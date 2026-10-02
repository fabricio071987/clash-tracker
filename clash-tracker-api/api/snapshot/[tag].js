// ============================================================
// SNAPSHOT: devolve para o site, lendo UMA linha do banco:
//   - war_days: últimos 16 dias de guerra (montado na coleta)
//   - promotions: promoções prontas
// ============================================================
import { createClient } from '@libsql/client';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout (${ms / 1000}s)`)), ms))]);
}

function safeParse(text, label, errors) {
  try {
    return JSON.parse(text || '[]');
  } catch (e) {
    errors.push(`${label}: JSON inválido`);
    return [];
  }
}

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

  const turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const errors = [];
  let warRows = [];
  let promotions = [];
  let updatedAt = null;

  try {
    const r = await withTimeout(turso.execute({
      sql: `SELECT war_days, promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
      args: [decodedTag]
    }), 20000);
    if (r.rows && r.rows.length > 0) {
      warRows = safeParse(r.rows[0].war_days, 'ataques', errors);
      promotions = safeParse(r.rows[0].promotions, 'promoções', errors);
      updatedAt = r.rows[0].updated_at;
    }
  } catch (e) {
    console.error('[SNAPSHOT]', e.message);
    errors.push(e.message);
  }

  res.setHeader('Cache-Control', errors.length ? 'no-store' : 'public, max-age=300');
  return res.status(200).json({
    war_days: warRows,
    promotions,
    generated_at: updatedAt || new Date().toISOString(),
    errors,
  });
}
