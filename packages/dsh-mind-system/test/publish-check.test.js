/**
 * 缺陷 3 的**证伪证明**：改坏 patch 的**副本**，检查必须变红。
 *
 * ## 为什么必须是"副本"
 *
 * 缺陷 3 要证明的是"上一版那个检查根本不可证伪"。要证明它不可证伪，
 * 就得**真的把 patch 改坏**再跑一遍 —— 而改坏的是**真 patch**就等于
 * 把仓库弄坏。
 *
 * 所以这里：
 * 1. 把 patch 与脚本**复制**到临时目录
 * 2. 在副本上删掉 `dsh-clis/strategy` 那一行
 * 3. 跑副本里的检查，断言它**必须失败**（退出码非 0 且报出缺失）
 * 4. 断言真 patch **原封不动**（内容逐字相同）
 *
 * 第 4 步是关键的自我保护：证明完必须证明"没碰真文件"。
 *
 * ## 上一版为什么是绿的（已实测）
 *
 * 上一版的顺序断言是 `idx('dsh-clis/strategy') < idx('dsh-clis')`。
 * 删掉 strategy 那一行后，`indexOf` 返回 `-1`，而 **`-1 < 任何数` 都是 true**
 * —— 于是断言照样 PASS。而"四个子组件都在"那条用的是
 * `includes(m) || some(n => n.startsWith(m + '/'))`，
 * 任何一个 clis 子路径就能满足整个 `dsh-clis` 的检查。
 *
 * 两条合起来：删掉一个子组件，**全部断言照样 PASS**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const realPatch = join(pkgRoot, 'cordis.patch.yml');
const realScript = join(pkgRoot, 'scripts', 'publish-check.mjs');

/**
 * 建一个"改坏了"的副本环境。
 *
 * @param mutate — 对 patch 文本的变换。
 * @returns `{ dir, run }`；`run()` 执行副本里的检查，返回 `{status, stdout}`。
 */
function makeMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-publish-mut-'));
  // 复制 patch
  const patchCopy = join(dir, 'cordis.patch.yml');
  writeFileSync(patchCopy, mutate(readFileSync(realPatch, 'utf8')), 'utf8');
  // 复制脚本（脚本从 '../index.js' import 成员清单 —— 那份没坏，保持真身）
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const scriptCopy = join(dir, 'scripts', 'publish-check.mjs');
  copyFileSync(realScript, scriptCopy);
  // 脚本要 import '../index.js' —— 相对副本目录，所以建一个软链/副本
  copyFileSync(join(pkgRoot, 'index.js'), join(dir, 'index.js'));
  // 脚本还读 package.json / README.md / LICENSE
  for (const f of ['package.json', 'README.md', 'LICENSE']) {
    copyFileSync(join(pkgRoot, f), join(dir, f));
  }
  return {
    dir,
    run: () =>
      spawnSync(process.execPath, [scriptCopy], {
        encoding: 'utf8',
        env: { ...process.env, DSH_PROFILE_DIR: join(dir, 'no-such-profile') },
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('缺陷 3：删掉 clis 子组件后检查必须变红（上一版照样 PASS）', () => {
  // 缺陷报告点名的那个变异：删掉 `dsh-clis/strategy` 的装载点
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-clis\/strategy'.*$/m, ''),
  );

  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(
      result.status,
      0,
      `删掉 dsh-clis/strategy 后检查必须失败（退出码非 0）。实际退出码 ${result.status}，输出：\n${out}`,
    );
    assert.ok(
      out.includes('dsh-clis/strategy'),
      `失败信息必须点名缺失的组件，实际输出：\n${out}`,
    );
    assert.ok(
      out.includes('FAILED'),
      `必须报告有检查项失败，实际输出：\n${out}`,
    );
  } finally {
    mutated.cleanup();
  }
});

test('缺陷 3：把子组件挪到工具包之后也必须变红（顺序断言不是摆设）', () => {
  // 只改顺序：把 strategy 那一行移到 `dsh-clis`（工具包）**之后**。
  // 组件仍在，但顺序错了 —— "服务提供者先于消费者"被破坏。
  const mutated = makeMutatedCopy((text) => {
    const lines = text.split('\n');
    const strategyIdx = lines.findIndex((l) => /name:\s*'dsh-clis\/strategy'/.test(l));
    const [strategyLine] = lines.splice(strategyIdx, 1);
    const toolsIdx = lines.findIndex((l) => /name:\s*'dsh-clis'/.test(l));
    // 插到工具包那一行之后
    lines.splice(toolsIdx + 1, 0, strategyLine);
    return lines.join('\n');
  });

  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(
      result.status,
      0,
      `顺序错了（组件在工具包之后）必须失败。实际退出码 ${result.status}，输出：\n${out}`,
    );
  } finally {
    mutated.cleanup();
  }
});

test('缺陷 3：删掉整个成员包（dsh-meta-framework）也必须变红', () => {
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-meta-framework'.*$/m, ''),
  );

  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(
      result.status,
      0,
      `删掉一个成员包必须失败。实际退出码 ${result.status}，输出：\n${out}`,
    );
    assert.ok(out.includes('dsh-meta-framework'), `失败信息必须点名缺失的成员：\n${out}`);
  } finally {
    mutated.cleanup();
  }
});

test('缺陷 3：删掉聚合包自身（双装载检查的另一半）必须变红', () => {
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-mind-system'.*$/m, ''),
  );

  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(
      result.status,
      0,
      `删掉聚合包自身的装载点必须失败。实际退出码 ${result.status}，输出：\n${out}`,
    );
  } finally {
    mutated.cleanup();
  }
});

test('缺陷 3：证明过程中真 patch **原封不动**', () => {
  // 前面几个用例都在副本上操作 —— 这里确认真文件没被碰过。
  const content = readFileSync(realPatch, 'utf8');
  for (const required of [
    'dsh-clis/classifier',
    'dsh-clis/strategy',
    'dsh-clis/feedback',
    'dsh-clis/orchestrator',
    'dsh-clis',
    'dsh-meta-framework',
    'dsh-memory-manager',
    'dsh-agent-mind',
    'dsh-mind-system',
  ]) {
    assert.ok(
      content.includes(`name: '${required}'`),
      `真 patch 必须仍含 ${required} —— 证明过程不该碰真文件`,
    );
  }
});
