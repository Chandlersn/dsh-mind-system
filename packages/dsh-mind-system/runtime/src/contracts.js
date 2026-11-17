import { isAbsolute } from 'node:path';

export class RuntimeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeContractError';
    this.code = code;
  }
}

export function failureCode(failure, fallback = 'runtime_failed') {
  try {
    const code = failure?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : fallback;
  } catch { return fallback; }
}

export const DEFAULT_BUDGET = Object.freeze({
  maxAttempts: 50,
  maxToolCalls: 20,
  maxIoOperations: 100,
  maxDecisionRequests: 100,
  maxAnalysisCalls: 5,
  maxRecoveryReads: 3,
  maxCompensations: 1,
  recoveryTimeoutMs: 60_000,
});

export function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) {
    throw new RuntimeContractError('invalid_contract', `${field} must be a non-empty bounded string.`);
  }
  return value;
}

export function jsonSnapshot(value) {
  const visiting = new Set();
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || visiting.has(item)) {
      throw new RuntimeContractError('invalid_json', 'Runtime values must be lossless JSON.');
    }
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) {
      throw new RuntimeContractError('invalid_json', 'Runtime objects must be plain JSON objects.');
    }
    visiting.add(item);
    const result = Array.isArray(item)
      ? Array.from(item, (value) => visit(value))
      : Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]));
    visiting.delete(item);
    return result;
  };
  return visit(value);
}

export function validateBudget(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuntimeContractError('invalid_budget', 'Budget limits must be an object.');
  }
  const budget = { ...DEFAULT_BUDGET, ...jsonSnapshot(input) };
  for (const [key, value] of Object.entries(budget)) {
    if (!Object.hasOwn(DEFAULT_BUDGET, key) || !Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeContractError('invalid_budget', `Invalid budget field: ${key}.`);
    }
  }
  return budget;
}

export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuntimeContractError('invalid_task', 'A task object is required.');
  }
  for (const field of ['taskId', 'recipeId', 'recipeVersion', 'goal', 'scopeRef', 'workspaceRoot']) {
    requireString(input[field], field);
  }
  if (!isAbsolute(input.workspaceRoot)) {
    throw new RuntimeContractError('invalid_scope', 'workspaceRoot must be absolute.');
  }
  if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) {
    throw new RuntimeContractError('invalid_deadline', 'deadlineAt must be an absolute millisecond timestamp.');
  }
  if (!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs)) {
    throw new RuntimeContractError('invalid_task', 'inputs must be an object.');
  }
  return jsonSnapshot({
    taskId: input.taskId,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    goal: input.goal,
    scopeRef: input.scopeRef,
    workspaceRoot: input.workspaceRoot,
    inputs: input.inputs,
    deadlineAt: input.deadlineAt,
    budget: validateBudget(input.budget),
  });
}

export function validateCandidate(input) {
  const value = jsonSnapshot(input);
  for (const field of ['candidateId', 'toolName', 'progressKey']) requireString(value?.[field], field);
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
    throw new RuntimeContractError('invalid_candidate', 'Candidate arguments must be an object.');
  }
  for (const field of ['preconditionIds', 'postconditionIds']) {
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      throw new RuntimeContractError('invalid_candidate', `${field} must contain at least one verifier id.`);
    }
    for (const item of value[field]) requireString(item, field);
  }
  if (!['read', 'reversible_write', 'irreversible', 'unknown'].includes(value.effect)) {
    throw new RuntimeContractError('invalid_candidate', 'Candidate effect must be declared.');
  }
  requireString(value.source?.recipeId, 'source.recipeId');
  requireString(value.source?.version, 'source.version');
  return value;
}

export function validateVerification(input) {
  const value = jsonSnapshot(input);
  if (!['pass', 'fail', 'unknown'].includes(value?.status)
    || !['advanced', 'unchanged', 'unknown'].includes(value.progress)
    || ![true, false, null].includes(value.goalSatisfied)) {
    throw new RuntimeContractError('invalid_verification', 'Verification status, progress, and goal state are required.');
  }
  requireString(value.verifierId, 'verifierId');
  requireString(value.verifierVersion, 'verifierVersion');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref)) {
    throw new RuntimeContractError('invalid_verification', 'Evidence references must be explicit strings.');
  }
  if ((value.status === 'pass' || value.goalSatisfied === true) && value.evidenceRefs.length === 0) {
    throw new RuntimeContractError('invalid_verification', 'Passing verification requires evidence references.');
  }
  if (value.goalSatisfied === true && value.status !== 'pass') {
    throw new RuntimeContractError('invalid_verification', 'Only passing verification may satisfy the goal.');
  }
  return value;
}
