import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

async function fixture(t, { postFailure = false, idempotencyKey } = {}) {
  let store; let executor;
  t.after(async () => { await executor?.dispose(); store?.close(); });
  const host = await createHost(t);
  const agent = await host.agent('recovery-caller');
  store = new RuntimeStore(join(host.root, 'recovery.sqlite'));
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime.write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) {
      host.ledger('business_write');
      writeFileSync(path, content, { flag: 'wx' });
      return { created: true };
    } });
  if (postFailure) host.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Post failure after the file exists.' }] }));
  const authority = { scopeRef: `recovery-${randomUUID()}`, workspaceRoot: host.storage, allowedTools: ['runtime.write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create normalized sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  return { host, store, executor, scheduler, task, authority, agent, idempotencyKey };
}

const recipe = (candidate) => ({ ...jsonNormalizeRecipe, allowedTools: ['runtime.write_json'],
  toolEffects: { 'runtime.write_json': 'reversible_write' },
  requiredPreconditionIds: ['workspace-scope'],
  candidates: () => [{ ...candidate, preconditionIds: ['workspace-scope'], postconditionIds: jsonNormalizeRecipe.postconditionIds,
    source: { recipeId: 'json-normalize', version: '1' } }],
  preconditions: { 'workspace-scope': async () => ({ verdict: 'allow' }) } });

test('a crash-like unknown effect stays frozen until explicit reconciliation', async (t) => {
  const env = await fixture(t, { postFailure: true });
  const run = await env.scheduler.run(env.task, { authority: env.authority });
  assert.equal(run.status, 'reconciling');
  const unresolved = env.store.listUnresolved(env.task.taskId);
  assert.equal(unresolved.length, 1);
  assert.equal(env.host.count('business_write'), 1);
  const recovered = env.store.recoverRun(env.task.taskId, { expectedVersion: run.version });
  assert.equal(recovered.status, 'reconciling');
  assert.equal(env.store.listUnresolved(env.task.taskId)[0].status, 'unknown');
  const next = env.scheduler.reconcile(env.task.taskId, { authority: env.authority,
    resolutions: [{ attemptId: unresolved[0].attemptId, resolution: 'applied', evidenceRef: 'file:output.json#sha256:fixture' }] });
  assert.equal(next.status, 'waiting_analysis');
  assert.equal(next.reason, 'reconciled_applied');
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 0);
  const attempt = env.store.getLatestAttempt(env.task.taskId);
  assert.equal(attempt.status, 'reconciled_applied');
  assert.equal(attempt.outcome.reconciled, true);
  assert.equal(attempt.verification.status, 'unknown', 'Reconciliation is not goal verification.');
  assert.equal(attempt.verification.goalSatisfied, null);
  assert.equal(env.host.count('business_write'), 1, 'Reconciliation must not replay the write.');
});

test('reconciliation cannot invent success, skip frozen attempts or replay work', async (t) => {
  const env = await fixture(t, { postFailure: true });
  await env.scheduler.run(env.task, { authority: env.authority });
  const { attemptId } = env.store.listUnresolved(env.task.taskId)[0];
  assert.throws(() => env.scheduler.reconcile(env.task.taskId, { authority: env.authority,
    resolutions: [{ attemptId, resolution: 'succeeded', evidenceRef: 'x' }] }), { code: 'invalid_reconciliation' });
  assert.throws(() => env.scheduler.reconcile(env.task.taskId, { authority: env.authority,
    resolutions: [{ attemptId, resolution: 'applied' }] }), { code: 'invalid_reconciliation' });
  assert.throws(() => env.scheduler.reconcile(env.task.taskId, { authority: env.authority,
    resolutions: [{ attemptId, resolution: 'applied', evidenceRef: 'x' }, { attemptId: 'foreign', resolution: 'absent', evidenceRef: 'y' }] }),
  { code: 'invalid_reconciliation' });
  const other = await env.host.agent('foreign-reconciler');
  assert.throws(() => env.scheduler.reconcile(env.task.taskId, { authority: { ...env.authority, agent: other },
    resolutions: [{ attemptId, resolution: 'absent', evidenceRef: 'x' }] }), { code: 'authority_agent_mismatch' });
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 1);
  assert.equal(env.host.count('business_write'), 1);
});

test('an unknown write stays claimed until reconciliation resolves it', async (t) => {
  const env = await fixture(t, { postFailure: true });
  const candidate = { candidateId: 'write-once', toolName: 'runtime.write_json', progressKey: 'created',
    arguments: { path: join(env.host.storage, 'output.json'), content: '[]', createOnly: true },
    preconditionIds: ['workspace-scope'], postconditionIds: jsonNormalizeRecipe.postconditionIds,
    effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' }, idempotencyKey: 'write-unique-1' };
  const scheduler = new RuntimeScheduler({ store: env.store, executor: env.executor, recipes: [recipe(candidate)],
    tools: env.host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const run = await scheduler.run(env.task, { authority: env.authority });
  assert.equal(run.status, 'reconciling');
  // The effect is unknown, so it is not yet claimed as applied; the frozen attempt already blocks new work.
  assert.equal(env.store.idempotencyClaimed(env.task.taskId, 'write-unique-1', 'runtime.write_json'), false);
  const { attemptId } = env.store.listUnresolved(env.task.taskId)[0];
  env.scheduler.reconcile(env.task.taskId, { authority: env.authority,
    resolutions: [{ attemptId, resolution: 'applied', evidenceRef: 'file:output.json#sha256:fixture' }] });
  // Once reconciled as applied, the key is permanently claimed even though the goal was never verified.
  assert.equal(env.store.idempotencyClaimed(env.task.taskId, 'write-unique-1', 'runtime.write_json'), true);
  assert.equal(env.store.getLatestAttempt(env.task.taskId).status, 'reconciled_applied');
  assert.equal(env.host.count('business_write'), 1, 'Reconciliation must not replay the effect.');
});

test('reserving a verified applied effect again is refused by the guard itself', async (t) => {
  const env = await fixture(t);
  const candidate = { candidateId: 'dup', toolName: 'runtime.write_json', progressKey: 'created',
    arguments: { path: join(env.host.storage, 'output.json'), content: '[]', createOnly: true },
    preconditionIds: ['workspace-scope'], postconditionIds: jsonNormalizeRecipe.postconditionIds,
    effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' }, idempotencyKey: 'write-dup' };
  env.store.createRun(env.task);
  const first = env.store.reserveAttempt(env.task.taskId, candidate, { expectedVersion: env.store.getRun(env.task.taskId).version });
  env.store.markStarted(env.task.taskId, first.attemptId, { expectedVersion: env.store.getRun(env.task.taskId).version });
  // Passing verification without goal completion keeps the run running, so the guard is reachable.
  env.store.recordOutcome(env.task.taskId, first.attemptId, { status: 'succeeded' },
    { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'fixture', verifierVersion: '1',
      evidenceRefs: ['file:output.json#sha256:fixture'] }, { expectedVersion: env.store.getRun(env.task.taskId).version });
  assert.equal(env.store.getRun(env.task.taskId).status, 'running');
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 0);
  assert.throws(() => env.store.reserveAttempt(env.task.taskId, candidate,
    { expectedVersion: env.store.getRun(env.task.taskId).version }), { code: 'idempotency_conflict' });
  assert.equal(env.host.count('business_write'), 0);
});
test('the same key on another tool is a different business effect', async (t) => {
  const env = await fixture(t);
  const candidate = { candidateId: 'write-once', toolName: 'runtime.write_json', progressKey: 'created',
    arguments: { path: join(env.host.storage, 'output.json'), content: '[]', createOnly: true },
    preconditionIds: ['workspace-scope'], postconditionIds: jsonNormalizeRecipe.postconditionIds,
    effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' }, idempotencyKey: 'write-shared' };
  const task = { ...env.task };
  env.store.createRun(task);
  const first = env.store.reserveAttempt(task.taskId, candidate, { expectedVersion: env.store.getRun(task.taskId).version });
  env.store.markStarted(task.taskId, first.attemptId, { expectedVersion: env.store.getRun(task.taskId).version });
  env.store.recordOutcome(task.taskId, first.attemptId, { status: 'succeeded' },
    { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'fixture', verifierVersion: '1',
      evidenceRefs: ['file:output.json#sha256:fixture'] }, { expectedVersion: env.store.getRun(task.taskId).version });
  assert.equal(env.store.idempotencyClaimed(task.taskId, 'write-shared', 'runtime.write_json'), true);
  assert.equal(env.store.idempotencyClaimed(task.taskId, 'write-shared', 'runtime.replace_json'), false);
});

test('a known-bad effect keeps the same key correctable', async (t) => {
  const env = await fixture(t);
  const candidate = { candidateId: 'write-once', toolName: 'runtime.write_json', progressKey: 'created',
    arguments: { path: join(env.host.storage, 'output.json'), content: '[]', createOnly: true },
    preconditionIds: ['workspace-scope'], postconditionIds: jsonNormalizeRecipe.postconditionIds,
    effect: 'reversible_write', source: { recipeId: 'json-normalize', version: '1' }, idempotencyKey: 'write-correctable' };
  const task = { ...env.task };
  env.store.createRun(task);
  const first = env.store.reserveAttempt(task.taskId, candidate, { expectedVersion: env.store.getRun(task.taskId).version });
  env.store.markStarted(task.taskId, first.attemptId, { expectedVersion: env.store.getRun(task.taskId).version });
  env.store.recordOutcome(task.taskId, first.attemptId, { status: 'succeeded' },
    { status: 'fail', progress: 'unchanged', goalSatisfied: false, verifierId: 'fixture', verifierVersion: '1',
      evidenceRefs: ['file:output.json#sha256:fixture'] }, { expectedVersion: env.store.getRun(task.taskId).version });
  // A verified failure is not an applied effect, so the same intent may still be repaired.
  assert.equal(env.store.idempotencyClaimed(task.taskId, 'write-correctable', 'runtime.write_json'), false);
});
test('ordinary runs without an idempotency key are unaffected', async (t) => {
  const env = await fixture(t);
  const run = await env.scheduler.run(env.task, { authority: env.authority });
  assert.equal(run.status, 'completed');
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 0);
  assert.equal(env.store.getLatestAttempt(env.task.taskId).verification.goalSatisfied, true);
  assert.equal(readFileSync(join(env.host.storage, 'output.json'), 'utf8').replace(/\s+/g, ''),
    '[{"id":"a","name":"Alpha"}]');
});
