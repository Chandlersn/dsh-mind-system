import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFlow } from '../src/live-flow.js';

const call = (callId, name, args = {}) => ({ callId, token: Symbol.for(`test-${callId}`), name, arguments: args });

test('maps only the supported operations and omits private data', () => {
  let time = 100;
  const flow = createLiveFlow({ now: () => time });
  const cases = [
    ['memory_write', {}, 'e2'], ['memory_insight', {}, 'e3'], ['memory_dao', {}, 'e4'],
    ['memory_index', { zone: 'functions' }, 'e6'], ['memory_index', { zone: 'insights' }, 'e7'],
    ['memory_usage', { action: 'record' }, 'e14'], ['memory_sag', { action: 'search' }, 'e15'],
  ];
  for (const [name, args, edge] of cases) {
    const exec = call(`secret-id-${edge}`, name, { ...args, body: 'secret-body' });
    flow.start(exec);
    assert.deepEqual(flow.snapshot().edges[edge], { phase: 'active', at: time, expiresAt: time + 60000 });
    flow.finish(exec, { isError: false, value: { secret: 'secret-result', success: false } });
    assert.equal(flow.snapshot().edges[edge].phase, 'finished');
    time++;
  }
  for (const exec of [call('1', 'other'), call('2', 'memory_index', { zone: 'dao' }), call('3', 'memory_usage', { action: 'report' }), call('4', 'memory_sag', { action: 'status' })]) flow.start(exec);
  assert.deepEqual(Object.keys(flow.snapshot().edges).sort(), ['e14', 'e15', 'e2', 'e3', 'e4', 'e6', 'e7']);
  assert.doesNotMatch(JSON.stringify(flow.snapshot()), /secret|memory_/);
});

test('capability index observations expire and carry no identity', () => {
  let time = 10;
  const flow = createLiveFlow({ now: () => time });
  const seen = [];
  flow.subscribe(value => seen.push(value));
  flow.capabilityIndexed('private-name');
  assert.deepEqual(flow.snapshot().edges.e9, { phase: 'finished', at: 10, expiresAt: 30010 });
  assert.doesNotMatch(JSON.stringify(seen), /private/);
  time = 30010;
  assert.equal(flow.snapshot().edges.e9, undefined);
});

test('index match source is bounded and expires without identity', () => {
  let time = 10;
  const flow = createLiveFlow({ now: () => time });
  flow.indexMatched('private-source');
  assert.deepEqual(flow.snapshot().edges, {});
  flow.indexMatched('disk', 'private-extra');
  assert.deepEqual(flow.snapshot().edges.e10, { phase: 'finished', at: 10, expiresAt: 30010, source: 'disk' });
  time = 11;
  flow.indexMatched('cache');
  assert.equal(flow.snapshot().edges.e10.source, 'cache');
  assert.doesNotMatch(JSON.stringify(flow.snapshot()), /private/);
  time = 30011;
  assert.equal(flow.snapshot().edges.e10, undefined);
});

test('retains finished and failed events for 30 seconds by default', () => {
  let time = 100;
  const flow = createLiveFlow({ now: () => time });
  const finished = call('finished', 'memory_write');
  const failed = call('failed', 'memory_dao');
  flow.start(finished); flow.finish(finished, { isError: false });
  flow.start(failed); flow.finish(failed, { isError: true });
  assert.deepEqual(flow.snapshot().edges, {
    e2: { phase: 'finished', at: 100, expiresAt: 30100 },
    e4: { phase: 'failed', at: 100, expiresAt: 30100 },
  });
  time = 30099; assert.equal(Object.keys(flow.snapshot().edges).length, 2);
  time = 30100; assert.deepEqual(flow.snapshot().edges, {});
});

test('keeps the default active timeout at 60 seconds', () => {
  let time = 100;
  const flow = createLiveFlow({ now: () => time });
  flow.start(call('active', 'memory_write'));
  time = 60099;
  assert.deepEqual(flow.snapshot().edges.e2, { phase: 'active', at: 100, expiresAt: 60100 });
  time = 60100;
  assert.deepEqual(flow.snapshot().edges.e2, { phase: 'unknown', at: 60100, expiresAt: 90100 });
  time = 90100; assert.deepEqual(flow.snapshot().edges, {});
});

test('clamps an explicit TTL to the five-minute maximum', () => {
  let time = 0;
  const flow = createLiveFlow({ now: () => time, ttlMs: 999999 });
  const exec = call('max', 'memory_write');
  flow.start(exec); flow.finish(exec, { isError: false });
  assert.equal(flow.snapshot().edges.e2.expiresAt, 300000);
  time = 299999; assert.equal(flow.snapshot().edges.e2.phase, 'finished');
  time = 300000; assert.deepEqual(flow.snapshot().edges, {});
});

test('tracks concurrent calls and retains terminal events for at least five seconds', () => {
  let time = 0;
  const flow = createLiveFlow({ now: () => time, ttlMs: 1 });
  const a = call('a', 'memory_write'), b = call('b', 'memory_write');
  flow.start(a); time = 20; flow.start(b);
  time = 100; flow.finish(b, { isError: true, error: { message: 'private' } });
  assert.equal(flow.snapshot().edges.e2.phase, 'active');
  time = 200; flow.finish(a, { isError: false });
  assert.deepEqual(flow.snapshot().edges.e2, { phase: 'finished', at: 200, expiresAt: 5200 });
  time = 5199; assert.equal(flow.snapshot().edges.e2.phase, 'finished');
  time = 5200; assert.deepEqual(flow.snapshot().edges, {});
});

test('distinguishes host errors, malformed results, missing starts and active timeouts', () => {
  let time = 10;
  const flow = createLiveFlow({ now: () => time, ttlMs: 6000 });
  const a = call('a', 'memory_dao');
  flow.start(a); flow.finish(a, { isError: true, value: { ok: true } });
  assert.equal(flow.snapshot().edges.e4.phase, 'failed');
  const b = call('b', 'memory_write'); flow.start(b); flow.finish(b, { ok: true });
  assert.equal(flow.snapshot().edges.e2.phase, 'unknown');
  flow.finish(call('missing', 'memory_insight'), { isError: false });
  assert.equal(flow.snapshot().edges.e3.phase, 'unknown');
  assert.equal(flow.snapshot().dropped, 1);
  const c = call('c', 'memory_index', { zone: 'functions' }); flow.start(c);
  time = 60010;
  assert.deepEqual(flow.snapshot().edges.e6, { phase: 'unknown', at: 60010, expiresAt: 66010 });
  time = 66010; assert.equal(flow.snapshot().edges.e6, undefined);
});

test('bounds active calls and reports rejected or unmatched observations', () => {
  const flow = createLiveFlow({ now: () => 0 });
  for (let i = 0; i < 1024; i++) flow.start(call(String(i), 'memory_write'));
  flow.start(call('overflow', 'memory_write'));
  flow.start(call('1', 'memory_write'));
  flow.start({ callId: 'no-token', name: 'memory_write', arguments: {} });
  assert.equal(flow.snapshot().dropped, 3);
  flow.finish(call('overflow', 'memory_write'), { isError: false });
  assert.equal(flow.snapshot().dropped, 4);
  assert.equal(flow.snapshot().edges.e2.phase, 'active');
});

test('keeps identical call IDs with distinct host tokens independent', () => {
  let time = 1;
  const flow = createLiveFlow({ now: () => time });
  const a = { ...call('same', 'memory_write'), token: Symbol('private-a') };
  const b = { ...call('same', 'memory_write'), token: Symbol('private-b') };
  flow.start(a); flow.start(b);
  flow.finish(a, { isError: true });
  assert.equal(flow.snapshot().edges.e2.phase, 'active');
  time++;
  flow.finish(b, { isError: false });
  assert.equal(flow.snapshot().edges.e2.phase, 'finished');
  assert.equal(flow.snapshot().dropped, 0);
  assert.doesNotMatch(JSON.stringify(flow.snapshot()), /private|same/);
  flow.finish({ name: 'memory_dao', arguments: {} }, { isError: false });
  assert.equal(flow.snapshot().edges.e4.phase, 'unknown');
  assert.equal(flow.snapshot().dropped, 1);
});

test('subscriptions are synchronous, isolated, bounded and removable', () => {
  const flow = createLiveFlow({ now: () => 10 });
  const seen = [];
  const stop = flow.subscribe(value => seen.push(value));
  const stopThrowing = flow.subscribe(() => { throw new Error('private'); });
  const exec = call('private', 'memory_write', { body: 'private' });
  flow.start(exec);
  flow.finish(exec, { isError: false, value: 'private' });
  assert.deepEqual(seen.map(value => value.edges.e2.phase), ['active', 'finished']);
  assert.doesNotMatch(JSON.stringify(seen), /private/);
  stop(); stop(); stopThrowing();
  flow.start(call('other', 'memory_dao'));
  assert.equal(seen.length, 2);
  const stops = Array.from({ length: 128 }, () => flow.subscribe(() => {}));
  assert.throws(() => flow.subscribe(() => {}), /limit/);
  stops.forEach(unsubscribe => unsubscribe());
  assert.doesNotThrow(() => flow.subscribe(() => {})());
});

test('does not match a result to a different mapped edge', () => {
  const flow = createLiveFlow({ now: () => 5 });
  flow.start(call('a', 'memory_write'));
  flow.finish(call('a', 'memory_dao'), { isError: false });
  assert.equal(flow.snapshot().edges.e2.phase, 'active');
  assert.equal(flow.snapshot().edges.e4.phase, 'unknown');
  assert.equal(flow.snapshot().dropped, 1);
});
