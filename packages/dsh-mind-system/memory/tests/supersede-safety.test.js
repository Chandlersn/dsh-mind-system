import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every invocation goes through the real registered tool and an isolated home.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-supersede-safety-'));
  const root = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  for (const dir of ['functions', 'insights', 'dao']) await mkdir(path.join(root, dir), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  for (const name of ['来源甲', '来源乙']) await writeFile(path.join(root, 'functions', `${name}.md`), `# ${name}\n`, 'utf8');
  const laws = ['法甲', '法乙', '法丙', '法丁', '法戊'];
  for (const name of laws) await writeFile(path.join(root, 'insights', `${name}.md`), `# ${name}\n\n## 核心原则\n\n- 互相独立的测试原则。\n`, 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-supersede-safety-'));
    await rm(home, { recursive: true, force: true });
  });
  const tools = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(dispose);
  assert.equal(typeof tools.get('memory_insight')?.execute, 'function');
  assert.equal(typeof tools.get('memory_dao')?.execute, 'function');
  return { home, root, tools, laws };
}

async function snapshot(dir, base = dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(file, base));
    else if (entry.isFile()) out[path.relative(base, file)] = await readFile(file);
    else throw new Error(`unexpected test fixture entry: ${file}`);
  }
  return out;
}

const body = '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n';
function params(kind, target, supersedes, laws) {
  if (kind === 'memory_insight') return {
    theme: target, supersedes, principle: '互相独立的证据共同限制推断范围', summary: '测试摘要',
    sources: ['来源甲', '来源乙'], applicability: '适用于多源判断；不适用于没有观测依据的情形。',
  };
  return {
    name: target, supersedes, status: 'active',
    proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: laws, body,
  };
}

for (const [kind, zone] of [['memory_insight', 'insights'], ['memory_dao', 'dao']]) {
  test(`${kind}: 自我 supersedes 在任何文件改变前被拒绝`, async (t) => {
    const f = await fixture(t);
    const existing = path.join(f.root, zone, 'Same.md');
    const original = Buffer.from('# 原文件\r\n\r\n不得修改的字节。\r\n');
    await writeFile(existing, original);
    const before = await snapshot(f.home);
    for (const [target, supersedes] of [['Same', 'Same'], ['Same', 'Same.md'], ['NewSelf', 'NewSelf']]) {
      await assert.rejects(f.tools.get(kind).execute(params(kind, target, supersedes, f.laws), {}), /supersedes.*DIFFERENT/i);
      assert.deepEqual(await readFile(existing), original);
      await assert.rejects(readFile(path.join(f.root, zone, 'NewSelf.md')), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(f.home), before, '不允许修改索引、账本或其他任何文件');
    }
  });

  test(`${kind}: 非法 supersedes 对已有目标和新目标都在写入前拒绝`, async (t) => {
    const f = await fixture(t);
    const existing = path.join(f.root, zone, 'Existing.md');
    const original = Buffer.from('# 原目标\r\n原有字节不能变化。\r\n');
    await writeFile(existing, original);
    const before = await snapshot(f.home);
    for (const target of ['Existing', 'NewTarget']) {
      await assert.rejects(f.tools.get(kind).execute(params(kind, target, '../越界', f.laws), {}), /slug|invalid|path|invalid characters/i);
      assert.deepEqual(await readFile(existing), original);
      await assert.rejects(readFile(path.join(f.root, zone, 'NewTarget.md')), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(f.home), before, '拒绝后整个隔离目录的文件必须不变');
    }
  });

  test(`${kind}: Windows 大小写别名不能取代自身`, { skip: process.platform !== 'win32' ? 'Windows 专属路径语义' : false }, async (t) => {
    const f = await fixture(t);
    const existing = path.join(f.root, zone, 'MixedCase.md');
    const alias = path.join(f.root, zone, 'mixedcase.md');
    const original = Buffer.from('# 大小写别名\r\n不得变化。\r\n');
    await writeFile(existing, original);
    assert.deepEqual(await readFile(alias), original, '先验证测试目录确实大小写不敏感');
    const before = await snapshot(f.home);
    await assert.rejects(f.tools.get(kind).execute(params(kind, 'MixedCase', 'mixedcase', f.laws), {}), /supersedes.*DIFFERENT/i);
    assert.deepEqual(await readFile(existing), original);
    assert.deepEqual(await readFile(alias), original);
    assert.deepEqual(await snapshot(f.home), before);
  });

  test(`${kind}: 正常不同名 supersedes 可以完成`, async (t) => {
    const f = await fixture(t);
    const old = path.join(f.root, zone, 'OldEntry.md');
    const target = path.join(f.root, zone, 'NewEntry.md');
    await writeFile(old, '# 旧条目\n\n旧正文仍须保留。\n');
    const result = await f.tools.get(kind).execute(params(kind, 'NewEntry', 'OldEntry', f.laws), {});
    assert.ok(result, '正常合法操作应返回结果');
    assert.ok((await readFile(target, 'utf8')).length > 0, '新条目应被真实写入');
    const oldText = await readFile(old, 'utf8');
    assert.match(oldText, /旧正文仍须保留/);
    assert.match(oldText, /已被取代/);
  });
}
