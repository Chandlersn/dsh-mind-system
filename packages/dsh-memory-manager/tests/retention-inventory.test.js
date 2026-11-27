import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retentionInventory } from '../src/retention-inventory.js';
import { AUTO_DAILY_ARCHIVE_ENABLED } from '../src/daily-archive.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const memoryRoot = path.join(base, 'memory-private');
  const storageRoot = path.join(base, 'storage-private');
  await fs.mkdir(memoryRoot);
  await fs.mkdir(storageRoot);
  return { base, memoryRoot, storageRoot };
}

async function snapshot(root) {
  const result = [];
  async function visit(file, relative) {
    const st = await fs.lstat(file);
    result.push([relative, st.mode, st.size, st.mtimeMs, st.ctimeMs, st.isFile() ? await fs.readFile(file, 'hex') : null]);
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
    }
  }
  await visit(root, '.');
  return result;
}

test('requires explicit absolute roots and bounded integer limits', async () => {
  await assert.rejects(retentionInventory(), TypeError);
  await assert.rejects(retentionInventory({ memoryRoot: '.', storageRoot: '.' }), TypeError);
  await assert.rejects(retentionInventory({ memoryRoot: path.resolve('.'), storageRoot: path.resolve('.'), maxEntries: 10001 }), RangeError);
});

test('missing roots are unknown while missing locations are empty and never created', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.base);
  const result = await retentionInventory({ memoryRoot: path.join(f.base, 'missing'), storageRoot: f.storageRoot });
  for (const [category, item] of Object.entries(result.categories)) {
    assert.equal(item.files, 0);
    assert.equal(item.bytes, 0);
    const missingRoot = !['valves_decisions', 'clis_history', 'clis_interventions'].includes(category);
    assert.equal(item.unknown, missingRoot);
    if (missingRoot) assert.ok(item.risks.includes('root_missing'));
    else assert.ok(item.risks.includes('missing'));
  }
  assert.deepEqual(await snapshot(f.base), before);
  assert.equal(AUTO_DAILY_ARCHIVE_ENABLED, false);
  assert.deepEqual(result.risks, ['non_atomic_snapshot', 'no_cleanup_authority', 'automatic_daily_archive_paused']);
  assert.ok(result.categories.usage_shards.risks.includes('automatic_compaction_disabled'));
  assert.ok(result.categories.stage.risks.includes('automatic_orphan_cleanup_disabled'));
});

test('an empty existing directory is distinguishable from a missing category', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.memoryRoot, '.stage'));
  const result = await retentionInventory(f);
  assert.equal(result.categories.stage.files, 0);
  assert.equal(result.categories.stage.unknown, false);
  assert.ok(!result.categories.stage.risks.includes('missing'));
  assert.ok(result.categories.usage_shards.risks.includes('missing'));
  assert.equal(result.categories.usage_shards.unknown, false);
});

test('counts only fixed categories without leaking paths or content and without changing input', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.memoryRoot, '.usage', 'archive'), { recursive: true });
  await fs.mkdir(path.join(f.memoryRoot, '.stage'));
  const files = [
    [f.memoryRoot, '.usage/2026-11.jsonl', 'aaa'],
    [f.memoryRoot, '.usage/archive/2026-10.jsonl', 'abcd'],
    [f.memoryRoot, '.usage/not-a-shard', 'private-secret'],
    [f.memoryRoot, '.usage.jsonl', 'ab'],
    [f.memoryRoot, '.write-ledger.jsonl', 'abcde'],
    [f.memoryRoot, '.stage/stage-secret', 'abcdef'],
    [f.storageRoot, 'mind-valves.jsonl', 'abcdefg'],
    [f.storageRoot, 'clis-history.json', 'abcdefgh'],
    [f.storageRoot, 'clis-interventions.jsonl', 'abcdefghi'],
    [f.storageRoot, 'unrelated', 'private-secret'],
  ];
  for (const [root, name, content] of files) await fs.writeFile(path.join(root, name), content);
  const before = await snapshot(f.base);
  const result = await retentionInventory(f);
  for (const [category, bytes] of Object.entries({ usage_shards: 3, usage_archive: 4, usage_legacy: 2, write_ledger: 5, stage: 6, valves_decisions: 7, clis_history: 8, clis_interventions: 9 })) {
    assert.equal(result.categories[category].files, 1);
    assert.equal(result.categories[category].bytes, bytes);
    assert.equal(result.categories[category].unknown, false);
  }
  assert.doesNotMatch(JSON.stringify(result), /private|secret|2026-11|memory-private|storage-private/);
  assert.deepEqual(await snapshot(f.base), before);
});

test('unexpected types and filesystem exceptions report unknown without exposing errors', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.memoryRoot, '.usage'), 'not a directory');
  await fs.mkdir(path.join(f.storageRoot, 'mind-valves.jsonl'));
  const result = await retentionInventory(f);
  assert.deepEqual(result.categories.usage_archive.risks, ['unexpected_type']);
  assert.equal(result.categories.valves_decisions.unknown, true);
  const failure = await retentionInventory({ memoryRoot: path.join(f.base, 'private\0invalid'), storageRoot: f.storageRoot });
  assert.equal(failure.categories.usage_legacy.unknown, true);
  assert.deepEqual(failure.categories.usage_legacy.risks, ['unavailable']);
  assert.doesNotMatch(JSON.stringify(failure), /xxxxx|memory-private/);
});

test('bounded enumeration reports truncation and never claims a complete count', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.memoryRoot, '.stage'));
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(f.memoryRoot, '.stage', String(i)), '123');
  const result = await retentionInventory({ ...f, maxEntries: 2 });
  assert.equal(result.categories.stage.files, 2);
  assert.equal(result.categories.stage.bytes, 6);
  assert.equal(result.categories.stage.unknown, true);
  assert.ok(result.categories.stage.risks.includes('limit_reached'));
});

test('symlink roots, nested directories and files are not followed', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '2026-01.jsonl'), 'outside-secret');
  await fs.mkdir(path.join(f.memoryRoot, '.usage'));
  await fs.mkdir(path.join(f.memoryRoot, '.stage'));
  try {
    await fs.symlink(outside, path.join(f.memoryRoot, '.usage', 'archive'), 'junction');
    await fs.symlink(outside, path.join(f.memoryRoot, '.stage', 'link'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlink creation unavailable');
    throw error;
  }
  const result = await retentionInventory(f);
  assert.equal(result.categories.usage_archive.unknown, true);
  assert.ok(result.categories.usage_archive.risks.includes('symlink'));
  assert.equal(result.categories.usage_archive.files, 0);
  assert.equal(result.categories.stage.files, 0);
  assert.ok(result.categories.stage.risks.includes('symlink'));
  const rootLink = path.join(f.base, 'root-link');
  await fs.symlink(outside, rootLink, 'junction');
  const linked = await retentionInventory({ memoryRoot: rootLink, storageRoot: f.storageRoot });
  assert.ok(linked.categories.usage_legacy.risks.includes('symlink'));
});
