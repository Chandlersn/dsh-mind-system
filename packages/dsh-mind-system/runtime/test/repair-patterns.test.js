import test from 'node:test';
import assert from 'node:assert/strict';
import { patternIdentity, classifyRepairEvidence, summarizePatternEvidence, buildPatternCandidates } from '../src/repair-patterns.js';

const constraint = (overrides = {}) => ({ recipeId: 'json-normalize', recipeVersion: '1', scopeRef: 'scope-a',
  verifierId: 'json-source-output', verifierVersion: '1', trigger: 'verification_failed',
  toolName: 'runtime.replace_json', ...overrides });

const pattern = (overrides) => patternIdentity({ ...constraint(), ...overrides }).patternId;

const entry = (repairId, taskId, { status = 'settled', succeeded = true, patternId = pattern() } = {}) => ({
  repairId, taskId, patternId, status, ...(status === 'settled' ? { succeeded } : {}) });

test('pattern identity follows what it constrains, not an exit code or a label', () => {
  const base = patternIdentity(constraint());
  assert.match(base.patternId, /^pattern:[a-f0-9]{32}$/);
  // The same constraint always yields the same identity.
  assert.equal(patternIdentity(constraint()).patternId, base.patternId);
  // Every constraint field changes identity, so unrelated failures cannot collapse together.
  for (const key of Object.keys(constraint())) {
    const changed = patternIdentity(constraint({ [key]: `${constraint()[key]}-variant` }));
    assert.notEqual(changed.patternId, base.patternId, `${key} must participate in the identity`);
  }
  // A transient message or an exit code is not part of the identity at all.
  const withNoise = patternIdentity({ ...constraint(), exitCode: 1, message: 'EPERM at 12:00' });
  assert.equal(withNoise.patternId, base.patternId, 'Transient text must not fork a pattern.');
});

test('unverified, blocked and unknown outcomes never count, while a verified failure counts against success', () => {
  const cases = [
    ['blocked', undefined, 'never_dispatched', false],
    ['unknown', undefined, 'unknown_outcome', false],
    ['observed', undefined, 'evidence_gathering_is_not_a_repair', false],
    // A verified failure is a real sample, so it must enter the denominator.
    ['settled', false, 'verified_failure', true],
  ];
  for (const [status, succeeded, reason, counted] of cases) {
    const classified = classifyRepairEvidence({ taskId: 't', repairId: 'r', patternId: 'p', status, ...(status === 'settled' ? { succeeded } : {}) });
    assert.equal(classified.counted, counted, status);
    assert.equal(classified.success, false, status);
    assert.equal(classified.reason, reason, status);
  }
  assert.deepEqual(classifyRepairEvidence({ taskId: 't', repairId: 'r', patternId: 'p', status: 'settled', succeeded: true }),
    { counted: true, success: true, reason: 'verified_repair' });
});

test('a settled repair without an explicit outcome is rejected rather than assumed successful', () => {
  assert.throws(() => classifyRepairEvidence({ taskId: 't', repairId: 'r', patternId: 'p', status: 'settled' }),
    { code: 'invalid_pattern_evidence' });
  assert.throws(() => classifyRepairEvidence({ taskId: 't', repairId: 'r', patternId: 'p', status: 'invented' }),
    { code: 'invalid_pattern_evidence' });
});

test('repeated repairs inside one run cannot manufacture independent evidence', () => {
  const single = [entry('r1', 'run-1'), entry('r2', 'run-1'), entry('r3', 'run-1'), entry('r4', 'run-1')];
  const [summary] = summarizePatternEvidence(single, { minRuns: 3 });
  assert.equal(summary.samples, 4);
  assert.equal(summary.independentRuns, 1, 'Four repairs in one run are one independent sample.');
  assert.equal(summary.eligible, false);
  assert.equal(summary.status, 'insufficient_runs');
  // Three runs each repairing once is genuinely three samples.
  const across = [entry('r1', 'run-1'), entry('r2', 'run-2'), entry('r3', 'run-3')];
  const [ok] = summarizePatternEvidence(across, { minRuns: 3 });
  assert.equal(ok.independentRuns, 3);
  assert.equal(ok.eligible, true);
  assert.equal(ok.status, 'candidate');
});

test('a duplicated receipt is deduplicated instead of double counted', () => {
  const duplicated = [entry('r1', 'run-1'), entry('r1', 'run-1'), entry('r2', 'run-2'), entry('r3', 'run-3')];
  const [summary] = summarizePatternEvidence(duplicated, { minRuns: 3 });
  assert.equal(summary.samples, 3);
  assert.equal(summary.independentRuns, 3);
});

test('one failure among successes can still be ineligible on rate', () => {
  const mixed = [entry('r1', 'run-1'), entry('r2', 'run-2'), entry('r3', 'run-3', { succeeded: false })];
  const [summary] = summarizePatternEvidence(mixed, { minRuns: 3, minSuccessRate: 0.9 });
  assert.equal(summary.independentRuns, 3);
  assert.equal(summary.successRate, 0.667);
  assert.equal(summary.eligible, false);
  assert.equal(summary.status, 'insufficient_success');
});

test('rejected evidence stays visible with its reason instead of being silently dropped', () => {
  const withUnknown = [entry('r1', 'run-1'), entry('r2', 'run-2'), entry('r3', 'run-3'),
    entry('r4', 'run-4', { succeeded: false }),
    { repairId: 'r5', taskId: 'run-5', patternId: pattern(), status: 'unknown' },
    { repairId: 'r6', taskId: 'run-6', patternId: pattern(), status: 'blocked' }];
  const [summary] = summarizePatternEvidence(withUnknown, { minRuns: 3 });
  // Three verified successes and one verified failure are samples; unknown and blocked are not.
  assert.equal(summary.samples, 4);
  assert.equal(summary.successes, 3);
  assert.equal(summary.independentRuns, 4);
  assert.equal(summary.rejected.length, 2);
  assert.deepEqual(summary.rejected.map((item) => item.reason).sort(), ['never_dispatched', 'unknown_outcome']);
});

test('different patterns are aggregated separately and candidates are never activatable', () => {
  const other = pattern({ scopeRef: 'scope-b' });
  const entries = [entry('r1', 'run-1'), entry('r2', 'run-2'), entry('r3', 'run-3'),
    entry('r4', 'run-4', { patternId: other })];
  const summaries = summarizePatternEvidence(entries, { minRuns: 3 });
  assert.equal(summaries.length, 2);
  assert.equal(summaries.find((item) => item.patternId === pattern()).eligible, true);
  assert.equal(summaries.find((item) => item.patternId === other).eligible, false);
  const candidates = buildPatternCandidates(entries, { minRuns: 3 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].activatable, false);
  assert.match(candidates[0].note, /not an active rule/);
  assert.equal(Object.isFrozen(candidates[0]), true);
});

test('aggregation rejects malformed policy instead of guessing thresholds', () => {
  for (const options of [{ minRuns: 0 }, { minRuns: 1.5 }, { minSuccessRate: 0 }, { minSuccessRate: 2 }, { minSuccessRate: 'high' }]) {
    assert.throws(() => summarizePatternEvidence([], options), { code: 'invalid_pattern_policy' });
  }
  assert.throws(() => summarizePatternEvidence('nope'), { code: 'invalid_pattern_evidence' });
});
