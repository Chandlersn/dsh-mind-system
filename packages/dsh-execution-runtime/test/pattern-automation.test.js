import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmApproval, confirmApprovalAutomatically, proposeApproval, revokeApproval,
  approvalApplies, patternVersionOf } from '../src/pattern-approval.js';

/**
 * The auto-confirmation policy is the one place where a machine may issue a ticket. Every test here is
 * about the boundary rather than the happy path: a bounded delegation is only safe if its refusals hold.
 */

const pattern = (overrides = {}) => ({ patternId: 'p1', scopeRef: 's',
  statement: 'The verified output differs from the source projection.',
  negativeType: 'out_of_scope_scenario', keywords: ['output', 'mismatch'], ...overrides });

const pending = (body = pattern(), now = () => 1000) =>
  proposeApproval({ ...body, activatable: false }, { requestedBy: 'resolver', now });

const evidence = (overrides = {}) => ({ independentRuns: 5, successRate: 0.9, ...overrides });

const automation = (overrides = {}) => ({ allowAutomatic: true, operator: 'selfloop',
  minIndependentRuns: 3, minSuccessRate: 0.8, ...overrides });

test('an explicitly enabled policy issues a confirmed ticket bound to the reviewed version', () => {
  const body = pattern();
  const request = pending(body);
  const confirmed = confirmApprovalAutomatically(request, { automation: automation(),
    evidence: evidence(), pattern: body, now: () => 2000 });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.patternVersion, request.patternVersion);
  assert.equal(confirmed.confirmedBy, 'automation:selfloop');
  // The audit trail must distinguish a machine ticket from a human one.
  assert.equal(confirmed.automation.operator, 'selfloop');
  assert.equal(confirmed.automation.independentRuns, 5);
  assert.equal(approvalApplies(confirmed, body, { now: () => 2000 }).applies, true);
});

test('there is no implicit enablement: omitting the policy refuses', () => {
  for (const value of [undefined, null, {}, { allowAutomatic: false }, 'yes', 1]) {
    assert.throws(() => confirmApprovalAutomatically(pending(), { automation: value, evidence: evidence(),
      pattern: pattern() }), { code: /automation_disabled/ }, JSON.stringify(value));
  }
});

test('an operator must be named so the ticket is attributable', () => {
  assert.throws(() => confirmApprovalAutomatically(pending(), { automation: automation({ operator: '' }),
    evidence: evidence(), pattern: pattern() }), { code: 'invalid_contract' });
});

test('the first evidence is never enough: the run requirement is enforced', () => {
  assert.throws(() => confirmApprovalAutomatically(pending(), { automation: automation(),
    evidence: evidence({ independentRuns: 2 }), pattern: pattern() }), { code: 'automation_evidence_insufficient' });
  // A weaker policy cannot lower the bar below two independent runs.
  assert.throws(() => confirmApprovalAutomatically(pending(), { automation: automation({ minIndependentRuns: 1 }),
    evidence: evidence(), pattern: pattern() }), { code: 'automation_not_permitted' });
});

test('a mediocre success rate is refused rather than rounded up', () => {
  assert.throws(() => confirmApprovalAutomatically(pending(), { automation: automation(),
    evidence: evidence({ successRate: 0.79 }), pattern: pattern() }), { code: 'automation_success_rate_too_low' });
  assert.throws(() => confirmApprovalAutomatically(pending(), { automation: automation(),
    evidence: evidence({ successRate: undefined }), pattern: pattern() }), { code: 'automation_evidence_insufficient' });
});

test('a pattern that wants human review cannot be auto-confirmed', () => {
  const body = pattern();
  const request = proposeApproval({ ...body, activatable: false, requiresHumanReview: true },
    { requestedBy: 'resolver', now: () => 1000 });
  assert.throws(() => confirmApprovalAutomatically(request, { automation: automation(),
    evidence: evidence(), pattern: body, now: () => 2000 }), { code: 'automation_not_permitted' });
});

test('an edited pattern invalidates the automatically issued ticket', () => {
  const body = pattern();
  const confirmed = confirmApprovalAutomatically(pending(body), { automation: automation(),
    evidence: evidence(), pattern: body, now: () => 2000 });
  const edited = pattern({ statement: 'A different statement nobody reviewed.' });
  assert.notEqual(patternVersionOf(edited), confirmed.patternVersion);
  assert.equal(approvalApplies(confirmed, edited, { now: () => 2000 }).applies, false);
});

test('issuing a ticket refuses a body that is not the one that was requested', () => {
  // Bind at issue time, not only at use time: otherwise automation could stamp a ticket onto different
  // text than the request named, and the later version check would be validating the wrong pair.
  const requested = pending(pattern());
  const differentBody = pattern({ statement: 'Text the request never mentioned.' });
  assert.throws(() => confirmApprovalAutomatically(requested, { automation: automation(),
    evidence: evidence(), pattern: differentBody, now: () => 2000 }),
  { code: 'approval_version_mismatch' });
});

test('revocation is enforced by the approval gate itself, not only by a caller filter', () => {
  // Belt and braces on purpose: the resolver filters revoked tickets, so a bug that made the gate accept
  // revoked status would stay invisible from that path alone. This asserts the gate directly.
  const body = pattern();
  const confirmedTicket = confirmApprovalAutomatically(pending(body), { automation: automation(),
    evidence: evidence(), pattern: body, now: () => 2000 });
  assert.equal(approvalApplies(confirmedTicket, body, { now: () => 2000 }).applies, true);
  const revoked = revokeApproval(confirmedTicket, { revokedBy: 'boss', reason: 'not worth it', now: () => 3000 });
  const verdict = approvalApplies(revoked, body, { now: () => 3000 });
  assert.equal(verdict.applies, false, 'A revoked approval must never apply.');
  assert.equal(verdict.reason, 'not_confirmed');
});

test('an automatic ticket expires on its own short clock', () => {
  const body = pattern();
  const confirmed = confirmApprovalAutomatically(pending(body), { automation: automation({ ttlMs: 60_000 }),
    evidence: evidence(), pattern: body, now: () => 2000 });
  assert.ok(confirmed.expiresAt <= 2000 + 60_000, 'The policy must be able to shorten the lifetime.');
  assert.equal(approvalApplies(confirmed, body, { now: () => confirmed.expiresAt + 1 }).applies, false);
});

test('a pending request above its lifetime cannot be auto-confirmed', () => {
  const body = pattern();
  const request = pending(body);
  assert.throws(() => confirmApprovalAutomatically(request, { automation: automation(), evidence: evidence(),
    pattern: body, now: () => request.expiresAt + 1 }), { code: 'approval_expired' });
});

test('an already confirmed request is not double-confirmed', () => {
  const body = pattern();
  const human = confirmApproval(pending(body), { confirmedBy: 'boss', human: true,
    patternVersion: pending(body).patternVersion, now: () => 1500 });
  assert.throws(() => confirmApprovalAutomatically(human, { automation: automation(), evidence: evidence(),
    pattern: body }), { code: 'invalid_approval_state' });
});

/**
 * The loop must actually turn over. Everything above only proves the gate's refusals; this drives the
 * resolver with no pre-existing ticket and asserts that a proven pattern becomes usable on its own.
 */
const resolverRun = (overrides = {}) => ({ status: 'waiting_analysis', reason: 'verification_failed',
  task: { taskId: 't1', recipeId: 'csv-normalize', recipeVersion: '1', scopeRef: 's', ...overrides } });

const resolverSamples = (runs) => Array.from({ length: runs }, (_, index) => ({
  patternId: 'p1', repairId: `r${index}`, taskId: `task-${index}`, status: 'settled', succeeded: true }));

const resolverStore = (entries) => ({ readRepairTrace() { return []; },
  listPatternEvidence() { return entries; },
  getLatestAttempt() { return { candidate: { toolName: 'runtime_write_text' } }; } });

test('with automation enabled the loop reuses a proven pattern without a human ticket', async () => {
  const { createPatternResolver } = await import('../src/pattern-resolver.js');
  const body = { patternId: 'p1', scopeRef: 's', recipeId: 'csv-normalize', recipeVersion: '1',
    verifierId: 'csv-source-output', verifierVersion: '1', trigger: 'verification_failed',
    toolName: 'runtime_write_text', statement: 'The verified output differs from the source projection.',
    negativeType: 'out_of_scope_scenario', keywords: ['output', 'mismatch'] };
  const resolve = createPatternResolver({ store: resolverStore(resolverSamples(4)), patterns: [body],
    automation: automation(), now: () => 1000 });
  const found = resolve('t1', resolverRun());
  assert.ok(found, 'A proven pattern must become usable once automation is explicitly enabled.');
  assert.equal(found.patternId, 'p1');
  assert.equal(found.decision.hit, true);
  // The decision is marked automatic, so a later audit can tell it apart from a human approval.
  assert.equal(found.automatic, true);
});

test('the same evidence reuses nothing when automation stays off', async () => {
  const { createPatternResolver } = await import('../src/pattern-resolver.js');
  const body = { patternId: 'p1', scopeRef: 's', recipeId: 'csv-normalize', recipeVersion: '1',
    verifierId: 'csv-source-output', verifierVersion: '1', trigger: 'verification_failed',
    toolName: 'runtime_write_text', statement: 'The verified output differs from the source projection.',
    negativeType: 'out_of_scope_scenario', keywords: ['output', 'mismatch'] };
  const resolve = createPatternResolver({ store: resolverStore(resolverSamples(4)), patterns: [body],
    now: () => 1000 });
  assert.equal(resolve('t1', resolverRun()), null, 'Without an explicit policy nothing is reused.');
});
