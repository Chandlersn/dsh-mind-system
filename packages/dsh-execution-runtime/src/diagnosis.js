import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const STRUCTURES = ['unidirectional', 'cyclic', 'duality', 'nested', 'unknown'];
const MAX_BYTES = 8 * 1024;

/**
 * Decide whether a failure needs structural diagnosis at all. A plainly explained execution error is
 * repaired directly; only a failure that repeated after repair attempts is worth a causal reading.
 */
export function classifyFailureRoute({ trigger, signatureFailures = 0, repairAttempts = 0,
  selfExplanatory = false, threshold = 2 } = {}) {
  requireString(trigger, 'trigger');
  if (!Number.isSafeInteger(signatureFailures) || signatureFailures < 0
    || !Number.isSafeInteger(repairAttempts) || repairAttempts < 0
    || !Number.isSafeInteger(threshold) || threshold < 1) {
    fail('invalid_diagnosis_route', 'Failure counts and threshold must be bounded integers.');
  }
  if (selfExplanatory === true) {
    // The error already says what is wrong: diagnosing causality here would add cost without information.
    return Object.freeze({ route: 'repair_directly', reason: 'self_explanatory_error' });
  }
  if (signatureFailures < threshold && repairAttempts < threshold) {
    return Object.freeze({ route: 'repair_directly', reason: 'first_occurrence' });
  }
  return Object.freeze({ route: 'diagnose', reason: 'repeated_without_progress' });
}

/**
 * Validate a structural diagnosis. `unknown` is a first-class answer: it is recorded as unknown and never
 * upgraded into an invented cause, because a guessed structure would steer the repair in the wrong direction.
 */
export function validateDiagnosis(input) {
  const value = jsonSnapshot(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_diagnosis', 'A diagnosis must be an object.');
  const keys = Object.keys(value).sort();
  const allowed = ['structure', 'confidence', 'evidenceRefs', 'summary'];
  if (keys.some((key) => !allowed.includes(key)) || !Object.hasOwn(value, 'structure')) {
    fail('invalid_diagnosis', 'A diagnosis carries only structure, confidence, evidence and a summary.');
  }
  if (!STRUCTURES.includes(value.structure)) fail('invalid_diagnosis', 'Unknown causal structure label.');
  if (Object.hasOwn(value, 'confidence')
    && (typeof value.confidence !== 'number' || !(value.confidence >= 0 && value.confidence <= 1))) {
    fail('invalid_diagnosis', 'Confidence must be a number from 0 to 1.');
  }
  if (Object.hasOwn(value, 'evidenceRefs')
    && (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref))) {
    fail('invalid_diagnosis', 'Evidence references must be strings.');
  }
  if (Object.hasOwn(value, 'summary') && (typeof value.summary !== 'string' || value.summary.length > 2000)) {
    fail('invalid_diagnosis', 'A summary is bounded text.');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) fail('invalid_diagnosis', 'The diagnosis exceeds its size limit.');
  // An unknown structure cannot claim confidence or a cause; it must stay visibly unresolved.
  if (value.structure === 'unknown' && Object.hasOwn(value, 'confidence')) {
    fail('invalid_diagnosis', 'An unknown structure must not carry a confidence value.');
  }
  return Object.freeze({ structure: value.structure,
    confidence: value.structure === 'unknown' ? null : (value.confidence ?? null),
    evidenceRefs: Object.freeze([...(value.evidenceRefs ?? [])]),
    summary: value.summary ?? null,
    resolved: value.structure !== 'unknown' });
}

/**
 * Escalate at most once per signature. The diagnosis answers "what kind of problem is this", never
 * "what should we do next" — it cannot authorize a repair, and an unresolved answer stops for a human.
 */
export function createDiagnosisEscalation({ diagnose, maxCallsPerTask = 1 } = {}) {
  if (typeof diagnose !== 'function') fail('invalid_diagnosis_escalation', 'A diagnosis transport is required.');
  if (!Number.isSafeInteger(maxCallsPerTask) || maxCallsPerTask < 1 || maxCallsPerTask > 3) {
    fail('invalid_diagnosis_escalation', 'Diagnosis calls per task must be bounded from 1 to 3.');
  }
  const used = new Map();
  return Object.freeze({
    async request({ taskId, trigger, signature, failureContext, signal } = {}) {
      requireString(taskId, 'taskId');
      requireString(trigger, 'trigger');
      requireString(signature, 'signature');
      const count = used.get(taskId) ?? 0;
      if (count >= maxCallsPerTask) {
        // Exhausting the diagnosis budget is a stop condition, not an invitation to guess.
        return Object.freeze({ status: 'budget_exhausted', diagnostic: null });
      }
      used.set(taskId, count + 1);
      let raw;
      try {
        raw = await diagnose({ trigger, signature, context: jsonSnapshot(failureContext ?? {}), signal });
      } catch (failure) {
        return Object.freeze({ status: 'unavailable', diagnostic: null, reason: String(failure?.code ?? 'diagnosis_failed') });
      }
      try {
        const diagnostic = validateDiagnosis(raw);
        return Object.freeze({ status: diagnostic.resolved ? 'resolved' : 'unknown', diagnostic });
      } catch {
        // A malformed answer is treated as no answer: it must not be loosened into a usable cause.
        return Object.freeze({ status: 'unavailable', diagnostic: null, reason: 'invalid_diagnosis' });
      }
    },
  });
}

/**
 * Convert a diagnosis outcome into the run's next state. Only an unresolved or unavailable diagnosis stops
 * for a human; a resolved structure is recorded as guidance and still needs its own verified repair.
 */
export function nextStepAfterDiagnosis(outcome) {
  if (!outcome) fail('invalid_diagnosis_outcome', 'A diagnosis outcome is required.');
  if (outcome.status === 'resolved') {
    return Object.freeze({ status: 'waiting_analysis', reason: `diagnosed_${outcome.diagnostic.structure}`,
      repairAuthorized: false,
      note: 'A structure is guidance, not authorization; any repair still passes admission and verification.' });
  }
  if (outcome.status === 'unknown') {
    return Object.freeze({ status: 'waiting_human', reason: 'diagnosis_unknown', repairAuthorized: false,
      note: 'The cause is unresolved; guessing a structure would steer the repair the wrong way.' });
  }
  if (outcome.status === 'budget_exhausted') {
    return Object.freeze({ status: 'waiting_human', reason: 'diagnosis_budget_exhausted', repairAuthorized: false });
  }
  return Object.freeze({ status: 'waiting_human', reason: 'diagnosis_unavailable', repairAuthorized: false });
}
