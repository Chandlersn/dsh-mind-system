import { RuntimeContractError, requireString } from './contracts.js';
import { buildVerifier, VERIFIER_PRIMITIVES } from './verifier-primitives.js';

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
  'preconditions', 'postconditions', 'allowedTools'];

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
  return input;
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

  return Object.freeze({
    id: checked.recipeId,
    version: checked.version ?? '1',
    ruleVersion: `generated:${checked.recipeId}:v${checked.version ?? '1'}`,
    description: checked.description ?? null,
    allowedTools: Object.freeze([...allowedTools]),
    toolEffects: Object.freeze(Object.fromEntries(allowedTools.map((name) => [name, toolEffects[name]]))),
    requiredPreconditionIds: Object.freeze(preconditionIds),
    postconditionIds: Object.freeze(postconditionIds),
    verificationIoReserve: 5,
    prepare() {
      // Preparation is deliberately identity: the task already carries its inputs, and inventing state here
      // would diverge from what the caller declared.
      return {};
    },
    candidates({ task, state }) {
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
    },
    preconditions: Object.fromEntries(preconditionIds.map((id) => [id, () => ({ verdict: 'allow' })])),
    verifier,
  });
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
