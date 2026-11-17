import { RuntimeContractError, requireString } from './contracts.js';
import { buildRecipeFromSpec, createRecipeRegistry } from './recipe-factory.js';
import { describePrimitives, VERIFIER_PRIMITIVES } from './verifier-primitives.js';
import { describeConditions } from './condition-primitives.js';

/**
 * The tool that lets a caller describe a task at runtime instead of naming a pre-registered template.
 *
 * ## Relationship to `runtime_run`
 *
 * `runtime_run` keeps its original, narrower contract: it dispatches a template the host declared, so the
 * caller cannot influence goal, scope or verifier. That stays, because the most constrained path should
 * remain available and unchanged.
 *
 * This tool is the general path: the caller supplies a task specification, a recipe is generated from it,
 * and the run proceeds. It is deliberately *not* a way to widen authority — scope, workspace and the
 * trusted effect table still come from the host, never from the request.
 *
 * ## What the caller may and may not decide
 *
 * - May decide: goal, inputs, which declared tool to call, argument template, and **which verifier
 *   primitive** (from the closed set) parameterizes acceptance.
 * - May not decide: workspace root, scope, the trusted effect of a tool, or a new verifier predicate.
 *   Those come from the mount and are checked before anything is dispatched.
 */
const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const SPEC_PARAMETERS = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Caller-chosen identity for this run.' },
    goal: { type: 'string', description: 'One sentence describing what must be true when the run ends.' },
    recipe: {
      type: 'object',
      description: 'Recipe specification: { recipeId, tool, effect, verifier, arguments, description? }.',
      additionalProperties: true,
    },
    inputs: {
      type: 'object',
      description: 'Task inputs, e.g. { inputFile, outputFile }. Paths stay inside the mount workspace.',
      additionalProperties: true,
    },
    deadlineMs: { type: 'number', description: 'Optional budget in milliseconds; defaults to one minute.' },
  },
  required: ['goal', 'recipe', 'inputs'],
  additionalProperties: false,
};

/**
 * Build the runtime_execute tool.
 *
 * @param {object} input
 * @param {object} input.store Persisted runtime store.
 * @param {() => object} input.schedulerFor Returns a scheduler bound to the calling agent.
 * @param {Record<string,string>} input.toolEffects Trusted effect declarations from the host.
 * @param {object} input.mount Fixed authority: scopeRef, workspaceRoot, allowedTools.
 * @param {object} [input.registry] Optional pre-built registry.
 */
export function createExecuteTool({ store, schedulerFor, toolEffects, mount, registry = null }) {
  requireString(mount?.scopeRef, 'mount.scopeRef');
  requireString(mount?.workspaceRoot, 'mount.workspaceRoot');
  const recipes = registry ?? createRecipeRegistry();
  const generated = new Set();

  return {
    name: 'runtime_execute',
    description: 'Describe a task at runtime and run it. A recipe is generated from the specification, and '
      + 'acceptance is decided by one of the built-in verifier primitives (' + VERIFIER_PRIMITIVES.join(', ')
      + '). Caller-chosen: goal, inputs, tool, arguments, and which primitive parameterizes success. '
      + 'Host-chosen: workspace, scope, and each tool\'s trusted effect. Dispatch stays inside the host '
      + 'pipeline, so unknown side effects stay frozen for reconciliation.',
    parameters: SPEC_PARAMETERS,
    output: { schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (!exec?.agent) fail('authority_unavailable', 'A runtime task needs the calling agent.');
      requireString(args?.goal, 'goal');
      const deadlineMs = Number.isSafeInteger(args?.deadlineMs) && args.deadlineMs > 0
        ? Math.min(args.deadlineMs, 3_600_000) : 60_000;
      const recipeSpec = args?.recipe;
      if (!recipeSpec || typeof recipeSpec !== 'object' || Array.isArray(recipeSpec)) {
        fail('invalid_recipe_spec', 'recipe must be a specification object.');
      }
      // The mount decides authority; the request only chooses among what the mount already allows.
      for (const name of recipeSpec.allowedTools ?? [recipeSpec.tool]) {
        if (!mount.allowedTools.includes(name)) {
          fail('authority_denied', `The mount does not allow ${name}.`);
        }
      }
      let recipe;
      try {
        recipe = recipes.generate(recipeSpec, { toolEffects });
      } catch (error) {
        // A duplicate id is not an error for the caller: the same specification reused across tasks is a
        // normal case, and regenerating an identical spec must not be blocked by its own earlier record.
        if (error?.code !== 'duplicate_recipe') throw error;
        recipe = recipes.get(`${recipeSpec.recipeId}:${recipeSpec.version ?? '1'}`);
      }
      generated.add(`${recipe.id}:${recipe.version}`);

      const taskId = typeof args?.taskId === 'string' && args.taskId ? args.taskId : `dynamic:${Date.now()}`;
      const task = { taskId, recipeId: recipe.id, recipeVersion: recipe.version, goal: args.goal,
        scopeRef: mount.scopeRef, workspaceRoot: mount.workspaceRoot,
        inputs: args.inputs, deadlineAt: Date.now() + deadlineMs };
      const scheduler = schedulerFor(exec.agent, recipes);
      const run = await scheduler.run(task, { authority: { scopeRef: mount.scopeRef,
        workspaceRoot: mount.workspaceRoot, allowedTools: mount.allowedTools, agent: exec.agent } });
      return { taskId: run.task.taskId, status: run.status, reason: run.reason,
        recipe: `${recipe.id}@${recipe.version}`, verifier: recipe.verifier.id,
        budgetUsage: run.budgetUsage };
    },
  };
}

/** A read-only tool so a caller can discover which acceptance and branch primitives exist. */
export const describePrimitivesTool = {
  name: 'runtime_verifiers',
  description: 'List the built-in verifier primitives that decide whether a generated task succeeded, and '
    + 'the condition primitives that decide how a multi-step recipe branches. Both are closed vocabularies '
    + 'on purpose: a task may choose how to be judged and how to branch, never invent either.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
  async execute() {
    return { primitives: describePrimitives(), conditions: describeConditions(),
      steps: 'A recipe may declare steps[] instead of a single action; each step takes { id, tool, effect, '
        + 'arguments, verifier, next? }. next is [{ when?, goto }] tried in order; goto must be a declared id.' };
  },
};
