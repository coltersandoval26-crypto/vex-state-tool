const BASE_URL = 'https://www.robotevents.com/api/v2';
const PROGRAM_V5RC = 1;
const PAGE_SIZE = 250;
const SKILLS_CONCURRENCY = 8;

function normalizeGrade(grade) {
  if (!grade) return undefined;
  const raw = String(grade).toLowerCase().trim();
  if (raw.includes('middle')) return 'Middle School';
  if (raw.includes('high')) return 'High School';
  return undefined;
}

function titleCase(value = '') {
  return value.trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

async function robotEventsFetch(path, token, searchParams = {}) {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(searchParams)) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== undefined && item !== null && item !== '') params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(val));
  }

  const url = `${BASE_URL}${path}${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `RobotEvents request failed (${response.status})`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }

  return body;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function findCurrentSeason(token) {
  const resp = await robotEventsFetch('/seasons', token, { 'program[]': PROGRAM_V5RC, per_page: 100 });
  const seasons = resp?.data || [];
  if (!seasons.length) throw new Error('No V5RC seasons returned by RobotEvents.');

  const now = new Date();
  const sorted = [...seasons].sort((a, b) => {
    const aStart = parseDate(a.start)?.getTime() || 0;
    const bStart = parseDate(b.start)?.getTime() || 0;
    return bStart - aStart;
  });

  const active = sorted.find((season) => {
    const start = parseDate(season.start);
    const end = parseDate(season.end);
    return start && end && start <= now && end >= now;
  });

  return active || sorted[0];
}

async function fetchAllTeams({ token, grade, country, teamQuery }) {
  const all = [];
  let page = 1;

  while (true) {
    const resp = await robotEventsFetch('/teams', token, {
      'program[]': PROGRAM_V5RC,
      'grade[]': grade,
      'country[]': country,
      'number[]': teamQuery && /^[0-9]/.test(teamQuery) ? teamQuery : undefined,
      page,
      per_page: PAGE_SIZE,
    });

    const rows = resp?.data || [];
    all.push(...rows);

    const meta = resp?.meta || {};
    const current = meta.current_page || page;
    const last = meta.last_page || current;
    if (current >= last || rows.length === 0) break;
    page += 1;
  }

  return all;
}

function computeTeamSkillSummary(runs) {
  let bestDriver = 0;
  let bestAuton = 0;

  for (const run of runs) {
    const score = Number(run?.score || 0);
    if (run?.type === 'driver') bestDriver = Math.max(bestDriver, score);
    if (run?.type === 'programming') bestAuton = Math.max(bestAuton, score);
  }

  return {
    driver: bestDriver,
    auton: bestAuton,
    total: bestDriver + bestAuton,
  };
}

async function fetchSkillsForTeam(token, teamId, seasonId) {
  const runs = [];
  let page = 1;

  while (true) {
    const resp = await robotEventsFetch(`/teams/${teamId}/skills`, token, {
      'season[]': seasonId,
      page,
      per_page: PAGE_SIZE,
    });

    const data = resp?.data || [];
    runs.push(...data);

    const meta = resp?.meta || {};
    const current = meta.current_page || page;
    const last = meta.last_page || current;
    if (current >= last || data.length === 0) break;
    page += 1;
  }

  return runs;
}

async function fetchLeaderboardFromTeams({ token, teams, seasonId }) {
  const leaderboard = [];

  for (let i = 0; i < teams.length; i += SKILLS_CONCURRENCY) {
    const chunk = teams.slice(i, i + SKILLS_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (team) => {
        const runs = await fetchSkillsForTeam(token, team.id, seasonId);
        const summary = computeTeamSkillSummary(runs);
        if (summary.total <= 0) return null;

        return {
          id: team.id,
          team: team.number,
          teamName: team.team_name || '',
          region: team.location?.region || '',
          country: team.location?.country || '',
          grade: team.grade || '',
          auton: summary.auton,
          driver: summary.driver,
          total: summary.total,
        };
      })
    );

    leaderboard.push(...results.filter(Boolean));
  }

  return leaderboard;
}

function sortLikeRobotEvents(a, b) {
  if (b.total !== a.total) return b.total - a.total;
  if (b.auton !== a.auton) return b.auton - a.auton;
  if (b.driver !== a.driver) return b.driver - a.driver;
  return a.team.localeCompare(b.team);
}

function buildPlan(you, target) {
  if (!target) {
    return { needed: 0, recommended: ['No team currently exists at that rank for this filter scope.'] };
  }

  const yourTotal = you?.total || 0;
  const yourAuton = you?.auton || 0;

  const needed = Math.max(0, target.total - yourTotal + 1);
  const autonTieGap = Math.max(0, target.auton - yourAuton + 1);

  if (!you) {
    return {
      needed: target.total + 1,
      recommended: [
        `To pass rank #${target.rank}, post at least ${target.total + 1} total points.`,
        `For tie safety, aim for ${target.auton + 1}+ autonomous points.`,
      ],
    };
  }

  if (needed === 0) {
    return {
      needed: 0,
      recommended: ['You are already at or above this target rank. Keep improving autonomous to stay ahead in tie-breaks.'],
    };
  }

  const splitAuton = Math.max(autonTieGap, Math.ceil(needed * 0.35));
  const splitDriver = Math.max(0, needed - splitAuton);

  return {
    needed,
    recommended: [
      `You need +${needed} total points to pass rank #${target.rank}.`,
      `Tie-break focus: improve autonomous by at least +${autonTieGap}.`,
      `Balanced one-attempt target: +${splitAuton} auton and +${splitDriver} driver.`,
      `Alternative: keep auton and gain all +${needed} in driver, but this is weaker on tie-breaks.`,
    ],
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Missing RobotEvents API token.' });
      return;
    }

    const grade = normalizeGrade(req.query.grade) || 'High School';
    const region = titleCase(String(req.query.region || '').trim());
    const country = titleCase(String(req.query.country || '').trim());
    const teamQuery = String(req.query.team || '').trim().toUpperCase();
    const targetRank = Math.max(1, parseInt(req.query.rank, 10) || 10);

    const season = await findCurrentSeason(token);
    const teams = await fetchAllTeams({ token, grade, country, teamQuery });

    let leaderboard = await fetchLeaderboardFromTeams({ token, teams, seasonId: season.id });

    if (region) {
      const regionLower = region.toLowerCase();
      leaderboard = leaderboard.filter((t) => String(t.region || '').toLowerCase() === regionLower);
    }

    leaderboard.sort(sortLikeRobotEvents);
    leaderboard = leaderboard.map((row, idx) => ({ ...row, rank: idx + 1 }));

    const you = teamQuery
      ? leaderboard.find((r) => r.team.toUpperCase() === teamQuery)
        || leaderboard.find((r) => r.team.toUpperCase().includes(teamQuery))
        || leaderboard.find((r) => r.teamName.toLowerCase() === teamQuery.toLowerCase())
        || leaderboard.find((r) => r.teamName.toLowerCase().includes(teamQuery.toLowerCase()))
        || null
      : null;

    const target = leaderboard.find((r) => r.rank === targetRank) || null;
    const plan = buildPlan(you, target);

    res.status(200).json({
      season: { id: season.id, name: season.name },
      filters: {
        grade,
        region: region || null,
        country: country || null,
        team: teamQuery || null,
      },
      targetRank,
      you,
      target,
      needed: plan.needed,
      plan,
      allTeams: leaderboard,
      totalTeams: leaderboard.length,
      cached: false,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || 'Unknown error',
      details: error.payload || null,
    });
  }
};
