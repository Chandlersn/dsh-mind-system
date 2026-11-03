/**
 * 合成包的发布前自检——回答"别人装上到底能不能用"。
 *
 * ## 为什么要有这个脚本
 *
 * 合成包最容易出的错是**静默降级**：成员子目录没拷全、exports 映射漏一条、
 * patch 少写一个装载点——宿主不报错，只是那部分能力不在。
 * 合成包的存在意义正是"一次装齐"，所以必须验证"装齐了它就是完整的"。
 *
 * ## 验收六件
 *
 * 1. **包自身完整**：名字/版本/license/bundle 声明/入口
 * 2. **唯一裸名入口**：patch 里 `dsh-mind-system` 只出现一次（裸名入口同时
 *    是客户端扫描的锚点，多了会触发 client-modules 的多源冲突）
 * 3. **成员装载点齐全**：patch 与 index.js 的 MEMBERS 逐条一致（含顺序）
 * 4. **exports 映射齐全**：每个装载点子路径都有映射且目标文件真实存在
 * 5. **成员子目录齐全**：clis/ meta/ memory/ mind/ 的入口文件都在
 * 6. **版本与客户端声明**：version 非空、dsh.client 指向真实 client 文件
 *
 * 失败即**非零退出**——发布脚本据此拦住发布。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 成员清单的唯一事实来源：本包 index.js
import { MEMBERS, MEMBER_PACKAGES, CLIS_COMPONENTS } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '  PASS ' : '  FAIL '}${label}`);
  if (!cond) failures++;
};

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

const pkg = JSON.parse(read(join(pkgRoot, 'package.json')) || '{}');
const patchText = read(join(pkgRoot, 'cordis.patch.yml'));

console.log('\n--- 1. 包自身完整性 ---');
ok(pkg.name === 'dsh-mind-system', `包名是 dsh-mind-system（实际 ${pkg.name}）`);
ok(pkg.private === false, '不是 private（要能发布）');
ok(typeof pkg.version === 'string' && pkg.version.length > 0, '有版本号');
ok(pkg.license !== undefined, '有 license');
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 bundle patch 路径');
ok(read(join(pkgRoot, 'index.js')).length > 0, '有入口 index.js');
ok(patchText.length > 0, '有 cordis.patch.yml');
ok(read(join(pkgRoot, 'README.md')).length > 0, '有 README');
ok(read(join(pkgRoot, 'LICENSE')).length > 0, '有 LICENSE');

console.log('\n--- 2. 唯一裸名入口 ---');
// 只解析非注释行：YAML 注释里的字面量不是数据。
const names = patchText
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .flatMap((line) => [...line.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));

const bare = names.filter((n) => n === 'dsh-mind-system');
ok(bare.length === 1, `裸名入口恰好一个（实际 ${bare.length}）——客户端扫描靠它，多了多源冲突`);
const subpathEntries = names.filter((n) => n.startsWith('dsh-mind-system/'));
ok(subpathEntries.length === MEMBERS.length, `子路径装载点 ${MEMBERS.length} 个（实际 ${subpathEntries.length}）`);

console.log('\n--- 3. 成员装载点与 MEMBERS 一致（含顺序）---');
const declared = names.filter((n) => n !== 'dsh-mind-system');
ok(
  JSON.stringify(declared) === JSON.stringify(MEMBERS),
  `patch 的装载点与 index.js 的 MEMBERS 完全一致（含顺序）\n` +
    `    patch: ${JSON.stringify(declared)}\n` +
    `    清单 : ${JSON.stringify(MEMBERS)}`,
);
for (const component of CLIS_COMPONENTS) {
  ok(names.includes(component), `装载 ${component}（clis 四组件，缺一工具包不激活）`);
}
// 顺序：服务提供者先于消费者
const idx = (n) => names.indexOf(n);
ok(
  CLIS_COMPONENTS.every((c) => idx(c) !== -1 && idx(c) < idx('dsh-mind-system/clis')),
  'clis 四组件先于 clis 工具包',
);
ok(
  idx('dsh-mind-system/clis') !== -1 && idx('dsh-mind-system/meta-framework') !== -1 && idx('dsh-mind-system/clis') < idx('dsh-mind-system/meta-framework'),
  'clis 先于 meta-framework（meta 依赖 clis 分类器）',
);
ok(
  idx('dsh-mind-system/agent-mind') !== -1 && idx('dsh-mind-system/agent-mind') < idx('dsh-mind-system'),
  'mind 先于合成包自身（自己最后收口）',
);

console.log('\n--- 4. exports 映射齐全且目标存在 ---');
const exportsMap = pkg.exports ?? {};
for (const member of MEMBERS) {
  const sub = '.' + member.slice('dsh-mind-system'.length);
  const target = exportsMap[sub];
  ok(target !== undefined, `exports['${sub}'] 存在（成员 ${member}）`);
  if (target !== undefined) {
    ok(existsSync(join(pkgRoot, target.replace('./', ''))), `exports['${sub}'] 目标文件存在：${target}`);
  }
}
ok(exportsMap['./client'] !== undefined, "exports['./client'] 存在（记忆面板客户端）");
ok(
  exportsMap['./client'] !== undefined && existsSync(join(pkgRoot, exportsMap['./client'].replace('./', ''))),
  `client 目标文件真实存在：${exportsMap['./client'] ?? '(缺失)'}`,
);

console.log('\n--- 5. 成员子目录齐全 ---');
const MEMBER_ENTRY = {
  clis: ['index.js', 'clis-classifier.js', 'clis-strategy.js', 'clis-feedback.js', 'clis-orchestrator.js'],
  meta: ['index.js', join('src', 'tools.js')],
  memory: ['server.js', 'health-inbox.js', 'client.js'],
  mind: ['index.js', join('src', 'orchestrate.js')],
};
for (const dir of MEMBER_PACKAGES) {
  ok(existsSync(join(pkgRoot, dir)), `成员子目录 ${dir}/ 在包内`);
  for (const f of MEMBER_ENTRY[dir] ?? []) {
    ok(existsSync(join(pkgRoot, dir, f)), `${dir}/${f} 存在`);
  }
}

console.log('\n--- 6. 客户端声明 ---');
ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform === web');
ok(pkg.dsh?.client?.immediately === true, 'dsh.client.immediately === true（面板随启动装载）');

console.log(failures === 0 ? '\npublish-check: ALL PASS' : `\npublish-check: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
