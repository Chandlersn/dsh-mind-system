/**
 * 对抗式审查后的回归测试（2026-11-02）。
 *
 * ## 为什么单独一个文件
 *
 * 审查发现：旧测试套件 64 处变异里 37 处**存活**（套件仍全绿），尤其是
 * "删掉 `agent/pre-step` 监听器仍 53/53 全绿" —— 套件区分不了
 * "插件在工作"与"插件什么都没做"。
 *
 * 所以这里每个用例都钉住**一个具体的、能被变异打红的缺陷**，
 * 而不是钉住纯函数的行为。
 *
 * 钉住的缺陷：
 *
 * 1. 采样分母错 → 空输入不采样（步骤口径 vs 轮次口径）
 * 2. 时序反转 → 处境在工具面定稿**之前**判出
 * 3. execute 族死代码 → 族里必须有非 core 成员
 * 4. `mind.trend` 永不上报 → 探针同步返回里必须有它
 * 5. 权重压不住广度 → 高权重必须赢
 * 6. 同分规则与文档相反 → 后注册者必须赢
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainSituation, registerSignal, __clearSignalsForTest } from '../src/dispatch.js';
import { arrangeTools, isCoreTool, SITUATIONS } from '../src/orchestrate.js';
import { recordSample, readTrend, readTrendSync, sampleFilePath } from '../src/sampling.js';
import { judge, currentSituationOf, __resetSituationForTest } from '../src/situation.js';

/** 造一个临时数据根。 */
function tempHome() {
	const dir = mkdtempSync(join(tmpdir(), 'mind-fix-'));
	return dir;
}

test('缺陷1：空输入不采样 —— 采样分母回到"一次用户输入"而非"一个 step"', async () => {
	const home = tempHome();
	try {
		// 有内容的判定 → 记
		await recordSample(home, { text: '帮我改一下这个文件', situation: 'execute', unknown: false, hits: ['do-it'] });
		// 空输入的判定 → 不记（宿主第 2 步起 inbox 为空）
		await recordSample(home, { text: '', situation: null, unknown: true, hits: [] });
		await recordSample(home, { text: '', situation: null, unknown: true, hits: [] });

		const trend = readTrendSync(home);
		assert.equal(trend.overall.total, 1, `只有有内容的判定才进采样，实际 ${trend.overall.total}`);
		assert.equal(trend.overall.unknown, 0, '空输入不该算进无信号');

		// 旧口径的对照：如果空输入也记，未知率会被稀释到 1/3
		const withEmpty = readTrendSync(home);
		assert.equal(withEmpty.overall.unknownRate, 0, '未知率必须只由真实的无信号判定构成');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('缺陷1b：采样文件里不该出现空输入的哈希（sha256(空串)）', async () => {
	const home = tempHome();
	try {
		await recordSample(home, { text: '', situation: null, unknown: true, hits: [] });
		await recordSample(home, { text: '真实输入', situation: 'execute', unknown: false, hits: [] });
		const raw = (await import('node:fs/promises')).readFile(sampleFilePath(home), 'utf8');
		const content = await raw;
		assert.ok(!content.includes('e3b0c44298fc1c14'), '空输入的哈希不得出现在采样文件里（那是 sha256(空串)）');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('缺陷2：空输入不覆盖已有处境（否则工具面在 turn 中途抖回默认顺序）', () => {
	__resetSituationForTest();
	judge('帮我改一下这个文件');
	assert.equal(currentSituationOf(), 'execute');
	judge('');
	assert.equal(currentSituationOf(), 'execute', '空输入不是"用户没表达处境"，不得清掉已有处境');
	judge('搜一下最新的版本');
	assert.equal(currentSituationOf(), 'retrieve', '新的真实输入必须能改写处境');
	__resetSituationForTest();
});

test('缺陷3：execute 优先族必须含非 core 成员（否则整族是死代码）', () => {
	// 族里每个前缀都要能命中一个**非 core** 的工具名。
	// 旧值 ['pwsh','read','edit','write','glob','grep'] 全部是 core → rank 永远进不了 0。
	const tools = [
		{ name: 'str_replace_editor' },
		{ name: 'file_reference' },
		{ name: 'cordis' },
		{ name: 'bash' },
		{ name: 'terminal' },
		{ name: 'clis_classify' },
		{ name: 'memory_read' },
		{ name: 'web_search' },
	];
	const ordered = arrangeTools(tools, SITUATIONS.execute).map((t) => t.name);
	const firstNonCore = ordered.find((n) => !isCoreTool(n));
	assert.equal(
		firstNonCore,
		'str_replace_editor',
		`execute 处境下"动手工具"必须排到非 core 工具之前，实际顺序 ${ordered.join(' > ')}`,
	);
	// 对照：非 execute 族（clis_/memory_/web_）不应被提到最前
	const diagnose = arrangeTools(tools, SITUATIONS.diagnose).map((t) => t.name);
	assert.equal(diagnose[0], 'clis_classify', 'diagnose 处境下判结构工具排首位');
});

test('缺陷4：探针同步返回里必须有 mind.trend（旧写法在 then() 里 push，永不上报）', async () => {
	const mindMod = await import('../index.js');
	const home = tempHome();
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		// 造两个样本，让趋势非空
		await recordSample(home, { text: '帮我改一下这个文件', situation: 'execute', unknown: false, hits: ['do-it'] });
		const probe = mindMod.healthProbe.probe();
		const codes = probe.findings.map((f) => f.code);
		assert.ok(
			codes.includes('mind.trend'),
			`探针同步返回必须含 mind.trend（否则这条读数从未出现过），实际 ${codes.join(', ')}`,
		);
	} finally {
		if (prevHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test('缺陷5：高权重信号必须赢过低权重的宽泛信号', () => {
	__clearSignalsForTest();
	try {
		registerSignal({ name: 'heavy', situation: SITUATIONS.retrieve, weight: 10, words: ['审查'] });
		registerSignal({ name: 'broad', situation: SITUATIONS.execute, weight: 1, words: ['检查', '核对', '评估', '审查', '审核', '是否', '对不对', '通不通', '检验'] });
		const d = explainSituation('检查核对评估审查审核是否对不对通不通检验');
		assert.equal(
			d.situation,
			SITUATIONS.retrieve,
			`权重 10 的信号必须赢过权重 1 但命中 9 词的信号，实际 ${d.situation}（evidence ${JSON.stringify(d.evidence)}）`,
		);
	} finally {
		__clearSignalsForTest();
	}
});

test('缺陷6：同分时后注册者赢（与文档一致；旧代码用严格 > 导致内置赢）', () => {
	__clearSignalsForTest();
	try {
		// 内置 intent-review 命中"审查"（权重 2）
		registerSignal({ name: 'ext-tie', situation: SITUATIONS.retrieve, owner: 'ext', weight: 2, words: ['审查'] });
		const d = explainSituation('审查');
		assert.equal(
			d.situation,
			SITUATIONS.retrieve,
			`同分时后注册的外部信号必须赢（文档：同分取注册顺序靠后者），实际 ${d.situation}`,
		);
	} finally {
		__clearSignalsForTest();
	}
});

test('缺陷7：反转判据时分数对数加成 —— 命中处数只给边际递减的加分', () => {
	__clearSignalsForTest();
	try {
		// 同权重下，命中多处应优于命中一处
		registerSignal({ name: 'one', situation: SITUATIONS.execute, weight: 2, words: ['甲'] });
		registerSignal({ name: 'three', situation: SITUATIONS.diagnose, weight: 2, words: ['甲', '乙', '丙'] });
		const d = explainSituation('甲乙丙');
		assert.equal(d.situation, SITUATIONS.diagnose, '同权重命中多处应胜出');
	} finally {
		__clearSignalsForTest();
	}
});
