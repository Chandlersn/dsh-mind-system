import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoCaptureIntent, beginCaptureIntent, finishCaptureIntent, inspectCaptureIntent } from '../src/capture-intent.js';

const day = '2026-11-10';
const intentName = '.daily-capture.pending';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-intent-isolated-'));
  const daily = path.join(root, `${day}.md`);
  const pending = path.join(root, intentName);
  await writeFile(daily, '不可改动的每日内容', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('capture-intent-isolated-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, daily, pending };
}

function ioError() { return Object.assign(new Error('模拟 I/O 回执丢失'), { code: 'EIO' }); }

async function patchBuiltin(method, wrap, body) {
  const original = fs.promises[method];
  fs.promises[method] = wrap(original);
  syncBuiltinESMExports();
  try { return await body(); }
  finally { fs.promises[method] = original; syncBuiltinESMExports(); }
}

async function assertDailyUntouched(daily) {
  assert.equal(await readFile(daily, 'utf8'), '不可改动的每日内容');
}

test('正常创建和完成：意图内容可核对，完成后才允许下一次开始', async (t) => {
  const f = await fixture(t);
  await assertNoCaptureIntent(f.root);
  assert.equal(await inspectCaptureIntent(f.root), 'not_seen');
  assert.equal(await inspectCaptureIntent(path.join(f.root, 'missing')), 'unknown');
  const intent = await beginCaptureIntent(f.root, day);
  assert.equal(await inspectCaptureIntent(f.root), 'present');
  assert.equal(intent.file, f.pending);
  const record = JSON.parse(await readFile(f.pending, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['day', 'id', 'version']);
  assert.equal(record.version, 1);
  assert.equal(record.day, day);
  assert.equal(record.id, intent.id);
  assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await assert.rejects(assertNoCaptureIntent(f.root), { code: 'CAPTURE_INTENT_PENDING' });
  await finishCaptureIntent(intent);
  await assert.rejects(lstat(f.pending), { code: 'ENOENT' });
  await assertNoCaptureIntent(f.root);
  await assertDailyUntouched(f.daily);
});

test('已有意图文件时拒绝，不覆盖或删除原始字节', async (t) => {
  const f = await fixture(t);
  await writeFile(f.pending, '旧意图原样保留\n', 'utf8');
  const before = await lstat(f.pending);
  await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
  await assert.rejects(assertNoCaptureIntent(f.root), { code: 'CAPTURE_INTENT_PENDING' });
  assert.equal(await readFile(f.pending, 'utf8'), '旧意图原样保留\n');
  assert.equal((await lstat(f.pending)).ino, before.ino);
  await assertDailyUntouched(f.daily);
});

test('意图路径已有符号链接时拒绝，链接和目标均保持不变', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'link-target.txt');
  await writeFile(target, '原链接目标', 'utf8');
  try { await symlink(target, f.pending, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`本机无法创建符号链接：${error.code}`);
    throw error;
  }
  await assert.rejects(assertNoCaptureIntent(f.root), { code: 'CAPTURE_INTENT_PENDING' });
  await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
  assert.ok((await lstat(f.pending)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), '原链接目标');
  await assertDailyUntouched(f.daily);
});

test('意图路径已有目录链接时同样拒绝，不跟随或删除目标', async (t) => {
  const f = await fixture(t);
  const targetDir = path.join(f.root, 'link-target-dir');
  const targetFile = path.join(targetDir, 'sentinel.txt');
  await mkdir(targetDir);
  await writeFile(targetFile, '目录哨兵原样');
  try { await symlink(targetDir, f.pending, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`本机无法创建目录链接：${error.code}`);
    throw error;
  }
  assert.ok((await lstat(f.pending)).isSymbolicLink());
  await assert.rejects(assertNoCaptureIntent(f.root), { code: 'CAPTURE_INTENT_PENDING' });
  await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
  assert.ok((await lstat(f.pending)).isSymbolicLink());
  assert.equal(await readFile(targetFile, 'utf8'), '目录哨兵原样');
  await assertDailyUntouched(f.daily);
});

for (const phase of ['write', 'sync']) {
  test(`独占 open 后 ${phase} 故障保留意图且不接触每日数据`, async (t) => {
    const f = await fixture(t);
    let opens = 0, writes = 0, syncs = 0, closes = 0;
    await patchBuiltin('open', (original) => async (file, ...args) => {
      const handle = await original(file, ...args);
      if (path.resolve(String(file)) !== path.resolve(f.pending)) return handle;
      opens++;
      return {
        async writeFile(data, ...rest) {
          writes++;
          if (phase === 'write') {
            await handle.writeFile(String(data).slice(0, 9), ...rest);
            throw ioError();
          }
          return handle.writeFile(data, ...rest);
        },
        async sync() {
          syncs++;
          await handle.sync();
          if (phase === 'sync') throw ioError();
        },
        async close() { closes++; return handle.close(); },
      };
    }, async () => {
      await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_UNKNOWN' });
    });
    assert.equal(opens, 1);
    assert.equal(writes, 1);
    assert.equal(syncs, phase === 'sync' ? 1 : 0);
    assert.equal(closes, 1);
    assert.ok((await lstat(f.pending)).isFile(), '意图文件须保留以供核查');
    assert.ok((await readFile(f.pending, 'utf8')).length > 0, '确认故障发生在真实写入之后');
    await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
    await assertDailyUntouched(f.daily);
  });
}

test('close 已成功但回执丢失时不得再次 close，意图必须保留', async (t) => {
  const f = await fixture(t);
  let closes = 0;
  await patchBuiltin('open', (original) => async (file, ...args) => {
    const handle = await original(file, ...args);
    if (path.resolve(String(file)) !== path.resolve(f.pending)) return handle;
    return {
      writeFile: (...args) => handle.writeFile(...args),
      sync: (...args) => handle.sync(...args),
      async close() { closes++; await handle.close(); throw ioError(); },
    };
  }, async () => {
    await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_UNKNOWN' });
  });
  assert.equal(closes, 1, '不能因关闭回执丢失再次关闭句柄');
  assert.equal(JSON.parse(await readFile(f.pending, 'utf8')).day, day);
  await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
  await assertDailyUntouched(f.daily);
});

test('unlink 已成功但回执丢失：报告结果未知且不得重复 unlink', async (t) => {
  const f = await fixture(t);
  const intent = await beginCaptureIntent(f.root, day);
  let calls = 0;
  await patchBuiltin('unlink', (original) => async (file, ...args) => {
    if (path.resolve(String(file)) !== path.resolve(f.pending)) return original(file, ...args);
    calls++;
    await original(file, ...args);
    throw ioError();
  }, async () => {
    await assert.rejects(finishCaptureIntent(intent), (error) => {
      assert.equal(error.code, 'CAPTURE_FINALIZE_UNKNOWN');
      assert.equal(error.fileWritten, true);
      assert.equal(error.ledgerStatus, 'recorded');
      assert.match(error.message, /不明|核查/);
      return true;
    });
  });
  assert.equal(calls, 1);
  await assert.rejects(lstat(f.pending), { code: 'ENOENT' });
  await assertDailyUntouched(f.daily);
});

test('进程退出后遗留意图：下一进程拒绝开始且不删除现场', async (t) => {
  const f = await fixture(t);
  const modulePath = fileURLToPath(new URL('../src/capture-intent.js', import.meta.url));
  const ready = path.join(f.root, '.capture-test-ready');
  const script = `import { beginCaptureIntent } from ${JSON.stringify(new URL('../src/capture-intent.js', import.meta.url).href)}; import {writeFile} from 'node:fs/promises'; import path from 'node:path'; await beginCaptureIntent(process.env.CAPTURE_TEST_ROOT, ${JSON.stringify(day)}); await writeFile(path.join(process.env.CAPTURE_TEST_ROOT, '.capture-test-ready'), 'ready'); setInterval(()=>{},1000);`;
  assert.ok(path.isAbsolute(modulePath));
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CAPTURE_TEST_ROOT: f.root }, stdio: 'ignore', windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await lstat(ready); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null || child.signalCode !== null) assert.fail('子进程未创建意图就退出');
    if (Date.now() >= deadline) assert.fail('子进程未在时限内完成意图创建');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child.kill('SIGKILL'), true, '在意图持久化后强制中断子进程');
  const result = await exited;
  assert.ok(result.signal === 'SIGKILL' || (result.code !== null && result.code !== 0), '中断必须以非正常退出被观察到');
  const bytes = await readFile(f.pending);
  assert.equal(JSON.parse(bytes.toString('utf8')).day, day);
  await assert.rejects(beginCaptureIntent(f.root, day), { code: 'CAPTURE_INTENT_PENDING' });
  await assert.rejects(assertNoCaptureIntent(f.root), { code: 'CAPTURE_INTENT_PENDING' });
  assert.deepEqual(await readFile(f.pending), bytes);
  await assertDailyUntouched(f.daily);
});
