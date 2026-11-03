/**
 * 聚合包的成员清单与探针测试（缺陷 4 / 6 / 10）。
 *
 * ## 缺陷 4：成员清单写在三个地方，三种形状
 *
 * - `index.js` 导出 `MEMBERS`（8 条子路径）—— 此前**零引用者**，是死代码
 * - `publish-check.mjs` 的三处字面量（4 个基本名，顺序还不同）
 * - patch YAML 的 9 个 `name:` 条目
 *
 * 现在 `index.js` 是唯一事实来源。这组测试守住它：
 * 清单本身格式正确、patch 与清单**逐条一致**、基本名清单由清单派生。
 *
 * ## 缺陷 6：`test` 脚本跑零个测试还退出 0
 *
 * `package.json` 声明 `"test": "node --test test/*.test.js"` 但没有 `test/` 目录
 * → "pass 0, fail 0, exit 0"。CI 接上它就**无条件通过**。
 *
 * 这组测试就是那个 `test/` 目录 —— 它现在真的存在、真的有断言。
 *
 * ## 缺陷 10：`MEMBERS` 顺序注释与 patch 实际顺序不符
 *
 * 注释说的顺序必须与 patch YAML 的实际顺序一致 —— 装载顺序本身就是承诺。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name,
  inject,
  MEMBERS,
  MEMBER_PACKAGES,
  CLIS_COMPONENTS,
  PROBE_CODES,
  healthProbe,
  probe,
  probeMember,
  deriveStatus,
  memberPackageDir,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const patchText = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');

/** 从 patch YAML 里解析出所有 `name:` 条目（跳过注释行）。 */
function patchNames() {
  return patchText
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => [...line.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));
}

test('包名与 inject 契约（宿主据此把它当普通 bundle 处理）', () => {
  assert.equal(name, 'dsh-mind-system');
  assert.deepEqual(inject, [], '聚合包不注入任何服务');
});

test('成员清单格式正确（每条都是 dsh-* 的装载点形态）', () => {
  assert.ok(Array.isArray(MEMBERS) && MEMBERS.length > 0, 'MEMBERS 必须是非空数组');
  for (const member of MEMBERS) {
    assert.equal(typeof member, 'string', `成员名必须是字符串：${member}`);
    assert.ok(member.startsWith('dsh-'), `成员名必须以 dsh- 开头：${member}`);
    assert.ok(!member.includes('//'), `成员名不能有空段：${member}`);
    assert.equal(member, member.trim(), `成员名不能带空白：${member}`);
  }
  // 不允许重复 —— 重复会让宿主装载两次（双装载）
  assert.equal(
    new Set(MEMBERS).size,
    MEMBERS.length,
    `成员清单不能有重复：${JSON.stringify(MEMBERS)}`,
  );
});

test('缺陷 4：patch 声明的装载点与 MEMBERS 逐条一致（含顺序）', () => {
  const names = patchNames();
  const declared = names.filter((n) => n !== 'dsh-mind-system');

  assert.deepEqual(
    declared,
    MEMBERS,
    `patch 的成员与 index.js 的 MEMBERS 必须完全一致（含顺序）\n` +
      `    patch: ${JSON.stringify(declared)}\n` +
      `    清单 : ${JSON.stringify(MEMBERS)}`,
  );
  assert.ok(names.includes('dsh-mind-system'), 'patch 必须装载聚合包自身');
});

test('缺陷 4：MEMBER_PACKAGES 由 MEMBERS 派生（不是另写一份清单）', () => {
  assert.deepEqual(
    MEMBER_PACKAGES,
    [...new Set(MEMBERS.map((m) => m.split('/')[0]))],
    '基本名清单必须由 MEMBERS 派生 —— 另写一份就会漂',
  );
  assert.equal(MEMBER_PACKAGES.length, 4, '四个成员包');
  for (const pkg of MEMBER_PACKAGES) {
    assert.ok(!pkg.includes('/'), `基本名不能带子路径：${pkg}`);
  }
});

test('缺陷 4：仓库里不再有第二份成员字面量（publish-check 从这里 import）', () => {
  // publish-check.mjs 必须**import** 清单，而不是自己写一份。
  const script = readFileSync(join(pkgRoot, 'scripts', 'publish-check.mjs'), 'utf8');
  assert.ok(
    script.includes("from '../index.js'"),
    'publish-check 必须从 index.js import 成员清单（唯一事实来源）',
  );
  assert.ok(
    script.includes('MEMBER_PACKAGES'),
    'publish-check 必须用 import 来的 MEMBER_PACKAGES',
  );

  // 脚本里不能出现手写的成员数组字面量
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/\[\s*'dsh-clis'\s*,/.test(code),
    'publish-check 里不能有手写的成员数组 —— 那会变成第二份清单',
  );
  assert.ok(
    !/\['dsh-clis',\s*'dsh-agent-mind'/.test(code),
    'publish-check 里不能有手写的成员数组（哪怕顺序不同）',
  );
});

test('缺陷 10：装载顺序满足"服务提供者先于消费者"', () => {
  const names = patchNames();
  const idx = (n) => names.indexOf(n);

  // 每条顺序断言都要先确认**两个都存在**（这正是缺陷 3 的教训）
  const assertBefore = (a, b, label) => {
    assert.notEqual(idx(a), -1, `${label}：${a} 必须存在`);
    assert.notEqual(idx(b), -1, `${label}：${b} 必须存在`);
    assert.ok(idx(a) < idx(b), `${label}：${a} 必须先于 ${b}`);
  };

  // clis 四组件 → clis 工具包（工具包的 inject 依赖那四个服务）
  for (const component of CLIS_COMPONENTS) {
    assertBefore(component, 'dsh-clis', `clis 组件 ${component} 必须先于 clis 工具包`);
  }
  // clis → meta-framework（meta 运行时取 clis 的分类器）
  assertBefore('dsh-clis', 'dsh-meta-framework', 'clis 必须先于 meta-framework');
  // mind → 聚合包自身（自己最后收口）
  assertBefore('dsh-agent-mind', 'dsh-mind-system', 'mind 必须先于聚合包自身');
});

test('缺陷 10：clis 四组件齐全（少一个工具包就不激活）', () => {
  const names = patchNames();
  for (const component of CLIS_COMPONENTS) {
    assert.ok(
      names.includes(component),
      `patch 必须声明 ${component} —— clis 工具包的 inject 依赖这四个服务`,
    );
  }
  assert.equal(CLIS_COMPONENTS.length, 4, '正好四个');
});

test('缺陷 6：聚合包有真实探针（此前完全没有 healthProbe）', () => {
  assert.equal(typeof healthProbe, 'object', '必须导出 healthProbe 对象');
  assert.equal(typeof healthProbe.probe, 'function', 'healthProbe 必须含 probe()');
  assert.equal(healthProbe.probe, probe, 'healthProbe.probe 必须就是那个探针');
});

test('缺陷 6：探针零参数可调用且永不抛错', () => {
  // 监督层以零参数调用 —— 探针不能依赖参数
  assert.doesNotThrow(() => probe());
});

test('缺陷 6：探针只报**能观察到**的事实（不谎称成员已装载）', () => {
  const r = probe();
  const codes = r.findings.map((f) => f.code);

  assert.ok(codes.includes(PROBE_CODES.ok), `成员齐全时应报 ok，实际：${codes}`);
  const ok = r.findings.find((f) => f.code === PROBE_CODES.ok);
  assert.ok(
    ok.message.includes('不**声称它们在真宿主里已装载'),
    `必须说清"不声称已装载"—— 那是它观察不到的事实，实际：${ok.message}`,
  );
  assert.ok(
    ok.message.includes('只看得到仓库里的成员'),
    '必须说清观察范围只是仓库里的成员，实际：' + ok.message,
  );
  assert.equal(r.status, 'ok');
});

test('缺陷 6：成员缺失时探针必须报 failing（不装绿牌）', () => {
  // 造一个不存在的成员 → 探针必须报缺失
  const missing = probeMember('dsh-does-not-exist');
  assert.equal(missing.present, false, '不存在的成员必须被认出来');
  assert.equal(missing.dir, undefined);

  // probeMember 对真实成员必须报 present
  for (const member of MEMBER_PACKAGES) {
    assert.equal(
      probeMember(member).present,
      true,
      `成员 ${member} 在仓库里应该能找到`,
    );
    assert.ok(memberPackageDir(member), `${member} 的目录必须能解析出来`);
  }
});

test('缺陷 6：探针代号稳定（会被按名字检索）', () => {
  assert.equal(PROBE_CODES.memberMissing, 'mind-system.member-missing');
  assert.equal(PROBE_CODES.ok, 'mind-system.ok');
  for (const [key, code] of Object.entries(PROBE_CODES)) {
    assert.ok(code.startsWith('mind-system.'), `${key} 必须带包名前缀：${code}`);
    assert.equal(code, code.toLowerCase(), `${key} 不能含大写`);
  }
});

test('deriveStatus 与其它插件同口径（error → failing，warn → degraded）', () => {
  assert.equal(deriveStatus([{ severity: 'error' }]), 'failing');
  assert.equal(deriveStatus([{ severity: 'warn' }]), 'degraded');
  assert.equal(deriveStatus([{ severity: 'info' }]), 'ok');
  assert.equal(deriveStatus([]), 'ok');
  assert.equal(deriveStatus([{ severity: 'info' }, { severity: 'error' }]), 'failing');
});
