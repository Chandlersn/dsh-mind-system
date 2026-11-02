/**
 * 聚合包的发布前验证 —— 回答"别人装上到底能不能用"。
 *
 * ## 为什么要有这个脚本
 *
 * 聚合包最容易出的错是**静默降级**：四家没装齐时，宿主不报错，
 * 只是那部分能力不在。而聚合包的存在意义正是"一次装齐" ——
 * 所以必须验证"装齐了它就是完整的"。
 *
 * ## 验六件事
 *
 * 1. **聚合包自身完整**：名字/版本/license/bundle 声明/入口
 * 2. **唯一入口**：patch 只声明自己一个装载点，且四个成员（含 clis 的四个
 *    子组件）**各自**都被声明了，顺序满足"服务提供者先于消费者"
 * 3. **依赖声明完整**：peerDependencies 覆盖全部四个成员，且版本区间对得上
 * 4. **成员都在**：本机 profile 里四家都装了（发布前的最后一道闸）
 * 5. **版本区间对得上本机实际版本**
 * 6. **成员清单单一来源**：patch 的 `name:` 条目与 `index.js` 导出的清单一致
 *
 * 失败即**非零退出** —— 发布脚本据此拦住发布。
 *
 * ## ⭐ 成员清单从 `index.js` import（缺陷 4）
 *
 * 此前这里有**三处**独立的成员字面量（且顺序不同），加上 `index.js` 里
 * 那个零引用的 `MEMBERS` —— 共四份。三份手抄的清单可以各自漂移而无人察觉。
 *
 * 现在 `index.js` 是**唯一事实来源**，这里 import。
 *
 * ## ⭐ 顺序断言必须**先确认存在**（缺陷 3）
 *
 * 上一版的顺序断言是 `idx(a) < idx(b)`，而 `Array.indexOf` 对不存在的
 * 名字返回 `-1` —— **`-1 < 任何数` 都是 true**。
 *
 * 所以"删掉 `dsh-clis/strategy` 这一行"之后，全部 8 条断言照样 PASS。
 * 那个检查根本不可证伪。
 *
 * 现在每条顺序断言都要求**两个名字都存在**：
 * `idx(a) !== -1 && idx(b) !== -1 && idx(a) < idx(b)`。
 *
 * 而"四个子组件各自都在"是**单独**的断言 —— 上一版用的是
 * `names.includes(m) || names.some(n => n.startsWith(m + '/'))`，
 * 那个"或"让**任何一个** clis 子路径就能满足整个 `dsh-clis` 的检查，
 * 于是"四个子组件都在"这条要求**从来没被检查过**。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 成员清单的唯一事实来源（缺陷 4）。
// 相对路径：scripts/ → 聚合包 → index.js
import { MEMBERS, MEMBER_PACKAGES, CLIS_COMPONENTS } from '../index.js';

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

/**
 * 名字在不在。
 *
 * @param {string} n — 名字。
 * @returns {boolean} 是否存在。
 */
const has = (n) => names.includes(n);

/**
 * 顺序断言：**先确认两个名字都存在**，再比先后。
 *
 * 这是缺陷 3 的核心修复。上一版只写 `idx(a) < idx(b)`，
 * 而 `indexOf` 对缺失的名字返回 `-1`，`-1 < 任何数` 恒真 ——
 * 删掉一行断言照样 PASS（已实测）。
 *
 * @param {string} a — 前者。
 * @param {string} b — 后者。
 * @param {string} label — 断言标签。
 */
const orderOk = (a, b, label) => {
	const ia = names.indexOf(a);
	const ib = names.indexOf(b);
	// 两个都必须存在，否则"顺序"无从谈起
	const bothExist = ia !== -1 && ib !== -1;
	ok(bothExist && ia < ib, label);
};

ok(has('dsh-mind-system'), '聚合包装载自己');

// 四个成员包**各自**都要在装载点里。
// 上一版是 `includes(m) || some(n => n.startsWith(m + '/'))` ——
// 那个"或"让**任何一个** clis 子路径就能满足整个 dsh-clis 的检查，
// 于是"四个成员都在"从来没被真正检查过。
for (const member of MEMBER_PACKAGES) {
	ok(has(member), `聚合包装载 ${member}（否则单独装聚合包等于什么都没装）`);
}

// clis 的四个子组件：**每一个**都必须单独在。
// 这是"四个组件都在"这条要求的唯一实现 —— 不是靠 startsWith 蒙混。
for (const component of CLIS_COMPONENTS) {
	ok(has(component), `聚合包装载 ${component}（clis 四组件，缺一个工具包就不激活）`);
}

// 顺序：服务提供者先于消费者（每条都先确认存在，见 orderOk 的注释）
orderOk('dsh-clis/classifier', 'dsh-clis', 'clis 四组件先于 clis 工具包（classifier）');
orderOk('dsh-clis/strategy', 'dsh-clis', 'clis 四组件先于 clis 工具包（strategy）');
orderOk('dsh-clis/feedback', 'dsh-clis', 'clis 四组件先于 clis 工具包（feedback）');
orderOk('dsh-clis/orchestrator', 'dsh-clis', 'clis 四组件先于 clis 工具包（orchestrator）');
orderOk('dsh-clis', 'dsh-meta-framework', 'clis 先于 meta-framework（meta 依赖 clis 的分类器）');
orderOk('dsh-agent-mind', 'dsh-mind-system', 'mind 先于聚合包自身（自己最后收口）');

console.log('\n--- 3. 依赖声明完整 ---');
const peers = pkg.peerDependencies ?? {};
for (const member of MEMBER_PACKAGES) {
	ok(peers[member] !== undefined, `${member} 在 peerDependencies 里`);
}
ok(peers['@deepseek-ai/cordis'] !== undefined, '@deepseek-ai/cordis 在 peerDependencies 里');
ok(
	pkg.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional === true,
	'cordis 标为 optional peer（宿主自带，不该让 pnpm 硬装）',
);

console.log('\n--- 4. 成员齐全（monorepo + 本机 profile）---');
// 4a. monorepo 里每个成员都在 packages/ 下，且包名与目录一致
for (const member of MEMBER_PACKAGES) {
	const pj = join(repoRoot, 'packages', member, 'package.json');
	const present = existsSync(pj);
	ok(present, `packages/${member} 在仓库里`);
	if (!present) continue;
	const j = JSON.parse(read(pj));
	ok(j.name === member, `packages/${member} 的包名是 ${member}（实际 ${j.name}）`);
	ok(j.private !== true, `${member} 可发布（非 private）`);
}
// 4b. 若本机装了 profile：成员要在，且不能同时在 bundles（否则双装载）
const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/lyq/.dsh/profiles/web';
const profilePkg = JSON.parse(read(join(profileDir, 'package.json')) || '{}');
const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
if (existsSync(join(profileDir, 'package.json'))) {
	for (const member of MEMBER_PACKAGES) {
		const present = existsSync(join(profileDir, 'node_modules', member, 'package.json'));
		ok(present, `${member} 已装在 profile 里${present ? '' : '（发布前必须装齐）'}`);
		ok(!bundles.includes(member), `${member} 不在 bundles 里（否则与聚合包双装载）`);
	}
	ok(bundles.includes('dsh-mind-system'), '聚合包在 bundles 里（它是入口）');
}

console.log('\n--- 5. 版本区间对得上本机实际版本 ---');
for (const member of MEMBER_PACKAGES) {
	const p = join(profileDir, 'node_modules', member, 'package.json');
	if (!existsSync(p)) continue;
	const installed = JSON.parse(read(p)).version;
	const range = peers[member];
	if (typeof range !== 'string') continue;
	// 只核对主版本：区间形如 ^0.3.0 / ^5.29.10
	const want = range.replace(/^[^0-9]*/, '');
	const gotMajor = String(installed).split('.')[0];
	const wantMajor = want.split('.')[0];
	ok(gotMajor === wantMajor, `${member} 本机 ${installed} 与声明区间 ${range} 主版本一致`);
}

console.log('\n--- 6. 成员清单单一来源（缺陷 4）---');
// patch 里声明的**成员**（排除聚合包自己）必须与 index.js 的清单一致。
// 顺序也要一致 —— 装载顺序本身就是承诺的一部分。
const declaredMembers = names.filter((n) => n !== 'dsh-mind-system');
ok(
	JSON.stringify(declaredMembers) === JSON.stringify(MEMBERS),
	`patch 的装载点与 index.js 的 MEMBERS 完全一致（含顺序）。\n` +
	`    patch: ${JSON.stringify(declaredMembers)}\n` +
	`    清单 : ${JSON.stringify(MEMBERS)}`,
);
// 基本名清单也必须由 MEMBERS 派生（不能另写一份）
ok(
	JSON.stringify(MEMBER_PACKAGES) ===
		JSON.stringify([...new Set(MEMBERS.map((m) => m.split('/')[0]))]),
	'MEMBER_PACKAGES 由 MEMBERS 派生（不是另写一份）',
);

console.log(failures === 0 ? '\npublish-check: ALL PASS' : `\npublish-check: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
