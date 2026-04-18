const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const PINNACLE_MMA_SPORT = 7;
const PINNACLE_TENNIS_SPORT = 33;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/pinnacle/mma') {
        const data = await getPinnacleOdds(env, PINNACLE_MMA_SPORT);
        return jsonResponse(data);
      }
      if (path === '/pinnacle/tennis') {
        const data = await getPinnacleOdds(env, PINNACLE_TENNIS_SPORT);
        return jsonResponse(data);
      }
      if (path === '/health') {
        return jsonResponse({ status: 'ok', version: '1.0' });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

async function getPinnacleOdds(env, sportId) {
  const auth = btoa(`${env.PINNACLE_USER}:${env.PINNACLE_PWD}`);
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
  };

  const [fixturesRes, oddsRes] = await Promise.all([
    fetch(`https://api.pinnacle.com/v1/fixtures?sportId=${sportId}`, { headers }),
    fetch(`https://api.pinnacle.com/v2/odds?sportId=${sportId}&oddsFormat=American`, { headers }),
  ]);

  if (!fixturesRes.ok) {
    const txt = await fixturesRes.text();
    throw new Error(`Pinnacle fixtures ${fixturesRes.status}: ${txt.slice(0, 200)}`);
  }
  if (!oddsRes.ok) {
    const txt = await oddsRes.text();
    throw new Error(`Pinnacle odds ${oddsRes.status}: ${txt.slice(0, 200)}`);
  }

  const [fixtures, odds] = await Promise.all([fixturesRes.json(), oddsRes.json()]);

  // Build event map: id → { home, away, starts }
  const eventMap = new Map();
  fixtures.league?.forEach(league => {
    league.events?.forEach(ev => {
      if (ev.status === 'O') { // Open only
        eventMap.set(ev.id, { home: ev.home, away: ev.away, starts: ev.starts });
      }
    });
  });

  // Normalize to Odds API h2h format
  const result = [];
  odds.leagues?.forEach(league => {
    league.events?.forEach(ev => {
      const fix = eventMap.get(ev.id);
      if (!fix) return;
      const ml = ev.periods?.find(p => p.number === 0)?.moneyline;
      if (!ml?.home || !ml?.away) return;

      result.push({
        id: `pinnacle_${ev.id}`,
        home_team: fix.home,
        away_team: fix.away,
        commence_time: fix.starts,
        bookmakers: [{
          key: 'pinnacle',
          title: 'Pinnacle',
          markets: [{
            key: 'h2h',
            outcomes: [
              { name: fix.home, price: ml.home },
              { name: fix.away, price: ml.away },
            ]
          }]
        }]
      });
    });
  });

  return result;
}

function corsPreflightResponse() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    }
  });
}
