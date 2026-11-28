import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryInbox } from '../health-inbox.js';

test('real pre-step offers eligible inbox work only on admitted inputs and preserves recall', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-inbox-hook-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = path.join(home, 'memory');
  await mkdir(root);
  await writeFile(path.join(root, 'MEMORY.md'), '# Fixture\n');
  const { apply } = await import('../server.js');
  const hooks = new Map(), services = new Map();
  const off = () => {};
  const valves = { upward() {}, negativeRules: async () => [{ id: 'fixture', statement: 'RULE_MARKER', keywords: ['triage'] }] };
  const dispose = apply({ tools: { register: () => off }, systemPrompt: { getSectionOrder: () => 0, section: () => off },
    on(name, fn) { hooks.set(name, fn); return off; }, get: k => k === 'valves' ? valves : services.get(k),
    set: (k,v) => services.set(k,v), inject: (_keys, fn) => { fn({}); return off; },
  }, { memoryRoot: root, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; assert.equal(path.dirname(home), tmpdir()); await rm(home, { recursive: true, force: true }); });
  const store = new MemoryInbox(() => home);
  const invoke = async (turn, kind, text, mode) => {
    const m = { role:'user', source:{kind}, content:[{type:'text',text}] };
    const d = mode === 'reject' ? {kind:'reject'} : {kind:'enter', messages: mode === 'drop' ? [] : [m]};
    let calls=0;
    const result = await hooks.get('agent/pre-step')({agent:{id:'fixture'},turn,messages:[m]}, async () => { calls++; return d; });
    assert.equal(calls,1);
    if (mode === 'reject') assert.equal(result,d);
    if (!mode) assert.ok(result.messages.includes(m));
    return { hint:result.messages?.find(x=>x.source?.kind==='memory-manager/inbox-work')?.content[0].text, result };
  };
  assert.equal((await invoke(1,'user','compose a poem')).hint,undefined);
  assert.match((await invoke(2,'schedule','记忆维护巡检')).hint,/memory_check/);
  const secret = 'NEVER_RENDER_RAW_INBOX';
  for (const suffix of ['A','B','C']) await store.post({from:secret,code:secret+suffix,message:secret,hint:secret});
  const before = await store.list();
  for (const kind of ['agent-message','subagent-settled','goal','tool-jobs','unknown']) assert.equal((await invoke(3,kind,'记忆体检')).hint,undefined);
  for (const [kind,text,mode] of [['schedule','写一首诗'],['schedule','记忆维护，只读报告'],['user','处理告警','drop'],['user','处理告警','reject']]) assert.equal((await invoke(3,kind,text,mode)).hint,undefined);
  const first = await invoke(3,'user','triage alerts');
  assert.ok(first.result.messages.some(m => m.source?.kind==='memory-manager/recall' && m.content[0].text.includes('RULE_MARKER')));
  assert.match(first.hint,/memory_inbox/); assert.ok(!first.hint.includes(secret));
  assert.equal((await invoke(3,'user','处理告警')).hint,undefined);
  assert.equal((await invoke(4,'user','写一首诗')).hint,undefined);
  const next = await invoke(5,'schedule','记忆巡检');
  const chosen = text => before.find(r=>text.includes(r.fingerprint))?.fingerprint;
  assert.ok(chosen(first.hint)); assert.ok(chosen(next.hint)); assert.notEqual(chosen(next.hint),chosen(first.hint));
  const third = await invoke(6, 'schedule', '记忆巡检');
  assert.equal(new Set([first.hint, next.hint, third.hint].map(chosen)).size, 3);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86_401_000 });
  assert.match((await invoke(7, 'user', '写一首诗')).hint, /低频待办/);
  assert.equal((await invoke(8, 'user', '写一首诗')).hint, undefined);
  assert.deepEqual(await store.list(),before);
});

test('ordinary admitted activity discovers a fresh problem before a user asks about health', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-inbox-discovery-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = path.join(home, 'memory');
  await mkdir(root);
  await writeFile(path.join(root, 'MEMORY.md'), '# Fixture\n' + 'a'.repeat(2048));
  const { apply } = await import('../server.js');
  const hooks = new Map();
  const off = () => {};
  const dispose = apply({ tools: { register: () => off }, on(name, fn) { hooks.set(name, fn); return off; },
    systemPrompt: { getSectionOrder: () => 0, section: () => off }, inject: (_keys, fn) => fn({}) },
    { dshRoot: process.env.DSH_INSTALL_DIR, maxIndexBytes: 1024 });
  t.after(async () => {
    dispose();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    assert.equal(path.dirname(home), tmpdir());
    await rm(home, { recursive: true, force: true });
  });
  const store = new MemoryInbox(() => home);
  assert.equal((await store.list()).length, 0);
  const m = { role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: 'Write a poem'}] };
  await hooks.get('agent/pre-step')({agent: {id: 'test'}, turn: 1, messages: [m]}, async () => ({kind: 'enter', messages: [m]}));
  const end = Date.now() + 5000;
  let finding;
  while (!finding && Date.now() < end) {
    finding = (await store.list()).find(row => row.code === 'R5' && row.status === 'open');
    if (!finding) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(finding, 'a normal turn must create the ticket in the real inbox store');
});
