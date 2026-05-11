// Jeff Sackmann's tennis_atp / tennis_wta CSV repos — career H2H, per-surface
// W-L, and per-surface serve aggregates. 2021-2024 inclusive. 2021-2022
// contribute H2H only; 2023-2024 also contribute surface form and serve stats
// (older years sometimes lack the serve columns).
//
// Caller supplies name-matching primitives (norm, awMatch, hmMatch) so this
// module stays agnostic about how compound surnames / diacritics / nicknames
// are reconciled — that logic lives next to the rest of the player-name code
// in index.html.

const SERVE_YEAR_MIN = 2023;
const YEARS = [2024, 2023, 2022, 2021];
const SURFS = ['clay', 'hard', 'grass'];
const SERVE_KEYS = ['m', 'a', 'df', 'svpt', 'fi', 'fw', 'sp2', 'sw', 'bpf', 'bps'];

const repoFor = sp => sp === 'wta' ? 'tennis_wta/master/wta_matches' : 'tennis_atp/master/atp_matches';
const emptyServe = () => ({ m: 0, a: 0, df: 0, svpt: 0, fi: 0, fw: 0, sp2: 0, sw: 0, bpf: 0, bps: 0 });
const emptyBySurface = factory => ({ clay: factory(), hard: factory(), grass: factory() });
const normSurf = s => { const v = (s || '').toLowerCase(); return v === 'clay' ? 'clay' : v === 'grass' ? 'grass' : 'hard'; };
const pct = (n, d) => d > 0 && n <= d ? (n / d * 100).toFixed(1) : null;

export async function fetchSackmannCSVs(sp, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  return Promise.all(YEARS.map(y =>
    fetchImpl(`https://raw.githubusercontent.com/JeffSackmann/${repoFor(sp)}_${y}.csv`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(r => r.ok ? r.text() : null)
      .catch(() => null)
  ));
}

// Append serve stats for one match into the running aggregate. sideKey is
// 'w' or 'l' — the column-name prefix in Sackmann's CSV indicating whether
// the player whose stats we're aggregating won or lost the match.
function accumulateServe(s, c, ci, sideKey) {
  const pi = v => parseInt(v) || 0;
  const svpt = pi(c[ci[`${sideKey}_svpt`]]);
  const fi = pi(c[ci[`${sideKey}_1stIn`]]);
  s.m++;
  s.a += pi(c[ci[`${sideKey}_ace`]]);
  s.df += pi(c[ci[`${sideKey}_df`]]);
  s.svpt += svpt;
  s.fi += fi;
  s.fw += pi(c[ci[`${sideKey}_1stWon`]]);
  s.sp2 += svpt - fi; // 2nd-serve points = total serve points - 1st-in
  s.sw += pi(c[ci[`${sideKey}_2ndWon`]]);
  s.bpf += pi(c[ci[`${sideKey}_bpFaced`]]);
  s.bps += pi(c[ci[`${sideKey}_bpSaved`]]);
}

// Parse one year's CSV. Returns the per-year shape that aggregateSackmannResults
// consumes. Empty CSV / missing year → returns an empty shape so .map+aggregate
// remains safe.
export function parseSackmannYear(csv, year, { norm, awMatch, hmMatch }) {
  const out = {
    h2h: [],
    awSurf: emptyBySurface(() => []),
    hmSurf: emptyBySurface(() => []),
    awServe: emptyBySurface(emptyServe),
    hmServe: emptyBySurface(emptyServe),
  };
  if (!csv) return out;
  const lines = csv.split('\n');
  if (lines.length < 2) return out;
  const hdr = lines[0].split(',');
  const ci = {};
  hdr.forEach((h, i) => ci[h.trim()] = i);
  const includeServe = year >= SERVE_YEAR_MIN
    && ci.w_ace !== undefined
    && ci.w_svpt !== undefined
    && ci.l_svpt !== undefined;

  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const c = ln.split(',');
    const winnerN = norm(c[ci.winner_name] || '');
    const loserN = norm(c[ci.loser_name] || '');
    if (!winnerN || !loserN) continue;
    const sk = normSurf(c[ci.surface]);
    const awWon = awMatch(winnerN) && hmMatch(loserN);
    const hmWon = hmMatch(winnerN) && awMatch(loserN);
    if (awWon || hmWon) {
      out.h2h.push({
        dt: c[ci.tourney_date],
        tn: c[ci.tourney_name],
        surf: c[ci.surface],
        round: (c[ci.round] || '').trim(),
        score: c[ci.score],
        awWon,
      });
    }
    if (year < SERVE_YEAR_MIN) continue;
    // Per-player surface form — also requires the player NOT to be on both
    // sides (defensive against name-collision false positives).
    const awWasW = awMatch(winnerN) && !awMatch(loserN);
    const awWasL = awMatch(loserN) && !awMatch(winnerN);
    const hmWasW = hmMatch(winnerN) && !hmMatch(loserN);
    const hmWasL = hmMatch(loserN) && !hmMatch(winnerN);
    if (awWasW) out.awSurf[sk].push({ W: true });
    else if (awWasL) out.awSurf[sk].push({ W: false });
    if (hmWasW) out.hmSurf[sk].push({ W: true });
    else if (hmWasL) out.hmSurf[sk].push({ W: false });
    if (includeServe) {
      if (awWasW) accumulateServe(out.awServe[sk], c, ci, 'w');
      else if (awWasL) accumulateServe(out.awServe[sk], c, ci, 'l');
      if (hmWasW) accumulateServe(out.hmServe[sk], c, ci, 'w');
      else if (hmWasL) accumulateServe(out.hmServe[sk], c, ci, 'l');
    }
  }
  return out;
}

export function summarizeServe(s) {
  if (!s.svpt || !s.m) return null;
  return {
    m: s.m,
    first_pct: pct(s.fi, s.svpt),
    first_won_pct: s.fi > 0 ? pct(s.fw, s.fi) : null,
    second_won_pct: s.sp2 > 0 ? pct(s.sw, s.sp2) : null,
    bp_save_pct: s.bpf > 0 ? pct(s.bps, s.bpf) : null,
    opp_ret_pct: s.svpt > 0 ? ((s.svpt - s.fw - s.sw) / s.svpt * 100).toFixed(1) : null,
  };
}

const summarizeSurfMatches = ms => ({
  w: ms.filter(m => m.W).length,
  l: ms.filter(m => !m.W).length,
  tot: ms.length,
});

export function aggregateSackmannResults(parsedYears) {
  const merged = {
    h2h: [],
    awSurf: emptyBySurface(() => []),
    hmSurf: emptyBySurface(() => []),
    awServe: emptyBySurface(emptyServe),
    hmServe: emptyBySurface(emptyServe),
  };
  for (const y of parsedYears) {
    merged.h2h.push(...y.h2h);
    for (const sk of SURFS) {
      merged.awSurf[sk].push(...y.awSurf[sk]);
      merged.hmSurf[sk].push(...y.hmSurf[sk]);
      for (const k of SERVE_KEYS) {
        merged.awServe[sk][k] += y.awServe[sk][k];
        merged.hmServe[sk][k] += y.hmServe[sk][k];
      }
    }
  }
  merged.h2h.sort((a, b) => (b.dt || '').localeCompare(a.dt || ''));
  const surfSummary = bag => ({ clay: summarizeSurfMatches(bag.clay), hard: summarizeSurfMatches(bag.hard), grass: summarizeSurfMatches(bag.grass) });
  const serveSummary = bag => ({ clay: summarizeServe(bag.clay), hard: summarizeServe(bag.hard), grass: summarizeServe(bag.grass) });
  return {
    awW: merged.h2h.filter(m => m.awWon).length,
    hmW: merged.h2h.filter(m => !m.awWon).length,
    total: merged.h2h.length,
    recent: merged.h2h.slice(0, 5),
    awSurf: surfSummary(merged.awSurf),
    hmSurf: surfSummary(merged.hmSurf),
    awServe: serveSummary(merged.awServe),
    hmServe: serveSummary(merged.hmServe),
  };
}

// One-shot orchestrator. Returns null on any failure (network, parse) — caller
// distinguishes "no data" from "fetch error" only via console.error logging.
export async function fetchSackmannH2H({ sp, norm, awMatch, hmMatch }, opts = {}) {
  try {
    const csvs = await fetchSackmannCSVs(sp, opts);
    const parsed = csvs.map((csv, i) => parseSackmannYear(csv, YEARS[i], { norm, awMatch, hmMatch }));
    return aggregateSackmannResults(parsed);
  } catch (e) {
    if (typeof console !== 'undefined') console.error('[fetchSackmannH2H]', e?.message || e);
    return null;
  }
}
