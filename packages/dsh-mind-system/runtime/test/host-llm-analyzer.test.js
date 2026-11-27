import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analyzer.js';
import { makeHostLlmAnalyzer, responseText, textOf } from '../src/host-llm-analyzer.js';

const evidenceRefs = ['run:out.txt'];
const diagnosis = { location: 'recipe', cause: 'wrong_expectation', evidenceRefs };
const repair = { kind: 'abort', diagnosis, requiresHumanReview: false, reason: 'stop' };

function packageFor(input = {}) {
  return {
    schemaVersion: 1, taskId: 'task', attemptId: 'attempt', trigger: 'execution_error',
    goal: 'Write a file.', scopeSummary: 'scope', candidate: null, decision: null,
    executionSummary: {}, verification: null, recentTrace: [], evidenceRefs,
    truncation: { omittedBytes: 0, fields: [] }, ...input,
  };
}

/** A stub host LLM service: captures the route and returns one streamed chunk. */
function stubLlm({ proposal = repair, enveloped = true, signalSeen = null, onChunk = null } = {}) {
  const state = { config: null, options: null, streamSignal: null };
  const llm = {
    async prepareCall(config, signal, configure) {
      state.config = config;
      state.signal = signal;
      return {
        config: { ...config, ...(configure ? configure(config, {}) : {}) },
        async *stream(options) {
          state.options = options;
          state.streamSignal = options.signal;
          const text = enveloped
            ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] })
            : JSON.stringify(proposal);
          if (onChunk) onChunk(signal, text);
          if (signal?.aborted) throw new Error('aborted');
          yield { text };
        },
      };
    },
  };
  return { llm, state, signalSeen };
}

const agent = (route) => ({
  options: { provider: 'options-provider', model: 'options-model' },
  session: { requestHeader: () => ({ config: route }) },
});

test('textOf ignores reasoning deltas that also carry a text field', () => {
  // The host pi-ai adapter emits both shapes with `text`; only text-delta is the answer.
  assert.equal(textOf({ type: 'text-delta', text: '{"a"' }), '{"a"');
  assert.equal(textOf({ type: 'reasoning-delta', text: 'thinking out loud' }), '');
  assert.equal(textOf({ type: 'thinking_delta', text: 'thinking' }), '');
  assert.equal(textOf({ text: 'legacy' }), 'legacy');
});

test('responseText unwraps a full fenced JSON block but leaves bare JSON untouched', () => {
  const bare = JSON.stringify(repair);
  assert.equal(responseText(bare), bare);
  assert.equal(responseText(`\`\`\`json\n${bare}\n\`\`\``), bare);
  assert.equal(responseText(`\`\`\`\n${bare}\n\`\`\``), bare);
  // A fence that does not wrap the whole response must not be silently stripped.
  const partial = `intro\n\`\`\`json\n${bare}\n\`\`\``;
  assert.equal(responseText(partial), partial);
});

test('host LLM invoke reaches Analyzer.analyze and produces a proposed repair', async () => {
  const { llm, state } = stubLlm();
  const analyzer = new Analyzer({ invoke: makeHostLlmAnalyzer({ llm, agent: agent({ provider: 'deepseek', model: 'deepseek-v4-flash' }) }) });
  const result = await analyzer.analyze(packageFor());
  assert.equal(result.status, 'proposed', JSON.stringify(result));
  assert.equal(result.repair.kind, 'abort');
  assert.equal(state.config.provider, 'deepseek');
  assert.equal(state.config.model, 'deepseek-v4-flash');
  assert.ok(state.config.maxTokens > 0);
  assert.equal(state.options.system.includes('untrusted data'), true);
  assert.equal(JSON.parse(state.options.messages[0].content[0].text).taskId, 'task');
});

test('route falls back to agent.options when requestHeader has no config', async () => {
  const { llm, state } = stubLlm();
  const fallbackAgent = { options: { provider: 'codex', model: 'gpt-6.x' }, session: { requestHeader: () => undefined } };
  const analyzer = new Analyzer({ invoke: makeHostLlmAnalyzer({ llm, agent: fallbackAgent }) });
  const result = await analyzer.analyze(packageFor());
  assert.equal(result.status, 'proposed', JSON.stringify(result));
  assert.equal(state.config.provider, 'codex');
  assert.equal(state.config.model, 'gpt-6.x');
});

test('invoke respects the caller agent passed per call', async () => {
  const { llm, state } = stubLlm();
  const invoke = makeHostLlmAnalyzer({ llm, agent: agent({ provider: 'mount', model: 'mount-model' }) });
  const raw = await invoke({ instructions: 'system', input: { value: 1 }, signal: new AbortController().signal,
    agent: agent({ provider: 'caller', model: 'caller-model' }) });
  assert.equal(JSON.parse(raw).kind, 'abort', 'The envelope must be unwrapped to the raw proposal.');
  assert.equal(state.config.provider, 'caller');
  assert.equal(state.config.model, 'caller-model');
});

test('a streamed response over 65536 bytes throws so analysis is classified as failed', async () => {
  const huge = repair.reason + 'x'.repeat(65_537);
  const { llm } = stubLlm({ proposal: { ...repair, reason: huge }, enveloped: false });
  const analyzer = new Analyzer({ invoke: makeHostLlmAnalyzer({ llm, agent: agent({ provider: 'p', model: 'm' }) }) });
  const result = await analyzer.analyze(packageFor());
  assert.equal(result.status, 'analysis_failed', JSON.stringify(result));
});

test('cancellation before or during the stream stops invoke', async () => {
  const controller = new AbortController();
  const { llm } = stubLlm({ onChunk: (signal) => { if (signal instanceof AbortSignal) signal.addEventListener('abort', () => {}, { once: true }); } });
  const invoke = makeHostLlmAnalyzer({ llm, agent: agent({ provider: 'p', model: 'm' }) });
  controller.abort();
  await assert.rejects(() => invoke({ instructions: 'system', input: {}, signal: controller.signal }),
    (error) => error?.name === 'AbortError' || /abort/i.test(error?.message ?? ''));
});

test('a missing route throws before any transport call', async () => {
  const { llm, state } = stubLlm();
  const invoke = makeHostLlmAnalyzer({ llm, agent: { options: {}, session: { requestHeader: () => undefined } } });
  await assert.rejects(() => invoke({ instructions: 'system', input: {}, signal: new AbortController().signal }),
    /route_unavailable/);
  assert.equal(state.config, null);
});

test('makeHostLlmAnalyzer refuses a service without prepareCall', () => {
  assert.throws(() => makeHostLlmAnalyzer({ llm: {}, agent }), /analysis_host_llm_unavailable/);
});
