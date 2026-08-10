import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Usa a variável de ambiente ou o IP padrão
const ROYALE_API_BASE = process.env.ROYALE_API_BASE || 'http://45.79.218.79/v1';

async function callRoyaleAPI(path) {
  const token = process.env.ROYALE_API_TOKEN;
  
  console.log(`[API] Chamando: ${path}`);
  console.log(`[API] Token: ${token ? 'Presente' : 'AUSENTE'}`);
  console.log(`[API] Base URL: ${ROYALE_API_BASE}`);
  
  const res = await fetch(`${ROYALE_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'clash-clan-tracker-worker',
    },
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[API] Erro ${res.status}: ${errorText}`);
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
      console.log(`[API] Tentativa ${attempt + 1} falhou: ${err.message}`);
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
    const clanInfo = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}`);
    
    const memberMap = new Map();
    (clanInfo.memberList || []).forEach(m => {
      memberMap.set(m.tag, { name: m.name, rank: m.rank || m.role || 'member' });
    });

    const race = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}/currentriverrace`);

    if (race.periodType !== 'warDay') {
      console.log(`[${clan.tag}] Não é dia de guerra. Pulando.`);
      return;
    }

    const sectionIndex = race.sectionIndex;
    const periodIndex = race.periodIndex;
    const participants = race.clan?.participants || [];
    const now = new Date().toISOString();

    if (participants.length === 0) {
      console.log(`[${clan.tag}] Nenhum participante encontrado.`);
      return;
    }

    let savedCount = 0;

    for (const p of participants) {
      if (!memberMap.has(p.tag)) continue;
      const memberInfo = memberMap.get(p.tag);
      
      await turso.execute({
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
      savedCount++;
    }

    console.log(`[${clan.tag}] ${savedCount} membros salvos.`);

    // Marca inativos
    const currentMemberTags = Array.from(memberMap.keys());
    if (currentMemberTags.length > 0) {
      const placeholders = currentMemberTags.map(() => '?').join(',');
      await turso.execute({
        sql: `UPDATE war_days SET is_active = 0 
              WHERE clan_tag = ? AND member_tag NOT IN (${placeholders})`,
        args: [clan.tag, ...currentMemberTags]
      });
    }

    // Mantém 20 dias
    await turso.execute({
      sql: `
        DELETE FROM war_days
        WHERE clan_tag = ? AND period_index NOT IN (
          SELECT period_index FROM war_days
          WHERE clan_tag = ? GROUP BY period_index
          ORDER BY period_index DESC LIMIT 20
        )
      `,
      args: [clan.tag, clan.tag]
    });

    console.log(`[${clan.tag}] Coleta finalizada.`);
  } catch (err) {
    console.error(`[${clan.tag}] Erro na coleta:`, err.message);
    throw err;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- CORREÇÃO DO TIMEOUT DA VERCEL ---
  // 1. Já manda a resposta imediata para o cron-job.org (para a Vercel parar de contar o tempo)
  res.status(200).json({ 
    success: true, 
    message: 'Coleta de ataques iniciada em background!',
    timestamp: new Date().toISOString()
  });

  // 2. O processamento pesado roda em segundo plano (setTimeout 0)
  setTimeout(async () => {
    try {
      console.log('[CRON] Iniciando coleta de ataques...');
      
      const clans = await turso.execute(
        'SELECT tag, name FROM clans WHERE enabled = 1'
      );

      console.log(`[CRON] ${clans.rows.length} clã(s) encontrado(s)`);

      for (const clan of clans.rows) {
        try {
          await collectClanAttacks(clan);
        } catch (err) {
          console.error(`Erro no clã ${clan.tag}:`, err.message);
        }
      }

      console.log('[CRON] Coleta de ataques finalizada.');
      
    } catch (error) {
      console.error('Erro no processamento em background:', error);
    }
  }, 0);
  // ------------------------------------
}
