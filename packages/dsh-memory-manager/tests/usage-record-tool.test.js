import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';
import { usageShardPath, usageWriteHealth, resetUsageWriteHealth } from '../src/usage.js';

const hostEntry = path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const { validateJsonSchemaValue } = createRequire(hostEntry)(hostEntry);

async function fixture(t, bridge = 'true') {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-record-tool-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root);
  await mkdir(skills);
  await mkdir(path.join(root, 'functions'));
  await writeFile(path.join(root, 'functions', 'sample.md'), 'Example memory');
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const tools = new Map();
  const adoption = [];
  const adoptionLedger = [];
  const noop = () => {};
  const valves = {
    negativeRules: async () => [], upward() {},
    async recordAdoptionSignal(signal) {
      adoption.push(signal);
      adoptionLedger.push(await readFile(usageShardPath(root), 'utf8'));
      if (bridge === 'throws') throw new Error('synthetic secret must not appear');
      if (bridge === 'undefined') return undefined;
      return bridge === 'true';
    },
  };
  if (bridge.startsWith('new:')) {
    valves.recordCorrelatedAdoptionSignal = async signal => {
      adoption.push(signal);
      adoptionLedger.push(await readFile(usageShardPath(root), 'utf8'));
      if (bridge === 'new:throws') throw new Error('synthetic secret must not appear');
      if (bridge === 'new:validate') return signal.note.length > 2048 ? 'invalid' : 'appended';
      return bridge.slice(4);
    };
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on: () => noop, set() {}, get: name => name === 'valves' && bridge !== 'absent' ? valves : undefined,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^usage-record-tool-/);
    await rm(home, { recursive: true, force: true });
    resetUsageWriteHealth();
  });
  return { root, tools, adoption, adoptionLedger };
}

test('registered record appends a verdict before forwarding adoption', async t => {
  const { root, tools, adoption, adoptionLedger } = await fixture(t);
  const tool = tools.get('memory_usage');
  const args = { action: 'record', kind: 'positive', href: 'functions/sample.md', note: 'confirmed' };
  const result = await tool.execute(args);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
  assert.match(tool.output.render(args, result)[0].text, /已记录/);
  const rows = (await readFile(usageShardPath(root), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'positive');
  assert.equal(rows[0].href, args.href);
  assert.deepEqual(adoption, [{ objectKey: args.href, kind: args.kind, note: args.note }]);
  assert.equal(JSON.parse(adoptionLedger[0]).href, args.href);
});

for (const bridge of ['absent', 'false', 'undefined', 'throws', 'true']) {
  test(`record exposes bridge outcome for ${bridge} without retry`, async t => {
    const { root, tools, adoption, adoptionLedger } = await fixture(t, bridge);
    const tool = tools.get('memory_usage');
    const args = { action: 'record', kind: 'correction', href: 'functions/sample.md' };
    const result = await tool.execute(args);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
    assert.equal(result.usageWritten, true);
    assert.equal(result.bridgeStatus, bridge === 'true' ? 'legacy_unlinked' : 'unknown');
    assert.match(result.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const rendered = tool.output.render(args, result)[0].text;
    assert.match(rendered, /已记录/);
    if (bridge === 'true') assert.match(rendered, /旧桥接服务报告已接受.*未关联.*不证明交付或人工采纳/);
    else assert.match(rendered, /结果未知或服务不可用.*无法确认写入.*无法排除已经写入.*勿据此重试/);
    assert.doesNotMatch(JSON.stringify(result) + rendered, /synthetic secret/);
    const rows = (await readFile(usageShardPath(root), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(adoption.length, bridge === 'absent' ? 0 : 1);
    assert.equal(adoptionLedger.length, bridge === 'absent' ? 0 : 1);
    if (adoptionLedger.length) assert.equal(adoptionLedger[0].trim().split('\n').length, 1);
  });
}

for (const [response, expected] of [['appended', 'appended'], ['unconfirmed', 'unconfirmed'], ['invalid', 'invalid'], ['throws', 'unconfirmed'], ['unexpected', 'unconfirmed']]) {
  test(`correlated bridge reports ${response} once`, async t => {
    const { root, tools, adoption, adoptionLedger } = await fixture(t, `new:${response}`);
    const tool = tools.get('memory_usage');
    const secret = 'sk-' + 'x'.repeat(24);
    const args = { action: 'record', kind: 'positive', href: 'functions/sample.md', note: `token ${secret}` };
    const result = await tool.execute(args);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
    assert.equal(result.bridgeStatus, expected);
    const row = JSON.parse((await readFile(usageShardPath(root), 'utf8')).trim());
    assert.equal(row.correlationId, result.correlationId);
    assert.equal(adoption.length, 1);
    assert.deepEqual(adoption[0], { schemaVersion: 1, eventId: result.correlationId, objectKey: args.href, kind: args.kind, note: row.note });
    assert.equal(adoptionLedger[0].trim().split('\n').length, 1);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(adoption), new RegExp(secret));
    const rendered = tool.output.render(args, result)[0].text;
    assert.match(rendered, expected === 'appended' ? /报告已追加/ : expected === 'invalid' ? /判为无效/ : /无法排除已经写入/);
  });
}

test('unique IDs and oversized note leave source records readable', async t => {
  const { root, tools, adoption } = await fixture(t, 'new:validate');
  const tool = tools.get('memory_usage');
  const args = { action: 'record', kind: 'correction', href: 'functions/sample.md', note: 'x'.repeat(2049) };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = await tool.execute(args);
  const second = await tool.execute(args);
  assert.equal(first.bridgeStatus, 'invalid');
  assert.notEqual(first.correlationId, second.correlationId);
  const rows = (await readFile(usageShardPath(root), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].t, rows[1].t);
  assert.deepEqual(rows.map(row => row.correlationId), [first.correlationId, second.correlationId]);
  assert.equal(adoption.length, 2);
  const report = await tool.execute({ action: 'report' });
  assert.equal(report.scanStatus, 'complete');
  assert.equal(report.items[0].corrections, 2);
});

test('call card redacts credentials and does not retain caller input', async t => {
  const { tools } = await fixture(t);
  const tool = tools.get('memory_usage');
  const secret = 'sk-' + 'x'.repeat(24);
  for (const kind of ['positive', 'correction', 'read', 'recall']) {
    const args = { action: 'record', kind, href: `functions/${secret}.md`, note: `token ${secret}`, extra: { secret } };
    const card = tool.presentCall(args);
    assert.doesNotMatch(JSON.stringify(card), new RegExp(secret));
    assert.match(JSON.stringify(card), /REDACTED/);
    assert.equal(card.rawInput.kind, kind);
    assert.notEqual(card.rawInput, args);
    assert.equal('extra' in card.rawInput, false);
    args.note = 'changed';
    assert.notEqual(card.rawInput.note, args.note);
  }
  const throwing = { get action() { throw new Error(secret); }, get href() { throw new Error(secret); },
    get note() { throw new Error(secret); }, get days() { throw new Error(secret); } };
  assert.doesNotMatch(JSON.stringify(tool.presentCall(throwing)) ?? '', new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(tool.presentCall({ action: secret })) ?? '', new RegExp(secret));
});

test('invalid or credential-shaped source keys never reach either ledger', async t => {
  const { root, tools, adoption } = await fixture(t, 'new:appended');
  const tool = tools.get('memory_usage');
  const secret = 'sk-' + 'x'.repeat(24);
  const bad = ['functions/a..b.md', `functions/${'a'.repeat(61)}.md`, 'functions/a\u0001b.md', 'functions/\ud800.md'];
  for (const href of bad) {
    for (const kind of ['positive', 'correction']) {
      await assert.rejects(tool.execute({ action: 'record', kind, href }), /记忆路径无效/);
    }
  }
  for (const kind of ['positive', 'correction', 'read', 'recall']) {
    await assert.rejects(tool.execute({ action: 'record', kind, href: `functions/${secret}.md` }), error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return /记忆路径无效/.test(error.message);
    });
  }
  assert.equal(adoption.length, 0);
  await assert.rejects(readFile(usageShardPath(root), 'utf8'), { code: 'ENOENT' });
});

test('legacy read accepts a broad noncanonical path without bridging', async t => {
  const { root, tools, adoption } = await fixture(t, 'new:appended');
  const result = await tools.get('memory_usage').execute({ action: 'record', kind: 'read', href: 'functions/a..b.md' });
  const row = JSON.parse((await readFile(usageShardPath(root), 'utf8')).trim());
  assert.equal(row.href, 'functions/a..b.md');
  assert.equal('correlationId' in row, false);
  assert.equal('bridgeStatus' in result, false);
  assert.equal(adoption.length, 0);
});

test('registered record redacts one note consistently in ledger, bridge, and receipt', async t => {
  const { root, tools, adoption } = await fixture(t);
  const tool = tools.get('memory_usage');
  const synthetic = 'sk-' + 'x'.repeat(24);
  const args = { action: 'record', kind: 'correction', href: 'functions/sample.md', note: `Confirmed ${synthetic}` };
  const result = await tool.execute(args);
  const ledger = await readFile(usageShardPath(root), 'utf8');
  const note = JSON.parse(ledger).note;
  const receipt = tool.output.render(args, result)[0].text;
  assert.equal(note, 'Confirmed [REDACTED:openai-key]');
  assert.equal(adoption[0].note, note);
  assert.ok(receipt.includes(note));
  for (const value of [ledger, JSON.stringify(adoption), JSON.stringify(result), receipt]) {
    assert.equal(value.includes(synthetic), false);
  }
});

test('registered record reports unconfirmed writes and never forwards adoption', async t => {
  const { root, tools, adoption } = await fixture(t);
  await writeFile(path.join(root, '.usage'), 'not a directory');
  const tool = tools.get('memory_usage');
  for (const kind of ['positive', 'correction']) {
    await assert.rejects(tool.execute({ action: 'record', kind, href: 'functions/sample.md' }),
      error => /写入未确认/.test(error.message) && /可能已部分写入/.test(error.message) && /未桥接治理/.test(error.message) && /关联 ID：[0-9a-f-]{36}/.test(error.message) && /禁止盲目重试/.test(error.message));
  }
  assert.deepEqual(adoption, []);
  assert.ok(usageWriteHealth().failure);
  assert.equal(await readFile(path.join(root, '.usage'), 'utf8'), 'not a directory');
});

test('an appendFile failure also prevents the governance bridge', async t => {
  const { root, tools, adoption } = await fixture(t);
  await mkdir(path.join(root, '.usage'));
  await mkdir(usageShardPath(root));
  await assert.rejects(tools.get('memory_usage').execute({ action: 'record', kind: 'positive', href: 'functions/sample.md' }),
    error => /写入未确认/.test(error.message) && /可能已部分写入/.test(error.message) && /未桥接治理/.test(error.message) && /关联 ID：[0-9a-f-]{36}/.test(error.message) && /禁止盲目重试/.test(error.message));
  assert.deepEqual(adoption, []);
  assert.ok(usageWriteHealth().failure);
});

test('automatic read remains usable when usage logging fails', async t => {
  const { root, tools, adoption } = await fixture(t);
  await writeFile(path.join(root, '.usage'), 'not a directory');
  const result = await tools.get('memory_read').execute({ kind: 'function', name: 'sample' });
  assert.equal(result.found, true);
  assert.equal(result.content, 'Example memory');
  assert.ok(usageWriteHealth().failure);
  assert.deepEqual(adoption, []);
});
