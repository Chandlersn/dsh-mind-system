import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-delete-unavailable-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(skills, { recursive: true });
  for (const zone of ['functions', 'insights', 'capabilities']) {
    await mkdir(path.join(root, zone, '_deleted'), { recursive: true });
    await writeFile(path.join(root, zone, 'example.md'), `Original ${zone}\n`);
    await writeFile(path.join(root, zone, '_deleted', 'example.md'), `Prior archive ${zone}\n`);
  }
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  await writeFile(path.join(root, '.write-ledger.jsonl'), '{"event":"existing"}\n');
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  return { root, tool: tools.get('memory_delete'), read: tools.get('memory_read') };
}

for (const zone of ['functions', 'insights', 'capabilities']) test(`${zone} deletion with a different-body archive refuses before touching source, archive, index or ledger`, async (t) => {
  const f = await fixture(t);
  const files = [path.join(f.root, zone, 'example.md'), path.join(f.root, zone, '_deleted', 'example.md'), path.join(f.root, 'MEMORY.md'), path.join(f.root, '.write-ledger.jsonl')];
  const before = await Promise.all(files.map((file) => readFile(file)));
  // The cross-process commit protocol is unavailable; reject before reading the ledger.
  await assert.rejects(f.tool.execute({ zone, name: 'example' }), (error) => error.code === 'safe_delete_unavailable');
  const after = await Promise.all(files.map((file) => readFile(file)));
  assert.deepEqual(after, before);
  const result = await f.read.execute({ kind: 'index' });
  assert.match(result.content, /index/);
});

test('dao and invalid requests retain their existing refusal codes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.tool.execute({ zone: 'dao', name: 'example' }), (error) => error.code === 'human_gate_required');
  await assert.rejects(f.tool.execute({ zone: 'functions', name: '../example' }), (error) => error.code === 'invalid_name');
  await assert.rejects(f.tool.execute({ zone: 'other', name: 'example' }), (error) => error.code === 'unsupported_zone');
});
