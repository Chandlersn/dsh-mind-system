import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as entry from '../src/host-plugin.js';
import { RuntimeStore } from '../src/store.js';
import { createExecuteTool } from '../src/dynamic-tools.js';

const request = (taskId) => ({ taskId, goal: 'Write a mismatching result.',
  recipe: { recipeId: `analysis-${taskId}`, tool: 'runtime_write_text', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['expected'] } },
    arguments: { path: '{{workspaceRoot}}/out.txt', content: 'actual\n', createOnly: true } },
  inputs: { inputFile: 'input.txt', outputFile: 'out.txt' } });

test('reconciling runs do not invoke analysis or repair', async () => {
  let analyses = 0;
  let repairs = 0;
  const signal = new AbortController().signal;
  const tool = createExecuteTool({ store: { getRun() { throw new Error('unexpected read'); } },
    mount: { scopeRef: 'scope', workspaceRoot: 'workspace', allowedTools: ['runtime_write_text'] },
    toolEffects: { runtime_write_text: 'reversible_write' },
    schedulerFor: () => ({ async run(task, options) {
      assert.equal(options.signal, signal);
      return { task, status: 'reconciling', reason: 'outcome_unknown', budgetUsage: {} };
    }, async repair() { repairs++; } }),
    analyzeRun: async () => { analyses++; } });
  const result = await tool.execute(request('reconcile'), { agent: { id: 'caller' }, signal });
  assert.equal(result.status, 'reconciling');
  assert.equal(analyses, 0);
  assert.equal(repairs, 0);
  assert.equal(Object.hasOwn(result, 'analysis'), false);
});

for (const mode of ['proposed', 'human', 'failure', 'missing', 'disabled', 'cancelled', 'oversized']) {
  test(`dynamic host analysis: ${mode}`, async (t) => {
    const host = await createHost(t);
    writeFileSync(join(host.storage, 'input.txt'), 'input\n');
    const priorFetch = globalThis.fetch;
    const controller = host.controller();
    let calls = 0;
    let transportSignal;
    globalThis.fetch = async (_url, options) => {
      calls++;
      transportSignal = options.signal;
      assert.ok(options.signal instanceof AbortSignal);
      if (mode === 'failure') throw new Error('secret-provider-token');
      if (mode === 'cancelled') controller.abort();
      if (mode === 'oversized') {
        const stream = new ReadableStream({ start(streamController) {
          streamController.enqueue(new Uint8Array(65_000));
          streamController.enqueue(new Uint8Array(1_000));
        } });
        return new Response(stream, { headers: { 'content-length': '1' } });
      }
      const diagnosis = { location: 'recipe', cause: 'wrong_expectation', evidenceRefs: [] };
      const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
      const proposal = mode === 'proposed'
        ? { kind: 'retry_with', requiresHumanReview: false, diagnosis, candidate: packet.candidate }
        : { kind: 'abort', requiresHumanReview: mode === 'human', diagnosis, reason: 'stop' };
      return Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    };
    const config = { enabled: true, stateDir: mkdtempSync(join(host.root, 'state-')),
      workspaceRoot: host.storage, scopeRef: 'scope' };
    config.analysis = mode === 'missing' ? { allowDynamic: true }
      : { endpoint: 'https://test.invalid', model: 'test', apiKey: 'secret-token', ...(mode === 'disabled' ? {} : { allowDynamic: true }) };
    const fiber = await host.ctx.plugin(entry.plugin, config);
    await fiber.await();
    try {
      const agent = await host.agent(`caller-${mode}`);
      const taskId = randomUUID();
      const args = request(taskId);
      if (mode === 'disabled') args.allowDynamic = true;
      const result = await host.execute('runtime_execute', { agent, signal: controller.signal, arguments: args });
      if (mode === 'cancelled') {
        assert.equal(result.isError, true);
        assert.equal(calls, 1);
        assert.equal(controller.signal.aborted, true);
        const inspect = new RuntimeStore(join(config.stateDir, 'runtime.sqlite'));
        try {
          let persisted;
          for (let i = 0; i < 100; i++) {
            persisted = inspect.getRun(taskId);
            if (persisted.status === 'cancelled') break;
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.equal(persisted.status, 'cancelled');
          assert.equal(persisted.reason, 'analysis_cancelled');
          assert.equal(persisted.budgetUsage.toolCalls, 1);
          assert.deepEqual(inspect.readRepairTrace(taskId), []);
          assert.equal(readFileSync(join(host.storage, 'out.txt'), 'utf8'), 'actual\n');
        } finally { inspect.close(); }
        return;
      }
      assert.equal(result.isError, false, JSON.stringify(result.content));
      const inspect = new RuntimeStore(join(config.stateDir, 'runtime.sqlite'));
      const analysisRecord = result.value.analysis.analysisId ? inspect.getAnalysis(taskId, result.value.analysis.analysisId) : null;
      const attempt = inspect.getLatestAttempt(taskId);
      inspect.close();
      assert.equal(calls, ['missing', 'disabled'].includes(mode) ? 0 : 1, JSON.stringify({ receipt: result.value, analysisRecord, candidate: attempt?.candidate }));
      assert.equal(result.value.analysis.status, mode === 'missing' ? 'analysis_unavailable' : mode === 'disabled' ? 'analysis_disabled' : ['failure', 'oversized'].includes(mode) ? 'analysis_failed' : 'proposed');
      assert.equal(result.value.status, ['human', 'failure', 'oversized'].includes(mode) ? 'waiting_human' : 'waiting_analysis');
      const status = await host.execute('runtime_status', { agent, arguments: { taskId } });
      assert.equal(result.value.status, status.value.run.status);
      assert.equal(result.value.reason, status.value.run.reason);
      assert.deepEqual(result.value.budgetUsage, status.value.run.budgetUsage);
      assert.equal(result.value.library.succeeded, null);
      assert.equal(result.value.budgetUsage.toolCalls, 1);
      if (mode === 'oversized') assert.equal(transportSignal.aborted, true);
      if (mode === 'proposed') assert.equal(analysisRecord.result.repair.kind, 'retry_with');
      assert.equal(readFileSync(join(host.storage, 'out.txt'), 'utf8'), 'actual\n');
      assert.doesNotMatch(JSON.stringify(result.value), /secret|scopeSummary|evidenceRefs/);
    } finally { globalThis.fetch = priorFetch; await fiber.dispose(); }
  });
}
