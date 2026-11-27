import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';

const hostEntry = path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const { validateJsonSchemaValue } = createRequire(hostEntry)(hostEntry);

async function snapshot(dir) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const info = await lstat(file);
    result[entry.name] = info.isDirectory() ? await snapshot(file) : (await readFile(file)).toString('hex');
  }
  return result;
}

test('registered inventory reports fixed metadata without writes or path overrides', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-retention-tool-'));
  const root = path.join(home, 'memory');
  const storage = path.join(home, 'storages');
  await mkdir(path.join(root, '.usage'), { recursive: true });
  await mkdir(path.join(root, '.stage'));
  await mkdir(path.join(root, '.write-ledger.jsonl'));
  await mkdir(storage);
  await writeFile(path.join(root, '.usage', '2026-01.jsonl'), 'secret');
  await writeFile(path.join(storage, 'mind-valves.jsonl'), '1234');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, set() {},
    get: () => undefined, inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }) };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(home, 'skills'), dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(async () => {
    dispose?.();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^memory-retention-tool-/);
    await rm(home, { recursive: true, force: true });
  });
  const tool = tools.get('memory_retention_inventory');
  assert.ok(tool);
  const before = await snapshot(home);
  const value = await tool.execute({});
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), []);
  assert.deepEqual(JSON.parse(tool.output.render({}, value)[0].text), value);
  const byName = Object.fromEntries(value.categories.map(item => [item.category, item]));
  assert.equal(byName.usage_shards.bytes, 6);
  assert.equal(byName.usage_shards.files, 1);
  assert.equal(byName.valves_decisions.bytes, 4);
  assert.equal(byName.write_ledger.unknown, true);
  assert.ok(byName.write_ledger.risks.includes('unexpected_type'));
  assert.ok(byName.usage_archive.risks.includes('missing'));
  assert.ok(byName.usage_shards.risks.includes('automatic_compaction_disabled'));
  assert.ok(byName.stage.risks.includes('automatic_orphan_cleanup_disabled'));
  assert.match(value.storageScope, /default.*unverified/);
  assert.ok(!JSON.stringify(value).includes('secret'));
  for (const args of [{ root }, { storageRoot: storage }, { action: 'delete' }]) {
    await assert.rejects(tool.execute(args), /accepts no arguments/);
  }
  assert.deepEqual(await snapshot(home), before);
});
