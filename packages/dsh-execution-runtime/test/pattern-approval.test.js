import test from 'node:test';
import assert from 'node:assert/strict';
import { patternVersionOf, proposeApproval, confirmApproval, revokeApproval, approvalApplies,
  rejectBorrowedTicket } from '../src/pattern-approval.js';

const pattern = (overrides = {}) => ({ patternId: 'pattern:abc', statement: 'Replace only the owned artifact.',
  negativeType: 'out_of_scope_scenario', keywords: ['foreign path', 'stale hash'], scopeRef: 'scope-a', ...overrides });

const candidate = (overrides = {}) => ({ patternId: 'pattern:abc', statement: 'Replace only the owned artifact.',
  negativeType: 'out_of_scope_scenario', keywords: ['foreign path', 'stale hash'], scopeRef: 'scope-a',
  activatable: false, samples: 4, independentRuns: 3, successRate: 0.75, ...overrides });

const pending = (overrides = {}) => proposeApproval(candidate(), { requestedBy: 'runtime', now: () => 1000, ...overrides });

test('a pattern version changes whenever its meaning changes', () => {
  const base = patternVersionOf(pattern());
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(patternVersionOf(pattern()), base);
  // Keyword order is not a meaning change, but a different keyword is.
  assert.equal(patternVersionOf(pattern({ keywords: ['stale hash', 'foreign path'] })), base);
  for (const key of ['patternId', 'statement', 'negativeType', 'scopeRef']) {
    assert.notEqual(patternVersionOf(pattern({ [key]: `${pattern()[key]}-x` })), base, key);
  }
  assert.notEqual(patternVersionOf(pattern({ keywords: ['foreign path'] })), base);
});

test('a pending request cannot authorize anything on its own', () => {
  const request = pending();
  assert.equal(request.status, 'pending');
  assert.equal(approvalApplies(request, pattern(), { now: () => 2000 }).applies, false);
  assert.equal(approvalApplies(request, pattern(), { now: () => 2000 }).reason, 'not_confirmed');
  // Only an activatable:false candidate may be proposed; a live rule cannot skip review.
  assert.throws(() => proposeApproval(candidate({ activatable: true }), { requestedBy: 'x' }),
    { code: 'invalid_approval_request' });
});

test('confirmation requires an explicit human act, not an analysis result', () => {
  const request = pending();
  assert.throws(() => confirmApproval(request, { confirmedBy: 'analyzer', patternVersion: request.patternVersion,
    now: () => 2000 }), { code: 'not_human_confirmed' });
  assert.throws(() => confirmApproval(request, { confirmedBy: 'analyzer', human: 'yes',
    patternVersion: request.patternVersion, now: () => 2000 }), { code: 'not_human_confirmed' });
  const confirmed = confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 });
  assert.equal(confirmed.status, 'confirmed');
  assert.match(confirmed.reviewTicket, /^[a-f0-9]{64}$/);
});

test('a ticket is bound to the reviewed pattern version and cannot be replayed', () => {
  const request = pending();
  const confirmed = confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 });
  // Same version: the approval applies.
  assert.equal(approvalApplies(confirmed, pattern(), { now: () => 3000 }).applies, true);
  // The pattern was edited after review: the old approval must stop applying.
  const edited = approvalApplies(confirmed, pattern({ statement: 'Replace anything.' }), { now: () => 3000 });
  assert.equal(edited.applies, false);
  assert.equal(edited.reason, 'pattern_version_changed');
  // Confirming against a different version is refused outright.
  assert.throws(() => confirmApproval(pending(), { confirmedBy: 'boss', human: true,
    patternVersion: 'f'.repeat(64), now: () => 2000 }), { code: 'approval_version_mismatch' });
});

test('a confirmed approval is single-use in the sense that it cannot be confirmed twice', () => {
  const request = pending();
  const confirmed = confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 });
  assert.throws(() => confirmApproval(confirmed, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2500 }), { code: 'invalid_approval_state' });
});

test('an expired request cannot be confirmed and an expired approval stops applying', () => {
  const request = pending({ ttlMs: 500 });
  assert.throws(() => confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 }), { code: 'approval_expired' });
  const live = pending({ ttlMs: 10_000 });
  const confirmed = confirmApproval(live, { confirmedBy: 'boss', human: true,
    patternVersion: live.patternVersion, now: () => 2000 });
  assert.equal(approvalApplies(confirmed, pattern(), { now: () => 5000 }).applies, true);
  assert.equal(approvalApplies(confirmed, pattern(), { now: () => 99_999 }).reason, 'expired');
});

test('revocation keeps the audit record and stops reuse', () => {
  const request = pending();
  const confirmed = confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 });
  const revoked = revokeApproval(confirmed, { revokedBy: 'boss', reason: 'pattern proved too broad', now: () => 3000 });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedBy, 'boss');
  assert.equal(revoked.reviewTicket, confirmed.reviewTicket, 'The audit trail must survive revocation.');
  assert.equal(approvalApplies(revoked, pattern(), { now: () => 4000 }).applies, false);
  assert.equal(approvalApplies(revoked, pattern(), { now: () => 4000 }).reason, 'not_confirmed');
  assert.throws(() => revokeApproval(revoked, { revokedBy: 'boss', reason: 'again' }), { code: 'invalid_approval_state' });
});

test('a candidate or analysis result cannot smuggle a ticket', () => {
  for (const field of ['reviewTicket', 'approvalId', 'permit', 'confirmedBy']) {
    assert.throws(() => rejectBorrowedTicket({ ...candidate(), [field]: 'forged' }), { code: 'approval_cannot_be_borrowed' });
  }
  assert.equal(rejectBorrowedTicket(candidate()), true);
});

test('a different pattern id never matches an approval even with the same version', () => {
  const request = pending();
  const confirmed = confirmApproval(request, { confirmedBy: 'boss', human: true,
    patternVersion: request.patternVersion, now: () => 2000 });
  const other = pattern({ patternId: 'pattern:other' });
  const result = approvalApplies(confirmed, other, { now: () => 3000 });
  assert.equal(result.applies, false);
  assert.ok(['pattern_mismatch', 'pattern_version_changed'].includes(result.reason));
});
