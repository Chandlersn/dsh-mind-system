import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeApproval, confirmApproval, revokeApproval, patternVersionOf } from '../src/pattern-approval.js';
import { matchPattern, recordPatternHit, planRollback, applyRollback } from '../src/pattern-runtime.js';

const pattern = (overrides = {}) => ({ patternId: 'pattern:abc', statement: 'Replace only the owned artifact.',
  negativeType: 'out_of_scope_scenario', keywords: ['foreign path'], scopeRef: 'scope-a',
  trigger: 'verification_failed', toolName: 'runtime.replace_json', recipeId: 'json-normalize',
  recipeVersion: '1', ...overrides });

const context = (overrides = {}) => ({ scopeRef: 'scope-a', trigger: 'verification_failed',
  toolName: 'runtime.replace_json', recipeId: 'json-normalize', recipeVersion: '1', ...overrides });

const evidence = (overrides = {}) => ({ eligible: true, independentRuns: 5, minRuns: 3, successRate: 0.8, ...overrides });

const approved = (now = () => 2000, overrides = {}) => {
  const candidate = { ...pattern(overrides), activatable: false };
  const request = proposeApproval(candidate, { requestedBy: 'runtime', ttlMs: 600_000, now: () => 1000 });
  return confirmApproval(request, { confirmedBy: 'boss', human: true, patternVersion: request.patternVersion, now });
};

test('the sixth identical case is served by the approved pattern without another analysis', () => {
  const approval = approved();
  const hit = matchPattern({ approval, pattern: pattern(), context: context(), evidence: evidence(), now: () => 3000 });
  assert.equal(hit.hit, true);
  assert.equal(hit.reason, 'approved_pattern_hit');
  assert.equal(hit.analysesSuppressed, true, 'A hit must actually suppress analysis.');
  const recorded = recordPatternHit(hit, { at: () => 3500 });
  assert.equal(recorded.patternId, 'pattern:abc');
  assert.equal(recorded.analysesSuppressed, true);
});

test('an unapproved, pending or revoked pattern abstains instead of acting', () => {
  const request = proposeApproval({ ...pattern(), activatable: false }, { requestedBy: 'runtime', now: () => 1000 });
  for (const approval of [null, request, revokeApproval(approved(), { revokedBy: 'boss', reason: 'too broad', now: () => 2500 })]) {
    const hit = matchPattern({ approval, pattern: pattern(), context: context(), evidence: evidence(), now: () => 3000 });
    assert.equal(hit.hit, false);
    assert.equal(hit.analysesSuppressed, false, 'Abstaining must not suppress analysis.');
  }
});

test('a different scope, trigger or tool is out of scope even with a valid approval', () => {
  const approval = approved();
  for (const [key, value] of [['scopeRef', 'scope-b'], ['trigger', 'execution_error'], ['toolName', 'runtime.write_json']]) {
    const hit = matchPattern({ approval, pattern: pattern(), context: context({ [key]: value }), evidence: evidence(), now: () => 3000 });
    assert.equal(hit.hit, false, key);
    assert.equal(hit.reason, `out_of_scope:${key}`, key);
    assert.equal(hit.analysesSuppressed, false, key);
  }
});

test('a changed template version abstains rather than reusing an old pattern', () => {
  const approval = approved();
  const moved = matchPattern({ approval, pattern: pattern(), context: context({ recipeVersion: '2' }),
    evidence: evidence(), now: () => 3000 });
  assert.equal(moved.hit, false);
  assert.equal(moved.reason, 'out_of_scope:recipeVersion');
});

test('insufficient evidence abstains even when the approval is otherwise valid', () => {
  const approval = approved();
  for (const item of [evidence({ eligible: false }), evidence({ independentRuns: 1 }), null]) {
    const hit = matchPattern({ approval, pattern: pattern(), context: context(), evidence: item, now: () => 3000 });
    assert.equal(hit.hit, false);
    assert.equal(hit.reason, 'evidence_insufficient');
  }
});

test('editing the approved pattern stops the hit without touching the approval record', () => {
  const approval = approved();
  const edited = matchPattern({ approval, pattern: pattern({ statement: 'Replace anything.' }),
    context: context(), evidence: evidence(), now: () => 3000 });
  assert.equal(edited.hit, false);
  assert.equal(edited.reason, 'pattern_version_changed');
  assert.equal(approval.status, 'confirmed', 'The record itself is untouched; only its effect lapses.');
});

test('revocation restores the original behaviour', () => {
  const approval = approved();
  assert.equal(matchPattern({ approval, pattern: pattern(), context: context(), evidence: evidence(), now: () => 3000 }).hit, true);
  const revoked = revokeApproval(approval, { revokedBy: 'boss', reason: 'over-broad', now: () => 3100 });
  const after = matchPattern({ approval: revoked, pattern: pattern(), context: context(), evidence: evidence(), now: () => 3200 });
  assert.equal(after.hit, false);
  assert.equal(after.analysesSuppressed, false);
});

test('a rollback restores the version but demands a fresh review', () => {
  const v1 = approved(() => 2000);
  const v2 = approved(() => 2500, { statement: 'Replace anything.' });
  const plan = planRollback({ approval: v2, history: [v1, v2], targetVersion: v1.patternVersion,
    reason: 'v2 proved too broad' });
  assert.equal(plan.rollbackTo, v1.patternVersion);
  assert.equal(plan.requiresReview, true, 'Restoring content must not restore the ticket.');
  assert.equal(plan.supersededVersion, v2.patternVersion);
  const applied = applyRollback({ approval: v2, plan, now: () => 4000 });
  assert.equal(applied.restored.status, 'pending');
  assert.equal(applied.restored.reviewTicket, undefined, 'A rolled-back version may not keep a live ticket.');
  assert.equal(applied.retired.status, 'superseded');
  assert.equal(applied.requiresReview, true);
  // Until re-confirmed, the rolled-back pattern does not hit.
  const hit = matchPattern({ approval: applied.restored, pattern: pattern(), context: context(),
    evidence: evidence(), now: () => 4100 });
  assert.equal(hit.hit, false);
});

test('rollback refuses unknown targets, the current version, and a dead approval', () => {
  const v1 = approved(() => 2000);
  const v2 = approved(() => 2500, { statement: 'Replace anything.' });
  assert.throws(() => planRollback({ approval: v2, history: [v1], targetVersion: 'f'.repeat(64), reason: 'x' }),
    { code: 'rollback_target_not_found' });
  assert.throws(() => planRollback({ approval: v2, history: [v1, v2], targetVersion: v2.patternVersion, reason: 'x' }),
    { code: 'invalid_rollback' });
  assert.throws(() => planRollback({ approval: v2, history: [], targetVersion: v1.patternVersion, reason: 'x' }),
    { code: 'invalid_rollback' });
  assert.throws(() => applyRollback({ approval: revokeApproval(v2, { revokedBy: 'b', reason: 'r' }),
    plan: { rollbackTo: v1.patternVersion, reason: 'x', requiresReview: true } }), { code: 'invalid_rollback' });
});

test('a hit record cannot be fabricated from an abstention', () => {
  const approval = approved();
  const miss = matchPattern({ approval, pattern: pattern(), context: context({ scopeRef: 'elsewhere' }),
    evidence: evidence(), now: () => 3000 });
  assert.throws(() => recordPatternHit(miss), { code: 'invalid_pattern_hit' });
  assert.throws(() => recordPatternHit(null), { code: 'invalid_pattern_hit' });
});

test('the approved version is the pattern version, so matching and approval cannot drift apart', () => {
  const approval = approved();
  assert.equal(patternVersionOf(pattern()), approval.patternVersion);
});
