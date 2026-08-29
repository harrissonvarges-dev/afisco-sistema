const { getSessionUser } = require('../_auth');

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Vary', 'Cookie');
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Método não permitido.' });
    }
    try {
        const user = await getSessionUser(req, res);
        if (!user) return res.status(401).json({ error: 'Sessão não encontrada.' });
        return res.status(200).json({ user });
    } catch (error) {
        console.error(error);
        if (error.code === 'ADMIN_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'O administrador inicial ainda não foi configurado no Vercel.' });
        }
        return res.status(500).json({ error: 'Não foi possível verificar a sessão.' });
    }
};
