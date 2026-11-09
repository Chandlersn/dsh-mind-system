/**
 * clis-bridge 测试 —— II-5 提名/裁决成对 + 幂等游标；II-3 只数可数的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClisHistory, consumeClisHistory, criterionEvidenceFromInsights, CAUSAL_TYPES } from '../src/clis-bridge.js';

const hist = (records) => ({ version: 1, records });
const entry = (over = {}) => ({ causal_type: 'cyclic', signal_type: 'ineffective', achieved: false, baseline: true, at: '2026-11-01T00:00:00Z', ...over });

test('消费：契约内类型 accepted、离契约 rejected 并计数（不重判因果）', () => {
	const r = consumeClisHistory(hist({
		f1: { entries: [entry()] },
		f2: { entries: [entry({ causal_type: 'made_up' })] },
	}));
	assert.equal(r.nominations.length, 2);
	assert.equal(r.nominations[0].verdict, 'accepted');
	assert.equal(r.nominations[1].verdict, 'rejected');
	assert.equal(r.nominations[1].reason, 'off_contract_type');
	assert.equal(r.stats.off_contract, 1);
	assert.ok(r.nominations[0].evidence[0].includes('f1'), '证据必须可回查 fingerprint');
});

test('消费：baseline/achieved/ineffective 口径分开；type_misjudged 单独成线索', () => {
	const r = consumeClisHistory(hist({
		f1: { entries: [
			entry(),
			entry({ baseline: false, at: '2026-11-02T00:00:00Z' }),
			entry({ baseline: false, signal_type: 'type_misjudged', at: '2026-11-03T00:00:00Z', detail: '第三次调价仍反弹' }),
			entry({ baseline: false, achieved: true, at: '2026-11-04T00:00:00Z' }),
		] },
	}));
	assert.equal(r.stats.entries, 4);
	assert.equal(r.stats.baseline, 1);
	assert.equal(r.stats.achieved, 1);
	assert.equal(r.stats.ineffective, 2, '只计 signal_type=ineffective 且非 baseline；misjudged 另列线索不混入');
	assert.equal(r.misjudged.length, 1);
	assert.equal(r.misjudged[0].detail, '第三次调价仍反弹');
});

test('消费：读失败返回 error 而不是空统计假装有数据', () => {
	const r = consumeClisHistory(undefined);
	assert.equal(r.error, 'history_unreadable');
	assert.equal(r.stats.entries, 0);
});

test('readClisHistory：ENOENT 空表 / 坏 JSON undefined / 形状坏 undefined', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-clisb-'));
	try {
		assert.deepEqual((await readClisHistory(dir)).records, {});
		writeFileSync(join(dir, 'clis-history.json'), '{broken', 'utf8');
		assert.equal(await readClisHistory(dir), undefined);
		writeFileSync(join(dir, 'clis-history.json'), JSON.stringify({ version: 1, records: null }), 'utf8');
		assert.equal(await readClisHistory(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime.clisTrace：首跑全量落账、二跑幂等（账本当游标）', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-clisb-'));
	try {
		writeFileSync(join(dir, 'clis-history.json'), JSON.stringify(hist({
			f1: { entries: [entry(), entry({ at: '2026-11-02T00:00:00Z', baseline: false })] },
		})), 'utf8');
		const rt = createRuntime({ storageDir: dir });
		const r1 = await rt.clisTrace();
		assert.equal(r1.newly_recorded, 2);
		await new Promise((r) => setTimeout(r, 50));
		const r2 = await rt.clisTrace();
		assert.equal(r2.newly_recorded, 0, '第二跑不得重复落账');
		const m = await rt.metrics();
		assert.equal(m.byGate.clis_nomination, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const insightText = (sources, superseded = false) => `${superseded ? '> ⚠️ 已被取代 → x\n' : ''}# 主题

## 核心原则

- 判据只认外部事实。

> 来源：${sources.map((s) => `[functions/${s}.md](../functions/${s}.md)`).join('、')}
`;

test('criterion 证据：来源去重计数、取代原则跳过、数不出的字段留空', () => {
	const out = criterionEvidenceFromInsights([
		{ theme: 'a', text: insightText(['x', 'y', 'x']) },
		{ theme: 'old', text: insightText(['x'], true) },
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].skill_coverage, 2, '重复来源去重');
	assert.equal(out[0].anti_example_count, undefined, '磁盘数不出反例数——留空');
	assert.equal(out[0].verifiable_by, undefined, '不编造检验方式');
	assert.equal(out[0].statement, '判据只认外部事实。');
});

test('criterion 真实形状过五门：覆盖不足 reject；≥2 源但不可检验 downgrade（J1 先于量化门）', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-clisb-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		const [c] = criterionEvidenceFromInsights([{ theme: 'a', text: insightText(['x', 'y']) }]);
		const d = rt.upward('L2', 'L1', c);
		// J1 在量化门之前：无可检验路径先 downgrade（证据都不成立，量覆盖没意义）
		assert.equal(d.action, 'downgrade');
		assert.equal(d.reason, 'not_externally_verifiable');
		// 补上可检验路径后，2 源 < criterionMinSkills(3)：如实拒，缺口可见
		const d2 = rt.upward('L2', 'L1', { ...c, verifiable_by: '新场景对照' });
		assert.equal(d2.action, 'reject');
		assert.equal(d2.reason, 'insufficient_skill_coverage');
		// 3 源 + 可检验但缺反例：downgrade 而非假 accept
		const [c3] = criterionEvidenceFromInsights([{ theme: 'b', text: insightText(['x', 'y', 'z']) }]);
		const d3 = rt.upward('L2', 'L1', { ...c3, verifiable_by: '新场景对照' });
		assert.equal(d3.action, 'downgrade');
		assert.equal(d3.reason, 'insufficient_anti_examples');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('CAUSAL_TYPES 与契约镜像一致（四确定 + unknown）', () => {
	assert.deepEqual(CAUSAL_TYPES, ['structural_duality', 'cyclic', 'unidirectional', 'nested', 'unknown']);
});

// —— 「## 阀门证据」节读回（II-3 收口）——

import { parseValveEvidenceSection } from '../src/clis-bridge.js';

const withSection = (base, section) => `${base}\n## 阀门证据\n\n${section}\n`;

test('证据节解析：三行形态读回；坏量化行不猜数字；无节返回 undefined', () => {
	const base = insightText(['x', 'y', 'z']);
	assert.equal(parseValveEvidenceSection(base), undefined);
	const full = withSection(base, [
		'- 可检验路径：本地过、远端拒即证伪',
		'- 量化：{"skill_coverage":3,"anti_example_count":2,"predict_rate":0.8}',
		'- 证据：functions/x.md 2026-11-09 实证',
	].join('\n'));
	const ve = parseValveEvidenceSection(full);
	assert.equal(ve.verifiable_by, '本地过、远端拒即证伪');
	assert.equal(ve.anti_example_count, 2);
	assert.equal(ve.predict_rate, 0.8);
	assert.deepEqual(ve.evidence, ['functions/x.md 2026-11-09 实证']);
	// 坏 JSON：量化字段缺席但其余仍读回（不猜数字）
	const bad = withSection(base, '- 可检验路径：重放\n- 量化：{broken\n');
	const veBad = parseValveEvidenceSection(bad);
	assert.equal(veBad.verifiable_by, '重放');
	assert.equal(veBad.skill_coverage, undefined);
	// 白名单外的键不得混入
	const evil = withSection(base, '- 量化：{"made_up":1,"skill_coverage":4}');
	assert.equal(parseValveEvidenceSection(evil).made_up, undefined);
	assert.equal(parseValveEvidenceSection(evil).skill_coverage, 4);
});

test('证据节改变五门结果：补证后从 downgrade 变 human_gate（II-3 闭环）', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-clisb-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		const base = insightText(['x', 'y', 'z']);
		// 无节：J1 downgrade
		const [before] = criterionEvidenceFromInsights([{ theme: 'a', text: base }]);
		assert.equal(rt.upward('L2', 'L1', before).reason, 'not_externally_verifiable');
		// 有节但缺反例与预测率：过 J1 后 downgrade 在量化门
		const partial = withSection(base, '- 可检验路径：新场景对照重放');
		const [mid] = criterionEvidenceFromInsights([{ theme: 'a', text: partial }]);
		assert.equal(mid.verifiable_by, '新场景对照重放');
		assert.equal(rt.upward('L2', 'L1', mid).reason, 'insufficient_anti_examples');
		// 全证据：human_gate（不自动生效）
		const full = withSection(base, [
			'- 可检验路径：新场景对照重放',
			'- 量化：{"anti_example_count":1,"predict_rate":0.7}',
			'- 证据：反例 R1 可重放',
		].join('\n'));
		const [after] = criterionEvidenceFromInsights([{ theme: 'a', text: full }]);
		const d = rt.upward('L2', 'L1', after);
		assert.equal(d.action, 'human_gate');
		assert.equal(d.reason, 'criterion_thresholds_met');
		assert.ok(after.evidence.includes('反例 R1 可重放'), '证据引用并入');
		assert.ok(after.evidence.includes('functions/x.md'), '回链保留');
		// 生效侧不动：human_gate 不写任何库
		assert.deepEqual(await rt.negativeRules(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('证据节截断边界：下一节的证据引用与量化行不混入（首行锚救不了列表行）', () => {
	const base = insightText(['x']);
	const text = `${base}\n## 阀门证据\n\n- 可检验路径：真路径\n- 量化：{"anti_example_count":1}\n\n## 待观察\n\n- 证据：别节的引用混入\n- 量化：{"anti_example_count":99}\n`;
	const ve = parseValveEvidenceSection(text);
	assert.equal(ve.verifiable_by, '真路径');
	// 列表行是 multiline 锚：不截断时下一节的「- 证据」会进数组、
	// 下一节的「- 量化」首行锚仍取本节但证据数组已污染——两侧都断言。
	assert.equal(ve.evidence, undefined, '下一节的证据引用不得混入（本节无证据行→字段缺席）');
	assert.equal(ve.anti_example_count, 1, '量化取本节首行，不被后节覆盖');
});