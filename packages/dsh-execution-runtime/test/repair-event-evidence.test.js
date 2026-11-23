import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';

const candidate = { candidateId: 'retry', toolName: 'fixture', arguments: {},
  preconditionIds: ['ready'], postconditionIds: ['done'], progressKey: 'cursor', effect: 'read',
  source: { recipeId: 'fixture', version: 'recipe-v2' } };
const proof = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'target-check', verifierVersion: 'verifier-v3', evidenceRefs: ['proof:one', 'proof:two'] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-evidence-')));
  const filename = join(root, 'runtime.sqlite');
  let store = new RuntimeStore(filename, { now: () => 1000 });
  t.after(() => {
    store.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('repair-evidence-'));
    rmSync(root, { recursive: true, force: true });
  });
  const options = (taskId = 'task') => ({ expectedVersion: store.getRun(taskId).version });
  const create = (taskId = 'task') => store.createRun({ taskId, recipeId: 'fixture', recipeVersion: 'recipe-v2',
    goal: 'Verify repair evidence', scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: 5000 });
  create();
  return {
    get store() { return store; }, options, create,
    reopen() { store.close(); store = new RuntimeStore(filename, { now: () => 1000 }); return store; },
    start(kind = 'retry_with', taskId = 'task', extra = {}) {
      store.stopRun(taskId, 'waiting_analysis', 'exception', options(taskId));
      const { analysisId } = store.reserveAnalysis(taskId, options(taskId));
      const repair = { kind, diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] },
        requiresHumanReview: false, ...(kind === 'retry_with' ? { candidate }
          : kind === 'gather_evidence' ? { probeIds: ['inspect'] } : { checkpointId: extra.checkpointId, compensationPlanId: null }) };
      store.recordAnalysis(taskId, analysisId, { status: 'proposed', repair }, options(taskId));
      return { ...store.startRepair(taskId, analysisId, { ...options(taskId), signature: 'fixture' }), analysisId };
    },
    execute(verification = proof, outcome = { status: 'succeeded' }, taskId = 'task') {
      const { attemptId } = store.reserveAttempt(taskId, candidate, options(taskId));
      store.markStarted(taskId, attemptId, options(taskId));
      store.recordOutcome(taskId, attemptId, outcome, verification, options(taskId));
      return attemptId;
    },
    finish(repairId, status, attemptId, extra = {}) {
      store.finishRepair('task', repairId, { ...options(), status, ...(attemptId ? { attemptId } : {}), ...extra });
      return store.readEvents('task').at(-1);
    },
  };
}

function assertRefused(f, repairId, attemptId, code) {
  const before = { run: f.store.getRun('task'), repair: f.store.getRepair('task', repairId),
    events: f.store.readEvents('task'), outbox: f.store.listPendingOutbox() };
  assert.throws(() => f.finish(repairId, 'settled', attemptId), code ? { code } : undefined);
  assert.deepEqual({ run: f.store.getRun('task'), repair: f.store.getRepair('task', repairId),
    events: f.store.readEvents('task'), outbox: f.store.listPendingOutbox() }, before);
}

test('repair API persists the exact producer evidence envelope across reopen and outbox retry', (t) => {
  const f = fixture(t);
  const { repairId, analysisId } = f.start();
  const attemptId = f.execute({ ...proof, details: 'large-verifier-trace'.repeat(10000) },
    { status: 'succeeded', output: 'large-tool-trace'.repeat(10000) });
  const event = f.finish(repairId, 'settled', attemptId, { succeeded: true });
  assert.deepEqual(event.payload, { repairId, status: 'settled', succeeded: true, evidence: {
    schemaVersion: 1, status: 'verified_success', attestation: 'producer', reviewStatus: 'unreviewed', governanceEligible: false,
    taskId: 'task', repairId, analysisId, attemptId, settlementStatus: 'settled', attemptStatus: 'settled',
    executionStatus: 'succeeded', verificationStatus: 'pass', verifier: { id: 'target-check', version: 'verifier-v3' },
    progress: 'advanced', goalSatisfied: false, evidenceRefs: ['proof:one', 'proof:two'],
    provenance: { source: { recipeId: 'fixture', version: 'recipe-v2' }, recipe: { id: 'fixture', version: 'recipe-v2' },
      tool: { name: 'fixture', version: null }, toolVersionStatus: 'unavailable', origin: 'unknown',
      principleRefs: null, principleRefsStatus: 'unavailable' },
  } });
  assert.ok(JSON.stringify(event.payload).length < 2000, 'Raw traces must not be copied into the envelope.');
  const [pending] = f.store.listPendingOutbox();
  assert.deepEqual(pending.payload, { ...event.payload, taskId: 'task', attemptId });
  assert.equal(pending.eventId, event.eventId);
  assert.deepEqual(f.reopen().readEvents('task').at(-1), event);
  assert.deepEqual(f.store.listPendingOutbox(), [pending]);
  f.store.retryOutbox(pending.eventId, { expectedAttempts: 0 });
  assert.deepEqual(f.reopen().listPendingOutbox(), [{ ...pending, attempts: 1 }]);
  assertRefused(f, repairId, attemptId, 'invalid_repair_state');
  f.store.acknowledgeOutbox(pending.eventId, { expectedAttempts: 1 });
  assert.deepEqual(f.reopen().listPendingOutbox(), []);
});

test('stored failure, unchanged pass, advanced pass and goal completion remain distinct', (t) => {
  for (const [execution, verification, progress, goalSatisfied, expected] of [
    ['failed', 'fail', 'unchanged', false, 'verified_failure'],
    ['succeeded', 'fail', 'unchanged', false, 'verified_failure'],
    ['succeeded', 'pass', 'unchanged', false, 'no_progress'],
    ['succeeded', 'pass', 'advanced', false, 'verified_success'],
    ['succeeded', 'pass', 'unchanged', true, 'verified_success'],
  ]) {
    const f = fixture(t);
    const { repairId } = f.start();
    const attemptId = f.execute({ ...proof, status: verification, progress, goalSatisfied }, { status: execution });
    const { evidence, succeeded } = f.finish(repairId, 'settled', attemptId).payload;
    assert.equal(evidence.status, expected);
    assert.equal(succeeded, expected === 'verified_success');
    assert.equal(evidence.executionStatus, execution);
    assert.equal(evidence.verificationStatus, verification);
    assert.equal(evidence.governanceEligible, false);
  }
});

test('restored legacy success and blocked or observed repairs never attest verified success', (t) => {
  for (const status of ['restored', 'blocked', 'observed']) {
    const f = fixture(t);
    let checkpointId;
    if (status === 'restored') {
      ({ checkpointId } = f.store.recordCheckpoint('task', { stepIndex: 0, state: {}, environment: {}, evidenceRef: 'checkpoint:proof' }, f.options()));
    }
    const { repairId } = f.start(status === 'restored' ? 'rollback_to' : 'gather_evidence', 'task', { checkpointId });
    if (status === 'restored') f.store.restoreCheckpoint('task', checkpointId, f.options());
    const { evidence, ...legacy } = f.finish(repairId, status).payload;
    assert.deepEqual(legacy, { repairId, status, ...(status === 'observed' ? {} : { succeeded: status === 'restored' }) });
    assert.equal(evidence.status, status);
    assert.equal(evidence.attemptId, null);
    assert.equal(evidence.verifier, null);
    assert.equal(evidence.executionStatus, 'unavailable');
    assert.equal(evidence.verificationStatus, 'unavailable');
    assert.deepEqual(evidence.evidenceRefs, []);
    assert.equal(evidence.provenance.source, null);
    assert.equal(evidence.provenance.tool, null);
    assert.equal(evidence.governanceEligible, false);
  }
});

test('unknown outcomes preserve stored unknown statuses and evidence without success claims', (t) => {
  const f = fixture(t);
  const { repairId } = f.start();
  const attemptId = f.execute({ ...proof, status: 'unknown', progress: 'unknown', goalSatisfied: null }, { status: 'outcome_unknown' });
  const event = f.finish(repairId, 'unknown', attemptId);
  assert.equal(Object.hasOwn(event.payload, 'succeeded'), false);
  assert.equal(event.payload.evidence.status, 'unknown');
  assert.equal(event.payload.evidence.attemptStatus, 'unknown');
  assert.equal(event.payload.evidence.executionStatus, 'outcome_unknown');
  assert.equal(event.payload.evidence.verificationStatus, 'unknown');
  assert.deepEqual(event.payload.evidence.evidenceRefs, proof.evidenceRefs);
  assert.equal(f.reopen().listPendingOutbox()[0].payload.evidence.status, 'unknown');
});

test('recovered unfinished attempts explicitly lack verification provenance', (t) => {
  const f = fixture(t);
  const { repairId } = f.start();
  const { attemptId } = f.store.reserveAttempt('task', candidate, f.options());
  f.store.recoverRun('task', f.options());
  const { evidence } = f.finish(repairId, 'unknown', attemptId).payload;
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.executionStatus, 'unavailable');
  assert.equal(evidence.verificationStatus, 'unavailable');
  assert.equal(evidence.verifier, null);
  assert.equal(evidence.goalSatisfied, null);
  assert.deepEqual(evidence.evidenceRefs, []);
  assert.equal(evidence.provenance.origin, 'unknown');
  assert.equal(evidence.provenance.principleRefsStatus, 'unavailable');
});

test('missing, old, foreign and mismatched attempt associations refuse without creating an envelope', (t) => {
  const f = fixture(t);
  const oldAttemptId = f.execute();
  f.create('other');
  const foreignAttemptId = f.execute(proof, { status: 'succeeded' }, 'other');
  const { repairId } = f.start();
  for (const id of [undefined, 'missing', oldAttemptId, foreignAttemptId]) assertRefused(f, repairId, id, 'invalid_repair_attempt');
  const attemptId = f.execute();
  f.store.withDatabase((db) => db.prepare('UPDATE attempts SET candidate_json = ? WHERE attempt_id = ?')
    .run(JSON.stringify({ ...candidate, arguments: { different: true } }), attemptId));
  assertRefused(f, repairId, attemptId, 'invalid_repair_attempt');
});

test('corrupt stored verification and duplicate or foreign analysis associations refuse atomically', (t) => {
  for (const corruption of ['verification', 'contradictory', 'unknown', 'analysis', 'duplicate', 'recipe']) {
    const f = fixture(t);
    const { repairId } = f.start();
    const attemptId = f.execute();
    if (corruption === 'analysis' || corruption === 'duplicate') {
      f.create('other');
      const other = f.start('retry_with', 'other');
      f.store.withDatabase((db) => {
        if (corruption === 'duplicate') {
          db.prepare('UPDATE repairs SET attempt_id = ? WHERE repair_id = ?').run(attemptId, other.repairId);
        } else {
          // Foreign keys alone do not enforce task identity for an existing analysis association.
          db.prepare("UPDATE analyses SET task_id = 'other' WHERE analysis_id = (SELECT analysis_id FROM repairs WHERE repair_id = ?)").run(repairId);
        }
      });
    } else {
      f.store.withDatabase((db) => {
        if (corruption === 'recipe') {
          const foreignRecipe = JSON.stringify({ ...candidate, source: { recipeId: 'other-recipe', version: 'other-version' } });
          db.prepare('UPDATE attempts SET candidate_json = ? WHERE attempt_id = ?').run(foreignRecipe, attemptId);
          db.prepare('UPDATE repairs SET candidate_json = ? WHERE repair_id = ?').run(foreignRecipe, repairId);
        } else if (corruption === 'contradictory') db.prepare('UPDATE attempts SET outcome_json = ? WHERE attempt_id = ?')
          .run(JSON.stringify({ status: 'failed' }), attemptId);
        else db.prepare('UPDATE attempts SET verification_json = ? WHERE attempt_id = ?')
          .run(JSON.stringify(corruption === 'verification' ? {} : { ...proof, status: 'unknown', goalSatisfied: null }), attemptId);
      });
    }
    assertRefused(f, repairId, attemptId);
  }
});
