import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ROYALE_API_BASE = process.env.ROYALE_API_BASE || 'http://45.79.218.79/v1';

async function callRoyaleAPI(path) {
  const token = process.env.ROYALE_API_TOKEN;
  const res = await fetch(`${ROYALE_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'clash-clan-tracker-worker',
    },
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`RoyaleAPI ${path} -> HTTP ${res.status} - ${errorText}`);
  }
  return res.json();
}

async function callRoyaleAPIWithRetry(path, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callRoyaleAPI(path);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function encodeTag(tag) {
  return encodeURIComponent(tag);
}

async function collectClanAttacks(clan) {
  console.log(`[ATTACKS] Coletando dados do clã ${clan.tag}`);
  
  try {
    const race = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}/currentriverrace`);
    
    // Se NÃO for dia de guerra, encerra sem tocar no banco (preserva todo o histórico gravado)
    if (race.periodType !== 'warDay') {
      console.log(`[${clan.tag}] Não é dia de guerra. Histórico preservado no banco.`);
      return { clan: clan.tag, status: 'skipped_not_warday' };
    }

    const clanInfo = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}`);
    const memberMap = new Map();
    (clanInfo.memberList || []).forEach(m => {
      memberMap.set(m.tag, { name: m.name, rank: m.rank || m.role || 'member' });
    });

    const sectionIndex = race.sectionIndex;
    const periodIndex = race.periodIndex;
    const participants = race.clan?.participants || [];
    const now = new Date().toISOString();

    if (participants.length === 0) {
      return { clan: clan.tag, status: 'no_participants' };
    }

    const statements = [];

    // Insere ou atualiza o dia de guerra atual
    for (const p of participants) {
      if (!memberMap.has(p.tag)) continue;
      const memberInfo = memberMap.get(p.tag);
      
      statements.push({
        sql: `
          INSERT INTO war_days
            (clan_tag, section_index, period_index, member_tag, member_name, 
             member_rank, decks_used, decks_total, updated_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(clan_tag, period_index, member_tag) DO UPDATE SET
            member_name = excluded.member_name,
            member_rank = excluded.member_rank,
            decks_used = excluded.decks_used,
            updated_at = excluded.updated_at,
            is_active = excluded.is_active
        `,
        args: [
          clan.tag,
          sectionIndex,
          periodIndex,
          p.tag,
          memberInfo?.name || p.name,
          memberInfo?.rank || 'member',
          p.decksUsedToday ?? 0,
          4,
          now,
          1
        ]
      });
    }

    // Mantém no banco apenas as últimas 20 rodadas de guerra (limpeza enxuta).
    // Passo 1: identifica os periods a apagar (mais antigos que as 20 mais recentes)
    statements.push({
      sql: `
        DELETE FROM war_days
        WHERE clan_tag = ? AND period_index < (
          SELECT MIN(period_index) FROM (
            SELECT DISTINCT period_index FROM war_days
            WHERE clan_tag = ?
            ORDER BY period_index DESC
            LIMIT 20
          )
        )
      `,
      args: [clan.tag, clan.tag]
    });

    if (statements.length > 0) {
      await Promise.race([
        turso.batch(statements, "write"),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso Batch (25s)')), 25000))
      ]);
    }

    return { clan: clan.tag, status: 'success', saved: statements.length - 1 };
  } catch (err) {
    console.error(`[${clan.tag}] Erro na coleta:`, err.message);
    throw err;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { tag } = req.query;
    let clans = [];

    if (tag) {
      clans = [{ tag: decodeURIComponent(tag) }];
    } else {
      const clansResult = await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1');
      clans = clansResult.rows;
    }

    const results = [];
    for (const clan of clans) {
      try {
        const resCol = await collectClanAttacks(clan);
        results.push(resCol);
      } catch (err) {
        results.push({ clan: clan.tag, error: err.message });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
