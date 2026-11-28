import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityHealthCheck } from '../src/activity-health-check.js';

test('a slow scan survives the foreground deadline and overlapping turns share it', async () => {
  let calls = 0, release;
  let time = 1000;
  const refresh = createActivityHealthCheck(() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  }, { now: () => time, waitMs: 5 });
  assert.deepEqual(await Promise.all([refresh(), refresh()]), [{ state: 'pending' }, { state: 'pending' }]);
  assert.equal(calls, 1);
  const completion = refresh();
  release({ results: [] });
  assert.deepEqual(await completion, { state: 'ok' });
  time += 86_399_999;
  assert.deepEqual(await refresh(), { state: 'cooldown' });
  assert.equal(calls, 1);
  time++;
  assert.deepEqual(await refresh(), { state: 'pending' });
  assert.equal(calls, 2);
  release({ results: [] });
});

test('partial delivery consumes only the short retry interval', async () => {
  let calls = 0, time = 0;
  const refresh = createActivityHealthCheck(async () => ++calls === 1 ? { trackingFailures: [{}] } : {}, { now: () => time });
  assert.deepEqual(await refresh(), { state: 'failed' });
  time = 59_999;
  assert.deepEqual(await refresh(), { state: 'failed' });
  assert.equal(calls, 1);
  time++;
  assert.deepEqual(await refresh(), { state: 'ok' });
});
