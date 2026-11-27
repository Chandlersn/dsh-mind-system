import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { AUTO_DAILY_ARCHIVE_ENABLED } from '../src/daily-archive.js';

test('enabled configuration cannot start the paused automatic daily archive', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'daily-archive-paused-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const source = path.join(root, '2020-01-01.md'), original = '# daily\n\nOriginal daily data\n';
  await writeFile(source, original);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const noop = () => {}, calls = [];
  const ctx = { tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dailyArchiveFirstDelayMs: 1, dailyArchiveIntervalMs: 2, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' }, { archiveDailyMonths: async (...args) => { calls.push(args); } });
  try {
    assert.equal(AUTO_DAILY_ARCHIVE_ENABLED, false);
    t.mock.timers.tick(10000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    assert.equal(await readFile(source, 'utf8'), original);
    await assert.rejects(readFile(path.join(root, 'daily', '2020-01.md')), { code: 'ENOENT' });
  } finally {
    dispose?.(); t.mock.timers.reset();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true });
  }
});
