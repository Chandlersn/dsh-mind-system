/**
 * 心智索引测试。
 *
 * ## 这个文件要守住什么
 *
 * 本插件的全部产出是**一段文本 + 一次注册**。没有可执行逻辑，
 * 所以最容易出的不是崩溃，而是**说反话**：
 *
 * - 分节注册了，但 order 排到了工具说明后面（读到时机不对）
 * - 正文自称"判断顺序"，实际只是工具清单（那还不如不写）
 * - 探针恒报 ok，"注册失败"永远看不见
 *
 * 所以这里的断言分两类：**行为契约**（注册了什么、失败时怎样）
 * 与**内容契约**（正文必须真的在讲判断，而不是在列工具）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name, healthProbe, PROBE_CODES } from '../index.js';
import { SECTION_NAME, SECTION_ORDER, SECTION_TEXT, registerMindSection } from '../src/mind.js';

/** 造一个假 ctx：记录 section 注册与日志。 */
function fakeCtx({ withSystemPrompt = true } = {}) {
  const sections = [];
  const logs = { info: [], error: [] };
  const ctx = {
    sections,
    logs,
    logger: () => ({
      info: (m) => logs.info.push(m),
      error: (m) => logs.error.push(m),
    }),
  };
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      section: (s) => {
        sections.push(s);
        return () => {};
      },
    };
  }
  return ctx;
}

test('入口名与 patch id 一致（不一致插件永不装载）', () => {
  assert.equal(name, 'mind');
});

test('inject 必须声明 systemPrompt 与 tools（访问属性前的前置条件）', () => {
  // Cordis 规则：ctx.systemPrompt 走 Proxy get，未在 inject 声明就抛错，
  // 整个插件不激活。这条守住那个事故形态不再发生。
  // tools 是 mind_signals 工具的注册通道（2026-11-02 新增）——
  // 同理必须声明，否则 ctx.tools.register 不可用。
  assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools']);
});

test('装载后确实注册了一个分节，名字与 order 都正确', () => {
  const ctx = fakeCtx();
  apply(ctx);

  assert.equal(ctx.sections.length, 1, '必须恰好注册一个分节');
  assert.equal(ctx.sections[0].name, SECTION_NAME);
  assert.equal(ctx.sections[0].order, SECTION_ORDER);
  assert.equal(typeof ctx.sections[0].text, 'string');
});

test('order 落在宿主的 TOOL_GOAL 与 TOOL_WORKFLOW 之间（只绑宿主常量）', () => {
  // ⚠️ 2026-11-03 修：旧断言写死了 `2450`（"clis 的因果段"）。
  // 但 2450 **不是宿主常量** —— 宿主 `SECTION_ORDERS` 里只有
  // TOOL_GOAL=2400 / TOOL_WORKFLOW=2600（dsh-system-prompt/lib/index.js:10-40），
  // 2450 是 dsh-clis 自己的私有值（clis/index.js 里的 section order）。
  //
  // 把断言绑在**另一个插件的私有数字**上，等于让本包的测试依赖别人不改序：
  // clis 一旦把 2450 调到 2399，这条断言就变成"必须在 2399 之前"，
  // 而 2410 会红 —— 失败原因是别人的改动，不是本包退化了。
  //
  // 现在只绑宿主常量。与 clis 的相对位置是**部署事实**，不是契约，
  // 应该由集成测试在真实装配里观察，而不是在单测里写死。
  const HOST_TOOL_GOAL = 2400;
  const HOST_TOOL_WORKFLOW = 2600;
  assert.ok(SECTION_ORDER > HOST_TOOL_GOAL, `要在 TOOL_GOAL(${HOST_TOOL_GOAL}) 之后，实际 ${SECTION_ORDER}`);
  assert.ok(SECTION_ORDER < HOST_TOOL_WORKFLOW, `要在 TOOL_WORKFLOW(${HOST_TOOL_WORKFLOW}) 之前，实际 ${SECTION_ORDER}`);
});

test('正文在讲判断顺序，不是在列工具清单', () => {
  // 这是本插件存在的全部理由。如果它变成"有哪些工具"的清单，
  // 那和每个插件自己打广告没有区别 —— 反例都写了，这里必须钉住。
  assert.ok(SECTION_TEXT.includes('判断顺序'), '要明说这是判断顺序');
  assert.ok(SECTION_TEXT.includes('先'), '要有先后关系');
  assert.ok(SECTION_TEXT.includes('反例') || SECTION_TEXT.includes('不要'), '必须给出反例/禁用情形');
  // 不能通篇都是工具名：工具名出现的次数要远少于判断性表述
  const toolMentions = (SECTION_TEXT.match(/`[a-z_]+`/g) ?? []).length;
  assert.ok(toolMentions <= 6, `工具名不该扎堆（像广告），实际 ${toolMentions} 处`);
});

test('正文必须包含"什么时候别用"（否则会诱使到处套用）', () => {
  // 只说"什么时候该用"的索引，会让 agent 把所有问题都归到最像的那一类。
  // 本机实测过：拿因果分析做一次性信息整理，输出只是把描述抄进模板。
  assert.ok(
    SECTION_TEXT.includes('空转') || SECTION_TEXT.includes('别调'),
    '要明确写出"调了也没用"的情形',
  );
});

test('道层仲裁句在场：道「绿灯不携带信息」经本分节被消费，不是装饰品', () => {
  // "蒸馏终点必须改变行动"的实例验证：dao/ 萃出后若无消费者，道层退化成档案。
  // 这里钉住消费面 —— 来自回路自身的绿灯，先问"没人检查它会不会不同"，
  // 同形即不得当证据用。
  assert.ok(SECTION_TEXT.includes('伪造不了'), '冲突仲裁必须给出可执行的问句');
  assert.ok(
    SECTION_TEXT.includes('没人检查') || SECTION_TEXT.includes('没人报错'),
    '要给出"何时绿色不算证据"的判据',
  );
  assert.ok(SECTION_TEXT.includes('线索') || SECTION_TEXT.includes('曝光'),
    '要说清自产信号不是禁用而是只作线索（否则会被整段丢弃）');
  // 仲裁句排在四步之后：它的角色是冲突时的上位裁断，不是第五类任务
  const idx = SECTION_TEXT.indexOf('伪造不了');
  assert.ok(idx > SECTION_TEXT.indexOf('## 4.'), '仲裁句须在四步之后收束');
});

test('systemPrompt 缺失时不抛错、不注册，但记 error 日志', () => {
  const ctx = fakeCtx({ withSystemPrompt: false });

  // 附加能力缺了要降级，不能拖垮核心 —— 这里"核心"是插件装载本身。
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(ctx.sections.length, 0, '没有服务就不该注册');
  assert.equal(ctx.logs.error.length, 1, '唯一职责没履行，必须留痕');
  assert.ok(ctx.logs.error[0].includes('未注册'), `日志要说清后果，实际：${ctx.logs.error[0]}`);
});

test('注册成功后探针报 ok（探针的事实来源就是这次成功）', () => {
  const ctx = fakeCtx();
  apply(ctx);

  const r = healthProbe.probe();
  assert.equal(r.status, 'ok');
  assert.equal(r.findings[0].code, PROBE_CODES.ok);
});

test('注册失败时探针必须报错（不能与成功同形）', () => {
  const ctx = fakeCtx({ withSystemPrompt: false });
  apply(ctx);

  const r = healthProbe.probe();
  assert.equal(r.status, 'failing', '分节没注册却报 ok，等于探针说反话');
  assert.ok(r.findings.some((f) => f.code === PROBE_CODES.sectionMissing));
});

test('探针零参数、只读、永不抛错', async () => {
  // 监督层按 exported.probe() 零参调用；探针自己抛错会让监督层一起挂。
  assert.doesNotThrow(() => healthProbe.probe());
  assert.equal(typeof healthProbe.probe, 'function');

  // ⚠️ 2026-11-03 修：旧断言是"连调两次 JSON 逐字相同"，但它读的是
  // **全局可变文件**（`$DSH_HOME/storages/mind-dispatch-samples.jsonl`）。
  // 只要期间有任何写入（包括同一个测试进程里别的用例），两次读数就不同 ——
  // 实测被并发采样的另一条用例弄红。那是**用例不稳**，不是探针有问题。
  //
  // 而且更糟：这条用例在**读真实用户数据**（那次读到 774 条真实采样）。
  // 测试不该碰用户的数据文件。这里改为隔离的 DSH_HOME。
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'mind-probe-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    mkdirSync(join(home, 'storages'), { recursive: true });
    writeFileSync(join(home, 'storages', 'mind-dispatch-samples.jsonl'), '');
    const a = JSON.stringify(healthProbe.probe());
    const b = JSON.stringify(healthProbe.probe());
    assert.equal(a, b, '同一状态下连调两次必须一致（探针不产生副作用）');

    // 正断言：**该出现的出现了** —— 只证"没抛错"不携带信息。
    const probe = healthProbe.probe();
    assert.equal(probe.plugin, 'dsh-agent-mind', '探针应标识插件名');
    assert.ok(Array.isArray(probe.findings) && probe.findings.length > 0, 'findings 非空');
    assert.ok(
      probe.findings.every((f) => typeof f.code === 'string' && f.code.startsWith('mind.')),
      '所有代号都要带 mind. 前缀（监督面按代号检索）',
    );
    // ⚠️ 空采样文件时**不该**有 mind.trend：没有样本就没有读数，
    // 编一个 0% 出来是伪造数据（见 index.js 里"没有可测的样本是事实"）。
    // 这条断言钉住那个方向 —— 空文件时宁可少一条读数，也不要假读数。
    assert.ok(
      !probe.findings.some((f) => f.code === 'mind.trend'),
      '空采样文件不得报 mind.trend（无样本时不编数字）',
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('正文关掉插值（常驻文本不该被变量替换）', () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx.sections[0].interpolate, false, '意外的 {{ }} 替换会让判断变形');
});

test('registerMindSection 在无服务时返回 undefined（可被单独调用）', () => {
  const noService = {};
  assert.equal(registerMindSection(noService), undefined);
  const withService = fakeCtx();
  assert.equal(typeof registerMindSection(withService), 'function');
});
