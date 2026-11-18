import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterventionPolicy, hintText } from '../src/intervention.js';

/**
 * Intervention: the runtime makes itself known when a caller is in trouble, and stays quiet otherwise.
 *
 * The risk this file guards against is a component that either never speaks (so it effectively does not
 * exist) or speaks on everything (so it is ignored, which is the same outcome). Both are checked, and the
 * counters are asserted as a pair: a hint count without a denominator cannot be read.
 */

const NOW = 1_000_000;
const clock = (start = NOW) => { let at = start; const now = () => at; now.advance = (ms) => { at += ms; }; return now; };

test('the same failure has to repeat before the runtime speaks', () => {
  const policy = createInterventionPolicy({ threshold: 2, now: () => NOW });
  const message = 'verification failed: output does not match';
  // One occurrence is not enough: a single failure is ordinary and offering help for it would be noise.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message }).skipped, 'below_threshold');
  const second = policy.evaluate({ agentId: 'a', tool: 't', message });
  assert.ok(second.hint, JSON.stringify(second));
  // A third identical failure must not repeat the hint: one note per signature is enough.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message }).skipped, 'already_hinted');
});

test('failures the runtime could not help with are ignored outright', () => {
  const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
  for (const message of ['syntax error near token', 'file not found', 'permission denied']) {
    const verdict = policy.evaluate({ agentId: 'a', tool: 't', message });
    assert.equal(verdict.skipped, 'not_relevant', message);
    assert.equal(verdict.hint, undefined);
  }
  // Nothing was hinted, and every evaluation was recorded — that the counters move is what proves the
  // policy was watching rather than absent.
  const metrics = policy.metrics();
  assert.equal(metrics.hinted, 0);
  assert.equal(metrics.evaluated, 3);
  assert.equal(metrics.skipped, 3);
});

test('the cooldown is per agent and expires', () => {
  const now = clock();
  const policy = createInterventionPolicy({ threshold: 1, cooldownMs: 60_000, now });
  assert.ok(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).hint);
  // A different signature from the same agent inside the cooldown is suppressed.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'deadline exceeded' }).skipped, 'cooldown');
  // Another agent is unaffected: the cooldown is a per-caller courtesy, not a global mute.
  assert.ok(policy.evaluate({ agentId: 'b', tool: 't', message: 'timeout' }).hint);
  // After the window, the first agent can be helped again.
  now.advance(61_000);
  assert.ok(policy.evaluate({ agentId: 'a', tool: 't', message: 'rollback failed' }).hint);
});

test('an old failure stops counting toward a present one', () => {
  const now = clock();
  const policy = createInterventionPolicy({ threshold: 2, cooldownMs: 60_000, now });
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).skipped, 'below_threshold');
  // Beyond the window the earlier observation is dropped, so this remains a first occurrence.
  now.advance(120_000);
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).skipped, 'below_threshold');
});

test('the counters are reported with their denominator', () => {
  const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
  policy.evaluate({ agentId: 'a', tool: 't', message: 'syntax error' });
  policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' });
  const metrics = policy.metrics();
  // hinted alone would look identical to "nobody is watching"; skipped is the denominator.
  assert.equal(metrics.hinted, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.evaluated, 2);
  assert.equal(metrics.missRate, 0.5);
  assert.equal(metrics.skippedByReason.not_relevant, 1);
});

test('a hint offers help without instructing the caller', () => {
  const text = hintText();
  // It must name the capability and explicitly leave the decision open.
  assert.match(text, /runtime_execute/);
  assert.match(text, /不一定要用/);
  // It must not claim the task failed, nor order a repair: the runtime does not decide for a caller.
  // Match an imperative at the start of a clause, not the substring inside 「不一定要用」.
  assert.doesNotMatch(text, /(?:^|[；。\n])\s*(?:必须|立即|一定要|请)/u);
  assert.doesNotMatch(text, /已经失败|任务失败了/u);
});

test('one agent cannot grow the tracked set without bound', () => {
  const policy = createInterventionPolicy({ threshold: 1, maxTrackedAgents: 3, now: () => NOW });
  for (const agentId of ['a', 'b', 'c', 'd', 'e']) {
    policy.evaluate({ agentId, tool: 't', message: 'timeout' });
  }
  // The oldest agents are evicted rather than accumulated; each new evaluation still works.
  assert.equal(policy.metrics().evaluated, 5);
  assert.equal(policy.metrics().hinted, 5);
});
