import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CAPTURE_JOURNAL_NAME, inspectCaptureJournal, beginCaptureJournal, commitCaptureJournal } from '../src/capture-journal.js';
import { withCaptureMutex } from '../src/capture-mutex.js';

const day = '2026-11-10';
const prefix = 'capture-journal-test-';
const modUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/capture-journal.js')).href;
const mutexUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/capture-mutex.js')).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (op, id, d = day) => JSON.stringify({ version: 1, op, id, day: d }) + '\n';

async function fixture(t, provision = true) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(home, 'memory');
  await mkdir(root);
  const file = path.join(root, CAPTURE_JOURNAL_NAME);
  if (provision) await writeFile(file, '', { flag: 'wx' }); // isolated fixture, not a production initialization protocol
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith(prefix));
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, file };
}
const locked = (root, fn) => withCaptureMutex(root, fn, { timeoutMs: 4000 });

async function captureError(fn) { try { await fn(); assert.fail('expected rejection'); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return error; } }

test('strictly append one begin and matching commit; no raw user text or retry', async t => {
  const f = await fixture(t), id = randomUUID();
  await locked(f.root, async () => {
    assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 0, history: 'unverified' });
    assert.equal((await beginCaptureJournal(f.root, id, day)).status, 'begin-recorded');
    await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_PENDING' });
    await assert.rejects(beginCaptureJournal(f.root, randomUUID(), day), { code: 'CAPTURE_JOURNAL_PENDING' });
    await assert.rejects(commitCaptureJournal(f.root, randomUUID(), day), { code: 'CAPTURE_JOURNAL_UNPAIRED' });
    assert.equal((await commitCaptureJournal(f.root, id, day)).status, 'commit-recorded');
    assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 2, history: 'unverified' });
    await assert.rejects(beginCaptureJournal(f.root, id, day), { code: 'CAPTURE_JOURNAL_DUPLICATE' });
    await assert.rejects(commitCaptureJournal(f.root, id, day), { code: 'CAPTURE_JOURNAL_UNPAIRED' });
  });
  assert.equal(await readFile(f.file, 'utf8'), event('begin', id) + event('commit', id));
  await assert.rejects(beginCaptureJournal(f.root, 'raw-user-text', day), TypeError);
  await assert.rejects(beginCaptureJournal(f.root, randomUUID(), '2026-02-31'), TypeError);
  await assert.rejects(beginCaptureJournal(f.root, randomUUID(), '2026-11-10\n'), TypeError);
});

test('missing root or journal block; existing empty journal is not proof of genesis', async t => {
  const f = await fixture(t, false);
  await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_MISSING' });
  await assert.rejects(beginCaptureJournal(f.root, randomUUID(), day), { code: 'CAPTURE_JOURNAL_MISSING' });
  await assert.rejects(inspectCaptureJournal(path.join(f.home, 'missing')), { code: 'CAPTURE_JOURNAL_ROOT_UNKNOWN' });
  assert.equal((await fs.promises.readdir(f.root)).length, 0, 'missing inspection must not provision or repair');
  await writeFile(f.file, '', { flag: 'wx' });
  assert.equal((await locked(f.root, () => inspectCaptureJournal(f.root))).history, 'unverified');
});

test('outside deletion and valid forged replacement cannot be identified as authentic', async t => {
  const f = await fixture(t), id = randomUUID();
  await locked(f.root, async () => {
    await beginCaptureJournal(f.root, id, day);
    // Simulate a non-cooperating same-account actor, not journal behaviour.
    assert.equal(f.file, path.join(f.root, CAPTURE_JOURNAL_NAME));
    await fs.promises.unlink(f.file);
    await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_MISSING' });
    await writeFile(f.file, '', { flag: 'wx' });
    assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 0, history: 'unverified' });
    // This forged, syntactically valid pair is indistinguishable from real events.
    await fs.promises.unlink(f.file);
    await writeFile(f.file, event('begin', id) + event('commit', id), { flag: 'wx' });
    assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 2, history: 'unverified' });
  });
});

test('legacy pending path blocks even when its bytes are unreadable or it is empty', async t => {
  const f = await fixture(t), id = randomUUID();
  await writeFile(path.join(f.root, '.daily-capture.pending'), '');
  await locked(f.root, async () => {
    for (const op of [() => inspectCaptureJournal(f.root), () => beginCaptureJournal(f.root, id, day), () => commitCaptureJournal(f.root, id, day)])
      await assert.rejects(op, { code: 'CAPTURE_JOURNAL_LEGACY_PENDING' });
  });
  assert.equal(await readFile(f.file, 'utf8'), '');
});

test('truncated, malformed, versioned, duplicate and unpaired records fail closed without altering bytes', async t => {
  const f = await fixture(t), id = randomUUID(), other = randomUUID();
  const invalid = [
    '{', '{bad}\n', '{"version":2,"op":"begin","id":"'+id+'","day":"'+day+'"}\n',
    event('begin', id).slice(0, -1), event('commit', id), event('begin', id) + event('begin', id),
    event('begin', id) + event('commit', other), event('begin', id) + event('commit', id, '2026-11-11'),
    event('begin', id) + event('commit', id) + event('begin', id),
    '{"version":1,"version":1,"op":"begin","id":"'+id+'","day":"'+day+'"}\n',
    '\n', '\xff\n',
  ];
  await locked(f.root, async () => {
    for (const content of invalid) {
      await writeFile(f.file, content);
      const before = await readFile(f.file);
      await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_INVALID' });
      await assert.rejects(beginCaptureJournal(f.root, other, day), { code: 'CAPTURE_JOURNAL_INVALID' });
      assert.deepEqual(await readFile(f.file), before);
    }
    await writeFile(f.file, Buffer.from([0xff, 0x0a]));
    await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_INVALID' });
    const privateMarker = 'private-untrusted-content-never-return';
    await writeFile(f.file, `${privateMarker}\n`);
    const error = await captureError(() => inspectCaptureJournal(f.root));
    assert.equal(error.code, 'CAPTURE_JOURNAL_INVALID');
    assert.ok(!String(error.stack).includes(privateMarker));
    assert.equal(error.cause, undefined);
  });
});

test('journal hardlink cannot redirect to another file', async t => {
  const f = await fixture(t, false), outside = path.join(f.home, 'outside');
  await writeFile(outside, 'sentinel');
  await link(outside, f.file);
  await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
  assert.equal(await readFile(outside, 'utf8'), 'sentinel');
  assert.equal((await lstat(outside)).nlink, 2);
});

test('journal and directory symlink paths are rejected', async t => {
  const f = await fixture(t, false), outside = path.join(f.home, 'outside');
  await writeFile(outside, 'sentinel');
  try { await symlink(outside, f.file, 'file'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip(`symlink creation unavailable: ${e.code}`); return; } throw e; }
  await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
  const alias = path.join(f.home, 'alias');
  try { await symlink(f.root, alias, 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip(`directory symlink unavailable: ${e.code}`); return; } throw e; }
  await assert.rejects(inspectCaptureJournal(alias), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
});

test('Windows junction root and ancestor are rejected', async t => {
  if (process.platform !== 'win32') { t.skip('Windows junction test'); return; }
  const f = await fixture(t), alias = path.join(f.home, 'junction');
  try { await symlink(f.root, alias, 'junction'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip(`junction unavailable: ${e.code}`); return; } throw e; }
  await assert.rejects(inspectCaptureJournal(alias), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
  const subdir = path.join(f.root, 'child');
  await mkdir(subdir);
  await assert.rejects(inspectCaptureJournal(path.join(alias, 'child')), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
});

test('independent module instances on the same physical root reject concurrent calls', async t => {
  const f = await fixture(t);
  const copy = await import(`${modUrl}?separate-instance=${randomUUID()}`);
  const origOpen = fs.promises.open;
  let entered, release;
  const opened = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fs.promises.open = async (...args) => {
    const h = await origOpen(...args);
    if (path.resolve(String(args[0])) === f.file) { entered(); await gate; }
    return h;
  };
  syncBuiltinESMExports();
  try {
    await locked(f.root, async () => {
      const running = inspectCaptureJournal(f.root);
      await opened;
      try { await assert.rejects(copy.inspectCaptureJournal(path.join(f.root, '.')), { code: 'CAPTURE_JOURNAL_CONCURRENT' }); }
      finally { release(); }
      assert.equal((await running).status, 'clear');
    });
  } finally { release(); fs.promises.open = origOpen; syncBuiltinESMExports(); }
});

async function fault(f, kind, operation, action) {
  const origOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const h = await origOpen(...args);
    if (path.resolve(String(args[0])) === f.file && typeof args[1] === 'number' && (args[1] & fs.constants.O_APPEND)) {
      const write = h.writeFile.bind(h), sync = h.sync.bind(h), close = h.close.bind(h);
      if (kind === 'write-before') h.writeFile = async () => { throw new Error('injected'); };
      if (kind === 'write-after') h.writeFile = async (...a) => { await write(...a); throw new Error('injected'); };
      if (kind === 'write-partial') h.writeFile = async (...a) => { await write(String(a[0]).slice(0, 12)); throw new Error('injected'); };
      if (kind === 'sync-before') h.sync = async () => { throw new Error('injected'); };
      if (kind === 'sync-after') h.sync = async () => { await sync(); throw new Error('injected'); };
      if (kind === 'close-after') h.close = async () => { await close(); throw new Error('injected'); };
    }
    return h;
  };
  syncBuiltinESMExports();
  try { return await captureError(() => operation(action)); }
  finally { fs.promises.open = origOpen; syncBuiltinESMExports(); }
}

test('begin write/sync/close acknowledgement uncertainty never claims completion', async t => {
  for (const kind of ['write-before','write-after','write-partial','sync-before','sync-after','close-after']) {
    await t.test(kind, async tt => {
      const f = await fixture(tt), id = randomUUID();
      await locked(f.root, async () => {
        const error = await fault(f, kind, fn => fn(), () => beginCaptureJournal(f.root, id, day));
        assert.equal(error.code, 'CAPTURE_JOURNAL_APPEND_UNKNOWN');
        assert.equal(error.recordStatus, 'unknown');
        assert.equal(error.stage, kind.startsWith('write') ? 'write' : kind.startsWith('sync') ? 'sync' : 'close');
        if (kind === 'write-before') assert.equal((await inspectCaptureJournal(f.root)).status, 'clear');
        else if (kind === 'write-partial') await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_INVALID' });
        else await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_PENDING' });
      });
    });
  }
});

test('commit acknowledgement lost: complete record parses clear, absent/partial record blocks', async t => {
  for (const kind of ['write-before','write-after','write-partial','sync-before','sync-after','close-after']) {
    await t.test(kind, async tt => {
      const f = await fixture(tt), id = randomUUID();
      await locked(f.root, async () => {
        await beginCaptureJournal(f.root, id, day);
        const error = await fault(f, kind, fn => fn(), () => commitCaptureJournal(f.root, id, day));
        assert.equal(error.code, 'CAPTURE_JOURNAL_APPEND_UNKNOWN');
        assert.equal(error.recordStatus, 'unknown');
        if (kind === 'write-before') await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_PENDING' });
        else if (kind === 'write-partial') await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_INVALID' });
        else {
          assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 2, history: 'unverified' });
          await assert.rejects(commitCaptureJournal(f.root, id, day), { code: 'CAPTURE_JOURNAL_UNPAIRED' });
          await assert.rejects(beginCaptureJournal(f.root, id, day), { code: 'CAPTURE_JOURNAL_DUPLICATE' });
        }
      });
    });
  }
});

test('a journal linked by an outside actor after sync is reported unknown, never cleaned or certified', async t => {
  const f = await fixture(t), id = randomUUID(), alias = path.join(f.home, 'outside-link');
  const origOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const h = await origOpen(...args);
    if (path.resolve(String(args[0])) === f.file && typeof args[1] === 'number' && (args[1] & fs.constants.O_APPEND)) {
      const sync = h.sync.bind(h);
      h.sync = async () => { await sync(); await link(f.file, alias); };
    }
    return h;
  };
  syncBuiltinESMExports();
  try {
    await locked(f.root, async () => {
      await assert.rejects(beginCaptureJournal(f.root, id, day), { code: 'CAPTURE_JOURNAL_APPEND_UNKNOWN', stage: 'post-sync', recordStatus: 'unknown' });
    });
  } finally { fs.promises.open = origOpen; syncBuiltinESMExports(); }
  assert.equal(await readFile(alias, 'utf8'), event('begin', id));
  await assert.rejects(inspectCaptureJournal(f.root), { code: 'CAPTURE_JOURNAL_UNSAFE_PATH' });
});

// Children use the real external SQLite mutex, real filesystem handles and the
// production journal API. No pipe stdio, no real memory or live host activity.
const childCode = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const root=process.env.JROOT, ready=process.env.JREADY, out=process.env.JOUT, phase=process.env.JPHASE;
const j=await import(process.env.JMOD), {withCaptureMutex}=await import(process.env.JMUTEX);
const original=fs.promises.open; let appends=0;
const hold=async()=>{fs.writeFileSync(ready,'ready');setInterval(()=>{},1000);await new Promise(()=>{});};
if(phase.startsWith('kill-')) {
  fs.promises.open=async(...a)=>{const h=await original(...a);if(path.basename(String(a[0]))===j.CAPTURE_JOURNAL_NAME && (a[1]&fs.constants.O_APPEND)){
    const n=++appends, w=h.writeFile.bind(h),s=h.sync.bind(h);
    const atCommit=phase.includes('commit'), target=atCommit?2:1;
    if(n===target && phase.endsWith('write'))h.writeFile=async(...b)=>{await w(...b);await hold();};
    if(n===target && phase.endsWith('sync'))h.sync=async(...b)=>{await s(...b);await hold();};
  }return h;};syncBuiltinESMExports();
}
try { await withCaptureMutex(root,async()=>{
  await j.beginCaptureJournal(root,process.env.JID,'2026-11-10');
  if(phase==='hold'){fs.writeFileSync(ready,'ready');await new Promise(r=>setTimeout(r,350));}
  await j.commitCaptureJournal(root,process.env.JID,'2026-11-10');
},{timeoutMs:5000}); fs.writeFileSync(out,'ok'); } catch(e){fs.writeFileSync(out,JSON.stringify({code:e.code}));}
`;
function child(f, phase, id, label) {
  const ready = path.join(f.home, `${label}.ready`), output = path.join(f.home, `${label}.out`);
  const proc = spawn(process.execPath, ['--input-type=module','-e',childCode], { stdio:'ignore', windowsHide:true, env:{...process.env,JROOT:f.root,JREADY:ready,JOUT:output,JPHASE:phase,JID:id,JMOD:modUrl,JMUTEX:mutexUrl} });
  proc.on('error', () => {});
  return { proc, ready, output };
}
async function waitFor(p, proc, ms=8000) {
  const end=Date.now()+ms;
  while(Date.now()<end){ try{return await readFile(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;} if(proc.exitCode!==null || proc.signalCode!==null) throw new Error(`child exited before observation: ${proc.exitCode}/${proc.signalCode}`); await pause(15); }
  throw new Error('child observation timed out');
}
async function waitExit(proc, ms=8000) {
  const end=Date.now()+ms;
  while(proc.exitCode===null && proc.signalCode===null){if(Date.now()>end)throw new Error('child exit timed out');await pause(15);}
}

test('two independent processes serialize the complete begin-to-commit operation via real SQLite lock', async t => {
  const f=await fixture(t), first=child(f,'hold',randomUUID(),'first');
  t.after(()=>{if(first.proc.exitCode===null && first.proc.signalCode===null) first.proc.kill('SIGKILL');});
  await waitFor(first.ready, first.proc);
  const second=child(f,'normal',randomUUID(),'second');
  t.after(()=>{if(second.proc.exitCode===null && second.proc.signalCode===null) second.proc.kill('SIGKILL');});
  assert.equal(await waitFor(first.output,first.proc), 'ok');
  assert.equal(await waitFor(second.output,second.proc), 'ok');
  await waitExit(first.proc); await waitExit(second.proc);
  assert.equal((await locked(f.root,()=>inspectCaptureJournal(f.root))).records,4);
  const lines=(await readFile(f.file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(e=>e.op),['begin','commit','begin','commit']);
  assert.equal(lines[0].id,lines[1].id); assert.equal(lines[2].id,lines[3].id); assert.notEqual(lines[0].id,lines[2].id);
});

test('real forced termination after begin or commit write/sync preserves the observed state without inferring durability', async t => {
  for (const phase of ['kill-after-write','kill-after-sync','kill-commit-after-write','kill-commit-after-sync']) await t.test(phase, async tt => {
    const f=await fixture(tt), run=child(f,phase,randomUUID(),phase);
    tt.after(()=>{if(run.proc.exitCode===null && run.proc.signalCode===null) run.proc.kill('SIGKILL');});
    await waitFor(run.ready,run.proc);
    assert.equal(run.proc.kill('SIGKILL'),true);
    await waitExit(run.proc);
    await locked(f.root,async()=>{
      if (phase.includes('commit')) assert.deepEqual(await inspectCaptureJournal(f.root), { status: 'clear', records: 2, history: 'unverified' });
      else await assert.rejects(inspectCaptureJournal(f.root), {code:'CAPTURE_JOURNAL_PENDING'});
    });
  });
});
