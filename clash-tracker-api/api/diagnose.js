import { createClient } from '@libsql/client';
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== process.env.DIAG_KEY && req.query.key !== 'clashtracker2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const tables = await turso.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const counts = {};
    for (const t of tables.rows) {
      const c = await turso.execute(`SELECT COUNT(*) AS n FROM "${t.name}"`);
      counts[t.name] = c.rows[0].n;
    }
    // Últimos period_index de war_days por clã
    const warInfo = await turso.execute(`SELECT clan_tag, COUNT(*) AS n, MAX(period_index) AS maxp, MIN(period_index) AS minp FROM war_days GROUP BY clan_tag`);
    res.status(200).json({ tables: tables.rows.map(r=>r.name), counts, warInfo: warInfo.rows, generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
