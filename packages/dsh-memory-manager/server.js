/**
 * dsh-memory-manager — long-term memory for the DeepSeek Harness.
 *
 * Adapted from lantern's `memory-function-org` skill. The memory root holds:
 *   functions/    = per-feature iteration history (date as tag, append-only blocks)
 *   insights/     = transferable principles distilled UP from features (backlinked)
 *   capabilities/ = external tool ledger (what can I call, and how)
 *   skills/       = crystallized procedures (candidate → active → retired)
 *   MEMORY.md     = the index: four one-line-summary tables + consensus + env constants
 *   YYYY-MM-DD.md = the RAW daily layer (free-form, model-maintained)
 *
 * The memory tools (see the registration list in apply() — it is the single
 * source of truth for the count), an injected discipline section, a budgeted
 * pre-step recall hook (RRF-fused ranking + decision repair), and a read-only
 * HTTP API (`/api/memory-org/*`) consumed by the bundled Web panel.
 *
 * This file is the plugin ENTRY (apply + tool registration + hooks). The pure
 * layers live in ./src — see the import block below for the map.
 *
 * @module dsh-memory-manager
 */
import { readFile, writeFile, rename, link, unlink, rm, mkdir, readdir, stat, lstat, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { recordDeleteEvent, recordWrite, readLedger, ledgerKey, isTracked, contentHash } from './src/write-ledger.js';
// ---------------------------------------------------------------------------
// shared layers — the plugin is a folder, not one 3.5k-line file
// ---------------------------------------------------------------------------
//   constants.js — table headings, size caps, lifecycle vocabularies
//   util.js      — dates, atomic write, slugs, block parsing, root resolution
//   usage.js     — the .usage.jsonl usage-signal ledger
//   markdown.js  — file templates + index/section surgery
//   recall.js    — pre-step ranking + full-text search
//   host.js      — DSH install discovery and lazy Host binding
import {
	localDateStr, normDate, oneLine, charLen, readIfExists, writeText, statExists, safeSlug,
	splitIterationBlocks, dshHome, joinDshHome, resolveRoot, appendBlock, countHeadingDate, withPathLock, withWriteCommitLock, MemoryWriteCommitUnknown, MemoryLedgerAppendError, MemoryStageOutcomeUnknown,
} from './src/util.js';
import { usagePath, appendUsage, readUsage, summarizeUsage, insightTrust, trustLineFor, refreshTrustLine, canonicalHref } from './src/usage.js';
import {
	memoryIndexTemplate, functionFileTemplate, dailyTemplate, insightTemplate, sepOf,
	upsertIndexRow, appendUnderHeading, refreshSummarySection, replaceSection,
	dropIndexRow, rowSlug,
} from './src/markdown.js';
import { selfReload, isReloading } from './src/reload.js';
import { createWriteGuard } from './src/write-guard.js';
import { withMemoryRootTransaction } from './src/root-transaction.js';
import { selectCaptureEvents } from './src/capture-events.js';
import { captureSelectedEvents } from './src/capture-service.js';
import { inspectCaptureIntent } from './src/capture-intent.js';
import { archiveDailyMonths, readArchivedDay, latestArchivedDay } from './src/daily-archive.js';
import { createCaptureStatus } from './src/capture-status.js';
import { tokensOf, matchIndexRows, buildRecallMessage, buildBudgetedRecall, skillNameOf, archiveBlocks, eligibleIndexRows, RECALL_BUDGET_TOKENS } from './src/recall.js';
import { redactSecrets, scanSecrets } from './src/secrets.js';
import { gateDao, gateFa, concreteMarkersOf, MIN_DAO_SOURCES, MAX_DAO_ENTRIES, daoSourceSlugs, daoReservedHeadingCollisions } from './src/layer-gate.js';
// 层级自检（2026-11-02 用户要求）：落盘后回读产物，按该层自己的定义核一遍。
// 与 layer-gate（写入前准入）分工：准入看输入，自检看**磁盘上的产物**。
import { checkArtifact, selfCheckLine, selfCheckWarnings } from './src/layer-selfcheck.js';
import { checkDaoBody, philosophicalShape } from './src/dao-shape.js';
// 候选公理（2026-11-10 用户要求）：agent 升华 → 用户决策。
import { AXIOM_CANDIDATE_STATES, confirmAxiomCandidate, rejectAxiomCandidate, describeCandidate } from './src/axiom-candidate.js';
// 阀门桥（2026-11-09）：对 dsh-valves 的可选依赖——负向规则召回注入 + 上行评估留痕。
// 缺 valves 时全部返回 undefined，既有行为一分不变（N4 降级）。
import { relevantNegativeRules, recordUpwardWrite, upwardEntryFromWrite } from './src/valves-bridge.js';

// Keep unlink and its intent/completion records ordered with writeText commits in
// this process. Disk and ledger remain separate writes: incomplete intent is
// surfaced by R26, never treated as a completed deletion.
export async function deleteTrackedFile(root, file, expectedText, { tool, to, writeEvent = recordDeleteEvent } = {}) {
	const key = ledgerKey(root, file);
	if (!isTracked(key)) throw new Error(`拒绝登记无效删除路径：${key}`);
	return withWriteCommitLock(file, async () => {
		const before = await readLedger(root);
		if (before === undefined) throw new Error(`账本不可读或损坏，未删除 ${key}`);
		if (before.get(key)?.op === 'delete_intent') throw new Error(`先前删除未完成，未删除 ${key}`);
		const current = await readFile(file, 'utf8');
		if (current !== expectedText) throw new Error(`${key} 在操作期间发生变化，未删除；目标可能已经写入`);
		const id = randomUUID();
		const event = { key, id, tool, ...(to ? { to } : {}) };
		let intentConfirmed = false;
		try { intentConfirmed = await writeEvent(root, { ...event, op: 'delete_intent' }); } catch { /* outcome remains unknown */ }
		if (!intentConfirmed) {
			const err = new Error(`删除尚未执行，但 ${key} 的删除意图记账结果未知（意图 ${id}）；请先核对文件和账本，不要盲目重试。`);
			err.code = 'MEMORY_DELETE_INTENT_UNKNOWN'; err.intentId = id; err.deleteStatus = 'not_started'; err.ledgerStatus = 'unknown';
			throw err;
		}
		let currentAfterIntent;
		try { currentAfterIntent = await readFile(file, 'utf8'); }
		catch (cause) { throw new Error(`${key} 已记录删除意图 ${id}，删除尚未执行；请先核对文件和账本，不要盲目重试。`, { cause }); }
		if (currentAfterIntent !== expectedText) throw new Error(`${key} 在记录意图期间发生变化，未删除；账本保留未完成意图`);
		try { await unlink(file); } catch (cause) {
			const err = new Error(`${key} 删除结果未知，文件可能已删除；账本保留未完成意图 ${id}。请先核对文件和账本，不要盲目重试。`, { cause });
			err.code = 'MEMORY_DELETE_OUTCOME_UNKNOWN'; err.intentId = id; err.deleteStatus = 'unknown'; err.ledgerStatus = 'pending';
			throw err;
		}
		let completionConfirmed = false;
		try { completionConfirmed = await writeEvent(root, { ...event, op: 'delete' }); } catch { /* acknowledgement may be lost */ }
		if (!completionConfirmed) {
			const err = new Error(`${key} 已删除，但完成事件记账结果未知（意图 ${id}）；请先核对账本，不要盲目重试。`);
			err.code = 'MEMORY_DELETE_LEDGER_UNKNOWN'; err.intentId = id; err.deleteStatus = 'deleted'; err.ledgerStatus = 'unknown';
			throw err;
		}
		const after = await readLedger(root);
		if (after?.get(key)?.op !== 'delete' || after.get(key).id !== id) throw new Error(`${key} 已删除，但账本出现并发或损坏，状态未知`);
	});
}

export async function writeRenameTarget(root, file, expected, text) {
	const key = ledgerKey(root, file);
	const redacted = redactSecrets(text).text;
	const tmp = `${file}.rename-${randomUUID()}.tmp`;
	try { await writeFile(tmp, redacted, { encoding: 'utf8', flag: 'wx' }); }
	catch (cause) { throw new MemoryStageOutcomeUnknown(tmp, cause); }
	try {
		return await withWriteCommitLock(file, async () => {
			const ledger = await readLedger(root);
			if (ledger === undefined || ledger.get(key)?.op === 'delete_intent') throw new Error('账本不可读、损坏或目标有未完成删除，未写入目标');
			let current;
			try { current = await readFile(file, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
			if (current !== expected) throw new Error(`${key} 在操作期间发生变化，未覆盖；源文件尚未删除`);
			try { await rename(tmp, file); }
			catch (cause) { const err = new MemoryWriteCommitUnknown(file, cause); err.ledgerStatus = 'not_attempted'; throw err; }
			try {
				if (!(await recordWrite(root, { key, hash: contentHash(redacted), tool: 'memory_rename' }))) throw new MemoryLedgerAppendError(file, key);
			} catch (cause) {
				if (cause instanceof MemoryLedgerAppendError) throw cause;
				throw new MemoryLedgerAppendError(file, key, cause);
			}
			let stagePresent = false;
			try { await lstat(tmp); stagePresent = true; }
			catch (cause) {
				if (cause?.code !== 'ENOENT') {
					const err = new Error(`目标已写入并记账，但暂存路径无法检查（${tmp}）；请先核对，不要盲目重试。`, { cause });
					err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'recorded'; throw err;
				}
			}
			if (stagePresent) {
				const err = new Error(`目标已写入并记账，原暂存路径现有文件（${tmp}），归属未知；请先核对，不要盲目重试。`);
				err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'recorded'; throw err;
			}
		});
	} catch (err) {
		// The stage pathname may have been reused after rename or replaced while
		// the commit was pending; its current ownership cannot be inferred.
		err.cleanupStatus = 'unknown';
		err.stagePath = tmp;
		err.message += ` 暂存路径状态未知（${tmp}），未自动清理；请先核对，不要盲目重试。`;
		throw err;
	}
}

// A panel archive or promotion has already been committed before source deletion.
async function deleteAfterPanelCopy(root, file, text, options) {
	try { return await deleteTrackedFile(root, file, text, options); }
	catch (cause) {
		const err = new Error(`目标 ${options.to} 已写入；${cause?.message ?? String(cause)}`, { cause });
		for (const key of ['code', 'intentId', 'deleteStatus', 'ledgerStatus']) if (cause?.[key] !== undefined) err[key] = cause[key];
		throw err;
	}
}

// Panel-created archives previously bypassed the write ledger. Keep exclusive
// creation semantics when requested and report a failed append after disk write.
async function writeTrackedPanelFile(root, file, text, { exclusive = false, tool } = {}) {
	const key = ledgerKey(root, file);
	if (!isTracked(key)) throw new Error(`拒绝登记无效写入路径：${key}`);
	return withWriteCommitLock(file, async () => {
		const ledger = await readLedger(root);
		if (ledger === undefined || ledger.get(key)?.op === 'delete_intent') throw new Error(`账本不可读、损坏或目标有未完成删除，未写入 ${key}`);
		if (exclusive && await statExists(file)) {
			const error = new Error(`目标已存在，未写入 ${key}`); error.code = 'EEXIST'; throw error;
		}
		// Stage the entire body beside the destination. link() commits without
		// overwriting an existing archive; a partial stage is never visible there.
		const tmp = `${file}.stage-${randomUUID()}.tmp`;
		let failure;
		let staged = false;
		let committed = false;
		try {
			try { await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' }); staged = true; }
			catch (cause) {
				const err = new Error(`目标 ${key} 尚未提交、源文件尚未删除；临时文件写入失败且可能残留，请先核对后处理。`, { cause });
				err.code = 'MEMORY_PANEL_STAGING_FAILED'; err.fileWritten = false; err.ledgerStatus = 'not_attempted'; err.cleanupStatus = 'unknown';
				throw err;
			}
			try {
				if (exclusive) await link(tmp, file);
				else await rename(tmp, file);
				committed = true;
			} catch (cause) { const err = new MemoryWriteCommitUnknown(file, cause); err.ledgerStatus = 'not_attempted'; throw err; }
			try {
				if (!(await recordWrite(root, { key, hash: contentHash(text), tool }))) throw new MemoryLedgerAppendError(file, key);
			} catch (cause) {
				if (cause instanceof MemoryLedgerAppendError) throw cause;
				throw new MemoryLedgerAppendError(file, key, cause);
			}
			if (!exclusive) {
				let stagePresent = false;
				try { await lstat(tmp); stagePresent = true; }
				catch (cause) {
					if (cause?.code !== 'ENOENT') {
						const err = new Error(`目标已提交并记账，但暂存路径无法检查（${tmp}）；请先核对，不要盲目重试。`, { cause });
						err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'recorded'; throw err;
					}
				}
				if (stagePresent) {
					const err = new Error(`目标已提交并记账，原暂存路径现有文件（${tmp}），归属未知；请先核对，不要盲目重试。`);
					err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'recorded'; throw err;
				}
			}
		} catch (err) { failure = err; }
		// A pathname can be replaced even after exclusive creation or a successful
		// link. A separate lstat followed by unlink would still have a race; no
		// portable Node primitive atomically unlinks only the inode we created.
		// Rename consumes its stage on success. For link the stage may remain, so
		// retain it and report partial completion instead of deleting another file.
		if (staged && (failure || exclusive)) {
			if (failure) {
				failure.message += ` 暂存路径清理状态未知（${tmp}），未自动清理；请先核对，不要盲目重试。`;
				failure.cleanupStatus = 'unknown';
				failure.stagePath = tmp;
			} else if (committed) {
				failure = new Error(`目标已提交并记账（${key}），但暂存路径清理状态未知（${tmp}）；源文件尚未删除，请先核对，不要盲目重试。`);
				failure.code = 'MEMORY_PANEL_CLEANUP_UNKNOWN'; failure.fileWritten = true; failure.ledgerStatus = 'recorded'; failure.cleanupStatus = 'unknown'; failure.stagePath = tmp;
			}
		}
		if (failure) throw failure;
	});
}

/**
 * 层级自检结果的输出形状（2026-11-02）。
 *
 * 五个写入工具的回执都带这个字段。**必须在这里声明**：宿主的输出校验是
 * additionalProperties:false 且递归生效 —— 上一次真机调用就是因为 execute
 * 多返回了一个未声明的 selfCheck，整个回执被宿主拒收（写成功了、回执报错，
 * 最容易被误当成“写失败”）。同一条教训在 5.11.3 出现过（trust 字段），
 * 这次是它在自检字段上重演 —— schema 与 execute 的返回必须成对维护。
 *
 * ⚠️ 2026-11-05：这里**不能**写 `required: true`。宿主的 defineTool 编译器把
 * 「属性节点上的 required:true」理解为「该属性必填」，会把 selfCheck 塞进每个
 * 复用本常量的工具的 output 顶层 required 数组。结果：所有不返回 selfCheck 的
 * 分支（list / read / candidates / activate / retire / delete）回执整条被拒。
 * 内部字段的 required:true 保留 —— 那是校验 selfCheck 自身结构，不是声明本属性
 * 必填。两个语义在宿主方言里共用同一个关键字，别混。
 */
const SELF_CHECK_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		ok: { type: 'boolean', required: true },
		layer: { type: 'string', required: true },
		relPath: { type: 'string', required: true },
		findings: {
			type: 'array',
			required: true,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
			},
		},
		notes: {
			type: 'array',
			required: true,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
			},
		},
	},
};

import { isSkillName, registerMemorySkillBridge, parseSkillText, isPublishable, skillAppliesToProject, PROVIDER_NAME } from './src/host-skill.js';
import { resolveDshRoot, setHostRoot, loadHost, defineTool, createUserMessage } from './src/host.js';
// 健康探针与问题收件箱（2026-10-26）：让记忆系统参与插件互查互治，
// 并成为各插件 / agent 投递问题的统一邮箱。
import { createHealthProbe, MemoryInbox } from './health-inbox.js';
import {
	name, inject, DEFAULTS, FUNC_TABLE_HEADING, INSIGHT_TABLE_HEADING, CAP_TABLE_HEADING,
	CAP_TABLE_HEADER, FUNC_TABLE_HEADER, INSIGHT_TABLE_HEADER,
	SKILL_TABLE_HEADING, SKILL_TABLE_HEADER, SKILL_NOMINATE, CAP_DIR, FED_TABLE_HEADING,
	FED_TABLE_HEADER, FED_CONSENSUS_HEADING, DAILY_SECTION, DAILY_OPEN_SECTION, RESULT_LABEL,
	GUARD_MARK, GUARD_LINE, MAX_BLOCK_CHARS, MAX_ROW_SUMMARY_CHARS, MAX_PRINCIPLE_CHARS,
	MAX_CONSENSUS_CHARS, CONSENSUS_HEADING, LEGACY_TABLE_HEADERS, INSIGHT_BUDGET, VANISHED_FILES_WARN,
	MEMORY_ZONES, FILE_ZONES, INDEXED_ZONES, ZONE_ALT, SEARCH_ZONES, DAO_DIR,
} from './src/constants.js';

// Derived zone matchers — built ONCE from MEMORY_ZONES so a new layer cannot be
// half-wired again (that is exactly how `dao/` ended up writable but unreadable).
const ZONE_RE = new RegExp(`^(${ZONE_ALT})/`); // hrefs inside a file zone
const ZONE_RE_SKILLS = new RegExp(`^(${ZONE_ALT}|skills)/`); // …or a skill bundle
const ZONE_RE_SKILLS_NC = new RegExp(`^(?:${ZONE_ALT}|skills)/`); // no capture
const ZONE_RE_FILE_EXACT = new RegExp(`^(${ZONE_ALT})/[^/]+\\.md$`); // <zone>/<slug>.md
const ZONE_RE_FI = /^(functions|insights)\//; // the two table zones only

// ---------------------------------------------------------------------------
// locating the Host installation
// ---------------------------------------------------------------------------

/**
 * First-party Host packages (`defineTool`, `createUserMessage`) must come from
 * the DSH installation itself.
 *
 * A profile-installed bundle is a pnpm link whose realpath is this source
 * directory, so bare-import resolution from inside it never sees the Host's
 * node_modules. Requiring the exact Host file works: these are ESM modules
 * (Node >= 22.12 `require(esm)`), their own dependencies resolve from the
 * install's flat node_modules, and require(esm) returns the already-cached
 * namespace the Host loaded — one shared instance.
 *
 * The install root is discovered instead of hardcoded so the bundle stays
 * portable. Candidates, in order:
 *   1. plugin config `dshRoot`
 *   2. env `DSH_INSTALL_DIR` / `DSH_ROOT`
 *   3. walking up from the running CLI entry (`process.argv[1]`)
 *   4. walking up from `process.cwd()`
 *   5. walking up from `DSH_PROFILE_DIR`
 *   6. resolving the Host package from this file's own tree (regular installs)
 * A candidate counts only when it really contains the Host package.
 */
// Host discovery + lazy Host binding now live in src/host.js (imported at the
// top of this file).


// Tool identity + every shared constant (table headings, size caps, lifecycle
// vocabularies, DEFAULTS) live in src/constants.js — imported at the top.

/**
 * Build the passive-capture line for one user turn, or null when it should not
 * be recorded (disabled, empty, or already present in today's log). Pure, so the
 * privacy/truncation rules are testable without touching the filesystem.
 */
function captureLineFor(userText, todayLogText, { enabled = false, maxChars = DEFAULTS.captureMaxChars } = {}) {
	if (!enabled) return null;
	const text = String(userText ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return null;
	const line = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	const stamp = `- ${line}`;
	// Exact-duplicate guard: repeating the same request must not pile up lines.
	if (String(todayLogText ?? '').split('\n').some((l) => l.trim() === stamp)) return null;
	return stamp;
}

// (usage signals now live in src/usage.js — imported above)

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------------------
// canonical file templates — now in src/markdown.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// markdown surgery (index rows / sections)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// shared checker pieces (ported from lantern's check_memory.py)
// ---------------------------------------------------------------------------

function stripCode(text) {
	return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

async function checkLinks(text, filePath, root, add) {
	const stripped = stripCode(text);
	const base = path.dirname(filePath);
	const rootAbs = path.resolve(root);
	const seen = new Set();
	const inspectTarget = async (target, source, rel) => {
		try {
			return await statExists(target);
		} catch (err) {
			if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
			add('WARN', 'R10', `链接目标检查失败：${source} -> ${rel}（${err?.code ?? 'unknown'}），目标存在状态未知`);
			return undefined;
		}
	};
	// Slugs may contain spaces (safeSlug only forbids separators); a [^)\s]
	// pattern silently SKIPPED those links, so a dangling spaced href never
	// tripped R10. Match the same surface the writer produces.
	for (const m of stripped.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
		const rel = m[1].split('#')[0].trim();
		if (!rel || rel.startsWith('http') || rel.includes('attachments')) continue;
		const label = () => path.relative(rootAbs, filePath).split(path.sep).join('/') || 'MEMORY.md';
		// A skill index row links to its HOST bundle via file:/// (5.24.0: skills
		// live outside the memory root by design). Resolve the URL and check that
		// the file exists — the dangling half of R10 still matters — but never
		// report it as an escape, because leaving the memory root IS the point.
		if (rel.startsWith('file://')) {
			let abs;
			try {
				abs = fileURLToPath(rel);
			} catch {
				add('FAIL', 'R10', `unparseable file URL in ${label()} -> ${rel}`);
				continue;
			}
			const key = `${filePath}→${abs}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (await inspectTarget(abs, label(), rel) === false) add('FAIL', 'R10', `dangling link in ${label()} -> ${rel}`);
			continue;
		}
		if (rel.startsWith('/')) continue;
		const resolved = path.resolve(base, rel);
		const key = `${filePath}→${resolved}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const exists = await inspectTarget(resolved, label(), rel);
		if (exists === false) add('FAIL', 'R10', `dangling link in ${label()} -> ${rel}`);
		else if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
			add('WARN', 'R10e', `link in ${label()} escapes memory root -> ${rel}${exists === undefined ? '（目标存在状态未知）' : ''}`);
		}
	}
}

/**
 * R21 (memory defence): one file's secrets reported by the health check.
 * Code spans are stripped first — an example token inside a fenced block is
 * documentation, not a leak (Hindsight exempts its own docs the same way).
 * Tier-1 hits mean the write predates the redactor or arrived outside the
 * plugin's write path; tier-2 (ID/phone) is never rewritten anywhere, only
 * reported here.
 */
function scanForSecrets(text, label, add) {
	const findings = scanSecrets(stripCode(text));
	if (!findings.length) return;
	const part1 = findings.filter((f) => f.tier === 1);
	const part2 = findings.filter((f) => f.tier === 2);
	if (part1.length) {
		add('FAIL', 'R21', `${label} 含凭据材料（${part1.map((f) => `${f.kind}×${f.count}`).join('、')}）：写入侧应已 redact——来自插件外的直接写入，请人工清理明文`);
	}
	if (part2.length) {
		add('WARN', 'R21', `${label} 含个人标识（${part2.map((f) => `${f.kind}×${f.count}`).join('、')}）：不自动改写（常属正当事实），确认是否真需要留存`);
	}
}

const REVERSE_DETAIL_FULL = /详见\s*MEMORY\.md[（(][^）)]{2,}[）)]/;
const REVERSE_DETAIL_VAGUE = /详见\s*MEMORY\.md(?!\s*[（(])/;
const DATE_TAG = /^##\s*\[(\d{4})-(\d{2})-(\d{2})/gm;

// ---------------------------------------------------------------------------
// shared health check (memory_check tool + panel API)
// ---------------------------------------------------------------------------

// Keep producer-only identities outside returned objects. Even non-enumerable
// own properties make a host tool result non-lossless JSON and are rejected.
const healthIssueIdentities = new WeakMap();
async function runHealthCheck(root, opts) {
	const results = [];
	const add = (level, rule, message, identity) => {
		const finding = { level, rule, message };
		if (identity) healthIssueIdentities.set(finding, identity);
		results.push(finding);
	};

	const memPath = path.join(root, 'MEMORY.md');
	const memText = await readIfExists(memPath);
	if (memText === undefined) {
		add('FAIL', 'R0', `MEMORY.md not found under ${root}：先用 memory_write 记录第一次迭代`);
		return { root, results, warnCount: 0, failCount: 1 };
	}
	const memSize = byteLen(memText);
	if (memSize > opts.maxIndexHardBytes) add('FAIL', 'R5', `MEMORY.md ${memSize}B > 硬上限 ${opts.maxIndexHardBytes}B`, { subtype: 'index-size', subject: 'MEMORY.md' });
	else if (memSize > opts.maxIndexBytes) add('WARN', 'R5', `MEMORY.md ${memSize}B > 舒适线 ${opts.maxIndexBytes}B`, { subtype: 'index-size', subject: 'MEMORY.md' });

	let emptySummary = 0;
	const longRows = [];
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		// The one-line summary is always the SECOND content cell, in every
		// generation (2-column rows: name/summary; legacy 4-column rows:
		// name/summary/link/extra). A 3-column floor would skip 2-column rows
		// entirely — exactly where an over-long summary would hide.
		if (cells.length < 2) continue;
		if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
		// Strip the link syntax so the check measures the words, not the href.
		// BOTH cells need it: the name cell is a whole link since 5.15.0, and an
		// insight row folds its source areas INTO the summary cell — counting
		// `[x.md](functions/x.md)` as words flags a 34-char sentence as 129.
		const name = cells[0].replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
		const summary = cells[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
		if (!summary) emptySummary++;
		else if (charLen(summary) > MAX_ROW_SUMMARY_CHARS) longRows.push(`${name}（${charLen(summary)} 字）`);
	}
	if (emptySummary) add('WARN', 'R5', `${emptySummary} 个索引行缺少一行摘要（摘要列是索引判断相关性的唯一依据）`);
	if (longRows.length) {
		add('WARN', 'R14', `索引行摘要过长（摘要是一句话，细节应留在功能文件）：${longRows.join('、')}`);
	}

	// R5 scaling: past ~40 function rows a single flat table costs too much to
	// scan. The escape hatch is `### 索引·<域>` sub-sections plus memory_index's
	// `group` argument; flag a big ungrouped table so the split happens before
	// the index gets uncomfortable rather than after.
	{
		const at = memText.indexOf(FUNC_TABLE_HEADING);
		if (at !== -1) {
			const rest = memText.slice(at);
			const stop = rest.indexOf('\n## ', 1);
			const section = stop === -1 ? rest : rest.slice(0, stop);
			const rows = section.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !l.includes('---')).length - 1;
			if (rows > 40 && !section.includes('### 索引·')) {
				add('WARN', 'R5', `功能表已 ${rows} 行（>40）：按「### 索引·<域>」拆分子分区，并在 memory_index 传 group 参数落对表`);
			}
		}
	}

	// R15: duplicated rows / duplicated table sections. The index is a lookup
	// surface; a repeated row (same slug cell) or a repeated table heading makes
	// recall inject the same fact twice and hides which row is authoritative.
	const rowSlugCount = new Map();
	let dupeRows = 0;
	// A grouped index (### 索引·<domain>, see upsertIndexRow's group branch) shares
	// ONE header row across every sub-table by design, so headers are not evidence
	// of a stale duplicate row — skip them before counting slug cells.
	const tableHeaders = new Set([FUNC_TABLE_HEADER, INSIGHT_TABLE_HEADER, CAP_TABLE_HEADER, SKILL_TABLE_HEADER, FED_TABLE_HEADER]);
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|')) continue;
		// The 4-column header generation is still exempt alongside the current
		// 2/3-column one: a root mid-migration carries both, and neither header
		// is evidence of a duplicate row.
		if (tableHeaders.has(s) || LEGACY_TABLE_HEADERS.has(s)) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		// 2 as the floor (name + summary): the 3-column floor would silently skip
		// every 2-column row, which is exactly where a duplicate would hide.
		if (cells.length < 2 || cells.every((c) => /^[-: ]*$/.test(c))) continue;
		const slug = cells[0].replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
		rowSlugCount.set(slug, (rowSlugCount.get(slug) ?? 0) + 1);
	}
	for (const [slug, n] of rowSlugCount) {
		if (n > 1) {
			dupeRows++;
			add('WARN', 'R15', `索引行「${slug}」出现 ${n} 次（同一事实只在一处为真）：确认哪一行是现状，删掉其余行`);
		}
	}
	const headingCount = new Map();
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('## ')) continue;
		headingCount.set(s, (headingCount.get(s) ?? 0) + 1);
	}
	for (const [h, n] of headingCount) {
		if (n > 1) add('WARN', 'R15', `索引小节「${h}」出现 ${n} 次（多为模板换代后锚点失配的兜底产物）：保留第一处，删除其余小节`);
	}

	scanForSecrets(memText, 'MEMORY.md', add);
	await checkLinks(memText, memPath, root, add);

	// R16 (ported from the workbuddy skill's F4): env-constant lines often carry
	// absolute backtick paths (install dirs, DB files, scripts). A moved or
	// renamed path silently poisons every future recall that trusts it — check
	// they still exist. Only the index is scanned: it is the env-constants home.
	const checkedPaths = new Set();
	for (const m of memText.matchAll(/`([^`\n|]+)`/g)) {
		const raw = m[1].trim();
		const pm = /^([A-Za-z]:[\\/].*)$/.exec(raw);
		if (!pm) continue;
		const p = pm[1].replace(/[/\\]+$/, '');
		const key = p.toLowerCase();
		if (checkedPaths.has(key)) continue;
		checkedPaths.add(key);
		try {
			if (!(await statExists(p))) {
				add('WARN', 'R16', `环境常量引用的路径已不存在 -> ${p}（索引里的环境常量被未来召回盲信，确认新路径后更新）`);
			}
		} catch (error) {
			add('WARN', 'R16', `环境常量引用的路径检查失败（${error?.code ?? 'unknown'}），状态未知 -> ${p}`);
		}
	}

	// R19: the consensus section is the highest layer (道层) — a binding constraint
	// lives here, so it must point back at its evidence.
	{
		const at = memText.indexOf(CONSENSUS_HEADING);
		if (at !== -1) {
			const rest = memText.slice(at + CONSENSUS_HEADING.length);
			const stop = rest.indexOf('\n## ');
			const section = stop === -1 ? rest : rest.slice(0, stop);
			for (const raw of section.split(/\r?\n/)) {
				const line = raw.trim();
				if (!line.startsWith('- ')) continue;
				const body = line.slice(2).trim();
				if (!body) continue; // the template placeholder
				const n = charLen(body);
				if (n > MAX_CONSENSUS_CHARS) {
					add('WARN', 'R19', `共识条目 ${n} 字 > ${MAX_CONSENSUS_CHARS}：一条共识只约束一件事，论证留在来源功能文件里（条目：${body.slice(0, 24)}…）`);
				}
				const links = [...body.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
				if (!links.length) {
					add('WARN', 'R19', `共识条目没有依据链接：至少指向一个 functions/ 或 insights/ 文件（条目：${body.slice(0, 24)}…）`);
				} else if (/跨功能|跨项目|所有|全局|一律/.test(body) && new Set(links.map((l) => l.replace(/\/(?:[^/]+)\.md$/, ''))).size < 2) {
					add('WARN', 'R19', `声称跨域的共识只有 1 个来源域：跨域结论要能指向 ≥2 个无关领域（条目：${body.slice(0, 24)}…）`);
				}
			}
		}
	}

	// R5-orphan: a zone file WITHOUT an index row is invisible to recall, and
	// recall is the only way a memory ever reaches the model unprompted — an
	// unindexed file is a memory that exists and will never be injected. The
	// skill zone has had this check since 5.27.0 (R20e); the three older zones
	// never did, so `memory_index`'s own description ("Unindexed-but-existing
	// files are surfaced by memory_check (R5 orphan)") was a promise the code
	// did not keep. Measured on a real root: 13 of 26 insight files were
	// unindexed and memory_check reported 0 WARN.
	//
	// The index is parsed ONCE here (zone + href + slug per row) and reused by
	// R23 below. Zone attribution is by the enclosing section heading, not by
	// the href alone: a row can carry any link shape across generations, but it
	// always sits under the table it belongs to.
	const indexedByZone = Object.fromEntries(INDEXED_ZONES.map((z) => [z, new Set()]));
	const indexedHrefs = new Set();
	{
		const zoneOfHeading = (line) => {
			if (line.startsWith(FUNC_TABLE_HEADING)) return 'functions';
			if (line.startsWith(INSIGHT_TABLE_HEADING)) return 'insights';
			if (line.startsWith(CAP_TABLE_HEADING)) return 'capabilities';
			// The dao layer's own section: rows here are `- **名**（[正文](dao/x.md)）`
			// bullets rather than table rows, and their HREFS count as "indexed"
			// (the bullet scan below). The heading's parenthetical differs across
			// roots (（最抽象的指导思想） / （`dao/`）), so match the stem, not the
			// full constant — a strict startsWith silently un-recognizes a real root.
			if (/^##\s*道层/.test(line)) return 'dao';
			return null;
		};
		let currentZone = null;
		for (const raw of memText.split('\n')) {
			const s = raw.trim();
			if (s.startsWith('## ')) {
				currentZone = zoneOfHeading(s);
				continue;
			}
			// The dao section registers its entries as BULLETS (`- **名**（[正文]
			// (dao/x.md)）`) — and both bullet spellings occur in real roots. An href
			// on any line of a zone's section counts as indexed for that zone: the
			// old table-only scan contradicted R24 and the panel (a hand-registered
			// 道 read as "never indexed" and got demanded an index row that the dao
			// table does not have).
			if (currentZone === 'dao') {
				for (const m of s.matchAll(/\((dao\/[^)\s]+\.md)\)/g)) indexedHrefs.add(m[1]);
				continue;
			}
			// `### 索引·<域>` sub-tables inherit the enclosing zone.
			if (!s.startsWith('|') || !currentZone) continue;
			const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
			if (cells.length < 2 || cells.every((c) => /^[-: ]*$/.test(c))) continue;
			// Any cell may carry the link: the 4-column generation kept it in cell 3,
			// the 2/3-column one bakes it into cell 1.
			let href;
			for (const c of cells) {
				const m = /\(([^)\s]+\.md)\)/.exec(c);
				if (m) {
					href = m[1].replace(/\\/g, '/');
					indexedHrefs.add(href);
					break;
				}
			}
			const slug = cells[0].replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
			if (!slug || /^[-: ]*$/.test(slug)) continue;
			indexedByZone[currentZone].add(slug);
			// A row may point at another zone's file (a function row citing an
			// insight); its HREF is what proves that file is indexed.
			if (href) indexedHrefs.add(href);
		}
	}
	{
		const orphans = [];
		for (const zone of INDEXED_ZONES) {
			let names = [];
			try {
				names = (await readdir(path.join(root, zone))).filter((f) => f.endsWith('.md'));
			} catch (err) {
				if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
					add('WARN', 'R5', `未索引检查不完整：${zone}/ 目录枚举失败（${err?.code ?? 'unknown'}），路径状态未知`);
				}
				continue;
			}
			for (const f of names.sort()) {
				const slug = f.replace(/\.md$/, '');
				if (indexedHrefs.has(`${zone}/${f}`) || indexedByZone[zone].has(slug)) continue;
				// A SUPERSEDED insight is decision history: indexing it would inject
				// an overturned principle into recall as if it were live, so its
				// absence from the index is correct, not a defect. R23 already
				// excludes it from the budget for the same reason.
				if (zone === 'insights' || zone === 'dao') {
					let body;
					try {
						body = await readIfExists(path.join(root, zone, f));
						if (body === undefined) throw Object.assign(new Error('enumerated file no longer readable'), { code: 'ENOENT' });
					} catch (err) {
						add('WARN', 'R5', `未索引检查不完整：${zone}/${f} 读取失败（${err?.code ?? 'unknown'}），路径状态未知`);
						continue;
					}
					if (/^>\s*⚠️\s*已被取代/m.test(body)) continue;
				}
				orphans.push(`${zone}/${f}`);
			}
		}
		if (orphans.length) {
			add(
				'WARN',
				'R5',
				`${orphans.length} 个记忆文件没有索引行（召回只认索引行，这些永远不会被注入）：${orphans.slice(0, 6).join('、')}${orphans.length > 6 ? ` 等 ${orphans.length} 个` : ''} —— 稳定下来的跑 memory_index 收进索引；不该留的合并或删除`,
			);
		}
	}

	// Collected during the pass below so the temperature analysis can reuse these
	// reads instead of hitting the disk a second time for every file.
	const fnTexts = new Map();
	const fnMtimes = new Map();
	const fnMtimeUnknown = new Set();
	const insightTexts = [];
	// Keyed by slug so the R23 source-count check reuses these reads instead of
	// re-reading every insight file a second time.
	const insightTextByFile = new Map();
	let temperatureInputsUnknown = false;
	const markZoneUnknown = (zone, label, err) => {
		// Report the checks whose evidence could not be read. Keep rule identities
		// stable for callers that interpret a missing finding as a clean result.
		const affected = ['R10', 'R10e', 'R21'];
		if (zone === 'functions') affected.push('R3', 'R8', 'R9', 'R14');
		if (zone === 'insights') affected.push('R23');
		if (zone === 'dao') affected.push('R24');
		if (zone === 'skills') affected.push('R20', 'R20e');
		if (zone === 'functions' || zone === 'insights') {
			temperatureInputsUnknown = true;
			affected.push('TEMP');
		}
		for (const rule of affected) add('WARN', rule, `${label} 检查不完整（${err?.code ?? 'unknown'}），状态未知`);
	};

	for (const zone of MEMORY_ZONES) {
		const dir = path.join(root, zone);
		let files = [];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
		} catch (err) {
			if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') markZoneUnknown(zone, `${zone}/ 扫描`, err);
		}
		for (const f of files.sort()) {
			const fp = path.join(dir, f);
			let text;
			try { text = await readFile(fp, 'utf8'); }
			catch (err) { markZoneUnknown(zone, `${zone}/${f} 读取`, err); continue; }
			const stripped = stripCode(text);
			if (zone === 'functions') {
				const slug = f.replace(/\.md$/, '');
				fnTexts.set(slug, text);
				try {
					fnMtimes.set(slug, (await stat(fp)).mtimeMs);
				} catch (err) {
					if (err?.code !== 'ENOENT' && opts.newFeatureGraceDays > 0) {
						fnMtimeUnknown.add(slug);
						add('WARN', 'TEMP', `冷记忆检查不完整：functions/${f} 修改时间不可读取（${err?.code ?? 'unknown'}），宽限期状态未知`, { subtype: 'check-incomplete', subject: `functions/${f}` });
					}
				}
				const size = byteLen(text);
				if (size > opts.maxFunctionBytes) {
					const fname = f.replace(/\.md$/, '');
					add('WARN', 'R9', `functions/${f} ${size}B > ${opts.maxFunctionBytes}B — 调用 memory_fold(feature="${fname}") 折叠最旧块`);
				}
				if (REVERSE_DETAIL_FULL.test(stripped)) {
					add('FAIL', 'R8', `functions/${f} 反向链接 MEMORY.md 的细节块：细节应移回本文件，MEMORY.md 只留指针`);
				} else if (REVERSE_DETAIL_VAGUE.test(stripped)) {
					add('WARN', 'R8', `functions/${f} “详见 MEMORY.md”目标不明（人工确认）`);
				}
				const dates = [...stripped.matchAll(DATE_TAG)].map((m) => `${m[1]}${m[2]}${m[3]}`);
				for (let i = 1; i < dates.length; i++) {
					if (dates[i] < dates[i - 1]) {
						add('WARN', 'R3', `functions/${f} 迭代日期标签非递增（不是追加写入）`);
						break;
					}
				}
				// R3 head guardrail (from the workbuddy skill variant): the head
				// 「当前状态摘要（截至 date）」 must not be older than the newest
				// iteration block — appending without refreshing the head is exactly
				// the "改头忘尾" drift this check makes visible.
				const mHead = /当前状态摘要（截至\s*(\d{4})-(\d{2})-(\d{2})/.exec(stripped);
				if (mHead && dates.length) {
					const head = `${mHead[1]}${mHead[2]}${mHead[3]}`;
					const newest = dates[dates.length - 1];
					if (head < newest) {
						add('WARN', 'R3', `functions/${f} 头部状态摘要截至 ${mHead.slice(1).join('-')} 早于最新迭代块 ${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6)}：追加迭代须成对刷新头部摘要`, { subtype: 'summary-stale', subject: `functions/${f}` });
					}
				} else if (!mHead && dates.length) {
					add('WARN', 'R3', `functions/${f} 缺少「当前状态摘要（截至 YYYY-MM-DD）」头部摘要`);
				}
				// R14: an iteration block is a distilled conclusion, not a process log.
				for (const b of splitIterationBlocks(text)) {
					const n = charLen(b.body);
					if (n > MAX_BLOCK_CHARS) {
						add('WARN', 'R14', `functions/${f} 迭代块「${b.title}」正文 ${n} 字 > ${MAX_BLOCK_CHARS}（未蒸馏）：压成 动因/改动结论/判据/待观察 各一句，过程留在会话与代码里`);
						break; // one report per file is enough
					}
				}
			} else if (zone === 'insights') {
				insightTexts.push(text);
				insightTextByFile.set(f.replace(/\.md$/, ''), text);
			} else if (zone === 'skills') {
				// 5.24.0: skills no longer live in the memory root — they are host
				// bundles under <dshHome>/skills/<name>/. A file here is a LEFTOVER
				// from the old layout: it would be a second body for a skill that
				// also exists as a bundle, so flag it for removal instead of
				// validating its shape.
				add('WARN', 'R20', `skills/${f} 是旧布局残留（技能现为宿主目录包 ${'<dshHome>/skills/<name>/SKILL.md'}）：删除本文件，正文以宿主包为准`);
				const owned = /^(?:true|1)$/i.test(String(parseSkillText(stripped).fields.agent_created ?? ''));
				const sStatus = (stripped.match(/^status:\s*([a-z]+)/m) ?? stripped.match(/^> 状态：([a-z]+)/m) ?? [])[1];
				if (owned && sStatus) {
					const rowM = new RegExp(`^\\|\\s*\\[?${f.replace(/\.md$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').exec(memText);
					if (rowM) add('WARN', 'R20e', `技能「${f.replace(/\.md$/, '')}」的索引行仍指向旧记忆根文件：改成宿主包路径或删除该行`);
				}
			}
			scanForSecrets(text, `${zone}/${f}`, add);
			await checkLinks(text, fp, root, add);
		}
	}
	// Missing backlink sources could make healthy files appear cold. Do not run
	// that analysis with partial inputs; the TEMP warning above records why.
	if (temperatureInputsUnknown) fnTexts.clear();

	// THE BUNDLE STORE JOINED THE LINT (5.27.0, adversarial audit): since 5.24.0
	// skills live OUTSIDE the memory root, so the zone walk above never sees
	// them — their evidence links dangled un-checked, and their lifecycle agreed
	// with nobody. Two checks per bundle: (a) R10 over its SKILL.md links
	// (resolved against the bundle dir); (b) the index row vs frontmatter status
	// — recall reads the ROW (fail-closed), publish and the panel read the FILE,
	// so a silent drift is a lifecycle with two truths.
	{
		const sdir = opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills');
		// find a skill's row status cell in MEMORY.md (undefined = no row; null =
		// a row without a lifecycle cell). Same href recognition as recall, same
		// name extraction (skillNameOf) — one grammar for both index parsers.
		const rowStatusOf = (name) => {
			for (const raw of memText.split('\n')) {
				const s = raw.trim();
				if (!s.startsWith('|')) continue;
				const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
				const href = cells.map((c) => /\(([^)\s]+\.md)\)/.exec(c)?.[1]).find(Boolean);
				if (!href || !(/(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(href) || /^skills\//.test(href))) continue;
				if (skillNameOf(href) !== name) continue;
				return cells.find((c) => /^(candidate|active|retired)$/.test(c)) ?? null;
			}
			return undefined;
		};
		let bundles = [];
		try {
			bundles = (await readdir(sdir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== '.history');
		} catch (err) {
			if (err?.code !== 'ENOENT') add('WARN', 'R20e', `技能目录检查不完整：无法枚举技能目录（${err?.code ?? 'unknown'}），技能状态和链接未知`, { subtype: 'check-incomplete', subject: 'skill-root' });
		}
		for (const e of bundles) {
			const bp = path.join(sdir, e.name, 'SKILL.md');
			let btext;
			try {
				btext = await readIfExists(bp);
			} catch (err) {
				add('WARN', 'R20e', `技能「${e.name}」的 SKILL.md 读取失败（${err?.code ?? 'unknown'}），该技能未检查，状态和链接未知`, { subtype: 'check-incomplete', subject: `skill:${e.name}` });
				continue;
			}
			if (btext === undefined) continue;
			await checkLinks(btext, bp, root, add);
			if (!/^(?:true|1)$/i.test(String(parseSkillText(btext).fields.agent_created ?? ''))) continue;
			const bstatus = (btext.match(/^status:\s*([a-z]+)/m) ?? [])[1] ?? 'candidate';
			const rs = rowStatusOf(e.name);
			if (rs === undefined) add('WARN', 'R20e', `技能「${e.name}」有包无索引行：召回只认索引行，跑一次 memory_skill(activate/retire) 或 memory_index 补行`);
			else if (rs === null) add('WARN', 'R20e', `技能「${e.name}」索引行缺状态格：召回按 fail-closed 不放行，补 candidate/active/retired`);
			else if (rs !== bstatus) add('WARN', 'R20e', `技能「${e.name}」索引行状态 ${rs} 与包 frontmatter ${bstatus} 不一致：召回信行、发布信文件，确认哪边是现状`);
		}
	}

	let dailyNames = [];
	try {
		dailyNames = await readdir(root);
	} catch (err) {
		add('WARN', 'R10', `每日记录根目录无法枚举（${err?.code ?? 'unknown'}），日记范围的链接及 R21 检查状态未知`);
	}
	for (const f of dailyNames) {
		if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
		let dtext;
		try {
			dtext = await readFile(path.join(root, f), 'utf8');
		} catch (err) {
			add('WARN', 'R10', `每日记录 ${f} 无法读取（${err?.code ?? 'unknown'}），该日记的链接及 R21 检查状态未知`);
			continue;
		}
		await checkLinks(dtext, path.join(root, f), root, add);
		// R21 also scans readable historical records for secrets predating the redactor.
		scanForSecrets(dtext, f, add);
	}

	// 月归档（2026-11 月/周折叠方案）：daily/YYYY-MM.md 与顶层日记同属 daily 层，
	// 体检同样跑链接与 R21（文件级扫描即可，不要求周节粒度）。枚举失败只报
	// 该范围未知，不把"没有归档"冒充成"已检查"。
	let archiveNames = [];
	try {
		archiveNames = (await readdir(path.join(root, 'daily'))).filter((n) => /^\d{4}-\d{2}\.md$/.test(n));
	} catch (err) {
		if (err?.code !== 'ENOENT') add('WARN', 'R10', `每日归档目录无法枚举（${err?.code ?? 'unknown'}），daily/YYYY-MM.md 的链接及 R21 检查状态未知`);
	}
	for (const f of archiveNames) {
		const fp = path.join(root, 'daily', f);
		let atext;
		try {
			atext = await readFile(fp, 'utf8');
		} catch (err) {
			add('WARN', 'R10', `每日归档 daily/${f} 无法读取（${err?.code ?? 'unknown'}），该归档的链接及 R21 检查状态未知`);
			continue;
		}
		await checkLinks(atext, fp, root, add);
		scanForSecrets(atext, `daily/${f}`, add);
	}

	try {
		for (const f of await readdir(path.join(root, 'legacy'))) {
			if (!f.endsWith('.md')) continue;
			let text;
			try { text = await readFile(path.join(root, 'legacy', f), 'utf8'); }
			catch (err) {
				if (err?.code !== 'ENOENT') add('WARN', 'R13', `历史文件检查不完整：legacy/${f} 读取失败（${err?.code ?? 'unknown'}），头部状态未知`, { subtype: 'check-incomplete', subject: `legacy/${f}` });
				continue;
			}
			if (!text.includes('历史原貌')) add('WARN', 'R13', `legacy/${f} 缺少“历史原貌”头部（不得并入当前 functions/）`);
		}
	} catch (err) {
		if (err?.code !== 'ENOENT') add('WARN', 'R13', `历史文件检查不完整：legacy/ 枚举失败（${err?.code ?? 'unknown'}），头部状态未知`, { subtype: 'check-incomplete', subject: 'legacy/' });
	}

	// Memory temperature (cold-area candidates): for every function file count
	// inbound references from OTHER function files (related links) and insight
	// backlinks. The index row and daily threads are excluded — both are
	// auto-generated for every write, so they carry no signal. Zero deep
	// references means nothing ever linked back: brand new or going cold.
	// Files touched within `newFeatureGraceDays` are skipped: a feature written
	// today has had no chance to be backlinked yet, so flagging it is noise.
	try {
		const fnNames = [...fnTexts.keys()];
		const graceMs = Math.max(0, opts.newFeatureGraceDays) * 24 * 60 * 60 * 1000;
		if (fnNames.length > 1) {
			const refText = [...insightTexts, ...fnTexts.values()].join('\n');
			for (const name of fnNames) {
				if (fnMtimeUnknown.has(name)) continue;
				const mtime = fnMtimes.get(name);
				if (graceMs > 0 && typeof mtime === 'number' && Date.now() - mtime < graceMs) continue;
				const own = fnTexts.get(name) ?? '';
				// Guarded memories opt out: a low-frequency, high-value area (security
				// audit, a兜底 rule) must not be judged cold for being quiet.
				if (own.includes(GUARD_MARK)) continue;
				// Two link spellings exist: index-style `functions/<name>.md` and
				// bare sibling `](<name>.md)` inside functions/ files. Count both,
				// minus the file's own occurrences.
				const idxStyle = refText.split(`functions/${name}.md`).length - 1 - (own.split(`functions/${name}.md`).length - 1);
				const bareStyle = refText.split(`](${name}.md)`).length - 1 - (own.split(`](${name}.md)`).length - 1);
				const inbound = idxStyle + bareStyle;
				if (inbound === 0) {
					add('WARN', 'TEMP', `functions/${name}.md 除索引行外没有任何其他记忆引用（冷记忆）：确认它是仍在活跃维护，还是应并入相关功能域（memory_rename）或折叠（memory_fold）；低频高价值的记忆请用 memory_write guard=true 标为守护型`);
				}
			}
		}
	} catch {
		/* temperature analysis is best-effort */
	}

	// R18 (circuit breaker): a function area that keeps getting corrected is not
	// "another iteration" — the article's rule is that a hot area whose error
	// rate spikes should stop automatic appends and be rebuilt instead. Uses the
	// usage log (correction signals) when it exists; silent without signals.
	try {
		const usage = await readUsage(root, 7);
		if (usage.length) {
			const perHref = new Map();
			for (const e of usage) {
				const href = String(e.href ?? '');
				if (!href.startsWith('functions/')) continue;
				const cur = perHref.get(href) ?? { engages: 0, corrections: 0, recalls: 0 };
				// SELF-REFERENCE FIX (2026-10-27): recall is the plugin's own action,
				// so it must not sit in the denominator. It used to — a memory that
				// was pushed 150 times and corrected twice scored a 1% correction
				// rate and never tripped, while its engagement rate was 29%.
				// `engages` = the model opened it or formed a verdict about it.
				if (e.kind === 'read' || e.kind === 'positive') cur.engages++;
				else if (e.kind === 'correction') {
					cur.corrections++;
					cur.engages++; // a correction IS engagement
				} else if (e.kind === 'recall') cur.recalls++;
				perHref.set(href, cur);
			}
			for (const [href, c] of perHref) {
				if (c.corrections >= 3 && c.corrections / Math.max(1, c.engages) > 0.4) {
					add('WARN', 'R18', `${href} 近 7 天被纠正 ${c.corrections} 次、实际触及 ${c.engages} 次（纠正率 > 40%，召回注入 ${c.recalls} 次不计入）：熔断——先重构该域再继续追加迭代，别把问题压进历史`);
				}
			}
		}
	} catch (err) {
		add('WARN', 'R18', `使用记录检查不完整，纠正率状态未知（${err?.code ?? 'UNKNOWN'}）`, { subtype: 'check-incomplete', subject: 'R18' });
	}

	// R22 (insight trust): an idea whose corrections reached its confirmations
	// is being overturned by real use — the same circuit-breaker logic as R18,
	// lifted from function areas to the principle layer (Hindsight refines a
	// belief instead of replacing it silently).
	try {
		const usage = await readUsage(root, 30);
		if (usage.length) {
			for (const it of summarizeUsage(usage)) {
				if (!it.href.startsWith('insights/')) continue;
				const trust = insightTrust(it);
				if (trust.level === '动摇') {
					add('WARN', 'R22', `${it.href} 认可 ${trust.positives} 次被纠正追平/反超（${trust.corrections} 次）：该思想正被动摇——精炼原则本体或 memory_insight(supersedes) 取代它`);
				}
			}
		}
	} catch (err) {
		if (err?.code !== 'ENOENT') add('WARN', 'R22', `使用记录检查不完整，思想信任状态未知（${err?.code ?? 'unknown'}）`, { subtype: 'check-incomplete', subject: 'usage-log' });
	}

	// R23 (the principle layer's retirement budget): every other zone can shrink
	// — functions/ folds at maxFunctionBytes, skills retire, the index caps at
	// maxIndexBytes — insights/ could only grow. Three measurable symptoms, all
	// taken from files/ledger that already exist:
	//   (a) count over budget: the layer is being used as a notebook;
	//   (b) too many SINGLE-SOURCE principles: the plugin's own promotion gate
	//       (>=2 unrelated areas) says those are 专项经验, not transferable 法 —
	//       a majority of them means the zone is misnamed, not just large;
	//   (c) dangling ledger hrefs: .usage.jsonl is the ONLY record of corrections
	//       and confirmations (the input of trust, R22 and the layer suggestion),
	//       so a href pointing at a file that no longer exists silently throws
	//       away that principle's whole evidence history.
	try {
		const budget = opts.insightBudget ?? INSIGHT_BUDGET;
		let insightNames = [];
		try {
			insightNames = (await readdir(path.join(root, 'insights'))).filter((f) => f.endsWith('.md'));
		} catch (err) {
			if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
		}
		if (insightNames.length) {
			// A superseded principle is DECISION HISTORY, not a live entry: it keeps
			// its file (the supersede stamp is a link, never a delete) but it must
			// not consume the budget, or `supersedes` could never shrink the layer —
			// the one operation the retirement check exists to make possible.
			// Same for a file that is nothing but the stamp.
			const liveNames = [];
			const supersededNames = [];
			for (const f of insightNames) {
				const body = insightTextByFile.get(f.replace(/\.md$/, '')) ?? (await readIfExists(path.join(root, 'insights', f))) ?? '';
				(/^>\s*⚠️\s*已被取代/m.test(body) ? supersededNames : liveNames).push(f);
			}
			if (liveNames.length > budget.maxInsights) {
				add(
					'WARN',
					'R23',
					`insights/ 已 ${liveNames.length} 条 > 预算 ${budget.maxInsights}${supersededNames.length ? `（另有 ${supersededNames.length} 条已被取代，不计入）` : ''}：思想层没有折叠机制，先合并同根因条目（memory_insight 同名主题重写原则本体）或 memory_insight(supersedes) 取代过时条目，再写新的`,
				);
			}
			// (b) source count per principle, from the 来源 line the template writes.
			const singleSource = [];
			for (const f of liveNames) {
				const body = insightTextByFile.get(f.replace(/\.md$/, '')) ?? (await readIfExists(path.join(root, 'insights', f))) ?? '';
				const srcLine = body.split('\n').find((l) => /来源[:：]/.test(l)) ?? '';
				const areas = new Set([...srcLine.matchAll(/functions\/([^)\].]+?)\.md/g)].map((m) => m[1]));
				if (areas.size < 2) singleSource.push(f.replace(/\.md$/, ''));
			}
			const share = liveNames.length ? singleSource.length / liveNames.length : 0;
			if (share > budget.maxSingleSourceShare) {
				add(
					'WARN',
					'R23',
					`insights/ 里 ${singleSource.length}/${liveNames.length} 条只有 1 个来源域（${Math.round(share * 100)}% > ${Math.round(budget.maxSingleSourceShare * 100)}%）：单源条目属专项经验，不是可跨域重套的「法」——要么补第二个无关来源域，要么降回 functions/ 迭代块`,
				);
			}
		}
		// (c) ledger integrity. Reads the WHOLE ledger, not the 30-day window:
		// evidence from a renamed file is lost exactly when it is oldest.
		const raw = await readIfExists(usagePath(root));
		if (raw) {
			const hrefs = new Set();
			for (const line of raw.split('\n')) {
				const s = line.trim();
				if (!s) continue;
				try {
					const e = JSON.parse(s);
					const h = String(e.href ?? '').trim();
					if (h) hrefs.add(canonicalHref(h));
				} catch {
					/* skip corrupt line */
				}
			}
			const missing = [];
			const unknown = [];
			for (const h of hrefs) {
				// Only memory-root targets are checkable; skill bundles live outside
				// the root and their absence is R20e's business.
				if (!ZONE_RE_SKILLS.test(h)) continue;
				if (/^skills\//.test(h)) continue;
				try { await stat(path.join(root, h)); }
				catch (err) {
					if (err?.code === 'ENOENT') missing.push(h);
					else unknown.push({ href: h, code: err?.code ?? 'unknown' });
				}
			}
			if (unknown.length) {
				add('WARN', 'R23', `.usage.jsonl 有 ${unknown.length} 个 href 的目标存在状态未知（${unknown.slice(0, 4).map((x) => `${x.href}: ${x.code}`).join('、')}${unknown.length > 4 ? ' 等' : ''}）：本次扫描不完整，不能判定这些目标缺失或正常`);
			}
			if (missing.length >= (opts.insightBudget?.minLedgerMisses ?? INSIGHT_BUDGET.minLedgerMisses)) {
				add(
					'WARN',
					'R23',
					`.usage.jsonl 有 ${unknown.length ? '至少 ' : ''}${missing.length} 个 href 指向已不存在的文件（${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' 等' : ''}）：该条目的认可/纠正记录已成孤儿，信任与分层建议都在读空——这些文件是被改名或删除了，确认它们的证据该归到哪个现存条目`,
				);
			}
		}
	} catch (err) {
		add('WARN', 'R23', `思想层与使用账本检查不完整，状态未知（${err?.code ?? 'UNKNOWN'}）`, { subtype: 'check-incomplete', subject: 'R23' });
	}

	// R25 (2026-10-28): 一次删掉很多记忆文件时，必须有人说话。
	// 起因是真实事故：一次「思想层收敛」删掉 24 个文件（insights 25→4、dao 3→0），
	// 而 memory_check 只报了一条不相干的 R14 —— 删除本身零告警。那次是**有意的**
	// 且内容确实并回了 functions/，但体检无从分辨「有意收敛」与「误删/覆盖」：
	// 两者的表现完全一样。这条不阻止删除（收敛是正当操作），只要求留下可核对的痕迹。
	//
	// 判据是「台账里存在过、现在不在」：删文件前它必然被读过或召回记过账。
	// 已存在的 24 个删除样本里，有证据的占绝大多数；剩下一两个从未被碰过的文件
	// 漏报可以接受——噪声下限比误报阈值更重要。
	try {
		const rawAll = await readIfExists(usagePath(root));
		if (rawAll) {
			const seen = new Set();
			for (const line of rawAll.split('\n')) {
				const s = line.trim();
				if (!s) continue;
				try {
					const e = JSON.parse(s);
					const h = canonicalHref(String(e.href ?? '').trim());
					if (ZONE_RE_FILE_EXACT.test(h)) seen.add(h);
				} catch {
					/* skip corrupt line */
				}
			}
			const vanished = [];
			const unknown = [];
			for (const h of seen) {
				try { await stat(path.join(root, h)); }
				catch (err) {
					if (err?.code === 'ENOENT') vanished.push(h);
					else unknown.push({ href: h, code: err?.code ?? 'unknown' });
				}
			}
			if (unknown.length) {
				add('WARN', 'R25', `有 ${unknown.length} 个曾经有使用证据的记忆文件存在状态未知（${unknown.slice(0, 4).map((x) => `${x.href}: ${x.code}`).join('、')}${unknown.length > 4 ? ' 等' : ''}）：本次扫描不完整，不能判定这些文件缺失或正常`);
			}
			// 台账里的 href 若被人工重定向过（收敛时做过），这里就看不到删除；
			// 那是正确的——证据已归到现存条目，不算消失。
			if (vanished.length >= VANISHED_FILES_WARN) {
				add(
					'WARN',
					'R25',
					`有 ${unknown.length ? '至少 ' : ''}${vanished.length} 个曾经有使用证据的记忆文件不见了（${vanished.slice(0, 4).join('、')}${vanished.length > 4 ? ' 等' : ''}）：若是有意收敛，确认它们的结论已写进现存文件（functions/ 迭代块或更上层）；若是误删/覆盖，现在恢复还来得及（记忆根有 git）`,
				);
			}
		}
	} catch (err) {
		add('WARN', 'R25', `历史使用目标检查不完整，删除状态未知（${err?.code ?? 'UNKNOWN'}）`, { subtype: 'check-incomplete', subject: 'R25' });
	}

	// R24 (2026-10-27): the 道 layer's own integrity + extraction prompt.
	//
	// 道是「从 ≥5 条法萃取」的最抽象层（dao/），它有两个会静默腐坏的方式：
	//   (a) 命题里混进具体技术/项目名 —— 它已经不是道，是法伪装成道；
	//   (b) 来源法被取代或删除 —— 道的依据没了，但文件还在，没人会发现。
	// 再者：法已经凑够 5 条的主题簇如果一直没人萃取，道层就永远长不出来。
	// 这三件事都只有机器看得见，所以在这里报。
	try {
		const daoDir = path.join(root, 'dao');
		let daoFiles = [];
		try {
			daoFiles = (await readdir(daoDir)).filter((f) => f.endsWith('.md'));
		} catch (err) {
			if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
		}
		const liveDao = [];
		let unknownDaoCount = 0;
		for (const f of daoFiles) {
			let body;
			try {
				body = await readIfExists(path.join(daoDir, f));
				if (body === undefined) throw Object.assign(new Error('扫描后文件消失'), { code: 'ENOENT' });
			} catch (err) {
				unknownDaoCount++;
				add('WARN', 'R24', `dao/${f} 读取失败，状态未知（${err?.code ?? 'UNKNOWN'}）；检查不完整，其来源法认领情况未知`, { subtype: 'dao-read-unknown', subject: `dao/${f}` });
				continue;
			}
			if (/^>\s*⚠️\s*已被取代/m.test(body)) continue;
			liveDao.push({ slug: f.replace(/\.md$/, ''), body });
		}
		const daoLowerBound = unknownDaoCount ? `（已确认下界；另有 ${unknownDaoCount} 条道状态未知）` : '';

		// (a) 命题的抽象度（复用 layer-gate 的判据，与写入闸门同源）
		const unabstract = [];
		const headless = [];
		for (const { slug, body } of liveDao) {
			const m = body.match(/## 命题\s*\n+\s*\n?([^\n]+)/);
			// 缺 `## 命题` 标题曾直接 continue —— 手工写一个没有标题的 dao 文件即可
			// 绕过唯一的兜底检查（闸门只拦 memory_dao 一条写路径）。缺结构本身就是问题。
			if (!m) {
				headless.push(slug);
				continue;
			}
			const markers = concreteMarkersOf(m[1]);
			if (markers.length) unabstract.push(`${slug}（${markers.slice(0, 3).join('、')}）`);
		}
		// (a2) 道文件必须在索引里出现一次。
		// memory_dao 的 description 写着「MEMORY.md gets one proposition line」，但它的
		// execute 从不读写 MEMORY.md（memory_index 的 zone 枚举也只有 functions/insights）。
		// 于是每条道都得靠人手工登记，漏登记时没有任何东西会说话——道写进去了、体检全绿、
		// 而索引里查不到它。这条把那个静默缺口变成可见的。
		// 2026-11-05：判据与 R5 **同一实现**。此前用 `memText.includes('dao/x.md')`
		// 裸子串——共识区里随口提一句该路径（非登记行）也算"已登记"，于是 R5 报
		// orphan、R24 沉默，同一个问题两处检查给出相反结论。改用 R5 解析索引得到
		// 的 indexedHrefs / indexedByZone（同一份解析结果，不另起一套）。
		const unindexed = liveDao
			.filter(({ slug }) => !indexedHrefs.has(`dao/${slug}.md`) && !indexedByZone.dao?.has(slug))
			.map(({ slug }) => slug);
		if (unindexed.length) {
			add(
				'WARN',
				'R24',
				`dao/ 有 ${unindexed.length} 条没有写进 MEMORY.md 的道层小节${daoLowerBound}：${unindexed.join('、')}——索引是唯一的检索面，没登记的道等于只有磁盘知道（memory_dao 不会替你登记，手工补一行）`,
			);
		}

		if (headless.length) {
			add(
				'WARN',
				'R24',
				`dao/ 有 ${headless.length} 条缺少「## 命题」小节${daoLowerBound}：${headless.join('、')}——没有这一节，抽象度检查整条被跳过（道必须有一句能用来说的命题）`,
			);
		}
		if (unabstract.length) {
			add(
				'WARN',
				'R24',
				`dao/ 有 ${unabstract.length} 条命题含具体技术/项目标记${daoLowerBound}：${unabstract.join('；')}——道必须能「换一个领域依然成立」，含具体名词的是法伪装成道`,
			);
		}

		// (b) 来源法的存活
		for (const { slug, body } of liveDao) {
			// 锚的唯一实现见 layer-gate.daoSourceSlugs —— 2026-11-02 事故：
			// 这里曾用 `body.split('## 来源法')[1]`，而正文里的「## 来源法逐条」
			// 会先被切断，导致依据齐全的道被读成 0 条、误报"依据不足"。
			const refs = daoSourceSlugs(body);
			if (refs.length < MIN_DAO_SOURCES) {
				add('WARN', 'R24', `dao/${slug}.md 只列出 ${refs.length} 条来源法（< ${MIN_DAO_SOURCES}）：道的依据不足，确认它是否被拆散或手工删减过`);
			}
			const gone = [];
			let unknownRefs = 0;
			for (const r of refs) {
				let txt;
				try { txt = await readIfExists(path.join(root, 'insights', `${r}.md`)); }
				catch (err) {
					unknownRefs++;
					add('WARN', 'R24', `insights/${r}.md 来源于 dao/${slug}.md，读取失败，状态未知（${err?.code ?? 'UNKNOWN'}）`, { subtype: 'source-read-unknown', subject: `insights/${r}.md` });
					continue;
				}
				if (txt === undefined || /^>\s*⚠️\s*已被取代/m.test(txt)) gone.push(r);
			}
			if (gone.length) {
				const partial = unknownRefs ? `（已确认下界，另有 ${unknownRefs} 条来源状态未知）` : '';
				add('WARN', 'R24', `dao/${slug}.md 的来源法有 ${gone.length} 条已不存在或已被取代${partial}（${gone.join('、')}）：道的依据缺了，要么补新来源，要么重新审视这条道是否还成立`);
			}
		}

		// (c) 数量上限
		if (liveDao.length > MAX_DAO_ENTRIES) {
			add('WARN', 'R24', `dao/ 已 ${liveDao.length} 条${daoLowerBound} > 上限 ${MAX_DAO_ENTRIES}：道多了就不是道，是清单——合并或取代`);
		}

		// (d) 可萃取提示：法已够 5 条、且**还没被任何道认领**的主题簇
		// 这里不猜语义，只按「被其他法引用的来源域」聚类：同一个 functions/ 功能域
		// 被 ≥5 条法回链，说明这批法讲的是同一个实践面，值得看能不能萃道。
		//
		// 但只数「尚未被认领」的法：已道化（被某条现存道的「来源法」列出）的法不再
		// 计入。否则这条提示永远清不掉——功能域的法数量只会增不会减，萃完道它照样
		// 报同样的清单，久而久之就成了背景噪音（一条永远红的检查等于没有检查）。
		const claimed = new Set();
		for (const { body } of liveDao) {
			// 同一份锚实现（见上）：认领统计与"依据存活"必须读到同一批 slug，
			// 否则会出现"依据够、但认领数不足"这种自相矛盾的提示。
			for (const slug of daoSourceSlugs(body)) claimed.add(slug);
		}
		const byArea = new Map();
		let insightFiles = [];
		try {
			insightFiles = (await readdir(path.join(root, 'insights'))).filter((f) => f.endsWith('.md'));
		} catch (err) {
			if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
		}
		let unknownInsights = 0;
		for (const f of insightFiles) {
			const slug = f.replace(/\.md$/, '');
			if (claimed.has(slug)) continue; // 已被某条道认领，不再提示
			let body;
			try {
				body = await readIfExists(path.join(root, 'insights', f));
				if (body === undefined) throw Object.assign(new Error('扫描后文件消失'), { code: 'ENOENT' });
			} catch (err) {
				unknownInsights++;
				add('WARN', 'R24', `insights/${f} 读取失败，状态未知（${err?.code ?? 'UNKNOWN'}）；未计入未认领法`, { subtype: 'insight-read-unknown', subject: `insights/${f}` });
				continue;
			}
			if (/^>\s*⚠️\s*已被取代/m.test(body)) continue;
			const srcLine = body.split('\n').find((l) => /来源[:：]/.test(l)) ?? '';
			for (const m of srcLine.matchAll(/functions\/([^)\].]+?)\.md/g)) {
				const area = m[1];
				if (!byArea.has(area)) byArea.set(area, []);
				byArea.get(area).push(slug);
			}
		}
		const extractable = [...byArea.entries()].filter(([, laws]) => new Set(laws).size >= MIN_DAO_SOURCES);
		if (unknownDaoCount) {
			add('WARN', 'R24', `有 ${unknownDaoCount} 条道状态未知，来源法认领检查不完整；本轮不判断可萃取主题`, { subtype: 'claims-unknown', subject: 'dao' });
		} else if (extractable.length) {
			const desc = extractable.map(([area, laws]) => `${area}（${new Set(laws).size} 条未认领${unknownInsights ? '，已确认下界' : ''}）`).join('、');
			// level 只能是 WARN / FAIL（宿主 schema 校验）——"建议"用 WARN 表达，
			// 文案里说清它是机会而非缺陷，避免读数的人误判成故障。
			add(
				'WARN',
				'R24',
				`以下功能域有 ≥${MIN_DAO_SOURCES} 条法尚未被任何道认领，可考虑萃取上层命题：${desc}——读这些法的「核心原则」，找它们共同指向的一个关于「世界是怎样的」的命题（不是更广的规则，是它们成立的前提）`,
			);
		}
	} catch (err) {
		add('WARN', 'R24', `道层完整性检查不完整，状态未知（${err?.code ?? 'UNKNOWN'}）`, { subtype: 'check-incomplete', subject: 'R24' });
	}

	// R26：递归核对受管层，未读到的路径为未知，不能推断写入者。
	try {
		const { readLedger, auditBatch, isTracked } = await import('./src/write-ledger.js');
		const ledger = await readLedger(root);
		const files = [];
		const unknown = new Set();
		const zones = ['functions', 'insights', 'dao', 'capabilities', 'daily'];
		const scan = async (key, optionalRoot = false) => {
			let entries;
			try {
				entries = await readdir(path.join(root, ...key.split('/')), { withFileTypes: true });
			} catch (err) {
				if (optionalRoot && err?.code === 'ENOENT') return;
				unknown.add(key);
				add('WARN', 'R26', `${key} 扫描失败（${err?.code ?? 'unknown'}），该范围的状态未知`);
				return;
			}
			for (const entry of entries) {
				const child = `${key}/${entry.name}`;
				if (entry.isSymbolicLink()) {
					unknown.add(child);
					add('WARN', 'R26', `${child} 是符号链接，未遍历或对账，该范围的状态未知`);
				} else if (entry.isDirectory()) {
					await scan(child);
				} else if (entry.isFile() && /\.md$/i.test(entry.name) && isTracked(child)) {
					try {
						files.push({ key: child, text: await readFile(path.join(root, ...child.split('/')), 'utf8') });
					} catch (err) {
						unknown.add(child);
						add('WARN', 'R26', `${child} 读取失败（${err?.code ?? 'unknown'}），文件状态未知`);
					}
				}
			}
		};
		for (const zone of zones) await scan(zone, true);
		// The actual daily layer lives at the root, not just in daily/.
		let dailyRootUnknown = false;
		try {
			for (const entry of await readdir(root, { withFileTypes: true })) {
				const key = entry.name;
				if (!isTracked(key) || key.includes('/')) continue;
				if (!entry.isFile() || entry.isSymbolicLink()) {
					unknown.add(key);
					add('WARN', 'R26', `${key} 不是普通每日文件，该范围的状态未知`);
					continue;
				}
				try { files.push({ key, text: await readFile(path.join(root, key), 'utf8') }); }
				catch (err) { unknown.add(key); add('WARN', 'R26', `${key} 读取失败（${err?.code ?? 'unknown'}），文件状态未知`); }
			}
		} catch (err) {
			dailyRootUnknown = true;
			add('WARN', 'R26', `每日记录根目录扫描失败（${err?.code ?? 'unknown'}），该范围的状态未知`);
		}
		if (ledger === undefined) {
			add('WARN', 'R26', '写入账本不可读或包含损坏记录（.write-ledger.jsonl）：无法对账，文件状态未知');
		} else if (ledger.size === 0) {
			add('WARN', 'R26', '写入账本为空：现存文件没有账本记录，无法判定其来源');
		} else {
			const issues = auditBatch({ root, files, ledger });
			const mismatches = issues.filter((it) => it.reason === 'hash_mismatch');
			const unrecorded = issues.filter((it) => it.reason === 'never_recorded');
			const unexpected = issues.filter((it) => it.reason === 'deleted_present');
			for (const it of unexpected.slice(0, 12)) add('WARN', 'R26', `${it.key} 账本记录已删除但文件存在，原因未知`);
			if (unexpected.length > 12) add('WARN', 'R26', `另有 ${unexpected.length - 12} 个已记录删除的文件再次出现`);
			for (const it of mismatches.slice(0, 12)) add('WARN', 'R26', `${it.key} 内容与账本记录不符，无法仅凭对账结果判断原因或写入者`, { subtype: 'hash-mismatch', subject: it.key });
			if (mismatches.length > 12) add('WARN', 'R26', `另有 ${mismatches.length - 12} 个文件内容与账本记录不符`);
			if (unrecorded.length) add('WARN', 'R26', `${unrecorded.length} 个文件不在写入账本里，无法据此判断来源`, { subtype: 'unrecorded-count', subject: 'aggregate' });
			const seen = new Set(files.map((file) => file.key));
			const absent = [];
			for (const key of ledger.keys()) {
				if (typeof key !== 'string' || !isTracked(key) || !/\.md$/i.test(key)) continue;
				if (key.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
					add('WARN', 'R26', '账本包含无效路径，无法对账');
					continue;
				}
				const entry = ledger.get(key);
				if (entry?.op === 'delete_intent') {
					add('WARN', 'R26', `${key} 删除意图未完成，文件与账本状态未知，需核查`);
					continue;
				}
				if (entry?.op === 'delete') continue;
				if (seen.has(key) || (dailyRootUnknown && !key.includes('/')) || [...unknown].some((prefix) => key === prefix || key.startsWith(`${prefix}/`))) continue;
				absent.push(key);
			}
			for (const key of absent.slice(0, 12)) add('WARN', 'R26', `${key} 已登记但扫描时不存在，可能已删除或移动，无法判断原因`);
			if (absent.length > 12) add('WARN', 'R26', `另有 ${absent.length - 12} 个已登记文件扫描时不存在`);
		}
	} catch (err) {
		add('WARN', 'R26', `写入对账无法完成（${err?.code ?? 'unknown'}），本轮状态未知`);
	}

	// R27 派生层冗余结构（2026-11-10 用户实测）：
	//
	// 用户看到召回里那条「早期演化（25 块已折叠：2026-10-18→…补24）」直接问
	// "这种内容，不是垃圾吗，怎么就没发现呢"。查下来是**一类**病，不是一处：
	// 派生层（functions/）应当压缩，却把**过程**搬了进来。三类症状同源：
	//   ①同文件出现多段「早期演化」——每次折叠新插一段，从不合并；
	//   ②段头逐条列日期标签——日期在每日记录里本来就有，标签链零信息；
	//   ③同一天堆 ≥5 个「补N」块——过程没沉淀就被归档（纪律明令的反面样本）。
	// 系统查不到它们，是因为所有规则都按 `## [YYYY-MM-DD]` 迭代块和索引行定义，
	// 「早期演化」段头与"同日多块"不在任何规则的定义里。
	try {
		const dir = path.join(root, 'functions');
		let names = [];
		try {
			names = (await readdir(dir)).filter((f) => f.endsWith('.md'));
		} catch (err) {
			if (err?.code !== 'ENOENT') add('WARN', 'R27', `折叠冗余检查不完整：functions/ 枚举失败（${err?.code ?? 'unknown'}），状态未知`, { subtype: 'check-incomplete', subject: 'functions/' });
		}
		const dup = [];
		const long = [];
		const sameDay = [];
		const preview = (list) => `${list.slice(0, 4).join('、')}${list.length > 4 ? ` 等 ${list.length} 处` : ''}`;
		for (const f of names) {
			let text;
			try { text = await readIfExists(path.join(dir, f)); }
			catch (err) {
				if (err?.code !== 'ENOENT') add('WARN', 'R27', `折叠冗余检查不完整：functions/${f} 读取失败（${err?.code ?? 'unknown'}），状态未知`, { subtype: 'check-incomplete', subject: `functions/${f}` });
				continue;
			}
			if (text === undefined) continue;
			const lines = text.split('\n');
			const heads = lines.filter((l) => /^##\s*早期演化/.test(l));
			if (heads.length > 1) dup.push(`functions/${f}（${heads.length} 段）`);
			const over = heads.filter((h) => h.length > 90);
			if (over.length) long.push(`functions/${f}（${over[0].length} 字符）`);
			const byDay = new Map();
			for (const l of lines) {
				const m = /^##\s*\[(\d{4}-\d{2}-\d{2})/.exec(l);
				if (m) byDay.set(m[1], (byDay.get(m[1]) || 0) + 1);
			}
			const worst = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
			if (worst && worst[1] >= 5) sameDay.push(`functions/${f}（${worst[0]} 有 ${worst[1]} 块）`);
		}
		if (dup.length) {
			add('WARN', 'R27', `「早期演化」段重复（应合并为一段）：${preview(dup)}——每次折叠新插一段会让文件越折越长，召回读到的是串不起作用的标签`, { subtype: 'duplicate-evolution-sections', subject: 'aggregate' });
		}
		if (long.length) {
			add('WARN', 'R27', `「早期演化」标题逐条列日期标签或过长（标题只该写数量与区间）：${preview(long)}——需审查标题与段落后再整理，当前 memory_fold 不会自动整理旧段`, { subtype: 'long-evolution-headings', subject: 'aggregate' });
		}
		if (sameDay.length) {
			add('WARN', 'R27', `同一天有多块迭代记录：${preview(sameDay)}——数量本身不能证明违反蒸馏纪律，请结合素材日期与豁免理由审查`, { subtype: 'same-day-blocks', subject: 'aggregate' });
		}
	} catch {
		/* R27 是增强检查，绝不因它失败而中断体检 */
	}

	const warnCount = results.filter((r) => r.level === 'WARN').length;
	const failCount = results.filter((r) => r.level === 'FAIL').length;
	return { root, results, warnCount, failCount };
}

/**
 * Panel presentation view of a health result: an uninitialized memory root
 * (the only problem is R0) is a neutral "not yet started" state, not a FAIL —
 * the agent-facing memory_check keeps R0 as FAIL to prompt the first write.
 */
function panelizeHealth(health) {
	const uninit = health.results.length === 1 && health.results[0].rule === 'R0';
	return {
		root: health.root,
		initialized: !uninit,
		failCount: uninit ? 0 : health.failCount,
		warnCount: uninit ? 0 : health.warnCount,
		results: uninit ? [] : health.results,
	};
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function memoryReadTool(opts) {
	return defineTool({
		name: 'memory_read',
		description:
			'Read the function-area project memory. Start with kind=index (MEMORY.md: dual tables whose one-line summaries let you judge relevance without opening files, plus consensus and env constants), then open the exact function/insight file you need. Daily logs are one-line decision threads (kind=daily defaults to the latest day). kind=function/insight WITHOUT a name lists that directory with sizes.',
		parameters: {
			kind: {
				type: 'string',
				required: true,
				enum: ['index', 'function', 'insight', 'dao', 'capability', 'skill', 'daily'],
				description: 'index=MEMORY.md; function=functions/<name>.md; insight=insights/<name>.md; dao=dao/<name>.md (最抽象层); capability=capabilities/<name>.md (CLI/MCP ledger); skill=<skillRoot>/<name>/SKILL.md (the host bundle — one store, no memory-root copy); daily=YYYY-MM-DD.md (latest when date omitted).',
			},
			name: {
				type: 'string',
				description: 'Feature or theme slug (no .md). Required for reading one file; omit to list the directory.',
			},
			date: { type: 'string', description: 'YYYY-MM-DD for kind=daily; defaults to the latest daily log.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					found: { type: 'boolean', required: true },
					path: { type: 'string', required: true },
					content: { type: 'string', required: true },
					listing: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								bytes: { type: 'integer', required: true },
								mtime: { type: 'string', required: true },
							},
						},
					},
				},
			},
			render: (_args, v) => {
				if (!v.found && v.listing.length === 0) {
					// 「记忆还是空的」是错的：这里只知道**这个分区**是空的。整库为空时
					// 该提示第一次写入，但某个分区为空（如 dao/ 还没凑够 5 条法）是完全
					// 正常的状态，报「记忆是空的」会让人以为数据丢了。
					const isIndex = String(v.path ?? '').endsWith('MEMORY.md');
					return [
						{
							type: 'text',
							text: isIndex
								? `未找到：${v.path}。记忆库还没有建档——先用 memory_write 记录第一次迭代。`
								: `这个分区还是空的：${v.path}（目录存在，暂无 .md 文件）。记忆库其余部分不受影响；若这是道层，空着可能正是闸门的答案——道须从 ≥5 条法萃取。`,
						},
					];
				}
				if (v.content) return [{ type: 'text', text: v.content }];
				if (v.listing.length) {
					return [{ type: 'text', text: v.listing.map((e) => `- ${e.name}（${e.bytes}B，更新于 ${e.mtime}）`).join('\n') }];
				}
				return [{ type: 'text', text: `${v.path} 存在但为空。` }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Read memory: ${args.kind}${args.name ? `/${args.name}` : ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			if (args.kind === 'index') {
				const p = path.join(root, 'MEMORY.md');
				const text = await readIfExists(p);
				return { found: text !== undefined, path: p, content: text ?? '', listing: [] };
			}
			if (args.kind === 'skill') {
				// 5.24.0: a skill is a host bundle <skillRoot>/<name>/SKILL.md —
				// memory_read follows the same single store the panel and the host
				// tool read. Listing = bundles that actually carry a SKILL.md.
				const dir = opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills');
				const listBundles = async () => {
					const listing = [];
					let entries = [];
					try {
						entries = await readdir(dir, { withFileTypes: true });
					} catch {
						return listing;
					}
					for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
						const fp = path.join(dir, e.name, 'SKILL.md');
						try {
							const st = await stat(fp);
							listing.push({ name: `${e.name}/SKILL.md`, bytes: st.size, mtime: st.mtime.toISOString() });
						} catch {
							/* not a bundle (no SKILL.md) — skip */
						}
					}
					return listing;
				};
				if (!args.name) {
					const listing = await listBundles();
					return { found: listing.length > 0, path: dir, content: '', listing };
				}
				const sName = oneLine(args.name).trim();
				const p = path.join(dir, sName, 'SKILL.md');
				const text = await readIfExists(p);
				if (text === undefined) return { found: false, path: p, content: '', listing: await listBundles() };
				// Reading a skill IS a use signal (the activate evidence gate reads
				// it; canonicalHref folds it onto the bundle identity).
				await appendUsage(root, { href: `skills/${sName}/SKILL.md`, kind: 'read' });
				return { found: true, path: p, content: text, listing: [] };
			}
			if (args.kind === 'function' || args.kind === 'insight' || args.kind === 'dao' || args.kind === 'capability') {
				// kind → directory, from ONE map: this used to be a nested ternary whose
				// default was CAP_DIR, so any new kind silently read capabilities/.
				const KIND_DIR = { function: 'functions', insight: 'insights', dao: DAO_DIR, capability: CAP_DIR };
				const hrefZone = KIND_DIR[args.kind];
				const dir = path.join(root, hrefZone);
				if (!args.name) {
					const listing = await listMdDir(dir);
					return { found: listing.length > 0, path: dir, content: '', listing };
				}
				const slug = safeSlug(args.name);
				const p = path.join(dir, `${slug}.md`);
				const text = await readIfExists(p);
				if (text === undefined) {
					const listing = await listMdDir(dir);
					return { found: false, path: p, content: '', listing };
				}
				// The usage href must name the zone that was ACTUALLY read — this
				// once mapped every capability read onto insights/, polluting the
				// usage ledger that drives nomination.
				await appendUsage(root, { href: `${hrefZone}/${slug}.md`, kind: 'read' });
				return { found: true, path: p, content: text, listing: [] };
			}
			// daily
			if (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim())) {
				const day = args.date.trim();
				const p = path.join(root, `${day}.md`);
				const text = await readIfExists(p);
				if (text !== undefined) await appendUsage(root, { href: day, kind: 'read' });
				if (text !== undefined) return { found: true, path: p, content: text, listing: [] };
				// 月/周折叠方案（2026-11）：顶层没有这份日记时回落到按月归档的
				// 日节（只读，不补造文件）。回落命中如实标注来源路径是归档文件。
				const archived = await readArchivedDay(root, day);
				if (archived) return { found: true, path: archived.file, content: archived.text, listing: [] };
				return { found: false, path: p, content: '', listing: [] };
			}
			let latest;
			try {
				for (const f of await readdir(root)) {
					if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && (!latest || f > latest)) latest = f;
				}
			} catch {
				/* root missing */
			}
			if (latest) {
				const p = path.join(root, latest);
				const text = await readIfExists(p);
				return { found: text !== undefined, path: p, content: text ?? '', listing: [] };
			}
			// 月/周折叠方案（2026-11）：顶层无任何日文件（可能全部已归档）时，
			// 回落到最新归档文件的最新日节；再没有就保持旧行为（指向今天路径）。
			const latestArch = await latestArchivedDay(root);
			if (latestArch) return { found: true, path: latestArch.file, content: latestArch.text, listing: [] };
			const p = path.join(root, `${localDateStr()}.md`);
			return { found: false, path: p, content: '', listing: [] };
		},
	});
}

// ---------------------------------------------------------------------------
// memory_search — on-demand ranked retrieval over the whole memory root
// ---------------------------------------------------------------------------

function memorySearchTool(opts) {
	return defineTool({
		name: 'memory_search',
		description:
			'Ranked full-text search across the ENTIRE memory root (index, functions/, insights/, daily logs) and return the best matching lines with their zone, file, line number, section heading and a snippet. Use it when you remember something was recorded but cannot tell which function area or which day: memory_read kind=index only scans one-line summaries, while this scans the bodies. Ranking is lexical (query substring, token hits, section heading, file name) with per-file caps, so a broad keyword does not return one file\'s whole history. Read the file afterwards with memory_read before re-deriving anything. Temporal queries (「上个月怎么解决的」) use after/before: every hit carries its attributed date (iteration-block tag → file-head date → filename → mtime) and the bounds filter inclusively.',
		parameters: {
			q: { type: 'string', required: true, description: '检索词：一个词或短句（≥2 字符）。中文子串与英文单词都支持。' },
			zone: { type: 'string', enum: ['all', ...SEARCH_ZONES], description: '限定检索分区，缺省 all（含索引）。能力台账（CLI/MCP/本地工具）在 capabilities，技能程序在 skills。' },
			limit: { type: 'integer', description: '最多返回多少条命中（默认 20，最大 50）。' },
			after: { type: 'string', description: '时间下限 YYYY-MM-DD（含）：只看这天及之后的内容。迭代块按 [日期] 标签归属，文件其余按头部「截至」日期，每日按文件名，无日期文件按 mtime——问“上个月怎么解决的”用它。' },
			before: { type: 'string', description: '时间上限 YYYY-MM-DD（含）。与 after 成对使用框出一个区间。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					count: { type: 'integer', required: true },
					hits: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								zone: { type: 'string', required: true },
								name: { type: 'string', required: true },
								line: { type: 'integer', required: true },
								heading: { type: 'string', required: true },
								snippet: { type: 'string', required: true },
								date: { type: 'string', required: true, description: '命中行的归属日期（迭代块标签 / 文件头 / 文件名 / mtime 逐级解析，可能为空串=未知）' },
							},
						},
					},
				},
			},
			render: (_args, v) => {
				if (!v.count) return [{ type: 'text', text: '没有命中：换一个更具体的关键词，或先 memory_read kind=index 看分区摘要。' }];
				const lines = [`命中 ${v.count} 条（按相关度排序）：`];
				for (const h of v.hits) {
					lines.push(`- [${h.zone}] ${h.name}:${h.line}${h.date ? ` · ${h.date}` : ''}${h.heading ? ` · ${h.heading}` : ''} — ${h.snippet}`);
				}
				lines.push('调用 memory_read 打开命中文件确认上下文，再决定是否追加迭代。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Search memory: ${args.q ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const q = oneLine(args.q);
			if (charLen(q) < 2) throw new Error('q must be at least 2 characters');
			const zone = SEARCH_ZONES.includes(args.zone) ? args.zone : 'all';
			const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50);
			// Date bounds: accept YYYY-MM-DD (tolerating spaces) or reject loudly —
			// a silently-ignored `after: 上个月` would return everything and be
			// trusted as a filtered answer.
			const normBound = (v, label) => {
				if (v === undefined || v === '') return '';
				const s = String(v).trim();
				// Format AND calendar validity: `2026-13-99` compares as a string but
				// means nothing — a bound that cannot be a real date must fail loud,
				// because a silently-wrong filter is worse than no filter.
				if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s))) {
					throw new Error(`${label} 必须是有效日期 YYYY-MM-DD（收到：${s.slice(0, 24)}）`);
				}
				return s;
			};
			const after = normBound(args.after, 'after');
			const before = normBound(args.before, 'before');
			if (after && before && after > before) throw new Error(`after ${after} 晚于 before ${before}：区间为空`);
			const hits = await searchMemory(root, q, { zone, limit, after, before, skillRoot: opts.skillRoot });
			return { count: hits.length, hits };
		},
	});
}

// ---------------------------------------------------------------------------
// federation (three-tier mode): project truth sources -> federation layer -> global
// ---------------------------------------------------------------------------
// (FED_* table constants live in src/constants.js)

/** Read + validate the federation config; throws with an explicit fix-it message. */
function federationConfig(opts) {
	const fed = opts.federation;
	if (!fed || typeof fed !== 'object') {
		throw new Error('未配置联邦模式：在插件配置里给出 federation: { root, projects: [{ key, root }] }');
	}
	if (!fed.root || typeof fed.root !== 'string') throw new Error('federation.root 缺失（联邦层记忆根目录）');
	const projects = Array.isArray(fed.projects) ? fed.projects : [];
	if (!projects.length) throw new Error('federation.projects 为空：至少列出 { key, root } 两个字段');
	const seen = new Set();
	const out = projects.map((p) => {
		const key = String(p?.key ?? '').trim();
		if (!key) throw new Error('federation.projects 每一项都需要 key');
		if (!/^[\w\u4e00-\u9fff.-]{1,40}$/.test(key)) throw new Error(`项目 key 不合法（不要带路径分隔符）：${key}`);
		const lower = key.toLowerCase();
		if (seen.has(lower)) throw new Error(`项目 key 重复：${key}`);
		seen.add(lower);
		if (!p?.root || typeof p.root !== 'string') throw new Error(`项目 ${key} 缺 root（该项目记忆根目录）`);
		return { key, root: path.resolve(p.root) };
	});
	return { root: path.resolve(fed.root), projects: out };
}

/** Mechanical federation index: one row per project (no semantic fusion here). */
function federationIndexText(rows) {
	return [
		'# 联邦记忆（跨项目索引）',
		'',
		'> 本层只做**跨项目整合**：项目真相源留在各项目自己的记忆根，这里存它们 `MEMORY.md` 的副本与一张项目索引。',
		'> `memory_federation(action=sync)` 刷新副本与索引行；跨项目共识由模型蒸馏后写在下方小节，不自动生成。',
		'',
		FED_TABLE_HEADING,
		'',
		FED_TABLE_HEADER,
		'|---|---|---|',
		...rows,
		'',
		FED_CONSENSUS_HEADING,
		'',
		'- ',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// memory_usage — usage signals and data-driven layer suggestions
// ---------------------------------------------------------------------------

function memoryUsageTool(opts) {
	return defineTool({
		name: 'memory_usage',
		description:
			'Record and read USAGE signals, the data that lets the memory sort itself. action=record logs one event against a memory file (kind: correction = the user corrected / rejected what was recalled or written; positive = explicit confirmation like "对了/就是这个"; recall/read are logged automatically). action=report aggregates the last N days per file and suggests a layer: 实验 (<3 uses), 专项 (>=3 uses + >=1 confirmation), 通用 (>=10 uses + >=2 confirmations + correction rate <20%). Uses count ENGAGEMENT only (read + verdicts): a recall injection is EXPOSURE, not use — counting it would let the plugin\'s own output inflate the popularity that decides what gets recalled next. Layers are suggestions for the model to act on — this tool never moves files.',
		parameters: {
			action: { type: 'string', required: true, enum: ['record', 'report'], description: 'record=记一次信号；report=按天聚合出分层建议。' },
			href: { type: 'string', description: 'record 必填：目标记忆文件，如 `functions/批印坊工程加固.md`、`insights/逐帧渲染取帧三闸.md`、`2026-10-18.md`、`daily/2026-10.md`（月归档）。' },
			kind: { type: 'string', enum: ['correction', 'positive', 'recall', 'read'], description: 'record 必填：correction=用户纠正/否定，positive=用户明确认可，recall/read 一般由插件自动记录。' },
			note: { type: 'string', description: 'record 强烈建议填写：一句话说明这次判定针对的是**哪件事**（例如用户原话）。它不只是备注——翻转计数靠它区分「同一结论被推翻」与「同一个文件被纠正了不同的事」；不写就只能按相邻判定猜，容易把无关纠正误报成结论不稳定。' },
			days: { type: 'integer', description: 'report 的统计窗口（天，默认 30）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					days: { type: 'integer', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								href: { type: 'string', required: true },
								uses: { type: 'integer', required: true },
								exposure: { type: 'integer', required: true },
								recalls: { type: 'integer', required: true },
								reads: { type: 'integer', required: true },
								corrections: { type: 'integer', required: true },
								positives: { type: 'integer', required: true },
								badRate: { type: 'number', required: true },
								flips: { type: 'integer', required: true },
								layer: { type: 'string', required: true },
								lastUsed: { type: 'string', required: true },
							},
						},
					},
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				// action=record carries its confirmation in `warnings` with an empty
				// items list; the generic "no signals yet" branch below swallowed
				// that receipt, so a successful record looked like a no-op.
				if (v.action === 'record') {
					return [{ type: 'text', text: v.warnings.length ? v.warnings.join('\n') : '已记录使用信号。' }];
				}
				if (!v.items.length) return [{ type: 'text', text: '还没有使用信号。信号来自召回注入、memory_read、以及你用 memory_usage(action=record) 记录的纠正/认可。' }];
				const lines = [`近 ${v.days} 天使用信号（按实际触及排序；召回注入只算曝光，不算使用）：`];
				for (const it of v.items) {
					lines.push(`- [${it.layer}] ${it.href} · 触及 ${it.uses}（读 ${it.reads} + 判断 ${it.corrections + it.positives}）· 曝光 ${it.exposure}（召回 ${it.recalls}）· 纠正 ${it.corrections} · 认可 ${it.positives} · 纠正率 ${it.badRate}${it.flips ? ` · 翻转 ${it.flips}` : ''}`);
				}
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				lines.push('层只是建议：通用=可进默认推荐，专项=常规池，实验=仍在小范围验证。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory usage: ${args.action ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const days = Math.min(Math.max(1, Number(args.days) || 30), 365);
			const warnings = [];
			if (args.action === 'record') {
				const href = oneLine(args.href);
				// 5.27.0: a skill's own bundle is recordable too — the activate
				// evidence gate reads positives on `skills/<name>/SKILL.md`, and until
				// now the contract REJECTED exactly that href (hit twice in practice).
				const skillM = /^skills\/([^/]+)\/SKILL\.md$/.exec(href);
				// 月/周折叠方案（2026-11）：daily/YYYY-MM.md 月归档也是可记录
				// 信号的数据文件（读它/纠正它都要能记账），与 isTracked 的
				// daily/ 前缀口径一致；严格月号校验，其他 daily/ 路径仍拒。
				const dailyArchiveM = /^daily\/\d{4}-(?:0[1-9]|1[0-2])\.md$/.exec(href);
				if (!ZONE_RE_FILE_EXACT.test(href) && !/^\d{4}-\d{2}-\d{2}\.md$/.test(href) && !skillM && !dailyArchiveM) {
					throw new Error('href 必须是 functions/<名>.md、insights/<名>.md、dao/<名>.md、capabilities/<名>.md、skills/<技能>/SKILL.md、YYYY-MM-DD.md 或 daily/YYYY-MM.md');
				}
				if (skillM && !isSkillName(skillM[1])) throw new Error(`技能名必须是 kebab-case，收到：${skillM[1]}`);
				const kind = ['correction', 'positive', 'recall', 'read'].includes(args.kind) ? args.kind : null;
				if (!kind) throw new Error('kind 必须是 correction / positive / recall / read');
				await appendUsage(root, { href, kind, note: oneLine(args.note ?? '') || undefined });
				return { action: 'record', days, items: [], warnings: [`已记录：${kind} → ${href}${args.note ? `（${oneLine(args.note)}）` : ''}`] };
			}
			const entries = await readUsage(root, days);
			const items = summarizeUsage(entries).map((it) => ({
				href: it.href,
				uses: it.uses,
				exposure: it.exposure,
				recalls: it.recalls,
				reads: it.reads,
				corrections: it.corrections,
				positives: it.positives,
				badRate: it.badRate,
				flips: it.flips,
				layer: it.layer,
				lastUsed: new Date(it.last).toISOString(),
			}));
			const hot = items.filter((it) => it.layer === '通用').length;
			if (hot) warnings.push(`${hot} 条已达到「通用」建议线：可考虑在索引行里标明它是标配工具，或让它进默认推荐`);
			const bad = items.filter((it) => it.uses >= 3 && it.badRate > 0.4);
			for (const b of bad) warnings.push(`${b.href} 纠正率 ${Math.round(b.badRate * 100)}%（>40%）：先重构这条记忆，别继续往上叠迭代`);
			// Flips: confirmed then overturned (or the reverse). Two or more means the
			// memory keeps changing verdicts — the content is unstable, not unlucky.
			for (const f of items.filter((it) => it.flips >= 2)) {
				warnings.push(`${f.href} 结论被反复推翻（翻转 ${f.flips} 次）：先查清到底哪个判断成立，再决定保留哪一版——反复推翻的记忆不能当依据`);
			}
			return { action: 'report', days, items, warnings };
		},
	});
}

function memoryFederationTool(opts) {
	return defineTool({
		name: 'memory_federation',
		description:
			'Three-tier federation mode (opt-in via plugin config `federation: { root, projects: [{ key, root }] }`). action=sync copies every configured project\'s MEMORY.md into `<federation.root>/sources/<key>.MEMORY.md` and rebuilds the federation index table (one mechanical row per project: size + link). action=check lints the federation layer: missing index, dangling links, missing project roots, missing/orphan copies, and env-constant absolute paths that no longer exist. Project truth sources are never edited by this tool, and cross-project consensus is NOT auto-distilled — the model writes that section itself.',
		parameters: {
			action: { type: 'string', required: true, enum: ['sync', 'check'], description: 'sync=刷新副本与索引行；check=只读体检（F1–F5）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					federationRoot: { type: 'string', required: true },
					projects: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								key: { type: 'string', required: true },
								copied: { type: 'boolean', required: true },
								copyStatus: { type: 'string', required: true, enum: ['present', 'missing', 'unknown'] },
								sourceStatus: { type: 'string', required: true, enum: ['present', 'missing', 'unknown'] },
								countStatus: { type: 'string', required: true, enum: ['known', 'unknown'] },
								bytes: { type: 'integer', required: true },
								functions: { type: 'integer', required: true },
								insights: { type: 'integer', required: true },
								daily: { type: 'integer', required: true },
							},
						},
					},
					findings: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								level: { type: 'string', required: true, enum: ['WARN', 'FAIL'] },
								rule: { type: 'string', required: true },
								message: { type: 'string', required: true },
							},
						},
					},
					failCount: { type: 'integer', required: true },
					warnCount: { type: 'integer', required: true },
				},
			},
			render: (_args, v) => {
				const lines = [
					`联邦层：${v.federationRoot}（${v.action}）`,
					...v.projects.map((p) => `- ${p.key}: ${p.copyStatus === 'unknown' ? '副本状态未知' : p.copied ? (v.action === 'check' ? '副本存在（未比较内容）' : '已写入副本') : '副本不存在'} · ${p.sourceStatus === 'unknown' ? '源大小未知' : p.sourceStatus === 'missing' ? '源不存在' : `${p.bytes}B`} · ${p.countStatus === 'unknown' ? '分区数量未知' : `${p.functions} 功能 / ${p.insights} 思想 / ${p.daily} 日线索`}`),
				];
				if (!v.findings.length) lines.push('体检：全部通过（F1–F5）');
				else {
					lines.push(`体检：${v.failCount} FAIL，${v.warnCount} WARN`);
					for (const f of v.findings) lines.push(`  [${f.level}] ${f.rule}: ${f.message}`);
				}
				if (v.action === 'sync') lines.push('ℹ 跨项目共识不会自动生成——需要时把蒸馏结论写进「跨项目共识」小节。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory federation: ${args.action ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const fed = federationConfig(opts);
			const findings = [];
			const add = (level, rule, message) => findings.push({ level, rule, message });
			const sourcesDir = path.join(fed.root, 'sources');
			if (args.action === 'sync') await mkdir(sourcesDir, { recursive: true });
			const isMissing = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
			const readState = async (file) => {
				try { return { status: 'present', text: await readFile(file, 'utf8') }; }
				catch (error) { return isMissing(error) ? { status: 'missing' } : { status: 'unknown', error }; }
			};
			const projects = [];
			for (const p of fed.projects) {
				const memPath = path.join(p.root, 'MEMORY.md');
				const source = await readState(memPath);
				if (source.status === 'unknown') {
					if (args.action === 'sync') throw source.error;
					add('WARN', 'F3', `项目 ${p.key} 的 MEMORY.md 无法读取（${source.error?.code ?? 'unknown'}），来源状态未知：${memPath}`);
				} else if (source.status === 'missing') {
					add('FAIL', 'F3', `项目 ${p.key} 的记忆根里没有 MEMORY.md：${p.root}`);
				}
				let countStatus = 'known';
				const count = async (dir, predicate) => {
					try { return (await readdir(dir)).filter(predicate).length; }
					catch (err) {
						if (isMissing(err)) return 0;
						if (args.action === 'sync') throw err;
						countStatus = 'unknown';
						add('WARN', 'F3', `项目 ${p.key} 分区无法枚举：${dir}（${err?.code ?? 'unknown'}），该分区数量未知`);
						return 0;
					}
				};
				const counts = {
					functions: await count(path.join(p.root, 'functions'), (n) => n.endsWith('.md')),
					insights: await count(path.join(p.root, 'insights'), (n) => n.endsWith('.md')),
					// 月/周折叠方案（2026-11）：日线索计数含顶层日文件与 daily/ 下的
					// 月归档（与面板 zoneCounts 同口径）。
					daily: await count(p.root, (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)) + await count(path.join(p.root, 'daily'), (n) => /^\d{4}-\d{2}\.md$/.test(n)),
				};
				const bytes = source.status === 'present' ? byteLen(source.text) : 0;
				let copyStatus = 'unknown';
				if (args.action === 'sync') {
					if (source.status === 'present') {
						await writeText(path.join(sourcesDir, `${p.key}.MEMORY.md`), source.text);
						copyStatus = 'present';
					} else copyStatus = 'unknown';
				} else {
					try {
						copyStatus = await statExists(path.join(sourcesDir, `${p.key}.MEMORY.md`)) ? 'present' : 'missing';
						if (copyStatus === 'missing') add('FAIL', 'F3', `缺少来源副本 sources/${p.key}.MEMORY.md（先 action=sync）`);
					} catch (err) {
						add('WARN', 'F3', `项目 ${p.key} 的来源副本无法检查（${err?.code ?? 'unknown'}），副本存在状态未知：sources/${p.key}.MEMORY.md`);
					}
				}
				projects.push({ key: p.key, copied: copyStatus === 'present', copyStatus, sourceStatus: source.status, countStatus, bytes, ...counts });
			}
			const indexPath = path.join(fed.root, 'MEMORY.md');
			if (args.action === 'sync') {
				const rows = projects.map((p) => `| ${p.key} | ${p.functions} 功能 · ${p.insights} 思想 · ${p.daily} 日线索 · ${p.bytes}B | [sources/${p.key}.MEMORY.md](sources/${p.key}.MEMORY.md) |`);
				const indexState = await readState(indexPath);
				if (indexState.status === 'unknown') throw indexState.error;
				const existing = indexState.text;
				let next = federationIndexText(rows);
				if (existing !== undefined) {
					// Keep everything the model distilled (consensus + notes) and only
					// replace this tool's own table block.
					next = existing.replace(/\n## 项目索引（联邦层）[\s\S]*?(?=\n## |$)/, `\n${FED_TABLE_HEADING}\n\n${[FED_TABLE_HEADER, '|---|---|---|', ...rows].join('\n')}\n`);
					if (!next.includes(FED_TABLE_HEADING)) next = federationIndexText(rows);
				}
				await writeText(indexPath, next);
				opts.dropRecallCaches?.();
			} else {
				const indexState = await readState(indexPath);
				if (indexState.status !== 'present') {
					if (indexState.status === 'missing') add('FAIL', 'F1', `联邦层没有 MEMORY.md：${indexPath}（先 action=sync）`);
					else add('WARN', 'F1', `联邦层索引无法读取（${indexState.error?.code ?? 'unknown'}），状态未知：${indexPath}`);
					add('WARN', 'F2', '联邦索引不可读取，链接未检查，状态未知');
					add('WARN', 'F3', '联邦索引不可读取，项目索引行未检查，状态未知');
					add('WARN', 'F4', '联邦索引不可读取，绝对路径未检查，状态未知');
				} else {
					const idxText = indexState.text;
					try {
						await checkLinks(idxText, indexPath, fed.root, (level, rule, message) => add(level, rule.startsWith('R10') ? 'F2' : rule, message));
					} catch (err) {
						add('WARN', 'F2', `联邦索引链接检查中断（${err?.code ?? 'unknown'}），其余链接未检查，状态未知`);
					}
					for (const m of idxText.matchAll(/`([^`\n|]+)`/g)) {
						const p0 = m[1].trim().replace(/[/\\]+$/, '');
						if (!/^[A-Za-z]:[\\/]/.test(p0) && !p0.startsWith('/')) continue;
						try {
							if (!(await statExists(p0))) add('WARN', 'F4', `联邦层引用的绝对路径已不存在 -> ${p0}`);
						} catch (err) {
							add('WARN', 'F4', `联邦层绝对路径检查失败（${err?.code ?? 'unknown'}），存在状态未知 -> ${p0}`);
						}
					}
					for (const p of fed.projects) {
						if (!idxText.includes(`sources/${p.key}.MEMORY.md`)) add('FAIL', 'F3', `项目索引表缺少 ${p.key} 一行（重新 sync）`);
					}
				}
				try {
					for (const c of (await readdir(sourcesDir)).filter((n) => n.endsWith('.MEMORY.md'))) {
						if (!fed.projects.some((p) => `${p.key}.MEMORY.md` === c)) add('WARN', 'F5', `孤儿副本 sources/${c} 不对应任何已配置项目（移走或补配置）`);
					}
				} catch (err) {
					if (!isMissing(err)) add('WARN', 'F5', `来源副本目录无法枚举（${err?.code ?? 'unknown'}），孤儿副本未检查，状态未知：${sourcesDir}`);
				}
			}
			const failCount = findings.filter((f) => f.level === 'FAIL').length;
			const warnCount = findings.filter((f) => f.level === 'WARN').length;
			return { action: args.action, federationRoot: fed.root, projects, findings, failCount, warnCount };
		},
	});
}

async function listMdDir(dir) {
	let entries = [];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const f of entries.filter((n) => n.endsWith('.md')).sort()) {
		const st = await stat(path.join(dir, f));
		out.push({ name: f.replace(/\.md$/, ''), bytes: st.size, mtime: st.mtime.toISOString() });
	}
	// Newest-first: every listing consumer (model recall, panel) wants the
	// latest state at the top, not a file-manager's alphabetical order.
	out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
	return out;
}

// ---------------------------------------------------------------------------
// memory_capability — the tool/MCP ledger ("what can I use to solve this?")
// ---------------------------------------------------------------------------
//
// The other zones answer "how did we do it" (functions/), "what principle holds"
// (insights/), "what happened when" (daily). None of them answers "which CLI,
// MCP server or local tool exists for this job, and how do I call it" — so every
// session rediscovers it. This zone is a ledger of capability: one file per
// tool/server, with the exact invocation, the prerequisites, and what it solved.
// (CAP_DIR lives in src/constants.js)

// ---------------------------------------------------------------------------
// skills — the crystallization layer (borrowed from MemOS's skill tier, adapted)
// ---------------------------------------------------------------------------
//
// The data flow records / distills / promotes / displays, but never CLOSED the
// loop into "use": an operation that keeps being re-run and keeps being confirmed
// should become a directly callable procedure. MemOS does this with an async LLM
// pipeline (L1→L2→L3→Skill with V/α/gain math); we keep the file discipline —
// MECHANICAL NOMINATION (pure aggregation of the usage signals we already
// collect) + A JUDGEMENT CRYSTALLIZES (only the model in context knows whether
// the evidence is coherent enough to write a real procedure).
// (SKILL_* constants live in src/constants.js)

/**
 * Skill file format — the frontmatter idea is borrowed from Anthropic/lantern
 * skill-creator (skills/<name> + YAML frontmatter, description is the ROUTER
 * that decides when the skill fires, imperative writing style, machine-checkable
 * fields), adapted to our one-file-per-skill layout. `status` extends the
 * frontmatter with our lifecycle; `agent_created` marks files this tool owns.
 */
/**
 * Skill-name grammar comes from the bridge module (one source with the host
 * provider); the harness drift-guard compares it against the real package.
 */

/**
 * The usage-href list a skill's own evidence cites: its frontmatter `sources:`
 * normalized to zone paths (functions/x.md). Pure — the activate evidence gate
 * reads it to check whether the DISTILLATION SOURCE has use signals (a proven
 * area crystallized late still deserves promotion).
 */
export function srcsOfExisting(text) {
	const m = (text.match(/^sources:\s*\[([^\]]*)\]/m) ?? [])[1] ?? '';
	return m
		.split(',')
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter((s) => ZONE_RE.test(s));
}

function skillTemplate(name, f) {
	return [
		'---',
		`name: ${name}`,
		`description: "${f.description}"`,
		// `agent_created: true` is what makes this bundle OURS: the panel's
		// 结晶技能 tab is exactly the bundles carrying it, and the host provider
		// uses `status` to decide whether the skill is live. No hostName field —
		// the bundle DIRECTORY name already is the kebab host name.
		'agent_created: true',
		// Scope metadata (memory-function-org §技能作用域元数据): an owned skill
		// MUST carry scope — the audit WARNs without it, and cross-project recall
		// has no way to tell "applies everywhere" from "only valid in project A".
		`scope: ${f.scope}`,
		...(f.scope === 'project' && f.scopeProject ? [`scope_project: ${f.scopeProject}`] : []),
		...(f.scopeNotes ? [`scope_notes: "${f.scopeNotes.replace(/"/g, "'")}"`] : []),
		`status: ${f.status}`,
		`created: ${f.date}`,
		`sources: [${f.srcs.join(', ')}]`,
		'---',
		'',
		`# 技能：${name}`,
		'',
		`> 摘要：${f.summary}`,
		'',
		'## 何时使用',
		'',
		`- ${f.when}`,
		'',
		'## 调用步骤',
		'',
		f.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
		'',
		'## 前提与坑',
		'',
		`- ${f.pitfalls || '（待补：跑的过程中把踩到的坑记回这里）'}`,
		'',
		'## 验证方式',
		'',
		`- ${f.verification}`,
		'',
		'## 证据来源',
		'',
		...f.srcLines,
		'',
		// NO 使用记录/迭代日志 section (the user's ruling, 5.27.0): every
		// activate/retire appended a line here — the body grew with use while a
		// skill must stay the CURRENT procedure. Lifecycle lives in `status:`
		// alone; history belongs to the memory layer (functions/ blocks).
		'',
	].join('\n');
}

/**
 * Pure nomination pass over the SAME usage aggregation memory_usage uses: an
 * href is a skill candidate when uses/positives/bad-rate clear the floors and
 * no skill file yet points at it. Returns the rows a `memory_skill(candidates)`
 * call shows the model. `skillSources` = the 来源 lines of existing skill files
 * (so nominated-but-already-crystallized areas drop out).
 */
function nominateSkillCandidates(usageItems, skillSources) {
	const out = [];
	for (const it of usageItems) {
		if (!ZONE_RE_FI.test(it.href)) continue;
		if (it.uses < SKILL_NOMINATE.minUses) continue;
		if (it.positives < SKILL_NOMINATE.minPositives) continue;
		if (it.badRate >= SKILL_NOMINATE.maxBadRate) continue;
		const already = skillSources.some((src) => src === it.href || it.href.startsWith(src.replace(/\.md$/, '')));
		if (already) continue;
		out.push({ href: it.href, uses: it.uses, positives: it.positives, badRate: it.badRate, flips: it.flips });
	}
	// Most-used first; flips included so an unstable conclusion is visible, not
	// silently nominated.
	out.sort((a, b) => b.uses - a.uses);
	return out;
}

function capabilityTemplate(name, kind, date) {
	return [
		`# 能力：${name}`,
		'',
		`> 类型：${kind} · 首次登记：${date}`,
		'> 用途：任务开始前查这张台账，知道「有什么工具能用、怎么调」；不要重复摸索同一个工具。',
		'',
		'## 调用方式',
		'',
		'- ',
		'',
		'## 前提 / 环境',
		'',
		'- ',
		'',
		'## 解决过什么',
		'',
		'- ',
		'',
	].join('\n');
}

function memoryCapabilityTool(opts) {
	return defineTool({
		name: 'memory_capability',
		description:
			'Record or look up an EXTERNAL CAPABILITY: a third-party CLI, MCP server, local binary, or installed software the agent can call. The boundary is what counts as external — do NOT record (a) the harness\'s own built-in tools (shell/file/web/scheduler: the agent already knows them, recording is pure noise), (b) the project\'s own scripts or the plugin\'s own API (that is a functions/ iteration block), (c) anything the system provides natively. Record a tool only when USING it took discovery: the exact invocation, prerequisites, and the traps hit. The other zones answer "how we did it" / "what principle holds" / "what happened"; this one answers "what can I USE for this job, and how exactly do I invoke it". Use action=record after you discover or successfully use such a tool; use action=list before starting a task to see what is already available instead of rediscovering it. This is a CAPABILITY ledger, not an iteration log: per-tool one file, updated in place, never a dated journal.',
		parameters: {
			action: { type: 'string', required: true, enum: ['record', 'list', 'read'], description: 'record=登记/更新一个能力；list=列出全部能力（含一句话摘要）；read=读某个能力的完整台账。' },
			name: { type: 'string', description: 'record/read 必填：能力名（作为文件名），如 `ffmpeg`、`gh-cli`、`playwright-mcp`。' },
			kind: { type: 'string', enum: ['cli', 'mcp', 'binary', 'service', 'skill', 'other'], description: 'record 可选：能力类型，缺省 cli。' },
			invocation: { type: 'string', description: 'record 必填：怎么调用（真实可执行的命令或调用形式，一句话）。' },
			prereq: { type: 'string', description: 'record 可选：前提/环境（路径、token、版本、启动方式）。' },
			solved: { type: 'string', description: 'record 可选：用它解决过什么（一句话；可多次 record 追加）。' },
			summary: { type: 'string', description: 'record 可选：一句话摘要（进索引与列表用），缺省取 invocation 首句。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					file: { type: 'string' },
					created: { type: 'boolean' },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								kind: { type: 'string', required: true },
								summary: { type: 'string', required: true },
								invocation: { type: 'string', required: true },
								updated: { type: 'string', required: true },
							},
						},
					},
					content: { type: 'string' },
										selfCheck: SELF_CHECK_SCHEMA,
warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				if (v.action === 'read') return [{ type: 'text', text: v.content || '（空）' }];
				if (v.action === 'record') {
					const lines = [`已登记能力：${v.file}${v.created ? '（新建）' : '（更新）'}`];
					// 自检结果必须显示：合格给一句确认（含"其实只是专项"这类说明），不合格逐项点名。
					if (v.selfCheck) {
						lines.push(v.selfCheck.ok ? `✓ ${v.selfCheck.layer}层自检通过` : `⛔ ${v.selfCheck.layer}层自检未过：`);
						for (const n of v.selfCheck.notes ?? []) lines.push(`  ℹ ${n.message}`);
						for (const f of v.selfCheck.findings ?? []) lines.push(`  ✗ ${f.message}`);
					}
					for (const w of v.warnings) lines.push(`⚠ ${w}`);
					lines.push('ℹ 下次做任务前先 memory_capability(action=list) 看有没有现成的。');
					return [{ type: 'text', text: lines.join('\n') }];
				}
				if (!v.items.length) return [{ type: 'text', text: '能力台账还是空的。用到某个 CLI/MCP/本地工具后，用 memory_capability(action=record) 记一笔：调用方式、前提、解决过什么。' }];
				const lines = [`能力台账（${v.items.length} 项）：`];
				for (const it of v.items) lines.push(`- [${it.kind}] ${it.name} — ${it.summary}${it.invocation ? ` ｜ 调用：${it.invocation}` : ''}`);
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory capability: ${args.action ?? ''}${args.name ? ` ${args.name}` : ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const dir = path.join(root, CAP_DIR);
			const warnings = [];
			if (args.action === 'list') {
				let names = [];
				try {
					names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
				} catch {
					/* no ledger yet */
				}
				const items = [];
				for (const f of names.sort()) {
					const text = (await readIfExists(path.join(dir, f))) ?? '';
					const kindM = text.match(/^> 类型：([^\s·]+)/m);
					const invM = text.match(/## 调用方式\s*\n+-\s*(.+)/);
					const summaryM = text.match(/^>\s*摘要：(.+)$/m);
					const st = await stat(path.join(dir, f));
					items.push({
						name: f.replace(/\.md$/, ''),
						kind: kindM ? kindM[1] : 'other',
						summary: summaryM ? summaryM[1].trim() : (invM ? invM[1].trim().slice(0, 80) : '（无摘要）'),
						invocation: invM ? invM[1].trim().slice(0, 120) : '',
						updated: st.mtime.toISOString(),
					});
				}
				return { action: 'list', items, warnings };
			}
			const name = safeSlug(args.name);
			const p = path.join(dir, `${name}.md`);
			if (args.action === 'read') {
				const text = await readIfExists(p);
				if (text === undefined) throw new Error(`能力台账里没有 ${name}（先 memory_capability(action=record)）`);
				return { action: 'read', file: p, items: [], content: text, warnings };
			}
			// record / update
			const invocation = oneLine(args.invocation);
			if (!invocation) throw new Error('invocation is required: the exact command or call form, so the next session does not rediscover it');
			const kind = ['cli', 'mcp', 'binary', 'service', 'skill', 'other'].includes(args.kind) ? args.kind : 'cli';
			const date = localDateStr();
			const existing = await readIfExists(p);
			let text;
			const created = existing === undefined;
			if (created) {
				text = capabilityTemplate(name, kind, date);
			} else {
				text = existing;
			}
			// invocation: replace the section body (single source of truth)
			text = replaceSection(text, '## 调用方式', `- ${invocation}`);
			if (args.prereq !== undefined && oneLine(args.prereq)) {
				text = appendUnderHeading(text, '## 前提 / 环境', `- ${oneLine(args.prereq)}`).text;
			}
			if (args.solved !== undefined && oneLine(args.solved)) {
				text = appendUnderHeading(text, '## 解决过什么', `- ${date} ${oneLine(args.solved)}`).text;
			}
			const summary = oneLine(args.summary ?? '') || invocation.slice(0, 80);
			if (!/^>\s*摘要：/m.test(text)) {
				// keep the summary line right under the type line
				text = text.replace(/^(> 类型：.*)$/m, `$1\n> 摘要：${summary}`);
			} else {
				text = text.replace(/^>\s*摘要：.*$/m, `> 摘要：${summary}`);
			}
			const wroteCap = await writeText(p, text, { memoryRoot: root });
			if (wroteCap?.hits?.length) {
				warnings.push(`台账内容含凭据材料（${wroteCap.hits.join('、')}），落盘前已 redact——调用方式里留密钥没有意义，留调用形态即可`);
			}
			// Keep the index row in sync: the capability table is the "what can I
			// use" lookup surface, and a ledger nobody indexes is a ledger nobody
			// finds. Shares the MEMORY.md writer lock (audit #3).
			const indexPath = path.join(root, 'MEMORY.md');
			await withPathLock(indexPath, async () => {
				let indexText = (await readIfExists(indexPath)) ?? memoryIndexTemplate();
				const row = `| [${name}](${CAP_DIR}/${name}.md) | ${summary} |`;
				indexText = upsertIndexRow(indexText, CAP_TABLE_HEADING, CAP_TABLE_HEADER, name, row);
				await writeText(indexPath, indexText);
				// Fresh index: the just-written row must be recallable on the next
				// step, not up to 10s later (audit #10).
				opts.dropRecallCaches?.();
			});
			const st = await stat(p);
			// —— 写入后：从磁盘回读，按「器层定义」自检（2026-11-02）——
			// 器层台账的价值全在"下次不必重新摸索"：缺「调用方式」它就没用。
			const onDiskCap = (await readIfExists(p)) ?? '';
			const capCheck = checkArtifact({ layer: '器', content: onDiskCap, relPath: `capabilities/${name}.md` });
			warnings.push(...selfCheckWarnings(capCheck));
			return {
				action: 'record',
				file: p,
				created,
				items: [{ name, kind, summary, invocation, updated: st.mtime.toISOString() }],
				selfCheck: capCheck,
				warnings,
			};
		},
	});
}

/**
 * memory_skill — the CRYSTALLIZATION layer (12th tool). Closes the loop the
 * four-layer flow left open: an operation that keeps being RE-RUN (uses) and
 * keeps being CONFIRMED (positives, low correction rate) should become a
 * directly callable procedure under skills/. Nomination is mechanical (usage
 * signals only, no guessing); crystallization is the model's judgement — this
 * tool never auto-writes a skill body. Lifecycle: candidate → active (verified)
 * → retired (environment changed; file kept as history). Borrowed from MemOS's
 * skill tier, adapted to the file discipline.
 */
function memorySkillTool(opts, hooks = {}) {
	// After any write that can change what the HOST catalog should contain
	// (crystallize / activate / retire), nudge the bridge to invalidate. A
	// failure here must never break the tool receipt.
	const publish = () => {
		try {
			hooks.onSkillChange?.();
		} catch {
			/* host refresh is best-effort; the disk is the source of truth */
		}
	};
	return defineTool({
		name: 'memory_skill',
		description:
			'Crystallize a REPEATED, CONFIRMED operation into a callable procedure (the missing “use” step of the data flow: record → distill → promote → display → USE). A skill IS a host bundle under <dshHome>/skills/<kebab-name>/SKILL.md — the same directory the host `skill` tool loads and the panel shows; there is no memory-root copy. actions: candidates = which areas the usage signals nominate (pure aggregation: >=6 uses, >=1 confirmation, correction rate <20%, not already crystallized) — call it periodically and decide; crystallize = write that bundle from an area\'s proven steps (status=candidate); activate/retire = lifecycle transitions (activate only after the procedure was actually followed successfully; retire when the environment changed, the file stays as history); delete = remove the bundle and its index row (git is the only archive); list/read = what skills exist / full text. A skill answers “do it exactly like THIS” — distinct from capabilities/ (“what tool exists”) and insights/ (“what principle holds”). Scope (global/project) is the only metadata beyond the bundle name; the name itself is the kebab host name. WRITING the procedure MUST follow the skill-creator skill (load it via the `skill` tool: ~/.dsh/skills/skill-creator/): Step1 concrete examples → Step2 plan reusable contents → Step3 init_skill.py → Step4 imperative-style editing → Step5 quick_validate.py + package_skill.py → Step6 real-task iteration, with its Quality Bar applied (description <=80 words with a when-to-use trigger, use/do-not-use triggers, imperative style, machine-checkable rules, no dangling links, size budgets).',
		parameters: {
			action: { type: 'string', required: true, enum: ['candidates', 'crystallize', 'activate', 'retire', 'list', 'read', 'delete'], description: 'candidates=看提名；crystallize=结晶一份技能；activate/retire=生命周期；delete=删除技能文件与索引行（不可恢复，git 是档案）；list/read=查。' },
			project: { type: 'string', description: 'list 可选：按项目 key 过滤（skill_scope --route 语义）——global 技能全保留，project 技能只留 scope_project 匹配的，无 scope 的不计入确定适用。' },
			name: { type: 'string', description: 'crystallize/activate/retire/read 必填：技能名（文件名 slug）。' },
			summary: { type: 'string', description: 'crystallize 必填：一句话用途（索引行与命中提示用）。' },
			when: { type: 'string', description: 'crystallize 必填：什么任务信号出现时该用这条技能（触发条件，一句话）。' },
			procedure: { type: 'array', description: 'crystallize 必填：可直接执行的步骤（每步一句，命令写全），items: { type: string }。', items: { type: 'string' } },
			pitfalls: { type: 'string', description: 'crystallize 可选：前提与踩过的坑（一段话）。' },
			verification: { type: 'string', description: 'crystallize 必填：怎么算执行成功（判据，一句话）。' },
			sources: { type: 'array', description: 'crystallize 必填：证据来源（functions/xxx.md 等，提名/召回据此关联），items: { type: string }。', items: { type: 'string' } },
			scope: { type: 'string', enum: ['global', 'project'], description: '可选：技能作用域（原 memory-function-org 纪律：自有技能必须带 scope）。缺省 global=跨项目通用；project=只适用于某一项目，此时应同时给 scopeProject。' },
			scopeProject: { type: 'string', description: 'scope=project 时必填：项目目录名/key（如 toolbox-login），召回与路由据此判适用性。' },
			scopeNotes: { type: 'string', description: '可选：一句话说明适用条件（何时在哪些项目用）。' },
			note: { type: 'string', description: 'activate/retire 可选：一句话依据（哪次成功验证 / 环境怎么变了）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					file: { type: 'string' },
					created: { type: 'boolean' },
					status: { type: 'string' },
					candidates: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								href: { type: 'string', required: true },
								uses: { type: 'integer', required: true },
								positives: { type: 'integer', required: true },
								badRate: { type: 'number', required: true },
								flips: { type: 'integer', required: true },
							},
						},
					},
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								status: { type: 'string', required: true },
								summary: { type: 'string', required: true },
								updated: { type: 'string', required: true },
								// Declared here or the Host rejects the receipt — the
								// 5.11.3 lesson, applied BEFORE shipping, not after a
								// silent-write + rejected-receipt surprise.
								scope: { type: 'string' },
						owned: { type: 'boolean' },
						published: { type: 'boolean' },
							},
						},
					},
					content: { type: 'string' },
										selfCheck: SELF_CHECK_SCHEMA,
warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (args, v) => {
				if (v.action === 'read') return [{ type: 'text', text: v.content || '（空）' }];
				if (v.action === 'candidates') {
					if (!v.candidates?.length) return [{ type: 'text', text: `暂无提名（门槛：≥${SKILL_NOMINATE.minUses} 次使用 + ≥${SKILL_NOMINATE.minPositives} 次确认 + 纠正率 <${SKILL_NOMINATE.maxBadRate * 100}%）。使用信号继续累积，隔段时间再查。` }];
					const lines = [`技能提名（机械信号，是否结晶由你判断）：`];
					for (const c of v.candidates) lines.push(`- ${c.href} · 用 ${c.uses} 次 · 确认 ${c.positives} · 纠正率 ${c.badRate}${c.flips ? ` · 翻转 ${c.flips}` : ''}`);
					lines.push('ℹ 反复重跑且被确认的操作 → memory_skill(crystallize) 写成可调用程序；不确定就再等等。');
					return [{ type: 'text', text: lines.join('\n') }];
				}
				if (v.action === 'list') {
					const proj = oneLine(args.project ?? '');
					if (!v.items.length) return [{ type: 'text', text: proj ? `没有适用于项目「${proj}」的技能（global 或 scope_project 匹配的才算）。` : '还没有技能。先 memory_skill(candidates) 看提名，再把反复验证过的操作结晶成程序。' }];
					const lines = [`技能台账（${v.items.length} 项${proj ? `，已按项目「${proj}」路由过滤` : ''}）：`];
					for (const it of v.items) {
						// scope is READ here (and drives the filter above); published
						// reflects the bridge's real gate, not a re-derivation.
						const scopeTag = it.scope && it.scope !== 'unknown' ? ` · ${it.scope}` : '';
						lines.push(`- [${it.status}${it.published ? '→宿主' : ''}${scopeTag}] ${it.name} — ${it.summary}`);
					}
					for (const w of v.warnings) lines.push(`⚠ ${w}`);
					return [{ type: 'text', text: lines.join('\n') }];
				}
				const verb = v.action === 'crystallize' ? '已结晶技能' : v.action === 'activate' ? '已激活技能' : v.action === 'retire' ? '已退役技能' : '已删除技能';
				const lines = [`${verb}：${v.file}（status=${v.status}）`];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				// The bundle path comes from v.file, never from execute's `p` —
				// render is a SIBLING of execute, that name is out of its scope
				// (an adversarial audit caught exactly this: the host calls render
				// after every success, a ReferenceError here makes the host reject
				// a disk write that DID land — silent-write + rejected-receipt,
				// the 5.11.3 lesson recurring through an untested projection path).
				if (v.action === 'crystallize') lines.push(`ℹ 技能目录包已写入 ${path.dirname(String(v.file ?? ''))}。请按 skill-creator 流程打磨正文（skill 工具加载 ~/.dsh/skills/skill-creator/：规划内容 → 祈使句编辑 → scripts 配套 → quick_validate.py 校验）；按真实任务跑通一次后用 memory_skill(activate) 转正，pre-step 会优先提示命中技能。`);
				if (v.action === 'delete') lines.push('ℹ 文件与索引行已删除，宿主目录同步失效；历史只能从 git 恢复。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory skill: ${args.action ?? ''}${args.name ? ` ${args.name}` : ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			// ONE storage location (5.24.0): skills live as host bundles
			// (<dshHome>/skills/<kebab-name>/SKILL.md), the same directory the host
			// `skill` tool loads. There is no memory-root copy and no pointer file —
			// a skill is one bundle, edited in place.
			// `opts.skillRoot` exists so TESTS can point this at a temp dir: without
			// it the suite writes into the real user skill catalog (it did, once).
			const dir = opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills');
			const warnings = [];
			const bundleOf = (n) => path.join(dir, n, 'SKILL.md');
			const listAll = async (projectKey) => {
				let names = [];
				try {
					const entries = await readdir(dir, { withFileTypes: true });
					names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
				} catch {
					/* no skills yet */
				}
				const items = [];
				for (const n of names.sort()) {
					const text = (await readIfExists(bundleOf(n))) ?? '';
					if (!text) continue;
					// ONE parser: the same frontmatter reader the host bridge uses, so
					// what `list` reports can never drift from what the provider
					// advertises.
					const { fields, body } = parseSkillText(text);
					const status = fields.status ?? (body.match(/^> 状态：([a-z]+)/m) ?? [])[1] ?? 'candidate';
					const summary = (body.match(/^>\s*摘要：(.+)$/m) ?? [])[1]?.trim() || fields.description || '（无摘要）';
					const scope = fields.scope ?? 'unknown';
					if (projectKey && !skillAppliesToProject(fields, projectKey)) continue;
					const st = await stat(bundleOf(n));
					// `published` = this plugin owns it and it is active; the host
					// publishes exactly the active ones. Ownership is a FRONTMATTER
					// fact (see the /skills note: a body regex misreads skill-creator).
					const owned = /^(?:true|1)$/i.test(String(fields.agent_created ?? ''));
					items.push({
						name: n,
						status,
						summary,
						updated: st.mtime.toISOString(),
						scope,
						owned,
						published: owned && status === 'active',
					});
				}
				return items;
			};
			const syncIndexRow = async (item) => {
				const indexPath = path.join(root, 'MEMORY.md');
				// ONE lock for every MEMORY.md writer (audit #3): this row sync,
				// memory_index, capability record, skill delete and memory_rename all
				// read-modify-write the same file; serialized, no writer ever computes
				// from a snapshot another has already replaced.
				await withPathLock(indexPath, async () => {
					let indexText = (await readIfExists(indexPath)) ?? memoryIndexTemplate();
					// The row points at the HOST bundle path (absolute), because there is
					// no memory-root copy to link to any more.
					const href = `file:///${path.join(dir, item.name, 'SKILL.md').replace(/\\/g, '/')}`;
					const row = `| [${item.name}](${href}) | ${item.summary} | ${item.status} |`;
					indexText = upsertIndexRow(indexText, SKILL_TABLE_HEADING, SKILL_TABLE_HEADER, item.name, row);
					await writeText(indexPath, indexText);
				});
				// The recall cache must drop so the fresh skill row is recallable at
				// once (audit #10).
				opts.dropRecallCaches?.();
				// Every write that lands (crystallize/activate/retire all funnel here)
				// refreshes the host catalog — one choke point, no per-action miss.
				publish();
			};
			if (args.action === 'candidates') {
				const items = summarizeUsage(await readUsage(root));
				const all = await listAll();
				const skillSources = [];
				for (const it of all) {
					const text = (await readIfExists(bundleOf(it.name))) ?? '';
					// Read the CANONICAL frontmatter sources, not body links: 5.27.0
					// rewrote evidence links to absolute file:/// (they no longer
					// matched the old `../` regex), and parsing the field is immune to
					// how the links happen to be spelled. If nomination read nothing,
					// a crystallized area would be re-nominated forever.
					for (const h0 of srcsOfExisting(text)) skillSources.push(h0);
				}
				const candidates = nominateSkillCandidates(items, skillSources);
				return { action: 'candidates', candidates, items: [], warnings };
			}
			if (args.action === 'list') {
				const project = oneLine(args.project ?? '');
				return { action: 'list', items: await listAll(project || undefined), warnings };
			}
			// A skill's name IS its host bundle directory name, so it must satisfy
			// the host grammar (kebab-case). safeSlug is the MEMORY-file slug rule
			// (it allows CJK and forbids dots) — using it here would reject every
			// legal host name and accept illegal ones.
			const name = oneLine(args.name ?? '').trim();
			if (!name) throw new Error('name is required: the skill bundle directory name (kebab-case)');
			if (!isSkillName(name)) throw new Error(`技能名必须是 kebab-case（宿主语法 ^[a-z0-9]+(-[a-z0-9]+)*$），收到：${name}`);
			const p = bundleOf(name);
			if (args.action === 'read') {
				const text = await readIfExists(p);
				if (text === undefined) throw new Error(`技能库里没有 ${name}（先 memory_skill(crystallize)，或 candidates 看提名）`);
				return { action: 'read', file: p, items: [], content: text, warnings };
			}
			if (args.action === 'crystallize') {
				const summary = oneLine(args.summary);
				if (!summary) throw new Error('summary is required');
				const when = oneLine(args.when);
				if (!when) throw new Error('when is required: what task signal should trigger this skill');
				const steps = (Array.isArray(args.procedure) ? args.procedure : []).map((s) => oneLine(s)).filter(Boolean);
				if (steps.length < 2) throw new Error('procedure needs at least 2 concrete steps — a skill is a callable procedure, not a hint');
				const verification = oneLine(args.verification);
				if (!verification) throw new Error('verification is required: how success is judged after following the procedure');
				const srcs = (Array.isArray(args.sources) ? args.sources : [])
					.map((s) => oneLine(s))
					.filter(Boolean)
					// Evidence hrefs must resolve: callers hand over anything from a
					// bare slug ("memory-manager") to a full "../functions/x.md".
					// Stripping the zone prefix and re-adding only `../` produced the
					// dangling `../memory-manager` R10 caught on the real root.
					// Normalize to a zone path; the default zone is functions/ — where
					// the iteration history a skill cites lives.
					.map((s) => {
						if (s.includes('](')) return s; // an authored markdown link passes through
						const t = s.trim().replace(/^\.\.?\//, '').replace(/\.md$/i, '');
						return /^(functions|insights|capabilities|skills)\//.test(t) ? `${t}.md` : `functions/${t}.md`;
					});
				if (!srcs.length) throw new Error('sources is required: link the evidence areas (functions/xxx.md) the procedure was distilled from');
				const date = localDateStr();
				const existing = await readIfExists(p);
				const created = existing === undefined;
				// Scope defaults to global; a project-bound skill must SAY so (the
				// origin-skill audit WARNs on owned skills without scope — R20 mirrors
				// it, so defaults must be written down, never left implied).
				const scope = args.scope === 'project' ? 'project' : 'global';
				const scopeProject = oneLine(args.scopeProject ?? '');
				if (scope === 'project' && !scopeProject) {
					warnings.push('scope=project 但没给 scopeProject：项目归属未知，路由/审计会按未知作用域处理（补 scopeProject=<项目目录名>）');
				}
				const scopeNotes = oneLine(args.scopeNotes ?? '');
				// (name already validated as kebab-case at the entry — it is the
				// bundle directory name, i.e. the host name.)
				// OWNERSHIP GATE (5.27.0, from the adversarial audit): crystallize
				// overwrites the whole file, so it may only do that to a bundle this
				// plugin owns. A hand-installed skill is not ours to rewrite; the
				// delete path had this guard and crystallize did not — the asymmetry
				// was the bug.
				if (existing !== undefined && !/^(?:true|1)$/i.test(String(parseSkillText(existing).fields.agent_created ?? ''))) {
					throw new Error(`${name} 已存在且不是本插件结晶的技能（frontmatter 无 agent_created）：不覆盖外来技能，请换名或先由它的来源渠道管理`);
				}
				// Re-crystallization KEEPS the lifecycle: activating then improving a
				// skill must not silently demote it to candidate (the status line and
				// the ⭐ recall gate both read it).
				const priorStatus = created ? 'candidate' : ((existing.match(/^status:\s*([a-z]+)/m) ?? existing.match(/^> 状态：([a-z]+)/m) ?? [])[1] ?? 'candidate');
				if (!created) {
					warnings.push(`技能已存在：本次为整体重结晶（覆盖正文与程序），生命周期保留为 ${priorStatus}；旧版已存进 .history/（见下）`);
				}
				// Router field (the skill-creator lesson): the frontmatter description
				// decides WHEN the skill fires, so it embeds the trigger, third-person.
				const description = `当${when}时使用本技能：${summary}`.replace(/"/g, "'");
				const srcLines = srcs.map((s) => {
					if (s.includes('](')) return `- ${s}`; // an authored markdown link passes through
					const rel = s.trim().replace(/^\.\.?\//, '').replace(/\.md$/i, '');
					const label = rel.replace(ZONE_RE_SKILLS_NC, '');
					// ABSOLUTE link into the memory root (5.27.0): the bundle lives at
					// <dshHome>/skills/<name>/, NOT under the memory root — the old
					// `../functions/x.md` resolved to <dshHome>/skills/functions/x.md,
					// a path that never exists (the audit caught R10 blind to it,
					// because the health check only walks the memory root). Same
					// strategy as the index row href.
					return `- [${label}.md](file:///${path.join(root, rel + '.md').replace(/\\/g, '/')})`;
				});
				const body = skillTemplate(name, {
					status: priorStatus,
					date,
					srcs,
					description,
					summary,
					when,
					scope,
					scopeProject,
					scopeNotes,
					steps,
					pitfalls: oneLine(args.pitfalls ?? ''),
					verification,
					srcLines,
				});
				// Write the BUNDLE: <dshHome>/skills/<name>/SKILL.md. The directory is
				// the host's discovery unit, so the tool creates exactly what the host
				// (and the panel) reads — one storage location, no memory-root copy.
				await mkdir(path.dirname(p), { recursive: true });
				// THE ARCHIVE IS REAL (5.27.0): receipts used to promise "old version
				// kept by git" while <dshHome>/skills is not a repository on this
				// machine — an overwrite that claimed a safety net which did not
				// exist. Keep the superseded body ourselves, append-only, before
				// replacing it. Only one slot exists per day; if occupied, its
				// provenance cannot be established here, so preserve it and stop.
				if (existing !== undefined) {
					const histDir = path.join(dir, '.history');
					const histFile = path.join(histDir, `${name}-${date}.md`);
					try {
						await mkdir(histDir, { recursive: true });
						// The name may already denote a dangling symlink or another file.
						// Exclusivity checks the directory entry without following it.
						await writeFile(histFile, existing, { encoding: 'utf8', flag: 'wx' });
					} catch (cause) {
						const occupied = cause?.code === 'EEXIST';
						const error = new Error(occupied
							? `历史快照创建结果不明：路径已被占用（${histFile}）；无法确认既有快照的安全性和来源，SKILL.md 未修改。请核查现场，不可盲目重试或删除快照。`
							: `历史快照创建结果不明（${histFile}，${cause?.code ?? 'unknown'}）；SKILL.md 未修改。请核查现场，不可盲目重试或删除快照。`, { cause });
						error.code = occupied ? 'MEMORY_SKILL_HISTORY_EXISTS' : 'MEMORY_SKILL_HISTORY_UNKNOWN';
						error.skillWritten = false;
						error.snapshotWritten = null;
						throw error;
					}
				}
				await writeText(p, body);
				await appendUsage(root, { href: `skills/${name}/SKILL.md`, kind: 'lifecycle', note: created ? `结晶（${priorStatus}）` : `重结晶（保留 ${priorStatus}）` });
				const st = await stat(p);
				const item = { name, status: priorStatus, summary, updated: st.mtime.toISOString() };
				await syncIndexRow(item);
				// —— 写入后：从磁盘回读，按「技能层定义」自检（2026-11-02）——
				// 技能是**宿主目录包**，靠 frontmatter 被宿主发现：缺 name/status
				// 或 name 不是 kebab-case，它会静静地不被加载 —— 结晶等于白做。
				const onDiskSkill = (await readIfExists(p)) ?? '';
				const skillCheck = checkArtifact({ layer: '技能', content: onDiskSkill, relPath: `skills/${name}/SKILL.md` });
				warnings.push(...selfCheckWarnings(skillCheck));
				return { action: 'crystallize', file: p, created, status: priorStatus, items: [item], selfCheck: skillCheck, warnings };
			}
			if (args.action === 'activate' || args.action === 'retire') {
				const text = await readIfExists(p);
				if (text === undefined) throw new Error(`技能库里没有 ${name}`);
				if (!/^(?:true|1)$/i.test(String(parseSkillText(text).fields.agent_created ?? ''))) {
					throw new Error(`${name} 不是本插件结晶的技能（缺 agent_created）：生命周期归它的来源渠道管`);
				}
				const to = args.action === 'activate' ? 'active' : 'retired';
				// frontmatter `status:` is canonical; tolerate the pre-5.12 head form.
				const cur = (text.match(/^status:\s*([a-z]+)/m) ?? text.match(/^> 状态：[a-z]+/m) ?? [])[1] ?? 'candidate';
				const note = oneLine(args.note ?? '');
				if (cur === to) throw new Error(`${name} 已是 ${to}`);
				if (to === 'retired' && cur === 'candidate') warnings.push('candidate 直接 retired：未经使用即放弃，确认是否应保留观察');
				// EVIDENCE GATE (5.27.0): promotion to active — the one state that
				// enters recall as ⭐ "follow it, do not re-derive" and publishes to
				// the host — must point at SOME use signal: a positive/read on the
				// skill itself, or on the area it was distilled from. "Activate only
				// after the procedure was actually followed" used to be prose only;
				// the model can still carry it explicitly with `note` (recorded into
				// the usage ledger — the body stays the current procedure).
				if (to === 'active') {
					const usageItems = summarizeUsage(await readUsage(root));
					const own = usageItems.find((u) => u.href === `skills/${name}/SKILL.md`);
					const fromArea = srcsOfExisting(text).some((h0) => {
						const u = usageItems.find((x) => x.href === h0);
						return u && (u.positives > 0 || u.reads > 0);
					});
					if (!((own && (own.positives > 0 || own.recalls > 0)) || fromArea) && !note) {
						throw new Error(`把 ${name} 转正需要证据：它（或来源功能域）还没有任何使用/认可以外信号。真跑通过就在 note 里写清哪次任务跑通（会记进台账），或先 memory_usage(record) 记一笔认可`);
					}
					if (!((own && (own.positives > 0 || own.recalls > 0)) || fromArea) && note) {
						warnings.push('转正仅凭 note 声明（无机械使用信号）：note 已记入 .usage.jsonl 供事后审计');
					}
				}
				const date = localDateStr();
				// Update whichever status marker the file actually carries so the two
				// formats never both survive on one file.
				let next = text;
				if (/^status:/m.test(next)) next = next.replace(/^status:\s*[a-z]+/m, `status: ${to}`);
				else next = next.replace(/^> 状态：[a-z]+/m, `> 状态：${to}`);
				// NO append to the body (5.27.0, the user's ruling): a dated 使用记录
				// line per lifecycle flip grew the skill file with use, while a skill
				// must stay the CURRENT procedure. `status:` is the only lifecycle
				// surface; the timestamped event goes to the usage ledger instead.
				await writeText(p, next);
				await appendUsage(root, { href: `skills/${name}/SKILL.md`, kind: 'lifecycle', note: `${args.action}${note ? `：${note}` : ''}` });
				const st = await stat(p);
				const sumM = next.match(/^>\s*摘要：(.+)$/m) ?? next.match(/^description:\s*"?([^"\n]+)"?/m);
				const item = { name, status: to, summary: sumM ? sumM[1].trim() : name, updated: st.mtime.toISOString() };
				await syncIndexRow(item);
				return { action: args.action, file: p, status: to, items: [item], warnings };
			}
			if (args.action === 'delete') {
				// Full lifecycle close (5.24.0): a skill IS a bundle directory, so
				// delete removes the WHOLE bundle — not just SKILL.md (a lone
				// scripts/ left behind would be an orphan no tool manages). The index
				// row goes with it and the host catalog is refreshed in the same
				// breath, because a deleted skill must not stay loadable. Guard: this
				// plugin may delete only the bundles IT owns (agent_created) — an
				// installed skill belongs to its own source (package manager, git).
				const text = await readIfExists(p);
				if (text === undefined) throw new Error(`技能库里没有 ${name}`);
				if (!/^(?:true|1)$/i.test(String(parseSkillText(text).fields.agent_created ?? ''))) {
					throw new Error(`${name} 不是本插件结晶的技能（缺 agent_created），删除请走它自己的来源渠道`);
				}
				await rm(path.dirname(p), { recursive: true, force: true });
				const indexPath = path.join(root, 'MEMORY.md');
				await withPathLock(indexPath, async () => {
					const idxText = await readIfExists(indexPath);
					if (idxText !== undefined) {
						const without = dropIndexRow(idxText, SKILL_TABLE_HEADING, SKILL_TABLE_HEADER, name);
						if (without !== idxText) await writeText(indexPath, without);
					}
				});
				opts.dropRecallCaches?.();
				publish();
				return { action: 'delete', file: p, status: 'deleted', items: [], warnings };
			}
			throw new Error(`unknown action: ${args.action}`);
		},
	});
}

function memoryWriteTool(opts) {
	return defineTool({
		name: 'memory_write',
		description:
			'Append ONE iteration block to functions/<feature>.md (distilled conclusion, not a process log; dates are tags, blocks are append-only) and refresh the file-head stable-state summary via `currentState`. The daily log (YYYY-MM-DD.md) is the RAW evidence layer and is never rewritten by this tool; agent editing is permitted, but direct edits are not authenticated plugin collection and their provenance may be unknown. **Cadence rule (user, 2026-11-09): a block synthesizes >=3 TOPIC-RELEVANT days of daily-log material, not a single day and not a sliding 3-day window** — pick the days yourself: define the theme, search ALL daily logs (memory_search), select the dates genuinely related to it (may be non-contiguous, weeks apart), and note in the block why those days were chosen. Evidence relevance, not calendar adjacency. Write what HOLDS across those days (evolution, recurrence, reversal). Under 3 relevant days: keep accumulating, distill at the weekly review. Exceptions (note the reason in the block): explicit user request, or same-day pitfall-causality/safety constraints. The MEMORY.md index row is written separately (memory_index) once a feature area stabilizes, so distillation flows daily → functions → index, one direction per step. Hard limits enforced on write: block body ≤900 chars, 概括 ≤110 chars (over-length is rejected as a process log, not a distilled conclusion). A block is a DISTILLED conclusion (动因 / 改动 / 判据 / 待观察, one line each): per-step changelists, code-level enumerations and debugging process stay in the session, the daily log and the code — writing them into the block is the failure R14 flags.',
		parameters: {
			// Declaration order is display order: the host's generic tool card shows
			// `name · first string argument`, so the FIRST parameter must be the
			// human-meaningful one (the block title), never the feature slug — a
			// slug like "memory-manager" rendered as "memory_write · memory-manager"
			// and read like a broken plugin-qualified name.
			title: { type: 'string', required: true, description: '一句话结论式标题，如“修复 config 加载顺序导致的空指针”；不要“优化了一些问题”这类空话。' },
			feature: { type: 'string', required: true, description: '功能域 slug（文件名，不含 .md）：这个迭代属于哪个功能/模块；不确定就先 memory_read kind=index。' },
			change: { type: 'string', description: '改动（结论级，1-3 句）：现在是什么行为 / 改了什么。不写过程——逐条实现清单、代码级枚举、调试经过都不进记忆（留在会话与代码/提交里）。' },
			reason: { type: 'string', description: '原因（一句话）：为什么必须改（用户诉求 / 缺陷根因）。' },
			verification: { type: 'string', description: '验证（一句话 + 关键数字）：测试名/命令/实测现象；不要复述全部断言细节。' },
			result: { type: 'string', enum: ['done', 'reverted', 'pending'], description: '结果：done=完成 / reverted=已回滚 / pending=进行中。' },
			open: { type: 'string', description: '待观察（一句话）：遗留风险或下一步要确认什么。' },
			guard: { type: 'boolean', description: '守护型标记：低频高价值、绝不能因为"很久没写"被判冷记忆的记忆（安全审计、关键踩坑、兜底规则）。写入后文件头带 🛡 标记，体检 TEMP 跳过它；传 false 不解除已有标记（删掉文件头那行才真正解除）。' },
			related: { type: 'array', description: '相关功能域 slug 列表，渲染为迭代块内的“相关”链接。', items: { type: 'string' } },
			summary: { type: 'string', required: true, description: '本块的一句话概括（≤60 字）：从每日原始记录蒸馏本迭代时，它回答“这次迭代做了什么/解决了什么”。功能域稳定后由 memory_index 把它收进索引行。' },
			currentState: { type: 'string', description: '刷新文件头部“当前状态摘要”：只写当前稳定行为/关键约束/隐患（3-5 条），不写历史与过程。' },
			date: { type: 'string', description: '迭代日期 YYYY-MM-DD；缺省今天。同日第二个迭代自动加“补”后缀。' },
			replace: {
				type: 'string',
				description: '可选：写完迭代块后在本功能文件内做字面替换（全部出现）。JSON 形式 {"oldString":"...","newString":"..."} 或其数组；找不到目标时报错。用于修正既往迭代块笔误/死链，审计上等价于追加一次修正迭代。',
			},
			resolve: {
				type: 'string',
				description: '兼容保留：功能域 slug，声明本迭代解决了该功能的待观察项；为保护原始证据不会改写或勾选历史每日记录，回执会给出提示。',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					featureFile: { type: 'string', required: true },
					appendedHeading: { type: 'string', required: true },
					createdFunctionFile: { type: 'boolean', required: true },
					functionBytes: { type: 'integer', required: true },
					resolvedDailyLogs: { type: 'array', required: true, items: { type: 'string' } },
					selfCheck: SELF_CHECK_SCHEMA,
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`已写入：${v.appendedHeading}`,
					`功能文件：${v.featureFile}（${v.functionBytes}B${v.createdFunctionFile ? '，新建' : ''}）`,
				];
				if (v.resolvedDailyLogs.length) lines.push(`✅ 已勾掉待观察项：${v.resolvedDailyLogs.join('、')}`);
				lines.push('ℹ 索引行未自动写入——功能域稳定后用 memory_index 收进索引；本工具不改写每日原始记录，直接编辑的来源可能未知。');
				// 自检结果必须显示：合格给一句确认，不合格逐项点名。
				if (v.selfCheck) {
					lines.push(v.selfCheck.ok ? `✓ ${v.selfCheck.layer}层自检通过` : `⛔ ${v.selfCheck.layer}层自检未过：`);
					for (const n of v.selfCheck.notes ?? []) lines.push(`  ℹ ${n.message}`);
					for (const f of v.selfCheck.findings ?? []) lines.push(`  ✗ ${f.message}`);
				}
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory write: ${args.feature ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const feature = safeSlug(args.feature);
			const resolveTarget = typeof args.resolve === 'string' && args.resolve.trim() ? safeSlug(args.resolve) : undefined;
			const date = normDate(args.date);
			const title = oneLine(args.title);
			if (!title) throw new Error('title is required');
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the MEMORY.md index row must carry a one-line summary');
			const warnings = [];

			const indexPath = path.join(root, 'MEMORY.md');
			const indexNow = await readIfExists(indexPath);
			if (indexNow !== undefined && byteLen(indexNow) >= opts.maxIndexHardBytes) {
				throw new Error(
					`MEMORY.md 已 ${byteLen(indexNow)}B ≥ 硬上限 ${opts.maxIndexHardBytes}B：先压缩索引行或按 ### 子分区拆分（拒绝写入以保护索引扫描成本）`,
				);
			}

			// 0) duplicate suspicion (dedupe aid): compare the new summary with
			// every existing index row via token overlap. High overlap on a
			// DIFFERENT feature warns the model to confirm add-vs-update first.
			if (indexNow !== undefined) {
				const sumTokens = tokensOf(summary);
				for (const raw of indexNow.split('\n')) {
					const s = raw.trim();
					if (!s.startsWith('|') || s.includes('---')) continue;
					const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
					if (cells.length < 2 || !cells[1]) continue;
					const rowName = cells[0].replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
					if (rowName === feature) continue; // updating its own row is fine
					const rowTokens = tokensOf(cells.slice(1).join(' '));
					let hit = 0;
					for (const tk of sumTokens) if (rowTokens.has(tk)) hit++;
					if (sumTokens.size > 0 && hit / sumTokens.size >= 0.6) {
						warnings.push(`疑似与已有功能域「${rowName}」重复（摘要重合 ${(hit / sumTokens.size * 100) | 0}%）：先 memory_read kind=index 确认这是新功能还是对既有功能的更新；若为更新，直接对 ${rowName} 追加迭代`);
						break;
					}
				}
			}

			// 1) function file: create / refresh head summary / append iteration block
			const fnPath = path.join(root, 'functions', `${feature}.md`);
			let fnText = await readIfExists(fnPath);
			const created = fnText === undefined;
			if (created) fnText = functionFileTemplate(feature, date, args.guard === true);
			if (args.guard === true && !fnText.includes(GUARD_MARK)) {
				// Marking an existing file as guarded: insert the marker line right
				// after the scope line so the head reads top-down without surprises.
				const lines = fnText.split('\n');
				const scopeAt = lines.findIndex((l) => l.startsWith('> 范围：'));
				lines.splice(scopeAt === -1 ? 2 : scopeAt + 1, 0, GUARD_LINE);
				fnText = lines.join('\n');
			}
			if (args.currentState !== undefined) {
				const cs = String(args.currentState).trim();
				if (cs) fnText = refreshSummarySection(fnText, date, cs);
			}
			const suffixCount = countHeadingDate(fnText, date);
			const suffix = suffixCount === 0 ? '' : suffixCount === 1 ? '补' : `补${suffixCount}`;
			const heading = `## [${date}${suffix}] ${title}`;
			const bullets = [`- **概括**：${summary}`];
			if (args.change !== undefined && oneLine(args.change)) bullets.push(`- **改动**：${oneLine(args.change)}`);
			if (args.reason !== undefined && oneLine(args.reason)) bullets.push(`- **原因**：${oneLine(args.reason)}`);
			if (args.verification !== undefined && oneLine(args.verification)) bullets.push(`- **验证**：${oneLine(args.verification)}`);
			if (args.result !== undefined) bullets.push(`- **结果**：${RESULT_LABEL[args.result] ?? oneLine(args.result)}`);
			if (args.open !== undefined && oneLine(args.open)) bullets.push(`- **待观察**：${oneLine(args.open)}`);
			if (Array.isArray(args.related) && args.related.length) {
				// Sibling links: the host file already lives in functions/, so the
				// href must be bare `<name>.md`. Slugs without an existing file are
				// listed as plain text instead of dangling markdown links.
				const rels = [...new Set(args.related.map((r) => safeSlug(r)))].filter((r) => r !== feature);
				const rendered = [];
				for (const r of rels) {
					rendered.push(
						(await statExists(path.join(root, 'functions', `${r}.md`)))
							? `[${r}.md](${r}.md)`
							: `${r}（未建档）`,
					);
				}
				bullets.push(`- 相关：${rendered.length ? rendered.join('、') : '（无）'}`);
			}
			// Distillation gate: warn at write time instead of letting a process log
			// land silently (the same limits are re-checked by R14 in memory_check).
			const blockBody = bullets.join('\n');
			const blockChars = charLen(blockBody);
			if (blockChars > MAX_BLOCK_CHARS) {
				warnings.push(
					`本块正文 ${blockChars} 字 > ${MAX_BLOCK_CHARS}：迭代块只写结论（动因/改动/判据/待观察 各一句），逐条实现清单与调试过程留在会话/代码里；体检 R14 也会复查`,
				);
			}
			const summaryChars = charLen(args.summary);
			if (summaryChars > MAX_ROW_SUMMARY_CHARS) {
				warnings.push(`索引行摘要 ${summaryChars} 字 > ${MAX_ROW_SUMMARY_CHARS}：摘要是一句话（用来判断相关性），迭代细节留在功能文件`);
			}
			fnText = appendBlock(fnText, `\n${heading}\n\n${blockBody}\n`);
			if (typeof args.replace === 'string' && args.replace.trim()) {
				let pairs;
				try {
					const parsed = JSON.parse(args.replace);
					pairs = Array.isArray(parsed) ? parsed : [parsed];
				} catch {
					pairs = null;
				}
				if (!Array.isArray(pairs) || !pairs.length) {
					throw new Error('replace must be JSON: {"oldString":"...","newString":"..."} or an array of those');
				}
				for (const p of pairs) {
					if (typeof p?.oldString !== 'string' || !p.oldString || typeof p?.newString !== 'string') {
						throw new Error('each replace entry needs non-empty oldString and newString');
					}
					const count = fnText.split(p.oldString).length - 1;
					if (count === 0) throw new Error(`replace target not found in functions/${feature}.md: ${p.oldString.slice(0, 60)}`);
					fnText = fnText.split(p.oldString).join(p.newString);
				}
			}
			const wrote = await writeText(fnPath, fnText, { memoryRoot: root });
			if (wrote?.hits?.length) {
				warnings.push(`写入内容含凭据材料（${wrote.hits.join('、')}），落盘前已 redact 为 [REDACTED:kind]——密钥不该进记忆，请改用凭据服务`);
			}
			const fnBytes = byteLen(fnText);
			if (fnBytes > opts.maxFunctionBytes) {
				warnings.push(`functions/${feature}.md ${fnBytes}B > ${opts.maxFunctionBytes}B：调用 memory_fold(feature="${feature}") 折叠最旧块为早期演化段`);
			}

			// 2) index row is NOT auto-written anymore: the MEMORY.md index is the
			// integration layer (memory_index), written once a feature area
			// stabilizes — distillation flows daily → functions → index.

			// This tool preserves historical daily evidence, regardless of its source.
			// Keep resolve and resolvedDailyLogs for existing callers, but do not
			// rewrite the historical evidence or imply that entries were resolved.
			const resolvedIn = [];
			if (resolveTarget) warnings.push(`resolve: ${resolveTarget} 的功能迭代已记录；为保留原始证据，未修改或勾选任何历史每日记录，也未确认其中的待观察项已解决。`);

			// —— 写入后：从磁盘回读，按「术层定义」自检（用户 2026-11-02 要求）——
			//
			// 术层最常见的腐坏是"块变成过程流水"（超 900 字、缺判据小节），
			// 而它本该是**蒸馏后的结论**。回读产物而不是查内存中间态：
			// 与体检 R14 读同一份字节。
			const onDiskFn = (await readIfExists(fnPath)) ?? '';
			const selfCheck = checkArtifact({ layer: '术', content: onDiskFn, relPath: `functions/${feature}.md` });
			warnings.push(...selfCheckWarnings(selfCheck));

			return {
				featureFile: fnPath,
				appendedHeading: heading,
				createdFunctionFile: created,
				functionBytes: fnBytes,
				resolvedDailyLogs: resolvedIn,
				selfCheck,
				warnings,
			};
		},
	});
}

function memoryInsightTool(opts) {
	return defineTool({
		name: 'memory_insight',
		description:
			'Distill a TRANSFERABLE PRINCIPLE (something you would RE-APPLY, not an operation you would re-run) into insights/<theme>.md with backlinks to its source feature files, and sync the MEMORY.md insights table. Consensus/rules and env constants belong in MEMORY.md instead; how-to steps belong in functions/. Writing the same idea into both zones is a rule violation. The file must also carry a boundary section (适用面/边界) that says when the principle does NOT hold — a one-sided 适用范围 without a negative case is rejected (boundary-one-sided).',
		parameters: {
			theme: { type: 'string', required: true, description: '思想主题 slug（文件名，不含 .md），如“等待策略”。' },
			principle: { type: 'string', required: true, description: '原则本体，具体地一句话说清（不要“注意性能”这类空话）。' },
			summary: { type: 'string', required: true, description: '索引行的一行内涵：这个原则解决什么权衡。' },
			sources: { type: 'array', required: true, description: '来源功能域 slug 列表（必须已存在于 functions/，用于回链）。', items: { type: 'string' } },
			evolution: { type: 'string', description: '思想演进：取代了什么旧做法 / 为什么。' },
			applicability: { type: 'string', description: '适用面：超出来源功能还适用于哪里。' },
			open: { type: 'string', description: '待观察：下一步要验证什么。' },
			supersedes: {
				type: 'string',
				description: '可选：被本思想取代的旧主题 slug（须已存在于 insights/）。自动给旧文件加“已取代”头部并链接到本主题（不删除，保留历史）。',
			},
			valve_evidence: {
				type: 'object',
				additionalProperties: false,
				properties: {
					evidence: { type: 'array', items: { type: 'string' }, description: '反例/trace 引用列表。' },
					verifiable_by: { type: 'string', description: '用什么外部手段可推翻本原则（J1 防伪）。' },
					skill_coverage: { type: 'integer', description: '覆盖独立技能数。' },
					scenario_coverage: { type: 'integer', description: '覆盖场景数。' },
					anti_example_count: { type: 'integer', description: '可外部检验的反例数。' },
					predict_rate: { type: 'number', description: '预测新场景成功率（0–1）。' },
					overlap: { type: 'number', description: '与已有判据的重叠度（0–1）。' },
				},
				description:
					'可选：上行阀门的量化证据（装了 dsh-valves 才消费；只留痕，不影响写入判定）。不给则账本如实记"证据不足"。',
			},
			date: { type: 'string', description: 'YYYY-MM-DD；缺省今天。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					insightFile: { type: 'string', required: true },
					linkedSources: { type: 'array', required: true, items: { type: 'string' } },
					skippedSources: { type: 'array', required: true, items: { type: 'string' } },
					supersededFile: { type: 'string' },
					// The schema is additionalProperties:false — every field execute
					// returns must be declared here or the Host rejects the receipt
					// (the 5.11.3 lesson, in reverse).
					trust: { type: 'object', required: true, additionalProperties: false, properties: { level: { type: 'string', required: true }, positives: { type: 'number', required: true }, corrections: { type: 'number', required: true } } },
					selfCheck: SELF_CHECK_SCHEMA,
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [`思想已沉淀：${v.insightFile}`];
				if (v.linkedSources.length) lines.push(`回链来源：${v.linkedSources.join('、')}`);
				if (v.skippedSources.length) lines.push(`⚠ 来源不存在，未回链：${v.skippedSources.join('、')}`);
				if (v.supersededFile) lines.push(`⚠️ 旧思想已标记取代：${v.supersededFile}`);
				// 自检结果必须显示：合格给一句确认（含"其实只是专项"这类说明），不合格逐项点名。
				if (v.selfCheck) {
					lines.push(v.selfCheck.ok ? `✓ ${v.selfCheck.layer}层自检通过` : `⛔ ${v.selfCheck.layer}层自检未过：`);
					for (const n of v.selfCheck.notes ?? []) lines.push(`  ℹ ${n.message}`);
					for (const f of v.selfCheck.findings ?? []) lines.push(`  ✗ ${f.message}`);
				}
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory insight: ${args.theme ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			await mkdir(path.join(root, 'insights'), { recursive: true });
			const theme = safeSlug(args.theme);
			const oldTheme = typeof args.supersedes === 'string' && args.supersedes.trim() ? safeSlug(args.supersedes) : undefined;
			if (oldTheme && (oldTheme === theme || (process.platform === 'win32' && oldTheme.toLowerCase() === theme.toLowerCase()))) throw new Error('supersedes must reference a DIFFERENT theme');
			const principle = oneLine(args.principle);
			if (!principle) throw new Error('principle is required');
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the insights index row must carry a one-line 内涵');
			const date = normDate(args.date);
			const warnings = [];

			const sources = (Array.isArray(args.sources) ? args.sources : []).map((s) => safeSlug(s));
			if (!sources.length) throw new Error('sources is required: at least one existing functions/ file to backlink');
			const linked = [];
			const skipped = [];
			for (const s of sources) {
				if (await statExists(path.join(root, 'functions', `${s}.md`))) linked.push(s);
				else skipped.push(s);
			}
			if (skipped.length) warnings.push(`来源不存在，未回链：${skipped.join('、')}（先用 memory_write 建立功能文件）`);
			// 阀门证据落盘（2026-11-09 II-3 收口）：valve_evidence 此前只进账本
			// 不进文件——criteria 通道从磁盘重跑时读不到它，头部原则永远
			// downgrade（补了证据也白补）。现在持久化为「## 阀门证据」节：
			// verifiable_by 一行 + 量化字段一行 JSON + 证据引用列表。
			// 只在显式提供时写；不提供不动既有节（更新原则不冲掉旧证据）。
			const ve = args.valve_evidence && typeof args.valve_evidence === 'object' ? args.valve_evidence : undefined;
			const evidenceSection = (v) => {
				const lines = [];
				if (typeof v.verifiable_by === 'string' && v.verifiable_by.trim()) lines.push(`- 可检验路径：${oneLine(v.verifiable_by)}`);
				const quant = {};
				for (const k of ['skill_coverage', 'scenario_coverage', 'anti_example_count', 'predict_rate', 'overlap']) {
					if (v[k] !== undefined) quant[k] = v[k];
				}
				if (Object.keys(quant).length) lines.push(`- 量化：${JSON.stringify(quant)}`);
				for (const e of Array.isArray(v.evidence) ? v.evidence : []) {
					if (typeof e === 'string' && e.trim()) lines.push(`- 证据：${oneLine(e)}`);
				}
				return lines.join('\n');
			};
			// 层级准入闸门（src/layer-gate.js 的 gateFa）—— 判据是**函数**，
			// 不在这个工具里内联正则。法层对「≥2 无关来源域」只降级不拒绝
			// （单源是合法的专项经验），但必须让调用方知道它进了哪一层。
			const faVerdict = gateFa({ principle, sources: linked });
			if (!faVerdict.ok) throw new Error(faVerdict.reason);
			for (const w of faVerdict.warnings) warnings.push(w);
			if (charLen(principle) > MAX_PRINCIPLE_CHARS) {
				warnings.push(`原则 ${charLen(principle)} 字 > ${MAX_PRINCIPLE_CHARS}：原则是判断，不是论述；推导留在来源功能文件里`);
			}
			const srcLine = linked.length ? linked.map((s) => `[functions/${s}.md](../functions/${s}.md)`).join('、') : '（来源缺失）';

			// 1) insight file
			const p = path.join(root, 'insights', `${theme}.md`);
			const existing = await readIfExists(p);
			let text;
			if (existing === undefined) {
				text = insightTemplate(theme, principle, srcLine, args.evolution, args.applicability, args.open, date);
			} else {
				text = replaceSection(existing, '## 核心原则', `- ${principle}`);
				const evo = `- ${date} 调整为：${principle}${args.evolution ? `（${oneLine(args.evolution)}）` : ''}`;
				text = appendUnderHeading(text, '## 思想演进', evo).text;
				text = text.replace(/^> 来源：.*$/m, `> 来源：${srcLine}`);
				// applicability is refreshed too: an evolved principle usually widens,
				// narrows, or replaces the scope it applies to.
				if (args.applicability !== undefined && oneLine(args.applicability)) {
					text = replaceSection(text, '## 适用面', `- ${oneLine(args.applicability)}`);
				}
				if (args.open !== undefined && oneLine(args.open)) text = appendUnderHeading(text, '## 待观察', `- ${oneLine(args.open)}`).text;
			}
			// 阀门证据节：显式提供才写/替换；节不存在则追加到文件末尾。
			if (ve) {
				const body = evidenceSection(ve);
				if (body) {
					text = text.includes('## 阀门证据')
						? replaceSection(text, '## 阀门证据', body)
						: `${text.replace(/\n*$/, '\n')}\n## 阀门证据\n\n${body}\n`;
				}
			}
			// Trust refresh (Hindsight-borrowed: beliefs carry proof counts and are
			// REFINED, never silently replaced): recompute from .usage.jsonl on every
			// insight write, so the head line is always the current evidence — and a
			// theme that keeps being corrected shows it right on its first line.
			const trustItems = summarizeUsage(await readUsage(root));
			const trust = insightTrust(trustItems.find((x) => x.href === `insights/${theme}.md`) ?? {});
			text = refreshTrustLine(text, trustLineFor(trust));
			if (trust.level === '动摇') {
				warnings.push(`该思想正处于「动摇」（认可 ${trust.positives} · 纠正 ${trust.corrections}）：继续追加前先精炼原则本体或传 supersedes 取代它`);
			}
			await writeText(p, text, { memoryRoot: root });

			// 1b) supersede (R12): stamp the old insight without deleting it.
			let supersededFile;
			if (oldTheme) {
				const oldPath = path.join(root, 'insights', `${oldTheme}.md`);
				const oldText = await readIfExists(oldPath);
				if (oldText === undefined) {
					warnings.push(`supersedes: insights/${oldTheme}.md 不存在，未打标`);
				} else if (oldText.includes('> ⚠️ 已被取代')) {
					warnings.push(`supersedes: insights/${oldTheme}.md 已带有取代标记（检查链是否正确）`);
				} else {
					// The old file lives in insights/, so the successor href is a bare
					// sibling link (insights/-prefixed hrefs resolve to insights/insights/).
					const stamp =
						`> ⚠️ 已被取代 → [${theme}.md](${theme}.md)（${date}）。以下内容保留作为决策历史。`;
					const stamped = oldText.replace(/^/, `${stamp}\n\n`);
					await writeText(oldPath, appendUnderHeading(stamped, '## 思想演进', `- ${date} 被 [${theme}.md](${theme}.md) 取代`).text, { memoryRoot: root });
					supersededFile = oldPath;
				}
			}

			// 2) index row is NOT auto-written: insights land in the index via
			// memory_index when the theme stabilizes (same integration layer as
			// function areas).

			// 3) the daily log is the raw layer; this tool never touches it.

			// Omit `supersededFile` entirely when nothing was superseded: an
			// `undefined` property makes the tool result non-lossless JSON, which
			// the Host rejects even though the write already succeeded.
			//
			// —— 写入后：从磁盘回读，按「法层定义」自检（用户 2026-11-02 要求）——
			// 法最常坏在两处：来源回链不足（降级成专项却当普适原则用）、
			// 核心原则写成步骤（那是术）。回读磁盘字节，与体检同源。
			const onDiskInsight = (await readIfExists(p)) ?? '';
			const selfCheck = checkArtifact({ layer: '法', content: onDiskInsight, relPath: `insights/${theme}.md` });
			warnings.push(...selfCheckWarnings(selfCheck));
			// 上行评估留痕（2026-11-09）：写入成功后把证据送 valves 账本。
			// 只留痕不改结果——生效判据仍是上面的 gateFa（判据单一实现），
			// 账本记的是"这次写入带没带可外部检验的证据"，是校准阈值的分布原料。
			const valveTrace = recordUpwardWrite(
				opts.ctx,
				upwardEntryFromWrite('criterion', args, linked.map((s) => `functions/${s}.md`)),
			);
			if (valveTrace && (valveTrace.action === 'downgrade' || valveTrace.action === 'reject')) {
				warnings.push(`valves 上行评估：${valveTrace.action}（${valveTrace.reason}）——不影响本次写入（gateFa 已过），但证据链在阀门账本里记为不足`);
			}
			const out = {
				insightFile: p,
				linkedSources: linked.map((s) => `functions/${s}.md`),
				skippedSources: skipped.map((s) => `functions/${s}.md`),
				trust,
				selfCheck,
				warnings,
			};
			if (supersededFile) out.supersededFile = supersededFile;
			return out;
		},
	});
}

/**
 * 道层写入工具 —— 层级准入的**硬闸门**。
 *
 * 与 memory_insight 的关键差别：不满足条件时**直接抛错拒绝写入**，
 * 而不是写进去再给一条警告。这是用户 2026-10-27 的明确要求：
 * 「各层级之间的萃取或者结晶，要形成固定的函数调用机制，把条件包含和
 * 描述包含在其中，而非仅靠语义和提示词的文字描述来成型。」
 *
 * 判据本体在 src/layer-gate.js（纯函数、可穷举测试），本工具只负责：
 * 读现有道条目 → 调 gateDao → 通过则写文件 + 更新 MEMORY.md 索引。
 */
function memoryDaoTool(opts) {
	return defineTool({
		name: 'memory_dao',
		description:
			'Write ONE 道 (dao) entry — the most abstract layer: a philosophical/dialectical proposition about how things ARE, from which concrete shoulds can be derived. HARD GATE (throws, does not warn): requires extractedFrom with >=5 existing insights/ laws, a proposition free of concrete tech/project/file markers, no procedure phrasing, and a layer size cap of 7. If the gate rejects, the reason states exactly what is missing — do not retry blindly: add laws first, or reconsider whether this is actually a 法 rather than a 道. Body goes to dao/<name>.md. This tool does NOT write MEMORY.md — add the dao-layer row by hand (体检 R24 会点名没有登记进索引的道)。 **Body structure is gated, not advisory** (src/dao-shape.js): it must contain a descriptive section (e.g. 三种形态 — world as it IS, no normative verbs like 必须/应当), a derivation section (依据展开 — must ARGUE how the laws jointly force the proposition, not restate them one by one), and a boundary section saying when the proposition does NOT hold. The proposition itself must carry philosophical shape: at least one of (对立/张力) or (生成性/演化) — a static assertion such as 「所有系统最终都会腐烂」 is rejected as an engineering conclusion, not a 道.',
		parameters: {
			name: { type: 'string', required: true, description: '道名 slug（文件名，不含 .md），如「静默失效」「判据在真实路径上」。status=list_candidates 时仍需传（工具契约统一，值会被忽略）。' },
			proposition: { type: 'string', required: true, description: '命题本体：一句话说清"世界是怎样的"。不得含具体技术/项目/文件名，不得含操作步骤。status=list_candidates 时值会被忽略。' },
			extractedFrom: { type: 'array', required: true, description: '萃取来源：insights/ 里的**法** slug 列表。至少 5 条（硬闸门）。道不直接从 functions/ 萃取——中间必须隔着法。status=list_candidates 时值会被忽略。', items: { type: 'string' } },
			body: { type: 'string', required: true, description: '正文（Markdown）：三种形态 / 推理用法 / 依据展开 / 边界。命题一句话在这里展开成可用的推理前提。**不要再写「## 来源法」标题**——那一节由本工具按 extractedFrom 追加并读取，正文再写一个会被静默忽略（该用「## 依据展开」）。status=list_candidates 时值会被忽略。' },
			date: { type: 'string', description: 'YYYY-MM-DD；缺省今天。' },
			supersedes: { type: 'string', description: '可选：被本道取代的旧道名。旧文件保留并打取代标记。' },
			valve_evidence: {
				type: 'object',
				additionalProperties: false,
				properties: {
					evidence: { type: 'array', items: { type: 'string' }, description: '来源法/反例引用列表。' },
					verifiable_by: { type: 'string', description: '人工判断的依据说明。' },
				},
				description: '可选：上行阀门证据。法→道在阀门侧永远人工闸门，这里只留痕。',
			},
			status: {
				type: 'string',
				enum: ['candidate', 'active', 'list_candidates'],
				description: 'candidate=候选公理（写入 dao/_candidates/，等待用户确认，不进召回、不进索引）；active=正式道（缺省，走原有路径）；list_candidates=列出全部待确认候选（用于主动呈现给用户决策）。',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					daoFile: { type: 'string', required: true },
					name: { type: 'string', required: true },
					extractedFrom: { type: 'array', required: true, items: { type: 'string' } },
					missingLaws: { type: 'array', required: true, items: { type: 'string' } },
					selfCheck: SELF_CHECK_SCHEMA,
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`道已沉淀：${v.daoFile}`,
					`萃取自 ${v.extractedFrom.length} 条法：${v.extractedFrom.join('、')}`,
				];
				if (v.missingLaws.length) lines.push(`⚠ 来源法不存在：${v.missingLaws.join('、')}`);
				// 自检结果必须**显示出来**：字段存在但没人看见，等于没做。
				// 合格时给一句确认（含"其实只是专项"这类说明），不合格时逐项点名。
				if (v.selfCheck) {
					lines.push(v.selfCheck.ok ? `✓ ${v.selfCheck.layer}层自检通过` : `⛔ ${v.selfCheck.layer}层自检未过：`);
					for (const n of v.selfCheck.notes ?? []) lines.push(`  ℹ ${n.message}`);
					for (const f of v.selfCheck.findings ?? []) lines.push(`  ✗ ${f.message}`);
				}
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory dao: ${args.name ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const daoDir = path.join(root, 'dao');
			const warnings = [];

			// —— 列出待确认候选（2026-11-10）——
			// 用户要求"agent 主动展现给用户，由用户决策"。没有这个读入口，
			// 候选写进去就等于石沉大海——存在但没人知道，那和没写一样。
			if (args.status === 'list_candidates') {
				const candDir = path.join(daoDir, '_candidates');
				let names = [];
				try {
					names = (await readdir(candDir)).filter((f) => f.endsWith('.md')).sort();
				} catch {
					/* 还没有候选 = 正常态，不是错误 */
				}
				const items = [];
				for (const f of names) {
					const slug = f.replace(/\.md$/, '');
					try {
						const t = await readText(path.join(candDir, f));
						const prop = /##\s*命题\s*\n+([\s\S]*?)(?:\n##|$)/.exec(t)?.[1]?.trim() ?? '';
						const srcCount = (t.match(/^- \[[^\]]+\]\(\.\.\/insights\//gm) ?? []).length;
						items.push({ name: slug, proposition: prop, source_count: srcCount });
					} catch {
						items.push({ name: slug, proposition: '', source_count: 0, unreadable: true });
					}
				}
				return {
					ok: true,
					status: 'list_candidates',
					count: items.length,
					candidates: items,
					note: items.length
						? '这些候选**尚未生效**（不进召回、不参与判定）。请把每条呈现给用户：命题 + 来源法数量，由用户决定转正或否决。'
						: '当前没有待确认的候选公理。',
				};
			}

			const name = safeSlug(args.name);
			const oldName = typeof args.supersedes === 'string' && args.supersedes.trim() ? safeSlug(args.supersedes) : undefined;
			if (oldName && (oldName === name || (process.platform === 'win32' && oldName.toLowerCase() === name.toLowerCase()))) throw new Error('supersedes must reference a DIFFERENT 道');
			const proposition = oneLine(args.proposition);
			const body = String(args.body ?? '').trim();
			if (!body) throw new Error('body is required: a 道 需要正文展开（形态/推理用法/依据展开/边界），否则只是一句口号');

			// —— 写入前：正文不得与模板保留节撞车（2026-11-02 事故）——
			//
			// 模板会把「## 来源法」追加到文件末尾。正文若自带一个同前缀的小节
			// （例如「## 来源法逐条」），它的链接**永远不会被读到** —— 作者以为
			// 登记了依据、系统只看到模板那一节。这里直接拒绝，让它改名（例如
			// 「## 依据展开」），而不是等体检报"依据不足"再回头猜。
			const collisions = daoReservedHeadingCollisions(body);
			if (collisions.length) {
				throw new Error(
					`正文里有与模板保留节撞车的标题：${collisions.join('、')}。` +
						'「## 来源法」是模板追加并读取的节，正文再写一个会被静默忽略（链接读不到）。' +
						'请把正文那一节改名为「## 依据展开」之类的标题后重写。',
				);
			}
			const date = normDate(args.date);

			// —— 写入前：道体结构必须符合「道」的定义（2026-11-02 机制补强）——
			//
			// 「三种形态 / 推理用法 / 依据展开 / 边界」此前只写在参数说明文字里、
			// 代码零实现，于是"正文塞满操作步骤"的道照样被放行。现在写之前就拦：
			// 结构不对直接拒绝，不让它先落盘再靠回执事后提醒。
			const shapePreview = checkDaoBody(body);
			// 命题的哲学形态也必须**写入前**就查：此前它只在 selfcheck 里，
			// 于是"工程结论式命题"能落盘、事后才报 ⛔（真机验证过：探针确实写进了磁盘）。
			const phPreview = philosophicalShape(proposition);
			if (!phPreview.ok) {
				throw new Error(
					'命题缺少哲学形态：' +
						(phPreview.has.length === 0
							? '对立/条件/拒绝裁判/生成性四件全缺——它是一条工程结论，不是道。'
							: '已具备 ' + phPreview.has.join('/') + '，但缺生成性或对立之一。') +
						'道要能说"世界在演化出什么"或"两极如何同时在场"，静态断言不是道。',
				);
			}
			if (shapePreview.findings.length > 0) {
				throw new Error(
					'道体结构不符合「道」的定义：\n' +
						shapePreview.findings.map((f) => `  - ${f.message}`).join('\n') +
						'\n道描述「世界是怎样的」，不是「该怎么做」——操作步骤属法层或共识区。',
				);
			}

			// —— 校验来源法真实存在（目录校验不做进纯函数，这里做）——
			const requested = (Array.isArray(args.extractedFrom) ? args.extractedFrom : []).map((s) => safeSlug(s));
			const existingLaws = [];
			const missingLaws = [];
			for (const s of requested) {
				const p = path.join(root, 'insights', `${s}.md`);
				const txt = await readIfExists(p);
				if (txt === undefined) { missingLaws.push(s); continue; }
				// 已被取代的法不能作为道的来源：它不再代表当前认知。
				if (/^>\s*⚠️\s*已被取代/m.test(txt)) { warnings.push(`来源法 insights/${s}.md 已被取代，不作为萃取依据`); continue; }
				existingLaws.push(s);
			}
			if (missingLaws.length) {
				warnings.push(`来源法不存在：${missingLaws.join('、')}（先用 memory_insight 建立法）`);
			}

			// —— 现有道条目数（上限检查用）——
			// 只数**在用**的道：已被取代的不占名额。曾按目录里全部 .md 计数，而 R24
			// 只数在用的——6 条在用 + 2 条已取代 = 8 文件时，闸门判定「已达上限 7」
			// 拒绝任何新增，R24 看到 6 条 → 零告警。层被永久锁死而体检全绿。
			let existingCount = 0;
			try {
				const daoAll = (await readdir(daoDir)).filter((f) => f.endsWith('.md'));
				for (const f of daoAll) {
					const t = (await readIfExists(path.join(daoDir, f))) ?? '';
					if (!/^>\s*⚠️\s*已被取代/m.test(t)) existingCount++;
				}
			} catch {
				/* dao/ 不存在 = 0 条 */
			}
			// 覆盖同名文件时它不算"新增"
			const targetPath = path.join(daoDir, `${name}.md`);
			const overwriting = await statExists(targetPath);
			const countedFor = overwriting ? Math.max(0, existingCount - 1) : existingCount;

			// —— 硬闸门 ——
			const verdict = gateDao({
				name,
				proposition,
				extractedFrom: existingLaws,
				existing: countedFor,
			});
			if (!verdict.ok) throw new Error(verdict.reason);
			for (const w of verdict.warnings) warnings.push(w);

			// —— 候选公理（2026-11-10 用户要求）——
			// 候选走**同一套闸门**（上面几行），只是落地位置不同：写到
			// dao/_candidates/ 而不是 dao/。这样它存在、可见、能反复打磨，
			// 但在用户点确认之前**不进索引、不进召回、不参与任何判断**。
			//
			// 为什么候选必须在物理上分开：召回只认 MEMORY.md 索引行，
			// 而索引由 memory_index 手写。放进 dao/ 就等于默认它会被人加进索引，
			// 那就退回"agent 自己升格"的老路了。
			if (args.status === 'candidate') {
				const candDir = path.join(daoDir, '_candidates');
				await mkdir(candDir, { recursive: true });
				const lawLinesC = existingLaws.map((s) => `- [${s}](../insights/${s}.md)`).join('\n');
				const candText = [
					`# 候选公理 · ${name}`,
					'',
					'> 性质：**候选公理**（未生效）。等用户确认后才转为正式道。',
					'> 确认前：不进 MEMORY.md 索引、不进召回、不参与任何判定。',
					`> 萃取自 ${existingLaws.length} 条法，已过道层三关（≥5 法 / 无具体标记 / 非操作手册）。`,
					'',
					'## 命题',
					'',
					proposition,
					'',
					body,
					'',
					'## 来源法',
					'',
					lawLinesC,
					'',
					'## 待决策',
					'',
					'- 这个命题成立吗？站得住「换一个领域依然成立」这条判据吗？',
					'- 确认：用 `status=active` 重新写入（转正）；否决：说明理由，候选文件保留作为「世界不是什么」的证据。',
					'',
				].join('\n');
				const candPath = path.join(candDir, `${name}.md`);
				await writeText(candPath, candText, { memoryRoot: root });
				return {
					ok: true,
					status: 'candidate',
					name,
					path: candPath,
					proposition,
					source_count: existingLaws.length,
					sources: [...existingLaws],
					...(warnings.length ? { warnings } : {}),
					note:
						'已写入候选区（dao/_candidates/），**未生效**。请主动把这个候选公理呈现给用户：命题 + 来源法 + 为什么它够格，' +
						'由用户决定是否转正（转正用 status=active 重写；否决请记录理由）。',
				};
			}

			// —— 写入 ——
			await mkdir(daoDir, { recursive: true });
			const lawLines = existingLaws
				.map((s) => {
					const link = `../insights/${s}.md`;
					return `- [${s}](${link})`;
				})
				.join('\n');
			const text = [
				`# 道 · ${name}`,
				'',
				'> 性质：**道层**。最抽象的指导思想，不含任何具体工具/文件/项目。',
				`> 萃取自 ${existingLaws.length} 条法（\`insights/\`）的共同上位命题，非单条抽象。`,
				'',
				'## 命题',
				'',
				`${proposition}`,
				'',
				body,
				'',
				'## 来源法',
				'',
				lawLines,
				'',
			].join('\n');
			await writeText(targetPath, text, { memoryRoot: root });

			let supersededFile;
			if (oldName) {
				const oldPath = path.join(daoDir, `${oldName}.md`);
				const oldText = await readIfExists(oldPath);
				if (oldText === undefined) {
					warnings.push(`supersedes: dao/${oldName}.md 不存在，未打标`);
				} else if (oldText.includes('> ⚠️ 已被取代')) {
					warnings.push(`supersedes: dao/${oldName}.md 已带取代标记`);
				} else {
					const stamp = `> ⚠️ 已被取代 → [${name}.md](${name}.md)（${date}）。以下内容保留作为决策历史。`;
					await writeText(oldPath, oldText.replace(/^/, `${stamp}\n\n`), { memoryRoot: root });
					supersededFile = oldPath;
				}
			}

			// —— 写入后：从磁盘回读，按「道层定义」自检（用户 2026-11-02 要求）——
			//
			// 回执此前只说"道已沉淀"，而落盘的东西读不读得出依据是另一回事
			// （真机事故：模板节被正文撞前缀 → 依据读成 0 条，回执照样报成功）。
			// 自检读的是**磁盘字节**，与体检 R24 同一套锚 —— 写者不给自己背书。
			const onDisk = (await readIfExists(targetPath)) ?? '';
			const selfCheck = checkArtifact({ layer: '道', content: onDisk, relPath: `dao/${name}.md` });
			warnings.push(...selfCheckWarnings(selfCheck));

			// 上行评估留痕（2026-11-09）：法→道在 valves 侧永远 human_gate（不量化），
			// 这里只把"又一条道经人工闸门落盘"记进账本，供 valve_metrics 汇总。
			recordUpwardWrite(opts.ctx, upwardEntryFromWrite('axiom', args, existingLaws.map((s) => `insights/${s}.md`)));

			return {
				daoFile: targetPath,
				name,
				extractedFrom: existingLaws.map((s) => `insights/${s}.md`),
				missingLaws: missingLaws.map((s) => `insights/${s}.md`),
				selfCheck,
				warnings,
			};
		},
	});
}
function memoryFoldTool(opts) {
	return defineTool({
		name: 'memory_fold',
		description:
			'Compress the oldest iteration blocks into an early-evolution section while retaining recent blocks. Folded headings remain as individual dated summaries; the section heading does not repeat their date tags. Existing sections are not automatically rewritten.',
		parameters: {
			feature: { type: 'string', required: true, description: '功能域 slug（functions/ 下的既有文件）。' },
			keep: { type: 'integer', description: '从最新块往回保留的块数（默认 3，最小 1）。' },
			normalizeHeadings: { type: 'boolean', description: '只清理旧折叠标题中已在正文完整保留的重复日期标签，不折叠或删除正文。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					foldedBlocks: { type: 'integer', required: true },
					keptBlocks: { type: 'integer', required: true },
					bytesBefore: { type: 'integer', required: true },
					bytesAfter: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`已折叠：${v.file}`,
					`折叠 ${v.foldedBlocks} 块为早期演化段，保留最近 ${v.keptBlocks} 块完整`,
					`体积 ${v.bytesBefore}B → ${v.bytesAfter}B`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Fold memory: ${args.feature ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const feature = safeSlug(args.feature);
			const warnings = [];
			const p = path.join(root, 'functions', `${feature}.md`);
			const text = await readIfExists(p);
			if (text === undefined) throw new Error(`functions/${feature}.md 不存在`);
			const bytesBefore = byteLen(text);

			if (args.normalizeHeadings === true) {
				const lines = text.split('\n');
				let changed = 0;
				for (let i = 0; i < lines.length; i++) {
					const m = /^(##\s*早期演化（\d+ 块已折叠)：([^）]+)）\s*$/.exec(lines[i]);
					if (!m) continue;
					const tags = m[2].split('→').map((tag) => tag.trim()).filter(Boolean);
					let end = i + 1;
					while (end < lines.length && !/^##\s/.test(lines[end])) end++;
					const bodyTags = new Set(lines.slice(i + 1, end).map((line) => /^-\s*\[([^\]]+)\]/.exec(line)?.[1]).filter(Boolean));
					if (!tags.length || !tags.every((tag) => bodyTags.has(tag))) {
						warnings.push(`第 ${i + 1} 行的标签未在本段正文完整保留，已跳过`);
						continue;
					}
					lines[i] = `${m[1]}）`;
					changed++;
				}
				const newText = lines.join('\n');
				if (changed) await writeText(p, newText, { memoryRoot: root });
				warnings.push(`安全整理 ${changed} 个标题，正文与其他内容保持原样`);
				return { file: p, foldedBlocks: 0, keptBlocks: 0, bytesBefore, bytesAfter: byteLen(newText), warnings };
			}

			// Collect iteration blocks (## [date...] up to the next ## heading).
			const lines = text.split('\n');
			const headEnd = (() => {
				// The body starts after the first `---` separator (template) or at the
				// first iteration heading, whichever comes first.
				const sep = lines.findIndex((l) => l.trim() === '---');
				return sep === -1 ? lines.findIndex((l) => /^## \[/.test(l)) : sep + 1;
			})();
			const blockStarts = [];
			for (let i = Math.max(0, headEnd); i < lines.length; i++) {
				if (/^##\s*\[\d{4}-\d{2}-\d{2}/.test(lines[i])) blockStarts.push(i);
			}
			if (blockStarts.length === 0) throw new Error('没有可折叠的迭代块（文件里没有 [YYYY-MM-DD] 块）');
			const keep = Math.max(1, Math.min(Number.isFinite(args.keep) ? args.keep : 3, blockStarts.length - 1));
			if (blockStarts.length <= keep) throw new Error(`只有 ${blockStarts.length} 个迭代块，keep=${keep} 无需折叠`);

			const foldCount = blockStarts.length - keep;
			const foldFrom = blockStarts[0];
			const foldTo = blockStarts[foldCount]; // first kept block start
			const foldedLines = lines.slice(foldFrom, foldTo);
			// Do not silently discard intervening non-iteration sections.
			if (foldedLines.some((line) => /^##\s/.test(line) && !/^##\s*\[\d{4}-\d{2}-\d{2}/.test(line))) {
				throw new Error('待折叠迭代块之间存在其他章节，无法安全折叠');
			}
			const keptLines = lines.slice(foldTo);

			// Extract per-block: heading (date + title) and its bullets' key info.
			const summaries = [];
			let cur = null;
			for (const l of foldedLines) {
				const hm = l.match(/^##\s*\[([^\]]+)\]\s*(.+)$/);
				if (hm) {
					if (cur) summaries.push(cur);
					cur = { tag: hm[1], title: hm[2].trim(), results: [], lessons: [] };
				} else if (cur) {
					const rm = l.match(/^-\s*\*\*结果\*\*[:：]\s*(.+)$/);
					const om = l.match(/^-\s*\*\*待观察\*\*[:：]\s*(.+)$/);
					if (rm) cur.results.push(rm[1].trim());
					else if (om) cur.lessons.push(om[1].trim());
					else if (l.startsWith('- 相关：')) cur.lessons.push(l.trim());
				}
			}
			if (cur) summaries.push(cur);

			const evoLines = summaries.map((s) => {
				// One short line per folded block: tag + title, plus the result only
				// when it is informative (reverted/pending), never a bare "完成".
				const res = s.results.find((r) => r !== '完成');
				return `- [${s.tag}] ${s.title}${res ? `（${res}）` : ''}`;
			});
			const evoBlock = [
				`## 早期演化（${foldCount} 块已折叠）`,
				'',
				...evoLines,
				'',
			];

			const newText = [...lines.slice(0, foldFrom), ...evoBlock, ...keptLines].join('\n');
			await writeText(p, newText, { memoryRoot: root });
			const bytesAfter = byteLen(newText);
			if (bytesAfter > opts.maxFunctionBytes) {
				warnings.push(`折叠后仍 ${bytesAfter}B > ${opts.maxFunctionBytes}B：再降低 keep 或压缩状态摘要`);
			}
			return {
				file: p,
				foldedBlocks: foldCount,
				keptBlocks: keep,
				bytesBefore,
				bytesAfter,
				warnings,
			};
		},
	});
}

function memoryRenameTool(opts) {
	return defineTool({
		name: 'memory_rename',
		description:
			'Rename or merge a function area (R10): move functions/<from>.md to functions/<to>.md, preserving source content when merging into an existing target, and update index, function and insight references. Historical daily logs are never rewritten, so their links may retain the old name. Report remaining dangling links; zero is not guaranteed.',
		parameters: {
			from: { type: 'string', required: true, description: '现有功能域 slug。' },
			to: { type: 'string', required: true, description: '目标 slug：不存在 = 重命名；已存在 = 合并（旧块追加到目标文件末尾）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					mode: { type: 'string', required: true, enum: ['renamed', 'merged'] },
					fromFile: { type: 'string', required: true },
					toFile: { type: 'string', required: true },
					rewrittenFiles: { type: 'array', required: true, items: { type: 'string' } },
					danglingAfter: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const incomplete = v.warnings.some((w) => w.startsWith('R10 死链检查不完整'));
				const lines = [
					v.mode === 'renamed' ? `已重命名：${v.fromFile} → ${v.toFile}` : `已合并：${v.fromFile} 并入 ${v.toFile}`,
					`改写引用的文件：${v.rewrittenFiles.length ? v.rewrittenFiles.join('、') : '（无）'}`,
					incomplete ? `改写后已发现死链数（检查不完整，仅为下界）：${v.danglingAfter}` : `改写后死链数：${v.danglingAfter}`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Rename memory: ${args.from ?? ''} → ${args.to ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const from = safeSlug(args.from);
			const to = safeSlug(args.to);
			if (from === to || (process.platform === 'win32' && from.toLowerCase() === to.toLowerCase())) throw new Error('from 与 to 指向同一路径');
			const warnings = [];
			const fromPath = path.join(root, 'functions', `${from}.md`);
			const toPath = path.join(root, 'functions', `${to}.md`);
			const fromText = await readIfExists(fromPath);
			if (fromText === undefined) throw new Error(`functions/${from}.md 不存在`);
			const toText = await readIfExists(toPath);
			const merging = toText !== undefined;
			if (merging) {
				const [a, b, realA, realB] = await Promise.all([stat(fromPath), stat(toPath), realpath(fromPath), realpath(toPath)]);
				if ((a.ino && b.ino && a.dev === b.dev && a.ino === b.ino) || realA === realB || (process.platform === 'win32' && realA.toLowerCase() === realB.toLowerCase())) {
					throw new Error('from 与 to 指向同一文件，拒绝合并');
				}
			}

			// 1) move / merge content
			let finalToText;
			if (!merging) {
				finalToText = fromText;
			} else {
				// Preserve the complete source, including folded history, its summary,
				// and custom sections. Extracting only dated blocks silently discarded
				// all content above the first block and could erase a folded-only file.
				const relinked = fromText.split(`](${from}.md)`).join(`](${to}.md)`);
				finalToText = toText.replace(/\n*$/, '\n\n') + `<!-- 并入来源：${from} -->\n\n` + relinked;
			}
			await writeRenameTarget(root, toPath, toText, finalToText);
			try {
				await deleteTrackedFile(root, fromPath, fromText, { tool: 'memory_rename', to: `functions/${to}.md` });
			} catch (cause) {
				const error = new Error(`目标 functions/${to}.md 已写入；源 functions/${from}.md 的删除未完成确认，引用尚未改写。请核对两份文件和账本，不要盲目重试合并。${cause?.message ?? String(cause)}`, { cause });
				error.code = 'MEMORY_RENAME_PARTIAL';
				throw error;
			}

			// 2) rewrite derived index, function and insight references. Four spellings
			// exist: index link `functions/<from>.md`, bare sibling links
			// `](<from>.md)` inside functions/, `functions/<from>.md` prose, and
			// the index row — BOTH name spellings: a bare cell `| from |` (legacy)
			// and a link cell `[from](functions/from.md)` (every row since 5.15.0).
			// The rewrite works on rowSlug semantics, not `| from |` string noise:
			// the audit caught the old pass leaving `| [from](functions/to.md) |`
			// behind — href renamed, label forgotten — and because R15 counts rows
			// by rowSlug, the absorbed row and the target row then looked like two
			// DIFFERENT entries, so the duplicate was invisible to every lint.
			const rewritten = [];
			const rewriteOne = (before, isIndex) => {
				let prepared = before;
				if (isIndex) {
					// Only the functions index may contain duplicate source/target rows.
					// Never deduplicate arbitrary tables elsewhere in the memory root.
					const start = prepared.indexOf(FUNC_TABLE_HEADING);
					const end = start < 0 ? -1 : prepared.indexOf('\n## ', start + FUNC_TABLE_HEADING.length);
					const section = start < 0 ? '' : prepared.slice(start, end < 0 ? undefined : end);
					if (merging && section.split('\n').some((line) => line.startsWith('|') && rowSlug(line) === to)) {
						prepared = dropIndexRow(prepared, FUNC_TABLE_HEADING, FUNC_TABLE_HEADER, from);
					}
					let inFunctions = false;
					prepared = prepared.split('\n').map((line) => {
						if (line.startsWith('## ')) inFunctions = line.startsWith(FUNC_TABLE_HEADING);
						return inFunctions && line.startsWith('|') && rowSlug(line) === from
							? line.split(`| ${from} |`).join(`| ${to} |`) : line;
					}).join('\n');
				}
				// Rename a label only when it actually points at the renamed file.
				return prepared
					.split(`[${from}.md](${from}.md)`).join(`[${to}.md](${to}.md)`)
					.split(`[${from}](${from}.md)`).join(`[${to}](${to}.md)`)
					.split(`[${from}.md](functions/${from}.md)`).join(`[${to}.md](functions/${to}.md)`)
					.split(`[${from}](functions/${from}.md)`).join(`[${to}](functions/${to}.md)`)
					.split(`](${from}.md)`).join(`](${to}.md)`)
					.split(`](functions/${from}.md)`).join(`](functions/${to}.md)`)
					.split(`/functions/${from}.md`).join(`/functions/${to}.md`)
					.split(`functions/${from}.md`).join(`functions/${to}.md`);
			};
			const rewriteIn = async (fp) => {
				const before = await readIfExists(fp);
				if (before === undefined) return;
				const after = rewriteOne(before, fp === path.join(root, 'MEMORY.md'));
				if (after !== before) {
					await writeText(fp, after, { memoryRoot: root });
					rewritten.push(path.relative(root, fp).split(path.sep).join('/'));
				}
			};
			// MEMORY.md is shared with five other writers — rename passes through the
			// same lock (its per-file rewrite is a full read-modify-write).
			await withPathLock(path.join(root, 'MEMORY.md'), () => rewriteIn(path.join(root, 'MEMORY.md')));
			opts.dropRecallCaches?.();
			for (const zone of ['functions', 'insights']) {
				let names = [];
				try {
					names = (await readdir(path.join(root, zone))).filter((n) => n.endsWith('.md'));
				} catch {
					/* zone absent */
				}
				for (const n of names) await rewriteIn(path.join(root, zone, n));
			}
			// Daily logs are raw evidence, not a derived link index. Never rewrite
			// historical records during a rename or merge.
			warnings.push(`为保留原始证据，已跳过全部历史每日记录的链接改写；历史链接可能仍指向旧名 functions/${from}.md。`);

			// 3) verify: run the real checker and count dangling links
			let health;
			try {
				health = await runHealthCheck(root, opts);
			} catch (err) {
				// The move and rewrites have already completed; report verification
				// failure separately instead of presenting the rename as a failure.
				health = { results: [] };
				warnings.push(`R10 死链检查不完整：体检未完成（${err?.code ?? 'unknown'}）；已发现数 0 仅为下界。`);
			}
			const danglingAfter = health.results.filter((r) => r.rule === 'R10' && r.level === 'FAIL').length;
			const r10Unknown = health.results.filter((r) => r.rule === 'R10' && r.level === 'WARN');
			const noIndex = health.results.filter((r) => r.rule === 'R0' && r.level === 'FAIL');
			if (r10Unknown.length || noIndex.length) warnings.push(`R10 死链检查不完整：${[...r10Unknown, ...noIndex].map((r) => r.message).join('；')}；已发现数 ${danglingAfter} 仅为下界。`);
			if (danglingAfter > 0) warnings.push(`改写后仍有 ${danglingAfter} 条死链（见 memory_check 输出；历史每日记录应保留原样）`);
			if (merging) warnings.push(`合并完成：${from} 的块已追加到 ${to} 末尾，来源文件已删除；请确认 target 的状态摘要仍准确`);

			return {
				mode: merging ? 'merged' : 'renamed',
				fromFile: fromPath,
				toFile: toPath,
				rewrittenFiles: rewritten,
				danglingAfter,
				warnings,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// proactive recall: pre-step index matching (agent/pre-step waterfall)
// ---------------------------------------------------------------------------

function indexRowsOf(indexText, options = {}) {
	// Decision repair must use the exact same lifecycle and scope gate as ranked recall.
	return eligibleIndexRows(indexText, options);
}

/**
 * Decision-repair (MemOS borrow ④, simplified to our signals).
 *
 * MemOS: N tool failures within M steps → build a repair packet (prefer the
 * high-value approach, avoid the low-value one) and inject it BEFORE THE NEXT
 * step — never interrupting the in-flight one. We have no V-values, but the
 * equivalent signal exists: an area corrected repeatedly in the recent window
 * (the same raw material as the R18 circuit breaker) is exactly where the model
 * is about to repeat a mistake.
 *
 * Returns the hrefs to force-recall on the NEXT pre-step, most-corrected first.
 */
function decisionRepairTargets(usageItems, { minCorrections = 2, minBadRate = 0.3, limit = 2 } = {}) {
	return usageItems
		.filter((it) => it.corrections >= minCorrections && it.badRate >= minBadRate)
		.sort((a, b) => b.corrections - a.corrections || b.badRate - a.badRate)
		.slice(0, limit)
		.map((it) => ({ href: it.href, corrections: it.corrections, badRate: it.badRate, uses: it.uses }));
}

/**
 * Ranked full-text search over the whole memory root. Shared by the
 * `memory_search` tool and the panel's /search route so both rank identically
 * (the panel used to do a naive indexOf, whose order was file order).
 *
 * `after` / `before` (YYYY-MM-DD, inclusive) filter each hit by a LINE-level
 * date (Hindsight's temporal retrieval, lifted from a DB column to plain
 * markdown): an iteration block attributes to its `[YYYY-MM-DD…]` heading
 * tag, everything else in a file attributes to the head 「截至」 date, a daily
 * log to its filename, and a file with no date at all falls back to mtime.
 */
async function searchMemory(root, rawQuery, { zone = 'all', limit = 20, after = '', before = '', skillRoot = '' } = {}) {
	const q = String(rawQuery ?? '').trim().toLowerCase();
	if (q.length < 2) return [];
	const tokens = tokensOf(q);
	const zones = zone === 'all' ? ['index', ...MEMORY_ZONES, 'daily'] : [zone];
	const files = [];
	if (zones.includes('index')) files.push({ zone: 'index', name: 'MEMORY.md', file: path.join(root, 'MEMORY.md') });
	for (const z of MEMORY_ZONES) {
		if (!zones.includes(z)) continue;
		// 5.24.0: skills search their host bundles (<name>/SKILL.md), the memory
		// root no longer holds a skills/ directory.
		if (z === 'skills') {
			const sdir = skillRoot || path.join(dshHome(), 'skills');
			let dirs = [];
			try {
				dirs = (await readdir(sdir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
			} catch {
				/* no bundles */
			}
			for (const d of dirs) files.push({ zone: 'skills', name: `${d}/SKILL.md`, file: path.join(sdir, d, 'SKILL.md') });
			continue;
		}
		let names = [];
		try {
			names = (await readdir(path.join(root, z))).filter((n) => n.endsWith('.md')).sort();
		} catch {
			/* zone absent */
		}
		for (const n of names) files.push({ zone: z, name: n, file: path.join(root, z, n) });
	}
	if (zones.includes('daily')) {
		let names = [];
		try {
			names = (await readdir(root)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse();
		} catch {
			/* root absent */
		}
		for (const n of names) files.push({ zone: 'daily', name: n, file: path.join(root, n) });
		// 月/周折叠方案（2026-11）：归档月文件同样计入检索范围（全文检索）。
		// 日期归属用日节标题（### [YYYY-MM-DD]）：归档件文件名只有月份，无法
		// 单独给命中行定日，解析不到就按"未知日期"放行（与文件级 mtime 兜底
		// 同口径——不确定就如实标注，不冒充已确认）。
		let archNames = [];
		try {
			archNames = (await readdir(path.join(root, 'daily'))).filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).sort().reverse();
		} catch {
			/* daily/ absent: no archives */
		}
		for (const n of archNames) files.push({ zone: 'daily', name: n, file: path.join(root, 'daily', n), archive: true });
	}
	const hits = [];
	for (const f of files) {
		const text = await readIfExists(f.file);
		if (text === undefined) continue;
		// Split on CRLF too: files written by other tools (or on Windows) carry
		// \r, and `.` never matches \r — a `^#{1,3}\s+(.+)$` test on a raw CRLF
		// line silently fails, which left every daily hit without its heading.
		const lines = text.split(/\r?\n/);
		const nameHit = f.name.toLowerCase().includes(q) || tokensOf(f.name).size && [...tokens].some((t) => tokensOf(f.name).has(t));
		// Date attribution, cheapest source first; mtime is stat'd lazily and
		// only when a hit actually needs the fallback.
		const headDate = /当前状态摘要（截至\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '';
		const nameDate = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f.name)?.[1] ?? '';
		let fileDate = headDate || nameDate;
		let mtimeDate = null;
		const dateOf = async (blockDate) => {
			if (blockDate || fileDate) return blockDate || fileDate;
			if (mtimeDate === null) {
				try {
					mtimeDate = localDateStr(new Date((await stat(f.file)).mtime));
				} catch {
					mtimeDate = '';
				}
			}
			return mtimeDate;
		};
		let heading = '';
		let blockDate = '';
		const fileHits = [];
		// 月归档（2026-11）：日节标题 ### [YYYY-MM-DD] 给其后各行归属日期，
		// 尽力而为——解析不到的行日期为空串（未知），不冒充已确认。
		let archDayDate = '';
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lower = line.toLowerCase();
			const hm = lower.match(/^#{1,3}\s+(.+)$/);
			if (hm) heading = hm[1].trim();
			const dm = /^##\s*\[(\d{4}-\d{2}-\d{2})/.exec(line.trim());
			if (dm) blockDate = dm[1];
			if (f.archive) {
				const daym = /^###\s*\[(\d{4}-\d{2}-\d{2})\]/.exec(line.trim());
				if (daym) archDayDate = daym[1];
				// 周节（## 周…）开新分组：重置日归属，避免上一周的日期漏给下一周。
				else if (/^##\s/.test(line.trim())) archDayDate = '';
			}
			let score = 0;
			if (lower.includes(q)) score += 3;
			if (heading && heading.toLowerCase().includes(q)) score += 2;
			let tokenHits = 0;
			for (const tk of tokens) if (lower.includes(tk)) tokenHits++;
			score += tokenHits;
			if (score === 0) continue;
			const hitDate = f.archive ? (archDayDate || await dateOf('')) : await dateOf(blockDate);
			// A line whose date cannot be resolved at all passes both bounds —
			// never hide a hit whose age is unknown; the date field shows why.
			if (after && hitDate && hitDate < after) continue;
			if (before && hitDate && hitDate > before) continue;
			fileHits.push({
				zone: f.zone,
				name: f.name,
				line: i + 1,
				heading: heading.slice(0, 60),
				snippet: line.trim().slice(0, 160),
				date: hitDate,
				score: score + (nameHit ? 2 : 0),
			});
		}
		// At most 3 lines per file: one file should not monopolise the ranking.
		fileHits.sort((a, b) => b.score - a.score);
		hits.push(...fileHits.slice(0, 3));
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit).map(({ zone: z, name, line, heading, snippet, date }) => ({ zone: z, name, line, heading, snippet, date }));
}


// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/**
 * 问题收件箱工具 —— 各插件与 agent 投递"需要长期跟踪的问题"的统一入口。
 *
 * 为什么需要它：
 * 体检能发现问题，但"发现了之后谁在跟、修了没"没有落处。收件箱把
 * 三方投递（插件事件 / agent 报告 / 用户要求）汇成一份可分诊的清单，
 * 存在记忆管理这边 —— 它本来就是长期状态的持有者。
 *
 * 刻意不做：自动修复。收件箱只记录与追踪，动手由 agent 或用户决定。
 * @param {object} opts 插件选项。
 * @param {MemoryInbox} inbox 收件箱实例。
 */
function memoryInboxTool(opts, inbox) {
	return defineTool({
		name: 'memory_inbox',
		description:
			'Plugin-problem inbox shared by every plugin and the agent. action=post files one problem for long-term tracking (deduplicated by source+code+message); action=list shows the queue with open items first; action=update moves one item between open / acknowledged / resolved. Other plugins also post automatically through the `clis/health-finding` event, so listing is usually enough. Use it when a health check finds something that must not be forgotten, or when you promised the user to track a defect. It records and tracks only — it never fixes anything.',
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['post', 'list', 'update', 'delete'],
				description: 'post=投递一个问题；list=查看队列；update=改处置状态；delete=彻底删除一条（不可逆，用于误报/重复投递）。',
			},
			from: {
				type: 'string',
				description: 'action=post 时必填：投递方（插件名，或 "agent" / "user"）。',
			},
			code: {
				type: 'string',
				description: 'action=post 时必填：问题代号，需稳定（如 R14、clis.service-missing）。',
			},
			message: {
				type: 'string',
				description: 'action=post 时必填：一句话说清问题。',
			},
			severity: {
				type: 'string',
				enum: ['info', 'warn', 'error'],
				description: 'action=post 可选：严重度，缺省 warn。',
			},
			location: {
				type: 'string',
				description: 'action=post 可选：位置（文件路径、服务名等）。',
			},
			hint: {
				type: 'string',
				description: 'action=post 可选：方向提示，不是修复指令。',
			},
			fingerprint: {
				type: 'string',
				description: 'action=update 时必填：条目的 fingerprint（list 里能看到）。',
			},
			status: {
				type: 'string',
				enum: ['open', 'acknowledged', 'resolved'],
				description: 'action=update 时必填：新状态。',
			},
			note: {
				type: 'string',
				description: 'action=update 可选：处置备注。',
			},
			statusFilter: {
				type: 'string',
				enum: ['open', 'acknowledged', 'resolved'],
				description: 'action=list 可选：只看某个状态。',
			},
			fromFilter: {
				type: 'string',
				description: 'action=list 可选：只看某个投递方。',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					path: { type: 'string', required: true },
					// post
					posted: { type: 'boolean' },
					isNew: { type: 'boolean' },
					times: { type: 'integer' },
					// list / update
					count: { type: 'integer' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								fingerprint: { type: 'string', required: true },
								from: { type: 'string', required: true },
								code: { type: 'string', required: true },
								severity: { type: 'string', required: true },
								message: { type: 'string', required: true },
								status: { type: 'string', required: true },
								times: { type: 'integer', required: true },
								receivedAt: { type: 'string', required: true },
								lastSeenAt: { type: 'string', required: true },
								location: { type: 'string' },
								hint: { type: 'string' },
								note: { type: 'string' },
							},
						},
					},
				},
			},
			render: renderInbox,
		},
		async execute(args) {
			const path = inbox.filePath();

			if (args.action === 'post') {
				const { item, isNew, times } = await inbox.post({
					from: oneLine(args.from) || 'agent',
					code: oneLine(args.code) || 'unspecified',
					message: oneLine(args.message),
					severity: args.severity,
					location: args.location === undefined ? undefined : oneLine(args.location),
					hint: args.hint === undefined ? undefined : oneLine(args.hint),
				});
				return { action: 'post', path, posted: true, isNew, times, count: 1, items: [item] };
			}

			if (args.action === 'update') {
				const updated = await inbox.update(
					oneLine(args.fingerprint),
					args.status,
					args.note === undefined ? undefined : oneLine(args.note),
				);
				if (updated === undefined) {
					throw new Error(`no inbox item with fingerprint ${String(args.fingerprint)}`);
				}
				// count 统一表示**收件箱剩余总数**（渲染头那行说的就是它）。
				// 早先这里固定填 1，于是"改一条/删一条"都显示成"收件箱 1 条"，
				// 看起来像删除没生效 —— 语义错，不是数量错。
				const remaining = await inbox.list();
				return { action: 'update', path, count: remaining.length, items: [updated] };
			}

			if (args.action === 'delete') {
				// 彻底删除 —— 与"标记已解决"不同：那条保留记录（说明处理过），
				// 这条是"根本不该在收件箱里"（误报 / 重复投递 / 不再需要跟踪）。
				// 不可逆，故面板上有二次确认；工具层只负责删并回显被删的内容。
				const removed = await inbox.remove(oneLine(args.fingerprint));
				if (removed === undefined) {
					throw new Error(`no inbox item with fingerprint ${String(args.fingerprint)}`);
				}
				const remaining = await inbox.list();
				return { action: 'delete', path, count: remaining.length, items: [removed] };
			}

			const items = await inbox.list({
				...(args.statusFilter !== undefined ? { status: args.statusFilter } : {}),
				...(args.fromFilter !== undefined ? { from: oneLine(args.fromFilter) } : {}),
			});
			return { action: 'list', path, count: items.length, items };
		},
	});
}

/**
 * 收件箱结果的渲染。
 *
 * @param {object} args 入参。
 * @param {object} value 结果。
 * @returns {Array<{type: string, text: string}>}
 */
function renderInbox(args, value) {
	const lines = [];
	if (value.action === 'post') {
		lines.push(value.isNew ? '已投递（新条目）' : `已投递（第 ${value.times} 次，去重合并）`);
	} else if (value.action === 'delete') {
		// 说清"删了哪条、还剩几条" —— 否则一句"收件箱 N 条"会让人以为删没生效。
		lines.push(`已删除；收件箱 ${value.path} 剩 ${value.count} 条`);
	} else if (value.action === 'update') {
		lines.push(`已改处置状态；收件箱 ${value.path} 共 ${value.count} 条`);
	} else {
		lines.push(`收件箱 ${value.path}：${value.count} 条`);
	}
	for (const item of value.items ?? []) {
		const mark = item.status === 'open' ? '○' : item.status === 'acknowledged' ? '◐' : '●';
		lines.push(
			`${mark} [${item.severity}] ${item.from} · ${item.code} — ${item.message}` +
				(item.times > 1 ? `（×${item.times}）` : ''),
		);
		if (item.hint !== undefined) lines.push(`   提示：${item.hint}`);
		if (item.note !== undefined) lines.push(`   备注：${item.note}`);
	}
	if (value.action === 'list' && (value.count ?? 0) === 0) lines.push('（空）');
	return [{ type: 'text', text: lines.join('\n') }];
}

function memoryCheckTool(opts, inbox) {	return defineTool({
		name: 'memory_check',
		description:
			'Lint the memory root (read-only): MEMORY.md size caps + rows missing one-line summaries + zone files with NO index row (R5 orphan — an unindexed file is invisible to recall), dangling / root-escaping links (R10), function files reverse-linking to MEMORY.md detail (R8), function-file size (R9), over-detailed iteration blocks and index rows that were not distilled (R14), duplicated index rows or table sections (R15), head stable-state summary older than the newest iteration block or missing (R3), env-constant absolute paths that no longer exist (R16), a function area corrected over 40% of the time in the last 7 days (R18 circuit breaker), iteration date tags not append-ordered (R3), legacy/ files missing the 历史原貌 header (R13), credential material or personal identifiers in memory files (R21 memory defence), the insight layer’s retirement budget — count over cap, too many single-source principles, dangling .usage.jsonl hrefs (R23). Guarded files (🛡 守护型) are exempt from the cold-memory rule. Run it after batch memory edits or when memory_check has never run on this root.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					root: { type: 'string', required: true },
					results: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								level: { type: 'string', required: true, enum: ['WARN', 'FAIL'] },
								rule: { type: 'string', required: true },
								message: { type: 'string', required: true },
							},
						},
					},
					warnCount: { type: 'integer', required: true },
					failCount: { type: 'integer', required: true },
					tracked: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								rule: { type: 'string', required: true },
								times: { type: 'integer', required: true },
								status: { type: 'string', required: true },
								fingerprint: { type: 'string', required: true },
								resultIndex: { type: 'integer', required: true },
							},
						},
						description: '每条 WARN/FAIL 在问题收件箱里的跟踪状态（times=累计发现次数）。',
					},
					trackingFailures: {
						type: 'array',
						items: {
							type: 'object', additionalProperties: false,
							properties: {
								resultIndex: { type: 'integer', required: true },
								rule: { type: 'string', required: true },
								status: { type: 'string', enum: ['unknown', 'not_committed'], required: true },
								message: { type: 'string', required: true },
							},
						},
					},
				},
			},
			render: (_args, v) => {
				const lines = [`memory_check — ${v.root}：${v.failCount} FAIL，${v.warnCount} WARN`];
				const timesByIndex = new Map((v.tracked ?? []).map((t) => [t.resultIndex, t]));
				const failuresByIndex = new Map((v.trackingFailures ?? []).map((t) => [t.resultIndex, t]));
				for (const [index, r] of v.results.entries()) {
					const t = timesByIndex.get(index);
					// 复发计数是打破"报出来=尽到责任"回路的阻尼：同一问题第 N 次
					// 发现必须可见且递增，"存量"不再是无代价的口头标签。
					const recur = t && t.times >= 2 && t.status !== 'resolved' ? `（第 ${t.times} 次发现，仍 ${t.status}——处置或说明为何搁置，不要再标"存量"跳过）` : '';
					lines.push(`  [${r.level}] ${r.rule}: ${r.message}${recur}`);
					const failure = failuresByIndex.get(index);
					if (failure) lines.push(`    ⚠ 收件箱：${failure.message}`);
				}
				if (!v.results.length) lines.push('  全部通过');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: 'Lint memory structure', kind: 'other', rawInput: args }),
		async execute(_args, exec) {
			const root = resolveRoot(opts);
			const report = await runHealthCheck(root, opts);
			// 发现→跟踪零配合闭环（2026-11-09 用户质问"发现了为啥跳过"后加）：
			// 每条 WARN/FAIL 自动投递收件箱（指纹去重，复发 times+1）。
			// 投递失败不影响体检回执（跟踪是附加能力，缺了降级）；
			// 但 resolved 条目不清除——问题复现时 post 会自动重新 open。
			//
			// 污染守卫：只对**默认全局根**投递。测试套件用 opts.memoryRoot 注入
			// 临时根（造出 25 个假功能域/假 WARN），那些是测试夹具不是真实问题，
			// 绝不能进全局收件箱把复发计数灌水。opts.memoryRoot 存在即测试态。
			const tracked = [];
			const trackingFailures = [];
			if (inbox && !opts.memoryRoot) {
				let scope;
				try {
					scope = await realpath(root);
					if (process.platform === 'win32') scope = scope.toLowerCase();
				} catch { /* unknown scope: keep legacy identity, never guess */ }
				for (const [resultIndex, r] of (report.results ?? []).entries()) {
					try {
						const { item } = await inbox.post({
							from: 'memory-manager',
							code: r.rule,
							severity: r.level === 'FAIL' ? 'error' : 'warn',
							message: r.message,
							hint: '体检自动投递：处置后 memory_inbox update resolved，或说明搁置理由',
							...(scope && healthIssueIdentities.has(r) ? { identity: { scope, ...healthIssueIdentities.get(r) } } : {}),
						});
						tracked.push({ rule: r.rule, times: item.times, status: item.status, fingerprint: item.fingerprint, resultIndex });
					} catch (error) {
						// Only a confirmed pre-replacement failure is known not to commit.
						const notCommitted = error?.code === 'INBOX_NOT_COMMITTED';
						trackingFailures.push({
							resultIndex, rule: r.rule, status: notCommitted ? 'not_committed' : 'unknown',
							message: notCommitted ? '跟踪未写入收件箱，请检查存储后重试。' : '跟踪结果未知，请先读取收件箱核对，不要盲目重试。',
						});
					}
				}
			}
			return { ...report, ...(tracked.length ? { tracked } : {}), ...(trackingFailures.length ? { trackingFailures } : {}) };
		},
	});
}

/**
 * memory_index — the INTEGRATION layer (data-flow layer 3). Function areas and
 * insights are written by memory_write / memory_insight; this tool is the ONLY
 * writer of the MEMORY.md dual tables, invoked once a feature/theme has
 * stabilized. Keeps the index a derived, curated surface instead of a
 * write-time side effect.
 */
function memoryIndexTool(opts) {
	return defineTool({
		name: 'memory_index',
		description:
			'Upsert ONE row into the MEMORY.md index (the integration layer). Call it when a feature area or insight theme has STABILIZED (>=2 iteration blocks, or clearly a standalone topic) — not per write. The row summary is distilled from the area\'s iteration-block summaries: one sentence saying what this feature IS. Zones: zone=functions or zone=insights. Unindexed-but-existing files are surfaced by memory_check (R5 orphan) so nothing silently falls out of the index.',
		parameters: {
			// The tool's execute body only routes functions/insights to their table
			// (a ternary, twice). Enumerating more zones here would make the SCHEMA
			// promise what the implementation does not: passing `dao` silently wrote a
			// functions-style table row under the wrong heading. 道层 rows are hand
			// bullets and are validated by R24 / R5 instead; keep the enum honest.
			zone: { type: 'string', required: true, enum: ['functions', 'insights'], description: '收进哪张索引表。' },
			name: { type: 'string', required: true, description: '功能域或思想主题 slug（functions/ 或 insights/ 下的既有文件名，不含 .md）。' },
			summary: { type: 'string', required: true, description: '索引行摘要：一句话（≤60 字）说清"这是什么/解决什么"，供检索时判断相关性；从各迭代块的概括中提炼，不复制细节。' },
			group: { type: 'string', description: '可选：功能表已按 `### 索引·<域>` 分组时，指定这一行落到哪个子分区（如「基础设施」「业务功能」）；缺省写入无标题的总表。' },
			sources: { type: 'array', description: 'zone=insights 必填：来源功能域 slug 列表（渲染进"相关（来源功能）"列）。', items: { type: 'string' } },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					indexFile: { type: 'string', required: true },
					zone: { type: 'string', required: true },
					name: { type: 'string', required: true },
					created: { type: 'boolean', required: true },
					indexBytes: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`索引已更新：${v.zone}/${v.name}${v.created ? '（新行）' : '（更新）'}`,
					`索引文件：${v.indexFile}（${v.indexBytes}B）`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory index: ${args.zone ?? ''}/${args.name ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const zone = args.zone === 'insights' ? 'insights' : 'functions';
			const name = safeSlug(args.name);
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the index row must carry a one-line summary');
			const warnings = [];
			if (charLen(summary) > MAX_ROW_SUMMARY_CHARS) {
				warnings.push(`索引行摘要 ${charLen(summary)} 字 > ${MAX_ROW_SUMMARY_CHARS}：摘要是一句话，细节留在功能文件`);
			}
			const indexPath = path.join(root, 'MEMORY.md');
			// The whole presence-check → build-row → upsert → write sequence runs
			// under the shared MEMORY.md writer lock (audit #3): a concurrent row
			// write must never be computed-over. `created` reports what THIS write
			// observed when it held the lock — which is the honest answer.
			const { created, indexBytes } = await withPathLock(indexPath, async () => {
				const indexText = (await readIfExists(indexPath)) ?? memoryIndexTemplate();
				// Row presence check is shape-agnostic: the name cell may be plain
				// text (legacy 4-column rows) or a link (current rows).
				const rowExists = indexText.split('\n').some((l) => {
					if (!l.trim().startsWith('|')) return false;
					const first = l.trim().replace(/^\|/, '').split('|')[0].trim();
					return first === name || first === `[${name}](${zone === 'insights' ? 'insights' : 'functions'}/${name}.md)`;
				});
				let row;
				if (zone === 'insights') {
					const srcs = (Array.isArray(args.sources) ? args.sources : []).map((s) => safeSlug(s)).filter((s) => s !== name);
					if (!srcs.length) throw new Error('zone=insights requires sources: the theme must name the areas it was distilled from');
					row = `| [${name}](insights/${name}.md) | ${summary}（来源：${srcs.map((s) => `[${s}.md](functions/${s}.md)`).join('、')}） |`;
					if (!(await statExists(path.join(root, 'insights', `${name}.md`)))) {
						warnings.push(`insights/${name}.md 尚不存在——索引行先建了，记得用 memory_insight 沉淀文件本体`);
					}
				} else {
					row = `| [${name}](functions/${name}.md) | ${summary} |`;
					if (!(await statExists(path.join(root, 'functions', `${name}.md`)))) {
						warnings.push(`functions/${name}.md 尚不存在——索引行先建了，记得用 memory_write 落第一个迭代块`);
					}
				}
				const nextText = upsertIndexRow(
					indexText,
					zone === 'insights' ? INSIGHT_TABLE_HEADING : FUNC_TABLE_HEADING,
					zone === 'insights' ? INSIGHT_TABLE_HEADER : FUNC_TABLE_HEADER,
					name,
					row,
					zone === 'functions' && typeof args.group === 'string' && args.group.trim() ? oneLine(args.group).slice(0, 20) : undefined,
				);
				await writeText(indexPath, nextText);
				return { created: !rowExists, indexBytes: byteLen(nextText) };
			});
			// The row just written must be recallable on the NEXT step, not after the
			// 10s cache TTL (audit #10).
			opts.dropRecallCaches?.();
			if (indexBytes > opts.maxIndexBytes) {
				warnings.push(`MEMORY.md ${indexBytes}B > ${opts.maxIndexBytes}B 舒适线：压缩各行摘要，或把功能表拆成 ### 子分区`);
			}
			return {
				indexFile: indexPath,
				zone,
				name,
				created,
				indexBytes,
				warnings,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// system-prompt discipline section
// ---------------------------------------------------------------------------

const DISCIPLINE_TEXT = [
	'## 持久记忆纪律（memory-manager）',
	'',
	'本 Harness 维护**全局**跨会话记忆（`~/.dsh/memory/`，即 dshHome 的 memory/ 目录；十四个工具：memory_read / memory_search / memory_capability / memory_write / memory_index / memory_insight / memory_dao / memory_fold / memory_rename / memory_check / memory_usage / memory_federation / memory_skill / memory_inbox；结构见 memory/MEMORY.md）。记忆对全部项目、全部会话通用，按功能域组织而非按项目隔离。**数据流单向五层，每层只吃上一层的产出**：',
	'',
	'- **第 0 层 · 每日记录（原始层）**：`YYYY-MM-DD.md` 可由 agent 使用编辑工具记录；每天留意有价值的判断、取舍、经验、踩坑因果和待验证事项，没有值得记录的内容时不强制当天有条目。粗粒度筛选：**执行式日志（常规命令输出、PID、退出码、耗时流水）不要抄**，理解关键因果必需的细节可少量保留；不补造历史，不记录凭据。直接编辑不等于插件采集或来源认证，也不自动脱敏；来源不明时如实标记未知，可能触发 R26 对账或采集基线不匹配，不得补造账本。插件用户消息采集默认关闭，开启后只采集符合条件的用户原话并脱敏、截断，不自动记录助手判断，也不保证来源认证或完整性；未启用时如实说明采集缺口。其他记忆层仍按各自插件工具与保护机制写入。',
	'- **第 1 层 · 功能域（memory_write）**：从每日原始记录中**归纳汲取**功能划分——一个 functions/<功能域>.md 迭代块 = **≥3 个主题相关素材日的综合结论**（蒸馏结论：动因/改动/判据/待观察 各一句；2026-11-09 用户要求：不以单日为单位蒸馏，单日事件多是过程片段，多天的演化/反复/被推翻才值得归档）。**素材日由 agent 围绕主题检索推理挑选**（memory_search 全库找相关日，可不连续、可跨周月），不是机械取最近 3 天——选证据关联不选日历相邻，块内说明为何选这些日。相关素材不足 3 天先积累不蒸馏（周检是天然时机）；用户显式要求或踩坑因果/安全约束可豁免，块内注明素材日期与理由。`summary` 是本块的一句话概括；功能域该新建还是并入既有的，判断依据就是每日记录里反复出现的主题。',
	'- **第 2 层 · 创新思想（memory_insight）**：从功能划分中**再提取**可迁移原则（会重套的、不绑定单一功能机制的），回链来源功能域；取代旧思想传 `supersedes`。',
	'- **第 3 层 · 索引与总览（memory_index）**：**整合层**——功能域稳定后（有 ≥2 个迭代块，或用户可感知为独立主题时）用 memory_index 把它收进 MEMORY.md 索引；索引行摘要 = 从各迭代块的概括中提炼的"这个功能是什么"。索引是展示与检索的派生物，不与单次写入强绑。',
	'- **第 4 层 · 技能（memory_skill）**：**使用环收口**——一个被反复重跑且被确认的操作，应结晶为可调用程序（何时使用/步骤/坑/验证），下次命中直接照做，不再现场推导。**技能就是一个宿主目录包**：`<dshHome>/skills/<kebab-name>/SKILL.md`（+ 可选 scripts/references/assets），与宿主 `skill` 工具、面板技能库读的是同一份——没有记忆根副本、没有指针文件。何时结晶：`memory_skill(candidates)` 给出机械提名（≥6 次使用 + ≥1 次确认 + 纠正率<20%，来自 .usage.jsonl），**提名≠结晶**——是否成文由你判断证据是否连贯。**成文必须走 skill-creator 流程**（`~/.dsh/skills/skill-creator/`，其描述命中即用 `skill` 工具加载）：Step1 具体用例 → Step2 规划可复用内容 → Step3 `init_skill.py` 初始化目录包 → Step4 祈使句式编辑 → Step5 `quick_validate.py` + `package_skill.py` 校验打包 → Step6 真实任务实战迭代；Quality Bar 逐条过（description ≤80 词且带 when-to-use、use/do-not-use 触发、祈使句式、规则配机器可检脚本、无死链、体积预算）。生命周期 candidate→active（真实任务照做成功过才转正）→retired（环境变了留档），写在 frontmatter `status`；`agent_created: true` 标记本插件自有（面板据此区分「结晶技能」与「系统技能」）。技能名必须 kebab-case（它同时是宿主目录名）。召回只放行 active 技能并标注 ⭐；技能=怎么做（程序），capability=有什么工具，insight=什么原则——三者别混。结晶时标 `scope`（global=跨项目通用 / project=须带 scopeProject=<项目名>），跨项目复用前先核对作用域。',
	'- **层级定义（道/法/术/器，按普适程度分）**：**器**=指向内容的指针与检索面（MEMORY.md 双表+面板）；**术**=一个功能域"怎么做"的完整迭代史（functions/，判据"我会不会再跑一次这个操作"）；**法**=从具体操作提炼的可套原则（insights/，判据"换个项目/领域还成立吗"）；**道**=**dao/** 里最抽象的指导思想（判据"换个领域是否依然成立"）——由 `memory_dao` 从 **≥5 条法**萃取，硬闸门把关，`memory_check` 的 R24 守其完整性；违反即出事故的**约束**另在 **MEMORY.md 共识区**（R19 把关）。**放错层的三个信号**：① 在功能域里翻到普适断言 → 该升到 insights；② 同一句话想写进两个功能域 → 该升到 insights；③ 一条"原则"每次都要附带操作步骤才能用 → 该降回 functions。**反例**：索引行里写推导过程；迭代块里写"以后所有项目都应该……"；原则写成"1. 先运行 X；2. 再执行 Y"；把某次技术选型记成共识；把只在一个域验证过的经验当"道"萃取（那只是专项，够 5 条才谈得上道）。',
	'- **先查后写**：涉及"项目里怎么做 / 为什么这么做 / 环境常量"时，先 `memory_read kind=index`（行内摘要判断相关性，再打开对应文件）；只记得片段、说不清在哪个域或哪天时用 `memory_search`（全库排序检索，返回命中的分区/文件/行号/小节/片段）。**动手前先查 `memory_capability`**：外部 CLI / MCP / 已装软件都在 `capabilities/` 台账里，能省下一整轮摸索。不要凭空重推已有结论。',
	'- **用到的外部工具要登记**：只有**项目外部**的工具才进台账——第三方 CLI / MCP / 已装软件，且调用它需要摸索（确切命令、前提、踩过的坑）。不登记：harness 自带工具（shell/文件/网络等，模型本来就会）、本项目自己的脚本与 API（那是 functions/ 迭代块）。台账按工具一文件、就地更新——**不是流水账，是索引**。下次同类任务先 `action=list`，不要重新摸索同一个工具。',
	'- **蒸馏不搬过程**：迭代块只写结论；逐条实现清单、调试经过属于每日原始层与会话/代码。块 >900 字或概括 >110 字写入告警，体检 R14 复查。',
	'- **蒸馏后必须自检（2026-11-02 用户要求）**：`memory_write` / `memory_insight` / `memory_dao` / `memory_capability` / `memory_skill` 的回执里都带 `selfCheck`——它是**从磁盘回读产物、按该层自己的定义**核出来的结果（术=块只装结论、法=来源≥2 且原则非步骤、道=命题+≥5 条来源法、器=调用方式在场、技能=frontmatter/name/status 合规）。**`selfCheck.ok` 为假时不得当成已完成**：按它点名的那一项修正后重写，再向用户汇报。绿灯只证"写过了"，不证"写出的东西符合它那一层"。',
	'- **层级判据是硬闸门，不是建议（2026-11-02）**：写入前就拒绝，不会先落盘再提醒。**道**：命题须有哲学形态（对立/张力 或 生成性/演化 至少其一；静态断言如「所有系统都会腐烂」被拒），正文须含描述节（说世界是什么，禁规范动词）、推演节（论证几条法如何**共同**逼出命题，不是逐条复述）、边界节（说出何时不成立）。**法**：须有边界节且含**反面**（只有「适用于哪些场景」会被判 boundary-one-sided）。**术**：块 ≤900 字、概括 ≤110 字。判据实现见 `src/layer-gate.js` / `layer-selfcheck.js` / `dao-shape.js`；回执里的 `selfCheck` 是磁盘回读结果。',
	'- **经验三分**：会**重跑**的操作进 functions/；会**重套**的原则用 memory_insight 进 insights/；**反复重跑且被验证**的操作程序用 memory_skill 结晶为宿主技能目录包（`<dshHome>/skills/<kebab>/`，`agent_created: true` 是归属标记）；跨功能共识与环境常量只在 MEMORY.md。',
	'- **使用信号让记忆自己排序**：召回命中与 memory_read 会自动记信号；用户纠正/明确认可时用 `memory_usage(action=record, kind=correction|positive)` 记一笔（这是分层判断里唯一不能自动获得的信号）。`memory_usage(action=report)` 给出 实验/专项/通用 建议；某域近 7 天纠正率 >40% 时体检 R18 报熔断——先重构再追加。',
	'- **守护型**：低频但高价值的记忆（安全审计、关键踩坑、兜底规则）用 `memory_write(guard=true)` 标记，体检的冷记忆规则会跳过它——不要因为"很久没写"就删掉兜底经验。',
	'- **项目归属**：涉及特定项目的记忆，在功能域 slug 或正文里注明项目名（如 `toolbox-login`）。功能域多到单根过大时，可启用**联邦模式**（`federation: { root, projects }`）：项目真相源留在各项目记忆根，`memory_federation` 负责刷副本与跨项目索引，项目细节不上升。',
	'- **收缩机制**：功能文件超 30KB 用 `memory_fold` 折叠最旧块；MEMORY.md 超线按 ### 子分区拆分；重命名/合并用 `memory_rename`（改写派生层引用并报告剩余死链；历史每日记录保留原样，可能仍指向旧名）。',
	'- **密钥防线**：凭据（API key / token / 私钥 / JWT）绝不进记忆——插件写入口在落盘前把凭据形态替换成 `[REDACTED:kind]` 并在回执点名；每日采集也须经过插件脱敏；体检 R21 是补充检测，身份证/手机号只告警不改写。留「调用形态 + 前提从哪里领」，不留密钥本体。',
	'- 批量改动记忆后跑 `memory_check` 体检。',
	'- 归属口诀：会**重跑**的操作（术·functions/）、会**重套**的原则（法·insights/）、**反复跑通且验证**的程序（技能·宿主目录包 `<dshHome>/skills/`，靠 frontmatter `agent_created` 与外来安装包区分）、**≥5 条法萃出的上位命题**（道·dao/，由 `memory_dao` 写、R24 守）、违反即出事故的约束（共识区·MEMORY.md，R19 守）、指向内容的指针（器·索引与面板）；原始过程永远只留在每日记录。',
].join('\n');

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

const MIME_PLAIN = { 'Content-Type': 'text/plain; charset=utf-8' };
const MIME_HTML = { 'Content-Type': 'text/html; charset=utf-8' };

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function panelError(err) {
	const result = { error: String(err?.message ?? err) };
	if (typeof err?.code === 'string' && err.code.startsWith('MEMORY_')) result.code = err.code;
	for (const key of ['intentId', 'deleteStatus', 'ledgerStatus', 'cleanupStatus']) if (typeof err?.[key] === 'string') result[key] = err[key];
	if (err?.fileWritten === null || typeof err?.fileWritten === 'boolean') result.fileWritten = err.fileWritten;
	return result;
}

/** Read a small JSON POST body (the panel's write channel only sends tiny payloads). */
async function readBody(req, limit = 16 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > limit) throw new Error('body too large');
		chunks.push(c);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('invalid JSON body');
	}
}

function htmlPage(res, status, title, body) {
	res.writeHead(status, MIME_HTML);
	res.end(
		`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>` +
			`<body style="font-family:system-ui;margin:2rem;line-height:1.7"><h1>${title}</h1>${body}` +
			`<p style="color:#888;font-size:.9em">memory-manager 面板 API</p></body></html>`,
	);
}

/** Zone file counts for the rail badges (directory listing only, no reads). */
async function zoneCounts(root, skillRoot = '') {
	const count = async (dir, test) => {
		try {
			return (await readdir(dir)).filter(test).length;
		} catch {
			return 0;
		}
	};
	const countBundles = async (dir) => {
		try {
			const ents = await readdir(dir, { withFileTypes: true });
			let n = 0;
			for (const e of ents.filter((x) => x.isDirectory())) {
				try {
					await stat(path.join(dir, e.name, 'SKILL.md'));
					n++;
				} catch {
					/* not a bundle */
				}
			}
			return n;
		} catch {
			return 0;
		}
	};
	// Derived from FILE_ZONES so a new layer is counted here for free — `dao/` was
	// missing from this literal, so the rail badge never saw it (a layer you can
	// write but not count reads as "the feature does not exist").
	const byZone = {};
	for (const z of FILE_ZONES) byZone[z] = await count(path.join(root, z), (n) => n.endsWith('.md'));
	return {
		...byZone,
		// 5.24.0: skills are host bundles — the badge counts directories that
		// actually carry a SKILL.md.
		skills: await countBundles(skillRoot || path.join(dshHome(), 'skills')),
		// 月/周折叠方案（2026-11）：口径变更 —— counts.daily 含归档月文件
		// （daily/YYYY-MM.md）在内；归档本身的数量另立 archived 计数，汇报时注明。
		archived: await count(path.join(root, 'daily'), (n) => /^\d{4}-\d{2}\.md$/.test(n)),
		daily: await count(root, (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)) + await count(path.join(root, 'daily'), (n) => /^\d{4}-\d{2}\.md$/.test(n)),
	};
}

/**
 * Build the panel API handler. The memory root is global and always resolved
 * server-side, so a request can never widen it: there is deliberately no
 * client-supplied `?path=`.
 * SECURITY (5.27.0, from the adversarial audit): the host webServer dispatches
 * registered routes with NO auth middleware — the fence is a service plugins
 * must pull themselves (`connection.requestRejection`, the Host/Origin +
 * login-token gate dsh-host-open-in-app and the inspector use). Without it,
 * any local process and any cross-site form/no-cors fetch could delete skills,
 * trigger reloads, and (via DNS rebinding) read the whole memory store. So:
 * every request passes the fence when the host offers `connection`; when it
 * does not, the MUTATING routes refuse (501) and reads stay — a host without
 * the connection service is a host where we cannot tell caller from stranger,
 * so writes are off, never guessed-open.
 */
const PANEL_WRITE_SEGS = new Set(['skill-action', 'reload', 'inbox-action', 'axiom-action', 'dao-action']);
function memoryPanelApi(opts, connection, inbox) {
	return async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const seg = url.pathname.slice('/api/memory-org'.length).replace(/^\//, '');
		if (connection && typeof connection.requestRejection === 'function') {
			const rejection = connection.requestRejection(req);
			if (rejection !== undefined) return json(res, rejection, { error: 'unauthorized' });
		} else if (PANEL_WRITE_SEGS.has(seg)) {
			return json(res, 501, { error: '宿主未提供 connection 服务，无法核验调用方——写路由已禁用' });
		}
		const root = resolveRoot(opts);
		const transactionalPost = req.method === 'POST' && ['axiom-action', 'dao-action', 'skill-action'].includes(seg);
		let transactionBody;
		if (transactionalPost) {
			// Do not hold the shared write queue while waiting for a client body.
			try { transactionBody = await readBody(req); }
			catch (err) { return json(res, 400, { error: String(err?.message ?? err) }); }
		}
		const handle = async () => {
		try {
			if (seg === 'overview') {
				const health = panelizeHealth(await runHealthCheck(root, opts));
				// Panel-side usage snapshot: layer histogram + flip/correction hot
				// spots, so the overview answers "how is the memory being used"
				// alongside "how big is it". Optional data — absent when the log is
				// empty (a fresh root starts with no signals).
				const usage = summarizeUsage(await readUsage(root, 30));
				const layerCounts = { 实验: 0, 专项: 0, 通用: 0 };
				const hotspots = [];
				for (const it of usage) {
					if (layerCounts[it.layer] !== undefined) layerCounts[it.layer]++;
					if (it.flips >= 2 || (it.uses >= 3 && it.badRate > 0.4)) {
						hotspots.push({ href: it.href, flips: it.flips, badRate: it.badRate, uses: it.uses });
					}
				}
				const signalCount = (await readIfExists(usagePath(root)))?.split('\n').filter((l) => l.trim()).length ?? 0;
				// Overview environment block (5.26.0): the panel answers "which
				// build is actually running, where do my two stores live, how full
				// is the index" from the SERVER's own truth. `version` is opts.version
				// — captured when THIS fiber applied — not a fresh disk read, so it
				// is the RUNNING build, which may lag an edit until the swap.
				let indexBytes = 0;
				try {
					indexBytes = byteLen((await readIfExists(path.join(root, 'MEMORY.md'))) ?? '');
				} catch {
					/* fresh root */
				}
				const env = {
					version: opts.version ?? '',
					canReload: Boolean(opts.canReload),
					hotReloadRunning: isReloading(),
					memoryRoot: root,
					skillRoot: opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills'),
					indexBytes,
					indexComfortBytes: opts.maxIndexBytes,
					indexHardBytes: opts.maxIndexHardBytes,
					// The swap's TERMINAL outcome (not just "it started") so the
					// panel can tell success from a swallowed rollback.
					lastReload: globalThis[Symbol.for('dsh-memory-manager.last-reload')] ?? null,
				};
				const capture = opts.captureStatus?.();
				return json(res, 200, [{ ...health, title: '全局记忆', path: joinDshHome(), counts: await zoneCounts(root, opts.skillRoot), usage: { signalCount, layers: layerCounts, hotspots: hotspots.slice(0, 5) }, capture: capture ? { ...capture, intentWitness: await inspectCaptureIntent(root) } : null, env }]);
			}
			if (seg === 'file') {
				const name = url.searchParams.get('name');
				if (!name || /[\\/]|\.\./.test(name) || !name.endsWith('.md')) {
					return json(res, 400, { error: 'invalid file name' });
				}
				const zone = url.searchParams.get('zone') ?? '';
				if (!['', ...SEARCH_ZONES].includes(zone)) {
					return json(res, 400, { error: 'invalid zone' });
				}
				if (zone === 'daily' && !/^\d{4}-\d{2}(-\d{2})?\.md$/.test(name)) {
					// 月/周折叠方案（2026-11）：每日分区同时放行日线程（YYYY-MM-DD.md）
					// 与月归档（YYYY-MM.md）。两种形态都是严格的日期形名字 —— join 只能
					// 落在记忆根下，MEMORY.md 等杂文件天然被这条正则拒绝。
					return json(res, 400, { error: 'daily zone accepts only YYYY-MM-DD.md or YYYY-MM.md' });
				}
				if (zone === 'daily' && /^\d{4}-\d{2}\.md$/.test(name)) {
					// 月形名做真实月份校验：13 月这类不可能日期拒绝在 400，而不是
					// 落到 404 让调用方误以为格式合法但文件不存在。
					const monthNum = Number(name.slice(5, 7));
					if (!(monthNum >= 1 && monthNum <= 12)) {
						return json(res, 400, { error: 'daily zone accepts months 01-12' });
					}
				}
				// 归档文件固定落在 root/daily/ 下；根层仍只放日线程。先验月形名，
				// 再决定目录——穿越与杂文件在上一条已拒。
				const isMonthArchive = zone === 'daily' && /^\d{4}-\d{2}\.md$/.test(name);
				const full = zone === 'daily'
					? path.join(isMonthArchive ? path.join(root, 'daily') : root, name)
					: path.join(root, zone, name);
				const text = await readIfExists(full);
				if (text === undefined) return json(res, 404, { error: 'file not found' });
				return json(res, 200, { name, text });
			}
			// 月归档的日线索（月/周折叠方案 2026-11）：只解析 `### [YYYY-MM-DD]`
			// 标题行，不读全文。展开归档时前端先拿这份索引，点开某一天再走
			// /file?zone=daily 按需取正文 —— 归档月可能有几十天，一次性全文会拖慢列表。
			if (seg === 'daily-days') {
				const name = url.searchParams.get('name');
				if (!name || !/^\d{4}-\d{2}\.md$/.test(name) || !/^\d{4}-(0[1-9]|1[0-2])\.md$/.test(name)) {
					return json(res, 400, { error: 'daily-days accepts only YYYY-MM.md' });
				}
				// 严格月形名 + 无分隔符（上面已拒 .. 与 /）→ join 只能落在 root/daily/。
				const text = await readIfExists(path.join(root, 'daily', name));
				if (text === undefined) return json(res, 404, { error: 'archive not found' });
				// 标题行解析必须**不跨行**：`\s*` 会吃掉 \n 把下一天的正文第一行当成
				// 标题尾（实测踩过）。行内空白用 [ \t]*，标题只可能是同一行的尾巴。
				const days = [...text.matchAll(/^###[ \t]*\[(\d{4}-\d{2}-\d{2})\][ \t]*([^\n]*)$/gm)].map((m) => ({ date: m[1], title: m[2].trim() }));
				return json(res, 200, { name, days });
			}
			// Recall preview (MemOS borrow ②): run the REAL pre-step pipeline
			// against an arbitrary query and return what would be injected, with
			// why. Recall quality was previously only observable after the fact;
			// this makes "this input recalls these rows, for these reasons" a
			// first-class, debuggable answer (same code path, same RRF fusion).
			if (seg === 'recall-preview') {
				const q = (url.searchParams.get('q') ?? '').trim();
				if (q.length < 2) return json(res, 200, { query: q, rows: [], message: '（查询至少 2 个字符）' });
				const indexText = (await readIfExists(path.join(root, 'MEMORY.md'))) ?? '';
				if (!indexText) return json(res, 200, { query: q, rows: [], message: '（记忆根尚未建档）' });
				const usageItems = summarizeUsage(await readUsage(root, 30));
				const usage = new Map(usageItems.map((it) => [it.href, it]));
				const tokens = tokensOf(q);
				const rows = matchIndexRows(indexText, tokens, 3, usage, { memoryRoot: root })
					.filter((l) => !q.includes(l.href))
					.map((r) => {
						const u = usage.get(r.href);
						const reasons = [];
						const nameTokens = tokensOf(r.name);
						const hits = [...tokens].filter((t) => nameTokens.has(t));
						if (hits.length) reasons.push(`名称命中：${hits.join('、')}`);
						if (r.lexical !== undefined) reasons.push(`词法分 ${Number(r.lexical).toFixed(2)}`);
						if (u) reasons.push(`使用 ${u.uses} 次 · 认可 ${u.positives} · 纠正率 ${u.badRate}`);
						return {
							href: r.href,
							zone: r.zone,
							summary: r.summary,
							fusedScore: Number(r.score.toFixed(4)),
							lexicalScore: r.lexical === undefined ? undefined : Number(r.lexical.toFixed(2)),
							usage: u ? { uses: u.uses, positives: u.positives, corrections: u.corrections, badRate: u.badRate, layer: u.layer } : null,
							reasons,
							// Would the user's own text have suppressed this row?
							suppressedByPointerDedupe: false,
						};
					});
				return json(res, 200, {
					query: q,
					tokens: [...tokens],
					usageSignals: usageItems.length,
					rows,
					message: rows.length ? '' : '（索引行无命中；档案、纠正提示或负向规则仍可能被召回）',
				});
			}
			// Skill library (5.18.0): the panel shows BOTH halves of "skills" —
			// host-native (bundled/project/user: the presets, office, anything the
			// host `skill` tool can load) and memory-crystallized (our skills/, in
			// every lifecycle state). The two sources meet at one identity: a host
			// row whose `path` is inside our skills/ dir is OUR published skill, so
			// it folds into the memory half and the host half never double-counts
			// it. Reads go through the bridge's borrowed registry — the same
			// catalog the host tool resolves, one source of truth.
			// Skill library (5.20.0): scan STORAGE, not the registry. The registry
			// answers "what can the machine invoke" (publish gates, invocation
			// policy); the panel is a READER for what is actually stored — SKILL.md
			// bodies, scripts/, references/. Two different surfaces, deliberately
			// not one source (the user's point: 后端运行逻辑与前端展示不必一致).
			// Host roots mirror dsh-skill-filesystem's roots() so what is listed
			// here is exactly what is on disk there.
			// Panel write channel (5.21.0): the ONLY mutating route. The panel posts
			// the same argument shape the memory_skill tool takes and this runs the
			// tool's real executor — so the slug guard, atomic write, index sync and
			// host invalidation hold identically. Actions are whitelisted here; a
			// browser must never reach crystallize (that is a model judgement).
			// Hot reload (5.25.0): replace the running server half with the code on
			// disk — NO process restart (the mechanism, borrowed from
			// dsh-our-free-model, purges the module caches and re-applies the plugin
			// in place; safe here because this plugin holds no long-running state).
			// Respond FIRST, swap on a plain timer: disposing the current fiber would
			// otherwise cancel the very effect performing the swap.
			if (seg === 'reload') {
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
				// A host without the plugin loader/registry cannot re-import or
				// re-register — say so up front (501) instead of accepting (202) and
				// failing silently inside the async swap. The capability is probed
				// exactly the way selfReload probes it.
				if (!opts.canReload) return json(res, 501, { error: '本宿主不支持热重启（没有 loader/registry），请重启进程' });
				if (isReloading()) return json(res, 409, { error: '已有热重启在跑' });
				// COOLDOWN (5.27.0): every swap disposes and re-registers the whole
				// fiber — a caller hammering POST put the host through teardown
				// windows back to back (the audit's self-DoS). The stamp is taken at
				// ACCEPTANCE, not at completion: the swap is deferred (and detached),
				// so a completion-only marker would wave through a burst of requests
				// fired before the first swap even began. The marker lives on
				// globalThis because a module-level counter would reset with every
				// fresh evaluation this very route triggers.
				const accKey = Symbol.for('dsh-memory-manager.last-reload-accepted');
				const lastAccepted = globalThis[accKey] ?? 0;
				const since = Date.now() - lastAccepted;
				if (since < 15_000) return json(res, 429, { error: `距上次受理仅 ${Math.round(since / 1000)}s（冷却 15s）`, retryAfterMs: 15_000 - since });
				globalThis[accKey] = Date.now();
				json(res, 202, { note: 'hot reload started', version: opts.version });
				setTimeout(() => {
					// The outcome is NOT swallowed (it used to be .catch(()=>{}) — the
					// panel believed every 202). selfReload now publishes its terminal
					// result to the global marker; log failures for the operator.
					opts.reload().catch((e) => console.warn?.(`memory-manager: reload crashed: ${e?.message ?? e}`));
				}, 150);
				return;
			}
			if (seg === 'axiom-candidates') {
				// 候选公理列表（2026-11-10）：面板道层用它做"候选"筛选标签。
				// 只读；确认/否决走 axiom-action。
				const candDir = path.join(root, 'dao', '_candidates');
				if (url.searchParams.has('name')) {
					if (req.method && req.method !== 'GET') return json(res, 405, { error: 'GET only' });
					const name = url.searchParams.get('name');
					try {
						// Require the exact slug; safeSlug alone normalizes whitespace and .md.
						if (safeSlug(name) !== name || /[.\s]$/.test(name) || /[\x00-\x1f]/.test(name)) throw new Error('invalid slug');
					} catch {
						return json(res, 400, { error: 'invalid candidate name' });
					}
					try {
						// Resolve links too: neither a linked candidate directory nor a linked
						// file may redirect this endpoint outside its designated directory.
						const rootReal = await realpath(root);
						const dirReal = await realpath(candDir);
						const fileReal = await realpath(path.join(candDir, `${name}.md`));
						const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
						if (!samePath(dirReal, path.join(rootReal, 'dao', '_candidates')) || !samePath(fileReal, path.join(dirReal, `${name}.md`))) {
							return json(res, 400, { error: 'candidate path outside permitted directory' });
						}
						const text = await readFile(fileReal, 'utf8');
						return json(res, 200, { name, text });
					} catch (err) {
						if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return json(res, 404, { error: 'candidate not found' });
						throw err;
					}
				}
				let names = [];
				try {
					names = (await readdir(candDir)).filter((f) => f.endsWith('.md')).sort();
				} catch (err) {
					// 与巡检同一纪律：读不到**不能**报成"零候选"。
					// dao/ 存在才算"还没候选"，否则是记忆根故障。
					if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
						let daoOk = false;
						try { daoOk = (await readdir(path.join(root, 'dao'), { withFileTypes: true })) !== undefined; } catch { daoOk = false; }
						if (!daoOk) return json(res, 500, { error: 'dao/ 不可读（记忆根可能有问题）', candidates: [] });
						return json(res, 200, { candidates: [], count: 0 });
					}
					return json(res, 500, { error: String(err?.message ?? err), candidates: [] });
				}
				const items = [];
				for (const f of names) {
					const slug = f.replace(/\.md$/, '');
					try {
						const text = await readFile(path.join(candDir, f), 'utf8');
						const proposition = /##\s*命题\s*\n+([\s\S]*?)(?:\n##|$)/.exec(text)?.[1]?.trim() ?? '';
						const sources = [...text.matchAll(/^- \[([^\]]+)\]\(\.\.\/insights\//gm)].map((m) => m[1]);
						items.push({
							...describeCandidate({
								name: slug, proposition, extracted_from: sources,
								status: AXIOM_CANDIDATE_STATES.candidate,
								evidence: /##\s*待决策\s*\n+([\s\S]*?)$/.exec(text)?.[1]?.trim() ?? '',
							}),
							file: `dao/_candidates/${f}`,
						});
					} catch {
						items.push({ name: slug, proposition: '', source_count: 0, status: 'candidate', decision_needed: true, unreadable: true, file: `dao/_candidates/${f}` });
					}
				}
				return json(res, 200, { candidates: items, count: items.length });
			}
			if (seg === 'axiom-action') {
				// 会话认证并不能证明调用方是人；面板点击依赖宿主的会话认证边界。
				// 无法认证时必须关闭写入口，不能只依赖外层路由白名单。
				if (!connection || typeof connection.requestRejection !== 'function') {
					return json(res, 501, { error: '宿主未提供 connection 服务，无法核验调用方——写路由已禁用' });
				}
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
				const body = transactionBody;
				const action = String(body?.action ?? '');
				const slug = safeSlug(body?.name);
				if (!slug) return json(res, 400, { error: 'name 必填' });
				if (!['confirm', 'reject', 'delete'].includes(action)) {
					return json(res, 400, { error: `action must be confirm|reject|delete (got ${action})` });
				}
				const candDir = path.join(root, 'dao', '_candidates');
				const candPath = path.join(candDir, `${slug}.md`);
				let text;
				try {
					text = await readFile(candPath, 'utf8');
				} catch {
					return json(res, 404, { error: `候选不存在：${slug}` });
				}
				const proposition = /^##\s*命题[ \t]*\r?\n+([\s\S]*?)(?=\r?\n##\s|$)/m.exec(text)?.[1]?.trim() ?? '';
				// 对其他操作不依赖内容形状；转正时再严格校验正文和来源节。
				const sourceSection = /^##\s*来源法[ \t]*\r?\n([\s\S]*?)(?=\r?\n##\s|(?![\s\S]))/m.exec(text)?.[1] ?? '';
				const sources = [...sourceSection.matchAll(/^- \[([^\]]+)\]\(\.\.\/insights\/([^/)]+)\.md\)\s*$/gm)]
					.filter((m) => m[1] === m[2]).map((m) => m[1]);

				if (action === 'delete') {
					// 删除 = 用户明确不要这条。与 reject 的区别：reject 留档案（反例证据），
					// delete 是「这条根本不该出现」（误写/重复）。
					await deleteTrackedFile(root, candPath, text, { tool: 'axiom-action:delete' });
					return json(res, 200, { message: `已删除候选 ${slug}` });
				}
				if (action === 'reject') {
					const reason = String(body?.reason ?? '').trim();
					if (!reason) return json(res, 400, { error: '否决必须写理由（否则同一命题会原样再提一遍）' });
					const r = rejectAxiomCandidate(
						{ name: slug, proposition, extracted_from: sources, status: AXIOM_CANDIDATE_STATES.candidate },
						{ reason },
					);
					if (!r.ok) return json(res, 400, { error: r.reason });
					// 否决：候选文件移到 _candidates/_rejected/，保留证据但不占待决策队列。
					const rejDir = path.join(candDir, '_rejected');
					await mkdir(rejDir, { recursive: true });
					// 先独占创建留档；任何写入失败或已有档案都保留候选原文。
					const rejectedPath = path.join(rejDir, `${slug}.md`);
					await writeTrackedPanelFile(root, rejectedPath, `${text}\n\n## 否决\n\n- 时间：${r.axiom.rejected_at}\n- 理由：${reason}\n`, { exclusive: true, tool: 'axiom-action:reject' });
					await deleteAfterPanelCopy(root, candPath, text, { tool: 'axiom-action:reject', to: `dao/_candidates/_rejected/${slug}.md` });
					return json(res, 200, { message: `已否决候选 ${slug}`, rejected_at: r.axiom.rejected_at });
				}
				// confirm：转正 → 写到 dao/ 正式位置（走与 memory_dao 相同的模板）
				const c = confirmAxiomCandidate(
					{ name: slug, proposition, extracted_from: sources, status: AXIOM_CANDIDATE_STATES.candidate },
					{ byUser: true, note: '面板确认' },
				);
				if (!c.ok) return json(res, 400, { error: c.reason });
				// 严格复核真实来源（不得把不存在、被取代或名称与链接不符的法计入）。
				const sourceLines = sourceSection.split(/\r?\n/).filter((line) => /^\s*-\s/.test(line));
				if (sourceLines.length !== sources.length) return json(res, 400, { error: '来源法链接无效或名称与链接不一致' });
				const validSources = [];
				for (const source of sources) {
					if (safeSlug(source) !== source) return json(res, 400, { error: '来源法名称无效' });
					const law = await readIfExists(path.join(root, 'insights', `${source}.md`));
					if (law === undefined || /^>\s*⚠️\s*已被取代/m.test(law)) return json(res, 400, { error: `来源法不存在或已被取代：${source}` });
					validSources.push(source);
				}
				const daoDir = path.join(root, 'dao');
				let existing = 0;
				for (const file of await readdir(daoDir)) {
					if (!file.endsWith('.md')) continue;
					const existingText = await readFile(path.join(daoDir, file), 'utf8');
					if (!/^>\s*⚠️\s*已被取代/m.test(existingText)) existing++;
				}
				const targetPath = path.join(daoDir, `${slug}.md`);
				if (await statExists(targetPath)) return json(res, 409, { error: '同名正式道已存在，不能覆盖' });
				const gate = gateDao({ name: slug, proposition, extractedFrom: validSources, existing });
				if (!gate.ok) return json(res, 400, { error: gate.reason });
				const propHeading = /^##\s*命题[ \t]*\r?\n/gm;
				const sourceHeading = /^##\s*来源法[ \t]*\r?\n/gm;
				const propMatches = [...text.matchAll(propHeading)];
				const sourceMatches = [...text.matchAll(sourceHeading)];
				if (propMatches.length !== 1 || sourceMatches.length !== 1) return json(res, 400, { error: '候选必须有唯一的命题和来源法章节' });
				const firstSection = /^##\s/m.exec(text.slice(propMatches[0].index + propMatches[0][0].length));
				if (!firstSection) return json(res, 400, { error: '候选缺少道体正文' });
				const bodyStart = propMatches[0].index + propMatches[0][0].length + firstSection.index;
				const bodyEnd = sourceMatches[0].index;
				if (bodyStart >= bodyEnd) return json(res, 400, { error: '候选正文和来源法顺序无效' });
				const candidateBody = text.slice(bodyStart, bodyEnd);
				if (daoReservedHeadingCollisions(candidateBody).length || !philosophicalShape(proposition).ok || checkDaoBody(candidateBody).findings.length) {
					return json(res, 400, { error: '候选命题或正文不符合正式道的形态要求' });
				}
				// 保留候选正文的全部章节和字节；来源与后续记录原样保留。
				const daoText = `# 道 · ${slug}\n\n> 由候选公理经用户确认转正（${c.axiom.confirmed_at}）。\n\n## 命题\n\n${proposition}\n\n${candidateBody}${text.slice(bodyEnd)}`;
				try {
					await writeTrackedPanelFile(root, targetPath, daoText, { exclusive: true, tool: 'axiom-action:confirm' });
				} catch (err) {
					if (err?.code === 'EEXIST') return json(res, 409, { error: '同名正式道已存在，不能覆盖' });
					throw err;
				}
				await deleteAfterPanelCopy(root, candPath, text, { tool: 'axiom-action:confirm', to: `dao/${slug}.md` });
				return json(res, 200, {
					message: `已确认候选 ${slug}，转为正式道`,
					file: `dao/${slug}.md`,
					note: '索引行仍需手工补进 MEMORY.md（memory_index 是唯一写索引的通道）',
				});
			}
			if (seg === 'dao-action') {
				// 正式道的删除（2026-11-10 用户要求：道里也要能删）。
				//
				// 为什么不复用 axiom-action：**删的东西不一样**。候选删了只是丢掉
				// 一个提案；正式道删了是丢掉一条已经在参与判断的命题，而且它可能
				// 已被召回引用。所以额外做两件事：
				// ①备份到 dao/_deleted/（不是彻底消失，留可回查的一份）；
				// ②如实提醒索引行要手工删（memory_index 是唯一写索引的通道）。
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
				const body = transactionBody;
				const slug = safeSlug(body?.name);
				if (!slug) return json(res, 400, { error: 'name 必填' });
				const daoPath = path.join(root, 'dao', `${slug}.md`);
				let text;
				try {
					text = await readFile(daoPath, 'utf8');
				} catch {
					return json(res, 404, { error: `道条目不存在：${slug}` });
				}
				const delDir = path.join(root, 'dao', '_deleted');
				// 归档失败必须中止，确保原文仍在；删除失败也不能报告成功。
				await mkdir(delDir, { recursive: true });
				try {
					await writeTrackedPanelFile(root, path.join(delDir, `${slug}.md`), `${text.trimEnd()}\n\n## 删除\n\n- 时间：${new Date().toISOString()}\n- 来源：面板手动删除\n`, { exclusive: true, tool: 'dao-action:delete' });
				} catch (err) {
					if (err?.code === 'EEXIST') {
						const existing = await stat(path.join(delDir, `${slug}.md`));
						if (existing.isFile()) return json(res, 409, { error: `已有同名历史归档：${slug}；为保护历史，本次未删除正式道` });
					}
					throw err;
				}
				await deleteAfterPanelCopy(root, daoPath, text, { tool: 'dao-action:delete', to: `dao/_deleted/${slug}.md` });
				return json(res, 200, {
					message: `已删除道 · ${slug}（已留档到 dao/_deleted/）`,
					archived: `dao/_deleted/${slug}.md`,
					note: 'MEMORY.md 里指向这条的道层行需要手工删除——索引由 memory_index 维护，面板不改索引。',
				});
			}
			if (seg === 'skill-action') {
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
				const body = transactionBody;
				const action = String(body?.action ?? '');
				if (!['activate', 'retire', 'delete'].includes(action)) return json(res, 400, { error: `action must be activate|retire|delete (got ${action})` });
				// Same hook the registered tool carries (3217's onSkillChange): the
				// panel writes through a fresh tool instance, and without the hook
				// the host's cached skill catalog would keep advertising a bundle
				// this very request just retired or deleted.
				const skill = memorySkillTool(opts, opts.bridge ? { onSkillChange: () => opts.bridge.invalidate() } : {});
				try {
					const out = await skill.execute({ action, name: String(body?.name ?? ''), note: '面板操作' }, {});
					return json(res, 200, { message: `${action} ok`, status: out.status, file: out.file, warnings: out.warnings ?? [] });
				} catch (err) {
					return json(res, 400, { error: String(err?.message ?? err) });
				}
			}
			if (seg === 'skills') {
				// ONE storage location (5.24.0): every skill is a host bundle under
				// the user skills roots. The two tabs are a VIEW of that one store,
				// split by provenance — `agent_created: true` means this plugin
				// crystallized it (结晶技能), anything else is an installed/system
				// skill (系统技能). No memory-root copy, no pointer file: the panel
				// shows the bundle itself, which is also the body the host loads.
				const hostDshHome = dshHome();
				const agentsHome = process.env.DSH_AGENTS_HOME || path.join(homedir(), '.agents');
				// A test-injected skillRoot replaces the whole scan (tests must never
				// list or touch the real user catalog).
				// .history/ (5.27.0) is our own append-only archive — its rows are
				// not bundles (no SKILL.md at the expected leaf) and never list.
				const hostRoots = opts.skillRoot
					? [{ dir: path.resolve(opts.skillRoot), source: 'user-dsh' }]
					: [
							{ dir: path.join(hostDshHome, 'skills'), source: 'user-dsh' },
							{ dir: path.join(agentsHome, 'skills'), source: 'user-agents' },
						];
				const memory = [];
				const host = [];
				const seenDirs = new Set();
				for (const r of hostRoots) {
					let entries = [];
					try {
						entries = await readdir(r.dir, { withFileTypes: true });
					} catch {
						continue; // root absent
					}
					for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
						if (!e.isDirectory()) continue;
						const dir2 = path.join(r.dir, e.name);
						const key = path.resolve(dir2);
						if (seenDirs.has(key)) continue;
						seenDirs.add(key);
						const text = await readIfExists(path.join(dir2, 'SKILL.md'));
						if (text === undefined) continue;
						const { fields } = parseSkillText(text);
						// Walk the bundle so the panel can show every stored file.
						const files = [];
						const walk = async (rel) => {
							const abs = path.join(dir2, rel);
							for (const de of await readdir(abs, { withFileTypes: true })) {
								// Runtime artifacts are not skill assets: __pycache__
								// appears the moment anything runs the scripts.
								if (de.name === '__pycache__' || de.name === 'node_modules') continue;
								const rel2 = rel ? `${rel}/${de.name}` : de.name;
								if (de.isDirectory()) await walk(rel2);
								else files.push({ rel: rel2, name: de.name, bytes: (await stat(path.join(dir2, rel2))).size });
							}
						};
						await walk('');
						// OWNERSHIP is a frontmatter fact, never a body scan:
						// skill-creator's own text contains the literal string
						// `agent_created: true` (it documents the field), so a
						// whole-text regex would claim every installed skill.
						const owned = /^(?:true|1)$/i.test(String(fields.agent_created ?? ''));
						const row = {
							name: fields.name || e.name,
							description: fields.description || '',
							source: r.source,
							kind: owned ? 'memory' : 'host',
							dir: dir2,
							files,
							...(owned ? { status: fields.status ?? 'candidate', scope: fields.scope || '', scopeProject: fields.scope_project || '' } : {}),
						};
						(owned ? memory : host).push(row);
					}
				}
				memory.sort((a, b) => a.name.localeCompare(b.name));
				host.sort((a, b) => a.name.localeCompare(b.name));
				return json(res, 200, { memory, host });
			}
			// One stored skill's bundle: the SERVER resolves it from the known roots;
			// the request only names the skill directory. No paths travel in.
			if (seg === 'skill') {
				const nameParam = (url.searchParams.get('name') ?? '').trim();
				if (!nameParam || /[\\/]|\.\./.test(nameParam)) return json(res, 400, { error: 'invalid skill name' });
				// The file list travels WITH the body: the panel's detail view needs
				// it, and re-deriving it client-side would mean the client knowing
				// the host roots (it does not — the server resolves them).
				const filesOf = async (dir2) => {
					const files = [];
					const walk = async (rel) => {
						for (const de of await readdir(path.join(dir2, rel), { withFileTypes: true })) {
							// __pycache__/node_modules are runtime artifacts, not skill
							// content — the panel reader must not see them as assets.
							if (de.name === '__pycache__' || de.name === 'node_modules') continue;
							const rel2 = rel ? `${rel}/${de.name}` : de.name;
							if (de.isDirectory()) await walk(rel2);
							else files.push({ rel: rel2, name: de.name, bytes: (await stat(path.join(dir2, rel2))).size });
						}
					};
					await walk('');
					return files;
				};
				// One bundle, one location (5.24.0): no memory-root branch any more.
				// The bundle dir name IS the skill name (kebab), so the request names
				// a directory under a known root and the server resolves the rest.
				const dir2 = path.join(opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills'), nameParam);
				const text = await readIfExists(path.join(dir2, 'SKILL.md'));
				if (text === undefined) return json(res, 404, { error: 'skill not found' });
				let files = [];
				try {
					files = await filesOf(dir2);
				} catch {
					/* bundle dir vanished mid-read — body still answers */
				}
				const { fields } = parseSkillText(text);
				const owned = /^(?:true|1)$/i.test(String(fields.agent_created ?? ''));
				return json(res, 200, {
					name: nameParam,
					kind: owned ? 'memory' : 'host',
					text,
					files,
					...(owned ? { status: fields.status ?? 'candidate', scope: fields.scope || '' } : {}),
				});
			}
			// One stored file inside a host skill bundle (scripts/references/...):
			// the request names skill + relative file; the server re-resolves the
			// bundle root so no client path ever reaches the filesystem.
			if (seg === 'skillfile') {
				const nameParam = (url.searchParams.get('name') ?? '').trim();
				const rel = (url.searchParams.get('file') ?? '').trim();
				if (!nameParam || /[\\/]|\.\./.test(nameParam)) return json(res, 400, { error: 'invalid skill name' });
				if (!rel || rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\') || /[\\]/.test(rel)) return json(res, 400, { error: 'invalid file path' });
				const text = await readIfExists(path.join(opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills'), nameParam, rel));
				if (text === undefined) return json(res, 404, { error: 'file not found' });
				return json(res, 200, { name: nameParam, file: rel, text });
			}
			if (seg === 'list') {
				const zone = url.searchParams.get('zone');
				if (!SEARCH_ZONES.includes(zone)) return json(res, 400, { error: 'invalid zone' });				// 5.24.0: skills are host bundles, not memory-root files. The panel
				// skill zone IS the library endpoint (/skills); /list?zone=skills
				// keeps answering with bundle SKILL.md rows so an older caller
				// reading the list zone still gets real rows.
				if (zone === 'skills') {
					const sdir = opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills');
					const rows = [];
					let ents = [];
					try {
						ents = await readdir(sdir, { withFileTypes: true });
					} catch {
						/* no bundles yet */
					}
					for (const e of ents.filter((x) => x.isDirectory())) {
						try {
							const st = await stat(path.join(sdir, e.name, 'SKILL.md'));
							rows.push({ name: `${e.name}/SKILL.md`, bytes: st.size, mtime: st.mtime.toISOString() });
						} catch {
							/* not a bundle */
						}
					}
					rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
					return json(res, 200, { files: rows });
				}
				const dir = zone === 'daily' ? root : path.join(root, zone);
				let names = [];
				try {
					names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
				} catch {
					/* zone absent */
				}
				// Daily zone lists ONLY decision threads (YYYY-MM-DD.md). The index
				// (MEMORY.md) has its own zone and must never appear under 每日,
				// and neither may stray non-dated files at the root. Newest first.
				// 月/周折叠方案（2026-11）：月归档（YYYY-MM.md）不再混进 files，
				// 单独作为 archive 数组返回 —— 前端按周子折叠展示，旧的直线列表
				// 消费者拿到的 files 形状不变（两布局兼容）。
				let archive = [];
				const archiveDir = path.join(root, 'daily');
				if (zone === 'daily') {
					const dated = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
					names = dated;
					try {
						archive = (await readdir(archiveDir)).filter((n) => /^\d{4}-\d{2}\.md$/.test(n));
					} catch {
						/* daily/ absent: no archives yet */
					}
				}
				names.sort(zone === 'daily' ? (a, b) => b.localeCompare(a) : undefined);
				const toRow = async (dir2, n) => {
					const st = await stat(path.join(dir2, n));
					return { name: n, bytes: st.size, mtime: st.mtime.toISOString() };
				};
				const files = [];
				for (const n of names) files.push(await toRow(dir, n));
				const archiveRows = [];
				if (zone === 'daily') {
					for (const n of archive.sort((a, b) => b.localeCompare(a))) archiveRows.push(await toRow(archiveDir, n));
				}
				// Newest-first for every zone (the panel and any other consumer
				// display the top row first). Names were pre-sorted per zone, so
				// this single mtime pass makes the order uniform.
				files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				archiveRows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				return json(res, 200, zone === 'daily' ? { files, archive: archiveRows } : { files });
			}
			if (seg === 'check') {
				return json(res, 200, panelizeHealth(await runHealthCheck(root, opts)));
			}
			if (seg === 'search') {
				const q = (url.searchParams.get('q') ?? '').trim();
				if (q.length < 2) return json(res, 200, { hits: [] });
				// Same ranker as the memory_search tool: the panel used to scan in
				// file order, so a hit in the first file always outranked a better
				// one further down.
				const zoneParam = url.searchParams.get('zone');
				const zone = SEARCH_ZONES.includes(zoneParam) ? zoneParam : 'all';
				const hits = await searchMemory(root, q, { zone, limit: 60, skillRoot: opts.skillRoot });
				return json(res, 200, { hits });
			}
			// —— 问题收件箱（2026-10-26）——
			//
			// 让用户在前端自己掌控全局：各插件/agent 投递的问题、当前处置状态、
			// 以及"修了没"的进度都在这一个页面里。
			if (seg === 'inbox') {
				const statusFilter = url.searchParams.get('status');
				const fromFilter = url.searchParams.get('from');
				const all = await inbox.list();
				const filtered = await inbox.list({
					...(statusFilter !== null ? { status: statusFilter } : {}),
					...(fromFilter !== null ? { from: fromFilter } : {}),
				});
				const counts = { open: 0, acknowledged: 0, resolved: 0 };
				for (const item of all) {
					if (counts[item.status] !== undefined) counts[item.status] += 1;
				}
				return json(res, 200, {
					path: inbox.filePath(),
					counts,
					total: filtered.length,
					items: filtered,
				});
			}
			// 收件箱的写通道：改处置状态 / 删除。与 skill-action 一样属写路由，
			// 无 connection 服务时 501（见上方 PANEL_WRITE_SEGS 守卫）。
			if (seg === 'inbox-action') {
				if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
				const body = await readBody(req);
				const fingerprint = String(body?.fingerprint ?? '');

				// op 区分两种写：默认 update（改状态），delete 是彻底删除。
				// 用显式 op 而不是"status 为空就删"，避免误传造成不可逆删除。
				if (body?.op === 'delete') {
					const removed = await inbox.remove(fingerprint);
					if (removed === undefined) {
						return json(res, 404, { error: `没有 fingerprint 为 ${fingerprint} 的条目` });
					}
					return json(res, 200, { deleted: true, item: removed });
				}

				const status = String(body?.status ?? '');
				if (!['open', 'acknowledged', 'resolved'].includes(status)) {
					return json(res, 400, { error: 'status 必须是 open / acknowledged / resolved' });
				}
				const updated = await inbox.update(
					fingerprint,
					status,
					body?.note === undefined ? undefined : String(body.note),
				);
				if (updated === undefined) {
					return json(res, 404, { error: `没有 fingerprint 为 ${fingerprint} 的条目` });
				}
				return json(res, 200, { item: updated });
			}
			htmlPage(
				res,
				200,
				'memory-manager',
				'<p>该插件的可视面板在 Harness Web UI 的侧栏（记忆图标）。此只读 API 供面板取数；记忆根由服务端解析，请求不能指定路径：</p>' +
					'<ul><li><code>GET /api/memory-org/overview</code> — 全局记忆体检 + 各分区计数</li>' +
					'<li><code>GET /api/memory-org/check</code> — 体检</li>' +
					'<li><code>GET /api/memory-org/list?zone=functions|insights|daily</code> — 分区文件列表（daily 额外返回 archive 月归档数组）</li>' +
					'<li><code>GET /api/memory-org/file?zone=functions&amp;name=&lt;file&gt;.md</code> — 读记忆文件（省略 zone 即索引；zone=daily 放行日线程与 daily/ 下的月归档）</li>' +
					'<li><code>GET /api/memory-org/daily-days?name=YYYY-MM.md</code> — 月归档的日线索（只解析 ### [YYYY-MM-DD] 标题行，不读全文）</li>' +
					'<li><code>GET /api/memory-org/skills</code> — 技能库（宿主目录包单一存储；agent_created 分「结晶/系统」两栏，各带文件树）</li>' +
					'<li><code>GET /api/memory-org/skill?name=&lt;bundle&gt;</code> — 技能包正文 + 文件清单（服务端解析根，请求只给名字）</li>' +
					'<li><code>GET /api/memory-org/skillfile?name=&lt;bundle&gt;&amp;file=&lt;rel&gt;</code> — 包内资源文件原文（scripts/references；相对路径禁穿越）</li>' +
					'<li><code>POST /api/memory-org/skill-action</code> — 面板写通道（activate/retire/delete，跑 memory_skill 真执行器）</li>' +
					'<li><code>POST /api/memory-org/reload</code> — 热重启：server 半重新加载磁盘代码，不重启宿主进程（宿主无 loader/registry 时 501）</li>' +
					'<li><code>GET /api/memory-org/search?q=&lt;关键词&gt;</code> — 全库搜索</li></ul>',
			);
		} catch (err) {
			json(res, 500, panelError(err));
		}
		};
		try {
			if (transactionalPost) return await withMemoryRootTransaction(root, handle);
			return await handle();
		} catch (err) {
			return json(res, 500, panelError(err));
		}
	};
}

/** 当前 apply() 实例的召回账本汇总 getter（模块级，供零参数探针读取）。 */
let liveRecallSummary = () => ({ rounds: 0 });

export function apply(ctx, config) {
	// The Host install may be pointed at explicitly; otherwise it is discovered
	// (env / CLI entry / cwd / profile). Loading eagerly fails fast with an
	// actionable message instead of breaking the first tool call.
	setHostRoot(typeof config?.dshRoot === 'string' && config.dshRoot.trim() ? config.dshRoot.trim() : undefined);
	loadHost();

	const opts = {
		// 阀门桥要经 ctx.get('valves') 运行时探测（可选依赖，不进 inject——
		// 声明了就变成硬依赖，没装 valves 的宿主上 memory 永不装载）。
		ctx,
		memoryRoot: typeof config?.memoryRoot === 'string' && config.memoryRoot.trim() ? config.memoryRoot.trim() : undefined,
		// Where skill bundles live. Defaults to <dshHome>/skills (the host's own
		// user skill root); tests override it so they never touch the real catalog.
		skillRoot: typeof config?.skillRoot === 'string' && config.skillRoot.trim() ? config.skillRoot.trim() : undefined,
		maxIndexBytes: Number.isFinite(config?.maxIndexBytes) ? config.maxIndexBytes : DEFAULTS.maxIndexBytes,
		maxIndexHardBytes: Number.isFinite(config?.maxIndexHardBytes) ? config.maxIndexHardBytes : DEFAULTS.maxIndexHardBytes,
		maxFunctionBytes: Number.isFinite(config?.maxFunctionBytes) ? config.maxFunctionBytes : DEFAULTS.maxFunctionBytes,
		newFeatureGraceDays: Number.isFinite(config?.newFeatureGraceDays) ? config.newFeatureGraceDays : DEFAULTS.newFeatureGraceDays,
		// R23's retirement budget for insights/ (count / single-source share /
		// ledger misses). Configurable so tests can lower the caps instead of
		// generating 25 fixture files.
		insightBudget:
			config?.insightBudget && typeof config.insightBudget === 'object'
				? {
						maxInsights: Number.isFinite(config.insightBudget.maxInsights) ? config.insightBudget.maxInsights : INSIGHT_BUDGET.maxInsights,
						maxSingleSourceShare: Number.isFinite(config.insightBudget.maxSingleSourceShare)
							? config.insightBudget.maxSingleSourceShare
							: INSIGHT_BUDGET.maxSingleSourceShare,
						minLedgerMisses: Number.isFinite(config.insightBudget.minLedgerMisses) ? config.insightBudget.minLedgerMisses : INSIGHT_BUDGET.minLedgerMisses,
					}
				: INSIGHT_BUDGET,
		// Foreground recall budget (ms). Config may SHORTEN it but never extend
		// past the default — recall must stay bounded no matter the config.
		recallTimeoutMs: resolveRecallBudget(config?.recallTimeoutMs),
		// This limits only the optional rendered recall text, not negative rules.
		recallOptionalBudgetBytes: Number.isFinite(config?.recallOptionalBudgetBytes) && config.recallOptionalBudgetBytes >= 0
			? Math.min(65536, Math.floor(config.recallOptionalBudgetBytes)) : 8192,
		// Passive capture into the raw daily layer (off unless opted in).
		captureUserTurns: config?.captureUserTurns === true,
		// Daily month archive (2026-11-13, user-enabled): 0 disables. Config may
		// delay or slow it; it never extends past one day (protects the current
		// month from being archived away by a stale clock).
		dailyArchiveFirstDelayMs: Number.isFinite(config?.dailyArchiveFirstDelayMs) && config.dailyArchiveFirstDelayMs >= 0
			? Math.min(config.dailyArchiveFirstDelayMs, 86_400_000) : DEFAULTS.dailyArchiveFirstDelayMs,
		dailyArchiveIntervalMs: Number.isFinite(config?.dailyArchiveIntervalMs) && config.dailyArchiveIntervalMs >= 0
			? Math.min(config.dailyArchiveIntervalMs, 86_400_000) : DEFAULTS.dailyArchiveIntervalMs,
		// Opt-in three-tier federation: { root, projects: [{ key, root }] }.
		federation: config?.federation && typeof config.federation === 'object' ? config.federation : undefined,
		// Hot reload (5.25.0): the panel's /reload endpoint calls this. selfReload
		// snapshots the fibers, purges this package from the module caches,
		// re-imports server.js through the host loader and re-registers it — the
		// same sequence the kernel HMR service uses for partialReload, from a
		// plugin that by design survives a swap (disk-only state).
		// The capability is probed EXACTLY the way selfReload probes it: on a host
		// without loader/registry, reload is undefined and the route answers 501
		// up front instead of accepting a swap that can never complete.
		canReload: ctx.loader !== undefined && ctx.registry !== undefined,
		version: (() => {
			try {
				return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '';
			} catch {
				return '';
			}
		})(),
		reload: () => selfReload(ctx, { logger: ctx.logger ?? console }),
	};

	// Instance-local observations only; no event, inbox post or durable data.
	const captureStatus = createCaptureStatus({ enabled: opts.captureUserTurns });
	opts.captureStatus = () => captureStatus.snapshot();

	// —— 每日按月归档定时器（2026-11-13 用户启用）——
	//
	// 启动 60s 后首跑、每 6h 一次（0 关闭）。归档只处理**非当月**的顶层日文件，
	// 当月文件永不触碰；写入走 writeText 记账、删除走 delete_intent/delete 配对，
	// 失败保留源文件。withMemoryRootTransaction 与其他写入共享同进程根队列；
	// 失败只记本实例状态，不投递收件箱（体检 R10/R21/R26 会对归档结果对账）。
	// disposers 数组在下方才初始化，定时器清理器先暂存、注册时再并入。
	const archiveDisposers = [];
	if (opts.dailyArchiveFirstDelayMs > 0 && opts.dailyArchiveIntervalMs > 0) {
		let archiveBusy = false;
		const runArchive = () => {
			if (archiveBusy) return;
			archiveBusy = true;
			void withMemoryRootTransaction(resolveRoot(opts), () => archiveDailyMonths(resolveRoot(opts)))
				.catch(() => {})
				.finally(() => { archiveBusy = false; });
		};
		const archiveTimer = setTimeout(runArchive, opts.dailyArchiveFirstDelayMs);
		archiveTimer.unref?.();
		const archiveInterval = setInterval(runArchive, opts.dailyArchiveIntervalMs);
		archiveInterval.unref?.();
		archiveDisposers.push(() => { clearTimeout(archiveTimer); clearInterval(archiveInterval); });
	}

	// 收件箱先建：memory_check 的自动投递要用它（发现→跟踪零配合）。
	const inbox = new MemoryInbox(dshHome);

	// One cooperative queue covers the entire read/modify/write operation, not
	// just its final rename. It is shared across plugin reloads in this process.
	// External processes and uncooperative writers remain outside this boundary.
	const transactionTool = (tool) => ({
		...tool,
		execute: (args, exec) => withMemoryRootTransaction(resolveRoot(opts), () => tool.execute(args, exec)),
	});
	const disposers = [
		ctx.tools.register(transactionTool(memoryReadTool(opts))),
		ctx.tools.register(memorySearchTool(opts)),
		ctx.tools.register(transactionTool(memoryCapabilityTool(opts))),
		ctx.tools.register(transactionTool(memoryWriteTool(opts))),
		ctx.tools.register(transactionTool(memoryIndexTool(opts))),
		ctx.tools.register(transactionTool(memoryInsightTool(opts))),
		ctx.tools.register(transactionTool(memoryDaoTool(opts))),
		ctx.tools.register(transactionTool(memoryFoldTool(opts))),
		ctx.tools.register(transactionTool(memoryRenameTool(opts))),
		ctx.tools.register(memoryCheckTool(opts, inbox)),
		ctx.tools.register(transactionTool(memoryUsageTool(opts))),
		ctx.tools.register(memoryFederationTool(opts)),
	];

	// —— 问题收件箱（2026-10-26）——
	//
	// 为什么让记忆管理收：它本来就是"全局长期记忆"的持有者，问题清单也是
	// 需要长期跟踪的状态。放在这里不必新建一套存储与面板。
	//
	// 四类投递来源：
	// 1. 其他插件通过 Cordis 事件 `clis/health-finding` 自动投递（本文件订阅）；
	// 2. agent 用 memory_inbox 工具主动报告；
	// 3. 用户直接要求在记忆里留一条待跟踪问题；
	// 4. memory_check 每次体检自动投递 WARN/FAIL（2026-11-09：发现与跟踪
	//    间接轨——"报出来"不再等于"尽到责任"，复发 times 可见递增）。
	disposers.push(
		ctx.tools.register(memoryInboxTool(opts, inbox)),
	);
	disposers.push(...archiveDisposers);

	// 订阅其他插件的健康通报 —— 这是"问题投递"的自动通道。
	// 用 ctx.on 注册，随插件卸载自动取消（Cordis 保证）。
	if (typeof ctx.on === 'function') {
		disposers.push(
			ctx.on('clis/health-finding', (notice) => {
				if (notice === null || typeof notice !== 'object') return;
				// 异步落盘失败不影响事件派发方
				void inbox
					.post({
						from: typeof notice.from === 'string' ? notice.from : 'unknown-plugin',
						code: typeof notice.code === 'string' ? notice.code : 'unknown',
						severity: notice.severity,
						message: typeof notice.message === 'string' ? notice.message : '',
						...(typeof notice.location === 'string' ? { location: notice.location } : {}),
						...(typeof notice.hint === 'string' ? { hint: notice.hint } : {}),
					})
					.catch(() => {});
			}),
		);
	}

	// —— 层级写入守卫（2026-11-10 用户要求：把机制卡死）——
	//
	// R26 只检查文件与账本的当前一致性；既不能证明来源或作者，也不能阻止写入。
	// 用户要的是"绝对不可以直接动用编辑工具书写"，所以必须有一个**前向拦截**。
	// fs/*-intent 是 first-wins 单槽，已有监听器会让后续守卫不执行。
	// tools/execute 是包裹式流水线，检查后调用 next 才进入工具本体。
	// 仅覆盖调度的 write/edit，不拦 shell 或其他写入方式。
	if (typeof ctx.on === 'function') {
		const guard = createWriteGuard(() => resolveRoot(opts), ctx, () => opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills'));
		disposers.push(ctx.on('tools/execute', guard));
	}

	// —— 健康探针（2026-10-26）——
	//
	// 按 **DSH 插件封装标准**的自愿接口导出（见本包 README 与
	// D:/个人开发/CLIS/docs/PLUGIN-STANDARD.md）：模块根具名导出
	// `healthProbe`，与 `inject` / `Config` 同族。
	//
	// 监督者（CLIS）自动发现它，**不需要 emit、不需要注册**。
	// 早先版本用 `ctx.emit('clis/register-probe')` 广播，还因捆绑顺序
	// 需要延时重播 —— 导出形态把这些时序问题一并去掉。
	//
	// 探针用默认配置（DEFAULTS）：监督者不知道本插件的 config，
	// 而检查项（索引体积/迭代块/链接）用默认阈值判断即可。
	const probe = createHealthProbe({ runHealthCheck, resolveRoot, opts, recallLedger: () => liveRecallSummary() });
	if (typeof ctx.set === 'function') {
		try {
			ctx.set('memory.healthProbe', probe);
		} catch {
			// 宿主不支持自定义服务键时跳过：探针不注册不影响插件主体功能
		}
	}
	// 注：不再用 ctx.emit('clis/register-probe') 广播。模块根导出 healthProbe
	// 已足够被发现，且免去了"本插件排在 CLIS 之前 → 广播丢失 → 需延时重播"
	// 那套时序补丁。

	// Host skill bridge (5.17.0): publish active+hostName skills into ctx.skills
	// so the host `skill` tool can load them. OPTIONAL — a host without the
	// skill registry (ctx.get returns nothing usable) skips the bridge entirely
	// and our own pre-step recall keeps serving all skills. inject deliberately
	// does NOT list 'skills': waiting on it would break hosts that never mount
	// dsh-skill, and the bridge needs no startup guarantee (it reads disk on
	// every list()).
	// The bridge publishes from the SAME store the host scans (5.24.0): the
	// bundles under <dshHome>/skills. It is now a thin adapter over that store
	// (status→published), not a second location.
	const skillBridge = registerMemorySkillBridge(ctx, {
		skillsDir: opts.skillRoot ? path.resolve(opts.skillRoot) : path.join(dshHome(), 'skills'),
	});
	// The panel's skill library reads the SAME registry the host tool resolves
	// against (bridge.registry); on a host without the skill service it stays
	// undefined and /skills answers hostDegraded rather than erroring.
	opts.bridge = skillBridge;
	disposers.push(ctx.tools.register(transactionTool(memorySkillTool(opts, skillBridge ? { onSkillChange: skillBridge.invalidate } : {}))));

	// Proactive recall: on every proposed step, match the batch's user text
	// against the memory index and prepend one recall message when the overlap
	// clears the threshold. Waterfall listener returning next() unchanged when
	// nothing matches or the batch was already served a recall (per-agent
	// signature dedupe). Registration is global; dispatch is agent-scoped.
	const recallServed = new Map(); // agentId -> signature of last served batch
	// 召回双侧账本（2026-11-09）：有界环形缓冲，记录最近 N 轮召回的
	// 注入/暂缓/丢弃/预算用量。探针只读汇总，不落盘（曝光数据不是记忆）。
	const RECALL_LEDGER_CAP = 50;
	const recallLedger = [];
	const recordRecall = (stats) => {
		if (!stats) return;
		recallLedger.push({ injected: stats.actualRows, strong: stats.injected, held: stats.held, dropped: stats.dropped, archives: stats.archives, rules: stats.rules, budget: stats.budget, used: stats.usedTokens,
			omittedRows: stats.budgetOmitted.rows, omittedRepairs: stats.budgetOmitted.repairs, omittedHeld: stats.budgetOmitted.held, omittedArchives: stats.budgetOmitted.archives,
			optionalBytes: stats.optionalBytes, renderFailures: stats.renderFailed ? 1 : 0 });
		if (recallLedger.length > RECALL_LEDGER_CAP) recallLedger.shift();
	};
	const recallLedgerSummary = () => {
		if (!recallLedger.length) return { rounds: 0 };
		const sum = (k) => recallLedger.reduce((n, e) => n + e[k], 0);
		return {
			rounds: recallLedger.length,
			injected: sum('injected'), strong: sum('strong'), held: sum('held'), dropped: sum('dropped'), archives: sum('archives'), rules: sum('rules'),
			omittedRows: sum('omittedRows'), omittedRepairs: sum('omittedRepairs'), omittedHeld: sum('omittedHeld'), omittedArchives: sum('omittedArchives'),
			peakOptionalBytes: Math.max(...recallLedger.map((e) => e.optionalBytes)), renderFailures: sum('renderFailures'),
			budget: recallLedger[0].budget,
			peakUsed: Math.max(...recallLedger.map((e) => e.used)),
		};
	};
	liveRecallSummary = recallLedgerSummary; // 零参数探针读同一个汇总
	// The recall reads MEMORY.md with a 10s cache and .usage.jsonl with 60s.
	// TTL alone meant a memory_index row stayed UNRECALLABLE for up to 10s after
	// its own tool call wrote it (audit #10: the discipline says "write then
	// recall"; the cache window broke it). The tools now declare the caches via
	// opts.dropRecallCaches — a write to either file voids the matching cache,
	// so freshness follows writes instead of the clock.
	const indexCache = { text: undefined, at: 0 };
	const usageCache = { map: undefined, recent: undefined, at: 0 };
	opts.dropRecallCaches = () => {
		indexCache.at = 0;
		indexCache.text = undefined;
		usageCache.at = 0;
		usageCache.map = undefined;
		usageCache.recent = undefined;
	};
	const readUsageCached = async () => {
		const now = Date.now();
		if (usageCache.map === undefined || now - usageCache.at > 60_000) {
			// Fusion input: which rows are actually USED (recall/read) and how they
			// were judged (positives / correction rate). Cheap: one dot-file read
			// per minute, and a failure just means "rank lexically only".
			try {
				const entries = await readUsage(resolveRoot(opts));
				const items = summarizeUsage(entries);
				usageCache.map = new Map(items.map((it) => [it.href, it]));
				usageCache.recent = summarizeUsage(entries.filter((entry) => entry.ms >= now - 7 * 24 * 60 * 60 * 1000));
			} catch {
				usageCache.map = new Map();
				usageCache.recent = [];
			}
			usageCache.at = now;
		}
		return usageCache.map;
	};
	const readIndexCached = async () => {
		const now = Date.now();
		if (indexCache.text === undefined || now - indexCache.at > 10_000) {
			indexCache.text = (await readIfExists(path.join(resolveRoot(opts), 'MEMORY.md'))) ?? '';
			indexCache.at = now;
		}
		return indexCache.text;
	};
	disposers.push(
		ctx.on('agent/pre-step', async (payload, next) => {
			const batch = Array.isArray(payload.messages) ? payload.messages : [];
			// Build the recall candidate first; a recall failure must never break a
			// step, so ONLY this block is guarded. `next()` runs exactly once,
			// outside the guard, so a downstream error propagates (instead of the
			// waterfall being re-entered by a catch that calls next() again).
			let recall = null;
			try {
				const userText = batch
					.flatMap((m) => (m?.role === 'user' ? m.content : []))
					.filter((b) => b?.type === 'text')
					.map((b) => b.text)
					.join('\n');
				const signature = `${payload.turn ?? ''}:${createHash('sha256').update(userText).digest('hex')}`;
				// MemOS borrow ⑤: every non-empty user turn gets a recall attempt,
				// but the whole attempt is bounded by an absolute budget. On timeout
				// we inject NOTHING (rather than a slow or half-built recall), so the
				// step proceeds normally — the failure mode is silence, not latency.
				const budgetMs = Math.min(Number(opts.recallTimeoutMs) || DEFAULTS.recallTimeoutMs, DEFAULTS.recallTimeoutMs);
				const deadline = performance.now() + budgetMs;
				const buildRecall = async () => {
					if (!userText.trim()) return null;
					if (recallServed.get(payload.agent.id) === signature) return null;
					const indexText = await readIndexCached();
					// A missing index must not suppress separately configured negative rules.
					// RRF fusion: lexical IDF rank + usage-heat rank (see
					// matchIndexRows). Signals already exist in .usage.jsonl;
					// without this they were collected but never used to rank.
					const usage = await readUsageCached();
					const qTokens = tokensOf(userText);
					// 档案块：共识/道条目整份带入（独立通道，不与索引行 IDF 争名额）。
					const archives = archiveBlocks(indexText, qTokens);
					const matchedRows = matchIndexRows(indexText, qTokens, 3, usage, { memoryRoot: resolveRoot(opts) });
					// 三档 + 双侧账本挂在返回数组上，filter 会丢掉自定义属性，先取下来。
					const recallStats = matchedRows.stats ?? null;
					const recallHeld = matchedRows.heldRows ?? [];
					const base = matchedRows
						// Pointer dedupe: when the user's own text already cites a memory
						// file (they quoted an earlier recall or wrote the link), re-
						// injecting the same row just echoes what is already on screen.
						.filter((l) => !userText.includes(l.href));
					const rows = [...base];
					// Decision-repair (④): an area corrected repeatedly is where a
					// mistake is about to be repeated — force it into the NEXT step's
					// context even when the current wording doesn't match it. The
					// current step is never interrupted or modified.
					if (usage && usage.size) {
						const repairs = decisionRepairTargets(usageCache.recent ?? []).filter(
							(r) => !rows.some((l) => l.href === r.href) && !userText.includes(r.href),
						);
						if (repairs.length) {
							const indexRows = indexRowsOf(indexText, { memoryRoot: resolveRoot(opts) });
							for (const r of repairs) {
								const row = indexRows.find((x) => x.href === r.href);
								if (!row) continue;
								rows.push({ ...row, repair: { corrections: r.corrections, badRate: r.badRate } });
							}
						}
					}
					// 负向规则注入（2026-11-09，阀门下行通道的零配合落点）：
					// 已人工确认的禁令若关键词命中本轮输入，即使记忆索引一行都
					// 没匹配上也要注入——"什么不能做"必须在动手前到达上下文。
					// 桥失败/服务不在 → undefined → 行为与旧版完全一致。
					let negativeLines = [];
					try {
						const hits = await relevantNegativeRules(opts.ctx, userText);
						if (Array.isArray(hits)) negativeLines = hits;
					} catch {
						negativeLines = [];
					}
					if (!rows.length && !negativeLines.length && !archives.length) return null;
					let selectedRows = [], selectedArchives = [];
					let budgetOmitted = { rows: 0, repairs: 0, held: 0, archives: 0 }, optionalBytes = 0, renderFailed = false;
					let message = { role: 'user', content: [{ type: 'text', text: '' }], source: { kind: 'memory-manager/recall', form: 'recall' } };
					if (rows.length || archives.length) {
						try {
							const rendered = buildBudgetedRecall(rows, recallHeld, recallStats, archives, { maxOptionalBytes: opts.recallOptionalBudgetBytes });
							message = rendered.message;
							selectedRows = rendered.rows;
							selectedArchives = rendered.archives;
							budgetOmitted = rendered.omitted;
							optionalBytes = rendered.optionalBytes;
						} catch {
							// Optional formatting must not discard rules that were already read.
							renderFailed = true;
						}
					}
					if (negativeLines.length) {
						const block = [
							'### ⛔ 负向规则（valves · 已人工确认）',
							'',
							'以下禁令与本轮输入相关，动手前先核对，命中即换路径：',
							...negativeLines.map((r) => `- [${r.id}] ${r.statement}`),
						].join('\n');
						message.content = [{ type: 'text', text: `${message.content[0]?.text ? message.content[0].text + '\n\n' : ''}${block}` }];
					}
					if (!message.content[0]?.text) return null;
					return {
						message: createUserMessage(message), signature, rows: selectedRows,
						recallStats: recallStats ?? { injected: 0, held: 0, dropped: 0, budget: RECALL_BUDGET_TOKENS, usedTokens: 0 },
						archivesCount: selectedArchives.length, rulesCount: negativeLines.length, budgetOmitted, optionalBytes, renderFailed,
					};
				};
				// Absolute budget: whichever settles first wins. A timeout injects
				// nothing (silence), never a slow or partial recall.
				let timeout;
				try {
					recall = await Promise.race([
						buildRecall(),
						new Promise((resolve) => { timeout = setTimeout(() => resolve(null), budgetMs); }),
					]);
					// A blocked event loop can let the build's microtask run before the
					// expired timer. It must not admit an already-expired candidate.
					if (performance.now() >= deadline) recall = null;
				} finally {
					if (timeout !== undefined) clearTimeout(timeout);
				}
			} catch {
				recall = null; // degrade to plain admission
			}
			const decision = await next();
			// Only admitted batches are eligible. Source and message IDs are host
			// declarations, not proof of a human sender or durable delivery.
			if (decision.kind === 'enter' && opts.captureUserTurns) {
				for (const _ of batch) captureStatus.observed();
				const chosen = selectCaptureEvents(batch, { maxChars: DEFAULTS.captureMaxChars });
				for (let i = 0; i < chosen.skipped.nonUser + chosen.skipped.nonUserSource; i++) captureStatus.skippedSource();
				for (let i = 0; i < chosen.skipped.missingId; i++) captureStatus.skippedMissingId();
				for (const _ of chosen.conflicts) captureStatus.schedule()?.finish('conflict', { code: 'OTHER', stage: 'select' });
				if (chosen.events.length) {
					const tickets = chosen.events.map(() => { captureStatus.selected(); return captureStatus.schedule(); });
					void Promise.resolve().then(() => {
						const root = resolveRoot(opts);
						return withMemoryRootTransaction(root, () => captureSelectedEvents(root, chosen.events));
					}).then(
						(outcomes) => { for (let i = 0; i < tickets.length; i++) tickets[i]?.finish(outcomes[i]); },
						(error) => {
							const code = typeof error?.code === 'string' ? error.code : 'OTHER';
							const stage = code.startsWith('CAPTURE_MUTEX_') ? 'lock' : code === 'CAPTURE_BASELINE_UNVERIFIED' || code.startsWith('CAPTURE_HISTORY_') || code === 'CAPTURE_UNSAFE_DAILY' ? 'read' : code === 'CAPTURE_FINALIZE_UNKNOWN' ? 'cleanup' : code === 'MEMORY_LEDGER_APPEND_FAILED' ? 'ledger' : code === 'MEMORY_WRITE_COMMIT_UNKNOWN' ? 'commit' : 'stage';
							for (const ticket of tickets) ticket?.finish('failed', { code, stage });
						},
					);
				}
			}
			if (!recall || decision.kind !== 'enter') return decision;
			// Commit only the candidate that actually won the deadline and is being
			// inserted into an entered step. Late builds and rejected steps leave no
			// served signature or exposure records behind.
			if (recallServed.size >= 512 && !recallServed.has(payload.agent.id)) recallServed.delete(recallServed.keys().next().value);
			recallServed.set(payload.agent.id, recall.signature);
			if (recall.recallStats) recordRecall({ ...recall.recallStats, actualRows: recall.rows.length, archives: recall.archivesCount, rules: recall.rulesCount, budgetOmitted: recall.budgetOmitted, optionalBytes: recall.optionalBytes, renderFailed: recall.renderFailed });
			for (const r of recall.rows) {
				const root = resolveRoot(opts);
				void withMemoryRootTransaction(root, () => appendUsage(root, { href: r.href, kind: 'recall' })).catch(() => {});
			}
			return { ...decision, messages: [recall.message, ...decision.messages] };
		}, { prepend: true }),
	);
	const sp = ctx.systemPrompt;
	disposers.push(
		sp.section({
			name: 'memory-manager:discipline',
			order: sp.getSectionOrder('TOOL_REPORT') + 5,
			interpolate: false,
			text: DISCIPLINE_TEXT,
		}),
	);

	// —— 向编排系统贡献本领域的处境信号（2026-11-02）——
	//
	// 编排系统（dsh-agent-mind）判断"此刻该先看什么"。它原本只有自己写的词表，
	// 于是**本领域的词汇全是盲区**：实测「沉淀」「蒸馏」「五层」「判据属于哪层」
	// 全部无信号 —— 而这些正是"该先查记忆"的时刻。
	//
	// 用广播而非 import：直接 import 会让 memory 反向依赖 mind，
	// 于是"没装 mind 就装不上 memory"。广播没有方向性 —— 缺 mind 时
	// 这条广播无人接收，memory 照常工作。
	//
	// 两类信号：记忆域（该回忆）与层级域（该查判据）。
	try {
		ctx.emit?.('mind/register-signal', {
			name: 'memory-recall',
			situation: 'recall',
			owner: 'dsh-memory-manager',
			weight: 3,
			words: [
				'沉淀', '蒸馏', '记忆', '回忆', '想不起来', '查一下记忆', '记忆里',
				'五层', '层级', '判据属于哪层', '该升到', '降回', '专项', '道层', '法层', '术层',
				'边界', '反面', '约束条件', '层级定义',
			],
		});
	} catch {
		/* 没有编排系统 → 广播无人接收，memory 照常工作 */
	}

	// Panel API: optional — without a web server the tools keep working and the
	// panel page shows its fallback text. Resolved lazily via ctx.inject because
	// webServer may not be provided yet at apply time. The memory root is global
	// (~/.dsh/memory), so workspaceRegistry is no longer needed here.
	// 'connection' joins the inject list for the security fence (see
	// memoryPanelApi): routes the host dispatches bare MUST gate themselves.
	ctx.inject(['webServer', 'connection'], (scoped) => {
		const server = scoped.webServer;
		if (server) {
			scoped.effect(() =>
				server.register({ kind: 'prefix', path: '/api/memory-org', handler: memoryPanelApi(opts, scoped.connection, inbox) }),
			);
		}
	});

	return () => {
		for (const d of disposers.reverse()) d();
	};
}

/**
 * Recall budget (MemOS borrow ⑤): config may SHORTEN the budget but never
 * extend it past the default ceiling — recall must stay bounded no matter how
 * it is configured. Pure so the clamping rule is testable.
 */
export function resolveRecallBudget(configured) {
	const ceiling = DEFAULTS.recallTimeoutMs;
	if (!Number.isFinite(configured)) return ceiling;
	return Math.min(Math.max(0, configured), ceiling);
}

/**
 * 健康探针 —— **DSH 插件封装标准的自愿接口**（与 `inject` / `Config` 同族）。
 *
 * 监督者（CLIS）从模块根具名导出里自动发现它，不需要 emit、不需要注册、
 * 不需要改 patch。见 D:/个人开发/CLIS/docs/PLUGIN-STANDARD.md。
 *
 * 导出形状必须是**带 probe() 的对象**（不是工厂函数）：监督层读的是
 * `ns.healthProbe.probe`，工厂函数会让 `.probe` 为 undefined → 调用即
 * TypeError，插件从监督视野里静默消失（2026-11-05 审查发现）。装配本身
 * 不做 I/O —— 只有 probe() 被调用时才真正读盘。
 *
 * 用 DEFAULTS 而非 apply() 里的 opts：监督者不知道本插件的 config，
 * 而检查项（索引体积/迭代块/链接/冷记忆）按默认阈值判断即可。
 *
 * 契约要点（标准要求）：
 * - **只读**：probe() 不修改任何数据；
 * - **不抛错**：内部失败转成 finding，而非 throw（见 health-inbox.js）；
 * - **code 稳定**：`memory.R14` 这类代号用于去重，不随内容变化。
 */
export const healthProbe = createHealthProbe({
	runHealthCheck,
	resolveRoot,
	opts: { ...DEFAULTS },
	recallLedger: () => liveRecallSummary(),
});

export { name, inject, dshHome, joinDshHome, resolveRoot, resolveDshRoot, runHealthCheck, panelizeHealth, zoneCounts, tokensOf, matchIndexRows, buildRecallMessage, decisionRepairTargets, indexRowsOf, captureLineFor, insightTrust, DEFAULTS, DISCIPLINE_TEXT };
