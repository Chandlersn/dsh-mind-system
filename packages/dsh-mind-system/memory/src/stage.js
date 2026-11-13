/**
 * 受核验的暂存文件（2026-11-13，MEMORY_PANEL_CLEANUP_UNKNOWN 发布阻断修复）。
 *
 * 面板 exclusive 提交用 link() 把暂存硬链接到目标；提交后暂存路径仍在，
 * 而 unlink 按路径操作——路径可能已被外来文件替换，直接删会误伤别人。
 * 这里的判据：**先拿句柄记录暂存的 (dev, ino)，清理前 lstat 核验路径仍指向
 * 同一个文件对象才 unlink**。删的必是自己创建的那个 inode；不匹配、ino 不可用
 * 或路径消失时退 ftruncate(0) 兜底（内容清零、路径保留待孤儿清扫），
 * 绝不 unlink 陌生 inode。dev/ino 判据与 src/capture-journal.js、
 * src/capture-mutex.js 的既有先例同级。
 *
 * 残余边界（如实）：lstat 与 unlink 之间存在微秒级 TOCTOU 窗口，同目录活动
 * 攻击者无法用 Node 公共 API 完全消除；ino=0 的卷退化为空残留（内容不可读、
 * 路径待清扫），不丢安全性。未来方向：Linux O_TMPFILE 分支或 native 句柄删除。
 *
 * @module src/stage
 */
import path from 'node:path';
import { mkdir, open, lstat, unlink, readdir } from 'node:fs/promises';
import { truncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const STAGE_DIR = '.stage';
/** 孤儿清扫阈值：暂存生命周期远短于此；超过即视为崩溃遗留。 */
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
 *   已 ftruncate(0) 清空内容并保留路径待孤儿清扫。
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
		// lstat 本身失败：无法核验归属，也不冒险删——清空内容兜底。
		await truncateQuiet(p);
		return { removed: false, deferred: true, reason: error?.code ?? 'lstat-unknown' };
	}
	if (st.isSymbolicLink()) {
		await truncateQuiet(p);
		return { removed: false, deferred: true, reason: 'replaced-by-symlink' };
	}
	// 双侧都是 bigint：句柄侧记录与核验读数同精度，比较才可靠。
	const sameInode = entry.ino !== undefined && entry.ino !== 0n &&
		st.ino === entry.ino && st.dev === entry.dev;
	if (!sameInode) {
		await truncateQuiet(p);
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

/** ftruncate(0) 兜底：内容清零但保留路径，失败静默（孤儿清扫是最后一道）。 */
async function truncateQuiet(p) {
	try { truncateSync(p, 0); } catch { /* 路径可能已消失或不可写；孤儿清扫兜底 */ }
}

/** 扫描 .stage/ 中超龄孤儿（一次性清扫；失败忽略）。 */
export async function sweepStaleStages(root, { now = Date.now() } = {}) {
	const dir = stageDir(root);
	let names;
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
	} catch {
		return { swept: 0, scanned: 0 };
	}
	let swept = 0;
	for (const n of names) {
		try {
			const st = await lstat(path.join(dir, n));
			if (now - st.mtimeMs > STAGE_ORPHAN_MS) {
				await unlink(path.join(dir, n));
				swept++;
			}
		} catch { /* 单个失败不影响其余 */ }
	}
	return { swept, scanned: names.length };
}
