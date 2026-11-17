import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeApproval, confirmApproval, revokeApproval, patternVersionOf } from '../src/pattern-approval.js';
import { createValveWriter, patternAllowsDecision } from '../src/valve-bridge.js';

const pattern = (overrides = {}) => ({ patternId: 'pattern:abc', statement: 'Replace only the owned artifact.',
  negativeType: 'out_of_scope_scenario', keywords: ['foreign path'], scopeRef: 'scope-a', ...overrides });

const candidate = (overrides = {}) => ({ ...pattern(), activatable: false, ...overrides });

const confirmed = (now = () => 2000) => {
  const request = proposeApproval(candidate(), { requestedBy: 'runtime', now: () => 1000 });
  return confirmApproval(request, { confirmedBy: 'boss', human: true, patternVersion: request.patternVersion, now });
};

/** A stand-in valve store that refuses writes without its own human gate, like the real one. */
function valveStore({ accept = true } = {}) {
  const calls = [];
  return { calls, async confirmRule(rule, options) {
    calls.push({ rule, options });
    if (options.human !== true && options.permit === undefined) return { ok: false, error: 'not_human_confirmed' };
    return accept ? { ok: true } : { ok: false, error: 'snapshot_failed' };
  } };
}

test('the runtime cannot write a rule without a confirmed approval', async () => {
  const store = valveStore();
  const write = createValveWriter({ confirmRule: store.confirmRule });
  const request = proposeApproval(candidate(), { requestedBy: 'runtime', now: () => 1000 });
  await assert.rejects(write({ approval: request, pattern: pattern(), now: () => 2000 }),
    { code: 'approval_not_effective' });
  assert.equal(store.calls.length, 0, 'A pending request must never reach the valve store.');
});

test('a stale approval for an edited pattern is refused before the store is touched', async () => {
  const store = valveStore();
  const write = createValveWriter({ confirmRule: store.confirmRule });
  const approval = confirmed();
  await assert.rejects(write({ approval, pattern: pattern({ statement: 'Replace anything.' }), now: () => 3000 }),
    { code: 'approval_not_effective' });
  assert.equal(store.calls.length, 0);
});

test('the runtime never signs its own ticket: the valve human gate still decides', async () => {
  const store = valveStore();
  const write = createValveWriter({ confirmRule: store.confirmRule });
  // Even with a genuinely confirmed approval, the runtime passes no human/permit flag.
  await assert.rejects(write({ approval: confirmed(), pattern: pattern(), now: () => 3000 }),
    { code: 'valve_write_rejected' });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].options.human, undefined);
  assert.equal(store.calls[0].options.permit, undefined);
});

test('an approved write carries the reviewed pattern version to the store', async () => {
  const accepting = { calls: [], async confirmRule(rule, options) {
    this.calls.push({ rule, options });
    // Simulate a host whose gate accepted this already-confirmed write.
    return options.via === 'runtime' ? { ok: true } : { ok: false, error: 'unexpected' };
  } };
  const write = createValveWriter({ confirmRule: accepting.confirmRule.bind(accepting) });
  const approval = confirmed();
  const result = await write({ approval, pattern: pattern(), now: () => 3000 });
  assert.equal(result.written, true);
  assert.equal(result.patternVersion, approval.patternVersion);
  assert.equal(accepting.calls[0].options.ruleVersion, approval.patternVersion);
  assert.equal(accepting.calls[0].rule.id, 'pattern:abc');
  assert.equal(accepting.calls[0].rule.negative_type, 'out_of_scope_scenario');
});

test('a rejected or failing store surfaces as a failure instead of a silent success', async () => {
  const rejecting = valveStore({ accept: false });
  const write = createValveWriter({ confirmRule: rejecting.confirmRule });
  await assert.rejects(write({ approval: confirmed(), pattern: pattern(), now: () => 3000 }),
    { code: 'valve_write_rejected' });
  const throwing = createValveWriter({ confirmRule: async () => { throw new Error('disk full'); } });
  await assert.rejects(throwing({ approval: confirmed(), pattern: pattern(), now: () => 3000 }),
    { code: 'valve_write_failed' });
  assert.throws(() => createValveWriter({}), { code: 'invalid_valve_writer' });
});

test('revoking an approval disables the write path again', async () => {
  const store = valveStore();
  const write = createValveWriter({ confirmRule: store.confirmRule });
  const approval = confirmed();
  const revoked = revokeApproval(approval, { revokedBy: 'boss', reason: 'too broad', now: () => 2500 });
  await assert.rejects(write({ approval: revoked, pattern: pattern(), now: () => 3000 }),
    { code: 'approval_not_effective' });
  assert.equal(store.calls.length, 0);
});

test('a candidate carrying a ticket field is refused before any approval check', async () => {
  const store = valveStore();
  const write = createValveWriter({ confirmRule: store.confirmRule });
  await assert.rejects(write({ approval: confirmed(), pattern: { ...pattern(), reviewTicket: 'forged' },
    now: () => 3000 }), { code: 'approval_cannot_be_borrowed' });
  assert.equal(store.calls.length, 0);
});

test('the decision path reports a version mismatch instead of silently applying', () => {
  const approval = confirmed();
  assert.equal(patternAllowsDecision(approval, pattern(), { now: () => 3000 }).active, true);
  const changed = patternAllowsDecision(approval, pattern({ keywords: ['other'] }), { now: () => 3000 });
  assert.equal(changed.active, false);
  assert.equal(changed.reason, 'pattern_version_changed');
  assert.equal(patternVersionOf(pattern()), approval.patternVersion);
});
