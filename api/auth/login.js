const {
    pool,
    ensureAdminBootstrap,
    normalizeUsername,
    verifyPassword,
    createSession,
    mapUser,
    recordAudit
} = require('../_auth');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Método não permitido.' });
    }

    try {
        await ensureAdminBootstrap();
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const username = normalizeUsername(body.username);
        const password = String(body.password || '');
        const { rows } = await pool.query('SELECT * FROM usuarios WHERE username=$1', [username]);
        const user = rows[0];

        if (!user || !user.active) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
        }
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(429).json({ error: 'Acesso temporariamente bloqueado. Tente novamente em 15 minutos.' });
        }

        const validPassword = await verifyPassword(password, user.password_hash);
        if (!validPassword) {
            await pool.query(
                `UPDATE usuarios
                 SET failed_attempts = failed_attempts + 1,
                     locked_until = CASE
                         WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
                         ELSE locked_until
                     END,
                     updated_at = NOW()
                 WHERE id=$1`,
                [user.id]
            );
            return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
        }

        await pool.query(
            `UPDATE usuarios
             SET failed_attempts=0, locked_until=NULL, last_login_at=NOW(), updated_at=NOW()
             WHERE id=$1`,
            [user.id]
        );
        await createSession(user.id, res);
        await recordAudit(pool, mapUser(user), 'login_realizado', 'sessao', user.id, { username: user.username });
        return res.status(200).json({ user: mapUser({ ...user, last_login_at: new Date() }) });
    } catch (error) {
        console.error(error);
        if (error.code === 'ADMIN_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'O administrador inicial ainda não foi configurado no Vercel.' });
        }
        return res.status(500).json({ error: 'Não foi possível entrar no sistema.' });
    }
};
