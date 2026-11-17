import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';
import { validateBudget } from '../src/contracts.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-budget-')));
  const filename = join(root, 'state.sqlite');
  const resources = [];
  t.after(() => {
    for (const close of resources.toReversed()) close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-budget-'));
    rmSync(root, { recursive: true, force: true });
  });
  const task = { taskId: 'budget-run', recipeId: 'fixture', recipeVersion: '1', goal: 'Verify transaction facts.',
    scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: Date.now() + 60_000,
    budget: { maxIoOperations: 2, maxDecisionRequests: 1, maxAnalysisCalls: 0 } };
  return { root, filename, resources, task, open() {
    const store = new RuntimeStore(filename);
    resources.push(() => store.close());
    return store;
  } };
}

const candidate = { candidateId: 'one', toolName: 'fixture', arguments: {}, preconditionIds: ['ready'],
  postconditionIds: ['done'], progressKey: 'cursor', effect: 'read', source: { recipeId: 'fixture', version: '1' } };
const verification = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'fixture-file', verifierVersion: '1', evidenceRefs: ['fixture:external-fact'] };

test('decision and I/O reservations enforce their limits without refunding failed requests', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createRun(f.task);
  const reserve = (kind, amount) => store.reserveBudget(f.task.taskId, kind, amount,
    { expectedVersion: store.getRun(f.task.taskId).version });
  reserve('ioOperations', 2);
  reserve('decisionRequests', 1);
  for (const kind of ['ioOperations', 'decisionRequests', 'analysisCalls']) {
    assert.throws(() => reserve(kind, 1), { code: 'budget_exceeded' });
  }
  assert.equal(store.getRun(f.task.taskId).budgetUsage.ioOperations, 2);
  assert.equal(store.getRun(f.task.taskId).budgetUsage.decisionRequests, 1);
  assert.equal(store.readEvents(f.task.taskId).filter((event) => event.kind === 'budget_reserved').length, 2);
});

test('outcome and business cursor update are one transaction with rollback on event failure', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createRun(f.task);
  store.setState(f.task.taskId, { count: 0 }, { expectedVersion: 0 });
  const reservation = store.reserveAttempt(f.task.taskId, candidate, { expectedVersion: store.getRun(f.task.taskId).version });
  const started = store.markStarted(f.task.taskId, reservation.attemptId, { expectedVersion: reservation.run.version });
  const db = new DatabaseSync(f.filename);
  f.resources.push(() => db.close());
  db.exec("CREATE TRIGGER reject_outcome BEFORE INSERT ON events WHEN NEW.kind = 'outcome_recorded' BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END;");
  assert.throws(() => store.recordOutcome(f.task.taskId, reservation.attemptId, { status: 'succeeded' }, verification,
    { expectedVersion: started.version, nextState: { count: 1 } }), /injected outcome failure/);
  assert.equal(store.getRun(f.task.taskId).state.count, 0);
  assert.equal(store.getRun(f.task.taskId).version, started.version);
  assert.equal(store.listUnresolved(f.task.taskId)[0].status, 'started');
  db.exec('DROP TRIGGER reject_outcome');
  store.recordOutcome(f.task.taskId, reservation.attemptId, { status: 'succeeded' }, { ...verification, goalSatisfied: true },
    { expectedVersion: started.version, nextState: { count: 1 } });
  assert.equal(store.getRun(f.task.taskId).state.count, 1);
  assert.equal(store.getRun(f.task.taskId).status, 'completed');
  assert.equal(store.readEvents(f.task.taskId).at(-1).payload.nextState.count, 1);
});

test('persisted phase-zero task budgets receive bounded new dimensions during migration', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.filename);
  db.exec(`CREATE TABLE runs (task_id TEXT PRIMARY KEY, task_json TEXT NOT NULL, status TEXT NOT NULL,
    version INTEGER NOT NULL, attempts_used INTEGER NOT NULL DEFAULT 0, tool_calls_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const task = { ...f.task, budget: { maxAttempts: 5, maxToolCalls: 5 } };
  db.prepare('INSERT INTO runs(task_id,task_json,status,version,created_at,updated_at) VALUES (?,?,?,0,?,?)')
    .run(task.taskId, JSON.stringify(task), 'running', Date.now(), Date.now());
  db.close();
  const store = f.open();
  store.reserveBudget(task.taskId, 'ioOperations', 100, { expectedVersion: 0 });
  assert.throws(() => store.reserveBudget(task.taskId, 'ioOperations', 1, { expectedVersion: 1 }), { code: 'budget_exceeded' });
  assert.deepEqual(store.getRun(task.taskId).state, {});
  for (const bad of [{ constructor: 1 }, { toString: 1 }, { maxIoOperations: -1 }]) {
    assert.throws(() => validateBudget(bad), { code: 'invalid_budget' });
  }
});
