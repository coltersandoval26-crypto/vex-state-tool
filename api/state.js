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
      
      // Process each team
      for (const t of teams) {
        // Small delay to avoid 429 rate limiting
        await new Promise(resolve => setTimeout(resolve, 120));
        
        const runs = await getAll("/teams/" + t.id + "/skills?season[]=" + season.id);
        
        // Group runs by event - auton + driver MUST be from same event
        const byEvent = {};
        for (const r of runs) {
          const eid = r.event?.id;
          if (!eid) continue;
          if (!byEvent[eid]) byEvent[eid] = { auton: 0, driver: 0 };
          if (r.type === "programming")
            byEvent[eid].auton = Math.max(byEvent[eid].auton, r.score);
          if (r.type === "driver")
            byEvent[eid].driver = Math.max(byEvent[eid].driver, r.score);
        }
        
        // Find the event with the highest combined score
        let bestTotal = 0, bestAuton = 0, bestDriver = 0;
        for (const ev of Object.values(byEvent)) {
          const total = ev.auton + ev.driver;
          if (total > bestTotal) {
            bestTotal = total;
            bestAuton = ev.auton;
            bestDriver = ev.driver;
          }
        }
        
        if (bestTotal > 0) {
          best[t.number] = {
            team: t.number,
            total: bestTotal,
            auton: bestAuton,
            driver: bestDriver
          };
        }
      }
      
      ranked = Object.values(best)
        .sort((a, b) => b.total - a.total || b.auton - a.auton)
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
    console.error("Full error:", e);
    res.status(500).json({ 
      error: e.message,
      stack: e.stack,
      name: e.name
    });
  }
}
