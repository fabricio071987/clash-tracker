// ============================================================
// cache-utils.js
//
// Tabelas:
//   war_log:    dias de guerra (inclui Coliseu). 1 linha por
//               (clan_tag, war_key, member_tag). Guarda só os
//               últimos 16 dias de guerra de cada clã.
//               war_key = season_id * 1000 + period_index
//               -> número único e crescente, não se repete
//                  quando a temporada vira.
//   cache_data: promotions prontas (1 linha por clã).
// ============================================================
import { createClient } from '@libsql/client';

export const MAX_WAR_DAYS = 16;

export function cacheTurso() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export async function ensureWarLog(turso) {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS war_log (
      clan_tag TEXT NOT NULL,
      war_key INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      section_index INTEGER NOT NULL,
      period_index INTEGER NOT NULL,
      period_type TEXT NOT NULL DEFAULT 'warDay',
      member_tag TEXT NOT NULL,
      member_name TEXT,
      member_rank TEXT,
      decks_used INTEGER NOT NULL DEFAULT 0,
      decks_total INTEGER NOT NULL DEFAULT 4,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (clan_tag, war_key, member_tag)
    )
  `);
}

export async function ensureCacheTables(turso) {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS cache_data (
      clan_tag TEXT PRIMARY KEY,
      war_days TEXT NOT NULL DEFAULT '[]',
      promotions TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
}

// Apaga tudo que for mais antigo que os últimos 16 dias de guerra do clã.
export function trimWarLogStatement(clanTag) {
  return {
    sql: `
      DELETE FROM war_log
      WHERE clan_tag = ? AND war_key < (
        SELECT COALESCE(MIN(war_key), 0) FROM (
          SELECT DISTINCT war_key FROM war_log
          WHERE clan_tag = ?
          ORDER BY war_key DESC
          LIMIT ${MAX_WAR_DAYS}
        )
      )
    `,
    args: [clanTag, clanTag],
  };
}

// Lê os últimos 16 dias de guerra de um clã (tabela pequena, consulta leve).
export async function readWarLog(turso, clanTag) {
  await ensureWarLog(turso);
  const r = await turso.execute({
    sql: `
      SELECT war_key, season_id, section_index, period_index, period_type,
             member_tag, member_name, member_rank, decks_used, decks_total, updated_at
      FROM war_log
      WHERE clan_tag = ?
      ORDER BY war_key DESC, member_name ASC
    `,
    args: [clanTag],
  });
  return r.rows || [];
}

// ===== PROMOTIONS: cache por clã (lógica inalterada) =====

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
      VALUES (?, '[]', ?, ?)
      ON CONFLICT(clan_tag) DO UPDATE SET
        war_days = '[]',
        promotions = excluded.promotions,
        updated_at = excluded.updated_at
    `,
    args: [clanTag, promosJson, new Date().toISOString()]
  });
  console.log(`[CACHE] promotions atualizado para ${clanTag} (${rows.length} linhas)`);
  return rows.length;
}
