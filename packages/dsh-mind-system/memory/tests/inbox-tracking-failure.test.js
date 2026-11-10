import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshRoot } from '../src/host.js';

test('memory_check 明示收件箱替换后异常的具体条目状态未知', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-inbox-tracking-failure-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const inboxPath = path.join(home, 'storages', 'memory-inbox.json');
  const oldHome = process.env.DSH_HOME;
  const originalRename = fs.promises.rename;
  process.env.DSH_HOME = home;
  t.after(async () => {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('dsh-inbox-tracking-failure-'));
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n\n' + 'x'.repeat(120) + '\n', 'utf8');

  let injected = 0;
  let persistedAfterRename;
  fs.promises.rename = async (source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(inboxPath) && injected === 0) {
      injected++;
      await originalRename(source, destination);
      persistedAfterRename = JSON.parse(await readFile(inboxPath, 'utf8'));
      const error = new Error('模拟替换成功但确认丢失');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();

  const definitions = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => { definitions.set(definition.name, definition); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, connection: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const hostRoot = resolveDshRoot(process.env.DSH_INSTALL_DIR);
  // No memoryRoot override: exercise the real auto-post branch against DSH_HOME.
  const dispose = apply(ctx, { dshRoot: hostRoot, skillRoot: skills, maxIndexBytes: 100, maxIndexHardBytes: 200 });
  if (typeof dispose === 'function') t.after(() => dispose());
  const check = definitions.get('memory_check');
  assert.ok(check && typeof check.execute === 'function');
  let report;
  try {
    report = await check.execute({}, {});
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(injected, 1, '故障必须发生在真实收件箱替换之后');
  const index = report.results.findIndex((item) => item.rule === 'R5' && item.message.includes('舒适线'));
  assert.ok(index >= 0, '体检必须实际发现目标问题');
  assert.ok(Object.values(persistedAfterRename.items).some((item) => item.code === 'R5' && item.message === report.results[index].message), '真实替换已经发生，不能断言未入库');

  const hostTools = await import(pathToFileURL(path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
  const hostValues = await import(pathToFileURL(path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href);
  const snapshot = hostValues.snapshotJsonValue(report);
  assert.notEqual(snapshot, undefined, '真实工具回执必须是宿主接受的无损 JSON');
  assert.deepEqual(hostTools.validateJsonSchemaValue(check.output.schema, snapshot, 'value'), [], '真实工具回执必须符合宿主严格输出 schema');

  // Proposed contract: per-finding failure keyed by resultIndex, with an explicit
  // unknown outcome instead of silently omitting the failure from `tracked`.
  const failure = snapshot.trackingFailures?.find((item) => item.resultIndex === index);
  assert.ok(failure, '回执必须标明哪条体检结果的收件箱跟踪未确认');
  assert.equal(failure.rule, 'R5');
  assert.equal(failure.status, 'unknown');
  assert.match(failure.message, /未知/);
  assert.match(failure.message, /不要盲目重试/);
  const rendered = check.output.render({}, snapshot).map((part) => part.text).join('\n');
  assert.ok(rendered.includes(report.results[index].message), '渲染结果必须保留该条体检问题');
  assert.match(rendered, /未知/);
  assert.match(rendered, /不要盲目重试/);
});
