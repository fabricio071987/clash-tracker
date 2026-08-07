import { createClient } from '@libsql/client';

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
  const decodedTag = decodeURIComponent(tag);

  try {
    const result = await turso.execute({
      sql: `
        SELECT * FROM promotions 
        WHERE clan_tag = ? AND is_active = 1 
        ORDER BY calculated_at DESC
      `,
      args: [decodedTag]
    });
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro ao buscar promoções' });
  }
}