import { describe, test, expect } from 'vitest';
import { aimp, kellyPct } from '../../lib/odds.js';

// ── aimp ──────────────────────────────────────────────────────────────────────

describe('aimp (American odds → implied probability)', () => {
  describe('positive (underdog) odds', () => {
    test('+100 → 0.50 (even money)', () => {
      expect(aimp(100)).toBeCloseTo(0.5, 5);
    });

    test('+200 → 0.333', () => {
      expect(aimp(200)).toBeCloseTo(1 / 3, 4);
    });

    test('+150 → 0.40', () => {
      expect(aimp(150)).toBeCloseTo(0.4, 5);
    });

    test('+400 → 0.20', () => {
      expect(aimp(400)).toBeCloseTo(0.2, 5);
    });
  });

  describe('negative (favorite) odds', () => {
    test('-100 → 0.50 (even money)', () => {
      expect(aimp(-100)).toBeCloseTo(0.5, 5);
    });

    test('-110 → ~0.5238', () => {
      expect(aimp(-110)).toBeCloseTo(110 / 210, 5);
    });

    test('-200 → 0.6667', () => {
      expect(aimp(-200)).toBeCloseTo(2 / 3, 4);
    });

    test('-400 → 0.80', () => {
      expect(aimp(-400)).toBeCloseTo(0.8, 5);
    });
  });

  describe('symmetry and range', () => {
    test('+100 and -100 both return 0.50', () => {
      expect(aimp(100)).toBeCloseTo(aimp(-100), 10);
    });

    test('result is always between 0 and 1', () => {
      for (const odds of [-500, -200, -110, -100, 100, 110, 200, 500]) {
        const p = aimp(odds);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }
    });

    test('higher favorite odds → higher implied probability', () => {
      expect(aimp(-200)).toBeGreaterThan(aimp(-110));
      expect(aimp(-110)).toBeGreaterThan(aimp(-100));
    });

    test('higher underdog odds → lower implied probability', () => {
      expect(aimp(100)).toBeGreaterThan(aimp(200));
      expect(aimp(200)).toBeGreaterThan(aimp(400));
    });
  });
});

// ── kellyPct ─────────────────────────────────────────────────────────────────

describe('kellyPct (Kelly criterion bet sizing)', () => {
  describe('confidence-based defaults (no evData)', () => {
    // Updated formula: p = bookImplied + edgeByConf (HIGH=4pp, MEDIUM=1.5pp, LOW=0.3pp).
    // Prior model used fixed p=0.58/0.53/0.50 ignoring price, producing absurd
    // Kelly stakes on plus-money picks. New model derives p from book + edge.
    test('HIGH confidence at -110 returns a positive Kelly %', () => {
      // book≈0.524, p=0.564, dec≈1.909 → k=(0.564×0.909−0.436)/0.909≈8.5%
      const result = kellyPct('HIGH', 'Team (-110)', null);
      expect(result).toBeCloseTo(8.5, 0);
    });

    test('MEDIUM confidence at -110 returns a small positive Kelly %', () => {
      // book≈0.524, p=0.539, dec≈1.909 → k≈3.2%
      const result = kellyPct('MEDIUM', 'Team (-110)', null);
      expect(result).toBeCloseTo(3.2, 0);
    });

    test('LOW confidence at -110 returns a tiny positive Kelly %', () => {
      // book≈0.524, p=0.527 → barely above book, k tiny but positive
      const result = kellyPct('LOW', 'Team (-110)', null);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    test('HIGH > MEDIUM > LOW > 0 at -110 odds', () => {
      const high   = kellyPct('HIGH',   'Team (-110)', null);
      const medium = kellyPct('MEDIUM', 'Team (-110)', null);
      const low    = kellyPct('LOW',    'Team (-110)', null);
      expect(high).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(low);
      expect(low).toBeGreaterThan(0);
    });

    test('plus-money longshots produce small Kelly stakes (regression)', () => {
      // Old formula: LOW +400 → 37.5% full Kelly (catastrophic).
      // New formula: book=0.20, p=0.203 → tiny edge → tiny stake.
      const lowLongshot = kellyPct('LOW', 'Team (+400)', null);
      expect(lowLongshot).toBeLessThan(2);
      // HIGH on a longshot still produces a stake but a sane one.
      const highLongshot = kellyPct('HIGH', 'Team (+400)', null);
      expect(highLongshot).toBeLessThan(8);
    });
  });

  describe('odds extraction from pick string', () => {
    test('extracts odds from pick string format "Team (-110)"', () => {
      const withOdds    = kellyPct('HIGH', 'Chiefs -3.5 (-110)', null);
      const withoutOdds = kellyPct('HIGH', null, null); // falls back to -115
      // -110 vs -115 defaults — -110 has slightly larger decimal, should be higher kelly
      expect(withOdds).not.toEqual(withoutOdds);
    });

    test('falls back to -115 default when no odds in pick string for HIGH conf', () => {
      // No pick string → uses HIGH default of -115
      const r1 = kellyPct('HIGH', null, null);
      const r2 = kellyPct('HIGH', '', null);
      expect(r1).toBeCloseTo(r2, 5);
    });

    test('falls back to -110 default for MEDIUM/LOW when no odds in string', () => {
      const r1 = kellyPct('MEDIUM', null, null);
      const r2 = kellyPct('MEDIUM', 'No odds here', null);
      expect(r1).toBeCloseTo(r2, 5);
    });
  });

  describe('evData.tp overrides confidence default', () => {
    test('uses tp value when evData is provided', () => {
      // tp=60 → p=0.60 (not clamped), higher than HIGH default of 0.58
      const withTp  = kellyPct('HIGH', 'Team (-110)', { tp: '60' });
      const noTp    = kellyPct('HIGH', 'Team (-110)', null);
      expect(withTp).toBeGreaterThan(noTp);
    });

    test('clamps tp above 75% to 0.75', () => {
      const at80 = kellyPct('LOW', 'Team (-110)', { tp: '80' });
      const at75 = kellyPct('LOW', 'Team (-110)', { tp: '75' });
      expect(at80).toBeCloseTo(at75, 5);
    });

    test('clamps tp below 45% to 0.45', () => {
      const at30 = kellyPct('LOW', 'Team (-110)', { tp: '30' });
      const at45 = kellyPct('LOW', 'Team (-110)', { tp: '45' });
      expect(at30).toBeCloseTo(at45, 5);
    });
  });

  describe('floor: never returns negative', () => {
    test('returns 0 when tp clamp produces negative EV against heavy juice', () => {
      // tp=20 clamps to 0.45 floor; at -200 (book 66.7%, dec 1.5)
      // k=(0.45×0.5−0.55)/0.5=−0.65 → clamped to 0
      expect(kellyPct('LOW', 'Team (-200)', { tp: '20' })).toBe(0);
    });
  });
});
