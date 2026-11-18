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
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { proposeApproval, confirmApproval } from '../src/pattern-approval.js';
import { matchPattern } from '../src/pattern-runtime.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

const pattern = { patternId: 'pattern:abc', statement: 'Replace only the owned artifact.',
  negativeType: 'out_of_scope_scenario', keywords: ['foreign path'], scopeRef: 'pattern-scope',
  trigger: 'verification_failed', toolName: 'runtime_write_json', recipeId: 'json-normalize', recipeVersion: '1' };

const approval = (() => {
  const request = proposeApproval({ ...pattern, activatable: false }, { requestedBy: 'runtime', now: () => 1000 });
  return confirmApproval(request, { confirmedBy: 'boss', human: true, patternVersion: request.patternVersion, now: () => 2000 });
})();

async function fixture(t, { patterns = null } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'pattern-run.sqlite'));
  const agent = await host.agent('pattern-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  let calls = 0;
  const analyzer = new Analyzer({ async invoke() {
    calls++;
    // A well-formed abort proposal keeps the run in a real terminal state rather than a parse failure.
    return JSON.stringify({ kind: 'abort', diagnosis: { location: 'output', cause: 'wrong_guess',
      evidenceRefs: [] }, requiresHumanReview: false, reason: 'Fixture abstains.' });
  } });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime_write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path }) { writeFileSync(path, '[]', { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const coordinator = new AnalysisCoordinator({ store, analyzer, agent, patterns });
  const authority = { scopeRef: 'pattern-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Create sorted normalized records.', scopeRef: authority.scopeRef, workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const run = await scheduler.run(task, { authority });
  // Close in the test body: the host fixture removes its temporary root in its own teardown, and an open
  // SQLite handle there surfaces as EBUSY instead of the assertion we care about.
  return { host, store, task, authority, coordinator, calls: () => calls, run,
    close: async () => { await executor.dispose(); await analyzer.dispose(); store.close(); } };
}

const hitting = () => matchPattern({ approval, pattern,
  evidence: { eligible: true, independentRuns: 6, minRuns: 3 },
  context: { scopeRef: 'pattern-scope', trigger: 'verification_failed', toolName: 'runtime_write_json',
    recipeId: 'json-normalize', recipeVersion: '1' }, now: () => 3000 });

test('an approved pattern answers the sixth case without calling the analyzer', async (t) => {
  const env = await fixture(t, { patterns: hitting });
  assert.equal(env.run.status, 'waiting_analysis');
  const analysis = await env.coordinator.analyze(env.task.taskId, { authority: env.authority, pattern: true });
  assert.equal(analysis.status, 'pattern_applied');
  assert.equal(env.calls(), 0, 'A pattern hit must not invoke the analyzer.');
  const events = env.store.readEvents(env.task.taskId);
  const applied = events.find((event) => event.kind === 'pattern_applied');
  assert.ok(applied, 'The hit must be recorded as an event.');
  assert.equal(applied.payload.reason, 'approved_pattern_hit');
  assert.equal(applied.payload.patternVersion, approval.patternVersion);
  await env.close();
});

test('an abstaining pattern still lets analysis run and records why it declined', async (t) => {
  const env = await fixture(t, { patterns: () => ({ hit: false, reason: 'out_of_scope:scopeRef', analysesSuppressed: false }) });
  const analysis = await env.coordinator.analyze(env.task.taskId, { authority: env.authority, pattern: true });
  assert.equal(analysis.status, 'proposed', 'Abstaining must fall through to the analyzer.');
  assert.equal(env.calls(), 1, 'The analyzer must actually run when the pattern abstains.');
  const events = env.store.readEvents(env.task.taskId).map((event) => event.kind);
  assert.ok(events.includes('pattern_abstained'));
  assert.ok(!events.includes('pattern_applied'));
  await env.close();
});

test('no pattern configured keeps the original behaviour exactly', async (t) => {
  const env = await fixture(t);
  const analysis = await env.coordinator.analyze(env.task.taskId, { authority: env.authority });
  assert.equal(analysis.status, 'proposed');
  assert.equal(env.calls(), 1);
  const events = env.store.readEvents(env.task.taskId).map((event) => event.kind);
  assert.ok(!events.includes('pattern_applied') && !events.includes('pattern_abstained'));
  await env.close();
});
