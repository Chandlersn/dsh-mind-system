import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { RuntimeStore } from '../src/store.js';
import { validateCompensationPlan, assessCompensation, buildJsonCompensation,
  assertCompensationSupported, bindCompensationToAttempt, registerCompensation } from '../src/compensation.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const A = hash('before');
const B = hash('after');

const plan = (overrides = {}) => ({ compensationId: 'restore:1', targetTool: 'runtime.replace_json',
  targetArguments: { path: '/w/out.json', content: 'old', expectedSha256: B },
  expectedBeforeSha256: B, expectedAfterSha256: A, reason: 'restore_prior_version',
  sourceAttemptId: 'attempt-1', ...overrides });

const verification = (overrides = {}) => ({ status: 'pass', progress: 'advanced', goalSatisfied: true,
  verifierId: 'json-source-output', verifierVersion: '1', evidenceRefs: ['file:/w/out.json#sha256:' + A], ...overrides });

function fixture(t, { keepRunning = false, maxCompensations } = {}) {
  const store = new RuntimeStore(':memory:');
  t.after(() => store.close());
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'g',
    scopeRef: 's', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 60_000,
    // Recovery attempts draw on their own reserve, declared per task.
    ...(maxCompensations === undefined ? {} : { budget: { maxCompensations } }) };
  store.createRun(task);
  const candidate = { candidateId: 'c', toolName: 'runtime.write_json', progressKey: 'p',
    arguments: { path: '/w/out.json', content: 'new', createOnly: true }, preconditionIds: ['ready'],
    postconditionIds: ['read'], effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' } };
  const reserved = store.reserveAttempt(task.taskId, candidate, { expectedVersion: store.getRun(task.taskId).version });
  store.markStarted(task.taskId, reserved.attemptId, { expectedVersion: store.getRun(task.taskId).version });
  // Verified progress without goal completion keeps the run running, which is where a compensation is decided.
  const verification = keepRunning
    ? { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'json-source-output',
      verifierVersion: '1', evidenceRefs: ['file:/w/out.json#sha256:' + B] }
    : { status: 'fail', progress: 'unchanged', goalSatisfied: false, verifierId: 'json-source-output',
      verifierVersion: '1', evidenceRefs: ['file:/w/out.json#sha256:' + B] };
  store.recordOutcome(task.taskId, reserved.attemptId, { status: 'succeeded' }, verification,
    { expectedVersion: store.getRun(task.taskId).version });
  return { store, task, attemptId: reserved.attemptId };
}

test('a compensation plan must name distinct observed versions and one restore reason', () => {
  assert.doesNotThrow(() => validateCompensationPlan(plan()));
  for (const invalid of [
    plan({ expectedAfterSha256: B }), plan({ reason: 'undo' }), plan({ targetArguments: 'nope' }),
    plan({ targetArguments: [] }), plan({ expectedBeforeSha256: 'nope' }),
    { ...plan(), extra: true },
  ]) assert.throws(() => validateCompensationPlan(invalid), { code: 'invalid_compensation' });
  // A non-string identity is rejected by the shared contract validator, not the plan validator.
  assert.throws(() => validateCompensationPlan({ ...plan(), compensationId: '' }), { code: 'invalid_contract' });
});

test('completion requires a passing target verification and the expected target fact', () => {
  assert.equal(assessCompensation({ plan: plan(), observedAfterSha256: A, verification: verification() }).completed, true);
  for (const [label, args, reason] of [
    ['failed verification', { observedAfterSha256: A, verification: verification({ status: 'fail', progress: 'unchanged', goalSatisfied: false }) }, 'compensation_verification_failed'],
    ['missing evidence', { observedAfterSha256: A, verification: verification({ status: 'unknown', progress: 'unknown', goalSatisfied: null, evidenceRefs: [] }) }, 'compensation_verification_failed'],
    ['missing fact', { observedAfterSha256: undefined, verification: verification() }, 'compensation_target_fact_missing'],
    ['diverged fact', { observedAfterSha256: B, verification: verification() }, 'compensation_target_mismatch'],
  ]) {
    const result = assessCompensation({ plan: plan(), ...args });
    assert.equal(result.completed, false, label);
    assert.equal(result.reason, reason, label);
  }
});

test('irreversible and unknown effects are refused as uncompensable', () => {
  for (const effect of ['irreversible', 'unknown']) assert.throws(() => assertCompensationSupported(effect), /cannot be compensated/);
  // Read-only actions leave nothing to compensate, so they pass the capability check but are never planned.
  assert.equal(assertCompensationSupported('read'), true);
  assert.equal(assertCompensationSupported('reversible_write'), true);
  assert.throws(() => registerCompensation({ toolName: 'x', effect: 'irreversible', build: () => {}, verify: () => {} }),
    { code: 'compensation_unsupported' });
  assert.equal(typeof registerCompensation({ toolName: 'x', build: () => {}, verify: () => {} }).build, 'function');
});

test('a plan cannot retarget another tool or source attempt', () => {
  const candidate = { attemptId: 'attempt-1', candidateId: 'c', toolName: 'runtime.write_json', progressKey: 'p',
    arguments: { path: '/w/out.json', content: 'new', createOnly: true }, preconditionIds: ['ready'],
    postconditionIds: ['read'], effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' } };
  assert.throws(() => bindCompensationToAttempt(plan({ sourceAttemptId: 'other' }), candidate),
    { code: 'compensation_binding_mismatch' });
  assert.throws(() => bindCompensationToAttempt(plan({ targetTool: 'runtime.unrelated' }), candidate),
    { code: 'compensation_binding_mismatch' });
  // Same argument shape, different tool: only the tool-identity check can catch this.
  assert.throws(() => bindCompensationToAttempt(plan({ targetTool: 'runtime.unrelated',
    targetArguments: { path: '/w/out.json', content: 'old', createOnly: true } }), candidate),
  { code: 'compensation_binding_mismatch' });
  assert.throws(() => bindCompensationToAttempt(plan({ targetArguments: { path: '/w/out.json' } }), candidate),
    { code: 'compensation_binding_mismatch' });
  assert.doesNotThrow(() => bindCompensationToAttempt(plan({ targetTool: 'runtime.write_json',
    targetArguments: { path: '/w/out.json', content: 'old', createOnly: true } }), candidate));
});

test('only target-verified compensation is recorded as completed', (t) => {
  const env = fixture(t);
  const input = plan({ sourceAttemptId: env.attemptId });
  // A completion claim without the observed target fact is refused before any row is written.
  assert.throws(() => env.store.recordCompensation(env.task.taskId, { status: 'completed', plan: input },
    { expectedVersion: env.store.getRun(env.task.taskId).version }), { code: 'invalid_compensation' });
  assert.equal(env.store.listCompensations(env.task.taskId).length, 0);
  const done = env.store.recordCompensation(env.task.taskId,
    { status: 'completed', plan: input, verifiedByTarget: true, evidenceRef: 'file:/w/out.json#sha256:' + A },
    { expectedVersion: env.store.getRun(env.task.taskId).version });
  assert.equal(done.compensation.status, 'completed');
  assert.equal(done.run.status, 'waiting_analysis', 'Compensation does not silently complete the goal.');
  assert.notEqual(done.run.status, 'completed');
});

test('a failed compensation on a running task stops it instead of reporting a finished rollback', (t) => {
  const env = fixture(t, { keepRunning: true, maxCompensations: 3 });
  assert.equal(env.store.getRun(env.task.taskId).status, 'running');
  const input = plan({ sourceAttemptId: env.attemptId });
  for (const status of ['unverified', 'diverged', 'unsupported']) {
    const result = env.store.recordCompensation(env.task.taskId,
      { status, plan: { ...input, compensationId: `restore:${status}` }, evidenceRef: 'file:x#sha256:' + A },
      { expectedVersion: env.store.getRun(env.task.taskId).version });
    assert.equal(result.compensation.status, status);
    assert.notEqual(result.run.status, 'completed', 'A failed rollback must never look finished.');
    assert.ok(['compensation_unresolved', 'compensation_unsupported'].includes(result.run.reason));
    if (status === 'unverified') assert.equal(result.run.status, 'waiting_human');
  }
  assert.equal(env.store.listCompensations(env.task.taskId).length, 3);
});

test('compensation cannot target an unsettled or foreign attempt', (t) => {
  const env = fixture(t);
  assert.throws(() => env.store.recordCompensation(env.task.taskId,
    { status: 'completed', plan: plan({ sourceAttemptId: 'absent' }), verifiedByTarget: true },
    { expectedVersion: env.store.getRun(env.task.taskId).version }), { code: 'invalid_compensation' });
  const other = new RuntimeStore(':memory:');
  t.after(() => other.close());
  other.createRun({ ...env.task, taskId: 'foreign' });
  assert.throws(() => other.store ?? other.recordCompensation('foreign',
    { status: 'completed', plan: plan({ sourceAttemptId: env.attemptId }), verifiedByTarget: true },
    { expectedVersion: other.getRun('foreign').version }), { code: 'invalid_compensation' });
});

test('the compensation reserve bounds recovery attempts instead of letting them retry forever', (t) => {
  const env = fixture(t, { keepRunning: true, maxCompensations: 1 });
  const input = plan({ sourceAttemptId: env.attemptId });
  const first = env.store.recordCompensation(env.task.taskId,
    { status: 'unverified', plan: input, evidenceRef: 'file:x#sha256:' + A },
    { expectedVersion: env.store.getRun(env.task.taskId).version });
  assert.equal(first.compensation.status, 'unverified');
  // A second attempt would buy another try with no new authority, so it is refused and persisted as such.
  assert.throws(() => env.store.recordCompensation(env.task.taskId,
    { status: 'unverified', plan: { ...input, compensationId: 'restore:second' }, evidenceRef: 'file:x#sha256:' + A },
    { expectedVersion: env.store.getRun(env.task.taskId).version }), { code: 'recovery_exhausted' });
  const run = env.store.getRun(env.task.taskId);
  assert.equal(run.reason, 'recovery_exhausted');
  assert.equal(run.status, 'waiting_human', 'An exhausted reserve hands the run to a human.');
  assert.equal(env.store.listCompensations(env.task.taskId).length, 1, 'The refused attempt wrote no compensation row.');
  const events = env.store.readEvents(env.task.taskId);
  assert.deepEqual(events.filter((event) => event.kind === 'recovery_charged').map((event) => event.payload.kind),
    ['compensation']);
  assert.equal(events.some((event) => event.kind === 'recovery_exhausted'), true);
});

test('recovery charging stays inside its own reserve and does not spend business budget', (t) => {
  const env = fixture(t, { keepRunning: true });
  const keys = ['attempts', 'toolCalls', 'ioOperations', 'decisionRequests', 'analysisCalls'];
  const business = (run) => Object.fromEntries(keys.map((key) => [key, run.budgetUsage[key]]));
  const before = business(env.store.getRun(env.task.taskId));
  env.store.recordCompensation(env.task.taskId,
    { status: 'completed', plan: plan({ sourceAttemptId: env.attemptId }), verifiedByTarget: true,
      evidenceRef: 'file:/w/out.json#sha256:' + A },
    { expectedVersion: env.store.getRun(env.task.taskId).version });
  const after = env.store.getRun(env.task.taskId);
  assert.deepEqual(business(after), before, 'A recovery action must not consume business attempts, tools or I/O.');
  // Recovery usage is reported on its own so neither side can hide the other.
  assert.equal(after.budgetUsage.recovery.reads, 0);
  assert.equal(after.budgetUsage.recovery.compensations, 1);
});

test('the JSON template builds a restore plan from observed versions, not from a model claim', () => {
  const attempt = { attemptId: 'attempt-1', status: 'settled',
    verification: { status: 'fail', progress: 'unchanged', goalSatisfied: false, verifierId: 'json-source-output',
      verifierVersion: '1', evidenceRefs: ['file:/w/out.json#sha256:' + B] } };
  const task = { taskId: 'task-1', recipeId: 'json-normalize', recipeVersion: '1', goal: 'g',
    scopeRef: 's', workspaceRoot: process.cwd(), inputs: { inputFile: 'i.json', outputFile: 'out.json' },
    deadlineAt: Date.now() + 60_000 };
  const built = buildJsonCompensation({ task, sourceAttempt: attempt, observedSha256: B, priorSha256: A,
    priorContent: 'old', targetPath: '/w/out.json' });
  assert.equal(built.expectedBeforeSha256, B);
  assert.equal(built.expectedAfterSha256, A);
  assert.equal(built.targetArguments.expectedSha256, B);
  assert.equal(built.sourceAttemptId, 'attempt-1');
  assert.throws(() => buildJsonCompensation({ task, sourceAttempt: attempt, observedSha256: 'bad',
    priorSha256: A, priorContent: 'old', targetPath: '/w/out.json' }), { code: 'invalid_compensation' });
});
