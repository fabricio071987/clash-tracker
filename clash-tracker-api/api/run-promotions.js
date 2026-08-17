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

async function calculatePromotions(clan) {
  console.log(`[PROMO] Calculando promoções para ${clan.tag}`);
  
  try {
    const clanInfo = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}`);
    
    const memberMap = new Map();
    (clanInfo.memberList || []).forEach(m => {
      memberMap.set(m.tag, { name: m.name, rank: m.rank || m.role || 'member' });
    });

    if (memberMap.size === 0) {
      return { clan: clan.tag, status: 'no_members' };
    }

    // Só as 8 últimas semanas são usadas para o cálculo da média (retenção enxuta)
    const log = await callRoyaleAPIWithRetry(`/clans/${encodeTag(clan.tag)}/riverracelog?limit=8`);
    const items = log.items || [];
    if (items.length === 0) {
      return { clan: clan.tag, status: 'no_history' };
    }

    const fameByMember = new Map();
    for (const item of items) {
      const standing = (item.standings || []).find((s) => s.clan?.tag === clan.tag);
      const participants = standing?.clan?.participants || [];
      for (const p of participants) {
        if (!memberMap.has(p.tag)) continue;
        if (!fameByMember.has(p.tag)) fameByMember.set(p.tag, []);
        fameByMember.get(p.tag).push(p.fame || 0);
      }
    }

    const referenceSectionIndex = items[0]?.sectionIndex ?? null;
    const now = new Date().toISOString();
    const statements = [];

    // LIMPEZA AUTOMÁTICA: Apaga as promoções antigas deste clã antes de inserir as novas
    statements.push({
      sql: `DELETE FROM promotions WHERE clan_tag = ?`,
      args: [clan.tag]
    });

    // MONTAGEM DOS NOVOS DADOS
    // IMPORTANTE: a soma considera as últimas 4/8 semanas do histórico do clã.
    // Se o membro não participou de alguma semana, ela entra como 0 fama (não é ignorada).
    // A divisão é SEMPRE por 4 (avg_4w) e por 8 (avg_8w), independente de quantas
    // guerras o membro participou. Assim ninguém aparece com média inflada por
    // ter participado de poucas guerras.
    for (const [memberTag, weeksFame] of fameByMember.entries()) {
      const memberInfo = memberMap.get(memberTag);
      const last4 = weeksFame.slice(0, 4);
      const last8 = weeksFame.slice(0, 8);
      // Preenche com 0 as semanas em que o membro não participou
      while (last4.length < 4) last4.push(0);
      while (last8.length < 8) last8.push(0);
      const sum4 = last4.reduce((a, b) => a + b, 0);
      const sum8 = last8.reduce((a, b) => a + b, 0);
      const avg4 = sum4 / 4;
      const avg8 = sum8 / 8;

      statements.push({
        sql: `
          INSERT INTO promotions
            (clan_tag, member_tag, member_name, member_rank,
             reference_section_index, sum_4w, avg_4w, eligible_elder, 
             sum_8w, avg_8w, eligible_colider, calculated_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `,
        args: [
          clan.tag,
          memberTag,
          memberInfo?.name || 'Membro',
          memberInfo?.rank || 'member',
          referenceSectionIndex,
          sum4,
          avg4,
          avg4 >= 2500 ? 1 : 0,
          sum8,
          avg8,
          avg8 >= 2500 ? 1 : 0,
          now
        ]
      });
    }

    if (statements.length > 0) {
      await Promise.race([
        turso.batch(statements, "write"),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Turso Batch (25s)')), 25000))
      ]);
    }

    console.log(`[PROMO] Sucesso: ${statements.length - 1} membros gravados para ${clan.tag}`);
    return { clan: clan.tag, status: 'success', saved: statements.length - 1 };
  } catch (err) {
    console.error(`[${clan.tag}] Erro nas promoções:`, err.message);
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

    // Se passar a tag (?tag=%23XYZ), processa só ela. Senão, busca todos os clãs do banco.
    if (tag) {
      clans = [{ tag: decodeURIComponent(tag) }];
    } else {
      const clansResult = await turso.execute('SELECT tag, name FROM clans WHERE enabled = 1');
      clans = clansResult.rows;
    }

    const results = [];
    for (const clan of clans) {
      try {
        const resPromo = await calculatePromotions(clan);
        results.push(resPromo);
      } catch (err) {
        results.push({ clan: clan.tag, error: err.message });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
