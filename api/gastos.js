const { pool, ensureSchema, parseBody, sendError } = require('./_db');
const { requireAuth, recordAudit } = require('./_auth');

function toIsoDate(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function mapGasto(row) {
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        userName: row.user_name || '',
        description: row.description || '',
        category: row.category || 'Outros',
        amount: Number(row.amount || 0),
        date: toIsoDate(row.expense_date),
        paymentMethod: row.payment_method || '',
        notes: row.notes || '',
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function readExpense(body) {
    return {
        description: String(body.description || '').trim(),
        category: String(body.category || 'Outros').trim() || 'Outros',
        amount: Number(body.amount || 0),
        date: String(body.date || '').slice(0, 10),
        paymentMethod: String(body.paymentMethod || body.payment_method || '').trim(),
        notes: String(body.notes || '').trim()
    };
}

function validateExpense(expense) {
    if (!expense.description) return 'Informe a descrição do gasto.';
    if (!Number.isFinite(expense.amount) || expense.amount <= 0) return 'Informe um valor maior que zero.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense.date)) return 'Informe uma data válida.';
    return '';
}

module.exports = async function handler(req, res) {
    try {
        await ensureSchema();
        const user = await requireAuth(req, res);
        if (!user) return;
        const isAdmin = user.role === 'admin';

        if (req.method === 'GET') {
            const now = new Date();
            const month = Number(req.query?.month || now.getMonth() + 1);
            const year = Number(req.query?.year || now.getFullYear());
            if (month < 1 || month > 12 || year < 2000 || year > 2100) {
                return res.status(400).json({ error: 'Período inválido.' });
            }
            const { rows } = await pool.query(
                `SELECT g.*, u.name AS user_name
                 FROM gastos g
                 JOIN usuarios u ON u.id = g.user_id
                 WHERE EXTRACT(MONTH FROM g.expense_date)::INTEGER = $1
                   AND EXTRACT(YEAR FROM g.expense_date)::INTEGER = $2
                 ORDER BY g.expense_date DESC, g.created_at DESC`,
                [month, year]
            );
            return res.status(200).json(rows.map(mapGasto));
        }

        if (req.method === 'POST') {
            const expense = readExpense(parseBody(req));
            const validationError = validateExpense(expense);
            if (validationError) return res.status(400).json({ error: validationError });
            const { rows } = await pool.query(
                `INSERT INTO gastos
                    (user_id, description, category, amount, expense_date, payment_method, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [user.id, expense.description, expense.category, expense.amount, expense.date, expense.paymentMethod, expense.notes]
            );
            await recordAudit(pool, user, 'gasto_criado', 'gasto', rows[0].id, {
                description: expense.description,
                category: expense.category,
                amount: expense.amount,
                date: expense.date
            });
            return res.status(201).json(mapGasto({ ...rows[0], user_name: user.name }));
        }

        if (req.method === 'PUT') {
            const body = parseBody(req);
            const id = Number(body.id);
            const expense = readExpense(body);
            const validationError = validateExpense(expense);
            if (!id) return res.status(400).json({ error: 'Gasto inválido.' });
            if (validationError) return res.status(400).json({ error: validationError });
            const { rows } = await pool.query(
                `UPDATE gastos
                 SET description=$1,
                     category=$2,
                     amount=$3,
                     expense_date=$4,
                     payment_method=$5,
                     notes=$6,
                     updated_at=NOW()
                 WHERE id=$7 AND ($8::BOOLEAN OR user_id=$9)
                 RETURNING *`,
                [expense.description, expense.category, expense.amount, expense.date, expense.paymentMethod, expense.notes, id, isAdmin, user.id]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Gasto não encontrado ou sem permissão para alterar.' });
            const owner = await pool.query('SELECT name FROM usuarios WHERE id=$1', [rows[0].user_id]);
            await recordAudit(pool, user, 'gasto_atualizado', 'gasto', id, {
                description: expense.description,
                category: expense.category,
                amount: expense.amount,
                date: expense.date
            });
            return res.status(200).json(mapGasto({ ...rows[0], user_name: owner.rows[0]?.name || '' }));
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query?.id);
            if (!id) return res.status(400).json({ error: 'Informe o gasto que será excluído.' });
            const { rows } = await pool.query(
                `DELETE FROM gastos
                 WHERE id=$1 AND ($2::BOOLEAN OR user_id=$3)
                 RETURNING *`,
                [id, isAdmin, user.id]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Gasto não encontrado ou sem permissão para excluir.' });
            await recordAudit(pool, user, 'gasto_excluido', 'gasto', id, {
                description: rows[0].description,
                amount: Number(rows[0].amount || 0),
                date: toIsoDate(rows[0].expense_date)
            });
            return res.status(200).json({ success: true });
        }

        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Método não permitido.' });
    } catch (error) {
        return sendError(res, error, 'Não foi possível acessar os gastos do escritório.');
    }
};
