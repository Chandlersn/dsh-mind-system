import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';
import { createExecutionRuntimePlugin } from '../src/plugin.js';
import * as hostEntry from '../src/host-plugin.js';

const contract = () => ({ schemaVersion: 1, predicate: { id: 'file_sha256', version: 1 },
  output: { path: 'output.txt', sha256: 'a'.repeat(64) } });
const task = (root) => ({ taskId: 'bound', recipeId: 'csv-normalize', recipeVersion: '1',
  goal: 'Check output', scopeRef: 'scope', workspaceRoot: root, inputs: { nested: { value: 1 } },
  deadlineAt: Date.now() + 60000 });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'recovery-wiring-'));
  const storage = join(root, 'storage');
  const stateDir = join(root, 'state');
  mkdirSync(storage); mkdirSync(stateDir);
  const registered = new Map();
  const tools = { validateArgs: () => [], register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } };
  const ctx = { tools, get(key) { return key === 'tools' ? tools : undefined; } };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, storage, stateDir, registered, ctx };
}
function seed(filename, entry, canonicalRoot) {
  const store = new RuntimeStore(filename);
  store.createRun(entry, { acceptanceBinding: { nativeRef: entry.taskId, contract: entry.acceptanceContract,
    authority: { schemaVersion: 1, scopeRef: entry.scopeRef, workspaceRoot: canonicalRoot, allowedTools: entry.allowedTools } } });
  store.close();
}

test('host diagnosis observes frozen registration, drift, missing bindings and read-only behavior', async (t) => {
  const host = fixture(t);
  const filename = join(host.stateDir, 'runtime.sqlite');
  const entry = { ...task(host.storage), acceptanceContract: contract(), allowedTools: ['fixture_tool'] };
  seed(filename, entry, realpathSync(host.storage));
  const config = { enabled: true, stateDir: host.stateDir, workspaceRoot: host.storage, tasks: [entry] };
  let dispose = await hostEntry.apply(host.ctx, config);
  const inspect = (taskId) => host.registered.get('runtime_recovery_diagnosis').execute({ taskId });
  const db = new DatabaseSync(filename);
  try {
    const before = db.prepare('SELECT * FROM runs').all();
    const events = db.prepare('SELECT * FROM events').all();
    assert.equal((await inspect('bound')).status, 'match');
    entry.inputs.nested.value = 99;
    entry.acceptanceContract.output.sha256 = 'b'.repeat(64);
    entry.allowedTools.push('other');
    assert.equal((await inspect('bound')).status, 'match');
    assert.equal((await inspect('missing')).status, 'unknown');
    assert.deepEqual(db.prepare('SELECT * FROM runs').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM events').all(), events);
    assert.equal(db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0);
    const original = db.prepare('SELECT native_ref, contract_json, authority_json FROM acceptance_bindings WHERE task_id = ?').get('bound');
    for (const [column, value] of [['native_ref', 'different'],
      ['contract_json', JSON.stringify({ ...contract(), output: { ...contract().output, sha256: 'c'.repeat(64) } })],
      ['authority_json', JSON.stringify({ schemaVersion: 1, scopeRef: 'other', workspaceRoot: realpathSync(host.storage), allowedTools: ['fixture_tool'] })]]) {
      db.prepare(`UPDATE acceptance_bindings SET ${column} = ? WHERE task_id = ?`).run(value, 'bound');
      assert.equal((await inspect('bound')).status, 'mismatch');
      db.prepare(`UPDATE acceptance_bindings SET ${column} = ? WHERE task_id = ?`).run(original[column], 'bound');
    }
    db.prepare('UPDATE acceptance_bindings SET authority_json = NULL WHERE task_id = ?').run('bound');
    assert.equal((await inspect('bound')).status, 'unknown');
    db.prepare('UPDATE acceptance_bindings SET authority_json = ? WHERE task_id = ?').run(original.authority_json, 'bound');
    await dispose();
    dispose = await hostEntry.apply(host.ctx, config);
    assert.equal((await inspect('bound')).status, 'mismatch');
    assert.equal((await inspect('bound')).recipeIdentity, 'unknown');
  } finally { db.close(); await dispose(); }
});

test('host diagnosis refuses retargeted and unresolved registration paths', async (t) => {
  const host = fixture(t);
  const other = join(host.root, 'other'); mkdirSync(other);
  const link = join(host.root, 'workspace-link');
  symlinkSync(host.storage, link, 'junction');
  const entry = { ...task(link), acceptanceContract: contract(), allowedTools: ['fixture_tool'] };
  seed(join(host.stateDir, 'runtime.sqlite'), entry, realpathSync(link));
  const dispose = await hostEntry.apply(host.ctx, { enabled: true, stateDir: host.stateDir, workspaceRoot: link, tasks: [entry] });
  const inspect = async () => (await host.registered.get('runtime_recovery_diagnosis').execute({ taskId: 'bound' })).status;
  try {
    assert.equal(await inspect(), 'match');
    unlinkSync(link);
    assert.equal(await inspect(), 'unknown');
    symlinkSync(other, link, 'junction');
    assert.equal(await inspect(), 'unknown');
  } finally { await dispose(); }
});

test('standalone diagnosis does not call factories and rejects forged arguments directly', async () => {
  let calls = 0;
  const tools = new Map();
  const store = { getRecoveryIdentitySnapshot() { return { coverage: 'bound', task: {}, binding: { authority: {} }, version: 1 }; },
    getRun() { throw new Error('corrupt run'); } };
  const plugin = createExecutionRuntimePlugin({ store, recipes: [], tasks: { bound: () => { calls++; } },
    validateArguments: () => [], owner: {} });
  plugin.apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } } });
  const diagnose = tools.get('runtime_recovery_diagnosis');
  assert.equal((await diagnose.execute({ taskId: 'bound' })).status, 'unknown');
  for (const input of [{}, { taskId: 'bound', authority: {} }, { taskId: '' }, null]) {
    await assert.rejects(diagnose.execute(input));
  }
  assert.equal(calls, 0);
  assert.equal(plugin.describe().executors, 0);
  assert.equal(plugin.describe().schedulers, 0);
});
