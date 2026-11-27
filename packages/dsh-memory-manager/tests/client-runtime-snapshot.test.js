import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the actual architecture rendering without network access.
let effects = null;
let stateUpdates = 0;
let streamRef;
const React = {
  createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children } }; },
  useState(init) { return [typeof init === 'function' ? init() : init, () => { stateUpdates++; }]; },
  useEffect(fn) { if (effects) effects.push(fn); },
  useRef(value) { return value && Object.hasOwn(value, 'flowAt') ? (streamRef ??= { current: value }) : { current: value }; },
};
let definition;
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
await import('../client.js');
const instance = definition.factory((name) => name === 'react' ? React : undefined);
let Panel;
instance.apply({ slots: { inject(_slot, fn) { fn(); }, register(options, component) { if (options.name === 'main') Panel = component; } } });
let source;
window.EventSource = class {
  constructor() { this.handlers = {}; source = this; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  emit(name, data = {}) { this.handlers[name]?.({ data: JSON.stringify(data) }); }
  close() {}
};
effects = [];
Panel({ __apiFixtures: {}, initialView: { kind: 'arch' } });
const closeSource = effects.find((fn) => String(fn).includes('new window.EventSource'))();
effects = null;
test.after(() => { closeSource(); globalThis.window = previousWindow; globalThis.fetch = previousFetch; });

function expand(value) {
  if (Array.isArray(value)) return value.flatMap(expand);
  if (value == null || typeof value === 'boolean') return [];
  if (typeof value !== 'object') return [String(value)];
  if (typeof value.type === 'function') return expand(value.type(value.props));
  return [{ type: value.type, props: value.props }, ...expand(value.props?.children)];
}
function render(fixture, event = 'overview') {
  if (event === 'overview') {
    source.emit('overview', { liveFlow: fixture.liveFlow });
    if (fixture.liveFlow) source.emit('flow', { dropped: 0, ...fixture.liveFlow });
  } else if (event) source.emit(event);
  const tree = expand(React.createElement(Panel, { __apiFixtures: { '/api/memory-org/overview?v=0': { data: [fixture], loading: false, error: null } }, initialView: { kind: 'arch' } }));
  return tree.filter((node) => typeof node === 'object' && node.props);
}
function textOf(node) {
  return expand(node.props?.children).filter((item) => typeof item === 'string').join(' ');
}
function snapshotNodes(fixture) {
  return render(fixture).filter((node) => node.props?.['data-dmo'] === 'runtime-snapshot');
}
function nodeByDmo(fixture, key) {
  return render(fixture).find((node) => node.props?.['data-dmo'] === key);
}
function baseFixture(current, historical, report = {}) {
  return { root: 'fixture', initialized: true, counts: {}, results: [], runtimeSnapshot: current,
    cycleCoverage: { status: 'available', at: 'weekly-date', report: { ...report, micro_execution: { runtime_snapshot: historical, ...(report.micro_execution ?? {}) } } } };
}

test('architecture page hides both current and historical runtime snapshots', () => {
  const fixture = baseFixture(
    { state: 'ready', runs: [{ taskId: 'current-task' }] },
    { state: 'partial', runs: [{ taskId: 'weekly-task' }], registeredTasks: { taskIds: ['weekly-registered'] } },
  );
  assert.equal(snapshotNodes(fixture).length, 0);
  const visible = render(fixture).map(textOf).join(' ');
  assert.doesNotMatch(visible, /current-task|weekly-task|weekly-registered|运行时快照/);
  assert.ok(nodeByDmo(fixture, 'cycle-loop-verdict'), 'the loop evidence remains visible');
});

test('loop verdict is derived from real evidence, never from patrol success alone', () => {
  const unknown = nodeByDmo(baseFixture({}, {}, {}), 'cycle-loop-verdict');
  assert.match(textOf(unknown), /闭环未验证.*执行结果.*跨步骤关联/);
  const observed = nodeByDmo(baseFixture({}, {}, {
    micro_execution: { outcome: { status: 'observed' } },
    cross_step_correlation: { status: 'observed' },
  }), 'cycle-loop-verdict');
  assert.match(textOf(observed), /已观察到执行结果与跨步骤关联；完整闭环仍未验证/);
  const incomplete = nodeByDmo(baseFixture({}, {}, {
    micro_execution: { outcome: { status: 'observed' }, schedule_delivery: { status: 'incomplete' } },
    memory: { recall: { status: 'incomplete', observed: true } },
    governance: { decisions: { status: 'unknown' } },
    cross_step_correlation: { status: 'observed' },
  }), 'cycle-loop-verdict');
  assert.doesNotMatch(textOf(incomplete), /闭环证据已观察到/);
  assert.match(textOf(incomplete), /完整闭环仍未验证/);
});

test('architecture keeps a clear unverified loop verdict without repetitive panels', () => {
  const fixture = baseFixture({}, {}, {});
  const nodes = render(fixture);
  const text = nodes.map(textOf).join(' ');
  assert.match(text, /闭环未验证/);
  for (const key of ['arch-graph-evidence', 'arch-loop', 'flow-activity']) {
    assert.equal(nodes.some((node) => node.props['data-dmo'] === key), false);
  }
});
test('refresh status remains unknown until a response is available', () => {
  const { Architecture, buildArchitecture } = instance.__internalsForTest;
  const badge = (props) => expand(React.createElement(Architecture, { model: buildArchitecture({}), ...props }))
    .find((node) => node.props?.['data-dmo'] === 'arch-refresh-badge');
  assert.match(textOf(badge({})), /数据刷新状态未知/);
  assert.doesNotMatch(badge({}).props.className, /\bok\b/);
  assert.match(textOf(badge({ refreshKnown: true })), /数据刷新成功/);
  assert.match(textOf(badge({ refreshKnown: true, refreshLoading: true })), /数据刷新中/);
  assert.match(textOf(badge({ refreshKnown: true, refreshError: true })), /数据刷新失败/);
});

test('a healthy push channel does not hide a missing activity feed', () => {
  const { Architecture, buildArchitecture } = instance.__internalsForTest;
  const badge = (props) => expand(React.createElement(Architecture, { model: buildArchitecture({}), ...props }))
    .find((node) => node.props?.['data-dmo'] === 'arch-flow-feed-badge');
  const live = { live: true, lastEventAt: Date.now() };
  assert.match(textOf(badge({ ...live, flowFeed: 'unavailable' })), /数据流活动不可用/);
  assert.match(badge({ ...live, flowFeed: 'unavailable' }).props.className, /\bwarn\b/);
  // Healthy or not-yet-observed feeds never claim the channel is missing.
  assert.equal(badge({ ...live, flowFeed: 'available' }), undefined);
  assert.equal(badge({ ...live, flowFeed: null }), undefined);
  assert.match(textOf(badge({ ...live, flowFeed: 'available', flowAt: Date.now() - 90000 })), /数据流活动不可用/);
  assert.equal(badge({ ...live, flowFeed: 'available', flowAt: Date.now() }), undefined);
  // Without a working push channel the push badge already explains the outage.
  assert.equal(badge({ live: false, lastEventAt: null, flowFeed: 'unavailable' }), undefined);
});

test('interactive architecture nodes support keyboard activation', () => {
  const node = nodeByDmo(baseFixture({}, {}, {}), 'arch-node-functions');
  assert.equal(node.props.role, 'button');
  assert.equal(typeof node.props.onKeyDown, 'function');
  let prevented = false;
  node.props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('skill count is shown as its own fact, not folded into the capability node', () => {
  const fixture = baseFixture({}, {}, {});
  fixture.counts = { capabilities: 17, skills: 15 };
  const skillNode = nodeByDmo(fixture, 'skill-count');
  assert.ok(skillNode);
  assert.match(textOf(skillNode), /技能包 15 个/);
  const capText = render(fixture).filter((n) => n.props?.['data-dmo'] === 'arch-node-capabilities').map(textOf).join(' ');
  assert.doesNotMatch(capText, /技能库 15/);
});

test('flow events are mapped by exact edge and never by SAG availability', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  fixture.sag = { online: false, authorized: false };
  fixture.liveFlow = { dropped: 3, edges: {
    e2: { phase: 'active', at: now - 100, expiresAt: now + 10000, privateData: 'secret-flow-data' },
    e3: { phase: 'finished', at: now - 100, expiresAt: now + 10000 },
    e4: { phase: 'failed', at: now - 100, expiresAt: now + 10000 },
    e6: { phase: 'active', at: now - 200, expiresAt: now - 1 },
    e7: { phase: 'active', at: now - 100 },
    e15: { phase: 'active', at: now - 100, expiresAt: now + 10000 },
    e20: { phase: 'failed', at: now - 100, expiresAt: now + 10000 },
  } };
  for (const [key, phase] of Object.entries({ e2: 'active', e3: 'finished', e4: 'failed', e6: 'unknown', e7: 'unknown', e14: 'unknown', e15: 'active' })) {
    assert.match(nodeByDmo(fixture, `flow-edge-${key}`).props.className, new RegExp(`flow-${phase}\\b`));
  }
  const current = textOf(nodeByDmo(fixture, 'flow-current'));
  assert.match(current, /每日线索 → 功能域：调用进行中/);
  assert.match(current, /功能域 → 思想：调用结束，结果待核验/);
  assert.match(current, /思想 → 道：调用失败/);
  assert.ok(current.includes('SAG 搜索调用（结果返回会话）：调用进行中'));
  assert.doesNotMatch(current, /事件时间|过期时间|未知|secret-flow-data/);
  assert.match(nodeByDmo(fixture, 'flow-edge-e3').props.className, /warn/);
  assert.match(textOf(nodeByDmo(fixture, 'arch-node-sag')), /不可达/);
  assert.equal(nodeByDmo(fixture, 'flow-current').props['aria-live'], 'polite');
  assert.equal(render(fixture).some((n) => n.props['data-dmo'] === 'flow-activity'), false);
  fixture.liveFlow.edges.e15.expiresAt = now - 1;
  assert.match(nodeByDmo(fixture, 'flow-edge-e15').props.className, /flow-unknown.*muted dashed/);
  assert.doesNotMatch(textOf(nodeByDmo(fixture, 'flow-current')), /SAG 搜索调用/);
  const text = render(fixture).map(textOf).join(' ');
  assert.match(text, /SAG 搜索调用 · 返回方向/);
  assert.match(text, /调用结束，结果待核验/);
  assert.doesNotMatch(text, /secret-flow-data|箭头活动|丢弃事件数/);
});

test('index reads and recall insertion are independent exact edges', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  fixture.liveFlow = { dropped: 0, edges: { e11: { phase: 'active', at: now, expiresAt: now + 10000 } } };
  let nodes = render(fixture);
  const edge = (id) => nodes.find(n => n.props['data-dmo'] === `flow-edge-${id}`).props.className;
  assert.match(edge('e11'), /flow-active/);
  assert.match(edge('e12'), /flow-unknown/);
  fixture.liveFlow.edges = { e12: { phase: 'finished', at: now, expiresAt: now + 10000 } };
  nodes = render(fixture);
  assert.match(edge('e11'), /flow-unknown/);
  assert.match(edge('e12'), /flow-finished/);
  const current = textOf(nodes.find(n => n.props['data-dmo'] === 'flow-current'));
  assert.match(current, /召回消息插入已进入的步骤.*已插入步骤，模型使用情况未知/);
  assert.doesNotMatch(current, /索引读取工具调用/);
  const text = nodes.map(textOf).join(' ');
  assert.match(text, /索引读取调用/);
  assert.match(text, /召回插入步骤/);
});

test('index matching lights only e10 and displays the bounded source', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  fixture.liveFlow = { dropped: 0, edges: { e10: { phase: 'finished', at: now, expiresAt: now + 10000, source: 'cache' } } };
  const nodes = render(fixture);
  const edge = id => nodes.find(n => n.props['data-dmo'] === `flow-edge-${id}`).props.className;
  assert.match(edge('e10'), /flow-finished/);
  assert.match(edge('e11'), /flow-unknown/);
  assert.match(edge('e12'), /flow-unknown/);
  const current = textOf(nodes.find(n => n.props['data-dmo'] === 'flow-current'));
  assert.match(current, /索引匹配.*缓存/);
  assert.doesNotMatch(current, /已插入步骤|模型使用/);
});

test('a batched start and finish renders a recent completed call', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  source.emit('flow', { edges: { e2: { phase: 'active', at: now, expiresAt: now + 10000 } }, dropped: 0 });
  source.emit('flow', { edges: { e2: { phase: 'finished', at: now, expiresAt: now + 10000 } }, dropped: 0 });
  const nodes = render(fixture, null);
  assert.match(nodes.find(n => n.props['data-dmo'] === 'flow-edge-e2').props.className, /flow-finished/);
  assert.match(textOf(nodes.find(n => n.props['data-dmo'] === 'flow-current')), /调用结束，结果待核验/);
});

test('finished edges remain distinct for 30 seconds, including reduced motion', async () => {
  const sourceText = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const now = Date.now();
  const oldNow = Date.now;
  const fixture = baseFixture({}, {}, {});
  try {
    source.emit('flow', { dropped: 0, edges: { e12: { phase: 'finished', at: now, expiresAt: now + 30000 } } });
    Date.now = () => now + 29999;
    const nodes = render(fixture, null);
    const finished = nodes.find(n => n.props['data-dmo'] === 'flow-edge-e12');
    assert.match(finished.props.className, /flow-finished/);
    assert.equal(finished.props.markerEnd, 'url(#dmo-ah-w)');
    assert.match(textOf(nodes.find(n => n.props['data-dmo'] === 'flow-current')), /已插入步骤/);
    Date.now = () => now + 30000;
    assert.match(render(fixture, null).find(n => n.props['data-dmo'] === 'flow-edge-e12').props.className, /flow-unknown/);
    assert.match(sourceText, /\.dmo-edge\.warn\{[^}]*\}\s*\.dmo-edge\.flow-finished\{stroke-dasharray:5 5\}/);
    assert.match(sourceText, /\.dmo-edge\.flow-active\{[^}]*stroke-dasharray:8 6;[^}]*animation:dmo-flow 0\.7s linear infinite/);
    assert.match(sourceText, /\.dmo-edge\.flow-finished\{[^}]*animation:dmo-finished 0\.7s linear 3/);
    assert.match(sourceText, /@keyframes dmo-flow\{to\{stroke-dashoffset:-14\}\}/);
    assert.match(sourceText, /@keyframes dmo-finished\{to\{stroke-dashoffset:-20\}\}/);
    assert.match(sourceText, /@media \(prefers-reduced-motion:reduce\)\{\.dmo-edge\.flow-active,\.dmo-edge\.flow-finished\{animation:none\}\}/);
    assert.match(sourceText, /\.dmo-arch-canvas\{overflow-x:auto\}/);
    assert.match(sourceText, /\.dmo-arch-svg\{[^}]*min-width:720px/);
  } finally { Date.now = oldNow; }
});

test('successive finished observations remount the edge for a new pulse', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  const snapshot = (at) => ({ dropped: 0, edges: { e11: { phase: 'finished', at, expiresAt: now + 10000 } } });
  source.emit('flow', snapshot(now));
  const first = render(fixture, null).find(n => n.props['data-dmo'] === 'flow-edge-e11');
  source.emit('flow', snapshot(now + 1));
  const second = render(fixture, null).find(n => n.props['data-dmo'] === 'flow-edge-e11');
  assert.match(first.props.className, /flow-finished/);
  assert.match(second.props.className, /flow-finished/);
  assert.notEqual(first.props.key, second.props.key);
});

test('capability index observation follows the path to the index and reports only the write', () => {
  const now = Date.now();
  const fixture = baseFixture({}, {}, {});
  fixture.liveFlow = { dropped: 0, edges: { e9: { phase: 'finished', at: now, expiresAt: now + 30000 } } };
  const nodes = render(fixture);
  const edge = nodes.find(n => n.props?.['data-dmo'] === 'flow-edge-e9');
  assert.equal(edge.props.d, 'M840 200 L800 200 L800 294');
  assert.equal(edge.props.markerEnd, 'url(#dmo-ah-w)');
  assert.match(edge.props.className, /flow-finished/);
  assert.match(textOf(nodes.find(n => n.props?.['data-dmo'] === 'flow-current')), /能力索引已写入/);
  assert.match(nodes.find(n => n.props?.['data-dmo'] === 'flow-edge-e2').props.className, /flow-unknown.*muted dashed/);
});

test('expiry schedules a local redraw and cleans up without an incoming event', () => {
  const { Architecture, buildArchitecture } = instance.__internalsForTest;
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const now = Date.now();
  let callback; let delay; let cleared;
  try {
    globalThis.setTimeout = (fn, ms) => { callback = fn; delay = ms; return 42; };
    globalThis.clearTimeout = (id) => { cleared = id; };
    effects = []; stateUpdates = 0;
    Architecture({ model: buildArchitecture({ liveFlow: { edges: { e2: { phase: 'active', at: now - 10, expiresAt: now + 5000 } } } }) });
    const cleanup = effects[0]();
    assert.ok(delay > 0 && delay <= 5001);
    callback();
    assert.equal(stateUpdates, 1);
    cleanup();
    assert.equal(cleared, 42);
  } finally {
    effects = null; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
  }
});

test('disconnected or stale stream cannot reuse an active HTTP snapshot', () => {
  const fixture = baseFixture({}, {}, {});
  const now = Date.now();
  fixture.liveFlow = { edges: { e2: { phase: 'active', at: now, expiresAt: now + 300000 } } };
  const edge = (event) => render(fixture, event).find((node) => node.props?.['data-dmo'] === 'flow-edge-e2');
  assert.match(edge('overview').props.className, /flow-active/);
  assert.match(edge('error').props.className, /flow-unknown/);
  assert.match(edge('overview').props.className, /flow-active/);
  assert.match(edge('snapshot-error').props.className, /flow-active/);
  assert.match(edge('overview').props.className, /flow-active/);
  const oldNow = Date.now;
  const staleAt = oldNow() + 90001;
  try {
    Date.now = () => staleAt;
    assert.match(edge(null).props.className, /flow-unknown/);
  } finally { Date.now = oldNow; }
  assert.match(edge('overview').props.className, /flow-active/);
});
