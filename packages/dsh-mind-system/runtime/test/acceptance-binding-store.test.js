import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';

const contract = () => ({ schemaVersion: 1, predicate: { id: 'file_sha256', version: 1 },
  output: { path: 'reports/result.json', sha256: 'a'.repeat(64) } });
const binding = () => ({ nativeRef: 'native-task', contract: contract(), authority: null });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-binding-'));
  const filename = join(root, 'runtime.sqlite');
  let store = new RuntimeStore(filename, { now: () => 1000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, reopen() { store.close(); store = new RuntimeStore(filename, { now: () => 1000 }); },
    task(id) { return { taskId: id, recipeId: 'recipe', recipeVersion: '1', goal: 'Check result',
      scopeRef: 'test', workspaceRoot: root, inputs: {}, deadlineAt: 100000 }; } };
}

test('authority is copied and serialized, while old rows remain without authority', (t) => {
  const f = fixture(t);
  const authority = { schemaVersion: 1, scopeRef: 'test', workspaceRoot: f.root, allowedTools: ['tool-a', 'tool-b'] };
  const expected = structuredClone(authority);
  f.store.createRun(f.task('new'), { acceptanceBinding: { ...binding(), authority } });
  authority.allowedTools.push('tool-c');
  assert.deepEqual(f.store.getAcceptanceBinding('new').authority, expected);
  f.store.getAcceptanceBinding('new').authority.allowedTools.pop();
  f.reopen();
  assert.deepEqual(f.store.getAcceptanceBinding('new').authority, expected);
  f.store.createRun(f.task('old'), { acceptanceBinding: binding() });
  f.store.withDatabase((db) => db.exec('ALTER TABLE acceptance_bindings DROP COLUMN authority_json'));
  f.reopen();
  assert.equal(f.store.getAcceptanceBinding('old').authority, null);
  assert.equal(f.store.getAcceptanceBinding('new').authority, null);
  assert.throws(() => f.store.resumeRun('old', { requireEnvironment: false }), { code: 'acceptance_recovery_unavailable' });
  assert.throws(() => f.store.startRepair('old', 'fake', { signature: 'fake' }), { code: 'acceptance_recovery_unavailable' });
  assert.throws(() => f.store.reconcileAttempt('old', 'fake', { resolution: 'absent', evidenceRef: 'fake' }), { code: 'acceptance_recovery_unavailable' });
});

test('invalid or corrupt authority fails closed', (t) => {
  const f = fixture(t);
  const authority = { schemaVersion: 1, scopeRef: 'test', workspaceRoot: f.root, allowedTools: ['tool-a'] };
  for (const change of [{ schemaVersion: 2 }, { scopeRef: '' }, { workspaceRoot: 'relative' },
    { allowedTools: [] }, { allowedTools: ['a', 'a'] }, { allowedTools: ['a\u0000b'] },
    { allowedTools: ['a'.repeat(257)] }, { allowedTools: Array.from({ length: 129 }, (_, i) => `t${i}`) }, { extra: true }]) {
    assert.throws(() => f.store.createRun(f.task('bad'), { acceptanceBinding: { ...binding(), authority: { ...authority, ...change } } }));
    assert.throws(() => f.store.getRun('bad'), { code: 'run_not_found' });
  }
  f.store.createRun(f.task('valid'), { acceptanceBinding: { ...binding(), authority } });
  for (const raw of ['{', JSON.stringify({ ...authority, schemaVersion: 2 }), JSON.stringify({ ...authority, allowedTools: ['a', 'a'] }), ' '.repeat(65537)]) {
    f.store.withDatabase((db) => db.prepare('UPDATE acceptance_bindings SET authority_json = ? WHERE task_id = ?').run(raw, 'valid'));
    assert.throws(() => f.store.getAcceptanceBinding('valid'), { code: 'invalid_acceptance_binding' });
  }
});

test('binding is copied, persists after reopening, and does not alter run or event payload', (t) => {
  const f = fixture(t);
  const given = binding();
  const expected = binding();
  const run = f.store.createRun(f.task('bound'), { acceptanceBinding: given });
  given.contract.output.path = 'changed';
  given.nativeRef = 'changed';
  assert.deepEqual(f.store.getAcceptanceBinding('bound'), expected);
  const returned = f.store.getAcceptanceBinding('bound');
  returned.contract.output.sha256 = 'b'.repeat(64);
  assert.deepEqual(f.store.getAcceptanceBinding('bound'), expected);
  assert.deepEqual(f.store.readEvents('bound')[0].payload, { task: run.task });
  assert.equal(Object.hasOwn(run.task, 'acceptanceBinding'), false);
  f.reopen();
  assert.deepEqual(f.store.getRun('bound'), run);
  assert.deepEqual(f.store.getAcceptanceBinding('bound'), expected);
});

test('unbound and legacy runs return null and duplicate creation never changes the binding', (t) => {
  const f = fixture(t);
  f.store.createRun(f.task('legacy'));
  f.store.createRun(f.task('bound'), { acceptanceBinding: binding() });
  assert.throws(() => f.store.createRun(f.task('legacy'), { acceptanceBinding: binding() }));
  const replacement = binding();
  replacement.nativeRef = 'other';
  assert.throws(() => f.store.createRun(f.task('bound'), { acceptanceBinding: replacement }));
  assert.equal(f.store.getAcceptanceBinding('legacy'), null);
  assert.equal(f.store.getAcceptanceBinding('missing'), null);
  assert.deepEqual(f.store.getAcceptanceBinding('bound'), binding());
  assert.equal(f.store.readEvents('bound').length, 1);
  f.reopen();
  assert.equal(f.store.getAcceptanceBinding('legacy'), null);
});

test('opening a legacy database without the binding table preserves its existing run', (t) => {
  const f = fixture(t);
  const before = f.store.createRun(f.task('legacy'));
  const events = f.store.readEvents('legacy');
  f.store.withDatabase((db) => db.exec('DROP TABLE acceptance_bindings'));
  f.reopen();
  assert.deepEqual(f.store.getRun('legacy'), before);
  assert.deepEqual(f.store.readEvents('legacy'), events);
  assert.equal(f.store.getAcceptanceBinding('legacy'), null);
});

test('binding and event failures roll back the whole creation transaction', (t) => {
  const f = fixture(t);
  for (const table of ['acceptance_bindings', 'events']) {
    f.store.withDatabase((db) => db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`));
    assert.throws(() => f.store.createRun(f.task(table), { acceptanceBinding: binding() }), /forced failure/);
    f.store.withDatabase((db) => {
      for (const target of ['runs', 'events', 'acceptance_bindings']) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${target} WHERE task_id = ?`).get(table).n, 0);
      }
      db.exec('DROP TRIGGER fail_insert');
    });
  }
});

test('invalid input and corrupt persisted values fail closed', (t) => {
  const f = fixture(t);
  for (const value of [null, {}, { ...binding(), extra: true }, { ...binding(), nativeRef: '' },
    { ...binding(), nativeRef: 'bad\0ref' }, { ...binding(), nativeRef: '\ud800' },
    { ...binding(), contract: { ...contract(), schemaVersion: 2 } }]) {
    assert.throws(() => f.store.createRun(f.task('invalid'), { acceptanceBinding: value }));
    assert.equal(f.store.snapshotRuns().runs.length, 0);
  }
  f.store.createRun(f.task('corrupt'), { acceptanceBinding: binding() });
  const cases = [
    ["native_ref = ''", []],
    ["native_ref = CAST(x'80' AS TEXT)", []],
    ["native_ref = CAST(x'610062' AS TEXT)", []],
    ["contract_json = ?", ['{']],
    ["contract_json = ?", [JSON.stringify({ ...contract(), schemaVersion: 2 })]],
    ["contract_json = ?", [JSON.stringify({ ...contract(), extra: true })]],
    ["contract_json = ?", [' '.repeat(5000)]],
    ["contract_json = CAST(x'80' AS TEXT)", []],
  ];
  for (const [assignment, args] of cases) {
    f.store.withDatabase((db) => {
      db.prepare('UPDATE acceptance_bindings SET native_ref = ?, contract_json = ? WHERE task_id = ?')
        .run('native-task', JSON.stringify(contract()), 'corrupt');
      db.prepare(`UPDATE acceptance_bindings SET ${assignment} WHERE task_id = ?`).run(...args, 'corrupt');
    });
    assert.throws(() => f.store.getAcceptanceBinding('corrupt'), { code: 'invalid_acceptance_binding' });
  }
});
