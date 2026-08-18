// ============================================================
// cache-utils.js: escreve os dados prontos do clã numa tabela
// de cache (cache_data). O endpoint do site APENAS lê essa
// tabela (responde em ms), nunca faz consulta pesada.
// Chamado pelo run-attacks e run-promotions após a coleta.
// ============================================================
import { createClient } from '@libsql/client';

export function cacheTurso() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export async function ensureCacheTable(turso) {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS cache_data (
      clan_tag  TEXT PRIMARY KEY,
      war_days  TEXT NOT NULL DEFAULT '[]',
      promotions TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
}

// Busca war_days prontos do banco e grava no cache
export async function refreshWarCache(turso, clanTag, options = {}) {
  await ensureCacheTable(turso);

  const wars = await turso.execute({
    sql: `
      SELECT member_tag, member_name, member_rank, section_index,
             period_index, decks_used, decks_total, updated_at
      FROM war_days
      WHERE clan_tag = ? AND is_active = 1
      ORDER BY period_index DESC, member_name ASC
      LIMIT 2000
    `,
    args: [clanTag]
  });

  const rows = wars.rows || [];
  let warDaysJson = JSON.stringify(rows);

  if (options.extraWarRows) {
    // mescla linhas adicionais (do próprio run-attacks, se houver)
    const extra = JSON.parse(options.extraWarRows);
    if (Array.isArray(extra) && extra.length) warDaysJson = JSON.stringify([...rows, ...extra]);
  }

  await turso.execute({
    sql: `
      INSERT INTO cache_data (clan_tag, war_days, promotions, updated_at)
      VALUES (?, ?, COALESCE((SELECT promotions FROM cache_data WHERE clan_tag = ?), '[]'), ?)
      ON CONFLICT(clan_tag) DO UPDATE SET
        war_days = excluded.war_days,
        updated_at = excluded.updated_at
    `,
    args: [clanTag, warDaysJson, clanTag, new Date().toISOString()]
  });
  console.log(`[CACHE] war_days atualizado para ${clanTag} (${rows.length} linhas)`);
  return rows.length;
}

// Busca promotions prontas do banco e grava no cache
export async function refreshPromoCache(turso, clanTag, options = {}) {
  await ensureCacheTable(turso);

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
