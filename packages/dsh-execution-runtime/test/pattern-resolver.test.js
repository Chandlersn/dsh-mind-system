import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternResolver, describePatternEvidence, evidenceFromRepairs } from '../src/pattern-resolver.js';
import { confirmApproval, proposeApproval, revokeApproval } from '../src/pattern-approval.js';

/**
 * The resolver is where the self-iterating loop closes: evidence becomes a reusable decision without a
 * human naming the pattern. These tests pin both halves — that it can hit, and that it refuses to hit
 * for every reason that would make reuse unsound.
 */

const identity = { recipeId: 'csv-normalize', recipeVersion: '1', scopeRef: 's', verifierId: 'csv-source-output',
  verifierVersion: '1', trigger: 'verification_failed', toolName: 'runtime.write_text' };

/**
 * A real pattern body. Identity fields are mandatory here: `matchPattern` only checks a constraint the
 * pattern actually declares, so a body without recipeVersion would match every version silently.
 */
const patternBody = (overrides = {}) => ({ patternId: 'p1',
  statement: 'The verified output differs from the source projection.',
  negativeType: 'out_of_scope_scenario', keywords: ['output', 'mismatch'],
  ...identity, ...overrides });

/** Build a confirmed approval through the real two-step gate, never by writing fields directly. */
function confirmed(pattern, now = () => 1000) {
  const pending = proposeApproval({ ...pattern, activatable: false }, { requestedBy: 'test', now });
  return confirmApproval(pending, { confirmedBy: 'boss', human: true,
    patternVersion: pending.patternVersion, now });
}

/** Approvals plus the reviewed bodies they cover; the resolver needs both, and neither implies the other. */
function approved(patternBodyValue, now = () => 1000) {
  return { approvals: [confirmed(patternBodyValue, now)], patterns: [patternBodyValue] };
}

/** A store stub whose evidence we control; the resolver must not invent samples of its own. */
function stubStore(entries) {
  return { readRepairTrace() { return []; }, listPatternEvidence() { return entries; },
    getLatestAttempt() { return { candidate: { toolName: 'runtime.write_text' } }; } };
}

const run = (overrides = {}) => ({ status: 'waiting_analysis', reason: 'verification_failed',
  task: { taskId: 't1', recipeId: 'csv-normalize', recipeVersion: '1', scopeRef: 's', ...overrides } });

const samples = (patternId, runs, succeeded = true) => Array.from({ length: runs }, (_, index) => ({
  patternId, repairId: `${patternId}-r${index}`, taskId: `task-${index}`, status: 'settled', succeeded }));

test('a proven pattern is resolved from evidence without the caller naming it', () => {
  const body = patternBody();
  const resolve = createPatternResolver({ store: stubStore(samples('p1', 4)),
    ...approved(body), now: () => 1000 });
  const found = resolve('t1', run());
  assert.ok(found, 'Four independent runs with a live approval must be reusable.');
  assert.equal(found.patternId, 'p1');
  assert.equal(found.decision.hit, true);
});

test('no approval means no reuse, however strong the evidence', () => {
  const resolve = createPatternResolver({ store: stubStore(samples('p1', 9)), approvals: [], now: () => 1000 });
  assert.equal(resolve('t1', run()), null, 'Evidence alone must never authorize reuse.');
});

test('one task repairing itself repeatedly cannot reach the threshold', () => {
  // Same task id on every sample: a run cannot manufacture independent confidence.
  const entries = Array.from({ length: 8 }, (_, index) => ({
    patternId: 'p1', repairId: `r${index}`, taskId: 'one-task', status: 'settled', succeeded: true }));
  const resolve = createPatternResolver({ store: stubStore(entries), ...approved(patternBody()),
    now: () => 1000 });
  assert.equal(resolve('t1', run()), null);
});

test('a revoked or expired approval abstains instead of falling back to analysis silently', () => {
  const body = patternBody();
  const revoked = createPatternResolver({ store: stubStore(samples('p1', 5)), patterns: [body],
    approvals: [revokeApproval(confirmed(body), { revokedBy: 'boss', reason: 'wrong', now: () => 2000 })],
    now: () => 2000 });
  assert.equal(revoked('t1', run()), null);
  const stale = confirmed(body);
  const expired = createPatternResolver({ store: stubStore(samples('p1', 5)), patterns: [body],
    approvals: [stale], now: () => stale.expiresAt + 1 });
  assert.equal(expired('t1', run()), null);
});

test('a changed recipe version is out of scope for an old pattern', () => {
  const resolve = createPatternResolver({ store: stubStore(samples('p1', 5)),
    ...approved(patternBody()), now: () => 1000 });
  assert.equal(resolve('t1', run({ recipeVersion: '2' })), null,
    'A new template version is a new environment and must invalidate the old pattern.');
});

test('a trigger or tool mismatch is out of scope', () => {
  const resolve = createPatternResolver({ store: stubStore(samples('p1', 5)),
    ...approved(patternBody()), now: () => 1000 });
  assert.equal(resolve('t1', { ...run(), reason: 'plan_gap' }), null);
  const otherTool = createPatternResolver({
    store: { ...stubStore(samples('p1', 5)), getLatestAttempt() { return { candidate: { toolName: 'other' } }; } },
    ...approved(patternBody()), now: () => 1000 });
  assert.equal(otherTool('t1', run()), null);
});

test('failures count against the success rate rather than disappearing', () => {
  const mixed = [...samples('p1', 3, true), ...Array.from({ length: 3 }, (_, index) => ({
    patternId: 'p1', repairId: `f${index}`, taskId: `fail-${index}`, status: 'settled', succeeded: false }))];
  const report = describePatternEvidence(mixed, { minRuns: 3, minSuccessRate: 0.66 });
  assert.equal(report[0].successRate, 0.5, 'A 50% pattern must not report as 100%.');
  assert.equal(report[0].eligible, false);
  const resolve = createPatternResolver({ store: stubStore(mixed), ...approved(patternBody()),
    now: () => 1000 });
  assert.equal(resolve('t1', run()), null);
});

test('an approval without its reviewed body resolves nothing', () => {
  // The ticket names a pattern; without the registered body there is no text to compare against, so the
  // resolver must abstain instead of fabricating a body that would trivially match its own version.
  const body = patternBody();
  const resolve = createPatternResolver({ store: stubStore(samples('p1', 5)),
    approvals: [confirmed(body)], patterns: [], now: () => 1000 });
  assert.equal(resolve('t1', run()), null, 'A missing reviewed body must abstain.');
});

test('the resolver reports candidates but never activates them', () => {
  const report = describePatternEvidence(samples('p1', 5));
  assert.equal(report[0].activatable, false, 'A candidate is not an active rule.');
});

test('a store without cross-task evidence abstains rather than scanning unrelated runs', () => {
  const resolve = createPatternResolver({ store: { readRepairTrace() { return []; },
    getLatestAttempt() { return { candidate: { toolName: 'runtime.write_text' } }; } },
    ...approved(patternBody()), now: () => 1000 });
  assert.equal(resolve('t1', run()), null);
});

test('repair rows keep per-repair identity so repeats are rejected, not double counted', () => {
  const entries = evidenceFromRepairs({ taskId: 't1', identity,
    repairs: [{ repairId: 'r1', status: 'settled', succeeded: true },
      { repairId: 'r1', status: 'settled', succeeded: true }] });
  assert.equal(entries.length, 2);
  const report = describePatternEvidence(entries, { minRuns: 1, minSuccessRate: 0.5 });
  assert.equal(report[0].samples, 1, 'The same repair must count once even if listed twice.');
});
