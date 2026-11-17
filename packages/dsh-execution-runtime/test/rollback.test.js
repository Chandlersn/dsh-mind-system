import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { createCheckpoint, planRollbackTo, settleRollback } from '../src/rollback.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const BEFORE = hash('before');
const AFTER = hash('after');

const environment = (overrides = {}) => ({ recipeId: 'json-normalize', recipeVersion: '1',
  scopeRef: 'scope-a', workspaceRoot: 'C:/work', ...overrides });

const checkpoint = (overrides = {}) => createCheckpoint({ taskId: 'task-1', stepIndex: 2,
  state: { inputs: { inputFile: 'source.json' } }, environment: environment(),
  evidenceRef: 'file:state.json#sha256:' + BEFORE, now: () => 1000, ...overrides });

const compensation = () => ({ compensationId: 'restore:1', targetTool: 'runtime.replace_json',
  targetArguments: { path: 'C:/work/output.json', content: 'old', expectedSha256: AFTER },
  expectedBeforeSha256: AFTER, expectedAfterSha256: BEFORE, reason: 'restore_prior_version',
  sourceAttemptId: 'attempt-1' });

const passVerification = () => ({ status: 'pass', progress: 'advanced', goalSatisfied: true,
  verifierId: 'json-source-output', verifierVersion: '1', evidenceRefs: ['file:out.json#sha256:' + BEFORE] });

test('a read-only step restores directly from its checkpoint', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'read' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, 'read_only_restore');
  assert.equal(plan.requiresCompensation, false);
  const settled = settleRollback({ plan });
  assert.equal(settled.status, 'restored');
  assert.equal(settled.completed, true);
});

test('a reversible write without a registered compensation is refused, not silently restored', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write' });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, 'compensation_required');
  assert.equal(plan.requiresCompensation, true);
});

test('irreversible and unknown effects can never be rolled back automatically', () => {
  for (const effect of ['irreversible', 'unknown']) {
    const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect, compensation: compensation() });
    assert.equal(plan.allowed, false, effect);
    assert.equal(plan.reason, `not_compensable:${effect}`, effect);
  }
});

test('a checkpoint from a changed environment is not a rollback point', () => {
  for (const [key, value] of [['recipeVersion', '2'], ['scopeRef', 'scope-b'], ['workspaceRoot', 'C:/other']]) {
    const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment({ [key]: value }), effect: 'read' });
    assert.equal(plan.allowed, false, key);
    assert.equal(plan.reason, `environment_changed:${key}`, key);
  }
});

test('a reversible rollback is complete only when the target fact confirms it', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write',
    compensation: compensation() });
  assert.equal(plan.allowed, true);
  assert.equal(plan.requiresCompensation, true);
  const confirmed = settleRollback({ plan, verification: passVerification(), observedAfterSha256: BEFORE });
  assert.equal(confirmed.status, 'restored');
  assert.equal(confirmed.completed, true);
  // A failed or diverged compensation leaves the run unresolved instead of claiming a rollback.
  for (const [label, args] of [
    ['failed verification', { verification: { ...passVerification(), status: 'fail', goalSatisfied: false }, observedAfterSha256: BEFORE }],
    ['diverged target', { verification: passVerification(), observedAfterSha256: AFTER }],
    ['missing target fact', { verification: passVerification() }],
  ]) {
    const result = settleRollback({ plan, ...args });
    assert.equal(result.status, 'unresolved', label);
    assert.equal(result.completed, false, label);
  }
});

test('an invalid compensation is refused before any restore is planned', () => {
  const plan = planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'reversible_write',
    compensation: { ...compensation(), expectedAfterSha256: AFTER } });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, 'compensation_invalid');
});

test('a checkpoint requires an environment and bounded step identity', () => {
  for (const overrides of [{ environment: undefined }, { stepIndex: -1 }, { state: [] }, { evidenceRef: '' }]) {
    assert.throws(() => checkpoint(overrides), { code: /invalid_(checkpoint|contract)/ });
  }
  assert.throws(() => planRollbackTo({ checkpoint: checkpoint(), current: environment(), effect: 'invented' }),
    { code: 'invalid_rollback' });
  assert.throws(() => settleRollback({ plan: { allowed: false } }), { code: 'invalid_rollback' });
});

/**
 * The rollback module is only useful if the runtime actually records checkpoints. This drives the real
 * host pipeline so the claim "DR-11 has data to roll back to" rests on an observed row, not on a
 * pure-function contract that nothing calls.
 */
async function pipeline(t) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'checkpoint.sqlite'));
  const agent = await host.agent('checkpoint-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime.write_json', description: 'Create the owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const authority = { scopeRef: 'cp-scope', workspaceRoot: host.storage, allowedTools: ['runtime.write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  // Close handles inside the test body: the host fixture removes its temp root in its own teardown.
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, scheduler, task, authority, close };
}

test('the running pipeline records a checkpoint for a verified step', async (t) => {
  const env = await pipeline(t);
  try {
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'completed');
    const recorded = env.store.listCheckpoints(env.task.taskId);
    assert.equal(recorded.length, 1, 'A verified step must leave a rollback point behind.');
    const checkpointRow = recorded[0];
    assert.equal(checkpointRow.stepIndex, 1);
    assert.match(checkpointRow.evidenceRef, /^file:/, 'The checkpoint cites the verifier evidence.');
    // The environment is stored with it, so a later restore can detect drift.
    assert.deepEqual(checkpointRow.environment, { recipeId: 'json-normalize', recipeVersion: '1',
      scopeRef: 'cp-scope', workspaceRoot: env.host.storage });
    const events = env.store.readEvents(env.task.taskId).map((event) => event.kind);
    assert.ok(events.includes('checkpoint_recorded'));
    // A checkpoint taken under the same environment is a usable target for a reversible effect.
    const plan = planRollbackTo({ checkpoint: createCheckpoint({ taskId: env.task.taskId,
      stepIndex: checkpointRow.stepIndex, state: checkpointRow.state, environment: checkpointRow.environment,
      evidenceRef: checkpointRow.evidenceRef }), current: checkpointRow.environment, effect: 'read' });
    assert.equal(plan.allowed, true);
  } finally { await env.close(); }
});

test('a failed or unverified step records no checkpoint', async (t) => {
  const env = await pipeline(t);
  try {
    // The recipe writes an empty artifact through a tool that ignores its content argument.
    env.host.tools.get('runtime.write_json').execute = async ({ path }) => {
      writeFileSync(path, '[]', { flag: 'wx' });
      return { created: true };
    };
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    // Verified below: the run stops at a failed verdict, so no checkpoint may exist. Asserting the reason
    // too keeps this from passing merely because the run crashed before verification.
    assert.equal(run.status, 'waiting_analysis');
    assert.equal(run.reason, 'output_mismatch');
    assert.equal(env.store.listCheckpoints(env.task.taskId).length, 0,
      'Unverified progress must not become a rollback point.');
  } finally { await env.close(); }
});

test('a checkpoint from a drifted environment is refused as a target in the pipeline too', async (t) => {
  const env = await pipeline(t);
  try {
    await env.scheduler.run(env.task, { authority: env.authority });
    const [row] = env.store.listCheckpoints(env.task.taskId);
    const plan = planRollbackTo({ checkpoint: createCheckpoint({ taskId: env.task.taskId, stepIndex: row.stepIndex,
      state: row.state, environment: row.environment, evidenceRef: row.evidenceRef }),
      current: { ...row.environment, recipeVersion: '2' }, effect: 'read' });
    assert.equal(plan.allowed, false);
    assert.equal(plan.reason, 'environment_changed:recipeVersion');
  } finally { await env.close(); }
});
