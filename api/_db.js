const { Pool } = require('pg');

const pool = globalThis.__afiscoPool || new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
});

if (process.env.NODE_ENV !== 'production') {
    globalThis.__afiscoPool = pool;
}

let schemaPromise;

function ensureSchema() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL não foi configurada no ambiente.');
    }

    if (!schemaPromise) {
        schemaPromise = (async () => {
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                // Evita que duas funções frias do Vercel tentem criar o mesmo índice simultaneamente.
                await db.query('SELECT pg_advisory_xact_lock($1, $2)', [205032, 1]);
                await db.query(`
                    CREATE TABLE IF NOT EXISTS clientes (
                        id BIGSERIAL PRIMARY KEY,
                        name TEXT NOT NULL,
                        cnpj TEXT NOT NULL DEFAULT '',
                        phone TEXT NOT NULL DEFAULT '',
                        responsible TEXT NOT NULL DEFAULT '',
                        collector TEXT NOT NULL DEFAULT '',
                        value NUMERIC(12, 2) NOT NULL DEFAULT 0,
                        due_day INTEGER NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 31),
                        start_date DATE NOT NULL DEFAULT CURRENT_DATE,
                        last_adjustment_date DATE,
                        status TEXT NOT NULL DEFAULT 'ativo'
                    )
                `);
                await db.query("ALTER TABLE clientes ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''");
                await db.query("ALTER TABLE clientes ADD COLUMN IF NOT EXISTS collector TEXT NOT NULL DEFAULT ''");
                await db.query('ALTER TABLE clientes ADD COLUMN IF NOT EXISTS last_adjustment_date DATE');
                await db.query(`
                    CREATE TABLE IF NOT EXISTS mensalidades (
                        id BIGSERIAL PRIMARY KEY,
                        client_id BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
                        year INTEGER NOT NULL,
                        previsto NUMERIC(12, 2) NOT NULL DEFAULT 0,
                        due_date DATE NOT NULL,
                        paid_date DATE,
                        paid_value NUMERIC(12, 2) NOT NULL DEFAULT 0,
                        status TEXT NOT NULL DEFAULT 'Em aberto'
                    )
                `);
                await db.query(`
                    CREATE TABLE IF NOT EXISTS usuarios (
                        id BIGSERIAL PRIMARY KEY,
                        name TEXT NOT NULL,
                        username TEXT NOT NULL UNIQUE,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL DEFAULT 'funcionario' CHECK (role IN ('admin', 'funcionario')),
                        responsible_name TEXT,
                        active BOOLEAN NOT NULL DEFAULT TRUE,
                        failed_attempts INTEGER NOT NULL DEFAULT 0,
                        locked_until TIMESTAMPTZ,
                        last_login_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await db.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS responsible_name TEXT');
                await db.query(`
                    CREATE TABLE IF NOT EXISTS gastos (
                        id BIGSERIAL PRIMARY KEY,
                        user_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
                        description TEXT NOT NULL,
                        category TEXT NOT NULL DEFAULT 'Outros',
                        amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
                        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
                        payment_method TEXT NOT NULL DEFAULT '',
                        notes TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await db.query(`
                    CREATE TABLE IF NOT EXISTS sessoes (
                        id BIGSERIAL PRIMARY KEY,
                        token_hash CHAR(64) NOT NULL UNIQUE,
                        user_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                        expires_at TIMESTAMPTZ NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await db.query(`
                    CREATE TABLE IF NOT EXISTS auditoria (
                        id BIGSERIAL PRIMARY KEY,
                        user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
                        user_name TEXT NOT NULL,
                        action TEXT NOT NULL,
                        entity TEXT NOT NULL,
                        entity_id TEXT,
                        details JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await db.query('CREATE INDEX IF NOT EXISTS mensalidades_periodo_idx ON mensalidades (year, month)');
                await db.query('CREATE INDEX IF NOT EXISTS mensalidades_cliente_idx ON mensalidades (client_id)');
                await db.query('CREATE INDEX IF NOT EXISTS sessoes_expiracao_idx ON sessoes (expires_at)');
                await db.query('CREATE INDEX IF NOT EXISTS auditoria_data_idx ON auditoria (created_at DESC)');
                await db.query('CREATE INDEX IF NOT EXISTS gastos_data_idx ON gastos (expense_date DESC)');
                await db.query('CREATE INDEX IF NOT EXISTS gastos_usuario_idx ON gastos (user_id)');
                await db.query('COMMIT');
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
        })().catch(error => {
            schemaPromise = undefined;
            throw error;
        });
    }
    return schemaPromise;
}

async function ensurePeriod(month, year) {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock($1, $2)', [year, month]);
        const result = await db.query(
            `INSERT INTO mensalidades
                (client_id, month, year, previsto, due_date, paid_date, paid_value, status)
             SELECT c.id,
                    $1,
                    $2,
                    c.value,
                     (make_date($2, $1, 1)
                         + INTERVAL '1 month'
                         + (LEAST(
                                c.due_day,
                                EXTRACT(DAY FROM (make_date($2, $1, 1) + INTERVAL '2 month - 1 day'))::INTEGER
                            ) - 1) * INTERVAL '1 day')::date,
                    NULL,
                    0,
                    CASE
                        WHEN (make_date($2, $1, 1)
                            + INTERVAL '1 month'
                            + (LEAST(
                                   c.due_day,
                                   EXTRACT(DAY FROM (make_date($2, $1, 1) + INTERVAL '2 month - 1 day'))::INTEGER
                               ) - 1) * INTERVAL '1 day')::date < CURRENT_DATE THEN 'Vencido'
                        ELSE 'Em aberto'
                    END
             FROM clientes c
             WHERE c.status = 'ativo'
               AND c.start_date <= (make_date($2, $1, 1) + INTERVAL '1 month - 1 day')::date
               AND NOT EXISTS (
                   SELECT 1 FROM mensalidades m
                   WHERE m.client_id = c.id AND m.month = $1 AND m.year = $2
               )`,
            [month, year]
        );
        // Corrige mensalidades antigas, inclusive as já pagas, sem apagar o pagamento registrado.
        await db.query(
            `UPDATE mensalidades m
             SET due_date = (make_date(m.year, m.month, 1)
                                + INTERVAL '1 month'
                                + (LEAST(
                                       c.due_day,
                                       EXTRACT(DAY FROM (make_date(m.year, m.month, 1) + INTERVAL '2 month - 1 day'))::INTEGER
                                   ) - 1) * INTERVAL '1 day')::date,
                 status = CASE
                     WHEN m.status = 'Pago' THEN 'Pago'
                     WHEN COALESCE(m.paid_value, 0) > 0 THEN 'Parcial'
                     WHEN (make_date(m.year, m.month, 1)
                              + INTERVAL '1 month'
                              + (LEAST(
                                     c.due_day,
                                     EXTRACT(DAY FROM (make_date(m.year, m.month, 1) + INTERVAL '2 month - 1 day'))::INTEGER
                                 ) - 1) * INTERVAL '1 day')::date < CURRENT_DATE THEN 'Vencido'
                     ELSE 'Em aberto'
                 END
             FROM clientes c
             WHERE c.id = m.client_id
               AND m.month = $1
               AND m.year = $2`,
            [month, year]
        );
        await db.query('COMMIT');
        return result.rowCount;
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }
}

function toIsoDate(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function mapCliente(row) {
    return {
        id: Number(row.id),
        name: row.name,
        cnpj: row.cnpj || '',
        phone: row.phone || '',
        responsible: row.responsible || '',
        collector: row.collector || '',
        value: Number(row.value || 0),
        dueDay: Number(row.due_day || 10),
        start: toIsoDate(row.start_date),
        lastAdjustment: toIsoDate(row.last_adjustment_date),
        status: row.status || 'ativo'
    };
}

function mapMensalidade(row) {
    return {
        id: Number(row.id),
        clientId: Number(row.client_id),
        month: Number(row.month),
        year: Number(row.year),
        previsto: Number(row.previsto || 0),
        due: toIsoDate(row.due_date),
        paidDate: toIsoDate(row.paid_date),
        paidValue: Number(row.paid_value || 0),
        status: row.status || 'Em aberto'
    };
}

function parseBody(req) {
    if (!req.body) return {};
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

function sendError(res, error, fallbackMessage) {
    console.error(error);
    const missingDatabase = error.message?.includes('DATABASE_URL');
    return res.status(missingDatabase ? 503 : 500).json({
        error: missingDatabase ? 'Banco de dados não configurado.' : fallbackMessage
    });
}

module.exports = {
    pool,
    ensureSchema,
    ensurePeriod,
    mapCliente,
    mapMensalidade,
    parseBody,
    sendError
};
