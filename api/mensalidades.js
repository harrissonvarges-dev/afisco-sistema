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
      const mensalidades = await sql`SELECT * FROM mensalidades ORDER BY year DESC, month DESC`;
      return res.status(200).json(mensalidades);
    }

    if (req.method === 'POST') {
      const { client_id, month, year, previsto, due_date, status } = req.body;
      const resultado = await sql`
        INSERT INTO mensalidades (client_id, month, year, previsto, due_date, status) 
        VALUES (${client_id}, ${month}, ${year}, ${previsto}, ${due_date}, ${status}) 
        RETURNING *;
      `;
      return res.status(201).json(resultado[0]);
    }

    if (req.method === 'PUT') {
      const { id, paid_value, paid_date, status } = req.body;
      const resultado = await sql`
        UPDATE mensalidades 
        SET paid_value = ${paid_value}, paid_date = ${paid_date}, status = ${status} 
        WHERE id = ${id} 
        RETURNING *;
      `;
      return res.status(200).json(resultado[0]);
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}