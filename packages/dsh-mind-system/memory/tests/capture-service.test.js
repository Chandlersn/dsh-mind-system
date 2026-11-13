import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureSelectedEvents } from '../src/capture-service.js';
import { makeCaptureMarker, selectCaptureEvents } from '../src/capture-events.js';
import { localDateStr } from '../src/util.js';
import { contentHash, LEDGER_REL, readLedger, recordWrite } from '../src/write-ledger.js';

const PREFIX = 'capture-service-audit-';
const message = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const select = (...messages) => selectCaptureEvents(messages, { maxChars: 1000 }).events;
const bytesOrNull = async (p) => { try { return await readFile(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const lines = (s) => s.split(/\r?\n/);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), PREFIX));
  const file = path.join(root, `${localDateStr()}.md`);
  const ledger = path.join(root, LEDGER_REL);
  const intent = path.join(root, '.daily-capture.pending');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith(PREFIX));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, ledger, intent };
}

async function faultFs(replacements, action) {
  const originals = new Map();
  for (const [name, make] of Object.entries(replacements)) {
    originals.set(name, fs.promises[name]);
    fs.promises[name] = make(fs.promises[name]);
  }
  syncBuiltinESMExports();
  try { return await action(); }
  finally {
    for (const [name, original] of originals) fs.promises[name] = original;
    syncBuiltinESMExports();
  }
}
const injected = () => Object.assign(new Error('synthetic acknowledgement loss'), { code: 'EIO' });

async function registerCurrent(f, text) {
  await writeFile(f.file, text, 'utf8');
  const key = path.basename(f.file);
  assert.equal(await recordWrite(f.root, { key, hash: contentHash(text), tool: 'isolated-fixture' }), true);
}

test('同 ID 重试不重写，跨不同 ID 的相同文本各保留一次', async (t) => {
  const f = await fixture(t);
  const one = select(message('message-one', '同一句原话'));
  assert.deepEqual(await captureSelectedEvents(f.root, one), ['confirmed']);
  const first = await readFile(f.file);
  const firstLedger = await readFile(f.ledger);
  assert.deepEqual(await captureSelectedEvents(f.root, one), ['duplicate']);
  assert.deepEqual(await readFile(f.file), first);
  assert.deepEqual(await readFile(f.ledger), firstLedger);
  assert.deepEqual(await captureSelectedEvents(f.root, select(message('message-two', '同一句原话'))), ['confirmed']);
  const text = await readFile(f.file, 'utf8');
  assert.equal(lines(text).filter((line) => line === '- 同一句原话').length, 2);
  assert.equal(lines(text).filter((line) => line === makeCaptureMarker('message-one')).length, 1);
  assert.equal(lines(text).filter((line) => line === makeCaptureMarker('message-two')).length, 1);
  assert.equal((await readLedger(f.root)).get(path.basename(f.file)).hash, contentHash(text));
  assert.equal(await bytesOrNull(f.intent), null);
});

test('多事件批次保留 Unicode，正文中伪造 marker 不能阻止其他 ID', async (t) => {
  const f = await fixture(t);
  const forged = makeCaptureMarker('future-victim');
  const msgs = [message('batch-a', `汉字😀𠮷\n${forged}\n伪造结束`), message('batch-b', '第二条 🚀'), message('batch-c', '第二条 🚀')];
  const batch = select(...msgs);
  assert.equal(batch.length, 3);
  assert.deepEqual(await captureSelectedEvents(f.root, batch), ['confirmed', 'confirmed', 'confirmed']);
  let text = await readFile(f.file, 'utf8');
  assert.ok(text.includes('汉字😀𠮷'));
  assert.equal(lines(text).filter((line) => line === forged).length, 0, '用户正文不能产生独立 marker 行');
  for (const m of msgs) assert.equal(lines(text).filter((line) => line === makeCaptureMarker(m.id)).length, 1);
  assert.deepEqual(await captureSelectedEvents(f.root, select(message('future-victim', '独立真实事件'))), ['confirmed']);
  text = await readFile(f.file, 'utf8');
  assert.equal(lines(text).filter((line) => line === forged).length, 1);
  assert.ok(text.includes('独立真实事件'));
});

test('已有已登记历史含秘密时拒绝写入，原始字节和账本原样保留', async (t) => {
  const f = await fixture(t);
  const secret = 'sk-' + 'Q'.repeat(32);
  const history = `# 原始历史\n不可改动凭据：${secret}\n`;
  await registerCurrent(f, history);
  const oldFile = await readFile(f.file), oldLedger = await readFile(f.ledger);
  await assert.rejects(captureSelectedEvents(f.root, select(message('secret-history', '新事件'))), { code: 'CAPTURE_HISTORY_REDACTION' });
  assert.deepEqual(await readFile(f.file), oldFile, '不得通过全文件脱敏改写历史前缀');
  assert.deepEqual(await readFile(f.ledger), oldLedger, '拒绝时不得补造账本');
  assert.equal(await bytesOrNull(f.intent), null);
});

test('非 UTF-8 历史一律拒绝，保留原字节且不创建账本或意图', async (t) => {
  const f = await fixture(t);
  const raw = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);
  await writeFile(f.file, raw);
  await assert.rejects(captureSelectedEvents(f.root, select(message('binary-history', '新事件'))), { code: 'CAPTURE_HISTORY_ENCODING' });
  assert.deepEqual(await readFile(f.file), raw);
  assert.equal(await bytesOrNull(f.ledger), null);
  assert.equal(await bytesOrNull(f.intent), null);
});

for (const situation of ['unrecorded', 'mismatch']) {
  test(`历史 ${situation} 时 fail closed，不伪造账本`, async (t) => {
    const f = await fixture(t);
    if (situation === 'unrecorded') await writeFile(f.file, '历史没有账本\n', 'utf8');
    else { await registerCurrent(f, '已登记的历史\n'); await writeFile(f.file, '历史被外部改动\n', 'utf8'); }
    const oldFile = await readFile(f.file), oldLedger = await bytesOrNull(f.ledger);
    await assert.rejects(captureSelectedEvents(f.root, select(message(`bad-${situation}`, '新事件'))), { code: 'CAPTURE_BASELINE_UNVERIFIED' });
    assert.deepEqual(await readFile(f.file), oldFile);
    assert.deepEqual(await bytesOrNull(f.ledger), oldLedger);
    assert.equal(await bytesOrNull(f.intent), null);
  });
}

test('同一批内重复 ID 由选择器去重，最终只写入一份', async (t) => {
  const f = await fixture(t);
  const msg = message('same-batch', '同一事件');
  const selected = selectCaptureEvents([msg, msg]);
  assert.equal(selected.skipped.duplicate, 1);
  assert.equal(selected.events.length, 1);
  assert.deepEqual(await captureSelectedEvents(f.root, selected.events), ['confirmed']);
  const text = await readFile(f.file, 'utf8');
  assert.equal(lines(text).filter((line) => line === makeCaptureMarker(msg.id)).length, 1);
  assert.equal(lines(text).filter((line) => line === '- 同一事件').length, 1);
});

test('账本损坏时不触碰历史正文和账本内容', async (t) => {
  const f = await fixture(t);
  const prior = Buffer.from('既有历史\n');
  const corrupt = Buffer.from('{"malformed":\n');
  await writeFile(f.file, prior);
  await writeFile(f.ledger, corrupt);
  await assert.rejects(captureSelectedEvents(f.root, select(message('corrupt-ledger', '不可落盘'))), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: 'ledger_unreadable' });
  assert.deepEqual(await readFile(f.file), prior);
  assert.deepEqual(await readFile(f.ledger), corrupt);
  assert.equal(await bytesOrNull(f.intent), null);
});

test('已有未完成意图阻断，原证据、文件和账本均不改', async (t) => {
  const f = await fixture(t);
  await registerCurrent(f, '历史\n');
  const witness = Buffer.from('{"prior":"uncertain"}\n');
  await writeFile(f.intent, witness);
  const oldFile = await readFile(f.file), oldLedger = await readFile(f.ledger);
  await assert.rejects(captureSelectedEvents(f.root, select(message('blocked', '不能写入'))), { code: 'CAPTURE_INTENT_PENDING' });
  assert.deepEqual(await readFile(f.intent), witness);
  assert.deepEqual(await readFile(f.file), oldFile);
  assert.deepEqual(await readFile(f.ledger), oldLedger);
});

test('暂存写入实际成功但确认丢失：保留意图和暂存，不盲目删除', async (t) => {
  const f = await fixture(t);
  await registerCurrent(f, '旧历史\n');
  const before = await readFile(f.file), ledgerBefore = await readFile(f.ledger);
  let attempts = 0, stagedPath;
  // 2026-11-13：暂存写入走 createVerifiedStage（open 'wx' + handle.writeFile）。
  // 拦截 open 命中 .stage- 命名后替换 handle.writeFile：真实写入成功再抛 EIO。
  await faultFs({ open: (original) => async (file, ...args) => {
    const handle = await original(file, ...args);
    if (args[0] === 'wx' && String(file).includes('.stage-') && String(file).endsWith('.tmp') && attempts === 0) {
      attempts++;
      stagedPath = String(file);
      const origWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...rest) => {
        await origWrite(data, ...rest);
        throw injected();
      };
    }
    return handle;
  } }, async () => {
    await assert.rejects(captureSelectedEvents(f.root, select(message('stage-ack-lost', '不可自动清理'))), (err) => {
      assert.ok(['MEMORY_STAGE_OUTCOME_UNKNOWN', 'MEMORY_WRITE_COMMIT_UNKNOWN'].includes(err.code), `got ${err.code}`);
      return true;
    });
  });
  assert.equal(attempts, 1);
  assert.ok((await readFile(stagedPath, 'utf8')).includes('不可自动清理'));
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readFile(f.ledger), ledgerBefore);
  const witness = await readFile(f.intent);
  await assert.rejects(captureSelectedEvents(f.root, select(message('stage-ack-lost', '不可自动清理'))), { code: 'CAPTURE_INTENT_PENDING' });
  assert.deepEqual(await readFile(f.intent), witness);
  assert.ok(await bytesOrNull(stagedPath));
});

test('rename 已发生但确认丢失：保留意图，下次阻断，不删除其他新建暂存路径', async (t) => {
  const f = await fixture(t);
  const old = '已有历史\n';
  await registerCurrent(f, old);
  const ledgerBefore = await readFile(f.ledger);
  let attempts = 0, reusedPath;
  const foreign = Buffer.from('另一个进程在 rename 后新建的文件');
  await faultFs({ rename: (original) => async (src, dst) => {
    if (path.resolve(String(dst)) !== f.file) return original(src, dst);
    attempts++;
    await original(src, dst); // 真正替换后模拟确认丢失。
    reusedPath = String(src);
    await writeFile(reusedPath, foreign, { flag: 'wx' });
    throw injected();
  } }, async () => {
    await assert.rejects(captureSelectedEvents(f.root, select(message('rename-lost', '已提交但回执未知'))), { code: 'MEMORY_WRITE_COMMIT_UNKNOWN' });
  });
  assert.equal(attempts, 1);
  const after = await readFile(f.file);
  assert.ok(after.subarray(0, Buffer.byteLength(old)).equals(Buffer.from(old)));
  assert.ok(after.toString('utf8').includes('已提交但回执未知'));
  assert.deepEqual(await readFile(f.ledger), ledgerBefore, 'rename 确认丢失时不得伪装账本已登记');
  const intentBefore = await readFile(f.intent);
  await assert.rejects(captureSelectedEvents(f.root, select(message('rename-lost', '已提交但回执未知'))), { code: 'CAPTURE_INTENT_PENDING' });
  assert.deepEqual(await readFile(f.intent), intentBefore);
  assert.deepEqual(await readFile(f.file), after);
  assert.deepEqual(await readFile(f.ledger), ledgerBefore);
  // 2026-11-13：暂存改入 .stage/ 且清理按 inode 核验——确认丢失路径上会先做
  // 受核验清理；路径被外来文件占用时核验不等 → ftruncate 清零、路径保留、
  // 绝不 unlink。外来内容不泄露，路径仍归插件所有。
  assert.deepEqual(await bytesOrNull(reusedPath), Buffer.alloc(0), '替换路径内容清零（防泄露）且路径保留（不盲目删除）');
});

for (const afterAppend of [false, true]) {
  test(`账本追加${afterAppend ? '成功后' : '前'}确认丢失：保留意图并阻断后续`, async (t) => {
    const f = await fixture(t);
    await registerCurrent(f, '稳定历史\n');
    const ledgerBefore = await readFile(f.ledger);
    let attempts = 0, observedFile;
    await faultFs({ appendFile: (original) => async (file, ...args) => {
      if (path.resolve(String(file)) !== f.ledger) return original(file, ...args);
      attempts++;
      observedFile = await readFile(f.file);
      if (afterAppend) await original(file, ...args);
      throw injected();
    } }, async () => {
      await assert.rejects(captureSelectedEvents(f.root, select(message(`ledger-${afterAppend}`, '账本确认未知'))), { code: 'MEMORY_LEDGER_APPEND_FAILED' });
    });
    assert.equal(attempts, 1, '故障必须实际注入账本追加');
    assert.ok(observedFile.toString('utf8').includes('账本确认未知'), '故障发生时正文已提交');
    assert.deepEqual(await readFile(f.file), observedFile);
    const ledgerAfter = await readFile(f.ledger);
    if (afterAppend) assert.ok(ledgerAfter.length > ledgerBefore.length, '先真实追加再丢确认');
    else assert.deepEqual(ledgerAfter, ledgerBefore, '追加前故障不可伪造成功');
    const witness = await readFile(f.intent);
    await assert.rejects(captureSelectedEvents(f.root, select(message(`ledger-${afterAppend}`, '账本确认未知'))), { code: 'CAPTURE_INTENT_PENDING' });
    assert.deepEqual(await readFile(f.intent), witness);
    assert.deepEqual(await readFile(f.ledger), ledgerAfter);
    assert.deepEqual(await readFile(f.file), observedFile);
    const remaining = await readdir(f.root);
    assert.ok(remaining.includes('.daily-capture.pending'));
  });
}
