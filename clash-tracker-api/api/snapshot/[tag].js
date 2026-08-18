// ============================================================
// SNAPSHOT (leve): lê apenas a tabela de cache (cache_data),
// que já vem pronta gravada pelo cronjob (run-attacks /
// run-promotions). Nunca faz consulta pesada ao vivo:
// responde em milissegundos, dentro do limite da Vercel.
// Se o cache estiver vazio (primeira vez), tenta preencher
// na hora com timeout curto para não travar o site.
// ============================================================
import { createClient } from '@libsql/client';
import { refreshWarCache, refreshPromoCache } from '../cache-utils.js';

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
    const turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    // 1) Leitura leve: 1 linha do cache por clã
    const cached = await Promise.race([
      turso.execute({
        sql: `SELECT war_days, promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
        args: [decodedTag]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout (20s)')), 20000))
    ]);

    let warDays = [];
    let promotions = [];
    let updatedAt = null;

    if (cached.rows && cached.rows.length > 0) {
      warDays = JSON.parse(cached.rows[0].war_days || '[]');
      promotions = JSON.parse(cached.rows[0].promotions || '[]');
      updatedAt = cached.rows[0].updated_at;
    }

    // 2) Primeira vez (cache vazio): preenche na hora, com proteção de tempo
    if (!updatedAt) {
      try {
        const [warRows, promoRows] = await Promise.allSettled([
          refreshWarCache(turso, decodedTag),
          refreshPromoCache(turso, decodedTag)
        ]);
        if (warRows.status === 'fulfilled') warDays = warRows.value.map(r => r) || [];
        if (promoRows.status === 'fulfilled') promotions = promoRows.value.map(r => r) || [];
        // refetch pós-gravação para garantir consistência
        const fresh = await turso.execute({
          sql: `SELECT war_days, promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
          args: [decodedTag]
        });
        if (fresh.rows && fresh.rows.length > 0) {
          warDays = JSON.parse(fresh.rows[0].war_days || '[]');
          promotions = JSON.parse(fresh.rows[0].promotions || '[]');
          updatedAt = fresh.rows[0].updated_at;
        }
      } catch (e) {
        console.error('Erro ao preencher cache inicial:', e.message);
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ war_days: warDays, promotions, generated_at: updatedAt || new Date().toISOString() });
  } catch (error) {
    console.error('Erro em snapshot:', error.message);
    return res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
