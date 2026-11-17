import { RuntimeContractError, requireString } from './contracts.js';
import { HostExecutor } from './executor.js';
import { RuntimeScheduler } from './scheduler.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Wrap the isolated runtime as a real Cordis plugin. The plugin never accepts an executable callback,
 * workspace, goal, or verifier from the model: a tool call may only name a task that native code registered.
 */
export function createExecutionRuntimePlugin({ store, recipes, tasks, validateArguments, probes = [], owner,
  decisionClient = null, decisionPolicy = null }) {
  if (!store || !Array.isArray(recipes) || !tasks || typeof tasks !== 'object'
    || typeof validateArguments !== 'function') {
    fail('invalid_runtime_plugin', 'A store, registered recipes, native tasks and argument validation are required.');
  }
  const executors = new Map();
  const schedulers = new Map();
  // Probe state belongs to this plugin instance, never to the module: two loaded runtimes must not share it.
  let lastProbe = null;
  let disposed = false;

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
      requireString(args?.taskRef, 'taskRef');
      const factory = tasks[args.taskRef];
      if (typeof factory !== 'function') fail('task_not_registered', 'The task reference is not registered natively.');
      if (!exec?.agent) fail('authority_unavailable', 'A task-level tool needs the calling agent.');
      const prepared = await factory({ agent: exec.agent });
      if (!prepared || typeof prepared !== 'object') fail('task_not_registered', 'The native task factory returned no task.');
      const scheduler = schedulerFor(exec.agent);
      const run = await scheduler.run(prepared.task, { authority: prepared.authority, signal: exec.signal });
      return { taskId: run.task.taskId, status: run.status, reason: run.reason, budgetUsage: run.budgetUsage };
    },
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
        disposed = true;
        for (const dispose of disposers.splice(0)) dispose();
        // Disposal stops new dispatch; in-flight work is drained by the owning application, not silently killed.
        lastProbe = { plugin: 'execution-runtime', status: 'ok',
          findings: [{ code: 'execution-runtime.unloaded', severity: 'info',
            message: 'The runtime plugin released its tools; the host keeps working without it.' }] };
      };
    },
    /** Zero-argument probe: report what the plugin knows without reaching into ctx. */
    healthProbe: {
      probe() {
        if (!lastProbe) {
          return { plugin: 'execution-runtime', status: 'degraded',
            findings: [{ code: 'execution-runtime.not-applied', severity: 'warn',
              message: 'The runtime plugin has not been applied in this process.' }] };
        }
        if (disposed) return lastProbe;
        return lastProbe;
      },
    },
    /** Test and host-embedding access to the bound services; never exposed to the model. */
    describe() { return { disposed, executors: executors.size, schedulers: schedulers.size }; },
  };
}

export { describe as describeError };
