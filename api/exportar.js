const { pool, mapCliente, mapMensalidade, sendError } = require('./_db');
const { requireAuth, mapUser, recordAudit } = require('./_auth');

function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

module.exports = async function handler(req, res) {
    try {
        const user = await requireAuth(req, res, ['admin']);
        if (!user) return;
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return res.status(405).json({ error: 'Método não permitido.' });
        }

        const now = new Date();
        const fileDate = now.toISOString().slice(0, 10);
        const format = String(req.query?.format || 'json').toLowerCase();

        if (format === 'csv') {
            const { rows } = await pool.query(
                `SELECT c.name, c.cnpj, c.phone, c.responsible, c.collector,
                        m.month, m.year, m.previsto, m.due_date,
                        m.paid_date, m.paid_value, m.status
                 FROM mensalidades m
                 JOIN clientes c ON c.id=m.client_id
                 ORDER BY m.year DESC, m.month DESC, c.name ASC`
            );
            const header = ['Cliente', 'CNPJ', 'WhatsApp', 'Responsável', 'Acesso para recebimento', 'Mês', 'Ano', 'Previsto', 'Vencimento', 'Pagamento', 'Valor pago', 'Status'];
            const lines = [header.map(csvCell).join(';')];
            rows.forEach(row => lines.push([
                row.name,
                row.cnpj,
                row.phone,
                row.responsible,
                row.collector,
                row.month,
                row.year,
                Number(row.previsto || 0).toFixed(2).replace('.', ','),
                row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : '',
                row.paid_date ? new Date(row.paid_date).toISOString().slice(0, 10) : '',
                Number(row.paid_value || 0).toFixed(2).replace('.', ','),
                row.status
            ].map(csvCell).join(';')));
            await recordAudit(pool, user, 'exportacao_csv', 'backup', fileDate, { rows: rows.length });
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="afisco-mensalidades-${fileDate}.csv"`);
            return res.status(200).send(`\uFEFF${lines.join('\r\n')}`);
        }

        const [clientesResult, mensalidadesResult, gastosResult, usuariosResult, auditoriaResult] = await Promise.all([
            pool.query('SELECT * FROM clientes ORDER BY id ASC'),
            pool.query('SELECT * FROM mensalidades ORDER BY id ASC'),
            pool.query('SELECT g.*, u.name AS user_name FROM gastos g JOIN usuarios u ON u.id=g.user_id ORDER BY g.id ASC'),
            pool.query('SELECT * FROM usuarios ORDER BY id ASC'),
            pool.query('SELECT id, user_name, action, entity, entity_id, details, created_at FROM auditoria ORDER BY id ASC')
        ]);
        const backup = {
            application: 'Afisco Contabilidade',
            exportedAt: now.toISOString(),
            clientes: clientesResult.rows.map(mapCliente),
            mensalidades: mensalidadesResult.rows.map(mapMensalidade),
            gastos: gastosResult.rows.map(row => ({
                id: Number(row.id),
                userId: Number(row.user_id),
                userName: row.user_name,
                description: row.description,
                category: row.category,
                amount: Number(row.amount || 0),
                date: row.expense_date ? new Date(row.expense_date).toISOString().slice(0, 10) : '',
                paymentMethod: row.payment_method,
                notes: row.notes,
                createdAt: row.created_at,
                updatedAt: row.updated_at
            })),
            usuarios: usuariosResult.rows.map(mapUser),
            auditoria: auditoriaResult.rows.map(row => ({
                id: Number(row.id),
                userName: row.user_name,
                action: row.action,
                entity: row.entity,
                entityId: row.entity_id,
                details: row.details || {},
                createdAt: row.created_at
            }))
        };
        await recordAudit(pool, user, 'backup_completo', 'backup', fileDate, {
            clients: backup.clientes.length,
            monthlyFees: backup.mensalidades.length,
            expenses: backup.gastos.length
        });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="afisco-backup-${fileDate}.json"`);
        return res.status(200).send(JSON.stringify(backup, null, 2));
    } catch (error) {
        return sendError(res, error, 'Não foi possível exportar os dados.');
    }
};
