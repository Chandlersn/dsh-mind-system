import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { walkUpForDshRoot } from '../src/host.js';
import { planSagRecall, recallSagPassages } from '../src/recall-sag.js';

const question = '查找上次有关太阳能控制的正文';
const noop = () => {};
const plan = planSagRecall(question, []);

test('route a body request or an index miss with memory intent', () => {
  const rows = [{ href: 'functions/solar.md' }];
  assert.deepEqual(planSagRecall(question, rows).zones, ['functions']);
  assert.equal(planSagRecall('上次太阳能控制', rows), null);
  assert.equal(planSagRecall('执行太阳能控制', []), null);
  assert.equal(planSagRecall(question + ' password=some-secret', []), null);
  assert.equal(planSagRecall(question + ' C:\\Private\\document.txt', []), null);
  assert.notEqual(plan.query, question);
  assert.deepEqual(planSagRecall('查 insights 的太阳能正文', []).zones, ['insights']);
  assert.equal(planSagRecall('查 daily 的太阳能正文', []), null);
  assert.deepEqual(planSagRecall('只查能力台账中 SAG CLI 的正文', rows).terms, ['sag', 'cli']);
  assert.deepEqual(planSagRecall('在能力台账中查 insights 的正文', rows).terms, ['insights']);
  assert.equal(planSagRecall('只查能力台账中的正文', rows), null);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'sag-recall-'));
  const root = path.join(home, 'memory');
  const dir = path.join(root, 'functions');
  const skills = path.join(home, 'skills');
  await mkdir(dir, { recursive: true });
  await mkdir(skills);
  const file = path.join(dir, 'solar.md');
  await writeFile(file, '太阳能正文');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, dir, file, skills };
}

test('scope, relevance, UTF-8 bytes, deduplication and response limits', async t => {
  const { home, root, dir, file } = await fixture(t);
  await mkdir(path.join(home, 'outside'));
  await symlink(path.join(home, 'outside'), path.join(root, 'insights'), 'junction');
  const options = { root, deadline: performance.now() + 1000, budget: 205, search: async (query, opts) => {
    assert.deepEqual(opts.paths, [dir]);
    assert.equal(opts.maxResponseBytes, 65536);
    assert.ok(opts.signal instanceof AbortSignal);
    return { ok: true, results: [
      { path: path.join(home, 'outside', 'foo.md'), content: '太阳能 OUTSIDE' },
      { path: path.toNamespacedPath(file), content: '太阳能' + '🌍'.repeat(650) },
      { path: file, content: '太阳能 DUPLICATE' },
    ] };
  } };
  const text = await recallSagPassages(plan, options);
  assert.match(text, /functions\/solar.md.*太阳能🌍/u);
  assert.doesNotMatch(text, /OUTSIDE|DUPLICATE|\uFFFD/);
  assert.ok(Buffer.byteLength(text) <= 205);
});

test('skip insufficient budgets and discard a late result on cancellation', async t => {
  const { root, file } = await fixture(t);
  const controller = new AbortController();
  let calls = 0, finish, started;
  const searching = new Promise(resolve => { started = resolve; });
  const opts = { root, signal: controller.signal, budget: 1024, deadline: performance.now() + 1000, search: (_, options) => {
    calls++; started(options.signal); return new Promise(resolve => { finish = resolve; });
  } };
  assert.equal(await recallSagPassages(plan, { ...opts, budget: 100 }), '');
  assert.equal(await recallSagPassages(plan, { ...opts, deadline: performance.now() }), '');
  assert.equal(calls, 0);
  const pending = recallSagPassages(plan, opts);
  const signal = await searching; controller.abort();
  assert.equal(await pending, ''); assert.equal(signal.aborted, true);
  finish({ ok: true, results: [{ path: file, content: '太阳能 LATE' }] });
});

test('dispatch observation starts only at search and settles once with the search outcome', async t => {
  const { root, file } = await fixture(t);
  const events = [];
  const options = { root, budget: 1024, onSearchStart() {
    events.push('start');
    return outcome => { events.push(outcome); };
  } };
  const run = (answer, overrides) => recallSagPassages(plan, { ...options, deadline: performance.now() + 500, search: async () => {
    events.push('search');
    return answer();
  }, ...overrides });
  for (const [answer, expected] of [
    [() => ({ ok: true, results: [] }), 'success'],
    [() => ({ ok: false, reason: 'network' }), 'failed'],
    [() => { throw Error('offline'); }, 'failed'],
    [() => ({ ok: true }), 'unknown'],
    [() => new Promise(() => {}), 'timeout'],
  ]) {
    events.length = 0;
    assert.equal(await run(answer), '');
    assert.deepEqual(events, ['start', 'search', expected]);
  }
  events.length = 0;
  const controller = new AbortController();
  await run(() => { controller.abort(); return new Promise(() => {}); }, { signal: controller.signal });
  assert.deepEqual(events, ['start', 'search', 'cancelled']);
  events.length = 0;
  await run(noop, { root: path.join(root, 'absent') });
  assert.deepEqual(events, []);
  const fail = () => { throw Error('observer failed'); };
  for (const onSearchStart of [fail, () => fail]) {
    assert.match(await run(() => ({ ok: true, results: [{ path: file, content: '太阳能' }] }), { onSearchStart }), /solar\.md/);
  }
});

function hostEntry(t, { home, root, skills }, sagSearch) {
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const hooks = new Map();
  const services = new Map();
  const ctx = { tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; }, get(name) { return services.get(name); }, set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({}); return noop; } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: walkUpForDshRoot(process.env.DSH_INSTALL_DIR) }, { sagSearch });
  t.after(() => { dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; });
  return (text, turn, kind = 'enter', source = 'user', signal, remove = false) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text }], source: { kind: source } }];
    return hooks.get('agent/pre-step')({ messages, turn, agent: { id: 'scoped' }, signal }, async () => ({ kind, messages: remove ? [] : messages }));
  };
}

const textOf = result => result.messages.map(m => m.content[0].text).join('\n');

test('host calls once after admission, preserves local recall and aborts slow searches', async t => {
  const files = await fixture(t);
  await writeFile(path.join(files.root, 'MEMORY.md'), '# Memory\n\n## 决策共识 / 规范\n\n- 太阳能 LOCAL_POINTER\n');
  let calls = 0, slow = false, active;
  const entry = hostEntry(t, files, async (_, { signal }) => {
    calls++; active = signal;
    if (slow) return new Promise(() => {});
    return { ok: true, results: [{ path: files.file, content: '太阳能 BODY' }] };
  });
  const invoke = (...args) => entry(question, ...args);
  await invoke(1, 'reject'); await invoke(2, 'enter', 'agent-message'); await invoke(3, 'enter', 'user', undefined, true);
  assert.equal(calls, 0);
  const text = textOf(await invoke(4));
  assert.match(text, /LOCAL_POINTER/); assert.match(text, /太阳能 BODY/);
  assert.doesNotMatch(textOf(await invoke(4)), /太阳能 BODY/); assert.equal(calls, 1);
  slow = true;
  const local = textOf(await invoke(5));
  assert.match(local, /LOCAL_POINTER/); assert.doesNotMatch(local, /太阳能 BODY/);
  assert.equal(calls, 2); assert.equal(active.aborted, true);
  const controller = new AbortController(); controller.abort(); await invoke(6, 'enter', 'user', controller.signal);
  assert.equal(calls, 2);
});

test('pre-step dispatch honors requested roots even when the index suggests another zone', async t => {
  const files = await fixture(t);
  const all = ['functions', 'insights', 'capabilities', 'dao'];
  for (const zone of all.slice(1)) await mkdir(path.join(files.root, zone));
  await writeFile(path.join(files.root, 'MEMORY.md'), '## 功能模块索引\n\n| 功能域 | 一行摘要 |\n|---|---|\n| [solar](functions/solar.md) | solar 光伏 |\n');
  const calls = [];
  const queries = [];
  const invoke = hostEntry(t, files, async (query, { paths, exclude }) => {
    queries.push(query);
    calls.push({ paths, exclude });
    return { ok: true, results: [] };
  });
  const cases = [
    ['查 solar 正文', ['functions']],
    ['只查能力台账中 solar 的正文', ['capabilities']],
    ['仅看创新思想里的 solar 全文', ['insights']],
    ['只从道层中查 solar 原文', ['dao']],
    ['仅限功能域和能力台账中的 solar 正文', ['functions', 'capabilities']],
    ['只查能力台账中关于 insights 的 solar 正文', ['capabilities']],
    ['在能力台账中查 insights 的正文', ['capabilities']],
    ['在私人目录里搜 solar 的全文', []],
    ['除了能力台账以外，查 solar 的正文', []],
    ['除能力台账外，查 solar 的正文', []],
    ['只查项目文档里 solar 的正文', []],
    ['只查未知资料中 solar 的正文', []],
    ['只查能力台账和私人笔记里 solar 的正文', []],
    ['不要搜索正文', []],
    ['不用检索 solar 的原文', []],
    ['请别再自动搜索 solar 全文', []],
    ['查 solar 正文，排除能力台账', []],
    ['只查实验层中的 solar 正文', []],
    ['查海豚的全文', all],
  ];
  for (const [i, [text, expected]] of cases.entries()) {
    calls.length = 0;
    const response = textOf(await invoke(text, i + 1));
    if (i <= 1) assert.match(response, /functions\/solar\.md/, text);
    const paths = expected.map(zone => path.join(files.root, zone));
    const exclude = expected.includes('dao') ? ['_candidates', '_rejected', '_deleted'].map(dir => path.join(files.root, 'dao', dir)) : [];
    assert.deepEqual(calls, expected.length ? [{ paths, exclude }] : [], text);
  }
  queries.length = 0;
  await invoke('只查能力台账中 SAG CLI 的正文', cases.length + 1);
  assert.deepEqual(queries, ['sag cli']);
});
