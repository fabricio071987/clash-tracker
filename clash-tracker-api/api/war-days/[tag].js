import { createClient } from '@libsql/client';
import { readWarLog } from '../cache-utils.js';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { tag } = req.query;
  if (!tag) {
    return res.status(400).json({ error: 'Tag do clã não informada' });
  }

  try {
    const rows = await Promise.race([
      readWarLog(turso, decodeURIComponent(tag)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso (60s)')), 60000))
    ]);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Erro em war-days:', error.message);
    res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
