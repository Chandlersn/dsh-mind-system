import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'federation-readonly-'));
  const prior = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const memoryRoot = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  const fed = path.join(home, 'not-created', 'federation');
  const roots = [path.join(home, 'project-a'), path.join(home, 'project-b'), path.join(home, 'project-c')];
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  for (const [i, root] of roots.entries()) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'MEMORY.md'), `# project ${i}\n`, 'utf8');
  }
  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR,
    federation: { root: fed, projects: roots.map((root, i) => ({ key: `p${i}`, root })) } });
  const tool = registered.get('memory_federation');
  assert.equal(typeof tool?.execute, 'function', 'real registered federation tool');
  t.after(async () => {
    if (typeof dispose === 'function') dispose();
    if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^federation-readonly-/);
    await rm(home, { recursive: true, force: true });
  });
  return { home, fed, roots, tool };
}

async function snapshot(root) {
  const out = [];
  async function visit(dir, relative = '') {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, e.name);
      if (e.isDirectory()) { out.push(['dir', rel]); await visit(path.join(dir, e.name), rel); }
      else if (e.isFile()) out.push(['file', rel, (await readFile(path.join(dir, e.name))).toString('base64')]);
      else out.push(['other', rel]);
    }
  }
  await visit(root);
  return out;
}

async function inject(method, faults, fn) {
  const original = fs.promises[method];
  const hits = new Map();
  fs.promises[method] = async (target, ...args) => {
    const key = path.resolve(String(target));
    const code = faults.get(key);
    if (code) {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      throw Object.assign(new Error(`injected ${code}`), { code });
    }
    return original.call(fs.promises, target, ...args);
  };
  syncBuiltinESMExports();
  try { return await fn(hits); }
  finally { fs.promises[method] = original; syncBuiltinESMExports(); }
}
async function observeMutations(fn) {
  const names = ['mkdir', 'writeFile', 'appendFile', 'open', 'rename', 'link', 'unlink', 'rm', 'rmdir', 'truncate'];
  const originals = new Map(names.map((name) => [name, fs.promises[name]]));
  const calls = [];
  for (const name of names) {
    fs.promises[name] = async (...args) => { calls.push(name); return originals.get(name).apply(fs.promises, args); };
  }
  syncBuiltinESMExports();
  try { const result = await fn(); assert.deepEqual(calls, [], 'read-only check must not call mutating filesystem operations'); return result; }
  finally { for (const name of names) fs.promises[name] = originals.get(name); syncBuiltinESMExports(); }
}
const warning = (res, rule, ...terms) => res.findings.some((f) => f.rule === rule && f.level === 'WARN' && terms.every((s) => f.message.includes(s)));
const missing = (res, rule, term) => res.findings.some((f) => f.rule === rule && f.level === 'FAIL' && f.message.includes(term));

test('check 缺少联邦根不创建文件或目录；sync 正控可创建并同步', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.home);
  const check = await observeMutations(() => f.tool.execute({ action: 'check' }, {}));
  assert.deepEqual(await snapshot(f.home), before, 'check must not create even an ancestor directory');
  assert.ok(missing(check, 'F1', 'MEMORY.md'));
  assert.ok(warning(check, 'F2', '未检查', '未知'));
  assert.ok(warning(check, 'F4', '未检查', '未知'));
  assert.equal(check.projects.length, 3);
  assert.ok(check.projects.every((p) => p.sourceStatus === 'present' && p.copyStatus === 'missing'));
  const synced = await f.tool.execute({ action: 'sync' }, {});
  assert.ok(synced.projects.every((p) => p.copied && p.copyStatus === 'present'));
  assert.equal(await readFile(path.join(f.fed, 'sources', 'p2.MEMORY.md'), 'utf8'), '# project 2\n');
  const afterSync = await snapshot(f.home);
  const clean = await f.tool.execute({ action: 'check' }, {});
  assert.equal(clean.failCount, 0);
  assert.equal(clean.warnCount, 0);
  const rendered = f.tool.output.render({ action: 'check' }, clean).map((b) => b.text).join('\n');
  assert.match(rendered, /副本存在（未比较内容）/);
  assert.doesNotMatch(rendered, /已同步/);
  assert.deepEqual(await snapshot(f.home), afterSync, 'existing federation check is read-only too');
});

test('F2/F3/F4 的 EIO/EACCES 显示未知，并继续真实缺失和后续项目', async (t) => {
  const f = await fixture(t);
  await f.tool.execute({ action: 'sync' }, {});
  const index = path.join(f.fed, 'MEMORY.md');
  const brokenCopy = path.join(f.fed, 'sources', 'p0.MEMORY.md');
  const missingCopy = path.join(f.fed, 'sources', 'p1.MEMORY.md');
  await rm(missingCopy);
  const badAbs = path.join(f.home, 'unreadable-absolute');
  const missingAbs = path.join(f.home, 'missing-absolute');
  const missingLink = 'sources/actually-missing.md';
  await writeFile(index, `${await readFile(index, 'utf8')}\n[missing](${missingLink})\n\`${badAbs}\`\n\`${missingAbs}\`\n`, 'utf8');
  await writeFile(path.join(f.fed, 'sources', 'orphan.MEMORY.md'), '# orphan\n');
  const before = await snapshot(f.home);
  for (const code of ['EIO', 'EACCES']) {
    const faults = new Map([[path.resolve(brokenCopy), code], [path.resolve(badAbs), code]]);
    await inject('stat', faults, async (hits) => {
      const out = await f.tool.execute({ action: 'check' }, {});
      assert.ok(hits.get(path.resolve(brokenCopy)) >= 2, 'copy and F2 link each invoke real stat');
      assert.ok(hits.get(path.resolve(badAbs)) >= 1);
      assert.ok(warning(out, 'F3', 'p0', code, '未知'));
      assert.equal(out.projects[0].copyStatus, 'unknown');
      assert.ok(warning(out, 'F2', 'p0.MEMORY.md', code, '未知'));
      assert.ok(warning(out, 'F4', code, '未知', badAbs));
      assert.ok(missing(out, 'F3', 'p1.MEMORY.md'), 'actual missing source copy remains a failure');
      assert.ok(missing(out, 'F2', missingLink), 'actual dangling link remains a failure');
      assert.ok(warning(out, 'F4', '不存在', missingAbs), 'actual missing absolute path remains reported');
      assert.equal(out.projects[2].copyStatus, 'present', 'subsequent project was checked');
      assert.ok(warning(out, 'F5', 'orphan'));
    });
  }
  assert.deepEqual(await snapshot(f.home), before);
});

test('项目源和索引读取故障与副本目录枚举故障分别报告未知范围', async (t) => {
  const f = await fixture(t);
  await f.tool.execute({ action: 'sync' }, {});
  const index = path.join(f.fed, 'MEMORY.md');
  const source = path.join(f.roots[0], 'MEMORY.md');
  await writeFile(path.join(f.fed, 'sources', 'orphan.MEMORY.md'), '# orphan\n');
  const before = await snapshot(f.home);
  await inject('readFile', new Map([[path.resolve(source), 'EACCES'], [path.resolve(index), 'EIO']]), async (hits) => {
    const out = await f.tool.execute({ action: 'check' }, {});
    assert.ok(hits.get(path.resolve(source)) && hits.get(path.resolve(index)));
    assert.ok(warning(out, 'F3', 'p0', 'EACCES', '未知'));
    assert.equal(out.projects[0].sourceStatus, 'unknown');
    assert.ok(!missing(out, 'F3', '项目 p0 的记忆根里没有'));
    assert.ok(warning(out, 'F1', 'EIO', '未知'));
    for (const rule of ['F2', 'F3', 'F4']) assert.ok(warning(out, rule, '未检查', '未知'));
    assert.equal(out.projects[2].sourceStatus, 'present');
    assert.ok(warning(out, 'F5', 'orphan'), 'F5 runs independently of unreadable index');
  });
  for (const code of ['EIO', 'EACCES']) {
    await inject('readdir', new Map([[path.resolve(path.join(f.roots[0], 'functions')), code]]), async (hits) => {
      const out = await f.tool.execute({ action: 'check' }, {});
      assert.ok(hits.get(path.resolve(path.join(f.roots[0], 'functions'))));
      assert.ok(warning(out, 'F3', 'p0', code, '数量未知'));
      assert.equal(out.projects[0].countStatus, 'unknown');
      assert.equal(out.projects[2].countStatus, 'known', 'later project counts remain checked');
    });
  }
  await inject('readdir', new Map([[path.resolve(path.join(f.fed, 'sources')), 'EACCES']]), async (hits) => {
    const out = await f.tool.execute({ action: 'check' }, {});
    assert.ok(hits.get(path.resolve(path.join(f.fed, 'sources'))));
    assert.ok(warning(out, 'F5', 'EACCES', '未检查', '未知'));
    assert.equal(out.projects[2].sourceStatus, 'present');
  });
  assert.deepEqual(await snapshot(f.home), before);
});
