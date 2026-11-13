/**
 * 每日记录按月/周归档通道（2026-11-13 用户要求）。
 *
 * ## 动因
 *
 * 顶层每日文件按天增长，体检、检索、面板全部按顶层枚举；用户要求把
 * **非当月**的顶层 `YYYY-MM-DD.md` 收纳折叠进 `daily/YYYY-MM.md`。归档是
 * **插件侧通道**（不经编辑工具）：搬走正文、登记写入账本、删除配对完整。
 *
 * ## 结构（保守最小化）
 *
 * - 每月一个归档文件 `daily/YYYY-MM.md`，首次创建带说明头；按 ISO 周
 *   （周一起始）分节 `## 周 YYYY-Www（MM-DD ~ MM-DD）`，节内按日
 *   `### [YYYY-MM-DD]` 接原文件正文（剥原 H1 标题行，其余逐字保留）。
 *   周节范围取**本节实际收纳日期**的最小~最大值——不是整个周一~周日，
 *   空端不冒充内容（跨月周的两半各归各的月份文件）。
 * - 追加不重写：同月归档已存在时读入后只追加缺失日；已存在的日标题跳过，
 *   已有字节保持原样（幂等重跑不改变历史表示）。
 * - 「每天最多归档一次」由**源文件消失**天然保证：删除配对事件完整才算完成。
 *
 * ## 删除配对（不复用 finishCaptureIntent 的裸 unlink）
 *
 * `finishCaptureIntent` 存在未修的路径替换反例；这里复用 write-ledger 的
 * `delete_intent → unlink → delete` 配对语义（server.js 调用时注入真身
 * `deleteTrackedFile`，`to='daily/YYYY-MM.md'` 指向归档位置）：unlink 前在
 * commit 锁内复读校验内容未变，任何一步失败都保留原文件并在返回值里给出
 * 明确阶段；unlink 结果未知时如实报 unknown，不猜。
 *
 * ## 竞态防护
 *
 * mtime 距今 < 24h 的顶层日文件跳过（`mtime_fresh`）：它可能仍在被采集
 * 通道追加（跨月边界场景），等下一轮定时器（6h）再归档。
 *
 * ## 边界（诚实标注）
 *
 * - writeText 在落盘前脱敏（R21 防线）：原文含凭据时，归档件与账本哈希以
 *   **脱敏后文本**为准——这是防线设计使然，不是归档丢数据。
 * - 归档件与顶层每日都是 tracked 键（`daily/` 在 TRACKED_ZONES 内），
 *   R26 对账口径不变；删除意图未完成时 R26 会点名，这是期望行为。
 * - 本模块**不自带触发器**（体检/钩子接入由调用方决定），只提供可测试的通道。
 * - 跨进程并发未加锁：与记忆根其余写入通道同level（同进程内按路径串行）。
 *
 * @module src/daily-archive
 */
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { localDateStr, readIfExists, withPathLock, withWriteCommitLock, writeText } from './util.js';
import { recordDeleteEvent } from './write-ledger.js';

/** 顶层每日文件名（与账本/守卫同一严格形状）。 */
const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
/** 按月归档文件名。 */
const ARCHIVE_NAME_RE = /^\d{4}-\d{2}\.md$/;
/** 日节标题（解析与生成共用同一形状）。 */
const DAY_HEADING_RE = /^###\s*\[(\d{4}-\d{2}-\d{2})\]/;
/** 删除事件登记的 tool 名（账本里可追溯到本通道）。 */
const TOOL = 'daily-archive';
/** mtime 距今小于该毫秒数的文件跳过（防跨月 capture 竞态）。 */
const MTIME_GUARD_MS = 24 * 60 * 60 * 1000;

/**
 * 归档通道默认的删除配对实现（与 server.js deleteTrackedFile 同语义）。
 * server.js 调用时注入真身 deleteTrackedFile（含 withWriteCommitLock 排队、
 * to 字段与并发校验），此处实现保证直接调用者也有完整 intent/complete 配对。
 */
let injectedDelete = null;
/** @param {Function} fn server.js 的 deleteTrackedFile 绑定。 */
export function setDeleteImplementation(fn) {
	injectedDelete = typeof fn === 'function' ? fn : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ISO 周号（周一为首日）。
 * @param {number} y 年
 * @param {number} m 月（1-12）
 * @param {number} d 日
 * @returns {{isoYear: number, week: number}}
 */
export function isoWeekOf(y, m, d) {
	const t = new Date(Date.UTC(y, m - 1, d));
	const day = (t.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	t.setUTCDate(t.getUTCDate() - day + 3); // 移到本周的周四（ISO 周锚点）
	const isoYear = t.getUTCFullYear();
	const firstThu = new Date(Date.UTC(isoYear, 0, 4));
	const fday = (firstThu.getUTCDay() + 6) % 7;
	firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3); // 第 1 周的周四
	const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / 604800000);
	return { isoYear, week };
}

/** 剥原 H1 标题行，其余逐字保留；没有 H1 就原样返回。 */
function stripH1(text) {
	const lines = String(text ?? '').split('\n');
	if (lines.length && /^#\s/.test(lines[0])) lines.shift();
	return lines.join('\n').replace(/^\n+/, '');
}

/** 归档件首次创建时的说明头。 */
function archiveHeader(month) {
	return [
		`# 每日归档 ${month}`,
		'',
		`> 本文件由插件每日归档通道（${TOOL}）生成并经写入账本登记：收纳 ${month} 的顶层每日记录，按 ISO 周（周一起始）分节，\`### [YYYY-MM-DD]\` 为日节（原文剥去一级标题后并入，写作时位于记忆根目录）。已存在的日节不重写；源文件在归档写入成功并完成删除配对后消失。`,
		'',
	].join('');
}

/** 把待归档日按 ISO 周分组，生成追加文本（周节升序、日节升序）。 */
function buildAddition(pending) {
	const weeks = new Map();
	for (const s of pending) {
		const wk = isoWeekOf(Number(s.day.slice(0, 4)), Number(s.day.slice(5, 7)), Number(s.day.slice(8, 10)));
		const key = `${wk.isoYear}-W${pad2(wk.week)}`;
		if (!weeks.has(key)) weeks.set(key, { days: [] });
		weeks.get(key).days.push(s);
	}
	let out = '';
	for (const key of [...weeks.keys()].sort()) {
		const days = weeks.get(key).days.sort((a, b) => a.day.localeCompare(b.day));
		out += `## 周 ${key}（${days[0].day.slice(5, 10)} ~ ${days[days.length - 1].day.slice(5, 10)}）\n\n`;
		for (const s of days) out += `### [${s.day}]\n\n${stripH1(s.text).trimEnd()}\n\n`;
	}
	return out;
}

/** 在既有归档文本后追加：已有字节保持原样，只补必要的换行对齐。 */
function appendArchiveText(existing, addition) {
	if (existing.endsWith('\n\n')) return existing + addition;
	if (existing.endsWith('\n')) return `${existing}\n${addition}`;
	return `${existing}\n\n${addition}`;
}

/** 从归档文本里抽取某日的日节（到下一个 `### [`/`##` 标题或文件尾）。 */
function extractDaySection(text, date) {
	const lines = String(text ?? '').split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (new RegExp(`^###\\s*\\[${date}\\]`).test(lines[i])) { start = i; break; }
	}
	if (start < 0) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^###\s*\[/.test(lines[i]) || /^##\s/.test(lines[i])) { end = i; break; }
	}
	return lines.slice(start, end).join('\n').trimEnd();
}

/**
 * 删除一份已归档的顶层源文件：delete_intent → 复读校验 → unlink → delete。
 * 任何一步失败都返回 `{ ok: false, stage, message }`，不抛出；结果由调用方
 * 汇总。unlink 结果未知时如实报 unknown（不复用 finishCaptureIntent 的
 * 裸 unlink——它存在未修的路径替换反例）。
 */
async function deleteArchivedSource(root, source, archiveKey) {
	// 优先复用 server.js 的 deleteTrackedFile：intent/complete 配对、复读校验、
	// to 指向归档位置——语义与 memory_rename 的源删除完全一致。
	if (injectedDelete) {
		try {
			await injectedDelete(root, source.path, source.text, { tool: TOOL, to: archiveKey });
			return { ok: true };
		} catch (err) {
			// 结果未知（unlink 可能已发生）时如实上报，不猜；调用方保留现场。
			const unknown = err?.code === 'MEMORY_DELETE_OUTCOME_UNKNOWN' || err?.code === 'MEMORY_DELETE_LEDGER_UNKNOWN';
			return { ok: false, stage: unknown ? 'unlink_or_complete' : 'delete_intent', code: err?.code, message: `${source.name} 删除配对失败：${err?.message ?? String(err)}` };
		}
	}
	const key = source.name;
	return withWriteCommitLock(source.path, async () => {
		let current;
		try {
			current = await readFile(source.path, 'utf8');
		} catch (err) {
			if (err?.code === 'ENOENT') {
				return { ok: false, stage: 'delete_intent', code: 'MEMORY_SOURCE_GONE', message: `源文件 ${key} 在归档写入后已消失，删除意图未登记；请先核对文件与账本` };
			}
			return { ok: false, stage: 'delete_intent', message: `源文件 ${key} 读取失败（${err?.code ?? 'unknown'}），未登记删除意图，文件保留` };
		}
		if (current !== source.text) {
			return { ok: false, stage: 'delete_intent', message: `${key} 在归档写入期间发生变化，未删除；文件保留` };
		}
		const id = randomUUID();
		let intentOk = false;
		try { intentOk = await recordDeleteEvent(root, { key, op: 'delete_intent', id, tool: TOOL, to: archiveKey }); } catch { intentOk = false; }
		if (!intentOk) {
			return { ok: false, stage: 'delete_intent', code: 'MEMORY_DELETE_INTENT_UNKNOWN', message: `${key} 的删除意图记账失败，未删除；文件保留` };
		}
		let after;
		try { after = await readFile(source.path, 'utf8'); }
		catch (err) {
			return { ok: false, stage: 'delete_intent', code: 'MEMORY_DELETE_INTENT_UNKNOWN', message: `${key} 已记录删除意图 ${id}，删除未执行（复读失败：${err?.code ?? 'unknown'}）；请核对文件与账本` };
		}
		if (after !== source.text) {
			return { ok: false, stage: 'delete_intent', code: 'MEMORY_DELETE_INTENT_UNKNOWN', message: `${key} 在记录意图期间发生变化，未删除；账本保留未完成意图 ${id}` };
		}
		try {
			await unlink(source.path);
		} catch (err) {
			return { ok: false, stage: 'unlink', code: 'MEMORY_DELETE_OUTCOME_UNKNOWN', message: `${key} 删除结果未知（${err?.code ?? 'unknown'}），账本保留未完成意图 ${id}；请先核对，不要盲目重试` };
		}
		let doneOk = false;
		try { doneOk = await recordDeleteEvent(root, { key, op: 'delete', id, tool: TOOL, to: archiveKey }); } catch { doneOk = false; }
		if (!doneOk) {
			return { ok: false, stage: 'delete_complete', code: 'MEMORY_DELETE_LEDGER_UNKNOWN', message: `${key} 已删除，但完成事件记账失败（意图 ${id}）；账本保留未完成意图，请核对` };
		}
		return { ok: true };
	});
}

/**
 * 把非当月的顶层每日文件归档进 daily/YYYY-MM.md。
 *
 * @param {string} root 记忆根。
 * @param {object} [options]
 * @param {string} [options.today] 判定"当月"的基准日（YYYY-MM-DD）；缺省 localDateStr()。
 * @returns {Promise<{archived: {day: string, month: string, bytes: number}[], skipped: {day: string, reason: string}[], errors: {day: string, month: string, stage: string, message: string, code?: string}[]}>}
 *   `bytes` 是源文件原始字节数（搬移量）。只读失败/写入失败/删除配对失败都
 *   保留原文件并进 `errors`；参数非法才抛 TypeError。
 */
export async function archiveDailyMonths(root, { today } = {}) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a non-empty path');
	let currentDay = today === undefined ? localDateStr() : today;
	if (typeof currentDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(currentDay.trim())) {
		throw new TypeError(`today must be YYYY-MM-DD（收到：${String(currentDay).slice(0, 24)}）`);
	}
	currentDay = currentDay.trim();
	const currentMonth = currentDay.slice(0, 7);
	const result = { archived: [], skipped: [], errors: [] };

	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if (err?.code === 'ENOENT') return result; // 根还不存在：无事可归
		result.errors.push({ day: '', month: '', stage: 'enumerate', message: `记忆根无法枚举（${err?.code ?? 'unknown'}），本轮未归档任何文件` });
		return result;
	}

	const byMonth = new Map();
	for (const entry of entries) {
		if (!entry.isFile() || !DAILY_FILE_RE.test(entry.name)) continue;
		const day = entry.name.slice(0, 10);
		const month = day.slice(0, 7);
		if (month >= currentMonth) {
			result.skipped.push({ day, reason: month === currentMonth ? 'current_month' : 'future_month' });
			continue;
		}
		// mtime < 24h 的文件跳过（防跨月 capture 竞态）：一份"上个月的"文件
		// 若最近还在被写（如采集通道补充、外部修正），它仍处于活跃写入窗口，
		// 立即归档可能与并发写入交错。下一轮定时器（6h）会再次处理它。
		try {
			const info = await stat(path.join(root, entry.name));
			if (Date.now() - info.mtimeMs < MTIME_GUARD_MS) {
				result.skipped.push({ day, reason: 'mtime_fresh' });
				continue;
			}
		} catch (err) {
			result.errors.push({ day, month, stage: 'stat', message: `源文件 ${entry.name} 状态读取失败（${err?.code ?? 'unknown'}），本轮未归档` });
			continue;
		}
		if (!byMonth.has(month)) byMonth.set(month, []);
		byMonth.get(month).push({ day, name: entry.name, path: path.join(root, entry.name) });
	}

	for (const month of [...byMonth.keys()].sort()) {
		const sources = [];
		for (const s of byMonth.get(month).sort((a, b) => a.day.localeCompare(b.day))) {
			try {
				sources.push({ ...s, text: await readFile(s.path, 'utf8') });
			} catch (err) {
				if (err?.code === 'ENOENT') result.skipped.push({ day: s.day, reason: 'source_missing' });
				else result.errors.push({ day: s.day, month, stage: 'read', message: `源文件 ${s.name} 读取失败（${err?.code ?? 'unknown'}），本轮未归档` });
			}
		}
		if (!sources.length) continue;
		// 同一归档路径的读-改-写在进程内串行，避免并发归档互相丢追加。
		await withPathLock(path.join(root, 'daily', `${month}.md`), async () => {
			const archPath = path.join(root, 'daily', `${month}.md`);
			let existing;
			try {
				existing = await readIfExists(archPath);
			} catch (err) {
				for (const s of sources) result.errors.push({ day: s.day, month, stage: 'read_archive', message: `归档件 daily/${month}.md 读取失败（${err?.code ?? 'unknown'}），本轮未归档，源文件保留` });
				return;
			}
			const existingDays = new Set(existing ? [...existing.matchAll(/^###\s*\[(\d{4}-\d{2}-\d{2})\]/gm)].map((m) => m[1]) : []);
			const pending = [];
			for (const s of sources) {
				if (existingDays.has(s.day)) result.skipped.push({ day: s.day, reason: 'already_archived' });
				else pending.push(s);
			}
			if (!pending.length) return;
			const addition = buildAddition(pending);
			const archiveText = existing === undefined ? archiveHeader(month) + addition : appendArchiveText(existing, addition);
			const bytesBefore = existing === undefined ? 0 : Buffer.byteLength(existing, 'utf8');
			try {
				await writeText(archPath, archiveText, { memoryRoot: root, tool: TOOL });
			} catch (err) {
				for (const s of pending) result.errors.push({ day: s.day, month, stage: 'write_archive', message: `归档件 daily/${month}.md 写入失败：${err?.message ?? String(err)}`, ...(err?.code ? { code: err.code } : {}) });
				return; // 源文件保留
			}
			// 前后字节校验：归档件确实落盘为预期内容（长度至少增加、内容与
			// 计算一致）。校验不过就视为写失败，源文件全部保留。
			try {
				const written = await readFile(archPath, 'utf8');
				const bytesAfter = Buffer.byteLength(written, 'utf8');
				if (written !== archiveText) throw new Error(`归档件内容与预期不一致（before=${bytesBefore}B, after=${bytesAfter}B）`);
			} catch (err) {
				for (const s of pending) result.errors.push({ day: s.day, month, stage: 'verify_archive', message: `归档件 daily/${month}.md 写后校验失败：${err?.message ?? String(err)}`, ...(err?.code ? { code: err.code } : {}) });
				return; // 源文件保留
			}
			for (const s of pending) {
				const del = await deleteArchivedSource(root, s, `daily/${month}.md`);
				if (del.ok) result.archived.push({ day: s.day, month, bytes: Buffer.byteLength(s.text, 'utf8') });
				else result.errors.push({ day: s.day, month, stage: del.stage, message: del.message, ...(del.code ? { code: del.code } : {}) });
			}
		});
	}
	return result;
}

/**
 * 从按月归档里读取某一天的日节（只读）。
 * @returns {Promise<{month: string, file: string, date: string, text: string}|undefined>}
 */
export async function readArchivedDay(root, date) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a non-empty path');
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return undefined;
	date = date.trim();
	const month = date.slice(0, 7);
	const file = path.join(root, 'daily', `${month}.md`);
	let text;
	try {
		text = await readIfExists(file);
	} catch {
		return undefined; // 归档件状态未知时如实放弃，不猜
	}
	if (text === undefined) return undefined;
	const section = extractDaySection(text, date);
	return section === undefined ? undefined : { month, file, date, text: section };
}

/**
 * 最新归档文件的最新日节（只读）。
 * @returns {Promise<{month: string, file: string, date: string, text: string}|undefined>}
 */
export async function latestArchivedDay(root) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a non-empty path');
	let names = [];
	try {
		names = (await readdir(path.join(root, 'daily'))).filter((n) => ARCHIVE_NAME_RE.test(n)).sort().reverse();
	} catch {
		return undefined; // 无归档目录
	}
	for (const name of names) {
		const file = path.join(root, 'daily', name);
		let text;
		try {
			text = await readIfExists(file);
		} catch {
			continue; // 该归档状态未知，看下一个
		}
		if (text === undefined) continue;
		const days = [...text.matchAll(/^###\s*\[(\d{4}-\d{2}-\d{2})\]/gm)].map((m) => m[1]).sort();
		if (!days.length) continue;
		const section = extractDaySection(text, days[days.length - 1]);
		if (section === undefined) continue;
		return { month: name.slice(0, 7), file, date: days[days.length - 1], text: section };
	}
	return undefined;
}
