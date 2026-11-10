import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_ERROR_CODES } from '../src/capture-status.js';

// Render the real MemoryPanel and children with the existing fixture/hook seam.
// No effects run and every fetch is rejected; no host, network or memory root.
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useEffect() {},
  useRef(value) { return { current: value }; },
};
let moduleDefinition;
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
globalThis.window = { __ModuleLoader__: { load(value) { moduleDefinition = value; } } };
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
await import('../client.js');
const instance = moduleDefinition.factory((name) => name === 'react' ? React : undefined);
let Panel;
instance.apply({ slots: { inject(_slot, fn) { fn(); }, register(options, component) { if (options.name === 'main') Panel = component; } } });
assert.equal(typeof Panel, 'function');

test.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; });

function expand(value) {
  if (Array.isArray(value)) return value.flatMap(expand);
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (typeof value !== 'object') return [String(value)];
  if (typeof value.type === 'function') return expand(value.type(value.props));
  return [{ type: value.type, props: value.props }, ...expand(value.props?.children)];
}
function render(status, override = {}) {
  const fixture = { root: 'fixture', initialized: true, counts: {}, results: [], ...(status === undefined ? {} : { capture: status }) };
  const overview = override.overview ?? { data: [fixture], loading: false, error: null };
  const tree = expand(React.createElement(Panel, { __apiFixtures: { '/api/memory-org/overview?v=0': overview }, initialView: { kind: 'overview' } }));
  const index = tree.findIndex((n) => typeof n === 'object' && n.props?.['data-dmo'] === 'capture-status');
  assert.notEqual(index, -1, 'actual overview must render the capture status region');
  const region = tree[index];
  assert.equal(region.props.role, 'status');
  assert.equal(region.props['aria-label'], '每日采集状态');
  const text = expand(region.props.children).filter((item) => typeof item === 'string').join(' ');
  return { text, tree };
}
const base = {
  enabled: true, createdAt: 123456, hasObservations: false, resetOnNewInstance: true, saturated: false,
  observed: 0, selected: 0, scheduled: 0, confirmed: 0, duplicate: 0, failed: 0, conflict: 0, pending: 0,
  skippedSource: 0, skippedMissingId: 0, skippedCapacity: 0, intentWitness: 'not_seen',
  errorCodes: Object.fromEntries(CAPTURE_ERROR_CODES.map((code) => [code, 0])),
  errorStages: { source: 0, select: 0, schedule: 0, lock: 0, read: 0, dedupe: 0, stage: 0, commit: 0, ledger: 0, cleanup: 0, OTHER: 0 },
};

test('旧服务没有采集字段时显示未知，不当作正常', () => {
  const { text } = render(undefined);
  assert.match(text, /采集：未知/);
  assert.match(text, /观测状态未知/);
  assert.match(text, /尝试 未知 · 确认 未知 · 失败 未知 · 待处理 未知/);
  assert.doesNotMatch(text, /采集正常|一切正常|健康/);
});

test('未启用并无样本，明确重载重置口径', () => {
  const { text } = render({ ...base, enabled: false });
  assert.match(text, /采集：未启用/);
  assert.match(text, /尚无观测样本，无法判断采集是否正常/);
  assert.match(text, /当前实例.*重新加载.*计数清零/);
});

test('已启用不等于健康：没有样本时仍不能判断正常', () => {
  const { text } = render(base);
  assert.match(text, /采集：已启用/);
  assert.match(text, /尚无观测样本，无法判断采集是否正常/);
  assert.doesNotMatch(text, /采集正常|一切正常|健康/);
});

test('有失败、冲突和待处理时展示真实计数及安全类别', () => {
  const snapshot = { ...base, hasObservations: true, observed: 9, selected: 7, scheduled: 6, confirmed: 2, failed: 2, conflict: 1, pending: 1, duplicate: 1,
    skippedSource: 1, skippedMissingId: 1, errorCodes: { ...base.errorCodes, MEMORY_LEDGER_APPEND_FAILED: 2, MEMORY_CAPTURE_LOCK_BUSY: 1, CAPTURE_BASELINE_UNVERIFIED: 1 },
    errorStages: { ...base.errorStages, ledger: 2, lock: 1 } };
  const { text } = render(snapshot);
  assert.match(text, /已观察 9 条事件/);
  assert.match(text, /尝试 6 · 确认 2 · 失败 2 · 待处理 1/);
  assert.match(text, /已选择 7 · 重复 1 · 冲突 1/);
  assert.match(text, /来源跳过 1 · 缺少标识跳过 1 · 统计容量溢出 0/);
  assert.match(text, /记账结果未知 2/);
  assert.match(text, /采集锁占用 1/);
  assert.match(text, /原记录无法对账 1/);
  assert.match(text, /发生阶段：互斥 1 · 记账 2/);
  assert.doesNotMatch(text, /MEMORY_LEDGER_APPEND_FAILED|健康/);
});

test('持久意图现场分别显示存在、未见和未知', () => {
  assert.match(render({ ...base, intentWitness: 'present' }).text, /发现未完成的采集意图.*停写/);
  assert.match(render(base).text, /当前未发现采集意图文件.*不能证明历史/);
  assert.match(render({ ...base, intentWitness: 'unexpected' }).text, /采集意图现场状态未知/);
});

test('计数饱和或容量跳过都提示观察容量不足', () => {
  assert.match(render({ ...base, saturated: true }).text, /观察容量不足.*统计不完整/);
  assert.match(render({ ...base, skippedCapacity: 4 }).text, /观察容量不足.*统计不完整/);
});

test('异常和矛盾值显示未知，不输出路径、ID 或任意错误标签', () => {
  const poisoned = { ...base, enabled: 'true', hasObservations: false, observed: 3, resetOnNewInstance: 'yes', saturated: null,
    selected: -1, scheduled: '5', confirmed: NaN, failed: Infinity, pending: {}, skippedCapacity: -1,
    errorCodes: { ...base.errorCodes, 'C:/private/secret': 6 }, errorStages: { ...base.errorStages, 'internal-event-id': 1 } };
  const { text } = render(poisoned);
  assert.match(text, /采集：未知/);
  assert.match(text, /观测状态未知/);
  assert.match(text, /尝试 未知 · 确认 未知 · 失败 未知 · 待处理 未知/);
  assert.match(text, /观察容量状态未知/);
  assert.match(text, /失败类别：未知；发生阶段：未知/);
  assert.match(text, /实例范围或重载后的状态未知/);
  assert.doesNotMatch(text, /C:\/private|internal-event-id|NaN|Infinity|\[object Object\]/);
});

test('总览 API 出错时采集状态仍显示未知，错误正文不被回显', () => {
  const { text, tree } = render(undefined, { overview: { data: null, loading: false, error: 'C:/private/token: event-123' } });
  assert.match(text, /采集：未知/);
  assert.match(text, /观测状态未知/);
  assert.ok(tree.includes('总览 API 不可用。'));
  assert.ok(!tree.some((item) => typeof item === 'string' && /C:\/private|event-123/.test(item)));
});
