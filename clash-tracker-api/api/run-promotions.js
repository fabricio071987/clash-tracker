import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ROYALE_API_BASE = 'https://proxy.royaleapi.dev/v1';

async function callRoyaleAPI(path) {
  const res = await fetch(`${ROYALE_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.ROYALE_API_TOKEN}`,
      'User-Agent': 'clash-clan-tracker-worker',
    },
  });
  if (!res.ok) {
    throw new Error(`RoyaleAPI ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

function encodeTag(tag) {
  return encodeURIComponent(tag);
}

async function calculatePromotions(clan) {
  console.log(`[PROMO] Calculando promoções para ${clan.tag}`);
  
  const clanInfo = await callRoyaleAPI(`/clans/${encodeTag(clan.tag)}`);
  
  const memberMap = new Map();
  (clanInfo.members || []).forEach(m => {
    memberMap.set(m.tag, { name: m.name, rank: m.rank || m.role || 'member' });
  });

  if (memberMap.size === 0) {
    console.log(`[PROMO] Nenhum membro encontrado para ${clan.tag}`);
    return;
  }

  const log = await callRoyaleAPI(`/clans/${encodeTag(clan.tag)}/riverracelog?limit=25`);
  const items = log.items || [];
  if (items.length === 0) {
    console.log(`[PROMO] Nenhum histórico encontrado para ${clan.tag}`);
    return;
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

  for (const [memberTag, weeksFame] of fameByMember.entries()) {
    const memberInfo = memberMap.get(memberTag);
    const last4 = weeksFame.slice(0, 4);
    const last8 = weeksFame.slice(0, 8);
    const sum4 = last4.reduce((a, b) => a + b, 0);
    const sum8 = last8.reduce((a, b) => a + b, 0);
    const avg4 = sum4 / 4;
    const avg8 = sum8 / 8;

    await turso.execute({
      sql: `
        INSERT INTO promotions
          (clan_tag, member_tag, member_name, member_rank,
           reference_section_index,
           sum_4w, avg_4w, eligible_elder, 
           sum_8w, avg_8w, eligible_colider, 
           calculated_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(clan_tag, member_tag, calculated_at) DO UPDATE SET
          member_name = excluded.member_name,
          member_rank = excluded.member_rank,
          sum_4w = excluded.sum_4w,
          avg_4w = excluded.avg_4w,
          eligible_elder = excluded.eligible_elder,
          sum_8w = excluded.sum_8w,
          avg_8w = excluded.avg_8w,
          eligible_colider = excluded.eligible_colider,
          is_active = excluded.is_active
      `,
      args: [
        clan.tag,
        memberTag,
        memberInfo?.name || '',
        memberInfo?.rank || 'member',
        referenceSectionIndex,
        sum4,
        avg4,
        avg4 >= 2500 ? 1 : 0,
        sum8,
        avg8,
        avg8 >= 2500 ? 1 : 0,
        now,
        1
      ]
    });
  }

  const allMemberTags = Array.from(memberMap.keys());
  if (allMemberTags.length > 0) {
    const placeholders = allMemberTags.map(() => '?').join(',');
    await turso.execute({
      sql: `UPDATE promotions SET is_active = 0 
            WHERE clan_tag = ? AND calculated_at = ? 
            AND member_tag NOT IN (${placeholders})`,
      args: [clan.tag, now, ...allMemberTags]
    });
  }

  console.log(`[PROMO] Promoções finalizadas para ${clan.tag}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const clans = await turso.execute(
      'SELECT tag, name FROM clans WHERE enabled = 1'
    );

    for (const clan of clans.rows) {
      try {
        await calculatePromotions(clan);
      } catch (err) {
        console.error(`Erro no clã ${clan.tag}:`, err.message);
      }
    }

    res.status(200).json({ 
      success: true, 
      message: 'Cálculo de promoções executado com sucesso.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}