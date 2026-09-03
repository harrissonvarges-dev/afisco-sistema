const {
    pool,
    ensureSchema,
    mapCliente,
    parseBody,
    sendError
} = require('./_db');
const { requireAuth, recordAudit } = require('./_auth');

function samePerson(left, right) {
    const expected = String(right || '').trim().toLowerCase();
    return Boolean(expected) && String(left || '').trim().toLowerCase() === expected;
}

function normalizePersonName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function allowedResponsibleName(value) {
    const names = {
        helio: 'Helio',
        harrisson: 'Harrisson',
        nando: 'Nando',
        marcia: 'Marcia',
        marcinha: 'Marcia'
    };
    return names[normalizePersonName(value)] || '';
}

function paymentPixForResponsible(responsible) {
    const name = String(responsible || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    if (name === 'helio') {
        return { key: '77 9 9145-8383', recipient: 'Helio Gomes Varges', qr: 'pix-qrcode-caixa.jpeg', label: 'Pix Hélio Varges' };
    }
    if (name === 'harrisson') {
        return { key: '77 9 9148-3477', recipient: 'Harrisson Bahia Varges', qr: 'pix-qrcode-harrisson.jpeg', label: 'Pix Harrisson Varges' };
    }
    if (name === 'marcia' || name === 'marcinha') {
        return { key: '77 9 9206-3910', recipient: 'Marcia Luiz Bahia Varges', qr: 'pix-qrcode-marcia.png', label: 'Pix Márcia Bahia' };
    }
    if (name === 'nando') {
        return { key: '09.388.965/0001-78', recipient: 'AFISCO CONTABILIDADE (HELIO GOMES VARGES)', qr: 'pix-qrcode-nando.jpeg', label: 'PIX AFISCO CONTABILIDADE' };
    }
    return { key: '', recipient: '', qr: '', label: '' };
}

function mapClienteForUser(row, user, isAdmin) {
    const cliente = mapCliente(row);
    const isOwner = samePerson(row.responsible, user.responsibleName);
    const isCollector = samePerson(row.collector, user.responsibleName);
    const canOperate = isAdmin
        || isOwner
        || isCollector;
    const paymentPix = canOperate ? paymentPixForResponsible(row.responsible) : { key: '', recipient: '', qr: '', label: '' };
    return {
        ...cliente,
        responsible: isAdmin ? cliente.responsible : '',
        collector: isAdmin ? cliente.collector : '',
        value: cliente.value,
        paymentPix,
        canViewFinancials: true,
        canOperate,
        canManage: isAdmin || isOwner
    };
}

function normalizeCliente(body) {
    return {
        id: body.id ? Number(body.id) : null,
        name: String(body.name || '').trim(),
        contactName: String(body.contactName || body.contact_name || '').trim().slice(0, 150),
        cnpj: String(body.cnpj || '').trim(),
        phone: String(body.phone || body.whatsapp || '').trim().slice(0, 30),
        responsible: String(body.responsible || '').trim(),
        collector: String(body.collector || '').trim().slice(0, 100),
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
            const { rows } = await pool.query('SELECT * FROM clientes ORDER BY name ASC');
            return res.status(200).json(rows.map(row => mapClienteForUser(row, user, isAdmin)));
        }

        if (req.method === 'POST') {
            const cliente = normalizeCliente(parseBody(req));
            if (!isAdmin) {
                const selectedResponsible = allowedResponsibleName(cliente.responsible);
                if (!selectedResponsible) {
                    return res.status(400).json({ error: 'Escolha quem receberá a mensalidade.' });
                }
                cliente.responsible = selectedResponsible;
                cliente.collector = user.responsibleName;
            }
            if (!cliente.name) {
                return res.status(400).json({ error: 'Informe o nome do cliente.' });
            }

            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const { rows } = await db.query(
                    `INSERT INTO clientes
                        (name, contact_name, cnpj, phone, responsible, collector, value, due_day, start_date, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     RETURNING *`,
                    [cliente.name, cliente.contactName, cliente.cnpj, cliente.phone, cliente.responsible, cliente.collector, cliente.value, cliente.dueDay, cliente.start, cliente.status]
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
                                (date_trunc('month', CURRENT_DATE)
                                    + INTERVAL '1 month'
                                    + (LEAST(
                                           $3,
                                           EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '2 month - 1 day'))::INTEGER
                                       ) - 1) * INTERVAL '1 day')::date,
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

                await recordAudit(db, user, 'cliente_criado', 'cliente', created.id, {
                    name: created.name,
                    responsible: created.responsible,
                    value: Number(created.value || 0)
                });
                await db.query('COMMIT');
                return res.status(201).json(mapClienteForUser(created, user, isAdmin));
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
        }

        if (req.method === 'PUT') {
            const cliente = normalizeCliente(parseBody(req));
            if (!isAdmin) {
                cliente.responsible = user.responsibleName;
                cliente.collector = '';
            }
            if (!cliente.id || !cliente.name) {
                return res.status(400).json({ error: 'Cliente inválido.' });
            }

            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const oldResult = isAdmin
                    ? await db.query('SELECT * FROM clientes WHERE id=$1 FOR UPDATE', [cliente.id])
                    : await db.query(
                        `SELECT * FROM clientes
                         WHERE id=$1 AND LOWER(TRIM(responsible)) = LOWER(TRIM($2))
                         FOR UPDATE`,
                        [cliente.id, user.responsibleName]
                    );
                if (!oldResult.rows[0]) {
                    await db.query('ROLLBACK');
                    return res.status(404).json({ error: 'Cliente não encontrado.' });
                }
                if (!isAdmin) cliente.collector = oldResult.rows[0].collector || '';

                const { rows } = await db.query(
                    `UPDATE clientes
                     SET name=$1, contact_name=$2, cnpj=$3, phone=$4, responsible=$5, collector=$6, value=$7,
                         due_day=$8, start_date=$9, status=$10,
                         last_adjustment_date=CASE
                             WHEN value IS DISTINCT FROM $7::numeric THEN CURRENT_DATE
                             ELSE last_adjustment_date
                         END
                     WHERE id=$11
                     RETURNING *`,
                    [cliente.name, cliente.contactName, cliente.cnpj, cliente.phone, cliente.responsible, cliente.collector, cliente.value, cliente.dueDay, cliente.start, cliente.status, cliente.id]
                );
                const updated = rows[0];
                const oldClient = mapCliente(oldResult.rows[0]);
                const newClient = mapCliente(updated);
                if (oldClient.value !== newClient.value) {
                    await db.query(
                        `UPDATE mensalidades
                         SET previsto=$1
                         WHERE client_id=$2
                           AND status <> 'Pago'
                           AND (year > EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
                                OR (year = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
                                    AND month >= EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER))`,
                        [newClient.value, updated.id]
                    );
                }
                await recordAudit(db, user, 'cliente_atualizado', 'cliente', updated.id, {
                    name: updated.name,
                    before: oldClient,
                    after: newClient
                });
                await db.query('COMMIT');
                return res.status(200).json(mapClienteForUser(updated, user, isAdmin));
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
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
                    ? await db.query('SELECT * FROM clientes WHERE id=$1 FOR UPDATE', [id])
                    : await db.query(
                        `SELECT * FROM clientes
                         WHERE id=$1 AND LOWER(TRIM(responsible)) = LOWER(TRIM($2))
                         FOR UPDATE`,
                        [id, user.responsibleName]
                    );
                if (!accessResult.rows[0]) {
                    await db.query('ROLLBACK');
                    return res.status(404).json({ error: 'Cliente não encontrado.' });
                }
                const deletedClient = mapCliente(accessResult.rows[0]);
                await db.query('DELETE FROM mensalidades WHERE client_id=$1', [id]);
                const result = await db.query('DELETE FROM clientes WHERE id=$1 RETURNING id', [id]);
                await recordAudit(db, user, 'cliente_excluido', 'cliente', id, {
                    name: deletedClient.name,
                    responsible: deletedClient.responsible
                });
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
