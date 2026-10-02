// ============================================================
// SNAPSHOT: devolve para o site
//   - war_days: últimos 16 dias de guerra do clã (tabela war_log)
//   - promotions: promoções prontas (cache_data)
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

  try {
    const turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    await ensureCacheTables(turso);

    const warRows = await withTimeout(readWarLog(turso, decodedTag), 8000);

    const promoResult = await withTimeout(turso.execute({
      sql: `SELECT promotions, updated_at FROM cache_data WHERE clan_tag = ?`,
      args: [decodedTag]
    }), 8000);
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
