import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Usage: node scripts/dr18-model-loop.mjs <manifest.json> <new-report.json> <installed-dsh-bin.js> [concurrency]
const [manifestPath, reportPath, cliPath, concurrencyText = '1'] = process.argv.slice(2);
const concurrency = Number(concurrencyText);
if (!cliPath || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error('Expected manifest, new report, installed DSH CLI and optional concurrency (1-8).');
if (existsSync(reportPath)) throw Error('Choose a new report path.');
const cli = resolve(cliPath);
const cliVersion = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'))).version;
const manifest = JSON.parse(readFileSync(manifestPath));
const sha = data => createHash('sha256').update(data).digest('hex');
const hostCorpusHash = 'a819f73e8c1936805d8cf5decdd3c1fe5ee4f770e54d62a2988e46bc5a1d452a';
const edges = {empty:[], 'case-order':[{id:'A',name:'A'},{id:'a',name:'a'},{id:'z',name:'z'}], unicode:[{id:'a',name:'東京'},{id:'b',name:'café'}]};
const sources = new Map(manifest.cases.map(item => [item.id, readFileSync(join(item.workspace, item.input))]));
const cases = manifest.cases.map(item => {
  const source = sources.get(item.id);
  const expected = Object.hasOwn(edges,item.id) ? Buffer.from(JSON.stringify(edges[item.id], null, 2)+'\n') : sources.get(item.id.split('-')[0]+'-0');
  if (sha(source) !== item.inputSha256 || sha(expected) !== item.expectedSha256) throw Error('Fixture bytes do not match the manifest.');
  return {id:item.id, source, expected};
});
const corpusHash = sha(JSON.stringify(cases.map(({id, source, expected}) => ({id, source: source.toString(), expected: expected.toString()}))));
if (corpusHash !== hostCorpusHash || cases.length !== 24) throw Error('Manifest does not match the 24-case host corpus.');
const root = mkdtempSync(join(tmpdir(), 'dr18-model-'));
const prompt = 'In the current working directory read input.json and create output.json. It is an array of objects with unique string id and string name. Preserve each id, trim whitespace from both ends of each name, and sort ascending by id in ordinal UTF-16 code unit order. Serialize objects with keys id then name, using JSON.stringify(array, null, 2) formatting, UTF-8 without BOM, and exactly one final LF. Preserve input.json. Use ordinary local file or shell tools as needed. Work only in this directory. Do not inspect configuration, credentials, other samples or external files. Reply briefly when finished.';
const deadlineMs = 180000;
const sums = (rows, field) => rows.length && rows.every(row => Number.isSafeInteger(row?.[field])) ? rows.reduce((n,row) => n+row[field], 0) : null;
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
function readRegular(path) {
  try { return lstatSync(path).isFile() ? readFileSync(path) : null; } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
async function sample(item) {
  const cwd = join(root, item.id);
  mkdirSync(cwd);
  const input = join(cwd,'input.json');
  writeFileSync(input, item.source, { flag: 'wx' });
  const usage = [], toolCalls = {};
  let sessionHash = null, turns = 0, steps = 0, finals = 0, toolErrors = 0, timedOut = false, modelMessages = 0;
  const start = performance.now();
  const child = spawn(process.execPath, [cli, '--profile','headless','--json',prompt], {cwd, windowsHide:true, stdio:['ignore','pipe','ignore']});
  const terminal = new Promise((res, rej) => {child.once('error', rej); child.once('close', res);});
  const timer = setTimeout(() => {timedOut = true; child.kill();}, deadlineMs);
  let exitCode;
  try {
    for await (const line of createInterface({input: child.stdout, crlfDelay: Infinity})) {
      let event;
      try {event = JSON.parse(line);} catch {continue;}
      if (event.type === 'session' && typeof event.sessionId === 'string') sessionHash = sha(event.sessionId);
      if (event.type === 'status') {
        if (event.phase === 'turn_start') turns++;
        if (event.phase === 'step_start') steps++;
        if (event.phase === 'step_end') usage.push(event.usage ?? {});
      }
      if (event.type === 'tool_call' && /^[a-z][a-z0-9_:-]{0,80}$/i.test(event.tool)) toolCalls[event.tool] = (toolCalls[event.tool] ?? 0) + 1;
      if (event.type === 'tool_result' && event.status === 'error') toolErrors++;
      if (event.type === 'text' && event.text) modelMessages++;
      if (event.type === 'final') finals++;
    }
    exitCode = await terminal;
  } finally {clearTimeout(timer);}
  const ms = performance.now() - start;
  const output = readRegular(join(cwd,'output.json'));
  const bytesMatch = output?.equals(item.expected) ?? false;
  const sourcePreserved = readRegular(input)?.equals(item.source) ?? false;
  const finished = !timedOut && exitCode === 0 && sessionHash !== null && turns === 1 && steps > 0 && finals === 1 && (modelMessages > 0 || usage.some(step => step.outputTokens > 0));
  const tokens = Object.fromEntries(tokenFields.map(f => [f, steps === usage.length ? sums(usage, f) : null]));
  return {caseId:item.id, ms, exitCode, timedOut, sessionHash, turns, steps, stepEnds:usage.length, finals, modelMessages, toolCalls, toolErrors, tokens, sourceSha256:sha(item.source), expectedSha256:sha(item.expected), actualSha256:output && sha(output), bytesMatch, sourcePreserved, accepted:finished && bytesMatch && sourcePreserved};
}
const samples = new Array(cases.length);
let cursor = 0;
async function worker() {
  while (cursor < cases.length) {
    const i = cursor++;
    const row = await sample(cases[i]);
    samples[i] = row;
    writeFileSync(join(root,cases[i].id,'observation.json'),JSON.stringify(row,null,2), {flag:'wx'});
    console.log(`${row.caseId} accepted=${row.accepted} steps=${row.steps} ms=${Math.round(row.ms)}`);
  }
}
console.log(`Trial artifacts: ${root}`);
await Promise.all(Array.from({length: concurrency}, worker));
const sessions = new Set(samples.map(s => s.sessionHash).filter(Boolean));
const times = samples.map(s => s.ms).sort((a,b)=>a-b);
const summary = {n:samples.length, pass:samples.filter(s=>s.accepted).length, distinctSessions:sessions.size, p50Ms:times[Math.ceil(times.length*.5)-1], p95Ms:times[Math.ceil(times.length*.95)-1], steps:samples.reduce((n,s)=>n+s.steps,0), tokens:Object.fromEntries(tokenFields.map(f=>[f,sums(samples.map(s=>s.tokens),f)]))};
const report = {schemaVersion:1, generatedAt:new Date().toISOString(), arm:'existing_model_loop', corpusSha256:corpusHash, cliVersion,nodeVersion:process.version, profile:'headless', concurrency, deadlineMs, prompt, timing:'Each fresh CLI process launch through process close, including profile startup, model and tool time. Acceptance reads excluded.', modelCallBasis:'Committed CLI step events. Transport attempts and retry counts are unavailable.', summary, samples};
writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
if (summary.pass !== 24 || sessions.size !== 24) process.exitCode = 1;
