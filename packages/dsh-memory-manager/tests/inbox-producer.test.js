import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshRoot } from '../src/host.js';

test('memory_check 为 R5 子类维护稳定身份，并按结果索引匹配跟踪信息', async (t) => {
  // Use the production default-root path and its real auto-post branch, but
  // redirect both memory and inbox to this isolated DSH_HOME before apply().
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-inbox-producer-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('dsh-inbox-producer-'));
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });

  const defs = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, connection: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const hostRoot = resolveDshRoot(process.env.DSH_INSTALL_DIR);
  // Do not set memoryRoot: that deliberately suppresses automatic inbox posts.
  const dispose = apply(ctx, { dshRoot: hostRoot, skillRoot: skills, maxIndexBytes: 100, maxIndexHardBytes: 200 });
  if (typeof dispose === 'function') t.after(() => dispose());
  const check = defs.get('memory_check');
  assert.ok(check && typeof check.execute === 'function', 'real apply must register memory_check');
  const hostModule = await import(pathToFileURL(path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
  const hostValues = await import(pathToFileURL(path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href);
  const validate = (report) => {
    // Use the host's actual lossless snapshot, which rejects hidden properties;
    // JSON.stringify would silently strip them and mask an invalid tool result.
    const jsonValue = hostValues.snapshotJsonValue(report);
    assert.notEqual(jsonValue, undefined, 'host must accept the original result as lossless JSON');
    assert.deepEqual(hostModule.validateJsonSchemaValue(check.output.schema, jsonValue, 'value'), []);
    assert.equal(jsonValue.tracked.length, jsonValue.results.length, 'all emitted findings must be tracked in the isolated inbox');
    for (const entry of jsonValue.tracked) {
      assert.ok(Number.isInteger(entry.resultIndex) && entry.resultIndex >= 0 && entry.resultIndex < jsonValue.results.length);
      assert.equal(entry.rule, jsonValue.results[entry.resultIndex].rule);
    }
    assert.equal(new Set(jsonValue.tracked.map((entry) => entry.resultIndex)).size, jsonValue.results.length);
    return jsonValue;
  };
  const inboxState = async () => JSON.parse(await readFile(path.join(home, 'storages', 'memory-inbox.json'), 'utf8'));
  const firstText = '# 索引\n\n' + 'x'.repeat(120) + '\n';
  assert.ok(Buffer.byteLength(firstText) > 100 && Buffer.byteLength(firstText) <= 200);
  await writeFile(path.join(root, 'MEMORY.md'), firstText, 'utf8');
  const first = validate(await check.execute({}, {}));
  const firstIndex = first.results.findIndex((r) => r.rule === 'R5' && r.message.includes('舒适线'));
  assert.ok(firstIndex >= 0, 'first report must observe the index over the soft limit');
  const firstTracked = first.tracked.find((r) => r.resultIndex === firstIndex);
  assert.equal(firstTracked.times, 1);
  const firstInbox = await inboxState();
  const initial = firstInbox.items[firstTracked.fingerprint];
  assert.equal(initial.severity, 'warn');
  assert.equal(initial.message, first.results[firstIndex].message);

  // Change both the byte count and severity, and introduce a different R5
  // subtype (missing summary) whose occurrence count starts at one.
  const secondText = '# 索引\n\n| 测试功能 | |\n\n' + 'x'.repeat(220) + '\n';
  assert.ok(Buffer.byteLength(secondText) > 200);
  await writeFile(path.join(root, 'MEMORY.md'), secondText, 'utf8');
  const second = validate(await check.execute({}, {}));
  const sizeIndex = second.results.findIndex((r) => r.rule === 'R5' && r.message.includes('硬上限'));
  const summaryIndex = second.results.findIndex((r) => r.rule === 'R5' && r.message.includes('缺少一行摘要'));
  assert.ok(sizeIndex >= 0 && summaryIndex >= 0 && sizeIndex !== summaryIndex, 'both distinct R5 findings must exist');
  const sizeTracked = second.tracked.find((r) => r.resultIndex === sizeIndex);
  const summaryTracked = second.tracked.find((r) => r.resultIndex === summaryIndex);
  assert.equal(sizeTracked.fingerprint, firstTracked.fingerprint, 'size identity remains stable across threshold and message changes');
  assert.equal(sizeTracked.times, 2);
  assert.equal(summaryTracked.times, 1);
  assert.notEqual(summaryTracked.fingerprint, sizeTracked.fingerprint, 'different R5 subtypes must never merge');
  const after = await inboxState();
  assert.equal(after.items[sizeTracked.fingerprint].severity, 'error', 'latest severity must replace the earlier warning');
  assert.equal(after.items[sizeTracked.fingerprint].message, second.results[sizeIndex].message, 'latest observation must replace the old byte count');
  assert.equal(after.items[summaryTracked.fingerprint].message, second.results[summaryIndex].message);
  const sizeIssues = Object.values(after.items).filter((item) => item.from === 'memory-manager' && item.code === 'R5' && /MEMORY\.md \d+B > (?:舒适线|硬上限)/.test(item.message));
  assert.equal(sizeIssues.length, 1, 'both size observations must update one issue instead of creating two');

  const rendered = check.output.render({}, second).map((part) => part.text).join('\n');
  const sizeLine = rendered.split('\n').find((line) => line.includes(second.results[sizeIndex].message));
  const summaryLine = rendered.split('\n').find((line) => line.includes(second.results[summaryIndex].message));
  assert.match(sizeLine, /第 2 次发现/, 'the recurrence belongs to the size finding');
  assert.doesNotMatch(summaryLine, /第 2 次发现/, 'the first occurrence of the other R5 finding must not inherit it');
});
