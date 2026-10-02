import { createClient } from '@libsql/client';
import { ensureWarLog, ensureCacheTables, trimWarLogStatement, refreshWarCacheStatement, MAX_WAR_DAYS } from './cache-utils.js';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ROYALE_API_BASE = process.env.ROYALE_API_BASE || 'http://45.79.218.79/v1';

// Tipos de dia em que há ataques de guerra. 'colosseum' = Guerra do Coliseu
// (última semana da temporada). 'training' = dias de treino (não conta).
const WAR_PERIOD_TYPES = new Set(['warDay', 'colosseum']);

async function callRoyaleAPI(path) {
  const token = process.env.ROYALE_API_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(`${ROYALE_API_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'clash-clan-tracker-worker',
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`RoyaleAPI ${path} -> ${err.name === 'AbortError' ? 'timeout 8s' : err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`RoyaleAPI ${path} -> HTTP ${res.status} - ${errorText}`);
  }
  return res.json();
}

async function callRoyaleAPIWithRetry(path, retries = 1) {
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${label} (${ms / 1000}s)`)), ms)),
  ]);
}

// Descobre a temporada atual. O period_index volta para o início a cada
// temporada, então ele sozinho não identifica o dia de guerra.
// Regra: o último item do histórico (riverracelog) é a última semana encerrada.
// Se a semana atual tem sectionIndex maior que ela, estamos na mesma temporada;
// senão, a temporada virou (+1).
async function getCurrentSeasonId(clanTag, race) {
  try {
    const log = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clanTag)}/riverracelog?limit=1`);
    const last = (log.items || [])[0];
    if (last && last.seasonId != null) {
      return race.sectionIndex > last.sectionIndex ? last.seasonId : last.seasonId + 1;
    }
  } catch (err) {
    console.error(`[${clanTag}] Falha ao ler riverracelog: ${err.message}`);
    throw err;
  }
  // Clã sem histórico ainda: usa 0 (próximas temporadas terão número maior)
  return 0;
}

function makeWarKey(seasonId, periodIndex) {
  return seasonId * 1000 + periodIndex;
}

async function oldTableExists(name) {
  const r = await turso.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [name],
  });
  return r.rows.length > 0;
}

// Migração única: copia os dados da tabela antiga war_days para war_log,
// calculando a temporada de cada dia, e depois apaga os dados antigos do clã.
async function migrateOldData(clanTag, seasonId, race) {
  if (!(await oldTableExists('war_days'))) return 0;

  const old = await withTimeout(turso.execute({
    sql: `
      SELECT period_index, MAX(updated_at) AS last_update, COUNT(*) AS n
      FROM war_days
      WHERE clan_tag = ? AND is_active = 1
      GROUP BY period_index
    `,
    args: [clanTag],
  }), 15000, 'Turso leitura antiga');
  if (old.rows.length === 0) return 0;
  const totalOld = old.rows.reduce((acc, r) => acc + Number(r.n), 0);

  // Ordena os períodos do mais recente para o mais antigo (pela data)
  const periodsNewestFirst = old.rows
    .map((r) => [Number(r.period_index), r.last_update])
    .sort((a, b) => (a[1] < b[1] ? 1 : -1));

  // Voltando no tempo, o period_index só diminui dentro de uma temporada.
  // Se ele aumentar, é porque passamos para a temporada anterior.
  const seasonOfPeriod = new Map();
  let season = seasonId;
  let prev = race.periodIndex;
  for (const [period] of periodsNewestFirst) {
    if (period > prev) season -= 1;
    seasonOfPeriod.set(period, season);
    prev = period;
  }

  // Um único comando no banco: copia tudo de uma vez (rápido), com a chave nova por período
  const periods = [...seasonOfPeriod.keys()].map(Number).filter(Number.isFinite);
  const keyCase = periods.map((p) => `WHEN ${p} THEN ${makeWarKey(seasonOfPeriod.get(p), p)}`).join(' ');
  const seasonCase = periods.map((p) => `WHEN ${p} THEN ${Number(seasonOfPeriod.get(p))}`).join(' ');
  const statements = [
    {
      sql: `
        INSERT OR IGNORE INTO war_log
          (clan_tag, war_key, season_id, section_index, period_index, period_type,
           member_tag, member_name, member_rank, decks_used, decks_total, updated_at)
        SELECT clan_tag, CASE period_index ${keyCase} END, CASE period_index ${seasonCase} END,
               section_index, period_index, 'warDay',
               member_tag, member_name, member_rank, COALESCE(decks_used, 0), COALESCE(decks_total, 4), COALESCE(updated_at, '')
        FROM war_days
        WHERE clan_tag = ? AND is_active = 1 AND member_tag IS NOT NULL
      `,
      args: [clanTag],
    },
    { sql: `DELETE FROM war_days WHERE clan_tag = ?`, args: [clanTag] },
    trimWarLogStatement(clanTag),
    refreshWarCacheStatement(clanTag),
  ];
  await withTimeout(turso.batch(statements, 'write'), 25000, 'Turso migração');
  console.log(`[${clanTag}] Migrados ${totalOld} registros antigos para war_log`);
  return totalOld;
}

async function collectClanAttacks(clan) {
  console.log(`[ATTACKS] Coletando dados do clã ${clan.tag}`);

  let race;
  try {
    race = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}/currentriverrace`);
  } catch (err) {
    // 404 = clã não está participando de guerra (ou tag inexistente). Não é falha do sistema.
    if (String(err.message).includes('HTTP 404')) {
      return { clan: clan.tag, status: 'sem_guerra' };
    }
    throw err;
  }
  const isWarDay = WAR_PERIOD_TYPES.has(race.periodType);

  // Só precisamos da temporada em dia de guerra ou se ainda houver dados antigos para migrar
  const hasOld = await oldTableExists('war_days');
  if (!isWarDay && !hasOld) {
    return { clan: clan.tag, status: 'skipped_not_warday', periodType: race.periodType };
  }

  const seasonId = await getCurrentSeasonId(clan.tag, race);
  const migrated = hasOld ? await migrateOldData(clan.tag, seasonId, race) : 0;

  if (!isWarDay) {
    return { clan: clan.tag, status: 'skipped_not_warday', periodType: race.periodType, migrated };
  }

  const clanInfo = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}`);
  const memberMap = new Map();
  (clanInfo.memberList || []).forEach((m) => {
    memberMap.set(m.tag, { name: m.name, rank: m.role || m.rank || 'member' });
  });

  const participants = race.clan?.participants || [];
  if (participants.length === 0) {
    return { clan: clan.tag, status: 'no_participants', migrated };
  }

  const warKey = makeWarKey(seasonId, race.periodIndex);
  const now = new Date().toISOString();
  const statements = [];

  // Grava (ou atualiza) o dia de guerra atual. Rodar várias vezes no mesmo dia
  // só atualiza os números; a última leitura antes da virada do dia é a que fica.
  for (const p of participants) {
    if (!memberMap.has(p.tag)) continue; // só quem está no clã agora
    const info = memberMap.get(p.tag);
    statements.push({
      sql: `
        INSERT INTO war_log
          (clan_tag, war_key, season_id, section_index, period_index, period_type,
           member_tag, member_name, member_rank, decks_used, decks_total, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, ?)
        ON CONFLICT(clan_tag, war_key, member_tag) DO UPDATE SET
          member_name = excluded.member_name,
          member_rank = excluded.member_rank,
          period_type = excluded.period_type,
          decks_used = MAX(war_log.decks_used, excluded.decks_used),
          updated_at = excluded.updated_at
      `,
      args: [
        clan.tag, warKey, seasonId, race.sectionIndex, race.periodIndex, race.periodType,
        p.tag, info.name || p.name, info.rank, p.decksUsedToday ?? 0, now,
      ],
    });
  }

  // Mantém só os últimos 16 dias de guerra e atualiza a linha que o site lê
  statements.push(trimWarLogStatement(clan.tag));
  statements.push(refreshWarCacheStatement(clan.tag));

  await withTimeout(turso.batch(statements, 'write'), 25000, 'Turso batch');

  return {
    clan: clan.tag,
    status: 'success',
    periodType: race.periodType,
    seasonId,
    sectionIndex: race.sectionIndex,
    periodIndex: race.periodIndex,
    warKey,
    saved: statements.length - 2,
    migrated,
  };
}

// Depois que todos os clãs migraram, remove as tabelas antigas que não são mais usadas.
async function dropOldTablesIfEmpty() {
  if (await oldTableExists('war_days')) {
    const r = await turso.execute(`
      SELECT COUNT(*) AS n FROM war_days
      WHERE is_active = 1 AND clan_tag IN (SELECT tag FROM clans WHERE enabled = 1)
    `);
    if (Number(r.rows[0].n) > 0) return false;
    await turso.execute(`DROP TABLE war_days`);
  }
  await turso.execute(`DROP TABLE IF EXISTS war_cache_war`);
  await turso.execute(`DROP TABLE IF EXISTS war_cache_meta`);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureWarLog(turso);
    await ensureCacheTables(turso);

    const { tag } = req.query;
    let clans = [];
    if (tag) {
      clans = [{ tag: decodeURIComponent(tag) }];
    } else {
      const clansResult = await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1');
      clans = clansResult.rows;
    }

    const started = Date.now();
    const results = [];
    for (const clan of clans) {
      if (Date.now() - started > 40000) {
        results.push({ clan: clan.tag, status: 'pending_next_run' });
        continue;
      }
      try {
        const t0 = Date.now();
        const r = await collectClanAttacks(clan);
        r.ms = Date.now() - t0;
        results.push(r);
      } catch (err) {
        console.error(`[${clan.tag}] Erro na coleta:`, err.message);
        results.push({ clan: clan.tag, error: err.message });
      }
    }

    let oldTablesRemoved = false;
    try {
      oldTablesRemoved = await dropOldTablesIfEmpty();
    } catch (err) {
      console.error('Falha ao remover tabelas antigas:', err.message);
    }

    return res.status(200).json({ success: true, maxWarDays: MAX_WAR_DAYS, oldTablesRemoved, results });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
