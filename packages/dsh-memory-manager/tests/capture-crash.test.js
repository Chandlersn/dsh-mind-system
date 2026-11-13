// Crash/restart acceptance tests. All state, hooks and child processes belong to
// a unique temporary DSH_HOME. The actual capture service and SQLite lock run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { makeCaptureMarker } from '../src/capture-events.js';
import { contentHash, LEDGER_REL, readLedger } from '../src/write-ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceUrl = pathToFileURL(path.resolve(here, '../src/capture-service.js')).href;
const eventsUrl = pathToFileURL(path.resolve(here, '../src/capture-events.js')).href;
const mutexUrl = pathToFileURL(path.resolve(here, '../src/capture-mutex.js')).href;
const PREFIX = 'capture-crash-isolated-';
const SENTINEL = '.capture-mutex.sqlite';
const INTENT = '.daily-capture.pending';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readOptional = async (p) => { try { return await readFile(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Hooks signal only after the real operation succeeded; the child then remains
// inside that production call while the parent verifies and forcibly kills it.
const childSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.CRASH_ROOT, phase = process.env.CRASH_PHASE;
const marker = process.env.CRASH_READY, result = process.env.CRASH_RESULT;
const ledger = path.join(root, '.write-ledger.jsonl');
const intent = path.join(root, '.daily-capture.pending');
const hold = async () => {
  fs.writeFileSync(marker, JSON.stringify({ phase, pid: process.pid }), { flag: 'wx' });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
const originalOpen = fs.promises.open;
fs.promises.open = async (...args) => {
  const h = await originalOpen(...args);
  if (phase === 'intent' && path.resolve(String(args[0])) === intent) {
    const close = h.close.bind(h);
    h.close = async (...a) => { const value = await close(...a); await hold(); return value; };
  }
  return h;
};
const originalRename = fs.promises.rename;
fs.promises.rename = async (src, dst) => {
  const value = await originalRename(src, dst);
  if (phase === 'renamed' && /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(String(dst))) && path.dirname(path.resolve(String(dst))) === root) await hold();
  return value;
};
const originalAppend = fs.promises.appendFile;
fs.promises.appendFile = async (file, ...args) => {
  const value = await originalAppend(file, ...args);
  if (phase === 'ledger' && path.resolve(String(file)) === ledger) await hold();
  return value;
};
syncBuiltinESMExports();
try {
  if (phase === 'probe') {
    const { withCaptureMutex } = await import(process.env.CRASH_MUTEX_URL);
    await withCaptureMutex(root, () => {}, { timeoutMs: 1000 });
    fs.writeFileSync(result, JSON.stringify({ outcome: 'lock-acquired' }));
  } else {
    const { captureSelectedEvents } = await import(process.env.CRASH_SERVICE_URL);
    const { selectCaptureEvents } = await import(process.env.CRASH_EVENTS_URL);
    const msg = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
    const inputs = [msg('crash-event-one', '独立崩溃采集事件')];
    if (phase === 'retry') inputs.push(msg('crash-event-two', '不应写入的第二事件'));
    const selected = selectCaptureEvents(inputs).events;
    const outcomes = await captureSelectedEvents(root, selected);
    fs.writeFileSync(result, JSON.stringify({ outcome: 'success', outcomes }));
  }
} catch (error) {
  fs.writeFileSync(result, JSON.stringify({ outcome: 'error', code: error?.code, message: String(error?.message) }));
}
`;

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), PREFIX));
  const root = path.join(home, 'memory');
  await mkdir(root);
  const children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all([...children].map((child) => ended(child, 5000).catch(() => {})));
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith(PREFIX));
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, children };
}

function start(f, phase, id = phase) {
  const ready = path.join(f.home, `${id}.ready`);
  const result = path.join(f.home, `${id}.result`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    env: { ...process.env, DSH_HOME: f.home, CRASH_ROOT: f.root, CRASH_PHASE: phase, CRASH_READY: ready, CRASH_RESULT: result, CRASH_SERVICE_URL: serviceUrl, CRASH_EVENTS_URL: eventsUrl, CRASH_MUTEX_URL: mutexUrl },
    stdio: 'ignore', windowsHide: true,
  });
  f.children.add(child);
  child.on('error', () => {});
  return { child, ready, result };
}

async function ended(child, timeoutMs = 7000) {
  const until = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= until) throw new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`);
    await pause(15);
  }
  return { exitCode: child.exitCode, signal: child.signalCode };
}

async function waitReady(job, timeoutMs = 7000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const bytes = await readOptional(job.ready);
    if (bytes) return JSON.parse(bytes.toString('utf8'));
    if (job.child.exitCode !== null || job.child.signalCode !== null) {
      const result = await readOptional(job.result);
      throw new Error(`child exited before reaching hook: ${result?.toString('utf8') ?? 'no receipt'}`);
    }
    await pause(15);
  }
  throw new Error(`phase hook did not fire within ${timeoutMs}ms`);
}

async function run(f, phase, id) {
  const job = start(f, phase, id);
  const exit = await ended(job.child);
  assert.equal(exit.exitCode, 0, `child ${phase} must exit normally`);
  const raw = await readOptional(job.result);
  assert.ok(raw, `child ${phase} must produce an explicit receipt`);
  return JSON.parse(raw.toString('utf8'));
}

async function snapshot(root) {
  const all = await readdir(root);
  const daily = all.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  assert.ok(daily.length <= 1, 'test must not silently cross a date boundary');
  const entries = {};
  for (const name of all) {
    // SQLite can update sidecar files as part of locking; verify it by inode
    // separately, and compare every other artifact byte-for-byte.
    if (name === SENTINEL || name.startsWith(`${SENTINEL}-`)) continue;
    // 2026-11-13：writeText 暂存移入 <root>/.stage/（目录）；快照只对文件做
    // 字节比较，目录（内部残留暂存）不进入该比对面。
    const st = await lstat(path.join(root, name)).catch(() => null);
    if (st?.isDirectory()) continue;
    entries[name] = (await readFile(path.join(root, name))).toString('base64');
  }
  return { daily: daily[0], entries };
}

for (const phase of ['intent', 'renamed', 'ledger']) {
  test(`强杀 ${phase} 阶段：OS 锁释放，未完成意图阻止自动恢复`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t);
    const protectedTmp = path.join(f.root, 'forensic-preserve.tmp');
    await writeFile(protectedTmp, '不能自动清除的独立现场');
    const job = start(f, phase);
    const ready = await waitReady(job);
    assert.equal(ready.phase, phase);
    assert.equal(ready.pid, job.child.pid);
    const pending = await readFile(path.join(f.root, INTENT), 'utf8');
    const witness = JSON.parse(pending);
    assert.equal(witness.version, 1);
    assert.ok(witness.id && /^\d{4}-\d{2}-\d{2}$/.test(witness.day), 'intent must contain fully written day and ID');
    const daily = path.join(f.root, `${witness.day}.md`);
    const content = await readOptional(daily);
    const ledger = await readOptional(path.join(f.root, LEDGER_REL));
    if (phase === 'intent') { assert.equal(content, null); assert.equal(ledger, null); }
    else {
      assert.ok(content?.toString('utf8').includes('独立崩溃采集事件'));
      assert.equal(content.toString('utf8').split(makeCaptureMarker('crash-event-one')).length - 1, 1);
      if (phase === 'renamed') assert.equal(ledger, null, 'rename has committed before any ledger append');
      else {
        assert.ok(ledger?.length, 'ledger append must have really completed');
        assert.equal((await readLedger(f.root)).get(`${witness.day}.md`)?.hash, contentHash(content.toString('utf8')));
      }
    }
    const sentinelBefore = await stat(path.join(f.root, SENTINEL), { bigint: true });
    assert.ok(sentinelBefore.ino !== 0n);
    const busy = await run(f, 'probe', `${phase}-busy`);
    assert.equal(busy.code, 'CAPTURE_MUTEX_BUSY', 'positive control: the live process actually holds the OS lock');
    assert.equal(job.child.kill('SIGKILL'), true, 'child must still be alive at the actual hook');
    await ended(job.child);
    const frozen = await snapshot(f.root);
    assert.deepEqual(await run(f, 'probe', `${phase}-probe`), { outcome: 'lock-acquired' }, 'new process must acquire OS lock without deleting sentinel');
    const inodeAfter = await stat(path.join(f.root, SENTINEL), { bigint: true });
    assert.equal(inodeAfter.ino, sentinelBefore.ino, 'the lock sentinel must not be removed/recreated');
    const retry = await run(f, 'retry', `${phase}-retry`);
    assert.equal(retry.outcome, 'error');
    assert.equal(retry.code, 'CAPTURE_INTENT_PENDING', 'new process must fail closed on the old intent');
    assert.deepEqual(await snapshot(f.root), frozen, 'retry must not alter intent, daily data, ledger or temporary artifacts');
    assert.equal((await readFile(protectedTmp, 'utf8')), '不能自动清除的独立现场');
    if (content) {
      const final = await readFile(daily, 'utf8');
      assert.equal(final.split(makeCaptureMarker('crash-event-one')).length - 1, 1);
      assert.ok(!final.includes('不应写入的第二事件'));
    }
  });
}

test('正常完成正控：意图清除、账本匹配，同事件重试不重复', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const first = await run(f, 'normal', 'normal-first');
  assert.deepEqual(first, { outcome: 'success', outcomes: ['confirmed'] });
  assert.equal(await readOptional(path.join(f.root, INTENT)), null);
  const snap = await snapshot(f.root);
  assert.ok(snap.daily);
  const content = await readFile(path.join(f.root, snap.daily), 'utf8');
  assert.ok(content.includes('独立崩溃采集事件'));
  assert.equal(content.split(makeCaptureMarker('crash-event-one')).length - 1, 1);
  assert.equal((await readLedger(f.root)).get(snap.daily)?.hash, contentHash(content));
  const second = await run(f, 'normal', 'normal-second');
  assert.deepEqual(second, { outcome: 'success', outcomes: ['duplicate'] });
  assert.deepEqual(await snapshot(f.root), snap);
});
