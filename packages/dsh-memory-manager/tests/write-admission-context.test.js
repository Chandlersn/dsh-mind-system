import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../server.js';
import { recordDownwardWrite } from '../src/valves-bridge.js';
import { contentHash } from '../src/write-ledger.js';
import { currentOperationId } from '../src/operation-context.js';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const valvesRoot = [new URL('../../dsh-valves/', import.meta.url), new URL('../../valves/', import.meta.url)].find(existsSync);
const { createRuntime } = await import(new URL('index.js', valvesRoot));
const { readDecisions } = await import(new URL('src/store.js', valvesRoot));

const mappings = [
  ['memory_write', { feature: ' shared.MD ', title: '', summary: '' }, 'write', 'function', 'functions/shared.md', /title is required/],
  ['memory_insight', { theme: ' shared.md ', principle: '', summary: '', sources: [] }, 'write', 'insight', 'insights/shared.md', /principle is required/],
  ['memory_dao', { name: ' shared.Md ', proposition: '', body: '', extractedFrom: [] }, 'active', 'dao', 'dao/shared.md', /body is required/],
  ['memory_dao', { name: 'shared', status: 'active', proposition: '', body: '', extractedFrom: [] }, 'active', 'dao', 'dao/shared.md', /body is required/],
  ['memory_dao', { name: ' shared.md ', status: 'candidate', proposition: '', body: '', extractedFrom: [] }, 'candidate', 'dao_candidate', 'dao/_candidates/shared.md', /body is required/],
  ['memory_capability', { action: 'record', name: ' shared.md ', feature: 'wrong-field' }, 'record', 'capability', 'capabilities/shared.md', /invocation is required/],
  ['memory_index', { zone: 'functions', name: ' shared.md ', summary: '' }, 'upsert', 'index_entry', 'functions/shared.md', /summary is required/],
  ['memory_index', { zone: 'insights', name: ' shared.md ', summary: '' }, 'upsert', 'index_entry', 'insights/shared.md', /summary is required/],
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function withoutRequestId(context) {
  assert.match(context.request_id, uuid);
  const { request_id, ...rest } = context;
  return rest;
}

function expected(tool, action, kind, key) {
  return { schema_version: 2, source: 'dsh-memory-manager', event: 'write_admission', mode: 'observational',
    tool, tool_action: action, target: kind ? { kind, key } : null, origin_basis: 'bridge_default',
    execution_result: 'not_observed', adoption: 'not_observed' };
}

async function fixture(t, factory) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-write-context-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root); await mkdir(skills);
  await writeFile(path.join(root, 'MEMORY.md'), '# Index\n');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const calls = [];
  const service = factory ? factory(home) : {
    negativeRules: async () => [], upward: () => undefined,
    downward: (from, to, data) => { calls.push({ from, to, data }); return { action: 'deny' }; },
  };
  const tools = new Map();
  const noop = () => {};
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop,
    get: name => name === 'valves' ? service : undefined, set() {},
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }) };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR,
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(async () => {
    dispose?.(); service?.dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^memory-write-context-/);
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, tools, calls, service };
}

for (const [tool, args, action, kind, key, error] of mappings) {
  test(`registered ${tool} ${action} maps ${key} before real validation`, async t => {
    const { tools, calls } = await fixture(t);
    await assert.rejects(tools.get(tool).execute(args), error);
    assert.equal(calls.length, 1);
    assert.deepEqual(withoutRequestId(calls[0].data.write_context), expected(tool, action, kind, key));
    assert.equal(calls[0].data.origin, 'daily');
    assert.ok(calls[0].data.write_context.tool.length <= 80);
    assert.ok(calls[0].data.write_context.target.key.length <= 1024);
  });
}

for (const [tool, args, action] of mappings.filter((_, i) => ![3, 7].includes(i))) {
  test(`registered ${tool} ${action} keeps invalid target null and preserves validation`, async t => {
    const { tools, calls } = await fixture(t);
    const field = tool === 'memory_write' ? 'feature' : tool === 'memory_insight' ? 'theme' : 'name';
    for (const value of [undefined, '', '../escape', 'x'.repeat(1025), 42, { name: 'not-a-slug' }]) {
      await assert.rejects(tools.get(tool).execute({ ...args, [field]: value }), /slug|invalid arguments/);
      assert.deepEqual(withoutRequestId(calls.at(-1).data.write_context), expected(tool, action, null));
    }
    assert.equal(calls.length, 6, 'Only pre-execution admissions, no completion events.');
  });
}

test('registered read and list branches emit no admission context', async t => {
  const { tools, calls, root } = await fixture(t);
  await mkdir(path.join(root, 'capabilities'));
  await writeFile(path.join(root, 'capabilities/example.md'), '# Example\n');
  await tools.get('memory_read').execute({ kind: 'index' });
  await tools.get('memory_capability').execute({ action: 'list' });
  await tools.get('memory_capability').execute({ action: 'read', name: 'example' });
  await tools.get('memory_dao').execute({ status: 'list_candidates', name: '', proposition: '', body: '', extractedFrom: [] });
  assert.deepEqual(calls, []);
});

test('denied observational admission preserves successful execution and receipt', async t => {
  const { tools, calls, root } = await fixture(t);
  const result = await tools.get('memory_capability').execute({ action: 'record', name: ' good.MD ',
    invocation: 'private-command --secret-content', note: 'raw-content-marker' });
  assert.equal(result.action, 'record');
  assert.match(await readFile(path.join(root, 'capabilities/good.md'), 'utf8'), /private-command/);
  assert.equal(calls.length, 1);
  assert.deepEqual(withoutRequestId(calls[0].data.write_context), expected('memory_capability', 'record', 'capability', 'capabilities/good.md'));
  assert.doesNotMatch(JSON.stringify(calls[0]), /private-command|raw-content-marker/);
  assert.equal(Object.hasOwn(result, 'write_context'), false);
});

test('throwing optional service neither blocks writes nor hides real validation', async t => {
  let admissions = 0;
  const { tools, root } = await fixture(t, () => ({ negativeRules: async () => [], upward() {},
    downward() { admissions++; throw new Error('observational outage'); } }));
  const result = await tools.get('memory_capability').execute({ action: 'record', name: 'works', invocation: 'works --help' });
  assert.equal(result.action, 'record');
  assert.match(await readFile(path.join(root, 'capabilities/works.md'), 'utf8'), /works --help/);
  await assert.rejects(tools.get('memory_write').execute({ feature: '../bad', title: '', summary: '' }), /invalid slug/);
  assert.equal(admissions, 2);
});

test('registered tools roundtrip context through actual valves runtime and persisted decisions', async t => {
  const { home, tools, service } = await fixture(t, home => createRuntime({ storageDir: path.join(home, 'valves') }));
  for (const [tool, args, , , , error] of mappings) await assert.rejects(tools.get(tool).execute(args), error);
  const receipt = await tools.get('memory_capability').execute({ action: 'record', name: ' persisted.MD ', invocation: 'fixture --version' });
  assert.equal(receipt.action, 'record');
  await assert.rejects(tools.get('memory_write').execute({ feature: '../bad', title: '', summary: '' }), /invalid slug/);
  recordDownwardWrite({ get: name => name === 'valves' ? service : undefined }, { tool: 'memory_write', target: 'legacy' });
  let rows = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    rows = await readDecisions(path.join(home, 'valves'));
    if (rows.length === mappings.length + 3) break;
    await delay(10);
  }
  assert.equal(rows.length, mappings.length + 3);
  const contexts = rows.filter(row => Object.hasOwn(row, 'write_context')).map(row => row.write_context);
  const wanted = mappings.map(([tool, , action, kind, key]) => expected(tool, action, kind, key));
  wanted.push(expected('memory_capability', 'record', 'capability', 'capabilities/persisted.md'));
  wanted.push(expected('memory_write', 'write', null));
  assert.deepEqual(contexts.map(withoutRequestId).map(JSON.stringify).sort(), wanted.map(JSON.stringify).sort());
  assert.equal(new Set(contexts.map(context => context.request_id)).size, contexts.length);
  assert.equal(rows.filter(row => !Object.hasOwn(row, 'write_context')).length, 1, 'Legacy absence remains absent.');
  for (const row of rows) {
    assert.equal(row.origin, 'daily');
    assert.equal(row.direction, 'down');
  }
  assert.equal(Object.hasOwn(receipt, 'write_context'), false);
});

test('real repeated writes pair durable admissions with raw operations and independently read bytes', async t => {
  const { home, root, tools } = await fixture(t, home => createRuntime({ storageDir: path.join(home, 'valves') }));
  const file = path.join(root, 'capabilities/repeated.md');
  const hashes = [];
  for (const invocation of ['first-command --help', 'second-command --version']) {
    const receipt = await tools.get('memory_capability').execute({ action: 'record', name: 'repeated', invocation, request_id: 'caller-spoof' });
    assert.equal(receipt.action, 'record');
    const bytes = await readFile(file, 'utf8');
    assert.ok(bytes.includes(invocation));
    hashes.push(contentHash(bytes));
    assert.equal(currentOperationId(), undefined);
    assert.equal(Object.hasOwn(receipt, 'request_id'), false);
  }
  let admissions = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    admissions = await readDecisions(path.join(home, 'valves'));
    if (admissions.length === 2) break;
    await delay(10);
  }
  assert.equal(admissions.length, 2);
  const operations = (await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map(row => row.hash), hashes);
  assert.equal(new Set(operations.map(row => row.request_id)).size, 2);
  for (const operation of operations) {
    assert.match(operation.request_id, uuid);
    assert.equal(operation.key, 'capabilities/repeated.md');
    const admission = admissions.find(row => row.write_context?.request_id === operation.request_id);
    assert.ok(admission);
    assert.deepEqual(withoutRequestId(admission.write_context), expected('memory_capability', 'record', 'capability', operation.key));
  }
});

for (const fault of ['cleanup', 'append_ack', 'commit_ack']) {
  test(`registered write preserves correlation and uncertainty after ${fault} failure`, async t => {
    const { root, tools, calls } = await fixture(t);
    const file = path.join(root, 'capabilities/partial.md');
    await tools.get('memory_capability').execute({ action: 'record', name: 'partial', invocation: 'before-command' });
    const original = fs.promises[fault === 'append_ack' ? 'appendFile' : 'rename'];
    const method = fault === 'append_ack' ? 'appendFile' : 'rename';
    let triggered = 0;
    fs.promises[method] = async (...args) => {
      const matches = fault === 'append_ack' ? String(args[0]) === path.join(root, '.write-ledger.jsonl') : String(args[1]) === file;
      const result = await original(...args);
      if (matches) {
        triggered++;
        if (fault === 'cleanup') await writeFile(args[0], 'replacement stage sentinel', { flag: 'wx' });
        else throw Object.assign(new Error('injected acknowledgement loss'), { code: 'EIO' });
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      const codes = { cleanup: 'MEMORY_STAGE_CLEANUP_DEFERRED', append_ack: 'MEMORY_LEDGER_APPEND_FAILED', commit_ack: 'MEMORY_WRITE_COMMIT_UNKNOWN' };
      await assert.rejects(tools.get('memory_capability').execute({ action: 'record', name: 'partial', invocation: 'after-command' }), error => error.code === codes[fault]);
    } finally {
      fs.promises[method] = original;
      syncBuiltinESMExports();
    }
    assert.equal(triggered, 1);
    assert.equal(currentOperationId(), undefined);
    const bytes = await readFile(file, 'utf8');
    assert.match(bytes, /after-command/);
    const operations = (await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(operations.length, fault === 'commit_ack' ? 1 : 2);
    assert.equal(operations[0].request_id, calls[0].data.write_context.request_id);
    if (fault !== 'commit_ack') {
      assert.equal(operations[1].request_id, calls[1].data.write_context.request_id);
      assert.equal(operations[1].hash, contentHash(bytes));
    }
    assert.equal(calls.length, 2, 'Failures do not create completion decisions.');
  });
}

test('superseding insight retains separate physical rows while index admission stays logical', async t => {
  const { root, tools, calls } = await fixture(t);
  await mkdir(path.join(root, 'functions'));
  await mkdir(path.join(root, 'insights'));
  for (const source of ['one', 'two']) await writeFile(path.join(root, `functions/${source}.md`), `# ${source}\n`);
  await writeFile(path.join(root, 'insights/old.md'), '# Old principle\n');
  await tools.get('memory_insight').execute({ theme: 'replacement', supersedes: 'old',
    principle: 'Independent evidence limits the scope of conclusions', summary: 'Evidence boundaries',
    sources: ['one', 'two'], applicability: '适用于多源判断；不适用于没有观测依据的情形。' });
  const ledgerPath = path.join(root, '.write-ledger.jsonl');
  const before = await readFile(ledgerPath, 'utf8');
  const operations = before.trim().split('\n').map(JSON.parse);
  assert.deepEqual(operations.map(row => row.key).sort(), ['insights/old.md', 'insights/replacement.md']);
  for (const row of operations) {
    assert.equal(row.request_id, calls[0].data.write_context.request_id);
    assert.equal(row.hash, contentHash(await readFile(path.join(root, row.key), 'utf8')));
  }
  const originalBody = await readFile(path.join(root, 'functions/one.md'), 'utf8');
  await tools.get('memory_index').execute({ zone: 'functions', name: 'one', summary: 'Logical index only' });
  assert.equal(calls[1].data.write_context.target.kind, 'index_entry');
  assert.equal(await readFile(ledgerPath, 'utf8'), before);
  assert.equal(await readFile(path.join(root, 'functions/one.md'), 'utf8'), originalBody);
  assert.match(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), /Logical index only/);
});

test('candidate and active dao writes keep separate keys and invocation identities', async t => {
  const { root, tools, calls } = await fixture(t);
  await mkdir(path.join(root, 'insights'));
  const laws = ['law-one', 'law-two', 'law-three', 'law-four', 'law-five'];
  for (const law of laws) await writeFile(path.join(root, `insights/${law}.md`), `# ${law}\n\n## 核心原则\n\n- 互相独立的测试原则。\n`);
  const args = { name: 'same-dao', proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: laws,
    body: '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n' };
  await tools.get('memory_dao').execute({ ...args, status: 'candidate' });
  await tools.get('memory_dao').execute({ ...args, status: 'active' });
  const operations = (await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(operations.map(row => row.key), ['dao/_candidates/same-dao.md', 'dao/same-dao.md']);
  assert.notEqual(operations[0].request_id, operations[1].request_id);
  for (let index = 0; index < operations.length; index++) {
    const row = operations[index];
    assert.equal(row.request_id, calls[index].data.write_context.request_id);
    assert.equal(row.hash, contentHash(await readFile(path.join(root, row.key), 'utf8')));
  }
});

test('missing optional service still writes correlated physical rows without inventing admissions', async t => {
  const { root, tools } = await fixture(t, () => undefined);
  await tools.get('memory_capability').execute({ action: 'record', name: 'offline', invocation: 'offline-command' });
  assert.match(await readFile(path.join(root, 'capabilities/offline.md'), 'utf8'), /offline-command/);
  const operation = JSON.parse((await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8')).trim());
  assert.match(operation.request_id, uuid);
});
