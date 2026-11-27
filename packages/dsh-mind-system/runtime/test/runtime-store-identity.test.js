import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { RuntimeStore } from '../src/store.js';
import { createExecutionRuntimePlugin } from '../src/plugin.js';
import * as entry from '../src/host-plugin.js';
import { createHost, installed } from './helpers/host.js';

const expected = (filename) => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const file = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main').file;
    return createHash('sha256').update(`sqlite-main-path-v1\0${file}`, 'utf8').digest('hex');
  } finally { db.close(); }
};

test('host status identifies the opened store and respects configuration precedence', async (t) => {
  const host = await createHost(t);
  const home = join(host.root, 'home');
  const alternate = join(host.root, 'alternate');
  const override = join(host.root, 'override');
  mkdirSync(home); mkdirSync(alternate); mkdirSync(override);
  process.env.DSH_HOME = home;
  let fiber = await host.ctx.plugin(entry.plugin, { enabled: true, workspaceRoot: host.storage });
  await fiber.await();
  try {
    process.env.DSH_HOME = alternate;
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.equal(status.isError, false);
    assert.deepEqual(status.value.storeIdentity, { status: 'available',
      identity: expected(join(home, 'execution-runtime', 'runtime.sqlite')),
      provenance: 'sqlite_database_list_main_path_sha256', pathSemantics: 'sqlite_reported_path_not_file_identity' });
    assert.doesNotMatch(JSON.stringify(status.value.storeIdentity), /runtime\.sqlite|execution-runtime/);
    const tool = host.tools.get('runtime_status');
    const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
    assertObjectJsonSchema(tool.parameters);
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, {}), []);
  } finally { await fiber.dispose(); }
  fiber = await host.ctx.plugin(entry.plugin, { enabled: true, stateDir: override, workspaceRoot: host.storage });
  await fiber.await();
  try {
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.equal(status.value.storeIdentity.identity, expected(join(override, 'runtime.sqlite')));
    assert.notEqual(status.value.storeIdentity.identity, expected(join(home, 'execution-runtime', 'runtime.sqlite')));
  } finally { await fiber.dispose(); }
});

test('SQLite path hashing follows SQLite spelling through a directory junction', async (t) => {
  const host = await createHost(t);
  const target = join(host.root, 'target');
  const link = join(host.root, 'alias');
  mkdirSync(target);
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const filename = join(link, 'runtime.sqlite');
  const store = new RuntimeStore(filename);
  try { assert.equal(store.getStoreIdentity().identity, expected(filename)); }
  finally { store.close(); }
});

test('in-memory, closed and custom stores report bounded unavailability', async (t) => {
  const memory = new RuntimeStore(':memory:');
  assert.deepEqual(memory.getStoreIdentity(), { status: 'unavailable', reason: 'in_memory' });
  memory.close();
  assert.deepEqual(memory.getStoreIdentity(), { status: 'unavailable', reason: 'sqlite_identity_read_failed' });
  const host = await createHost(t);
  const closed = new RuntimeStore(':memory:');
  closed.close();
  for (const [store, reason] of [[new RuntimeStore(':memory:'), 'in_memory'], [closed, 'sqlite_identity_read_failed'],
    [{ getStoreIdentity() { throw new Error('secret'); } }, 'custom_adapter']]) {
    const plugin = createExecutionRuntimePlugin({ store, recipes: [], tasks: {}, owner: host.ctx, validateArguments: () => [] });
    const fiber = await host.ctx.plugin(plugin, {});
    await fiber.await();
    try {
      const result = await host.execute('runtime_status', { arguments: {} });
      assert.deepEqual(result.value.storeIdentity, { status: 'unavailable', reason });
      assert.doesNotMatch(JSON.stringify(result.value), /secret/);
    } finally { await fiber.dispose(); if (store instanceof RuntimeStore && store !== closed) store.close(); }
  }
});
