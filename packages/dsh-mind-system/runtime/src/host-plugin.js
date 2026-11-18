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
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeStore } from './store.js';
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
import { createRecipeLibrary } from './recipe-library.js';
import { Analyzer } from './analyzer.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { csvNormalizeRecipe } from '../recipes/csv-normalize.js';
import { validateTask } from './contracts.js';

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

/** One executor per call so the caller identity is the one the host just supplied. */
function makeExecutor(ctx, agent) {
  const executor = new HostExecutor({ context: ctx, tools: ctx.tools, agent });
  executors.push(executor);
  return executor;
}

/**
 * Build an analyzer from explicit host configuration, or return null.
 *
 * The transport is HTTP-and-key based rather than "whatever client happens to be around": analysis sends a
 * task's exception package to a remote model, and that has to be a deliberate, visible configuration
 * decision. A missing endpoint or key means analysis is off 鈥?not degraded into a guess.
 */
function makeAnalyzer(config) {
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
    invoke: async (packageJson, { signal } = {}) => {
      const response = await fetch(endpoint, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: packageJson }] }) });
      if (!response.ok) throw new Error(`analysis transport failed: ${response.status}`);
      return response.text();
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
            { source: { kind: 'plugin:execution-runtime' }, content: [{ type: 'text', text: verdict.hint }] }] };
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

/** Whether a tool result reports failure, read the way the host reports it. */
function outcomeFailed(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.isError === true) return true;
  // The tool runtime reports policy denials through a decision kind rather than isError.
  return result.kind === 'deny' || result.kind === 'error';
}

/** The most specific failure text available, bounded so one huge error cannot flood the policy. */
function failureText(result) {
  const parts = [];
  if (typeof result?.error?.message === 'string') parts.push(result.error.message);
  if (typeof result?.error?.code === 'string') parts.push(result.error.code);
  if (Array.isArray(result?.content)) {
    for (const part of result.content) if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.join(' ').slice(0, 2_000);
}

export async function apply(ctx, config = {}) {
  const logger = optional(ctx, 'logger')?.('execution-runtime') ?? null;
  const base = { enabled: config?.enabled === true, loadError: null, recipes: [], tasks: 0, patterns: false };
  facts = base;
  disposeInner = null;

  if (config?.enabled !== true) {
    // Mounting while disabled is deliberate: register nothing rather than a half-usable tool.
    base.state = 'disabled';
    logger?.info?.('execution runtime mounted with enabled:false; no tool is registered.');
    return () => {};
  }

  let store = null;
  let executor = null;
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
    const tasks = {};
    for (const entry of Array.isArray(config?.tasks) ? config.tasks : []) {
      try {
        const template = validateTask(entry);
        tasks[entry.taskId] = async ({ agent }) => {
          // A fresh executor per call: the caller identity is the one the host handed to this invocation.
          const scoped = new HostExecutor({ context: ctx, tools: ctx.tools, agent });
          executors.push(scoped);
          return { task: template, authority: { scopeRef: template.scopeRef, workspaceRoot: template.workspaceRoot,
            allowedTools: Array.isArray(entry.allowedTools) ? entry.allowedTools : [],
            agent } };
        };
      } catch (error) { logger?.warn?.(`skipped task ${entry?.taskId}: ${error?.code ?? error?.message}`); }
    }
    base.tasks = Object.keys(tasks).length;

    const supplied = makeValidator(await loadHostValidator(ctx));
    base.validator = supplied === null ? 'none' : 'host';
    const resolvePattern = createPatternResolver({ store,
      patterns: Array.isArray(config?.patterns) ? config.patterns : [],
      approvals: Array.isArray(config?.approvals) ? config.approvals : [],
      automation: config?.automation ?? null });
    base.patterns = true;

    // Analysis needs a reasoning transport. It stays off unless the host explicitly supplies one, because
    // a coordinator without a provider would only manufacture "unavailable" records. The deterministic
    // path keeps working either way.
    const analyzer = makeAnalyzer(config?.analysis);
    base.analysis = analyzer === null ? 'disabled' : 'configured';

    const inner = createExecutionRuntimePlugin({ store, recipes, tasks,
      validateArguments: supplied ?? (() => true), owner: ctx, resolvePattern, analyzer });
    // Delegate with the host ctx: that is the ctx whose `tools` service must receive the registrations.
    const innerDispose = inner.apply(ctx);

    // The general path: a caller may describe a task at runtime instead of naming a declared template.
    // It shares the same store and mount authority, so nothing about scope or effects widens.
    const dynamicRegistry = createRecipeRegistry();
    for (const recipe of recipes) dynamicRegistry.register(recipe);
    const toolEffects = Object.fromEntries(recipes.flatMap((recipe) =>
      Object.entries(recipe.toolEffects ?? {})));
    const mount = { scopeRef: config?.scopeRef ?? 'execution-runtime',
      workspaceRoot: config?.workspaceRoot ?? process.cwd(),
      allowedTools: Object.keys(toolEffects) };
    const schedulerFactory = (agent, registry) => new RuntimeScheduler({ store,
      executor: makeExecutor(ctx, agent), tools: ctx.tools,
      recipes: registry.list().map((key) => registry.get(key)),
      validateArguments: supplied ?? (() => true) });
    // The library lives in the same database as the runs, so one file carries both what happened and what
    // was learned. It is created through the store's scoped accessor rather than holding the handle.
    const library = store?.withDatabase ? store.withDatabase((db) => createRecipeLibrary({ db })) : null;
    base.recipeLibrary = library !== null;

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

    const dynamicDisposers = [];
    const dynamicTools = [
      createExecuteTool({ store, schedulerFor: schedulerFactory, toolEffects, mount,
        registry: dynamicRegistry, library }),
      createLibraryTool({ library }),
      createKnowledgeTool({ adapter: knowledge.adapter, endpoint: knowledge.endpoint }),
      createPatternTool({ valveWriter: valve.writer, patterns: Array.isArray(config?.patterns) ? config.patterns : [],
        reason: valve.reason }),
      describePrimitivesTool,
    ];
    for (const tool of dynamicTools) {
      const disposeTool = ctx.tools?.register?.(tool);
      if (typeof disposeTool === 'function') dynamicDisposers.push(disposeTool);
      else base.dynamicToolsError = 'the host did not accept a dynamic tool';
    }
    base.dynamicTools = Array.isArray(base.dynamicTools) ? base.dynamicTools : [];
    base.dynamicTools = ['runtime_execute', 'runtime_recipes', 'runtime_knowledge', 'runtime_pattern', 'runtime_verifiers']
      .filter((name) => !base.dynamicToolsError);
    base.mount = { scopeRef: mount.scopeRef, workspaceRoot: mount.workspaceRoot,
      allowedTools: mount.allowedTools };
    disposeInner = async () => {
      for (const disposeTool of dynamicDisposers.splice(0)) {
        try { disposeTool(); } catch { /* a failed tool removal must not block unload */ }
      }
      // The post-execute subscription must also go: a listener left behind after unload would keep hinting
      // for a runtime that no longer exists.
      try { interventionDispose?.(); } catch { /* same reasoning as above */ }
      await innerDispose?.();
    };
    base.state = 'ready';
    logger?.info?.(`execution runtime ready: ${base.recipes.join(', ')}; tasks=${base.tasks}`
      + `; dynamic tools=${base.dynamicTools.join(',') || 'none'}; intervention=${base.intervention}`);
  } catch (error) {
    // Never rethrow: an apply() throw makes the plugin disappear with no trace.
    base.state = 'failed';
    base.loadError = error?.code ?? error?.message ?? String(error);
    logger?.error?.(`execution runtime assembly failed: ${base.loadError}`);
    disposeInner = null;
  }

  /** Release everything this mount owns, in order, and never throw out of a disposer. */
  const release = async () => {
    base.state = 'unloading';
    try { if (typeof disposeInner === 'function') await disposeInner(); }
    catch (error) { logger?.warn?.(`inner dispose failed: ${error?.message}`); }
    for (const item of executors.splice(0)) {
      try { await item.dispose?.(); } catch (error) { logger?.warn?.(`executor dispose failed: ${error?.message}`); }
    }
    try { store?.close?.(); } catch (error) { logger?.warn?.(`store close failed: ${error?.message}`); }
    base.state = 'unloaded';
  };

  // The host drives disposal through `ctx.effect`; without it the SQLite handle outlives the plugin and a
  // later removal of the state directory fails with EBUSY.
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { void release(); });
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
    return { plugin: 'execution-runtime', status: facts.state === 'failed' ? 'error' : 'ok',
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
