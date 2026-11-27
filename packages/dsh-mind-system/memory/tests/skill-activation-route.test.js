import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

test('skills route reports the same reason as the actual activation rejection', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'skill-route-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const bundle = path.join(skills, 'example', 'SKILL.md');
  await mkdir(root);
  await mkdir(path.dirname(bundle), { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const source = '---\nname: example\ndescription: Example\nstatus: candidate\nagent_created: true\n---\n\n# Example\n';
  await writeFile(bundle, source);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let handler;
  const tools = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    get: () => undefined, on: () => noop, set() {}, emit() {},
    inject(_names, run) {
      run({ webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: (fn) => fn() });
    },
  };
  let server;
  let dispose;
  try {
    dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
    assert.ok(handler);
    server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/memory-org`;
    const response = await fetch(`${base}/skills`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.activation, { available: false, reason: 'verified_skill_execution_unavailable', detail: '宿主尚无绑定技能版本和任务的独立执行验收证据' });
    assert.ok(body.memory.some((item) => item.name === 'example' && item.status === 'candidate'));
    assert.ok(Array.isArray(body.host));
    await assert.rejects(tools.get('memory_skill').execute({ action: 'activate', name: 'example' }), (error) => {
      assert.equal(error.code, body.activation.reason);
      assert.ok(error.message.includes(body.activation.detail));
      return true;
    });
    assert.equal(await readFile(bundle, 'utf8'), source);
  } finally {
    dispose?.();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
