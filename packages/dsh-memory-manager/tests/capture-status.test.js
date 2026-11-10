import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_COUNTER_MAX, CAPTURE_PENDING_MAX, createCaptureStatus } from '../src/capture-status.js';

function noNonFiniteNumbers(value) {
  if (typeof value === 'number') assert.ok(Number.isSafeInteger(value) && value >= 0);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) noNonFiniteNumbers(v);
}

test('无观测和重新创建实例可区分，快照不可反向修改状态', () => {
  const a = createCaptureStatus({ enabled: true });
  const before = a.snapshot();
  assert.equal(before.enabled, true);
  assert.equal(before.hasObservations, false);
  assert.equal(before.resetOnNewInstance, true);
  assert.equal(before.observed, 0);
  assert.equal(before.selected, 0);
  assert.equal(before.scheduled, 0);
  assert.equal(before.failed, 0);
  assert.equal(before.pending, 0);
  assert.ok(before.createdAt > 0 && before.createdAt <= Date.now());
  before.errorCodes.OTHER = 50;
  before.observed = 100;
  assert.equal(a.snapshot().errorCodes.OTHER, 0);
  assert.equal(a.snapshot().observed, 0);
  a.observed();
  assert.equal(a.snapshot().hasObservations, true);
  const fresh = createCaptureStatus({ enabled: false }).snapshot();
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.observed, 0);
  assert.equal(fresh.hasObservations, false);
  assert.ok(fresh.createdAt >= before.createdAt);
  noNonFiniteNumbers(fresh);
});

test('并发票据只可结束一次，失败、冲突、去重和确认保留相应分母', async () => {
  const status = createCaptureStatus({ enabled: true });
  for (let i = 0; i < 6; i++) status.observed();
  for (let i = 0; i < 4; i++) status.selected();
  status.skippedSource();
  status.skippedMissingId();
  const tickets = Array.from({ length: 4 }, () => status.schedule());
  assert.equal(status.snapshot().pending, 4);
  const results = await Promise.all([
    Promise.resolve().then(() => tickets[0].finish('confirmed')),
    Promise.resolve().then(() => tickets[0].finish('failed', { code: 'MEMORY_LEDGER_APPEND_FAILED', stage: 'ledger' })),
    Promise.resolve().then(() => tickets[1].finish('duplicate')),
    Promise.resolve().then(() => tickets[2].finish('failed', { code: 'MEMORY_WRITE_COMMIT_UNKNOWN', stage: 'commit' })),
    Promise.resolve().then(() => tickets[3].finish('conflict', { code: 'MEMORY_CAPTURE_LOCK_TIMEOUT', stage: 'lock' })),
  ]);
  assert.deepEqual(results, [true, false, true, true, true]);
  const s = status.snapshot();
  assert.equal(s.observed, 6);
  assert.equal(s.selected, 4);
  assert.equal(s.scheduled, 4);
  assert.equal(s.confirmed, 1);
  assert.equal(s.duplicate, 1);
  assert.equal(s.conflict, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 0);
  assert.equal(s.skippedSource, 1);
  assert.equal(s.skippedMissingId, 1);
  assert.equal(s.errorCodes.MEMORY_WRITE_COMMIT_UNKNOWN, 1);
  assert.equal(s.errorCodes.MEMORY_CAPTURE_LOCK_TIMEOUT, 1);
  assert.equal(s.errorCodes.MEMORY_LEDGER_APPEND_FAILED, 0);
  assert.equal(s.errorStages.commit, 1);
  assert.equal(s.errorStages.lock, 1);
  assert.equal(s.scheduled, s.confirmed + s.duplicate + s.conflict + s.failed + s.pending);
  noNonFiniteNumbers(s);
});

test('仅接收白名单标签，不保留未知异常、正文、ID、路径或 getter', () => {
  const status = createCaptureStatus();
  const secret = '正文-id-/private/path-unknown exception';
  assert.equal(status.observed(secret), false);
  assert.equal(status.selected({ body: secret }), false);
  assert.equal(status.schedule({ id: secret }), null);
  const ticket = status.schedule();
  let getterCalled = false;
  const getter = {};
  Object.defineProperty(getter, 'code', { get() { getterCalled = true; return secret; }, enumerable: true });
  assert.equal(ticket.finish('failed', getter), false);
  assert.equal(getterCalled, false);
  assert.equal(ticket.finish('failed', new Error(secret)), false);
  assert.equal(ticket.finish('failed', { code: 'MEMORY_WRITE_COMMIT_UNKNOWN', stage: 'commit', path: secret }), false);
  assert.equal(ticket.finish('failed', { code: 'MEMORY_WRITE_COMMIT_UNKNOWN', stage: 'commit', message: secret }), false);
  assert.equal(ticket.finish('failed', { code: secret, stage: secret }), true);
  const snap = status.snapshot();
  assert.equal(snap.failed, 1);
  assert.equal(snap.scheduled, 1);
  assert.equal(snap.pending, 0);
  assert.equal(snap.errorCodes.OTHER, 1);
  assert.equal(snap.errorStages.OTHER, 1);
  assert.ok(!JSON.stringify(snap).includes(secret));
  assert.ok(!Object.keys(snap.errorCodes).includes(secret));
  assert.ok(!Object.keys(snap.errorStages).includes(secret));
});

test('错误格式不结束票据，确认/去重不允许夹带详情', () => {
  const status = createCaptureStatus();
  const ticket = status.schedule();
  assert.equal(ticket.finish('nonsense'), false);
  assert.equal(ticket.finish('confirmed', { code: 'MEMORY_LEDGER_UNREADABLE' }), false);
  assert.equal(ticket.finish('failed', { code: 0, stage: 'read' }), false);
  assert.equal(ticket.finish('failed', null), false);
  assert.equal(ticket.finish('failed', { code: 'x', stage: 'read' }, 'extra'), false);
  assert.equal(status.snapshot().pending, 1);
  assert.equal(ticket.finish('failed', { code: 'MEMORY_LEDGER_UNREADABLE', stage: 'read' }), true);
  assert.equal(status.snapshot().errorCodes.MEMORY_LEDGER_UNREADABLE, 1);
  assert.equal(status.snapshot().errorStages.read, 1);
  assert.equal(ticket.finish('failed'), false);
  assert.equal(status.snapshot().pending, 0);
});

test('pending 有界，不挤掉未结束票据，完成后可继续调度', () => {
  const status = createCaptureStatus({ enabled: true });
  const tickets = Array.from({ length: CAPTURE_PENDING_MAX }, () => status.schedule());
  assert.ok(tickets.every(Boolean));
  assert.equal(status.schedule(), null);
  assert.equal(status.snapshot().skippedCapacity, 1);
  assert.equal(status.snapshot().scheduled, CAPTURE_PENDING_MAX);
  assert.equal(status.snapshot().pending, CAPTURE_PENDING_MAX);
  assert.equal(tickets[0].finish('confirmed'), true);
  const next = status.schedule();
  assert.ok(next);
  for (const ticket of tickets.slice(1)) assert.equal(ticket.finish('duplicate'), true);
  assert.equal(next.finish('confirmed'), true);
  const s = status.snapshot();
  assert.equal(s.pending, 0);
  assert.equal(s.scheduled, CAPTURE_PENDING_MAX + 1);
  assert.equal(s.confirmed, 2);
  assert.equal(s.duplicate, CAPTURE_PENDING_MAX - 1);
});

test('计数饱和明确可见，不产生 NaN、无限大或循环归零', () => {
  const status = createCaptureStatus();
  for (let i = 0; i < CAPTURE_COUNTER_MAX + 2; i++) status.observed();
  const s = status.snapshot();
  assert.equal(s.observed, CAPTURE_COUNTER_MAX);
  assert.equal(s.saturated, true);
  noNonFiniteNumbers(s);
  assert.throws(() => createCaptureStatus({ enabled: 'yes' }), /enabled must be boolean/);
});
