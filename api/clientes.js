import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const clientes = await sql`SELECT * FROM clientes ORDER BY id DESC`;
      return res.status(200).json(clientes);
    }

    if (req.method === 'POST') {
      const { name, cnpj, responsible, value, due_day, start_date, status } = req.body;
      const resultado = await sql`
        INSERT INTO clientes (name, cnpj, responsible, value, due_day, start_date, status) 
        VALUES (${name}, ${cnpj}, ${responsible}, ${value}, ${due_day}, ${start_date}, ${status}) 
        RETURNING *;
      `;
      return res.status(201).json(resultado[0]);
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}