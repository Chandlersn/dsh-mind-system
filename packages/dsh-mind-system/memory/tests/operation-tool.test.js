import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, link } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';
const hostEntry=path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR),'node_modules','@deepseek-ai','dsh-tools','lib','index.js');
const { validateJsonSchemaValue }=createRequire(hostEntry)(hostEntry);
async function fixture(t) {
 const home=await mkdtemp(path.join(tmpdir(),'memory-operation-tool-'));
 const root=path.join(home,'memory'), skills=path.join(home,'skills');
 await mkdir(root);await mkdir(skills);await writeFile(path.join(root,'MEMORY.md'),'# Index\n');
 const previous=process.env.DSH_HOME;process.env.DSH_HOME=home;
 const tools=new Map(), calls=[], noop=()=>{};
 const ctx={tools:{register:tool=>{tools.set(tool.name,tool);return noop;}},
  systemPrompt:{getSectionOrder:()=>2900,section:()=>noop},on:()=>noop,set(){},
  get:name=>name==='valves'?{negativeRules:async()=>[],upward:()=>undefined,downward:(_from,_to,data)=>{calls.push(data);return {action:'allow'};}}:undefined,
  inject:(_names,fn)=>fn({webServer:undefined,workspaceRegistry:undefined})};
 const dispose=apply(ctx,{memoryRoot:root,skillRoot:skills,dshRoot:process.env.DSH_INSTALL_DIR,dailyArchiveFirstDelayMs:0,dailyArchiveIntervalMs:0});
 t.after(async()=>{
  dispose?.();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;
  assert.equal(path.dirname(home),path.resolve(tmpdir()));assert.match(path.basename(home),/^memory-operation-tool-/);
  await rm(home,{recursive:true,force:true});
 });
 return {root,tools,calls};
}
async function query(tool,id) {
 const args={kind:'operation',request_id:id};
 const value=await tool.execute(args);
 assert.deepEqual(validateJsonSchemaValue(tool.output.schema,value,'value'),[]);
 const rendered=tool.output.render(args,value);
 assert.equal(rendered[0].text,value.content);
 return {value,result:JSON.parse(value.content)};
}
test('registered operation query reads a real write without adding admissions or changing ledger bytes',async t=>{
 const {root,tools,calls}=await fixture(t);
 await tools.get('memory_capability').execute({action:'record',name:'operation-query-fixture',invocation:'example --inspect',summary:'A query fixture'});
 assert.equal(calls.length,1);
 const id=calls[0].write_context.request_id;
 const ledger=path.join(root,'.write-ledger.jsonl'), before=await readFile(ledger);
 const usageBytes=()=>readFile(path.join(root,'.usage.jsonl')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const usageBefore=await usageBytes();
 const {value,result}=await query(tools.get('memory_read'),id);
 assert.equal(value.found,true);
 assert.equal(result.scanComplete,true);
 assert.ok(result.rows.length>0);
 assert.ok(result.rows.every(row=>row.request_id===id));
 assert.ok((await readFile(path.join(root,'capabilities','operation-query-fixture.md'),'utf8')).includes('example --inspect'));
 assert.equal(result.execution,'not_observed');assert.equal(result.adoption,'not_observed');
 await query(tools.get('memory_read'),randomUUID());
 assert.equal(calls.length,1);
 assert.deepEqual(await readFile(ledger),before);
 assert.deepEqual(await usageBytes(),usageBefore);
});
test('missing ledger remains missing and renders its report instead of empty-directory advice',async t=>{
 const {root,tools,calls}=await fixture(t);
 const {value,result}=await query(tools.get('memory_read'),randomUUID());
 assert.equal(value.found,false);assert.equal(result.scanComplete,false);
 assert.equal(calls.length,0);
 await assert.rejects(access(path.join(root,'.write-ledger.jsonl')),{code:'ENOENT'});
});
test('a hard-linked ledger is not treated as an ordinary owned ledger',async t=>{
 const {root,tools}=await fixture(t), id=randomUUID();
 const ledger=path.join(root,'.write-ledger.jsonl');
 const text=JSON.stringify({key:'functions/sample.md',hash:'sample',request_id:id})+'\n';
 await writeFile(ledger,text);await link(ledger,path.join(root,'linked-ledger'));
 const {result}=await query(tools.get('memory_read'),id);
 assert.equal(result.scanComplete,false);assert.equal(result.reason,'unsafe_ledger');
 assert.equal(await readFile(ledger,'utf8'),text);
});
test('operation mode rejects filesystem overrides and unrelated mode fields at execution boundary',async t=>{
 const {tools,calls}=await fixture(t), tool=tools.get('memory_read');
 for(const extra of [{root:'elsewhere'},{name:'elsewhere'},{date:'2026-01-01'},{path:'elsewhere'}]) {
  await assert.rejects(tool.execute({kind:'operation',request_id:randomUUID(),...extra}),/only kind and request_id/);
 }
 assert.equal(calls.length,0);
});
