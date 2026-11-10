/**
 * 候选公理层测试（2026-11-10，用户要求）。
 *
 * 用户的话：「公理层可以加一个候选公理层，agent 一层层迭代升华、抽象，
 * 最后主动展现给用户，由用户来决策，点击确认，是否加入真正的公理层。」
 *
 * 三条必须守住的：①候选走**同一套闸门**（不是降标准的道）；
 * ②确认只能由用户做，agent 不能自己批准自己；③候选**绝不进召回**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	proposeAxiomCandidate, confirmAxiomCandidate, rejectAxiomCandidate,
	recallable, describeCandidate, AXIOM_CANDIDATE_STATES, AXIOM_CANDIDATE_CODES,
} from '../src/axiom-candidate.js';
import { gateDao } from '../src/layer-gate.js';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const FIVE = ['法一', '法二', '法三', '法四', '法五'];

const propose = (over = {}) => proposeAxiomCandidate({
	name: '信号在谁身上生成',
	proposition: '观测者与被观测者互为定义，站自证之极只是重复自己。',
	extractedFrom: FIVE,
	evidence: '五条法都在说同一件事：信号的来源决定了它携带什么',
	gate: gateDao,
	now: NOW,
	...over,
});

// ——————————————————————————————————————————————
// ① 候选走同一套闸门（不是降标准的道）
// ——————————————————————————————————————————————

test('够 5 条法 → 生成候选，状态是 candidate 而不是 active', () => {
	const r = propose();
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.candidate.status, AXIOM_CANDIDATE_STATES.candidate);
	assert.equal(r.candidate.confirmed_at, undefined, '候选不该有确认时间');
});

test('不足 5 条法 → 连候选都进不去（复用 gateDao，不降低标准）', () => {
	const r = propose({ extractedFrom: ['法一', '法二'] });
	assert.equal(r.ok, false);
	assert.match(String(r.reason), /至少需要 5 条/);
});

test('重复的来源法只算一条（同一条法写 5 遍不算 5 条）', () => {
	const r = propose({ extractedFrom: ['法一', '法一', '法一', '法一', '法一'] });
	assert.equal(r.ok, false, '去重后只有 1 条，不该过');
});

test('命题含具体标记 → 候选也拒（候选不是避难所）', () => {
	const r = propose({ proposition: 'dsh-valves 的 mind-valves.jsonl 里写着这个' });
	assert.equal(r.ok, false);
});

test('命题是操作手册句式 → 拒', () => {
	const r = propose({ proposition: '第一步先读账本，第二步再判定因果' });
	assert.equal(r.ok, false);
});

test('没给 gate 函数 → 拒绝（候选不许自带判据）', () => {
	const r = proposeAxiomCandidate({ name: 'x', proposition: 'y', extractedFrom: FIVE });
	assert.equal(r.ok, false);
	assert.match(String(r.reason), /gate/);
});

// ——————————————————————————————————————————————
// ② 确认只能由用户做
// ——————————————————————————————————————————————

test('用户确认 → 转正，带确认时间', () => {
	const { candidate } = propose();
	const r = confirmAxiomCandidate(candidate, { byUser: true, note: '这个命题成立', now: NOW });
	assert.equal(r.ok, true);
	assert.equal(r.axiom.status, AXIOM_CANDIDATE_STATES.active);
	assert.ok(r.axiom.confirmed_at);
	assert.equal(r.axiom.confirm_note, '这个命题成立');
});

test('没有 byUser 标记 → 拒绝（agent 不能自己批准自己）', () => {
	const { candidate } = propose();
	const r = confirmAxiomCandidate(candidate, {});
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'confirmation_requires_user');
	assert.ok(String(r.hint).includes('用户点确认'), '要明确告诉调用方这是硬约束');
});

test('已确认的不能再确认一次（幂等边界）', () => {
	const { candidate } = propose();
	const active = confirmAxiomCandidate(candidate, { byUser: true, now: NOW }).axiom;
	const again = confirmAxiomCandidate(active, { byUser: true, now: NOW });
	assert.equal(again.ok, false);
	assert.equal(again.reason, AXIOM_CANDIDATE_CODES.notCandidate);
});

test('用户否决 → 保留理由（否决也是证据）', () => {
	const { candidate } = propose();
	const r = rejectAxiomCandidate(candidate, { reason: '这只是一条法的换句话', now: NOW });
	assert.equal(r.ok, true);
	assert.equal(r.axiom.status, AXIOM_CANDIDATE_STATES.rejected);
	assert.equal(r.axiom.reject_reason, '这只是一条法的换句话');
});

test('否决必须给理由（否则同一个命题会原样再提一遍）', () => {
	const { candidate } = propose();
	const r = rejectAxiomCandidate(candidate, {});
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'rejection_requires_reason');
});

// ——————————————————————————————————————————————
// ③ 候选绝不进召回
// ——————————————————————————————————————————————

test('recallable：只有 active 可进召回，候选与被否决一律不进', () => {
	const { candidate } = propose();
	assert.equal(recallable(candidate), false, '候选进召回 = 拿没被认可的命题当前提');

	const active = confirmAxiomCandidate(candidate, { byUser: true, now: NOW }).axiom;
	assert.equal(recallable(active), true);

	const rejected = rejectAxiomCandidate(candidate, { reason: '不成立', now: NOW }).axiom;
	assert.equal(recallable(rejected), false);
});

test('recallable：null/未知状态一律不放行（失败关闭）', () => {
	assert.equal(recallable(null), false);
	assert.equal(recallable({}), false);
	assert.equal(recallable({ status: 'whatever' }), false);
});

// ——————————————————————————————————————————————
// 呈现：主动展现给用户
// ——————————————————————————————————————————————

test('describeCandidate：明确标"等你决定"，不伪装成已生效', () => {
	const { candidate } = propose();
	const d = describeCandidate(candidate);
	assert.equal(d.decision_needed, true, '必须让用户看到"需要我决定"');
	assert.equal(d.status, 'candidate');
	assert.equal(d.source_count, 5);
	assert.deepEqual(d.sources, FIVE);
	assert.ok(d.evidence.length > 0, '要带上"为什么够格"的理由');
});

test('describeCandidate：转正后不再要求决策', () => {
	const { candidate } = propose();
	const active = confirmAxiomCandidate(candidate, { byUser: true, now: NOW }).axiom;
	assert.equal(describeCandidate(active).decision_needed, false);
});

test('describeCandidate：闸门警告一路带上（呈现时不丢信息）', () => {
	// 来源过多会触发 gateDao 的 warning；候选应把它一起交给用户看。
	const { candidate } = propose({
		extractedFrom: [...FIVE, '法六', '法七', '法八', '法九', '法十', '法十一'],
	});
	assert.equal(candidate.status, 'candidate');
	const d = describeCandidate(candidate);
	assert.ok(Array.isArray(d.warnings) && d.warnings.length > 0, '警告要出现在呈现里');
});

test('describeCandidate：null 输入返回 null（不造空对象）', () => {
	assert.equal(describeCandidate(null), null);
	assert.equal(describeCandidate(undefined), null);
});
