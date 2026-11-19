import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../index.js';

/**
 * The recall probe's wiring, from the registration side.
 *
 * The boundary this guards: an unregistered probe must stay "not checked"
 * (violations null), and a registered one must actually be used. Both halves
 * matter equally — a probe that silently reports clean without a search is the
 * exact failure mode the weekly report was written to avoid.
 */

test('an unregistered probe reports not-registered rather than pretending', () => {
  const runtime = createRuntime({ storageDir: 'unused', thresholds: {} });
  assert.deepEqual(runtime.recallSearchState(), { registered: false });
  assert.equal(runtime.recallSearchFn(), undefined);
});

test('registering a searcher makes it available to the patrol path', () => {
  const runtime = createRuntime({ storageDir: 'unused', thresholds: {} });
  const searcher = async () => ({ ok: true, results: [] });
  const result = runtime.registerRecallSearch(searcher);
  assert.equal(result.ok, true);
  assert.deepEqual(runtime.recallSearchState(), { registered: true });
  // Identity matters: the patrol path calls this exact function, so a wrapper
  // that dropped the caller's behaviour would go unnoticed here otherwise.
  assert.equal(runtime.recallSearchFn(), searcher);
});

test('a non-function registration is refused, not silently accepted', () => {
  const runtime = createRuntime({ storageDir: 'unused', thresholds: {} });
  for (const bad of [null, undefined, 'search', 42, {}]) {
    const result = runtime.registerRecallSearch(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_a_function');
  }
  // A refused registration must not leave the probe looking wired.
  assert.deepEqual(runtime.recallSearchState(), { registered: false });
});

test('re-registration replaces the searcher', () => {
  // The memory package registers once at assembly, but a host may re-apply the
  // plugin; the newest client must win rather than the first one sticking.
  const runtime = createRuntime({ storageDir: 'unused', thresholds: {} });
  const first = async () => ({ ok: true, results: [{ path: 'old' }] });
  const second = async () => ({ ok: true, results: [{ path: 'new' }] });
  runtime.registerRecallSearch(first);
  runtime.registerRecallSearch(second);
  assert.equal(runtime.recallSearchFn(), second);
});
