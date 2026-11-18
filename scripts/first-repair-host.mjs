// Run one declared task through the installed runtime and real Cordis ToolRuntime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const label = process.argv[2];
assert.match(label ?? '', /^[a-z0-9-]+$/);
const evidence = resolve('docs', `first-repair-${label}`);
mkdirSync(evidence);
const work = join(evidence, 'workspace');
mkdirSync(work);
const save = (file, value) => writeFileSync(join(evidence, file), JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
const host = createRequire(pathToFileURL(join(process.env.DSH_SEAM_HOST_ROOT ?? 'D:/dsh', 'package.json')));
const load = name => import(pathToFileURL(host.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { ToolRuntime }, { SystemPrompt }, { createScope }] = await Promise.all(['cordis','dsh-tools','dsh-system-prompt','dsh-scope'].map(load));
const runtime = join(homedir(), '.dsh/profiles/web/node_modules/dsh-mind-system/runtime');
const {default: plugin} = await import(pathToFileURL(join(runtime, 'src/host-plugin.js')).href);
const taskId = `empty-csv-${randomUUID()}`;
writeFileSync(join(work,'input.csv'), 'id,name\n', {flag:'wx'});
const task = {taskId, recipeId:'csv-normalize', recipeVersion:'1', scopeRef:taskId, workspaceRoot:work, goal:'Normalize the empty CSV, preserving its header and source bytes.', inputs:{inputFile:'input.csv',outputFile:'output.csv'}, allowedTools:['runtime_write_text','runtime_replace_owned_csv'], deadlineAt:Date.now()+1_800_000};
const responseFile = join(evidence, 'response.json');
const relay = createServer(async (req,res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const packet = JSON.parse(body).messages[0].content;
    save('packet.json', packet);
    const db = new DatabaseSync(join(evidence,'runtime.sqlite'), {readOnly:true});
    try { save('before.json', {attempt:db.prepare('SELECT * FROM attempts WHERE task_id=?').get(taskId), outputHex:readFileSync(join(work,'output.csv')).toString('hex')}); } finally {db.close();}
    console.log('Awaiting a fresh model diagnosis at', responseFile);
    const end = Date.now()+115_000;
    while (!existsSync(responseFile) && Date.now()<end) await delay(100);
    res.end(readFileSync(responseFile));
  } catch (error) { res.statusCode=500; res.end(error.message); }
});
await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
const ctx = new Context();
try {
  await ctx.plugin(SystemPrompt, {includeHarnessIdentity:false,includeRuntimeContext:false}).await();
  await ctx.plugin(ToolRuntime, {mode:'native'}).await();
  const config = {enabled:true, workspaceRoot:work,stateDir:evidence,tasks:[task],analysis:{endpoint:`http://127.0.0.1:${relay.address().port}`, apiKey:'local-only', model:'human-directed-session-model', timeoutMs:120000}};
  await ctx.plugin(plugin, config).await();
  const agent = {id:'isolated-normal-entry'};
  const scope = createScope(ctx,agent);
  await scope.ctx.fiber.await(); agent.ctx = scope.ctx;
  ctx.on('tools/result',(exec,result)=>appendFileSync(join(evidence,'calls.jsonl'),JSON.stringify({callId:exec.callId,tool:exec.name,isError:result.isError})+'\n'));
  save('mount.json',{task,installedHost:host.resolve('@deepseek-ai/dsh-tools'),runtime,probe:plugin.healthProbe.probe()});
  const result = await ctx.get('tools').execute({name:'runtime_run',callId:randomUUID(),agent,arguments:{taskRef:taskId},signal:new AbortController().signal});
  save('entry-result.json',result);
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.value.analysis.status,'proposed',JSON.stringify(result.value));
} finally {relay.closeAllConnections(); relay.close(); await ctx.fiber.dispose();}
