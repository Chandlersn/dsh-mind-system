/**
 * Host-LLM wiring: analysis must work without any separate endpoint/model/apiKey, using the LLM service
 * already mounted on the real Cordis context. A stub `llm` service is provided through `ctx.provide`,
 * because the test fixture does not mount the host's real LLM provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as entry from '../src/host-plugin.js';
import { RuntimeStore } from '../src/store.js';

const request = (taskId) => ({ taskId, goal: 'Write a mismatching result.',
  recipe: { recipeId: `analysis-${taskId}`, tool: 'runtime_write_text', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['expected'] } },
    arguments: { path: '{{workspaceRoot}}/out.txt', content: 'actual\n', createOnly: true } },
  inputs: { inputFile: 'input.txt', outputFile: 'out.txt' } });

function makeStubLlm(state) {
  return {
    async prepareCall(config, signal, configure) {
      state.configs.push(config);
      return {
        config: { ...config, ...(configure ? configure(config, {}) : {}) },
        async *stream(options) {
          state.options.push(options);
          const packet = JSON.parse(options.messages[0].content[0].text);
          const proposal = { kind: 'retry_with', requiresHumanReview: false, diagnosis: {
            location: 'recipe', cause: 'wrong_expectation', evidenceRefs: [] }, candidate: packet.candidate };
          yield { text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }) };
        },
      };
    },
  };
}

test('the host LLM service drives dynamic analysis with no explicit endpoint or key', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'input\n');
  const state = { configs: [], options: [] };
  const unprovide = host.ctx.provide('llm', makeStubLlm(state));
  const stateDir = mkdtempSync(join(host.root, 'state-'));
  const config = { enabled: true, stateDir, workspaceRoot: host.storage, scopeRef: 'scope',
    analysis: { allowDynamic: true } };
  const fiber = await host.ctx.plugin(entry.plugin, config);
  await fiber.await();
  try {
    const probe = entry.healthProbe.probe();
    assert.equal(probe.facts.analysis, 'configured', JSON.stringify(probe.facts));
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.deepEqual(status.value.analysis, { configuration: 'configured', invocation: 'unknown' });

    const agent = await host.agent('host-llm-caller');
    agent.options = { provider: 'agent-provider', model: 'agent-model' };
    agent.session = { requestHeader: () => ({ config: { provider: 'route-provider', model: 'route-model', reasoningEffort: 'high' } }) };
    const taskId = randomUUID();
    const result = await host.execute('runtime_execute', { agent, arguments: request(taskId) });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.analysis.status, 'proposed', JSON.stringify(result.value.analysis));
    assert.equal(state.configs.length, 1, 'The host LLM must be called exactly once.');
    assert.equal(state.configs[0].provider, 'route-provider');
    assert.equal(state.configs[0].model, 'route-model');
    assert.equal(state.configs[0].reasoningEffort, 'high');
    assert.equal(state.options[0].system.includes('untrusted data'), true);
    const inspect = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
    try {
      const record = inspect.getAnalysis(taskId, result.value.analysis.analysisId);
      assert.equal(record.status, 'proposed');
      assert.equal(record.result.repair.kind, 'retry_with');
    } finally { inspect.close(); }
    assert.equal(readFileSync(join(host.storage, 'out.txt'), 'utf8'), 'actual\n');
  } finally { await fiber.dispose(); await unprovide(); }
});

test('allowDynamic=false keeps dynamic analysis off even when the host LLM is available', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'input\n');
  const state = { configs: [], options: [] };
  const unprovide = host.ctx.provide('llm', makeStubLlm(state));
  const stateDir = mkdtempSync(join(host.root, 'state-'));
  const fiber = await host.ctx.plugin(entry.plugin, { enabled: true, stateDir,
    workspaceRoot: host.storage, scopeRef: 'scope' });
  await fiber.await();
  try {
    const agent = await host.agent('no-dynamic-caller');
    agent.options = { provider: 'p', model: 'm' };
    agent.session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) };
    const taskId = randomUUID();
    const args = request(taskId);
    args.allowDynamic = true;
    const result = await host.execute('runtime_execute', { agent, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.analysis.status, 'analysis_disabled', JSON.stringify(result.value.analysis));
    assert.equal(state.configs.length, 0, 'No LLM call may happen when dynamic analysis is not opted in.');
  } finally { await fiber.dispose(); await unprovide(); }
});

test('explicit HTTP config still overrides the host LLM', async (t) => {
  const host = await createHost(t);
  const state = { configs: [], options: [] };
  const unprovide = host.ctx.provide('llm', makeStubLlm(state));
  const priorFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('explicit transport selected'); };
  const fiber = await host.ctx.plugin(entry.plugin, { enabled: true,
    stateDir: mkdtempSync(join(host.root, 'state-')), workspaceRoot: host.storage,
    analysis: { endpoint: 'https://explicit.invalid', model: 'explicit', apiKey: 'explicit-key' } });
  await fiber.await();
  try {
    const probe = entry.healthProbe.probe();
    assert.equal(probe.facts.analysis, 'configured_explicit');
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.equal(status.value.analysis.configuration, 'configured_explicit');
    assert.equal(state.configs.length, 0, 'The host LLM must not be used when explicit HTTP config wins.');
  } finally { await fiber.dispose(); globalThis.fetch = priorFetch; await unprovide(); }
});
