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
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
	console.error(
		[
			'',
			'⚠️  产物与一个已安装副本共享 inode（两者是同一个文件）。',
			`   安装位置：${linked}`,
			'   本次写入用 rename 断链，所以运行实例仍是旧内容——**要生效必须重装**：',
			'   删掉上面的安装目录，再按你平时的装法重新装一次（拷贝，不要硬链接），然后重启 dsh。',
			'   详见 README「装进 profile 是拷贝，不是链接」。'
		].join('\n')
	);
}

if (process.exitCode === undefined) {
	console.log(`\nbuild-combined: OK（repoRoot=${repoRoot}）`);
}
