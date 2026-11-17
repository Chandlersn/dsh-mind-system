import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createHost, deferred, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { HostExecutor } from '../src/executor.js';
import { DecisionClient } from '../src/decision-client.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
const validateArguments = ({ tool, arguments: args }) => {
  assertObjectJsonSchema(tool.parameters);
  return validateJsonSchemaValue(tool.parameters, args, 'arguments');
};

async function setup(t, options = {}) {
  let store;
  let executor;
  t.after(async () => { await executor?.dispose(); store?.close(); });
  const host = await createHost(t);
  const agent = await host.agent('scheduler-caller');
  store = new RuntimeStore(join(host.root, 'runtime.sqlite'), options.storeOptions);
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'b', name: ' Beta ' }, { id: 'a', name: ' Alpha ' }]));
  host.tools.register({
    name: 'runtime.write_json', description: 'Create a fixture JSON output inside the authorized workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
      createOnly: { type: 'boolean', enum: [true] } }, required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      assert.equal(args.path, join(host.storage, 'output.json'));
      host.ledger('json_write');
      if (options.writeBody) return options.writeBody(args, host);
      writeFileSync(args.path, args.content, { flag: 'wx' });
      return { created: true };
    },
  });
  const authority = { scopeRef: 'fixture-workspace', workspaceRoot: host.storage,
    allowedTools: ['runtime.write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Normalize fixture records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000, ...options.task };
  const makeScheduler = (overrides = {}) => new RuntimeScheduler({ store, recipes: [jsonNormalizeRecipe],
    executor, tools: host.tools, validateArguments, ...options.schedulerOptions, ...overrides });
  return { host, store, executor, authority, task, makeScheduler };
}

test('registered recipe completes through the real pipeline with independently verified files and no analysis', async (t) => {
  const env = await setup(t);
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'completed');
  assert.equal(env.host.count('json_write'), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(env.host.storage, 'output.json'), 'utf8')),
    [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  assert.deepEqual(result.budgetUsage, { attempts: 1, toolCalls: 1, ioOperations: 24, decisionRequests: 0, analysisCalls: 0 });
  const events = env.store.readEvents(env.task.taskId);
  assert.equal(events.filter((event) => event.kind === 'admission_decided').length, 2);
  assert.equal(events.find((event) => event.kind === 'decision_recorded').payload.decisionSource, 'rules');
  const final = events.findLast((event) => event.kind === 'outcome_recorded');
  assert.equal(final.payload.verification.goalSatisfied, true);
  assert.equal(final.payload.verification.evidenceRefs.length, 2);
  assert.equal(final.payload.outcome.dispatchEntered, true);
});

test('a tool success and forged verification payload cannot bypass the registered verifier', async (t) => {
  const env = await setup(t, { writeBody(args) {
    writeFileSync(args.path, '[]', { flag: 'wx' });
    return { success: true, verification: { status: 'pass', goalSatisfied: true, evidenceRefs: ['forged'] } };
  } });
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(result.reason, 'output_mismatch');
  assert.equal(result.budgetUsage.analysisCalls, 0);
  assert.equal(env.host.count('json_write'), 1);
});

test('pre-policy denial stops without dispatch or an automatic repair attempt', async (t) => {
  const env = await setup(t);
  env.host.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Fixture authorization denied.' }));
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('json_write'), 0);
  assert.equal(existsSync(join(env.host.storage, 'output.json')), false);
  assert.equal(env.store.readEvents(env.task.taskId).at(-1).payload.outcome.status, 'not_started');
});

test('a post-policy failure after the file effect freezes the run for reconciliation', async (t) => {
  const env = await setup(t);
  env.host.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Fixture post failure.' }] }));
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'reconciling');
  assert.equal(env.host.count('json_write'), 1);
  assert.equal(existsSync(join(env.host.storage, 'output.json')), true);
  assert.equal(env.store.listUnresolved(env.task.taskId).length, 1);
  assert.equal(result.budgetUsage.attempts, 1);
});

test('a changed source while policy waits is caught by dispatch-time admission', async (t) => {
  const env = await setup(t);
  env.host.ctx.on('tools/pre-execute', async (_exec, next) => {
    writeFileSync(join(env.host.storage, 'source.json'), '[]');
    return next();
  });
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('json_write'), 0);
  assert.equal(result.reason, 'dispatch_admission_denied');
});

for (const [dimension, budget] of [['tool', { maxToolCalls: 0 }], ['I/O', { maxIoOperations: 18 }]]) {
  test(`${dimension} budget exhaustion blocks the write and does not reset usage`, async (t) => {
    const env = await setup(t, { task: { budget } });
    const result = await env.makeScheduler().run(env.task, { authority: env.authority });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'budget_exceeded');
    assert.equal(env.host.count('json_write'), 0);
    assert.equal(result.budgetUsage.analysisCalls, 0);
    assert.ok(result.budgetUsage.ioOperations <= (budget.maxIoOperations ?? 100));
  });
}

test('missing caller authority fails before template reads or run creation', async (t) => {
  const env = await setup(t);
  await assert.rejects(env.makeScheduler().run(env.task), { code: 'authority_unavailable' });
  assert.throws(() => env.store.getRun(env.task.taskId), { code: 'run_not_found' });
  assert.equal(env.host.count('json_write'), 0);
});

test('a cancelled task stops before preparing inputs or dispatching', async (t) => {
  const env = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const result = await env.makeScheduler().run(env.task, { authority: env.authority, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.budgetUsage.ioOperations, 0);
  assert.equal(result.budgetUsage.attempts, 0);
  assert.equal(env.host.count('json_write'), 0);
});

test('omitted postconditions are rejected before a body runs', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, candidates(args) {
    const [candidate] = jsonNormalizeRecipe.candidates(args);
    return [{ ...candidate, postconditionIds: [] }];
  } };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(env.host.count('json_write'), 0);
});

test('invalid concrete tool arguments cannot reach the body', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, candidates(args) {
    const [candidate] = jsonNormalizeRecipe.candidates(args);
    return [{ ...candidate, arguments: { ...candidate.arguments, createOnly: 'yes' } }];
  } };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'admission_denied');
  assert.equal(env.host.count('json_write'), 0);
});

test('a write candidate cannot downgrade its trusted effect to read', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, candidates(args) {
    return jsonNormalizeRecipe.candidates(args).map((candidate) => ({ ...candidate, effect: 'read' }));
  } };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(env.host.count('json_write'), 0);
});

test('verification cannot use a different registered identity or fabricate completion', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, verifier: { ...jsonNormalizeRecipe.verifier,
    verify() { return { status: 'pass', goalSatisfied: true, progress: 'advanced', verifierId: 'another-verifier',
      verifierVersion: '1', evidenceRefs: ['forged'] }; } } };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.status, 'reconciling');
  assert.equal(result.reason, 'verifier_binding_mismatch');
  assert.equal(env.host.count('json_write'), 1);
});

test('a duplicate active run cannot overwrite the original task state', async (t) => {
  const env = await setup(t);
  const reached = deferred();
  const release = deferred();
  const recipe = { ...jsonNormalizeRecipe, async prepare(args) {
    const state = jsonNormalizeRecipe.prepare(args);
    reached.resolve();
    await release.promise;
    return state;
  } };
  const scheduler = env.makeScheduler({ recipes: [recipe] });
  const first = scheduler.run(env.task, { authority: env.authority });
  await reached.promise;
  await assert.rejects(scheduler.run(env.task, { authority: env.authority }), { code: 'run_in_progress' });
  release.resolve();
  assert.equal((await first).status, 'completed');
  assert.equal(env.host.count('json_write'), 1);
});

test('provider selection uses the local HTTP contract and charges its request before dispatch', async (t) => {
  const env = await setup(t);
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests++;
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(payload.questions)
      .map((id) => [id, { type: 'noul', noul: 0.9 }])) }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  const client = new DecisionClient({ provider: 'local-fixture', model: 'fixture', auth: { type: 'none' },
    endpoint: `http://127.0.0.1:${server.address().port}/systemone`, timeoutMs: 1000 });
  const scheduler = env.makeScheduler({ decisionClient: client,
    decisionPolicy: { version: 'fixture-policy', minScore: 0.7, minMargin: 0.1 } });
  const result = await scheduler.run(env.task, { authority: env.authority, decisionMode: 'provider' });
  assert.equal(result.status, 'completed');
  assert.equal(requests, 1);
  assert.equal(result.budgetUsage.decisionRequests, 1);
  assert.equal(result.budgetUsage.analysisCalls, 0);
});

test('zero provider request budget prevents a billable request and all tool effects', async (t) => {
  const env = await setup(t, { task: { budget: { maxDecisionRequests: 0 } } });
  let requests = 0;
  const scheduler = env.makeScheduler({ decisionClient: { async decide() { requests++; throw new Error('Must not be called.'); } },
    decisionPolicy: { version: 'fixture', minScore: 0.7, minMargin: 0.1 } });
  const result = await scheduler.run(env.task, { authority: env.authority, decisionMode: 'provider' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'budget_exceeded');
  assert.equal(requests, 0);
  assert.equal(env.host.count('json_write'), 0);
});

test('invalid signals cannot poison the active-run registry', async (t) => {
  const env = await setup(t);
  const scheduler = env.makeScheduler();
  await assert.rejects(scheduler.run(env.task, { authority: env.authority, signal: {} }), { code: 'invalid_runtime' });
  assert.equal((await scheduler.run(env.task, { authority: env.authority })).status, 'completed');
  assert.equal(env.host.count('json_write'), 1);
});

function counterRecipe(env, { target = 2, unchanged = false } = {}) {
  const filename = join(env.host.storage, 'counter.txt');
  writeFileSync(filename, '0');
  env.host.tools.register({
    name: 'fixture.counter', description: 'Advance the isolated fixture counter.',
    parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ count }) { env.host.ledger('counter_write'); writeFileSync(filename, String(count)); return { count }; },
  });
  return {
    id: 'counter', version: '1', ruleVersion: 'counter-v1', allowedTools: ['fixture.counter'],
    toolEffects: { 'fixture.counter': 'reversible_write' }, requiredPreconditionIds: ['ready'],
    postconditionIds: ['counter-value'], verificationIoReserve: 1,
    prepare() { return { count: 0 }; },
    candidates({ state }) { return [{ candidateId: 'increment', toolName: 'fixture.counter',
      arguments: { count: state.count + 1 }, preconditionIds: ['ready'], postconditionIds: ['counter-value'],
      progressKey: 'count', effect: 'reversible_write', source: { recipeId: 'counter', version: '1' } }]; },
    preconditions: { ready() { return { verdict: 'allow' }; } },
    verifier: { id: 'counter-file', version: '1', verify({ state, io }) {
      const actual = Number(io.readFileSync(filename, 'utf8'));
      const valid = actual === state.count + 1;
      return { status: valid ? 'pass' : 'fail', progress: valid && !unchanged ? 'advanced' : 'unchanged',
        goalSatisfied: valid && actual >= target, verifierId: 'counter-file', verifierVersion: '1',
        evidenceRefs: [`file:${filename}#observed:${actual}`] };
    } },
    advance({ state }) { return { count: state.count + 1 }; },
  };
}

for (const [label, options, budget, expectedStatus, writes] of [
  ['multi-step completion', {}, {}, 'completed', 2],
  ['attempt ceiling', {}, { maxAttempts: 1 }, 'failed', 1],
  ['no progress ceiling', { target: 100, unchanged: true }, {}, 'waiting_analysis', 3],
]) {
  test(`${label} preserves the business cursor, budget and external step evidence`, async (t) => {
    const env = await setup(t);
    const recipe = counterRecipe(env, options);
    const task = { ...env.task, recipeId: 'counter', inputs: {}, budget };
    const authority = { ...env.authority, allowedTools: ['fixture.counter'] };
    const result = await env.makeScheduler({ recipes: [recipe] }).run(task, { authority });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.state.count, writes);
    assert.equal(result.budgetUsage.attempts, writes);
    assert.equal(env.host.count('counter_write'), writes);
    assert.equal(Number(readFileSync(join(env.host.storage, 'counter.txt'), 'utf8')), writes);
    if (label === 'attempt ceiling') assert.equal(result.reason, 'budget_exceeded');
    if (label === 'no progress ceiling') assert.equal(result.reason, 'no_progress');
    const settled = env.store.readEvents(task.taskId).filter((event) => event.kind === 'outcome_recorded');
    assert.equal(settled.length, writes);
    assert.deepEqual(settled.map((event) => event.payload.nextState.count), Array.from({ length: writes }, (_, index) => index + 1));
  });
}

test('metered recipe reads cannot accept destructive file flags', async (t) => {
  const env = await setup(t);
  const before = readFileSync(join(env.host.storage, 'source.json'), 'utf8');
  const recipe = { ...jsonNormalizeRecipe, prepare({ task, io }) {
    io.readFileSync(join(task.workspaceRoot, 'source.json'), { flag: 'w' });
    return {};
  } };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.reason, 'invalid_io_options');
  assert.equal(readFileSync(join(env.host.storage, 'source.json'), 'utf8'), before);
  assert.equal(env.host.count('json_write'), 0);
});

test('a verifier exceeding its prepaid I/O allowance leaves an unresolved outcome', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, verificationIoReserve: 0 };
  const result = await env.makeScheduler({ recipes: [recipe] }).run(env.task, { authority: env.authority });
  assert.equal(result.status, 'reconciling');
  assert.equal(result.reason, 'io_reservation_exceeded');
  assert.equal(env.host.count('json_write'), 1);
});

test('monotonic deadline prevents dispatch even when the wall clock moves backwards', async (t) => {
  let wall = 1000;
  let monotonic = 1000;
  const env = await setup(t, { storeOptions: { now: () => wall }, task: { deadlineAt: 2000 },
    schedulerOptions: { now: () => wall, monotonicNow: () => monotonic } });
  env.host.ctx.on('tools/pre-execute', async (_exec, next) => { wall = 500; monotonic = 2000; return next(); });
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'budget_exceeded');
  assert.equal(env.host.count('json_write'), 0);
});

test('admission and execution reject different caller agents before any recipe reads', async (t) => {
  const env = await setup(t);
  const other = await env.host.agent('different-authority');
  assert.throws(() => { env.executor.agent = other; }, TypeError);
  await assert.rejects(env.makeScheduler().run(env.task, { authority: { ...env.authority, agent: other } }),
    { code: 'authority_agent_mismatch' });
  assert.throws(() => env.store.getRun(env.task.taskId), { code: 'run_not_found' });
  assert.equal(env.host.count('json_write'), 0);
});

for (const stage of ['prepare', 'candidates', 'provider', 'verify', 'advance']) {
  for (const thrown of [null, undefined]) {
    test(`${stage} rejecting ${String(thrown)} persists a stopped run instead of an orphan`, async (t) => {
      const env = await setup(t);
      const rejecting = async () => { throw thrown; };
      let recipe = { ...jsonNormalizeRecipe };
      let schedulerOptions = {};
      let runOptions = { authority: env.authority };
      if (['prepare', 'candidates'].includes(stage)) recipe[stage] = rejecting;
      if (stage === 'verify') recipe.verifier = { ...recipe.verifier, verify: rejecting };
      if (stage === 'advance') recipe.advance = rejecting;
      if (stage === 'provider') {
        schedulerOptions = { decisionClient: { decide: rejecting }, decisionPolicy: { version: 'fixture', minScore: 0.7, minMargin: 0.1 } };
        runOptions.decisionMode = 'provider';
      }
      const result = await env.makeScheduler({ recipes: [recipe], ...schedulerOptions }).run(env.task, runOptions);
      assert.equal(result.status, ['verify', 'advance'].includes(stage) ? 'reconciling' : 'waiting_analysis');
      assert.notEqual(result.status, 'running');
      assert.equal(env.store.getRun(env.task.taskId).status, result.status);
      assert.equal(env.host.count('json_write'), ['verify', 'advance'].includes(stage) ? 1 : 0);
    });
  }
}

for (const allowFallback of [true, false]) {
  test(`provider outage ${allowFallback ? 'uses an explicit unique read rule' : 'stops without a registered fallback'}`, async (t) => {
    const env = await setup(t);
    const sourcePath = join(env.host.storage, 'source.json');
    env.host.tools.register({ name: 'fixture.inspect', description: 'Inspect the isolated source file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ path }) { assert.equal(path, sourcePath); env.host.ledger('inspect_read'); return readFileSync(path, 'utf8'); } });
    const recipe = { id: 'read-inspection', version: '1', ruleVersion: 'read-primary-v1',
      allowedTools: ['fixture.inspect'], toolEffects: { 'fixture.inspect': 'read' }, requiredPreconditionIds: ['scope'],
      postconditionIds: ['source-observed'], verificationIoReserve: 1,
      fallbackRule: allowFallback ? { version: 'read-fallback-v1', candidateId: 'inspect', recipeId: 'read-inspection', recipeVersion: '1' } : null,
      candidates() { return [{ candidateId: 'inspect', toolName: 'fixture.inspect', arguments: { path: sourcePath },
        preconditionIds: ['scope'], postconditionIds: ['source-observed'], progressKey: 'source-observed', effect: 'read',
        source: { recipeId: 'read-inspection', version: '1' } }]; },
      preconditions: { scope({ candidate }) { return { verdict: candidate.arguments.path === sourcePath ? 'allow' : 'deny' }; } },
      verifier: { id: 'source-observation', version: '1', verify({ io }) {
        const observed = JSON.parse(io.readFileSync(sourcePath, 'utf8'));
        return { status: observed.length === 2 ? 'pass' : 'fail', goalSatisfied: observed.length === 2, progress: 'advanced',
          verifierId: 'source-observation', verifierVersion: '1', evidenceRefs: [`file:${sourcePath}`] };
      } } };
    let requests = 0;
    const scheduler = env.makeScheduler({ recipes: [recipe], decisionPolicy: { version: 'fixture', minScore: 0.7, minMargin: 0.1 },
      decisionClient: { async decide() { requests++; throw Object.assign(new Error('Fixture outage.'), { code: 'decision_transport_error' }); } } });
    const task = { ...env.task, recipeId: recipe.id };
    const authority = { ...env.authority, allowedTools: ['fixture.inspect'] };
    const result = await scheduler.run(task, { authority, decisionMode: 'provider' });
    assert.equal(result.status, allowFallback ? 'completed' : 'waiting_analysis');
    assert.equal(requests, 1);
    assert.equal(result.budgetUsage.decisionRequests, 1);
    assert.equal(env.host.count('inspect_read'), allowFallback ? 1 : 0);
    if (allowFallback) assert.equal(env.store.readEvents(task.taskId).find((event) => event.kind === 'decision_recorded').payload.decisionSource, 'rules');
  });
}

test('a provider outage cannot turn a matching write rule into an automatic fallback', async (t) => {
  const env = await setup(t);
  const recipe = { ...jsonNormalizeRecipe, fallbackRule: { version: 'unsafe-fallback', candidateId: 'create-normalized-json',
    recipeId: 'json-normalize', recipeVersion: '1' } };
  const scheduler = env.makeScheduler({ recipes: [recipe], decisionPolicy: { version: 'fixture', minScore: 0.7, minMargin: 0.1 },
    decisionClient: { async decide() { throw Object.assign(new Error('Fixture outage.'), { code: 'decision_transport_error' }); } } });
  const result = await scheduler.run(env.task, { authority: env.authority, decisionMode: 'provider' });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(env.host.count('json_write'), 0);
});

test('deadline expiry after an effect does not silently complete or repeat the write', async (t) => {
  let now = 1000;
  const env = await setup(t, { storeOptions: { now: () => now },
    schedulerOptions: { now: () => now, monotonicNow: () => now }, task: { deadlineAt: 2000 },
    writeBody(args) { writeFileSync(args.path, args.content, { flag: 'wx' }); now = 2000; return { created: true }; } });
  const result = await env.makeScheduler().run(env.task, { authority: env.authority });
  assert.equal(result.status, 'reconciling');
  assert.equal(result.reason, 'budget_exceeded');
  assert.equal(env.host.count('json_write'), 1);
});
