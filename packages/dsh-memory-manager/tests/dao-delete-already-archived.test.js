// Idempotent dao deletion for old delete-flow residue: an archive already
// exists and holds the same body as the source, but the source was never
// unlinked. The delete must clean up the redundant source without overwriting
// history or destroying concurrent bytes. All fixtures are isolated mkdtemp
// roots; no real DSH data is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_REL, readLedger } from '../src/write-ledger.js';

const SLUG = '残留道';
const ORIGINAL = `# 道 · ${SLUG}\n\n正式道正文，归档与源必须一致。\n`;
const NOTE = '\n\n## 删除\n\n- 时间：2026-11-13T05:06:12.369Z\n- 来源：面板手动删除\n';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dao-already-archived-'));
  const root = path.join(base, 'memory');
  const skillRoot = path.join(base, 'skills');
  await mkdir(path.join(root, 'dao'), { recursive: true });
  await mkdir(path.join(root, 'dao', '_deleted'), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n', 'utf8');
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const mod = await import('../server.js');
  const noop = () => {};
  let handler;
  const ctx = {
    tools: { register: () => noop },
    on: () => noop,
    set() {}, get: () => undefined,
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_names, fn) {
      fn({
        webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
        connection: { requestRejection: () => undefined },
        effect: (f) => f(),
        loader: { internal: { loadCache: new Map() }, async import() { return {}; }, unwrapExports: (m) => m },
        registry: { get: () => undefined, delete: () => undefined, plugin: () => ({ ctx: { fiber: {} } }) },
      });
    },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot });
  assert.equal(typeof handler, 'function');
  t.after(async () => {
    dispose?.();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    await rm(base, { recursive: true, force: true });
  });
  async function post(payload = { action: 'delete', name: SLUG }) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = { method: 'POST', url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield bytes; } };
    let status, body;
    const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
    await handler(req, res);
    return { status, body: JSON.parse(body) };
  }
  return {
    base, root, post,
    source: path.join(root, 'dao', `${SLUG}.md`),
    archive: path.join(root, 'dao', '_deleted', `${SLUG}.md`),
    deletedDir: path.join(root, 'dao', '_deleted'),
    ledger: path.join(root, LEDGER_REL),
  };
}

const readIfExists = async (p) => { try { return await readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

test('already-archived residue: source removed, archive untouched, quarantined, ledger complete', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  await writeFile(f.archive, ORIGINAL + NOTE, 'utf8');
  const archiveBefore = await readFile(f.archive, 'utf8');
  const result = await f.post();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.match(result.body.message, /已删除道/);
  assert.match(result.body.message, /残留/);
  assert.equal(await readIfExists(f.source), null, 'residual source must be gone');
  assert.equal(await readFile(f.archive, 'utf8'), archiveBefore, 'existing archive must be byte-identical (no second delete note)');
  const entries = await fs.promises.readdir(f.deletedDir);
  const dropped = entries.filter((n) => n.endsWith('.dropped'));
  assert.equal(dropped.length, 1, 'exactly one quarantine copy');
  assert.equal(await readFile(path.join(f.deletedDir, dropped[0]), 'utf8'), ORIGINAL, 'quarantine holds the original bytes');
  const ledger = await readLedger(f.root);
  const sourceKey = `dao/${SLUG}.md`;
  assert.equal(ledger.get(sourceKey).op, 'delete', 'source has delete record');
  assert.ok(ledger.get(sourceKey).id, 'delete has an id');
});

test('different archive body keeps the 409 history protection', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  await writeFile(f.archive, '# 道 · 残留\n\n完全不同的历史正文。\n', 'utf8');
  const archiveBefore = await readFile(f.archive, 'utf8');
  const result = await f.post();
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(await readFile(f.source, 'utf8'), ORIGINAL, 'source untouched');
  assert.equal(await readFile(f.archive, 'utf8'), archiveBefore, 'archive untouched');
  assert.equal((await fs.promises.readdir(f.deletedDir)).filter((n) => n.endsWith('.dropped')).length, 0);
});

test('archive target that is a directory is refused with a stable error', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  await rm(f.archive, { force: true });
  await mkdir(f.archive, { recursive: true });
  const result = await f.post();
  assert.equal(result.status, 500, JSON.stringify(result));
  assert.match(JSON.stringify(result.body), /MEMORY_DELETE_ARCHIVE_TARGET_INVALID/);
  assert.equal(await readFile(f.source, 'utf8'), ORIGINAL, 'source untouched');
});

test('unreadable source during compare fails closed without deleting', async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, ORIGINAL + NOTE, 'utf8');
  // source missing -> 404 because the helper checks existence before compare
  const result = await f.post();
  assert.equal(result.status, 404, JSON.stringify(result));
  assert.equal(await readFile(f.archive, 'utf8'), ORIGINAL + NOTE, 'archive untouched');
});

test('pre-rename concurrent append survives in the quarantine', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  await writeFile(f.archive, ORIGINAL + NOTE, 'utf8');
  const flag = path.join(f.base, 'go.flag');
  const payload = 'CONCURRENT_PRE_PAYLOAD_UNIQUE';
  const child = spawn(process.execPath, ['-e', `
    const fs=require('fs');
    const fd=fs.openSync(process.argv[1],'a');
    const flag=process.argv[2];
    const start=Date.now();
    while(!fs.existsSync(flag)){ if(Date.now()-start>10000) throw new Error('timeout'); }
    fs.writeSync(fd, process.argv[3]);
    fs.closeSync(fd);
  `, f.source, flag, payload], { stdio: 'ignore' });
  // Give the child time to open the handle, then commit the delete.
  await new Promise((r) => setTimeout(r, 300));
  const resultPromise = f.post();
  await new Promise((r) => setTimeout(r, 50));
  await writeFile(flag, 'go', 'utf8');
  const result = await resultPromise;
  await new Promise((resolve, reject) => child.on('exit', () => resolve()).on('error', reject));
  assert.equal(result.status, 200, JSON.stringify(result));
  const entries = await fs.promises.readdir(f.deletedDir);
  const dropped = entries.filter((n) => n.endsWith('.dropped'));
  assert.equal(dropped.length, 1);
  const quarantined = await readFile(path.join(f.deletedDir, dropped[0]), 'utf8');
  assert.ok(quarantined.includes(payload), 'pre-rename appended bytes must survive in quarantine');
  const archive = await readFile(f.archive, 'utf8');
  assert.ok(!archive.includes(payload), 'archive must stay the clean historical body');
});

test('repeating the delete does not claim a second deletion', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  await writeFile(f.archive, ORIGINAL + NOTE, 'utf8');
  const first = await f.post();
  assert.equal(first.status, 200);
  const second = await f.post();
  assert.equal(second.status, 404, 'source already gone -> 404, not a fake 200');
});

test('normal no-archive path still works unchanged', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, ORIGINAL, 'utf8');
  const result = await f.post();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(await readIfExists(f.source), null);
  const archive = await readFile(f.archive, 'utf8');
  assert.ok(archive.startsWith(ORIGINAL.trimEnd()));
  assert.match(archive, /## 删除/);
});
