import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { jsonSnapshot, validateCandidate, validateTask } from './contracts.js';

const strings = (value) => Array.isArray(value)
  && value.every((item) => typeof item === 'string' && item.trim().length > 0);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * Admit a concrete action without executing it. Authority and recipe come from
 * the trusted caller, never from the candidate or model output.
 * tools is a visible registry with get(name, agent), or a lookup(name, agent).
 * validateArguments({ tool, arguments, task, candidate, signal }) must return
 * host schema violations as string[]; an empty array means valid arguments.
 * Optional policy checks use the same context and return { verdict, reason? }.
 * This result authorizes no bypass of the host's execution-time policy pipeline.
 */
export async function admitCandidate({ task, candidate, authority, recipe, tools, signal,
  validateArguments, constraintCheck, negativeRuleCheck } = {}) {
  const checks = [];
  let current = 'signal';
  const record = (id, result, reason) => {
    checks.push({ id, result, ...(reason ? { reason } : {}) });
  };
  const finish = (verdict, reason) => ({ verdict, reason, checks });
  const stop = (verdict, reason) => {
    record(current, verdict, reason);
    return finish(verdict, reason);
  };
  const cancelled = () => signal?.aborted === true;
  try {
    if (cancelled()) return stop('unavailable', 'aborted');
    current = 'contracts';
    try {
      task = freeze(validateTask(task));
      candidate = freeze(validateCandidate(candidate));
    } catch {
      return stop('deny', 'invalid_contract');
    }
    record(current, 'allow');

    current = 'authority';
    if (!authority || typeof authority.scopeRef !== 'string' || !authority.scopeRef.trim()
      || typeof authority.workspaceRoot !== 'string' || !isAbsolute(authority.workspaceRoot)
      || !strings(authority.allowedTools)) return stop('unavailable', 'authority_missing_or_invalid');
    const scopeRef = authority.scopeRef;
    const workspaceRoot = authority.workspaceRoot;
    const allowedTools = jsonSnapshot(authority.allowedTools);
    const agent = authority.agent;
    if (task.scopeRef !== scopeRef) return stop('deny', 'scope_mismatch');
    const [authorizedRoot, taskRoot] = await Promise.all([
      realpath(workspaceRoot), realpath(task.workspaceRoot),
    ]);
    if (authorizedRoot !== taskRoot) return stop('deny', 'workspace_mismatch');
    if (!(await stat(authorizedRoot)).isDirectory()) return stop('unavailable', 'workspace_not_directory');
    record(current, 'allow');

    current = 'recipe';
    if (!recipe || typeof recipe.id !== 'string' || !recipe.id.trim()
      || typeof recipe.version !== 'string' || !recipe.version.trim()
      || !strings(recipe.allowedTools) || !strings(recipe.requiredPreconditionIds)
      || !recipe.preconditions || typeof recipe.preconditions !== 'object'
      || Array.isArray(recipe.preconditions)) return stop('unavailable', 'recipe_missing_or_invalid');
    if (task.recipeId !== recipe.id || task.recipeVersion !== recipe.version
      || candidate.source.recipeId !== recipe.id || candidate.source.version !== recipe.version) {
      return stop('deny', 'recipe_binding_mismatch');
    }
    const recipeTools = jsonSnapshot(recipe.allowedTools);
    const requiredIds = jsonSnapshot(recipe.requiredPreconditionIds);
    const preconditions = new Map(Object.entries(recipe.preconditions));
    const declaredEffects = recipe.toolEffects === undefined ? null : jsonSnapshot(recipe.toolEffects);
    if (requiredIds.some((id) => typeof preconditions.get(id) !== 'function')) {
      return stop('unavailable', 'required_precondition_unregistered');
    }
    if (requiredIds.some((id) => !candidate.preconditionIds.includes(id))) {
      return stop('deny', 'required_precondition_omitted');
    }
    if (candidate.preconditionIds.some((id) => typeof preconditions.get(id) !== 'function')) {
      return stop('deny', 'unknown_precondition');
    }
    record(current, 'allow');

    current = 'effect';
    if (!['read', 'reversible_write'].includes(candidate.effect)) return stop('deny', 'effect_not_supported');
    record(current, 'allow');
    current = 'tool_authorization';
    if (!allowedTools.includes(candidate.toolName) || !recipeTools.includes(candidate.toolName)) {
      return stop('deny', 'tool_not_authorized');
    }
    record(current, 'allow');
    current = 'effect_binding';
    if (!declaredEffects || typeof declaredEffects !== 'object' || Array.isArray(declaredEffects)
      || !Object.hasOwn(declaredEffects, candidate.toolName)) return stop('unavailable', 'effect_declaration_missing');
    if (declaredEffects[candidate.toolName] !== candidate.effect) return stop('deny', 'effect_mismatch');
    record(current, 'allow');

    current = 'tool_visibility';
    if (typeof tools !== 'function' && typeof tools?.get !== 'function') {
      return stop('unavailable', 'tool_lookup_missing');
    }
    const tool = await (typeof tools === 'function'
      ? tools(candidate.toolName, agent) : tools.get(candidate.toolName, agent));
    if (cancelled()) return stop('unavailable', 'aborted');
    if (!tool) return stop('deny', 'tool_not_visible');
    if (tool.name !== candidate.toolName) return stop('unavailable', 'tool_lookup_mismatch');
    record(current, 'allow');

    const context = Object.freeze({ task, candidate, tool, arguments: candidate.arguments, signal });
    current = 'arguments';
    if (typeof validateArguments !== 'function') return stop('unavailable', 'schema_validator_missing');
    const violations = await validateArguments(context);
    if (cancelled()) return stop('unavailable', 'aborted');
    if (!strings(violations)) return stop('unavailable', 'schema_validation_invalid_result');
    if (violations.length) return stop('deny', 'invalid_tool_arguments');
    record(current, 'allow');

    const gates = candidate.preconditionIds.map((id) => [`precondition:${id}`, preconditions.get(id)]);
    if (constraintCheck !== undefined) gates.push(['constraints', constraintCheck]);
    if (negativeRuleCheck !== undefined) gates.push(['negative_rules', negativeRuleCheck]);
    for (const [id, check] of gates) {
      current = id;
      if (cancelled()) return stop('unavailable', 'aborted');
      if (typeof check !== 'function') return stop('unavailable', 'check_missing');
      const result = await check(context);
      if (cancelled()) return stop('unavailable', 'aborted');
      if (!result || !['allow', 'deny', 'unavailable'].includes(result.verdict)
        || (result.reason !== undefined && typeof result.reason !== 'string')) {
        return stop('unavailable', 'check_invalid_result');
      }
      if (result.verdict !== 'allow') return stop(result.verdict, result.reason || `${id}_not_allowed`);
      record(current, 'allow', result.reason);
    }
    current = 'signal';
    if (cancelled()) return stop('unavailable', 'aborted');
    record(current, 'allow');
    return finish('allow', 'admitted');
  } catch {
    return stop('unavailable', cancelled() ? 'aborted' : `${current}_unavailable`);
  }
}
