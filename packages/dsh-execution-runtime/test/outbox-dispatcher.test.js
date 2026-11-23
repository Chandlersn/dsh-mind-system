import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxDispatcher } from '../src/outbox-dispatcher.js';

function entry(eventId, attempts = 0, extra = {}) {
  return { eventId, kind: extra.kind ?? 'repair_finished', payload: extra.payload ?? { eventId }, attempts, createdAt: extra.createdAt };
}

/** In-memory stand-in for the store's outbox API, with the same compare-and-set semantics. */
function createFakeStore(records = []) {
  const rows = new Map();
  records.forEach((record, index) => {
    rows.set(record.eventId, {
      eventId: record.eventId,
      kind: record.kind,
      payload: record.payload,
      attempts: record.attempts ?? 0,
      createdAt: record.createdAt ?? index,
      acked: false,
    });
  });
  const calls = { list: [], ack: [], retry: [] };

  return {
    rows,
    calls,
    listPendingOutbox({ limit = 100 } = {}) {
      calls.list.push({ limit });
      return [...rows.values()]
        .filter((row) => !row.acked)
        .sort((a, b) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({
          eventId: row.eventId, kind: row.kind, payload: row.payload, attempts: row.attempts, createdAt: row.createdAt,
        }));
    },
    retryOutbox(eventId, { expectedAttempts } = {}) {
      calls.retry.push({ eventId, expectedAttempts });
      const row = rows.get(eventId);
      if (!row || row.acked || row.attempts !== expectedAttempts) return false;
      row.attempts += 1;
      return true;
    },
    acknowledgeOutbox(eventId, { expectedAttempts } = {}) {
      calls.ack.push({ eventId, expectedAttempts });
      const row = rows.get(eventId);
      if (!row || row.acked || row.attempts !== expectedAttempts) return false;
      row.acked = true;
      return true;
    },
  };
}

test('a failed or invalid queue listing rejects without acknowledging and a later pass recovers', async () => {
  const store = createFakeStore([entry('e1')]);
  const list = store.listPendingOutbox.bind(store);
  let mode = 'throw';
  store.listPendingOutbox = (options) => {
    if (mode === 'throw') throw new Error('database unavailable');
    if (mode === 'invalid') return null;
    return list(options);
  };
  const dispatcher = createOutboxDispatcher({ store,
    receiver: async ({ eventId }) => ({ eventId, status: 'accepted' }) });
  await assert.rejects(dispatcher.dispatchOnce(), /database unavailable/);
  mode = 'invalid';
  await assert.rejects(dispatcher.dispatchOnce(), /must return an array/);
  assert.equal(store.calls.ack.length, 0);
  assert.equal(store.rows.get('e1').acked, false);
  mode = 'healthy';
  assert.equal((await dispatcher.dispatchOnce()).acknowledged, 1);
  assert.equal((await dispatcher.dispatchOnce()).attempted, 0);
});

test('accepted receipts acknowledge each entry and pass the producer identity through', async () => {
  const store = createFakeStore([entry('e1'), entry('e2')]);
  const sent = [];
  const dispatcher = createOutboxDispatcher({
    store,
    producerId: 'producer-1',
    receiver: async (message) => {
      sent.push(message);
      return { eventId: message.eventId, status: 'accepted' };
    },
  });

  const result = await dispatcher.dispatchOnce();

  assert.deepEqual(result, { attempted: 2, acknowledged: 2, duplicates: 0, retried: 0, skipped: 0, unavailable: false });
  assert.equal(store.calls.list.length, 1);
  assert.equal(store.calls.list[0].limit, 20);
  assert.deepEqual(sent.map((message) => message.eventId), ['e1', 'e2']);
  assert.equal(sent[0].producerId, 'producer-1');
  assert.deepEqual(sent[0].payload, { eventId: 'e1' });
  assert.deepEqual(store.calls.ack, [
    { eventId: 'e1', expectedAttempts: 0 },
    { eventId: 'e2', expectedAttempts: 0 },
  ]);
  assert.equal(store.rows.get('e1').acked, true);
  assert.equal(store.rows.get('e2').acked, true);
  assert.deepEqual(store.listPendingOutbox(), []);
});

test('duplicate receipts acknowledge the entry and are counted separately', async () => {
  const store = createFakeStore([entry('e1', 2)]);
  const dispatcher = createOutboxDispatcher({
    store,
    receiver: async (message) => ({ eventId: message.eventId, status: 'duplicate' }),
  });

  const result = await dispatcher.dispatchOnce();

  assert.deepEqual(result, { attempted: 1, acknowledged: 1, duplicates: 1, retried: 0, skipped: 0, unavailable: false });
  assert.equal(store.rows.get('e1').acked, true);
  assert.equal(store.calls.ack[0].expectedAttempts, 2);
  assert.equal(store.calls.retry.length, 0);
});

test('a throwing receiver retries that entry, leaves it unacknowledged, and the loop continues', async () => {
  const store = createFakeStore([entry('boom'), entry('fine')]);
  const warnings = [];
  const dispatcher = createOutboxDispatcher({
    store,
    logger: { warn: (message, detail) => warnings.push({ message, detail }) },
    receiver: async (message) => {
      if (message.eventId === 'boom') throw new Error('downstream down');
      return { eventId: message.eventId, status: 'accepted' };
    },
  });

  const result = await dispatcher.dispatchOnce();

  assert.deepEqual(result, { attempted: 2, acknowledged: 1, duplicates: 0, retried: 1, skipped: 0, unavailable: false });
  assert.deepEqual(store.calls.retry, [{ eventId: 'boom', expectedAttempts: 0 }]);
  assert.equal(store.rows.get('boom').attempts, 1);
  assert.equal(store.rows.get('boom').acked, false);
  assert.equal(store.rows.get('fine').acked, true);
  assert.deepEqual(store.listPendingOutbox().map((row) => row.eventId), ['boom']);
  assert.ok(warnings.some((item) => item.detail?.eventId === 'boom' && item.detail?.reason === 'receiver_threw'));
});

test('any receipt that does not match the event and an accepted outcome is never acknowledged', async () => {
  const receipts = [
    undefined,
    true,
    { ok: true },
    { eventId: 'other', status: 'accepted' },
    { eventId: 'e1', status: 'rejected' },
    { eventId: 'e1' },
    [],
  ];

  for (const receipt of receipts) {
    const store = createFakeStore([entry('e1', 0)]);
    const dispatcher = createOutboxDispatcher({ store, receiver: async () => receipt });

    const result = await dispatcher.dispatchOnce();

    assert.deepEqual(result, { attempted: 1, acknowledged: 0, duplicates: 0, retried: 1, skipped: 0, unavailable: false },
      `receipt ${JSON.stringify(receipt)} must not acknowledge`);
    assert.equal(store.calls.ack.length, 0);
    assert.deepEqual(store.calls.retry, [{ eventId: 'e1', expectedAttempts: 0 }]);
    assert.equal(store.rows.get('e1').acked, false);
    assert.equal(store.rows.get('e1').attempts, 1);
  }
});

test('a missing receiver reports unavailable without listing, acknowledging or throwing', async () => {
  for (const receiver of [undefined, null]) {
    const store = createFakeStore([entry('e1')]);
    const dispatcher = createOutboxDispatcher({ store, receiver });

    const result = await dispatcher.dispatchOnce();

    assert.deepEqual(result, { attempted: 0, acknowledged: 0, duplicates: 0, retried: 0, skipped: 0, unavailable: true });
    assert.equal(store.calls.list.length, 0);
    assert.equal(store.calls.ack.length, 0);
    assert.equal(store.rows.get('e1').acked, false);
  }
});

test('concurrent calls share one in-flight promise and send each entry only once', async () => {
  const store = createFakeStore([entry('e1'), entry('e2')]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sends = new Map();
  let active = 0;
  let maxActive = 0;
  const dispatcher = createOutboxDispatcher({
    store,
    receiver: async (message) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      sends.set(message.eventId, (sends.get(message.eventId) ?? 0) + 1);
      await gate;
      active -= 1;
      return { eventId: message.eventId, status: 'accepted' };
    },
  });

  const first = dispatcher.dispatchOnce();
  const second = dispatcher.dispatchOnce();

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(active, 1, 'only one send may be in flight');
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, secondResult);
  assert.deepEqual(firstResult, { attempted: 2, acknowledged: 2, duplicates: 0, retried: 0, skipped: 0, unavailable: false });
  assert.equal(store.calls.list.length, 1);
  assert.equal(sends.get('e1'), 1);
  assert.equal(sends.get('e2'), 1);
  assert.equal(maxActive, 1);

  // A later pass is allowed to run again (the in-flight slot was released).
  const third = await dispatcher.dispatchOnce();
  assert.deepEqual(third, { attempted: 0, acknowledged: 0, duplicates: 0, retried: 0, skipped: 0, unavailable: false });
});

test('compare-and-set uses the attempt count observed in the listing', async () => {
  const store = createFakeStore([entry('accepted', 3), entry('failed', 4)]);
  const dispatcher = createOutboxDispatcher({
    store,
    receiver: async (message) => {
      if (message.eventId === 'failed') throw new Error('downstream down');
      return { eventId: message.eventId, status: 'accepted' };
    },
  });

  const listed = store.listPendingOutbox({ limit: 10 });
  assert.deepEqual(listed.map((row) => row.attempts), [3, 4]);

  const result = await dispatcher.dispatchOnce();

  assert.equal(result.acknowledged, 1);
  assert.equal(result.retried, 1);
  assert.deepEqual(store.calls.ack, [{ eventId: 'accepted', expectedAttempts: 3 }]);
  assert.deepEqual(store.calls.retry, [{ eventId: 'failed', expectedAttempts: 4 }]);
  assert.equal(store.rows.get('accepted').acked, true);
  assert.equal(store.rows.get('failed').acked, false);
  assert.equal(store.rows.get('failed').attempts, 5);
});

test('the pass is bounded by the configured limit', async () => {
  const store = createFakeStore([entry('e1', 0, { createdAt: 0 }), entry('e2', 0, { createdAt: 1 })]);
  const dispatcher = createOutboxDispatcher({
    store,
    limit: 1,
    receiver: async (message) => ({ eventId: message.eventId, status: 'accepted' }),
  });

  const result = await dispatcher.dispatchOnce();

  assert.equal(store.calls.list[0].limit, 1);
  assert.deepEqual(result, { attempted: 1, acknowledged: 1, duplicates: 0, retried: 0, skipped: 0, unavailable: false });
  assert.equal(store.rows.get('e1').acked, true);
  assert.equal(store.rows.get('e2').acked, false);
});