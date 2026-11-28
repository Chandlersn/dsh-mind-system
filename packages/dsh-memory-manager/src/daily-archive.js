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
 * ## 5.30.0 · rename-first primitive (`archiveDayRenameFirst`)
 *
 * The channel above ends in a `read` + `unlink` on the live source path, so an
 * independent writer that appends between the final read and the unlink loses
 * its bytes while the caller still reports success. `archiveDayRenameFirst`
 * removes that window: it moves the directory entry with `fs.rename` (atomic on
 * one filesystem), merges the moved bytes into the month file, and only then
 * removes the staged copy. A writer that already holds a handle keeps writing
 * to the same inode, now reachable at the staging path; a writer that opens the
 * old path afterwards creates a fresh file, which is new data and is left
 * alone. Anything this function cannot prove (already-present day with
 * different bytes, an unsettled staged file, an unreadable archive) stops the
 * run with `manual_reconcile_required` and keeps the bytes on disk.
 * `AUTO_DAILY_ARCHIVE_ENABLED` stays false: this is a primitive, not a trigger.
 *
 * @module src/daily-archive
 */
import { lstat, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localDateStr, readIfExists, withPathLock, withWriteCommitLock, writeText } from './util.js';
import { recordDeleteEvent } from './write-ledger.js';
import { redactSecrets } from './secrets.js';

/** Automatic scheduling is paused until cross-process deletion is safe. */
export const AUTO_DAILY_ARCHIVE_ENABLED = false;

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
	].join('\n');
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

/** Parse archive boundaries without interpreting fenced code as headings. */
export function parseArchiveBoundaries(text) {
	const lines = String(text ?? '').split('\n');
	const boundaries = [];
	const seen = new Set();
	let fence = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, '');
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
			continue;
		}
		if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
		const day = /^###\s+\[(\d{4}-\d{2}-\d{2})\]\s*$/.exec(line);
		if (day) {
			if (seen.has(day[1])) return { status: 'ambiguous', reason: 'duplicate_day' };
			seen.add(day[1]);
			boundaries.push({ line: i, day: day[1] });
		} else if (/^###\s*\[/.test(line)) {
			return { status: 'ambiguous', reason: 'malformed_day_heading' };
		} else if (/^##\s+周\s+\d{4}-W\d{2}（\d{2}-\d{2} ~ \d{2}-\d{2}）\s*$/.test(line)) {
			boundaries.push({ line: i });
		} else if (/^##\s+周\s+\d{4}-W/.test(line)) {
			return { status: 'ambiguous', reason: 'malformed_week_heading' };
		}
	}
	if (fence) return { status: 'ambiguous', reason: 'unclosed_fence' };
	return { status: 'parsed', lines, boundaries };
}

function parseDaySection(text, date) {
	const parsed = parseArchiveBoundaries(text);
	if (parsed.status !== 'parsed') return parsed;
	const { lines, boundaries } = parsed;
	const days = boundaries.filter((entry) => entry.day).map((entry) => entry.day);
	const index = boundaries.findIndex((entry) => entry.day === date);
	if (index < 0) return { status: 'missing', reason: 'day_missing', days };
	const start = boundaries[index].line;
	const end = boundaries[index + 1]?.line ?? lines.length;
	const section = lines.slice(start, end).join('\n').trimEnd();
	const body = lines.slice(start + 1, end).join('\n');
	return { status: body.trim() ? 'found' : 'empty', text: section, days };
}

function extractDaySection(text, date) {
	const parsed = parseDaySection(text, date);
	return parsed.status === 'found' || parsed.status === 'empty' ? parsed.text : undefined;
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

	// Check every candidate month before modifying any archive in this run.
	for (const month of [...byMonth.keys()].sort()) {
		const archPath = path.join(root, 'daily', `${month}.md`);
		try {
			const existing = await readIfExists(archPath);
			const parsed = existing === undefined ? null : parseDaySection(existing, '');
			if (parsed?.status === 'ambiguous') {
				for (const s of byMonth.get(month)) result.errors.push({ day: s.day, month, stage: 'read_archive', code: 'MEMORY_ARCHIVE_AMBIGUOUS', message: `归档件 daily/${month}.md 结构不明确（${parsed.reason}），本轮未归档，源文件保留` });
			}
		} catch (err) {
			for (const s of byMonth.get(month)) result.errors.push({ day: s.day, month, stage: 'read_archive', code: err?.code, message: `归档件 daily/${month}.md 读取失败（${err?.code ?? 'unknown'}），本轮未归档，源文件保留` });
		}
	}
	if (result.errors.length) return result;

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
			const parsed = existing === undefined ? null : parseDaySection(existing, '');
			if (parsed?.status === 'ambiguous') {
				for (const s of sources) result.errors.push({ day: s.day, month, stage: 'read_archive', code: 'MEMORY_ARCHIVE_AMBIGUOUS', message: `归档件 daily/${month}.md 结构不明确（${parsed.reason}），未归档，源文件保留` });
				return;
			}
			const existingDays = new Set(parsed?.days ?? []);
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
export async function readArchivedDayStrict(root, date) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a non-empty path');
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return { status: 'invalid', reason: 'invalid_date' };
	date = date.trim();
	const parsedDate = new Date(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) return { status: 'invalid', reason: 'invalid_date' };
	const month = date.slice(0, 7);
	const file = path.join(root, 'daily', `${month}.md`);
	let text;
	try {
		text = await readIfExists(file);
	} catch (error) {
		return { status: 'unavailable', reason: 'read_failed', code: error?.code ?? 'unknown', month, file, date };
	}
	if (text === undefined) return { status: 'missing', reason: 'archive_missing', month, file, date };
	return { ...parseDaySection(text, date), month, file, date };
}

export async function readArchivedDay(root, date) {
	const result = await readArchivedDayStrict(root, date);
	if (result.status !== 'found' && result.status !== 'empty') return undefined;
	return { month: result.month, file: result.file, date: result.date, text: result.text };
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
		const parsed = parseDaySection(text, '');
		if (parsed.status === 'ambiguous') return undefined;
		const days = parsed.days.sort();
		if (!days.length) continue;
		const section = extractDaySection(text, days[days.length - 1]);
		if (section === undefined) continue;
		return { month: name.slice(0, 7), file, date: days[days.length - 1], text: section };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Rename-first archive protocol (5.30.0)
// ---------------------------------------------------------------------------

/** Staging directory, inside the memory root, for moved-not-yet-merged days. */
const STAGE_DAILY_REL = '.stage/daily-archive';
/** Shape of a staging file name this module creates: `<date>.<uuid>.moved`. */
const STAGED_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.moved$/;
/** Upper bound on bytes merged from one staged day (a daily log, not a corpus). */
const MAX_DAY_BYTES = 1024 * 1024;
/** Upper bound on the archive file read back for merge (append-only month file). */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** Upper bound when reading the live source for validation before the rename. */
const MAX_SOURCE_BYTES = 1024 * 1024;
/** How long to watch the staged file for a pre-rename handle still writing. */
const SETTLE_MS = 120;
/** Poll interval while watching the staged file settle. */
const SETTLE_POLL_MS = 20;

/** Structured outcome for expected conditions; never thrown. */
function outcome(status, detail = {}) {
	return { status, ok: status === 'archived' || status === 'already_archived', ...detail };
}

/** True when `date` is a real calendar day in YYYY-MM-DD form. */
function isValidDate(date) {
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Convert a staged day's bytes into the text appended under `### [date]`.
 * The strict parser treats `###`+`[...]` and `## 周 …` as structure, so a
 * source body that contains such lines must not be spliced in unexamined:
 * that would either create a duplicate day heading or a malformed week
 * heading and make the whole month file `ambiguous` (unreadable for every
 * day in it). Such a body is reported instead of guessed at.
 *
 * @returns {{ok: true, body: string} | {ok: false, reason: string}}
 */
function stagedBodyForMerge(text, date) {
	const lines = stripH1(String(text ?? '')).replace(/\r\n/g, '\n').split('\n');
	let fence = null;
	for (const raw of lines) {
		const line = raw.replace(/\r$/, '');
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
			continue;
		}
		if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
		// A day heading of ANY date inside the body would collide with the
		// heading this function writes; the month file must keep one section
		// per day and the parser rejects duplicates outright.
		if (/^###\s*\[/.test(line)) return { ok: false, reason: 'body_contains_day_heading' };
		if (/^##\s+周\s/.test(line)) return { ok: false, reason: 'body_contains_week_heading' };
	}
	if (fence) return { ok: false, reason: 'body_has_unclosed_fence' };
	const body = lines.join('\n').trimEnd();
	return body.trim() ? { ok: true, body } : { ok: false, reason: 'body_is_empty' };
}

/**
 * Build the exact bytes to append for one day under its ISO week section.
 * Byte-for-byte the shape `readArchivedDayStrict` expects: an optional week
 * heading, then `### [date]`, a blank line, the body, and a trailing blank line.
 *
 * @param {string} date `YYYY-MM-DD`.
 * @param {string} body Merged body.
 * @param {boolean} [omitWeekHeading] True when the archive's last week heading
 *   is already this day's week: repeating it would leave two identical
 *   `## 周 …` headings in one file (parseable, but not what the batch channel
 *   produces, and needlessly ambiguous to a reader).
 */
function buildDayAddition(date, body, omitWeekHeading = false) {
	const wk = isoWeekOf(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
	const key = `${wk.isoYear}-W${pad2(wk.week)}`;
	const daySection = `### [${date}]\n\n${body}\n\n`;
	return omitWeekHeading ? daySection : `## 周 ${key}（${date.slice(5, 10)} ~ ${date.slice(5, 10)}）\n\n${daySection}`;
}

/** The week key (`YYYY-Www`) of the last `## 周 …` heading, if it is well formed. */
function lastWeekKeyOf(text) {
	let last = null;
	for (const line of String(text ?? '').split('\n')) {
		const m = /^##\s+周\s+(\d{4}-W\d{2})（\d{2}-\d{2} ~ \d{2}-\d{2}）\s*$/.exec(line.replace(/\r$/, ''));
		if (m) last = m[1];
	}
	return last;
}

/** Pick the staging file for `date`, or list every staged file for that date. */
async function listStaged(root, date) {
	const dir = path.join(root, ...STAGE_DAILY_REL.split('/'));
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { dir, entries: [] };
		return { dir, error: error?.code ?? 'unknown', entries: [] };
	}
	const entries = [];
	for (const name of names) {
		const m = STAGED_NAME_RE.exec(name);
		if (!m || m[1] !== date) continue;
		entries.push({ name, path: path.join(dir, name) });
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return { dir, entries };
}

/** Bounded read of a regular file; refuses non-files and oversized bodies. */
async function readBounded(file, maxBytes) {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if (error?.code === 'ENOENT') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	if (info.isSymbolicLink()) return { status: 'invalid_source', reason: 'symlink' };
	if (!info.isFile()) return { status: 'invalid_source', reason: 'not_regular_file' };
	if (info.size > maxBytes) return { status: 'read_failed', reason: 'too_large', bytes: info.size };
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	// Re-check after the read: the path may have been swapped for a link.
	try {
		const again = await lstat(file);
		if (again.isSymbolicLink() || !again.isFile()) return { status: 'invalid_source', reason: 'changed_during_read' };
		if (again.size !== info.size || again.mtimeMs !== info.mtimeMs) return { status: 'settling', text, bytes: again.size };
	} catch (error) {
		if (error?.code === 'ENOENT') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	return { status: 'ok', text, bytes: info.size };
}

/**
 * Wait for a moved file to stop changing, then return a stable snapshot.
 *
 * A writer that opened the source before the rename keeps its handle on the
 * same inode; its bytes land at the staging path. Those bytes are the whole
 * point of this protocol, so the read is repeated: two consecutive samples
 * with the same byte count are treated as stable. A file that never stabilises
 * within the bounded window is reported as `settling`; the caller then KEEPS
 * the staged file instead of merging and deleting, so those bytes are never
 * destroyed.
 *
 * The residual risk is stated honestly rather than papered over: an append
 * that arrives after the stable observation but before the eventual unlink is
 * still possible, because Node exposes no way to prove an inode has no other
 * open handles. The window is small and bounded (see SETTLE_MS), and the
 * staged file is not deleted until the archive has been read back and
 * confirmed — but this is a much smaller window, not zero.
 *
 * @returns {Promise<{status: string, text?: string, bytes?: number}>}
 */
async function settleStaged(file, maxBytes) {
	const deadline = Date.now() + SETTLE_MS;
	let previous = null;
	for (;;) {
		const read = await readBounded(file, maxBytes);
		if (read.status !== 'ok' && read.status !== 'settling') return read;
		const bytes = read.bytes;
		if (previous !== null && previous === bytes) return { status: 'ok', text: read.text, bytes };
		if (Date.now() >= deadline) return { status: 'settling', text: read.text, bytes };
		previous = bytes;
		await delay(SETTLE_POLL_MS);
	}
}

/**
 * Bounded append of one day to `daily/YYYY-MM.md` and verification of bytes.
 *
 * Reads what is there, refuses to touch an `ambiguous` archive, and (when the
 * day is already present) compares the existing section to the staged bytes so
 * a re-run cannot append a second copy. The append goes through `writeText`
 * (atomic rename + ledger record), then the file is read back and the expected
 * text compared byte for byte: only a confirmed match lets the caller delete.
 *
 * @returns {Promise<{status: string, ...}>}
 */
async function mergeIntoArchive(root, date, body) {
	const month = date.slice(0, 7);
	const archivePath = path.join(root, 'daily', `${month}.md`);
	// The archive is written through writeText, which redacts tier-1 material
	// before it reaches disk. Redact the body here as well so the
	// "already present, byte-identical" comparison compares like with like
	// instead of always seeing a difference on any day that held a credential.
	// This mirrors the documented boundary of this module: the archive stores
	// the redacted text, and that is by design, not data loss.
	const archivedBody = redactSecrets(body).text;
	const week = isoWeekOf(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
	const weekKey = `${week.isoYear}-W${pad2(week.week)}`;
	return withPathLock(archivePath, async () => {
		let existing;
		try {
			existing = await readIfExists(archivePath);
			if (existing !== undefined && Buffer.byteLength(existing, 'utf8') > MAX_ARCHIVE_BYTES) {
				return { status: 'read_failed', reason: 'archive_too_large' };
			}
		} catch (error) {
			return { status: 'read_failed', code: error?.code ?? 'unknown' };
		}
		// An empty (or whitespace-only) archive file has no usable header; treat
		// it as absent so the first merge writes the header rather than
		// prepending blank lines that the strict parser would still accept but
		// a reader would find malformed.
		if (existing === undefined || existing.trim() === '') {
			// NOTE: archiveHeader() joins its lines with '' (a pre-existing quirk:
			// the intended blank-line separators do nothing), so its output ends
			// without a newline. Appending through appendArchiveText keeps the
			// week heading on its own line instead of gluing it onto the header's
			// last line. The header bytes themselves are left exactly as the
			// existing channel produces them — changing them is out of scope for
			// this primitive, which must not alter the current channel's output.
			const text = appendArchiveText(archiveHeader(month), buildDayAddition(date, archivedBody));
			try {
				await writeText(archivePath, text, { memoryRoot: root, tool: TOOL });
			} catch (error) {
				return { status: 'write_failed', code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
			}
			let written;
			try { written = await readFile(archivePath, 'utf8'); }
			catch (error) { return { status: 'write_failed', code: error?.code ?? 'unknown', reason: 'verify_read_failed' }; }
			if (written !== text) return { status: 'write_failed', reason: 'verify_mismatch' };
			return { status: 'archived' };
		}
		const parsed = parseDaySection(existing, date);
		if (parsed.status === 'ambiguous') {
			return { status: 'ambiguous_archive', reason: parsed.reason };
		}
		const existingDays = new Set(parsed.days ?? []);
		if (existingDays.has(date)) {
			const section = extractDaySection(existing, date);
			// Only a byte-identical section proves the staged file is that same
			// content; anything else means two different versions exist and a
			// human must decide which one to keep. Never append a second copy.
			if (section !== undefined && section === `### [${date}]\n\n${archivedBody}`.trimEnd()) {
				return { status: 'already_archived', comparable: true };
			}
			return { status: 'manual_reconcile_required', reason: 'day_present_with_different_bytes' };
		}
		// Reuse the existing week section when this day belongs to it: two
		// identical week headings in one file are parseable but wrong.
		const text = appendArchiveText(existing, buildDayAddition(date, archivedBody, lastWeekKeyOf(existing) === weekKey));
		try {
			await writeText(archivePath, text, { memoryRoot: root, tool: TOOL });
		} catch (error) {
			return { status: 'write_failed', code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
		}
		let written;
		try { written = await readFile(archivePath, 'utf8'); }
		catch (error) { return { status: 'write_failed', code: error?.code ?? 'unknown', reason: 'verify_read_failed' }; }
		if (written !== text) return { status: 'write_failed', reason: 'verify_mismatch' };
		return { status: 'archived' };
	});
}

/**
 * Archive one top-level `YYYY-MM-DD.md` by RENAME FIRST, then merge.
 *
 * Protocol:
 * 1. Validate the date and that the source is a regular file directly under
 *    `root` (no symlink, no traversal, bounded size).
 * 2. Any staging file already present for this date is a crash leftover; it is
 *    merged instead of the live source (the moved bytes are the older, more
 *    likely complete ones, and nothing is renamed twice for one date).
 * 3. Otherwise `fs.rename` the source into `.stage/daily-archive/` — atomic on
 *    one filesystem, so the entry moves and the inode keeps its bytes.
 * 4. Settle-read the staged file (a pre-rename handle may still be writing
 *    there) and merge it into `daily/YYYY-MM.md` under `### [YYYY-MM-DD]`.
 * 5. Only after the archive write is read back and confirmed is the staged
 *    file unlinked. Every other path keeps the staged file on disk.
 *
 * Nothing outside this function's own rename is ever deleted: the only unlink
 * targets a staging path this call created or adopted with matching bytes.
 *
 * @param {string} root Memory root.
 * @param {string} date `YYYY-MM-DD` of the day to archive.
 * @param {object} [options]
 * @param {() => string} [options.now] Reserved for callers that need a clock;
 *   unused by the protocol itself (kept so the signature stays stable).
 * @returns {Promise<{status: string, ok: boolean, date: string, month?: string,
 *   archive?: string, staged?: string, bytes?: number, reason?: string,
 *   code?: string, message?: string}>} `status` is one of `archived`,
 *   `already_archived`, `manual_reconcile_required`, `ambiguous_archive`,
 *   `invalid_source`, `not_found`, `read_failed`, `write_failed`.
 *   `ok` is true only for `archived` / `already_archived`.
 *   Nothing is thrown for any of these; a non-string root or a non-string
 *   date also returns `invalid_source` rather than throwing.
 */
export async function archiveDayRenameFirst(root, date, options = {}) {
	if (typeof root !== 'string' || !root.trim()) {
		return outcome('invalid_source', { date: String(date ?? ''), reason: 'invalid_root' });
	}
	const trimmed = typeof date === 'string' ? date.trim() : '';
	if (!isValidDate(trimmed)) {
		return outcome('invalid_source', { date: typeof date === 'string' ? date : String(date ?? ''), reason: 'invalid_date' });
	}
	// `now` is accepted for signature stability; the protocol needs no clock.
	void options;

	const source = path.join(root, `${trimmed}.md`);
	const month = trimmed.slice(0, 7);
	const result = { date: trimmed, month, archive: path.join(root, 'daily', `${month}.md`) };

	// Step 1: validate the source shape before touching anything.
	let sourceInfo;
	try {
		sourceInfo = await lstat(source);
	} catch (error) {
		if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
			return outcome('read_failed', { ...result, code: error?.code ?? 'unknown', reason: 'source_stat_failed' });
		}
		sourceInfo = undefined;
	}
	if (sourceInfo !== undefined) {
		if (sourceInfo.isSymbolicLink()) return outcome('invalid_source', { ...result, reason: 'source_is_symlink' });
		if (!sourceInfo.isFile()) return outcome('invalid_source', { ...result, reason: 'source_not_regular_file' });
		if (sourceInfo.size > MAX_SOURCE_BYTES) {
			return outcome('read_failed', { ...result, reason: 'source_too_large', bytes: sourceInfo.size });
		}
	}

	// Step 2: adopt a crash leftover for this date rather than re-staging.
	let staged;
	const listing = await listStaged(root, trimmed);
	if (listing.error !== undefined) {
		return outcome('read_failed', { ...result, code: listing.error, reason: 'staging_dir_unreadable' });
	}
	if (listing.entries.length > 1) {
		// Two staged copies for one date: which one is complete is not knowable
		// here, and picking one could drop the other's bytes. Stop.
		return outcome('manual_reconcile_required', {
			...result,
			reason: 'multiple_staged_copies',
			staged: listing.entries.map((e) => e.path),
		});
	}
	if (listing.entries.length === 1) {
		staged = listing.entries[0].path;
	} else if (sourceInfo === undefined) {
		return outcome('not_found', result);
	} else {
		// Step 3: the atomic move. The source entry disappears in the same step
		// the staged entry appears, so a concurrent appender holding an open
		// handle keeps writing to these bytes at the new path.
		const stageDir = listing.dir;
		try {
			await mkdir(stageDir, { recursive: true });
		} catch (error) {
			return outcome('write_failed', { ...result, code: error?.code ?? 'unknown', reason: 'staging_dir_create_failed' });
		}
		staged = path.join(stageDir, `${trimmed}.${randomUUID()}.moved`);
		let renamed = false;
		try {
			await rename(source, staged);
			renamed = true;
		} catch (error) {
			if (error?.code === 'ENOENT') return outcome('not_found', result);
			// A failed rename may still have moved the entry (the error can be a
			// lost acknowledgement). Only an unchanged source proves it did not.
			let stillThere = false;
			try { stillThere = (await lstat(source)).isFile(); } catch { stillThere = false; }
			if (stillThere) {
				return outcome('write_failed', { ...result, code: error?.code ?? 'unknown', reason: 'rename_failed' });
			}
			// The source is gone but the staging path is unknown: report, keep
			// whatever exists, and let the next run adopt any leftover.
			let moved = false;
			try { moved = (await lstat(staged)).isFile(); } catch { moved = false; }
			if (!moved) {
				return outcome('manual_reconcile_required', {
					...result,
					reason: 'rename_outcome_unknown',
					code: error?.code ?? 'unknown',
					staged,
				});
			}
			renamed = true;
		}
		if (!renamed) return outcome('manual_reconcile_required', { ...result, reason: 'rename_outcome_unknown', staged });
	}

	// Step 4: settle-read the moved bytes and merge them.
	const read = await settleStaged(staged, MAX_DAY_BYTES);
	if (read.status === 'invalid_source') {
		return outcome('manual_reconcile_required', { ...result, staged, reason: read.reason ?? read.status });
	}
	if (read.status === 'not_found') {
		// The staged file vanished between rename and read. That is not ours to
		// recreate; the archive may or may not contain it.
		return outcome('manual_reconcile_required', { ...result, staged, reason: 'staged_vanished' });
	}
	if (read.status === 'settling') {
		return outcome('manual_reconcile_required', { ...result, staged, reason: 'staged_never_settled' });
	}
	if (read.status !== 'ok') {
		return outcome('read_failed', { ...result, staged, code: read.code, reason: read.reason ?? 'staged_read_failed' });
	}
	const body = stagedBodyForMerge(read.text, trimmed);
	if (!body.ok) {
		return outcome('manual_reconcile_required', { ...result, staged, reason: body.reason });
	}
	const merged = await mergeIntoArchive(root, trimmed, body.body);
	if (merged.status !== 'archived' && merged.status !== 'already_archived') {
		return outcome(merged.status === 'ambiguous_archive' ? 'ambiguous_archive' : merged.status, {
			...result,
			staged,
			...(merged.reason ? { reason: merged.reason } : {}),
			...(merged.code ? { code: merged.code } : {}),
			...(merged.message ? { message: merged.message } : {}),
		});
	}

	// Step 5: bytes are confirmed in the archive; the staging copy may go.
	// Only this exact path (created or adopted above) is unlinked.
	try {
		await unlink(staged);
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			// The archive is complete and the bytes are safe; the leftover
			// staging file is a duplicate, and a re-run adopts it and reports
			// already_archived. Report as archived, naming the leftover.
			return outcome(merged.status, {
				...result,
				staged,
				bytes: read.bytes,
				stagedRemoved: false,
				stagedCleanupCode: error?.code ?? 'unknown',
			});
		}
	}
	return outcome(merged.status, { ...result, staged, bytes: read.bytes, stagedRemoved: true });
}
