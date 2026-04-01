// RobotEvents Skills Calculator API
// Strategy: use the v1 /api/seasons/{id}/skills endpoint which returns a
// pre-ranked leaderboard in ONE request — no token required, no pagination.
// We only use v2 (with token) to resolve the current season ID, then cache it.

const BASE_V2 = 'https://www.robotevents.com/api/v2';
const BASE_V1 = 'https://www.robotevents.com/api/seasons';
const PROGRAM_V5RC = 1;

// In-memory cache (lives as long as the serverless function instance)
const cache = new Map();
const SEASON_TTL  = 60 * 60 * 1000;  // 1 hour
const SKILLS_TTL  = 5  * 60 * 1000;  // 5 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttl) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value, ttl) {
  cache.set(key, { value, at: Date.now(), ttl });
}

// ── Season lookup via v2 (needs token) ────────────────────────────────────────
async function getCurrentSeasonId(token) {
  const cacheKey = 'season:current';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${BASE_V2}/seasons?program[]=${PROGRAM_V5RC}&per_page=10`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw Object.assign(new Error(`Seasons fetch failed: ${res.status}`), { status: res.status });

  const body = await res.json();
  const seasons = body?.data || [];
  const now = new Date();
  const active = seasons
    .sort((a, b) => new Date(b.start) - new Date(a.start))
    .find(s => new Date(s.start) <= now && new Date(s.end) >= now)
    || seasons[0];

  if (!active) throw new Error('No V5RC season found');
  cacheSet(cacheKey, active.id, SEASON_TTL);
  return active.id;
}

// ── Skills leaderboard via v1 (NO token needed) ───────────────────────────────
// Returns array already ranked by RobotEvents
async function fetchSkillsLeaderboard({ seasonId, grade, region, country }) {
  const cacheKey = `skills:${seasonId}:${grade}:${region || ''}:${country || ''}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { data: cached, fromCache: true };

  const params = new URLSearchParams({ post_season: 1 });
  if (grade)   params.set('grade_level', grade);
  if (region)  params.set('region', region);
  if (country) params.set('country_region', country);

  const url = `${BASE_V1}/${seasonId}/skills?${params}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'vex-state-tool/2.0' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Skills v1 fetch failed: ${res.status}${text ? ' — ' + text.slice(0, 200) : ''}`),
      { status: res.status }
    );
  }

  const raw = await res.json();
  // v1 returns an array directly, already sorted rank 1→N
  const teams = (Array.isArray(raw) ? raw : raw?.data || []).map((row, i) => ({
    rank:     row.rank    ?? (i + 1),
    team:     row.team?.team_number ?? row.team?.number ?? String(row.team_id ?? ''),
    teamName: row.team?.team_name   ?? '',
    region:   row.team?.event_region ?? row.event_region ?? '',
    country:  row.team?.country      ?? '',
    auton:    row.scores?.programming ?? row.programming_score ?? 0,
    driver:   row.scores?.driver      ?? row.driver_score      ?? 0,
    total:    row.scores?.score       ?? row.score             ?? 0,
  }));

  cacheSet(cacheKey, teams, SKILLS_TTL);
  return { data: teams, fromCache: false };
}

function buildPlan(you, target) {
  if (!target) return { needed: 0, recommended: ['No team at that rank in this filter scope.'] };

  const needed = Math.max(0, target.total - (you?.total ?? 0) + 1);
  const autonGap = Math.max(0, target.auton - (you?.auton ?? 0) + 1);

  if (!you) return {
    needed: target.total + 1,
    recommended: [
      `To pass rank #${target.rank}, post at least ${target.total + 1} total points.`,
      `Aim for ${target.auton + 1}+ auton for tie-break safety.`,
    ],
  };

  if (needed === 0) return {
    needed: 0,
    recommended: ['You are already at or above this target rank. Keep improving autonomous for tie-breaks.'],
  };

  const splitAuton = Math.max(autonGap, Math.ceil(needed * 0.35));
  const splitDriver = Math.max(0, needed - splitAuton);
  return {
    needed,
    recommended: [
      `You need +${needed} total points to pass rank #${target.rank}.`,
      `Tie-break: improve autonomous by at least +${autonGap}.`,
      `Balanced target: +${splitAuton} auton and +${splitDriver} driver.`,
    ],
  };
}

function normalizeGrade(g) {
  if (!g) return 'High School';
  const s = String(g).toLowerCase();
  if (s.includes('middle')) return 'Middle School';
  if (s.includes('college') || s.includes('university')) return 'College';
  return 'High School';
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // /api/status
  if (req.url?.includes('/status')) {
    res.status(200).json({ tokenConfigured: Boolean(process.env.ROBOTEVENTS_TOKEN) });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' }); return;
  }

  try {
    const input = req.method === 'POST' ? (req.body || {}) : (req.query || {});

    const token = String(input.token || process.env.ROBOTEVENTS_TOKEN || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Missing ROBOTEVENTS_TOKEN. Set it in Vercel env vars or pass token in request.' });
      return;
    }

    const grade      = normalizeGrade(input.grade);
    const region     = String(input.region  || '').trim() || null;
    const country    = String(input.country || '').trim() || null;
    const teamQuery  = String(input.team    || '').trim().toUpperCase() || null;
    const targetRank = Math.max(1, parseInt(input.rank, 10) || 10);

    // 1. Get season ID (cached 1hr)
    const seasonId = await getCurrentSeasonId(token);

    // 2. Fetch leaderboard (cached 5min) — single v1 request!
    const { data: allTeams, fromCache } = await fetchSkillsLeaderboard({ seasonId, grade, region, country });

    // 3. Find your team
    const you = teamQuery
      ? allTeams.find(r => r.team === teamQuery)
        || allTeams.find(r => r.team.includes(teamQuery))
        || allTeams.find(r => r.teamName.toUpperCase().includes(teamQuery))
        || null
      : null;

    const target = allTeams.find(r => r.rank === targetRank) || allTeams[targetRank - 1] || null;
    const plan = buildPlan(you, target);

    res.status(200).json({
      season:      { id: seasonId },
      filters:     { grade, region, country, team: teamQuery },
      targetRank,
      you,
      target,
      plan,
      needed:      plan.needed,
      allTeams,
      totalTeams:  allTeams.length,
      cached:      fromCache,
    });

  } catch (err) {
    console.error('state handler error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
};
