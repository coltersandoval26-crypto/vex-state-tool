import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const { team, state, rank, token } = req.query;

    if (!team || !state || !rank || !token) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const cacheKey = `state:${state.toLowerCase()}`;

    // 1️⃣ Check Redis cache
    const cached = await redis.get(cacheKey);

    let ranked;

    if (cached) {
      ranked = cached;
    } else {

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
          const sep = path.includes("?") ? "&" : "?";
          const data = await api(path + sep + "page=" + page + "&per_page=250");
          all = all.concat(data.data || []);
          last = data.meta?.last_page || 1;
          page++;
        } while (page <= last);

        return all;
      }

      const seasons = await api("/seasons?program[]=1&active=true");
      const season = seasons.data[0];

      const teams = await getAll(
        "/teams?program[]=1&season[]=" + season.id +
        "&region=" + encodeURIComponent(state)
      );

      const best = {};

      for (const t of teams) {
        const runs = await getAll("/teams/" + t.id + "/skills?season[]=" + season.id);

        let auton = 0;
        let driver = 0;

        for (const r of runs) {
          if (r.type === "programming")
            auton = Math.max(auton, r.score);
          if (r.type === "driver")
            driver = Math.max(driver, r.score);
        }

        if (auton + driver > 0) {
          best[t.number] = {
            team: t.number,
            total: auton + driver,
            auton,
            driver
          };
        }
      }

      ranked = Object.values(best)
        .sort((a, b) => b.total - a.total)
        .map((t, i) => ({ ...t, rank: i + 1 }));

      // 2️⃣ Store for 24 hours (86400 seconds)
      await redis.set(cacheKey, ranked, { ex: 86400 });
    }

    const you = ranked.find(t => t.team === team);
    const target = ranked[parseInt(rank) - 1];
    const needed = target ? target.total + 1 - (you?.total || 0) : 0;

    res.status(200).json({
      you,
      target,
      needed,
      totalTeams: ranked.length,
      cached: !!cached
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
