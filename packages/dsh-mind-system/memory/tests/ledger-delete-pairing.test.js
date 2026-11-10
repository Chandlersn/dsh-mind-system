import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_REL, readLedger, recordDeleteEvent } from '../src/write-ledger.js';

async function fixture(t, events) {
  const root = await mkdtemp(path.join(tmpdir(), 'ledger-delete-pairing-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('ledger-delete-pairing-'));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, LEDGER_REL), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return root;
}
const key = 'functions/a.md';
const intent = (extra = {}) => ({ key, id: 'one', op: 'delete_intent', ...extra });
const done = (extra = {}) => ({ key, id: 'one', op: 'delete', ...extra });

test('相同操作来源和规范化目标可配对', async (t) => {
  const root = await fixture(t, [intent({ tool: 'memory_rename', to: 'functions/new.md' }), done({ tool: 'memory_rename', to: 'functions/./new.md' })]);
  const state = (await readLedger(root))?.get(key);
  assert.equal(state?.op, 'delete');
  assert.equal(state?.to, 'functions/new.md');
  const portable = await fixture(t, [intent({ tool: 'memory_rename', to: 'functions\\\\new.md' }), done({ tool: 'memory_rename', to: 'functions/new.md' })]);
  assert.equal((await readLedger(portable))?.get(key)?.to, 'functions/new.md');
});

test('不同 tool 或目标不能配对，包括仅一侧缺字段', async (t) => {
  for (const [a, b] of [
    [{ tool: 'one' }, { tool: 'two' }],
    [{ to: 'functions/a.md' }, { to: 'functions/b.md' }],
    [{ tool: 'one' }, {}],
    [{ to: 'functions/a.md' }, {}],
  ]) {
    const root = await fixture(t, [intent(a), done(b)]);
    assert.equal(await readLedger(root), undefined);
  }
});

test('双方均省略 tool/to 的历史记录保持可读', async (t) => {
  const root = await fixture(t, [intent(), done()]);
  assert.equal((await readLedger(root))?.get(key)?.op, 'delete');
});

test('任一事件非法目标类型或不安全路径拒绝读取，写入入口亦拒绝非法目标', async (t) => {
  for (const bad of [null, 0, {}, [], '', '../outside.md', '/absolute.md']) {
    const root = await fixture(t, [intent({ to: bad }), done({ to: bad })]);
    assert.equal(await readLedger(root), undefined, `to=${JSON.stringify(bad)}`);
    const before = await readFile(path.join(root, LEDGER_REL), 'utf8');
    assert.equal(await recordDeleteEvent(root, { key, id: 'bad', op: 'delete_intent', to: bad }), false);
    assert.equal(await readFile(path.join(root, LEDGER_REL), 'utf8'), before, 'invalid destination must not append an event');
  }
});

test('跨 key 交错的独立意图和完成事件仍可配对', async (t) => {
  const other = 'functions/b.md';
  const root = await fixture(t, [intent({ tool: 'one', to: 'functions/new-a.md' }), { key: other, id: 'two', op: 'delete_intent', tool: 'two' }, done({ tool: 'one', to: 'functions/new-a.md' }), { key: other, id: 'two', op: 'delete', tool: 'two' }]);
  const ledger = await readLedger(root);
  assert.equal(ledger?.get(key)?.op, 'delete');
  assert.equal(ledger?.get(other)?.op, 'delete');
});
