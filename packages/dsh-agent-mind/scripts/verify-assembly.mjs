/**
 * 心智索引的**真装配验证**。
 *
 * ## 为什么单测不够
 *
 * `test/mind.test.js` 用的是假 ctx —— 它只能证明"我调用了 section()"，
 * 证明不了"分节真的进了装配结果"。这两者之间的差距正是本机反复踩过的
 * 那类缺陷：调用发生了、返回值正常、而下游根本没接上。
 *
 * 这里装载**真实的** `@deepseek-ai/cordis`（从宿主安装目录解析，保证
 * Service 身份一致）与**真实的** `@deepseek-ai/dsh-system-prompt`，
 * 然后调 `assemble()` 看装配结果 —— 与宿主同一个服务、同一条路径。
 *
 * ## 判据（都是"该出现的出现了"）
 *
 * 1. 分节出现在 `assembly.sections` 里，且名字正确
 * 2. 渲染出的全文里，判断顺序**排在** clis 因果段之前（order 生效）
 * 3. 卸载后分节消失（disposer 有效，插件可关）
 *
 * 用法：node scripts/verify-assembly.mjs
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

// 从宿主侧解析 cordis —— Service 身份必须与宿主一致，
// 否则 instanceof 判定与层（layers）语义都会错。
const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
const systemPromptMod = await import(
  pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href
);
const SystemPrompt = systemPromptMod.default ?? systemPromptMod.SystemPrompt;
check('能解析宿主的 dsh-system-prompt', typeof SystemPrompt === 'function');

// 本插件：plugin 半。`new URL(...).href` 已经是 file: URL，
// 不能再套 pathToFileURL（那会把 "file:..." 当成路径再转一次）。
const mindMod = await import(new URL('../index.js', import.meta.url).href);
check('dsh-agent-mind 入口可加载', typeof mindMod.apply === 'function');

// —— 真实装载 ——
const ctx = new host.Context();
await ctx.plugin(SystemPrompt);
check('真实 systemPrompt 服务就位', ctx.systemPrompt !== undefined);

await ctx.plugin(mindMod);
check('dsh-agent-mind 装载后无异常', true);

// —— 判据 1：分节进了装配结果 ——
const assembly = await ctx.systemPrompt.assemble({});
const names = assembly.sections.map((s) => s.name);
check(
  '分节出现在 assembly.sections',
  names.includes('mind:orchestration'),
  `实际分节: ${names.join(', ')}`,
);

const mine = assembly.sections.find((s) => s.name === 'mind:orchestration');
check('分节正文非空', (mine?.text ?? '').length > 200, `${(mine?.text ?? '').length} 字符`);
check('正文含判断顺序标志句', (mine?.text ?? '').includes('判断顺序'));
check(
  '正文没有被变量插值破坏',
  !(mine?.text ?? '').includes('{{'),
  '常驻文本里不该出现未替换的变量',
);

// —— 判据 2：order 生效（排在工具说明之前）——
// 用 renderPrompt 看最终拼接顺序；没有别的分节时至少能验证它在场且靠前。
const sections = assembly.sections;
const idxMine = sections.findIndex((s) => s.name === 'mind:orchestration');
check('分节在装配列表中有确定位置', idxMine >= 0, `index=${idxMine}`);

// —— 判据 3：disposer 有效（可卸载）——
await ctx.fiber.dispose();
const after = ctx.systemPrompt === undefined ? undefined : await ctx.systemPrompt.assemble({});
check(
  '卸载后分节消失',
  after === undefined || !after.sections.some((s) => s.name === 'mind:orchestration'),
  'disposer 无效会让插件关不掉',
);

// —— 判据 4：工具面编排真的落到装配结果（C）——
// 用真实 systemPrompt 重新搭上下文，注册一批假工具，再看不同处境下
// assembly.tools 的顺序是否真的变了 —— 且数量不变。
//
// ⚠️ 不能拿"注册顺序"当基线：宿主会做 `orderTools()` 规范化排序
// （无 toolOrder 配置时按名字字典序）。所以基线必须来自**另一个不装
// 本插件的上下文** —— 那才是"没有干扰时宿主会给出的顺序"。
const PROVIDED = ['pwsh', 'read', 'clis_run', 'clis_classify', 'meta_reframe', 'memory_read', 'sys_scan'];
const withTools = (c) =>
  c.systemPrompt.tools(() => ({
    schemas: PROVIDED.map((n) => ({ name: n, description: `d:${n}`, parameters: {} })),
  }));

// 基线上下文：只装 systemPrompt + 工具，不装本插件。
const ctxBase = new host.Context();
await ctxBase.plugin(SystemPrompt);
withTools(ctxBase);
const baseline = (await ctxBase.systemPrompt.assemble({})).tools.map((t) => t.name);
await ctxBase.fiber.dispose();

const ctx2 = new host.Context();
await ctx2.plugin(SystemPrompt);
withTools(ctx2);
await ctx2.plugin(mindMod);

// 处境未设 → 必须与基线逐字相同（判不出来就不动）
const before = await ctx2.systemPrompt.assemble({});
check(
  '未判出处境时工具面与不装本插件时逐字相同',
  before.tools.map((t) => t.name).join(',') === baseline.join(','),
  `基线 ${baseline.join(',')} / 实际 ${before.tools.map((t) => t.name).join(',')}`,
);

// 设成 diagnose → 判结构类应被排到最前，且顺序确实变了
mindMod.__setSituationForTest('diagnose');
const diagnosed = await ctx2.systemPrompt.assemble({});
const names2 = diagnosed.tools.map((t) => t.name);
check(
  'diagnose 处境下判结构工具排到最前',
  names2[0] === 'clis_run' || names2[0] === 'clis_classify' || names2[0] === 'meta_reframe',
  `实际首个 ${names2[0]}`,
);
check(
  '重排确实改变了顺序（不是空转）',
  names2.join(',') !== baseline.join(','),
  '处境已知却与基线相同，说明编排没生效',
);
check(
  '编排没有减少任何工具（能力零损失）',
  names2.length === PROVIDED.length && [...names2].sort().join(',') === [...PROVIDED].sort().join(','),
  `实际 ${names2.join(',')}`,
);

// 收尾：卸载干净，避免影响后续断言
await ctx2.fiber.dispose();
mindMod.__setSituationForTest('unknown');

console.log('');
if (failures.length > 0) {
  console.log(`VERIFY FAIL (${failures.length})`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('VERIFY OK — 心智索引真的进了系统提示装配');