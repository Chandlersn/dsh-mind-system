import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RuntimeContractError, requireString } from './contracts.js';
import { buildVerifier, VERIFIER_PRIMITIVES } from './verifier-primitives.js';
import { buildCondition, CONDITION_KINDS } from './condition-primitives.js';

/**
 * Recipe factory: turn a task specification into a runnable recipe.
 *
 * ## What this makes dynamic
 *
 * Previously a recipe had to be hand-written and registered before any task could run, so "any task" was
 * really "any task that already had a template". This factory derives the recipe from the task
 * specification instead: which tool to call, how to build the candidate, which preconditions to check.
 *
 * ## What stays fixed, on purpose
 *
 * - The **verifier** may only be one of the closed primitives; the specification selects and parameterizes
 *   it, and an unknown name is an error rather than a silent downgrade.
 * - The **effect class** must be declared. A write whose reversibility is unknown cannot be admitted, so
 *   guessing here would either block honest work or let irreversible work look reversible.
 * - The **tool** must already exist in the host. The factory composes calls to registered tools; it never
 *   invents a capability.
 *
 * ## The generated recipe is still an ordinary recipe
 *
 * It exposes the same callbacks the scheduler already expects, so nothing downstream changes: candidates
 * are re-derived every step, preconditions are checked against live state, and verification reads the
 * artifact back through the task's own metered I/O.
 */

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/** Declared specification shape. Extra fields are refused so a spec cannot smuggle in behaviour. */
const SPEC_FIELDS = ['recipeId', 'version', 'description', 'tool', 'effect', 'verifier', 'arguments',
  'preconditions', 'postconditions', 'allowedTools', 'steps'];

function validateSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_recipe_spec', 'A recipe specification object is required.');
  }
  for (const key of Object.keys(input)) {
    if (!SPEC_FIELDS.includes(key)) fail('invalid_recipe_spec', `Unknown specification field: ${key}.`);
  }
  requireString(input.recipeId, 'spec.recipeId');
  requireString(input.tool, 'spec.tool');
  if (!['read', 'reversible_write'].includes(input.effect)) {
    fail('invalid_recipe_spec', 'spec.effect must be read or reversible_write.');
  }
  if (!input.verifier || typeof input.verifier !== 'object' || Array.isArray(input.verifier)) {
    fail('invalid_recipe_spec', 'spec.verifier must declare a primitive.');
  }
  for (const key of Object.keys(input.verifier)) {
    if (!['primitive', 'parameters'].includes(key)) {
      fail('invalid_recipe_spec', `Unknown verifier field: ${key}.`);
    }
  }
  if (!VERIFIER_PRIMITIVES.includes(input.verifier.primitive)) {
    fail('invalid_recipe_spec',
      `spec.verifier.primitive must be one of: ${VERIFIER_PRIMITIVES.join(', ')}.`);
  }
  // Arguments are a template: string values may reference task inputs, but the shape must be static so the
  // candidate is predictable and re-checkable at dispatch time.
  if (input.arguments !== undefined && (typeof input.arguments !== 'object' || Array.isArray(input.arguments))) {
    fail('invalid_recipe_spec', 'spec.arguments must be an object template.');
  }
  // Multi-step specs: each step is itself a single-action spec shape, so a step cannot carry nested steps
  // (that would need a scheduler change rather than a data change) and every step is validated the same way.
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 32) {
      fail('invalid_recipe_spec', 'spec.steps must be a non-empty array of at most 32 steps.');
    }
    for (const [index, step] of input.steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        fail('invalid_recipe_spec', `step ${index} must be an object.`);
      }
      if (step.steps !== undefined) {
        fail('invalid_recipe_spec', 'steps may not nest: a step is a single action.');
      }
      const allowed = ['id', 'tool', 'effect', 'arguments', 'verifier', 'description', 'next'];
      for (const key of Object.keys(step)) {
        if (!allowed.includes(key)) fail('invalid_recipe_spec', `Unknown step field at ${index}: ${key}.`);
      }
      requireString(step.tool, `steps[${index}].tool`);
      if (!['read', 'reversible_write'].includes(step.effect)) {
        fail('invalid_recipe_spec', `steps[${index}].effect must be read or reversible_write.`);
      }
      if (!verifierSpecOf(step.verifier)) {
        fail('invalid_recipe_spec', `steps[${index}].verifier must declare a known primitive.`);
      }
      // Branching is declared, not coded: a list of { when, goto } tried in order, plus an optional
      // default. Without `next` the step simply proceeds to the following one.
      if (step.next !== undefined) {
        if (!Array.isArray(step.next) || step.next.length === 0 || step.next.length > 8) {
          fail('invalid_recipe_spec', `steps[${index}].next must be a non-empty array of at most 8 rules.`);
        }
        for (const [ruleIndex, rule] of step.next.entries()) {
          if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            fail('invalid_recipe_spec', `steps[${index}].next[${ruleIndex}] must be an object.`);
          }
          for (const key of Object.keys(rule)) {
            if (!['when', 'goto'].includes(key)) {
              fail('invalid_recipe_spec', `Unknown next rule field at ${index}: ${key}.`);
            }
          }
          if (rule.when !== undefined) buildCondition(rule.when);
          requireString(rule.goto, `steps[${index}].next[${ruleIndex}].goto`);
        }
      }
    }
    // Every jump target must be a declared step id, and the id set must be unique: a branch to a missing
    // step would stall the run with no candidate and look like a plan gap instead of a wiring mistake.
    const ids = input.steps.map((step, index) => step.id ?? `step-${index}`);
    if (new Set(ids).size !== ids.length) fail('invalid_recipe_spec', 'Step ids must be unique.');
    for (const [index, step] of input.steps.entries()) {
      for (const [ruleIndex, rule] of (step.next ?? []).entries()) {
        if (!ids.includes(rule.goto)) {
          fail('invalid_recipe_spec',
            `steps[${index}].next[${ruleIndex}].goto names ${rule.goto}, which is not a declared step.`);
        }
      }
    }
  }
  return input;
}

/** Shared verifier-spec validation, so a top-level verifier and a step verifier cannot drift apart. */
function verifierSpecOf(verifier) {
  if (!verifier || typeof verifier !== 'object' || Array.isArray(verifier)) return false;
  for (const key of Object.keys(verifier)) {
    if (!['primitive', 'parameters'].includes(key)) return false;
  }
  return VERIFIER_PRIMITIVES.includes(verifier.primitive);
}

/** Substitute `{{inputFile}}` / `{{outputFile}}` / `{{workspaceRoot}}` placeholders from the task. */
function renderArguments(template, task, state) {
  const inputs = state?.inputs ?? task?.inputs ?? {};
  const values = { inputFile: inputs.inputFile, outputFile: inputs.outputFile, workspaceRoot: task.workspaceRoot };
  const walk = (value) => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.hasOwn(values, key) || typeof values[key] !== 'string') {
          fail('invalid_recipe_spec', `The argument template references an unknown placeholder: ${key}.`);
        }
        return values[key];
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return walk(template ?? {});
}

/**
 * Build a recipe from a specification.
 *
 * @param {object} spec The declared specification.
 * @param {{ toolEffects: Record<string,string> }} options Trusted effect declarations from the host.
 */
export function buildRecipeFromSpec(spec, { toolEffects } = {}) {
  const checked = validateSpec(spec);
  const allowedTools = checked.allowedTools ?? [checked.tool];
  if (!Array.isArray(allowedTools) || !allowedTools.length || !allowedTools.includes(checked.tool)) {
    fail('invalid_recipe_spec', 'allowedTools must include the tool the recipe dispatches.');
  }
  if (!toolEffects || typeof toolEffects !== 'object') {
    fail('invalid_recipe_spec', 'Trusted tool effect declarations are required; the spec may not supply them.');
  }
  for (const name of allowedTools) {
    if (!Object.hasOwn(toolEffects, name)) {
      fail('invalid_recipe_spec', `The host has not declared an effect for ${name}.`);
    }
  }
  const verifier = buildVerifier(checked.verifier);
  const preconditionIds = Array.isArray(checked.preconditions) ? [...checked.preconditions] : ['workspace-scope'];
  const postconditionIds = Array.isArray(checked.postconditions) && checked.postconditions.length
    ? [...checked.postconditions] : ['goal-verified'];
  // A spec is either a single action or an ordered list of steps. Multi-step recipes advance through
  // persisted state, and stop by returning no candidate once the last step is done — that is how the
  // scheduler's loop terminates, so no engine change is needed.
  const steps = Array.isArray(checked.steps) && checked.steps.length
    ? checked.steps.map((step, index) => ({
      id: step.id ?? `step-${index}`,
      tool: step.tool,
      effect: step.effect,
      arguments: step.arguments ?? {},
      verifier: buildVerifier(step.verifier),
      // Conditions are built once at registration time, so a bad branch fails while the recipe is created
      // rather than in the middle of a run.
      next: Array.isArray(step.next) ? step.next.map((rule) => ({
        when: rule.when === undefined ? null : buildCondition(rule.when),
        goto: rule.goto,
      })) : [],
    }))
    : null;
  const stepIds = steps ? steps.map((step) => step.id) : [];
  const indexOfStep = (id) => stepIds.indexOf(id);
  const stepTools = steps ? [...new Set(steps.map((step) => step.tool))] : [checked.tool];
  const tools = [...new Set([...allowedTools, ...stepTools])];
  for (const name of tools) {
    if (!Object.hasOwn(toolEffects, name)) {
      fail('invalid_recipe_spec', `The host has not declared an effect for ${name}.`);
    }
  }

  /**
   * The scheduler verifies every attempt, including intermediate ones, so a multi-step recipe routes each
   * verdict to the step that produced it. The candidate id carries the step id, which is what makes the
   * routing unambiguous rather than positional guesswork.
   */
  const stepVerifier = {
    id: `${verifier.id}+steps`, version: '1',
    async verify(context) {
      const candidateId = context?.candidate?.candidateId ?? '';
      const index = steps.findIndex((item) => candidateId.endsWith(`:${item.id}`));
      const step = index >= 0 ? steps[index] : null;
      const verdict = await (step === null ? verifier : step.verifier).verify(context);
      // The scheduler pins the verdict to the registered verifier identity, so a delegated verdict must
      // carry this identity; the step that produced it stays visible in the reason.
      //
      // An intermediate step satisfying its own predicate is *not* the task being done: reporting
      // goalSatisfied here would end the run after step one, which is exactly what it did before this was
      // split out. Only the final step may claim the goal.
      const last = step !== null && index === steps.length - 1;
      return { ...verdict, verifierId: `${verifier.id}+steps`, verifierVersion: '1',
        goalSatisfied: last ? verdict.goalSatisfied : (verdict.status === 'pass' ? false : verdict.goalSatisfied),
        reason: step === null ? verdict.reason : `${step.id}:${verdict.reason ?? verdict.status}` };
    },
  };

  return Object.freeze({
    id: checked.recipeId,
    version: checked.version ?? '1',
    ruleVersion: `generated:${checked.recipeId}:v${checked.version ?? '1'}`,
    description: checked.description ?? null,
    allowedTools: Object.freeze([...tools]),
    toolEffects: Object.freeze(Object.fromEntries(tools.map((name) => [name, toolEffects[name]]))),
    requiredPreconditionIds: Object.freeze(preconditionIds),
    postconditionIds: Object.freeze(postconditionIds),
    verificationIoReserve: 5,
    prepare() {
      // Preparation is deliberately identity: the task already carries its inputs, and inventing state here
      // would diverge from what the caller declared. Multi-step recipes record a step cursor instead.
      return steps ? { step: 0 } : {};
    },
    candidates({ task, state, io }) {
      if (!steps) {
        return [{
          candidateId: `${checked.recipeId}:main`,
          toolName: checked.tool,
          arguments: renderArguments(checked.arguments, task, state),
          preconditionIds: [...preconditionIds],
          postconditionIds: [...postconditionIds],
          inputVersion: state?.inputs?.inputSha256 ?? null,
          progressKey: `${checked.recipeId}:progress`,
          effect: checked.effect,
          idempotencyKey: `${task.taskId}:${checked.recipeId}:main`,
          source: { recipeId: checked.recipeId, version: checked.version ?? '1' },
        }];
      }
      const cursor = Number.isSafeInteger(state?.step) ? state.step : 0;
      // Returning no candidate is the loop's stop signal; it is not a failure.
      if (cursor >= steps.length) return [];
      const step = steps[cursor];
      return [{
        candidateId: `${checked.recipeId}:${step.id}`,
        toolName: step.tool,
        arguments: renderArguments(step.arguments, task, state),
        preconditionIds: [...preconditionIds],
        postconditionIds: [...postconditionIds],
        inputVersion: state?.inputs?.inputSha256 ?? null,
        progressKey: `${checked.recipeId}:${step.id}`,
        effect: step.effect,
        idempotencyKey: `${task.taskId}:${checked.recipeId}:${step.id}`,
        source: { recipeId: checked.recipeId, version: checked.version ?? '1' },
      }];
    },
    ...(steps ? {
      /**
       * Advance the cursor, honouring declared branches.
       *
       * `advance` receives no I/O capability, so conditions that need file facts read through the same
       * workspace-scoped helper the verifiers use — but only bare filenames, and only inside the task's
       * workspace. The chosen target is recorded in state so a run can be inspected afterwards: "why did it
       * go that way" must be answerable from persisted data, not by re-running the branch.
       */
      advance({ task, state, candidate }) {
        const cursor = Number.isSafeInteger(state?.step) ? state.step : 0;
        const step = steps[cursor] ?? null;
        if (step === null) return { ...state, step: cursor + 1 };
        const chosen = resolveNext(step, { task, state });
        // A branch target may be the current step, which expresses a retry loop; state records how many
        // times that happened so a runaway loop is visible rather than silently spinning.
        const visits = { ...(state?.visits ?? {}) };
        visits[step.id] = (visits[step.id] ?? 0) + 1;
        if (visits[step.id] > 64) {
          fail('branch_loop_exceeded', `Step ${step.id} was entered more than 64 times.`);
        }
        const nextIndex = chosen === null ? cursor + 1 : indexOfStep(chosen);
        // Keep the whole branch trail, not just the last hop: "which path did this run take" must be
        // answerable from persisted state, and a single field would lose that as soon as a run branches
        // twice.
        const trail = [...(Array.isArray(state?.branchTrail) ? state.branchTrail : []),
          { from: step.id, to: chosen ?? (steps[nextIndex]?.id ?? null) }];
        return { ...state, step: nextIndex, visits, branchTrail: trail.slice(-32),
          lastBranch: chosen };
      },
    } : {}),
    preconditions: Object.fromEntries(preconditionIds.map((id) => [id, () => ({ verdict: 'allow' })])),
    verifier: steps ? stepVerifier : verifier,
  });
}

/**
 * Choose the next step id for a step, honouring declared branches in order.
 *
 * Returns null when no rule matched, which means "proceed to the following step". Conditions read through
 * a bounded, workspace-scoped reader: bare filenames only, so a branch cannot inspect anything outside the
 * task's own workspace.
 */
function resolveNext(step, { task, state }) {
  if (!step.next || step.next.length === 0) return null;
  const workspace = task.workspaceRoot;
  const context = {
    state,
    workspace,
    digest: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    readBytes: (path, options) => {
      try { return readFileSync(path); } catch (error) {
        if (options?.allowMissing && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) return null;
        throw error;
      }
    },
  };
  for (const rule of step.next) {
    // A rule without `when` is the default and matches unconditionally; it should be listed last, and the
    // validator does not reorder anything, so an early default simply short-circuits the rest.
    if (rule.when === null) return rule.goto;
    if (rule.when.evaluate(context)) return rule.goto;
  }
  return null;
}

/**
 * A registry that can hold hand-written recipes and generated ones side by side.
 *
 * Generated recipes are keyed by `recipeId:version`, so a spec change produces a new key instead of
 * mutating a recipe that an in-flight run already pinned.
 */
export function createRecipeRegistry({ initial = [] } = {}) {
  const recipes = new Map();
  const register = (recipe) => {
    const key = `${recipe.id}:${recipe.version}`;
    if (recipes.has(key)) fail('duplicate_recipe', `Recipe ${key} is already registered.`);
    recipes.set(key, recipe);
    return recipe;
  };
  for (const recipe of initial) register(recipe);
  return Object.freeze({
    get(key) { return recipes.get(key) ?? null; },
    list() { return Object.freeze([...recipes.keys()].sort()); },
    register,
    /** Generate and register from a specification; the caller supplies the trusted effect table. */
    generate(spec, options) {
      const recipe = buildRecipeFromSpec(spec, options);
      return register(recipe);
    },
  });
}
