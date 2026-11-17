import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { Analyzer } from '../src/analyzer.js';
import { AnalysisCoordinator, runWithAnalysis } from '../src/exceptions.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { jsonNormalizeRepairPolicy } from '../recipes/json-repair.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { alterProposal, brokenRepair = false, budget, omitPolicy = false, repairPolicy = jsonNormalizeRepairPolicy, now = Date.now } = {}) {
  let store; let executor; let analyzer;
  t.after(async () => { await executor?.dispose(); await analyzer?.dispose(); store?.close(); });
  const host = await createHost(t);
  const agent = await host.agent('repair-caller');
  store = new RuntimeStore(join(host.root, 'state.sqlite'), { now });
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'b', name: ' Beta ' }, { id: 'a', name: ' Alpha ' }]));
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
  host.tools.register({ name: 'runtime.write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false }, output: { schema: {}, render },
    async execute({ path }) { assert.equal(path, join(host.storage, 'output.json')); host.ledger('initial_write'); writeFileSync(path, '[]', { flag: 'wx' }); return { created: true }; } });
  host.tools.register({ name: 'runtime.replace_json', description: 'Replace only the unchanged owned fixture output.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, expectedSha256: { type: 'string' } },
      required: ['path', 'content', 'expectedSha256'], additionalProperties: false }, output: { schema: {}, render },
    async execute({ path, content, expectedSha256 }) {
      host.ledger('repair_entered');
      assert.equal(path, join(host.storage, 'output.json'));
      assert.equal(hash(readFileSync(path)), expectedSha256);
      host.ledger('repair_write');
      writeFileSync(path, brokenRepair ? '[]' : content);
      return { success: true, verification: { status: 'pass', goalSatisfied: true } };
    } });
  const authority = { scopeRef: 'owned-repair-fixture', workspaceRoot: host.storage,
    allowedTools: ['runtime.write_json', 'runtime.replace_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create normalized sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: now() + 60_000, ...(budget ? { budget } : {}) };
  analyzer = new Analyzer({ async invoke({ input }) {
    const path = input.candidate.arguments.path;
    const outputRef = input.verification.evidenceRefs.find((ref) => ref.startsWith(`file:${path}#sha256:`));
    const candidate = { ...input.candidate, candidateId: 'replace-owned-json', toolName: 'runtime.replace_json',
      arguments: { path, content: input.candidate.arguments.content, expectedSha256: outputRef.slice(-64) },
      preconditionIds: [...jsonNormalizeRepairPolicy.requiredPreconditionIds] };
    const repair = { kind: 'retry_with', candidate, diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [outputRef] },
      requiresHumanReview: false };
    return JSON.stringify(alterProposal ? alterProposal(repair) : repair);
  } });
  const scheduler = new RuntimeScheduler({ store, executor, tools: host.tools, now,
    recipes: [{ ...jsonNormalizeRecipe, ...(omitPolicy ? {} : { repairPolicy }) }],
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const coordinator = new AnalysisCoordinator({ store, analyzer, agent });
  const initial = await runWithAnalysis({ scheduler, coordinator, task, options: { authority } });
  return { host, store, executor, task, scheduler, coordinator, authority, analysisId: initial.analysis.analysisId, initial };
}

function repairRecord(env) {
  const started = env.store.readEvents(env.task.taskId).findLast((event) => event.kind === 'repair_started');
  return started ? env.store.getRepair(env.task.taskId, started.payload.repairId) : null;
}

test('stored repair returns through admission and real host execution to fixed independent verification', async (t) => {
  const env = await fixture(t);
  assert.equal(env.initial.run.status, 'waiting_analysis');
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(readFileSync(join(env.host.storage, 'output.json'), 'utf8')),
    [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  assert.equal(env.host.count('initial_write'), 1);
  assert.equal(env.host.count('repair_write'), 1);
  assert.equal(result.budgetUsage.attempts, 2);
  assert.equal(result.budgetUsage.toolCalls, 2);
  assert.equal(result.budgetUsage.analysisCalls, 1);
  assert.notEqual(env.store.getAnalysis(env.task.taskId, env.analysisId).consumedAt, null);
  const repair = repairRecord(env);
  assert.equal(repair.status, 'settled');
  assert.equal(repair.outcome.succeeded, true);
  assert.equal(env.store.getRepairFailures(env.task.taskId, repair.signature), 0);
  const final = env.store.readEvents(env.task.taskId).findLast((event) => event.kind === 'outcome_recorded');
  assert.equal(final.payload.verification.verifierId, 'json-source-output');
  assert.equal(final.payload.verification.goalSatisfied, true);
  assert.equal(final.attemptId, repair.attemptId);
});

for (const [name, alter] of [
  ['foreign target', (r) => { r.candidate.arguments.path += '.foreign'; return r; }],
  ['omitted ownership check', (r) => { r.candidate.preconditionIds = ['workspace-scope']; return r; }],
  ['weakened postcondition', (r) => { r.candidate.postconditionIds = ['source-hash-unchanged']; return r; }],
  ['forged input hash', (r) => { r.candidate.inputVersion = '0'.repeat(64); return r; }],
  ['read effect downgrade', (r) => { r.candidate.effect = 'read'; return r; }],
]) {
  test(`${name} in a model repair proposal cannot reach a write`, async (t) => {
    const env = await fixture(t, { alterProposal: alter });
    const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
    assert.equal(result.status, 'failed');
    assert.equal(env.host.count('repair_write'), 0);
    assert.equal(readFileSync(join(env.host.storage, 'output.json'), 'utf8'), '[]');
    const record = repairRecord(env);
    assert.equal(record.status, 'blocked');
    assert.equal(env.store.getRepairFailures(env.task.taskId, record.signature), 1);
  });
}

test('repair success claims cannot override the registered verifier after wrong file content', async (t) => {
  const env = await fixture(t, { brokenRepair: true });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(env.host.count('repair_write'), 1);
  const repair = repairRecord(env);
  assert.equal(repair.outcome.succeeded, false);
  assert.equal(env.store.getRepairFailures(env.task.taskId, repair.signature), 1);
});

test('repair policy cannot replace the fixed goal verifier with its own success callback', async (t) => {
  const injected = { ...jsonNormalizeRepairPolicy, verifier: { id: 'injected', version: '1',
    async verify() { return { verifierId: 'injected', verifierVersion: '1', status: 'pass',
      goalSatisfied: true, progress: 'advanced', evidenceRefs: ['self-report:unverified'] }; } } };
  const env = await fixture(t, { repairPolicy: injected, brokenRepair: true });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(repairRecord(env).outcome.succeeded, false);
  const outcome = env.store.getLatestAttempt(env.task.taskId);
  assert.equal(outcome.verification.verifierId, 'json-source-output');
});

test('changed artifact after analysis is not overwritten by its stale proposal', async (t) => {
  const env = await fixture(t);
  writeFileSync(join(env.host.storage, 'output.json'), 'external update');
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('repair_write'), 0);
  assert.equal(readFileSync(join(env.host.storage, 'output.json'), 'utf8'), 'external update');
  assert.equal(env.host.count('repair_entered'), 0);
});

test('dispatch-time repair recheck catches a change while host policy waits', async (t) => {
  const env = await fixture(t);
  env.host.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'runtime.replace_json') writeFileSync(join(env.host.storage, 'output.json'), 'policy-time change');
    return next();
  });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('repair_write'), 0);
  assert.equal(repairRecord(env).outcome.succeeded, false);
});

test('post failure after actual repair freezes the unknown attempt and cannot credit repair success', async (t) => {
  const env = await fixture(t);
  env.host.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'runtime.replace_json'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture post failure.' }] } : next());
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'reconciling');
  assert.equal(env.host.count('repair_write'), 1);
  const repair = repairRecord(env);
  assert.equal(repair.status, 'unknown');
  assert.equal(env.store.getRepairFailures(env.task.taskId, repair.signature), 0);
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 1);
});

test('a consumed proposal cannot perform a second repair', async (t) => {
  const env = await fixture(t);
  assert.equal((await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority })).status, 'completed');
  await assert.rejects(env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority }));
  assert.equal(env.host.count('repair_write'), 1);
});

test('abort consumes the proposal without another business call even at the attempt ceiling', async (t) => {
  const env = await fixture(t, { budget: { maxAttempts: 1 }, alterProposal(r) {
    return { kind: 'abort', diagnosis: r.diagnosis, requiresHumanReview: false, reason: 'Stop after the verified mismatch.' };
  } });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.budgetUsage.attempts, 1);
  assert.equal(result.budgetUsage.toolCalls, 1);
  assert.equal(env.host.count('repair_write'), 0);
});

test('two actual failed repairs of the same native signature stop further ordinary analysis', async (t) => {
  let originalContext;
  const retainedPolicy = { ...jsonNormalizeRepairPolicy, prepare(args) {
    originalContext ??= jsonNormalizeRepairPolicy.prepare(args);
    return originalContext;
  } };
  const env = await fixture(t, { brokenRepair: true, repairPolicy: retainedPolicy });
  assert.equal((await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority })).status, 'waiting_analysis');
  const first = repairRecord(env);
  const second = await env.coordinator.analyze(env.task.taskId, { authority: env.authority });
  assert.equal(second.status, 'proposed');
  const result = await env.scheduler.repair(env.task.taskId, second.analysisId, { authority: env.authority });
  assert.equal(result.status, 'waiting_human');
  assert.equal(result.reason, 'repair_limit');
  assert.equal(env.host.count('repair_write'), 2);
  assert.equal(result.budgetUsage.analysisCalls, 2);
  assert.equal(first.signature, repairRecord(env).signature);
  assert.equal(env.store.getRepairFailures(env.task.taskId, first.signature), 2);
  assert.equal((await env.coordinator.analyze(env.task.taskId, { authority: env.authority })).status, 'not_required');
  assert.equal(env.host.count('repair_write'), 2);
});

test('deadline after repair reservation but before start settles non-dispatch without unknown replay', async (t) => {
  let clock = Date.now();
  const env = await fixture(t, { now: () => clock });
  const reserve = env.store.reserveAttempt.bind(env.store);
  env.store.reserveAttempt = (...args) => { const result = reserve(...args); clock = env.task.deadlineAt; return result; };
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('repair_write'), 0);
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 0);
  assert.equal(env.store.getLatestAttempt(env.task.taskId).outcome.status, 'not_started');
  assert.equal(repairRecord(env).status, 'settled');
});

test('caller cancellation during pre-execution settles the repair without a failure sample', async (t) => {
  const env = await fixture(t);
  const controller = new AbortController();
  env.host.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'runtime.replace_json') controller.abort('Fixture cancellation.');
    return next();
  });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(env.host.count('repair_write'), 0);
  assert.equal(repairRecord(env).status, 'settled');
  assert.equal(repairRecord(env).outcome.succeeded, false);
  assert.equal(env.store.getRepairFailures(env.task.taskId, repairRecord(env).signature), 0);
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 0);
});

test('unregistered repair policy cannot authorize an otherwise well-formed proposal', async (t) => {
  const env = await fixture(t, { omitPolicy: true });
  await assert.rejects(env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority }), { code: 'repair_policy_unavailable' });
  assert.equal(env.host.count('repair_write'), 0);
  assert.equal(env.store.getAnalysis(env.task.taskId, env.analysisId).consumedAt, null);
});
