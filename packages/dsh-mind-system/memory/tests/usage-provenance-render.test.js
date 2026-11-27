import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../server.js';
import { usageShardPath } from '../src/usage.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-provenance-render-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root);
  await mkdir(skills);
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const tools = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on: () => noop, set() {}, get: () => undefined,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
  };
  let dispose;
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^usage-provenance-render-/);
    await rm(home, { recursive: true, force: true });
  });
  dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_ROOT || 'D:/dsh',
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  const tool = tools.get('memory_usage');
  assert.ok(tool);
  return { root, tool };
}

function rendered(tool, args, result) {
  return tool.output.render(args, result).map((block) => block.text ?? '').join('\n');
}

function assertUnverifiedSource(text) {
  assert.match(text, /调用方声明/, 'must identify the signal as a caller declaration');
  assert.match(text, /来源未认证/, 'must disclose that the source is not authenticated');
  assert.doesNotMatch(text, /用户(?:已|明确)?确认|用户明确认可|真实采纳|经认证/);
}

test('record receipt does not authenticate a caller-declared positive signal', async (t) => {
  const { root, tool } = await fixture(t);
  const args = { action: 'record', kind: 'positive', href: 'functions/sample.md' };
  const result = await tool.execute(args, { agent: { id: 'synthetic-agent' } });
  const rows = (await readFile(usageShardPath(root), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'positive');
  assertUnverifiedSource(rendered(tool, args, result));
});

test('report does not upgrade a caller-declared positive signal into verified adoption', async (t) => {
  const { tool } = await fixture(t);
  const record = { action: 'record', kind: 'positive', href: 'functions/sample.md' };
  await tool.execute(record, { agent: { id: 'synthetic-agent' } });
  const args = { action: 'report', days: 30 };
  const result = await tool.execute(args, { agent: { id: 'synthetic-agent' } });
  assert.equal(result.scanStatus, 'complete');
  assert.equal(result.items.find((item) => item.href === record.href)?.positives, 1);
  assertUnverifiedSource(rendered(tool, args, result));
});
