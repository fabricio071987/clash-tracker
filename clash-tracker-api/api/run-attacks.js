import { createClient } from '@libsql/client';
import { ensureWarLog, trimWarLogStatement, MAX_WAR_DAYS } from './cache-utils.js';

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

  const old = await turso.execute({
    sql: `
      SELECT section_index, period_index, member_tag, member_name, member_rank,
             decks_used, decks_total, updated_at
      FROM war_days
      WHERE clan_tag = ? AND is_active = 1
    `,
    args: [clanTag],
  });
  if (old.rows.length === 0) return 0;

  // Agrupa por period_index e ordena do mais recente para o mais antigo (pela data)
  const byPeriod = new Map();
  for (const r of old.rows) {
    const cur = byPeriod.get(r.period_index);
    if (!cur || r.updated_at > cur) byPeriod.set(r.period_index, r.updated_at);
  }
  const periodsNewestFirst = [...byPeriod.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));

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

  const statements = old.rows.map((r) => {
    const s = seasonOfPeriod.get(r.period_index);
    return {
      sql: `
        INSERT OR IGNORE INTO war_log
          (clan_tag, war_key, season_id, section_index, period_index, period_type,
           member_tag, member_name, member_rank, decks_used, decks_total, updated_at)
        VALUES (?, ?, ?, ?, ?, 'warDay', ?, ?, ?, ?, ?, ?)
      `,
      args: [
        clanTag, makeWarKey(s, r.period_index), s, r.section_index, r.period_index,
        r.member_tag, r.member_name, r.member_rank, r.decks_used ?? 0, r.decks_total ?? 4, r.updated_at,
      ],
    };
  });
  statements.push({ sql: `DELETE FROM war_days WHERE clan_tag = ?`, args: [clanTag] });
  statements.push(trimWarLogStatement(clanTag));

  await withTimeout(turso.batch(statements, 'write'), 25000, 'Turso migração');
  console.log(`[${clanTag}] Migrados ${old.rows.length} registros antigos para war_log`);
  return old.rows.length;
}

async function collectClanAttacks(clan) {
  console.log(`[ATTACKS] Coletando dados do clã ${clan.tag}`);

  const race = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}/currentriverrace`);
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

  // Mantém só os últimos 16 dias de guerra
  statements.push(trimWarLogStatement(clan.tag));

  await withTimeout(turso.batch(statements, 'write'), 25000, 'Turso batch');

  return {
    clan: clan.tag,
    status: 'success',
    periodType: race.periodType,
    seasonId,
    sectionIndex: race.sectionIndex,
    periodIndex: race.periodIndex,
    warKey,
    saved: statements.length - 1,
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
        results.push(await collectClanAttacks(clan));
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
