import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RuntimeContractError, jsonSnapshot, requireString, validateCandidate, validateTask, validateVerification } from '../src/contracts.js';

const fail = (message, code = 'invalid_compensation') => { throw new RuntimeContractError(code, message); };
const HASH = /^[a-f0-9]{64}$/;
const required = ['compensationId', 'targetTool', 'targetArguments', 'expectedBeforeSha256', 'expectedAfterSha256',
  'reason', 'sourceAttemptId'];

/**
 * A compensation plan states what it will restore, from which observed version, to which version. It is not a
 * rollback flag: it needs an independently verified target fact before it may be recorded as complete.
 */
export function validateCompensationPlan(input) {
  const value = jsonSnapshot(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A compensation plan must be a plain object.');
  const keys = Object.keys(value).sort();
  if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
    fail('A compensation plan requires exactly its declared fields.');
  }
  requireString(value.compensationId, 'compensationId');
  requireString(value.targetTool, 'targetTool');
  if (!value.targetArguments || typeof value.targetArguments !== 'object' || Array.isArray(value.targetArguments)) {
    fail('Compensation arguments must be an object.');
  }
  if (!HASH.test(value.expectedBeforeSha256) || !HASH.test(value.expectedAfterSha256)
    || value.expectedBeforeSha256 === value.expectedAfterSha256) {
    fail('Compensation must name distinct observed versions.');
  }
  if (value.reason !== 'restore_prior_version') fail('Only an explicit prior-version restore is a supported compensation.');
  requireString(value.sourceAttemptId, 'sourceAttemptId');
  return value;
}

/**
 * Build a prior-version restore plan for any template.
 *
 * The verifier identity is a parameter rather than a constant: an engine that only compensates one
 * template's verifier cannot support a second recipe, and the failure would look like a policy refusal
 * rather than the hard-coding it is. The caller must name the verifier it observed, and the plan is
 * rejected unless the source attempt was actually verified by that same verifier.
 */
export function buildCompensation({ task, sourceAttempt, verifierId, targetTool, observedSha256, priorSha256,
  priorContent, targetPath }) {
  const checked = validateTask(task);
  requireString(verifierId, 'verifierId');
  requireString(targetTool, 'targetTool');
  const attempt = sourceAttempt;
  if (!attempt || attempt.status !== 'settled' || !attempt.verification) fail('Compensation requires a settled source attempt.');
  const observed = validateVerification(attempt.verification);
  if (observed.verifierId !== verifierId) {
    fail(`Compensation must be based on the ${verifierId} observation, not ${observed.verifierId}.`);
  }
  if (!HASH.test(observedSha256) || !HASH.test(priorSha256)) fail('Compensation requires concrete content versions.');
  if (typeof priorContent !== 'string') fail('Compensation requires the prior content it will restore.');
  return validateCompensationPlan({ compensationId: `restore:${createHash('sha256')
    .update(`${checked.taskId}:${attempt.attemptId}:${priorSha256}`).digest('hex').slice(0, 32)}`,
  targetTool,
  targetArguments: { path: targetPath, content: priorContent, expectedSha256: observedSha256 },
  expectedBeforeSha256: observedSha256, expectedAfterSha256: priorSha256,
  reason: 'restore_prior_version', sourceAttemptId: attempt.attemptId });
}

/** The JSON template's plan: a thin wrapper so the template keeps its tool name out of generic code. */
export function buildJsonCompensation(input) {
  return buildCompensation({ ...input, verifierId: 'json-source-output', targetTool: 'runtime_replace_json' });
}

/**
 * Decide whether a compensation may be recorded as applied. Completion needs a target fact from a registered
 * verifier; a failed or unverifiable compensation stays open instead of pretending the rollback happened.
 */
export function assessCompensation({ plan: input, observedAfterSha256, verification }) {
  const plan = validateCompensationPlan(input);
  const checked = validateVerification(verification);
  if (checked.status !== 'pass') {
    return { status: 'unverified', completed: false, reason: checked.reason ?? 'compensation_verification_failed' };
  }
  if (!Array.isArray(checked.evidenceRefs) || checked.evidenceRefs.length === 0) {
    return { status: 'unverified', completed: false, reason: 'compensation_evidence_missing' };
  }
  if (typeof observedAfterSha256 !== 'string' || !HASH.test(observedAfterSha256)) {
    return { status: 'unverified', completed: false, reason: 'compensation_target_fact_missing' };
  }
  if (observedAfterSha256 !== plan.expectedAfterSha256) {
    return { status: 'diverged', completed: false, reason: 'compensation_target_mismatch' };
  }
  return { status: 'completed', completed: true, reason: 'compensation_verified' };
}

const immutable = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
};

/**
 * A registered compensation for a specific tool. Irreversible effects are never compensable, and a target that
 * disagrees with the plan leaves the run unresolved rather than reporting a successful rollback.
 */
export function registerCompensation({ toolName, effect = 'reversible_write', build, verify }) {
  requireString(toolName, 'toolName');
  if (effect !== 'reversible_write') fail('Only reversible writes may be compensated.', 'compensation_unsupported');
  if (typeof build !== 'function' || typeof verify !== 'function') fail('A compensation needs native build and verify callbacks.');
  return immutable({ toolName, effect, build, verify });
}

export function assertCompensationSupported(tool) {
  const effect = tool?.effect ?? tool;
  if (!['read', 'reversible_write'].includes(effect)) {
    fail('Irreversible or unknown effects cannot be compensated.', 'compensation_unsupported');
  }
  return true;
}

/** Ensure a plan targets the same tool and argument shape the source attempt actually used. */
export function bindCompensationToAttempt(plan, sourceCandidate) {
  const checked = validateCompensationPlan(plan);
  const candidate = validateCandidate(sourceCandidate);
  if (checked.sourceAttemptId !== sourceCandidate.attemptId) {
    fail('The compensation names a different source attempt.', 'compensation_binding_mismatch');
  }
  if (checked.targetTool !== candidate.toolName) {
    fail('The compensation must target the same tool as the source action.', 'compensation_binding_mismatch');
  }
  if (!isDeepStrictEqual(Object.keys(checked.targetArguments).sort(),
    Object.keys(candidate.arguments).sort())) {
    fail('The compensation cannot introduce new argument shapes.', 'compensation_binding_mismatch');
  }
  return checked;
}
