// Rename-first dao deletion: the user-facing delete must succeed without
// losing bytes a concurrent writer appends around the commit point.
// Every fixture lives in its own mkdtemp root; no real DSH data is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText } from '../src/util.js';
import { LEDGER_REL, readLedger, contentHash } from '../src/write-ledger.js';

const SLUG = '重命名删除测试';
const SOURCE_REL = `dao/${SLUG}.md`;
const ARCHIVE_REL = `dao/_deleted/${SLUG}.md`;
const ORIGINAL = `# 道 · ${SLUG}\n\n> 命题\n\n正式道原文，删除后必须逐字节留档。\n`;

// Register the real panel route with a synthetic authenticated connection,
// the same pattern the other panel tests use.
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dao-delete-rename-first-'));
  const root = path.join(base, 'memory');
  const skillRoot = path.join(base, 'skills');
  await mkdir(path.join(root, 'dao'), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const mod = await import('../server.js');
  const noop = () => {};
  let handler;
  let authCalls = 0;
  const ctx = {
    tools: { register: () => noop },
    on: () => noop,
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_names, fn) {
      fn({
        webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
        connection: { requestRejection() { authCalls++; return undefined; } },
        effect: (fn2) => fn2(),
      });
    },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot });
  assert.equal(typeof handler, 'function', 'the real panel route must be registered');
  t.after(async () => {
    dispose?.();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir()));
    assert.match(path.basename(base), /^dao-delete-rename-first-/);
    await rm(base, { recursive: true, force: true });
  });
  async function post(payload, { method = 'POST', authenticated = true } = {}) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = { method, url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield bytes; } };
    let status;
    let body;
    const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
    const before = authCalls;
    // A missing auth connection is a separate fixture; default uses the real one.
    await handler(req, res);
    return { status, body: JSON.parse(body), authCalls: authCalls - before };
  }
  return {
    base, root, skillRoot, post,
    source: path.join(root, SOURCE_REL),
    archive: path.join(root, ARCHIVE_REL),
    ledger: path.join(root, LEDGER_REL),
    async seed(text = ORIGINAL) { await writeText(path.join(root, SOURCE_REL), text, { memoryRoot: root, tool: 'test' }); },
  };
}

async function contentsOrMissing(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Recursive byte + directory snapshot for the "no writes on validation error"
// assertions. Ledger files are included so an accidental append is visible.
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

// ---- 1) happy path --------------------------------------------------------
test('valid dao delete returns 200, archives original bytes, and writes a complete R26 receipt', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const result = await f.post({ action: 'delete', name: SLUG });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.message, `已删除道 · ${SLUG}（已留档到 dao/_deleted/）`);
  assert.equal(result.body.archived, ARCHIVE_REL);
  assert.match(result.body.note, /memory_index/);
  assert.equal(await contentsOrMissing(f.source), null, 'source must be gone');
  const archived = await readFile(f.archive, 'utf8');
  assert.ok(archived.startsWith(ORIGINAL.trimEnd()), 'original bytes must be preserved verbatim');
  assert.match(archived, /## 删除/);
  assert.match(archived, /来源：面板手动删除/);
  const ledger = await readLedger(f.root);
  assert.equal(ledger.get(SOURCE_REL)?.op, 'delete', 'source key must end with delete');
  assert.equal(typeof ledger.get(SOURCE_REL)?.id, 'string');
  assert.equal(ledger.get(SOURCE_REL)?.to, ARCHIVE_REL);
  assert.equal(ledger.get(ARCHIVE_REL)?.hash, contentHash(archived), 'archive write hash must match bytes on disk');
  assert.equal(ledger.get(ARCHIVE_REL)?.tool, 'dao-action:delete');
});

// ---- 2) archive collision -------------------------------------------------
test('existing archive returns 409 without overwriting history or touching the source', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  await mkdir(path.dirname(f.archive), { recursive: true });
  const oldArchive = '历史归档，绝不覆盖\n';
  await writeFile(f.archive, oldArchive, 'utf8');
  const sourceBefore = await readFile(f.source);
  const result = await f.post({ action: 'delete', name: SLUG });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /已有同名历史归档/);
  assert.ok((await readFile(f.source)).equals(sourceBefore), 'source must stay byte-identical');
  assert.equal(await readFile(f.archive, 'utf8'), oldArchive, 'earlier archive must stay byte-identical');
});

// ---- 3) validation errors: original errors, no writes ---------------------
test('missing name, bad slug, nonexistent dao, non-POST and missing auth keep original errors and write nothing', async (t) => {
  const f = await fixture(t);
  await f.seed();
  const before = await snapshot(f.root);
  // safeSlug throws for an empty or unsafe name; the handler has always mapped
  // that to its 500 panelError shape. Preserve that original error exactly.
  const badName = await f.post({ action: 'delete', name: '' });
  assert.equal(badName.status, 500);
  assert.match(badName.body.error, /slug must be a non-empty string/);
  const badSlug = await f.post({ action: 'delete', name: '../escape' });
  assert.equal(badSlug.status, 500);
  assert.match(badSlug.body.error, /invalid slug/);
  const missing = await f.post({ action: 'delete', name: '不存在的道' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /道条目不存在/);
  const nonPost = await f.post({ action: 'delete', name: SLUG }, { method: 'GET' });
  assert.equal(nonPost.status, 405);
  assert.equal(nonPost.body.error, 'POST only');
  assert.ok(sameSnapshot(before, await snapshot(f.root)), 'validation errors must not write anything');
});

test('missing auth connection returns the original 501 for the write route', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'dao-delete-no-auth-'));
  const root = path.join(base, 'memory');
  await mkdir(path.join(root, 'dao'), { recursive: true });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const mod = await import('../server.js');
    const noop = () => {};
    let handler;
    const ctx = {
      tools: { register: () => noop }, on: () => noop,
      systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
      inject(_names, fn) {
        fn({ webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } }, effect: (fn2) => fn2() });
      },
    };
    const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: path.join(base, 'skills') });
    const bytes = Buffer.from(JSON.stringify({ action: 'delete', name: SLUG }), 'utf8');
    const req = { method: 'POST', url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield bytes; } };
    let status; let body;
    await handler(req, { writeHead(code) { status = code; }, end(value) { body = value; } });
    assert.equal(status, 501);
    assert.match(JSON.parse(body).error, /宿主未提供 connection/);
    dispose?.();
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    await rm(base, { recursive: true, force: true });
  }
});

// ---- 4) concurrent append, both orders, 6 iterations each -----------------
// The child is a REAL process with a flag-file handshake.
// pre: it opens a handle on the source before the rename, then writes after
//      the parent releases `go`; those bytes must survive in the archive.
// post: it waits for the rename, opens the old path (creating a fresh file),
//      then writes; those bytes must remain in dao/<slug>.md.
function spawnAppender(home, order, payload, readyFile, goFile) {
  const script = `
const fs = require('node:fs');
const [home, order, payload, ready, go] = process.argv.slice(1);
const file = require('node:path').join(home, 'memory', 'dao', '${SLUG}.md');
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

// Async polling: the panel delete runs in this process's event loop, so a
// blocking Atomics.wait here would deadlock it. setTimeout yields instead.
async function waitFor(file, source, gone) {
  const deadline = Date.now() + 10000;
  while (gone ? existsSync(file) : !existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${gone ? 'rename' : file} (source still ${existsSync(source)})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const order of ['pre', 'post']) {
  for (let iteration = 0; iteration < 6; iteration += 1) {
    test(`concurrent append ${order} #${iteration + 1}: payload survives rename-first`, { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
      const f = await fixture(t);
      await f.seed();
      const readyFile = path.join(f.base, 'ready.flag');
      const goFile = path.join(f.base, 'go.flag');
      const payload = `\n<!-- concurrent-${order}-${iteration} -->\n`;
      let child;
      if (order === 'pre') {
        child = spawnAppender(f.base, 'pre', payload, readyFile, goFile);
        await waitFor(readyFile, f.source, false); // handle is open on the live inode
      }
      const deleting = f.post({ action: 'delete', name: SLUG });
      if (order === 'post') {
        child = spawnAppender(f.base, 'post', payload, readyFile, goFile);
        await waitFor(readyFile, f.source, false);
      }
      // Release only once the rename has happened, so `pre` writes into the
      // archived inode and `post` writes into a freshly created source file.
      await waitFor(f.source, f.source, true);
      writeFileSync(goFile, 'go');
      const result = await deleting;
      await child;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (order === 'pre') {
        const archived = await readFile(f.archive, 'utf8');
        assert.ok(archived.includes(payload.trim()), `pre payload must survive in archive (${order} #${iteration})`);
      } else {
        const fresh = await contentsOrMissing(f.source);
        assert.ok(fresh !== null && fresh.includes(payload.trim()), `post payload must survive in a fresh source file (${order} #${iteration})`);
        assert.ok(!(await readFile(f.archive, 'utf8')).includes(payload.trim()), 'post payload must not be deleted or silently merged into the archive');
      }
    });
  }
}

// ---- 5) ledger failure injection -----------------------------------------
test('unknown ledger acknowledgement after rename returns an error, keeps archived bytes, and carries the stable code', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const original = fs.promises.appendFile;
  let injected = false;
  fs.promises.appendFile = async (target, data, ...args) => {
    if (!injected && String(target).endsWith(LEDGER_REL) && String(data).includes('"op":"delete"')) {
      injected = true;
      await original.call(fs.promises, target, data, ...args); // append really landed
      const err = new Error('simulated lost ledger acknowledgement');
      err.code = 'EIO';
      throw err; // recordDeleteEvent swallows this and returns false
    }
    return original.call(fs.promises, target, data, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await f.post({ action: 'delete', name: SLUG });
  } finally {
    fs.promises.appendFile = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true, 'the ledger failure must actually be injected');
  assert.notEqual(result.status, 200, 'no false success after an unknown ack');
  assert.equal(result.body.code, 'MEMORY_DELETE_LEDGER_UNKNOWN');
  assert.equal(result.body.ledgerStatus, 'unknown');
  const archived = await readFile(f.archive, 'utf8');
  assert.ok(archived.startsWith(ORIGINAL.trimEnd()), 'archived bytes must stay intact');
  assert.equal(await contentsOrMissing(f.source), null, 'source was already renamed away');
});

// ---- 6) R26 consistency ---------------------------------------------------
test('successful delete leaves no dangling delete_intent and a matching archive write', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const result = await f.post({ action: 'delete', name: SLUG });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const raw = await readFile(f.ledger, 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  const archiveHash = contentHash(await readFile(f.archive, 'utf8'));
  assert.ok(rows.some((row) => row.key === SOURCE_REL && row.op === 'delete_intent' && row.to === ARCHIVE_REL));
  assert.ok(rows.some((row) => row.key === SOURCE_REL && row.op === 'delete'));
  assert.ok(rows.some((row) => row.key === ARCHIVE_REL && row.op === undefined && row.hash === archiveHash));
  const ledger = await readLedger(f.root);
  assert.notEqual(ledger.get(SOURCE_REL)?.op, 'delete_intent', 'no dangling intent');
  assert.equal(ledger.get(SOURCE_REL)?.op, 'delete');
  assert.equal(ledger.get(ARCHIVE_REL)?.hash, contentHash(await readFile(f.archive, 'utf8')));
  // lstat confirms the archive is a real regular file, not a stage leftover.
  assert.equal((await lstat(f.archive)).isFile(), true);
  await assert.rejects(lstat(f.source), { code: 'ENOENT' });
});
