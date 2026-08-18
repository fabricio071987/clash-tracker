// ============================================================
// cache-utils.js: cache de leitura LEVE, gravado guerra a guerra.
//
// Estrutura:
//   war_cache_war: 1 linha por (clan_tag, period_index) -> JSON das
//                  linhas de war_days daquela guerra (~50 linhas).
//   war_cache_meta: 1 linha por clan_tag -> JSON dos period_index
//                   conhecidos (para montar a tabela 1-20).
//   cache_data:     promotions prontas (consulta leve, 1 linha/clã).
//
// Todas as operações são rápidas (<2s) e cabem no limite da Vercel.
// ============================================================
import { createClient } from '@libsql/client';

export function cacheTurso() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export async function ensureCacheTables(turso) {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS war_cache_war (
      clan_tag TEXT NOT NULL,
      period_index INTEGER NOT NULL,
      rows_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (clan_tag, period_index)
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS war_cache_meta (
      clan_tag TEXT PRIMARY KEY,
      periods_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS cache_data (
      clan_tag TEXT PRIMARY KEY,
      war_days TEXT NOT NULL DEFAULT '[]',
      promotions TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
}

// ===== WARS: cache guerra a guerra =====

// Grava (ou atualiza) UMA guerra no cache. Consulta LEVE por período.
export async function refreshWarCachePeriod(turso, clanTag, periodIndex) {
  await ensureCacheTables(turso);

  const war = await turso.execute({
    sql: `
      SELECT member_tag, member_name, member_rank, section_index,
             period_index, decks_used, decks_total, updated_at
      FROM war_days
      WHERE clan_tag = ? AND is_active = 1 AND period_index = ?
    `,
    args: [clanTag, periodIndex]
  });

  await turso.execute({
    sql: `
      INSERT INTO war_cache_war (clan_tag, period_index, rows_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(clan_tag, period_index) DO UPDATE SET
        rows_json = excluded.rows_json,
        updated_at = excluded.updated_at
    `,
    args: [clanTag, periodIndex, JSON.stringify(war.rows || []), new Date().toISOString()]
  });
  return war.rows.length;
}

// Atualiza a meta (lista de períodos conhecidos) de um clã.
export async function refreshWarCacheMeta(turso, clanTag) {
  await ensureCacheTables(turso);

  const meta = await turso.execute({
    sql: `SELECT DISTINCT period_index FROM war_days WHERE clan_tag = ? ORDER BY period_index DESC LIMIT 25`,
    args: [clanTag]
  });
  const periods = meta.rows.map(r => r.period_index);

  await turso.execute({
    sql: `
      INSERT INTO war_cache_meta (clan_tag, periods_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(clan_tag) DO UPDATE SET
        periods_json = excluded.periods_json,
        updated_at = excluded.updated_at
    `,
    args: [clanTag, JSON.stringify(periods), new Date().toISOString()]
  });
  return periods.length;
}

// ===== PROMOTIONS: cache por clã (consulta leve) =====

export async function refreshPromoCache(turso, clanTag, options = {}) {
  await ensureCacheTables(turso);

  const promos = await turso.execute({
    sql: `
      SELECT member_tag, member_name, member_rank,
             reference_section_index, sum_4w, avg_4w, eligible_elder,
             sum_8w, avg_8w, eligible_colider, calculated_at
      FROM promotions
      WHERE clan_tag = ? AND is_active = 1
      ORDER BY member_name ASC
      LIMIT 2000
    `,
    args: [clanTag]
  });

  const rows = promos.rows || [];
  let promosJson = JSON.stringify(rows);

  if (options.extraPromoRows) {
    const extra = JSON.parse(options.extraPromoRows);
    if (Array.isArray(extra) && extra.length) promosJson = JSON.stringify([...rows, ...extra]);
  }

  await turso.execute({
    sql: `
      INSERT INTO cache_data (clan_tag, war_days, promotions, updated_at)
      VALUES (?, COALESCE((SELECT war_days FROM cache_data WHERE clan_tag = ?), '[]'), ?, ?)
      ON CONFLICT(clan_tag) DO UPDATE SET
        promotions = excluded.promotions,
        updated_at = excluded.updated_at
    `,
    args: [clanTag, clanTag, promosJson, new Date().toISOString()]
  });
  console.log(`[CACHE] promotions atualizado para ${clanTag} (${rows.length} linhas)`);
  return rows.length;
}
