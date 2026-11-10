import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLedger } from '../src/write-ledger.js';

test('memory_rename 合并后源删除确认丢失时报告真实部分提交状态', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-rename-delete-uncertain-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const functions = path.join(root, 'functions');
  const source = path.join(functions, 'source.md');
  const target = path.join(functions, 'target.md');
  const index = path.join(root, 'MEMORY.md');
  const sourceText = '# Source\n\nSource only content.\n';
  const targetText = '# Target\n\nTarget only content.\n';
  const indexText = '# Index\n\n## 功能索引\n\n| 功能域 | 说明 |\n|---|---|\n| [source](functions/source.md) | source |\n| [target](functions/target.md) | target |\n';
  const previousHome = process.env.DSH_HOME;
  const originalUnlink = fs.promises.unlink;
  process.env.DSH_HOME = home;
  t.after(async () => {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^dsh-rename-delete-uncertain-/);
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(functions, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(source, sourceText, 'utf8');
  await writeFile(target, targetText, 'utf8');
  await writeFile(index, indexText, 'utf8');

  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(() => dispose());
  const rename = registered.get('memory_rename');
  assert.ok(rename && typeof rename.execute === 'function', '必须调用真实注册的 memory_rename');

  let injected = 0;
  fs.promises.unlink = async (file, ...args) => {
    if (path.resolve(String(file)) === source && injected === 0) {
      injected++;
      await originalUnlink.call(fs.promises, file, ...args);
      throw Object.assign(new Error('模拟删除成功但确认丢失'), { code: 'EIO' });
    }
    return originalUnlink.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  let failure;
  try {
    await rename.execute({ from: 'source', to: 'target' }, {});
  } catch (error) {
    failure = error;
  } finally {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }

  assert.equal(injected, 1, '故障必须发生在源文件实际 unlink 完成之后');
  const merged = await readFile(target, 'utf8');
  assert.ok(merged.includes(targetText.trim()), '目标原有内容必须存在');
  assert.ok(merged.includes(sourceText.trim()), '源内容实际已经写入目标');
  await assert.rejects(readFile(source, 'utf8'), { code: 'ENOENT' }, '源文件实际上已经消失');
  assert.equal(await readFile(index, 'utf8'), indexText, '索引引用必须尚未改写');
  const ledger = await readLedger(root);
  assert.equal(ledger?.get('functions/source.md')?.op, 'delete_intent', '源账本保留未完成的删除意图');

  assert.ok(failure, '真实工具必须返回错误');
  assert.equal(failure.code, 'MEMORY_RENAME_PARTIAL');
  assert.equal(failure.cause?.code, 'MEMORY_DELETE_OUTCOME_UNKNOWN');
  assert.match(failure.message, /目标[^\n]*已写入/, '必须说明目标已写入');
  assert.match(failure.message, /删除结果未知|删除[^\n]*不确定/, '必须说明源删除结果未知');
  assert.match(failure.message, /引用尚未改写/, '必须说明引用尚未改写');
  assert.match(failure.message, /不要盲目重试合并/, '必须提醒不能盲目重试合并');
});
