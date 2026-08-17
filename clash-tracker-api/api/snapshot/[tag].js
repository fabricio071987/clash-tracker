// ============================================================
// SNAPSHOT: consulta os dados do Turso e retorna JSON leve
// ============================================================
// O frontend lê este endpoint (com cache), em vez de consultar
// o Turso ao vivo a cada visita. Assim o site nunca mais "some"
// por lentidão do banco — ele sempre recebe os dados da última
// coleta feita pelo cronjob.
// ============================================================
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
    const [warsResult, promosResult] = await Promise.race([
      Promise.all([
        turso.execute({
          sql: `
            SELECT member_tag, member_name, member_rank, section_index, period_index, decks_used, decks_total, updated_at
            FROM war_days
            WHERE clan_tag = ? AND is_active = 1
            ORDER BY period_index DESC, member_name ASC
            LIMIT 2000
          `,
          args: [decodedTag]
        }),
        turso.execute({
          sql: `
            SELECT member_tag, member_name, member_rank,
                   reference_section_index, sum_4w, avg_4w, eligible_elder,
                   sum_8w, avg_8w, eligible_colider, calculated_at
            FROM promotions
            WHERE clan_tag = ? AND is_active = 1
          `,
          args: [decodedTag]
        })
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso (60s)')), 60000))
    ]);

    const body = {
      war_days: warsResult.rows,
      promotions: promosResult.rows,
      generated_at: new Date().toISOString()
    };

    // Cache público de 5 minutos: o navegador/CDN reaproveita a resposta
    // entre visitas, aliviando o backend
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(body);
  } catch (error) {
    console.error('Erro em snapshot:', error.message);
    return res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
