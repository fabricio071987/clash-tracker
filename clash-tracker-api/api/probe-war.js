import { createClient } from '@libsql/client';
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  const tag = req.query.tag ? decodeURIComponent(req.query.tag) : null;
  try {
    const sql = tag
      ? { sql: `SELECT member_tag, member_name, member_rank, section_index, period_index, decks_used, decks_total, updated_at FROM war_days WHERE clan_tag = ? AND is_active = 1 ORDER BY period_index DESC, member_name ASC LIMIT 2000`, args: [tag] }
      : { sql: `SELECT clan_tag, COUNT(*) n FROM war_days GROUP BY clan_tag` };
    const t0 = Date.now();
    const r = await turso.execute(sql);
    const t1 = Date.now();
    res.status(200).json({ tag: tag || 'all', rows: tag ? r.rows.length : r.rows, query_ms: t1 - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
