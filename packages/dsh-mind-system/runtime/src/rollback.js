import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';
import { validateCompensationPlan, assessCompensation } from './compensation.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/**
 * A checkpoint records the business cursor plus the environment it was taken under. Restoring the cursor
 * alone would be unsound: a changed template or scope must invalidate the restore, exactly like resume.
 */
export function createCheckpoint({ taskId, stepIndex, state, environment, evidenceRef, now = Date.now } = {}) {
  requireString(taskId, 'taskId');
  requireString(evidenceRef, 'evidenceRef');
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) fail('invalid_checkpoint', 'A checkpoint needs a step index.');
  const value = jsonSnapshot(state);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_checkpoint', 'A checkpoint state must be an object.');
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('invalid_checkpoint', 'A checkpoint must record the environment it was taken under.');
  }
  for (const key of ['recipeId', 'recipeVersion', 'scopeRef', 'workspaceRoot']) requireString(environment[key], key);
  return Object.freeze({ taskId, stepIndex, state: value, environment: jsonSnapshot(environment),
    evidenceRef, createdAt: now() });
}

/**
 * Plan a rollback. Three distinct cases, and only the first two may proceed automatically:
 * read-only steps restore directly; reversible writes need a registered compensation whose before/after
 * versions were observed. Irreversible or unknown effects cannot be rolled back at all.
 */
export function planRollbackTo({ checkpoint, current, effect, compensation } = {}) {
  if (!checkpoint || checkpoint.taskId === undefined) fail('invalid_rollback', 'A checkpoint is required.');
  if (!current || typeof current !== 'object') fail('invalid_rollback', 'The current environment is required.');
  if (!['read', 'reversible_write', 'irreversible', 'unknown'].includes(effect)) {
    fail('invalid_rollback', 'The effect of the work being rolled back must be declared.');
  }
  // A checkpoint from a different environment is not a rollback point, it is a different task.
  for (const key of ['recipeId', 'recipeVersion', 'scopeRef', 'workspaceRoot']) {
    if (checkpoint.environment[key] !== current[key]) {
      return Object.freeze({ allowed: false, reason: `environment_changed:${key}`, requiresCompensation: false });
    }
  }
  if (effect === 'irreversible' || effect === 'unknown') {
    // There is no safe automatic undo for these; pretending otherwise would report a rollback that did not happen.
    return Object.freeze({ allowed: false, reason: `not_compensable:${effect}`, requiresCompensation: false });
  }
  if (effect === 'read') {
    return Object.freeze({ allowed: true, reason: 'read_only_restore', requiresCompensation: false,
      restoreState: checkpoint.state, evidenceRef: checkpoint.evidenceRef });
  }
  if (!compensation) {
    return Object.freeze({ allowed: false, reason: 'compensation_required', requiresCompensation: true });
  }
  let plan;
  try {
    plan = validateCompensationPlan(compensation);
  } catch {
    return Object.freeze({ allowed: false, reason: 'compensation_invalid', requiresCompensation: true });
  }
  return Object.freeze({ allowed: true, reason: 'reversible_write_with_compensation', requiresCompensation: true,
    restoreState: checkpoint.state, evidenceRef: checkpoint.evidenceRef, compensation: plan });
}

/**
 * Record the outcome of a rollback. Success requires the compensation to be independently verified against
 * the target; anything else leaves the run unresolved rather than reporting a completed rollback.
 */
export function settleRollback({ plan, verification, observedAfterSha256 } = {}) {
  if (!plan || plan.allowed !== true) fail('invalid_rollback', 'Only an allowed rollback can be settled.');
  if (plan.requiresCompensation !== true) {
    // A read-only restore needs no compensation proof, but it still needs its checkpoint evidence.
    return Object.freeze({ status: 'restored', completed: true, requiresCompensation: false,
      evidenceRef: plan.evidenceRef });
  }
  const assessed = assessCompensation({ plan: plan.compensation, observedAfterSha256, verification });
  if (assessed.completed) {
    return Object.freeze({ status: 'restored', completed: true, requiresCompensation: true,
      compensationStatus: assessed.status });
  }
  return Object.freeze({ status: 'unresolved', completed: false, requiresCompensation: true,
    compensationStatus: assessed.status, reason: assessed.reason });
}
