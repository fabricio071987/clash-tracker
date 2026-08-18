// ============================================================
// populate-cache: repovoa o cache do histórico de guerras.
// Pode ser chamado com ?tag=X para um clã ou sem tag para todos.
// Funciona por período (guerra), então cada etapa é leve e
// cabe no limite de execução da Vercel.
// ============================================================
import { createClient } from '@libsql/client';
import { ensureCacheTables, refreshWarCachePeriod, refreshWarCacheMeta, refreshPromoCache } from './cache-utils.js';

const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const MAX_WAR_SLOTS = 20;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  try {
    await ensureCacheTables(turso);
    const tag = req.query.tag ? decodeURIComponent(req.query.tag) : null;
    let clans;
    if (tag) {
      clans = [{ tag }];
    } else {
      clans = (await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1')).rows;
    }

    const results = [];
    for (const c of clans.rows || clans) {
      try {
        // Últimos 20 períodos (guerras) conhecidos no banco
        const periods = (await turso.execute({
          sql: `SELECT DISTINCT period_index FROM war_days WHERE clan_tag = ? ORDER BY period_index DESC LIMIT ?`,
          args: [c.tag, MAX_WAR_SLOTS]
        })).rows.map(r => r.period_index);

        const perWar = [];
        for (const p of periods) {
          const n = await refreshWarCachePeriod(turso, c.tag, p);
          perWar.push({ period: p, rows: n });
        }
        await refreshWarCacheMeta(turso, c.tag);
        await refreshPromoCache(turso, c.tag);
        results.push({ clan: c.tag, periods: perWar.length, perWar });
      } catch (e) {
        results.push({ clan: c.tag, error: e.message });
      }
    }
    res.status(200).json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
