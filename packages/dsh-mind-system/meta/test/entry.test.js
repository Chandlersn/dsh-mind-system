/**
 * 入口 `apply()` 测试。
 *
 * ## 为什么这个文件此前不存在
 *
 * 上一轮审查的 29 个用例全在 `tools.js` 与 `health.js` 里，
 * **入口零覆盖** —— 而插件唯一一次"完全不装载"的事故（`inject` 写空，
 * 宿主报 `1 entry did not activate`）恰好发生在入口。
 *
 * "29/29 全绿"只证明两个内层模块没坏，不证明插件能装进宿主。
 * 这个文件补的就是那条断言：**工具真的被注册了**。
 *
 * ## 不用真 Cordis
 *
 * 用假 ctx（记下 `register` 收到什么）即可验证入口的行为契约：
 * 注册了没有、注册的名字对不对、失败时是降级还是抛错、探针有没有同步。
 * 真正的 Cordis 装载语义由宿主负责，不该由单测重复证明。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name } from '../index.js';
import {
  healthProbe,
  bindContext,
  recordRegistration,
  recordExecution,
  PROBE_CODES,
} from '../src/health.js';

/** 造一个假 ctx：记录 `tools.register` 收到的定义，并收集日志。 */
function fakeCtx(services = {}) {
  const registered = [];
  const logs = [];
  return {
    registered,
    logs,
    get: (key) => services[key],
    logger: () => ({ error: (msg) => logs.push(msg) }),
    tools: { register: (definition) => registered.push(definition) },
  };
}

/** 造一个满足 `defineTool` 契约的最简实现：原样返回定义。 */
function passthroughDefineTool(definition) {
  return definition;
}

/**
 * 把探针恢复到"还没 apply"的初值，避免模块级状态在用例间串味。
 *
 * 三个模块级状态都要清：ctx、装载结果、**执行结果**。
 * 漏掉执行结果的话，前一个用例的"执行成功"会让后一个用例的探针报 ok。
 */
function reset() {
  bindContext(undefined);
  recordRegistration('not-applied');
  recordExecution('not-observed');
}

test('入口导出名与 patch id 一致（不一致插件永不装载）', () => {
  // cordis.patch.yml 里的 id 必须与 name 一致；这里守 name 不被随手改。
  assert.equal(name, 'meta-framework');
});

test('inject 必须声明 tools（漏了插件完全不激活，曾真实发生）', () => {
  // 事故原样：写成 [] 时宿主报 `cannot get property "tools" without inject`，
  // 插件因此没能激活，只留一句 "1 entry did not activate"。
  assert.ok(Array.isArray(inject), 'inject 必须是服务名数组');
  assert.ok(inject.includes('tools'), 'tools 是硬依赖，必须声明');
  // CLIS 三服务刻意不在 inject 里：它们走 ctx.get() 运行时探测，
  // 声明成 inject 会让"没装 dsh-clis"时本插件也不装载。
  assert.ok(!inject.some((s) => s.startsWith('clis.')), 'CLIS 服务不该进 inject');
});

test('正常装载：工具真的注册到 ctx.tools，且名字是 meta_reframe', () => {
  reset();
  const ctx = fakeCtx();

  apply(ctx, { loadDefineTool: () => passthroughDefineTool });

  assert.equal(ctx.registered.length, 1, '必须恰好注册一个工具');
  assert.equal(ctx.registered[0].name, 'meta_reframe', '工具名是 agent 侧的契约');
  assert.equal(typeof ctx.registered[0].execute, 'function', '必须可执行');
  assert.deepEqual(ctx.logs, [], '成功路径不该写错误日志');
});

test('注册成功后探针必须报 ok（探针的事实来源就是这次成功）', () => {
  reset();
  // 分类器必须**形状正确**（带 classify 方法）—— 库的 pick() 就是这么判的，
  // 探针现在用同一把尺（缺陷 1）。用 `{}` 当分类器会被判为"不可用"。
  const ctx = fakeCtx({ 'clis.causalClassifier': { async classify() { return {}; } } });

  apply(ctx, { loadDefineTool: () => passthroughDefineTool });
  const r = healthProbe.probe();

  assert.equal(r.status, 'ok', '装载成功 + CLIS 可用 → ok');
  assert.ok(
    r.findings.some((f) => f.code === PROBE_CODES.ok),
    `应报 ok 代号，实际：${JSON.stringify(r.findings.map((f) => f.code))}`,
  );
});

test('定位不到宿主根：降级不抛错、记一条带原因的日志、工具不注册', () => {
  reset();
  const ctx = fakeCtx();

  // 造出 resolveDshRoot() 的那条显式错误
  assert.doesNotThrow(() => {
    apply(ctx, {
      loadDefineTool: () => {
        throw new Error('无法定位 DSH 安装目录（未在任一候选路径下找到 …）');
      },
    });
  }, '定位失败绝不能让插件不激活 —— 那是宿主日志里最难查的形态');

  assert.equal(ctx.registered.length, 0, '失败时不该注册半个工具');
  assert.equal(ctx.logs.length, 1, '必须留下一条可查的日志');
  assert.ok(ctx.logs[0].includes('无法定位'), `日志要带真实原因，实际：${ctx.logs[0]}`);
});

test('宿主根在但 dsh-tools 加载抛错：归类为 tools-unavailable（不是宿主根缺失）', () => {
  reset();
  const ctx = fakeCtx();

  apply(ctx, {
    loadDefineTool: () => {
      throw new Error("Cannot find module '@deepseek-ai/dsh-tools'");
    },
  });

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);

  // 这两种失败的修法完全不同，混成一句"加载失败"等于把排查成本推给使用者。
  assert.ok(codes.includes(PROBE_CODES.toolsUnavailable), `应报 tools-unavailable，实际：${codes}`);
  assert.ok(!codes.includes(PROBE_CODES.hostRootMissing), '不能误报成定位失败');
  assert.equal(r.status, 'failing', '工具没注册必须拉红灯');
});

test('失败原因必须进探针文案（只报代号等于让人重新查一遍）', () => {
  reset();
  const ctx = fakeCtx();
  const reason = "Cannot find module '@deepseek-ai/dsh-tools'";

  apply(ctx, {
    loadDefineTool: () => {
      throw new Error(reason);
    },
  });

  const finding = healthProbe.probe().findings.find((f) => f.code === PROBE_CODES.toolsUnavailable);
  assert.ok(finding.message.includes(reason), '探针文案要带上真实异常，别只说"加载失败"');
});

test('没跑到 apply 时探针不能猜宿主状态（说"未跑到 apply"，不是"缺文件"）', () => {
  reset();

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);

  // 上一版在这里用 existsSync 猜，会给出一个可能错的结论。
  // 现在的契约是：没跑到 apply 就如实说没跑到。
  assert.ok(codes.includes(PROBE_CODES.notLoaded), `应报 not-loaded，实际：${codes}`);
  assert.ok(!codes.includes(PROBE_CODES.toolsUnavailable), '没装载时不能断言 dsh-tools 不可用');
  assert.equal(r.status, 'failing', '工具都没注册，不能报健康');
});

// ── 缺陷 1：探针必须能看出"注册成功但工具是坏的" ──────────────────
//
// 缺陷 1 的要害：探针此前的唯一依据是 `recordRegistration('ok')`，
// 而那行代码紧跟在 `ctx.tools.register(tool)` 之后 ——
// 它证明的只是"注册了"，**不证明"能用"**。
//
// 复现：把库换成"每个调用都抛"，工具注册完全成功，
// 而探针照样报 `status: ok` —— 给一个 100% 不可用的工具发绿牌。

test('缺陷 1：工具执行成功后探针必须记录"执行成功"（唯一能证明能用的信号）', async () => {
  reset();
  // 分类器形状要对（带 classify 方法）—— 否则探针会报 classifier-missing，
  // 那条 info 会让 findings 非空，从而没有 ok 代号可断言。
  const ctx = fakeCtx({
    'clis.causalClassifier': {
      async classify() {
        return { causal_type: 'cyclic', confidence: 0.9, rationale: 'test', evidence: [] };
      },
    },
  });

  apply(ctx, { loadDefineTool: () => passthroughDefineTool });
  assert.equal(ctx.registered.length, 1, '先确认工具注册成功');

  // 真的执行一次。trace 落盘指向临时目录 —— 不能写进仓库的 data/。
  const traceDir = mkdtempSync(join(tmpdir(), 'dsh-meta-entry-'));
  const previousTraceDir = process.env.META_FRAMEWORK_TRACE_DIR;
  process.env.META_FRAMEWORK_TRACE_DIR = traceDir;
  try {
    const out = await ctx.registered[0].execute({ description: '为什么改了配置没生效' });
    assert.ok(out && typeof out === 'object', '执行应返回结果对象');
  } finally {
    if (previousTraceDir === undefined) {
      delete process.env.META_FRAMEWORK_TRACE_DIR;
    } else {
      process.env.META_FRAMEWORK_TRACE_DIR = previousTraceDir;
    }
    rmSync(traceDir, { recursive: true, force: true });
  }

  const r = healthProbe.probe();
  const ok = r.findings.find((f) => f.code === PROBE_CODES.ok);
  assert.ok(ok, `执行成功后应报 ok，实际：${JSON.stringify(r.findings.map((f) => f.code))}`);
  assert.ok(ok.message.includes('执行成功'), `文案要说明执行成功，实际：${ok.message}`);
});

test('缺陷 1：工具执行抛错 → 探针必须报 execution-failed（不能报 ok）', async () => {
  reset();
  const ctx = fakeCtx();

  // 缺陷 1 的复现形态：**注册完全成功，但执行体一调用就抛**
  // （框架库版本不匹配 / 依赖缺失 / 内部异常）。
  // 覆盖的是执行体本身 —— 真实的失败形态就是执行体抛错。
  apply(ctx, {
    loadDefineTool: () => passthroughDefineTool,
    reframe: async () => {
      throw new Error('boom: 库内部炸了');
    },
  });
  assert.equal(ctx.registered.length, 1, '工具照样注册成功（这正是缺陷的形态）');

  // 入口的 execute() 包装器会捕获异常并返回错误对象（不向上冒泡）
  const out = await ctx.registered[0].execute({ description: '测试' });
  assert.ok(out.error, '失败时入口应返回错误对象而不是抛出去');
  assert.ok(out.reason.includes('boom'), '错误原因要带出来');

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);

  assert.ok(
    codes.includes(PROBE_CODES.executionFailed),
    `执行失败必须报 execution-failed，实际：${codes}`,
  );
  assert.ok(!codes.includes(PROBE_CODES.ok), '执行失败时不能同时报 ok');
  assert.equal(r.status, 'failing', '工具坏了必须拉红灯');
});

test('缺陷 1：执行失败后探针要带上真实原因（只报代号等于让人重查一遍）', async () => {
  reset();
  const ctx = fakeCtx();
  apply(ctx, {
    loadDefineTool: () => passthroughDefineTool,
    reframe: async () => {
      throw new Error('boom: 库内部炸了');
    },
  });

  await ctx.registered[0].execute({ description: '测试' });

  const finding = healthProbe.probe().findings.find((f) => f.code === PROBE_CODES.executionFailed);
  assert.ok(finding, '必须报 execution-failed');
  assert.ok(
    finding.message.includes('boom'),
    `失败原因不能丢（要能据此排查），实际：${finding.message}`,
  );
});


