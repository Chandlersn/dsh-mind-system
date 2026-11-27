import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

test('overview distinguishes a missing index from an empty readable index', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-index-overview-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root);
  await mkdir(skills);
  let handler;
  const noop = () => {};
  const ctx = {
    get() {},
    tools: { register: () => noop },
    on: () => noop,
    inject(_names, run) {
      run({ webServer: { register(route) { handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: (fn) => fn() });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  let dispose;
  let server;
  try {
    dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0 });
    assert.equal(typeof handler, 'function');
    server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/memory-org/overview`;
    async function indexStatus() {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const overview = (await response.json())[0];
      return { indexRows: overview.usage.indexRows, indexBytes: overview.env.indexBytes };
    }
    assert.deepEqual(await indexStatus(), { indexRows: null, indexBytes: null });
    await writeFile(path.join(root, 'MEMORY.md'), '');
    assert.deepEqual(await indexStatus(), { indexRows: 0, indexBytes: 0 });
  } finally {
    dispose?.();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(home, { recursive: true, force: true });
  }
});
