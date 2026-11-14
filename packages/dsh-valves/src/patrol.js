/**
 * 定时巡检（III-7）：周级原则巡检 + 季度层结构巡检。
 *
 * ## 为什么要它（问题本身）
 *
 * 前面所有治理能力（III-1 治理循环、III-2 覆盖率、III-6 语义标记）都是
 * **被调用才发生**。没人调就不巡检——而"原则悄悄失效"恰恰不会自己喊：
 * 一条法三个月没被任何 trace 引用，它到底还成立，还是已经没人用它了？
 * 这只有**定期去看**才能发现。
 *
 * 生产环境里"定期"通常靠人记得，那不叫机制。这里做成：
 * 巡检由**时间**触发，结论**落盘**，跑没跑、查到什么都留在文件里。
 *
 * ## 两种周期，职责不同
 *
 * - **周级（原则巡检）**：只看原则层——哪些法长期零引用、哪些反例在增加。
 *   成本低（读账本），频率高，回答"还有什么在用"。
 * - **季度级（层结构巡检）**：看层本身——每层有多少条目、有没有空层、
 *   层间数量是否失衡。成本略高（扫多个文件），频率低，回答"架子还站得住吗"。
 *
 * 两者结论都写一份报告到 `storages/mind-patrol/`，**不自动改任何东西**
 * （与"生成与判断分离"一致：巡检出问题，改不改由人决定）。
 *
 * ## 不用第三方 timer 插件
 *
 * 用 Node 原生 `setInterval`，并在以下情况完整降级：
 * - 配置 `patrol.enabled=false`：完全不启动；
 * - 宿主没有 `unref`（非 Node 环境）：仍能启动，只是不主动释放；
 * - 任何异常：只记日志，绝不抛到插件生命周期里。
 *
 * 零依赖是有意的：巡检是"附加能力"，缺了主流程照常（N4）。
 *
 * @module src/patrol
 */
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 报告目录（相对 storages）。 */
export const PATROL_DIR = 'mind-patrol';

/** 默认周期：周级 7 天、季度级 90 天。 */
export const PATROL_PERIODS = Object.freeze({
	weeklyMs: 7 * 24 * 60 * 60 * 1000,
	quarterlyMs: 90 * 24 * 60 * 60 * 1000,
});

/**
 * setInterval 能接受的最大延时（毫秒）。
 *
 * Node 的定时器延时是 32 位有符号整数，上限约 24.8 天。超过时 Node **不报错**，
 * 只打一条 TimeoutOverflowWarning 并把延时**压成 1 毫秒**——实测 90 天被压成 1ms，
 * 等于季度巡检变成"每毫秒跑一次"的忙循环。这在真机烟测里才被发现。
 *
 * 所以所有定时器延时必须夹到这个上限内，长周期靠"每次唤醒都按上次报告时间
 * 判是否到期"（isPatrolDue）来实现——这正是补跑判据存在的另一个理由。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 把期望周期夹成合法的定时器延时。
 *
 * @param {number} periodMs 期望周期。
 * @returns {number} 可直接传给 setInterval 的延时（≤ MAX_TIMER_DELAY_MS）。
 */
export function clampTimerDelay(periodMs) {
	const n = Number.isFinite(periodMs) ? periodMs : 0;
	if (n <= 0) return 1;
	return Math.min(n, MAX_TIMER_DELAY_MS);
}

/**
 * 周级原则巡检：找出"长期零引用"与"反例在增加"的原则。
 *
 * @param {object} input
 * @param {object[]} input.principles 原则清单：`{ id, statement, refs, antiExamples }`
 *   - `refs`：窗口内被 trace 显式引用的次数
 *   - `antiExamples`：可外部检验的反例数
 * @param {object} [options] `{ zeroRefWarn }` 零引用告警阈值（缺省 1：0 次即告警）
 * @returns {{findings: object[], summary: object}} 纯结果，不写文件。
 */
export function weeklyPrinciplePatrol(input, options = {}) {
	const zeroRefWarn = Number.isFinite(options.zeroRefWarn) ? options.zeroRefWarn : 1;
	const list = Array.isArray(input?.principles) ? input.principles : [];
	const findings = [];
	let zeroRef = 0;
	let withAnti = 0;
	let counted = 0; // 只数有效条目（有 id 的）——缺 id 的不能进分母

	for (const p of list) {
		const id = String(p?.id ?? '').trim();
		if (!id) continue;
		counted++;
		const refs = Number.isFinite(p.refs) ? p.refs : 0;
		const anti = Number.isFinite(p.antiExamples) ? p.antiExamples : 0;
		if (anti > 0) withAnti++;
		if (refs < zeroRefWarn) {
			zeroRef++;
			findings.push({
				principle_id: id,
				kind: 'zero_reference',
				refs,
				// 说清"这意味着什么"，不夸大：零引用可能正常（新原则），
				// 也可能说明它已经不被使用——分歧要靠人看，不能自动判死。
				note: '窗口内零引用：可能是新原则，也可能已无人使用；需人判断而不是自动失效',
			});
		}
	}

	return {
		findings,
		summary: {
			principles: counted,
			zero_reference: zeroRef,
			with_anti_examples: withAnti,
		},
	};
}

/**
 * 季度层结构巡检：每层条目数、空层、失衡。
 *
 * @param {object} input
 * @param {object} input.layers 层名数组（顺序即自下而上或反之，只用于报告）
 * @param {Record<string, number>} input.counts 每层条目数
 * @returns {{findings: object[], summary: object}}
 */
export function quarterlyLayerPatrol(input) {
	const layers = Array.isArray(input?.layers) ? input.layers.map(String) : [];
	const counts = input?.counts && typeof input.counts === 'object' ? input.counts : {};
	const findings = [];
	const empty = [];
	let total = 0;
	for (const name of layers) {
		const n = Number.isFinite(counts[name]) ? counts[name] : 0;
		total += n;
		if (n === 0) {
			empty.push(name);
			findings.push({
				layer: name,
				kind: 'empty_layer',
				count: 0,
				note: '该层没有任何条目：可能是还没沉积，也可能是断链（上一层没往下长）',
			});
		}
	}
	// 失衡：任意一层超过总数 90% 而总数 ≥10。少于 10 条时比例没意义，不判。
	if (total >= 10) {
		for (const name of layers) {
			const n = Number.isFinite(counts[name]) ? counts[name] : 0;
			if (n / total > 0.9) {
				findings.push({
					layer: name,
					kind: 'imbalanced_layer',
					count: n,
					total,
					note: `该层占总数 ${(n / total * 100).toFixed(0)}%（>90%）：其余层可能没有在生长`,
				});
			}
		}
	}
	return {
		findings,
		summary: { layers: layers.length, empty: empty.length, total, skipped_balance_check: total < 10 },
	};
}

/** 报告文件名：`<kind>-<YYYY-MM-DD>.json`，同日重跑覆盖（同一天不需要两份）。 */
export function patrolReportPath(storageDir, kind, date = new Date()) {
	const day = date.toISOString().slice(0, 10);
	return join(storageDir, PATROL_DIR, `${kind}-${day}.json`);
}

/**
 * 读待决策的候选公理（从磁盘，不跨插件调用）。
 *
 * ## 为什么不通过 memory 的回调拿
 *
 * 候选是**文件**（`dao/_candidates/*.md`），而 valves 不该反向 import memory
 * （依赖方向纪律）。所以按路径约定直接读：代价是知道一个目录名，
 * 收益是零耦合——memory 没装、版本不同、服务没发布，这一项都能独立工作。
 *
 * 读不到 = 没有候选（正常态）。但**目录存在却读失败**要如实报错，
 * 那可能意味着候选丢了。
 *
 * @param {string} memoryRoot 记忆根（`dao/` 的父目录）。
 * @returns {Promise<{ok: boolean, candidates: object[], error?: string}>}
 */
export async function readPendingAxiomCandidates(memoryRoot) {
	const daoDir = join(String(memoryRoot ?? ''), 'dao');
	const dir = join(daoDir, '_candidates');
	let names;
	try {
		names = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
	} catch (err) {
		// ENOENT 有**两种含义**，必须分开（2026-11-10 实测踩到）：
		//   a) `_candidates` 不存在 → 还没有候选（正常态，返回空列表）
		//   b) `dao` 本身不存在或不是目录 → 记忆根有问题（故障，要报错）
		// 只看 err.code 会把 b 当成 a，"读坏了说成没有"——正是我们反复踩的坑。
		if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
			let daoOk = false;
			try {
				daoOk = (await readdir(daoDir, { withFileTypes: true })).length >= 0;
			} catch {
				daoOk = false;
			}
			if (daoOk) return { ok: true, candidates: [] };
			return { ok: false, candidates: [], error: `dao/ 不可读（记忆根可能有问题）：${err?.code ?? err}` };
		}
		return { ok: false, candidates: [], error: err instanceof Error ? err.message : String(err) };
	}
	const { readFile } = await import('node:fs/promises');
	const out = [];
	for (const f of names) {
		try {
			const text = await readFile(join(dir, f), 'utf8');
			const proposition = /##\s*命题\s*\n+([\s\S]*?)(?:\n##|$)/.exec(text)?.[1]?.trim() ?? '';
			// 模板把来源法写成 `- [法名](../insights/法名.md)`
			const sourceCount = (text.match(/^- \[[^\]]+\]\(\.\.\/insights\//gm) ?? []).length;
			out.push({ name: f.replace(/\.md$/, ''), proposition, source_count: sourceCount });
		} catch {
			// 单条读失败不连坐：其余候选仍要呈现出来。
			out.push({ name: f.replace(/\.md$/, ''), proposition: '', source_count: 0, unreadable: true });
		}
	}
	return { ok: true, candidates: out };
}

/**
 * Enumerate the principle layer from disk (2026-11-13, P0-1).
 *
 * Why this exists: the weekly patrol requires a `principles` list and used to
 * record `no_input` forever when nobody passed one — the timer fired every 7
 * days and inspected nothing. The sources are already on disk:
 *   - ids:        <memoryRoot>/insights/*.md stems (superseded files excluded
 *                 the same way memory_check R24 does — a replaced law must not
 *                 be reported as failing again);
 *   - refs:       count of ledger rows whose principle_refs include the stem
 *                 (explicit refs only, never guessed — same rule as III-2);
 *   - antiExamples: evidence list in the file's `## 阀门证据` section
 *                 (persisted by memory_insight valve_evidence).
 *
 * Unreadable insights/ is reported as an error, never as "no principles":
 * a broken root must not look like a clean bill of health.
 *
 * @param {string} memoryRoot memory root path.
 * @param {object[]} ledgerEntries decision ledger rows (already read).
 * @returns {Promise<{ok: boolean, principles: object[], error?: string}>}
 */
export async function readPrinciplesFromDisk(memoryRoot, ledgerEntries) {
	const dir = join(String(memoryRoot ?? ''), 'insights');
	let names;
	try {
		names = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
	} catch (err) {
		if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
			// Distinguish three states (same discipline as readPendingAxiomCandidates):
			//   a) insights/ genuinely absent -> normal uninitialized state (absent)
			//   b) insights/ exists as a FILE -> broken root (error, not absent)
			//   c) root itself unreadable -> error
			// Collapsing b/c into a would let a broken root report a clean patrol.
			let entry = null;
			try {
				const { stat } = await import('node:fs/promises');
				entry = await stat(dir);
			} catch (statErr) {
				if (statErr?.code === 'ENOENT') return { ok: true, principles: [], absent: true };
				return { ok: false, principles: [], error: statErr?.code ?? String(statErr) };
			}
			if (entry.isDirectory()) {
				// ENOENT/ENOTDIR raced away or a deeper component broke; re-check once.
				try {
					const names2 = (await readdir(dir)).filter((f) => f.endsWith('.md'));
					return { ok: true, principles: [], absent: names2.length === 0 ? true : undefined };
				} catch (err2) {
					return { ok: false, principles: [], error: err2?.code ?? String(err2) };
				}
			}
			return { ok: false, principles: [], error: 'insights/ is not a directory' };
		}
		return { ok: false, principles: [], error: err?.code ?? String(err) };
	}
	const { readFile } = await import('node:fs/promises');
	const rows = Array.isArray(ledgerEntries) ? ledgerEntries : [];
	const principles = [];
	for (const f of names) {
		const stem = f.replace(/\.md$/, '');
		let text;
		try {
			text = await readFile(join(dir, f), 'utf8');
		} catch {
			// Unreadable file: report zero refs and flag it, do not drop it —
			// a file that cannot be read is exactly what a patrol should surface.
			principles.push({ id: stem, refs: 0, antiExamples: 0, unreadable: true });
			continue;
		}
		if (/^>\s*⚠️\s*已被取代/m.test(text)) continue;
		const refs = rows.reduce((n, e) => n + (Array.isArray(e?.principle_refs) && e.principle_refs.includes(stem) ? 1 : 0), 0);
		// Evidence lines under `## 阀门证据` (memory_insight persisted form):
		// plain bullets like `- 证据：functions/xxx.md 2026-11-02：…`. The
		// quantified line (`- 量化：{json}`) carries anti_example_count, but it
		// is self-declared; count the concrete `- 证据：` lines instead (each has
		// a traceable source location).
		const section = /##\s*阀门证据\s*\n([\s\S]*?)(?=\n##|$)/.exec(text)?.[1] ?? '';
		const antiExamples = (section.match(/^- 证据：/gm) ?? []).length;
		principles.push({ id: stem, refs, antiExamples });
	}
	return { ok: true, principles };
}

/**
 * 写一份巡检报告。
 *
 * ## 报告里有"没跑成"的一席
 *
 * 巡检失败也要落盘（`ok:false` + 原因）。否则"这周没有报告"与
 * "这周巡检了但没发现问题"在文件系统里长得一模一样——这正是
 * 之前踩过的"报出来 ≠ 尽到责任"的镜像：**没报 ≠ 没问题**。
 *
 * @param {string} storageDir storages 根。
 * @param {object} report 报告内容。
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function writePatrolReport(storageDir, report) {
	const kind = String(report?.kind ?? 'unknown');
	try {
		const dir = join(storageDir, PATROL_DIR);
		await mkdir(dir, { recursive: true });
		const path = patrolReportPath(storageDir, kind, report?.at ? new Date(report.at) : new Date());
		await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
		return { ok: true, path };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 读最近的巡检报告（给探针/人看"上次巡检是什么时候、查出什么"）。
 *
 * @param {string} storageDir storages 根。
 * @param {string} kind 报告类型（weekly / quarterly）。
 * @returns {Promise<object|null>} 最新一份；没有则 null。
 */
export async function readLatestPatrolReport(storageDir, kind) {
	const dir = join(storageDir, PATROL_DIR);
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	const mine = names.filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.json')).sort();
	if (mine.length === 0) return null;
	try {
		const { readFile } = await import('node:fs/promises');
		return JSON.parse(await readFile(join(dir, mine[mine.length - 1]), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 判断某类巡检是否"该跑了"。
 *
 * 为什么需要它：定时器只在进程活着时走。宿主重启后 interval 重新计时，
 * 一个稳定的周检可能因为频繁重启而永远不触发。所以除了定时，
 * 还要能按**上次报告时间**补跑。
 *
 * @param {object|null} latest 最近一份报告（null = 从未跑过）。
 * @param {number} periodMs 周期。
 * @param {Date} [now] 当前时间。
 * @returns {boolean} 是否需要跑。
 */
export function isPatrolDue(latest, periodMs, now = new Date()) {
	if (!latest || typeof latest.at !== 'string') return true;
	const last = Date.parse(latest.at);
	if (!Number.isFinite(last)) return true;
	return now.getTime() - last >= periodMs;
}
