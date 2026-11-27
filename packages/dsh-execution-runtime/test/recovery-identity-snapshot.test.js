import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'recovery-identity-'));
  const filename = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(filename, { now: () => 1000 });
  const other = new DatabaseSync(filename);
  t.after(() => { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = (taskId) => ({ taskId, recipeId: 'recipe', recipeVersion: '1', goal: 'Check result',
    scopeRef: 'test', workspaceRoot: root, inputs: {}, deadlineAt: 100000 });
  const contract = { schemaVersion: 1, predicate: { id: 'file_sha256', version: 1 },
    output: { path: 'result.json', sha256: 'a'.repeat(64) } };
  const authority = { schemaVersion: 1, scopeRef: 'test', workspaceRoot: root, allowedTools: ['tool'] };
  return { store, other, task, contract, authority };
}

test('bound, unbound, missing and legacy authority are explicit and read-only', (t) => {
  const f = fixture(t);
  const bound = f.store.createRun(f.task('bound'), { acceptanceBinding: { nativeRef: 'native', contract: f.contract, authority: f.authority } });
  const legacy = f.store.createRun(f.task('legacy'), { acceptanceBinding: { nativeRef: 'old', contract: f.contract } });
  const unbound = f.store.createRun(f.task('unbound'));
  const before = f.other.prepare('SELECT * FROM runs ORDER BY task_id').all();
  const events = f.other.prepare('SELECT * FROM events ORDER BY sequence').all();
  assert.deepEqual(f.store.getRecoveryIdentitySnapshot('bound'), { coverage: 'bound', task: bound.task, version: 0,
    binding: { nativeRef: 'native', contract: f.contract, authority: f.authority } });
  assert.deepEqual(f.store.getRecoveryIdentitySnapshot('legacy'), { coverage: 'bound', task: legacy.task, version: 0,
    binding: { nativeRef: 'old', contract: f.contract, authority: null } });
  assert.deepEqual(f.store.getRecoveryIdentitySnapshot('unbound'), { coverage: 'unbound', task: unbound.task, version: 0 });
  assert.deepEqual(f.store.getRecoveryIdentitySnapshot('missing'), { coverage: 'missing' });
  assert.deepEqual(f.other.prepare('SELECT * FROM runs ORDER BY task_id').all(), before);
  assert.deepEqual(f.other.prepare('SELECT * FROM events ORDER BY sequence').all(), events);
  assert.equal(f.other.prepare('SELECT count(*) AS n FROM attempts').get().n, 0);
});

test('corrupt, truncated, malformed and oversized identities fail closed', (t) => {
  const f = fixture(t);
  f.store.createRun(f.task('bad'), { acceptanceBinding: { nativeRef: 'native', contract: f.contract, authority: f.authority } });
  const saved = f.other.prepare('SELECT task_json FROM runs WHERE task_id = ?').get('bad').task_json;
  const reset = () => {
    f.other.prepare('UPDATE runs SET task_json = ?, version = 0 WHERE task_id = ?').run(saved, 'bad');
    f.other.prepare('UPDATE acceptance_bindings SET native_ref = ?, contract_json = ?, authority_json = ? WHERE task_id = ?')
      .run('native', JSON.stringify(f.contract), JSON.stringify(f.authority), 'bad');
  };
  const corruptions = [
    ["UPDATE runs SET task_json = CAST(x'80' AS TEXT)", []],
    ["UPDATE runs SET task_json = CAST(x'7b007d' AS TEXT)", []],
    ['UPDATE runs SET task_json = ?', [' '.repeat(65537)]],
    ['UPDATE runs SET task_json = ?', [JSON.stringify({ ...JSON.parse(saved), taskId: 'other' })]],
    ['UPDATE runs SET task_json = ?', [JSON.stringify({ ...JSON.parse(saved), extra: true })]],
    ['UPDATE runs SET task_json = ?', [JSON.stringify({ ...JSON.parse(saved), goal: 'bad\0goal' })]],
    ['UPDATE runs SET version = -1', []],
    ["UPDATE acceptance_bindings SET native_ref = CAST(x'80' AS TEXT)", []],
    ["UPDATE acceptance_bindings SET native_ref = CAST(x'610062' AS TEXT)", []],
    ['UPDATE acceptance_bindings SET native_ref = ?', ['x'.repeat(4097)]],
    ['UPDATE acceptance_bindings SET contract_json = ?', [' '.repeat(4097)]],
    ['UPDATE acceptance_bindings SET contract_json = ?', ['{}']],
    ["UPDATE acceptance_bindings SET authority_json = CAST(x'80' AS TEXT)", []],
    ['UPDATE acceptance_bindings SET authority_json = ?', [' '.repeat(65537)]],
    ['UPDATE acceptance_bindings SET authority_json = ?', ['{}']],
  ];
  for (const [sql, args] of corruptions) {
    reset();
    f.other.prepare(`${sql} WHERE task_id = ?`).run(...args, 'bad');
    assert.deepEqual(f.store.getRecoveryIdentitySnapshot('bad'), { coverage: 'unavailable' }, sql);
  }
  for (const input of ['', null, 'bad\0id', '\ud800', 'x'.repeat(4097)]) {
    assert.deepEqual(f.store.getRecoveryIdentitySnapshot(input), { coverage: 'unavailable' });
  }
  reset();
  f.other.prepare('DELETE FROM acceptance_bindings WHERE task_id = ?').run('bad');
  f.other.prepare('UPDATE runs SET task_json = ? WHERE task_id = ?').run('{}', 'bad');
  assert.deepEqual(f.store.getRecoveryIdentitySnapshot('bad'), { coverage: 'unavailable' });
});

test('the joined statement sees coherent cross-connection commits and no uncommitted changes', (t) => {
  const f = fixture(t);
  f.store.createRun(f.task('race'), { acceptanceBinding: { nativeRef: 'before', contract: f.contract } });
  f.other.exec('BEGIN IMMEDIATE');
  f.other.prepare('UPDATE runs SET version = 1 WHERE task_id = ?').run('race');
  f.other.prepare('UPDATE acceptance_bindings SET native_ref = ? WHERE task_id = ?').run('after', 'race');
  let snapshot = f.store.getRecoveryIdentitySnapshot('race');
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.binding.nativeRef, 'before');
  f.other.exec('COMMIT');
  snapshot = f.store.getRecoveryIdentitySnapshot('race');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.binding.nativeRef, 'after');
  f.store.withDatabase((db) => db.exec('PRAGMA query_only = ON'));
  assert.equal(f.store.getRecoveryIdentitySnapshot('race').binding.nativeRef, 'after');
});
