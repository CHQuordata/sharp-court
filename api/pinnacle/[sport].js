const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const SPORT_IDS = { mma: 7, tennis: 33 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sport } = req.query;
  const sportId = SPORT_IDS[sport];
  if (!sportId) return res.status(404).json({ error: 'Not found' });

  try {
    const data = await getPinnacleOdds(process.env.PINNACLE_USER, process.env.PINNACLE_PWD, sportId);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getPinnacleOdds(user, pwd, sportId) {
  const auth = Buffer.from(`${user}:${pwd}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' };

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

  const eventMap = new Map();
  fixtures.league?.forEach(league => {
    league.events?.forEach(ev => {
      if (ev.status === 'O') {
        eventMap.set(ev.id, { home: ev.home, away: ev.away, starts: ev.starts });
      }
    });
  });

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
