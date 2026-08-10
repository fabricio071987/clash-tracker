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
    // CORREÇÃO DEFINITIVA: Sem LIMIT, mas com ORDER BY nome. 
    // O Turso lê tudo, mas a Vercel envia aos poucos.
    const result = await Promise.race([
      turso.execute({
        sql: `
          SELECT * FROM promotions 
          WHERE clan_tag = ? AND is_active = 1 
          ORDER BY member_name ASC
          LIMIT 55
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
