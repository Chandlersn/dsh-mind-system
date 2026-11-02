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
 *
 * ## 第三条：**注册成功 ≠ 能用**（缺陷 1）
 *
 * 上一版探针的唯一依据是 `recordRegistration('ok')`，那行代码紧跟在
 * `ctx.tools.register(tool)` 之后 —— 它证明的是"注册了"，**不是"能用"**。
 * 探针因此会给一个 100% 不可用的工具发绿牌。
 *
 * 现在探针有两个独立的事实来源：`recordRegistration()`（注册了没有）与
 * `recordExecution()`（最近一次真实执行成功没有）。只有后者能证明"能用"。
 *
 * ## 第四条：CLIS 判据必须与工具路径**同一把尺**（缺陷 1）
 *
 * 上一版探针只判"服务存在"，工具路径走库的 `pick()`（要求有 `classify()` 方法）。
 * 于是同一个宿主上两边结论相反。本文件用 `src/clis.js` 的共享实现，
 * 并有一条测试直接比对库的 `pick()` 源码，确保两把尺不会漂。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  healthProbe,
  PROBE_CODES,
  bindContext,
  recordRegistration,
  recordExecution,
  deriveStatus,
  pickClassifier,
  probeClassifier,
  CAUSAL_CLASSIFIER_SERVICE,
  CLASSIFIER_METHOD,
} from '../src/health.js';

/**
 * 造一个**形状正确**的分类器服务。
 *
 * 必须是带 `classify()` 方法的对象 —— 库的 `pick()` 就是这么判的。
 * 上一版的测试用 `{}` 当分类器，那恰好是"存在但不合约"的形状，
 * 旧探针说"可用"、工具说"不可用"（缺陷 1 的第二个形态）。
 */
function fakeClassifier() {
  return {
    async classify() {
      return { causal_type: 'cyclic', confidence: 0.9, rationale: 'test', evidence: [] };
    },
  };
}

/** 造一个假的 ctx：`get(name)` 按表返回。 */
function fakeCtx(services = {}) {
  return { get: (name) => services[name] };
}

/**
 * 每个用例前恢复到一个已知状态。
 *
 * 三个模块级状态都要清：
 * - `bindContext` 记的 ctx
 * - `recordRegistration` 记的**实测装载结果**（探针事实来源之一）
 * - `recordExecution` 记的**实测执行结果**（探针事实来源之二）
 *
 * 不清的话前一个用例的"装载成功 + 执行成功"会让后一个用例的探针报 ok ——
 * 那会造出难查的假失败。
 */
function reset(stage = 'ok', executionStage = 'not-observed') {
  bindContext(undefined);
  recordRegistration(stage);
  recordExecution(executionStage);
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

test('新代号稳定且不含变量数据（缺陷 1：执行失败要单独一个代号）', () => {
  // `execution-failed` 是缺陷 1 的修复产物：探针此前没有"执行路径坏了"这个状态。
  // 代号会被按名字检索，所以必须稳定。
  assert.equal(PROBE_CODES.executionFailed, 'meta-framework.execution-failed');

  // 所有代号都必须是"静态字符串"，不能把运行时数据塞进去（否则按名检索失效）。
  for (const [key, code] of Object.entries(PROBE_CODES)) {
    assert.equal(typeof code, 'string', `${key} 必须是字符串`);
    assert.ok(code.startsWith('meta-framework.'), `${key} 必须带包名前缀，实际 ${code}`);
    assert.equal(code, code.toLowerCase(), `${key} 不能含大写（检索友好）`);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(code), `${key} 不能含日期（那是变量数据）`);
  }
});

test('apply 报 ok + CLIS 可用 → 探针 ok（不靠传参）', () => {
  reset('ok');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }));

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

test('探针不读文件系统做推断（同一判据不实现两遍）', () => {
  // 这条守的是架构约束，不是某个分支：结论只来自 recordRegistration
  // 记下的实测结果，不该再有一条独立的文件系统推断路径。
  //
  // 必须先剥掉注释再查 —— 注释里会**解释**旧的 existsSync 做法，
  // 直接全文匹配会把文档判成代码（写这条断言时就踩了）。
  const source = readFileSync(new URL('../src/health.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!code.includes('existsSync'), '探针代码里不该再有文件系统推断（注释不算）');
  assert.ok(!code.includes('toolsLoadable'), '旧的推断函数必须删干净，不能留成死代码');
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

// ── 缺陷 1：探针必须证明"能用"，不只是"注册了" ──────────────────

test('缺陷 1：注册成功但执行失败 → 探针必须报 execution-failed（不能报 ok）', () => {
  // 这是缺陷 1 的核心断言。
  //
  // 上一版探针的唯一依据是 `recordRegistration('ok')`（注册了没有），
  // 所以"库一调用就抛"的工具照样报 `status: ok` —— 给坏工具发绿牌。
  //
  // 现在执行结果是一个**独立**的事实来源：失败必须拉红灯。
  reset('ok', 'failed');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }));

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);

  assert.ok(codes.includes(PROBE_CODES.executionFailed), `必须报 execution-failed，实际：${codes}`);
  assert.ok(!codes.includes(PROBE_CODES.ok), '执行失败时不能同时报 ok');
  assert.equal(r.status, 'failing', '执行路径坏了必须拉红灯');
});

test('缺陷 1：执行失败的原因必须进探针文案（只报代号等于让人重查一遍）', () => {
  reset('ok', 'failed');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }));

  const r = healthProbe.probe();
  const f = r.findings.find((x) => x.code === PROBE_CODES.executionFailed);

  assert.ok(f, '必须报 execution-failed');
  assert.equal(f.severity, 'error');
  assert.ok(f.message.includes('执行失败'), `实际：${f.message}`);
});

test('缺陷 1：还没执行过（not-observed）不报"能用"也不报"不能用"', () => {
  // 关键：没观测过就**不装作有结论**。
  // 报 ok 是在说"它能用"—— 那同样是没根据的话。
  reset('ok', 'not-observed');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }));

  const r = healthProbe.probe();
  const ok = r.findings.find((x) => x.code === PROBE_CODES.ok);

  assert.ok(ok, '注册成功且 CLIS 可用 → 仍是 ok');
  assert.ok(
    ok.message.includes('尚无实测记录'),
    `没执行过时必须说清楚是"尚无实测记录"，不能暗示"已验证可用"，实际：${ok.message}`,
  );
  assert.equal(r.status, 'ok', '没执行过不等于坏了');
});

test('缺陷 1：执行成功 → ok 的文案要说明"最近一次执行成功"', () => {
  reset('ok', 'ok');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }));

  const r = healthProbe.probe();
  const ok = r.findings.find((x) => x.code === PROBE_CODES.ok);

  assert.ok(ok, '必须报 ok');
  assert.ok(ok.message.includes('执行成功'), `实际：${ok.message}`);
  assert.equal(r.status, 'ok');
});

test('缺陷 1：探针永不抛错（ctx 形状再怪也只报问题）', () => {
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

// ── 缺陷 1：CLIS 判据必须与工具路径同一把尺 ───────────────────────

test('缺陷 1：服务存在但形状不对 → 探针必须说"不可用"（不能只判存在）', () => {
  // 这一条是缺陷 1 的第二个形态：**探针与工具对同一宿主给出相反结论**。
  //
  // 旧探针判 `get(...) !== undefined` → `{}` 就算"CLIS 可用"；
  // 而工具路径走库的 `pick()` → `{}` 没有 `classify()` → "分类器不可用"。
  //
  // 同一个宿主上，探针说可用、工具说不可用 —— 探针就在撒谎。
  reset('ok');
  bindContext(fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: {} }));

  const r = healthProbe.probe();
  const codes = r.findings.map((f) => f.code);

  assert.ok(
    codes.includes(PROBE_CODES.classifierMissing),
    `形状不对时探针必须说不可用（与工具口径一致），实际：${codes}`,
  );
  assert.ok(!codes.includes(PROBE_CODES.ok), '不能一边说"CLIS 可用"一边报 ok');
});

test('缺陷 1：探针的 CLIS 判据**直接用库自己的**（不抄一遍，不可能漂）', () => {
  // 探针与工具路径必须用同一把尺。关键是：**这把尺就是库的那把**。
  //
  // 本插件的共享实现（`src/clis.js`）调用库的 `resolveClisServices()`，
  // 而不是复刻它的 `pick()` 逻辑 —— 复刻会漂（库里改了方法名就完了），
  // 直接调用则**不可能漂**：探针与工具路径跑的是同一段代码。
  const shared = readFileSync(new URL('../src/clis.js', import.meta.url), 'utf8');
  assert.ok(
    shared.includes('resolveClisServices'),
    '共享实现必须调用库的 resolveClisServices（唯一实现）',
  );
  assert.ok(
    !shared.includes("typeof source.get !== 'function'"),
    '共享实现不该复刻库的 pick() 判据 —— 复刻会漂',
  );

  // 库的 pick() 仍然要求那两件事（作为对照，确认我们调用的是对的函数）
  const bridge = readFileSync(
    new URL(
      '../node_modules/@causal-layers/meta-framework/dist/src/clis-bridge.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.ok(
    bridge.includes("typeof source.get !== 'function'"),
    '库要求 ctx.get 是函数',
  );
  assert.ok(
    bridge.includes("typeof candidate[method] !== 'function'"),
    '库要求候选对象上有方法',
  );
});

test('缺陷 1：CLIS 服务名与契约包的真实常量一致（防字面量漂移）', () => {
  // 本插件不直接依赖契约包（那是传递依赖，解析不到就会让插件加载失败），
  // 所以服务名是写死的字面量 —— 那就必须有测试把它钉在契约的真实值上。
  const contractsPath = new URL(
    '../node_modules/@causal-layers/contracts/dist/services.js',
    import.meta.url,
  );
  const source = readFileSync(contractsPath, 'utf8');
  assert.ok(
    source.includes(`CAUSAL_CLASSIFIER_SERVICE = '${CAUSAL_CLASSIFIER_SERVICE}'`),
    `契约包里的服务名应仍是 ${CAUSAL_CLASSIFIER_SERVICE}`,
  );
});

test('缺陷 1：pickClassifier 与 probeClassifier 结论必须一致', () => {
  // 两条路径共用同一份判据（src/clis.js），所以对同一 ctx 必须给出同一结论。
  const cases = [
    fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: fakeClassifier() }),
    fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: {} }),
    fakeCtx({ [CAUSAL_CLASSIFIER_SERVICE]: null }),
    fakeCtx({}),
    { get: () => { throw new Error('boom'); } },
    {},
    undefined,
  ];
  for (const ctx of cases) {
    const picked = pickClassifier(ctx);
    const probed = probeClassifier(ctx);
    assert.equal(
      picked !== undefined,
      probed.available,
      `两条路径结论不一致：ctx=${String(ctx)}`,
    );
  }
});

test('缺陷 1：查询抛错与"服务不存在"要能区分（排查方向不同）', () => {
  const failed = probeClassifier({
    get: () => {
      throw new Error('cannot get without inject');
    },
  });
  const absent = probeClassifier(fakeCtx());

  assert.equal(failed.available, false);
  assert.equal(absent.available, false);
  assert.notEqual(
    failed.kind,
    absent.kind,
    '查询抛错与"服务不存在"必须能区分 —— 前者查宿主集成，后者查安装',
  );
  assert.ok(failed.reason, '查询抛错必须带原因');
});

// ── 缺陷 9：deriveStatus 的口径 ──────────────────────────────────

test('缺陷 9：deriveStatus 与契约包的 deriveStatus 逐字同义', () => {
  // 契约包的实现（`clis-contracts/src/health.ts`）：
  //   error → failing；warn → degraded；否则 ok
  //
  // 本插件的 deriveStatus 必须与之**逐条一致** —— 抄一份会漂，
  // 所以直接读契约包实现源码比对。
  assert.equal(deriveStatus([{ severity: 'error' }]), 'failing');
  assert.equal(deriveStatus([{ severity: 'warn' }]), 'degraded');
  assert.equal(deriveStatus([{ severity: 'info' }]), 'ok');
  assert.equal(deriveStatus([]), 'ok');
  assert.equal(deriveStatus([{ severity: 'info' }, { severity: 'error' }]), 'failing');
  assert.equal(deriveStatus([{ severity: 'info' }, { severity: 'warn' }]), 'degraded');

  // 契约包实现源码里必须真的只有那两条分支 —— 若上游改了规则，
  // 这条断言会红，提示两边需要重新对齐。
  const contractsTypes = readFileSync(
    new URL('../node_modules/@causal-layers/contracts/dist/types.js', import.meta.url),
    'utf8',
  );
  const m = contractsTypes.match(/export function deriveStatus\(findings\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '契约包里必须还能找到 deriveStatus 的实现');
  assert.ok(m[0].includes("'error'"), '契约实现必须含 error 分支');
  assert.ok(m[0].includes("'warn'"), '契约实现必须含 warn 分支');
  assert.ok(
    !m[0].includes('length > 0'),
    '契约实现不该有"有发现即 degraded"那一支 —— 若上游改了，本插件要重新对齐',
  );
});

test('缺陷 9：注释不再谎称"与 dsh-clis 的 deriveStatus 逐字同义"，且写明用的是哪一支', () => {
  // 缺陷 9 的要害不是代码，是**注释在撒谎**：
  // 旧注释声称"与 dsh-clis 的 deriveStatus 逐字同义"，而 dsh-clis 内部
  // 真正套用的是 `findings.length > 0 ? 'degraded' : 'ok'` 那一支
  // （它的发现项只有 warn/error），与契约包的实现不是同一支。
  //
  // 这条断言要求注释里**明确说出用的是哪一支**，且不能再说那句假话。
  const source = readFileSync(new URL('../src/health.js', import.meta.url), 'utf8');
  const comment = source.slice(0, source.indexOf('export function deriveStatus'));
  assert.ok(
    !comment.includes('逐字同义**（`error → failing`'),
    '不能再用那句对不上号的措辞',
  );
  assert.ok(
    comment.includes('findings.length > 0'),
    '注释必须写明 dsh-clis 内部那一支长什么样（否则下一个人又会搞混）',
  );
});
