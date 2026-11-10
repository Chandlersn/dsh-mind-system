import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryInbox, inboxFingerprint, canonicalIssueIdentity, stableIssueFingerprint } from '../health-inbox.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'inbox-identity-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('inbox-identity-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, inbox: new MemoryInbox(() => root), file: path.join(root, 'storages', 'memory-inbox.json') };
}
const finding = (overrides = {}) => ({
  from: 'memory-manager', code: 'R26', severity: 'warn', message: '29 个文件未登记',
  identity: { scope: 'memory-root-A', subtype: 'unrecorded-count', subject: 'aggregate' },
  ...overrides,
});

test('同身份动态数字变化复用条目、更新消息级别并保留人工处置和首次时间', async (t) => {
  const { root, inbox, file } = await fixture(t);
  const first = await inbox.post(finding());
  await inbox.update(first.item.fingerprint, 'acknowledged', '人工已认领');
  const next = await inbox.post(finding({ message: '33 个文件未登记', severity: 'error', location: 'memory-root-A', hint: '核对' }));
  assert.equal(next.isNew, false);
  assert.equal(next.item.fingerprint, first.item.fingerprint);
  assert.equal(next.item.times, 2);
  assert.equal(next.item.message, '33 个文件未登记');
  assert.equal(next.item.severity, 'error');
  assert.equal(next.item.status, 'acknowledged');
  assert.equal(next.item.note, '人工已认领');
  assert.equal(next.item.receivedAt, first.item.receivedAt);
  assert.equal(next.item.location, 'memory-root-A');
  assert.equal('identity' in next.item, false, '保持既有工具输出严格 schema');
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.identities[first.item.fingerprint], canonicalIssueIdentity(finding()));
  const reloaded = new MemoryInbox(() => root);
  assert.equal((await reloaded.post(finding({ message: '30 个文件未登记' }))).times, 3);
  assert.equal((await reloaded.list()).length, 1);
});

test('同规则不同子类型、对象、作用域、来源或规则均不合并', async (t) => {
  const { inbox } = await fixture(t);
  const variants = [
    finding(),
    finding({ identity: { scope: 'memory-root-A', subtype: 'hash-mismatch', subject: 'aggregate' } }),
    finding({ identity: { scope: 'memory-root-A', subtype: 'unrecorded-count', subject: 'functions/a.md' } }),
    finding({ identity: { scope: 'memory-root-B', subtype: 'unrecorded-count', subject: 'aggregate' } }),
    finding({ from: 'other-plugin' }),
    finding({ code: 'R27' }),
  ];
  const results = await Promise.all(variants.map((x) => inbox.post(x)));
  assert.equal(new Set(results.map((r) => r.item.fingerprint)).size, variants.length);
  assert.equal((await inbox.list()).length, variants.length);
});

test('完整身份无歧义：字段本身包含分隔符仍不混同', () => {
  const a = finding({ identity: { scope: 'a|b', subtype: 'c', subject: 'd' } });
  const b = finding({ identity: { scope: 'a', subtype: 'b|c', subject: 'd' } });
  assert.notEqual(canonicalIssueIdentity(a), canonicalIssueIdentity(b));
  assert.notEqual(stableIssueFingerprint(canonicalIssueIdentity(a)), stableIssueFingerprint(canonicalIssueIdentity(b)));
});

test('身份不完整或多余字段时拒绝，不退回 rule 合并', async (t) => {
  const { inbox } = await fixture(t);
  for (const identity of [null, {}, { scope: 'a', subtype: 'b' }, { scope: 'a', subtype: 'b', subject: '' }, { scope: 'a', subtype: 'b', subject: 'c', extra: 'x' }]) {
    await assert.rejects(inbox.post(finding({ identity })), /身份/);
  }
  assert.equal((await inbox.list()).length, 0);
});

test('新身份与旧人工条目并存，旧 fingerprint/消息/状态保持原貌', async (t) => {
  const { inbox } = await fixture(t);
  const legacy = { from: 'memory-manager', code: 'R26', message: '29 个文件未登记', severity: 'warn' };
  const old = await inbox.post(legacy);
  assert.equal(old.item.fingerprint, inboxFingerprint(legacy.from, legacy.code, legacy.message));
  await inbox.update(old.item.fingerprint, 'acknowledged', '历史记录');
  const current = await inbox.post(finding());
  assert.notEqual(old.item.fingerprint, current.item.fingerprint);
  const list = await inbox.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((item) => item.fingerprint === old.item.fingerprint).note, '历史记录');
  assert.equal(list.find((item) => item.fingerprint === old.item.fingerprint).status, 'acknowledged');
});

test('已解决条目再次被相同身份观察到时重开，保留处置备注', async (t) => {
  const { inbox } = await fixture(t);
  const first = await inbox.post(finding());
  await inbox.update(first.item.fingerprint, 'resolved', '先前已解决');
  const again = await inbox.post(finding({ message: '异常再现' }));
  assert.equal(again.item.status, 'open');
  assert.equal(again.item.note, '先前已解决');
  assert.equal(again.item.message, '异常再现');
});

test('完整身份与指纹不一致或冲突时拒绝，原记录不变', async (t) => {
  const { inbox, file } = await fixture(t);
  const first = await inbox.post(finding());
  const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.identities[first.item.fingerprint] = canonicalIssueIdentity(finding({ identity: { scope: 'other', subtype: 'other', subject: 'other' } }));
  const tampered = JSON.stringify(disk);
  await writeFile(file, tampered, 'utf8');
  await assert.rejects(inbox.post(finding({ message: '不可覆盖' })), /身份与指纹不一致|碰撞/);
  assert.equal(await readFile(file, 'utf8'), tampered);
});

test('目标指纹已有条目但身份元数据缺失时拒绝覆盖', async (t) => {
  const { inbox, file } = await fixture(t);
  const first = await inbox.post(finding());
  const disk = JSON.parse(await readFile(file, 'utf8'));
  delete disk.identities[first.item.fingerprint];
  const tampered = JSON.stringify(disk);
  await writeFile(file, tampered, 'utf8');
  await assert.rejects(inbox.post(finding({ message: '不可覆盖' })), /身份缺失/);
  assert.equal(await readFile(file, 'utf8'), tampered);
});

test('持久化失败同时回滚新身份与条目，后续可正常重试', async (t) => {
  const { inbox } = await fixture(t);
  const original = inbox.flush;
  inbox.flush = async () => { throw new Error('模拟保存失败'); };
  await assert.rejects(inbox.post(finding()), /模拟保存失败/);
  assert.equal(inbox.identities.size, 0);
  assert.equal((await inbox.list()).length, 0);
  inbox.flush = original;
  assert.equal((await inbox.post(finding())).times, 1);
});

test('存储中的身份表被篡改时保留原文件并拒绝载入', async (t) => {
  const { root, inbox, file } = await fixture(t);
  const first = await inbox.post(finding());
  const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.identities[first.item.fingerprint] = canonicalIssueIdentity(finding({ code: 'different' }));
  const tampered = JSON.stringify(disk);
  await writeFile(file, tampered, 'utf8');
  await assert.rejects(new MemoryInbox(() => root).list(), /身份与指纹不一致/);
  assert.equal(await readFile(file, 'utf8'), tampered);
});

test('超过 200 条时仍不自动删除历史已解决条目', async (t) => {
  const { root, inbox, file } = await fixture(t);
  const first = await inbox.post({ from: 'agent', code: 'historic', message: '历史', severity: 'warn' });
  await inbox.update(first.item.fingerprint, 'resolved', '保留历史');
  const disk = JSON.parse(await readFile(file, 'utf8'));
  for (let i = 0; i < 205; i++) {
    const fingerprint = `seed-${i}`;
    disk.items[fingerprint] = { fingerprint, from: 'agent', code: 'seed', message: String(i), severity: 'info', status: 'open', times: 1, receivedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(disk), 'utf8');
  const reloaded = new MemoryInbox(() => root);
  await reloaded.post(finding());
  const items = await reloaded.list();
  assert.equal(items.length, 207);
  assert.equal(items.find((item) => item.fingerprint === first.item.fingerprint)?.status, 'resolved');
});
