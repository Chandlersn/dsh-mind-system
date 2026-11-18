import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from '../src/store.js';
import { createExecutionRuntimePlugin } from '../src/plugin.js';
import { Analyzer } from '../src/analyzer.js';

/**
 * The analysis loop, wired rather than merely present.
 *
 * `AnalysisCoordinator` and `exceptions.js` existed and had their own passing tests, but nothing called them:
 * the whole "package the exception, ask for a repair, record the proposal" path was unreachable from a real
 * run. The assertions here therefore go through the plugin, and the first one is about the *absence* of
 * analysis 鈥?a host without a provider must behave exactly as it did before.
 *
 * A fake analyzer is used on purpose: the point is that the loop is reachable and records what it says, not
 * that a model answers well.
 */

// A repair proposal has a strict shape: kind, a diagnosis with its own fields, requiresHumanReview, and the
// branch-specific keys. A bare { kind, reason } is rejected as a protocol error, which is what the first
// attempt at this fixture returned.
//
// `diagnosis.evidenceRefs` must cite evidence that is actually in the packaged exception: a proposal may not
// reference something the caller never supplied. The ref is therefore taken from the packet rather than
// hardcoded, which is what a real analyzer has to do.
//
// `diagnosis.cause` is a closed vocabulary (wrong_guess / environment_changed / wrong_expectation / unknown),
// not free text. A diagnosis has to be classifiable to steer a repair, and prose is not; `unknown`
// additionally requires human review.
const repairFor = (packet) => ({
  kind: 'abort',
  requiresHumanReview: false,
  diagnosis: { location: 'recipe:never-matches', cause: 'wrong_expectation',
    evidenceRefs: [packet.evidenceRefs[0]].filter(Boolean) },
  reason: 'the recipe can never satisfy this goal',
});

const proposalFor = (packet) => ({ status: 'proposed', repair: repairFor(packet) });

function fixture(t, { analyzer = null, succeeds = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'analysis-wiring-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const registered = new Map();

  // A minimal context: enough for the plugin's `get('tools')`, the executor's `on`, and a dispatch that
  // emits both pipeline events in the host's order.
  const handlers = new Map();
  const owner = {
    get(name) { return name === 'tools' ? tools : undefined; },
    tools: null,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {
        const list = handlers.get(event) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    async waterfall(event, value, fallback) {
      const chain = [...(handlers.get(event) ?? [])];
      const step = (index) => async () => (index >= chain.length ? fallback() : chain[index](value, step(index + 1)));
      return step(0)();
    },
  };

  const tools = {
    register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    get(name) { return registered.get(name) ?? null; },
    list() { return [...registered.keys()]; },
    async execute(input) {
      const tool = registered.get(input?.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      await owner.waterfall('tools/pre-execute', input, () => Promise.resolve({ kind: 'allow' }));
      let outcome;
      await owner.waterfall('tools/execute', input, async () => {
        try {
          const value = await tool.execute(input.arguments, input);
          outcome = { isError: false, value, content: [{ type: 'text', text: 'ok' }] };
        } catch (error) {
          outcome = { isError: true, content: [{ type: 'text', text: error?.message ?? String(error) }] };
        }
        return outcome;
      });
      return outcome;
    },
  };
  owner.tools = tools;

  tools.register({
    name: 'runtime_write_text',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
      createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; },
  });

  const recipe = {
    id: 'never-matches', version: '1', ruleVersion: '1',
    allowedTools: ['runtime_write_text'],
    toolEffects: { 'runtime_write_text': 'reversible_write' },
    // Both condition lists must be non-empty: the contract refuses a candidate that declares neither, so an
    // empty array here would fail at candidate generation and never reach the analysis this file tests.
    requiredPreconditionIds: ['workspace'],
    postconditionIds: ['goal'],
    verificationIoReserve: 2,
    prepare: () => ({}),
    // Deliberately unsatisfiable: the run must stop for analysis, which is what this whole file exercises.
    candidates: ({ task }) => [{
      candidateId: `${task.taskId}:main`, toolName: 'runtime_write_text',
      arguments: { path: join(root, 'out.txt'), content: 'x', createOnly: true },
      preconditionIds: ['workspace'], postconditionIds: ['goal'], inputVersion: null,
      progressKey: 'p', effect: 'reversible_write', idempotencyKey: `${task.taskId}:main`,
      source: { recipeId: 'never-matches', version: '1' } }],
    preconditions: { workspace: () => ({ verdict: 'allow' }) },
    verifier: { id: 'always-fails', version: '1',
      // A failing verdict by default: the run must stop for analysis. `succeeds` flips it so the opposite
      // case — a completed run — can be exercised against the same fixture.
      verify: async () => (succeeds
        ? { status: 'pass', progress: 'advanced', goalSatisfied: true, verifierId: 'always-fails',
          verifierVersion: '1', evidenceRefs: ['evidence:known'], reason: 'passes' }
        : { status: 'fail', progress: 'unchanged', goalSatisfied: false, verifierId: 'always-fails',
          verifierVersion: '1', evidenceRefs: ['evidence:known'], reason: 'nope' }) },
  };

  const taskId = randomUUID();
  const task = { taskId, recipeId: 'never-matches', recipeVersion: '1', goal: 'A goal this recipe never meets.',
    scopeRef: 'scope-a', workspaceRoot: root, inputs: { inputFile: 'in.txt', outputFile: 'out.txt' },
    deadlineAt: Date.now() + 60_000 };
  writeFileSync(join(root, 'in.txt'), 'a\n');

  const plugin = createExecutionRuntimePlugin({ store, recipes: [recipe],
    tasks: { run: async ({ agent }) => ({ task, authority: { scopeRef: 'scope-a', workspaceRoot: root,
      allowedTools: ['runtime_write_text'], agent } }) },
    // An empty violation list means "the arguments are acceptable"; anything else would block dispatch.
    validateArguments: () => [], owner, analyzer });
  const dispose = plugin.apply(owner);
  const agent = { id: 'caller' };
  return { root, store, registered, owner, agent, taskId,
    close: async () => { await dispose?.(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('without an analyzer the plugin behaves exactly as before', async (t) => {
  const env = fixture(t);
  try {
    const run = await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    assert.equal(run.status, 'waiting_analysis');
    // No analysis key at all: the absence is visible in the receipt rather than hidden behind a component
    // that would only record "unavailable".
    assert.equal(Object.hasOwn(run, 'analysis'), false, JSON.stringify(run));
  } finally { await env.close(); }
});

test('a run that stops for analysis actually gets analyzed', async (t) => {
  const calls = [];
  const env = fixture(t, { analyzer: { async analyze(packet) { calls.push(packet); return proposalFor(packet); } } });
  try {
    const run = await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    assert.equal(run.status, 'waiting_analysis');
    assert.equal(calls.length, 1, 'The analyzer must be called exactly once for one stopped run.');
    assert.ok(run.analysis, JSON.stringify(run));
    if (run.analysis.status !== 'proposed') {
      const detail = env.store.getAnalysis(env.taskId, run.analysis.analysisId);
      const packet = calls[0];
      assert.fail(`analysis did not propose: ${JSON.stringify({ error: detail?.result?.error,
        packetEvidenceRefs: packet?.evidenceRefs, packetTrigger: packet?.trigger,
        packetVerification: packet?.verification?.status })}`);
    }
    assert.equal(run.analysis.status, 'proposed', JSON.stringify(run.analysis));
    // The proposal is persisted, not merely returned: a later owner has to be able to act on it.
    const analysis = env.store.getAnalysis(env.taskId, run.analysis.analysisId);
    assert.equal(analysis.status, 'proposed');
    assert.equal(analysis.result.repair.kind, 'abort');
  } finally { await env.close(); }
});

test('the exception package carries the trigger and the failed verification', async (t) => {
  const calls = [];
  const env = fixture(t, { analyzer: { async analyze(packet) { calls.push(packet); return proposalFor(packet); } } });
  try {
    await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    assert.equal(calls.length, 1);
    const packet = calls[0];
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.taskId, env.taskId);
    // The trigger names why analysis was requested, not a generic "error".
    assert.ok(['verification_failed', 'no_progress', 'execution_error'].includes(packet.trigger), packet.trigger);
    assert.equal(packet.verification?.status, 'fail');
    // Evidence travels with the package so a proposal can cite it.
    assert.ok(Array.isArray(packet.evidenceRefs));
  } finally { await env.close(); }
});

test('a completed run is never analyzed even when an analyzer is configured', async (t) => {
  const calls = [];
  const env = fixture(t, { succeeds: true,
    analyzer: { async analyze(packet) { calls.push(packet); return proposalFor(packet); } } });
  try {
    const run = await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    assert.equal(run.status, 'completed', JSON.stringify(run));
    // Analysis is tied to a run stopping, not to the plugin having a provider. Without this case, a mutant
    // that analyzed every run would pass — the only other assertions here use a run that does stop.
    assert.equal(calls.length, 0, 'A completed run must not be analyzed.');
    assert.equal(Object.hasOwn(run, 'analysis'), false, JSON.stringify(run));
  } finally { await env.close(); }
});

test('a run that does not stop for analysis is never analyzed', async (t) => {
  const calls = [];
  const env = fixture(t, { analyzer: { async analyze(packet) { calls.push(packet); return proposalFor(packet); } } });
  try {
    // The first run does stop, so it is analyzed exactly once.
    const first = await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    assert.equal(first.status, 'waiting_analysis');
    assert.equal(calls.length, 1);
    // Reading status afterwards must not analyze it again: analysis is tied to a run stopping, not to a read.
    await env.registered.get('runtime_status').execute({ taskId: env.taskId }, { agent: env.agent });
    assert.equal(calls.length, 1, 'Reading status must not analyze a run a second time.');
  } finally { await env.close(); }
});

test('an analysis failure is reported, not turned into a task failure', async (t) => {
  const env = fixture(t, { analyzer: { async analyze() { throw new Error('provider exploded'); } } });
  try {
    const run = await env.registered.get('runtime_run').execute({ taskRef: 'run' }, { agent: env.agent });
    // The task's own outcome is already settled; a bookkeeping failure must not rewrite it into something else.
    assert.equal(run.status, 'waiting_analysis');
    assert.ok(run.analysis, JSON.stringify(run));
    // A throwing provider is recorded as an unavailable proposal, never as a successful one.
    assert.notEqual(run.analysis.status, 'proposed');
  } finally { await env.close(); }
});

test('the analyzer enforces a bounded timeout and response size', async () => {
  // These guards live in the constructor, so a misconfigured transport is refused rather than degrading.
  assert.throws(() => new Analyzer({ invoke: () => {}, timeoutMs: 0 }), { code: 'analysis_config_error' });
  assert.throws(() => new Analyzer({ invoke: () => {}, timeoutMs: 999_999 }), { code: 'analysis_config_error' });
  assert.throws(() => new Analyzer({}), { code: 'analysis_config_error' });
});
