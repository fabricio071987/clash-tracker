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
  if (!tag) {
    return res.status(400).json({ error: 'Tag do clã não informada' });
  }

  const decodedTag = decodeURIComponent(tag);

  try {
    const result = await Promise.race([
      turso.execute({
        sql: `
          SELECT member_tag, member_name, member_rank, avg_4w, avg_8w, reference_section_index, calculated_at, sum_4w, sum_8w
          FROM promotions
          WHERE clan_tag = ? AND is_active = 1
          ORDER BY member_name ASC
          LIMIT 2000
        `,
        args: [decodedTag]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso (60s)')), 60000))
    ]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro em promotions:', error.message);
    res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
