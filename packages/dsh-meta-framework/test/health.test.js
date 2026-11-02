/**
 * 健康探针测试。
 *
 * ## 最要紧的一条约束：探针收不到 ctx
 *
 * `dsh-clis` 的 `wrapExportedProbe` 调的是 `exported.probe()` —— **零参数**。
 * 所以探针必须从模块级变量（`bindContext` 设置）拿上下文，不能指望参数。
 *
 * 上一版的 bug 正是这个：`probe(ctx)` 写成有参，真宿主里 ctx 恒为
 * undefined，于是在每台装了 CLIS 的机器上恒误报 `classifier-missing`，
 * 而 `ok` 分支永不可达。这里的测试就是守住"不靠参数"这一条。
 *
 * ## 第二条：探针不推断，只读实测结果
 *
 * 上一版还用 `existsSync` 判 dsh-tools 文件存在与否来推断"工具会不会注册"。
 * 实测过两头都能错（文件在但 require 抛错 → 报 ok）；现在结论只来自
 * `recordRegistration()`（由真正跑过加载的 `apply()` 填写）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { healthProbe, PROBE_CODES, bindContext, recordRegistration } from '../src/health.js';

/** 造一个假的 ctx：`get(name)` 按表返回。 */
function fakeCtx(services = {}) {
  return { get: (name) => services[name] };
}

/**
 * 每个用例前恢复到一个已知状态。
 *
 * 两个模块级状态都要清：
 * - `bindContext` 记的 ctx
 * - `recordRegistration` 记的**实测装载结果**（探针唯一的事实来源）
 *
 * 不清的话前一个用例的"装载成功"会让后一个用例的探针报 ok ——
 * 那会造出难查的假失败。
 */
function reset(stage = 'ok') {
  bindContext(undefined);
  recordRegistration(stage);
}

test('探针以对象形态导出（监督层按 ns.healthProbe.probe 发现）', () => {
  assert.equal(typeof healthProbe, 'object');
  assert.equal(typeof healthProbe.probe, 'function');
});

test('probe 是零参数调用（与 dsh-clis 的调用方式一致）', () => {
  // 这条断言的是"函数能不传参被调用"，而不是 arity —— 因为即使写成
  // `probe(ctx)`，JS 也允许零参调用；真正的保证是"不依赖参数"，
  // 由下面几条"先 bindContext 再零参调用"的用例覆盖。
  reset();
  assert.doesNotThrow(() => healthProbe.probe());
});

test('代号稳定（改名会让按名字检索的日志/面板失联）', () => {
  assert.equal(PROBE_CODES.notLoaded, 'meta-framework.not-loaded');
  assert.equal(PROBE_CODES.hostRootMissing, 'meta-framework.host-root-missing');
  assert.equal(PROBE_CODES.toolsUnavailable, 'meta-framework.tools-unavailable');
  assert.equal(PROBE_CODES.classifierMissing, 'meta-framework.classifier-missing');
  assert.equal(PROBE_CODES.ok, 'meta-framework.ok');
});

test('apply 报 ok + CLIS 可用 → 探针 ok（不靠传参）', () => {
  reset('ok');
  bindContext(fakeCtx({ 'clis.causalClassifier': {} }));

  // 关键：这里**不传任何参数**，模拟监督层的真实调用方式
  const r = healthProbe.probe();

  assert.equal(r.status, 'ok', 'CLIS 可用时必须报 ok');
  assert.equal(r.findings.length, 1, '正常时应只有一条 ok');
  assert.equal(r.findings[0].code, PROBE_CODES.ok);
});

test('未 bindContext 时不能报"CLIS 缺失"（那会把"未装载"说成"没装"）', () => {
  reset('ok');
  bindContext(undefined);

  const r = healthProbe.probe();
  const f = r.findings.find((x) => x.code === PROBE_CODES.classifierMissing);

  // 仍然是同一代号，但文案必须说明是"尚未装载/无法确认"，
  // 而不是断言"CLIS 不可用"—— 后者在插件没装载时是假话。
  assert.ok(f, '仍要报出来（否则监督层看不出异常）');
  assert.ok(
    f.message.includes('尚未装载') || f.message.includes('无法确认'),
    `未装载时不能断言 CLIS 缺失，实际文案：${f.message}`,
  );
});

test('bindContext 了但 CLIS 真不在 → 报 classifier-missing（info，不拉红灯）', () => {
  reset('ok');
  bindContext(fakeCtx());

  const r = healthProbe.probe();
  assert.equal(r.status, 'ok', 'CLIS 缺失不该判为不健康（可选增强）');
  const f = r.findings.find((x) => x.code === PROBE_CODES.classifierMissing);
  assert.equal(f.severity, 'info', '严重度必须是 info，不是 error');
  assert.ok(f.message.includes('不可用'), '真缺失时才可以说"不可用"');
});

test('没跑到 apply → 报 not-loaded（不猜宿主状态，不报 ok）', () => {
  reset('not-applied');

  const r = healthProbe.probe();
  const f = r.findings.find((x) => x.code === PROBE_CODES.notLoaded);

  assert.ok(f, '没装载必须报出来 —— 否则"工具没注册"完全不可见');
  assert.equal(f.severity, 'error');
  assert.equal(r.status, 'failing');
  // 没跑到 apply 时不能断言 dsh-tools 可用性（上一版就在这里猜）
  assert.ok(!r.findings.some((x) => x.code === PROBE_CODES.toolsUnavailable));
});

test('apply 报"定位失败" → 报 host-root-missing（带修法提示）', () => {
  reset('host-root-missing');

  const r = healthProbe.probe();
  const f = r.findings.find((x) => x.code === PROBE_CODES.hostRootMissing);

  assert.ok(f, '定位失败必须点名');
  assert.equal(f.severity, 'error');
  assert.ok(f.hint, '要给出修法提示');
  assert.equal(r.status, 'failing');
});

test('apply 报"工具加载失败" → 报 tools-unavailable，且带上真实异常', () => {
  reset();
  recordRegistration('tools-unavailable', "Cannot find module '@deepseek-ai/dsh-tools'");

  const r = healthProbe.probe();
  const f = r.findings.find((x) => x.code === PROBE_CODES.toolsUnavailable);

  assert.ok(f, '必须报 tools-unavailable');
  assert.equal(f.severity, 'error');
  assert.ok(
    f.message.includes("Cannot find module '@deepseek-ai/dsh-tools'"),
    `失败原因不能丢，实际：${f.message}`,
  );
  assert.equal(r.status, 'failing');
});

test('探针不读文件系统做推断（同一判据不实现两遍）', async () => {
  // 这条守的是架构约束，不是某个分支：结论只来自 recordRegistration
  // 记下的实测结果，不该再有一条独立的文件系统推断路径。
  //
  // 必须先剥掉注释再查 —— 注释里会**解释**旧的 existsSync 做法，
  // 直接全文匹配会把文档判成代码（写这条断言时就踩了）。
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/health.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!code.includes('existsSync'), '探针代码里不该再有文件系统推断（注释不算）');
  assert.ok(!code.includes('toolsLoadable'), '旧的推断函数必须删干净，不能留成死代码');
});

test('探针永不抛错（ctx 形状再怪也只报问题）', () => {
  // 探针自己抛错比没探针更糟：会让监督层一起挂。
  for (const ctx of [
    undefined,
    {},
    { get: () => { throw new Error('boom'); } },
    { get: () => undefined },
  ]) {
    reset('ok');
    bindContext(ctx);
    assert.doesNotThrow(() => healthProbe.probe(), `ctx 形状 ${String(ctx)} 时不该抛错`);
  }
});

test('ctx.get 抛错时按"CLIS 不可用"处理，不向上冒泡', () => {
  reset('ok');
  bindContext({
    get: () => {
      throw new Error('cannot get without inject');
    },
  });

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes(PROBE_CODES.classifierMissing));
});

test('deriveStatus 与 dsh-clis 同口径', async () => {
  const { deriveStatus } = await import('../src/health.js');
  assert.equal(deriveStatus([{ severity: 'error' }]), 'failing');
  assert.equal(deriveStatus([{ severity: 'warn' }]), 'degraded');
  assert.equal(deriveStatus([{ severity: 'info' }]), 'ok');
  assert.equal(deriveStatus([]), 'ok');
});
