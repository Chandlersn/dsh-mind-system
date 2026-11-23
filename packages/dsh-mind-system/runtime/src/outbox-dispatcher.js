/**
 * Bounded, single-flight outbox dispatcher.
 *
 * Delivery contract: at-least-once, never exactly-once. A receiver may have applied an effect before a
 * crash or before its acknowledgement is recorded, so the same event can be sent again on a later pass.
 * Duplicate delivery is possible, and the receiver MUST dedupe on eventId (for example by returning
 * status 'duplicate' for an event it already applied). Acknowledging records only that a matching receipt
 * was observed; it is not proof that the effect happened exactly once.
 *
 * This module owns no timers and is not wired to any host process; the caller decides when dispatchOnce()
 * runs. It performs no background work.
 */

const RECEIPT_STATUSES = new Set(['accepted', 'duplicate']);
const MAX_BATCH = 100;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(failure) {
  if (failure instanceof Error) return failure.message;
  try {
    return String(failure);
  } catch {
    return 'unprintable failure';
  }
}

/** A listing row is safe to dispatch only if its identity and observed attempt count are bounded. */
function isUsableEntry(entry) {
  return isRecord(entry)
    && typeof entry.eventId === 'string' && entry.eventId.length > 0
    && Number.isSafeInteger(entry.attempts)
    && entry.attempts >= 0 && entry.attempts < Number.MAX_SAFE_INTEGER;
}

/** Only a receipt that names this event and reports an accepted outcome may acknowledge it. */
function isAcceptedReceipt(receipt, eventId) {
  return isRecord(receipt) && receipt.eventId === eventId && RECEIPT_STATUSES.has(receipt.status);
}

/**
 * Create a dispatcher over an existing outbox store.
 *
 * @param {object} options
 * @param {object} options.store store exposing listPendingOutbox/retryOutbox/acknowledgeOutbox
 * @param {(message: { producerId: unknown, eventId: string, kind: unknown, payload: unknown }) => Promise<unknown>} [options.receiver]
 * @param {unknown} [options.producerId] value echoed to the receiver so it can attribute the sender
 * @param {number} [options.limit=20] maximum entries inspected per pass (1..100)
 * @param {{ warn?: (message: string, detail: object) => void } | ((message: string, detail: object) => void)} [options.logger]
 * @returns {{ dispatchOnce: () => Promise<Readonly<{ attempted: number, acknowledged: number, duplicates: number, retried: number, skipped: number, unavailable: boolean }>> }}
 */
export function createOutboxDispatcher({ store, receiver, producerId, limit = 20, logger } = {}) {
  if (!store
    || typeof store.listPendingOutbox !== 'function'
    || typeof store.retryOutbox !== 'function'
    || typeof store.acknowledgeOutbox !== 'function') {
    throw new TypeError('createOutboxDispatcher requires a store with listPendingOutbox, retryOutbox and acknowledgeOutbox.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TypeError(`Outbox dispatch limit must be an integer from 1 to ${MAX_BATCH}.`);
  }

  // Logging must never break dispatch: a throwing logger is ignored rather than allowed to skip records.
  const warn = typeof logger === 'function' ? logger
    : typeof logger?.warn === 'function' ? logger.warn.bind(logger) : null;
  const warnSafely = (message, detail) => {
    if (warn === null) return;
    try {
      warn(message, detail);
    } catch {
      // Deliberately ignored: diagnostics are not part of the delivery contract.
    }
  };

  // Single-flight state. Concurrent dispatchOnce() callers receive this same promise.
  let inFlight = null;

  /**
   * Record a failed send against the observed attempt count. The compare-and-set is what keeps two
   * dispatchers from rewriting each other's bookkeeping; a lost race means the row is no longer ours.
   */
  function recordRetry(eventId, attempts, stats, reason) {
    let recorded = false;
    try {
      recorded = store.retryOutbox(eventId, { expectedAttempts: attempts }) === true;
    } catch (failure) {
      stats.skipped += 1;
      warnSafely('outbox retry could not be recorded', {
        eventId, attempts, reason: 'retry_failed', sendReason: reason, error: describe(failure),
      });
      return;
    }
    if (recorded) {
      stats.retried += 1;
      return;
    }
    // Another dispatcher advanced or acknowledged this row first; it owns the record now.
    stats.skipped += 1;
    warnSafely('outbox retry compare-and-set lost', { eventId, attempts, sendReason: reason });
  }

  async function run() {
    /** @type {{ attempted: number, acknowledged: number, duplicates: number, retried: number, skipped: number, unavailable: boolean }} */
    const stats = { attempted: 0, acknowledged: 0, duplicates: 0, retried: 0, skipped: 0, unavailable: false };

    if (typeof receiver !== 'function') {
      // No receiver is configuration, not an error: report unavailability and leave every row untouched.
      stats.unavailable = true;
      return Object.freeze(stats);
    }

    let entries;
    try {
      entries = await store.listPendingOutbox({ limit });
    } catch (failure) {
      warnSafely('outbox listing failed; no records were dispatched', {
        reason: 'listing_failed', error: describe(failure),
      });
      throw failure;
    }
    if (!Array.isArray(entries)) {
      warnSafely('outbox listing was not an array; no records were dispatched', { reason: 'listing_invalid' });
      throw new TypeError('Outbox listing must return an array.');
    }

    for (const entry of entries) {
      if (!isUsableEntry(entry)) {
        stats.skipped += 1;
        warnSafely('outbox entry skipped without sending', {
          eventId: isRecord(entry) && typeof entry.eventId === 'string' ? entry.eventId : null,
          reason: 'invalid_entry',
        });
        continue;
      }

      const { eventId, kind, payload, attempts } = entry;
      stats.attempted += 1;

      let receipt;
      try {
        receipt = await receiver({ producerId, eventId, kind, payload });
      } catch (failure) {
        warnSafely('outbox receiver threw; event was not acknowledged', {
          eventId, kind, attempts, reason: 'receiver_threw', error: describe(failure),
        });
        recordRetry(eventId, attempts, stats, 'receiver_threw');
        continue;
      }

      if (!isAcceptedReceipt(receipt, eventId)) {
        // Undefined, `true`, a foreign eventId, `{ ok: true }` or any other shape proves nothing.
        warnSafely('outbox receipt rejected; event was not acknowledged', {
          eventId, kind, attempts, reason: 'receipt_rejected',
        });
        recordRetry(eventId, attempts, stats, 'receipt_rejected');
        continue;
      }

      let acknowledged = false;
      let acknowledgeError = null;
      try {
        acknowledged = store.acknowledgeOutbox(eventId, { expectedAttempts: attempts }) === true;
      } catch (failure) {
        acknowledgeError = failure;
      }
      if (!acknowledged) {
        stats.skipped += 1;
        warnSafely('outbox acknowledgement was not recorded', {
          eventId, attempts,
          reason: acknowledgeError === null ? 'acknowledge_not_recorded' : 'acknowledge_failed',
          ...(acknowledgeError === null ? {} : { error: describe(acknowledgeError) }),
        });
        continue;
      }

      stats.acknowledged += 1;
      if (receipt.status === 'duplicate') stats.duplicates += 1;
    }

    return Object.freeze(stats);
  }

  return Object.freeze({
    /**
     * Run one bounded pass. Concurrent calls share the in-flight promise, so entries are never sent in
     * parallel by this dispatcher; a call made after the pass settles starts a new pass.
     *
     * Counters: `attempted` receiver calls made, `acknowledged` rows acknowledged, `duplicates` acked
     * receipts reporting duplicate, `retried` rows whose attempt increment was recorded, `skipped` rows
     * that ended without a recorded send outcome (malformed rows and lost compare-and-set races), and
     * `unavailable` true when no receiver was configured.
     */
    dispatchOnce() {
      if (inFlight !== null) return inFlight;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  });
}