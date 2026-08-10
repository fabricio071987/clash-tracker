import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function queryTurso(sql) {
  try {
    return await Promise.race([
      turso.execute(sql),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso (25s)')), 25000))
    ]);
  } catch (err) {
    throw new Error(`Erro ao buscar clãs: ${err.message}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const result = await queryTurso('SELECT tag, name, enabled FROM clans ORDER BY name');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar clãs' });
  }
}
