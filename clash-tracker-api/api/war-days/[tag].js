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
    const result = await Promise.race([
      turso.execute({
        sql: `
          SELECT 
            clan_tag, section_index, period_index, 
            member_tag, member_name, member_rank,
            decks_used, decks_total, updated_at, is_active,
            RANK() OVER (PARTITION BY section_index ORDER BY period_index) AS day_number
          FROM war_days
          WHERE clan_tag = ? AND is_active = 1
          ORDER BY member_name ASC
        `,
        args: [decodedTag]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso')), 6000))
    ]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro:', error.message);
    res.status(200).json([]);
  }
}
