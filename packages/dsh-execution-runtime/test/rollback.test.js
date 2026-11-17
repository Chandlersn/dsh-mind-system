import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpoint, planRollbackTo, settleRollback } from '../src/rollback.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const BEFORE = hash('before');
const AFTER = hash('after');

const environment = (overrides = {}) => ({ recipeId: 'json-normalize', recipeVersion: '1',
  scopeRef: 'scope-a', workspaceRoot: 'C:/work', ...overrides });

const checkpoint = (overrides = {}) => createCheckpoint({ taskId: 'task-1', stepIndex: 2,
  state: { inputs: { inputFile: 'source.json' } }, environment: environment(),
  evidenceRef: 'file:state.json#sha256:' + BEFORE, now: () => 1000, ...overrides });

const compensation = () => ({ compensationId: 'restore:1', targetTool: 'runtime.replace_json',
  targetArguments: { path: 'C:/work/output.json', content: 'old', expectedSha256: AFTER },
  expectedBeforeSha256: AFTER, expectedAfterSha256: BEFORE, reason: 'restore_prior_version',
  sourceAttemptId: 'attempt-1' });

const passVerification = () => ({ status: 'pass', progress: 'advanced', goalSatisfied: true,
  verifierId: 'json-source-output', verifierVersion: '1', evidenceRefs: ['file:out.json#sha256:' + BEFORE] });

test('a read-only step restores directly from its checkpoint', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'read' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, 'read_only_restore');
  assert.equal(plan.requiresCompensation, false);
  const settled = settleRollback({ plan });
  assert.equal(settled.status, 'restored');
  assert.equal(settled.completed, true);
});

test('a reversible write without a registered compensation is refused, not silently restored', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write' });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, 'compensation_required');
  assert.equal(plan.requiresCompensation, true);
});

test('irreversible and unknown effects can never be rolled back automatically', () => {
  for (const effect of ['irreversible', 'unknown']) {
    const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect, compensation: compensation() });
    assert.equal(plan.allowed, false, effect);
    assert.equal(plan.reason, `not_compensable:${effect}`, effect);
  }
});

test('a checkpoint from a changed environment is not a rollback point', () => {
  for (const [key, value] of [['recipeVersion', '2'], ['scopeRef', 'scope-b'], ['workspaceRoot', 'C:/other']]) {
    const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment({ [key]: value }), effect: 'read' });
    assert.equal(plan.allowed, false, key);
    assert.equal(plan.reason, `environment_changed:${key}`, key);
  }
});

test('a reversible rollback is complete only when the target fact confirms it', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write',
    compensation: compensation() });
  assert.equal(plan.allowed, true);
  assert.equal(plan.requiresCompensation, true);
  const confirmed = settleRollback({ plan, verification: passVerification(), observedAfterSha256: BEFORE });
  assert.equal(confirmed.status, 'restored');
  assert.equal(confirmed.completed, true);
  // A failed or diverged compensation leaves the run unresolved instead of claiming a rollback.
  for (const [label, args] of [
    ['failed verification', { verification: { ...passVerification(), status: 'fail', goalSatisfied: false }, observedAfterSha256: BEFORE }],
    ['diverged target', { verification: passVerification(), observedAfterSha256: AFTER }],
    ['missing target fact', { verification: passVerification() }],
  ]) {
    const result = settleRollback({ plan, ...args });
    assert.equal(result.status, 'unresolved', label);
    assert.equal(result.completed, false, label);
  }
});

test('an invalid compensation is refused before any restore is planned', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write',
    compensation: { ...compensation(), expectedAfterSha256: AFTER } });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, 'compensation_invalid');
});

test('a checkpoint requires an environment and bounded step identity', () => {
  for (const overrides of [{ environment: undefined }, { stepIndex: -1 }, { state: [] }, { evidenceRef: '' }]) {
    assert.throws(() => checkpoint(overrides), { code: /invalid_(checkpoint|contract)/ });
  }
  assert.throws(() => planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'invented' }),
    { code: 'invalid_rollback' });
  assert.throws(() => settleRollback({ plan: { allowed: false } }), { code: 'invalid_rollback' });
});
