# Session Summary — 2026-05-09

**Theme:** Diagnose and fix AI Analyze quality issues, then audit-and-harden the surrounding codebase.

**Scope:** 8 commits to `main`, all live on GitHub Pages.

---

## Phase 1 — User-reported AI Analyze bug

### Symptom
On the dashboard's AI Analyze button, results frequently cited "missing player data" and/or repeated the same matchup result data multiple times within a single response.

### Diagnosis
Two distinct root causes traced through [index.html:5308-5374](../index.html):

1. **Duplicate match facts in the prompt.** The same prior H2H meeting was being restated in the prompt context up to **5 times** with different framings — once in each player's L5 line, once in each player's "this tournament" line, and once in the canonical "Recent H2H" line. The model echoed the redundancy back as repeated reasoning and over-anchored on the multi-stated fact.
2. **Empty `tennisForm` for off-feed players.** `tennisForm` was only populated from today's ESPN scoreboard during `refreshAll()`. Any player whose last completed match wasn't in today's feed (first-round players, rest-day returners) had no form data → `LIMITED DATA` flag fired → model hedged confidence even when surface DB and odds were fine.

### Fixes shipped (3 commits)

| # | Commit | Fix |
|---|---|---|
| #1 + #2 | [`811c100`](https://github.com/CHQuordata/sharp-court/commit/811c100) | Canonical match-key dedup across L5 / this-tournament / Recent H2H. Unified "this tournament" block (one line per match instead of two per player). |
| #3 | [`794baf0`](https://github.com/CHQuordata/sharp-court/commit/794baf0) | Fixed broken cache guard at [index.html:5314](../index.html). `gameFormCache.has(g.id)` always missed because the cache is keyed by player id, not game id — prefetch ran on every click. Now scoped to tennis games with actually-missing data. |
| #4 + #5 | [`be7e285`](https://github.com/CHQuordata/sharp-court/commit/be7e285) | Added `backfillTennisForm(daysBack=10)` — pulls past-10-days ESPN scoreboards in parallel (capped at 8s wall time, idempotent dedup on `±60s` instant). Split monolithic `LIMITED DATA` flag into scoped `NO RECENT FORM` and `NO SURFACE DB` so the model only hedges the affected signal class. |

### Visual report generated
[`outputs/2026-05-09_AIAnalyze_FixSummary.html`](2026-05-09_AIAnalyze_FixSummary.html) — single-file dark Bloomberg-style HTML with KPI strip, SVG pipeline diagram, before/after fix cards, data-source health table.

---

## Phase 2 — Codebase audit

User asked for a code-reviewer-style audit. Delegated to an Explore agent over the full ~7,500-line codebase, then verified the agent's claims against actual file state.

### Audit deliverable
- 20 findings grouped HIGH / MEDIUM / LOW
- Several agent claims were inflated and corrected (e.g., "80 innerHTML usages" → actual 37; "ALLOWED_ORIGIN never used" → actually wired into CORS responses)
- Verified mega-line counts independently: line **3899 = 5,219 chars**, line **2080 = 3,637 chars**, several others over 1,500 chars

### HIGH-severity items identified

| # | Item | Disposition |
|---|---|---|
| H1 | Mega-line CSV parser at line 2080 | **Fixed** |
| H2 | 37 `innerHTML` writes, model output unescaped in verdict cards | **Fixed** (scoped) |
| H3 | `Promise.race` masking fetch failures | Deferred — logging hygiene only |
| H4 | `_repairJSON` suspect output silently accepted | **Fixed** |

---

## Phase 3 — HIGH-severity fixes shipped

### H1 — Sackmann CSV parser extracted ([`42663ab`](https://github.com/CHQuordata/sharp-court/commit/42663ab))

3,637-char one-line `fetchTennisH2H` function split into pure functions in new `lib/sackmann.js`:
- `fetchSackmannCSVs(sp, opts)` — parallel fetch of 4 years
- `parseSackmannYear(csv, year, {norm, awMatch, hmMatch})` — name-matching agnostic
- `accumulateServe(s, c, ci, sideKey)` — single-match serve aggregation
- `summarizeServe(s)` — final per-surface serve % computation
- `aggregateSackmannResults(parsedYears)` — merge years
- `fetchSackmannH2H(...)` — orchestrator

`index.html` keeps a 11-line wrapper that builds matchers next to `tnSurnameCands` and delegates. Verified end-to-end with a synthetic 3-row CSV — H2H tally, surface splits, and serve aggregates all match manual math.

**Side fix:** `npx serve` had a corrupted npm cache (mime-db missing db.json). Switched [`.claude/launch.json`](../.claude/launch.json) to `npx --yes http-server`.

### H2 — XSS in verdict cards ([`6532043`](https://github.com/CHQuordata/sharp-court/commit/6532043))

Verdict cards at [index.html:5520](../index.html) interpolated `v.my_pick`, `v.my_verdict`, `v.confidence`, `v.score` into `innerHTML` without escaping. Those fields come from `JSON.parse` of model output — a tournament name with embedded markup could induce a payload that executes on render.

- Hoisted `escHTML(s)` to a top-level helper at [index.html:620](../index.html)
- Wrapped every dynamic interpolation in the verdict-card builder
- Replaced two duplicate inline patterns (`_esc` in selGame error handler, `safeTxt` in aiAnalyzeGame)
- Verified end-to-end: simulated payload `<img src=x onerror=alert(1)>` + `<script>alert(1)</script>` → 0 img tags, 0 script tags after `innerHTML` render, payload appears as visible escaped text

**Not fixed:** ~30 other `innerHTML` writes that interpolate trusted internal app state (formatted numbers, hardcoded labels) or low-risk external strings (ESPN player/tournament names). Documented as deferred-defensive-cleanup.

### H4 — `_repairJSON` suspect rejection ([`1eae327`](https://github.com/CHQuordata/sharp-court/commit/1eae327))

`_repairJSON` had a suspect counter and console warning at `innerQuotesEscaped >= 10` but no caller could read the signal. Semantically wrong picks could land in `et_picks_history` and pollute CLV / calibration metrics.

- Hoisted threshold to `REPAIR_SUSPECT_THRESHOLD = 10` constant
- `_repairJSON.last = {inputLen, innerQuotesEscaped, suspect, ts}` set after every call
- Main pick parser captures suspect flag from full-response repair (before sub-extracts overwrite the side-channel) and rejects with a clean re-runnable error
- Judge-verdict path drops verdicts entirely when suspect — picks ship with no judge decoration rather than with verdicts recovered from corrupted JSON
- Lower-stakes call sites (`parseLearningResponse`, `_partialExtract`) keep current behavior

Verified: clean JSON → 0 escapes; pre-escaped apostrophe → 0 escapes; mangled wholesale (16 escapes) → `suspect=true`, threshold check fires.

### L1 — CLAUDE.md refresh ([`f4dd95e`](https://github.com/CHQuordata/sharp-court/commit/f4dd95e))

- Line count was `~3,200`, actually 5,700
- "All logic lives in index.html" no longer true — pure functions extracted to lib/*.js
- Dev server command was stale `npx serve`; now `npx --yes http-server`

---

## Phase 4 — User asked: "are these remaining truly needed?"

Honest assessment: **no, not urgent.**

- **H3** (Promise.race + AbortController): logging hygiene only for a single-user tool. User-facing consequence already covered by split LIMITED DATA flags.
- **H1-cont** (next mega-line at line 3907 — 5,219 chars): the AI Analyze prompt builder we just touched. Refactor would unlock testing but the testing gap itself is non-urgent for a single-user tool. Defer until the next substantial change.

Watch list (don't do now, but don't forget):
- M1 — `_pinnacleWorkerDown` auto-recovery (2-line fix)
- M7 — `et_picks_history` size cap (matters once data accumulates)

---

## Phase 5 — User asked: "how does this improve pick quality, pre vs post?"

Honest impact ranking:

| Rank | Fix | Why |
|---|---|---|
| 1 | **#4 form backfill** | Biggest visible win. Affects first-round / rest-day / weekend slates. Used to default to MEDIUM/LOW from missing data; now scored on actual form. |
| 2 | **#5 split flag** | Sharper confidence calibration on partial-data slates. Model no longer hedges all axes when only one is missing. |
| 3 | **#1/#2 dedup** | Quieter prompt, less anchoring on repeated H2H mention. Most visible on rematch slates. |
| 4 | **H4 suspect rejection** | Invisible today, compounding over weeks. Stops corrupted picks from polluting grading data the system learns from. |

**Plumbing only** (no pick-quality change):
- #3 cache guard (speed)
- H1 Sackmann extraction (refactor, behavior bit-for-bit preserved)
- H2 XSS (security)
- L1 CLAUDE.md (doc)

---

## Final commit log

```
f4dd95e — Refresh stale CLAUDE.md project overview (L1)
1eae327 — Reject suspect _repairJSON output in high-stakes paths (H4)
6532043 — Escape AI Analyze verdict-card model output (XSS H2)
42663ab — Extract Sackmann CSV parser to lib/sackmann.js (H1)
be7e285 — Backfill tennisForm + split LIMITED DATA flag (#4 + #5)
794baf0 — Fix broken AI Analyze prefetch guard (#3)
811c100 — Dedup tennis match facts in AI Analyze prompt (#1 + #2)
```

8 commits total (incl. one earlier non-AI-Analyze pick dedup at `b0467d3`). All pushed to `main`, live on GitHub Pages.

---

## Files touched this session

**Modified:**
- [`index.html`](../index.html) — all 6 functional fixes
- [`CLAUDE.md`](../CLAUDE.md) — doc refresh
- [`.claude/launch.json`](../.claude/launch.json) — dev-server swap

**Created:**
- [`lib/sackmann.js`](../lib/sackmann.js) — extracted CSV parser
- [`outputs/2026-05-09_AIAnalyze_FixSummary.html`](2026-05-09_AIAnalyze_FixSummary.html) — visual report
- [`outputs/2026-05-09_Session_Summary.md`](2026-05-09_Session_Summary.md) — this file
