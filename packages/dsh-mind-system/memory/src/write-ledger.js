/**
 * 层级写入溯源（2026-11-10 用户要求）。
 *
 * ## 用户原话与它要封的口子
 *
 * > "把机制卡死，每个层级的数据和信息编辑来源，只能是插件系统的抽取，
 * > 绝对不可以直接动用编辑工具进行书写。"
 *
 * 现状的漏洞：记忆的五个层（daily / functions / insights / dao / capabilities）
 * 全部是**磁盘上的普通 Markdown**。插件工具（memory_write / memory_insight /
 * memory_dao …）会走闸门、做判据、落审计；但只要用文件编辑工具直接改同一个
 * 文件，**所有闸门都被绕过，而且系统毫无察觉**——文件长得一模一样。
 *
 * 这不是"防恶意"，是**防无意识的绕过**：我自己在调试时就多次直接用
 * write/edit 改过记忆文件，每次都绕开了 R14 蒸馏闸门和层判据。
 *
 * ## 两道防线（互补，缺一不可）
 *
 * 1. **写入凭据**（前向）：插件写入时，在**旁路账本**里记一行
 *    `{ key, hash, t, tool }`。账本位于记忆根的 `.write-ledger.jsonl`，
 *    不写进记忆文件本身——否则"证明"会跟着被篡改的内容一起改。
 * 2. **体检对账**（后向）：体检把每个记忆文件的**当前 sha** 与账本里最后一次
 *    记录比对。对不上只表示内容不一致，不能单凭对账判定写入者。
 *
 * 为什么用 sha 而不是 mtime：mtime 只要 `touch` 一下就变，而且合法写入之后
 * 再被外部改一次，mtime 也说不清"改的是哪一次"。sha 只对内容负责，内容变了
 * 就是变了。代价是读全文算哈希（记忆根很小，可接受）。
 *
 * ## 边界（诚实标注）
 *
 * - 这是**审计**，不是**阻止**：文件系统层面拦不住 write 工具，本机制只能在
 *   事后提示账本与文件状态不一致；不能从中证明写入者。要真正阻止需要宿主级文件沙箱配合。
 * - 账本自身也可被改。它以"旁路 + 只追加"提高成本，但不提供密码学保证。
 * - 首次启用时账本为空，会把所有现存文件判为"未登记"。这是**如实的**——
 *   它们确实不是在本机制之下写的；下一轮插件写入即转正。
 *
 * @module src/write-ledger
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix, relative, sep } from 'node:path';

/**
 * 账本位置：记忆根下的 `.write-ledger.jsonl`，与 `.usage.jsonl` 同级。
 *
 * 为什么放记忆根内而不是外部 storages：审计要能跟着记忆一起备份/迁移，
 * 分成两处会让"记忆有历史、账本没有"这种半截状态出现。它与 .usage.jsonl
 * 同一安全级别——都是旁路账本，不提供密码学保证（见模块头的边界说明）。
 */
export const LEDGER_REL = '.write-ledger.jsonl';

/** 受本机制约束的层目录（相对记忆根）。daily 也在内——它同样只能由 agent 经工具写。 */
export const TRACKED_ZONES = Object.freeze(['functions', 'insights', 'dao', 'capabilities', 'daily']);

/** 报告代号（体检与面板共用稳定字符串）。 */
export const UNVERIFIED_WRITE = 'unverified_write';

/**
 * 内容哈希（sha256 前 16 位十六进制）。
 *
 * 取前 16 位是为了账本行短，碰撞概率对"检测人为改动"这个用途足够低
 * （2^64 空间；这里的对手不是密码学对手，是手滑的我）。
 *
 * @param {string} text 文件内容。
 * @returns {string}
 */
export function contentHash(text) {
	return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 把绝对路径规范成账本里的相对键（相对记忆根，正斜杠）。
 *
 * 用相对键的理由：记忆根可能在另一台机器上位于别的绝对路径，
 * 绝对路径会让账本不可移植。
 *
 * @param {string} root 记忆根。
 * @param {string} absPath 文件绝对路径。
 * @returns {string}
 */
export function ledgerKey(root, absPath) {
	const rel = relative(root, absPath);
	return rel.split(sep).join('/');
}

/**
 * 判定根目录每日文件或受管层路径，拒绝非规范或穿越路径。
 *
 * @param {string} key 相对键（如 `functions/某域.md`）。
 * @returns {boolean}
 */
export function isTracked(key) {
	const value = String(key ?? '');
	// Daily logs live at the root, not under daily/. Require the complete
	// filename; JS `$` alone also matches before a trailing newline.
	if (/^\d{4}-\d{2}-\d{2}\.md(?![\s\S])/u.test(value)) return true;
	const parts = value.split('/');
	// Reject traversal and malformed paths; `dao/_candidates/x.md` remains tracked.
	return parts.length >= 2 && TRACKED_ZONES.includes(parts[0]) &&
		parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

/**
 * 记录一次插件写入。**只追加**，永不修改历史——历史被改写就失去了对账意义。
 *
 * @param {string} root 记忆根。
 * @param {object} entry `{ key, hash, tool, bytes? }`
 * @returns {Promise<boolean>} 写失败返回 false（不阻断主流程）。
 */
export async function recordWrite(root, entry) {
	const key = String(entry?.key ?? '').trim();
	const hash = String(entry?.hash ?? '').trim();
	if (!key || !hash) return false;
	try {
		await mkdir(root, { recursive: true });
		const line = JSON.stringify({
			t: new Date().toISOString(),
			key,
			hash,
			tool: String(entry?.tool ?? 'unknown'),
			...(Number.isFinite(entry?.bytes) ? { bytes: entry.bytes } : {}),
		});
		await appendFile(join(root, LEDGER_REL), `${line}\n`, 'utf8');
		return true;
	} catch {
		// 账本写失败不能阻断写入本身：审计是附加能力（N4 降级）。
		return false;
	}
}

/** A missing destination is distinct from an invalid or differently targeted destination. */
function normalizeDeleteTarget(to) {
	if (to === undefined) return undefined;
	if (typeof to !== 'string' || !to || /[\x00-\x1f\x7f]/.test(to)) throw new TypeError('invalid delete target');
	const portable = to.replace(/\\/g, '/');
	if (portable.split('/').includes('..')) throw new TypeError('invalid delete target');
	const normalized = posix.normalize(portable);
	if (!isTracked(normalized)) throw new TypeError('invalid delete target');
	return normalized;
}

/** 追加带事务 ID 的删除意图或完成事件；失败返回 false。 */
export async function recordDeleteEvent(root, entry) {
	const { key, op, id, tool, to } = entry ?? {};
	if (!isTracked(key) || !['delete_intent', 'delete'].includes(op) || typeof id !== 'string' || !id || (tool !== undefined && (typeof tool !== 'string' || !tool))) return false;
	try {
		const target = normalizeDeleteTarget(to);
		await mkdir(root, { recursive: true });
		await appendFile(join(root, LEDGER_REL), `${JSON.stringify({ t: new Date().toISOString(), key, op, id, tool: tool ?? 'unknown', ...(target !== undefined ? { to: target } : {}) })}\n`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

/** 汇总各路径的最新写入/删除状态；坏账本或无法匹配的并发事件返回 undefined。 */
export async function readLedger(root) {
	let text;
	try {
		text = await readFile(join(root, LEDGER_REL), 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') return new Map(); // 还没记过 = 空账本，正常
		return undefined;
	}
	const last = new Map();
	const pendingIdentities = new Map();
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			const e = JSON.parse(s);
			if (typeof e?.key !== 'string' || !e.key) return undefined;
			if (e.op === 'delete_intent' || e.op === 'delete') {
				if (!isTracked(e.key) || typeof e.id !== 'string' || !e.id || (e.tool !== undefined && (typeof e.tool !== 'string' || !e.tool))) return undefined;
				const target = normalizeDeleteTarget(e.to);
				if (e.op === 'delete_intent') {
					if (last.get(e.key)?.op === 'delete_intent') return undefined;
					pendingIdentities.set(e.key, { tool: e.tool, target });
				} else {
					const pending = pendingIdentities.get(e.key);
					if (last.get(e.key)?.op !== 'delete_intent' || last.get(e.key)?.id !== e.id || !pending || pending.tool !== e.tool || pending.target !== target) return undefined;
					pendingIdentities.delete(e.key);
				}
				last.set(e.key, { op: e.op, id: e.id, at: e.t, tool: e.tool ?? 'unknown', ...(target !== undefined ? { to: target } : {}) });
			} else {
				if ((e.op !== undefined && e.op !== 'write') || typeof e.hash !== 'string' || !e.hash || last.get(e.key)?.op === 'delete_intent') return undefined;
				last.set(e.key, { hash: e.hash, at: e.t, tool: String(e.tool ?? 'unknown') });
			}
		} catch {
			// A partial or corrupt record makes the last recorded hash uncertain.
			return undefined;
		}
	}
	return last;
}

/**
 * 对账一份文件：它当前的内容是否与账本里最后一次插件写入一致。
 *
 * @param {object} input `{ key, text, ledger }`
 * @returns {{verdict: 'ok'|'unverified'|'unknown', expected?: string, actual: string, at?: string, tool?: string}}
 *   - `ok`：当前内容与最后登记的哈希一致，不证明来源。
 *   - `unverified`：未登记、哈希不符，或已登记删除的文件再次出现。
 *   - `unknown`：账本不可读、损坏或删除意图未完成。
 */
export function reconcile(input) {
	const key = String(input?.key ?? '').trim();
	const actual = contentHash(input?.text);
	const ledger = input?.ledger;
	if (ledger === undefined) {
		return { verdict: 'unknown', actual, reason: 'ledger_unreadable' };
	}
	if (!isTracked(key)) {
		// 不归本机制管（README.md、skills/ 等），如实说"不适用"，不冒充已验证。
		return { verdict: 'unknown', actual, reason: 'not_tracked' };
	}
	const rec = ledger.get(key);
	if (!rec) return { verdict: 'unverified', actual, reason: 'never_recorded' };
	if (rec.op === 'delete_intent') return { verdict: 'unknown', actual, reason: 'delete_incomplete', at: rec.at, tool: rec.tool };
	if (rec.op === 'delete') return { verdict: 'unverified', actual, reason: 'deleted_present', at: rec.at, tool: rec.tool };
	if (rec.hash !== actual) {
		return { verdict: 'unverified', actual, expected: rec.hash, at: rec.at, tool: rec.tool, reason: 'hash_mismatch' };
	}
	return { verdict: 'ok', actual, expected: rec.hash, at: rec.at, tool: rec.tool };
}

/**
 * 批量对账：把"未登记的写入"整理成可以呈现给人看的清单。
 *
 * @param {object} input `{ root, files: [{ key, text }], ledger }`
 * @returns {object[]} 问题清单（verdict !== 'ok' 且属于受管层）。
 */
export function auditBatch(input) {
	const out = [];
	for (const f of Array.isArray(input?.files) ? input.files : []) {
		const r = reconcile({ key: f?.key, text: f?.text, ledger: input?.ledger });
		if (r.verdict === 'ok') continue;
		// not_tracked 不算问题（README/索引本来就不由本机制管）。
		if (r.reason === 'not_tracked') continue;
		out.push({
			code: UNVERIFIED_WRITE,
			key: f?.key,
			verdict: r.verdict,
			reason: r.reason,
			...(r.expected ? { expected: r.expected, actual: r.actual } : {}),
			...(r.at ? { last_plugin_write: r.at, last_tool: r.tool } : {}),
		});
	}
	return out;
}
