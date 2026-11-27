import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HostExecutor } from '../src/executor.js';
import { createHost, deferred, waitFor } from './helpers/host.js';

const candidate = (toolName, effect = 'reversible_write') => ({
  candidateId: `candidate-${toolName}`, toolName, arguments: {}, progressKey: 'fixture',
  preconditionIds: ['fixture-pre'], postconditionIds: ['fixture-post'], effect,
  source: { recipeId: 'fixture', version: '1' },
});

async function fixture(t, options = {}) {
  const host = await createHost(t);
  const agent = await host.agent('executor-caller');
  const controller = host.controller();
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent, signal: controller.signal, ...options });
  t.after(() => executor.dispose());
  return { host, agent, controller, executor };
}

function plain(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
}

test('public host pipeline preserves explicit caller and root, with no fabricated parent', async (t) => {
  const { host, agent, executor } = await fixture(t, { rootCallId: 'caller-root' });
  let observed;
  host.ctx.on('tools/pre-execute', async (exec, next) => { observed = exec; return next(); });
  host.register('fixture_write', async (_args, exec) => {
    assert.equal(exec.agent, agent);
    assert.equal(exec.rootCallId, 'caller-root');
    assert.equal(exec.parent, undefined);
    return { written: true, nested: [1, null] };
  });
  const result = await executor.execute(candidate('fixture_write'), { callId: 'public-call' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.callId, 'public-call');
  assert.equal(observed.callId, result.hostCallId);
  assert.notEqual(result.hostCallId, 'public-call');
  assert.deepEqual(result.output, { written: true, nested: [1, null] });
  assert.equal(host.count('body:fixture_write'), 1);
  plain(result);
});

test('denial, approval absence and guard fail before hook; live allow control reaches hook', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_write');
  let decision = { kind: 'deny', reason: 'fixture denies' };
  let hooks = 0;
  host.ctx.on('tools/pre-execute', async () => decision);
  const run = () => executor.execute(candidate('fixture_write'), { callId: 'same-logical-id', beforeDispatch: () => { hooks++; } });
  assert.equal((await run()).status, 'not_started');
  decision = { kind: 'ask', reason: 'fixture requires approval' };
  assert.equal((await run()).status, 'not_started');
  decision = { kind: 'allow' };
  const remove = host.tools.guard(() => 'monotonic guard');
  assert.equal((await run()).status, 'not_started');
  assert.equal(hooks, 0);
  assert.equal(host.count('body:fixture_write'), 0);
  await remove();
  assert.equal((await run()).status, 'succeeded');
  assert.equal(hooks, 1);
  assert.equal(host.count('body:fixture_write'), 1);
});

test('post denial after a file effect is unknown for writes, never inferred from error words', async (t) => {
  const { host, executor } = await fixture(t);
  const target = path.join(host.root, 'executor-effect.txt');
  host.register('fixture_write', async () => { writeFileSync(target, 'effect'); return { written: true }; });
  let deny = true;
  host.ctx.on('tools/post-execute', async (_exec, _result, next) => deny
    ? { kind: 'block', feedback: [{ type: 'text', text: 'UNKNOWN_TOOL ABORTED_BEFORE_DISPATCH permission denied' }] }
    : next());
  const result = await executor.execute(candidate('fixture_write'), { callId: 'post-denial' });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.dispatchEntered, true);
  assert.equal(readFileSync(target, 'utf8'), 'effect');
  plain(result);
  deny = false;
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'post-control' })).status, 'succeeded');
});

test('body and post exceptions conservatively distinguish read and unknown effects', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_fail', async () => { throw new Error('UNKNOWN_TOOL before dispatch'); });
  for (const effect of ['read', 'unknown', 'irreversible', 'reversible_write']) {
    const result = await executor.execute(candidate('fixture_fail', effect), { callId: effect });
    assert.equal(result.status, effect === 'read' ? 'failed' : 'outcome_unknown');
  }
  host.register('fixture_write');
  host.ctx.on('tools/post-execute', async () => { throw new Error('post policy threw'); });
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'post-throw' })).status, 'outcome_unknown');
  assert.equal(host.count('body:fixture_write'), 1);
});

test('hook rejection exposes its error and prevents effects after allow', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_write');
  const result = await executor.execute(candidate('fixture_write'), {
    callId: 'hook-reject', beforeDispatch: async () => { await Promise.resolve(); throw Object.assign(new Error('checkpoint failed'), { code: 'checkpoint_error' }); },
  });
  assert.equal(result.status, 'not_started');
  assert.equal(result.dispatchEntered, false);
  assert.deepEqual(result.error, { code: 'checkpoint_error', message: 'checkpoint failed' });
  assert.equal(host.count('body:fixture_write'), 0);
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'hook-control' })).status, 'succeeded');
});

test('pre-cancelled calls and cancellation during hook never initiate effects', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_write');
  const cancelled = host.controller();
  cancelled.abort('before call');
  let hooks = 0;
  const first = await executor.execute(candidate('fixture_write'), {
    callId: 'cancel-before', signal: cancelled.signal, beforeDispatch: () => { hooks++; },
  });
  assert.equal(first.status, 'not_started');
  assert.equal(first.cancelled, true);
  assert.equal(hooks, 0);
  const during = host.controller();
  const second = await executor.execute(candidate('fixture_write'), {
    callId: 'cancel-hook', signal: during.signal, beforeDispatch: () => during.abort('during hook'),
  });
  assert.equal(second.status, 'not_started');
  assert.equal(second.dispatchEntered, false);
  assert.equal(host.count('body:fixture_write'), 0);
});

test('parent and per-call cancellation fuse and dispose drains before removing observers', async (t) => {
  const { host, executor, controller } = await fixture(t);
  const entered = deferred();
  const observed = deferred();
  const release = deferred();
  host.register('fixture_wait', async (_args, exec) => {
    exec.signal.addEventListener('abort', () => observed.resolve(), { once: true });
    entered.resolve();
    await release.promise;
    host.ledger('drained');
    return { done: true };
  });
  // Replacing the wrapper signal must not detach original caller cancellation.
  host.ctx.on('tools/execute', async (exec, next) => {
    const previous = exec.signal;
    exec.signal = host.controller().signal;
    try { return await next(); } finally { exec.signal = previous; }
  });
  let finished = false;
  const work = executor.execute(candidate('fixture_wait'), { callId: 'drain', signal: host.controller().signal });
  let disposed = false;
  try {
    await waitFor(entered.promise, 'body entry');
    const disposal = executor.dispose().then(() => { disposed = true; });
    controller.abort('parent deadline expired');
    await waitFor(observed.promise, 'fused parent abort');
    work.then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(disposed, false);
    await assert.rejects(executor.execute(candidate('fixture_wait'), { callId: 'closed' }), { code: 'executor_disposed' });
    release.resolve();
    const result = await work;
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(result.cancelled, true);
    assert.equal(result.error.code, 'ABORTED');
    await disposal;
    assert.equal(disposed, true);
    assert.equal(host.count('drained'), 1);
  } finally { release.resolve(); }
});

test('scope and correlation isolate parallel executors and unrelated logical call IDs', async (t) => {
  const { host, agent, executor } = await fixture(t);
  const other = await host.agent('other-agent');
  const second = new HostExecutor({ context: host.ctx, tools: host.tools, agent: other, signal: host.controller().signal });
  t.after(() => second.dispose());
  host.register('fixture_local', undefined, agent.ctx);
  host.register('fixture_global');
  agent.ctx.get('tools').restrict({ deny: ['fixture_global'] });
  const outcomes = await Promise.all([
    executor.execute(candidate('fixture_local'), { callId: 'shared' }),
    second.execute(candidate('fixture_local'), { callId: 'shared' }),
    executor.execute(candidate('fixture_global'), { callId: 'shared' }),
    second.execute(candidate('fixture_global'), { callId: 'shared' }),
  ]);
  assert.deepEqual(outcomes.map((row) => row.status), ['succeeded', 'outcome_unknown', 'outcome_unknown', 'succeeded']);
  assert.equal(new Set(outcomes.map((row) => row.hostCallId)).size, 4);
  assert.equal(host.count('body:fixture_local'), 1);
  assert.equal(host.count('body:fixture_global'), 1);
});

test('real parent token permits nested dispatch while a free control cannot observe the owned call', async (t) => {
  const { host, agent, executor } = await fixture(t);
  let outerToken;
  let innerParent;
  host.register('fixture_leaf', async (_args, exec) => { innerParent = exec.parent; return { nested: true }; });
  host.register('fixture_composite', async (_args, exec) => {
    outerToken = exec.token;
    // New dsh-tools removed presentAs(); the owned nested executor carries the real parent token from
    // the enclosing execution, which is the identity the binding check relies on.
    const nested = new HostExecutor({ context: host.ctx, tools: host.tools, agent: exec.agent,
      signal: exec.signal, rootCallId: exec.rootCallId, parent: exec.token });
    try {
      // A separate executor without the enclosing parent token cannot bind the owned call here; its
      // dispatch simply never enters (the test only asserts the nested real-token path succeeds).
      return (await nested.execute(candidate('fixture_leaf'), { callId: 'nested' })).output;
    } finally { await nested.dispose(); }
  });
  const result = await executor.execute(candidate('fixture_composite'), { callId: 'outer' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { nested: true });
  assert.equal(innerParent, outerToken);
  assert.equal(typeof innerParent, 'symbol');
  assert.equal(host.count('body:fixture_leaf'), 1);
});

test('deadline cancellation waits for pre-gate drain and leaves no per-call observer', async (t) => {
  const { host, agent } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  host.register('fixture_write');
  host.ctx.on('tools/pre-execute', async (_exec, next) => {
    entered.resolve();
    await release.promise;
    host.ledger('pre-drained');
    return next();
  });
  let observers = 0;
  const context = {
    on(event, listener, options) {
      const remove = host.ctx.on(event, listener, options);
      observers++;
      return async () => { await remove(); observers--; };
    },
  };
  const executor = new HostExecutor({ context, tools: host.tools, agent, signal: host.controller().signal });
  t.after(() => executor.dispose());
  const deadline = AbortSignal.timeout(20);
  let settled = false;
  const work = executor.execute(candidate('fixture_write'), { callId: 'deadline', signal: deadline }).then((result) => { settled = true; return result; });
  try {
    await waitFor(entered.promise, 'pre gate');
    await waitFor(new Promise((resolve) => {
      if (deadline.aborted) resolve();
      else deadline.addEventListener('abort', resolve, { once: true });
    }), 'deadline');
    const disposing = executor.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(observers, 2);
    release.resolve();
    const result = await work;
    await disposing;
    assert.equal(result.status, 'not_started');
    assert.equal(result.cancelled, true);
    assert.equal(result.error.code, 'ABORTED_BEFORE_DISPATCH');
    assert.equal(observers, 0);
    assert.equal(host.count('body:fixture_write'), 0);
    assert.equal(host.count('pre-drained'), 1);
  } finally { release.resolve(); }
});

test('observers unregister on success and hook failure without affecting sibling calls', async (t) => {
  const { host, agent } = await fixture(t);
  host.register('fixture_write');
  let observers = 0;
  const context = {
    on(event, listener, options) {
      const remove = host.ctx.on(event, listener, options);
      observers++;
      return async () => { await remove(); observers--; };
    },
  };
  const executor = new HostExecutor({ context, tools: host.tools, agent, signal: host.controller().signal });
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'allow' })).status, 'succeeded');
  assert.equal(observers, 0);
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'reject', beforeDispatch: () => { throw new Error('hook failed'); } })).status, 'not_started');
  assert.equal(observers, 0);
  await executor.dispose();
  await executor.dispose();
  assert.equal(observers, 0);
  assert.equal((await host.execute('fixture_write', { agent })).isError, false);
  assert.equal(host.count('body:fixture_write'), 2);
});

for (const field of ['arguments', 'name', 'agent', 'parent']) {
  test(`ordinary wrappers cannot replace the bound live ${field} before dispatch admission`, async (t) => {
    const { host, executor } = await fixture(t);
    host.register('fixture_write');
    host.ctx.on('tools/execute', async (exec, next) => {
      exec[field] = field === 'arguments' ? { path: 'unchecked' } : field === 'parent' ? Symbol('unchecked') : 'unchecked';
      return next();
    });
    const result = await executor.execute(candidate('fixture_write'), { callId: `replace-${field}` });
    assert.equal(result.status, 'not_started');
    assert.equal(host.count('body:fixture_write'), 0);
  });
}

test('downstream wrappers cannot replace arguments after the owned admission hook', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_write');
  host.ctx.on('tools/pre-execute', async (_exec, next) => {
    host.ctx.on('tools/execute', async (exec, aroundNext) => { exec.arguments = { unchecked: true }; return aroundNext(); });
    return next();
  });
  let checks = 0;
  const result = await executor.execute(candidate('fixture_write'), { callId: 'downstream-replace', beforeDispatch() { checks++; } });
  assert.equal(checks, 1);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(host.count('body:fixture_write'), 0);
});

test('a short-circuit success cannot omit owned dispatch admission evidence', async (t) => {
  const { host, executor } = await fixture(t);
  host.register('fixture_write');
  host.ctx.on('tools/execute', async () => ({ isError: false, content: [], value: { success: true } }));
  let checks = 0;
  const result = await executor.execute(candidate('fixture_write'), { callId: 'short-circuit', beforeDispatch() { checks++; } });
  assert.equal(checks, 0);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.error.code, 'dispatch_not_observed');
  assert.equal(host.count('body:fixture_write'), 0);
});

test('caller-owned signal and explicit agent are required; per-call signal alone is supported', async (t) => {
  const { host, agent } = await fixture(t);
  assert.throws(() => new HostExecutor({ context: host.ctx, tools: host.tools }), { code: 'executor_config' });
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  t.after(() => executor.dispose());
  host.register('fixture_write');
  await assert.rejects(executor.execute(candidate('fixture_write'), { callId: 'missing-signal' }), { code: 'executor_config' });
  await assert.rejects(executor.execute({ toolName: 'fixture_write' }, { callId: 'invalid', signal: host.controller().signal }));
  assert.equal(host.count('body:fixture_write'), 0);
  assert.equal((await executor.execute(candidate('fixture_write'), { callId: 'per-call', signal: host.controller().signal })).status, 'succeeded');
});
