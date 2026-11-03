/** Paired, isolated headless DSH experiment for dsh-agent-mind.
 *
 * Run with Node 22 on a host with DSH and the installed free-model adapter.
 * Only synthetic fixtures are sent to the provider. A real network and a
 * provider that reports usage are required; failures remain failures.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dshBin = process.env.MIND_EVAL_DSH_BIN ?? 'D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const adapter = process.env.MIND_EVAL_ADAPTER ?? 'C:/Users/lyq/.dsh/profiles/web/node_modules/dsh-our-free-model/index.js';
const catalogPath = process.env.MIND_EVAL_CATALOG ?? 'C:/Users/lyq/.dsh/our-free-model/catalog.json';
const model = process.env.MIND_EVAL_MODEL ?? 'nvidia/nemotron-3.5-super-vl:free';
const outputDir = resolve(process.env.MIND_EVAL_OUTPUT ?? join(root, 'reports', 'mind-ab-20261103'));
const timeoutMs = Number(process.env.MIND_EVAL_TIMEOUT_MS ?? 120000);
const repeat = Number(process.env.MIND_EVAL_REPEATS ?? 1);
const startRepeat = Number(process.env.MIND_EVAL_START_REPEAT ?? 1);
const tasks = [
  {
    id: 'inventory',
    prompt: '请检查当前目录的 orders.csv，按所有行计算总件数、总金额（数量乘单价）以及 A 商品总件数。只读取文件，不修改任何文件；最终仅输出 JSON，字段 total_units、revenue、sku_a 均为数字。',
    files: { 'orders.csv': 'sku,quantity,price\nA,3,12\nB,4,7\nA,2,12\nC,1,9\n' },
    expected: { total_units: 10, revenue: 97, sku_a: 5 },
  },
  {
    id: 'config',
    prompt: '审查当前目录 services.json。找出 retries 大于等于 4 且 timeout_ms 小于等于 1000 的服务名称，按字母排序。只读取文件，不修改任何文件；最终仅输出 JSON，字段 risky 为字符串数组。',
    files: { 'services.json': JSON.stringify({ services: [{ name: 'api', retries: 4, timeout_ms: 1000 }, { name: 'worker', retries: 2, timeout_ms: 3000 }, { name: 'notifier', retries: 5, timeout_ms: 800 }, { name: 'relay', retries: 4, timeout_ms: 1100 }] }, null, 2) },
    expected: { risky: ['api', 'notifier'] },
  },
  {
    id: 'log',
    prompt: '审查当前目录 service.log，找出失败步骤、错误代码以及被拒绝访问的文件。只读取文件，不修改任何文件；最终仅输出 JSON，字段 step、code、file 为字符串。',
    files: { 'service.log': '[08:30:00] step=download status=ok\n[08:30:01] step=export status=error code=EACCES file=reports.csv\n[08:30:02] step=notify status=skipped\n' },
    expected: { step: 'export', code: 'EACCES', file: 'reports.csv' },
  },
  {
    id: 'code',
    prompt: '检查当前目录 pricing.js，按代码实际行为分别求 quote(100, 5) 和 quote(100, 15) 的返回值。只读取文件，不修改任何文件；最终仅输出 JSON，字段 small、large 为数字。',
    files: { 'pricing.js': 'export function quote(price, quantity) {\n  const subtotal = price * quantity;\n  const discount = quantity >= 10 ? 0.2 : 0.1;\n  return subtotal * (1 - discount);\n}\n' },
    expected: { small: 450, large: 1200 },
  },
  {
    id: 'feedback',
    prompt: '审查当前目录 dependencies.json 中的有向影响关系，找出参与因果反馈环的全部节点；仅当节点能沿有向边回到自身时才算参与。只读取文件，不修改任何文件；最终仅输出 JSON，字段 cycle_nodes 为按字母排序的字符串数组。',
    files: { 'dependencies.json': JSON.stringify({ edges: [['api', 'queue'], ['queue', 'worker'], ['worker', 'api'], ['worker', 'report'], ['report', 'mail']] }, null, 2) },
    expected: { cycle_nodes: ['api', 'queue', 'worker'] },
  },
];

function yamlPath(path) { return `'${path.replaceAll('\\', '/').replaceAll("'", "''")}'`; }
function configuration(enabled) {
  const components = [
    ['our-free-model', adapter, '      config:\n        distribution: managed\n'],
    ...['classifier', 'strategy', 'feedback', 'orchestrator'].map(n => [`clis-${n}`, join(root, 'packages/dsh-clis', `clis-${n}.js`), '']),
    ['clis-tools', join(root, 'packages/dsh-clis/index.js'), ''],
    ...(enabled ? [['mind', join(root, 'packages/dsh-agent-mind/index.js'), '']] : []),
  ];
  return `- id: agent-default-model\n  config:\n    provider: our-free-model\n    model: ${model}\n- insert:\n` +
    components.map(([id, path, extra]) => `    - id: ${id}\n      name: ${yamlPath(path)}\n${extra}`).join('');
}

function parseAnswer(text) {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(candidate); } catch { return null; }
}
function matches(value, expected) {
  return value !== null && Object.entries(expected).every(([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v));
}

async function runOne(task, enabled, repetition, catalog, tempRoot) {
  const tag = `${task.id}-${enabled ? 'on' : 'off'}-${repetition}`;
  const runRoot = join(tempRoot, tag);
  const home = join(runRoot, 'home');
  const cwd = join(runRoot, 'work');
  await mkdir(join(home, 'our-free-model'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'our-free-model/catalog.json'), JSON.stringify({ version: 1, at: 0, entries: ['mimo-v2.6-flash-free'], kiloRows: catalog.kiloRows }));
  for (const [name, contents] of Object.entries(task.files)) await writeFile(join(cwd, name), contents);
  const patch = join(runRoot, 'eval.patch.yml');
  await writeFile(patch, configuration(enabled));
  const started = performance.now();
  const raw = [];
  let stderr = '';
  let pending = '';
  let finalMs = null;
  let timedOut = false;
  let launchError = null;
  const child = spawn(process.execPath, [dshBin, 'headless', '--patch', patch, '--json', task.prompt], {
    cwd, env: { ...process.env, DSH_HOME: home, DSH_INSTALL_DIR: resolve(dshBin, '../../../../..'), DSH_MIND_PARK: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The known host installation root is also used by plugin host discovery.
  // dshBin is .../node_modules/@deepseek-ai/dsh/lib/bin.js.
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    let pos;
    while ((pos = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, pos).trim();
      pending = pending.slice(pos + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line); raw.push(event);
        if (event.type === 'final' && finalMs === null) {
          finalMs = performance.now() - started;
          // Some provider background timers keep headless alive after final.
          setTimeout(() => child.kill(), 1500).unref();
        }
      } catch { raw.push({ type: 'non_json_stdout', line }); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', e => { launchError = e.message; });
  const exit = await new Promise(resolveExit => child.on('close', (code, signal) => resolveExit({ code, signal })));
  clearTimeout(timer);
  const final = raw.find(e => e.type === 'final');
  const turn = raw.filter(e => e.type === 'status' && e.phase === 'turn_end').at(-1);
  const steps = raw.filter(e => e.type === 'status' && e.phase === 'step_end');
  const usageComplete = steps.length > 0 && steps.every(e => e.usage && Number.isFinite(e.usage.inputTokens) && Number.isFinite(e.usage.outputTokens));
  const usage = usageComplete ? Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens'].map(key => [key, steps.every(e => Number.isFinite(e.usage[key])) ? steps.reduce((n, e) => n + e.usage[key], 0) : null])) : null;
  const answer = parseAnswer(final?.text ?? '');
  const completed = turn?.reason?.kind === 'completed' && final !== undefined;
  let dispatch = null;
  try {
    const sample = await readFile(join(home, 'storages/mind-dispatch-samples.jsonl'), 'utf8');
    dispatch = sample.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(({ situation, unknown, hits }) => ({ situation, unknown, hits }));
  } catch { /* no sample file: expected when disabled, but not proof of activation */ }
  const result = { task: task.id, enabled, repetition, seconds_to_final: finalMs === null ? null : finalMs / 1000, completed, correct: completed && matches(answer, task.expected), answer, expected: task.expected, usage, usage_complete: usageComplete, tool_calls: raw.filter(e => e.type === 'tool_call').map(e => e.tool), turn_reason: turn?.reason ?? null, dispatch, exit, timed_out: timedOut, launch_error: launchError };
  await writeFile(join(outputDir, `${tag}.json`), JSON.stringify({ result, events: raw, stderr }, null, 2));
  return result;
}

await mkdir(outputDir, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), 'mind-ab-'));
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (!Array.isArray(catalog.kiloRows)) throw new Error('A cached Kilo model catalog is required.');
let results = [];
if (startRepeat > 1) {
  const previous = JSON.parse(await readFile(join(outputDir, 'results.json'), 'utf8'));
  if (previous.model !== model) throw new Error('Cannot append runs with a different model.');
  results = previous.results;
}
for (let rep = startRepeat; rep < startRepeat + repeat; rep++) {
  for (let i = 0; i < tasks.length; i++) {
    // Reverse the within-pair order on alternating tasks and repeats.
    for (const enabled of (i + rep) % 2 === 0 ? [false, true] : [true, false]) {
      console.log(`RUN ${tasks[i].id} ${enabled ? 'on' : 'off'} repeat ${rep}`);
      const result = await runOne(tasks[i], enabled, rep, catalog, tempRoot);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
}
const report = { generated_at: new Date().toISOString(), model, provider: 'our-free-model / Kilo', repeat_ids: [...new Set(results.map(r => r.repetition))], tasks: tasks.map(({ id, prompt, files, expected }) => ({ id, prompt, files, expected })), measurement: 'Wall time from process launch to final event; usage summed across all steps only when every step reports usage. Completion requires a completed turn; correctness requires matching independent expected JSON fields.', temp_root: tempRoot, results };
await writeFile(join(outputDir, 'results.json'), JSON.stringify(report, null, 2));
console.log(`RESULTS ${join(outputDir, 'results.json')}`);
