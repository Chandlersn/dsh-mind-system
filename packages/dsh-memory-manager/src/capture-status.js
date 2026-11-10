/**
 * Per-instance, in-memory capture observations.  This is not a durable log,
 * provenance proof, delivery guarantee, or a cross-process counter.
 *
 * Callers decide when a real event has been observed/selected/skipped. A
 * scheduled attempt receives a one-shot ticket; only that ticket may close
 * its pending count. No event content, identity, path or error message is
 * accepted as a label. Unknown codes/stages collapse into the fixed OTHER bin.
 */
export const CAPTURE_COUNTER_MAX = 1_000_000;
export const CAPTURE_PENDING_MAX = 1024;

export const CAPTURE_ERROR_CODES = Object.freeze([
  'MEMORY_STAGE_OUTCOME_UNKNOWN',
  'MEMORY_WRITE_COMMIT_UNKNOWN',
  'MEMORY_LEDGER_APPEND_FAILED',
  'MEMORY_LEDGER_UNREADABLE',
  'MEMORY_DELETE_INTENT_PENDING',
  'MEMORY_CAPTURE_LOCK_BUSY',
  'MEMORY_CAPTURE_LOCK_TIMEOUT',
  'MEMORY_CAPTURE_LOCK_UNKNOWN',
  'MEMORY_CAPTURE_LOCK_RELEASE_UNKNOWN',
  'CAPTURE_MUTEX_UNAVAILABLE',
  'CAPTURE_MUTEX_UNSAFE_PATH',
  'CAPTURE_MUTEX_SENTINEL_CLOSE_UNKNOWN',
  'CAPTURE_MUTEX_OPEN_FAILED',
  'CAPTURE_MUTEX_ACQUIRE_FAILED',
  'CAPTURE_MUTEX_BUSY',
  'CAPTURE_MUTEX_CLOSE_UNKNOWN',
  'CAPTURE_BASELINE_UNVERIFIED',
  'CAPTURE_INTENT_PENDING',
  'CAPTURE_INTENT_UNKNOWN',
  'CAPTURE_FINALIZE_UNKNOWN',
  'CAPTURE_HISTORY_ENCODING',
  'CAPTURE_HISTORY_REDACTION',
  'CAPTURE_INPUT_REDACTION',
  'CAPTURE_UNSAFE_DAILY',
  'OTHER',
]);

export const CAPTURE_ERROR_STAGES = Object.freeze([
  'source', 'select', 'schedule', 'lock', 'read', 'dedupe', 'stage',
  'commit', 'ledger', 'cleanup', 'OTHER',
]);

const OUTCOMES = new Set(['confirmed', 'duplicate', 'conflict', 'failed']);
const CODE_SET = new Set(CAPTURE_ERROR_CODES);
const STAGE_SET = new Set(CAPTURE_ERROR_STAGES);
const emptyBins = (labels) => Object.fromEntries(labels.map((label) => [label, 0]));

// Do not read arbitrary properties or invoke getters on error objects. Callers
// provide only two explicit, primitive labels; malformed metadata is rejected.
function labelsFor(details) {
  if (details === undefined) return { code: 'OTHER', stage: 'OTHER' };
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  try {
    const proto = Object.getPrototypeOf(details);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(details);
    if (keys.some((key) => key !== 'code' && key !== 'stage')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(details);
    const code = descriptors.code;
    const stage = descriptors.stage;
    if ((code && (!('value' in code) || typeof code.value !== 'string')) ||
        (stage && (!('value' in stage) || typeof stage.value !== 'string'))) return null;
    return {
      code: code && CODE_SET.has(code.value) ? code.value : 'OTHER',
      stage: stage && STAGE_SET.has(stage.value) ? stage.value : 'OTHER',
    };
  } catch {
    return null;
  }
}

export function createCaptureStatus({ enabled = false } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  const now = Date.now();
  const createdAt = Number.isSafeInteger(now) && now >= 0 ? now : 0;
  const counts = {
    observed: 0, selected: 0, scheduled: 0, confirmed: 0, duplicate: 0,
    skippedSource: 0, skippedMissingId: 0, skippedCapacity: 0,
    conflict: 0, failed: 0, pending: 0,
  };
  const errorCodes = emptyBins(CAPTURE_ERROR_CODES);
  const errorStages = emptyBins(CAPTURE_ERROR_STAGES);
  let saturated = false;
  const increment = (object, key) => {
    if (object[key] >= CAPTURE_COUNTER_MAX) { saturated = true; return; }
    object[key] += 1;
  };
  const noArguments = (args) => args.length === 0;
  const status = {
    observed(...args) { if (!noArguments(args)) return false; increment(counts, 'observed'); return true; },
    selected(...args) { if (!noArguments(args)) return false; increment(counts, 'selected'); return true; },
    skippedSource(...args) { if (!noArguments(args)) return false; increment(counts, 'skippedSource'); return true; },
    skippedMissingId(...args) { if (!noArguments(args)) return false; increment(counts, 'skippedMissingId'); return true; },
    schedule(...args) {
      if (!noArguments(args)) return null;
      if (counts.pending >= CAPTURE_PENDING_MAX) { increment(counts, 'skippedCapacity'); return null; }
      increment(counts, 'scheduled');
      counts.pending += 1;
      let finished = false;
      return Object.freeze({
        finish(outcome, details, ...extra) {
          if (finished || extra.length || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return false;
          if ((outcome === 'confirmed' || outcome === 'duplicate') && details !== undefined) return false;
          let labels;
          if (outcome === 'conflict' || outcome === 'failed') {
            labels = labelsFor(details);
            if (!labels) return false;
          }
          finished = true;
          counts.pending -= 1;
          increment(counts, outcome);
          if (labels) {
            increment(errorCodes, labels.code);
            increment(errorStages, labels.stage);
          }
          return true;
        },
      });
    },
    snapshot(...args) {
      if (!noArguments(args)) return null;
      return {
        enabled, createdAt, hasObservations: counts.observed > 0,
        resetOnNewInstance: true, saturated,
        ...counts,
        errorCodes: { ...errorCodes }, errorStages: { ...errorStages },
      };
    },
  };
  return Object.freeze(status);
}
