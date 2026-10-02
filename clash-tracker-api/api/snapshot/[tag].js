// ============================================================
// SNAPSHOT: devolve para o site
//   - war_days: últimos 16 dias de guerra do clã (tabela war_log)
//   - promotions: promoções prontas (cache_data)
// Cada parte é lida separadamente: se uma falhar, a outra
// continua aparecendo no site, e o motivo vai em "errors".
// ============================================================
import { createClient } from '@libsql/client';
import { ensureCacheTables, readWarLog } from '../cache-utils.js';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout (${ms / 1000}s)`)), ms))]);
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
    warRows = await withTimeout(readWarLog(turso, decodedTag), 20000);
  } catch (e) {
    console.error('[SNAPSHOT] ataques:', e.message);
    errors.push(`ataques: ${e.message}`);
  }

  try {
    await withTimeout(ensureCacheTables(turso), 10000);
    const promoResult = await withTimeout(turso.execute({
      sql: `SELECT promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
      args: [decodedTag]
    }), 15000);
    if (promoResult.rows && promoResult.rows.length > 0) {
      promotions = JSON.parse(promoResult.rows[0].promotions || '[]');
      updatedAt = promoResult.rows[0].updated_at;
    }
  } catch (e) {
    console.error('[SNAPSHOT] promoções:', e.message);
    errors.push(`promoções: ${e.message}`);
  }

  // Só deixa a Vercel guardar em cache se veio tudo certo
  res.setHeader('Cache-Control', errors.length ? 'no-store' : 'public, max-age=300');
  return res.status(200).json({
    war_days: warRows,
    promotions,
    generated_at: updatedAt || new Date().toISOString(),
    errors,
  });
}
