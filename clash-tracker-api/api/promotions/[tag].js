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
    // Adicionado LIMIT 1 para pegar apenas o cálculo mais recente, e timeout de 5s
    const result = await Promise.race([
      turso.execute({
        sql: `
          SELECT * FROM promotions 
          WHERE clan_tag = ? AND is_active = 1 
          ORDER BY calculated_at DESC
          LIMIT 1
        `,
        args: [decodedTag]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso')), 5000))
    ]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro:', error.message);
    // Se der erro, devolve vazio para o site não travar
    res.status(200).json([]);
  }
}
