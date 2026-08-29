const {
    pool,
    requireAuth,
    normalizeUsername,
    validateUsername,
    hashPassword,
    mapUser
} = require('./_auth');

module.exports = async function handler(req, res) {
    try {
        const currentUser = await requireAuth(req, res, ['admin']);
        if (!currentUser) return;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

        if (req.method === 'GET') {
            const { rows } = await pool.query(
                'SELECT * FROM usuarios ORDER BY active DESC, name ASC'
            );
            return res.status(200).json(rows.map(mapUser));
        }

        if (req.method === 'POST') {
            const name = String(body.name || '').trim();
            const username = normalizeUsername(body.username);
            const password = String(body.password || '');
            const role = body.role === 'admin' ? 'admin' : 'funcionario';
            const responsibleName = role === 'funcionario' ? String(body.responsibleName || name).trim() : '';
            if (!name || !validateUsername(username) || password.length < 8 || (role === 'funcionario' && !responsibleName)) {
                return res.status(400).json({ error: 'Informe nome, usuário válido, responsável e senha com pelo menos 8 caracteres.' });
            }
            const passwordHash = await hashPassword(password);
            const { rows } = await pool.query(
                `INSERT INTO usuarios (name, username, password_hash, role, responsible_name)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [name, username, passwordHash, role, responsibleName]
            );
            return res.status(201).json(mapUser(rows[0]));
        }

        if (req.method === 'PUT') {
            const id = Number(body.id);
            const name = String(body.name || '').trim();
            const role = body.role === 'admin' ? 'admin' : 'funcionario';
            const responsibleName = role === 'funcionario' ? String(body.responsibleName || name).trim() : '';
            const active = body.active !== false;
            const password = String(body.password || '');
            if (!id || !name) {
                return res.status(400).json({ error: 'Funcionário inválido.' });
            }
            if (id === currentUser.id && (!active || role !== 'admin')) {
                return res.status(400).json({ error: 'Você não pode remover o próprio acesso de administrador.' });
            }
            if (password && password.length < 8) {
                return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
            }

            let result;
            if (password) {
                const passwordHash = await hashPassword(password);
                result = await pool.query(
                    `UPDATE usuarios
                     SET name=$1, role=$2, active=$3, password_hash=$4, responsible_name=$5,
                         failed_attempts=0, locked_until=NULL, updated_at=NOW()
                     WHERE id=$6 RETURNING *`,
                    [name, role, active, passwordHash, responsibleName, id]
                );
                await pool.query('DELETE FROM sessoes WHERE user_id=$1', [id]);
            } else {
                result = await pool.query(
                    `UPDATE usuarios
                     SET name=$1, role=$2, active=$3, responsible_name=$4, updated_at=NOW()
                     WHERE id=$5 RETURNING *`,
                    [name, role, active, responsibleName, id]
                );
                if (!active) await pool.query('DELETE FROM sessoes WHERE user_id=$1', [id]);
            }
            if (!result.rows[0]) return res.status(404).json({ error: 'Funcionário não encontrado.' });
            return res.status(200).json(mapUser(result.rows[0]));
        }

        res.setHeader('Allow', 'GET, POST, PUT');
        return res.status(405).json({ error: 'Método não permitido.' });
    } catch (error) {
        console.error(error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Esse nome de usuário já está sendo usado.' });
        }
        return res.status(500).json({ error: 'Não foi possível gerenciar os funcionários.' });
    }
};
