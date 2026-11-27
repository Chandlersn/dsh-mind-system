import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAdoption } from '../src/valves-bridge.js';

function ctxWith(valves) {
  return { get(name) { return name === 'valves' ? valves : undefined; } };
}

test('recordAdoption forwards a host-owned signal and returns the ledger result', async () => {
  const calls = [];
  const valves = {
    negativeRules() {}, upward() {},
    async recordAdoptionSignal(s) { calls.push(s); return true; },
  };
  assert.equal(await recordAdoption(ctxWith(valves), { objectKey: 'functions/x.md', kind: 'correction', note: 'n' }), true);
  assert.deepEqual(calls, [{ objectKey: 'functions/x.md', kind: 'correction', note: 'n' }]);
});

test('recordAdoption degrades to undefined when valves is absent or lacks the method', async () => {
  assert.equal(await recordAdoption(ctxWith(undefined), { objectKey: 'x', kind: 'positive' }), undefined);
  assert.equal(await recordAdoption(ctxWith({ negativeRules() {}, upward() {} }), { objectKey: 'x', kind: 'positive' }), undefined);
});

test('recordAdoption never throws: a broken valves service cannot block a memory write', async () => {
  const valves = {
    negativeRules() {}, upward() {},
    async recordAdoptionSignal() { throw new Error('ledger down'); },
  };
  assert.equal(await recordAdoption(ctxWith(valves), { objectKey: 'x', kind: 'positive' }), undefined);
  assert.equal(await recordAdoption({ get() { throw new Error('ctx broken'); } }, { objectKey: 'x', kind: 'positive' }), undefined);
});
