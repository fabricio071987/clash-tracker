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

async function collectClanAttacks(clan) {
  console.log(`[ATTACKS] Coletando dados do clã ${clan.tag}`);
  
  const clanInfo = await callRoyaleAPI(`/clans/${encodeTag(clan.tag)}`);
  
  const memberMap = new Map();
  (clanInfo.members || []).forEach(m => {
    memberMap.set(m.tag, { name: m.name, rank: m.rank || m.role || 'member' });
  });

  const race = await callRoyaleAPI(`/clans/${encodeTag(clan.tag)}/currentriverrace`);

  if (race.periodType !== 'warDay') {
    console.log(`[${clan.tag}] Não é dia de guerra. Pulando.`);
    return;
  }

  const sectionIndex = race.sectionIndex;
  const periodIndex = race.periodIndex;
  const participants = race.clan?.participants || [];
  const now = new Date().toISOString();

  if (participants.length === 0) return;

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
  }

  const currentMemberTags = Array.from(memberMap.keys());
  if (currentMemberTags.length > 0) {
    const placeholders = currentMemberTags.map(() => '?').join(',');
    await turso.execute({
      sql: `UPDATE war_days SET is_active = 0 
            WHERE clan_tag = ? AND member_tag NOT IN (${placeholders})`,
      args: [clan.tag, ...currentMemberTags]
    });
  }

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
        await collectClanAttacks(clan);
      } catch (err) {
        console.error(`Erro no clã ${clan.tag}:`, err.message);
      }
    }

    res.status(200).json({ 
      success: true, 
      message: 'Coleta de ataques executada com sucesso.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}