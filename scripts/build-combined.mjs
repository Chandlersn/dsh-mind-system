/**
 * 生成合成包产物：`packages/dsh-mind-system/{clis,mind,meta,memory}/`。
 *
 * 用法：
 *   node scripts/build-combined.mjs            生成（覆盖变化，新增缺失）
 *   node scripts/build-combined.mjs --prune    额外删除成员目录里已无来源的陈旧文件
 *
 * 为什么写入用「临时文件 + rename」而不是直接覆盖：产物与
 * `~/.dsh/profiles/web/node_modules/dsh-mind-system` 是**硬链接**（89/93）。
 * 直接覆盖会顺着链接改掉正在运行的 dsh，而源码变更本应要求显式重装。
 * rename 会断开链接（旧 inode 留给安装副本），这正是我们要的语义。
 *
 * @module scripts/build-combined
 */
import { lstatSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTargets, compare, repoRoot } from './build/plan.mjs';

const argv = new Set(process.argv.slice(2));
const prune = argv.has('--prune');

/**
 * 找到「和源码共享 inode」的安装副本，用于提醒。
 *
 * @param {string} pkgRoot 合成包根。
 * @returns {string|null} 命中的安装路径，没有则 null。
 */
function findLinkedInstall(pkgRoot) {
	const home = process.env.USERPROFILE ?? process.env.HOME;
	const candidates = [
		process.env.DSH_PROFILE_PLUGIN,
		home === undefined ? undefined : join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-mind-system')
	].filter((item) => typeof item === 'string');

	let sourceIno;
	try {
		sourceIno = statSync(join(pkgRoot, 'package.json')).ino;
	} catch {
		return null;
	}
	for (const candidate of candidates) {
		try {
			if (statSync(join(candidate, 'package.json')).ino === sourceIno) return candidate;
		} catch {
			/* 没装就是最好的情况 */
		}
	}
	return null;
}

/**
 * 原子写：同目录临时文件 → rename。
 *
 * @param {string} abs 目标绝对路径。
 * @param {Buffer} bytes 内容。
 */
function writeAtomic(abs, bytes) {
	const tmp = `${abs}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, bytes);
		renameSync(tmp, abs);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

const { manifest, pkgRoot, files, skipped } = await computeTargets();
const stampName = manifest.stamp ?? 'build-stamp.json';
const diff = compare(pkgRoot, files, stampName);

console.log(`合成包产物：${files.size} 个文件（来自 ${manifest.members.length} 个成员，排除 ${skipped.length} 项）`);

if (diff.missing.length + diff.changed.length + diff.extra.length === 0) {
	console.log('已经是最新，无需写入。');
} else {
	for (const rel of diff.missing) {
		writeAtomic(join(pkgRoot, rel), files.get(rel).bytes);
		console.log(`  + ${rel}`);
	}
	for (const rel of diff.changed) {
		writeAtomic(join(pkgRoot, rel), files.get(rel).bytes);
		console.log(`  ~ ${rel}`);
	}
	for (const rel of diff.extra) {
		if (!prune) {
			console.log(`  ? ${rel}  ← 成员目录里没有来源的文件，确认后加 --prune 删除`);
			continue;
		}
		rmSync(join(pkgRoot, rel), { force: true });
		console.log(`  - ${rel}`);
	}
	console.log(`写入 ${diff.missing.length + diff.changed.length} 个，删除 ${prune ? diff.extra.length : 0} 个。`);
}

if (diff.extra.length > 0 && !prune) {
	console.error(
		`\n有 ${diff.extra.length} 个文件在成员目录里但找不到来源。构建不会替你删——` +
			'确认它们是陈旧产物后加 --prune，或者把它们挪到该去的地方。'
	);
	process.exitCode = 1;
}

const written = diff.missing.length + diff.changed.length;
const linked = written > 0 ? findLinkedInstall(pkgRoot) : null;
if (linked !== null) {
	// ⚠️ 2026-11-03 更新：安装形态已从「拷贝」改为 junction，这条提示随之改写。
	//
	// 旧版写的是"本次写入用 rename 断链，要生效必须重装" —— 那是**拷贝形态**下
	// 的正确结论。现在 junction 是指向整个 packages/dsh-mind-system 的目录链接，
	// 构建写入的就是运行实例读的那个文件，**不需要重装**。
	//
	// 但反过来的风险更大了，所以提示要说清楚：junction 下构建 = 直接改运行代码。
	const isJunction = (() => {
		try {
			return lstatSync(linked).isSymbolicLink();
		} catch {
			return false;
		}
	})();
	console.error(
		isJunction
			? [
				'',
				'⚠️  安装副本是指向本包的 junction —— 构建写入**直接就是运行实例的代码**。',
				`   安装位置：${linked}`,
				'   不需要重装；但也意味着**没有隔离缓冲**：',
				'   · 被 import 过的模块会由 HMR 热替换，可能中断进行中的会话；',
				'   · 半成品实现会立刻成为运行时行为；',
				'   · `git checkout` / 切分支 = 换线上版本。',
				'   详见 PUBLISH.md「运行状态警示：改这个仓库等于改正在运行的系统」。'
			].join('\n')
			: [
				'',
				'⚠️  产物与一个已安装副本共享 inode（两者是同一个文件）。',
				`   安装位置：${linked}`,
				'   本次写入用 rename 断链，所以运行实例仍是旧内容——**要生效必须重装**：',
				'   删掉上面的安装目录，再按你平时的装法重新装一次（拷贝，不要硬链接），然后重启 dsh。',
				'   详见 README「装进 profile」一节。'
			].join('\n')
	);
}

if (process.exitCode === undefined) {
	console.log(`\nbuild-combined: OK（repoRoot=${repoRoot}）`);
}
