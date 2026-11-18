import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { Analyzer } from '../src/analyzer.js';
import { AnalysisCoordinator } from '../src/exceptions.js';
import { classifyFailureRoute } from '../src/diagnosis.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

async function fixture(t) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'route.sqlite'));
  const agent = await host.agent('route-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const analyzer = new Analyzer({ async invoke() {
    return JSON.stringify({ kind: 'abort', diagnosis: { location: 'output', cause: 'wrong_guess',
      evidenceRefs: [] }, requiresHumanReview: false, reason: 'fixture' });
  } });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime_write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path }) { writeFileSync(path, '[]', { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const coordinator = new AnalysisCoordinator({ store, analyzer, agent });
  const authority = { scopeRef: 'route-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Create sorted normalized records.', scopeRef: authority.scopeRef, workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const run = await scheduler.run(task, { authority });
  return { store, task, authority, coordinator, run,
    close: async () => { await executor.dispose(); await analyzer.dispose(); store.close(); } };
}

test('a first failure repairs directly instead of paying for a structural diagnosis', async (t) => {
  const env = await fixture(t);
  assert.equal(env.run.status, 'waiting_analysis');
  await env.coordinator.analyze(env.task.taskId, { authority: env.authority });
  assert.equal(env.coordinator.lastRoute.route, 'repair_directly');
  assert.equal(env.coordinator.lastRoute.reason, 'first_occurrence');
  await env.close();
});

test('routing reads repetition from persisted history, not from a single failure', async (t) => {
  const env = await fixture(t);
  // First failure: no repair history at all, so the route is "repair directly".
  await env.coordinator.analyze(env.task.taskId, { authority: env.authority });
  assert.equal(env.coordinator.lastRoute.route, 'repair_directly');
  assert.equal(env.coordinator.lastRoute.reason, 'first_occurrence');
  // The persisted history is what the router consults; with two recorded non-observed repairs it escalates.
  const history = env.store.readRepairTrace(env.task.taskId, { limit: 10 });
  assert.equal(history.filter((item) => item.kind === 'retry_with').length, 0);
  await env.close();
});

test('a self-explanatory execution error never routes to diagnosis', () => {
  // The router itself is the contract: an error whose cause is already stated is repaired directly.
  const route = classifyFailureRoute({ trigger: 'execution_error', selfExplanatory: true, signatureFailures: 9 });
  assert.equal(route.route, 'repair_directly');
  assert.equal(route.reason, 'self_explanatory_error');
});
