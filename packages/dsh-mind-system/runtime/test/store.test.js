import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';
import { jsonSnapshot, validateBudget, validateVerification } from '../src/contracts.js';

const cleanupByRoot = new Map();

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-store-'));
  cleanupByRoot.set(root, []);
  t.after(() => {
    for (const close of cleanupByRoot.get(root).toReversed()) close();
    cleanupByRoot.delete(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-store-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function task(root, options = {}) {
  return { taskId: 'run-1', recipeId: 'fixture', recipeVersion: '1', goal: 'Verify a fixture output.',
    scopeRef: 'test-scope', workspaceRoot: root, inputs: {}, deadlineAt: Date.now() + 60_000,
    ...options };
}

const candidate = {
  candidateId: 'write', toolName: 'fixture_write', arguments: { content: 'expected' },
  preconditionIds: ['scope'], postconditionIds: ['file-content'], progressKey: 'output',
  effect: 'reversible_write', source: { recipeId: 'fixture', version: '1' },
};
const verified = { status: 'pass', progress: 'advanced', goalSatisfied: true,
  verifierId: 'external-file', verifierVersion: '1', evidenceRefs: ['fixture:observed-file'] };
const unknown = { status: 'unknown', progress: 'unknown', goalSatisfied: null,
  verifierId: 'external-file', verifierVersion: '1', evidenceRefs: [] };

function openStore(t, root, options) {
  const store = new RuntimeStore(join(root, 'runtime.sqlite'), options);
  cleanupByRoot.get(root).push(() => store.close());
  return store;
}

test('intent, budget reservation, outcome and evidence persist across reopening', (t) => {
  const root = sandbox(t);
  const filename = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(filename);
  store.createRun(task(root));
  const reserved = store.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  assert.equal(reserved.run.usage.toolCalls, 1);
  assert.deepEqual(store.readEvents('run-1').map((event) => event.kind), ['run_created', 'attempt_reserved']);
  const started = store.markStarted('run-1', reserved.attemptId, { expectedVersion: reserved.run.version });
  const completed = store.recordOutcome('run-1', reserved.attemptId, { status: 'succeeded', output: 'expected' }, verified,
    { expectedVersion: started.version });
  assert.equal(completed.status, 'completed');
  store.close();
  const reopened = openStore(t, root);
  assert.equal(reopened.getRun('run-1').status, 'completed');
  assert.deepEqual(reopened.getRun('run-1').usage, { attempts: 1, toolCalls: 1 });
  assert.equal(reopened.readEvents('run-1').at(-1).payload.verification.evidenceRefs[0], 'fixture:observed-file');
});

test('a stale writer and exhausted reservation do not create partial events', (t) => {
  const root = sandbox(t);
  const store = openStore(t, root);
  store.createRun(task(root, { budget: { maxAttempts: 1, maxToolCalls: 1 } }));
  const reserved = store.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  assert.throws(() => store.reserveAttempt('run-1', candidate, { expectedVersion: 0 }), { code: 'stale_run' });
  const started = store.markStarted('run-1', reserved.attemptId, { expectedVersion: reserved.run.version });
  const next = store.recordOutcome('run-1', reserved.attemptId, { status: 'succeeded' },
    { ...verified, goalSatisfied: false }, { expectedVersion: started.version });
  const before = store.readEvents('run-1');
  assert.throws(() => store.reserveAttempt('run-1', candidate, { expectedVersion: next.version }), { code: 'budget_exceeded' });
  assert.deepEqual(store.readEvents('run-1'), before);
  assert.deepEqual(store.getRun('run-1').usage, { attempts: 1, toolCalls: 1 });
});

test('invalid attempt identities cannot commit an unreachable unresolved attempt', (t) => {
  const root = sandbox(t);
  const store = openStore(t, root);
  store.createRun(task(root));
  const before = store.readEvents('run-1');
  for (const attemptId of [null, '', '   ', 3]) {
    assert.throws(() => store.reserveAttempt('run-1', candidate, { expectedVersion: 0, attemptId }), { code: 'invalid_contract' });
  }
  assert.equal(store.listUnresolved('run-1').length, 0);
  assert.deepEqual(store.readEvents('run-1'), before);
  assert.deepEqual(store.getRun('run-1').usage, { attempts: 0, toolCalls: 0 });
});

test('a competing database connection cannot reserve against an obsolete version', (t) => {
  const root = sandbox(t);
  const first = openStore(t, root);
  const second = openStore(t, root);
  first.createRun(task(root));
  first.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  assert.throws(() => second.reserveAttempt('run-1', candidate, { expectedVersion: 0 }), { code: 'stale_run' });
  assert.equal(second.readEvents('run-1').filter((event) => event.kind === 'attempt_reserved').length, 1);
});

test('success without independent evidence and false completion are rejected', (t) => {
  const root = sandbox(t);
  const store = openStore(t, root);
  store.createRun(task(root));
  const reservation = store.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  const started = store.markStarted('run-1', reservation.attemptId, { expectedVersion: reservation.run.version });
  assert.throws(() => store.recordOutcome('run-1', reservation.attemptId, { status: 'succeeded' },
    { ...verified, evidenceRefs: [] }, { expectedVersion: started.version }), { code: 'invalid_verification' });
  assert.throws(() => validateVerification({ ...verified, status: 'fail' }), { code: 'invalid_verification' });
  assert.equal(store.getRun('run-1').status, 'running');
  const result = store.recordOutcome('run-1', reservation.attemptId, { status: 'succeeded' },
    { ...verified, status: 'fail', progress: 'unchanged', goalSatisfied: false }, { expectedVersion: started.version });
  assert.equal(result.status, 'waiting_analysis');
});

test('live acknowledgement uncertainty freezes dispatch even with remaining budget', (t) => {
  const root = sandbox(t);
  const store = openStore(t, root);
  store.createRun(task(root));
  const reservation = store.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  const started = store.markStarted('run-1', reservation.attemptId, { expectedVersion: reservation.run.version });
  const frozen = store.recordOutcome('run-1', reservation.attemptId, { status: 'outcome_unknown', reason: 'ack_lost' }, unknown,
    { expectedVersion: started.version });
  assert.equal(frozen.status, 'reconciling');
  assert.equal(store.listUnresolved('run-1').length, 1);
  assert.throws(() => store.reserveAttempt('run-1', candidate, { expectedVersion: frozen.version }), { code: 'run_not_running' });
});

test('a process exits after a side effect; restart exposes uncertainty instead of replay', (t) => {
  const root = sandbox(t);
  const filename = join(root, 'runtime.sqlite');
  const effectPath = join(root, 'effect.txt');
  const moduleUrl = new URL('../src/store.js', import.meta.url).href;
  const program = `
    import { RuntimeStore } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync } from 'node:fs';
    const store = new RuntimeStore(${JSON.stringify(filename)});
    store.createRun(${JSON.stringify(task(root))});
    const reservation = store.reserveAttempt('run-1', ${JSON.stringify(candidate)}, {expectedVersion: 0});
    store.markStarted('run-1', reservation.attemptId, {expectedVersion: reservation.run.version});
    writeFileSync(${JSON.stringify(effectPath)}, 'one external write', {flag:'wx'});
    process.exit(42);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore', timeout: 10_000 });
  assert.equal(child.status, 42, 'The child must exit at the injected crash point.');
  assert.equal(readFileSync(effectPath, 'utf8'), 'one external write');
  const store = openStore(t, root);
  const before = store.getRun('run-1');
  const recovered = store.recoverRun('run-1', { expectedVersion: before.version });
  assert.equal(recovered.status, 'reconciling');
  assert.deepEqual(recovered.usage, { attempts: 1, toolCalls: 1 });
  assert.equal(store.listUnresolved('run-1')[0].status, 'unknown');
  assert.throws(() => store.reserveAttempt('run-1', candidate, { expectedVersion: recovered.version }), { code: 'run_not_running' });
  assert.equal(readFileSync(effectPath, 'utf8'), 'one external write');
});

test('transaction failure rolls back the run row and immutable event rows cannot be rewritten', (t) => {
  const root = sandbox(t);
  const store = openStore(t, root);
  store.createRun(task(root));
  const external = new DatabaseSync(join(root, 'runtime.sqlite'));
  cleanupByRoot.get(root).push(() => external.close());
  assert.throws(() => external.exec("UPDATE events SET kind = 'fake_success'"), /immutable/);
  assert.throws(() => external.exec('DELETE FROM events'), /immutable/);
  external.exec("CREATE TRIGGER reject_new_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;");
  assert.throws(() => store.createRun(task(root, { taskId: 'must-rollback' })), /injected disk write failure/);
  assert.equal(external.prepare('SELECT count(*) AS n FROM runs WHERE task_id = ?').get('must-rollback').n, 0);
});

test('expired dispatch and lossy JSON are rejected explicitly', (t) => {
  const root = sandbox(t);
  let now = 1000;
  const store = openStore(t, root, { now: () => now });
  store.createRun(task(root, { deadlineAt: 2000 }));
  const reservation = store.reserveAttempt('run-1', candidate, { expectedVersion: 0 });
  now = 2000;
  assert.throws(() => store.markStarted('run-1', reservation.attemptId, { expectedVersion: reservation.run.version }), { code: 'dispatch_not_allowed' });
  assert.throws(() => jsonSnapshot({ lost: undefined }), { code: 'invalid_json' });
  assert.throws(() => jsonSnapshot({ value: NaN }), { code: 'invalid_json' });
  assert.throws(() => validateBudget({ maxToolCalls: -1 }), { code: 'invalid_budget' });
  for (const invalid of [null, 3, [], 'limits']) {
    assert.throws(() => validateBudget(invalid), { code: 'invalid_budget' });
  }
});
