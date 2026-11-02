/**
 * 聚合包的发布前验证 —— 回答"别人装上到底能不能用"。
 *
 * ## 为什么要有这个脚本
 *
 * 聚合包最容易出的错是**静默降级**：四家没装齐时，宿主不报错，
 * 只是那部分能力不在。而聚合包的存在意义正是"一次装齐" ——
 * 所以必须验证"装齐了它就是完整的"。
 *
 * ## 验四件事
 *
 * 1. **聚合包自身完整**：名字/版本/license/bundle 声明/入口
 * 2. **零双装载**：patch 只声明自己一个装载点。
 *    宿主对 `bundles` 里每个 bundle 都应用其 patch —— 若聚合包也声明
 *    四家的装载点，同一插件会被装载两次（cordis 每次 plugin() 新建 fiber），
 *    表现为"同名分节被覆盖、工具被后注册者顶掉"：**看着没坏，实为巧合**。
 * 3. **依赖声明完整**：peerDependencies 覆盖全部四个成员，且版本区间对得上
 * 4. **成员都在**：本机 profile 里四家都装了（发布前的最后一道闸）
 *
 * 失败即**非零退出** —— 发布脚本据此拦住发布。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 仓库根：scripts/ → 聚合包 → packages/ → 仓库根
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

let failures = 0;
const ok = (cond, label) => {
	console.log(`${cond ? '  PASS ' : '  FAIL '}${label}`);
	if (!cond) failures++;
};

/** 读文件（不存在返回空串）。 */
const read = (p) => {
	try {
		return readFileSync(p, 'utf8');
	} catch {
		return '';
	}
};

const pkg = JSON.parse(read(join(pkgRoot, 'package.json')) || '{}');
const patchText = read(join(pkgRoot, 'cordis.patch.yml'));

console.log('\n--- 1. 聚合包自身完整性 ---');
ok(pkg.name === 'dsh-mind-system', `包名是 dsh-mind-system（实际 ${pkg.name}）`);
ok(pkg.private === false, '不是 private（要能发布）');
ok(typeof pkg.version === 'string' && pkg.version.length > 0, '有版本号');
ok(pkg.license !== undefined, '有 license');
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 bundle patch 路径');
ok(read(join(pkgRoot, 'index.js')).length > 0, '有入口 index.js');
ok(patchText.length > 0, '有 cordis.patch.yml');
ok(read(join(pkgRoot, 'README.md')).length > 0, '有 README');
ok(read(join(pkgRoot, 'LICENSE')).length > 0, '有 LICENSE');

console.log('\n--- 2. 唯一入口：聚合包装载四家 ---');
// 只解析**非注释行**：YAML 注释里的字面量不是数据。
// 上一版把注释里的 name: 'dsh-agent-mind' 当成装载点，误报"双装载"。
const names = patchText
	.split('\n')
	.filter((line) => !/^\s*#/.test(line))
	.flatMap((line) => [...line.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));
const MEMBERS = ['dsh-clis', 'dsh-meta-framework', 'dsh-memory-manager', 'dsh-agent-mind'];
ok(names.includes('dsh-mind-system'), '聚合包装载自己');
for (const m of MEMBERS) {
	ok(
		names.includes(m) || names.some((n) => n.startsWith(m + '/')),
		`聚合包装载 ${m}（否则单独装聚合包等于什么都没装）`,
	);
}
// 顺序：服务提供者先于消费者
const idx = (n) => names.indexOf(n);
ok(idx('dsh-clis/classifier') < idx('dsh-clis'), 'clis 四组件先于 clis-tools');
ok(idx('dsh-clis') < idx('dsh-meta-framework'), 'clis 先于 meta-framework');
ok(idx('dsh-agent-mind') < idx('dsh-mind-system'), 'mind 先于聚合包自身（自己最后收口）');

console.log('\n--- 3. 依赖声明完整 ---');
const peers = pkg.peerDependencies ?? {};
for (const member of ['dsh-clis', 'dsh-agent-mind', 'dsh-meta-framework', 'dsh-memory-manager']) {
	ok(peers[member] !== undefined, `${member} 在 peerDependencies 里`);
}
ok(peers['@deepseek-ai/cordis'] !== undefined, '@deepseek-ai/cordis 在 peerDependencies 里');
ok(
	pkg.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional === true,
	'cordis 标为 optional peer（宿主自带，不该让 pnpm 硬装）',
);

console.log('\n--- 4. 成员齐全（monorepo + 本机 profile）---');
// 4a. monorepo 里每个成员都在 packages/ 下，且包名与目录一致
for (const m of MEMBERS) {
	const dir = m === 'dsh-agent-mind' ? 'dsh-agent-mind' : m;
	const pj = join(repoRoot, 'packages', dir, 'package.json');
	const present = existsSync(pj);
	ok(present, `packages/${dir} 在仓库里`);
	if (!present) continue;
	const j = JSON.parse(read(pj));
	ok(j.name === m, `packages/${dir} 的包名是 ${m}（实际 ${j.name}）`);
	ok(j.private !== true, `${m} 可发布（非 private）`);
}
// 4b. 若本机装了 profile：成员要在，且不能同时在 bundles（否则双装载）
const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/lyq/.dsh/profiles/web';
const profilePkg = JSON.parse(read(join(profileDir, 'package.json')) || '{}');
const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
if (existsSync(join(profileDir, 'package.json'))) {
	for (const m of MEMBERS) {
		const present = existsSync(join(profileDir, 'node_modules', m, 'package.json'));
		ok(present, `${m} 已装在 profile 里${present ? '' : '（发布前必须装齐）'}`);
		ok(!bundles.includes(m), `${m} 不在 bundles 里（否则与聚合包双装载）`);
	}
	ok(bundles.includes('dsh-mind-system'), '聚合包在 bundles 里（它是入口）');
}

console.log('\n--- 5. 版本区间对得上本机实际版本 ---');
for (const m of ['dsh-clis', 'dsh-meta-framework', 'dsh-memory-manager', 'dsh-agent-mind']) {
	const p = join(profileDir, 'node_modules', m, 'package.json');
	if (!existsSync(p)) continue;
	const installed = JSON.parse(read(p)).version;
	const range = peers[m];
	if (typeof range !== 'string') continue;
	// 只核对主版本：区间形如 ^0.3.0 / ^5.29.10
	const want = range.replace(/^[^0-9]*/, '');
	const gotMajor = String(installed).split('.')[0];
	const wantMajor = want.split('.')[0];
	ok(gotMajor === wantMajor, `${m} 本机 ${installed} 与声明区间 ${range} 主版本一致`);
}

console.log(failures === 0 ? '\npublish-check: ALL PASS' : `\npublish-check: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
