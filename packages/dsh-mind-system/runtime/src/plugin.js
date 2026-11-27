import { RuntimeContractError, requireString, validateTask } from './contracts.js';
import { realpathSync } from 'node:fs';
import { RuntimeStore, validateAuthoritySnapshot } from './store.js';
import { HostExecutor } from './executor.js';
import { RuntimeScheduler } from './scheduler.js';
import { AnalysisCoordinator } from './exceptions.js';
import { isDeepStrictEqual } from 'node:util';
import { readAcceptancePredicate } from './acceptance-predicate-reader.js';

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
  analysisMaxBytes = 16_384, getRegistrationSnapshot = null, getOperationalStatus = null }) {
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
      + 'its persisted status, reason, budget usage and recipe binding coverage. Origins are caller declarations; '
      + 'the current producer state does not independently prove the goal. Store identity is a hash of the SQLite-reported '
      + 'main database path, not a file identity; aliases or replacement files may affect comparisons. '
      + 'Read-only; it never starts or resumes work.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Optional task id to inspect.' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const registered = recipes.map((recipe) => ({ recipeId: recipe.id, recipeVersion: recipe.version,
        allowedTools: [...recipe.allowedTools] }));
      let operational;
      try { operational = typeof getOperationalStatus === 'function' ? getOperationalStatus() : null; } catch { /* Unavailable. */ }
      const runtime = operational ?? { analysis: { configuration: 'unknown', invocation: 'unknown' },
        outbox: { startup: 'unknown', state: 'unknown', lastPass: null } };
      let storeIdentity = { status: 'unavailable', reason: 'custom_adapter' };
      if (store instanceof RuntimeStore) {
        try { storeIdentity = RuntimeStore.prototype.getStoreIdentity.call(store); }
        catch { storeIdentity = { status: 'unavailable', reason: 'sqlite_identity_read_failed' }; }
      }
      if (args?.taskId === undefined) return { templates: registered, tasks: Object.keys(tasks).sort(), ...runtime, storeIdentity };
      const run = store.getRun(args.taskId);
      return { templates: registered, ...runtime, storeIdentity, run: { taskId: args.taskId, status: run.status, reason: run.reason,
        budgetUsage: run.budgetUsage, fence: run.fence, owner: run.owner,
        recipeOutcome: store.getRecipeOutcome(args.taskId) } };
    },
  };

  const recoveryDiagnosisTool = {
    name: 'runtime_recovery_diagnosis',
    description: 'Compare one persisted native binding with the current host registration. Read-only observation; '
      + 'it does not authorize recovery, establish terminality, prove a goal or establish provenance. '
      + 'Full handwritten recipe identity is unknown.',
    parameters: { type: 'object', properties: { taskId: { type: 'string' } },
      required: ['taskId'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Reflect.ownKeys(args).length !== 1 || !Object.hasOwn(args, 'taskId')
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, 'taskId') ?? {}, 'value')) {
        fail('invalid_contract', 'Only taskId is accepted.');
      }
      requireString(args.taskId, 'taskId');
      const result = (status, reason, version = null) => ({ status, reason, version,
        recipeIdentity: 'unknown', authorization: 'not_evaluated', terminality: 'not_evaluated',
        goalProof: 'not_evaluated', provenance: 'not_evaluated' });
      try {
        if (typeof store.getRecoveryIdentitySnapshot !== 'function') return result('unknown', 'snapshot_unavailable');
        const persisted = store.getRecoveryIdentitySnapshot(args.taskId);
        if (persisted?.coverage !== 'bound') return result('unknown', 'binding_unavailable');
        if (typeof getRegistrationSnapshot !== 'function') return result('unknown', 'registration_unavailable', persisted.version);
        const registration = getRegistrationSnapshot(args.taskId);
        if (!registration?.acceptanceBinding || !registration.authority || !persisted.binding?.authority) {
          return result('unknown', 'registration_or_authority_unavailable', persisted.version);
        }
        const matches = isDeepStrictEqual(persisted.task, registration.task)
          && isDeepStrictEqual(persisted.binding, { ...registration.acceptanceBinding, authority: registration.authority })
          && persisted.binding.nativeRef === args.taskId;
        return result(matches ? 'match' : 'mismatch', matches ? 'identity_matches' : 'identity_differs', persisted.version);
      } catch { return result('unknown', 'snapshot_unavailable'); }
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

  const acceptanceResult = (status, reason) => ({ status, reason, goalProof: 'not_evaluated',
    principleAttribution: 'not_evaluated', governanceEligible: false });

  const reviewAcceptance = (prepared, run, taskRef, expectedBinding, expectedTask) => {
    try {
      const persisted = store.getRun(prepared.task.taskId);
      const binding = store.getAcceptanceBinding(prepared.task.taskId);
      if (!binding) return acceptanceResult('unknown', 'binding_unavailable');
      if (!isDeepStrictEqual(binding, expectedBinding)
        || binding.nativeRef !== taskRef || binding.nativeRef !== expectedTask.taskId
        || !isDeepStrictEqual(persisted.task, expectedTask) || !isDeepStrictEqual(run.task, expectedTask)) {
        return acceptanceResult('unknown', 'binding_mismatch');
      }
      return readAcceptancePredicate({ workspaceRoot: prepared.task.workspaceRoot, contract: binding.contract });
    } catch {
      return acceptanceResult('error', 'binding_unavailable');
    }
  };

  const runTool = {
    name: 'runtime_run',
    description: 'Run one already-registered task template. The caller supplies only a task reference: the goal, '
      + 'workspace, tools and verifier come from native registration, so this cannot widen its own authority. '
      + 'Returns the persisted run state; unknown side effects stay frozen for reconciliation. '
      + 'For host-configured acceptance contracts, acceptance separately reports a predicate on current file bytes; '
      + 'it does not prove the goal or principle attribution, and bound recovery is unavailable.',
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
      let scheduler = schedulerFor(exec.agent);
      let expectedBinding;
      let expectedTask;
      if (prepared.acceptanceBinding !== undefined) {
        expectedTask = validateTask(prepared.task);
        const nativeAuthority = validateAuthoritySnapshot({ schemaVersion: 1, scopeRef: prepared.authority?.scopeRef,
          workspaceRoot: realpathSync(prepared.authority?.workspaceRoot), allowedTools: prepared.authority?.allowedTools });
        expectedBinding = structuredClone({ ...prepared.acceptanceBinding, authority: nativeAuthority });
        if (args.taskRef !== expectedTask.taskId || expectedBinding.nativeRef !== args.taskRef) {
          fail('native_task_drift', 'Native task reference changed.');
        }
        const executor = new HostExecutor({ context: owner, tools: owner.get('tools'), agent: exec.agent });
        executors.set(executor, executor);
        scheduler = new RuntimeScheduler({ store, recipes, executor, tools: owner.get('tools'),
          validateArguments, probes, decisionClient, decisionPolicy,
          nativeBinding: prepared.acceptanceBinding, nativeTask: expectedTask, nativeAuthority });
      }
      const authority = { ...prepared.authority, allowedTools: prepared.authority?.allowedTools?.slice() };
      const options = { authority, signal: exec.signal };
      const autoRepair = prepared.autoRepair === true;
      const work = (async () => {
        let run = await scheduler.run(prepared.task, options);
        const { taskId, recipeId, recipeVersion } = run.task;
        const acceptance = prepared.acceptanceBinding === undefined ? undefined : reviewAcceptance(prepared, run, args.taskRef, expectedBinding, expectedTask);
        const analysis = await maybeAnalyze(exec.agent, taskId, authority, exec.signal);
        if (analysis !== null) run = store.getRun(taskId);
        let repairError;
        if (autoRepair && analysis !== null) {
          run = store.getRun(taskId);
          if (!disposed && run.status === 'waiting_analysis' && analysis.status === 'proposed'
            && analysis.route === 'repair_directly') {
            const record = store.getAnalysis(taskId, analysis.analysisId);
            const action = record?.result?.repair;
            const policy = recipes.find((r) => r.id === recipeId && r.version === recipeVersion)?.repairPolicy;
            if (record?.status === 'proposed' && record.consumedAt === null && action?.kind === 'retry_with'
              && action.requiresHumanReview === false && action.candidate.source.recipeId === recipeId
              && action.candidate.source.version === recipeVersion && policy?.allowedTools.includes(action.candidate.toolName)
              && authority.allowedTools.includes(action.candidate.toolName)) {
              // The scheduler owns admission, single-use reservation, dispatch and the original verifier.
              try { run = await scheduler.repair(taskId, analysis.analysisId, options); }
              catch (error) { repairError = error?.code ?? 'repair_unavailable'; run = store.getRun(taskId); }
            }
          }
        }
        return { taskId, status: run.status, reason: run.reason, budgetUsage: run.budgetUsage,
          ...(acceptance === undefined ? {} : { acceptance }),
          ...(analysis === null ? {} : { analysis }), ...(repairError ? { repairError } : {}) };
      })();
      active.add(work);
      try { return await work; } finally { active.delete(work); }
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
      for (const tool of [statusTool, runTool, recoveryDiagnosisTool]) {
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
