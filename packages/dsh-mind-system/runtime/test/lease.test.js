import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from '../src/store.js';

const task = (overrides = {}) => ({ taskId: randomUUID(), recipeId: 'lease-fixture', recipeVersion: '1',
  goal: 'Exercise single-writer semantics.', scopeRef: 'lease-scope', workspaceRoot: process.cwd(),
  inputs: {}, deadlineAt: Date.now() + 60_000, ...overrides });

const candidate = (overrides = {}) => ({ candidateId: 'probe', toolName: 'fixture.read', progressKey: 'read',
  arguments: { path: 'x' }, preconditionIds: ['ready'], postconditionIds: ['read'],
  effect: 'read', source: { recipeId: 'lease-fixture', version: '1' }, ...overrides });

const verification = { status: 'pass', progress: 'advanced', goalSatisfied: true, verifierId: 'fixture',
  verifierVersion: '1', evidenceRefs: ['file:x#sha256:y'] };

const environmentOf = (task) => ({ recipeId: task.recipeId, recipeVersion: task.recipeVersion,
  scopeRef: task.scopeRef, workspaceRoot: task.workspaceRoot, allowedTools: [] });

function fixture(t, options = {}) {
  const store = new RuntimeStore(':memory:', options);
  t.after(() => store.close());
  const input = task();
  store.createRun(input);
  return { store, task: input };
}

test('a newer owner supersedes an older fence so the old worker cannot write', (t) => {
  const { store, task: input } = fixture(t);
  const first = store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a', ttlMs: 1000 });
  assert.equal(first.fence, 1);
  const second = store.acquireLease(input.taskId, { expectedVersion: first.run.version, ownerId: 'worker-b', ttlMs: 1000 });
  assert.equal(second.fence, 2);
  // The superseded owner still holds stale state and tries to dispatch.
  assert.throws(() => store.reserveAttempt(input.taskId, candidate(),
    { expectedVersion: second.run.version, fence: first.fence }), { code: 'stale_owner' });
  assert.throws(() => store.markStarted(input.taskId, 'attempt', { expectedVersion: second.run.version, fence: first.fence }),
    { code: 'stale_owner' });
  // The current owner proceeds normally.
  const reserved = store.reserveAttempt(input.taskId, candidate(),
    { expectedVersion: store.getRun(input.taskId).version, fence: second.fence });
  assert.equal(reserved.attemptId.length > 0, true);
});

test('a stale owner cannot record an outcome or release the lease', (t) => {
  const { store, task: input } = fixture(t);
  store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  store.acquireLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version, ownerId: 'worker-b' });
  const current = store.getRun(input.taskId);
  const reserved = store.reserveAttempt(input.taskId, candidate(), { expectedVersion: current.version });
  store.markStarted(input.taskId, reserved.attemptId, { expectedVersion: store.getRun(input.taskId).version });
  assert.throws(() => store.recordOutcome(input.taskId, reserved.attemptId, { status: 'succeeded' }, verification,
    { expectedVersion: store.getRun(input.taskId).version, fence: 1 }), { code: 'stale_owner' });
  assert.throws(() => store.releaseLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version,
    ownerId: 'worker-a', fence: 1 }), { code: 'stale_owner' });
  const settled = store.recordOutcome(input.taskId, reserved.attemptId, { status: 'succeeded' }, verification,
    { expectedVersion: store.getRun(input.taskId).version, fence: current.fence });
  assert.equal(settled.status, 'completed');
});

test('the same owner cannot double-acquire an unexpired lease but may re-acquire after expiry', (t) => {
  let now = 1_000;
  const { store, task: input } = fixture(t, { now: () => now });
  store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a', ttlMs: 100 });
  assert.throws(() => store.acquireLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version,
    ownerId: 'worker-a', ttlMs: 100 }), { code: 'lease_conflict' });
  now = 2_000;
  const renewed = store.acquireLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version,
    ownerId: 'worker-a', ttlMs: 100 });
  assert.equal(renewed.fence, 2);
  assert.equal(renewed.run.owner.ownerId, 'worker-a');
});

test('a lease requires a bounded TTL and a live running task', (t) => {
  const { store, task: input } = fixture(t);
  for (const ttlMs of [0, -1, 86_400_001, 1.5]) {
    assert.throws(() => store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'a', ttlMs }), { code: 'invalid_lease' });
  }
  assert.throws(() => store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: '' }), { code: 'invalid_contract' });
  store.stopRun(input.taskId, 'failed', 'fixture stop', { expectedVersion: 0 });
  assert.throws(() => store.acquireLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version, ownerId: 'a' }),
    { code: 'run_not_running' });
});

test('pause refuses outstanding work and stops new dispatch', (t) => {
  const { store, task: input } = fixture(t);
  store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const current = store.getRun(input.taskId);
  const reserved = store.reserveAttempt(input.taskId, candidate(), { expectedVersion: current.version });
  store.markStarted(input.taskId, reserved.attemptId, { expectedVersion: store.getRun(input.taskId).version });
  assert.throws(() => store.pauseRun(input.taskId, { expectedVersion: store.getRun(input.taskId).version, fence: current.fence }),
    { code: 'attempt_unresolved' });
  // Verified progress without goal completion keeps the run running, which is the pausable state.
  store.recordOutcome(input.taskId, reserved.attemptId, { status: 'succeeded' },
    { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'fixture', verifierVersion: '1',
      evidenceRefs: ['file:x#sha256:y'] }, { expectedVersion: store.getRun(input.taskId).version });
  assert.equal(store.getRun(input.taskId).status, 'running');
  const paused = store.pauseRun(input.taskId, { expectedVersion: store.getRun(input.taskId).version, fence: current.fence });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.owner, null);
  assert.throws(() => store.reserveAttempt(input.taskId, candidate(), { expectedVersion: paused.version }),
    { code: 'run_not_running' });
});

test('pause bumps the fence so the pausing worker cannot keep writing', (t) => {
  const { store, task: input } = fixture(t);
  const lease = store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const paused = store.pauseRun(input.taskId, { expectedVersion: lease.run.version, fence: lease.fence });
  assert.equal(paused.fence, lease.fence + 1);
  assert.throws(() => store.reserveAttempt(input.taskId, candidate(), { expectedVersion: paused.version, fence: lease.fence }),
    { code: 'stale_owner' });
});

test('resume requires a fresh fence and never double-writes on repeated resume', (t) => {
  const { store, task: input } = fixture(t);
  const lease = store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const paused = store.pauseRun(input.taskId, { expectedVersion: lease.run.version, fence: lease.fence });
  const resumed = store.resumeRun(input.taskId, { expectedVersion: paused.version, environment: environmentOf(input) });
  assert.equal(resumed.status, 'running');
  assert.ok(resumed.fence > paused.fence, 'Resume must advance the fence for a new owner.');
  // A second resume on a running task is refused, so a stale worker cannot re-open its own window.
  assert.throws(() => store.resumeRun(input.taskId, { expectedVersion: resumed.version, environment: environmentOf(input) }), { code: 'invalid_state' });
  const newLease = store.acquireLease(input.taskId, { expectedVersion: resumed.version, ownerId: 'worker-b' });
  assert.ok(newLease.fence > resumed.fence);
  assert.throws(() => store.reserveAttempt(input.taskId, candidate(), { expectedVersion: newLease.run.version, fence: lease.fence }),
    { code: 'stale_owner' });
});

test('resume after the deadline is refused instead of running stale work', (t) => {
  let now = 1_000;
  const { store, task: input } = fixture(t, { now: () => now });
  const lease = store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const paused = store.pauseRun(input.taskId, { expectedVersion: lease.run.version, fence: lease.fence });
  now = input.deadlineAt;
  assert.throws(() => store.resumeRun(input.taskId, { expectedVersion: paused.version, environment: environmentOf(input) }), { code: 'budget_exceeded' });
  assert.equal(store.getRun(input.taskId).status, 'paused');
});

test('recovery after pause still freezes unknown work and blocks blind resume', (t) => {
  const { store, task: input } = fixture(t);
  store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const first = store.getRun(input.taskId);
  const reserved = store.reserveAttempt(input.taskId, candidate(), { expectedVersion: first.version });
  store.markStarted(input.taskId, reserved.attemptId, { expectedVersion: store.getRun(input.taskId).version });
  assert.equal(store.listUnresolved(input.taskId).length, 1);
  // Pause is refused while work is outstanding; recovery only freezes, it never resumes.
  assert.throws(() => store.pauseRun(input.taskId, { expectedVersion: store.getRun(input.taskId).version, fence: first.fence }),
    { code: 'attempt_unresolved' });
  const recovered = store.recoverRun(input.taskId, { expectedVersion: store.getRun(input.taskId).version });
  assert.equal(recovered.status, 'reconciling');
  assert.throws(() => store.resumeRun(input.taskId, { expectedVersion: recovered.version }), { code: 'invalid_state' });
  assert.throws(() => store.acquireLease(input.taskId, { expectedVersion: recovered.version, ownerId: 'worker-b' }),
    { code: 'run_not_running' });
});

test('a superseded scheduler cannot settle its own in-flight attempt', async (t) => {
  const { createHost, installed } = await import('./helpers/host.js');
  const { RuntimeScheduler } = await import('../src/scheduler.js');
  const { HostExecutor } = await import('../src/executor.js');
  const { writeFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { jsonNormalizeRecipe } = await import('../recipes/json-normalize.js');
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  let executor;
  t.after(async () => { await executor?.dispose(); });
  const host = await createHost(t);
  const agent = await host.agent('fence-caller');
  const store = new RuntimeStore(join(host.root, 'fence.sqlite'));
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  let hijacked = false;
  host.tools.register({ name: 'runtime.write_json', description: 'Create the fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) {
      writeFileSync(path, content, { flag: 'wx' });
      if (!hijacked) {
        hijacked = true;
        // Another worker takes over while this action is in flight.
        store.acquireLease(input.taskId, { expectedVersion: store.getRun(input.taskId).version, ownerId: 'worker-b' });
      }
      return { created: true };
    } });
  const input = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Create sorted normalized records.', scopeRef: 'fence-scope', workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) {
      assertObjectJsonSchema(tool.parameters);
      return validateJsonSchemaValue(tool.parameters, args);
    } });
  const authority = { scopeRef: input.scopeRef, workspaceRoot: host.storage, allowedTools: ['runtime.write_json'], agent };
  await assert.rejects(async () => scheduler.run(input, { authority }), (failure) => {
    assert.equal(failure.code, 'stale_owner', 'The superseded worker must not settle the attempt.');
    return true;
  });
  assert.equal(store.getRun(input.taskId).fence, 2);
  assert.equal(store.listUnresolved(input.taskId).length, 1, 'The hijacked attempt stays unresolved for the new owner.');
  // Close SQLite explicitly before the host fixture tears down its temporary root.
  await executor.dispose();
  store.close();
});

test('resume refuses a changed template or authority instead of resuming blind', (t) => {
  const { store, task: input } = fixture(t);
  const base = environmentOf(input);
  const lease = store.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  const paused = store.pauseRun(input.taskId, { expectedVersion: lease.run.version, fence: lease.fence, environment: base });
  for (const changed of [
    { ...base, recipeVersion: '2' },
    { ...base, scopeRef: 'other-scope' },
    { ...base, workspaceRoot: '/elsewhere' },
    { ...base, allowedTools: ['extra.tool'] },
  ]) {
    assert.throws(() => store.resumeRun(input.taskId, { expectedVersion: paused.version, environment: changed }),
      { code: 'resume_environment_changed' });
  }
  assert.throws(() => store.resumeRun(input.taskId, { expectedVersion: paused.version }),
    { code: 'resume_environment_required' });
  assert.equal(store.getRun(input.taskId).status, 'paused');
  const resumed = store.resumeRun(input.taskId, { expectedVersion: paused.version, environment: base });
  assert.equal(resumed.status, 'running');
  assert.ok(resumed.fence > paused.fence);
});
test('fence and owner survive a reopen so a restarted worker cannot bypass them', (t) => {
  // Keep databases out of the repository so a failed assertion cannot pollute the working tree.
  const dir = mkdtempSync(join(tmpdir(), 'runtime-lease-reopen-'));
  const filename = join(dir, 'state.sqlite');
  const input = task();
  const first = new RuntimeStore(filename);
  first.createRun(input);
  const lease = first.acquireLease(input.taskId, { expectedVersion: 0, ownerId: 'worker-a' });
  first.close();
  const reopened = new RuntimeStore(filename);
  // Close every handle before deleting the directory; hooks run in reverse order of registration.
  t.after(() => {
    try { reopened.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const run = reopened.getRun(input.taskId);
  assert.equal(run.fence, lease.fence);
  assert.equal(run.owner.ownerId, 'worker-a');
  const newer = reopened.acquireLease(input.taskId, { expectedVersion: run.version, ownerId: 'worker-b' });
  assert.ok(newer.fence > lease.fence);
});
