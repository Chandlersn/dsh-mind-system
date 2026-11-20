/**
 * VI-5 实验层回流（碰撞笔记 → 候选 → 用户确认/否决）。
 *
 * ## 这一层的危险在哪
 *
 * 碰撞笔记是自由文体、没有闸门、谁都可以写得像正典（作者自己在
 * `删掉的东西，还在被我召回` 里就写了这句）。它唯一的合法出口是走既有闸门，
 * 而不是获得一条捷径。所以这里测的不是"能不能回流"，是**回流时会不会冒充**：
 *
 * 1. 没有证据的笔记必须被降级或拒绝，不能因为"它是我们自己的笔记"就放行；
 * 2. 适配器不许替笔记编数字——编出来的覆盖数正是闸门要用的那个数；
 * 3. 来源层必须可区分，否则账本上实验层与正典长得一模一样；
 * 4. 作者自己写下的"会失败的观测"要能被识别并当作可检验路径（这是笔记里
 *    最有价值的证据，因为它在说"什么能证明我错了"）。
 *
 * ## 一个实测订正
 *
 * 第一版用宽松正则抓 A/B 与百分比，把 `10:00`（周检时间）算成了量化观测。
 * 时间不是测量。假观测会抬高 skill_coverage——那正是判据要数的东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { collideNoteToCandidate } = await import('../src/clis-bridge.js');
const { createRuntime } = await import('../index.js');

const tempStore = () => mkdtempSync(join(tmpdir(), 'dsh-v5-'));

test('自由文体笔记：标题成为陈述，路径成为来源', () => {
	const c = collideNoteToCandidate({
		theme: '存在被当成了运行',
		text: '# 存在被当成了运行\n\n周检卡在 no_input 六天。\n',
		source: '存在被当成了运行.md',
	});
	assert.equal(c.statement, '存在被当成了运行');
	assert.equal(c.origin, 'nomination');
	assert.equal(c.source_layer, 'experimental', '来源层必须写死在候选上');
	assert.ok(c.evidence.some((e) => e.startsWith('collide:')), '来源路径要进证据，便于回溯');
});

test('真实量化观测被提取；时钟时间不算证据', () => {
	// Text mirrors the real note: "排在结果前面的——三比零——是那份已经删掉的"
	// records an actual retrieval outcome (3 deleted-twin hits to 0 canonical),
	// so it counts as a measurement. An earlier version of this fixture phrased
	// it as "三比零那次是删掉的", which reads as a label rather than a result;
	// that phrasing is what made counting it look wrong.
	const c = collideNoteToCandidate({
		theme: 't',
		text: '召回 5/5 命中，排在结果前面的——三比零——是那份已经删掉的。每周一 10:00 会跑。命中率 91.7% 。',
	});
	// 5/5, 三比零 and 91.7% are measurements; 10:00 is a schedule.
	assert.equal(c.skill_coverage, 3, `应只数真观测，实际证据：${c.evidence.join(',')}`);
	assert.ok(c.evidence.includes('collide-observation:5/5'));
	assert.ok(c.evidence.includes('collide-observation:91.7%'));
	assert.ok(c.evidence.includes('collide-observation:3:0'), '中文数字的比分也是观测');
	assert.ok(!c.evidence.some((e) => e.includes('10:00')), '时钟时间不是量化观测');
});

test('没有量化观测时 coverage 为 0，不猜数字', () => {
	const c = collideNoteToCandidate({ theme: 't', text: '一段只有感慨没有数字的笔记。' });
	assert.equal(c.skill_coverage, 0, '数不出就是 0，不能给个好看的下界');
	assert.equal(c.scenario_coverage, 0);
});

test('作者写的"会失败的观测"被当作可检验路径', () => {
	const c = collideNoteToCandidate({
		theme: 't',
		text: '留一条会失败的观测：以后哪次查「绿灯」又冒出 _deleted，说明排除被冲掉了。',
	});
	assert.ok(c.verifiable_by, '这条证据最有价值，必须被识别');
	assert.match(c.verifiable_by, /_deleted/, '要保留作者的原话要点，不要改写成空泛句子');
});

test('真实写法："观测在这儿：" 中间插词也要能识别', () => {
	// Measured on the actual note: it says 留一条会失败的观测在这儿：… and the
	// strict "phrase immediately followed by colon" match returned undefined.
	// That silently dropped the single most valuable evidence in the note.
	const c = collideNoteToCandidate({
		theme: 't',
		text: '留一条会失败的观测在这儿：以后哪次查「绿灯」又冒出 _deleted，说明排除被冲掉了。',
	});
	assert.ok(c.verifiable_by, '中间插了几个字不该让整条证据丢失');
	assert.match(c.verifiable_by, /_deleted/);
});

test('没写可检验路径时，不编一个出来', () => {
	const c = collideNoteToCandidate({ theme: 't', text: '只有判断，没有反证钩子。' });
	assert.equal(c.verifiable_by, undefined, '缺就是缺——留给阀门如实降级');
});

test('已被取代的笔记不再提名', () => {
	assert.equal(collideNoteToCandidate({ theme: 't', text: '⚠️ 已被取代：旧结论。' }), null);
});

test('空主题返回 null（不产出无名候选）', () => {
	assert.equal(collideNoteToCandidate({ theme: '  ', text: 'x' }), null);
	assert.equal(collideNoteToCandidate(null), null);
});

// ——————————————————————————————————————————————
// 过闸门：与正典并批，但来源可区分、结论不被放宽
// ——————————————————————————————————————————————

test('实验层笔记走既有闸门，未被特殊放行', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const r = await rt.criteria([], {
			collideNotes: [{ theme: '存在被当成了运行', text: '周检卡了六天，存在被当成了运行。', source: 'x.md' }],
		});
		assert.equal(r.verdicts.length, 1);
		// No recorded evidence search ⇒ the gate must not admit it. The point of the
		// test is that being a collide note buys NO exemption.
		assert.notEqual(r.verdicts[0].action, 'accept', `实验层不能直接放行：${JSON.stringify(r.verdicts[0])}`);
		assert.ok(['reject', 'downgrade', 'human_gate'].includes(r.verdicts[0].action));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('来源拆分如实报出，防止实验层批量冒充正典', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const r = await rt.criteria([], { collideNotes: [{ theme: 'a', text: 'x' }, { theme: 'b', text: 'y' }] });
		assert.deepEqual(r.source_split, { canon: 0, experimental: 2 }, '全实验层批次必须一眼看得出');
		const r2 = await rt.criteria([], {});
		assert.deepEqual(r2.source_split, { canon: 0, experimental: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('兼容旧调用：不传 collideNotes 时行为不变', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const r = await rt.criteria([]);
		assert.equal(r.candidates.length, 0);
		assert.equal(r.verdicts.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
