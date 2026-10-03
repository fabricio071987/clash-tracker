// Diagnóstico: mede cada consulta ao banco separadamente, com limite de tempo.
// Abrir: /api/diag
import { makeTurso } from './cache-utils.js';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms / 1000}s`)), ms))]);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const turso = makeTurso();
  const url = (process.env.TURSO_DATABASE_URL || '').replace(/\/\/([^.]+)\./, '//***.');
  const out = { url_tipo: url.split('://')[0], testes: [] };

  const tests = [
    ['ping', 'SELECT 1 AS ok'],
    ['tabelas', `SELECT name FROM sqlite_master WHERE type='table'`],
    ['clans', 'SELECT COUNT(*) AS n FROM clans'],
    ['promotions', 'SELECT COUNT(*) AS n FROM promotions'],
    ['war_log_total', 'SELECT COUNT(*) AS n FROM war_log'],
    ['war_log_por_cla', 'SELECT clan_tag, COUNT(*) AS linhas, COUNT(DISTINCT war_key) AS dias FROM war_log GROUP BY clan_tag'],
    ['cache_data_linhas', 'SELECT COUNT(*) AS n FROM cache_data'],
    ['cache_data_tamanho', 'SELECT clan_tag, length(war_days) AS tam_ataques, length(promotions) AS tam_medias, updated_at FROM cache_data'],
    ['cache_data_estrutura', `SELECT sql FROM sqlite_master WHERE name='cache_data'`],
    ['war_days_antiga', 'SELECT COUNT(*) AS n FROM war_days'],
  ];

  for (const [nome, sql] of tests) {
    const t0 = Date.now();
    try {
      const r = await withTimeout(turso.execute(sql), 8000);
      out.testes.push({ nome, ms: Date.now() - t0, resultado: r.rows });
    } catch (e) {
      out.testes.push({ nome, ms: Date.now() - t0, erro: e.message });
    }
  }
  res.status(200).json(out);
}
