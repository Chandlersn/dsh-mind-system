import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

async function fixture(t, { status = 'candidate', owned = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'skill-activation-unavailable-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills'), bundle = path.join(skills, 'example', 'SKILL.md');
  await mkdir(path.dirname(bundle), { recursive: true }); await mkdir(root, { recursive: true });
  const skill = `---\nname: example\ndescription: Example\nstatus: ${status}\nagent_created: ${owned}\nsources: [functions/example.md]\n---\n\n# Example\n\nRun the procedure.\n`;
  await writeFile(bundle, skill); await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  return { root, bundle, tool: tools.get('memory_skill'), skill };
}
async function snapshot(f) {
  const data = {};
  for (const [key, file] of [['skill', f.bundle], ['index', path.join(f.root, 'MEMORY.md')], ['usage', path.join(f.root, '.usage.jsonl')], ['ledger', path.join(f.root, '.write-ledger.jsonl')]]) {
    try { data[key] = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; data[key] = null; }
  }
  try { data.shards = await readdir(path.join(f.root, '.usage')); } catch (error) { if (error.code !== 'ENOENT') throw error; data.shards = []; }
  return data;
}

for (const signal of ['recall', 'source-read', 'caller-positive', 'note']) test(`activation rejects unverified ${signal} without writes`, async (t) => {
  const f = await fixture(t);
  const entry = signal === 'recall' ? { href: 'skills/example/SKILL.md', kind: 'recall' }
    : signal === 'source-read' ? { href: 'functions/example.md', kind: 'read' }
      : signal === 'caller-positive' ? { href: 'skills/example/SKILL.md', kind: 'positive' } : null;
  if (entry) await writeFile(path.join(f.root, '.usage.jsonl'), JSON.stringify({ ...entry, t: new Date().toISOString() }) + '\n');
  const before = await snapshot(f);
  const args = { action: 'activate', name: 'example', ...(signal === 'note' ? { note: 'Verified execution on a task' } : {}) };
  await assert.rejects(f.tool.execute(args), (error) => error.code === 'verified_skill_execution_unavailable');
  assert.deepEqual(await snapshot(f), before);
  assert.match(await readFile(f.bundle, 'utf8'), /^status: candidate$/m);
});

test('already active and externally owned skills retain their existing boundaries', async (t) => {
  const active = await fixture(t, { status: 'active' });
  const beforeActive = await snapshot(active);
  await assert.rejects(active.tool.execute({ action: 'activate', name: 'example' }), /已是 active/);
  assert.deepEqual(await snapshot(active), beforeActive);
  const external = await fixture(t, { owned: false });
  const beforeExternal = await snapshot(external);
  await assert.rejects(external.tool.execute({ action: 'activate', name: 'example' }), /不是本插件结晶/);
  assert.deepEqual(await snapshot(external), beforeExternal);
});

test('listing and reading a candidate remain available', async (t) => {
  const f = await fixture(t);
  const list = await f.tool.execute({ action: 'list' });
  assert.ok(list.items.some((item) => item.name === 'example' && item.status === 'candidate'));
  const result = await f.tool.execute({ action: 'read', name: 'example' });
  assert.match(result.content, /^status: candidate$/m);
});

test('retiring an owned active skill remains available', async (t) => {
  const f = await fixture(t, { status: 'active' });
  const result = await f.tool.execute({ action: 'retire', name: 'example' });
  assert.equal(result.status, 'retired');
  assert.match(await readFile(f.bundle, 'utf8'), /^status: retired$/m);
});
