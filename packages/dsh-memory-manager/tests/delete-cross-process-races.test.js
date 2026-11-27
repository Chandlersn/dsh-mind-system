import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { apply } from '../server.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'delete-race-isolated-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^delete-race-isolated-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function writeInOtherProcess(file, text) {
  const child = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", file, text], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
}

test('archive check followed by rename overwrites a file created by another process', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source.md');
  const archive = path.join(root, 'archive.md');
  await writeFile(source, 'source data');
  await assert.rejects(lstat(archive), { code: 'ENOENT' });
  writeInOtherProcess(archive, 'concurrent archive');
  await rename(source, archive);
  assert.equal(await readFile(archive, 'utf8'), 'source data');
});

async function tree(root) {
  const items = [];
  async function visit(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) { items.push([relative, 'directory']); await visit(path.join(dir, entry.name), relative); }
      else items.push([relative, (await readFile(path.join(dir, entry.name))).toString('base64')]);
    }
  }
  await visit(root);
  return items;
}

test('real delete entries refuse before writing any files', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'memory');
  const skills = path.join(base, 'skills');
  await mkdir(skills);
  for (const zone of ['functions', 'insights', 'capabilities', 'dao']) {
    await mkdir(path.join(root, zone), { recursive: true });
    await writeFile(path.join(root, zone, 'example.md'), `source ${zone}\n`);
  }
  for (const zone of ['functions', 'capabilities', 'dao']) {
    await mkdir(path.join(root, zone, '_deleted'));
    await writeFile(path.join(root, zone, '_deleted', 'example.md'), `existing archive ${zone}\n`);
  }
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const tools = new Map();
  let handler;
  const noop = () => {};
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on: () => noop, get: () => undefined, set() {}, emit() {},
    inject(_names, fn) { fn({ webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } }, connection: { requestRejection: () => undefined }, effect: (fn2) => fn2() }); },
  };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(() => { dispose?.(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; });
  const before = await tree(root);
  for (const zone of ['functions', 'insights', 'capabilities']) {
    await assert.rejects(tools.get('memory_delete').execute({ zone, name: 'example' }), { code: 'safe_delete_unavailable' });
  }
  await assert.rejects(tools.get('memory_delete').execute({ zone: 'dao', name: 'example' }), { code: 'human_gate_required' });
  await assert.rejects(tools.get('memory_delete').execute({ zone: 'functions', name: '../bad' }), { code: 'invalid_name' });
  const bytes = Buffer.from(JSON.stringify({ name: 'example' }));
  const req = { method: 'POST', url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield bytes; } };
  let status, body;
  await handler(req, { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } });
  assert.equal(status, 503);
  assert.equal(body.code, 'safe_delete_unavailable');
  assert.deepEqual(await tree(root), before);
});

test('index read followed by write loses another process update', async (t) => {
  const root = await fixture(t);
  const index = path.join(root, 'MEMORY.md');
  await writeFile(index, 'old row\n');
  const before = await readFile(index, 'utf8');
  writeInOtherProcess(index, `${before}concurrent row\n`);
  await writeFile(index, before.replace('old row\n', ''));
  assert.equal(await readFile(index, 'utf8'), '');
});
