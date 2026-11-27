import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-descriptor-failure-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, '.usage'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# Isolated index\n');
  const shard = path.join(root, '.usage', '2026-11.jsonl');
  const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify({ t: '2026-11-10T00:00:00Z', href: `functions/missing${i}.md`, kind: 'read' })).join('\n') + '\n';
  await writeFile(shard, rows);
  t.after(async () => { assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  return { home, root, skills, shard };
}

async function faultRead(shard, code, caller, fn) {
  const original = fs.promises.readFile;
  let hits = 0;
  fs.promises.readFile = async function (file, ...args) {
    const stack = new Error().stack;
    if (typeof file === 'string' && path.resolve(file) === shard && stack.includes(caller) && !stack.includes('readUsage (')) {
      hits++;
      throw Object.assign(new Error('synthetic descriptor read failure'), { code });
    }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try { const result = await fn(); assert.ok(hits > 0, 'fault reached the selected descriptor reader'); return result; }
  finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
}

function incomplete(result, rule, code) {
  return result.results.some((r) => r.rule === rule && r.level === 'WARN' && r.message.includes('不完整') && r.message.includes('未知') && r.message.includes(code));
}

test('health checks report discovered shard read failures without partial results', async (t) => {
  const f = await fixture(t);
  const check = () => runHealthCheck(f.root, { ...DEFAULTS, skillRoot: f.skills });
  const normal = await check();
  assert.ok(normal.results.some((r) => r.rule === 'R25' && r.message.includes('不见了')), 'healthy shard must contribute actual evidence');
  for (const code of ['ENOENT', 'EIO']) {
    const result = await faultRead(f.shard, code, 'runHealthCheck (', check);
    for (const rule of ['R23', 'R25']) assert.ok(incomplete(result, rule, code), `${rule} must report ${code}`);
    assert.ok(!result.results.some((r) => r.rule === 'R25' && r.message.includes('不见了')), 'no partial deletion verdict');
    assert.ok(result.results.some((r) => r.rule === 'R26'), 'later health rules still execute');
  }
});

test('overview fails visibly when an enumerated shard disappears', async (t) => {
  const f = await fixture(t);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = f.home;
  let handler;
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on: () => noop, get: () => undefined, set() {}, emit() {},
    inject(_names, fn) { fn({ webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } }, connection: { requestRejection: () => undefined }, effect: (f) => f() }); },
  };
  const dispose = apply(ctx, { memoryRoot: f.root, skillRoot: f.skills, captureUserTurns: false });
  t.after(() => { dispose?.(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  assert.equal(typeof handler, 'function');
  async function overview() {
    let status, body;
    await handler({ method: 'GET', url: '/api/memory-org/overview' }, { writeHead(code) { status = code; }, end(value) { body = value; } });
    return { status, body: JSON.parse(body) };
  }
  const normal = await overview();
  assert.equal(normal.status, 200);
  assert.ok(normal.body[0].usage.sources.some((s) => s.file === '2026-11.jsonl' && s.rows === 10));
  for (const code of ['ENOENT', 'EIO']) {
    const result = await faultRead(f.shard, code, 'overviewPayload (', overview);
    assert.equal(result.status, 500);
    assert.ok(!Array.isArray(result.body), 'no partial overview is returned');
    assert.ok(!JSON.stringify(result.body).includes('missing0'), 'no partial usage content is returned');
  }
  const stream = await faultRead(f.shard, 'ENOENT', 'overviewPayload (', async () => {
    let close;
    return await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => { close?.(); reject(new Error('stream timeout')); }, 5000);
      try {
        await handler({ method: 'GET', url: '/api/memory-org/stream' }, {
          writeHead() {},
          write(chunk) {
            if (chunk.startsWith('event: snapshot-error\n')) {
              clearTimeout(timeout); close?.(); resolve(chunk);
            } else if (chunk.startsWith('event: overview\n')) {
              clearTimeout(timeout); close?.(); reject(new Error('partial overview emitted'));
            }
          },
          on(name, fn) { if (name === 'close') close = fn; }, end() {},
        });
      } catch (error) { clearTimeout(timeout); close?.(); reject(error); }
    });
  });
  assert.match(stream, /^event: snapshot-error\n/);
  assert.ok(!stream.includes('missing0'));
});
