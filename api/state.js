import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const { team, state, rank, token, grade } = req.query;
    if (!team || !state || !rank || !token) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    const gradeFilter = grade || 'High School'; // Default to HS
    const cacheKey = `state:${state.toLowerCase()}:${gradeFilter.toLowerCase().replace(/\s+/g, '_')}`;
    
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
      
      // Fetch teams list to get grade information
      const allTeams = await getAll(
        "/teams?program[]=1&season[]=" + season.id +
        "&region=" + encodeURIComponent(state)
      );
      
      // Build grade lookup from teams list
      const teamGrades = {};
      for (const t of allTeams) {
        teamGrades[String(t.id)] = (t.grade || '').toLowerCase();
      }
      
      // Get all past events in the state
      const allEvents = await getAll(
        "/events?program[]=1&season[]=" + season.id +
        "&region=" + encodeURIComponent(state)
      );
      const now = new Date();
      const pastEvents = allEvents.filter(e => new Date(e.end) < now);
      
      // Fetch skills from all events and group by (team, event)
      const teamEventScores = {};
      const teamMap = {};
      
      for (const event of pastEvents) {
        const skills = await getAll("/events/" + event.id + "/skills");
        
        for (const s of skills) {
          const tid = String(s.team?.id);
          if (!tid || tid === 'undefined') continue;
          
          // Store team number (don't overwrite grade - we got it from teams endpoint)
          if (!teamMap[tid]) {
            teamMap[tid] = s.team?.name || 'Unknown';
          }
          
          // Group by team and event
          if (!teamEventScores[tid]) teamEventScores[tid] = {};
          if (!teamEventScores[tid][event.id]) {
            teamEventScores[tid][event.id] = { auton: 0, driver: 0 };
          }
          
          if (s.type === "programming") {
            teamEventScores[tid][event.id].auton = Math.max(
              teamEventScores[tid][event.id].auton,
              s.score
            );
          }
          if (s.type === "driver") {
            teamEventScores[tid][event.id].driver = Math.max(
              teamEventScores[tid][event.id].driver,
              s.score
            );
          }
        }
      }
      
      // Find best combined score from any single event for each team
      const best = {};
      for (const [tid, events] of Object.entries(teamEventScores)) {
        // Filter by grade
        const teamGrade = (teamGrades[tid] || '').toLowerCase();
        const targetGrade = gradeFilter.toLowerCase();
        const gradeMatches = teamGrade.includes(targetGrade.replace(' school', ''));
        
        if (!gradeMatches) continue; // Skip teams that don't match selected grade
        
        let bestTotal = 0, bestAuton = 0, bestDriver = 0;
        
        for (const ev of Object.values(events)) {
          const total = ev.auton + ev.driver;
          if (total > bestTotal) {
            bestTotal = total;
            bestAuton = ev.auton;
            bestDriver = ev.driver;
          }
        }
        
        if (bestTotal > 0) {
          best[tid] = {
            team: teamMap[tid],
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
      allTeams: ranked,  // Add full list for table display
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
