const { Pool } = require('pg');

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            const { rows } = await pool.query('SELECT * FROM mensalidades ORDER BY due DESC');
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao buscar mensalidades' });
        }
    } 
    else if (req.method === 'POST') {
        try {
            const { clientId, month, year, previsto, due, paidDate, paidValue, status } = req.body;
            const pDate = paidDate || null;
            const query = 'INSERT INTO mensalidades ("clientId", month, year, previsto, due, "paidDate", "paidValue", status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *';
            const { rows } = await pool.query(query, [clientId, month, year, previsto, due, pDate, paidValue || 0, status]);
            res.status(201).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao gerar mensalidade' });
        }
    } 
    else if (req.method === 'PUT') {
        try {
            const { id, previsto, due, paidDate, paidValue, status } = req.body;
            const pDate = paidDate || null;
            const query = 'UPDATE mensalidades SET previsto=$1, due=$2, "paidDate"=$3, "paidValue"=$4, status=$5 WHERE id=$6 RETURNING *';
            const { rows } = await pool.query(query, [previsto, due, pDate, paidValue || 0, status, id]);
            res.status(200).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao atualizar mensalidade' });
        }
    } else {
        res.status(405).json({ message: 'Método não permitido' });
    }
}