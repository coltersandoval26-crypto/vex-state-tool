export default async function handler(req, res) {
  try {
    const { team, state, rank, token, grade } = req.query;

    if (!team || !state || !rank || !token) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    
    const gradeFilter = grade || "High School";

    const headers = {
      Authorization: "Bearer " + token.trim(),
      Accept: "application/json"
    };

    async function api(path) {
      const r = await fetch("https://www.robotevents.com/api/v2" + path, { headers });
      if (!r.ok) throw new Error("API " + r.status);
      const data = await r.json();
      if (!data) throw new Error("Empty API response");
      return data;
    }

    async function getAll(path) {
      let all = [];
      let page = 1;
      let last = 1;
      do {
        await new Promise(r => setTimeout(r, 150));
        const sep = path.includes("?") ? "&" : "?";
        const data = await api(path + sep + "page=" + page + "&per_page=250");
        if (!data || !Array.isArray(data.data)) throw new Error("Malformed API response");
        all = all.concat(data.data);
        last = data.meta?.last_page || 1;
        page++;
      } while (page <= last);
      return all;
    }

    const seasons = await api("/seasons?program[]=1&active=true");
    if (!seasons?.data?.length) throw new Error("Could not determine active season");
    const seasonId = seasons.data[0].id;

    const events = await getAll("/events?program[]=1&season[]=" + seasonId + "&region=" + encodeURIComponent(state));
    if (!Array.isArray(events)) throw new Error("Events fetch failed");
    const eventIds = events.map(e => e.id);
    
    const teamBest = {};
    const debugSamples = [];
    let totalSkills = 0;
    let filteredOut = 0;
    let keptTeams = 0;

    // Process events
    for (const eventId of eventIds) {
      await new Promise(r => setTimeout(r, 200));
      const skills = await getAll(`/events/${eventId}/skills`);
      if (!Array.isArray(skills)) throw new Error("Skills fetch failed for event " + eventId);
      
      totalSkills += skills.length;
      const bestPerTeam = {};

      for (const s of skills) {
        const teamNumber = s.team?.name;
        const teamGrade = s.team?.grade;
        
        // Capture samples for debugging
        if (debugSamples.length < 10) {
          debugSamples.push({ teamNumber, teamGrade, gradeFilter, eventId });
        }

        // Filter by selected grade
        if (!teamNumber) continue;
        if (teamGrade !== gradeFilter) {
          filteredOut++;
          continue;
        }
        
        keptTeams++;

        if (!bestPerTeam[teamNumber]) {
          bestPerTeam[teamNumber] = { auton: 0, driver: 0 };
        }

        if (s.type === "programming") {
          bestPerTeam[teamNumber].auton = Math.max(bestPerTeam[teamNumber].auton, s.score);
        }
        if (s.type === "driver") {
          bestPerTeam[teamNumber].driver = Math.max(bestPerTeam[teamNumber].driver, s.score);
        }
      }

      // Merge into teamBest
      for (const [teamNum, scores] of Object.entries(bestPerTeam)) {
        const total = scores.auton + scores.driver;
        if (!teamBest[teamNum] || total > teamBest[teamNum].total) {
          teamBest[teamNum] = { team: teamNum, total, auton: scores.auton, driver: scores.driver };
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
      allTeams: ranked,
      debug: {
        gradeFilter,
        totalEvents: eventIds.length,
        totalSkillsProcessed: totalSkills,
        filteredOut,
        keptTeams,
        debugSamples
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
