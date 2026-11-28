import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('panel instances own their streams and cleanup independently', async (t) => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const sources = []; let mod, current;
  t.after(() => { for (const panel of panels) for (const hook of panel.hooks) hook?.cleanup?.(); globalThis.window = oldWindow; globalThis.fetch = oldFetch; });
  class Source {
    constructor() { this.handlers = {}; this.closed = false; sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    emit(name, data = {}) { this.handlers[name]?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  globalThis.window = { EventSource: Source, __ModuleLoader__: { load(value) { mod = value; } } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(init) { const panel = current, i = panel.cursor++; if (!(i in panel.hooks)) panel.hooks[i] = typeof init === 'function' ? init() : init; return [panel.hooks[i], value => { panel.hooks[i] = typeof value === 'function' ? value(panel.hooks[i]) : value; }]; },
    useRef(init) { const panel = current, i = panel.cursor++; return panel.hooks[i] ??= { current: init }; },
    useEffect(fn, deps) { const panel = current, i = panel.cursor++, prev = panel.hooks[i]; if (!prev || deps.some((v, n) => v !== prev.deps[n])) { prev?.cleanup?.(); panel.hooks[i] = { deps }; panel.effects.push(() => { panel.hooks[i].cleanup = fn(); }); } },
  };
  const panels = [{ hooks: [], effects: [] }, { hooks: [], effects: [] }];
  await import(new URL(`../client.js?instances=${Math.random()}`, import.meta.url));
  let Panel; mod.factory(() => React).apply({ slots: { inject(_s, f) { f(); }, register(o, c) { if (o.name === 'main') Panel = c; } } });
  const fixture = { data: [{ initialized: true, counts: {}, results: [] }], loading: false };
  const fixtures = new Proxy({}, { getOwnPropertyDescriptor(_target, key) { return String(key).startsWith('/api/memory-org/overview?') ? { configurable: true, enumerable: true } : undefined; }, get(_target, key) { return String(key).startsWith('/api/memory-org/overview?') ? fixture : undefined; } });
  const props = { initialView: { kind: 'arch' }, __apiFixtures: fixtures };
  function find(node) { if (Array.isArray(node)) return node.map(find).find(Boolean); if (!node || typeof node !== 'object') return null; return node.type?.name === 'Architecture' ? node : find(node.props?.children); }
  function render(panel) { current = panel; panel.cursor = 0; const tree = Panel(props); while (panel.effects.length) panel.effects.shift()(); return find(tree); }
  render(panels[0]); render(panels[1]);
  sources[0].emit('overview', {});
  assert.equal(render(panels[0]).props.live, true);
  assert.equal(render(panels[1]).props.live, false);
  sources[1].emit('overview', {});
  for (const hook of panels[0].hooks) hook?.cleanup?.();
  assert.equal(sources[0].closed, true);
  assert.equal(sources[1].closed, false);
  assert.equal(render(panels[1]).props.live, true);
  sources[0].emit('error');
  assert.equal(render(panels[1]).props.live, true);
});

test('stream emits visible heartbeats, serializes samples, and recovers after failure', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function streamPanel('), source.indexOf('const PANEL_WRITE_SEGS', source.indexOf('function streamPanel(')));
  let now = 1000, fail = false, pending = null, calls = 0;
  const intervals = [];
  const writes = [];
  const response = { writeHead() {}, write(value) { writes.push(value); }, on() {}, end() {} };
  const ctx = { Date: { now: () => now }, JSON, String,
    overviewPayload: async () => { calls++; if (pending) await pending; if (fail) throw Error('failed'); return { counts: { daily: 1 }, edgeStatus: { status: 'available', at: now, runningGraphCount: 1 } }; },
    setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; intervals.push(timer); return timer; }, clearInterval() {} };
  vm.runInNewContext(`${code}\nthis.start = streamPanel`, ctx);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  ctx.start(response, '', {}); await flush();
  assert.ok(writes.some(value => /^event: overview\n/.test(value)));
  const tick = intervals.find(x => x.ms === 2000).fn;
  const beat = intervals.find(x => x.ms === 20000).fn;
  for (let i = 0; i < 6; i++) { now += 20000; await tick(); beat(); }
  assert.equal(writes.filter(x => x.startsWith('event: overview\n')).length, 1, 'sampling timestamps alone do not trigger refresh');
  assert.equal(writes.filter(x => x.startsWith('event: heartbeat\n')).length, 6);
  assert.ok(writes.filter(x => x.startsWith('event: heartbeat\n')).every(x => x.includes('"snapshotFresh":true')));
  let release; pending = new Promise(resolve => { release = resolve; });
  const before = calls; const running = tick(); await tick(); assert.equal(calls, before + 1);
  now += 100000; beat(); assert.match(writes.at(-1), /"snapshotFresh":false/);
  release(); await running; pending = null;
  fail = true; await tick(); assert.match(writes.at(-1), /^event: snapshot-error\n/);
  fail = false; await tick(); assert.match(writes.at(-1), /^event: overview\n/);
});

test('panel handles idle heartbeats, delayed and failed HTTP, disconnect, and recovery', async (t) => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch, oldNow = Date.now;
  let now = 1000, mod, es, cursor = 0, hooks = [], effects = [], dirty = false;
  let hold = null, fail = false, daily = 1, runningEdges = 1, fetches = 0;
  class Source { constructor() { this.handlers = {}; es = this; } addEventListener(name, fn) { this.handlers[name] = fn; } emit(name, data = {}) { this.handlers[name]?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); } close() {} }
  globalThis.window = { EventSource: Source, __ModuleLoader__: { load(x) { mod = x; } } };
  Date.now = () => now;
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); globalThis.window = oldWindow; globalThis.fetch = oldFetch; Date.now = oldNow; });
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; dirty = true; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useEffect(fn, deps) { const i = cursor++; const prev = hooks[i]; if (!prev || deps.some((v, n) => v !== prev.deps[n])) { prev?.cleanup?.(); hooks[i] = { deps }; effects.push(() => { hooks[i].cleanup = fn(); }); } },
  };
  globalThis.fetch = async (url) => {
    fetches++;
    if (url.includes('/overview?')) {
      const capturedDaily = daily, capturedEdges = runningEdges;
      if (hold) await hold;
      if (fail) throw Error('offline');
      return { ok: true, json: async () => [{ initialized: true, failCount: 0, warnCount: 0, counts: { daily: capturedDaily }, results: [], edgeStatus: { status: 'available', runningGraphCount: capturedEdges, graphEdgeCount: 20 } }] };
    }
    return { ok: true, json: async () => url.includes('/list?') ? { files: [] } : url.includes('/file?') ? { text: '' } : {} };
  };
  await import(new URL(`../client.js?freshness=${Math.random()}`, import.meta.url));
  const instance = mod.factory(() => React); let Panel;
  instance.apply({ slots: { inject(_s, f) { f(); }, register(o, c) { if (o.name === 'main') Panel = c; } } });
  const props = { initialView: { kind: 'arch' } };
  async function render() { let tree; for (let i = 0; i < 25; i++) { cursor = 0; dirty = false; tree = Panel(props); while (effects.length) effects.shift()(); for (let j = 0; j < 12; j++) await Promise.resolve(); if (!dirty) return tree; } throw Error('render did not settle'); }
  function find(node, name) { if (Array.isArray(node)) return node.map(x => find(x, name)).find(Boolean); if (!node || typeof node !== 'object') return null; return typeof node.type === 'function' && node.type.name === name ? node : find(node.props?.children, name); }
  let tree = await render();
  es.emit('overview', { counts: { daily: 1 } }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.live, true);
  for (let i = 0; i < 6; i++) { now += 20000; es.emit('heartbeat', { snapshotFresh: true }); }
  tree = await render(); assert.equal(find(tree, 'Architecture').props.live, true, 'heartbeats remain live after 120 seconds');
  let release; hold = new Promise(resolve => { release = resolve; }); daily = 2;
  es.emit('overview', { counts: { daily: 2 } }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.refreshLoading, true);
  assert.equal(find(tree, 'Architecture').props.model.layers[0].count, 1);
  assert.equal(find(tree, 'Architecture').props.model.graphSummary.running, 1);
  const active = { edges: { e2: { phase: 'active', at: now, expiresAt: now + 10000 } }, dropped: 0 };
  const finished = { edges: { e2: { phase: 'finished', at: now + 1, expiresAt: now + 10000 } }, dropped: 2 };
  const beforeFlow = fetches;
  es.emit('flow', active); tree = await render();
  assert.equal(fetches, beforeFlow, 'flow redraw does not refetch panel data');
  assert.equal(find(tree, 'Architecture').props.model.liveFlow.edges.e2.phase, 'active');
  es.emit('flow', finished); tree = await render();
  assert.deepEqual(find(tree, 'Architecture').props.model.liveFlow, finished);
  es.emit('overview', { liveFlow: active }); tree = await render();
  assert.deepEqual(find(tree, 'Architecture').props.model.liveFlow, finished, 'an older overview cannot replace flow');
  release(); hold = null; for (let i = 0; i < 12; i++) await Promise.resolve(); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.layers[0].count, 2);
  runningEdges = 5; es.emit('overview', { counts: { daily: 2 } }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.graphSummary.running, 5);
  hold = new Promise(resolve => { release = resolve; }); daily = 3;
  es.emit('overview', { counts: { daily: 3 } }); await render();
  hold = null; daily = 4; es.emit('overview', { counts: { daily: 4 } }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.layers[0].count, 4);
  release(); for (let i = 0; i < 12; i++) await Promise.resolve(); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.layers[0].count, 4, 'aborted older response cannot overwrite newer data');
  fail = true; es.emit('overview', { counts: { daily: 3 } }); tree = await render();
  assert.ok(!find(tree, 'Architecture')); assert.ok(JSON.stringify(tree).includes('数据刷新失败'));
  fail = false; es.emit('overview', { counts: { daily: 2 } }); await render();
  es.emit('error'); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false);
  es.emit('heartbeat', { snapshotFresh: true }); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false);
  es.emit('overview', { counts: { daily: 2 } }); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, true);
  es.emit('flow', active); es.emit('snapshot-error'); tree = await render();
  assert.equal(find(tree, 'Architecture').props.live, false);
  assert.equal(find(tree, 'Architecture').props.model.liveFlow.edges.e2.phase, 'active');
  es.emit('heartbeat', { snapshotFresh: true }); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false);
  es.emit('overview', { counts: { daily: 2 } }); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, true, 'identical overview recovers snapshot health');
  now += 90001; es.emit('heartbeat', { snapshotFresh: true }); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false, 'an old snapshot is not revived by heartbeat');
  es.emit('overview', { counts: { daily: 2 } }); await render();
  es.emit('heartbeat', 'null'); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false);
  es.emit('overview', 'null'); tree = await render(); assert.equal(find(tree, 'Architecture').props.live, false);
  es.emit('flow', active); tree = await render(); assert.equal(find(tree, 'Architecture').props.model.liveFlow.edges.e2.phase, 'active');
  es.emit('flow', { edges: [], dropped: 0 }); tree = await render(); assert.equal(find(tree, 'Architecture').props.model.liveFlow, undefined);
  es.emit('flow', active); es.emit('flow-status', { available: false, fallback: 'snapshot' }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.liveFlow, undefined);
  assert.equal(find(tree, 'Architecture').props.flowFeed, 'unavailable');
  es.emit('overview', { counts: { daily: 2 } }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.live, true);
  assert.equal(find(tree, 'Architecture').props.flowFeed, 'unavailable', 'overview health does not imply an activity subscription');
  es.emit('flow-status', { available: true }); tree = await render();
  assert.equal(find(tree, 'Architecture').props.flowFeed, 'available');
  es.emit('flow', active); es.emit('error'); tree = await render(); assert.equal(find(tree, 'Architecture').props.model.liveFlow, undefined);
  es.emit('overview', { liveFlow: active }); tree = await render(); assert.equal(find(tree, 'Architecture').props.model.liveFlow, undefined);
  es.emit('flow', finished); tree = await render(); assert.deepEqual(find(tree, 'Architecture').props.model.liveFlow, finished);
  // Heartbeats keep overview fresh but must not extend the 120s flow window.
  for (let i = 0; i < 7; i++) { now += 20000; es.emit('heartbeat', { snapshotFresh: true }); }
  tree = await render();
  assert.equal(find(tree, 'Architecture').props.live, true, 'overview heartbeats remain fresh');
  assert.equal(find(tree, 'Architecture').props.model.liveFlow, undefined, 'overview heartbeats cannot refresh an old flow snapshot');
  es.emit('flow', active); tree = await render();
  assert.equal(find(tree, 'Architecture').props.model.liveFlow.edges.e2.phase, 'active', 'a new flow event restores the snapshot');
});
