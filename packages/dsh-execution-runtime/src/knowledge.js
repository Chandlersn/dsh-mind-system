import { createHash } from 'node:crypto';
import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/** A knowledge reference is explicit and traceable: domain + id + version, never a bare path. */
export function knowledgeRef({ domain, id, version } = {}) {
  // Check the domain first: an unknown or empty domain is a knowledge error, not a generic string error.
  if (!['formal', 'workspace', 'scratch'].includes(domain)) fail('invalid_knowledge_ref', 'Unknown knowledge domain.');
  for (const [key, value] of Object.entries({ id, version })) requireString(value, key);
  // The domain decides trust: formal knowledge and unverified notes keep their own identity.
  return Object.freeze({ domain, id, version, ref: `${domain}:${id}@${version}` });
}

/**
 * Read through an injected engine adapter. The result keeps the domain identity: content that came from
 * scratch is never relabelled as formal just because the same engine served it.
 */
export async function readKnowledge({ adapter, reference, signal } = {}) {
  if (!adapter || typeof adapter.read !== 'function') fail('invalid_knowledge_adapter', 'A read-capable adapter is required.');
  const ref = knowledgeRef(reference);
  const result = await adapter.read({ ...ref, signal });
  if (!result || typeof result !== 'object') fail('invalid_knowledge_result', 'The adapter returned no content.');
  if (!result.identity || ['domain', 'id', 'version'].some((key) => result.identity[key] !== ref[key])) {
    fail('knowledge_identity_mismatch', 'The adapter did not establish the requested knowledge identity.');
  }
  return Object.freeze({ ...ref, content: result.content ?? null, trust: ref.domain,
    verified: ref.domain === 'formal' ? result.verified === true : false });
}

/**
 * Write through the owning domain's entry point. A write and its index state are separate facts: the
 * adapter may store the content and still fail to index it, and that must be visible rather than hidden.
 */
export async function writeKnowledge({ adapter, reference, content, origin = 'runtime', signal } = {}) {
  if (!adapter || typeof adapter.write !== 'function') fail('invalid_knowledge_adapter', 'A write-capable adapter is required.');
  const ref = knowledgeRef(reference);
  requireString(origin, 'origin');
  if (origin === 'daily' && ref.domain !== 'formal') {
    // Verification samples must not pollute the daily calibration record.
    fail('daily_origin_requires_formal', 'Only formal knowledge may be written with the daily origin.');
  }
  const outcome = await adapter.write({ ...ref, content, origin, signal });
  if (!outcome || typeof outcome !== 'object') fail('invalid_knowledge_result', 'The adapter returned no write result.');
  const stored = outcome.stored === true;
  const indexed = stored && outcome.indexed === true;
  return Object.freeze({ ...ref, stored, indexed,
    // The three states are reported separately so a caller cannot mistake "stored" for "searchable".
    state: !stored ? 'write_failed' : indexed ? 'stored_and_indexed' : 'stored_not_indexed',
    indexError: stored && !indexed ? String(outcome.indexError ?? 'index_failed') : null });
}

/**
 * In-memory governance outbox prototype: stable IDs deduplicate only within this instance.
 * Entries do not survive a crash and are not connected to production execution.
 */
export function createGovernanceOutbox({ now = Date.now } = {}) {
  const entries = new Map();
  const key = (eventId, kind) => createHash('sha256').update(`${eventId}:${kind}`).digest('hex');
  return Object.freeze({
    enqueue({ eventId, kind, payload } = {}) {
      requireString(eventId, 'eventId');
      requireString(kind, 'kind');
      const value = jsonSnapshot(payload ?? {});
      const id = key(eventId, kind);
      const existing = entries.get(id);
      // Replay returns the original entry: the outbox is idempotent by construction, not by luck.
      if (existing) return Object.freeze({ ...existing, duplicate: true });
      const entry = { id, eventId, kind, payload: value, status: 'pending', attempts: 0,
        createdAt: now(), deliveredAt: null, lastError: null };
      entries.set(id, entry);
      return Object.freeze({ ...entry, duplicate: false });
    },
    pending() { return [...entries.values()].filter((item) => item.status !== 'delivered').map((item) => Object.freeze({ ...item })); },
    delivered() { return [...entries.values()].filter((item) => item.status === 'delivered').map((item) => Object.freeze({ ...item })); },
    /** Delivery success is recorded only when the sink confirms it; failures remain retryable. */
    markDelivered(id, { at = now } = {}) {
      const entry = entries.get(id);
      if (!entry) fail('unknown_outbox_entry', 'The outbox entry does not exist.');
      entry.status = 'delivered';
      entry.deliveredAt = at();
      entry.attempts += 1;
      entry.lastError = null;
      return Object.freeze({ ...entry });
    },
    markFailed(id, { error, at = now } = {}) {
      const entry = entries.get(id);
      if (!entry) fail('unknown_outbox_entry', 'The outbox entry does not exist.');
      entry.attempts += 1;
      entry.lastError = String(error ?? 'delivery_failed');
      entry.at = at();
      // A failed delivery stays pending: it must not look delivered just because it was attempted.
      return Object.freeze({ ...entry });
    },
  });
}
