const { pool, sendError } = require('./_db');
const { requireAuth } = require('./_auth');

module.exports = async function handler(req, res) {
    try {
        const user = await requireAuth(req, res, ['admin']);
        if (!user) return;
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return res.status(405).json({ error: 'Método não permitido.' });
        }

        const limit = Math.min(500, Math.max(1, Number(req.query?.limit || 200)));
        const { rows } = await pool.query(
            `SELECT id, user_name, action, entity, entity_id, details, created_at
             FROM auditoria
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit]
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(rows.map(row => ({
            id: Number(row.id),
            userName: row.user_name,
            action: row.action,
            entity: row.entity,
            entityId: row.entity_id,
            details: row.details || {},
            createdAt: row.created_at
        })));
    } catch (error) {
        return sendError(res, error, 'Não foi possível carregar o histórico.');
    }
};
