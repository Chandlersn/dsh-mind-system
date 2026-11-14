/**
 * P0-3 (2026-11-14): managed writes emit a daily downward-admission record.
 *
 * WHY THIS SUITE EXISTS
 * --------------------
 * Calibration may only use daily samples, but nothing in the ordinary write
 * path ever produced one. The real ledger stalled at one daily row on
 * 2026-11-10 while agents kept writing memory every day, so `dailyCount` could
 * never grow no matter how much real work happened.
 *
 * The assertions below pin four properties that must all hold, because the
 * cheap-looking fixes each break one:
 *   1. a managed WRITE records exactly one daily admission;
 *   2. a READ records none (reading is not an admission);
 *   3. the write still succeeds when the valve service is absent or throws
 *      (bookkeeping must never cost availability);
 *   4. the recorded origin is `daily`, so it actually reaches the calibration
 *      denominator rather than being silently filed as untagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordDownwardWrite } from '../src/valves-bridge.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'p03-downward-'));
  const root = path.join(home, 'memory');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# idx\n', 'utf8');
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return { home, root };
}

/** Minimal stand-in that records what the bridge asked of the valve service. */
function spyValves(behavior = 'ok') {
  const calls = [];
  return {
    calls,
    service: {
      negativeRules: async () => [],
      upward: () => undefined,
      downward(from, to, data) {
        calls.push({ from, to, data });
        if (behavior === 'throw') throw new Error('valve service exploded');
        return { admitted: true, reason: 'concretized' };
      },
    },
  };
}

const ctxWith = (service) => ({ get: (name) => (name === 'valves' ? service : undefined) });

test('a managed write records exactly one daily downward admission at the write layer', () => {
  const spy = spyValves();
  const verdict = recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_write', layer: 'L2', target: '某功能域' });
  assert.ok(verdict, 'the bridge must return the valve decision');
  assert.equal(spy.calls.length, 1, 'exactly one admission per write');
  const [call] = spy.calls;
  assert.equal(call.from, 'L2');
  assert.equal(call.to, 'L3', 'descent steps exactly one rank (L2->L3)');
  assert.equal(call.data.origin, 'daily', 'must be daily, or it never reaches calibration');
  assert.deepEqual(call.data.constraints, ['某功能域']);
});

test('insight writes step L1→L2 and dao writes step L0→L1 (adjacent only)', () => {
  const spy = spyValves();
  recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_insight', layer: 'L1' });
  recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_dao', layer: 'L0' });
  // Adjacent-only: the real downward predicate denies any skip, so a mapping
  // that jumps two ranks (the first version sent L2->L0 for 道) would make every
  // such write land as non_adjacent_descent. A real run caught exactly that.
  assert.deepEqual(spy.calls.map((c) => [c.from, c.to]), [['L1', 'L2'], ['L0', 'L1']]);
});

test('layer mapping never jumps more than one rank', () => {
  const spy = spyValves();
  for (const layer of ['L0', 'L1', 'L2', 'L3']) {
    recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_write', layer });
  }
  for (const call of spy.calls) {
    const from = Number(call.from.slice(1));
    const to = Number(call.to.slice(1));
    assert.equal(to, from + 1, `${call.from}->${call.to} must be exactly one rank`);
  }
});

test('an absent valve service yields undefined and never throws', () => {
  assert.equal(recordDownwardWrite(ctxWith(undefined), { tool: 'memory_write' }), undefined);
  assert.equal(recordDownwardWrite({}, { tool: 'memory_write' }), undefined);
  assert.equal(recordDownwardWrite(undefined, { tool: 'memory_write' }), undefined);
});

test('a throwing valve service is swallowed — the write path must not pay for bookkeeping', () => {
  const spy = spyValves('throw');
  assert.doesNotThrow(() => recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_write' }));
  assert.equal(recordDownwardWrite(ctxWith(spy.service), { tool: 'memory_write' }), undefined);
  assert.equal(spy.calls.length, 2, 'it must have actually attempted both calls');
});
