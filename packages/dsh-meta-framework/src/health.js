/**
 * 健康探针。
 *
 * ## 为什么需要它
 *
 * 本插件的失败模式**全是静默的**：
 *
 * 1. `dsh-tools` 解析失败 → `apply()` 降级 return，工具根本不存在
 * 2. CLIS 三服务缺失 → 工具照常返回，只是 `causal_type: null`
 * 3. `inject: ['tools']` 未满足 → fiber 卡在 loading
 * 4. **工具注册成功，但执行路径整个是坏的** → 宿主里一切正常，agent 一调就炸
 *
 * 宿主里的 `dsh-clis` 监督层按导出名自动发现探针（`ns.healthProbe`），
 * 对没有探针的插件报 `coverage.no-probe`。
 *
 * ## ⚠️ 约束一：探针**收不到 ctx**
 *
 * `dsh-clis` 的 `wrapExportedProbe` 是这样调的：
 *
 * ```js
 * raw = await exported.probe();   // 零参数，不传 ctx
 * ```
 *
 * 所以**绝不能**把 `ctx` 写成探针的参数并指望它被传进来 ——
 * 上一版就是这么写的，结果 `ctx` 永远是 `undefined`，于是：
 *
 * - `classifier-missing` 在每台装了 CLIS 的机器上**恒误报**
 * - `meta-framework.ok` 分支在真实发现路径上**不可达**（只有单测手工传 ctx 才走得到）
 *
 * 修法：`apply(ctx)` 时把 ctx 存进模块级变量，探针从那里读。
 *
 * ## ⚠️ 约束二：探针**不许自己推断"能不能加载"**
 *
 * 上一版用 `existsSync` 判 `<root>/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
 * 是否存在，据此推断工具会注册。**那是猜，不是判**，两头都能错：
 *
 * - 文件在、但 require 时内部抛错（缺 peer、版本不匹配）→ 探针报 ok，工具却没注册
 * - 文件不在、但宿主其实从别处解析到了 → 探针报 error，工具其实好好的
 *
 * 第二种已用"假安装根"实测复现：`dsh-tools/lib/index.js` 存在但一 require 就抛，
 * **探针照报 `status: ok`** —— 正好漏掉它声称要盯的那个失败模式。
 *
 * 根因不是漏判某一档，而是**同一件事算了两遍**：`apply()` 里 `getDefineTool()`
 * 已经知道答案（成功，或抛错并给出 reason），探针又拿文件系统推一遍，
 * 而"推断"与"事实"之间没有任何约束。
 *
 * 现在改为：`apply()` 把**实测结果**写进 `recordRegistration()`，探针只读不判。
 * 判据单一实现（真正跑过一次加载），探针从此不可能比事实更乐观。
 * 代价是探针在 `apply()` 之前不能断言宿主状态 —— 那本来就该说"没跑到 apply"，
 * 而不是拿目录结构猜一个结论。
 *
 * ## ⚠️ 约束三：**"注册成功"不等于"能用"**
 *
 * 上一版（以及更早的版本）把 `recordRegistration('ok')` 当作探针的**全部**依据 ——
 * 而那行代码紧跟在 `ctx.tools.register(tool)` 之后，**证明的只是"注册了"**。
 *
 * 实测复现：把库换成"每个调用都抛"，探针照样报 `status: ok` /
 * `meta-framework.ok` —— 而工具 100% 不可用。**探针在给一个坏工具发绿牌。**
 *
 * 所以现在有**三个独立的事实来源**，各自只证明自己那一件事：
 *
 * | 来源 | 写入者 | 证明什么 | 不证明什么 |
 * |---|---|---|---|
 * | `recordRegistration()` | `apply()` | 宿主工具定义器加载成功、工具已注册 | 工具能不能跑 |
 * | `recordExecution()` | `execute()` 包装器 | **最近一次真实执行成功** | 之后的调用会不会成功 |
 *
 * 只有第二条能证明"工具可用"。第一条是必要条件，不是充分条件。
 * 缺陷 1 的复现形态（库能加载但每个调用都抛）正好落在
 * "第一条绿、第二条红" —— 探针必须报红，而不是跟着第一条走。
 *
 * ### 为什么没有第三条"库加载"信号
 *
 * 框架库 `@causal-layers/meta-framework` 在 `index.js` 顶部是**静态 import** 的
 * —— 它加载不了的话，整个插件模块加载就失败了，`apply()` 根本不会跑，
 * 探针报的是 `not-loaded`。所以"库加载失败"没有独立于"插件没装载"的形态，
 * 单独给它一个代号只会造出一个**永远绿的状态**（那正是本文件要消灭的东西）。
 *
 * ## ⚠️ 约束四：CLIS 可用性必须与**工具路径用同一把尺**
 *
 * 库的 `resolveClisServices()` → `pick()` 判定"分类器可用"的条件是四件事同时成立：
 * ctx 上有 `get`、`get` 不抛错、取到的是对象、**且 `typeof raw.classify === 'function'`**。
 *
 * 上一版探针只判**存在**（`get('clis.causalClassifier') !== undefined`），
 * 于是同一个宿主上：探针说"CLIS 可用"、工具说"分类器不可用" ——
 * **探针与它所监督的工具对同一件事给出相反结论**。
 *
 * 现在探针用**同一个判据**（同一份服务名常量 + 同一个方法名 + 同一套形状检查）。
 *
 * ## 四条约束
 *
 * - **只读**：只查，不改任何状态
 * - **不抛错**：探针自己抛错比没探针更糟（会让监督层一起挂）
 * - **`code` 稳定**：代号会被人按名字检索，不能随文案改，也不能把变量数据塞进去
 * - **零参数**：监督层以 `probe()` 调用，写了参数也拿不到
 */

import { probeClassifier } from './clis.js';

/**
 * CLIS 分类器服务名与判定用的方法名。
 *
 * ## 为什么在这里写死而不 import `@causal-layers/contracts`
 *
 * 服务名常量住在契约包里（`CAUSAL_CLASSIFIER_SERVICE === 'clis.causalClassifier'`），
 * 但本插件的 `dependencies` 里**没有**直接依赖那个包 —— 它是
 * `@causal-layers/meta-framework` 的传递依赖，而 npm 不保证传递依赖能被解析到。
 * 硬 import 会在某些安装形态下直接让插件加载失败（那比探针不准确更糟）。
 *
 * 所以这里写死字面量，并**用一条测试把它钉在契约包的真实值上**
 * （见 `test/health.test.js`：从契约包读出常量，与本文件比对）。
 * 这样既不引入新的运行时依赖，也不会悄悄漂移。
 *
 * 判定逻辑本身不在这里 —— 它住在 `src/clis.js`，那是探针与工具路径
 * 共用的**唯一**实现（避免两边各判各的）。
 */
export { CAUSAL_CLASSIFIER_SERVICE, CLASSIFIER_METHOD, pickClassifier, probeClassifier } from './clis.js';

/** 探针代号（稳定，供监督层与日志检索）。 */
export const PROBE_CODES = {
  /** 插件没跑到 `apply()`：inject 未满足、模块加载失败，或宿主上下文不可用。 */
  notLoaded: 'meta-framework.not-loaded',
  /** `apply()` 实跑过：定位 DSH 安装目录失败，工具未注册。 */
  hostRootMissing: 'meta-framework.host-root-missing',
  /** `apply()` 实跑过：安装根在，但 `@deepseek-ai/dsh-tools` 加载抛错，工具未注册。 */
  toolsUnavailable: 'meta-framework.tools-unavailable',
  /** 最近一次真实工具执行失败：工具注册成功但执行路径是坏的。 */
  executionFailed: 'meta-framework.execution-failed',
  /** CLIS 分类器不可用 —— 装了 dsh-clis 才有因果判断。 */
  classifierMissing: 'meta-framework.classifier-missing',
  /** 一切正常。 */
  ok: 'meta-framework.ok',
};

/**
 * 插件装载时捕获的宿主上下文。
 *
 * 供探针读取 —— 探针被监督层以零参数调用，只能从这里拿到 ctx。
 * 尚未装载时保持 undefined，此时 CLIS 检查会如实说明"未装载"。
 */
let pluginCtx;

/**
 * `apply()` 的**实测**装载结果。
 *
 * 这是本模块事实来源之一：探针不推断，只读它。
 *
 * - `stage: 'not-applied'` —— 还没跑到 `apply()`（初值）
 * - `stage: 'ok'` —— `getDefineTool()` 成功，工具已注册
 * - `stage: 'host-root-missing'` / `'tools-unavailable'` —— 同名的两种失败
 */
let registration = { stage: 'not-applied' };

/**
 * 最近一次**真实工具执行**的结果。
 *
 * - `stage: 'not-observed'` —— 工具还没被调用过（既不证明能用，也不证明不能用）
 * - `stage: 'ok'` —— 最近一次执行成功
 * - `stage: 'failed'` —— 最近一次执行失败
 */
let execution = { stage: 'not-observed' };

/**
 * 记录宿主上下文（由 `apply()` 调用）。
 *
 * @param ctx — Cordis 上下文。
 */
export function bindContext(ctx) {
  pluginCtx = ctx;
}

/**
 * 记录**实测**装载结果（由 `apply()` 调用）。
 *
 * 必须由真正跑过 `getDefineTool()` 的那段代码来填 —— 填在这里的每个值
 * 都对应一次真实的成功或异常，探针不再有独立的推断路径。
 *
 * @param stage — 装载阶段结果。
 * @param reason — 失败时的真实异常消息（失败详情不能丢）。
 */
export function recordRegistration(stage, reason) {
  registration = reason === undefined ? { stage } : { stage, reason };
}

/**
 * 记录**最近一次真实执行**的结果（由 `index.js` 的 `execute()` 包装器调用）。
 *
 * 这是探针唯一能证明"工具可用"的信号：注册成功只说明工具在列表里，
 * 跑通一次才说明它真的能用。
 *
 * @param stage — `'ok'` 或 `'failed'`。
 * @param reason — 失败时的真实异常消息。
 */
export function recordExecution(stage, reason) {
  execution = reason === undefined ? { stage } : { stage, reason };
}

/**
 * 把 `apply()` 捕获的异常归类成探针代号。
 *
 * 只按**异常消息**分辨"定位不到安装根"与"定位到了但 dsh-tools 加载失败"：
 * 前者来自 `resolveDshRoot()` 的显式错误，后者是 require 阶段的 MODULE_NOT_FOUND
 * 或包内部抛错。两者修法完全不同，不能混成一句"加载失败"。
 *
 * @param error — `getDefineTool()` 抛出的异常。
 * @returns 归类后的阶段。
 */
export function classifyLoadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('无法定位 DSH 安装目录')) return 'host-root-missing';
  return 'tools-unavailable';
}

/**
 * 检查插件健康度。
 *
 * 注意：**不加 ctx 参数** —— 监督层零参数调用，写了也拿不到。
 * 需要的上下文从 `bindContext()` 捕获的模块级变量取。
 *
 * @returns 探针结果。
 */
export function probe() {
  try {
    return buildReport();
  } catch (error) {
    // 探针自己抛错比没探针更糟（会让监督层一起挂）。
    // 兜底：报一条 failing，绝不把异常冒泡出去。
    return {
      plugin: 'dsh-meta-framework',
      status: 'failing',
      findings: [
        {
          code: PROBE_CODES.notLoaded,
          severity: 'error',
          message: `探针自身执行异常：${error instanceof Error ? error.message : String(error)}`,
          hint: '这是探针的缺陷，不是被监督插件的缺陷；请上报。',
        },
      ],
    };
  }
}

/**
 * 构造探针报告（`probe()` 的实现体，单独抽出便于包 try/catch）。
 *
 * @returns 探针结果。
 */
function buildReport() {
  const findings = [];

  // ① 工具到底注册了没有？—— 读 `apply()` 的实测结果，不推断。
  //
  // 三种失败含义不同，修法也不同：
  //   not-applied        → 插件没跑起来（inject 未满足 / 模块加载失败）
  //   host-root-missing  → 跑起来了，但找不到 DSH 安装目录
  //   tools-unavailable  → 跑起来了、目录也在，但 dsh-tools 加载抛错
  const { stage, reason } = registration;

  if (stage === 'not-applied') {
    findings.push({
      code: PROBE_CODES.notLoaded,
      severity: 'error',
      message: '插件尚未跑到 apply()，meta_reframe 工具未注册。',
      hint: '查宿主启动日志里的 "did not activate"；常见原因是 inject 未满足或模块加载抛错。',
    });
  } else if (stage === 'host-root-missing') {
    findings.push({
      code: PROBE_CODES.hostRootMissing,
      severity: 'error',
      message: `无法定位 DSH 安装目录，meta_reframe 工具未注册。${reason === undefined ? '' : `原因：${reason}`}`,
      hint: '设置环境变量 DSH_INSTALL_DIR 指向 DSH 安装目录（含 dsh.cmd 的那一级）。',
    });
  } else if (stage === 'tools-unavailable') {
    findings.push({
      code: PROBE_CODES.toolsUnavailable,
      severity: 'error',
      message: `能定位 DSH 安装目录，但加载 @deepseek-ai/dsh-tools 失败，meta_reframe 工具未注册。${reason === undefined ? '' : `原因：${reason}`}`,
      hint: '确认 DSH 安装完整：该包文件存在但 require 抛错时，多为 peer 依赖缺失或版本不匹配。',
    });
  }

  // ② 最近一次**真实执行**成功了吗？
  //
  // 这是唯一能证明"工具可用"的信号。没执行过（not-observed）时不作任何断言 ——
  // 既不报"能用"也不报"不能用"，只如实说"尚无实测记录"。
  if (execution.stage === 'failed') {
    findings.push({
      code: PROBE_CODES.executionFailed,
      severity: 'error',
      message: `meta_reframe 最近一次执行失败，工具当前不可用。${execution.reason === undefined ? '' : `原因：${execution.reason}`}`,
      hint: '查上面那条原因；常见于框架库版本不匹配或依赖缺失。',
    });
  }

  // ③ CLIS 分类器在不在？
  //
  // 不在**不是错误**：CLIS 是可选增强，纯 meta 也能用。所以标 info，
  // 但必须报出来 —— 否则使用者会把"没判出因果类型"误读成
  // "这问题本来就没有因果结构"，那是完全不同的结论。
  //
  // ctx 从模块级变量取（探针拿不到参数）。**没装载时不能报"分类器缺失"** ——
  // 那会把"还没装载"说成"CLIS 没装"，又是一句假话。所以单独区分。
  //
  // 判据与工具路径**同一把尺**（`src/clis.js` 的 `probeClassifier()`，
  // 与库的 `pick()` 逐条对齐），不允许两边结论相反。
  const probed = pluginCtx !== undefined && pluginCtx !== null;
  const classifier = probed ? probeClassifier(pluginCtx) : undefined;

  if (!probed) {
    findings.push({
      code: PROBE_CODES.classifierMissing,
      severity: 'info',
      message: '插件尚未装载（或宿主上下文不可用），无法确认 CLIS 分类服务状态。',
      hint: '若插件已装载仍见此条，检查它是否因加载失败而没走到 apply()。',
    });
  } else if (!classifier.available) {
    findings.push({
      code: PROBE_CODES.classifierMissing,
      severity: 'info',
      message: `CLIS 分类服务不可用：四问作答会原样传给框架，但判不出因果类型。${classifier.reason === undefined ? '' : `原因：${classifier.reason}`}`,
      hint: '需要因果判断时装 dsh-clis；不需要可忽略。',
    });
  }

  if (findings.length === 0) {
    findings.push({
      code: PROBE_CODES.ok,
      severity: 'info',
      message:
        execution.stage === 'ok'
          ? '宿主定位正常，CLIS 分类服务可用，最近一次工具执行成功。'
          : '宿主定位正常，CLIS 分类服务可用（执行路径尚无实测记录）。',
    });
  }

  return {
    plugin: 'dsh-meta-framework',
    status: deriveStatus(findings),
    findings,
  };
}

/**
 * 由 findings 推整体状态。
 *
 * ## 与 dsh-clis 的口径是**同一份实现**，不是"看起来一样"
 *
 * `dsh-clis` 的 `index.js` 从 `@causal-layers/clis-contracts` 拿到 `deriveStatus`，
 * 实现是 `clis-contracts/src/health.ts`：
 *
 * ```ts
 * error → 'failing'；warn → 'degraded'；否则 'ok'
 * ```
 *
 * 本文件**逐字复刻**这一份（而不是 import —— 契约包不是本插件的直接依赖，
 * 硬 import 会在某些安装形态下直接让插件加载失败；见文件头关于服务名的说明）。
 * `test/health.test.js` 有一条测试直接读契约包的 `deriveStatus` 实现源码，
 * 把两边的规则逐条比对 —— 抄一份会漂，但**漂了会被抓到**。
 *
 * ## 注意：dsh-clis 内部还有**另一个**同名的判定式
 *
 * `dsh-clis/index.js` 的 `structuralProbe()`（约 1734 行）里另写了一段：
 *
 * ```js
 * findings.some((f) => f.severity === 'error') ? 'failing'
 *   : findings.length > 0 ? 'degraded' : 'ok'
 * ```
 *
 * 那段是**自动结构探针专用**的：它自己产出的发现项只有 warn/error 两级，
 * 所以"有发现即 degraded"对它是合适的。而本探针会产出 **info** 级发现项
 * （例如"CLIS 分类服务不可用" —— 那是可选增强缺失，不是不健康），
 * 若套用那一支，任何一条 info 都会把整体拖成 degraded，与主线口径打架。
 *
 * 因此这里取**契约包那一支**（error → failing，warn → degraded，否则 ok），
 * 并把"哪一支"写进本注释 —— 上一版的注释声称"与 dsh-clis 的 deriveStatus
 * 逐字同义"，而它指的其实是这个契约实现，而 dsh-clis 内部真正套用的是
 * 另一支（`findings.length > 0`）。那句话对不上号，现在把话说准。
 *
 * @param findings — 发现项。
 * @returns 状态字符串。
 */
export function deriveStatus(findings) {
  if (findings.some((item) => item.severity === 'error')) return 'failing';
  if (findings.some((item) => item.severity === 'warn')) return 'degraded';
  return 'ok';
}

/** 探针对象形态（监督层接受 `ns.healthProbe` 为对象含 `probe()`）。 */
export const healthProbe = { probe };
