import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { readLatestPatrolReport } from '../src/patrol.js';

const run = (taskId, status, count = 0, attemptStatus = 'unknown') => ({
  taskId, status, reason: null, createdAt: 100, updatedAt: 200, registered: true,
  unresolved: { count, first: count ? { attemptId: `attempt-${taskId}`, status: attemptStatus } : null },
});
const ready = (runs = []) => ({ state: 'ready', limit: 100, truncated: false, runs,
  registeredTasks: { taskIds: runs.map((item) => item.taskId), truncated: false } });

async function startup(serviceFactory) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-coverage-'));
  const storageDir = join(root, 'storage');
  const memoryRoot = join(root, 'memory');
  let dispose;
  try {
    await mkdir(storageDir);
    await mkdir(memoryRoot);
    const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), provide() {}, set() {},
      get(name) { assert.equal(name, 'executionRuntimeStatus'); return serviceFactory(); },
      on(event, fn) { if (event === 'dispose') dispose = fn; }, tools: { register: () => () => {} } };
    apply(ctx, { storageDir, patrol: { enabled: true, principles: [], memoryRoot,
      pendingAxiomCandidates: () => null } }, { loadDefineTool: () => (schema) => schema });
    let report;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      report = await readLatestPatrolReport(storageDir, 'weekly');
      if (report?.cycle_coverage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(report?.error, 'no_input');
    assert.equal(report.cycle_coverage.micro_execution.outcome.status, 'unknown');
    assert.equal(report.cycle_coverage.cross_step_correlation.status, 'unknown');
    return report.cycle_coverage.micro_execution.runtime_snapshot;
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
}

test('automatic weekly report records bounded statuses and unresolved attempts', async () => {
  const input = ready([run('one', 'running', 1, 'reserved'), run('two', 'reconciling', 2, 'started'),
    run('three', 'completed'), run('four', 'failed', 1, 'unknown')]);
  let calls = 0;
  const result = await startup(() => ({ snapshot(options) { calls++; assert.deepEqual(options, { limit: 100 }); return input; } }));
  assert.equal(calls, 1);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.runs, input.runs);
  assert.deepEqual(result.unresolvedCandidates.map(({ taskId, status, unresolved }) =>
    [taskId, status, unresolved.first.status]), [['one', 'running', 'reserved'], ['two', 'reconciling', 'started'], ['four', 'failed', 'unknown']]);
});

test('automatic weekly report distinguishes missing, disabled, unavailable and thrown services', async () => {
  for (const [factory, state, reason] of [
    [() => undefined, 'missing'],
    [() => ({ snapshot: () => ({ state: 'disabled' }) }), 'disabled'],
    [() => ({ snapshot: () => ({ state: 'unavailable' }) }), 'unavailable'],
    [() => ({ snapshot: () => ({ state: 'error', error: 'snapshot_failed' }) }), 'error'],
    [() => ({ snapshot: () => { throw new Error('boom'); } }), 'error', 'snapshot_threw'],
    [() => { throw new Error('get failed'); }, 'error', 'snapshot_threw'],
    [() => ({}), 'partial', 'snapshot_method_missing'],
  ]) {
    const result = await startup(factory);
    assert.equal(result.state, state);
    if (reason) assert.equal(result.reason, reason);
  }
});

test('automatic weekly report marks truncated and malformed snapshots partial', async () => {
  const truncated = ready([run('visible', 'running', 1, 'unknown')]);
  truncated.truncated = true;
  truncated.registeredTasks.truncated = true;
  const observed = await startup(() => ({ snapshot: () => truncated }));
  assert.equal(observed.state, 'partial');
  assert.equal(observed.truncated, true);
  assert.equal(observed.registeredTasks.truncated, true);
  assert.equal(observed.unresolvedCandidates[0].taskId, 'visible');
  const malformed = ready([run('valid', 'running'), { taskId: 'broken' }]);
  const partial = await startup(() => ({ snapshot: () => malformed }));
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.runs.map((item) => item.taskId), ['valid']);
  const oversized = ready(Array.from({ length: 101 }, (_, index) => run(`task-${index}`, 'waiting_human')));
  const bounded = await startup(() => ({ snapshot: () => oversized }));
  assert.equal(bounded.state, 'partial');
  assert.equal(bounded.runs.length, 100);
  assert.equal(bounded.registeredTasks.taskIds.length, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.registeredTasks.truncated, true);
});
