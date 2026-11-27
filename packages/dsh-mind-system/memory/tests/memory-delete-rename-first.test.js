// Rename-first deletion for the lower distilled layers (L1/L2/L3).
// Every fixture lives in its own mkdtemp root; the real ~/.dsh is never touched.
// The delete must preserve bytes a concurrent writer appends around the atomic
// rename, keep a complete R26 receipt, and report index cleanup separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { LEDGER_REL, readLedger, contentHash } from '../src/write-ledger.js';

const ZONES = [
  { zone: 'functions', layer: 'L2', slug: 'rename-first-function', body: '# Rename first function\n\n术层正文。\n' },
  { zone: 'insights', layer: 'L1', slug: 'rename-first-insight', body: '# Rename first insight\n\n法层正文。\n' },
  { zone: 'capabilities', layer: 'L3', slug: 'rename-first-capability', body: '# Rename first capability\n\n器层正文。\n' },
];

const HEADINGS = {
  functions: ['## 功能模块索引', '| 功能域 | 摘要 |', '|---|---|'],
  insights: ['## 创新优化思想索引', '| 思想主题 | 内涵 |', '|---|---|'],
  capabilities: ['## 能力台账 细节子目录', '| 能力 | 用途 |', '|---|---|'],
};

function indexText() {
  return [
    '# 索引', ...HEADINGS.functions, `| [rename-first-function](functions/rename-first-function.md) | target |`,
    ...HEADINGS.insights, `| [rename-first-insight](insights/rename-first-insight.md) | target |`,
    ...HEADINGS.capabilities, `| [rename-first-capability](capabilities/rename-first-capability.md) | target |`,
    '## 其他', '| 行 | 保留 |', '',
  ].join('\n');
}

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'memory-delete-rename-first-'));
  const root = path.join(base, 'memory');
  const skillRoot = path.join(base, 'skills');
  await mkdir(skillRoot, { recursive: true });
  for (const { zone } of ZONES) await mkdir(path.join(root, zone), { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), indexText(), 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const tools = new Map(), noop = () => {};
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    set() {}, get: () => undefined, on: () => noop, emit() {},
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = apply(ctx, {
    memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh',
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0,
  });
  t.after(async () => {
    dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir()));
    assert.match(path.basename(base), /^memory-delete-rename-first-/);
    await rm(base, { recursive: true, force: true });
  });
  async function seed(zone, slug, body) {
    await writeFile(path.join(root, zone, `${slug}.md`), body, 'utf8');
  }
  return {
    base, root, skillRoot, seed,
    tool: tools.get('memory_delete'),
    read: tools.get('memory_read'),
    source: (zone, slug) => path.join(root, zone, `${slug}.md`),
    archive: (zone, slug) => path.join(root, zone, '_deleted', `${slug}.md`),
    deletedDir: (zone) => path.join(root, zone, '_deleted'),
    ledger: path.join(root, LEDGER_REL),
  };
}

async function contentsOrMissing(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Byte + directory snapshot for the "no writes on validation error" cases.
async function snapshot(root) {
  const files = new Map();
  const dirs = [];
  const walk = async (current) => {
    for (const entry of (await fs.promises.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { dirs.push(rel); await walk(full); }
      else files.set(rel, await readFile(full));
    }
  };
  await walk(root);
  return { dirs: dirs.sort(), files: [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
}

function sameSnapshot(a, b) {
  if (JSON.stringify(a.dirs) !== JSON.stringify(b.dirs)) return false;
  if (a.files.length !== b.files.length) return false;
  return a.files.every(([name, bytes], i) => name === b.files[i][0] && bytes.equals(b.files[i][1]));
}

// ---- 1) happy path for every zone -----------------------------------------
for (const { zone, layer, slug, body } of ZONES) test(`${zone}: rename-first delete archives bytes, writes R26 receipt, removes index row`, { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  const result = await f.tool.execute({ zone, name: slug });
  assert.equal(result.deleted, true, JSON.stringify(result));
  assert.equal(result.layer, layer);
  assert.equal(result.source, `${zone}/${slug}.md`);
  assert.equal(result.archive, `${zone}/_deleted/${slug}.md`);
  assert.deepEqual(result.warnings, []);
  assert.equal(await contentsOrMissing(f.source(zone, slug)), null, 'source must be gone');
  const archived = await readFile(f.archive(zone, slug), 'utf8');
  assert.ok(archived.startsWith(body.trimEnd()), 'original bytes must survive verbatim');
  assert.match(archived, /## 删除/);
  assert.match(archived, new RegExp(`- 层：${layer}`));
  assert.match(archived, /- 工具：memory_delete/);
  const sourceKey = `${zone}/${slug}.md`;
  const archiveKey = `${zone}/_deleted/${slug}.md`;
  const ledger = await readLedger(f.root);
  assert.equal(ledger.get(sourceKey)?.op, 'delete');
  assert.equal(typeof ledger.get(sourceKey)?.id, 'string');
  assert.equal(ledger.get(sourceKey)?.to, archiveKey);
  assert.equal(ledger.get(archiveKey)?.hash, contentHash(archived));
  assert.equal(ledger.get(archiveKey)?.tool, 'memory_delete');
  const raw = await readFile(f.ledger, 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  const id = ledger.get(sourceKey)?.id;
  assert.ok(rows.some((row) => row.key === sourceKey && row.op === 'delete_intent' && row.id === id && row.to === archiveKey));
  assert.ok(rows.some((row) => row.key === sourceKey && row.op === 'delete' && row.id === id));
  assert.ok(rows.some((row) => row.key === archiveKey && row.op === undefined && row.hash === contentHash(archived)));
  const index = await readFile(path.join(f.root, 'MEMORY.md'), 'utf8');
  assert.doesNotMatch(index, new RegExp(`${zone}/${slug}\\.md`));
  assert.match(index, /## 其他\n\| 行 \| 保留 \|/);
});

// ---- 2) dao is still refused, with no writes -------------------------------
test('dao zone refuses with human_gate_required and writes nothing', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'dao'), { recursive: true });
  await writeFile(path.join(f.root, 'dao', 'baz.md'), '# Dao\n\naxiom\n', 'utf8');
  const before = await snapshot(f.root);
  await assert.rejects(f.tool.execute({ zone: 'dao', name: 'baz' }), (error) => error.code === 'human_gate_required');
  assert.ok(sameSnapshot(before, await snapshot(f.root)), 'dao refusal must not write anything');
});

// ---- 3) validation errors: original codes, no writes -----------------------
test('invalid slug, missing name, unsupported zone and nonexistent entry fail without writes', async (t) => {
  const f = await fixture(t);
  await f.seed('functions', 'rename-first-function', ZONES[0].body);
  const before = await snapshot(f.root);
  await assert.rejects(f.tool.execute({ zone: 'functions', name: '../escape' }), (error) => error.code === 'invalid_name');
  await assert.rejects(f.tool.execute({ zone: 'functions', name: '' }), (error) => error.code === 'invalid_name');
  await assert.rejects(f.tool.execute({ zone: 'daily', name: '2026-11-25' }), (error) => error.code === 'unsupported_zone');
  await assert.rejects(f.tool.execute({ zone: 'functions', name: 'does-not-exist' }), (error) => error.code === 'safe_delete_unavailable');
  assert.ok(sameSnapshot(before, await snapshot(f.root)), 'validation errors must not write anything');
});

// ---- 4) idempotent residue: archive already holds the same body ------------
test('same-body archive residue quarantines the source and leaves the archive untouched', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, layer, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  await mkdir(f.deletedDir(zone), { recursive: true });
  const note = '\n\n## 删除\n\n- 时间：2026-11-24T00:00:00.000Z\n- 层：L2\n- 工具：memory_delete\n';
  const archiveBefore = body.trimEnd() + note;
  await writeFile(f.archive(zone, slug), archiveBefore, 'utf8');
  const result = await f.tool.execute({ zone, name: slug });
  assert.equal(result.deleted, true, JSON.stringify(result));
  assert.equal(result.layer, layer);
  assert.ok(result.warnings.some((w) => /隔离|手工|MEMORY\.md/.test(w)));
  assert.equal(await contentsOrMissing(f.source(zone, slug)), null, 'residual source must be gone');
  assert.equal(await readFile(f.archive(zone, slug), 'utf8'), archiveBefore, 'archive must stay byte-identical');
  const entries = (await fs.promises.readdir(f.deletedDir(zone))).filter((n) => n.endsWith('.dropped'));
  assert.equal(entries.length, 1, 'exactly one quarantine');
  assert.equal(await readFile(path.join(f.deletedDir(zone), entries[0]), 'utf8'), body, 'quarantine holds original bytes');
  const ledger = await readLedger(f.root);
  assert.equal(ledger.get(`${zone}/${slug}.md`)?.op, 'delete');
  assert.equal(ledger.get(`${zone}/_deleted/${slug}.md`)?.hash, contentHash(archiveBefore));
});

// ---- 5) different archive body: 409-equivalent refusal ---------------------
test('different-body archive refuses and leaves both source and archive untouched', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  await mkdir(f.deletedDir(zone), { recursive: true });
  const oldArchive = '历史归档，绝不覆盖\n';
  await writeFile(f.archive(zone, slug), oldArchive, 'utf8');
  const sourceBefore = await readFile(f.source(zone, slug));
  await assert.rejects(f.tool.execute({ zone, name: slug }), (error) => error.code === 'archive_exists' && /历史归档/.test(error.message));
  assert.ok((await readFile(f.source(zone, slug))).equals(sourceBefore), 'source must stay byte-identical');
  assert.equal(await readFile(f.archive(zone, slug), 'utf8'), oldArchive, 'archive must stay byte-identical');
  assert.equal((await fs.promises.readdir(f.deletedDir(zone))).filter((n) => n.endsWith('.dropped')).length, 0);
});

test('archive target that is a directory refuses with a stable code', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  await mkdir(f.archive(zone, slug), { recursive: true });
  await assert.rejects(f.tool.execute({ zone, name: slug }), (error) => error.code === 'MEMORY_DELETE_ARCHIVE_TARGET_INVALID');
  assert.equal(await readFile(f.source(zone, slug), 'utf8'), body);
});

// ---- 6/7) real child-process concurrency, both orders, 6 iterations --------
function spawnAppender(home, zone, slug, order, payload, readyFile, goFile) {
  const script = `
const fs = require('node:fs');
const [home, order, payload, ready, go] = process.argv.slice(1);
const file = require('node:path').join(home, 'memory', '${zone}', '${slug}.md');
const wait = (f) => new Promise((res) => { const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); res(); } }, 5); });
(async () => {
  if (order === 'pre') {
    const fd = fs.openSync(file, 'a');
    fs.writeFileSync(ready, 'ready');
    await wait(go);
    fs.writeSync(fd, payload, null, 'utf8');
    fs.closeSync(fd);
  } else {
    fs.writeFileSync(ready, 'ready');
    await wait(go);
    const fd = fs.openSync(file, 'a');
    fs.writeSync(fd, payload, null, 'utf8');
    fs.closeSync(fd);
  }
})().catch((e) => { console.error(e); process.exit(1); });
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, home, order, payload, readyFile, goFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (buf) => { stderr += String(buf); });
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== 0) reject(new Error(`appender exit ${code}: ${stderr}`)); else resolve(code); });
  });
}

async function waitFor(file, gone) {
  const deadline = Date.now() + 10000;
  while (gone ? existsSync(file) : !existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${gone ? 'rename' : file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const { zone: RZ, slug: RS, body: RB } = ZONES[0];
for (const order of ['pre', 'post']) {
  for (let iteration = 0; iteration < 6; iteration += 1) {
    test(`concurrent ${order} append #${iteration + 1}: payload is never lost`, { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
      const f = await fixture(t);
      await f.seed(RZ, RS, RB);
      const readyFile = path.join(f.base, 'ready.flag');
      const goFile = path.join(f.base, 'go.flag');
      const payload = `\n<!-- concurrent-${order}-${iteration} -->\n`;
      let child;
      if (order === 'pre') {
        child = spawnAppender(f.base, RZ, RS, 'pre', payload, readyFile, goFile);
        await waitFor(readyFile, false); // handle is open on the live inode
      }
      const deleting = f.tool.execute({ zone: RZ, name: RS });
      if (order === 'post') {
        child = spawnAppender(f.base, RZ, RS, 'post', payload, readyFile, goFile);
        await waitFor(readyFile, false);
      }
      // Release only after the rename, so pre writes into the archived inode
      // and post writes into a freshly created source file.
      await waitFor(f.source(RZ, RS), true);
      writeFileSync(goFile, 'go');
      const result = await deleting;
      await child;
      assert.equal(result.deleted, true, JSON.stringify(result));
      if (order === 'pre') {
        const archived = await readFile(f.archive(RZ, RS), 'utf8');
        assert.ok(archived.includes(payload.trim()), `pre payload must survive in archive (#${iteration + 1})`);
      } else {
        const fresh = await contentsOrMissing(f.source(RZ, RS));
        assert.ok(fresh !== null && fresh.includes(payload.trim()), `post payload must survive in a fresh source (#${iteration + 1})`);
        assert.ok(!(await readFile(f.archive(RZ, RS), 'utf8')).includes(payload.trim()), 'post payload must not be silently merged into the archive');
      }
    });
  }
}

// ---- 8) ledger failure injection ------------------------------------------
test('ledger append failure after rename returns a stable error, never a fake success', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  const original = fs.promises.appendFile;
  let injected = 0;
  fs.promises.appendFile = async (target, data, ...args) => {
    if (String(target).endsWith(LEDGER_REL) && String(data).includes('"op":"delete_intent"')) {
      injected++;
      throw Object.assign(new Error('injected ledger failure'), { code: 'EIO' });
    }
    return original.call(fs.promises, target, data, ...args);
  };
  syncBuiltinESMExports();
  let error;
  try {
    await assert.rejects(f.tool.execute({ zone, name: slug }), (err) => {
      error = err;
      return true;
    });
  } finally { fs.promises.appendFile = original; syncBuiltinESMExports(); }
  assert.equal(injected, 1, 'the ledger failure must actually be injected');
  assert.equal(error?.code, 'MEMORY_DELETE_LEDGER_UNKNOWN');
  assert.equal(error?.ledgerStatus, 'unknown');
  assert.equal(await contentsOrMissing(f.source(zone, slug)), null, 'rename already committed');
  const archived = await readFile(f.archive(zone, slug), 'utf8');
  assert.ok(archived.startsWith(body.trimEnd()), 'archived bytes stay intact');
});

test('lost ledger acknowledgement returns an error, never deleted:true', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  const original = fs.promises.appendFile;
  let injected = 0;
  fs.promises.appendFile = async (target, data, ...args) => {
    if (!injected && String(target).endsWith(LEDGER_REL) && String(data).includes('"op":"delete"')) {
      injected++;
      await original.call(fs.promises, target, data, ...args); // record really landed
      const err = new Error('simulated lost ledger acknowledgement');
      err.code = 'EIO';
      throw err; // recordDeleteEvent swallows this and returns false
    }
    return original.call(fs.promises, target, data, ...args);
  };
  syncBuiltinESMExports();
  let error;
  try {
    await assert.rejects(f.tool.execute({ zone, name: slug }), (err) => { error = err; return true; });
  } finally { fs.promises.appendFile = original; syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  assert.equal(error?.code, 'MEMORY_DELETE_LEDGER_UNKNOWN');
  assert.ok(archivedBytesIntact(await readFile(f.archive(zone, slug), 'utf8'), body));
  assert.equal(await contentsOrMissing(f.source(zone, slug)), null);
});

function archivedBytesIntact(archived, body) { return archived.startsWith(body.trimEnd()); }

// ---- 9) index failure: delete succeeds, warning says manual cleanup --------
test('index update failure returns deleted:true with a manual-cleanup warning and no false claim', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  const indexPath = path.join(f.root, 'MEMORY.md');
  const original = fs.promises.rename;
  let injected = 0;
  fs.promises.rename = async (from, to, ...args) => {
    if (path.resolve(String(to)) === indexPath) {
      injected++;
      throw Object.assign(new Error('injected index write failure'), { code: 'EIO' });
    }
    return original.call(fs.promises, from, to, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await f.tool.execute({ zone, name: slug });
  } finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(injected, 1, 'the index write failure must actually be injected');
  assert.equal(result.deleted, true, 'the committed delete must still be reported as done');
  assert.equal(result.layer, 'L2');
  assert.ok(result.warnings.some((w) => /MEMORY\.md.*手工清理/.test(w)), JSON.stringify(result.warnings));
  assert.ok(!result.warnings.some((w) => /已更新|已清理索引/.test(w)), 'no false claim of index update');
  assert.equal(await contentsOrMissing(f.source(zone, slug)), null);
  assert.match(await readFile(f.archive(zone, slug), 'utf8'), /术层正文/);
  assert.match(await readFile(indexPath, 'utf8'), new RegExp(`${zone}/${slug}\\.md`), 'index still needs manual cleanup');
  assert.equal((await readLedger(f.root)).get(`${zone}/${slug}.md`)?.op, 'delete');
});

test('missing MEMORY.md is not recreated by a successful delete', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { zone, slug, body } = ZONES[0];
  const f = await fixture(t);
  await f.seed(zone, slug, body);
  await rm(path.join(f.root, 'MEMORY.md'));
  const result = await f.tool.execute({ zone, name: slug });
  assert.equal(result.deleted, true);
  assert.equal(await contentsOrMissing(path.join(f.root, 'MEMORY.md')), null);
});
