/**
 * 自动提名器测试 —— 判据两侧 + 诚实边界（不编成功率、泛化签名标记、读失败≠空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nominateForbidden, nominateSkills, nominateFromDisk, isDegradedSignature } from '../src/nominate.js';
import { summarizeDecisions } from '../src/store.js';
import { mergeThresholds } from '../src/thresholds.js';

const hint = (sig, t = '2026-11-01T00:00:00Z', tool = 'pwsh') => ({ t, kind: 'hinted', signature: sig, tool, agent: 'a1' });

test('负向：同签名 ≥2 提名、1 次不提名；skipped 行不计', () => {
	const rows = [
		hint('pwsh:ConvertFrom-Json bad'), hint('pwsh:ConvertFrom-Json bad', '2026-11-02T00:00:00Z'),
		hint('write:file stale'),
		{ t: '2026-11-01T00:00:00Z', kind: 'skipped', signature: 'pwsh:ConvertFrom-Json bad' },
	];
	const out = nominateForbidden(rows);
	assert.equal(out.length, 1);
	assert.equal(out[0].failure_count, 2);
	assert.equal(out[0].negative_type, 'forbidden_skill');
	assert.equal(out[0].origin, 'nomination');
	assert.ok(out[0].verifiable_by, '必须带可检验路径');
});

test('负向：泛化签名如实标 degraded_signature（签名塌缩教训）', () => {
	assert.equal(isDegradedSignature('pwsh:exit code #'), true);
	assert.equal(isDegradedSignature('pwsh:ConvertFrom-Json bad'), false);
	const out = nominateForbidden([hint('pwsh:exit code #'), hint('pwsh:exit code #')]);
	assert.equal(out[0].degraded_signature, true);
	assert.ok(out[0].warning.includes('假重复'));
});

test('负向：窗口过滤、已生效 id 幂等、阈值覆盖传导', () => {
	const rows = [hint('sig-x', '2020-01-01T00:00:00Z'), hint('sig-x', '2020-01-02T00:00:00Z')];
	assert.equal(nominateForbidden(rows, { windowDays: 1 }).length, 0, '窗口外的失败不算');
	const first = nominateForbidden(rows);
	assert.equal(nominateForbidden(rows, { existingRuleIds: [first[0].candidate_id] }).length, 0, '已生效不重复提名');
	const t = mergeThresholds({ forbiddenMinFailures: 3 });
	assert.equal(nominateForbidden(rows, { thresholds: t }).length, 0, '阈值提到 3 后 2 次不够');
});

test('负向：确定性排序（可重复运行同结果）', () => {
	const rows = [hint('b-sig'), hint('b-sig'), hint('a-sig'), hint('a-sig'), hint('a-sig')];
	const r1 = nominateForbidden(rows).map((c) => c.candidate_id);
	const r2 = nominateForbidden([...rows].reverse()).map((c) => c.candidate_id);
	assert.deepEqual(r1, r2);
});

const usage = (href, uses, positives, badRate = 0) => ({ href, uses, positives, badRate });

test('正向：只提名 functions/、阈值三侧、不编造成功率', () => {
	const items = [
		usage('functions/hot.md', 6, 1),        // 达标
		usage('functions/cold.md', 4, 1),       // uses 不够
		usage('functions/unconfirmed.md', 9, 0),// 无确认
		usage('functions/corrected.md', 9, 1, 0.25), // 纠正率高
		usage('insights/principle.md', 9, 2),   // 法层不提名（那是法/道原料）
	];
	const out = nominateSkills(items);
	assert.equal(out.length, 1);
	assert.equal(out[0].rule_type, 'skill');
	assert.equal(out[0].repeats, 6);
	assert.equal(out[0].success_rate, undefined, '不得编造成功率');
	assert.equal(out[0].needs_external_evidence, true);
	assert.equal(out[0].success_evidence, 'self_report', '如实声明证据级别——valve_check 会拒，这正是设计');
});

test('正向候选过 valve_check：如实被拒（malformed），不是假 accept', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-nom-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		const [c] = nominateSkills([usage('functions/hot.md', 6, 1)]);
		const d = rt.upward('L3', 'L2', c);
		assert.equal(d.action, 'reject');
		assert.equal(d.reason, 'malformed_skill_evidence', '缺外部成功率证据必须拒——提名只是线索');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('负向候选过 valve_check：达标进 human_gate（不自动生效）', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-nom-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		const [c] = nominateForbidden([hint('real-sig'), hint('real-sig')]);
		const d = rt.upward('L3', 'L2', c);
		assert.equal(d.action, 'human_gate');
		// 生效库必须仍为空——human_gate 不等于生效
		assert.deepEqual(await rt.negativeRules(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('nominateFromDisk：读失败的一侧是 undefined 不是 []', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-nom-'));
	try {
		// 目录当文件读 → EISDIR（非 ENOENT）→ undefined
		const r = await nominateFromDisk({ interventionsPath: dir, usageItems: [] });
		assert.equal(r.forbidden, undefined);
		assert.deepEqual(r.skills, []);
		// 文件不存在 → []（正常态：还没数据）
		const r2 = await nominateFromDisk({ interventionsPath: join(dir, 'nope.jsonl'), usageItems: [] });
		assert.deepEqual(r2.forbidden, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('origin 口径：daily 单独计数，验证样本进分布但不进 dailyCount，历史行归 untagged', () => {
	const s = summarizeDecisions([
		{ outcome: 'admitted', reason: 'r1', origin: 'daily' },
		{ outcome: 'skipped', reason: 'r2', origin: 'verification' },
		{ outcome: 'admitted', reason: 'r3', origin: 'nomination' },
		{ outcome: 'skipped', reason: 'r4' }, // 历史行
	]);
	assert.equal(s.evaluated, 4);
	assert.equal(s.dailyCount, 1);
	assert.equal(s.byOrigin.untagged, 1);
	assert.equal(s.byOrigin.verification, 1);
	assert.equal(s.missRate, 0.5, '总分布仍含全部样本');
});