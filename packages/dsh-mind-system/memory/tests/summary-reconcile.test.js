import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, realpath, link, unlink, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryInbox } from '../health-inbox.js';
import { reconcileSummaries, summaryDates } from '../src/summary-reconcile.js';

const head = '2026-05-03', old = '2026-05-01';
const doc = date => `# topic\n\n## 当前状态摘要（截至 ${date}）\n\n- revised\n\n## [${head}] changed\n\nbody\n`;
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-summary-reconcile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'memory'), dir = path.join(root, 'functions'), file = path.join(dir, 'topic.md');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n');
  const inbox = new MemoryInbox(() => home);
  let scope = await realpath(root); if (process.platform === 'win32') scope = scope.toLowerCase();
  const subject = 'functions/topic.md';
  const msg = `${subject} 头部状态摘要截至 ${old} 早于最新迭代块 ${head}：追加迭代须成对刷新头部摘要`;
  const finding = { from: 'memory-manager', code: 'R3', severity: 'warn', message: msg, identity: {scope, subtype:'summary-stale', subject} };
  return { home, root, scope, file, inbox, finding, scanned: new Map([['topic', doc(head)]]), current: new Set() };
}

test('actual registered check posts, re-reads, resolves, then reopens the same fingerprint', async t => {
  const f = await fixture(t), prev = process.env.DSH_HOME;
  process.env.DSH_HOME = f.home;
  t.after(() => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; });
  const { apply } = await import('../server.js');
  let check; const noop = () => {};
  const ctx = { tools: { register(d) { if (d.name === 'memory_check') check = d; return noop; } }, on: () => noop,
    inject: (_names, fn) => fn({}), systemPrompt: { getSectionOrder: () => 2900, section: () => noop } };
  const dispose = apply(ctx, { dshRoot: process.env.DSH_INSTALL_DIR, skillRoot: path.join(f.home,'skills') });
  if (typeof dispose === 'function') t.after(dispose);
  await writeFile(f.file, doc(old));
  const initial = await check.execute({}, {}), row = initial.tracked.find(r => r.rule === 'R3');
  assert.match(row.fingerprint, /^i1-/);
  const fixedBytes = Buffer.from('\uFEFF' + doc(head));
  await writeFile(f.file, fixedBytes);
  const fixed = await check.execute({}, {});
  assert.equal(fixed.reconciliation?.[0]?.fingerprint, row.fingerprint);
  assert.equal(fixed.reconciliation[0].status, 'resolved', JSON.stringify(fixed.reconciliation));
  const expectedHash = createHash('sha256').update(fixedBytes).digest('hex');
  assert.ok((await f.inbox.list({status:'resolved'}))[0].note.endsWith(expectedHash));
  await writeFile(f.file, doc(old));
  const recurred = await check.execute({}, {});
  assert.ok(recurred.tracked.some(r => r.fingerprint === row.fingerprint && r.status === 'open' && r.times === 2));
  apply(ctx, { dshRoot: process.env.DSH_INSTALL_DIR, skillRoot: path.join(f.home, 'skills'), memoryRoot: f.root });
  await writeFile(f.file, doc(head));
  assert.equal((await check.execute({}, {})).reconciliation, undefined);
  assert.ok((await f.inbox.list({status:'open'})).some(i => i.fingerprint === row.fingerprint));
});

test('invalid evidence, nested subjects, hardlinks and concurrent state changes cannot close a ticket', async t => {
  const f = await fixture(t);
  const first = await f.inbox.post(f.finding);
  const snapshots = await f.inbox.summaryWorkItems();
  const run = () => reconcileSummaries({...f, snapshots});
  await writeFile(f.file, doc(head));
  f.scanned.clear(); assert.match((await run())[0].message,/未读/);
  f.scanned.set('topic',doc(old)); assert.match((await run())[0].message,/不同/);
  f.scanned.set('topic',doc(head));
  const alias = f.file + '.copy'; await link(f.file, alias); assert.match((await run())[0].message,/常规文件/); await unlink(alias);
  await f.inbox.update(first.item.fingerprint, 'acknowledged', 'changed after snapshot');
  assert.match((await run())[0].message,/收件箱状态已变化/);
  const nested = 'functions/inner/topic.md';
  await f.inbox.post({...f.finding, message:f.finding.message.replace('functions/topic.md',nested), identity:{...f.finding.identity, subject:nested}});
  for(const change of [{scope:'other'}, {subtype:'other'}]) await f.inbox.post({...f.finding, identity:{...f.finding.identity, ...change}});
  await f.inbox.post({...f.finding, code:'R26'}); await f.inbox.post({...f.finding, identity:undefined});
  const all = await f.inbox.summaryWorkItems();
  const results = await reconcileSummaries({...f,snapshots:all.filter(r=>r.item.fingerprint !== first.item.fingerprint)});
  assert.equal(results.length,1);assert.match(results[0].message,/路径/);
  assert.equal((await f.inbox.list({status:'resolved'})).length,0);
});

test('reject ambiguous, nonexistent and decreasing dates and ignore fenced headings', () => {
  for (const text of [doc('2026-02-30'),doc(head)+doc(head),doc(head)+'## [2026-05-99] invalid',doc(head)+'## [2026-01-01] earlier',doc(head).replace('- revised',''), '```\n'+doc(head)+'```']) assert.throws(()=>summaryDates(text));
  assert.deepEqual(summaryDates(doc(head)+'```md\n## [2026-06-10] example\n```'),{head,newest:head});
});


test('reject a functions junction and recheck the file immediately before publishing', async t => {
  const f = await fixture(t);
  const {item} = await f.inbox.post(f.finding);
  const snapshots = await f.inbox.summaryWorkItems();
  const run = () => reconcileSummaries({...f, snapshots});
  await writeFile(f.file, doc(head));
  const dir = path.dirname(f.file), relocated = path.join(f.home, 'relocated');
  await rename(dir, relocated);
  await symlink(relocated, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await run())[0].status, 'unconfirmed');
  await unlink(dir);
  await rename(relocated, dir);
  const flush = f.inbox.flush.bind(f.inbox);
  f.inbox.flush = verify => flush(async () => { await writeFile(f.file, doc(old)); await verify(); });
  const [result] = await run();
  assert.equal(result.status,'unconfirmed');
  assert.match(result.message,/证据版本已变化/);
  assert.equal((await f.inbox.list()).find(row=>row.fingerprint===item.fingerprint).status,'open');
});
