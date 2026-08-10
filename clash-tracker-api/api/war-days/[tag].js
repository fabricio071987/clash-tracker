import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tag } = req.query;
  if (!tag) return res.status(400).json({ error: 'Tag do clã não informada' });

  const decodedTag = decodeURIComponent(tag);

  try {
    const result = await turso.execute({
      sql: `
        SELECT * FROM war_days 
        WHERE clan_tag = ? 
        ORDER BY period_index DESC, member_name ASC 
        LIMIT 20
      `,
      args: [decodedTag]
    });

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro em war-days:', error.message);
    res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
