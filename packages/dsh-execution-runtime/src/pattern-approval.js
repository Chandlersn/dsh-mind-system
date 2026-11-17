import { createHash, randomUUID } from 'node:crypto';
import { RuntimeContractError, jsonSnapshot, requireString } from './contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const HASH = /^[a-f0-9]{64}$/;

/** A pattern version covers everything that would change its meaning, so a later edit invalidates approval. */
export function patternVersionOf(pattern) {
  const value = jsonSnapshot(pattern);
  for (const key of ['patternId', 'statement', 'negativeType', 'keywords', 'scopeRef']) {
    if (key === 'keywords') {
      if (!Array.isArray(value?.keywords) || value.keywords.some((item) => typeof item !== 'string')) {
        fail('invalid_pattern_version', 'A pattern version requires a keyword list.');
      }
      continue;
    }
    requireString(value?.[key], key);
  }
  return createHash('sha256').update(JSON.stringify({ patternId: value.patternId, statement: value.statement,
    negativeType: value.negativeType, keywords: [...value.keywords].sort(), scopeRef: value.scopeRef })).digest('hex');
}

/**
 * A pending approval is a request, not a decision. It is produced only from a candidate that already
 * passed evidence aggregation, and it carries the exact pattern version it was raised against.
 */
export function proposeApproval(candidate, { requestedBy, ttlMs = 86_400_000, now = Date.now } = {}) {
  const value = jsonSnapshot(candidate);
  requireString(requestedBy, 'requestedBy');
  if (value?.activatable !== false) {
    fail('invalid_approval_request', 'Only a non-activatable candidate may be proposed for approval.');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_592_000_000) {
    fail('invalid_approval_request', 'An approval request needs a bounded lifetime.');
  }
  const version = patternVersionOf({ patternId: value.patternId, statement: value.statement,
    negativeType: value.negativeType ?? 'out_of_scope_scenario', keywords: value.keywords ?? [],
    scopeRef: value.scopeRef ?? 'global' });
  return Object.freeze({ approvalId: `approval:${randomUUID()}`, patternId: value.patternId,
    patternVersion: version, requestedBy, requestedAt: now(), expiresAt: now() + ttlMs,
    // A pending request is deliberately unable to authorize anything by itself.
    status: 'pending' });
}

/**
 * Record a human decision. The confirmation is bound to the pending request AND to the pattern version
 * that was reviewed, so a ticket cannot be replayed against a different version or a different pattern.
 */
export function confirmApproval(pending, { confirmedBy, human = false, patternVersion, now = Date.now } = {}) {
  const value = jsonSnapshot(pending);
  requireString(value?.approvalId, 'approvalId');
  requireString(value.patternId, 'patternId');
  requireString(value.patternVersion, 'patternVersion');
  requireString(confirmedBy, 'confirmedBy');
  // The human gate is explicit: nothing else may sign a ticket, including an analysis result.
  if (human !== true) fail('not_human_confirmed', 'Only an explicit human confirmation may approve a pattern.');
  if (value.status !== 'pending') fail('invalid_approval_state', 'Only a pending request may be confirmed.');
  if (!HASH.test(patternVersion ?? '') || patternVersion !== value.patternVersion) {
    fail('approval_version_mismatch', 'The reviewed pattern version does not match this request.');
  }
  if (now() >= value.expiresAt) fail('approval_expired', 'The approval request expired before confirmation.');
  return Object.freeze({ ...value, status: 'confirmed', confirmedBy, confirmedAt: now(),
    reviewTicket: createHash('sha256').update(`${value.approvalId}:${patternVersion}:${confirmedBy}:${now()}`).digest('hex') });
}

/** Revocation keeps the record for audit instead of deleting the approval. */
export function revokeApproval(approval, { revokedBy, reason, now = Date.now } = {}) {
  const value = jsonSnapshot(approval);
  requireString(revokedBy, 'revokedBy');
  requireString(reason, 'reason');
  if (value?.status !== 'confirmed') fail('invalid_approval_state', 'Only a confirmed approval may be revoked.');
  return Object.freeze({ ...value, status: 'revoked', revokedBy, revokeReason: reason, revokedAt: now() });
}

/**
 * Effective only while confirmed, unexpired, and matched on the exact pattern version. Any edit to the
 * pattern changes its version and silently disables an old approval instead of keeping it alive.
 */
export function approvalApplies(approval, pattern, { now = Date.now } = {}) {
  if (!approval || approval.status !== 'confirmed') return { applies: false, reason: 'not_confirmed' };
  if (now() >= approval.expiresAt) return { applies: false, reason: 'expired' };
  const version = patternVersionOf(pattern);
  if (version !== approval.patternVersion) return { applies: false, reason: 'pattern_version_changed' };
  if (pattern.patternId !== approval.patternId) return { applies: false, reason: 'pattern_mismatch' };
  return { applies: true, reason: 'approved_for_version' };
}

/** An analysis result or a candidate is never a ticket, whatever fields it happens to carry. */
export function rejectBorrowedTicket(candidate) {
  for (const field of ['reviewTicket', 'approvalId', 'permit', 'confirmedBy']) {
    if (candidate && Object.hasOwn(candidate, field)) {
      fail('approval_cannot_be_borrowed', `A candidate may not carry ${field}; approval comes only from human confirmation.`);
    }
  }
  return true;
}
