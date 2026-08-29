const crypto = require('crypto');
const { promisify } = require('util');
const { pool, ensureSchema } = require('./_db');

const scryptAsync = promisify(crypto.scrypt);
const COOKIE_NAME = 'afisco_session';
const SESSION_IDLE_MINUTES = 30;
let adminBootstrapPromise;

function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function validateUsername(username) {
    return /^[a-z0-9._-]{3,50}$/.test(username);
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await scryptAsync(password, salt, 64);
    return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
    const [salt, expectedHex] = String(storedHash || '').split(':');
    if (!salt || !expectedHex) return false;
    const actual = await scryptAsync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(req) {
    const header = req.headers?.cookie || '';
    return header.split(';').reduce((cookies, part) => {
        const index = part.indexOf('=');
        if (index === -1) return cookies;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function serializeCookie(value, maxAge) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const expires = new Date(Date.now() + Math.max(0, maxAge) * 1000).toUTCString();
    return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${expires}; Priority=High${secure}`;
}

function ensureAdminBootstrap() {
    if (!adminBootstrapPromise) {
        adminBootstrapPromise = (async () => {
            await ensureSchema();
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                await db.query('SELECT pg_advisory_xact_lock($1, $2)', [205032, 2]);
                const countResult = await db.query('SELECT COUNT(*)::INTEGER AS count FROM usuarios');
                if (countResult.rows[0].count === 0) {
                    const username = normalizeUsername(process.env.AFISCO_ADMIN_USER);
                    const password = String(process.env.AFISCO_ADMIN_PASSWORD || '');
                    const name = String(process.env.AFISCO_ADMIN_NAME || 'Administrador').trim();
                    if (!validateUsername(username) || password.length < 8) {
                        const error = new Error('ADMIN_NOT_CONFIGURED');
                        error.code = 'ADMIN_NOT_CONFIGURED';
                        throw error;
                    }
                    const passwordHash = await hashPassword(password);
                    await db.query(
                        `INSERT INTO usuarios (name, username, password_hash, role)
                         VALUES ($1, $2, $3, 'admin')`,
                        [name, username, passwordHash]
                    );
                }
                await db.query('COMMIT');
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally {
                db.release();
            }
        })().catch(error => {
            adminBootstrapPromise = undefined;
            throw error;
        });
    }
    return adminBootstrapPromise;
}

function mapUser(row) {
    return {
        id: Number(row.id),
        name: row.name,
        username: row.username,
        role: row.role,
        responsibleName: row.responsible_name || '',
        active: Boolean(row.active),
        lastLoginAt: row.last_login_at || null,
        createdAt: row.created_at || null
    };
}

async function createSession(userId, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    await pool.query('DELETE FROM sessoes WHERE expires_at <= NOW()');
    await pool.query(
        `INSERT INTO sessoes (token_hash, user_id, expires_at)
         VALUES ($1, $2, NOW() + ($3::INTEGER * INTERVAL '1 minute'))`,
        [tokenHash, userId, SESSION_IDLE_MINUTES]
    );
    res.setHeader('Set-Cookie', serializeCookie(token, SESSION_IDLE_MINUTES * 60));
}

async function destroySession(req, res) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) {
        await pool.query('DELETE FROM sessoes WHERE token_hash=$1', [hashToken(token)]);
    }
    res.setHeader('Set-Cookie', serializeCookie('', 0));
}

async function getSessionUser(req, res = null) {
    await ensureAdminBootstrap();
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
        `SELECT u.*
         FROM sessoes s
         JOIN usuarios u ON u.id = s.user_id
         WHERE s.token_hash=$1 AND s.expires_at > NOW() AND u.active=TRUE`,
        [tokenHash]
    );
    if (!rows[0]) return null;

    // A sessão é deslizante: cada uso válido renova os 30 minutos de inatividade.
    await pool.query(
        `UPDATE sessoes
         SET expires_at = NOW() + ($2::INTEGER * INTERVAL '1 minute')
         WHERE token_hash=$1`,
        [tokenHash, SESSION_IDLE_MINUTES]
    );
    if (res) {
        res.setHeader('Set-Cookie', serializeCookie(token, SESSION_IDLE_MINUTES * 60));
    }
    return mapUser(rows[0]);
}

async function requireAuth(req, res, allowedRoles = null) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Vary', 'Cookie');
    const user = await getSessionUser(req, res);
    if (!user) {
        res.status(401).json({ error: 'Faça login para continuar.' });
        return null;
    }
    if (allowedRoles && !allowedRoles.includes(user.role)) {
        res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
        return null;
    }
    return user;
}

async function recordAudit(db, user, action, entity, entityId = null, details = {}) {
    await db.query(
        `INSERT INTO auditoria (user_id, user_name, action, entity, entity_id, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
            user?.id || null,
            user?.name || 'Sistema',
            String(action),
            String(entity),
            entityId === null || entityId === undefined ? null : String(entityId),
            JSON.stringify(details || {})
        ]
    );
}

module.exports = {
    pool,
    ensureAdminBootstrap,
    normalizeUsername,
    validateUsername,
    hashPassword,
    verifyPassword,
    createSession,
    destroySession,
    getSessionUser,
    requireAuth,
    mapUser,
    recordAudit
};
