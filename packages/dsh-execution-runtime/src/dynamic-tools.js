import { RuntimeContractError, requireString, TASK_ORIGINS, validateTaskProvenance } from './contracts.js';
import { buildRecipeFromSpec, createRecipeRegistry, recipeIdentity } from './recipe-factory.js';
import { describePrimitives, VERIFIER_PRIMITIVES } from './verifier-primitives.js';
import { describeConditions } from './condition-primitives.js';
import { readKnowledge, writeKnowledge } from './knowledge.js';
import { classifyRunOutcome } from './recipe-library.js';
import { validateBindingPage } from './store.js';

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
    origin: { type: 'string', enum: [...TASK_ORIGINS],
      description: 'Optional caller-declared task origin; omission remains unknown.' },
    principleRefs: { type: 'array', items: { type: 'string' },
      description: 'Optional caller-declared principle references: at most 32 nonblank strings of at most 256 characters each. An explicit empty array differs from omission; references are not independently verified.' },
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
export function createExecuteTool({ store, schedulerFor, toolEffects, mount, registry = null,
  library = null, analyzeRun = null }) {
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
      + 'pipeline, so unknown side effects stay frozen for reconciliation. Dynamic analysis is disabled unless '
      + 'the host explicitly enables it. When enabled, it may send task goals, scope, paths, arguments, outcomes '
      + 'and evidence references to the configured external provider; no redaction is guaranteed. Analysis '
      + 'records proposals only and shares the task deadline and the host provider timeout.',
    parameters: SPEC_PARAMETERS,
    output: { schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (!exec?.agent) fail('authority_unavailable', 'A runtime task needs the calling agent.');
      requireString(args?.goal, 'goal');
      const provenance = validateTaskProvenance(args);
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
      const candidate = buildRecipeFromSpec(recipeSpec, { toolEffects });
      for (const name of candidate.allowedTools) {
        if (!mount.allowedTools.includes(name)) fail('authority_denied', `The mount does not allow ${name}.`);
      }
      const key = `${candidate.id}:${candidate.version}`;
      const existing = recipes.get(key);
      if (existing && (recipeIdentity(existing) === null || recipeIdentity(existing) !== recipeIdentity(candidate))) {
        fail('recipe_identity_collision', `Recipe ${key} has a different or unverified identity.`);
      }
      const known = library ? library.assertIdentity(key, recipeIdentity(candidate)) : false;
      if (library && !known) library.record(recipeSpec, { goalPattern: args.goal, toolEffects });
      const recipe = existing ?? recipes.register(candidate);
      generated.add(key);

      const taskId = typeof args?.taskId === 'string' && args.taskId ? args.taskId : `dynamic:${Date.now()}`;
      const task = { taskId, recipeId: recipe.id, recipeVersion: recipe.version, goal: args.goal,
        scopeRef: mount.scopeRef, workspaceRoot: mount.workspaceRoot,
        inputs: args.inputs, deadlineAt: Date.now() + deadlineMs, ...provenance };
      const scheduler = schedulerFor(exec.agent, recipes);
      const authority = { scopeRef: mount.scopeRef, workspaceRoot: mount.workspaceRoot,
        allowedTools: mount.allowedTools, agent: exec.agent };
      let run = await scheduler.run(task, { authority, signal: exec.signal });
      let analysis = null;
      if (run.status === 'waiting_analysis') {
        if (typeof analyzeRun !== 'function') analysis = { status: 'analysis_unavailable' };
        else {
          try { analysis = await analyzeRun({ taskId, authority, signal: exec.signal }); }
          catch { analysis = { status: 'analysis_unavailable' }; }
        }
        // Refresh the run after analysis when it is backed by the store. A scheduler may be supplied
        // without a persisted run (test fixtures, embedded callers); in that case keep the scheduler's
        // returned state instead of failing a task that already settled.
        try { run = store.getRun(taskId); } catch { /* Keep the scheduler's run state. */ }
      }

      // Record what was learned only *after* the run settled, and only through the same counters the
      // library uses for everyone. Recording before the outcome would let a failing recipe look proven.
      let libraryNote = null;
      if (library) {
        try {
          library.assertIdentity(key, recipeIdentity(recipe));
          const succeeded = classifyRunOutcome(run.status);
          if (succeeded !== null) library.recordOutcome({ recipeKey: key, status: run.status, taskId: run.task.taskId });
          libraryNote = { recipeKey: key, reused: known, succeeded };
        } catch (error) {
          // A library problem must not fail a run that already happened: the work is done either way, and
          // reporting a task failure because bookkeeping failed would be a false negative.
          libraryNote = { error: error?.code ?? 'library_unavailable' };
        }
      }

      return { taskId: run.task.taskId, status: run.status, reason: run.reason,
        recipe: `${recipe.id}@${recipe.version}`, verifier: recipe.verifier.id,
        budgetUsage: run.budgetUsage, library: libraryNote, ...(analysis === null ? {} : { analysis }) };
    },
  };
}

/** Read historical recipes and their selected-verifier counts as retrieval hints. */
export function createLibraryTool({ library, store }) {
  return {
    name: 'runtime_recipes',
    description: 'List recipe specifications that have been used before, ordered by how often they were '
      + 'verified by the selected verifier. These mixed-origin counts are retrieval heuristics, not production evidence. '
      + 'Given a goal, suggests the closest recorded specifications. Each reuseStatus reports '
      + 'identity_unverifiable or identity_verified_requires_admission; the latter is not execution permission. '
      + 'Historical entries are data for inspection, never auto-run. Current host authority, identity and '
      + 'verification still apply to any later runtime_execute call. Counts include all origins; their historical '
      + 'origin split is unknown. Success means completion under the selected verifier; updates may be lost or '
      + 'duplicated, and counts do not independently prove the goal. Each entry exposes this in countBasis. '
      + 'Optional bindingLimit requests a separate bounded snapshot of current statuses of new validated bindings, '
      + 'grouped by exact recipe id and version and caller-declared origin; truncation and unavailable rows are explicit. '
      + 'With bindingCursor and an explicit bindingLimit, page by rowid within a high watermark; empty cursor starts. '
      + 'Membership assumes immutable no-delete bindings, normal implicit rowid insertion, no VACUUM, exhaustion, explicit rowids or database/schema replacement. '
      + 'The caller controls cursor position; it proves neither completeness, provenance nor goals. Statuses use a per-page snapshot and can change across pages. '
      + 'This is not independent goal proof or production verification.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Optional goal text; returns the closest recorded recipes.' },
        minVerifiedRuns: { type: 'number',
          description: 'Minimum historical selected-verifier completion count across all origins; defaults to 1.' },
        limit: { type: 'number', description: 'Maximum entries returned; defaults to 10.' },
        bindingLimit: { type: 'number', description: 'Optional bound-run snapshot limit, an integer from 1 to 100.' },
        bindingCursor: { type: 'string', description: 'Opt into rowid pagination: empty string starts; use nextCursor to continue. Requires bindingLimit.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      if (args?.bindingCursor !== undefined) validateBindingPage(args.bindingLimit, args.bindingCursor);
      if (!library) return { available: false, reason: 'The recipe library is not mounted.' };
      const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10;
      // A goal asks "what fits this"; without one it is simply "what has worked".
      const entries = typeof args?.goal === 'string' && args.goal.trim()
        ? library.suggest(args.goal, { limit })
        : library.list({ minVerifiedRuns: Number.isSafeInteger(args?.minVerifiedRuns)
          ? Math.max(0, args.minVerifiedRuns) : 1, limit });
      const result = { available: true, matched: typeof args?.goal === 'string' && Boolean(args.goal.trim()),
        count: entries.length, entries };
      if (args?.bindingCursor !== undefined) result.bindingSummary = store?.pageRecipeOutcomes
        ? store.pageRecipeOutcomes({ limit: args.bindingLimit, cursor: args.bindingCursor })
        : { coverage: 'unavailable', reason: 'store_unavailable' };
      else if (args?.bindingLimit !== undefined) result.bindingSummary = store?.summarizeRecipeOutcomes
        ? store.summarizeRecipeOutcomes({ limit: args.bindingLimit })
        : { coverage: 'unavailable', reason: 'store_unavailable' };
      return result;
    },
  };
}

/** A read/write knowledge channel, backed by whatever adapter the host configured. */
export function createKnowledgeTool({ adapter = null, endpoint = null } = {}) {
  return {
    name: 'runtime_knowledge',
    description: 'Read or write the knowledge base through its owning domain. Reading returns content with '
      + 'its domain identity attached, so scratch notes are never relabelled as formal. Writing reports '
      + '"stored" and "indexed" as separate facts: content that was written but not made searchable is '
      + 'reported as such, never as a success. Without a configured adapter both directions refuse rather '
      + 'than returning an empty result that would read like "nothing found".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'Which direction to use.' },
        domain: { type: 'string', enum: ['formal', 'workspace', 'scratch'],
          description: 'Owning domain; it decides how much the content is trusted.' },
        id: { type: 'string', description: 'Knowledge id, e.g. a note name or topic.' },
        version: { type: 'string', description: 'Knowledge version.' },
        content: { type: 'object', description: 'For write: { path } of the file to index.',
          additionalProperties: true },
        origin: { type: 'string', description: 'For write: who produced this content; defaults to runtime.' },
      },
      required: ['action', 'domain', 'id', 'version'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (adapter === null) {
        return { available: false, reason: 'The knowledge channel is not configured.', endpoint };
      }
      const reference = { domain: args?.domain, id: args?.id, version: args?.version };
      try {
        if (args?.action === 'read') {
          const result = await readKnowledge({ adapter, reference, signal: exec?.signal });
          return { available: true, action: 'read', ref: result.ref, trust: result.trust,
            verified: result.verified, itemCount: result.content?.length ?? 0, content: result.content };
        }
        if (args?.action === 'write') {
          const result = await writeKnowledge({ adapter, reference, content: args?.content,
            origin: args?.origin ?? 'runtime', signal: exec?.signal });
          return { available: true, action: 'write', ref: result.ref, state: result.state,
            stored: result.stored, indexed: result.indexed, indexError: result.indexError };
        }
        return { available: true, action: 'refused', reason: 'action must be read or write' };
      } catch (error) {
        // A failure carries its reason code. Returning an empty list instead would read like "the knowledge
        // base has nothing", which is a different and misleading claim.
        return { available: true, action: args?.action, error: error?.code ?? 'knowledge_failed',
          message: String(error?.message ?? error).slice(0, 200) };
      }
    },
  };
}

/** Submit an approved repair pattern to the valve rule store, or report why it cannot. */
export function createPatternTool({ valveWriter = null, patterns = [], reason = null } = {}) {
  return {
    name: 'runtime_pattern',
    description: 'Submit an approved repair pattern to the valve rule store. The runtime does not decide that '
      + 'a pattern is approved: it requires a confirmed, unexpired, version-matched approval, and it never '
      + 'passes a human flag or a permit of its own. Note that whether the write is truly human-gated depends '
      + 'on which writer the host supplied — this tool cannot tell an autonomous writer from a gated one.',
    parameters: {
      type: 'object',
      properties: {
        patternId: { type: 'string', description: 'The pattern to submit.' },
        approval: { type: 'object', description: 'The approval ticket, as issued by the approval channel.',
          additionalProperties: true },
      },
      required: ['patternId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      if (valveWriter === null) {
        return { available: false, reason: reason ?? 'The valve write path is not configured.' };
      }
      const pattern = patterns.find((item) => item?.patternId === args?.patternId) ?? null;
      if (pattern === null) {
        // The body comes from the host's registry, never from the request: a caller may name a pattern, but
        // it may not describe one.
        return { available: true, written: false, reason: 'pattern_not_registered' };
      }
      try {
        const result = await valveWriter({ approval: args?.approval ?? null, pattern });
        return { available: true, written: result.written, ruleId: result.ruleId,
          patternVersion: result.patternVersion };
      } catch (error) {
        // An ineffective approval or a refusing store is a refusal, not a silent success.
        return { available: true, written: false, error: error?.code ?? 'valve_write_failed',
          message: String(error?.message ?? error).slice(0, 200) };
      }
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
