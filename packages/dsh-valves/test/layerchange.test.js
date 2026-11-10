/**
 * IV-4 层修改机制测试。
 *
 * 两条不能破的纪律：
 * 1. **永不自动生效** —— approve 之外没有任何路径能把提议变成生效。
 * 2. **旧 trace 永不重写** —— 改名只做查询时映射，历史记录原样保留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	proposeLayerChange, reviewLayerChange, activateLayerChange,
	mapLayerName, effectiveLayers,
	LAYER_CHANGE_STATES, LAYER_CHANGE_CODES, DEFAULT_COMPAT_MS,
} from '../src/layerchange.js';

const LAYERS = ['L0', 'L1', 'L2', 'L3'];
const NOW = Date.parse('2026-11-10T00:00:00.000Z');

const propose = (over = {}) => proposeLayerChange({
	layers: LAYERS, from: 'L2', to: '法层', reason: '名字更直观', now: NOW, ...over,
});

// ——————————————————————————————————————————————
// 纪律 1：永不自动生效
// ——————————————————————————————————————————————

test('提议只是登记：state=proposed，不给激活时间', () => {
	const r = propose();
	assert.equal(r.ok, true);
	assert.equal(r.change.state, LAYER_CHANGE_STATES.proposed);
	assert.equal(r.change.activated_at, undefined);
	assert.equal(r.change.compat_until, undefined);
});

test('未批准的提议无法激活（这是"永不自动生效"的执行点）', () => {
	const { change } = propose();
	const out = activateLayerChange(change, { now: NOW });
	assert.equal(out.ok, false);
	assert.equal(out.error, LAYER_CHANGE_CODES.notApproved);
	assert.equal(out.detail.state, 'proposed');
});

test('被拒绝的提议同样无法激活', () => {
	const { change } = propose();
	const reviewed = reviewLayerChange(change, { approved: false, now: NOW }).change;
	assert.equal(reviewed.state, LAYER_CHANGE_STATES.rejected);
	assert.equal(activateLayerChange(reviewed, { now: NOW }).ok, false);
});

test('批准后才能激活，并进入兼容期（有明确截止时间）', () => {
	const { change } = propose();
	const reviewed = reviewLayerChange(change, { approved: true, by: 'boss', now: NOW }).change;
	assert.equal(reviewed.state, LAYER_CHANGE_STATES.approved);
	const active = activateLayerChange(reviewed, { now: NOW }).change;
	assert.equal(active.state, LAYER_CHANGE_STATES.active);
	assert.equal(active.compat_until, new Date(NOW + DEFAULT_COMPAT_MS).toISOString());
});

test('只有 proposed 能进终审（已批准/已激活的不能再审一次）', () => {
	const { change } = propose();
	const reviewed = reviewLayerChange(change, { approved: true, now: NOW }).change;
	const again = reviewLayerChange(reviewed, { approved: false, now: NOW });
	assert.equal(again.ok, false);
	assert.equal(again.error, 'only_proposed_can_be_reviewed');
});

// ——————————————————————————————————————————————
// 提议本身的校验
// ——————————————————————————————————————————————

test('缺理由的提议不接受（没有理由的改名无法复核）', () => {
	assert.equal(proposeLayerChange({ layers: LAYERS, from: 'L2', to: 'X' }).ok, false);
});

test('改不存在的层 → 拒绝并说明', () => {
	const r = propose({ from: 'L9' });
	assert.equal(r.ok, false);
	assert.equal(r.error, LAYER_CHANGE_CODES.unknownOldLayer);
	assert.deepEqual(r.detail.layers, LAYERS);
});

test('新名撞上现有层 → 拒绝（避免两层共名）', () => {
	const r = propose({ to: 'L3' });
	assert.equal(r.ok, false);
	assert.equal(r.error, LAYER_CHANGE_CODES.invalidLayers);
});

test('映射在提议时就冻结（终审看到什么，执行就是什么）', () => {
	const { change } = propose();
	assert.deepEqual(change.mapping, { L2: '法层' });
	// 冻结：后续改动不影响已提议的映射
	const snapshot = JSON.stringify(change.mapping);
	const { change: again } = propose({ to: '另一个名' });
	assert.equal(JSON.stringify(change.mapping), snapshot, '原提议的映射不受后续提议影响');
	assert.deepEqual(again.mapping, { L2: '另一个名' });
});

// ——————————————————————————————————————————————
// 纪律 2：旧 trace 不重写，只做查询映射
// ——————————————————————————————————————————————

test('未激活的修改不产生映射（提议阶段不该影响任何查询）', () => {
	const { change } = propose();
	assert.deepEqual(mapLayerName([change], 'L2'), { name: 'L2', mapped: false });
});

test('激活后旧名映射到新名，并标 mapped:true（让调用方知道这是旧名）', () => {
	const { change } = propose();
	const active = activateLayerChange(reviewLayerChange(change, { approved: true, now: NOW }).change, { now: NOW }).change;
	const m = mapLayerName([active], 'L2', { now: NOW });
	assert.equal(m.name, '法层');
	assert.equal(m.mapped, true);
	assert.equal(m.from, 'L2');
	assert.equal(m.state, LAYER_CHANGE_STATES.active);
});

test('兼容期过后仍能映射（旧数据永远要能读），但状态标 retired', () => {
	const { change } = propose();
	const active = activateLayerChange(reviewLayerChange(change, { approved: true, now: NOW }).change, { now: NOW }).change;
	const later = NOW + DEFAULT_COMPAT_MS + 1000;
	const m = mapLayerName([active], 'L2', { now: later });
	assert.equal(m.name, '法层', '过期后仍要能读到对应关系');
	assert.equal(m.state, LAYER_CHANGE_STATES.retired, '但如实标已退役');
});

test('未涉及的名字原样返回、mapped:false', () => {
	const { change } = propose();
	const active = activateLayerChange(reviewLayerChange(change, { approved: true, now: NOW }).change, { now: NOW }).change;
	assert.deepEqual(mapLayerName([active], 'L1', { now: NOW }), { name: 'L1', mapped: false });
});

// ——————————————————————————————————————————————
// 层表
// ——————————————————————————————————————————————

test('effectiveLayers：只有 active 的修改改变层表', () => {
	const { change } = propose();
	const proposedOnly = effectiveLayers(LAYERS, [change]);
	assert.deepEqual(proposedOnly.layers, LAYERS, '提议阶段层表不变');
	assert.equal(proposedOnly.applied, 0);

	const active = activateLayerChange(reviewLayerChange(change, { approved: true, now: NOW }).change, { now: NOW }).change;
	const after = effectiveLayers(LAYERS, [active]);
	assert.deepEqual(after.layers, ['L0', 'L1', '法层', 'L3']);
	assert.equal(after.applied, 1);
});

test('effectiveLayers：多条 active 依次应用', () => {
	const a1 = activateLayerChange(reviewLayerChange(propose().change, { approved: true, now: NOW }).change, { now: NOW }).change;
	const p2 = propose({ from: 'L3', to: '道层' });
	const a2 = activateLayerChange(reviewLayerChange(p2.change, { approved: true, now: NOW }).change, { now: NOW }).change;
	const out = effectiveLayers(LAYERS, [a1, a2]);
	assert.deepEqual(out.layers, ['L0', 'L1', '法层', '道层']);
	assert.equal(out.applied, 2);
});
