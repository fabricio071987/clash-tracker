import { createClient } from '@libsql/client';
import { refreshWarCache, refreshPromoCache } from './cache-utils.js';

const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.key !== 'clashtracker2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const clans = await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1');
    const results = [];
    for (const c of clans.rows) {
      try {
        const w = await refreshWarCache(turso, c.tag);
        const p = await refreshPromoCache(turso, c.tag);
        results.push({ clan: c.tag, war_rows: w, promo_rows: p });
      } catch (e) {
        results.push({ clan: c.tag, error: e.message });
      }
    }
    res.status(200).json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
