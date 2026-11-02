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
 * @param {string} dshHome 数据根。
 * @param {object} decision 判定结果（explainSituation 的返回）。
 * @returns {Promise<void>} 永不抛错。
 */
export async function recordSample(dshHome, decision) {
	try {
		const path = sampleFilePath(dshHome);
		await mkdir(dirname(path), { recursive: true });
		await appendFile(
			path,
			`${JSON.stringify({
				t: new Date().toISOString(),
				key: sampleKey(decision?.text ?? ''),
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
