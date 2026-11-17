import { createHash } from 'node:crypto';
import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const HASH = /^[a-f0-9]{64}$/;

/**
 * A pattern is identified by what it actually constrains, never by an exit code or a model's label.
 * Two failures that differ only in their transient message are the same pattern; two different tools
 * or scopes never collapse into one.
 */
export function patternIdentity(input) {
  const value = jsonSnapshot(input);
  for (const key of ['recipeId', 'recipeVersion', 'scopeRef', 'verifierId', 'verifierVersion', 'trigger', 'toolName']) {
    requireString(value?.[key], key);
  }
  const digest = createHash('sha256').update(JSON.stringify({ recipeId: value.recipeId,
    recipeVersion: value.recipeVersion, scopeRef: value.scopeRef, verifierId: value.verifierId,
    verifierVersion: value.verifierVersion, trigger: value.trigger, toolName: value.toolName })).digest('hex');
  return { patternId: `pattern:${digest.slice(0, 32)}`, digest,
    constraint: { recipeId: value.recipeId, recipeVersion: value.recipeVersion, scopeRef: value.scopeRef,
      verifierId: value.verifierId, verifierVersion: value.verifierVersion, trigger: value.trigger,
      toolName: value.toolName } };
}

/**
 * Only a repair that was actually verified counts as evidence of success. Unknown, failed, blocked and
 * reconciled outcomes are recorded but never promote a pattern, and a repeated attempt inside one run
 * is one sample rather than independent confirmation.
 */
export function classifyRepairEvidence(entry) {
  const value = jsonSnapshot(entry);
  requireString(value?.taskId, 'taskId');
  requireString(value?.repairId, 'repairId');
  requireString(value?.patternId, 'patternId');
  if (!['settled', 'blocked', 'unknown', 'observed'].includes(value.status)) {
    fail('invalid_pattern_evidence', 'Repair evidence needs a recognized settlement status.');
  }
  if (value.status === 'settled' && typeof value.succeeded !== 'boolean') {
    fail('invalid_pattern_evidence', 'A settled repair must state whether it actually succeeded.');
  }
  if (value.status === 'observed') {
    return { counted: false, success: false, reason: 'evidence_gathering_is_not_a_repair' };
  }
  if (value.status === 'unknown') return { counted: false, success: false, reason: 'unknown_outcome' };
  if (value.status === 'blocked') return { counted: false, success: false, reason: 'never_dispatched' };
  // A verified failure is a real sample: it belongs in the denominator, and only in the denominator.
  if (value.succeeded !== true) return { counted: true, success: false, reason: 'verified_failure' };
  return { counted: true, success: true, reason: 'verified_repair' };
}

/**
 * Aggregate per-pattern evidence. Independent samples are keyed by run, so one run cannot manufacture
 * confidence by repairing itself repeatedly.
 */
export function summarizePatternEvidence(entries, { minRuns = 3, minSuccessRate = 0.66 } = {}) {
  if (!Array.isArray(entries)) fail('invalid_pattern_evidence', 'Pattern evidence must be an array.');
  if (!Number.isSafeInteger(minRuns) || minRuns < 1 || typeof minSuccessRate !== 'number'
    || !(minSuccessRate > 0 && minSuccessRate <= 1)) {
    fail('invalid_pattern_policy', 'A bounded run requirement and success rate are required.');
  }
  const byPattern = new Map();
  for (const entry of entries) {
    const classified = classifyRepairEvidence(entry);
    const current = byPattern.get(entry.patternId) ?? { patternId: entry.patternId, samples: 0, successes: 0,
      runs: new Set(), seenRepairs: new Set(), rejected: [] };
    if (current.seenRepairs.has(entry.repairId)) continue;
    current.seenRepairs.add(entry.repairId);
    if (!classified.counted) {
      current.rejected.push({ repairId: entry.repairId, reason: classified.reason });
      byPattern.set(entry.patternId, current);
      continue;
    }
    current.samples += 1;
    if (classified.success) current.successes += 1;
    // Every counted sample contributes its run, including failures: otherwise a failing run would vanish
    // from the denominator and the run count would only ever reflect successes.
    current.runs.add(entry.taskId);
    byPattern.set(entry.patternId, current);
  }
  return [...byPattern.values()].map((item) => {
    const independentRuns = item.runs.size;
    const successRate = item.samples === 0 ? 0 : item.successes / item.samples;
    // Promotion needs enough independent runs; repeated repairs inside one run never count as more evidence.
    const eligible = independentRuns >= minRuns && successRate >= minSuccessRate;
    return { patternId: item.patternId, samples: item.samples, successes: item.successes,
      independentRuns, successRate: Math.round(successRate * 1000) / 1000,
      rejected: item.rejected, eligible,
      status: eligible ? 'candidate' : independentRuns < minRuns ? 'insufficient_runs' : 'insufficient_success' };
  }).sort((a, b) => a.patternId.localeCompare(b.patternId));
}

/** A candidate view is read-only: it never activates a rule, and unverified evidence stays labelled. */
export function buildPatternCandidates(entries, options = {}) {
  return Object.freeze(summarizePatternEvidence(entries, options)
    .filter((item) => item.eligible)
    .map((item) => Object.freeze({ ...item, activatable: false,
      note: 'A candidate is not an active rule; activation requires explicit review.' })));
}
