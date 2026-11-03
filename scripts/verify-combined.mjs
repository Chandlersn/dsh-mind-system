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

const { manifest, pkgRoot, files } = await computeTargets();
const diff = compare(pkgRoot, files, manifest.stamp ?? 'build-stamp.json');
const total = diff.missing.length + diff.changed.length + diff.extra.length;

if (total === 0) {
	console.log(`verify-combined: ALL PASS（${files.size} 个产物文件与源一致）`);
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
