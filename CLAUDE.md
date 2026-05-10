# CLAUDE.md — SHARP COURT v1

## PROJECT OVERVIEW

Single-file Bloomberg Terminal-style tennis betting dashboard. Most logic lives in `index.html` (~5,700 lines), with shared pure functions extracted into `lib/*.js` (imported via `<script type="module">`). Zero dependencies, no build step. Deployed on GitHub Pages at `https://chquordata.github.io/sharp-court/` (old `sportsedge-terminal` URL still redirects).

- **Worker proxy:** `worker/index.js` — Cloudflare Worker for Pinnacle API (Tennis #33) to bypass CORS
- **Shared libs:** `lib/odds.js`, `lib/parsing.js`, `lib/signals.js`, `lib/tennis.js`, `lib/sackmann.js` (also covered by `worker/tests/`)
- **Dev server:** `npx --yes http-server -p 3000 -c-1 .` (configured in `.claude/launch.json`)

---

## CODE WORKFLOW

**Always: edit → parse-validate → `git add` → `git commit` → `git push origin main`**

Never stop at commit. The live site only updates on push (GitHub Pages).

**Parse-validate after any non-trivial JS edit to `index.html`:**

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=h.match(/<script>\s*\n([\s\S]*?)<\/script>\s*\n*<\/div>/);try{new Function(m[1]);console.log('PARSE OK')}catch(e){console.log('PARSE ERROR:',e.message)}"
```

Skipping this once cost 5 commits of a broken site (duplicate `let injected` halted the entire main `<script>` block, killing the PIN gate's `checkPin` along with everything else). The check takes 1 second and catches the entire class of bug.

**Worker changes need a separate deploy** — git push only updates GitHub Pages (frontend). For `worker/index.js`:

```bash
cd worker && npx wrangler deploy
```

---

## SPORTS COVERAGE

| Sport | Key | Markets |
|-------|-----|---------|
| Tennis (ATP) Singles | `tennis_atp` | h2h, spreads, totals |
| Tennis (WTA) Singles | `tennis_wta` | h2h, spreads, totals |
| Tennis Doubles (ATP/WTA) | via ESPN + same Odds API keys | h2h (ML only) |

**UI tabs:** ATP | WTA | DOUBLES | ⚡ PICKS

**Doubles rules:**
- No individual player stats — ML only
- Signals limited to pair seeding, partnership form, odds movement, surface
- Default confidence MEDIUM/LOW unless dominant seeded pairing
- Never fabricate serve/return stats for doubles players

---

## KEY CONSTANTS (index.html)

```js
SHARP_BOOKS  = ['Pinnacle', 'Circa Sports', 'BetOnline.ag', 'Bookmaker', 'BookiePro']
LOWVIG_BOOKS = ['LowVig.ag', 'PropSwap', 'Unibet']
SQUARE_BOOKS = ['FanDuel', 'DraftKings', 'BetMGM', 'Caesars', ...rest]

EDGE_THRESHOLDS = { HIGH: 8, MEDIUM: 5, LOW: 3 }  // % deviation from consensus

TN_BAN_LIST = ['nakashima','tsitsipas','bublik','haddad maia','rublev',
               'kyrgios','fognini','shapovalov','kokkinakis','garin']
// House-policy variance bans. Never picked under ANY path (algo, LLM, quant
// injection, AI ANALYZE save). Honored at 5+ enforcement points.

// Implied probability
aimp(odds) => odds > 0 ? 100/(odds+100) : |odds|/(|odds|+100)

// Quarter-Kelly stake (% of bankroll) — the headline metric for every pick.
// Derived from p = bookImplied + edgeByConf where edgeByConf is
// HIGH=4pp, MEDIUM=1.5pp, LOW=0.3pp. Hard-capped at 2% per bet for
// ruin protection. See lib/odds.js:kellyPct.
```

---

## SHARP FRAMEWORK (live as of 2026-05-10)

The pick framework was redesigned to align with how professional bettors actually decide. Diagram: `outputs/2026-05-10_SharpRedesign_PatchSet.html`.

**Stake size is the bet. Confidence tag is for visual grouping only.** Every pick has a `recommended_stake_pct` field (¼-Kelly, 2% cap) shown as the headline pill on the leaderboard. Tooltip shows the source (`quant` vs `confidence`-derived).

**Tennis HIGH requires dual confirmation.** LLM agreement is implicit; quant must also confirm via AUTOPICK classification or BORDERLINE with ≥5% edge. Otherwise HIGH downgrades to MEDIUM with `dual_confirm_failed` filter.

**Pinnacle is the sharp reference.** Pick cards show `✓ PIN` or `⚡ PIN ✗` based on whether Pinnacle's current price implies our side has value (≥2pp gap). `~CLV +X.Xpp` shows forward-looking closing line value vs Pinnacle no-vig fair.

**CLV is the only honest skill metric.** Win rate is variance. CLV (`closing_implied − entry_implied` in pp) is computed at grade time and survives sample-size noise. Track it long-term; ignore W/L over short windows.

**One bet per match, locked at first generation.** Pick gen filters out in-progress matches and matchups that already have a pick in today's slate. Click ✕ on a pick to deliberately remove it; next regenerate fills the gap.

**Clay-favorite guardrail.** On clay, never assign HIGH to a -200+ ML favorite without explicit current-year clay W-L AND no fatigue gap. Enforced in algo path, LLM prompt, quant injection, AND AI ANALYZE post-parse re-validation.

**Quant injection → leans for tennis.** When the LLM drops a quant AUTOPICK on tennis, route to leans for review instead of force-injecting. Other sports keep "math wins on conflicts." Tennis upset variance + qualitative-heavy edge sources mean LLM drops carry real signal.

---

## BACKTEST TOOL

`backtest.html` — replays graded picks under each rule policy. Pulls `et_picks_history` from the worker KV (CORS allowed only from deployed GH Pages origin) or accepts pasted JSON for local testing. Runs 6 policies side-by-side from a $1,000 starting bankroll: baseline (old kellyPct), new stake (post-fix), + HIGH price cap, + dual confirmation, + skip negative CLV, + expanded ban list.

Dedupes to one pick per matchup (drops same-matchup duplicates and leans) so the simulator reflects real-world one-bet-per-match behavior.

---

## CRON & WORKER MONITORING

Cloudflare Worker runs nightly at **6 AM UTC** (configured in `worker/wrangler.toml`). Phases: selo_refresh → closing_snapshot → odds_api_scores → kv_write_completed → kv_read_history → espn_scores → grading_loop → clv_compute → kv_write_history → learning_agent. Each wrapped in try/catch — one phase failing won't abort the rest. Phase log + counts persisted to `et_cron_diagnostic` KV.

**To inspect manually:**

```bash
curl -s https://sportsedge-proxy.chuynh.workers.dev/kv/et_cron_diagnostic
curl -X POST https://sportsedge-proxy.chuynh.workers.dev/admin/run-cron
```

Look for `phases:[]` array with `ok:false` entries and the `gradedThisRun` / `ungradedAfter` counts to see whether grading actually progressed.

---

## ANALYSIS RULES

These rules govern all manual analysis I perform in conversation.

### 1. MANDATORY LIVE LINE PULL

Before any analysis, pull confirmed current prices. Never assume or estimate lines.

**Primary source:** DraftKings
- Search: `[Team A] vs [Team B] DraftKings odds [current date]`
- Tennis: `[Player A] vs [Player B] DraftKings odds [current date]`

**Fallback chain (never leave a line as N/A):**
1. BetMGM — `[matchup] BetMGM odds`
2. FanDuel — `[matchup] FanDuel odds`
3. European decimal odds (Flashscore, SportGambler)

**Decimal → American conversion:**
- Favorite: `(decimal - 1) × 100` → e.g. 1.41 → -244
- Underdog: `-100 / (decimal - 1)` → e.g. 2.90 → +190

If the user provides lines directly, use those — no re-pull needed.

---

### 2. ALT LINE COMPARISON (TENNIS HEAVY FAVORITES)

When a tennis ML is **-200 or worse**, always pull and compare all three vehicles:

| Market | When it's right |
|--------|----------------|
| ML | Only if price gap to -1.5g is under 2% |
| -1.5 games | **Default** — same outcome as ML in 99% of wins (only fails triple tiebreak) |
| -2.5 games | H2H suggests dominant straight sets; verify expected margin first |

Always state implied probability for each option and explain the tradeoff explicitly.

---

### 3. TENNIS GAME SPREAD MATH

Game spread = sum of **all games won across the entire match**. Never calculate set by set.

**Example:** 4-6, 6-3, 6-3
- Winner: 4+6+6 = **16 games**
- Loser: 6+3+3 = **12 games**
- Net margin: **+4** (covers -2.5 and -3.5, does NOT cover -4.5)

Same logic applies to set spreads and total games O/U.

---

### 4. SLATE REVIEWS — POLYMARKET & KALSHI CROSS-CHECK

On multi-game slate requests only (not single-match deep dives):

**Polymarket:** `site:polymarket.com [Team A] [Team B]` — win probability (¢ = %) + total $ volume  
**Kalshi:** `[Team A] [Team B] Kalshi` — note: limited WTA/ATP and international sports coverage

**Volume-adjusted signal thresholds:**

| Volume | Signal |
|--------|--------|
| $10K+ | Actionable — treat gap seriously |
| $1K–$10K | Soft lean — flag thin liquidity |
| Under $1K | Noise — disregard gap entirely |

**Gap interpretation (at $10K+ volume):**
- 5%+ gap → actionable signal
- 3–5% gap → mild lean
- DK higher than prediction market → book may be stale/inflated on favorite
- Prediction market higher than DK → book lagging sharp money

**Output format for slate table:**

| Match | DK (implied) | Source | Polymarket | PM Vol | Gap | Flag |
|-------|-------------|--------|-----------|--------|-----|------|
| Rybakina vs Zheng | -441 (81.5%) | DK | 80¢ (80%) | $1.6K | 1.5% | Noise |

---

### 5. TENNIS SURFACE RESET RULE

Do not overprice historical H2H when the matchup moves to a new surface. H2H built on hard/grass carries minimal predictive weight on clay and vice versa.

Before backing any favorite based on H2H, check: **on which surfaces were those meetings played?**

If the dog has a concrete structural edge on the current surface (better surface record, more recent clay matches, opponent on first clay event of season), lean dog or pass. Never back the favorite on ranking or narrative alone when the surface is new to the matchup.

---

### 6. SPORT-SPECIFIC STAT POLICIES

**Tennis:**
- TRUE SIGNALS (priority order): RetWon% ≥42%, BPconv% gap ≥10pp, 2ndWon% <50%, 1stIn% gap ≥8pp, Surface win% current season, Rest days gap ≥2, BPsave% gap ≥10pp
- H2H is strong only when: 3+ meetings on **today's specific surface**, or dominant 5-0 / 4-0 overall pattern
- World ranking gap ≥20 = structural edge **only** when higher-ranked player also has positive recent form on current surface
- Never cite ranking tier ("top 10"), seed number, or season W-L record as a pick reason
- LIMITED DATA tag: use ranking + market price ONLY — never invent surface records or playing style

**Injury policy:**
- Injury is background context — already priced into the market line
- Never downgrade confidence or skip a pick solely because of an injury listing
- If a match is on the slate, both players are healthy enough to compete. Never cite injury as a reason to skip or downgrade a tennis pick

---

### 7. SESSION MEMORY RULES

- Save every analysis session as `.md` to the `outputs/` directory (create if it doesn't exist)
- Filename convention: `YYYY-MM-DD_TeamA_vs_TeamB.md` or `YYYY-MM-DD_BettingSlate.md`
- Always present the saved file path to the user after saving

---

## DATA SOURCES

All APIs below are actively used. None are candidates for removal.

| Source | Purpose | Required? |
|--------|---------|-----------|
| The Odds API | Live odds from all active `tennis_*` sport keys | Yes — live odds |
| Anthropic Claude API | AI picks generation + single-match deep analysis | Yes — AI engine |
| ESPN API (free, no key) | ATP/WTA schedules, rankings, player stats, match summaries | Yes — schedule + metadata |
| Pinnacle API (CF Worker) | Sharp money reference odds — Tennis | Optional but improves edge detection |
| Tennis API / matchstat.com (RapidAPI) | Current-season surface records, serve/return stats, H2H | Optional — enriches picks |
| Tennis Abstract (CF Worker proxy) | Sackmann historical match data fallback for stats | Optional — stat fallback |
