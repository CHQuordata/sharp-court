const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const PINNACLE_MMA_SPORT = 7;
const PINNACLE_TENNIS_SPORT = 33;
const CRON_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

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
        return jsonResponse({ status: 'ok', version: '2.0' });
      }
      // KV read: GET /kv/:key
      if (path.startsWith('/kv/') && request.method === 'GET') {
        return handleKvGet(path.slice(4), env);
      }
      // KV write: POST /kv/:key  body: { value: "<string>" }
      if (path.startsWith('/kv/') && request.method === 'POST') {
        return handleKvPost(path.slice(4), request, env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyCron(env));
  }
};

// ── KV handlers ──────────────────────────────────────────────────────────────

async function handleKvGet(key, env) {
  if (!env.LEARNING_STORE) return jsonResponse({ error: 'KV not configured' }, 503);
  const val = await env.LEARNING_STORE.get(key);
  if (val === null) return jsonResponse({ value: null });
  return jsonResponse({ value: val });
}

async function handleKvPost(key, request, env) {
  if (!env.LEARNING_STORE) return jsonResponse({ error: 'KV not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  if (body.value === undefined) return jsonResponse({ error: 'Missing value' }, 400);
  const strVal = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
  await env.LEARNING_STORE.put(key, strVal, { expirationTtl: 60 * 60 * 24 * 90 }); // 90-day TTL
  return jsonResponse({ ok: true });
}

// ── Nightly cron ─────────────────────────────────────────────────────────────

async function runNightlyCron(env) {
  if (!env.ODDS_API_KEY || !env.LEARNING_STORE) return;

  // 1. Fetch completed scores across all active sports
  const completedGames = await fetchAllCompletedScores(env.ODDS_API_KEY);

  // 2. Store raw completed games for the frontend to pull as training data
  await env.LEARNING_STORE.put('et_completed_games', JSON.stringify({
    ts: Date.now(),
    games: completedGames
  }), { expirationTtl: 60 * 60 * 24 * 4 }); // 4-day TTL

  // 3. Read pick history from KV, auto-grade ungraded picks
  const historyRaw = await env.LEARNING_STORE.get('et_picks_history');
  if (!historyRaw) return;

  let history;
  try { history = JSON.parse(historyRaw); } catch { return; }

  let changed = false;
  history.forEach(slate => {
    (slate.picks || []).forEach(pick => {
      if (pick.result && pick.result !== '?') return;
      const result = gradePickFromScore(pick, completedGames);
      if (result) { pick.result = result; changed = true; }
    });
    // Also update grading array if present
    if (slate.grading) {
      slate.grading.forEach(g => {
        if (g.result && g.result !== '?') return;
        const matched = (slate.picks || []).find(p =>
          p.pick === g.pick ||
          (p.matchup && g.matchup && p.matchup.toLowerCase() === g.matchup.toLowerCase())
        );
        if (matched?.result) { g.result = matched.result; changed = true; }
      });
    }
  });

  if (changed) {
    await env.LEARNING_STORE.put('et_picks_history', JSON.stringify(history.slice(0, 30)));
  }
}

// ── Score fetching ────────────────────────────────────────────────────────────

async function fetchAllCompletedScores(apiKey) {
  const sports = [...CRON_SPORTS];

  // Discover active tennis sport keys
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
    if (r.ok) {
      const all = await r.json();
      const tennis = all.filter(s => s.active && s.key.startsWith('tennis_')).slice(0, 8).map(s => s.key);
      sports.push(...tennis);
    }
  } catch (_) {}

  const results = [];
  await Promise.allSettled(sports.map(async sport => {
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/?daysFrom=3&apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) return;
      const data = await r.json();
      data.filter(g => g.completed).forEach(g => results.push({ sport, ...g }));
    } catch (_) {}
  }));

  return results;
}

// ── Pick grading ──────────────────────────────────────────────────────────────
// Matches a stored pick against completed game scores and returns W / L / P / null

function gradePickFromScore(pick, games) {
  const pt = pick.pick || '';
  const matchup = (pick.matchup || '').toLowerCase();
  const tokens = matchup.split(/[\s@,|vs.]+/).filter(t => t.length >= 3);

  const game = games.find(g => {
    const ht = g.home_team.toLowerCase(), at = g.away_team.toLowerCase();
    return tokens.some(t => ht.includes(t) || at.includes(t));
  });
  if (!game?.scores?.length) return null;

  const homeS = parseFloat(game.scores.find(s => s.name === game.home_team)?.score ?? 'NaN');
  const awayS = parseFloat(game.scores.find(s => s.name === game.away_team)?.score ?? 'NaN');
  if (isNaN(homeS) || isNaN(awayS)) return null;

  const ptL = pt.toLowerCase();

  // Total (Over/Under)
  if (ptL.includes('over') || ptL.includes('under')) {
    const n = parseFloat((pt.match(/(\d+\.?\d*)/) || [])[1] || 'NaN');
    if (isNaN(n)) return null;
    const combined = homeS + awayS;
    if (Math.abs(combined - n) < 0.01) return 'P';
    return (ptL.includes('over') ? combined > n : combined < n) ? 'W' : 'L';
  }

  // Spread: "Team -3.5 (-110)" or "Team +3.5 (-110)"
  const spM = pt.match(/^(.+?)\s+([+-]\d+\.?\d*)\s*\(/);
  if (spM) {
    const toks = spM[1].trim().toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const spread = parseFloat(spM[2]);
    const isHome = toks.some(t => game.home_team.toLowerCase().includes(t));
    const isAway = !isHome && toks.some(t => game.away_team.toLowerCase().includes(t));
    if (!isHome && !isAway) return null;
    const margin = (isHome ? homeS - awayS : awayS - homeS) + spread;
    if (Math.abs(margin) < 0.01) return 'P';
    return margin > 0 ? 'W' : 'L';
  }

  // ML: "Team ML (-150)" or "Team (-150)" with 3-digit odds
  const mlM = pt.match(/^(.+?)\s+(?:ML\s*)?[(+-]?(\d{3,})/i);
  if (mlM) {
    const toks = mlM[1].trim().toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const isHome = toks.some(t => game.home_team.toLowerCase().includes(t));
    const isAway = !isHome && toks.some(t => game.away_team.toLowerCase().includes(t));
    if (!isHome && !isAway) return null;
    const pS = isHome ? homeS : awayS, oS = isHome ? awayS : homeS;
    if (pS === oS) return 'P';
    return pS > oS ? 'W' : 'L';
  }

  return null;
}

// ── Pinnacle ──────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsPreflightResponse() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
