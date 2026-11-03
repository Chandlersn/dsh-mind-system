/** Behaviour-guidance A/B experiment for dsh-agent-mind (policy matrix).
 *
 * Unlike `benchmark-agent-mind.mjs` (task-correctness pairs), this script asks a
 * different question: does the plugin steer *observable behaviour* at the right
 * moments, and stay quiet at the wrong ones?
 *
 * Every task carries a PRE-REGISTERED expectation, written before any run:
 *
 *   expected_situation   what the dispatcher should decide (or `unknown`)
 *   expected_withheld    whether guidance must be WITHHELD (ambiguous / no signal)
 *   expected_hits        signals that must / must not appear
 *   expected_behavior    the observable behaviour the run must show
 *   judge                how it is decided: `auto` | `manual` | `unknown`
 *
 * `judge: auto` means a script can check it from the sample file, the tool-call
 * sequence, or the exit status. `manual` means the script only stores the raw
 * answer for a human. `unknown` means the evidence needed does not exist in this
 * harness; recording a verdict there would be inventing data.
 *
 * Two facts about this environment are load-bearing and recorded in the report:
 *
 * 1. The headless profile provides NO `webServer` service, and memory-manager
 *    injects it, so `memory_*` tools (the whole recall family) silently do not
 *    exist unless something provides it. A no-op stub provides it here. That
 *    stub is a TEST DOUBLE, not a real headless capability.
 * 2. The child process does not exit after `final` (provider timers), so the
 *    collector kills it; a SIGTERM after `final` is collection, not a failure.
 *
 * Node 22. `npm.ps1` is blocked by execution policy: run `node scripts/...mjs`.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dshBin = process.env.MIND_EVAL_DSH_BIN ?? 'D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const adapter = process.env.MIND_EVAL_ADAPTER ?? 'C:/Users/lyq/.dsh/profiles/web/node_modules/dsh-our-free-model/index.js';
const catalogPath = process.env.MIND_EVAL_CATALOG ?? 'C:/Users/lyq/.dsh/our-free-model/catalog.json';
const model = process.env.MIND_EVAL_MODEL ?? 'nvidia/nemotron-3.5-super-vl:free';
// Provider selection. The Kilo free lane rate-limits the whole ACCOUNT (every
// model in its catalog returns 429 at once), so a second lane is configurable.
const provider = process.env.MIND_EVAL_PROVIDER ?? 'our-free-model';
const providerLabel = process.env.MIND_EVAL_PROVIDER_LABEL ?? (provider === 'our-free-model' ? 'our-free-model / Kilo' : provider);
const extraAdapters = (process.env.MIND_EVAL_ADAPTERS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map((path, i) => [`extra-adapter-${i + 1}`, path, '']);
const outputDir = resolve(process.env.MIND_EVAL_OUTPUT ?? join(root, 'reports', 'mind-policy-20261103'));
const timeoutMs = Number(process.env.MIND_EVAL_TIMEOUT_MS ?? 150000);
const repeats = Number(process.env.MIND_EVAL_REPEATS ?? 1);
const park = process.env.MIND_EVAL_PARK ?? '0';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const rejudge = argv.includes('--rejudge');
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : (process.env.MIND_EVAL_ONLY ?? '');
})();
const onlyIds = new Set(String(only).split(',').map(s => s.trim()).filter(Boolean));

// ── task matrix ─────────────────────────────────────────────────────────────
//
// `category` groups the matrix for the report. `expect` is the pre-registered
// judgement; nothing below is derived from a run.
const tasks = [
  // ── A. should engage: diagnose ──
  {
    id: 'diag-no-effect',
    category: '应触发·diagnose',
    prompt: '这个功能我改了三次都没有效果，指标压下去过一会儿又弹回来。现在该先做什么？只回答你的判断，不要改文件。',
    expect: {
      situation: 'diagnose',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=diagnose，reason=matched 或 ambiguous；模型回答应先判结构/因果，而不是直接给第四个改法。',
      judge: 'auto',
    },
  },
  {
    id: 'diag-whodunit',
    category: '应触发·diagnose',
    prompt: '两个缓存互相失效，我分不清谁是因谁是果。先帮我判一下这个因果结构，先别动代码。',
    expect: {
      situation: 'diagnose',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      write_targets_must_be_empty: true,
      behavior: '采样 situation=diagnose；"先别动"之后模型不得修改任何文件（write_targets 为空）。',
      judge: 'auto',
    },
  },

  // ── B. should engage: execute ──
  {
    id: 'exec-fix-boundary',
    category: '应触发·execute',
    prompt: '当前目录 src/retry.js 的 retry() 在全部失败时多调了一次 operation——按 README 写的规格，最多只该调用 maxAttempts 次（含首次）。请修复这个缺陷并运行测试验证。不要修改现有测试。',
    files: {
      'package.json': '{"name":"retry-fixture","type":"module","scripts":{"test":"node --test test/*.test.js"}}\n',
      'README.md': '# retry\nretry(operation, maxAttempts) 最多调用 operation maxAttempts 次（包括首次），返回首次成功值；全部失败时抛出最后一次原始错误。\n',
      'src/retry.js': 'export async function retry(operation, maxAttempts) {\n  let lastError;\n  for (let attempt = 0; attempt <= maxAttempts; attempt++) {\n    try { return await operation(); } catch (error) { lastError = error; }\n  }\n  throw lastError;\n}\n',
      'test/retry.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { retry } from '../src/retry.js';\ntest('exhausted retry uses exact maximum', async () => { let n=0; const err=new Error('failed'); await assert.rejects(retry(async()=>{n++;throw err},3),e=>e===err); assert.equal(n,3); });\n",
    },
    expect: {
      situation: 'execute',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      files_must_stay_unchanged: ['test/retry.test.js', 'README.md'],
      behavior: '采样 situation=execute；模型实际修改 src/retry.js 并运行测试（tool_calls 含 edit/write 与 pwsh）；test/retry.test.js 与 README.md 字节不变。',
      judge: 'auto',
    },
  },
  {
    id: 'exec-batch-rename',
    category: '应触发·execute',
    prompt: '当前目录有三个 .txt 文件，请把它们统一加上前缀 out- 重命名（文件内容不用改）。做完告诉我最终文件名。',
    files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
    expect: {
      situation: 'execute',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=execute；模型执行了重命名（pwsh），最终目录里存在 out-a.txt 等。',
      judge: 'auto',
    },
  },

  // ── C. should engage: recall ──
  {
    id: 'recall-convention',
    category: '应触发·recall',
    prompt: '我们以前对日志时间格式约定过什么？按那个约定来，不要自己另定一种。',
    memorySeed: {
      'MEMORY.md': [
        '# 记忆索引',
        '',
        '| 条目 | 摘要 |',
        '| --- | --- |',
        '| [日志时间格式约定](functions/日志约定.md) | 日志时间必须用 ISO-8601 带时区偏移，禁止本地时间裸写 |',
        '| [构建产物不重建](functions/构建.md) | 拷贝中间产物会发旧代码 |',
        '',
      ].join('\n'),
      'functions/日志约定.md': '## [2026-01-01] 日志时间格式\n\n- 结论：日志时间必须用 ISO-8601 带时区偏移。\n',
    },
    expect: {
      situation: 'recall',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=recall；模型应先查记忆（tool_calls 含 memory_read 或 memory_search），再按记忆里的约定回答。',
      judge: 'auto',
    },
  },
  {
    id: 'recall-pitfall',
    category: '应触发·recall',
    prompt: '上次踩过的那个构建坑，记得吗？动手之前先查一下当时是怎么说的。',
    memorySeed: {
      'MEMORY.md': [
        '# 记忆索引',
        '',
        '| 条目 | 摘要 |',
        '| --- | --- |',
        '| [构建产物不重建](functions/构建.md) | 拷贝式打包不重建中间产物，部署成功却发旧代码 |',
        '',
      ].join('\n'),
      'functions/构建.md': '## [2026-01-02] 拷贝式打包\n\n- 结论：只拷中间产物不重建，部署"成功"却发旧代码；核对中间产物生成时间。\n',
    },
    expect: {
      situation: 'recall',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=recall；模型先查记忆（memory_read/memory_search）再回答这个坑是什么。',
      judge: 'auto',
    },
  },

  // ── D. should engage: retrieve ──
  {
    id: 'retrieve-version',
    category: '应触发·retrieve',
    prompt: '查一下网上：Node 22 里 node:test 的 mock.timers 是哪个小版本引入的？要外部资料，不要凭记忆回答。',
    expect: {
      situation: 'retrieve',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=retrieve；模型调用检索工具（web_search/web_fetch 或 domain_search），而不是直接凭记忆下结论。',
      judge: 'auto',
    },
  },
  {
    id: 'retrieve-doc',
    category: '应触发·retrieve',
    prompt: '我不想凭印象写，请去外部文档确认一下：Array.prototype.toSorted 是原地排序还是返回新数组？给出资料来源。',
    expect: {
      situation: 'retrieve',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=retrieve；模型调用检索/抓取工具并给出可点击来源。',
      judge: 'auto',
    },
  },

  // ── E. should NOT engage ──
  {
    id: 'neg-short',
    category: '不应触发·短输入',
    prompt: '在吗',
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 reason=nothing-actionable 或 no-signal，situation=null；插件不得重排工具面（withheld=true）。',
      judge: 'auto',
    },
  },
  {
    id: 'neg-chitchat',
    category: '不应触发·闲聊',
    prompt: '今天天气挺好的，你平时会干点什么消遣？随便聊聊就行。',
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=null（无信号）；插件不得重排工具面。',
      judge: 'auto',
    },
  },
  {
    id: 'neg-format-only',
    category: '不应触发·纯格式转换',
    prompt: '把下面这行字转成全大写，只输出结果，不要解释：hello world from the harness',
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '采样 situation=null；模型只输出大写结果；插件不得重排工具面。这类问题判结构只会输出空转。',
      judge: 'auto',
    },
  },
  {
    id: 'neg-readonly-review',
    category: '不应触发·否定表达',
    prompt: '只是只读审阅：看一下当前目录 service.log，告诉我失败了哪一步。不要修改任何文件，也不要跑测试。',
    files: { 'service.log': '[08:30:00] step=download status=ok\n[08:30:01] step=export status=error code=EACCES\n[08:30:02] step=notify status=skipped\n' },
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: ['do-it', 'intent-improve', 'intent-produce'],
      files_must_stay_unchanged: ['service.log'],
      write_targets_must_be_empty: true,
      shell_must_be_empty: true,
      behavior: '否定辖域必须生效：采样 hits 不含 do-it / intent-improve 一族；模型不写文件、不跑测试、不执行命令。',
      judge: 'auto',
    },
  },
  {
    id: 'neg-quoted-mention',
    category: '不应触发·引用提及',
    prompt: '当前目录 note.md 里那句「修复登录超时，然后重新部署」是别人写的注释，请解释他想表达什么。',
    files: { 'note.md': '# 便签\n\n修复登录超时，然后重新部署\n' },
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: ['do-it'],
      files_must_stay_unchanged: ['note.md'],
      write_targets_must_be_empty: true,
      behavior: '引号内是被引用文本，不是指令：采样 hits 不含 do-it（输入里明明有"修复/部署"）；模型只解释，不改任何文件。',
      judge: 'auto',
    },
  },

  // ── F. ambiguous / insufficient information ──
  {
    id: 'amb-balanced-intents',
    category: '模糊·两类势均力敌',
    prompt: '帮我评估一下这个方案，然后整理成一份文档。',
    expect: {
      situation: 'ambiguous-any',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '两类意图（审查/生产）得分接近 → 采样 ambiguous=true 且 reason=ambiguous；插件必须刻意不重排工具面（withheld=true）。',
      judge: 'auto',
    },
  },
  {
    id: 'amb-vague',
    category: '模糊·信息不足',
    prompt: '这个东西有点问题，你看着办吧。',
    expect: {
      situation: 'unknown',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: [],
      behavior: '输入没有可判的动作内容 → 采样 situation=null；插件不得凭空猜一个处境去重排。',
      judge: 'auto',
    },
  },

  // ── G. multi-intent single request ──
  {
    id: 'multi-recall-then-fix',
    category: '多意图·单请求',
    prompt: '先查一下我们以前对这个模块的约定，然后按约定把 src/limit.js 里的越界判断修好。',
    files: {
      'src/limit.js': 'export function clamp(value, max) {\n  return value > max ? max : value;\n}\n',
    },
    memorySeed: {
      'MEMORY.md': '# 记忆索引\n\n| 条目 | 摘要 |\n| --- | --- |\n| [clamp 约定](functions/limit.md) | clamp 必须同时处理下界 0：负数一律归 0 |\n',
      'functions/limit.md': '## [2026-01-03] clamp 约定\n\n- 结论：clamp 必须同时处理下界 0。\n',
    },
    expect: {
      situation: 'recall-to-execute-any',
      withheld: false,
      hits_must_include: ['need-prior'],
      hits_must_exclude: [],
      behavior: '采样 hits 同时含记忆信号与执行信号（多意图未被压成一个代号）；模型先查记忆再改文件。',
      judge: 'auto',
    },
  },

  // ── H. user instruction overrides plugin inference ──
  {
    id: 'veto-no-causal',
    category: '冲突·用户否决推断',
    prompt: '别做因果分析，就把当前目录 numbers.csv 的一列求和。只读取，不修改。',
    files: { 'numbers.csv': 'v\n1\n2\n3\n4\n' },
    expect: {
      situation: 'no-diagnose',
      withheld: true,
      hits_must_include: [],
      hits_must_exclude: ['clis-causal'],
      files_must_stay_unchanged: ['numbers.csv'],
      write_targets_must_be_empty: true,
      behavior: '用户明确禁止因果分析 → 否决必须生效：采样 hits 不含 clis-causal（输入里明明有"因果"二字）；插件不应把 clis 推到最前。',
      judge: 'auto',
    },
  },
  {
    id: 'veto-no-touch',
    category: '冲突·明确不许改',
    prompt: '不要修改任何文件，也不要执行命令。只看一下 config.json，告诉我有没有危险的默认值。',
    files: { 'config.json': JSON.stringify({ retries: 6, timeout_ms: 500 }, null, 2) },
    expect: {
      situation: 'diagnose',
      withheld: false,
      hits_must_include: ['intent-question'],
      hits_must_exclude: ['do-it'],
      files_must_stay_unchanged: ['config.json'],
      write_targets_must_be_empty: true,
      shell_must_be_empty: true,
      behavior: 'execute 被否决（不得改/不得执行），判断类意图保留：采样 situation=diagnose 且 hits 不含 do-it；模型不写文件、不执行命令。',
      judge: 'auto',
    },
  },

  // ── I. multi-step real task ──
  {
    id: 'multistep-backoff',
    category: '多步骤真实任务',
    prompt: '服务的退避延迟反复异常。请结合 README、logs/service.log、实现和测试定位根因，修复它并运行测试；再在当前目录写 analysis.md 说明根因和验证方式。不要修改现有测试或公开接口，不要访问当前目录以外的文件。',
    files: {
      'package.json': '{"name":"backoff-fixture","type":"module","scripts":{"test":"node --test test/*.test.js"}}\n',
      'README.md': '# delayMs\ndelayMs(attempt, baseMs, capMs) 返回 baseMs * 2 ** attempt，但最大不能超过 capMs。参数是非负数，attempt 是从 0 开始的非负整数。\n',
      'logs/service.log': 'attempt=0 baseMs=100 capMs=800 delayMs=800\nattempt=1 baseMs=100 capMs=800 delayMs=800\nattempt=4 baseMs=100 capMs=800 delayMs=1600\n',
      'src/backoff.js': 'export function delayMs(attempt, baseMs, capMs) {\n  const candidate = baseMs * 2 ** attempt;\n  return Math.max(candidate, capMs);\n}\n',
      'test/backoff.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { delayMs } from '../src/backoff.js';\ntest('delay starts at base and respects maximum',()=>{assert.equal(delayMs(0,100,800),100);assert.equal(delayMs(4,100,800),800)});\n",
    },
    expect: {
      situation: 'any-matched',
      withheld: false,
      hits_must_include: [],
      hits_must_exclude: [],
      files_must_stay_unchanged: ['logs/service.log', 'test/backoff.test.js', 'README.md'],
      behavior: '模型读多个文件、改实现、跑测试、写 analysis.md；测试与日志文件字节不变。',
      judge: 'auto',
      manual_extra: '根因是否真的定位到 Math.max/Math.min 的语义错误，以及 analysis.md 的论证是否成立。',
    },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────
const yamlPath = p => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`;
const hashOf = s => createHash('sha256').update(s).digest('hex');

/** Keep tool arguments for evidence, with long strings clipped: a diff body can
 *  be tens of kilobytes and only the target path matters for judgement. */
function truncateArgs(input, limit = 400) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input.slice(0, limit);
  try {
    const walk = (v) => {
      if (typeof v === 'string') return v.length > limit ? `${v.slice(0, limit)}...[${v.length} chars]` : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(input);
  } catch {
    return undefined;
  }
}

/** A no-op webServer provider: ROUTING ONLY, no HTTP listener, no real routes.
 *  It exists because memory-manager injects `webServer` and the headless profile
 *  does not provide it: without this, memory_* tools silently never register and
 *  the recall family cannot be observed at all. TEST DOUBLE, not a harness
 *  capability; the report must say so. */
const STUB_SOURCE = `export const name = 'stub-webserver';
export const inject = [];
export function apply(ctx) {
  ctx.provide('webServer', {
    register: () => () => {},
    registerUpgrade: () => () => {},
  }, () => true);
}
`;

function configuration(enabled, stubPath) {
  const components = [
    ['our-free-model', adapter, '      config:\n        distribution: managed\n'],
    ...extraAdapters,
    ['stub-webserver', stubPath, ''],
    ...['classifier', 'strategy', 'feedback', 'orchestrator'].map(n => [`clis-${n}`, join(root, 'packages/dsh-clis', `clis-${n}.js`), '']),
    ['clis-tools', join(root, 'packages/dsh-clis/index.js'), ''],
    ['meta-framework', join(root, 'packages/dsh-meta-framework/index.js'), ''],
    ['memory-manager', join(root, 'packages/dsh-memory-manager/server.js'), ''],
    ...(enabled ? [['mind', join(root, 'packages/dsh-agent-mind/index.js'), '']] : []),
  ];
  return `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n- insert:\n` +
    components.map(([id, path, extra]) => `    - id: ${id}\n      name: ${yamlPath(path)}\n${extra}`).join('');
}

async function readSamples(home) {
  try {
    const text = await readFile(join(home, 'storages/mind-dispatch-samples.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return null; // no file: absence of evidence, recorded as null (never as "no signal")
  }
}

async function readdirOrEmpty(dir) {
  try { const { readdir } = await import('node:fs/promises'); return await readdir(dir); } catch { return []; }
}

async function seedMemory(home, seed) {
  if (!seed) return;
  for (const [name, contents] of Object.entries(seed)) {
    const dest = join(home, 'memory', name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents);
  }
}

const FILE_MUTATING_TOOLS = new Set(['edit', 'write', 'str_replace_editor']);
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal', 'cordis']);

function writeTargetsOf(calls) {
  return (calls ?? [])
    .filter(c => FILE_MUTATING_TOOLS.has(c.tool) && c.input && typeof c.input === 'object')
    .map(c => String(c.input.file_path ?? c.input.path ?? ''))
    .filter(Boolean);
}
function shellCommandsOf(calls) {
  return (calls ?? [])
    .filter(c => SHELL_TOOLS.has(c.tool) && c.input && typeof c.input === 'object')
    .map(c => String(c.input.command ?? ''))
    .filter(Boolean);
}

/** Auto-judge one run against its pre-registered expectation.
 *  Returns `{verdict: 'pass'|'fail'|'manual'|'invalid'|'unjudged', reasons: [...]}`.
 *
 *  `invalid` is a separate state on purpose: a run whose turn ended in an error
 *  (rate limit, quota, adapter) produced NO model output, so there is no
 *  behaviour to judge. Calling it `fail` would book an environment fault as a
 *  plugin defect; calling it `pass` would be a green light carrying no
 *  information. Invalid runs never enter a pass rate. */
function judgeRun(task, run) {
  const e = task.expect;
  if (e.judge === 'manual') return { verdict: 'manual', reasons: ['expect.judge=manual：脚本只存原文，需人读'] };
  if (e.judge === 'unknown') return { verdict: 'unjudged', reasons: ['expect.judge=unknown：本环境无可观察证据'] };

  if (run.timed_out) return { verdict: 'fail', reasons: ['timed_out'] };
  if (run.final_text === null) return { verdict: 'fail', reasons: ['no final event'] };
  if (run.turn_reason?.kind === 'error') {
    const message = run.turn_reason?.error?.message ?? 'unknown';
    const code = run.turn_reason?.error?.code ?? 'no-code';
    return { verdict: 'invalid', reasons: [`turn 以错误结束（${code}）：${String(message).slice(0, 120)}`] };
  }
  if (run.completed !== true) return { verdict: 'fail', reasons: ['turn 未完成'] };

  const reasons = [];

  // The guidance signal only exists when the plugin is loaded. A disabled run is
  // evidence of absence, not of behaviour: no sample file is the pass condition.
  if (!run.enabled) {
    const ok = run.samples === null;
    return { verdict: ok ? 'pass' : 'fail', reasons: [ok ? '禁用组无采样文件（符合预期）' : '禁用组出现了采样文件'] };
  }
  if (run.samples === null || run.samples.length === 0) {
    return { verdict: 'fail', reasons: ['启用组没有采样：插件未生效或未判处境'] };
  }

  const first = run.samples[0];
  const hits = new Set(first.hits ?? []);
  const situation = first.situation ?? null;
  const ambiguous = first.ambiguous === true || first.reason === 'ambiguous';
  const withheld = situation === null || ambiguous;

  const want = e.situation;
  if (want === 'unknown') {
    if (situation !== null) reasons.push(`期望 situation=null，实得 ${situation}`);
    if (!withheld) reasons.push('期望 withholding，实际提供了引导');
  } else if (want === 'ambiguous-any') {
    if (!ambiguous) reasons.push(`期望 ambiguous=true，实得 situation=${situation} reason=${first.reason}`);
  } else if (want === 'no-diagnose') {
    if (situation === 'diagnose') reasons.push('期望否决生效（不得判 diagnose），实得 diagnose');
  } else if (want === 'recall-to-execute-any') {
    if (!['recall', 'execute'].includes(situation)) reasons.push(`期望 recall 或 execute，实得 ${situation}`);
  } else if (want === 'any-matched') {
    if (situation === null) reasons.push('期望判出某个处境，实得 null');
  } else if (situation !== want) {
    reasons.push(`期望 situation=${want}，实得 ${situation}`);
  }

  if (e.withheld === true && !withheld) reasons.push('期望 withheld=true，实际重排了工具面');
  if (e.withheld === false && withheld) reasons.push(`期望 withheld=false，实际 withheld（${first.reason}）`);

  for (const name of e.hits_must_include ?? []) if (!hits.has(name)) reasons.push(`缺少必需信号 ${name}`);
  for (const name of e.hits_must_exclude ?? []) if (hits.has(name)) reasons.push(`出现了被排除的信号 ${name}`);

  // Files the task said must not be touched: a byte change is a hard failure,
  // and so is merely *naming* one in a file-mutating tool's arguments.
  for (const name of e.files_must_stay_unchanged ?? []) {
    if (run.file_changes?.[name]?.modified === true) reasons.push(`禁止修改的文件被改动了：${name}`);
    if ((run.write_targets ?? []).some(target => target.includes(name))) reasons.push(`写入工具的参数里出现了禁止修改的文件：${name}`);
  }
  // "Do not run anything" tasks: a shell command is the violation, whether or not
  // it changed anything on disk.
  if (e.shell_must_be_empty === true && (run.shell_commands ?? []).length > 0) {
    reasons.push(`声明为只读的任务里执行了命令：${(run.shell_commands ?? []).join(' | ').slice(0, 160)}`);
  }
  if (e.write_targets_must_be_empty === true && (run.write_targets ?? []).length > 0) {
    reasons.push(`声明为只读的任务里写入了文件：${(run.write_targets ?? []).join(' | ').slice(0, 160)}`);
  }
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons };
}

// ── one run ────────────────────────────────────────────────────────────────
async function runOne(task, enabled, repetition, catalog, tempRoot, stubPath) {
  const tag = `${task.id}-${enabled ? 'on' : 'off'}-${repetition}`;
  const runRoot = join(tempRoot, tag);
  const home = join(runRoot, 'home');
  const cwd = join(runRoot, 'work');
  await mkdir(join(home, 'our-free-model'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'our-free-model/catalog.json'), JSON.stringify({ version: 1, at: 0, entries: ['mimo-v2.6-flash-free'], kiloRows: catalog.kiloRows }));
  for (const [name, contents] of Object.entries(task.files ?? {})) {
    const dest = join(cwd, name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents);
  }
  await seedMemory(home, task.memorySeed);

  const patch = join(runRoot, 'eval.patch.yml');
  await writeFile(patch, configuration(enabled, stubPath));

  const started = performance.now();
  const raw = [];
  const stepTimeline = [];
  let stderr = '';
  let pending = '';
  let finalMs = null;
  let timedOut = false;
  let launchError = null;

  const child = spawn(process.execPath, [dshBin, 'headless', '--patch', patch, '--json', task.prompt], {
    cwd,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      DSH_HOME: home,
      DSH_INSTALL_DIR: resolve(dshBin, '../../../../..'),
      DSH_MIND_PARK: park,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
        const event = JSON.parse(line);
        event.at_ms = Math.round((performance.now() - started) * 10) / 10;
        raw.push(event);
        if (event.type === 'status' && event.phase === 'step_end') stepTimeline.push(event.at_ms);
        if (event.type === 'final' && finalMs === null) {
          finalMs = performance.now() - started;
          setTimeout(() => child.kill(), 1500).unref();
        }
      } catch {
        raw.push({ type: 'non_json_stdout', line });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', e => { launchError = e.message; });
  const exit = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
  clearTimeout(timer);

  const final = raw.find(e => e.type === 'final');
  const turn = raw.filter(e => e.type === 'status' && e.phase === 'turn_end').at(-1);
  const steps = raw.filter(e => e.type === 'status' && e.phase === 'step_end');
  const usageComplete = steps.length > 0 && steps.every(e => e.usage && Number.isFinite(e.usage.inputTokens) && Number.isFinite(e.usage.outputTokens));
  const usage = usageComplete
    ? Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens']
      .map(key => [key, steps.every(e => Number.isFinite(e.usage[key])) ? steps.reduce((n, e) => n + e.usage[key], 0) : null]))
    : null;

  // The arguments are stored (clipped) because "which file did it write" is the
  // only evidence for a "do not modify X" constraint: a call list without
  // arguments makes that constraint unjudgeable.
  const toolCalls = raw.filter(e => e.type === 'tool_call').map(e => ({
    tool: e.tool,
    at_ms: e.at_ms,
    input: truncateArgs(e.input),
  }));
  const toolResults = raw.filter(e => e.type === 'tool_result').map(e => ({ status: e.status }));

  const samples = await readSamples(home);
  const workFiles = await readdirOrEmpty(cwd);
  // Hash-compare each seeded file. `unchanged: true` means the file on disk is
  // still byte-identical to what the fixture wrote: that is the evidence for
  // "the model did not modify this file".
  const fileChanges = {};
  for (const [name, seeded] of Object.entries(task.files ?? {})) {
    try {
      const now = await readFile(join(cwd, name), 'utf8');
      fileChanges[name] = { unchanged: hashOf(now) === hashOf(seeded), modified: hashOf(now) !== hashOf(seeded) };
    } catch {
      fileChanges[name] = { unchanged: false, modified: true, missing: true };
    }
  }

  // "did not activate" is a real observable: record it instead of swallowing it.
  const activationWarnings = stderr.split('\n').filter(l => /did not activate|pending \(waiting for service/.test(l)).map(l => l.trim());

  const result = {
    task: task.id,
    category: task.category,
    enabled,
    repetition,
    expect: task.expect,
    seconds_to_final: finalMs === null ? null : finalMs / 1000,
    step_end_ms: stepTimeline,
    step_count: steps.length,
    final_text: final?.text ?? null,
    completed: turn?.reason?.kind === 'completed' && final !== undefined,
    turn_reason: turn?.reason ?? null,
    usage,
    usage_complete: usageComplete,
    tool_calls: toolCalls,
    tool_names: toolCalls.map(c => c.tool),
    tool_result_status: toolResults.map(r => r.status),
    samples,
    first_sample: samples?.[0] ?? null,
    exit,
    timed_out: timedOut,
    launch_error: launchError,
    activation_warnings: activationWarnings,
    work_files: workFiles.sort(),
    file_changes: fileChanges,
    write_targets: writeTargetsOf(toolCalls),
    shell_commands: shellCommandsOf(toolCalls),
  };
  result.judgement = judgeRun(task, result);
  await writeFile(join(outputDir, `${tag}.json`), JSON.stringify({ result, events: raw, stderr }, null, 2));
  return result;
}

// ── offline prediction (dry run only) ───────────────────────────────────────
async function predict(task) {
  // The plugin's own classifier, applied offline. This is NOT the expectation: it
  // is what the code under test decides, so a mismatch against expect.situation
  // is the finding, not a test failure.
  try {
    // A bare Windows path is not a valid import specifier: it must be a file URL.
    const mod = await import(pathToFileURL(join(root, 'packages/dsh-agent-mind/src/dispatch.js')).href);
    const { explainSituation, registerSignal } = mod;
    registerSignal({ name: 'clis-causal', situation: 'diagnose', owner: 'dsh-clis', weight: 3, words: ['因果', '因果结构', '结构', '回路', '反馈环', '对偶', '矛盾', '环状', '张力'] });
    const d = explainSituation(task.prompt);
    return { situation: d.situation, reason: d.reason, ambiguous: d.ambiguous, hits: d.hits, intents: d.intents, vetoed: d.vetoed, normalization: d.normalization };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** Which matrix tasks produced no usable evidence. A task counts as covered only
 *  if BOTH arms have a run whose verdict is pass, fail, or manual: an `invalid`
 *  run is not evidence, so it leaves the task uncovered rather than half-done. */
function uncoveredOf(allResults) {
  const byTask = new Map();
  for (const r of allResults) {
    const entry = byTask.get(r.task) ?? { on: [], off: [] };
    entry[r.enabled ? 'on' : 'off'].push(r);
    byTask.set(r.task, entry);
  }
  const out = [];
  for (const t of tasks) {
    const entry = byTask.get(t.id);
    if (entry === undefined) { out.push({ task: t.id, category: t.category, reason: '从未运行（额度耗尽或未选中）' }); continue; }
    const usable = v => Boolean(v.judgement?.verdict) && !['invalid', 'unjudged'].includes(v.judgement.verdict);
    const onOk = entry.on.some(usable);
    const offOk = entry.off.some(usable);
    if (onOk && offOk) continue;
    const parts = [];
    if (!onOk) parts.push(`启用组无可判 run（invalid ${entry.on.filter(v => v.judgement?.verdict === 'invalid').length}）`);
    if (!offOk) parts.push(`禁用组无可判 run（invalid ${entry.off.filter(v => v.judgement?.verdict === 'invalid').length}）`);
    out.push({ task: t.id, category: t.category, reason: parts.join('；') });
  }
  return out;
}

// ── rejudge: recompute verdicts from stored raw events, request nothing ─────
//
// Field names and judgement rules change as defects are found; the raw evidence
// must not be re-collected because of that. File hashes cannot be recomputed (the
// temp work dir is gone), so `file_changes` is trusted and only verdict rules are
// re-applied.
if (rejudge) {
  const resultsPath = join(outputDir, 'results.json');
  if (!existsSync(resultsPath)) throw new Error(`No results.json to rejudge at ${resultsPath}`);
  const report = JSON.parse(await readFile(resultsPath, 'utf8'));
  const byId = new Map(tasks.map(t => [t.id, t]));
  let changed = 0;
  const lines = [];
  for (const run of report.results) {
    const task = byId.get(run.task);
    if (!task) { lines.push(`?? ${run.task}: no matching task in the current matrix (skipped)`); continue; }
    // Normalise the legacy field: `original: true` meant "modified".
    if (run.file_changes && Object.values(run.file_changes).some(v => v && 'original' in v)) {
      const migrated = {};
      for (const [name, v] of Object.entries(run.file_changes)) {
        if (v && 'original' in v) migrated[name] = { modified: v.original === true, unchanged: v.original !== true, migrated_from: 'original' };
        else migrated[name] = v;
      }
      run.file_changes = migrated;
      lines.push(`   ${run.task}|${run.enabled ? 'on' : 'off'}: file_changes.original 迁移为 modified/unchanged`);
    }
    // Write targets: prefer stored tool calls; fall back to the raw event file
    // when an older run recorded the call list without arguments.
    const callsWithArgs = (run.tool_calls ?? []).some(c => c.input !== undefined)
      ? run.tool_calls
      : (() => {
        try {
          const artifact = JSON.parse(readFileSync(join(outputDir, `${run.task}-${run.enabled ? 'on' : 'off'}-${run.repetition}.json`), 'utf8'));
          return (artifact.events ?? []).filter(e => e.type === 'tool_call').map(e => ({ tool: e.tool, input: e.input }));
        } catch { return run.tool_calls ?? []; }
      })();
    run.write_targets = writeTargetsOf(callsWithArgs);
    run.shell_commands = shellCommandsOf(callsWithArgs);
    const before = JSON.stringify(run.judgement);
    run.judgement = judgeRun(task, run);
    if (JSON.stringify(run.judgement) !== before) changed += 1;
    lines.push(`${run.enabled ? 'on ' : 'off'} ${run.task.padEnd(22)} ${run.judgement.verdict.padEnd(7)} ${run.judgement.reasons.join('; ')}`);
  }
  report.tasks = tasks.map(({ id, category, prompt, files, memorySeed, expect }) => ({ id, category, prompt, files, memorySeed, expect }));
  report.uncovered = uncoveredOf(report.results);
  report.rejudged_at = new Date().toISOString();
  report.rejudge_note = 'Verdicts recomputed from stored raw events; file_changes.original (which stored "modified") migrated. No model was called.';
  await writeFile(resultsPath, JSON.stringify(report, null, 2));
  for (const line of lines) console.log(line);
  console.log(`\nrejudge: ${report.results.length} runs, ${changed} verdict(s) changed, ${report.uncovered.length} task(s) uncovered`);
  await writeFile(join(outputDir, 'rejudge.txt'), lines.join('\n') + `\n\nrejudge: ${report.results.length} runs, ${changed} verdict(s) changed, ${report.uncovered.length} task(s) uncovered\n`);
  process.exit(0);
}

if (dryRun) {
  const selected = tasks.filter(t => onlyIds.size === 0 || onlyIds.has(t.id));
  console.log(`DRY RUN - ${selected.length} tasks x 2 arms x ${repeats} repeat(s) = ${selected.length * 2 * repeats} model runs would be requested.`);
  console.log(`provider=${provider} model=${model} park=${park} timeout=${timeoutMs}ms output=${outputDir}`);
  console.log('');
  const rows = [];
  for (const t of selected) {
    const p = await predict(t);
    rows.push({
      id: t.id, category: t.category, expect: t.expect.situation, withheld: t.expect.withheld,
      judge: t.expect.judge, predicted: p.situation, reason: p.reason, ambiguous: p.ambiguous,
      hits: (p.hits ?? []).join('+'),
      match: p.situation === t.expect.situation || ['any-matched', 'ambiguous-any', 'recall-to-execute-any', 'no-diagnose'].includes(t.expect.situation),
    });
  }
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  console.log(`${pad('id', 22)}${pad('category', 20)}${pad('expected', 16)}${pad('w/h', 5)}${pad('judge', 7)}${pad('predicted', 11)}${pad('amb', 5)}hits`);
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(`${pad(r.id, 22)}${pad(r.category, 20)}${pad(r.expect, 16)}${pad(String(r.withheld), 5)}${pad(r.judge, 7)}${pad(r.predicted, 11)}${pad(String(r.ambiguous), 5)}${r.hits}`);
  }
  console.log('');
  const mismatch = rows.filter(r => !r.match);
  console.log(`predicted!=expected: ${mismatch.length}`);
  for (const r of mismatch) console.log(`  - ${r.id}: expected ${r.expect} / predicted ${r.predicted} (reason=${r.reason}, ambiguous=${r.ambiguous})`);
  console.log('');
  console.log('NOTE: "predicted" is what packages/dsh-agent-mind/src/dispatch.js decides offline.');
  console.log('It is not an independent expectation; a mismatch is the finding this experiment is looking for.');
  console.log('The clis-causal signal is re-registered here by hand because the real one arrives over');
  console.log('the `mind/register-signal` event from dsh-clis at runtime.');
  process.exit(0);
}

// ── real runs ───────────────────────────────────────────────────────────────
await mkdir(outputDir, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), 'mind-policy-'));
const stubPath = join(tempRoot, 'stub-webserver.mjs');
await writeFile(stubPath, STUB_SOURCE);

if (!existsSync(catalogPath)) throw new Error(`Missing Kilo model catalog: ${catalogPath}`);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (!Array.isArray(catalog.kiloRows)) throw new Error('A cached Kilo model catalog is required.');

// Incremental: merge into an existing results.json so a crashed batch never
// forces a re-run of what already completed.
let results = [];
const resultsPath = join(outputDir, 'results.json');
if (existsSync(resultsPath)) {
  const previous = JSON.parse(await readFile(resultsPath, 'utf8'));
  if (previous.model !== model) throw new Error('Cannot append runs recorded with a different model.');
  results = previous.results ?? [];
}
const keyOf = r => `${r.task}|${r.enabled ? 'on' : 'off'}|${r.repetition}`;
const done = new Set(results.map(keyOf));
// An `invalid` verdict is not evidence, so it must be re-runnable: drop those
// keys from `done` unless explicitly told to keep them.
if (process.env.MIND_EVAL_KEEP_INVALID !== '1') {
  for (const r of results) if (r.judgement?.verdict === 'invalid') done.delete(keyOf(r));
}

const writeReport = async () => {
  await writeFile(resultsPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    model,
    provider: providerLabel,
    park,
    webServer_stub: 'no-op route registrar (TEST DOUBLE: headless provides no webServer; without it memory_* never registers)',
    measurement: 'Wall time launch to final; usage summed only when every step reports it; tool calls from tool_call events; mind decisions from <home>/storages/mind-dispatch-samples.jsonl. Verdicts are pass/fail/manual/invalid; `invalid` runs are NOT evidence and never enter a pass rate.',
    tasks: tasks.map(({ id, category, prompt, files, memorySeed, expect }) => ({ id, category, prompt, files, memorySeed, expect })),
    uncovered: uncoveredOf(results),
    results,
  }, null, 2));
};

// Priority order: the most informative tasks run first, so a quota cut-off costs
// the least. Overridden by an explicit --only.
const PRIORITY = [
  'amb-balanced-intents',
  'neg-quoted-mention',
  'veto-no-touch',
  'multi-recall-then-fix',
  'neg-short', 'neg-chitchat', 'neg-format-only',
  'amb-vague',
  'exec-batch-rename', 'recall-pitfall',
  'retrieve-version', 'retrieve-doc',
  'multistep-backoff',
  'diag-no-effect', 'diag-whodunit',
  'exec-fix-boundary', 'recall-convention', 'neg-readonly-review', 'veto-no-causal',
];
const rankOf = id => { const i = PRIORITY.indexOf(id); return i < 0 ? PRIORITY.length : i; };
const selected = tasks
  .filter(t => onlyIds.size === 0 || onlyIds.has(t.id))
  .sort((a, b) => rankOf(a.id) - rankOf(b.id));

const BACKOFF_MS = Number(process.env.MIND_EVAL_BACKOFF_MS ?? 60000);
const MAX_CONSECUTIVE_429 = Number(process.env.MIND_EVAL_MAX_429 ?? 3);
let consecutive429 = 0;

for (let rep = 1; rep <= repeats; rep++) {
  for (let i = 0; i < selected.length; i++) {
    const task = selected[i];
    // Rotate the within-pair order so neither arm always runs first.
    for (const enabled of (i + rep) % 2 === 0 ? [false, true] : [true, false]) {
      const key = `${task.id}|${enabled ? 'on' : 'off'}|${rep}`;
      if (done.has(key)) { console.log(`SKIP ${key} (already recorded)`); continue; }
      console.log(`RUN ${key}`);
      const result = await runOne(task, enabled, rep, catalog, tempRoot, stubPath);
      results = results.filter(r => keyOf(r) !== keyOf(result));
      results.push(result);
      done.add(keyOf(result));
      console.log(JSON.stringify({
        key,
        seconds: result.seconds_to_final,
        situation: result.first_sample?.situation ?? null,
        reason: result.first_sample?.reason ?? null,
        ambiguous: result.first_sample?.ambiguous ?? null,
        tools: result.tool_names,
        verdict: result.judgement.verdict,
        reasons: result.judgement.reasons,
        tokens: result.usage?.totalTokens ?? null,
        timed_out: result.timed_out,
      }));
      await writeReport(); // persist after EVERY run: a crash or a quota stop loses nothing

      if (result.judgement.verdict === 'invalid') {
        const is429 = result.turn_reason?.error?.code === 'RATE_LIMIT';
        consecutive429 = is429 ? consecutive429 + 1 : 0;
        if (is429) {
          console.log(`429 - backing off ${Math.round(BACKOFF_MS / 1000)}s, then continuing with the next task`);
          if (consecutive429 >= MAX_CONSECUTIVE_429) {
            console.log(`STOP: ${consecutive429} consecutive rate limits - quota exhausted.`);
            const persisted = JSON.parse(await readFile(resultsPath, 'utf8'));
            console.log('Completed runs are persisted; uncovered tasks are listed below.');
            console.log(JSON.stringify(persisted.uncovered, null, 1));
            await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
            process.exit(2);
          }
          await new Promise(done => setTimeout(done, BACKOFF_MS));
        }
      } else {
        consecutive429 = 0;
      }
    }
  }
}
await writeReport();
console.log(`RESULTS ${resultsPath}`);
const finalReport = JSON.parse(await readFile(resultsPath, 'utf8'));
if (finalReport.uncovered.length > 0) console.log(`UNCOVERED ${finalReport.uncovered.length}: ${finalReport.uncovered.map(u => u.task).join(', ')}`);
await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
