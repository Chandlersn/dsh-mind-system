/**
 * 合成包的构建计划 —— `build-combined` 与 `verify-combined` 共用同一份计算。
 *
 * ## 为什么抽成模块而不是各写一遍
 *
 * 如果「构建」和「校验」各写一套规则，两边迟早不一致，而校验存在的唯一意义就是
 * **不信任构建**。共用一个 `computeTargets()`，校验才真的在校验同一件事。
 *
 * ## 两个硬约束
 *
 * 1. **只管理有名字的文件**：成员目录里的 `node_modules/` 永不触碰（`meta/node_modules`
 *    里装着 `@causal-layers/meta-framework`，包本身没声明这个依赖，删了就得手工装回来）。
 * 2. **改写必须命中**：`rewrites.mjs` 里每条 edit 的命中次数必须等于 `count`，
 *    否则抛错。宁可红，也不产出一份半改的文件。
 *
 * @module scripts/build/plan
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根。 */
export const repoRoot = resolve(here, '..', '..');

/** manifest 路径（相对仓库根）。 */
export const MANIFEST_REL = 'packages/dsh-mind-system/build.manifest.json';

/** 遍历时永远跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * 递归列出目录下的文件（相对 `base`，统一用 `/`）。
 *
 * @param {string} dir 目录绝对路径。
 * @param {string} [base] 计算相对路径的基准。
 * @param {string[]} [out] 收集数组。
 * @returns {string[]} 相对路径列表。
 */
export function walkFiles(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const abs = join(dir, entry.name);
		const rel = relative(base, abs).split(sep).join('/');
		if (entry.isDirectory()) walkFiles(abs, base, out);
		else out.push(rel);
	}
	return out;
}

/**
 * 读取并做基本形态检查的 manifest。
 *
 * @returns {object} manifest 对象。
 */
export function loadManifest() {
	const abs = join(repoRoot, MANIFEST_REL);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(abs, 'utf8'));
	} catch (error) {
		throw new Error(`读不了 ${MANIFEST_REL}：${error.message}`);
	}
	if (!Array.isArray(parsed.members) || parsed.members.length === 0) {
		throw new Error(`${MANIFEST_REL} 里没有 members`);
	}
	return parsed;
}

/**
 * 把一条改写应用到内容上，并断言命中次数。
 *
 * 用 `split/join` 而不是 `replace`：`replace` 会把替换串里的 `$&`、`$1` 当特殊标记，
 * 而改写表是纯数据、不该有这种隐式语义。
 *
 * @param {string} content 原内容。
 * @param {{find: string, replace: string, count: number}} edit 一条改写。
 * @param {string} label 报错用标签。
 * @returns {string} 改写后内容。
 */
function applyEdit(content, edit, label) {
	const hits = content.split(edit.find).length - 1;
	const expected = edit.count ?? 1;
	if (hits !== expected) {
		throw new Error(
			`${label}：改写未按预期命中（期望 ${expected} 次，实际 ${hits} 次）\n` +
				`  待找片段：${JSON.stringify(edit.find.slice(0, 80))}\n` +
				`  含义：源文件已变化，构建规则过期。改源或改 scripts/build/rewrites.mjs，不要绕过。`
		);
	}
	return content.split(edit.find).join(edit.replace);
}

/**
 * 计算产物应有什么内容。
 *
 * @returns {Promise<{
 *   manifest: object,
 *   pkgRoot: string,
 *   files: Map<string, {bytes: Buffer, source: string, rewritten: number}>,
 *   skipped: Array<{package: string, path: string, why: string}>,
 * }>} 目标文件表（键为产物内相对路径）。
 */
export async function computeTargets() {
	const manifest = loadManifest();
	const pkgRoot = join(repoRoot, manifest.packageRoot);
	const rewritesMod = await import(pathToFileURL(join(repoRoot, manifest.rewritesFile)).href);
	const rewrites = rewritesMod.REWRITES ?? [];
	const byFile = new Map(rewrites.map((entry) => [entry.file, entry]));

	/** @type {Map<string, {bytes: Buffer, source: string, rewritten: number}>} */
	const files = new Map();
	const skipped = [];

	for (const member of manifest.members) {
		const srcRoot = join(repoRoot, 'packages', member.package);
		const excluded = new Map((member.exclude ?? []).map((item) => [item.path, item.why]));
		const srcFiles = walkFiles(srcRoot);

		// 源包里没有、manifest 也没排除的「排除项」说明清单过期了。
		const srcSet = new Set(srcFiles);
		for (const path of excluded.keys()) {
			if (!srcSet.has(path)) {
				throw new Error(
					`${MANIFEST_REL} 给 ${member.package} 声明了排除 ${path}，但源里已没有这个文件——清单过期，请更新`
				);
			}
		}

		for (const rel of srcFiles) {
			if (excluded.has(rel)) {
				skipped.push({ package: member.package, path: rel, why: excluded.get(rel) });
				continue;
			}

			const targetRel = `${member.dir}/${rel}`;
			const raw = readFileSync(join(srcRoot, rel));
			const rule = byFile.get(targetRel);

			if (rule === undefined) {
				files.set(targetRel, { bytes: raw, source: `${member.package}/${rel}`, rewritten: 0 });
				continue;
			}

			// 改写只对文本文件成立。用 utf8 往返比对来判定，避免把二进制当文本改坏。
			const text = raw.toString('utf8');
			if (!Buffer.from(text, 'utf8').equals(raw)) {
				throw new Error(`${targetRel} 有改写规则，但不是合法 UTF-8 文本`);
			}
			let next = text;
			for (const edit of rule.edits) next = applyEdit(next, edit, targetRel);
			files.set(targetRel, {
				bytes: Buffer.from(next, 'utf8'),
				source: `${member.package}/${rel}`,
				rewritten: rule.edits.length
			});
		}
	}

	// 改写表里点名的文件若不在目标集里，规则就永远不会生效——必须报出来。
	for (const file of byFile.keys()) {
		if (!files.has(file)) throw new Error(`rewrites 指向 ${file}，但它不在任何成员产出的目标集里`);
	}

	// 产物指纹：谁生成了它、来自哪个源文件、内容哈希。
	const stampName = manifest.stamp ?? 'build-stamp.json';
	const stampFiles = {};
	for (const rel of [...files.keys()].sort()) {
		const entry = files.get(rel);
		stampFiles[rel] = {
			source: entry.source,
			sha256: createHash('sha256').update(entry.bytes).digest('hex')
		};
	}
	const stamp = {
		generatedBy: 'scripts/build-combined.mjs',
		manifest: MANIFEST_REL,
		note: '产物索引，勿手改。重新生成：npm run build',
		files: stampFiles
	};
	files.set(stampName, {
		bytes: Buffer.from(`${JSON.stringify(stamp, null, 2)}\n`, 'utf8'),
		source: '(生成)',
		rewritten: 0
	});

	return { manifest, pkgRoot, files, skipped };
}

/**
 * 把「应有」与「现有」比一遍。
 *
 * @param {string} pkgRoot 合成包根。
 * @param {Map<string, {bytes: Buffer}>} files 目标文件表。
 * @param {string} stampName 指纹文件名（本身不参与「多余」判定）。
 * @returns {{missing: string[], changed: string[], extra: string[]}} 三类差异。
 */
export function compare(pkgRoot, files, stampName) {
	const missing = [];
	const changed = [];
	for (const [rel, entry] of files) {
		let current;
		try {
			current = readFileSync(join(pkgRoot, rel));
		} catch {
			missing.push(rel);
			continue;
		}
		if (!current.equals(entry.bytes)) changed.push(rel);
	}

	const onDisk = walkFiles(pkgRoot).filter((rel) => rel !== stampName);
	const extra = onDisk.filter((rel) => !files.has(rel) && isInsideMemberDir(rel, files));

	return { missing: missing.sort(), changed: changed.sort(), extra: extra.sort() };
}

/**
 * 只有成员目录内的文件归构建管；包根的手写文件（index.js、README、scripts/、test/）不归它管，
 * 出现在磁盘上不算「多余」。
 *
 * @param {string} rel 产物内相对路径。
 * @param {Map<string, {bytes: Buffer}>} files 目标文件表。
 * @returns {boolean} 是否落在某个成员目录里。
 */
function isInsideMemberDir(rel, files) {
	const memberDirs = new Set(
		[...files.keys()].filter((key) => key.includes('/')).map((key) => key.split('/')[0])
	);
	return memberDirs.has(rel.split('/')[0]);
}
