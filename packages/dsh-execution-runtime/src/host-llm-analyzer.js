/**
 * Host-LLM-backed invoke transport for Analyzer.
 *
 * The host already mounts an LLM service (`ctx.get('llm')`) with per-agent model routes. This module turns
 * that service into the raw-text `invoke({instructions, input, signal})` contract the Analyzer expects,
 * without importing any `@deepseek-ai/*` package into this plugin.
 *
 * The route is resolved from the caller's Agent when `invoke` runs (not when the factory is created), so one
 * Analyzer can serve different agents: `session.requestHeader().config` owns the latest route, and
 * `options` is the fallback before the first request.
 */

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_MAX_TOKENS = 4_096;

/** Resolve `provider`/`model` (and optional `reasoningEffort`) from one caller agent. */
function routeFromAgent(agent) {
  let route = {};
  try {
    const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : null;
    const config = header?.config;
    if (config && typeof config === 'object') {
      if (typeof config.provider === 'string' && config.provider) route.provider = config.provider;
      if (typeof config.model === 'string' && config.model) route.model = config.model;
      if (typeof config.reasoningEffort === 'string' && config.reasoningEffort) route.reasoningEffort = config.reasoningEffort;
    }
  } catch { /* An unavailable header is not a reason to fail before the options fallback. */ }
  const options = agent?.options;
  if (!route.provider && options && typeof options.provider === 'string' && options.provider) route.provider = options.provider;
  if (!route.model && options && typeof options.model === 'string' && options.model) route.model = options.model;
  if (!route.reasoningEffort && options && typeof options.reasoningEffort === 'string' && options.reasoningEffort) {
    route.reasoningEffort = options.reasoningEffort;
  }
  if (!route.provider || !route.model) throw new Error('analysis_host_llm_route_unavailable');
  return route;
}

// The host pi-ai adapter emits both `text-delta` and `reasoning-delta` with a `text`
// field. Reasoning is NOT part of the model answer: concatenating it corrupts the JSON
// proposal. Only accept explicit text blocks/deltas; ignore reasoning and metadata.
const NON_TEXT_TYPES = new Set(['reasoning-delta', 'reasoning', 'thinking', 'thinking-delta']);
export function textOf(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (!chunk || typeof chunk !== 'object') return '';
  if (NON_TEXT_TYPES.has(chunk.type)) return '';
  if (chunk.type === 'text-delta' || chunk.type === 'text' || chunk.type === undefined) {
    if (typeof chunk.text === 'string') return chunk.text;
  }
  const delta = chunk.delta;
  if (delta && typeof delta === 'object') {
    if (typeof delta.text === 'string') return delta.text;
    if (typeof delta.content === 'string') return delta.content;
  }
  if (Array.isArray(chunk.content)) {
    return chunk.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/** Strip a single fenced code block only when it wraps the entire response. */
export function unwrapFence(text) {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return match ? match[1] : text;
}

/** Extract the raw proposal text from a streamed response, allowing an OpenAI-style envelope. */
export function responseText(raw) {
  const text = unwrapFence(raw.trim());
  try {
    const envelope = JSON.parse(text);
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return unwrapFence(content.trim());
  } catch { /* Not a JSON envelope; the raw text is the proposal. */ }
  return text;
}

/**
 * Build an Analyzer-compatible invoke function backed by the host's LLM service.
 *
 * Options:
 * - `llm`: the host service exposing `prepareCall(config, signal, configure)`.
 * - `agent`: the caller whose route is used; may be overridden per call via `invoke({agent})`.
 * - `timeoutMs` / `maxTokens`: forwarded to `prepareCall`.
 */
export function makeHostLlmAnalyzer({ llm, agent = null, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new Error('analysis_host_llm_unavailable');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('analysis_host_llm_invalid_max_tokens');

  return async function hostLlmInvoke({ instructions, input, signal, agent: callAgent } = {}) {
    signal?.throwIfAborted?.();
    const effectiveAgent = callAgent ?? agent;
    const route = routeFromAgent(effectiveAgent);
    const call = await llm.prepareCall({ ...route, maxTokens }, signal, (controls) => controls);
    const messages = [
      { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] },
    ];
    const stream = call.stream({ ...call.config, messages, system: instructions, signal });
    let raw = '';
    let size = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted?.();
      const text = textOf(chunk);
      if (!text) continue;
      size += Buffer.byteLength(text, 'utf8');
      if (size > MAX_RESPONSE_BYTES) throw new Error('analysis_response_exceeds_byte_limit');
      raw += text;
    }
    signal?.throwIfAborted?.();
    return responseText(raw);
  };
}
