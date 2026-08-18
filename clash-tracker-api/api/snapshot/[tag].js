// ============================================================
// SNAPSHOT (leve): monta a resposta combinando:
//   - war_cache_war: 1 SELECT leve por guerra (período)
//   - war_cache_meta: lista dos períodos conhecidos do clã
//   - cache_data: promotions prontas
// Nenhuma consulta pesada; responde em ms.
// ============================================================
import { createClient } from '@libsql/client';
import { ensureCacheTables } from '../cache-utils.js';

const MAX_WAR_SLOTS = 20;

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
    await ensureCacheTables(turso);

    const timeoutMs = 8000;

    // 1) Meta: períodos conhecidos do clã (cache ou banco, leve)
    const metaQuery = turso.execute({
      sql: `SELECT periods_json FROM war_cache_meta WHERE clan_tag = ?`,
      args: [decodedTag]
    });
    const metaResult = await Promise.race([metaQuery, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout (8s)')), timeoutMs))]);
    let periods = [];
    if (metaResult.rows && metaResult.rows.length > 0) {
      periods = JSON.parse(metaResult.rows[0].periods_json || '[]');
    }

    // 2) Guerras: buscar cada período com consulta leve, até preencher 20 slots
    const wanted = periods.slice(0, MAX_WAR_SLOTS); // mais recentes primeiro
    const warRows = [];
    for (const period of wanted) {
      try {
        const w = await Promise.race([
          turso.execute({
            sql: `SELECT rows_json FROM war_cache_war WHERE clan_tag = ? AND period_index = ?`,
            args: [decodedTag, period]
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout (8s)')), timeoutMs))
        ]);
        if (w.rows && w.rows.length > 0) {
          const parsed = JSON.parse(w.rows[0].rows_json || '[]');
          warRows.push(...parsed);
        }
      } catch (e) {
        console.error(`[SNAPSHOT] falha ao ler período ${period}: ${e.message}`);
      }
    }

    // 3) Promoções
    const promoQuery = turso.execute({
      sql: `SELECT promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
      args: [decodedTag]
    });
    const promoResult = await Promise.race([promoQuery, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout (8s)')), timeoutMs))]);
    const promotions = promoResult.rows && promoResult.rows.length > 0
      ? JSON.parse(promoResult.rows[0].promotions || '[]')
      : [];
    const updatedAt = promoResult.rows && promoResult.rows.length > 0
      ? promoResult.rows[0].updated_at
      : null;

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ war_days: warRows, promotions, generated_at: updatedAt || new Date().toISOString() });
  } catch (error) {
    console.error('Erro em snapshot:', error.message);
    return res.status(500).json({ error: `Erro na consulta ao banco: ${error.message}` });
  }
}
