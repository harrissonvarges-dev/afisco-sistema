const { Pool } = require('pg');

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            const { rows } = await pool.query('SELECT * FROM mensalidades ORDER BY year DESC, month DESC');
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao buscar mensalidades' });
        }
    } 
    else if (req.method === 'POST') {
        try {
            const { client_id, month, year, previsto, due_date, paid_date, paid_value, status } = req.body;
            const query = 'INSERT INTO mensalidades (client_id, month, year, previsto, due_date, paid_date, paid_value, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *';
            const { rows } = await pool.query(query, [client_id, month, year, previsto, due_date, paid_date, paid_value, status]);
            res.status(201).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao criar mensalidade' });
        }
    } 
    else if (req.method === 'PUT') {
        try {
            const { id, client_id, month, year, previsto, due_date, paid_date, paid_value, status } = req.body;
            const query = 'UPDATE mensalidades SET client_id=$1, month=$2, year=$3, previsto=$4, due_date=$5, paid_date=$6, paid_value=$7, status=$8 WHERE id=$9 RETURNING *';
            const { rows } = await pool.query(query, [client_id, month, year, previsto, due_date, paid_date, paid_value, status, id]);
            res.status(200).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao atualizar mensalidade' });
        }
    } 
    else if (req.method === 'DELETE') {
        try {
            const { id } = req.query;
            await pool.query('DELETE FROM mensalidades WHERE id=$1', [id]);
            res.status(200).json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao deletar mensalidade' });
        }
    } else {
        res.status(405).json({ message: 'Método não permitido' });
    }
}
