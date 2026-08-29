const {
    pool,
    ensureSchema,
    ensurePeriod,
    mapMensalidade,
    parseBody,
    sendError
} = require('./_db');

module.exports = async function handler(req, res) {
    try {
        await ensureSchema();

        if (req.method === 'GET') {
            const now = new Date();
            const month = Number(req.query?.month || now.getMonth() + 1);
            const year = Number(req.query?.year || now.getFullYear());
            if (month < 1 || month > 12 || year < 2000 || year > 2100) {
                return res.status(400).json({ error: 'Período inválido.' });
            }

            await ensurePeriod(month, year);
            await pool.query(
                `UPDATE mensalidades
                 SET status = 'Vencido'
                 WHERE status IN ('Em aberto', 'Parcial')
                   AND due_date < CURRENT_DATE
                   AND COALESCE(paid_value, 0) < previsto`
            );

            const { rows } = await pool.query(
                'SELECT * FROM mensalidades ORDER BY year DESC, month DESC, due_date ASC'
            );
            return res.status(200).json(rows.map(mapMensalidade));
        }

        if (req.method === 'POST') {
            const body = parseBody(req);
            if (body.action === 'ensure-period') {
                const month = Number(body.month);
                const year = Number(body.year);
                if (month < 1 || month > 12 || year < 2000 || year > 2100) {
                    return res.status(400).json({ error: 'Período inválido.' });
                }
                const created = await ensurePeriod(month, year);
                return res.status(200).json({ success: true, created });
            }

            const clientId = Number(body.clientId ?? body.client_id);
            const month = Number(body.month);
            const year = Number(body.year);
            const previsto = Number(body.previsto || 0);
            const dueDate = body.due || body.dueDate || body.due_date;
            const paidDate = body.paidDate || body.paid_date || null;
            const paidValue = Number(body.paidValue ?? body.paid_value ?? 0);
            const status = body.status || 'Em aberto';

            const { rows } = await pool.query(
                `INSERT INTO mensalidades
                    (client_id, month, year, previsto, due_date, paid_date, paid_value, status)
                 SELECT $1, $2, $3, $4, $5, $6, $7, $8
                 WHERE NOT EXISTS (
                     SELECT 1 FROM mensalidades WHERE client_id=$1 AND month=$2 AND year=$3
                 )
                 RETURNING *`,
                [clientId, month, year, previsto, dueDate, paidDate, paidValue, status]
            );

            if (!rows[0]) {
                return res.status(409).json({ error: 'Essa mensalidade já existe.' });
            }
            return res.status(201).json(mapMensalidade(rows[0]));
        }

        if (req.method === 'PUT') {
            const body = parseBody(req);
            const id = Number(body.id);
            const previsto = Number(body.previsto || 0);
            const paidValue = Number(body.paidValue ?? body.paid_value ?? 0);
            let paidDate = body.paidDate || body.paid_date || null;
            let status = body.status || 'Em aberto';

            if (!id) {
                return res.status(400).json({ error: 'Mensalidade inválida.' });
            }
            if (status === 'Pago' && !paidDate) {
                paidDate = new Date().toISOString().slice(0, 10);
            }
            if (status === 'Pago' && paidValue <= 0) {
                return res.status(400).json({ error: 'Informe o valor recebido.' });
            }

            const { rows } = await pool.query(
                `UPDATE mensalidades
                 SET previsto=$1, paid_date=$2, paid_value=$3, status=$4
                 WHERE id=$5
                 RETURNING *`,
                [previsto, paidDate, paidValue, status, id]
            );

            if (!rows[0]) {
                return res.status(404).json({ error: 'Mensalidade não encontrada.' });
            }
            return res.status(200).json(mapMensalidade(rows[0]));
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query?.id);
            if (!id) {
                return res.status(400).json({ error: 'Informe a mensalidade que será excluída.' });
            }
            const result = await pool.query('DELETE FROM mensalidades WHERE id=$1 RETURNING id', [id]);
            if (!result.rows[0]) {
                return res.status(404).json({ error: 'Mensalidade não encontrada.' });
            }
            return res.status(200).json({ success: true });
        }

        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Método não permitido.' });
    } catch (error) {
        return sendError(res, error, 'Não foi possível acessar as mensalidades.');
    }
};
