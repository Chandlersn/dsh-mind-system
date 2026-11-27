import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { createExecuteTool } from '../src/dynamic-tools.js';
import { createRecipeRegistry } from '../src/recipe-factory.js';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { validateTask } from '../src/contracts.js';

const malformed = [
  { origin: null }, { origin: undefined }, { origin: 'unknown' }, { origin: 'DAILY' },
  { origin: '' }, { origin: ' daily ' }, { origin: [] }, { origin: 1 },
  { principleRefs: null }, { principleRefs: undefined }, { principleRefs: 'one' },
  { principleRefs: {} }, { principleRefs: [null] }, { principleRefs: [1] },
  { principleRefs: [''] }, { principleRefs: [' \t\n'] }, { principleRefs: new Array(1) },
  { principleRefs: ['x'.repeat(257)] }, { principleRefs: Array(33).fill('ref') },
];
const candidate = { candidateId: 'retry', toolName: 'fixture', arguments: {},
  preconditionIds: ['ready'], postconditionIds: ['done'], progressKey: 'cursor', effect: 'read',
  source: { recipeId: 'fixture', version: '1' } };
const proof = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'target-check', verifierVersion: '1', evidenceRefs: ['proof:one'] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-provenance-')));
  const filename = join(root, 'runtime.sqlite');
  let store = new RuntimeStore(filename);
  t.after(() => {
    store.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('task-provenance-'));
    rmSync(root, { recursive: true, force: true });
  });
  const task = (extra = {}) => ({ taskId: 'task', recipeId: 'fixture', recipeVersion: '1',
    goal: 'Observe declared provenance', scopeRef: 'fixture', workspaceRoot: root,
    inputs: {}, deadlineAt: Date.now() + 60_000, ...extra });
  const options = () => ({ expectedVersion: store.getRun('task').version });
  return { root, task, options, get store() { return store; },
    reopen() { store.close(); store = new RuntimeStore(filename); },
    finish(extra = {}, settled = true) {
      store.stopRun('task', 'waiting_analysis', 'exception', options());
      const { analysisId } = store.reserveAnalysis('task', options());
      store.recordAnalysis('task', analysisId, { status: 'proposed', repair: {
        kind: settled ? 'retry_with' : 'gather_evidence',
        diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] },
        requiresHumanReview: false, ...(settled ? { candidate } : { probeIds: ['inspect'] }),
      } }, options());
      const { repairId } = store.startRepair('task', analysisId, { ...options(), signature: 'fixture' });
      let attemptId;
      if (settled) {
        ({ attemptId } = store.reserveAttempt('task', candidate, options()));
        store.markStarted('task', attemptId, options());
        store.recordOutcome('task', attemptId, { status: 'succeeded' }, proof, options());
      }
      store.finishRepair('task', repairId, { ...options(), status: settled ? 'settled' : 'observed',
        ...(settled ? { attemptId } : {}), ...extra });
      return store.readEvents('task').at(-1);
    },
  };
}

function dynamic(f, realScheduler = false) {
  const registry = createRecipeRegistry();
  const agent = {};
  let schedulerCalls = 0;
  let dispatches = 0;
  const library = realScheduler ? f.store.withDatabase((db) => createRecipeLibrary({ db })) : null;
  const tool = createExecuteTool({ store: f.store, registry, library, toolEffects: { fixture: 'read' },
    mount: { scopeRef: 'fixture', workspaceRoot: f.root, allowedTools: ['fixture'] },
    schedulerFor() {
      schedulerCalls++;
      if (!realScheduler) return { run: async (task) => f.store.createRun(task) };
      return new RuntimeScheduler({ store: f.store, recipes: registry.list().map((key) => registry.get(key)),
        executor: { agent, async execute() { dispatches++; throw new Error('Unexpected dispatch'); } },
        tools: {}, validateArguments: () => [] });
    },
  });
  const args = { taskId: 'task', goal: 'Observe declared provenance', inputs: {},
    recipe: { recipeId: 'fixture', tool: 'fixture', effect: 'read', arguments: {},
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['x'] } } } };
  return { tool, args, registry, execute: (extra = {}) => tool.execute({ ...args, ...extra }, { agent }),
    get schedulerCalls() { return schedulerCalls; }, get dispatches() { return dispatches; } };
}

test('malformed metadata is rejected by contracts and store before persistence', (t) => {
  const f = fixture(t);
  for (const metadata of malformed) {
    assert.throws(() => validateTask(f.task(metadata)), { code: 'invalid_task_provenance' });
    assert.throws(() => f.store.createRun(f.task(metadata)), { code: 'invalid_task_provenance' });
    assert.deepEqual(f.store.snapshotRuns().runs, []);
  }
});

test('dynamic entry rejects malformed metadata before registry, scheduler, or library work', async (t) => {
  const f = fixture(t);
  const d = dynamic(f);
  for (const metadata of malformed) {
    await assert.rejects(d.execute(metadata), { code: 'invalid_task_provenance' });
    assert.deepEqual(d.registry.list(), []);
    assert.equal(d.schedulerCalls, 0);
    assert.deepEqual(f.store.snapshotRuns().runs, []);
  }
});

test('omission, explicit empty refs, declared refs and limits survive dynamic entry and reopen', async (t) => {
  for (const metadata of [{}, { origin: 'daily' }, { origin: 'verification', principleRefs: [] },
    { origin: 'drill', principleRefs: [' ref:one ', 'ref:one'] },
    { principleRefs: Array(32).fill('x'.repeat(256)) }]) {
    const f = fixture(t);
    const d = dynamic(f);
    await d.execute(metadata);
    const stored = f.store.getRun('task').task;
    for (const key of ['origin', 'principleRefs']) {
      assert.equal(Object.hasOwn(stored, key), Object.hasOwn(metadata, key));
      assert.deepEqual(stored[key], metadata[key]);
    }
    if (metadata.principleRefs) metadata.principleRefs.push('later-caller-mutation');
    f.reopen();
    assert.deepEqual(f.store.getRun('task').task, stored);
    assert.deepEqual(f.store.readEvents('task')[0].payload.task, stored);
  }
});

test('reopened pause/resume preserves declarations and ignores replacement metadata', (t) => {
  for (const metadata of [{}, { origin: 'verification', principleRefs: [] },
    { origin: 'drill', principleRefs: ['principle:original'] }]) {
    const f = fixture(t);
    const original = f.store.createRun(f.task(metadata)).task;
    f.store.pauseRun('task', f.options());
    f.reopen();
    const environment = { recipeId: 'fixture', recipeVersion: '1', scopeRef: 'fixture',
      workspaceRoot: f.root, allowedTools: [], origin: 'daily', principleRefs: ['replacement'] };
    f.store.resumeRun('task', { ...f.options(), environment, origin: 'daily', principleRefs: ['replacement'] });
    assert.deepEqual(f.store.getRun('task').task, original);
    assert.throws(() => f.store.createRun({ ...original, origin: 'daily', principleRefs: ['replacement'] }),
      /UNIQUE constraint failed/);
    assert.deepEqual(f.store.getRun('task').task, original);
  }
});

test('actual scheduler refuses dynamic task reuse before dispatch or provenance replacement', async (t) => {
  for (const metadata of [{}, { origin: 'verification', principleRefs: [] }]) {
    const f = fixture(t);
    const original = f.store.createRun(f.task(metadata)).task;
    f.store.pauseRun('task', f.options());
    f.reopen();
    const before = f.store.getRun('task');
    const events = f.store.readEvents('task');
    const d = dynamic(f, true);
    for (const changed of [{ origin: 'daily', principleRefs: ['replacement'] }, { principleRefs: [] }, {}]) {
      await assert.rejects(d.execute(changed), /UNIQUE constraint failed/);
      assert.deepEqual(f.store.getRun('task'), before);
      assert.deepEqual(f.store.readEvents('task'), events);
      assert.deepEqual(f.store.getRun('task').task, original);
      assert.equal(d.dispatches, 0);
    }
  }
});

test('repair evidence uses reopened task declarations, never finishRepair arguments', async (t) => {
  for (const metadata of [{}, { origin: 'daily' }, { origin: 'verification', principleRefs: [] },
    { origin: 'drill', principleRefs: ['principle:one'] }, { principleRefs: [] }]) {
    for (const settled of [true, false]) {
      const f = fixture(t);
      await dynamic(f).execute(metadata);
      f.reopen();
      const event = f.finish({ origin: 'daily', principleRefs: ['forged'], originStatus: 'verified',
        principleRefsStatus: 'verified', governanceEligible: true }, settled);
      const { evidence } = event.payload;
      assert.equal(evidence.governanceEligible, false);
      assert.equal(evidence.attestation, 'producer');
      assert.equal(evidence.reviewStatus, 'unreviewed');
      assert.equal(evidence.provenance.origin, metadata.origin ?? 'unknown');
      assert.equal(evidence.provenance.originStatus, metadata.origin ? 'declared' : undefined);
      assert.deepEqual(evidence.provenance.principleRefs, metadata.principleRefs ?? null);
      assert.equal(evidence.provenance.principleRefsStatus,
        Object.hasOwn(metadata, 'principleRefs') ? 'declared' : 'unavailable');
      const pending = f.store.listPendingOutbox();
      assert.deepEqual(pending[0].payload.evidence, evidence);
      f.reopen();
      assert.deepEqual(f.store.readEvents('task').at(-1), event);
      assert.deepEqual(f.store.listPendingOutbox(), pending);
    }
  }
});

test('task identifiers never imply daily or verification provenance', (t) => {
  const f = fixture(t);
  for (const taskId of ['daily:one', 'verification:one', 'drill:one']) {
    const stored = f.store.createRun(f.task({ taskId })).task;
    assert.equal(Object.hasOwn(stored, 'origin'), false);
    assert.equal(Object.hasOwn(stored, 'principleRefs'), false);
  }
});
