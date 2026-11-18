import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternTool } from '../src/dynamic-tools.js';
import { createValveWriter, patternAllowsDecision } from '../src/valve-bridge.js';
import { patternVersionOf } from '../src/pattern-approval.js';

/**
 * The valve write path, wired through a tool.
 *
 * ## The uncomfortable fact this file records
 *
 * `valve-bridge.js` refuses to pass a `human` flag or a permit, and its comment reads as though that proves
 * the runtime cannot self-confirm. It does not prove that. In this codebase `valves.confirm()` is itself a
 * human channel — it issues its own permit internally — so anything permitted to call it can write.
 *
 * The defence therefore lives in *which writer the host supplies*, not in the call shape. The runtime cannot
 * distinguish an autonomous writer from a genuinely gated one, so these tests pin what it *can* guarantee:
 * it never signs, it refuses without a confirmed and current approval, and it never takes a pattern body
 * from the request. What it cannot guarantee is stated here rather than implied away.
 */

const clock = () => 1_000;

function pattern(overrides = {}) {
  return { patternId: 'p-1', statement: 'never retry without reading the error', negativeType: 'forbidden_skill',
    keywords: ['retry', 'error'], layer: 'L2', scopeRef: 'scope-a', ...overrides };
}

function confirmed(patternValue = pattern(), overrides = {}) {
  return { patternId: patternValue.patternId, status: 'confirmed', patternVersion: patternVersionOf(patternValue),
    confirmedBy: 'human:boss', expiresAt: 10_000, ...overrides };
}

test('the tool refuses when no writer is configured, naming the reason', async () => {
  const tool = createPatternTool({ valveWriter: null, patterns: [pattern()], reason: 'no_valve_writer' });
  const result = await tool.execute({ patternId: 'p-1' }, {});
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_valve_writer');
  // A refusal must not look like a write that happened to do nothing.
  assert.equal(Object.hasOwn(result, 'written'), false);
});

test('the runtime never takes a pattern body from the request', async () => {
  const written = [];
  const tool = createPatternTool({ patterns: [pattern()],
    valveWriter: async ({ pattern: value }) => { written.push(value); return { written: true, ruleId: value.patternId }; } });
  // A caller may name a pattern, never describe one: an unregistered id is refused outright.
  const unknown = await tool.execute({ patternId: 'invented', statement: 'anything I like' }, {});
  assert.equal(unknown.written, false);
  assert.equal(unknown.reason, 'pattern_not_registered');
  assert.equal(written.length, 0, 'The store must not be reached for an unregistered pattern.');
  // The registered one carries the host's statement, not whatever the request said.
  const ok = await tool.execute({ patternId: 'p-1', statement: 'overridden' }, {});
  assert.equal(ok.written, true);
  assert.equal(written[0].statement, 'never retry without reading the error');
});

test('an absent or stale approval is refused before the store is touched', async () => {
  const calls = [];
  const write = createValveWriter({ confirmRule: async (rule) => { calls.push(rule); return { ok: true }; } });
  await assert.rejects(write({ approval: null, pattern: pattern(), now: clock }),
    { code: 'approval_not_effective' });
  const stale = confirmed(pattern(), { expiresAt: 500 });
  await assert.rejects(write({ approval: stale, pattern: pattern(), now: clock }),
    { code: 'approval_not_effective' });
  // A pending ticket is not an approval, even if everything else matches.
  const pending = confirmed(pattern(), { status: 'pending' });
  await assert.rejects(write({ approval: pending, pattern: pattern(), now: clock }),
    { code: 'approval_not_effective' });
  assert.equal(calls.length, 0, 'A refused approval must never reach the store.');
});

test('an approval for a different pattern version does not carry over', async () => {
  const calls = [];
  const write = createValveWriter({ confirmRule: async () => { calls.push(1); return { ok: true }; } });
  // The pattern changed after the approval was issued: same id, different body, different version hash.
  const approval = confirmed(pattern());
  await assert.rejects(write({ approval, pattern: pattern({ statement: 'edited afterwards' }), now: clock }),
    { code: 'approval_not_effective' });
  assert.equal(calls.length, 0);
});

test('the runtime passes no human flag and no permit of its own', async () => {
  const calls = [];
  const write = createValveWriter({ confirmRule: async (rule, options) => {
    calls.push({ rule, options }); return { ok: true }; } });
  await write({ approval: confirmed(), pattern: pattern(), now: clock });
  assert.equal(calls[0].options.human, undefined);
  assert.equal(calls[0].options.permit, undefined);
  // The reviewed version travels with the write so the store can bind the rule to what was reviewed.
  assert.equal(calls[0].options.ruleVersion, patternVersionOf(pattern()));
  assert.equal(calls[0].options.via, 'runtime');
});

test('a writer the host supplies decides whether the write is truly human-gated', async () => {
  // A gated writer refuses autonomous writes; the runtime simply reports the refusal.
  const gated = createValveWriter({ confirmRule: async () => ({ ok: false, error: 'not_human_confirmed' }) });
  await assert.rejects(gated({ approval: confirmed(), pattern: pattern(), now: clock }),
    { code: 'valve_write_rejected' });
  // An ungated writer accepts. This is the case the runtime cannot detect — recorded as a test so the
  // limitation is visible rather than assumed away.
  const ungated = createValveWriter({ confirmRule: async () => ({ ok: true }) });
  const result = await ungated({ approval: confirmed(), pattern: pattern(), now: clock });
  assert.equal(result.written, true);
});

test('a store rejection or a throwing writer surfaces as a failure, not a silent success', async () => {
  const rejecting = createValveWriter({ confirmRule: async () => ({ ok: false, error: 'rule_store_down' }) });
  await assert.rejects(rejecting({ approval: confirmed(), pattern: pattern(), now: clock }),
    { code: 'valve_write_rejected' });
  const throwing = createValveWriter({ confirmRule: async () => { throw new Error('boom'); } });
  await assert.rejects(throwing({ approval: confirmed(), pattern: pattern(), now: clock }),
    { code: 'valve_write_failed' });
});

test('the decision path reports an inactive approval instead of applying it', () => {
  const active = patternAllowsDecision(confirmed(), pattern(), { now: clock });
  assert.equal(active.active, true);
  const stale = patternAllowsDecision(confirmed(pattern(), { expiresAt: 10 }), pattern(), { now: clock });
  assert.equal(stale.active, false);
  assert.ok(stale.reason);
});
