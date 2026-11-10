// Production apply/pre-step against disposable roots only. Aliases are created
// explicitly as an adversarial fixture; no real memory or ledger is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, link, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUserMessage } from '../src/host.js';
import { localDateStr } from '../src/util.js';
import { dailyTemplate } from '../src/markdown.js';
import { readLedger, contentHash, recordWrite, reconcile } from '../src/write-ledger.js';
import { setTimeout as delay } from 'node:timers/promises';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

const sample = '隔离日记别名测试：采集必须保护原始材料';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'daily-capture-alias-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const today = localDateStr();
  const dailyName = `${today}.md`;
  const daily = path.join(root, dailyName);
  const outside = path.join(home, 'outside-sentinel.md');
  const oldHome = process.env.DSH_HOME;
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 空索引\n', 'utf8');
  process.env.DSH_HOME = home;
  const hooks = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() { return undefined; }, set() {},
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const mod = await import('../server.js');
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, captureUserTurns: true, recallTimeoutMs: 100, dshRoot: process.env.DSH_INSTALL_DIR });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'must register the real pre-step');
  const message = createUserMessage({ content: [{ type: 'text', text: sample }], source: { kind: 'user' } });
  t.after(async () => {
    dispose?.();
    await withMemoryRootTransaction(root, async () => {});
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (!t.passed) { t.diagnostic(`isolated fixture preserved for diagnosis: ${home}`); return; }
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^daily-capture-alias-/);
    await rm(home, { recursive: true, force: true });
  });
  async function run() {
    let nextCalls = 0;
    const decision = await preStep({ agent: { id: 'synthetic-daily-alias' }, turn: 1, messages: [message] }, async () => {
      nextCalls++;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(decision.kind, 'enter');
    assert.equal(nextCalls, 1);
    // Admission precedes a Promise.resolve capture schedule: this barrier alone
    // may run before capture enqueues. observeDailyLstat waits for the real hook
    // and drains the queue again before any negative assertion.
    await withMemoryRootTransaction(root, async () => {});
    assert.equal(localDateStr(), today, 'local date must not change during this isolated test');
  }
  return { root, daily, dailyName, outside, today, run };
}

async function observeDailyLstat(daily, operation) {
  const original = fs.promises.lstat;
  let observed = 0;
  fs.promises.lstat = async (p, ...args) => {
    if (typeof p === 'string' && path.resolve(p) === daily) observed++;
    return original.call(fs.promises, p, ...args);
  };
  syncBuiltinESMExports();
  try {
    await operation();
    const deadline = Date.now() + 5000;
    while (!observed && Date.now() < deadline) await delay(10);
    assert.ok(observed > 0, 'production capture must inspect the exact daily path');
    // lstat is called from the running transaction, so this barrier follows it.
    await withMemoryRootTransaction(path.dirname(daily), async () => {});
  } finally {
    fs.promises.lstat = original;
    syncBuiltinESMExports();
  }
}

async function assertNoDailyRecord(root, dailyName) {
  const ledger = await readLedger(root);
  assert.ok(ledger instanceof Map, 'missing ledger is represented as an empty ledger');
  assert.equal(ledger.has(dailyName), false, 'an aliased daily file must not receive a write event');
}

test('硬链接到记忆根外文件：采集不改写任一别名且不登记日记', async (t) => {
  const f = await fixture(t);
  const sentinel = '# 根外哨兵\n原字节不得改变\n';
  await writeFile(f.outside, sentinel, 'utf8');
  try { await link(f.outside, f.daily); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(err.code)) { t.skip(`hard links unavailable: ${err.code}`); return; }
    throw err;
  }
  const before = await lstat(f.daily);
  assert.ok(before.isFile() && before.nlink > 1, 'fixture must create an actual hard link');
  await observeDailyLstat(f.daily, f.run);
  const after = await lstat(f.daily);
  assert.equal(await readFile(f.outside, 'utf8'), sentinel);
  assert.equal(await readFile(f.daily, 'utf8'), sentinel);
  assert.equal(after.nlink, before.nlink, 'capture must not replace or detach the alias');
  if (before.ino && after.ino) assert.equal(after.ino, before.ino);
  await assertNoDailyRecord(f.root, f.dailyName);
});

test('普通每日文件正控：同一采集链路追加用户原话并登记账本', async (t) => {
  const f = await fixture(t);
  const original = dailyTemplate(f.today);
  await writeFile(f.daily, original, 'utf8');
  assert.equal(await recordWrite(f.root, { key: f.dailyName, hash: contentHash(original), tool: 'test.fixture' }), true, 'positive baseline must be registered');
  assert.equal(reconcile({ key: f.dailyName, text: original, ledger: await readLedger(f.root) }).verdict, 'ok', 'positive baseline must reconcile');
  assert.equal((await lstat(f.daily)).nlink, 1);
  await observeDailyLstat(f.daily, f.run);
  const text = await readFile(f.daily, 'utf8');
  assert.ok(text.startsWith(original));
  assert.ok(text.includes(sample), 'positive control must actually capture the user message');
  const ledger = await readLedger(f.root);
  assert.ok(ledger instanceof Map);
  assert.equal(ledger.get(f.dailyName)?.hash, contentHash(text), 'ledger records the actual captured bytes');
});

test('符号链接到记忆根外文件：采集不改写目标或别名且不登记日记', async (t) => {
  const f = await fixture(t);
  const sentinel = '# 符号链接根外哨兵\n内容保持原样\n';
  await writeFile(f.outside, sentinel, 'utf8');
  try { await symlink(f.outside, f.daily, 'file'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) { t.skip(`symbolic links unavailable: ${err.code}`); return; }
    throw err;
  }
  assert.ok((await lstat(f.daily)).isSymbolicLink(), 'fixture must be a real symbolic link');
  await observeDailyLstat(f.daily, f.run);
  assert.ok((await lstat(f.daily)).isSymbolicLink(), 'capture must not replace the alias');
  assert.equal(await readFile(f.outside, 'utf8'), sentinel);
  assert.equal(await readFile(f.daily, 'utf8'), sentinel);
  await assertNoDailyRecord(f.root, f.dailyName);
});
