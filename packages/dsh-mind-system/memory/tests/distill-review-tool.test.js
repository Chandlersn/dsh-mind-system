import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { apply, detectDistillationBacklog } from '../server.js';
import { reviewState } from '../src/distill-reviews.js';

const sha = text => createHash('sha256').update(text).digest('hex');

test('a review invalidates cached and in-flight pre-step reminders', async t => {
  const root = await fixture(t);
  const makeRow = version => ({due:[{area:'version-fixture',days:['2026-11-10'],materialVersion:sha(version),sections:[]}],orphan:[]});
  let clock = 1, pending, version = 'one', scans = 0;
  const {pre,tool} = mount(t,root, {now:()=>clock, detectDistillationBacklog:()=>{
    if (++scans === 2) return new Promise(resolve => {pending = resolve;});
    return makeRow(version);
  }});
  let turn = 0;
  const step = async () => {
    const m = {role:'user',content:[{type:'text',text:'fixture'}]};
    const result = await pre({agent:{id:'review'},turn:++turn,messages:[m]},async()=>({kind:'enter',messages:[]}));
    return result.messages.flatMap(row=>row.content.map(b=>b.text)).join('\n');
  };
  const until = async pattern => {
    for(let i=0;i<50;i++){const text=await step();if(pattern.test(text))return;await new Promise(r=>setTimeout(r,5));}
    assert.fail('expected reminder ' + pattern);
  };
  await until(/version-fixture/);
  clock += 600001; await step();
  assert.equal(typeof pending,'function');
  await tool.execute({action:'review',candidate:'area:version-fixture',materialVersion:sha('one'),conclusion:'checked first version'});
  pending(makeRow('one'));
  for(let i=0;i<4;i++){assert.doesNotMatch(await step(),/version-fixture/);await new Promise(r=>setTimeout(r,10));}
  version = 'two'; clock += 600001;
  await until(/version-fixture/);
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(),'distill-receipt-'));
  await mkdir(path.join(root,'functions'));
  await writeFile(path.join(root,'MEMORY.md'),'# fixture\n');
  await writeFile(path.join(root,'functions','topic.md'),'# topic\n');
  for (let day = 10; day <= 12; day++) await writeFile(path.join(root,`2026-11-${day}.md`), `## topic\n${'topic text '.repeat(25)}\n`);
  t.after(async () => { assert.equal(path.dirname(root),tmpdir()); await rm(root,{recursive:true,force:true}); });
  return root;
}
function mount(t, root, deps = {}) {
  const tools = new Map(), hooks = new Map(), off = () => {};
  const ctx = { tools: {register: d => {tools.set(d.name,d); return off;}}, on: (name,fn) => {hooks.set(name,fn);return off;}, inject: (_keys,fn) => fn({}), systemPrompt: {getSectionOrder:()=>0,section:()=>off} };
  const dispose = apply(ctx, {memoryRoot:root,dshRoot: process.env.DSH_INSTALL_DIR},deps);
  t.after(dispose);
  return { tool: tools.get('memory_distill_review'), check:tools.get('memory_check'), pre:hooks.get('agent/pre-step') };
}

test('registered tool preserves original conclusion, source ranges, and exact version across remount and edits', async t => {
  const root = await fixture(t);
  const {tool,check} = mount(t,root);
  const list = await tool.execute({action:'list'});
  assert.ok(list.complete);
  const row = list.candidates.find(r => r.candidate === 'area:topic');
  assert.match(row.materialVersion,/^[a-f0-9]{64}$/);
  assert.equal(row.sectionCount,3);
  const details = await tool.execute({action:'list',candidate:row.candidate});
  for(const ref of details.candidates[0].sections) assert.match((await readFile(path.join(root,ref.path),'utf8')).split('\n')[ref.startLine-1],/topic/);
  const args = { action:'review', candidate:row.candidate, materialVersion:row.materialVersion, conclusion:'  examined three original sections\nkeep evidence unchanged  ' };
  const unsafe = {...args, conclusion:'sk-'+ 'X'.repeat(25)};
  await assert.rejects(()=>tool.execute(unsafe),/含凭据/);
  assert.ok(!(await readdir(root)).includes('.distill-reviews'));
  const both = await Promise.allSettled([tool.execute(args),tool.execute({...args,conclusion:'another independent conclusion'})]);
  assert.deepEqual(both.map(x=>x.status).sort(),['fulfilled','rejected']);
  const saved = both.find(x=>x.status==='fulfilled').value.receipt;
  assert.ok([args.conclusion,'another independent conclusion'].includes(saved.conclusion));
  assert.deepEqual((await tool.execute({...args,conclusion:saved.conclusion})).receipt,saved);
  const second = mount(t,root).tool;
  assert.equal((await second.execute({action:'list'})).candidates[0].reviewed,true);
  assert.ok(!(await check.execute({},{})).reviewNotes?.some(r=>r.rule==='R28'));
  const file=path.join(root,'2026-11-10.md');
  await writeFile(file,(await readFile(file,'utf8')).replace('text','edit'));
  assert.ok((await check.execute({},{})).reviewNotes.some(r=>r.rule==='R28'));
  assert.equal((await second.execute({action:'list'})).candidates[0].reviewed,false);
  await assert.rejects(()=>second.execute(args),/版本已变化/);
  assert.deepEqual((await second.execute({...args,action:'receipt'})).receipt,saved);
});

test('partial source scans and damaged receipts cannot suppress or accept a review',async t=>{
  const root=await fixture(t);
  const scan=await detectDistillationBacklog(root);
  const {tool}=mount(t,root,{detectDistillationBacklog:()=>scan});
  const row=scan.due[0];
  const args={action:'review',candidate:'area:'+row.area,materialVersion:row.materialVersion,conclusion:'original finding'};
  await tool.execute(args);
  for(const flag of ['readUnknown','truncated']){
    scan[flag]=1;
    const state=await reviewState(root,scan);
    assert.equal(state.complete,false);assert.equal(state.pending.due.length,1);
    await assert.rejects(()=>tool.execute(args),/不完整/);
    delete scan[flag];
  }
  const dir=path.join(root,'.distill-reviews'); const receiptFile=path.join(dir,(await readdir(dir))[0]);
  await writeFile(receiptFile,'{');
  const state=await reviewState(root,scan);
  assert.match(state.pending.skipped,/回执读取失败/);assert.equal(state.pending.due.length,1);
  await assert.rejects(()=>tool.execute(args),/不完整/);
});
