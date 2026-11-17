/**
 * Host entry: assembles the runtime's native dependencies and mounts it as a Cordis plugin.
 *
 * ## What this file is, and is not
 *
 * `src/plugin.js` already returns a complete Cordis plugin (`name`/`inject`/`apply`/`drain`/`healthProbe`/
 * `describe`). What it cannot do is build its own dependencies — a store, an executor bound to the host
 * context, registered recipes, declared tasks. Those come from the embedding application, so this module
 * wires them and then delegates `apply(ctx)` to that plugin with the *host's* ctx, because that is the ctx
 * whose `tools` service must receive the registrations. No second plugin layer is introduced: a parallel
 * wrapper would only hide the real apply/dispose semantics behind a translation.
 *
 * ## Host contracts honoured here (each is an observed trap, not a guess)
 *
 * - Named exports only. `export default` would swallow the named family: the loader takes
 *   `default ?? exports`, so `inject` would silently disappear and the plugin would never activate.
 * - `apply` must not throw at top level — a throw there makes the plugin vanish with no trace. Assembly
 *   failures are caught and reported through the probe instead.
 * - The probe reports only what was actually wired. `disabled` and `not_configured` are states, not
 *   failures to hide, and a green probe never implies that work is possible.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuntimeStore } from './store.js';
import { HostExecutor } from './executor.js';
import { createExecutionRuntimePlugin } from './plugin.js';
import { createPatternResolver } from './pattern-resolver.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { csvNormalizeRecipe } from '../recipes/csv-normalize.js';
import { validateTask } from './contracts.js';

export const name = 'execution-runtime';
export const inject = ['tools'];

const RECIPES = Object.freeze({ 'json-normalize': jsonNormalizeRecipe, 'csv-normalize': csvNormalizeRecipe });

/** Assembly facts for this mount; never shared between two loads in one process. */
let facts = null;
let disposeInner = null;

/** A writable state directory, without assuming DSH_HOME exists. */
function stateRoot(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir) return resolve(config.stateDir);
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home ? join(home, 'execution-runtime') : join(process.cwd(), '.execution-runtime');
}

/**
 * Optional services are read through `ctx.get`. Reading them as properties throws "cannot get property
 * ... without inject", which fails activation for the whole plugin — one missing optional service would
 * take the required ones down with it.
 */
const optional = (ctx, key) => {
  try { return typeof ctx?.get === 'function' ? ctx.get(key) : undefined; } catch { return undefined; }
};

/** Reuse the host's own validator when it offers one; a hand-rolled check would drift from its schema. */
function argumentValidator(ctx) {
  const tools = ctx.tools;
  const found = [optional(ctx, 'validateSchemaValue'), tools?.validateArgs, tools?.validateArguments]
    .find((item) => typeof item === 'function');
  if (!found) return null;
  return ({ tool, arguments: args }) => found.call(tools ?? ctx, tool?.parameters, args);
}

export function apply(ctx, config = {}) {
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
    // The executor requires an explicit caller agent: the runtime must never dispatch as an anonymous
    // principal. It comes from config (the host's identified caller), never from a default.
    const agent = config?.agent ?? optional(ctx, 'agent') ?? null;
    if (!agent) throw new Error('execution runtime needs an explicit caller agent (config.agent).');
    const root = stateRoot(config);
    mkdirSync(root, { recursive: true });
    base.storePath = join(root, 'runtime.sqlite');
    store = new RuntimeStore(base.storePath);
    executor = new HostExecutor({ context: ctx, tools: ctx.tools, agent });

    const recipes = Object.values(RECIPES).filter((recipe) => config?.recipes?.[recipe.id] !== false);
    base.recipes = recipes.map((recipe) => `${recipe.id}@${recipe.version}`);

    // Tasks come from host config: the runtime executes a declared template, never an ad-hoc script.
    const tasks = {};
    for (const entry of Array.isArray(config?.tasks) ? config.tasks : []) {
      try { tasks[entry.taskId] = validateTask(entry); }
      catch (error) { logger?.warn?.(`skipped task ${entry?.taskId}: ${error?.code ?? error?.message}`); }
    }
    base.tasks = Object.keys(tasks).length;

    const supplied = argumentValidator(ctx);
    const resolvePattern = createPatternResolver({ store,
      patterns: Array.isArray(config?.patterns) ? config.patterns : [],
      approvals: Array.isArray(config?.approvals) ? config.approvals : [],
      automation: config?.automation ?? null });
    base.patterns = true;

    const inner = createExecutionRuntimePlugin({ store, recipes, tasks,
      validateArguments: supplied ?? (() => true), owner: ctx, resolvePattern });
    // Delegate with the host ctx: that is the ctx whose `tools` service must receive the registrations.
    disposeInner = inner.apply(ctx);
    base.state = 'ready';
    logger?.info?.(`execution runtime ready: ${base.recipes.join(', ')}; tasks=${base.tasks}`);
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
    try { await executor?.dispose?.(); } catch (error) { logger?.warn?.(`executor dispose failed: ${error?.message}`); }
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
