import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const runtimeRoot = existsSync(new URL('../../runtime/src/store.js', import.meta.url)) ? '../../runtime/' : '../../dsh-execution-runtime/';
const { createHost } = await import(`${runtimeRoot}test/helpers/host.js`);
const { RuntimeStore } = await import(`${runtimeRoot}src/store.js`);
const { plugin: runtimePlugin } = await import(`${runtimeRoot}src/host-plugin.js`);
import { apply as applyValves } from '../index.js';
import { readLatestPatrolReport } from '../src/patrol.js';

test('automatic patrol persists the real runtime task and unresolved attempt', async (t) => {
  const host = await createHost(t);
  const stateDir = join(host.root, 'runtime-state');
  const valveDir = join(host.root, 'valves');
  const memoryRoot = join(host.root, 'memory');
  await Promise.all([mkdir(stateDir), mkdir(valveDir), mkdir(memoryRoot)]);
  const task = { taskId: 'persisted-task', recipeId: 'csv-normalize', recipeVersion: '1',
    goal: 'Check a fixture.', scopeRef: 'test', workspaceRoot: host.storage,
    inputs: {}, deadlineAt: Date.now() + 60_000 };
  const candidate = { candidateId: 'write', toolName: 'fixture_write', arguments: {},
    preconditionIds: ['scope'], postconditionIds: ['output'], progressKey: 'output',
    effect: 'reversible_write', source: { recipeId: 'csv-normalize', version: '1' } };
  const seed = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
  try {
    seed.createRun(task);
    const reserved = seed.reserveAttempt(task.taskId, candidate,
      { expectedVersion: 0, attemptId: 'persisted-attempt' });
    seed.markStarted(task.taskId, 'persisted-attempt', { expectedVersion: reserved.run.version });
  } finally {
    seed.close();
  }

  const runtimeFiber = await host.ctx.plugin(runtimePlugin,
    { enabled: true, stateDir, workspaceRoot: host.storage, tasks: [task] });
  let valveFiber;
  try {
    await runtimeFiber.await();
    const status = host.ctx.get('executionRuntimeStatus');
    assert.equal(status.snapshot().state, 'ready');
    assert.equal(status.snapshot().runs[0].unresolved.first.attemptId, 'persisted-attempt');
    valveFiber = await host.ctx.plugin({ name: 'valves-integration', inject: ['tools'], apply: applyValves },
      { storageDir: valveDir, patrol: { enabled: true, principles: [], memoryRoot,
        pendingAxiomCandidates: () => null } });
    await valveFiber.await();
    let report;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      report = await readLatestPatrolReport(valveDir, 'weekly');
      if (report?.cycle_coverage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(report?.cycle_coverage, 'automatic weekly report was not persisted');
    const snapshot = report.cycle_coverage.micro_execution.runtime_snapshot;
    assert.equal(snapshot.state, 'ready');
    const run = snapshot.runs.find((item) => item.taskId === task.taskId);
    assert.ok(run, 'persisted task missing from report');
    assert.equal(run.unresolved.first.attemptId, 'persisted-attempt');
    assert.equal(run.unresolved.first.status, 'started');
    const unresolved = snapshot.unresolvedCandidates.find((item) => item.taskId === task.taskId);
    assert.equal(unresolved?.unresolved.first.attemptId, 'persisted-attempt');
  } finally {
    await valveFiber?.dispose();
    await runtimeFiber.dispose();
  }
});
