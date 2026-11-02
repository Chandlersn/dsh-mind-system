/**
 * 调度命中率采样 —— 让"调度还灵不灵"成为**持续趋势**，而不是一次性测量。
 *
 * ## 为什么需要采样（2026-11-02 客观审查之后）
 *
 * 命中率回归（C 批留白样本）能守住"词表没退化"，但它有两个盲区：
 *
 * 1. **样本固定**：C 批只有 10 条，词表可能对它们过拟合、对新说法无效
 * 2. **测的是词表，不是真实使用**：回归跑的是"我准备好的句子"，
 *    而真实使用是"用户此刻说的原话"，分布一直在漂
 *
 * 所以再加一层：**把真实发生的每次判定落盘**，按时间聚合成趋势。
 * 趋势回答的是回归回答不了的问题——"上个月命中率 80%，这个月掉到 40% 了吗"。
 *
 * ## 采样记什么（刻意少）
 *
 * 只记 **输入的哈希**、**判出的处境**、**命中/落选的信号名**。
 *
 * **不记输入原文**：采样文件会长期待在磁盘上，原文可能含用户隐私，
 * 而趋势分析只需要"同一句话判成了什么"的幂等键。哈希足够复现趋势，
 * 且不可反推内容。
 *
 * ## 判据
 *
 * `hitRate` 判定沿用同一口径（无信号与判错分开计）。采样里的每条都
 * **已经判过了**，所以这里只统计"无信号率"与"判错率"——
 * 命中率 = 1 - 无信号率 - 判错率。
 *
 * @module src/sampling
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 采样文件相对路径（与记忆层同区，便于一起备份/清理）。 */
const SAMPLE_REL_PATH = join('storages', 'mind-dispatch-samples.jsonl');

/**
 * 采样文件路径。
 *
 * @param {string} [dshHome] 数据根（缺省按环境推导）。
 * @returns {string} 绝对路径。
 */
export function sampleFilePath(dshHome) {
	const root = dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
	return join(root, SAMPLE_REL_PATH);
}

/**
 * 输入的幂等键（哈希，不含原文）。
 *
 * @param {string} text 输入文本。
 * @returns {string} 十六进制哈希。
 */
export function sampleKey(text) {
	return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 记一次判定采样。
 *
 * **fire-and-forget**：采样是观测手段，绝不能拖慢调度。失败静默 ——
 * 采样文件写不进去不影响任何功能（且下次补记即可）。
 *
 * ## ⚠️ 空输入不记（2026-11-02 对抗式审查修）
 *
 * 宿主一个 turn 里，第 2 步起 inbox 已被 claim 干净 —— `claimed` 是空数组，
 * 判出来必然是 unknown。把这些记进采样，"无信号率"就变成了**空输入率**。
 *
 * 实测：采样文件 362 行里 351 行是空输入（哈希 = sha256(空串)），
 * 空/非空严格交替呈轮次结构。同一份数据两个口径：
 *
 * ```
 * 步骤口径：351/362 = 97% 无信号 → "调度基本失灵"
 * 轮次口径：  4/14 = 27% 无信号 → 命中率 73.3%
 * ```
 *
 * 且该读数对被测对象**几乎不敏感**：把词表整个销毁，步骤口径也只从 97%
 * 变到 100%（动态范围 3 个百分点），而轮次口径从 27% 变到 100%（100 个
 * 百分点）。一个几乎不动的读数不能用来判断被测对象的好坏。
 *
 * 判据：**只有判过内容的判定才进采样**。命中率���单位回到"一次用户输入"。
 *
 * @param {string} dshHome 数据根。
 * @param {object} decision 判定结果（explainSituation 的返回）。
 * @returns {Promise<void>} 永不抛错。
 */
export async function recordSample(dshHome, decision) {
	const text = decision?.text ?? '';
	// 空输入 → 不采样。理由见上。
	if (String(text).length === 0) return;
	try {
		const path = sampleFilePath(dshHome);
		await mkdir(dirname(path), { recursive: true });
		await appendFile(
			path,
			`${JSON.stringify({
				t: new Date().toISOString(),
				key: sampleKey(text),
				situation: decision?.unknown ? null : decision?.situation,
				unknown: decision?.unknown === true,
				hits: decision?.hits ?? [],
			})}\n`,
			'utf8',
		);
	} catch {
		/* 采样失败不影响调度 */
	}
}

/**
 * 读采样并按天聚合趋势。
 *
 * @param {string} dshHome 数据根。
 * @param {number} [days] 回看天数（缺省 30）。
 * @returns {Promise<{days: Array<object>, overall: object|null}>} 趋势。
 */
export async function readTrend(dshHome, days = 30) {
	const path = sampleFilePath(dshHome);
	/** @type {Map<string, {total:number, unknown:number, missed:number, situations:Map<string,number>}>} */
	const byDay = new Map();
	try {
		const raw = await readFile(path, 'utf8');
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		for (const line of raw.split('\n')) {
			const s = line.trim();
			if (!s) continue;
			try {
				const e = JSON.parse(s);
				const t = Date.parse(e.t);
				if (!Number.isFinite(t) || t < cutoff) continue;
				const day = e.t.slice(0, 10);
				let bucket = byDay.get(day);
				if (bucket === undefined) {
					bucket = { total: 0, unknown: 0, missed: 0, situations: new Map() };
					byDay.set(day, bucket);
				}
				bucket.total += 1;
				if (e.unknown === true) bucket.unknown += 1;
				else if (e.situation) {
					bucket.situations.set(e.situation, (bucket.situations.get(e.situation) ?? 0) + 1);
				}
			} catch {
				/* 坏行跳过 */
			}
		}
	} catch {
		/* 没有采样文件 = 还没开始采样（正常路径，不是错误） */
	}

	const out = [...byDay.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([day, b]) => ({
			day,
			total: b.total,
			unknown: b.unknown,
			unknownRate: b.total === 0 ? null : b.unknown / b.total,
			situations: Object.fromEntries(b.situations),
		}));

	let total = 0;
	let unknown = 0;
	for (const b of byDay.values()) {
		total += b.total;
		unknown += b.unknown;
	}
	return {
		days: out,
		overall: total === 0 ? null : { total, unknown, unknownRate: unknown / total },
	};
}

/**
 * 把趋势压成一句可读的判断。
 *
 * @param {object} trend readTrend 的返回。
 * @returns {string} 一行文本。
 */
export function trendLine(trend) {
	if (trend?.overall === null || trend?.overall === undefined) {
		return '调度采样：暂无样本（采样从本次起开始积累）';
	}
	const o = trend.overall;
	const rate = ((1 - o.unknownRate) * 100).toFixed(0);
	const last = trend.days[trend.days.length - 1];
	const lastRate = last?.unknownRate === null || last?.unknownRate === undefined ? null : ((1 - last.unknownRate) * 100).toFixed(0);
	return (
		`调度采样：${o.total} 次判定，无信号率 ${(o.unknownRate * 100).toFixed(0)}%` +
		`（命中率 ${rate}%，近一日 ${lastRate ?? 'n/a'}%）。` +
		`无信号率高 = 词表跟不上真实说法。`
	);
}

/**
 * **同步**读采样并按天聚合趋势。
 *
 * ## 为什么需要同步版（2026-11-02 对抗式审查修）
 *
 * 健康探针是**同步**函数（监督层零参数调用 `exported.probe()`），返回值
 * 当场定型。异步版 `readTrend()` 只能在 Promise resolve 之后才拿到数据 ——
 * 那时探针早已返回，finding 进不了监督层看到的快照。
 *
 * 实测（旧写法）：同步返回只有 `mind.ok, mind.signals`；等 1 秒后同一个
 * 数组才多出 `mind.trend`，但监督层早就拿走了 —— 那条读数**从未出现过**。
 *
 * 而 `mind.trend` 是唯一上报"命中率趋势"的读数。修好分母之后，它是判断
 * "词表还跟不跟得上真实说法"的唯一依据。
 *
 * 代价：同步读一个小文件。采样文件每行几十字节，探针调用频率低，可接受。
 *
 * @param {string} dshHome 数据根。
 * @param {number} [days] 回看天数（缺省 30）。
 * @returns {{days: Array<object>, overall: object|null}} 趋势。
 */
export function readTrendSync(dshHome, days = 30) {
	const path = sampleFilePath(dshHome);
	/** @type {Map<string, {total:number, unknown:number, situations:Map<string,number>}>} */
	const byDay = new Map();
	let raw = '';
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		/* 没有采样文件 = 还没开始采样（正常路径，不是错误） */
	}
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	for (const line of raw.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			const e = JSON.parse(s);
			const t = Date.parse(e.t);
			if (!Number.isFinite(t) || t < cutoff) continue;
			const day = e.t.slice(0, 10);
			let bucket = byDay.get(day);
			if (bucket === undefined) {
				bucket = { total: 0, unknown: 0, situations: new Map() };
				byDay.set(day, bucket);
			}
			bucket.total += 1;
			if (e.unknown === true) bucket.unknown += 1;
			else if (e.situation) {
				bucket.situations.set(e.situation, (bucket.situations.get(e.situation) ?? 0) + 1);
			}
		} catch {
			/* 坏行跳过 */
		}
	}

	const out = [...byDay.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([day, b]) => ({
			day,
			total: b.total,
			unknown: b.unknown,
			unknownRate: b.total === 0 ? null : b.unknown / b.total,
			situations: Object.fromEntries(b.situations),
		}));

	let total = 0;
	let unknown = 0;
	for (const b of byDay.values()) {
		total += b.total;
		unknown += b.unknown;
	}
	return {
		days: out,
		overall: total === 0 ? null : { total, unknown, unknownRate: unknown / total },
	};
}
