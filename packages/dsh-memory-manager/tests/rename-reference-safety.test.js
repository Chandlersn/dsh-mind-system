import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the tool registered by the real plugin against an isolated home.
// No user memory or installed package is changed by these fixtures.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-rename-reference-'));
  const root = path.join(home, 'memory');
  const functions = path.join(root, 'functions');
  const skills = path.join(home, 'skills');
  await mkdir(functions, { recursive: true });
  await mkdir(skills, { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-rename-reference-'));
    await rm(home, { recursive: true, force: true });
  });

  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 测试索引', '', '## 功能模块索引', '',
    '| 功能域 | 一句话状态 / 待验证 |', '|---|---|',
    '| [目标](functions/目标.md) | 已有目标摘要 |',
    '| [来源](functions/来源.md) | 合并来源摘要 |', '',
  ].join('\n'));
  await writeFile(path.join(functions, '来源.md'), '# 来源\n\n## [2026-11-01] 来源记录\n\n- 来源内容。\n');
  await writeFile(path.join(functions, '目标.md'), '# 目标\n\n## [2026-11-02] 目标记录\n\n- 目标内容。\n');

  const tools = [];
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => (tools.push(definition), noop) },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const entry = process.env.DSH_RENAME_TEST_ENTRY;
  const { apply } = await import(entry ? pathToFileURL(path.resolve(entry)).href : '../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(() => dispose());
  const tool = tools.find((item) => item?.name === 'memory_rename' && typeof item.execute === 'function');
  assert.ok(tool, 'apply 必须注册真实 memory_rename 执行器');
  return { root, functions, rename: () => tool.execute({ from: '来源', to: '目标' }, {}) };
}

// Recursive byte + directory snapshot: a paused merge must leave the root
// exactly as it found it (no reference rewrite, no index rewrite, no staging).
async function snapshot(root) {
  const files = new Map();
  const dirs = [];
  const walk = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { dirs.push(rel); await walk(full); }
      else files.set(rel, await readFile(full));
    }
  };
  await walk(root);
  return { dirs: dirs.sort(), files };
}

// Every case below asserted the RESULT of a merge. Merging is paused, so the
// shared contract is now: refuse with the pause code and change nothing. The
// per-case fixtures and the content each one protects are kept as they were.
async function assertMergePaused(f) {
  const before = await snapshot(f.root);
  await assert.rejects(f.rename(), (error) => error.code === 'safe_rename_unavailable' && /无损改名能力尚不可用/.test(error.message));
  const after = await snapshot(f.root);
  assert.deepEqual(after.dirs, before.dirs, '合并暂停不得创建任何目录');
  assert.deepEqual([...after.files.keys()].sort(), [...before.files.keys()].sort(), '合并暂停不得增删文件');
  for (const [rel, bytes] of before.files) assert.deepEqual(after.files.get(rel), bytes, `${rel} 必须逐字节不变`);
}

test('无关功能文件不同章节里同名目标行均应保留', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.functions, '无关章节.md');
  const before = '# 独立功能\n\n## 第一章\n\n| 名称 | 内容 |\n|---|---|\n| 目标 | 第一章独有数据 |\n\n## 第二章\n\n| 名称 | 内容 |\n|---|---|\n| 目标 | 第二章独有数据 |\n';
  await writeFile(file, before);
  await assertMergePaused(f);
  assert.equal(await readFile(file, 'utf8'), before, '无关文件必须逐字节不变');
});

test('无来源引用的文件必须逐字节不变', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.functions, '只读旁支.md');
  // CRLF also makes line-ending changes observable independently of content.
  const before = Buffer.from('# 独立文件\r\n\r\n## 甲\r\n| 目标 | 甲表 |\r\n\r\n## 乙\r\n| 目标 | 乙表 |\r\n', 'utf8');
  await writeFile(file, before);
  await assertMergePaused(f);
  assert.deepEqual(await readFile(file), before, '未引用来源的文件不得被去重或改写');
});

test('显示文字与来源同名但指向其他文件的链接不得改名', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.functions, '其他引用.md');
  const before = '# 引用不同对象\n\n[来源](其他功能.md) 是其他对象的展示名。\n\n| 名称 | 摘要 |\n|---|---|\n| [来源](其他功能.md) | 不指向来源文件 |\n';
  await writeFile(file, before);
  await writeFile(path.join(f.functions, '其他功能.md'), '# 其他功能\n');
  await assertMergePaused(f);
  assert.equal(await readFile(file, 'utf8'), before, '链接目的地不属于来源时应保持原文');
});

test('真实旧引用改写和目标功能索引去重仍然可用', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.functions, '真正引用.md');
  const before = '# 真实引用\n\n请看 [旧功能](来源.md)。\n';
  await writeFile(file, before);
  // Reference rewriting and index dedupe are post-guard: with the merge paused
  // both are unreachable, and that must be visible as "nothing moved", not as
  // a silent success. The case is kept so the intent is not lost.
  await assertMergePaused(f);
  assert.equal(await readFile(file, 'utf8'), before, '旧引用必须保持指向来源，不得提前改写');
  const index = await readFile(path.join(f.root, 'MEMORY.md'), 'utf8');
  assert.match(index, /\[来源\]\(functions\/来源\.md\)/, '索引来源行必须原样保留');
  assert.match(index, /\[目标\]\(functions\/目标\.md\)/, '索引目标行必须原样保留');
});
