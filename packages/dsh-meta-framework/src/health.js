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
 * ## 三条约束
 *
 * - **只读**：只查，不改任何状态
 * - **不抛错**：探针自己抛错比没探针更糟（会让监督层一起挂）
 * - **`code` 稳定**：代号会被人按名字检索，不能随文案改
 */

/** 探针代号（稳定，供监督层与日志检索）。 */
export const PROBE_CODES = {
  /** 插件没跑到 `apply()`：inject 未满足、模块加载失败，或宿主上下文不可用。 */
  notLoaded: 'meta-framework.not-loaded',
  /** `apply()` 实跑过：定位 DSH 安装目录失败，工具未注册。 */
  hostRootMissing: 'meta-framework.host-root-missing',
  /** `apply()` 实跑过：安装根在，但 `@deepseek-ai/dsh-tools` 加载抛错，工具未注册。 */
  toolsUnavailable: 'meta-framework.tools-unavailable',
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
 * 这是本模块唯一的事实来源：探针不推断，只读它。
 *
 * - `stage: 'not-applied'` —— 还没跑到 `apply()`（初值）
 * - `stage: 'ok'` —— `getDefineTool()` 成功，工具已注册
 * - `stage: 'host-root-missing'` / `'tools-unavailable'` —— 同名的两种失败
 */
let registration = { stage: 'not-applied' };

/**
 * 记录宿主上下文（由 `apply()` 调用）。
 *
 * @param ctx — Cordis 上下文。
 */
export function bindContext(ctx) {
  pluginCtx = ctx;
}

/**
 * 记录**实测**装载结果（由 `apply()` 调用，是探针唯一的事实来源）。
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

  // ② CLIS 分类器在不在？
  //
  // 不在**不是错误**：CLIS 是可选增强，纯 meta 也能用。所以标 info，
  // 但必须报出来 —— 否则使用者会把"没判出因果类型"误读成
  // "这问题本来就没有因果结构"，那是完全不同的结论。
  //
  // ctx 从模块级变量取（探针拿不到参数）。**没装载时不能报"分类器缺失"** ——
  // 那会把"还没装载"说成"CLIS 没装"，又是一句假话。所以单独区分。
  let classifierOk = false;
  let probed = false;
  if (pluginCtx !== undefined) {
    try {
      classifierOk = pluginCtx.get?.('clis.causalClassifier') !== undefined;
      probed = true;
    } catch {
      classifierOk = false;
      probed = true;
    }
  }

  if (!probed) {
    findings.push({
      code: PROBE_CODES.classifierMissing,
      severity: 'info',
      message: '插件尚未装载（或宿主上下文不可用），无法确认 CLIS 分类服务状态。',
      hint: '若插件已装载仍见此条，检查它是否因加载失败而没走到 apply()。',
    });
  } else if (!classifierOk) {
    findings.push({
      code: PROBE_CODES.classifierMissing,
      severity: 'info',
      message: 'CLIS 分类服务不可用：四问作答会原样传给框架，但判不出因果类型。',
      hint: '需要因果判断时装 dsh-clis；不需要可忽略。',
    });
  }

  if (findings.length === 0) {
    findings.push({
      code: PROBE_CODES.ok,
      severity: 'info',
      message: '宿主定位正常，CLIS 分类服务可用。',
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
 * **与 dsh-clis 的 `deriveStatus` 逐字同义**（`error → failing`、
 * `warn → degraded`、否则 `ok`）。刻意不自己发明一套 —— 监督层会把多个
 * 插件的 status 汇总展示，口径不一致会导致同一个问题在不同插件的行里
 * 显示成不同颜色，读的人会以为它们严重程度不同。
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
