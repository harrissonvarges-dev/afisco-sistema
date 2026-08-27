const { Pool } = require('pg');

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            const { rows } = await pool.query('SELECT * FROM clientes ORDER BY name ASC');
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao buscar clientes' });
        }
    } 
    else if (req.method === 'POST') {
        try {
            const { name, cnpj, responsible, value, dueDay, start, status } = req.body;
            const query = 'INSERT INTO clientes (name, cnpj, responsible, value, "dueDay", start, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *';
            const { rows } = await pool.query(query, [name, cnpj, responsible, value, dueDay, start, status]);
            res.status(201).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao criar cliente' });
        }
    } 
    else if (req.method === 'PUT') {
        try {
            const { id, name, cnpj, responsible, value, dueDay, start, status } = req.body;
            const query = 'UPDATE clientes SET name=$1, cnpj=$2, responsible=$3, value=$4, "dueDay"=$5, start=$6, status=$7 WHERE id=$8 RETURNING *';
            const { rows } = await pool.query(query, [name, cnpj, responsible, value, dueDay, start, status, id]);
            res.status(200).json(rows[0]);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao atualizar cliente' });
        }
    } 
    else if (req.method === 'DELETE') {
        try {
            const { id } = req.query;
            await pool.query('DELETE FROM clientes WHERE id=$1', [id]);
            res.status(200).json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao deletar cliente' });
        }
    } else {
        res.status(405).json({ message: 'Método não permitido' });
    }
}