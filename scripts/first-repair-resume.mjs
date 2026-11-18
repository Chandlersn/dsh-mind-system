// Mount an isolated, one-task repair bridge. The installed scheduler owns all state transitions.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const label = process.argv[2];
assert.match(label ?? '', /^[a-z0-9-]+$/);
const dir = realpathSync(resolve('docs',`first-repair-${label}`));
const root = realpathSync(join(dir,'workspace'));
assert.equal(root,join(dir,'workspace'));
const source = join(root,'input.csv');
const target = join(root,'output.csv');
const expected = 'id,name\n';
const broken = expected+'\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const host = createRequire(pathToFileURL(join(process.env.DSH_SEAM_HOST_ROOT ?? 'D:/dsh', 'package.json')));
const hostLoad = name => import(pathToFileURL(host.resolve(`@deepseek-ai/${name}`)).href);
const runtime = join(homedir(),'.dsh/profiles/web/node_modules/dsh-mind-system/runtime');
const load = p => import(pathToFileURL(join(runtime,p)).href);
const [{Context},{ToolRuntime, validateJsonSchemaValue},{SystemPrompt},{createScope},{RuntimeScheduler},{HostExecutor},{RuntimeStore},{csvNormalizeRecipe}] = await Promise.all([hostLoad('cordis'),hostLoad('dsh-tools'),hostLoad('dsh-system-prompt'),hostLoad('dsh-scope'),load('src/scheduler.js'),load('src/executor.js'),load('src/store.js'),load('recipes/csv-normalize.js')]);
const receipt = JSON.parse(readFileSync(join(dir,'entry-result.json'))).value;
const {taskId,analysis:{analysisId}} = receipt;
const store = new RuntimeStore(join(dir,'runtime.sqlite'));
const ctx = new Context();
const toolName = 'runtime_replace_owned_csv';
const verdict = ok => ({verdict:ok?'allow':'deny'});
const nativeArgs = a => a.path===target && a.content===expected && a.expectedSha256===hash(broken);
const checks = {
  'csv-source-hash-unchanged':({io}) => verdict(io.readFileSync(source,'utf8')===expected),
  'csv-owned-output-unchanged':({io,candidate}) => verdict(nativeArgs(candidate.arguments) && io.readFileSync(target,'utf8')===broken),
  'csv-workspace-scope':({io,candidate}) => verdict(candidate.arguments.path===target && io.realpathSync(target)===target && io.realpathSync(source)===source),
};
const policy = {allowedTools:[toolName],toolEffects:{[toolName]:'reversible_write'},requiredPreconditionIds:Object.keys(checks),preconditions:checks,
  prepare({task,state,previousAttempt:p}) {
    assert.equal(task.taskId,taskId); assert.equal(task.scopeRef,taskId); assert.equal(task.workspaceRoot,root);
    assert.equal(task.recipeId,'csv-normalize'); assert.equal(task.recipeVersion,'1');
    assert.equal(state.inputs.inputSha256,hash(expected)); assert.equal(state.inputs.inputFile,'input.csv'); assert.equal(state.inputs.outputFile,'output.csv');
    assert.equal(p.status,'settled'); assert.equal(p.candidate.toolName,'runtime_write_text');
    assert.equal(p.candidate.arguments.createOnly,true); assert.equal(p.candidate.arguments.path,target);
    assert.equal(p.candidate.arguments.content,broken); assert.equal(p.outcome.status,'succeeded'); assert.equal(p.outcome.output.created,true);
    assert.equal(p.verification.verifierId,'csv-source-output'); assert.equal(p.verification.status,'fail'); assert.equal(p.verification.reason,'output_invalid_csv');
    assert.deepEqual(p.verification.evidenceRefs,[`file:${source}#sha256:${hash(expected)}`,`file:${target}#sha256:${hash(broken)}`]);
    return Object.freeze({taskId,expectedSha256:hash(broken)});
  }};
const output = {schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
let executor;
try {
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false}).await();
  await ctx.plugin(ToolRuntime,{mode:'native'}).await();
  const tools = ctx.get('tools');
  const agent = {id:'isolated-normal-entry'}; const scope=createScope(ctx,agent); await scope.ctx.fiber.await(); agent.ctx=scope.ctx;
  executor=new HostExecutor({context:ctx,tools,agent});
  const authority={scopeRef:taskId,workspaceRoot:root,allowedTools:['runtime_write_text',toolName],agent};
  const scheduler=new RuntimeScheduler({store,executor,tools,recipes:[{...csvNormalizeRecipe,repairPolicy:policy}],validateArguments:({tool,arguments:args})=>validateJsonSchemaValue(tool.parameters,args)});
  tools.register({name:toolName,description:'Remove one trailing blank line from the confirmed, owned header-only file.',parameters:{type:'object',required:['path','content','expectedSha256'],additionalProperties:false,properties:{path:{type:'string'},content:{type:'string'},expectedSha256:{type:'string'}}},output,
    async execute(args,exec){
      assert.equal(exec.agent,agent); assert.ok(nativeArgs(args)); assert.equal(realpathSync(target),target); assert.ok(lstatSync(target).isFile());
      const fd=openSync(target,'r+');
      try {assert.equal(fstatSync(fd).nlink,1); assert.equal(readFileSync(fd,'utf8'),broken); assert.equal(readFileSync(source,'utf8'),expected); ftruncateSync(fd,Buffer.byteLength(args.content)); fsyncSync(fd);}
      finally {closeSync(fd);}
      return {path:target,bytes:Buffer.byteLength(args.content)};
    }});
  tools.register({name:'first_repair_apply',description:'Consume the locally authorized proposal for one declared task.',parameters:{type:'object',properties:{},additionalProperties:false},output,
    async execute(_args,exec){assert.equal(exec.agent,agent); return scheduler.repair(taskId,analysisId,{authority,signal:exec.signal});}});
  ctx.on('tools/result',(exec,result)=>appendFileSync(join(dir,'calls.jsonl'),JSON.stringify({callId:exec.callId,tool:exec.name,isError:result.isError})+'\n'));
  const result=await tools.execute({name:'first_repair_apply',arguments:{},callId:randomUUID(),agent,signal:new AbortController().signal});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.value.status,'completed',JSON.stringify(result.value));
  writeFileSync(join(dir,'repair-result.json'),JSON.stringify(result.value,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({taskId,analysisId,status:result.value.status,budget:result.value.budgetUsage}));
} finally {await executor?.dispose(); await ctx.fiber.dispose(); store.close();}
