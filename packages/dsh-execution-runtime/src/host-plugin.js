/**
 * Host entry: assembles the runtime's native dependencies and mounts it as a Cordis plugin.
 *
 * ## What this file is, and is not
 *
 * `src/plugin.js` already returns a complete Cordis plugin (`name`/`inject`/`apply`/`drain`/`healthProbe`/
 * `describe`). What it cannot do is build its own dependencies 鈥?a store, an executor bound to the host
 * context, registered recipes, declared tasks. Those come from the embedding application, so this module
 * wires them and then delegates `apply(ctx)` to that plugin with the *host's* ctx, because that is the ctx
 * whose `tools` service must receive the registrations. No second plugin layer is introduced: a parallel
 * wrapper would only hide the real apply/dispose semantics behind a translation.
 *
 * ## Host contracts honoured here (each is an observed trap, not a guess)
 *
 * - Named exports only. `export default` would swallow the named family: the loader takes
 *   `default ?? exports`, so `inject` would silently disappear and the plugin would never activate.
 * - `apply` must not throw at top level 鈥?a throw there makes the plugin vanish with no trace. Assembly
 *   failures are caught and reported through the probe instead.
 * - The probe reports only what was actually wired. `disabled` and `not_configured` are states, not
 *   failures to hide, and a green probe never implies that work is possible.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeStore } from './store.js';
import { createOutboxDispatcher } from './outbox-dispatcher.js';
import { readRepairEvidence } from './repair-evidence-reader.js';
import { readArtifactEvidence } from './artifact-evidence-reader.js';
import { HostExecutor } from './executor.js';
import { RuntimeScheduler } from './scheduler.js';
import { createExecutionRuntimePlugin } from './plugin.js';
import { createPatternResolver } from './pattern-resolver.js';
import { createRecipeRegistry } from './recipe-factory.js';
import { createExecuteTool, createLibraryTool, createKnowledgeTool, createPatternTool, describePrimitivesTool }
  from './dynamic-tools.js';
import { createSagAdapter, resolveSagKey } from './knowledge-sag.js';
import { createValveWriter } from './valve-bridge.js';
import { createInterventionPolicy } from './intervention.js';
import { createWriteTools, createReplaceTool } from './write-tools.js';
import { createRecipeLibrary } from './recipe-library.js';
import { Analyzer } from './analyzer.js';
import { makeHostLlmAnalyzer } from './host-llm-analyzer.js';
import { AnalysisCoordinator } from './exceptions.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { jsonNormalizeRepairPolicy } from '../recipes/json-repair.js';
import { csvNormalizeRecipe } from '../recipes/csv-normalize.js';
import { validateTask, validateAcceptanceContract } from './contracts.js';
import { validateAuthoritySnapshot } from './store.js';

const freezeTree = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
};

export const name = 'execution-runtime';
export const inject = ['tools'];

const RECIPES = Object.freeze({ 'json-normalize': jsonNormalizeRecipe, 'csv-normalize': csvNormalizeRecipe });

/** Assembly facts for this mount; never shared between two loads in one process. */
let facts = null;
let disposeInner = null;
// Executors are created per invocation, so the mount keeps them to release handlers on unload.
const executors = [];

/** A writable state directory, without assuming DSH_HOME exists. */
function stateRoot(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir) return resolve(config.stateDir);
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home ? join(home, 'execution-runtime') : join(process.cwd(), '.execution-runtime');
}

/**
 * Optional services are read through `ctx.get`. Reading them as properties throws "cannot get property
 * ... without inject", which fails activation for the whole plugin 鈥?one missing optional service would
 * take the required ones down with it.
 */
const optional = (ctx, key) => {
  try { return typeof ctx?.get === 'function' ? ctx.get(key) : undefined; } catch { return undefined; }
};

/**
 * The admission layer calls the validator with a context object and expects a list of violation strings
 * (an empty list means valid). A boolean-returning check is rejected as an invalid result, so whatever the
 * host provides is normalized into that contract here.
 *
 * The host does not always expose a validator on `ctx`. In that case the host's own
 * `@deepseek-ai/dsh-tools` is loaded 鈥?preloaded during `apply`, so the value is available synchronously
 * when admission calls it later. Reimplementing schema checks here would drift from the host's schema
 * dialect, which is a known source of silent divergence.
 */
function makeValidator(validate) {
  if (typeof validate !== 'function') return null;
  return ({ tool, arguments: args }) => {
    const outcome = validate(tool?.parameters, args);
    if (Array.isArray(outcome)) return outcome.map(String);
    if (outcome === true || outcome === undefined) return [];
    if (outcome === false) return ['arguments did not satisfy the tool schema'];
    return ['the host validator returned an unusable result'];
  };
}

/** Load the host's own JSON-schema validator synchronously-compatible; null when unavailable. */
async function loadHostValidator(ctx) {
  const tools = ctx.tools;
  const direct = [optional(ctx, 'validateSchemaValue'), tools?.validateArgs, tools?.validateArguments]
    .find((item) => typeof item === 'function');
  if (direct) return (schema, value) => direct.call(tools ?? ctx, schema, value);
  for (const root of [process.env.DSH_HOST_ROOT, 'D:/dsh']) {
    if (typeof root !== 'string' || !root) continue;
    try {
      const require = createRequire(pathToFileURL(join(root, 'package.json')));
      const entry = require.resolve('@deepseek-ai/dsh-tools');
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.validateJsonSchemaValue === 'function') return module.validateJsonSchemaValue;
    } catch { /* try the next root */ }
  }
  return null;
}

/**
 * Load one host package synchronously, or return null.
 *
 * The same root assumption as `loadHostValidator`: the host install, not this package, owns its
 * `@deepseek-ai/*` dependencies. Cached because a message factory is looked up on every hint.
 */
const hostModuleCache = new Map();
function loadHostModule(specifier) {
  if (hostModuleCache.has(specifier)) return hostModuleCache.get(specifier);
  let resolved = null;
  for (const root of [process.env.DSH_HOST_ROOT, 'D:/dsh']) {
    if (typeof root !== 'string' || !root) continue;
    try {
      const require = createRequire(pathToFileURL(join(root, 'package.json')));
      resolved = require(specifier);
      break;
    } catch { /* try the next root */ }
  }
  hostModuleCache.set(specifier, resolved);
  return resolved;
}

/** One executor per call so the caller identity is the one the host just supplied. */
function makeExecutor(ctx, agent) {
  const executor = new HostExecutor({ context: ctx, tools: ctx.tools, agent });
  executors.push(executor);
  return executor;
}

/**
 * Build an analyzer from explicit HTTP configuration, or return null.
 *
 * An explicit endpoint+model+apiKey remains a valid override: when the host deliberately supplies all three,
 * that transport wins over the host LLM service. Without them this returns null so the host-LLM path can be
 * selected by the caller. It never degrades into a guess.
 */
function makeExplicitAnalyzer(config) {
  if (!config || typeof config !== 'object') return null;
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!endpoint || !model || !apiKey) return null;
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0
    ? Math.min(config.timeoutMs, 120_000) : 30_000;
  return new Analyzer({
    timeoutMs,
    // The analyzer passes a quoted, untrusted data blob; the transport must not add instructions of its own.
    invoke: async ({ instructions, input, signal }) => {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      const response = await fetch(endpoint, { method: 'POST', signal: combined,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: instructions },
          { role: 'user', content: JSON.stringify(input) }] }) });
      if (!response.ok) { controller.abort(); throw new Error('analysis transport failed'); }
      const reader = response.body?.getReader?.();
      if (!reader) { controller.abort(); throw new Error('analysis response stream unavailable'); }
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || (size += value.byteLength) > 65_536) {
            controller.abort();
            throw new Error('analysis response exceeds byte limit');
          }
          chunks.push(value);
        }
      } catch (error) {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      // Preserve raw proposal bytes for strict validation, including duplicate-key detection.
      let envelope;
      try { envelope = JSON.parse(raw); } catch { return raw; }
      return typeof envelope?.choices?.[0]?.message?.content === 'string'
        ? envelope.choices[0].message.content : raw;
    },
  });
}

/**
 * Build the knowledge channel from explicit configuration, or report it as unavailable.
 *
 * Unlike the analyzer, a missing key is still worth surfacing: the caller learns "not configured" from a
 * refusal that names the reason, rather than from a tool that silently does not exist. `enabled: false`
 * keeps it off entirely.
 */
function makeKnowledgeChannel(config) {
  if (!config || typeof config !== 'object' || config.enabled !== true) {
    return { adapter: null, endpoint: config?.endpoint ?? null };
  }
  const endpoint = typeof config.endpoint === 'string' && config.endpoint
    ? config.endpoint : 'http://127.0.0.1:24681';
  const resolved = typeof config.apiKey === 'string' && config.apiKey.trim()
    ? { key: config.apiKey.trim(), source: 'config' }
    : resolveSagKey();
  const adapter = createSagAdapter({ endpoint, apiKey: resolved.key,
    sagCmd: typeof config.sagCmd === 'string' && config.sagCmd ? config.sagCmd : 'sag' });
  return { adapter, endpoint };
}

/**
 * Build the valve write path, or report it as unavailable.
 *
 * ## Where the human gate actually is
 *
 * `valve-bridge.js` calls the host writer without a `human` flag and without a permit, and its comment reads
 * as though that proves the runtime cannot self-confirm. It does not. In this codebase `valves.confirm()` is
 * itself a human channel: it issues its own permit internally, so anything allowed to call it can write.
 * The defence is therefore in *which function the host passes in*, not in the call shape.
 *
 * This is why the writer is opt-in and must be given a function that has already decided how much autonomy
 * to grant. Passing `valves.confirm` wholesale hands the runtime the same authority a person has; passing a
 * wrapper that refuses when no human is present keeps the gate where the comment claims it is. The runtime
 * cannot tell the difference, so this note is the only place that distinction is recorded.
 */
function makeValveChannel(ctx, config) {
  if (!config || typeof config !== 'object' || config.enabled !== true) {
    return { writer: null, reason: 'disabled' };
  }
  // `confirmRule` may be supplied directly by the host, or taken from the mounted valves service.
  let confirmRule = typeof config.confirmRule === 'function' ? config.confirmRule : null;
  if (confirmRule === null) {
    const valves = optional(ctx, 'valves');
    confirmRule = typeof valves?.confirm === 'function' ? valves.confirm.bind(valves) : null;
  }
  if (confirmRule === null) return { writer: null, reason: 'no_valve_writer' };
  try {
    return { writer: createValveWriter({ confirmRule }), reason: null };
  } catch (error) {
    return { writer: null, reason: error?.code ?? 'invalid_valve_writer' };
  }
}

/** Monotonic suffix so fallback message ids stay unique within one process. */
let fallbackMessageCounter = 0;

/**
 * Build the user message this runtime injects, in the shape the host can persist.
 *
 * `additionalContexts` carries `UserMessage` values, and the session log validates every message event
 * strictly: a user message without a non-empty `id` makes the WHOLE session unreadable on the next load
 * (`<subject> lacks an identified message`). A rejected session is not a visible failure — it simply
 * disappears from history, which is the worst possible outcome for an advisory note.
 *
 * So the message is created through the host's own `createUserMessage`, which stamps the id and freezes the
 * value. When that module cannot be loaded, the fallback still supplies an id rather than emitting a shape
 * the host has never been promised to accept.
 */
export function createInjectedMessage(text) {
  const input = { source: { kind: 'plugin:execution-runtime' }, content: [{ type: 'text', text }] };
  try {
    const factory = loadHostModule('@deepseek-ai/dsh-llm')?.createUserMessage;
    if (typeof factory === 'function') return factory(input);
  } catch { /* fall through to the identified literal */ }
  fallbackMessageCounter += 1;
  return {
    id: `execution-runtime-hint-${Date.now().toString(36)}-${fallbackMessageCounter.toString(36)}`,
    role: 'user',
    ...input,
  };
}

/**
 * Subscribe to tool completions and offer help on a repeated failure.
 *
 * The hook mirrors the one this codebase already uses elsewhere: `tools/post-execute` receives
 * `(exec, result, next)`, and the listener runs `next()` to obtain the host's decision, then may append
 * `additionalContexts`. Appending is the whole mechanism — the runtime adds a note, never an instruction.
 *
 * Errors are swallowed on purpose. An intervention that throws would fail a tool call that already
 * succeeded, which is a far worse outcome than staying silent.
 */
function installIntervention(ctx, policy, base) {
  if (typeof ctx?.on !== 'function') return null;
  try {
    const dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        if (outcomeFailed(result) !== true) return decision;
        const verdict = policy.evaluate({
          agentId: exec?.agent?.id ?? exec?.agent?.name ?? 'default',
          tool: typeof exec?.name === 'string' ? exec.name : 'unknown',
          message: failureText(result),
        });
        base.interventionMetrics = policy.metrics();
        if (verdict.hint === undefined) return decision;
        // Offer, not instruct: the note is appended as context and the host decides what to do with it.
        return { ...decision,
          additionalContexts: [...(decision?.additionalContexts ?? []),
            createInjectedMessage(verdict.hint)] };
      } catch {
        return decision;
      }
    });
    return typeof dispose === 'function' ? dispose : null;
  } catch {
    // A host without a post-execute channel simply does not get intervention; everything else still works.
    base.intervention = 'unsupported';
    return null;
  }
}

/**
 * Whether a tool result reports failure.
 *
 * There are two shapes, and missing either one makes the runtime blind to a whole class of failures:
 *
 * 1. `isError: true` — the tool itself failed; the reason is in `error.message` or the content text.
 * 2. `isError: false` with a non-zero `value.exitCode` — the tool ran fine and the *command* failed. This is
 *    how a shell tool reports a failing command, and it is the common case in practice.
 *
 * Only checking the first shape looks correct and never intervenes on shell failures. That was the actual
 * behaviour before this fix: CLIS spoke on a repeated pwsh failure while this runtime stayed silent on the
 * same event, in the same session — which is how the gap was found.
 */
function outcomeFailed(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.isError === true) return true;
  if (result.kind === 'deny' || result.kind === 'error') return true;
  // A command failed although the tool succeeded. A signalled process counts as cancelled, not failed.
  const exitCode = result.value?.exitCode;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0
    && (result.value?.signal === undefined || result.value?.signal === null)) return true;
  return false;
}

/** The most specific failure text available, bounded so one huge error cannot flood the policy. */
function failureText(result) {
  const parts = [];
  if (typeof result?.error?.message === 'string') parts.push(result.error.message);
  if (typeof result?.error?.info?.message === 'string') parts.push(result.error.info.message);
  if (typeof result?.error?.code === 'string') parts.push(result.error.code);
  // A non-zero exit carries no message of its own; the command's own output is the reason.
  const exitCode = result?.value?.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) parts.push(`exit code ${exitCode}`);
  if (typeof result?.value?.stderr?.text === 'string') parts.push(result.value.stderr.text);
  if (Array.isArray(result?.content)) {
    for (const part of result.content) if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.join(' ').slice(0, 2_000);
}

export async function apply(ctx, config = {}) {
  const logger = optional(ctx, 'logger')?.('execution-runtime') ?? null;
  const base = { enabled: config?.enabled === true, loadError: null, recipes: [], tasks: 0, rejectedAcceptanceTasks: 0, patterns: false };
  facts = base;
  disposeInner = null;
  let store = null;
  let registeredTasks = [];
  let disposeStatus = null;
  let stopOutbox = null;
  const operationalStatus = () => {
    const analysis = ['disabled', 'configured', 'configured_explicit'].includes(base.analysis) ? base.analysis : 'unknown';
    const states = ['identity_unavailable', 'receiver_unavailable', 'dispatching', 'pending', 'ready', 'error'];
    const state = states.includes(base.outbox?.state) ? base.outbox.state : 'unknown';
    const pass = base.outbox?.lastPass;
    const keys = ['attempted', 'acknowledged', 'duplicates', 'retried', 'skipped'];
    const valid = pass && keys.every((key) => Number.isSafeInteger(pass[key]) && pass[key] >= 0)
      && typeof pass.unavailable === 'boolean';
    return { analysis: { configuration: analysis, invocation: 'unknown' },
      outbox: { startup: state === 'identity_unavailable' ? 'unavailable' : state === 'unknown' ? 'unknown' : 'started',
        state, lastPass: valid ? { ...Object.fromEntries(keys.map((key) => [key, pass[key]])),
          unavailable: pass.unavailable } : null } };
  };
  const statusService = Object.freeze({
    snapshot({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return { state: 'error', error: 'invalid_snapshot_limit' };
      }
      if (base.state === 'disabled') return { state: 'disabled' };
      if (base.state === 'failed') return { state: 'error', error: 'runtime_assembly_failed' };
      if (base.state !== 'ready' || store === null) return { state: 'unavailable' };
      try {
        const result = store.snapshotRuns({ limit });
        return { state: 'ready', ...result, ...operationalStatus(),
          registeredTasks: { taskIds: registeredTasks.slice(0, limit), truncated: registeredTasks.length > limit },
          runs: result.runs.map((run) => ({ ...run, registered: registeredTasks.includes(run.taskId) })) };
      } catch {
        return { state: 'error', error: 'snapshot_failed' };
      }
    },
  });
  // This optional service is independent of the tool registry and never exposes the store handle.
  try {
    if (typeof ctx?.provide === 'function') disposeStatus = ctx.provide('executionRuntimeStatus', statusService);
  } catch (error) {
    logger?.warn?.(`status service unavailable: ${error?.message}`);
  }

  if (config?.enabled !== true) {
    base.state = 'disabled';
    logger?.info?.('execution runtime mounted with enabled:false; no tool is registered.');
    return async () => { base.state = 'unloaded'; if (typeof disposeStatus === 'function') await disposeStatus(); };
  }

  let executor = null;
  const mountedDisposers = [];
  disposeInner = async () => {
    for (const dispose of mountedDisposers.splice(0).reverse()) {
      try { await dispose(); } catch { /* Drain every owned registration even after a partial mount. */ }
    }
  };
  try {
    const root = stateRoot(config);
    mkdirSync(root, { recursive: true });
    base.storePath = join(root, 'runtime.sqlite');
    store = new RuntimeStore(base.storePath);
    // The host passes the calling agent on every tool invocation (`exec.agent`). Binding an executor to a
    // configured agent would let one caller's task run under another's authority, so the executor is built
    // per call by the task factory below instead of once here.
    executor = null;

    const recipes = Object.values(RECIPES).filter((recipe) => config?.recipes?.[recipe.id] !== false);
    base.recipes = recipes.map((recipe) => `${recipe.id}@${recipe.version}`);

    // Task factories are native closures: each returns the prepared task plus the authority it may use, and
    // the runtime refuses anything the factory does not grant. They are declared in host config because a
    // model must never widen its own authority.
    const tasks = Object.create(null);
    const registrations = new Map();
    for (const entry of Array.isArray(config?.tasks) ? config.tasks : []) {
      try {
        const template = freezeTree(validateTask(entry));
        let acceptanceBinding;
        let canonicalRoot;
        if (Object.hasOwn(entry, 'acceptanceContract')) {
          const contract = validateAcceptanceContract(entry.acceptanceContract);
          canonicalRoot = realpathSync(template.workspaceRoot);
          if (canonicalRoot !== realpathSync(config?.workspaceRoot ?? process.cwd())) {
            throw new Error('Acceptance task workspace must match the host workspace.');
          }
          acceptanceBinding = Object.freeze({ nativeRef: template.taskId,
            contract: Object.freeze({ ...contract, predicate: Object.freeze(contract.predicate), output: Object.freeze(contract.output) }) });
        }
        const autoRepair = entry.autoRepair === true;
        const allowedTools = freezeTree(structuredClone(Array.isArray(entry.allowedTools) ? entry.allowedTools : []));
        let authority = null;
        if (acceptanceBinding) {
          try {
            authority = freezeTree(validateAuthoritySnapshot({ schemaVersion: 1, scopeRef: template.scopeRef,
              workspaceRoot: canonicalRoot, allowedTools }));
          } catch { /* Invalid authority remains unavailable to diagnosis and dispatch. */ }
        }
        const registration = freezeTree({ task: template, autoRepair, acceptanceBinding: acceptanceBinding ?? null,
          authority, canonicalRoot: canonicalRoot ?? null });
        registrations.set(template.taskId, registration);
        tasks[template.taskId] = async ({ agent }) => {
          // A fresh executor per call: the caller identity is the one the host handed to this invocation.
          const scoped = new HostExecutor({ context: ctx, tools: ctx.tools, agent });
          executors.push(scoped);
          return { task: registration.task, autoRepair: registration.autoRepair,
            ...(registration.acceptanceBinding ? { acceptanceBinding: registration.acceptanceBinding } : {}),
            authority: { scopeRef: registration.task.scopeRef, workspaceRoot: registration.task.workspaceRoot, allowedTools, agent } };
        };
      } catch (error) {
        if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'acceptanceContract')) base.rejectedAcceptanceTasks++;
        logger?.warn?.(`skipped task ${entry?.taskId}: ${error?.code ?? error?.message}`);
      }
    }
    registeredTasks = Object.keys(tasks).sort();
    base.tasks = registeredTasks.length;

    const supplied = makeValidator(await loadHostValidator(ctx));
    base.validator = supplied === null ? 'none' : 'host';
    if (supplied === null) {
      const failure = new Error('The host schema validator is unavailable.');
      failure.code = 'schema_validator_unavailable';
      throw failure;
    }
    const resolvePattern = createPatternResolver({ store,
      patterns: Array.isArray(config?.patterns) ? config.patterns : [],
      approvals: Array.isArray(config?.approvals) ? config.approvals : [],
      automation: config?.automation ?? null });
    base.patterns = true;

    // Analysis needs a reasoning transport. Explicit HTTP config still wins as an override; otherwise the
    // host's own LLM service is used, so no separate endpoint/model/apiKey is required. With neither, the
    // deterministic path keeps working and analysis stays explicitly off.
    const analysisConfig = config?.analysis;
    const timeoutMs = Number.isSafeInteger(analysisConfig?.timeoutMs) && analysisConfig.timeoutMs > 0
      ? Math.min(analysisConfig.timeoutMs, 120_000) : 30_000;
    const explicitAnalyzer = makeExplicitAnalyzer(analysisConfig);
    const hostLlm = analysisConfig?.enabled === false ? null : optional(ctx, 'llm');
    const hostLlmAvailable = hostLlm !== null && typeof hostLlm?.prepareCall === 'function';
    let analyzer = null;
    let analysisMode = 'disabled';
    if (explicitAnalyzer !== null) {
      analyzer = explicitAnalyzer;
      analysisMode = 'configured_explicit';
    } else if (hostLlmAvailable) {
      try {
        const invoke = makeHostLlmAnalyzer({ llm: hostLlm, agent: config?.agent ?? null });
        analyzer = new Analyzer({ timeoutMs, invoke });
        analysisMode = 'configured';
      } catch { /* A malformed host service leaves analysis off rather than failing the whole mount. */ }
    }
    base.analysis = analysisMode;
    const allowDynamicAnalysis = analysisConfig?.allowDynamic === true;
    // The dynamic path receives the caller's agent per invocation; build its analyzer at that point so the
    // LLM route follows the current caller. An explicit HTTP transport is agent-independent and is reused.
    const dynamicAnalyzerFor = (agent) => {
      if (analysisMode === 'configured_explicit') return analyzer;
      if (analysisMode !== 'configured') return null;
      try {
        return new Analyzer({ timeoutMs,
          invoke: makeHostLlmAnalyzer({ llm: hostLlm, agent: agent ?? config?.agent ?? null }) });
      } catch { return null; }
    };

    // Only native tasks can use the existing replacement policy. The host owns the replacement tool.
    const nativeRecipes = recipes.map((recipe) => recipe === jsonNormalizeRecipe
      ? { ...recipe, repairPolicy: jsonNormalizeRepairPolicy } : recipe);
    const getRegistrationSnapshot = (taskId) => {
      const registration = registrations.get(taskId);
      if (!registration?.acceptanceBinding || !registration.authority) return null;
      try {
        if (realpathSync(registration.task.workspaceRoot) !== registration.canonicalRoot) return null;
        return registration;
      } catch { return null; }
    };
    const inner = createExecutionRuntimePlugin({ store, recipes: nativeRecipes, tasks,
      validateArguments: supplied, owner: ctx, resolvePattern, analyzer, getRegistrationSnapshot,
      getOperationalStatus: operationalStatus });
    // Delegate with the host ctx: that is the ctx whose `tools` service must receive the registrations.
    const innerDispose = inner.apply(ctx);
    if (typeof innerDispose === 'function') mountedDisposers.push(innerDispose);

    // The general path: a caller may describe a task at runtime instead of naming a declared template.
    // It shares the same store and mount authority, so nothing about scope or effects widens.
    const dynamicRegistry = createRecipeRegistry();
    for (const recipe of recipes) dynamicRegistry.register(recipe);
    const toolEffects = Object.fromEntries(recipes.flatMap((recipe) =>
      Object.entries(recipe.toolEffects ?? {})));
    const mount = { scopeRef: config?.scopeRef ?? 'execution-runtime',
      workspaceRoot: config?.workspaceRoot ?? process.cwd(),
      allowedTools: Object.keys(toolEffects) };
    // The host creates the library using this store's own database handle. Fix the binding mode at
    // assembly time; later missing or changed rows must fail in the store's atomic identity check.
    const library = store?.withDatabase ? store.withDatabase((db) => createRecipeLibrary({ db })) : null;
    const bindGeneratedRecipes = library !== null;
    base.recipeLibrary = bindGeneratedRecipes;
    const schedulerFactory = (agent, registry) => new RuntimeScheduler({ store,
      executor: makeExecutor(ctx, agent), tools: ctx.tools,
      recipes: registry.list().map((key) => registry.get(key)),
      validateArguments: supplied, bindGeneratedRecipes });

    // The knowledge channel is opt-in: it reaches outside the runtime into the SAG index, which is a
    // deployment decision, not a default. When it is not configured the tool still registers but refuses
    // with a reason, so a caller learns why instead of seeing an empty result.
    const knowledge = makeKnowledgeChannel(config?.knowledge);
    base.knowledge = knowledge.adapter === null ? 'disabled' : 'configured';

    // The valve write path is opt-in for the reason spelled out on makeValveChannel: the runtime cannot tell
    // an autonomous writer from a human-gated one, so the host has to decide which it is handing over.
    const valve = makeValveChannel(ctx, config?.valves);
    base.valves = valve.writer === null ? valve.reason : 'configured';

    // Intervention makes the runtime's existence known at the moment a caller is in trouble. It offers
    // context and stops there: deciding whether to use the runtime stays with the host.
    const intervention = createInterventionPolicy({
      threshold: Number.isSafeInteger(config?.intervention?.threshold) ? config.intervention.threshold : 2,
    });
    base.intervention = config?.intervention?.enabled === false ? 'disabled' : 'enabled';
    const interventionDispose = config?.intervention?.enabled === false
      ? null : installIntervention(ctx, intervention, base);
    if (typeof interventionDispose === 'function') mountedDisposers.push(interventionDispose);

    // A recipe's candidate names a tool (`runtime_write_json`). Admission resolves that name
    // through the host registry and fails closed at `tool_not_visible` when nothing registered
    // it -- which is what happened until now: every generated task was denied before it could
    // run, so the runtime never produced a single successful sample. Registering the write
    // tools closes that half of the contract. They stay inside the same mount scope.
    const writeTools = createWriteTools({ root: mount.workspaceRoot });
    for (const tool of writeTools) {
      const disposeTool = ctx.tools?.register?.(tool);
      if (typeof disposeTool !== 'function') throw new Error(`The host did not accept ${tool.name}.`);
      mountedDisposers.push(disposeTool);
    }
    base.writeTools = writeTools.map((tool) => tool.name).filter(() => base.writeToolsError === undefined);

    // The bounded in-place replacement tool is opt-in: only the host may enable it, and enabling it
    // registers the tool but grants no authority by itself. Admission still checks the task template's
    // declared `allowedTools` and the native repair policy's strict schema, so a template that does not
    // name `runtime_replace_json` cannot use it even after registration. config.repair.replaceTool is a
    // pure registration flag, never an authority widener.
    base.replaceTool = 'disabled';
    if (config?.repair?.replaceTool === true) {
      const replaceTool = createReplaceTool({ root: mount.workspaceRoot });
      const disposeReplace = ctx.tools?.register?.(replaceTool);
      if (typeof disposeReplace !== 'function') throw new Error(`The host did not accept ${replaceTool.name}.`);
      mountedDisposers.push(disposeReplace);
      base.replaceTool = 'registered';
    }

    const dynamicTools = [
      createExecuteTool({ store, schedulerFor: schedulerFactory, toolEffects, mount,
        registry: dynamicRegistry, library, analyzeRun: async ({ taskId, authority, signal }) => {
          if (!allowDynamicAnalysis) return { status: 'analysis_disabled' };
          const scopedAnalyzer = dynamicAnalyzerFor(authority.agent);
          if (scopedAnalyzer === null) return { status: 'analysis_unavailable' };
          const coordinator = new AnalysisCoordinator({ store, analyzer: scopedAnalyzer, agent: authority.agent, resolvePattern });
          const result = await coordinator.analyze(taskId, { authority, signal });
          return { status: result.status, analysisId: result.analysisId ?? null,
            route: coordinator.lastRoute?.route ?? null };
        } }),
      createLibraryTool({ library, store }),
      createKnowledgeTool({ adapter: knowledge.adapter, endpoint: knowledge.endpoint }),
      createPatternTool({ valveWriter: valve.writer, patterns: Array.isArray(config?.patterns) ? config.patterns : [],
        reason: valve.reason }),
      describePrimitivesTool,
    ];
    for (const tool of dynamicTools) {
      const disposeTool = ctx.tools?.register?.(tool);
      if (typeof disposeTool !== 'function') throw new Error(`The host did not accept ${tool.name}.`);
      mountedDisposers.push(disposeTool);
    }
    base.dynamicTools = Array.isArray(base.dynamicTools) ? base.dynamicTools : [];
    base.dynamicTools = ['runtime_execute', 'runtime_recipes', 'runtime_knowledge', 'runtime_pattern', 'runtime_verifiers']
      .filter((name) => !base.dynamicToolsError);
    base.mount = { scopeRef: mount.scopeRef, workspaceRoot: mount.workspaceRoot,
      allowedTools: mount.allowedTools };
    base.state = 'ready';
    // A database-scoped identity is required for receiver-side deduplication across restarts.
    let producerId = null;
    try { producerId = store.getProducerId?.(); } catch { /* Keep delivery unavailable. */ }
    base.outbox = { state: 'identity_unavailable', lastPass: null };
    if (typeof producerId === 'string' && producerId.trim()) {
      // Only this mount selects the database. Review opens a read-only snapshot, never another store.
      const runtimeFilePath = base.storePath;
      const refusal = (status, reason) => ({ status, reason, governanceEligible: false,
        goalProof: 'not_evaluated', principleAttribution: 'not_evaluated' });
      const evidenceService = Object.freeze({
        producerId,
        readRepairEvidence(request) {
          if (base.state !== 'ready') return refusal('error', 'runtime_unavailable');
          if (!request || typeof request !== 'object' || Array.isArray(request)
            || Reflect.ownKeys(request).length !== 2
            || !Object.hasOwn(request, 'producerId') || !Object.hasOwn(request, 'eventId')) {
            return refusal('error', 'invalid_request');
          }
          if (request.producerId !== producerId) return refusal('mismatch', 'producer_id_mismatch');
          return readRepairEvidence({ runtimeFilePath, producerId, eventId: request.eventId });
        },
        readRepairArtifacts(request) {
          const identity = evidenceService.readRepairEvidence(request);
          if (identity.status !== 'match') return identity;
          return { ...identity, artifacts: readArtifactEvidence({ workspaceRoot: mount.workspaceRoot,
            evidenceRefs: identity.payload.evidence.evidenceRefs }) };
        },
      });
      // Publish before the first dispatch so a receiver can resolve evidence during delivery.
      try {
        if (typeof ctx?.provide === 'function') {
          const disposeEvidence = ctx.provide('executionRuntimeEvidence', evidenceService);
          if (typeof disposeEvidence === 'function') mountedDisposers.push(disposeEvidence);
        }
      } catch (error) {
        logger?.warn?.(`evidence service unavailable: ${error?.message}`);
      }
      const intervalMs = Number.isSafeInteger(config?.outbox?.intervalMs)
        ? Math.max(10, Math.min(config.outbox.intervalMs, 300_000)) : 5_000;
      const limit = Number.isSafeInteger(config?.outbox?.limit)
        ? Math.max(1, Math.min(config.outbox.limit, 100)) : 20;
      const dispatcher = createOutboxDispatcher({ store, producerId, limit, logger,
        receiver: async (message) => {
          const valves = optional(ctx, 'valves');
          if (typeof valves?.receiveRepairEvent !== 'function') throw new Error('receiver_unavailable');
          const result = await valves.receiveRepairEvent(message);
          if (!result || typeof result !== 'object' || Array.isArray(result)
            || (result.eventId !== undefined && result.eventId !== message.eventId)) return null;
          if (result.accepted === true && result.duplicate === false) {
            return { eventId: message.eventId, status: 'accepted' };
          }
          if (result.accepted === false && result.duplicate === true) {
            return { eventId: message.eventId, status: 'duplicate' };
          }
          return null;
        } });
      let stopped = false;
      let active = null;
      const run = () => {
        if (stopped || active) return active;
        if (typeof optional(ctx, 'valves')?.receiveRepairEvent !== 'function') {
          base.outbox = { state: 'receiver_unavailable', lastPass: base.outbox.lastPass };
          return null;
        }
        base.outbox = { ...base.outbox, state: 'dispatching' };
        active = dispatcher.dispatchOnce().then((lastPass) => {
          // A successful bounded batch does not prove that the remaining queue is empty.
          const remaining = store.listPendingOutbox({ limit: 1 });
          if (!Array.isArray(remaining)) throw new TypeError('Outbox listing must return an array.');
          base.outbox = { state: lastPass.retried || lastPass.skipped || remaining.length ? 'pending' : 'ready', lastPass };
        }).catch(() => { base.outbox = { ...base.outbox, state: 'error' }; })
          .finally(() => { active = null; });
        return active;
      };
      const timer = setInterval(run, intervalMs);
      timer.unref?.();
      stopOutbox = async () => { stopped = true; clearInterval(timer); if (active) await active; };
      run();
    }
    logger?.info?.(`execution runtime ready: ${base.recipes.join(', ')}; tasks=${base.tasks}`
      + `; dynamic tools=${base.dynamicTools.join(',') || 'none'}; intervention=${base.intervention}`);
  } catch (error) {
    // Never rethrow: an apply() throw makes the plugin disappear with no trace.
    base.state = 'failed';
    base.loadError = error?.code ?? error?.message ?? String(error);
    logger?.error?.(`execution runtime assembly failed: ${base.loadError}`);
    await disposeInner?.();
    disposeInner = null;
  }

  /** Release everything this mount owns, in order, and never throw out of a disposer. */
  const release = async () => {
    base.state = 'unloading';
    try { if (typeof disposeStatus === 'function') { const dispose = disposeStatus; disposeStatus = null; await dispose(); } }
    catch (error) { logger?.warn?.(`status dispose failed: ${error?.message}`); }
    try { if (typeof disposeInner === 'function') await disposeInner(); }
    catch (error) { logger?.warn?.(`inner dispose failed: ${error?.message}`); }
    for (const item of executors.splice(0)) {
      try { await item.dispose?.(); } catch (error) { logger?.warn?.(`executor dispose failed: ${error?.message}`); }
    }
    try { await stopOutbox?.(); } catch (error) { logger?.warn?.(`outbox drain failed: ${error?.message}`); }
    try { store?.close?.(); } catch (error) { logger?.warn?.(`store close failed: ${error?.message}`); }
    base.state = 'unloaded';
  };

  // The host drives disposal through `ctx.effect`; without it the SQLite handle outlives the plugin and a
  // later removal of the state directory fails with EBUSY.
  if (typeof ctx.effect === 'function') ctx.effect(() => release);
  return release;
}

/**
 * The probe reports the assembly facts, not the plugin's runtime counters: those live in the plugin's own
 * probe, and duplicating them here would let the two disagree.
 */
export const healthProbe = {
  probe() {
    if (facts === null) {
      return { plugin: 'execution-runtime', status: 'degraded',
        findings: [{ code: 'execution-runtime.not-applied', severity: 'warn',
          message: 'The host entry was never applied in this process.' }] };
    }
    const findings = [];
    if (facts.state === 'failed') {
      findings.push({ code: 'execution-runtime.load-failed', severity: 'error',
        message: `Assembly failed: ${facts.loadError}` });
    }
    if (facts.state === 'disabled') {
      findings.push({ code: 'execution-runtime.disabled', severity: 'info',
        message: 'Declared enabled:false. Set enabled:true with a task to dispatch work.' });
    }
    if (facts.state === 'ready' && facts.tasks === 0) {
      findings.push({ code: 'execution-runtime.no-tasks', severity: 'info',
        message: 'Ready, but no task is declared: runtime_run will refuse until one is configured.' });
    }
    const acceptanceDegraded = facts.state === 'ready' && facts.rejectedAcceptanceTasks > 0;
    if (acceptanceDegraded) {
      findings.push({ code: 'execution-runtime.acceptance-unavailable', severity: 'warn',
        message: `${facts.rejectedAcceptanceTasks} task(s) with acceptance contracts were not registered.` });
    }
    const outboxDegraded = facts.state === 'ready'
      && ['error', 'receiver_unavailable', 'identity_unavailable'].includes(facts.outbox?.state);
    if (outboxDegraded) {
      findings.push({ code: 'execution-runtime.outbox-unavailable', severity: 'warn',
        message: `Repair event delivery is unavailable: ${facts.outbox.state}.` });
    }
    return { plugin: 'execution-runtime', status: facts.state === 'failed' ? 'error' : outboxDegraded || acceptanceDegraded ? 'degraded' : 'ok',
      findings, facts: { ...facts } };
  },
};

/**
 * The plugin object, also exported as `default` because that is how the host loads a plugin module:
 * `const { default: plugin } = await import(entry)`. Without a default the loader falls back to the module
 * namespace, whose `href` is not a service, and activation fails with
 * "cannot get property href without inject".
 *
 * A default export is normally a trap here (it can swallow the named family), but this object is built
 * explicitly from the three fields a plugin needs, and every named export above stays reachable.
 */
export const plugin = Object.freeze({ name, inject, apply, healthProbe });
export default plugin;
