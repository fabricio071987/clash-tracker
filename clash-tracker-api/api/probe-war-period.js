import { createClient } from '@libsql/client';
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  const tag = req.query.tag ? decodeURIComponent(req.query.tag) : null;
  const period = req.query.period ? Number(req.query.period) : null;
  if (!tag || !period) return res.status(400).json({ error: 'informe tag e period' });
  try {
    const t0 = Date.now();
    const r = await turso.execute({
      sql: `SELECT member_tag, member_name, member_rank, section_index, period_index, decks_used, decks_total, updated_at
            FROM war_days WHERE clan_tag = ? AND is_active = 1 AND period_index = ?`,
      args: [tag, period]
    });
    const t1 = Date.now();
    res.status(200).json({ rows: r.rows.length, query_ms: t1 - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
