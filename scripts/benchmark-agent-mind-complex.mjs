/** Paired real DSH runs: no mind, original mind, and current mind.
 * Run from the repository with Node 22; see reports for evidence and limits.
 */
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dshBin = process.env.MIND_EVAL_DSH_BIN ?? 'D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const adapter = process.env.MIND_EVAL_ADAPTER ?? 'C:/Users/lyq/.dsh/profiles/web/node_modules/dsh-our-free-model/index.js';
const catalogPath = process.env.MIND_EVAL_CATALOG ?? 'C:/Users/lyq/.dsh/our-free-model/catalog.json';
const model = process.env.MIND_EVAL_MODEL ?? 'nvidia/nemotron-3.5-super-vl:free';
const out = resolve(process.env.MIND_EVAL_OUTPUT ?? join(root, 'reports/mind-complex-20261103'));
const limitMs = Number(process.env.MIND_EVAL_TIMEOUT_MS ?? 180000);
const hash = s => createHash('sha256').update(s).digest('hex');
const tasks = [
  {
    id: 'retry',
    title: '修复异步重试边界',
    prompt: '项目的异步重试在持续失败时调用次数不对。请阅读代码和测试，运行测试，修复根因并再次验证。按 README 的约定保持公开接口；不要修改或删除现有测试，只在当前目录工作。最后简要说明修复和验证结果。',
    files: {
      'package.json': '{"name":"retry-fixture","type":"module","scripts":{"test":"node --test test/*.test.js"}}\n',
      'README.md': '# retry\nretry(operation, maxAttempts) 最多调用 operation maxAttempts 次（包括首次），返回首次成功值；全部失败时抛出最后一次原始错误。maxAttempts 是正整数。\n',
      'src/retry.js': 'export async function retry(operation, maxAttempts) {\n  let lastError;\n  for (let attempt = 0; attempt <= maxAttempts; attempt++) {\n    try { return await operation(); } catch (error) { lastError = error; }\n  }\n  throw lastError;\n}\n',
      'test/retry.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { retry } from '../src/retry.js';\ntest('exhausted retry uses exact maximum', async () => { let n=0; const err=new Error('failed'); await assert.rejects(retry(async()=>{n++;throw err},3),e=>e===err); assert.equal(n,3); });\n",
    },
    grader: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { retry } from './work/src/retry.js';\ntest('success on first try',async()=>{let n=0; assert.equal(await retry(async()=>{n++;return 42},5),42);assert.equal(n,1)});\ntest('success on final permitted try',async()=>{let n=0;assert.equal(await retry(async()=>{if(++n<3)throw Error('temp');return 'ok'},3),'ok');assert.equal(n,3)});\ntest('one attempt and original error',async()=>{let n=0;let e=Error('last');await assert.rejects(retry(async()=>{n++;throw e},1),x=>x===e);assert.equal(n,1)});\n`,
  },
  {
    id: 'ledger',
    title: '修复账目汇总逻辑',
    prompt: '对照 README 审查账目统计：报表数字不正确。请运行现有测试、修改实现、重新验证。不要修改现有测试或接口，只在当前目录工作；最后说明根因和验证。',
    files: {
      'package.json': '{"name":"ledger-fixture","type":"module","scripts":{"test":"node --test test/*.test.js"}}\n',
      'README.md': '# netCents\nnetCents(rows) 对 settled 记录：charge 加上 amountCents，refund 减去 amountCents；pending 等其他状态不计入。金额是非负整数分。不得修改输入数组或对象；空数组返回 0。\n',
      'src/ledger.js': "export function netCents(rows) {\n  return rows.filter(row => row.status === 'settled' && row.type === 'charge')\n    .reduce((total, row) => total + row.amountCents, 0);\n}\n",
      'test/ledger.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { netCents } from '../src/ledger.js';\ntest('settled refund reduces revenue',()=>assert.equal(netCents([{status:'settled',type:'charge',amountCents:1250},{status:'settled',type:'refund',amountCents:300}]),950));\n",
    },
    grader: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { netCents } from './work/src/ledger.js';\ntest('empty and refunds',()=>{assert.equal(netCents([]),0);assert.equal(netCents([{status:'settled',type:'refund',amountCents:40}]),-40)});\ntest('ignore pending, add charges',()=>assert.equal(netCents([{status:'pending',type:'charge',amountCents:999},{status:'settled',type:'charge',amountCents:100},{status:'settled',type:'charge',amountCents:20},{status:'pending',type:'refund',amountCents:1}]),120));\ntest('no mutation',()=>{let rows=Object.freeze([Object.freeze({status:'settled',type:'refund',amountCents:7})]);assert.equal(netCents(rows),-7)});\n`,
  },
  {
    id: 'backoff',
    title: '结合故障记录排查退避上限',
    prompt: '服务重试延迟反复异常。请结合 README、日志、实现和测试定位根因，修复并运行测试；再在当前目录写 analysis.md，说明根因和验证方式。不要修改现有测试或公开接口，不要访问当前目录以外的项目文件。',
    files: {
      'package.json': '{"name":"backoff-fixture","type":"module","scripts":{"test":"node --test test/*.test.js"}}\n',
      'README.md': '# delayMs\ndelayMs(attempt, baseMs, capMs) 返回 baseMs * 2 ** attempt，但最大不能超过 capMs。参数是非负数，attempt 是从 0 开始的非负整数。\n',
      'logs/service.log': 'attempt=0 baseMs=100 capMs=800 delayMs=800\nattempt=1 baseMs=100 capMs=800 delayMs=800\nattempt=4 baseMs=100 capMs=800 delayMs=1600\n',
      'src/backoff.js': 'export function delayMs(attempt, baseMs, capMs) {\n  const candidate = baseMs * 2 ** attempt;\n  return Math.max(candidate, capMs);\n}\n',
      'test/backoff.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { delayMs } from '../src/backoff.js';\ntest('delay starts at base and respects maximum',()=>{assert.equal(delayMs(0,100,800),100);assert.equal(delayMs(4,100,800),800)});\n",
    },
    grader: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { delayMs } from './work/src/backoff.js';\ntest('intermediate exponential growth',()=>{assert.equal(delayMs(1,100,800),200);assert.equal(delayMs(2,100,800),400);assert.equal(delayMs(3,100,800),800)});\ntest('cap below base and zero',()=>{assert.equal(delayMs(0,100,30),30);assert.equal(delayMs(4,0,100),0)});\ntest('root-cause note exists',()=>{const text=readFileSync(new URL('./work/analysis.md',import.meta.url),'utf8');assert.ok(text.trim().length>=40);assert.match(text,/max|最大/i);assert.match(text,/min|上限|cap/i)});\n`,
  },
];

const temp = await mkdtemp(join(tmpdir(), 'mind-complex-'));
const oldPath = join(temp, 'old-plugin');
const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'packages/dsh-agent-mind'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
for (const repoPath of tracked) {
  const rel = repoPath.replace(/^packages\/dsh-agent-mind\//, '');
  const dest = join(oldPath, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, execFileSync('git', ['show', `HEAD:${repoPath}`], { cwd: root }));
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (!Array.isArray(catalog.kiloRows)) throw new Error('Missing Kilo model catalog');
await mkdir(out, { recursive: true });
const yaml = p => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`;
function config(arm) {
  const components = [
    ['our-free-model', adapter, '      config:\n        distribution: managed\n'],
    ...['classifier', 'strategy', 'feedback', 'orchestrator'].map(n => [`clis-${n}`, join(root, 'packages/dsh-clis', `clis-${n}.js`), '']),
    ['clis-tools', join(root, 'packages/dsh-clis/index.js'), ''],
    ...(arm === 'off' ? [] : [['mind', arm === 'old' ? join(oldPath, 'index.js') : join(root, 'packages/dsh-agent-mind/index.js'), '']]),
  ];
  return `- id: agent-default-model\n  config:\n    provider: our-free-model\n    model: ${model}\n- insert:\n` + components.map(([id,p,extra]) => `    - id: ${id}\n      name: ${yaml(p)}\n${extra}`).join('');
}

async function capture(command, args, options, timeoutMs, onLine) {
  const start = performance.now();
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let stdout='', stderr='', pending='', finalMs=null, timedOut=false, error=null;
  const timer=setTimeout(()=>{timedOut=true;child.kill()},timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout+=chunk; pending+=chunk; let pos; while((pos=pending.indexOf('\n'))>=0){const line=pending.slice(0,pos);pending=pending.slice(pos+1);if(onLine?.(line)===true && finalMs===null){finalMs=performance.now()-start;setTimeout(()=>child.kill(),1500).unref();}} });
  child.stderr.on('data', chunk => {stderr+=chunk}); child.on('error', e=>{error=e.message});
  const exit=await new Promise(done=>child.on('close',(code,signal)=>done({code,signal})));
  clearTimeout(timer);
  return {stdout,stderr,exit,finalMs,timedOut,error,elapsedMs:performance.now()-start};
}
async function run(task, arm) {
  const id=`${task.id}-${arm}`, runRoot=join(temp,id), home=join(runRoot,'home'), work=join(runRoot,'work');
  await mkdir(join(home,'our-free-model'),{recursive:true});
  await writeFile(join(home,'our-free-model/catalog.json'),JSON.stringify({version:1,at:0,entries:['mimo-v2.6-flash-free'],kiloRows:catalog.kiloRows}));
  for(const [p,contents] of Object.entries(task.files)){const f=join(work,p);await mkdir(dirname(f),{recursive:true});await writeFile(f,contents)}
  await writeFile(join(runRoot,'grader.mjs'),task.grader);
  const initialGrader=await capture(process.execPath,['--test',join(runRoot,'grader.mjs')],{cwd:work,env:process.env},20000);
  if (initialGrader.exit.code === 0 || initialGrader.timedOut) throw new Error(`Initial grader did not demonstrate the ${id} defect`);
  const patch=join(runRoot,'eval.patch.yml'); await writeFile(patch,config(arm));
  const events=[];
  const dsh=await capture(process.execPath,[dshBin,'headless','--patch',patch,'--json',task.prompt],{cwd:work,env:{...process.env,PATH:`${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,DSH_HOME:home,DSH_INSTALL_DIR:resolve(dshBin,'../../../../..'),DSH_MIND_PARK:'0'}},limitMs,line=>{try{const e=JSON.parse(line);events.push(e);return e.type==='final'}catch{return false}});
  const turn=events.filter(e=>e.type==='status'&&e.phase==='turn_end').at(-1);
  const final=events.find(e=>e.type==='final');
  const steps=events.filter(e=>e.type==='status'&&e.phase==='step_end');
  const usageComplete=steps.length>0&&steps.every(e=>e.usage&&Number.isFinite(e.usage.inputTokens)&&Number.isFinite(e.usage.outputTokens)&&Number.isFinite(e.usage.totalTokens));
  const usage=usageComplete?Object.fromEntries(['inputTokens','outputTokens','totalTokens','reasoningTokens','cacheReadTokens'].map(k=>[k,steps.every(e=>Number.isFinite(e.usage[k]))?steps.reduce((s,e)=>s+e.usage[k],0):null])):null;
  let immutable=true;
  for(const [p,v] of Object.entries(task.files).filter(([p])=>p.startsWith('test/'))) {
    try { if(hash(await readFile(join(work,p)))!==hash(v)) immutable=false; } catch { immutable=false; }
  }
  const grader=await capture(process.execPath,['--test',join(runRoot,'grader.mjs')],{cwd:work,env:process.env},20000);
  const completed=turn?.reason?.kind==='completed'&&final!==undefined;
  let dispatch=null;try{dispatch=(await readFile(join(home,'storages/mind-dispatch-samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(l=>{const {situation,unknown,hits}=JSON.parse(l);return {situation,unknown,hits}})}catch{}
  const result={task:task.id,arm,completed,correct:completed&&immutable&&grader.exit.code===0,immutable_tests:immutable,grader_passed:grader.exit.code===0,seconds_to_final:dsh.finalMs===null?null:dsh.finalMs/1000,usage,usage_complete:usageComplete,tool_calls:events.filter(e=>e.type==='tool_call').map(e=>e.tool),step_count:steps.length,turn_reason:turn?.reason??null,dispatch,timed_out:dsh.timedOut,exit:dsh.exit};
  const artifact={result,events,stderr:dsh.stderr,initial_grader:{exit:initialGrader.exit,stdout:initialGrader.stdout,stderr:initialGrader.stderr},grader:{exit:grader.exit,stdout:grader.stdout,stderr:grader.stderr},final_text:final?.text??'',changed_files:{}};
  for(const p of [...Object.keys(task.files).filter(p=>p.startsWith('src/')),...(task.id==='backoff'?['analysis.md']:[])])try{artifact.changed_files[p]=await readFile(join(work,p),'utf8')}catch{}
  await writeFile(join(out,`${id}.json`),JSON.stringify(artifact,null,2));
  console.log(JSON.stringify(result));
  return result;
}
const selected = new Set((process.env.MIND_EVAL_RERUN ?? '').split(',').filter(Boolean));
let previous = null;
let results=[];
if (selected.size) {
  previous=JSON.parse(await readFile(join(out,'results.json'),'utf8'));
  if(previous.old_commit!==commit||previous.model!==model) throw new Error('Cannot reuse results from a different commit or model');
  results=previous.results;
}
const arms=[['off','old','new'],['old','new','off'],['new','off','old']];
for(let i=0;i<tasks.length;i++)for(const arm of arms[i]){
  const key=`${tasks[i].id}:${arm}`;
  if(selected.size&&!selected.has(key)) continue;
  if(selected.size){
    await mkdir(join(out,'intermediate'),{recursive:true});
    await copyFile(join(out,`${tasks[i].id}-${arm}.json`),join(out,'intermediate',`${tasks[i].id}-${arm}-before-source-filter.json`));
    results=results.filter(r=>!(r.task===tasks[i].id&&r.arm===arm));
  }
  console.log(`RUN ${tasks[i].id} ${arm}`);results.push(await run(tasks[i],arm));
}
const files=['index.js','src/situation.js','src/dispatch.js','src/orchestrate.js','src/mind.js','src/hitrate.js','src/sampling.js'];
const hashes={};for(const p of files)hashes[p]={old:hash(await readFile(join(oldPath,p))),new:hash(await readFile(join(root,'packages/dsh-agent-mind',p)))};
await writeFile(join(out,'results.json'),JSON.stringify({generated_at:new Date().toISOString(),model,provider:'our-free-model / Kilo',old_commit:commit,source_sha256:hashes,rerun_after_source_filter:[...(previous?.rerun_after_source_filter??[]),...selected],method:'Fresh isolated home and work directory per run; initial arm order rotated; time to final; independently run hidden Node tests after completion; existing tests must remain byte-identical. Selected final-version runs were repeated after fixing plugin-origin messages and ran later than their controls.',tasks,results},null,2));
console.log(`RESULTS ${join(out,'results.json')}`);
