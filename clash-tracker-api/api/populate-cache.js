// ============================================================
// populate-cache: refaz o cache de promoções.
// Pode ser chamado com ?tag=X para um clã ou sem tag para todos.
// (Os dias de guerra não usam mais cache: o site lê direto da
//  tabela war_log, que guarda só os últimos 16 dias.)
// ============================================================
import { ensureCacheTables, refreshPromoCache, makeTurso } from './cache-utils.js';

const turso = makeTurso();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  try {
    await ensureCacheTables(turso);
    const tag = req.query.tag ? decodeURIComponent(req.query.tag) : null;
    const clans = tag
      ? [{ tag }]
      : (await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1')).rows;

    const results = [];
    for (const c of clans) {
      try {
        const n = await refreshPromoCache(turso, c.tag);
        results.push({ clan: c.tag, promotions: n });
      } catch (e) {
        results.push({ clan: c.tag, error: e.message });
      }
    }
    res.status(200).json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
