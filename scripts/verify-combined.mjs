/**
 * 校验合成包产物与源是否一致 —— **不写入，只判定**。
 *
 * 用法：`node scripts/verify-combined.mjs`（干净时退出 0，漂移时退出 1）
 *
 * 为什么不直接调用 `build-combined`：构建会顺手修好漂移，CI 里这就等于把错误吃掉了。
 * 校验必须只读，红就是红。
 *
 * @module scripts/verify-combined
 */
import { computeTargets, compare } from './build/plan.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { manifest, pkgRoot, files } = await computeTargets();
const diff = compare(pkgRoot, files, manifest.stamp ?? 'build-stamp.json');
const total = diff.missing.length + diff.changed.length + diff.extra.length;

// ---------------------------------------------------------------------------
// 独立断言：运行必需的第三方依赖必须真的在包里、且可解析。
//
// 为什么单独一条：`plan.mjs` 的 walkFiles 跳过 node_modules，这些文件既不进
// build-stamp（不生成哈希）也不进 extra 检测。于是删掉 meta/node_modules 里的
// 40 个 .js，构建照样报「已经是最新」、verify 照样全绿 —— 部署回执全对，
// 运行却崩。这正是「拷贝式打包不重建中间产物」的形状：绿灯来自一条根本没
// 检查过依赖的回路。这里不把依赖纳入构建管辖（第三方产物不该被改写），
// 只让校验显式看一眼它们是否还在、是否可用。
// ---------------------------------------------------------------------------
const DEPENDENCIES = [
	{
		label: 'meta/node_modules/@causal-layers/meta-framework',
		pkg: join(pkgRoot, 'meta', 'node_modules', '@causal-layers', 'meta-framework', 'package.json'),
		entry: join(pkgRoot, 'meta', 'node_modules', '@causal-layers', 'meta-framework', 'dist', 'src', 'index.js'),
	},
];
const depFailures = [];
for (const dep of DEPENDENCIES) {
	if (!existsSync(dep.pkg)) { depFailures.push(`${dep.label} 缺 package.json`); continue; }
	if (!existsSync(dep.entry)) { depFailures.push(`${dep.label} 缺入口 dist/src/index.js`); continue; }
	try {
		const pkg = JSON.parse(readFileSync(dep.pkg, 'utf8'));
		if (!pkg.version) depFailures.push(`${dep.label} 的 package.json 没有 version（包被掏空）`);
		// 静态解析：入口能被 Node 找到（不执行它，避免校验带副作用）。
		createRequire(dep.entry).resolve(dep.entry);
	} catch (error) {
		depFailures.push(`${dep.label} 无法解析：${error?.message ?? error}`);
	}
}
if (depFailures.length) {
	console.error('verify-combined: 运行依赖缺失/损坏（构建指纹看不到它们，故单独报）\n');
	for (const f of depFailures) console.error(`  - ${f}`);
}

if (total === 0 && depFailures.length === 0) {
	console.log(`verify-combined: ALL PASS（${files.size} 个产物文件与源一致；${DEPENDENCIES.length} 个运行依赖在位且可解析）`);
	process.exit(0);
}

console.error('verify-combined: 产物与源不一致\n');
if (diff.missing.length > 0) {
	console.error(`缺失 ${diff.missing.length} 个（源里有、产物没有）：`);
	for (const rel of diff.missing) console.error(`  - ${rel}`);
}
if (diff.changed.length > 0) {
	console.error(`内容不同 ${diff.changed.length} 个：`);
	for (const rel of diff.changed) console.error(`  ~ ${rel}  ← 源：${files.get(rel).source}`);
}
if (diff.extra.length > 0) {
	console.error(`多余 ${diff.extra.length} 个（产物有、源里没有）：`);
	for (const rel of diff.extra) console.error(`  + ${rel}`);
}
console.error(
	'\n修法：`npm run build`（陈旧文件确认后加 --prune）。' +
		'若是有人手改了产物，请改回源包——产物不是源。'
);
process.exit(1);
