// Cross-process regression for the real passive capture hook. Everything below
// uses a unique temporary DSH_HOME; no live memory or live configuration is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { localDateStr } from '../src/util.js';
import { contentHash, readLedger, reconcile, recordWrite } from '../src/write-ledger.js';

const SAMPLE = { A: '并发独立输入甲：保留第一条原话', B: '并发独立输入乙：保留第二条原话' };
const SELF = fileURLToPath(import.meta.url);
const deadlineWait = async (fn, ms, description) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await delay(15);
  }
  throw new Error(`timed out: ${description}`);
};
const exists = async (file) => { try { await access(file); return true; } catch (err) { if (err?.code === 'ENOENT') return false; throw err; } };

// Each child imports the real server only AFTER patching Node's actual fs API.
// The barrier is outside the memory root. It holds a completed daily read, so
// both old implementations demonstrably use the same actual file bytes. The
// first reader has a bounded escape: a correct cross-process lock can serialize
// the second reader without making the test deadlock.
async function child(home, id, day) {
  const root = path.join(home, 'memory');
  const daily = path.join(root, `${day}.md`);
  const marks = path.join(home, 'barrier');
  const mine = path.join(marks, `read-${id}.json`);
  const other = path.join(marks, `read-${id === 'A' ? 'B' : 'A'}.json`);
  const ownCommit = path.join(marks, `ledger-${id}.done`);
  const firstCommit = path.join(marks, 'ledger-A.done');
  const pfs = fs.promises;
  const realRead = pfs.readFile.bind(pfs);
  const realWrite = pfs.writeFile.bind(pfs);
  const realRename = pfs.rename.bind(pfs);
  const realAppend = pfs.appendFile.bind(pfs);
  let hookedRead = false;
  let heldForPeer = false;
  pfs.readFile = async (file, ...args) => {
    const bytes = await realRead(file, ...args);
    if (!hookedRead && typeof file === 'string' && path.resolve(file) === path.resolve(daily)) {
      hookedRead = true;
      await realWrite(mine, JSON.stringify({ id, text: String(bytes) }), 'utf8');
      try { await deadlineWait(() => exists(other), 1800, `${id}: peer daily read`); heldForPeer = true; }
      catch (err) { if (!String(err.message).startsWith('timed out:')) throw err; }
    }
    return bytes;
  };
  pfs.rename = async (from, to, ...args) => {
    if (id === 'B' && typeof to === 'string' && path.resolve(to) === path.resolve(daily)) {
      // A complete file+ledger commit first makes the old implementation's
      // final ledger hash deterministic, while preserving the stale B read.
      await deadlineWait(() => exists(firstCommit), 6000, 'B: A ledger append');
    }
    return realRename(from, to, ...args);
  };
  pfs.appendFile = async (file, data, ...args) => {
    const result = await realAppend(file, data, ...args);
    if (typeof file === 'string' && path.resolve(file) === path.resolve(root, '.write-ledger.jsonl')) {
      await realWrite(ownCommit, 'committed', 'utf8');
    }
    return result;
  };
  syncBuiltinESMExports();
  process.env.DSH_HOME = home;
  const { createUserMessage } = await import('../src/host.js');
  const { withMemoryRootTransaction } = await import('../src/root-transaction.js');
  const mod = await import('../server.js');
  const hooks = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() { return undefined; }, set() {},
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: path.join(home, 'skills'), captureUserTurns: true, recallTimeoutMs: 100, dshRoot: process.env.DSH_INSTALL_DIR });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  const message = createUserMessage({ content: [{ type: 'text', text: SAMPLE[id] }], source: { kind: 'user' } });
  let calls = 0;
  const decision = await preStep({ agent: { id: `independent-${id}` }, turn: 1, messages: [message] }, async () => {
    calls++;
    return { kind: 'enter', messages: [] };
  });
  assert.equal(decision.kind, 'enter');
  assert.equal(calls, 1);
  // Capture is fire-and-forget and resolving its root is async: wait for an
  // observed ledger append before draining the real per-process queue.
  await deadlineWait(() => exists(ownCommit), 7000, `${id}: own ledger append`);
  await withMemoryRootTransaction(root, async () => {});
  assert.equal(localDateStr(), day, 'the fixture must not cross local midnight');
  await realWrite(path.join(marks, `result-${id}.json`), JSON.stringify({ hookedRead, heldForPeer }), 'utf8');
  dispose?.();
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'daily-capture-concurrency-'));
  const root = path.join(home, 'memory');
  const marks = path.join(home, 'barrier');
  const day = localDateStr();
  await mkdir(root, { recursive: true });
  await mkdir(marks, { recursive: true });
  await mkdir(path.join(home, 'skills'), { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 隔离空索引\n', 'utf8');
  const baseline = `# ${day} 隔离初始快照\n`;
  await writeFile(path.join(root, `${day}.md`), baseline, 'utf8');
  assert.equal(await recordWrite(root, { key: `${day}.md`, hash: contentHash(baseline), tool: 'test.fixture' }), true, `baseline registration failed; fixture preserved: ${home}`);
  assert.equal(reconcile({ key: `${day}.md`, text: baseline, ledger: await readLedger(root) }).verdict, 'ok', `baseline must reconcile; fixture preserved: ${home}`);
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
    await Promise.race([
      Promise.all(children.map((c) => c.done)),
      delay(2000, undefined, { ref: false }).then(() => { throw new Error(`child did not exit; preserving isolated fixture ${home}`); }),
    ]);
    if (!t.passed) { t.diagnostic(`isolated fixture preserved for diagnosis: ${home}`); return; }
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^daily-capture-concurrency-/);
    await rm(home, { recursive: true, force: true });
  });
  const start = (id) => {
    const c = spawn(process.execPath, [SELF, '--fixture-child', home, id, day], {
      env: { ...process.env, DSH_HOME: home, DSH_INSTALL_DIR: process.env.DSH_INSTALL_DIR || 'D:/dsh' },
      stdio: 'ignore', windowsHide: true,
    });
    children.push(c);
    c.done = new Promise((resolve) => {
      c.once('error', (err) => resolve({ error: String(err), code: null }));
      c.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return c;
  };
  return { home, root, marks, day, start };
}

if (process.argv[2] === '--fixture-child') {
  const [, , , home, id, day] = process.argv;
  try { await child(home, id, day); }
  catch (err) {
    // Child errors are written solely to the fixture directory for diagnosis.
    await writeFile(path.join(home, 'barrier', `error-${id}.txt`), String(err?.stack ?? err), 'utf8').catch(() => {});
    process.exitCode = 1;
  }
} else {
  test('两个真实进程的每日采集不得丢失任一输入，账本必须匹配最终内容', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const a = f.start('A');
    await deadlineWait(() => exists(path.join(f.marks, 'read-A.json')), 5000, 'A reaches real daily read');
    const b = f.start('B');
    const outcomes = await Promise.race([
      Promise.all([a.done, b.done]),
      delay(9500, undefined, { ref: false }).then(() => { throw new Error('child processes exceeded overall timeout'); }),
    ]);
    for (const [i, o] of outcomes.entries()) {
      const id = i ? 'B' : 'A';
      const errorFile = path.join(f.marks, `error-${id}.txt`);
      const details = await exists(errorFile) ? await readFile(errorFile, 'utf8') : '';
      assert.equal(o.code, 0, `${id} child failed: ${JSON.stringify(o)} ${details}`);
    }
    const snapA = JSON.parse(await readFile(path.join(f.marks, 'read-A.json'), 'utf8'));
    const snapB = JSON.parse(await readFile(path.join(f.marks, 'read-B.json'), 'utf8'));
    const stateA = JSON.parse(await readFile(path.join(f.marks, 'result-A.json'), 'utf8'));
    const stateB = JSON.parse(await readFile(path.join(f.marks, 'result-B.json'), 'utf8'));
    assert.ok(stateA.hookedRead && stateB.hookedRead, 'both real pre-steps must reach the actual daily read');
    const text = await readFile(path.join(f.root, `${f.day}.md`), 'utf8');
    const ledger = await readLedger(f.root);
    const verdict = reconcile({ key: `${f.day}.md`, text, ledger });
    const presentA = text.includes(SAMPLE.A);
    const presentB = text.includes(SAMPLE.B);
    t.diagnostic(`same_snapshot=${snapA.text === snapB.text}; both_reached_barrier=${stateA.heldForPeer && stateB.heldForPeer}; A=${presentA}; B=${presentB}; ledger_verdict=${verdict.verdict}; ledger_hash_matches=${ledger?.get(`${f.day}.md`)?.hash === contentHash(text)}`);
    assert.equal(ledger?.get(`${f.day}.md`)?.hash, contentHash(text), 'final ledger must match final file');
    assert.equal(verdict.verdict, 'ok', 'final file must reconcile');
    assert.ok(presentA && presentB, `both distinct captured user messages must survive; A=${presentA}, B=${presentB}`);
  });
}
