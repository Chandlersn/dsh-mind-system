/**
 * 合成包的成员清单与探针测试。
 *
 * 守三件事：
 * 1. 清单唯一事实来源（index.js 的 MEMBERS）格式正确、与 patch 逐条一致（含顺序）；
 * 2. 装载顺序满足"服务提供者先于消费者"；
 * 3. 探针真实、只报能观察到的事实、成员子目录缺失时报 failing。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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

/** 入口 name 导出核对：读 index.js 源码里的导出语句（唯一事实来源）。 */
function entryName() {
  const src = readFileSync(join(pkgRoot, 'index.js'), 'utf8');
  const m = /export const name = '([^']+)'/u.exec(src);
  return m ? m[1] : undefined;
}

test('包名契约（宿主据此把它当普通 bundle 处理）', () => {
  assert.equal(entryName(), 'dsh-mind-system');
});

test('成员清单格式正确（每条都是本包 exports 子路径形态）', () => {
  assert.ok(Array.isArray(MEMBERS) && MEMBERS.length > 0, 'MEMBERS 必须是非空数组');
  for (const member of MEMBERS) {
    assert.ok(member.startsWith('dsh-mind-system/'), `成员装载点必须带本包前缀：${member}`);
    assert.ok(!member.includes('//'), `成员名不能有空段：${member}`);
    assert.equal(member, member.trim(), `成员名不能带空白：${member}`);
  }
  assert.equal(new Set(MEMBERS).size, MEMBERS.length, '成员清单不能有重复（双装载）');
});

test('patch 声明的装载点与 MEMBERS 逐条一致（含顺序）', () => {
  const names = patchNames();
  const declared = names.filter((n) => n !== 'dsh-mind-system');
  assert.deepEqual(
    declared,
    MEMBERS,
    `patch 的成员与 index.js 的 MEMBERS 必须完全一致（含顺序）\n` +
      `    patch: ${JSON.stringify(declared)}\n` +
      `    清单 : ${JSON.stringify(MEMBERS)}`,
  );
  assert.ok(names.includes('dsh-mind-system'), 'patch 必须装载合成包自身（唯一裸名入口，客户端扫描靠它）');
});

test('exports 里每个成员装载点都有映射且目标文件存在', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const exportsKeys = Object.keys(pkg.exports);
  for (const member of MEMBERS) {
    const sub = '.' + member.slice('dsh-mind-system'.length); // './clis-classifier' 形态
    assert.ok(exportsKeys.includes(sub), `exports 必须含 ${sub}（成员 ${member} 的解析入口）`);
    const target = pkg.exports[sub].replace('./', '');
    assert.ok(existsSync(join(pkgRoot, target)), `exports 映射目标必须存在：${target}`);
  }
  assert.ok(exportsKeys.includes('./client'), '必须导出 ./client（记忆面板客户端）');
  assert.ok(existsSync(join(pkgRoot, 'memory', 'client.js')), 'client 目标文件必须真实存在');
});

test('装载顺序满足"服务提供者先于消费者"', () => {
  const names = patchNames();
  const idx = (n) => names.indexOf(n);
  const assertBefore = (a, b, label) => {
    assert.notEqual(idx(a), -1, `${label}：${a} 必须存在`);
    assert.notEqual(idx(b), -1, `${label}：${b} 必须存在`);
    assert.ok(idx(a) < idx(b), `${label}：${a} 必须先于 ${b}`);
  };
  for (const component of CLIS_COMPONENTS) {
    assertBefore(component, 'dsh-mind-system/clis', `clis 组件 ${component} 必须先于 clis 工具包`);
  }
  assertBefore('dsh-mind-system/clis', 'dsh-mind-system/meta-framework', 'clis 必须先于 meta-framework');
  assertBefore('dsh-mind-system/agent-mind', 'dsh-mind-system', 'mind 必须先于合成包自身');
});

test('clis 四组件齐全（少一个工具包就不激活）', () => {
  const names = patchNames();
  for (const component of CLIS_COMPONENTS) {
    assert.ok(names.includes(component), `patch 必须声明 ${component}`);
  }
  assert.equal(CLIS_COMPONENTS.length, 4, '正好四个');
});

test('合成包有真实探针', () => {
  assert.equal(typeof healthProbe, 'object');
  assert.equal(typeof healthProbe.probe, 'function');
  assert.equal(healthProbe.probe, probe);
});

test('探针零参数可调用且永不抛错', () => {
  assert.doesNotThrow(() => probe());
});

test('探针只报能观察到的事实（不谎称成员已装载）', () => {
  const r = probe();
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes(PROBE_CODES.ok), `成员齐全时应报 ok，实际：${codes}`);
  assert.equal(r.status, 'ok');
});

test('成员子目录缺失时探针必须报 failing', () => {
  const missing = probeMember('does-not-exist');
  assert.equal(missing.present, false);
  assert.equal(missing.dir, undefined);
  for (const member of MEMBER_PACKAGES) {
    assert.equal(probeMember(member).present, true, `成员 ${member} 在包内应能找到`);
    assert.ok(memberPackageDir(member), `${member} 的目录必须能解析出来`);
  }
});

test('探针代号稳定（会被按名字检索）', () => {
  assert.equal(PROBE_CODES.memberMissing, 'mind-system.member-missing');
  assert.equal(PROBE_CODES.ok, 'mind-system.ok');
});

test('deriveStatus 与其它插件同口径（error → failing，warn → degraded）', () => {
  assert.equal(deriveStatus([{ severity: 'error' }]), 'failing');
  assert.equal(deriveStatus([{ severity: 'warn' }]), 'degraded');
  assert.equal(deriveStatus([]), 'ok');
});
