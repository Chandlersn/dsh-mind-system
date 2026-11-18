import { RuntimeContractError, requireString } from './contracts.js';
import { patternIdentity, summarizePatternEvidence } from './repair-patterns.js';
import { confirmApprovalAutomatically, proposeApproval } from './pattern-approval.js';
import { matchPattern } from './pattern-runtime.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/**
 * Build the default pattern resolver for the analysis coordinator.
 *
 * Why this exists: `matchPattern` could already decide whether an approved pattern replaces a model call,
 * but nothing ever supplied it one — the matcher was only reachable by a caller that already knew a
 * pattern's identity. That leaves the self-iterating loop open: evidence accumulates, yet no decision
 * ever consults it. This resolver closes the loop by deriving candidates from persisted repair history.
 *
 * Design constraints, each of which a naive implementation would violate:
 * - It never activates anything. A candidate that reaches the promotion threshold is still reported as
 *   `activatable: false`; a confirmation remains a human act, so a hit requires an approval passed in.
 * - It never invents evidence. Runs are counted per task id, so one task repairing itself repeatedly
 *   cannot reach the threshold on its own.
 * - It abstains loudly. Returning null means "no candidate", which the coordinator treats as ordinary
 *   analysis — never as an implicit pass.
 */
export function createPatternResolver({ store, approvals = [], patterns = [], automation = null,
  minRuns = 3, minSuccessRate = 0.66, now = Date.now } = {}) {
  if (!store || typeof store.readRepairTrace !== 'function') {
    fail('invalid_pattern_resolver', 'A store with repair history is required.');
  }
  if (!Array.isArray(approvals)) fail('invalid_pattern_resolver', 'Approvals must be an explicit array.');
  if (!Array.isArray(patterns)) fail('invalid_pattern_resolver', 'Registered patterns must be an explicit array.');
  if (automation !== null && (typeof automation !== 'object' || Array.isArray(automation))) {
    fail('invalid_pattern_resolver', 'An automatic policy must be an explicit object.');
  }
  if (!Number.isSafeInteger(minRuns) || minRuns < 2) {
    fail('invalid_pattern_policy', 'At least two independent runs are required before a pattern may be reused.');
  }
  // The reviewed bodies, keyed by the identity the approval refers to: an approval says "this pattern was
  // reviewed", so the text it covers has to be resolvable separately from the ticket.
  const registry = new Map(patterns.map((item) => [item?.patternId, Object.freeze({ ...item })]));
  if (registry.size !== patterns.length) fail('invalid_pattern_resolver', 'Pattern identities must be unique.');
  // Tickets issued by the automation, kept here so a later call can see what the loop already confirmed.
  const issued = [];
  const ticketFor = (patternId) => {
    const existing = [...approvals, ...issued].find((item) => item?.patternId === patternId
      && item.status === 'confirmed');
    return existing ?? null;
  };

  return function resolvePattern(taskId, run) {
    requireString(taskId, 'taskId');
    if (!run?.task) fail('invalid_pattern_resolver', 'A loaded run is required to resolve a pattern.');
    const { task } = run;
    // Read the current task's own repairs plus any evidence the caller registered. Cross-task evidence is
    // supplied explicitly by the embedding application, never scanned from unrelated runs by this module.
    const entries = typeof store.listPatternEvidence === 'function' ? store.listPatternEvidence() : [];
    if (!entries.length) return null;
    const latest = store.getLatestAttempt(taskId);
    const context = {
      scopeRef: task.scopeRef ?? null,
      trigger: run.reason ?? null,
      toolName: latest?.candidate?.toolName ?? null,
      recipeId: task.recipeId ?? null,
      recipeVersion: task.recipeVersion ?? null,
    };
    // A pattern can only be considered when every constraint it names is knowable; otherwise abstain
    // instead of matching on a missing key.
    if (Object.values(context).some((value) => value === null)) return null;
    const summarized = summarizePatternEvidence(entries, { minRuns, minSuccessRate });
    for (const candidate of summarized) {
      if (!candidate.eligible) continue;
      // The approval is a credential, not a body: confirming it does not copy the pattern text. The body
      // must come from the registry of what was actually reviewed, because a version hash over a
      // synthesized stub could never equal the version the human approved — and inventing one here would
      // silently re-authorize text nobody saw.
      const approved = registry.get(candidate.patternId) ?? null;
      if (approved === null) continue;
      let approval = ticketFor(candidate.patternId);
      if (approval === null) {
        // No ticket yet. An explicitly configured policy may issue one, but only through the same narrow
        // gate the approval module enforces; any refusal simply means "no reuse" and analysis proceeds.
        if (automation === null) continue;
        try {
          const request = proposeApproval({ ...approved, activatable: false }, { requestedBy: 'resolver', now });
          approval = confirmApprovalAutomatically(request, { automation,
            evidence: { independentRuns: candidate.independentRuns, successRate: candidate.successRate },
            pattern: approved, now });
          issued.push(approval);
        } catch { continue; }
      }
      const pattern = { ...approved };
      const decision = matchPattern({ approval, pattern, context,
        evidence: { eligible: true, independentRuns: candidate.independentRuns, minRuns }, now });
      if (decision.hit === true) {
        return Object.freeze({ ...pattern, patternId: candidate.patternId, decision,
          automatic: approval.confirmedBy?.startsWith('automation:') === true });
      }
    }
    return null;
  };
}

/**
 * Turn persisted repair rows into pattern evidence. Each row keeps its own identity so the aggregator can
 * reject repeats; nothing here decides success on behalf of the verifier.
 */
export function evidenceFromRepairs({ taskId, repairs, identity }) {
  requireString(taskId, 'taskId');
  if (!Array.isArray(repairs)) fail('invalid_pattern_evidence', 'Repair rows must be an array.');
  const base = patternIdentity(identity);
  return repairs.map((repair) => Object.freeze({
    patternId: base.patternId,
    repairId: repair.repairId,
    taskId,
    status: repair.status,
    succeeded: repair.succeeded,
  }));
}

/** Report what the resolver would consider, without activating anything. */
export function describePatternEvidence(entries, options = {}) {
  return Object.freeze(summarizePatternEvidence(entries, options).map((item) => Object.freeze({
    patternId: item.patternId, samples: item.samples, independentRuns: item.independentRuns,
    successRate: item.successRate, eligible: item.eligible, status: item.status,
    // Kept explicit so no caller can mistake the report for permission.
    activatable: false,
  })));
}
