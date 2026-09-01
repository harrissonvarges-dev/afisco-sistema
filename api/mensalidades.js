const {
    pool,
    ensureSchema,
    ensurePeriod,
    mapMensalidade,
    parseBody,
    sendError
} = require('./_db');
const { requireAuth, recordAudit } = require('./_auth');

function samePerson(left, right) {
    const expected = String(right || '').trim().toLowerCase();
    return Boolean(expected) && String(left || '').trim().toLowerCase() === expected;
}

function mapMensalidadeForUser(row, user, isAdmin) {
    const mensalidade = mapMensalidade(row);
    const canOperate = isAdmin
        || samePerson(row.client_responsible, user.responsibleName)
        || samePerson(row.client_collector, user.responsibleName);
    return {
        ...mensalidade,
        previsto: mensalidade.previsto,
        paidValue: mensalidade.paidValue,
        canViewFinancials: true,
        canOperate
    };
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

            await ensurePeriod(month, year);
            await pool.query(
                `UPDATE mensalidades
                 SET status = 'Vencido'
                 WHERE status IN ('Em aberto', 'Parcial')
                   AND due_date < CURRENT_DATE
                   AND COALESCE(paid_value, 0) < previsto`
            );

            const { rows } = await pool.query(
                `SELECT m.*, c.responsible AS client_responsible, c.collector AS client_collector
                 FROM mensalidades m
                 JOIN clientes c ON c.id = m.client_id
                 ORDER BY m.year DESC, m.month DESC, m.due_date ASC`
            );
            return res.status(200).json(rows.map(row => mapMensalidadeForUser(row, user, isAdmin)));
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

            if (!isAdmin) {
                const access = await pool.query(
                    `SELECT id FROM clientes
                     WHERE id=$1
                       AND LOWER(TRIM(responsible)) = LOWER(TRIM($2))`,
                    [clientId, user.responsibleName]
                );
                if (!access.rows[0]) return res.status(404).json({ error: 'Cliente não encontrado.' });
            }

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
            await recordAudit(pool, user, 'mensalidade_criada', 'mensalidade', rows[0].id, {
                clientId,
                month,
                year,
                previsto
            });
            return res.status(201).json(mapMensalidade(rows[0]));
        }

        if (req.method === 'PUT') {
            const body = parseBody(req);
            const id = Number(body.id);
            const previsto = Number(body.previsto || 0);
            let paidValue = Number(body.paidValue ?? body.paid_value ?? 0);
            let paidDate = body.paidDate || body.paid_date || null;
            let status = body.status || 'Em aberto';

            if (!id) {
                return res.status(400).json({ error: 'Mensalidade inválida.' });
            }
            if (status === 'Em aberto' || status === 'Vencido') {
                paidValue = 0;
                paidDate = null;
            } else if (paidValue >= previsto && previsto > 0) {
                paidValue = Math.max(paidValue, previsto);
                status = 'Pago';
            } else if (paidValue > 0) {
                status = 'Parcial';
            }
            if (status === 'Pago' && !paidDate) {
                paidDate = new Date().toISOString().slice(0, 10);
            }
            if (status === 'Pago' && paidValue <= 0) {
                return res.status(400).json({ error: 'Informe o valor recebido.' });
            }

            const { rows } = isAdmin
                ? await pool.query(
                    `UPDATE mensalidades
                     SET previsto=$1, paid_date=$2, paid_value=$3, status=$4
                     WHERE id=$5
                     RETURNING *`,
                    [previsto, paidDate, paidValue, status, id]
                )
                : await pool.query(
                    `UPDATE mensalidades m
                     SET previsto=CASE
                             WHEN EXISTS (
                                 SELECT 1 FROM clientes owner
                                 WHERE owner.id=m.client_id
                                   AND LOWER(TRIM(owner.responsible)) = LOWER(TRIM($6))
                             ) THEN $1
                             ELSE m.previsto
                         END,
                         paid_date=$2, paid_value=$3, status=$4
                     WHERE m.id=$5
                       AND EXISTS (
                           SELECT 1 FROM clientes c
                           WHERE c.id=m.client_id
                             AND (LOWER(TRIM(c.responsible)) = LOWER(TRIM($6))
                                  OR LOWER(TRIM(c.collector)) = LOWER(TRIM($6)))
                       )
                     RETURNING m.*`,
                    [previsto, paidDate, paidValue, status, id, user.responsibleName]
                );

            if (!rows[0]) {
                return res.status(404).json({ error: 'Mensalidade não encontrada.' });
            }
            const clientResult = await pool.query('SELECT name FROM clientes WHERE id=$1', [rows[0].client_id]);
            await recordAudit(pool, user, 'pagamento_atualizado', 'mensalidade', rows[0].id, {
                clientName: clientResult.rows[0]?.name || '',
                month: Number(rows[0].month),
                year: Number(rows[0].year),
                status: rows[0].status,
                paidValue: Number(rows[0].paid_value || 0)
            });
            return res.status(200).json(mapMensalidade(rows[0]));
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query?.id);
            if (!id) {
                return res.status(400).json({ error: 'Informe a mensalidade que será excluída.' });
            }
            const result = isAdmin
                ? await pool.query('DELETE FROM mensalidades WHERE id=$1 RETURNING *', [id])
                : await pool.query(
                    `DELETE FROM mensalidades m
                     WHERE m.id=$1
                       AND EXISTS (
                           SELECT 1 FROM clientes c
                           WHERE c.id=m.client_id
                             AND LOWER(TRIM(c.responsible)) = LOWER(TRIM($2))
                       )
                     RETURNING m.*`,
                    [id, user.responsibleName]
                );
            if (!result.rows[0]) {
                return res.status(404).json({ error: 'Mensalidade não encontrada.' });
            }
            await recordAudit(pool, user, 'mensalidade_excluida', 'mensalidade', id, {
                clientId: Number(result.rows[0].client_id),
                month: Number(result.rows[0].month),
                year: Number(result.rows[0].year)
            });
            return res.status(200).json({ success: true });
        }

        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Método não permitido.' });
    } catch (error) {
        return sendError(res, error, 'Não foi possível acessar as mensalidades.');
    }
};
