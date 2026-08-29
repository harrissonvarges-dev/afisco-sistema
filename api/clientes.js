const {
    pool,
    ensureSchema,
    mapCliente,
    parseBody,
    sendError
} = require('./_db');
const { requireAuth } = require('./_auth');

function normalizeCliente(body) {
    return {
        id: body.id ? Number(body.id) : null,
        name: String(body.name || '').trim(),
        cnpj: String(body.cnpj || '').trim(),
        responsible: String(body.responsible || '').trim(),
        value: Number(body.value || 0),
        dueDay: Math.min(31, Math.max(1, Number(body.dueDay ?? body.due_day ?? 10))),
        start: body.start || body.start_date || new Date().toISOString().slice(0, 10),
        status: body.status === 'inativo' ? 'inativo' : 'ativo'
    };
}

module.exports = async function handler(req, res) {
    try {
        await ensureSchema();
        const user = await requireAuth(req, res);
        if (!user) return;
        const isAdmin = user.role === 'admin';

        if (req.method === 'GET') {
            const { rows } = isAdmin
                ? await pool.query('SELECT * FROM clientes ORDER BY name ASC')
                : await pool.query(
                    `SELECT * FROM clientes
                     WHERE LOWER(TRIM(responsible)) = LOWER(TRIM($1))
                     ORDER BY name ASC`,
                    [user.responsibleName]
                );
            return res.status(200).json(rows.map(mapCliente));
        }

        if (req.method === 'POST') {
            const cliente = normalizeCliente(parseBody(req));
            if (!isAdmin) cliente.responsible = user.responsibleName;
            if (!cliente.name) {
                return res.status(400).json({ error: 'Informe o nome do cliente.' });
            }

            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const { rows } = await db.query(
                    `INSERT INTO clientes
                        (name, cnpj, responsible, value, due_day, start_date, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [cliente.name, cliente.cnpj, cliente.responsible, cliente.value, cliente.dueDay, cliente.start, cliente.status]
                );

                const created = rows[0];
                if (created.status === 'ativo') {
                    await db.query(
                        `INSERT INTO mensalidades
                            (client_id, month, year, previsto, due_date, paid_date, paid_value, status)
                         SELECT $1,
                                EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER,
                                EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
                                $2,
                                make_date(
                                    EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
                                    EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER,
                                    LEAST($3, EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::INTEGER)
                                ),
                                NULL,
                                0,
                                'Em aberto'
                         WHERE $4::date <= (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date
                           AND NOT EXISTS (
                               SELECT 1 FROM mensalidades
                               WHERE client_id = $1
                                 AND month = EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER
                                 AND year = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
                           )`,
                        [created.id, created.value, created.due_day, created.start_date]
                    );
                }

                await db.query('COMMIT');
                return res.status(201).json(mapCliente(created));
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
        }

        if (req.method === 'PUT') {
            const cliente = normalizeCliente(parseBody(req));
            if (!isAdmin) cliente.responsible = user.responsibleName;
            if (!cliente.id || !cliente.name) {
                return res.status(400).json({ error: 'Cliente inválido.' });
            }

            const { rows } = isAdmin
                ? await pool.query(
                    `UPDATE clientes
                     SET name=$1, cnpj=$2, responsible=$3, value=$4,
                         due_day=$5, start_date=$6, status=$7
                     WHERE id=$8
                     RETURNING *`,
                    [cliente.name, cliente.cnpj, cliente.responsible, cliente.value, cliente.dueDay, cliente.start, cliente.status, cliente.id]
                )
                : await pool.query(
                    `UPDATE clientes
                     SET name=$1, cnpj=$2, responsible=$3, value=$4,
                         due_day=$5, start_date=$6, status=$7
                     WHERE id=$8 AND LOWER(TRIM(responsible)) = LOWER(TRIM($9))
                     RETURNING *`,
                    [cliente.name, cliente.cnpj, cliente.responsible, cliente.value, cliente.dueDay, cliente.start, cliente.status, cliente.id, user.responsibleName]
                );

            if (!rows[0]) {
                return res.status(404).json({ error: 'Cliente não encontrado.' });
            }
            return res.status(200).json(mapCliente(rows[0]));
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query?.id);
            if (!id) {
                return res.status(400).json({ error: 'Informe o cliente que será excluído.' });
            }

            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const accessResult = isAdmin
                    ? await db.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE', [id])
                    : await db.query(
                        `SELECT id FROM clientes
                         WHERE id=$1 AND LOWER(TRIM(responsible)) = LOWER(TRIM($2))
                         FOR UPDATE`,
                        [id, user.responsibleName]
                    );
                if (!accessResult.rows[0]) {
                    await db.query('ROLLBACK');
                    return res.status(404).json({ error: 'Cliente não encontrado.' });
                }
                await db.query('DELETE FROM mensalidades WHERE client_id=$1', [id]);
                const result = await db.query('DELETE FROM clientes WHERE id=$1 RETURNING id', [id]);
                await db.query('COMMIT');
                if (!result.rows[0]) {
                    return res.status(404).json({ error: 'Cliente não encontrado.' });
                }
                return res.status(200).json({ success: true });
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
        }

        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Método não permitido.' });
    } catch (error) {
        return sendError(res, error, 'Não foi possível acessar os clientes.');
    }
};
