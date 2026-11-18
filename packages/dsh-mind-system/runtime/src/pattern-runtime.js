import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';
import { approvalApplies } from './pattern-approval.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/**
 * Decide whether an approved pattern may replace analysis for this decision. A hit requires an approval
 * that still applies, a matching scope/trigger/tool, an unchanged version, and a pattern that has actually
 * proven itself on several independent runs. Anything short of that abstains and lets analysis run.
 */
export function matchPattern({ approval, pattern, context, evidence, now = Date.now } = {}) {
  requireString(context?.scopeRef, 'context.scopeRef');
  requireString(context?.trigger, 'context.trigger');
  requireString(context?.toolName, 'context.toolName');
  requireString(context?.recipeId, 'context.recipeId');
  requireString(context?.recipeVersion, 'context.recipeVersion');
  const checked = approvalApplies(approval, pattern, { now });
  if (!checked.applies) {
    // An unconfirmed, revoked, expired or re-versioned approval must abstain rather than guess.
    return Object.freeze({ hit: false, reason: checked.reason, analysesSuppressed: false });
  }
  for (const key of ['scopeRef', 'trigger', 'toolName']) {
    const expected = pattern[key];
    if (expected !== undefined && expected !== context[key]) {
      return Object.freeze({ hit: false, reason: `out_of_scope:${key}`, analysesSuppressed: false });
    }
  }
  if (pattern.recipeId !== undefined && pattern.recipeId !== context.recipeId) {
    return Object.freeze({ hit: false, reason: 'out_of_scope:recipeId', analysesSuppressed: false });
  }
  if (pattern.recipeVersion !== undefined && pattern.recipeVersion !== context.recipeVersion) {
    // A new template version is a new environment; an old pattern must not silently keep working.
    return Object.freeze({ hit: false, reason: 'out_of_scope:recipeVersion', analysesSuppressed: false });
  }
  if (evidence?.eligible !== true || (evidence.independentRuns ?? 0) < (evidence.minRuns ?? 0)) {
    return Object.freeze({ hit: false, reason: 'evidence_insufficient', analysesSuppressed: false });
  }
  return Object.freeze({ hit: true, reason: 'approved_pattern_hit', analysesSuppressed: true,
    patternId: pattern.patternId, patternVersion: approval.patternVersion });
}

/** Count a real reuse so revocation and rollback can be reasoned about from observed data. */
export function recordPatternHit(hit, { at = Date.now() } = {}) {
  if (!hit || hit.hit !== true) fail('invalid_pattern_hit', 'Only a real hit may be recorded.');
  return Object.freeze({ patternId: hit.patternId, patternVersion: hit.patternVersion, at: at(),
    analysesSuppressed: hit.analysesSuppressed === true });
}

/**
 * Evaluate a rollback request. Rolling back restores the previously confirmed version and demands a fresh
 * review of that exact version; silently restoring the old ticket is not allowed.
 */
export function planRollback({ approval, history, targetVersion, reason } = {}) {
  requireString(reason, 'reason');
  requireString(targetVersion, 'targetVersion');
  if (!Array.isArray(history) || !history.length) fail('invalid_rollback', 'A rollback needs recorded approval history.');
  const previous = history.find((item) => item?.patternVersion === targetVersion && item.status === 'confirmed');
  if (!previous) fail('rollback_target_not_found', 'The requested version was never confirmed.');
  const current = approval?.patternVersion;
  if (current === targetVersion) fail('invalid_rollback', 'The runtime already runs that version.');
  return Object.freeze({ rollbackTo: targetVersion, reason,
    // Restoring the content does not restore the ticket: that version must be reviewed again.
    requiresReview: true, supersededVersion: current ?? null });
}

/**
 * Apply a planned rollback: the target version becomes pending review again, and the retired approval is
 * kept as history rather than deleted.
 */
export function applyRollback({ approval, plan, now = Date.now } = {}) {
  if (!plan || plan.requiresReview !== true) fail('invalid_rollback', 'A rollback must be planned first.');
  if (!approval || approval.status !== 'confirmed') fail('invalid_rollback', 'Only a live approval can be rolled back.');
  return Object.freeze({ restored: Object.freeze({ ...approval, status: 'pending', reviewTicket: undefined,
    rolledBackAt: now(), rollbackReason: plan.reason }),
  retired: Object.freeze({ ...approval, status: 'superseded', supersededAt: now() }),
  requiresReview: true });
}
