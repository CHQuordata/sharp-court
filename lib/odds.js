// Odds math utilities — canonical source used by both index.html (via window assignment) and tests.

export function aimp(p) {
  return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
}

export function kellyPct(conf, pickStr, evData) {
  const m = (pickStr || '').match(/\(([+-]\d+)\)/);
  const amer = m ? parseInt(m[1]) : (conf === 'HIGH' ? -115 : -110);
  const dec = amer > 0 ? amer / 100 + 1 : 100 / Math.abs(amer) + 1;
  // Confidence tags imply small edges OVER THE BOOK PRICE, not fixed win
  // probabilities. Prior version assumed p=0.58/0.53/0.50 regardless of
  // price, which produced absurd Kelly stakes on plus-money picks (LOW
  // +400 → 37% full Kelly because it modeled it as a 50%-prob bet at
  // 5x payout). Real tennis edges are ~1-5pp, not 8-30pp.
  const bookImplied = aimp(amer);
  const edgeByConf = conf === 'HIGH' ? 0.04 : conf === 'MEDIUM' ? 0.015 : 0.003;
  const p = evData?.tp
    ? Math.min(Math.max(parseFloat(evData.tp) / 100, 0.45), 0.75)
    : Math.min(0.95, bookImplied + edgeByConf);
  const k = (p * (dec - 1) - (1 - p)) / (dec - 1);
  return Math.max(0, k * 100);
}
