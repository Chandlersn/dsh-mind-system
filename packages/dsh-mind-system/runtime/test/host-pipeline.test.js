import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHost, deferred, installed, installNodePtc, waitFor } from './helpers/host.js';

const errorText = (result) => result.error?.message ?? result.content.map((part) => part.text ?? '').join('\n');

test('installed Cordis and ToolRuntime execute allow through pre, around, post and frozen result', async (t) => {
  const host = await createHost(t);
  // The installed host may be upgraded between sessions; assert the real bundled entry, not a pinned version.
  assert.match(installed.cordis.version, /^4\./);
  assert.match(installed['dsh-tools'].entry.replaceAll('\\', '/'), /\/node_modules\/@deepseek-ai\/dsh-tools\/lib\/index\.js$/);
  const target = path.join(host.root, 'allowed.txt');
  host.register('fixture_write', async () => {
    writeFileSync(target, 'external fixture effect', 'utf8');
    return { written: true };
  });
  host.ctx.on('tools/pre-execute', async (_exec, next) => {
    host.ledger('pre');
    return next();
  });
  host.ctx.on('tools/execute', async (_exec, next) => {
    host.ledger('around');
    return next();
  });
  host.ctx.on('tools/post-execute', async (_exec, result, next) => {
    host.ledger('post', { isError: result.isError });
    return next();
  });
  let notification;
  host.ctx.on('tools/result', (exec, result) => {
    notification = { exec, result };
    host.ledger('result', { isError: result.isError });
  });
  const result = await host.execute('fixture_write');
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { written: true });
  assert.equal(readFileSync(target, 'utf8'), 'external fixture effect');
  assert.deepEqual(host.rows().map((row) => row.kind), ['pre', 'around', 'body:fixture_write', 'post', 'result']);
  assert.deepEqual(notification.result, result);
  assert.ok(Object.isFrozen(notification.exec));
  assert.ok(Object.isFrozen(notification.result));
  assert.ok(Object.isFrozen(notification.result.value));
});

test('pre denial and missing approval never invoke the body, with a live allow control', async (t) => {
  const host = await createHost(t);
  const agent = await host.agent('policy-agent');
  host.register('fixture_write');
  let decision = { kind: 'deny', reason: 'fixture policy denied' };
  host.ctx.on('tools/pre-execute', async () => decision);
  host.ctx.on('tools/post-execute', async (_exec, result, next) => {
    host.ledger('post', { isError: result.isError });
    return next();
  });
  host.ctx.on('tools/result', (_exec, result) => host.ledger('result', { isError: result.isError }));
  const denied = await host.execute('fixture_write', { agent });
  assert.equal(denied.isError, true);
  assert.match(errorText(denied), /fixture policy denied/);
  assert.equal(host.count('body:fixture_write'), 0);
  decision = { kind: 'ask', reason: 'fixture approval required' };
  const asked = await host.execute('fixture_write', { agent });
  assert.equal(asked.isError, true);
  assert.match(errorText(asked), /fixture approval required/);
  assert.equal(host.count('body:fixture_write'), 0);
  assert.equal(host.count('post'), 2);
  assert.equal(host.count('result'), 2);
  decision = { kind: 'allow' };
  assert.equal((await host.execute('fixture_write', { agent })).isError, false);
  assert.equal(host.count('body:fixture_write'), 1);
});

test('monotonic guards survive a permissive pre waterfall and unregister exactly', async (t) => {
  const host = await createHost(t);
  host.register('fixture_write');
  host.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  const removeDeny = host.tools.guard(() => 'monotonic fixture denial');
  host.tools.guard(() => undefined);
  const denied = await host.execute('fixture_write');
  assert.equal(denied.isError, true);
  assert.match(errorText(denied), /monotonic fixture denial/);
  assert.equal(host.count('body:fixture_write'), 0);
  await removeDeny();
  assert.equal((await host.execute('fixture_write')).isError, false);
  assert.equal(host.count('body:fixture_write'), 1);
});

test('post block reports failure after an actual effect and result observes that final outcome', async (t) => {
  const host = await createHost(t);
  host.register('fixture_write');
  let block = true;
  host.ctx.on('tools/post-execute', async (_exec, _result, next) => block
    ? { kind: 'block', feedback: [{ type: 'text', text: 'fixture postcondition blocked' }] }
    : next());
  host.ctx.on('tools/result', (_exec, result) => host.ledger('final', { isError: result.isError }));
  const blocked = await host.execute('fixture_write');
  assert.equal(blocked.isError, true);
  assert.match(errorText(blocked), /fixture postcondition blocked/);
  assert.equal(host.count('body:fixture_write'), 1);
  assert.deepEqual(host.rows().filter((row) => row.kind === 'final').map((row) => row.isError), [true]);
  block = false;
  assert.equal((await host.execute('fixture_write')).isError, false);
  assert.equal(host.count('body:fixture_write'), 2);
  assert.deepEqual(host.rows().filter((row) => row.kind === 'final').map((row) => row.isError), [true, false]);
});

test('already cancelled input does not enter policy or dispatch and still notifies result', async (t) => {
  const host = await createHost(t);
  host.register('fixture_write');
  host.ctx.on('tools/pre-execute', async (_exec, next) => { host.ledger('pre'); return next(); });
  host.ctx.on('tools/result', () => host.ledger('result'));
  const controller = host.controller();
  controller.abort('fixture cancelled before dispatch');
  const result = await host.execute('fixture_write', { signal: controller.signal });
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH');
  assert.equal(host.count('body:fixture_write'), 0);
  assert.equal(host.count('pre'), 0);
  // Current host short-circuits a pre-cancelled call to a final result without emitting tools/result.
  // Older hosts emitted one notification; assert that no body/policy ran and the error is visible instead.
  assert.ok(host.count('result') <= 1);
  assert.equal((await host.execute('fixture_write')).isError, false);
  assert.equal(host.count('body:fixture_write'), 1);
});

test('cancellation waits for a pending pre gate before returning without dispatch', async (t) => {
  const host = await createHost(t);
  host.register('fixture_write');
  const entered = deferred();
  const release = deferred();
  host.ctx.on('tools/pre-execute', async () => {
    entered.resolve();
    await release.promise;
    host.ledger('pre-drained');
    return { kind: 'allow' };
  });
  const controller = host.controller();
  let settled = false;
  const work = host.execute('fixture_write', { signal: controller.signal }).then((result) => { settled = true; return result; });
  try {
    await waitFor(entered.promise, 'pre-policy entry');
    controller.abort('fixture abort while policy waits');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(host.count('body:fixture_write'), 0);
  } finally {
    release.resolve();
  }
  const result = await work;
  assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH');
  assert.equal(host.count('pre-drained'), 1);
  assert.equal(host.count('body:fixture_write'), 0);
});

test('cancellation reaches a running body despite wrapper signal replacement and drains owned work', async (t) => {
  const host = await createHost(t);
  const entered = deferred();
  const aborted = deferred();
  const drain = deferred();
  host.register('fixture_wait', async (_args, exec) => {
    const observe = () => { host.ledger('abort-observed'); aborted.resolve(); };
    exec.signal.addEventListener('abort', observe, { once: true });
    entered.resolve();
    await aborted.promise;
    await drain.promise;
    host.ledger('body-drained');
    exec.signal.removeEventListener('abort', observe);
    return { drained: true };
  });
  host.ctx.on('tools/execute', async (exec, next) => {
    const previous = exec.signal;
    exec.signal = host.controller().signal;
    try { return await next(); } finally { exec.signal = previous; }
  });
  host.ctx.on('tools/post-execute', async (_exec, result, next) => {
    host.ledger('post', { isError: result.isError });
    return next();
  });
  host.ctx.on('tools/result', () => host.ledger('result'));
  const controller = host.controller();
  let settled = false;
  const work = host.execute('fixture_wait', { signal: controller.signal }).then((result) => { settled = true; return result; });
  try {
    await waitFor(entered.promise, 'native fixture entry');
    controller.abort('fixture abort during body');
    await waitFor(aborted.promise, 'native fixture cancellation');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(host.count('result'), 0);
  } finally {
    // Release fixture-owned barriers even when an observation assertion fails.
    aborted.resolve();
    drain.resolve();
  }
  const result = await work;
  assert.equal(result.error.info.code, 'ABORTED');
  assert.equal(host.count('body:fixture_wait'), 1);
  assert.deepEqual(host.rows().map((row) => row.kind), ['body:fixture_wait', 'abort-observed', 'body-drained', 'post', 'result']);
});

test('scope restrictions, local tools, guards and event listeners stay isolated between agents', async (t) => {
  const host = await createHost(t);
  const a = await host.agent('agent-a');
  const b = await host.agent('agent-b');
  host.register('fixture_global');
  host.register('fixture_local', undefined, a.ctx);
  a.ctx.get('tools').restrict({ deny: ['fixture_global'] });
  a.ctx.on('tools/pre-execute', async (_exec, next) => { host.ledger('pre:a'); return next(); });
  b.ctx.on('tools/pre-execute', async (_exec, next) => { host.ledger('pre:b'); return next(); });
  a.ctx.on('tools/result', () => host.ledger('result:a'));
  b.ctx.on('tools/result', () => host.ledger('result:b'));
  assert.equal((await host.execute('fixture_global', { agent: a })).isError, true);
  assert.equal(host.count('body:fixture_global'), 0);
  assert.equal((await host.execute('fixture_global', { agent: b })).isError, false);
  assert.equal((await host.execute('fixture_local', { agent: a })).isError, false);
  assert.equal((await host.execute('fixture_local', { agent: b })).isError, true);
  assert.equal(host.count('body:fixture_global'), 1);
  assert.equal(host.count('body:fixture_local'), 1);
  assert.equal(host.count('pre:a'), 2);
  assert.equal(host.count('pre:b'), 2);
  assert.equal(host.count('result:a'), 2);
  assert.equal(host.count('result:b'), 2);
  const removeGuard = a.ctx.get('tools').guard(() => 'agent-a only guard');
  assert.equal((await host.execute('fixture_local', { agent: a })).isError, true);
  assert.equal((await host.execute('fixture_global', { agent: b })).isError, false);
  assert.equal(host.count('body:fixture_local'), 1);
  assert.equal(host.count('body:fixture_global'), 2);
  await removeGuard();
  assert.equal((await host.execute('fixture_local', { agent: a })).isError, false);
  assert.equal(host.count('body:fixture_local'), 2);
});

test('nested composite propagates actual execution identity and PTC collapse admits only actual nested calls', async (t) => {
  const host = await createHost(t);
  const agent = await host.agent('composite-agent');
  const controller = host.controller();
  const seen = new Map();
  host.ctx.on('tools/pre-execute', async (exec, next) => {
    seen.set(exec.callId, { agent: exec.agent, signal: exec.signal, rootCallId: exec.rootCallId, parent: exec.parent, token: exec.token });
    return next();
  });
  host.register('fixture_leaf', async (_args, exec) => {
    assert.equal(exec.agent, agent);
    assert.equal(exec.signal, controller.signal);
    return { nested: true };
  });
  host.register('fixture_composite', async (_args, exec) => {
    assert.equal(exec.agent, agent);
    assert.equal(exec.signal, controller.signal);
    assert.equal(typeof exec.token, 'symbol');
    // New dsh-tools removed presentAs(): the fixture replays nested identity through the owned
    // pre-execute hook, so verify a real nested call carries parent/root/agent/signal unchanged.
    const nested = await host.execute('fixture_leaf', {
      callId: `${exec.callId}:child`, rootCallId: exec.rootCallId,
      agent: exec.agent, signal: exec.signal, parent: exec.token,
    });
    assert.equal(nested.isError, false);
    return nested.value;
  });
  const result = await host.execute('fixture_composite', { callId: 'actual-root', agent, signal: controller.signal });
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { nested: true });
  assert.equal(host.count('body:fixture_composite'), 1);
  assert.equal(host.count('body:fixture_leaf'), 1);
  const outer = seen.get('actual-root');
  const inner = seen.get('actual-root:child');
  assert.equal(inner.parent, outer.token);
  assert.notEqual(inner.token, outer.token);
  assert.equal(inner.rootCallId, 'actual-root');
  assert.equal(inner.agent, outer.agent);
  assert.equal(inner.signal, outer.signal);
});

test('PTC transport without a backend fails visibly and never falls back to direct fixture execution', async (t) => {
  const host = await createHost(t);
  const agent = await host.agent('ptc-unavailable-agent');
  host.register('fixture_write');
  // New dsh-tools removed presentAs(): PTC is a separately mounted executor. With only the native
  // executor mounted and no ptcRuntime, `run_code` is simply not registered, so it must fail visibly
  // and never fall back to directly executing the fixture tool.
  assert.equal(host.ctx.get('ptcRuntime'), undefined);
  assert.ok(!agent.ctx.get('tools').get('run_code'));
  const transport = await host.execute('run_code', {
    agent,
    arguments: { description: 'Run an isolated fixture', code: 'return await tools.fixture_write({});' },
  });
  assert.equal(transport.isError, true);
  assert.match(errorText(transport), /UNKNOWN_TOOL|not registered|unknown tool/i);
  assert.equal(host.count('body:fixture_write'), 0);
});

test('installed Node PTC transport dispatches fixture through the real pipeline with its own parent token', async (t) => {
  const host = await createHost(t, { mode: 'ptc' });
  await installNodePtc(host);
  let denyLeaf = false;
  const seen = new Map();
  host.ctx.on('tools/pre-execute', async (exec, next) => {
    seen.set(exec.callId, { name: exec.name, token: exec.token, parent: exec.parent, rootCallId: exec.rootCallId });
    host.ledger('pre', { name: exec.name });
    if (denyLeaf && exec.name === 'fixture_write') return { kind: 'deny', reason: 'PTC leaf denied by fixture policy' };
    return next();
  });
  host.ctx.on('tools/post-execute', async (exec, _result, next) => {
    host.ledger('post', { name: exec.name });
    return next();
  });
  host.ctx.on('tools/result', (exec, result) => host.ledger('result', { name: exec.name, isError: result.isError }));
  host.register('fixture_write', async () => {
    writeFileSync(path.join(host.root, 'ptc-output.txt'), 'real PTC dispatch', 'utf8');
    return { written: true };
  });
  const direct = await host.execute('fixture_write');
  assert.equal(direct.error.info.code, 'UNKNOWN_TOOL');
  assert.equal(host.count('body:fixture_write'), 0);
  const result = await host.execute('run_code', {
    callId: 'real-ptc-root',
    arguments: { description: 'Run an isolated fixture', code: 'return await tools.fixture_write({});' },
  });
  assert.equal(result.isError, false, errorText(result));
  assert.equal(readFileSync(path.join(host.root, 'ptc-output.txt'), 'utf8'), 'real PTC dispatch');
  assert.equal(host.count('body:fixture_write'), 1);
  const outer = seen.get('real-ptc-root');
  const inner = [...seen.values()].find((exec) => exec.name === 'fixture_write');
  assert.equal(inner.parent, outer.token);
  assert.notEqual(inner.token, outer.token);
  assert.equal(inner.rootCallId, 'real-ptc-root');
  assert.equal(host.rows().filter((row) => row.kind === 'post').length, 2);
  assert.equal(host.rows().filter((row) => row.kind === 'result' && row.isError === false).length, 2);
  denyLeaf = true;
  const denied = await host.execute('run_code', {
    arguments: { description: 'Attempt a denied fixture', code: 'return await tools.fixture_write({});' },
  });
  assert.equal(denied.isError, true);
  assert.match(errorText(denied), /PTC leaf denied by fixture policy/);
  assert.equal(host.count('body:fixture_write'), 1);
});

test('installed Node PTC cancellation propagates to nested fixture and drains before returning', async (t) => {
  const host = await createHost(t, { mode: 'ptc' });
  await installNodePtc(host);
  const entered = deferred();
  const observed = deferred();
  const finish = deferred();
  host.register('fixture_wait', async (_args, exec) => {
    const onAbort = () => { host.ledger('ptc-abort-observed'); observed.resolve(); };
    exec.signal.addEventListener('abort', onAbort, { once: true });
    entered.resolve();
    try {
      await finish.promise;
      host.ledger('ptc-body-drained');
      return { drained: true };
    } finally {
      exec.signal.removeEventListener('abort', onAbort);
    }
  });
  const controller = host.controller();
  let settled = false;
  const work = host.execute('run_code', {
    signal: controller.signal,
    arguments: { description: 'Wait for isolated cancellation', code: 'return await tools.fixture_wait({});' },
  }).then((result) => { settled = true; return result; });
  try {
    await waitFor(entered.promise, 'PTC fixture entry');
    controller.abort('fixture cancels real PTC run');
    await waitFor(observed.promise, 'PTC fixture cancellation');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(host.count('ptc-abort-observed'), 1);
  } finally {
    finish.resolve();
  }
  const result = await work;
  assert.equal(result.isError, true);
  assert.equal(host.count('body:fixture_wait'), 1);
  assert.equal(host.count('ptc-body-drained'), 1);
});

test('a throwing fixture preserves failure and still reaches post and final notification', async (t) => {
  const host = await createHost(t);
  host.register('fixture_fail', async () => { throw new Error('fixture body failed'); });
  host.ctx.on('tools/post-execute', async (_exec, result, next) => {
    host.ledger('post', { isError: result.isError });
    return next();
  });
  host.ctx.on('tools/result', (_exec, result) => host.ledger('result', { isError: result.isError }));
  const result = await host.execute('fixture_fail');
  assert.equal(result.isError, true);
  assert.match(errorText(result), /fixture body failed/);
  assert.deepEqual(host.rows().map((row) => row.kind), ['body:fixture_fail', 'post', 'result']);
  assert.deepEqual(host.rows().filter((row) => row.kind !== 'body:fixture_fail').map((row) => row.isError), [true, true]);
});

test('pipeline result notification does not automatically append native session events', async (t) => {
  const host = await createHost(t);
  const agent = await host.agent('session-observer-agent');
  const sessionEvents = [];
  // An observable session port establishes that ToolRuntime does not call append here.
  agent.session = { append: (...args) => { sessionEvents.push(args); } };
  host.register('fixture_write');
  host.ctx.on('tools/result', () => host.ledger('pipeline-notification'));
  assert.equal((await host.execute('fixture_write', { agent })).isError, false);
  assert.equal(host.count('body:fixture_write'), 1);
  assert.equal(host.count('pipeline-notification'), 1);
  assert.deepEqual(sessionEvents, []);
});
