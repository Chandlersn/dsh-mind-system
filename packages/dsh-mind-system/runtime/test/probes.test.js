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

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { proposal, probes = [], repairPolicy } = {}) {
  let store; let executor; let analyzer;
  t.after(async () => { await executor?.dispose(); await analyzer?.dispose(); store?.close(); });
  const host = await createHost(t);
  const agent = await host.agent('probe-caller');
  store = new RuntimeStore(join(host.root, 'probe.sqlite'));
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime_write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ path }) {
      assert.equal(path, join(host.storage, 'output.json'));
      host.ledger('initial_write');
      writeFileSync(path, '[]', { flag: 'wx' });
      return { created: true };
    } });
  const authority = { scopeRef: 'probe-fixture', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create sorted normalized records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  analyzer = new Analyzer({ async invoke({ input }) {
    const outputRef = input.verification.evidenceRefs.find((ref) => ref.includes('#sha256:'));
    return JSON.stringify(proposal({ input, outputRef }));
  } });
  const scheduler = new RuntimeScheduler({ store, executor, tools: host.tools, probes,
    recipes: [{ ...jsonNormalizeRecipe, ...(repairPolicy ? { repairPolicy } : {}) }],
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const coordinator = new AnalysisCoordinator({ store, analyzer, agent });
  const initial = await runWithAnalysis({ scheduler, coordinator, task, options: { authority } });
  return { host, store, task, scheduler, coordinator, authority, analysisId: initial.analysis.analysisId, initial };
}

const gather = ({ input }) => ({ kind: 'gather_evidence', probeIds: ['output-hash'],
  diagnosis: { location: 'output', cause: 'environment_changed',
    evidenceRefs: [input.verification.evidenceRefs.find((ref) => ref.includes('#sha256:'))] },
  requiresHumanReview: false });

test('a registered read-only probe records task evidence and returns the run to analysis', async (t) => {
  const runs = [];
  const probe = { probeId: 'output-hash', description: 'Report the owned output hash.',
    async run({ workspaceRoot, io }) {
      runs.push(workspaceRoot);
      const raw = io.readFileSync(join(workspaceRoot, 'output.json'), 'utf8');
      return { sha256: hash(raw), bytes: Buffer.byteLength(raw, 'utf8') };
    } };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  assert.equal(env.initial.run.reason, 'repair_proposed');
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  assert.equal(result.reason, 'evidence_gathered');
  assert.equal(runs.length, 1);
  assert.equal(env.host.count('initial_write'), 1);
  const evidence = env.store.listEvidence(env.task.taskId);
  assert.ok(evidence.some((item) => item.label === 'probe:output-hash'));
  const stored = evidence.find((item) => item.label === 'probe:output-hash');
  const trace = env.store.readRecentTrace(env.task.taskId, { limit: 5 });
  assert.ok(trace.some((event) => event.kind === 'repair_evidence_gathered'));
  const repair = env.store.readEvents(env.task.taskId).findLast((event) => event.kind === 'repair_started');
  const record = env.store.getRepair(env.task.taskId, repair.payload.repairId);
  assert.equal(record.status, 'observed');
  assert.equal(record.attemptId, null);
  assert.equal(record.outcome.succeeded, undefined);
  const reserved = env.store.reserveAnalysis(env.task.taskId, { expectedVersion: result.version });
  const bound = env.store.bindAnalysisEvidence(env.task.taskId, reserved.analysisId, [stored.ref],
    { expectedVersion: env.store.getRun(env.task.taskId).version });
  const excerpt = env.store.readAnalysisEvidence(env.task.taskId, reserved.analysisId, stored.ref,
    { expectedVersion: bound.version, maxBytes: 4096 });
  assert.equal(excerpt.label, 'probe:output-hash');
  assert.match(excerpt.text, /sha256/);
});

test('an unregistered probe name is reported as unavailable evidence, not as business work', async (t) => {
  const env = await fixture(t, { proposal: ({ input }) => ({ ...gather({ input }), probeIds: ['invented-probe'] }) });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.status, 'waiting_analysis');
  const events = env.store.readEvents(env.task.taskId).filter((event) => event.kind === 'repair_evidence_gathered');
  assert.equal(events.at(-1).payload.unavailable, 1);
  assert.equal(env.host.count('initial_write'), 1);
});

test('a probe cannot escape the authorized workspace or fall back to raw filesystem reads', async (t) => {
  let escape;
  const probe = { probeId: 'output-hash', description: 'Attempt an out-of-scope read.',
    async run({ io }) {
      try { escape = io.readFileSync('C:/Windows/win.ini', 'utf8'); }
      catch (failure) { escape = failure.code; }
      return { attempted: true };
    } };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(escape, 'probe_scope_denied');
});

test('gathering evidence consumes the proposal but cannot be replayed or counted as repair success', async (t) => {
  const probe = { probeId: 'output-hash', description: 'Observe output.', run: async () => ({ ok: true }) };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  const first = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(first.reason, 'evidence_gathered');
  await assert.rejects(env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority }));
  const repairEvent = env.store.readEvents(env.task.taskId).findLast((event) => event.kind === 'repair_started');
  const record = env.store.getRepair(env.task.taskId, repairEvent.payload.repairId);
  assert.equal(record.status, 'observed');
  assert.equal(env.store.getRepairFailures(env.task.taskId, record.signature), 0);
  assert.equal(env.host.count('initial_write'), 1);
});

test('running the same probe twice is bounded by the task I/O budget', async (t) => {
  const probe = { probeId: 'output-hash', description: 'Observe output.',
    async run({ io, workspaceRoot }) { return { size: io.lstatSync(join(workspaceRoot, 'output.json')).size }; } };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  const before = env.store.getRun(env.task.taskId).budgetUsage.ioOperations;
  await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  const after = env.store.getRun(env.task.taskId).budgetUsage.ioOperations;
  assert.equal(after, before + 1, 'One metered probe observation must charge exactly one logical I/O operation.');
});

test('a probe result is readable by the next analysis and stays task isolated', async (t) => {
  const probe = { probeId: 'output-hash', description: 'Observe output.',
    async run({ io, workspaceRoot }) {
      const raw = io.readFileSync(join(workspaceRoot, 'output.json'), 'utf8');
      return { sha256: hash(raw) };
    } };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  const stored = env.store.listEvidence(env.task.taskId).find((item) => item.label === 'probe:output-hash');
  const second = await env.coordinator.analyze(env.task.taskId, { authority: env.authority });
  assert.equal(second.status, 'proposed');
  const analysis = env.store.getAnalysis(env.task.taskId, second.analysisId);
  assert.ok(analysis.evidenceRefs.includes(stored.ref), 'A bounded probe reference must reach the next package.');
  // Evidence reads are bound to the live pending analysis; a finished proposal must not be re-opened.
  assert.throws(() => env.coordinator.readEvidence(env.task.taskId, second.analysisId, stored.ref,
    { authority: env.authority, maxBytes: 2048 }), { code: 'invalid_analysis_state' });
  assert.throws(() => env.store.getAnalysis('foreign-task', second.analysisId), { code: 'run_not_found' });
});

test('an oversized probe output is refused instead of being silently truncated', async (t) => {
  const probe = { probeId: 'output-hash', description: 'Return far too much.',
    async run() { return { text: 'x'.repeat(4 * 1024 * 1024 + 1) }; } };
  const env = await fixture(t, { proposal: gather, probes: [probe] });
  const result = await env.scheduler.repair(env.task.taskId, env.analysisId, { authority: env.authority });
  assert.equal(result.reason, 'evidence_gathered');
  const event = env.store.readEvents(env.task.taskId).findLast((item) => item.kind === 'repair_evidence_gathered');
  assert.equal(event.payload.unavailable, 1);
  assert.equal(event.payload.observed, 0);
  assert.equal(env.store.listEvidence(env.task.taskId).some((item) => item.label === 'probe:output-hash'), false);
});
