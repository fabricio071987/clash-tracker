// ============================================================
// SNAPSHOT: devolve para o site, lendo UMA linha do banco.
// Lê o Turso direto pela API HTTP (fetch), sem a biblioteca
// @libsql/client, que trava ao receber respostas grandes.
// ============================================================

const SQL = `SELECT war_days, promotions, updated_at FROM cache_data WHERE clan_tag = ?`;

function tursoHttpUrl() {
  return (process.env.TURSO_DATABASE_URL || '')
    .replace(/^libsql:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

async function queryTurso(tag, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(tursoHttpUrl() + '/v2/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql: SQL, args: [{ type: 'text', value: tag }] } },
          { type: 'close' },
        ],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const first = data.results && data.results[0];
    if (!first || first.type !== 'ok') {
      throw new Error('Turso: ' + JSON.stringify(first && first.error ? first.error : first).slice(0, 200));
    }
    const rows = first.response.result.rows || [];
    if (!rows.length) return null;
    const val = (cell) => (cell && cell.type !== 'null' ? cell.value : null);
    return { war_days: val(rows[0][0]), promotions: val(rows[0][1]), updated_at: val(rows[0][2]) };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout (${ms / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

  const errors = [];
  let warRows = [];
  let promotions = [];
  let updatedAt = null;

  try {
    let row;
    try {
      row = await queryTurso(decodedTag, 10000);
    } catch (first) {
      console.error('[SNAPSHOT] 1a tentativa falhou:', first.message);
      row = await queryTurso(decodedTag, 15000);
    }
    if (row) {
      warRows = safeParse(row.war_days, 'ataques', errors);
      promotions = safeParse(row.promotions, 'promoções', errors);
      updatedAt = row.updated_at;
    }
  } catch (e) {
    console.error('[SNAPSHOT]', e.message);
    errors.push(e.message);
  }

  res.setHeader('Cache-Control', errors.length ? 'no-store' : 'public, s-maxage=120, stale-while-revalidate=600');
  return res.status(200).json({
    war_days: warRows,
    promotions,
    generated_at: updatedAt || new Date().toISOString(),
    errors,
  });
}
