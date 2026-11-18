import { RuntimeContractError } from './contracts.js';

/**
 * Runtime intervention: notice a failure worth acting on, and offer to help — without deciding for the host.
 *
 * ## What this is, and what it is not
 *
 * The runtime does not route work. It cannot know that a request is "write an article" or "convert a CSV";
 * deciding that is the host's job, and guessing it here would mean taking work over on a hunch. What it can
 * do is notice the moment a caller is in trouble and make its existence known, then leave the decision
 * entirely to the host: the hint describes what the runtime can do and stops there.
 *
 * ## Why the hint is bounded and rare
 *
 * A component that speaks on every failure becomes noise, and noise gets ignored — at which point it has no
 * capability at all. So a hint requires repetition (the same failure seen more than once), it is offered
 * once per agent per cooldown, and it never repeats a hint that was already given for the same signature.
 * Every decision is recorded, including the ones that stay silent: an intervention rate without a
 * denominator cannot be read (a rate of zero looks identical to "nobody was watching").
 */

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/**
 * Failures worth offering help for — phrased the way failures are actually phrased.
 *
 * ## Why this list changed
 *
 * The first version held the runtime's own error codes: `budget_exceeded`, `half_`,
 * `reconciling`. Measured against real failure text it matched 3.0% of 2021 recorded failures,
 * and missed 11 of 12 cases that genuinely needed help, because a caller never writes
 * "reconciling" — it writes "the write landed on disk but no ledger row was recorded for it".
 * The vocabulary was describing the runtime to itself instead of recognising the caller's
 * situation.
 *
 * The list is now built from the shapes the runtime can act on, each written the way a failure
 * message writes it. Both directions are measured (scripts/tune-detector-vocab.mjs): the
 * labelled case set goes from 91.7% missed to 0%, and the ordinary noise the design must ignore
 * (typos, parse errors, missing arguments) stays where it was — 3.0% to 3.5% of real failures.
 *
 * ## The boundary this does not cross
 *
 * A widened list still cannot tell "timeout waiting for the language server" (a configuration
 * problem) from "killed after the deadline" (a step that can be resumed). Those four case-set
 * false alarms are the known cost of matching on text, and they are left visible in the report
 * rather than papered over with more words.
 */
const RELEVANT_WORDS = Object.freeze([
  // the runtime's own vocabulary: still valid when a caller quotes a contract error back
  'budget_exceeded', 'deadline', 'timeout', 'verification', 'outcome_unknown', 'not_observed',
  'reconciling', 'partial', 'atomic', 'half_', 'inconsistent', 'resume', 'rollback', 'retry',
  // an artifact that does not satisfy what the task declared
  'does not match', 'mismatch', 'differs', 'not satisfy', 'violated', 'unexpected content',
  // work that half-landed or is in an unknown state
  'half written', 'half-written', 'only half', 'not settle', 'did not settle',
  'no ledger row', 'not recorded', 'unrecorded', 'orphan',
  'in an unknown state', 'outcome is unknown', 'unknown outcome',
  // progress that cannot continue without undo or recovery
  'must be undone', 'cannot proceed', 'cannot continue', 'no longer matches',
  'stale', 'out of date', 'cursor', 'checkpoint', 'journal',
  // caps and repeated identical failure
  'reached the', 'cap', 'exhausted', 'no further attempt',
  'failed twice', 'identically', 'repeatedly failed',
  // competing ownership / lost dispatch
  'same fence', 'claim the same', 'two attempts', 'no executor',
  // a process that died partway through its writes
  'died with', 'process died', 'crashed', 'was killed mid',
]);

/**
 * The vocabulary, exposed read-only for the vocabulary diagnostic.
 *
 * Exported because the question "which of the failures that actually happen here does this list
 * even consider?" can only be answered against the list itself. A probe that re-declared the
 * words would drift from the real ones the first time this file is edited.
 */
export const RELEVANT_WORDS_DEV = RELEVANT_WORDS;

/** A failure is relevant when its text mentions one of the shapes the runtime can actually help with. */
function isRelevant(text) {
  const lowered = text.toLowerCase();
  return RELEVANT_WORDS.some((word) => lowered.includes(word));
}

/**
 * Build the intervention policy.
 *
 * @param {object} input
 * @param {number} [input.threshold] Distinct failures before speaking.
 * @param {number} [input.cooldownMs] Minimum gap between hints per agent.
 * @param {() => number} [input.now]
 */
export function createInterventionPolicy({ threshold = 2, cooldownMs = 10 * 60_000,
  now = Date.now, maxTrackedAgents = 200 } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) fail('invalid_intervention', 'threshold must be a positive integer.');
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) fail('invalid_intervention', 'cooldownMs must be non-negative.');
  const windows = new Map();
  const hinted = new Map();
  const lastHintAt = new Map();
  const metrics = { evaluated: 0, hinted: 0, skipped: 0, skippedByReason: {} };

  const bucketOf = (agentId) => {
    const key = String(agentId ?? 'default');
    let window = windows.get(key);
    if (window === undefined) {
      // Bound the table: an unbounded per-agent cache in a long-lived host is a leak, not a feature.
      if (windows.size >= maxTrackedAgents) windows.delete(windows.keys().next().value);
      window = [];
      windows.set(key, window);
    }
    return { key, window };
  };

  const record = (reason) => {
    metrics.skipped += 1;
    metrics.skippedByReason[reason] = (metrics.skippedByReason[reason] ?? 0) + 1;
  };

  return Object.freeze({
    /**
     * Evaluate one failure.
     *
     * Returns `{ hint }` when the runtime should speak, or `{ skipped }` naming why it stayed quiet. The
     * caller must pass the hint through only as optional context — never as an instruction.
     */
    evaluate({ agentId, tool, message, at = now() } = {}) {
      metrics.evaluated += 1;
      const text = typeof message === 'string' ? message : '';
      // Decide first whether this failure is the kind the runtime could help with at all.
      if (!isRelevant(text)) { record('not_relevant'); return { skipped: 'not_relevant', signature: null }; }
      const signature = `${tool ?? 'unknown'}:${text.slice(0, 120)}`;
      const { key, window } = bucketOf(agentId);
      // Keep only recent observations: an old failure should not count toward a present one.
      while (window.length && window[0].at < at - cooldownMs) window.shift();
      window.push({ at, signature });
      const repeated = window.filter((item) => item.signature === signature).length;
      if (repeated < threshold) { record('below_threshold'); return { skipped: 'below_threshold', signature }; }
      const seen = hinted.get(key) ?? new Set();
      if (seen.has(signature)) { record('already_hinted'); return { skipped: 'already_hinted', signature }; }
      const last = lastHintAt.get(key);
      if (last !== undefined && at - last < cooldownMs) { record('cooldown'); return { skipped: 'cooldown', signature }; }
      seen.add(signature);
      hinted.set(key, seen);
      lastHintAt.set(key, at);
      metrics.hinted += 1;
      return { hint: hintText(), signature };
    },
    /** Counters, reported as pairs: a hint count alone cannot distinguish silence from absence. */
    metrics() {
      return Object.freeze({ ...metrics, skippedByReason: { ...metrics.skippedByReason },
        missRate: metrics.evaluated === 0 ? null : Number((metrics.skipped / metrics.evaluated).toFixed(3)) });
    },
    reset() { windows.clear(); hinted.clear(); lastHintAt.clear(); },
  });
}

/**
 * The hint itself.
 *
 * It says what the runtime can do and that using it is optional. It does not claim the task failed, does not
 * name a repair, and does not ask for any authority — anything stronger would be the runtime deciding for a
 * caller that has not asked it.
 */
export function hintText() {
  return [
    '这个失败可能不是一次性的。若它涉及预算、超时、验证、部分完成或需要恢复，',
    '`runtime_execute` 可以把任务变成有明确验收标准的多步执行：每步单独验证，失败时停下来而不是继续往下走。',
    '不一定要用它；但如果继续原样重试同一个动作，多半会得到同样的结果。',
  ].join('\n');
}
