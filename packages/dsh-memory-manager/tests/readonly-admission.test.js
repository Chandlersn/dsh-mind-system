import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

test('registered read actions emit no write admission while capability record still does', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-admission-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root); await mkdir(skills);
  await writeFile(path.join(root, 'MEMORY.md'), '# Index\n');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const tools = new Map();
  const calls = [];
  const noop = () => {};
  const valves = { negativeRules: async () => [], upward: () => undefined,
    downward: (...args) => { calls.push(args); return { admitted: true }; } };
  const ctx = { tools: { register: (tool) => { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop,
    get: (name) => name === 'valves' ? valves : undefined, set() {},
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }) };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(async () => {
    dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^memory-admission-/);
    await rm(home, { recursive: true, force: true });
  });
  const capability = tools.get('memory_capability');
  await capability.execute({ action: 'list' });
  assert.equal(calls.length, 0, 'Listing capabilities is not a write admission.');
  await capability.execute({ action: 'record', name: 'fixture', kind: 'cli', summary: 'An isolated fixture.', invocation: 'fixture --version' });
  assert.equal(calls.length, 1, 'A real record still gets one admission.');
  await capability.execute({ action: 'read', name: 'fixture' });
  await capability.execute({ action: 'list' });
  await tools.get('memory_dao').execute({ status: 'list_candidates', name: 'ignored', proposition: 'ignored', body: 'ignored', extractedFrom: [] });
  assert.equal(calls.length, 1, 'Read branches must not inflate the admission denominator.');
});
