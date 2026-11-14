/**
 * P0-2 (2026-11-14): calibration denominator separation.
 *
 * Why this suite exists
 * --------------------
 * The real ledger on 2026-11-14 held 101 decisions: 82 nomination, 16 untagged,
 * 2 verification, 1 daily. Any missRate computed over the whole ledger was
 * therefore describing the nominator's own output, not ordinary use — yet the
 * plan read `dailyCount: 1/30` as "users have not accumulated enough data".
 *
 * Two denominators now exist and must stay distinct:
 *   - summary.missRate        — every decision (system behaviour overall)
 *   - summary.calibration.*   — daily rows only (what may tune thresholds)
 *
 * These tests pin the separation so a future "just use all rows" simplification
 * fails loudly instead of quietly resuming calibration on self-produced samples.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDecisions, CALIBRATION_ORIGINS } from '../src/store.js';
import { canCalibrate, MIN_CALIBRATION_SAMPLES } from '../src/thresholds.js';

const row = (origin, outcome, reason = 'r', gate = 'g') => ({ origin, outcome, reason, gate });

test('nomination rows shape the overall rate but never enter the calibration denominator', () => {
  const entries = [
    ...Array.from({ length: 82 }, () => row('nomination', 'admitted', 'in_contract_traceable', 'clis_nomination')),
    ...Array.from({ length: 16 }, () => row(undefined, 'skipped', 'legacy')),
    ...Array.from({ length: 2 }, () => row('verification', 'admitted', 'verified')),
    row('daily', 'skipped', 'not_concretized', 'downward_L1_L2'),
  ];
  const s = summarizeDecisions(entries);

  // Whole-ledger view still sees everything (nothing is hidden).
  assert.equal(s.evaluated, 101);
  assert.equal(s.skipped, 17);
  assert.equal(s.byOrigin.nomination, 82);
  assert.equal(s.byOrigin.untagged, 16);

  // Calibration view is daily-only — the entire point of P0-2.
  assert.deepEqual(CALIBRATION_ORIGINS, ['daily']);
  assert.equal(s.calibration.evaluated, 1);
  assert.equal(s.calibration.skipped, 1);
  assert.equal(s.calibration.missRate, 1);
  assert.deepEqual(s.calibration.byReason, { not_concretized: 1 });
  assert.equal(s.calibration.byGate.downward_L1_L2, 1);
  assert.equal(s.calibration.byGate.clis_nomination, undefined, 'nomination gates must not leak in');
  assert.equal(s.dailyCount, 1);
  assert.equal(s.calibration.sampleSufficient, false);
});

test('untagged historical rows are reported but never counted as daily', () => {
  const s = summarizeDecisions([
    row(undefined, 'admitted'),
    row('', 'skipped'),
    row(null, 'admitted'),
  ]);
  assert.equal(s.byOrigin.untagged, 3);
  assert.equal(s.dailyCount, 0, 'missing origin must not be guessed into daily');
  assert.equal(s.calibration.evaluated, 0);
  assert.match(String(s.calibration.note), /不计入校准分母/);
});

test('calibration gate refuses to allow threshold changes without daily samples', () => {
  const zero = summarizeDecisions([row('nomination', 'admitted')]);
  const verdict = canCalibrate(zero.calibration);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'no_daily_samples');
  assert.equal(verdict.needed, MIN_CALIBRATION_SAMPLES);

  // A big ledger of self-produced rows is still not enough — this is the exact
  // trap the real root was in.
  const stillZero = summarizeDecisions(Array.from({ length: 200 }, () => row('nomination', 'skipped')));
  assert.equal(canCalibrate(stillZero.calibration).allowed, false);
  assert.equal(canCalibrate(stillZero.calibration).evaluated, 0);
});

test('calibration opens only when daily rows reach the floor', () => {
  const under = summarizeDecisions(Array.from({ length: MIN_CALIBRATION_SAMPLES - 1 }, () => row('daily', 'admitted')));
  assert.equal(under.calibration.evaluated, MIN_CALIBRATION_SAMPLES - 1);
  assert.equal(canCalibrate(under.calibration).allowed, false);
  assert.equal(canCalibrate(under.calibration).reason, 'sample_below_floor');

  const at = summarizeDecisions(Array.from({ length: MIN_CALIBRATION_SAMPLES }, () => row('daily', 'admitted')));
  const verdict = canCalibrate(at.calibration);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, 'sample_sufficient');
  assert.equal(at.calibration.sampleSufficient, true);
});

test('verification and drill samples stay out of calibration too', () => {
  const s = summarizeDecisions([
    ...Array.from({ length: 10 }, () => row('verification', 'admitted')),
    ...Array.from({ length: 5 }, () => row('drill', 'admitted')),
    row('daily', 'admitted'),
  ]);
  assert.equal(s.evaluated, 16);
  assert.equal(s.calibration.evaluated, 1, 'only the daily row counts');
});
