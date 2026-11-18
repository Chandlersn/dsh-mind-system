import { RuntimeContractError, requireString } from './contracts.js';
import { HostExecutor } from './executor.js';
import { RuntimeScheduler } from './scheduler.js';
import { AnalysisCoordinator } from './exceptions.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Wrap the isolated runtime as a real Cordis plugin. The plugin never accepts an executable callback,
 * workspace, goal, or verifier from the model: a tool call may only name a task that native code registered.
 *
 * `resolvePattern` and `analyzer` are optional. When both are absent the plugin behaves exactly as it did
 * before they existed — no analysis is attempted, so a host without a reasoning provider keeps the
 * deterministic path rather than failing on a capability it was never given.
 */
export function createExecutionRuntimePlugin({ store, recipes, tasks, validateArguments, probes = [], owner,
  decisionClient = null, decisionPolicy = null, resolvePattern = null, analyzer = null,
  analysisMaxBytes = 16_384 }) {
  if (!store || !Array.isArray(recipes) || !tasks || typeof tasks !== 'object'
    || typeof validateArguments !== 'function') {
    fail('invalid_runtime_plugin', 'A store, registered recipes, native tasks and argument validation are required.');
  }
  if (resolvePattern !== null && typeof resolvePattern !== 'function') {
    fail('invalid_runtime_plugin', 'An optional pattern resolver must be a function.');
  }
  if (analyzer !== null && typeof analyzer?.analyze !== 'function') {
    fail('invalid_runtime_plugin', 'An optional analyzer must expose analyze().');
  }
  const executors = new Map();
  const schedulers = new Map();
  // Probe state belongs to this plugin instance, never to the module: two loaded runtimes must not share it.
  let lastProbe = null;
  let disposed = false;
  // Drain bookkeeping: unloading stops new dispatch first, then waits for the work already in flight.
  const active = new Set();
  let draining = null;

  /** One executor and scheduler per calling agent: identity is never widened by a model-supplied value. */
  const schedulerFor = (agent) => {
    const cached = schedulers.get(agent);
    if (cached) return cached;
    const executor = new HostExecutor({ context: owner, tools: owner.get('tools'), agent });
    const scheduler = new RuntimeScheduler({ store, recipes, executor, tools: owner.get('tools'),
      validateArguments, probes, decisionClient, decisionPolicy });
    executors.set(agent, executor);
    schedulers.set(agent, scheduler);
    return scheduler;
  };

  /**
   * Build the analysis coordinator for one caller, or null when the host configured no analyzer.
   *
   * Without an analyzer there is nothing to ask, so a coordinator would only manufacture "unavailable"
   * records. Returning null keeps that absence explicit at the call site instead of hiding it behind a
   * component that looks wired.
   */
  const coordinatorFor = (agent, extraResolvePattern = null) => {
    if (analyzer === null) return null;
    const resolver = extraResolvePattern ?? resolvePattern;
    return new AnalysisCoordinator({ store, analyzer, agent, maxBytes: analysisMaxBytes,
      ...(resolver === null ? {} : { resolvePattern: resolver }) });
  };

  const statusTool = {
    name: 'runtime_status',
    description: 'Report the isolated execution runtime: which task templates are registered and, for a named task, '
      + 'its persisted status, reason and budget usage. Read-only; it never starts or resumes work.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Optional task id to inspect.' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const registered = recipes.map((recipe) => ({ recipeId: recipe.id, recipeVersion: recipe.version,
        allowedTools: [...recipe.allowedTools] }));
      if (args?.taskId === undefined) return { templates: registered, tasks: Object.keys(tasks).sort() };
      const run = store.getRun(args.taskId);
      return { templates: registered, run: { taskId: args.taskId, status: run.status, reason: run.reason,
        budgetUsage: run.budgetUsage, fence: run.fence, owner: run.owner } };
    },
  };

  /**
   * Analyze a run that stopped for analysis, and only such a run.
   *
   * The coordinator already refuses anything that is not `waiting_analysis`, but checking here keeps the
   * common path free of a component that would do nothing. Any failure is reported alongside the run rather
   * than thrown: the task's own outcome is already settled, and turning a bookkeeping problem into a task
   * failure would be a false negative.
   */
  const maybeAnalyze = async (agent, taskId, authority, signal) => {
    const coordinator = coordinatorFor(agent);
    if (coordinator === null) return null;
    const current = store.getRun(taskId);
    if (current.status !== 'waiting_analysis') return null;
    try {
      const result = await coordinator.analyze(taskId, { authority, signal });
      return { status: result.status, analysisId: result.analysisId ?? null,
        route: coordinator.lastRoute?.route ?? null };
    } catch (error) {
      return { status: 'analysis_unavailable', error: error?.code ?? describe(error), detail: describe(error) };
    }
  };

  const runTool = {
    name: 'runtime_run',
    description: 'Run one already-registered task template. The caller supplies only a task reference: the goal, '
      + 'workspace, tools and verifier come from native registration, so this cannot widen its own authority. '
      + 'Returns the persisted run state; unknown side effects stay frozen for reconciliation.',
    parameters: {
      type: 'object',
      properties: { taskRef: { type: 'string', description: 'A task reference registered by native code.' } },
      required: ['taskRef'], additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (disposed) fail('runtime_unloaded', 'The runtime plugin is unloaded and cannot dispatch new work.');
      requireString(args?.taskRef, 'taskRef');
      const factory = tasks[args.taskRef];
      if (typeof factory !== 'function') fail('task_not_registered', 'The task reference is not registered natively.');
      if (!exec?.agent) fail('authority_unavailable', 'A task-level tool needs the calling agent.');
      const prepared = await factory({ agent: exec.agent });
      if (!prepared || typeof prepared !== 'object') fail('task_not_registered', 'The native task factory returned no task.');
      const scheduler = schedulerFor(exec.agent);
      const work = scheduler.run(prepared.task, { authority: prepared.authority, signal: exec.signal });
      active.add(work);
      work.finally(() => active.delete(work)).catch(() => {});
      const run = await work;
      // A run that stopped for analysis gets one. The analysis records a proposal only — it never
      // dispatches anything, and a caller still has to act on it through `runtime.status`.
      const analysis = await maybeAnalyze(exec.agent, run.task.taskId, prepared.authority, exec.signal);
      return { taskId: run.task.taskId, status: run.status, reason: run.reason,
        budgetUsage: run.budgetUsage, ...(analysis === null ? {} : { analysis }) };
    },
  };

  /**
   * Stop new dispatch, then wait for work already in flight. Draining never invents an outcome: a run that
   * was interrupted stays in its persisted state so a later owner can reconcile or resume it.
   */
  const drain = async () => {
    // Snapshot before awaiting: settling removes entries from `active`, so reading it afterwards would
    // always report zero and make a real wait indistinguishable from a no-op.
    const pending = [...active];
    if (!pending.length) return { drained: 0, pending: 0 };
    draining ??= Promise.allSettled(pending);
    await draining;
    draining = null;
    return { drained: pending.length, pending: active.size };
  };

  return {
    name: 'execution-runtime',
    inject: ['tools'],
    apply(ctx) {
      disposed = false;
      const disposers = [];
      for (const tool of [statusTool, runTool]) {
        const dispose = ctx.tools?.register?.(tool);
        if (typeof dispose !== 'function') fail('runtime_tool_unavailable', `The host did not accept ${tool.name}.`);
        disposers.push(dispose);
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { for (const dispose of disposers.splice(0)) dispose(); });
      }
      lastProbe = { plugin: 'execution-runtime', status: 'ok',
        findings: [{ code: 'execution-runtime.loaded', severity: 'info',
          message: `Loaded ${recipes.length} template(s) and ${Object.keys(tasks).length} native task reference(s).` }] };
      return () => {
        // Order matters on unload: refuse new dispatch first, then stop allowing the tools, then report.
        disposed = true;
        for (const dispose of disposers.splice(0)) dispose();
        lastProbe = { plugin: 'execution-runtime', status: 'ok',
          findings: [{ code: 'execution-runtime.unloaded', severity: 'info',
            message: `The runtime plugin released its tools; ${active.size} run(s) still in flight remain resumable.` }] };
      };
    },
    /** Explicit drain for unload/HMR paths; resolves once the in-flight work settles or fails. */
    drain,
    /** Zero-argument probe: report what the plugin knows without reaching into ctx. */
    healthProbe: {
      probe() {
        if (!lastProbe) {
          return { plugin: 'execution-runtime', status: 'degraded',
            findings: [{ code: 'execution-runtime.not-applied', severity: 'warn',
              message: 'The runtime plugin has not been applied in this process.' }] };
        }
        // In-flight work during unload is reported rather than hidden: a green probe must not imply idle.
        if (disposed && active.size) {
          return { plugin: 'execution-runtime', status: 'degraded',
            findings: [{ code: 'execution-runtime.draining', severity: 'warn',
              message: `Unloaded with ${active.size} run(s) still in flight; call drain() before replacing the plugin.` }] };
        }
        return lastProbe;
      },
    },
    /** Test and host-embedding access to the bound services; never exposed to the model. */
    describe() { return { disposed, executors: executors.size, schedulers: schedulers.size, active: active.size }; },
  };
}

export { describe as describeError };
