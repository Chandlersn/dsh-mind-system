/**
 * publish-check.mjs 的变异测试——守"检查本身不可证伪"。
 *
 * 守法：对 patch 做各种破坏，每次检查都必须**变红**；
 * 全绿只能证明没坏，不能证明检查真的在看——所以每个用例
 * 都先破坏、再要求退出码非零。
 */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  // 复制 patch（变异版）
  writeFileSync(join(dir, 'cordis.patch.yml'), mutate(readFileSync(realPatch, 'utf8')), 'utf8');
  // 复制脚本与其 import 的 ../index.js —— 那份没坏，保持真身
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(realScript, join(dir, 'scripts', 'publish-check.mjs'));
  copyFileSync(join(pkgRoot, 'index.js'), join(dir, 'index.js'));
  // 合成包的检查会核对包内成员子目录与 exports 目标 —— 整包拷贝（测试沙盒里一次性）
  cpSync(pkgRoot, dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.git') });
  // 拷贝后重新写入变异 patch（cpSync 会覆盖）
  writeFileSync(join(dir, 'cordis.patch.yml'), mutate(readFileSync(realPatch, 'utf8')), 'utf8');
  return {
    dir,
    run: () =>
      spawnSync(process.execPath, [join(dir, 'scripts', 'publish-check.mjs')], {
        encoding: 'utf8',
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('删掉 clis 子组件后检查必须变红（上一版照样 PASS 的教训）', () => {
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-mind-system\/clis-strategy'.*$/m, ''),
  );
  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0, `删掉 clis-strategy 装载点后必须失败，输出：\n${out}`);
    assert.ok(out.includes('clis-strategy'), `失败信息必须点名缺失的组件，实际输出：\n${out}`);
  } finally {
    mutated.cleanup();
  }
});

test('把子组件挪到工具包之后也必须变红（顺序断言不是摆设）', () => {
  const mutated = makeMutatedCopy((text) => {
    const lines = text.split('\n');
    const strategyIdx = lines.findIndex((l) => /name:\s*'dsh-mind-system\/clis-strategy'/.test(l));
    const [strategyLine] = lines.splice(strategyIdx, 1);
    const toolsIdx = lines.findIndex((l) => /name:\s*'dsh-mind-system\/clis'/.test(l));
    lines.splice(toolsIdx + 1, 0, strategyLine);
    return lines.join('\n');
  });
  try {
    const result = mutated.run();
    assert.notEqual(result.status, 0, '顺序错了（组件在工具包之后）必须失败');
  } finally {
    mutated.cleanup();
  }
});

test('删掉整个成员装载点（meta-framework）也必须变红', () => {
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-mind-system\/meta-framework'.*$/m, ''),
  );
  try {
    const result = mutated.run();
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0, '删掉一个成员装载点必须失败');
    assert.ok(out.includes('meta-framework'), `失败信息必须点名缺失的成员：\n${out}`);
  } finally {
    mutated.cleanup();
  }
});

test('删掉合成包自身的裸名入口必须变红（客户端锚点丢失）', () => {
  const mutated = makeMutatedCopy((text) =>
    text.replace(/^.*name:\s*'dsh-mind-system'.*$/m, ''),
  );
  try {
    const result = mutated.run();
    assert.notEqual(result.status, 0, '删掉裸名入口必须失败');
  } finally {
    mutated.cleanup();
  }
});

test('证明过程中真 patch 原封不动', () => {
  const content = readFileSync(realPatch, 'utf8');
  for (const required of MEMBERS_LIST()) {
    assert.ok(
      content.includes(`name: '${required}'`),
      `真 patch 必须仍含 ${required} —— 证明过程不该碰真文件`,
    );
  }
});

function MEMBERS_LIST() {
  // 从真 index.js 读清单（避免本文件成为第二份事实来源）
  const src = readFileSync(join(pkgRoot, 'index.js'), 'utf8');
  const block = /export const MEMBERS = \[([\s\S]*?)\];/u.exec(src)[1];
  return [...block.matchAll(/'([^']+)'/gu)].map((m) => m[1]);
}
