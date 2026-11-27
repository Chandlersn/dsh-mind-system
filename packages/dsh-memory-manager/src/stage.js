/**
 * Verified stage files record their identity from the creation handle. Cleanup
 * compares that identity with lstat before unlinking, and leaves unverified paths
 * and their contents untouched. Age alone does not prove ownership.
 *
 * An attacker can replace a path between lstat and unlink. Node's public API
 * cannot eliminate this race. Unverifiable files remain intact for review.
 *
 * @module src/stage
 */
import path from 'node:path';
import { mkdir, open, lstat, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const STAGE_DIR = '.stage';
/** Retained for callers that reference the previous age threshold. */
export const STAGE_ORPHAN_MS = 7 * 24 * 60 * 60 * 1000;

/** .stage/ 目录绝对路径（不创建）。 */
export function stageDir(root) {
	return path.join(root, STAGE_DIR);
}

/**
 * 在记忆根的 .stage/ 下创建一个受核验的暂存文件并记录其身份。
 *
 * 'wx' 独占创建保证路径不与任何现有文件重合；句柄写入+fsync 保证提交前
 * 内容完整；bigint stat 记下 (dev, ino) 供清理时核验归属。
 *
 * @param {string} root 记忆根绝对路径。
 * @param {string} key 账本键（取其文件名做前缀，便于人工辨认）。
 * @param {string} text 暂存正文。
 * @returns {Promise<{path: string, dev: bigint, ino: bigint}>}
 */
export async function createVerifiedStage(root, key, text) {
	const dir = stageDir(root);
	await mkdir(dir, { recursive: true });
	const base = String(key ?? 'file').split('/').pop() || 'file';
	const p = path.join(dir, `${base}.stage-${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(p, 'wx', 0o600);
		try {
			await handle.writeFile(text, 'utf8');
			await handle.sync();
			const st = await handle.stat({ bigint: true });
			return { path: p, dev: st.dev, ino: st.ino };
		} finally {
			await handle.close();
		}
	} catch (error) {
		// 独占创建失败（典型 EEXIST：uuid 撞名或同进程注入）：把尝试路径带给
		// 调用方——MemoryStageOutcomeUnknown 需要它来指认"请核对的暂存路径"，
		// 调用方据此不覆盖、不删除、不另起炉灶绕开碰撞。
		try { error.stagePath = p; } catch { /* frozen error: report without path */ }
		try { await handle?.close(); } catch { /* close outcome unknown */ }
		throw error;
	}
}

/**
 * 清理一个受核验的暂存：只有路径仍指向创建时记录的 inode 才 unlink。
 *
 * @param {{path: string, dev: bigint, ino: bigint}} entry createVerifiedStage 的返回值。
 * @returns {Promise<{removed: boolean, deferred?: boolean, reason?: string}>}
 *   removed=true 已删除（或路径已不存在）；deferred=true 归属无法核验，
 *   the unverified path and its contents are left untouched.
 */
export async function removeVerifiedStage(entry) {
	const p = String(entry?.path ?? '');
	if (!p) return { removed: false, deferred: true, reason: 'no-stage-path' };
	let st;
	try {
		// bigint lstat：Windows 的 inode 可超过 Number.MAX_SAFE_INTEGER（实测
		// 出现过 9.28e15 > 2^53），number 型读数会精度丢失，与句柄侧 bigint
		// 记录比较时间歇性失配——必须用 bigint 读数核验。
		st = await lstat(p, { bigint: true });
	} catch (error) {
		if (error?.code === 'ENOENT') return { removed: true };
		// Ownership is unknown; preserve the path and its contents.
		return { removed: false, deferred: true, reason: error?.code ?? 'lstat-unknown' };
	}
	if (st.isSymbolicLink()) {
		return { removed: false, deferred: true, reason: 'replaced-by-symlink' };
	}
	// 双侧都是 bigint：句柄侧记录与核验读数同精度，比较才可靠。
	const sameInode = entry.ino !== undefined && entry.ino !== 0n &&
		st.ino === entry.ino && st.dev === entry.dev;
	if (!sameInode) {
		return { removed: false, deferred: true, reason: 'inode-mismatch-or-unavailable' };
	}
	try {
		await unlink(p);
		return { removed: true };
	} catch (error) {
		// unlink 失败（如 Windows EPERM 瞬时冲突）：不动路径，如实报 deferred。
		return { removed: false, deferred: true, reason: error?.code ?? 'unlink-unknown' };
	}
}

/** List candidate paths without deleting: age does not establish ownership. */
export async function sweepStaleStages(root, _options = {}) {
	const dir = stageDir(root);
	try {
		const names = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
		return { swept: 0, scanned: names.length, disabled: true, reason: 'ownership-unverified' };
	} catch (error) {
		return { swept: 0, scanned: 0, disabled: true, reason: 'ownership-unverified', ...(error?.code === 'ENOENT' ? {} : { scanError: error?.code ?? 'unknown' }) };
	}
}
