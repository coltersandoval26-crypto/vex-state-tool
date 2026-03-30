const BASE_URL = 'https://www.robotevents.com/api/v2';
const DEFAULT_PER_PAGE = 250;
const PROGRAM_V5RC = 1;

function normalizeGrade(grade) {
  if (!grade) return undefined;
  const raw = String(grade).toLowerCase().trim();
  if (raw.includes('middle')) return 'Middle School';
  if (raw.includes('high')) return 'High School';
  return undefined;
}

function titleCase(value = '') {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

async function robotEventsFetch(path, token, searchParams = {}) {
  const qs = new URLSearchParams();
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    qs.set(key, String(value));
  });

  const url = `${BASE_URL}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(json?.message || `RobotEvents request failed (${response.status})`);
    err.status = response.status;
    err.payload = json;
    throw err;
  }

  return json;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function findCurrentSeason(token) {
  const seasonResp = await robotEventsFetch('/seasons', token, {
    'program[]': PROGRAM_V5RC,
    per_page: 100,
  });

  const seasons = seasonResp?.data || [];
  if (!seasons.length) throw new Error('No V5RC seasons were returned by RobotEvents API.');

  const now = new Date();
  const sorted = [...seasons].sort((a, b) => {
    const aStart = parseDate(a.start ?? a.start_date)?.getTime() ?? 0;
    const bStart = parseDate(b.start ?? b.start_date)?.getTime() ?? 0;
    return bStart - aStart;
  });

  const active = sorted.find((s) => {
    const start = parseDate(s.start ?? s.start_date);
    const end = parseDate(s.end ?? s.end_date);
    if (!start || !end) return false;
    return start <= now && end >= now;
  });

  return active || sorted[0];
}

async function loadSkills({ token, seasonId, grade, region, country }) {
  const rows = [];
  let page = 1;

  while (true) {
    const payload = {
      'season[]': seasonId,
      'program[]': PROGRAM_V5RC,
      per_page: DEFAULT_PER_PAGE,
      page,
    };

    if (grade) payload['grade_level[]'] = grade;
    if (region) payload['region'] = region;
    if (country) payload['country'] = country;

    const resp = await robotEventsFetch('/skills', token, payload);
    const data = resp?.data || [];
    rows.push(...data);

    const meta = resp?.meta || {};
    const currentPage = meta.current_page || page;
    const lastPage = meta.last_page || currentPage;
    if (currentPage >= lastPage || !data.length) break;
    page += 1;
  }

  return rows;
}

function normalizeSkillRow(raw) {
  const teamNumber =
    raw?.team?.number ||
    raw?.team?.name ||
    raw?.team?.team_name ||
    raw?.team_number ||
    raw?.number ||
    'UNKNOWN';

  const auton = Number(raw?.score_auton ?? raw?.auton ?? raw?.programming ?? 0);
  const driver = Number(raw?.score_driver ?? raw?.driver ?? raw?.driver_control ?? 0);
  const total = Number(raw?.score ?? raw?.total ?? auton + driver);

  return {
    team: String(teamNumber).toUpperCase(),
    teamName: raw?.team?.team_name || raw?.team_name || '',
    auton,
    driver,
    total,
  };
}

function sortLikeRobotEvents(a, b) {
  if (b.total !== a.total) return b.total - a.total;
  if (b.auton !== a.auton) return b.auton - a.auton;
  if (b.driver !== a.driver) return b.driver - a.driver;
  return a.team.localeCompare(b.team);
}

function buildPlan(you, target) {
  if (!target) {
    return {
      summary: 'No target rank exists for current filters yet.',
      needed: 0,
      neededAutonForTie: 0,
      recommended: [],
    };
  }

  const yourTotal = you?.total || 0;
  const yourAuton = you?.auton || 0;
  const needed = Math.max(0, target.total - yourTotal + 1);
  const neededAutonForTie = Math.max(0, target.auton - yourAuton + 1);

  if (!you) {
    return {
      summary: `Post at least ${target.total + 1} total points to move above current #${target.rank}.`,
      needed: target.total + 1,
      neededAutonForTie: target.auton + 1,
      recommended: [
        `Target total score: ${target.total + 1}+`,
        `Tie-break safe autonomous target: ${target.auton + 1}+`,
      ],
    };
  }

  const recommendations = [];
  if (needed <= 0) {
    recommendations.push('You are already above this target rank.');
  } else {
    recommendations.push(`Increase your total (auton + driver) by at least ${needed} points.`);
    recommendations.push(`If tied on total, beat autonomous by at least ${neededAutonForTie} points.`);

    const driverOnly = you.driver + needed;
    const autonOnly = you.auton + needed;
    recommendations.push(`One-match goal examples: ${you.auton} auton + ${driverOnly} driver, or ${autonOnly} auton + ${you.driver} driver.`);

    const splitAuton = Math.max(neededAutonForTie, Math.ceil(needed * 0.35));
    const splitDriver = needed - splitAuton;
    recommendations.push(`Balanced tie-safe improvement: +${splitAuton} auton and +${Math.max(0, splitDriver)} driver.`);
  }

  return {
    summary: needed > 0 ? `You need ${needed} more points to pass rank #${target.rank}.` : 'You have already reached this target.',
    needed,
    neededAutonForTie,
    recommended: recommendations,
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

    const grade = normalizeGrade(req.query.grade);
    const region = titleCase(String(req.query.region || '').trim());
    const country = titleCase(String(req.query.country || '').trim());
    const teamQuery = String(req.query.team || '').trim().toUpperCase();
    const targetRank = Math.max(1, Number.parseInt(req.query.rank, 10) || 10);

    const season = await findCurrentSeason(token);

    const skillsRows = await loadSkills({
      token,
      seasonId: season.id,
      grade,
      region,
      country,
    });

    const normalized = skillsRows.map(normalizeSkillRow);

    const aggregatedMap = new Map();
    for (const row of normalized) {
      const existing = aggregatedMap.get(row.team);
      if (!existing || sortLikeRobotEvents(row, existing) < 0) {
        aggregatedMap.set(row.team, row);
      }
    }

    let leaderboard = Array.from(aggregatedMap.values()).sort(sortLikeRobotEvents);

    leaderboard = leaderboard.map((row, index) => ({ ...row, rank: index + 1 }));

    const you = teamQuery
      ? leaderboard.find((row) => row.team === teamQuery)
        || leaderboard.find((row) => row.team.includes(teamQuery))
        || leaderboard.find((row) => row.teamName.toLowerCase() === teamQuery.toLowerCase())
        || leaderboard.find((row) => row.teamName.toLowerCase().includes(teamQuery.toLowerCase()))
        || null
      : null;

    const target = leaderboard.find((row) => row.rank === targetRank) || null;
    const plan = buildPlan(you, target);

    res.status(200).json({
      season: {
        id: season.id,
        name: season.name,
      },
      filters: {
        grade: grade || null,
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
