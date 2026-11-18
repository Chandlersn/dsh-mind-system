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

const compensation = () => ({ compensationId: 'restore:1', targetTool: 'runtime_replace_json',
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
  host.tools.register({ name: 'runtime_write_json', description: 'Create the owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const authority = { scopeRef: 'cp-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  // Close handles inside the test body: the host fixture removes its temp root in its own teardown.
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, scheduler, task, authority, close };}

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
    env.host.tools.get('runtime_write_json').execute = async ({ path }) => {
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

/**
 * The dispatch half: a persisted `rollback_to` proposal must actually restore the recorded cursor through
 * the scheduler. Everything else in this file can be green while this is still a stub, which is exactly
 * the failure this test exists to prevent.
 */
async function rollbackPipeline(t, { effect = 'read', afterRestoreFailure = null } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'rollback.sqlite'));
  const agent = await host.agent('rollback-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime_write_json', description: 'Create the owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  // A verifier that records each call, so "re-verified after restore" is observable rather than assumed.
  // `afterRestoreFailure` forces a non-pass verdict so "restored but unverified" can be told apart from
  // "restored and verified" — without that contrast, reporting success would pass either way.
  const verified = [];
  const recipe = { ...jsonNormalizeRecipe, verifier: { ...jsonNormalizeRecipe.verifier,
    async verify(context) {
      const result = await jsonNormalizeRecipe.verifier.verify(context);
      verified.push({ state: structuredClone(context.state), status: result.status });
      if (afterRestoreFailure && verified.length > 1) {
        return { ...result, status: afterRestoreFailure, progress: 'unchanged', goalSatisfied: false,
          evidenceRefs: result.evidenceRefs ?? [], reason: 'forced_verification_failure' };
      }
      return result;
    } } };
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [recipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const authority = { scopeRef: 'rb-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, scheduler, task, authority, close, verified, effect };
}

test('a persisted rollback_to proposal restores the recorded cursor through the scheduler', async (t) => {
  const env = await rollbackPipeline(t);
  try {
    // A completed run is a finished run: there is nothing to roll back, and stopRun is a no-op on it.
    const completed = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(completed.status, 'completed');
    const [checkpointRow] = env.store.listCheckpoints(env.task.taskId);
    assert.ok(checkpointRow, 'The completed run must have left a checkpoint.');
    // Build the rollback scenario on a fresh run whose state the pipeline itself prepared. The pipeline's
    // prepared state carries the computed input hash, which the verifier needs; a hand-written state would
    // fail re-verification for reasons unrelated to rollback.
    const rb = { ...env.task, taskId: randomUUID() };
    const rbVersion = () => ({ expectedVersion: env.store.getRun(rb.taskId).version });
    env.store.createRun(rb);
    // Use the same prepared shape the pipeline writes: {inputs} bound from the task's real files.
    const preparedInputs = { inputFile: rb.inputs.inputFile, outputFile: rb.inputs.outputFile,
      inputSha256: createHash('sha256').update(readFileSync(join(env.host.storage, rb.inputs.inputFile))).digest('hex') };
    const { checkpointId } = env.store.recordCheckpoint(rb.taskId, { stepIndex: 0,
      state: { step: 0, inputs: preparedInputs },
      environment: { recipeId: rb.recipeId, recipeVersion: rb.recipeVersion,
        scopeRef: rb.scopeRef, workspaceRoot: env.host.storage },
      evidenceRef: 'file:baseline#sha256:' + 'b'.repeat(64) }, rbVersion());
    env.store.setState(rb.taskId, { step: 1, inputs: preparedInputs }, rbVersion());
    env.store.stopRun(rb.taskId, 'waiting_analysis', 'repair_proposed', rbVersion());
    const { analysisId } = env.store.reserveAnalysis(rb.taskId, rbVersion());
    env.store.recordAnalysis(rb.taskId, analysisId, { status: 'proposed', repair: {
      kind: 'rollback_to', checkpointId, compensationPlanId: null,
      diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [] }, requiresHumanReview: false,
    } }, rbVersion());
    // Only a read-only history needs no compensation, so this must be a direct restore.
    const before = env.verified.length;
    const result = await env.scheduler.repair(rb.taskId, analysisId, { authority: env.authority });
    assert.equal(result.state.step, 0, 'The cursor must come back to the checkpoint.');
    const events = env.store.readEvents(rb.taskId).map((event) => event.kind);
    assert.ok(events.includes('checkpoint_restored'));
    assert.equal(env.verified.length, before + 1, 'The restored state must be re-verified exactly once.');
    const repair = env.store.getRepair(rb.taskId,
      env.store.readEvents(rb.taskId).findLast((event) => event.kind === 'repair_started').payload.repairId);
    assert.equal(repair.kind, 'rollback_to');
    // A rollback settles as `restored`, not `settled`: it restores a cursor and produces no attempt of its own,
    // so it must not borrow the status that requires a freshly verified attempt.
    assert.equal(repair.status, 'restored');
    assert.equal(repair.outcome.succeeded, true);
  } finally { await env.close(); }
});

test('a restore whose re-verification fails is not reported as a completed rollback', async (t) => {
  const env = await rollbackPipeline(t, { afterRestoreFailure: 'fail' });
  try {
    const rb = { ...env.task, taskId: randomUUID() };
    const rbVersion = () => ({ expectedVersion: env.store.getRun(rb.taskId).version });
    env.store.createRun(rb);
    const preparedInputs = { inputFile: rb.inputs.inputFile, outputFile: rb.inputs.outputFile,
      inputSha256: createHash('sha256').update(readFileSync(join(env.host.storage, rb.inputs.inputFile))).digest('hex') };
    const { checkpointId } = env.store.recordCheckpoint(rb.taskId, { stepIndex: 0,
      state: { step: 0, inputs: preparedInputs },
      environment: { recipeId: rb.recipeId, recipeVersion: rb.recipeVersion,
        scopeRef: rb.scopeRef, workspaceRoot: env.host.storage },
      evidenceRef: 'file:baseline#sha256:' + 'b'.repeat(64) }, rbVersion());
    // Produce one verified step so the forced failure applies to the verification that follows the restore.
    const first = await env.store.reserveAttempt(rb.taskId, { candidateId: 'warmup',
      toolName: 'runtime_write_json', arguments: { path: join(env.host.storage, 'output.json'),
        content: '[]', createOnly: true },
      preconditionIds: [...jsonNormalizeRecipe.requiredPreconditionIds],
      postconditionIds: [...jsonNormalizeRecipe.postconditionIds], progressKey: 'cursor', effect: 'read',
      source: { recipeId: rb.recipeId, version: rb.recipeVersion } }, rbVersion());
    env.store.markStarted(rb.taskId, first.attemptId, rbVersion());
    env.store.recordOutcome(rb.taskId, first.attemptId, { status: 'succeeded' },
      { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'json-source-output',
        verifierVersion: '1', evidenceRefs: ['file:x.json#sha256:' + 'a'.repeat(64)] }, rbVersion());
    env.store.setState(rb.taskId, { step: 1, inputs: preparedInputs }, rbVersion());
    env.store.stopRun(rb.taskId, 'waiting_analysis', 'repair_proposed', rbVersion());
    const { analysisId } = env.store.reserveAnalysis(rb.taskId, rbVersion());
    env.store.recordAnalysis(rb.taskId, analysisId, { status: 'proposed', repair: {
      kind: 'rollback_to', checkpointId, compensationPlanId: null,
      diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [] }, requiresHumanReview: false,
    } }, rbVersion());
    const result = await env.scheduler.repair(rb.taskId, analysisId, { authority: env.authority });
    // The cursor is restored (the write happened), but a failed re-verification must not be sold as success.
    assert.equal(result.state.step, 0);
    const repair = env.store.getRepair(rb.taskId,
      env.store.readEvents(rb.taskId).findLast((event) => event.kind === 'repair_started').payload.repairId);
    assert.notEqual(repair.status, 'restored', 'An unverified restore must not borrow the restored status.');
    assert.equal(repair.status, 'blocked');
    assert.match(repair.outcome.reason, /^rollback_unverified:/);
    assert.equal(env.verified.at(-1).status, 'fail', 'The forced failure must be the verdict that decided this.');
  } finally { await env.close(); }
});

test('an irreversible effect recorded after the checkpoint refuses the rollback', async (t) => {
  const env = await rollbackPipeline(t, { effect: 'irreversible' });
  try {
    // Build the scenario entirely through public store APIs on a fresh running run, so the "irreversible
    // fact after the checkpoint" is ordinary recorded state rather than a fabricated row.
    env.store.createRun(env.task);
    const version = () => ({ expectedVersion: env.store.getRun(env.task.taskId).version });
    const { checkpointId } = env.store.recordCheckpoint(env.task.taskId, { stepIndex: 0, state: { step: 0 },
      environment: { recipeId: env.task.recipeId, recipeVersion: env.task.recipeVersion,
        scopeRef: env.task.scopeRef, workspaceRoot: env.host.storage },
      evidenceRef: 'file:baseline#sha256:' + 'b'.repeat(64) }, version());
    // An attempt after the checkpoint that no compensation can undo.
    const attempt = env.store.reserveAttempt(env.task.taskId, { candidateId: 'irreversible-step',
      toolName: 'runtime_write_json', arguments: { path: join(env.host.storage, 'x.json'), content: '[]', createOnly: true },
      preconditionIds: [...jsonNormalizeRecipe.requiredPreconditionIds],
      postconditionIds: [...jsonNormalizeRecipe.postconditionIds], progressKey: 'cursor', effect: 'irreversible',
      source: { recipeId: env.task.recipeId, version: env.task.recipeVersion } }, version());
    env.store.markStarted(env.task.taskId, attempt.attemptId, version());
    env.store.recordOutcome(env.task.taskId, attempt.attemptId, { status: 'succeeded' },
      { status: 'pass', progress: 'advanced', goalSatisfied: false, verifierId: 'json-source-output',
        verifierVersion: '1', evidenceRefs: ['file:x.json#sha256:' + 'a'.repeat(64)] }, version());
    // Precondition: the store really does report the irreversible attempt as "after the checkpoint".
    const since = env.store.readAttemptsAfter(env.task.taskId, checkpointId);
    assert.deepEqual(since.map((item) => item.candidate.effect), ['irreversible']);
    env.store.stopRun(env.task.taskId, 'waiting_analysis', 'repair_proposed', version());
    const { analysisId } = env.store.reserveAnalysis(env.task.taskId, version());
    env.store.recordAnalysis(env.task.taskId, analysisId, { status: 'proposed', repair: {
      kind: 'rollback_to', checkpointId, compensationPlanId: null,
      diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [] }, requiresHumanReview: false,
    } }, version());
    const before = env.store.getRun(env.task.taskId).state;
    await assert.rejects(env.scheduler.repair(env.task.taskId, analysisId, { authority: env.authority }),
      { code: 'not_compensable' });
    assert.deepEqual(env.store.getRun(env.task.taskId).state, before,
      'A refused rollback must not partially restore the cursor.');
    assert.ok(!env.store.readEvents(env.task.taskId).some((event) => event.kind === 'checkpoint_restored'));
  } finally { await env.close(); }
});
