import { createClient } from '@libsql/client';
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const idx = await turso.execute(`CREATE INDEX IF NOT EXISTS idx_war_days_clan_period
      ON war_days (clan_tag, is_active, period_index DESC)`);
    const idx2 = await turso.execute(`CREATE INDEX IF NOT EXISTS idx_promo_clan
      ON promotions (clan_tag, is_active)`);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
