import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const { team, state, rank, token } = req.query;
    if (!team || !state || !rank || !token) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const headers = {
      Authorization: "Bearer " + token.trim(),
      Accept: "application/json"
    };

    async function api(path) {
      const r = await fetch("https://www.robotevents.com/api/v2" + path, { headers });
      if (!r.ok) throw new Error("API " + r.status);
      return r.json();
    }

    async function getAll(path) {
      let all = [];
      let page = 1;
      let last = 1;

      do {
        await new Promise(r => setTimeout(r, 120));
        const sep = path.includes("?") ? "&" : "?";
        const data = await api(path + sep + "page=" + page + "&per_page=250");
        all = all.concat(data.data || []);
        last = data.meta?.last_page || 1;
        page++;
      } while (page <= last);

      return all;
    }

    // 1️⃣ Get active season
    let seasonId = await redis.get("season:active");

    if (!seasonId) {
      const seasons = await api("/seasons?program[]=1&active=true");
      seasonId = seasons.data[0].id;
      await redis.set("season:active", seasonId);
    }

    const stateKey = `state:${seasonId}:${state.toLowerCase()}`;
    let eventIds = await redis.get(stateKey);

    // 2️⃣ If state not indexed yet
    if (!eventIds) {
      const events = await getAll(
        "/events?program[]=1&season[]=" + seasonId +
        "&region=" + encodeURIComponent(state)
      );

      eventIds = events.map(e => e.id);
      await redis.set(stateKey, eventIds);
    }

    const teamBest = {};

    // 3️⃣ Process each event
    for (const eventId of eventIds) {

      const eventKey = `event:${seasonId}:${eventId}`;
      let eventData = await redis.get(eventKey);

      if (!eventData) {
        await new Promise(r => setTimeout(r, 150));

        const skills = await getAll(`/events/${eventId}/skills`);
        const bestPerTeam = {};

        for (const s of skills) {
          const tid = String(s.team?.name);
          if (!tid) continue;

          if (!bestPerTeam[tid]) {
            bestPerTeam[tid] = { auton: 0, driver: 0 };
          }

          if (s.type === "programming") {
            bestPerTeam[tid].auton = Math.max(bestPerTeam[tid].auton, s.score);
          }

          if (s.type === "driver") {
            bestPerTeam[tid].driver = Math.max(bestPerTeam[tid].driver, s.score);
          }
        }

        eventData = bestPerTeam;
        await redis.set(eventKey, eventData);
      }

      // Merge into state totals
      for (const [teamNum, scores] of Object.entries(eventData)) {
        const total = scores.auton + scores.driver;

        if (!teamBest[teamNum] || total > teamBest[teamNum].total) {
          teamBest[teamNum] = {
            team: teamNum,
            total,
            auton: scores.auton,
            driver: scores.driver
          };
        }
      }
    }

    const ranked = Object.values(teamBest)
      .sort((a, b) => b.total - a.total || b.auton - a.auton)
      .map((t, i) => ({ ...t, rank: i + 1 }));

    const you = ranked.find(t => t.team === team);
    const target = ranked[parseInt(rank) - 1];
    const needed = target ? target.total + 1 - (you?.total || 0) : 0;

    res.status(200).json({
      you,
      target,
      needed,
      totalTeams: ranked.length,
      cached: true
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
