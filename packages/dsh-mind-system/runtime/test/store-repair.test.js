import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';

const candidate = { candidateId: 'retry', toolName: 'fixture', arguments: { a: 1, b: { c: 2 } },
  preconditionIds: ['ready'], postconditionIds: ['done'], progressKey: 'cursor', effect: 'read',
  source: { recipeId: 'fixture', version: '1' } };
const verification = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'fixture', verifierVersion: '1', evidenceRefs: ['proof:verified'] };
const action = (kind = 'retry_with', extra = {}) => ({ kind,
  diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] }, requiresHumanReview: false,
  ...(kind === 'retry_with' ? { candidate } : kind === 'gather_evidence' ? { probeIds: ['inspect'] }
    : kind === 'abort' ? { reason: 'No safe repair.' } : { checkpointId: 'one', compensationPlanId: null }), ...extra });

function fixture(t, budget = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-repair-')));
  const filename = join(root, 'runtime.sqlite');
  const resources = [];
  let now = 1000;
  t.after(() => {
    for (const resource of resources.toReversed()) resource.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-repair-'));
    rmSync(root, { recursive: true, force: true });
  });
  const f = { root, filename, setNow(value) { now = value; }, open() {
    const store = new RuntimeStore(filename, { now: () => now });
    resources.push(store);
    return store;
  }, db() { const db = new DatabaseSync(filename); resources.push(db); return db; } };
  f.store = f.open();
  f.task = { taskId: 'task', recipeId: 'fixture', recipeVersion: '1', goal: 'Verify repair persistence.',
    scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: 5000,
    budget: { maxAnalysisCalls: 10, ...budget } };
  f.store.createRun(f.task);
  f.options = () => ({ expectedVersion: f.store.getRun('task').version });
  f.propose = (repair = action()) => {
    if (f.store.getRun('task').status === 'running') f.store.stopRun('task', 'waiting_analysis', 'exception', f.options());
    const { analysisId } = f.store.reserveAnalysis('task', f.options());
    f.store.recordAnalysis('task', analysisId, { status: 'proposed', repair }, f.options());
    return analysisId;
  };
  f.start = (analysisId, signature = 'stable:fixture') => f.store.startRepair('task', analysisId, { ...f.options(), signature });
  f.execute = (input = candidate, proof = verification, outcome = { status: 'succeeded' }) => {
    const { attemptId } = f.store.reserveAttempt('task', input, f.options());
    f.store.markStarted('task', attemptId, f.options());
    f.store.recordOutcome('task', attemptId, outcome, proof, f.options());
    return attemptId;
  };
  return f;
}

function unchanged(f, operation, code) {
  const before = { run: f.store.getRun('task'), events: f.store.readEvents('task'),
    analyses: f.db().prepare('SELECT * FROM analyses').all(), repairs: f.db().prepare('SELECT * FROM repairs').all(),
    failures: f.db().prepare('SELECT * FROM repair_failures').all() };
  assert.throws(operation, code ? { code } : undefined);
  assert.deepEqual({ run: f.store.getRun('task'), events: f.store.readEvents('task'),
    analyses: f.db().prepare('SELECT * FROM analyses').all(), repairs: f.db().prepare('SELECT * FROM repairs').all(),
    failures: f.db().prepare('SELECT * FROM repair_failures').all() }, before);
}

test('start consumes once, preserves immutable analysis, uses running, and never resets budgets', (t) => {
  const f = fixture(t);
  f.store.reserveBudget('task', 'ioOperations', 2, f.options());
  const analysisId = f.propose();
  const before = f.store.getAnalysis('task', analysisId);
  const budget = f.store.getRun('task').budgetUsage;
  const version = f.options().expectedVersion;
  const started = f.start(analysisId);
  assert.equal(started.repair.id, started.repairId);
  assert.equal(started.repair.kind, 'retry_with');
  assert.equal(started.run.status, 'running');
  assert.deepEqual(started.run.budgetUsage, budget);
  assert.deepEqual(f.store.getAnalysis('task', analysisId), { ...before, consumedAt: 1000 });
  assert.equal(f.store.getRepair('task', started.repairId).status, 'reserved');
  unchanged(f, () => f.store.startRepair('task', analysisId, { expectedVersion: version, signature: 'stable:fixture' }), 'stale_run');
  unchanged(f, () => f.start(analysisId), 'invalid_repair_state');
  assert.throws(() => f.db().exec("UPDATE analyses SET result_json = '{}'"), /immutable/);
  assert.deepEqual(f.store.readEvents('task').at(-1).payload,
    { repairId: started.repairId, analysisId, signature: 'stable:fixture', kind: 'retry_with' });
  assert.equal(f.open().getAnalysis('task', analysisId).consumedAt, 1000);
});

test('two persistent same-signature failed repairs stop loops and allow a new unconsumed analysis', (t) => {
  const f = fixture(t);
  for (let index = 1; index <= 2; index++) {
    const analysisId = f.propose();
    const { repairId } = f.start(analysisId);
    const attemptId = f.execute(candidate, { ...verification, status: 'fail', progress: 'unchanged' }, { status: 'failed' });
    const budget = f.store.getRun('task').budgetUsage;
    const run = f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId });
    assert.equal(f.open().getRepairFailures('task', 'stable:fixture'), index);
    assert.deepEqual(run.budgetUsage, budget);
    assert.equal(run.status, index === 2 ? 'waiting_human' : 'waiting_analysis');
    if (index === 2) assert.equal(run.reason, 'repair_limit');
  }
  // A forced owner transition must not bypass the persisted signature limit.
  f.db().exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
  const analysisId = f.propose();
  unchanged(f, () => f.start(analysisId), 'repair_limit');
  assert.equal(f.store.getAnalysis('task', analysisId).consumedAt, null);
});

test('success is derived from stored verification and finish does not advance business state', (t) => {
  const f = fixture(t);
  const { repairId } = f.start(f.propose());
  const attemptId = f.execute(candidate, { ...verification, progress: 'unchanged' });
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId, succeeded: true }), 'invalid_repair_outcome');
  const before = f.store.getRun('task');
  const run = f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId });
  assert.equal(run.status, 'waiting_analysis');
  assert.equal(run.reason, 'repair_no_progress');
  assert.deepEqual(run.state, before.state);
  assert.equal(f.store.getRepair('task', repairId).outcome.succeeded, false);
  assert.equal(f.store.getRepairFailures('task', 'stable:fixture'), 1);
});

test('passing advanced or completed attempts prove success without trusting the supplied boolean', (t) => {
  for (const goalSatisfied of [false, true]) {
    const f = fixture(t);
    const { repairId } = f.start(f.propose());
    const reordered = { ...candidate, arguments: { b: { c: 2 }, a: 1 } };
    const attemptId = f.execute(reordered, { ...verification, goalSatisfied });
    unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId, succeeded: false }), 'invalid_repair_outcome');
    const run = f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId, succeeded: true });
    assert.equal(run.status, goalSatisfied ? 'completed' : 'running');
    assert.equal(f.store.getRepairFailures('task', 'stable:fixture'), 0);
    assert.equal(f.store.getRepair('task', repairId).outcome.succeeded, true);
    unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId }), 'invalid_repair_state');
  }
});

test('intent attribution rejects absent, foreign, old and mismatched attempts with no mutations', (t) => {
  const f = fixture(t);
  const oldAttempt = f.execute();
  f.store.createRun({ ...f.task, taskId: 'foreign' });
  const foreignAttempt = f.store.reserveAttempt('foreign', candidate, { expectedVersion: 0 }).attemptId;
  const { repairId } = f.start(f.propose());
  for (const attemptId of [undefined, 'missing', oldAttempt, foreignAttempt]) {
    unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId }), 'invalid_repair_attempt');
  }
  const attemptId = f.execute({ ...candidate, arguments: { a: 99 } });
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId }), 'invalid_repair_attempt');
});

test('unknown business effects stay reconciling and do not increment or reset signature failures', (t) => {
  const f = fixture(t);
  const blocked = f.start(f.propose());
  f.store.finishRepair('task', blocked.repairId, { ...f.options(), status: 'blocked', reason: 'Admission denied.' });
  f.db().exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
  const { repairId } = f.start(f.propose());
  const attemptId = f.execute(candidate, { ...verification, status: 'unknown', progress: 'unknown', goalSatisfied: null },
    { status: 'outcome_unknown' });
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'unknown', attemptId, succeeded: false }), 'invalid_repair_outcome');
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'settled', attemptId }), 'invalid_repair_outcome');
  const run = f.store.finishRepair('task', repairId, { ...f.options(), status: 'unknown', attemptId });
  assert.equal(run.status, 'reconciling');
  assert.equal(f.store.listUnresolved('task').length, 1);
  assert.equal(f.store.getRepairFailures('task', 'stable:fixture'), 1);
  assert.equal(f.open().getRepair('task', repairId).status, 'unknown');
});

test('blocked repair requires no attempt, counts failures, and never completes the task', (t) => {
  const f = fixture(t);
  const { repairId } = f.start(f.propose());
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', succeeded: true }), 'invalid_repair_outcome');
  const run = f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', reason: 'Admission rejected.' });
  assert.equal(run.status, 'failed');
  assert.equal(f.store.getRepairFailures('task', 'stable:fixture'), 1);
  f.db().exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
  const next = f.start(f.propose());
  const attempt = f.store.reserveAttempt('task', candidate, f.options());
  unchanged(f, () => f.store.finishRepair('task', next.repairId, { ...f.options(), status: 'blocked' }), 'invalid_repair_outcome');
  unchanged(f, () => f.store.finishRepair('task', next.repairId, { ...f.options(), status: 'unknown', attemptId: attempt.attemptId }), 'invalid_repair_outcome');
});

test('human review, rollback, invalid signatures, expired budgets and unresolved work reject before consumption', (t) => {
  for (const kind of ['retry_with', 'gather_evidence', 'rollback_to']) {
    const f = fixture(t);
    const analysisId = f.propose(action(kind, kind === 'retry_with' ? { requiresHumanReview: true } : {}));
    if (kind === 'retry_with') {
      unchanged(f, () => f.start(analysisId), 'invalid_repair_state');
      f.db().exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
      unchanged(f, () => f.start(analysisId), 'repair_requires_review');
    } else if (kind === 'rollback_to') {
      // A rollback is now a persistable repair: admitted here, planned by the scheduler against recorded
      // checkpoints. What must still hold is that starting it consumes the proposal exactly once.
      const started = f.start(analysisId);
      assert.equal(started.repair.kind, 'rollback_to');
      assert.notEqual(f.store.getAnalysis('task', analysisId).consumedAt, null);
    } else {
      for (const signature of [undefined, null, '', ' ', 'x'.repeat(1025)]) unchanged(f,
        () => f.store.startRepair('task', analysisId, { ...f.options(), signature }), 'invalid_contract');
      f.setNow(5000);
      unchanged(f, () => f.start(analysisId), 'budget_exceeded');
      assert.equal(f.store.getAnalysis('task', analysisId).consumedAt, null);
    }
  }
  for (const budget of [{ maxAttempts: 0 }, { maxToolCalls: 0 }]) {
    const f = fixture(t, budget);
    const analysisId = f.propose();
    unchanged(f, () => f.start(analysisId), 'budget_exceeded');
  }
  const f = fixture(t);
  const analysisId = f.propose();
  f.db().exec("UPDATE runs SET status = 'running' WHERE task_id = 'task'");
  f.store.reserveAttempt('task', candidate, f.options());
  f.db().exec("UPDATE runs SET status = 'waiting_analysis', reason = 'repair_proposed' WHERE task_id = 'task'");
  unchanged(f, () => f.start(analysisId), 'attempt_unresolved');
});

test('abort settles immediately with no business effects or budget charges; evidence gathering resumes running', (t) => {
  for (const kind of ['abort', 'gather_evidence']) {
    const f = fixture(t);
    const analysisId = f.propose(action(kind));
    const before = f.store.getRun('task');
    const { repairId, run } = f.start(analysisId);
    assert.equal(run.status, kind === 'abort' ? 'cancelled' : 'running');
    assert.equal(f.store.getRepair('task', repairId).status, kind === 'abort' ? 'settled' : 'reserved');
    assert.equal(f.store.getRepair('task', repairId).candidate, null);
    assert.deepEqual(run.budgetUsage, before.budgetUsage);
    assert.deepEqual(run.state, before.state);
    assert.equal(f.store.getLatestAttempt('task'), null);
    assert.equal(f.store.readEvents('task').at(-1).kind, kind === 'abort' ? 'repair_aborted' : 'repair_started');
  }
});

test('foreign repair, stale finish versions and invalid flags cannot mutate storage', (t) => {
  const f = fixture(t);
  const { repairId } = f.start(f.propose());
  f.store.createRun({ ...f.task, taskId: 'foreign' });
  assert.throws(() => f.store.finishRepair('foreign', repairId, { expectedVersion: 0, status: 'blocked' }), { code: 'invalid_repair_state' });
  assert.equal(f.store.getRepair('foreign', repairId), null);
  for (const status of ['reserved', 'pass', undefined]) unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status }), 'invalid_repair_outcome');
  for (const succeeded of [1, 'true', null]) unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', succeeded }), 'invalid_repair_outcome');
  unchanged(f, () => f.store.finishRepair('task', repairId, { expectedVersion: 0, status: 'blocked' }), 'stale_run');
});

test('transaction failures roll back consumption, run changes and signature failure increments', (t) => {
  const f = fixture(t);
  const analysisId = f.propose();
  const db = f.db();
  db.exec("CREATE TRIGGER fail_repair_start BEFORE INSERT ON events WHEN NEW.kind = 'repair_started' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  unchanged(f, () => f.start(analysisId));
  db.exec('DROP TRIGGER fail_repair_start');
  const { repairId } = f.start(analysisId);
  db.exec("CREATE TRIGGER fail_repair_finish BEFORE INSERT ON events WHEN NEW.kind = 'repair_finished' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  unchanged(f, () => f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked' }));
});

test('repair DDL migration fires only when the stored CHECK really differs', (t) => {
  const f = fixture(t);
  // A current-shape database must not be rebuilt on reopen: a rebuild drops table-bound triggers,
  // so keeping a probe trigger is an observable proof that no rewrite happened.
  const db = f.db();
  db.exec(`CREATE TRIGGER no_repair_rebuild AFTER INSERT ON repairs BEGIN SELECT RAISE(IGNORE); END`);
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repairs'").get().sql;
  const runBefore = f.store.getRun('task').status;
  const reopened = f.open();
  const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repairs'").get().sql;
  assert.equal(after, before, 'Reopening a current database must not rewrite the repairs table.');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='no_repair_rebuild'").get(),
    'A spurious rebuild would destroy the probe trigger.');
  // An idempotent migration must change nothing observable about the run.
  assert.equal(reopened.getRun('task').status, runBefore);
});

test('an older narrower repairs CHECK is widened on reopen and keeps its rows', (t) => {
  const f = fixture(t);
  const db = f.db();
  // Use a real analysis id: the migration copies rows with foreign_keys ON, so a fabricated key would
  // fail for the wrong reason and look like a migration bug.
  const analysisId = f.propose();
  // Recreate the pre-observation table exactly as an older release would have had it.
  db.exec(`ALTER TABLE repairs RENAME TO repairs_ancient;
    CREATE TABLE repairs (
      repair_id TEXT PRIMARY KEY NOT NULL,
      analysis_id TEXT NOT NULL UNIQUE REFERENCES analyses(analysis_id),
      task_id TEXT NOT NULL REFERENCES runs(task_id), signature TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('retry_with', 'gather_evidence', 'abort')),
      status TEXT NOT NULL CHECK(status IN ('reserved', 'settled', 'blocked', 'unknown')),
      candidate_json TEXT, attempt_id TEXT UNIQUE REFERENCES attempts(attempt_id),
      attempt_floor INTEGER NOT NULL, outcome_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO repairs (repair_id, analysis_id, task_id, signature, kind, status, attempt_floor, created_at, updated_at)
      VALUES ('legacy-1', '${analysisId}', 'task', 'sig-legacy', 'abort', 'settled', 0, 1, 1);
    DROP TABLE repairs_ancient`);
  // Precondition: this table genuinely rejects the newer value, otherwise the widening proves nothing.
  assert.throws(() => db.prepare(`INSERT INTO repairs (repair_id, analysis_id, task_id, signature, kind, status,
    attempt_floor, created_at, updated_at) VALUES ('probe', '${analysisId}', 'task', 's', 'abort', 'observed', 0, 1, 1)`).run(),
  /CHECK/i);

  const migrated = f.open();
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repairs'").get().sql;
  assert.match(sql, /'observed'/, 'The widened CHECK must accept the newer status value.');
  assert.equal(migrated.getRepair('task', 'legacy-1').kind, 'abort', 'Existing rows survive the rebuild.');
});

test('a rollback cannot restore a checkpoint that was never recorded for this task', (t) => {
  const f = fixture(t);
  // A freshly created run is running, so the refusal has to come from the missing checkpoint itself.
  assert.throws(() => f.store.restoreCheckpoint('task', 'never-recorded', f.options()), { code: 'invalid_checkpoint' });
  // And a checkpoint of another task must not be addressable through this one.
  f.store.createRun({ ...f.task, taskId: 'other' });
  assert.throws(() => f.store.restoreCheckpoint('task', 'other', { expectedVersion: f.store.getRun('task').version }),
    { code: 'invalid_checkpoint' });
});

test('legacy analyses migration adds consumption and atomically replaces the partial index on reopen', (t) => {
  const f = fixture(t);
  const db = f.db();
  db.exec(`DROP TRIGGER analyses_result_immutable;
    DROP INDEX analyses_one_unresolved;
    ALTER TABLE analyses DROP COLUMN consumed_at;
    CREATE UNIQUE INDEX analyses_one_unresolved ON analyses(task_id) WHERE status IN ('pending', 'proposed')`);
  const peer = f.open();
  assert.equal(db.prepare('PRAGMA table_info(analyses)').all().filter((column) => column.name === 'consumed_at').length, 1);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'analyses_one_unresolved'").get().sql, /consumed_at IS NULL/);
  const analysisId = f.propose();
  f.start(analysisId);
  assert.equal(peer.getAnalysis('task', analysisId).consumedAt, 1000);
  f.open();
});
