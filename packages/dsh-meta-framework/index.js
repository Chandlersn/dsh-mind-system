/**
 * dsh-meta-framework —— 把 @causal-layers/meta-framework 包装成 DSH 工具。
 *
 * 只暴露一个工具 `meta_reframe`：把一个问题重新审视一遍，给出
 * 重定义、边界、因果结构判断和候选路径。
 *
 * ## 为什么不是四个工具对应四层
 *
 * 真实任务实测（见 meta-framework 仓库 DECISIONS.md D11）：
 * 因果任务走完四层会撞回退上限转 `human_gate`。把每层都做成工具，
 * 等于把"必定转人工"这件事摊给使用者。工具面只保留真正稳的那个动作。
 *
 * ## 工具描述必须如实
 *
 * 名字与描述若写成"帮你决定怎么做"，第一次用就会失望。所以描述里
 * 明确说"这是诊断工具，不是决策工具"—— 这也让 agent 知道该在什么
 * 时机调用它（反复出问题、怀疑自己理解错了），而不是所有问题都调。
 *
 * ## CLIS 服务是复用的，不是自带的
 *
 * 因果判断需要 `clis.causalClassifier` 服务。**本插件不自带它** ——
 * 宿主里已装的 `dsh-clis` 就提供这三个服务。插件用 `ctx.get()` 去取，
 * 取到就用、取不到就退化为通用逻辑。这样：
 *   - 不重复打包一份 CLIS（省体积、避免两份实现漂移）
 *   - 装了 dsh-clis 的用户自动获得因果判断能力
 */

import { reframe, getDefineTool, TOOL_NAME, QUESTION_DOCS } from './src/tools.js';
import { createClisSession } from '@causal-layers/meta-framework';
import { healthProbe, bindContext, recordRegistration, classifyLoadError } from './src/health.js';

/** 插件名。 */
export const name = 'meta-framework';

/**
 * 健康探针（供 dsh-clis 的监督层自动发现）。
 *
 * 本插件的失败全是不报错的：CLIS 缺失只让 `causal_type: null`、
 * 宿主定位失败则工具根本不注册。没有探针的话，这些状态没人看得见。
 * 探针只读、不抛错，查两件事：宿主目录能否定位、CLIS 分类器在不在。
 */
export { healthProbe };

/**
 * 服务依赖：**必须声明 `tools`**。
 *
 * 实测报错（重启宿主后日志）：`cannot get property "tools" without inject`，
 * 插件因此未能激活（宿主报 "1 entry did not activate"）。
 *
 * Cordis 的规则：**访问任何服务属性都必须先在 inject 里声明**，
 * 哪怕那个服务一定存在。`ctx.tools` 是宿主提供的工具注册表，
 * 不声明就读不到，`ctx.tools.register()` 直接抛错。
 *
 * 注意与 meta-framework 库的 D8 区分：那条讲的是**不要写
 * `{ required: [], optional: [...] }`** —— 那个形状每个键都被当硬依赖，
 * 会让插件永不装载。这里写的是**服务名数组** `['tools']`，合法形态，
 * 且 `tools` 确实是硬依赖（没有它本插件什么也做不了）。
 *
 * CLIS 三个服务**不在此列**：它们用 `ctx.get()` 运行时探测
 * （`ctx.get` 的语义正是"取服务但不声明 inject 要求"），缺了也能装载。
 */
export const inject = ['tools'];

/**
 * 装载插件：注册 `meta_reframe` 工具。
 *
 * ## 为什么 `getDefineTool()` 要包 try/catch
 *
 * 它内部会去 DSH 安装目录 require `@deepseek-ai/dsh-tools`。若定位失败
 * （换机器、环境变量没设、安装目录结构变了），`resolveDshRoot()` 抛错 ——
 * 而这是 `apply()` 的顶层同步调用，抛出的后果是**整个插件不激活**
 * （宿主日志只报一句 "1 entry did not activate"），工具连影子都没有。
 *
 * 那是最难查的失败形态：没人知道"插件装了但没跑起来"。
 * 所以这里显式降级 —— 记一条错误日志，然后正常 return。
 * 插件存活、不注册工具，失败原因在日志里写清楚。
 *
 * ## 为什么留一个 `overrides` 参数
 *
 * 入口此前**零自动化覆盖**：29 个用例全在 tools.js / health.js，
 * 而插件唯一一次"完全不装载"的事故（`inject` 写空）恰恰发生在这里。
 * 没有接缝就没法在测试里把"宿主工具定义器加载失败"造出来 ——
 * 于是只能靠手工在真宿主里试，不可回归。
 *
 * `overrides.loadDefineTool` / `overrides.logger` 仅测试使用；生产不给，
 * 走的仍是 `getDefineTool()` 与 `ctx.logger`，行为一分不变。
 *
 * 覆盖点选在**加载器**而不是它的返回值：真实失败形态就是加载器自己抛错
 * （定位不到安装根 / dsh-tools 加载不了），测试必须能复现那一抛。
 *
 * @param ctx — Cordis 上下文。
 * @param overrides — 仅测试用的注入接缝（生产省略）。
 */
export function apply(ctx, overrides = {}) {
  // 探针拿不到 ctx（监督层是零参数调用 `exported.probe()`），
  // 所以在这里把 ctx 存进模块级变量供它读取。
  // 不这么做的话，探针查 CLIS 时 ctx 恒为 undefined，
  // 会在每台装了 dsh-clis 的机器上恒误报"分类器不可用"。
  bindContext(ctx);

  const logger = overrides.logger ?? ctx.logger?.('meta-framework');

  let defineTool;
  try {
    // 覆盖的是**加载器**而不是它的返回值：真实的失败形态就是加载器自己抛错
    // （找不到安装根 / dsh-tools 加载不了），测试必须能复现这一点。
    defineTool = (overrides.loadDefineTool ?? getDefineTool)();
  } catch (error) {
    // 插件不激活比"缺一个工具"更难排查，所以宁可活着报错。
    const reason = error instanceof Error ? error.message : String(error);
    // 把**实测**失败写进探针的事实来源 —— 探针不再自己拿文件系统推断
    // "能不能加载"（那条推断两头都能错，已实测）。
    recordRegistration(classifyLoadError(error), reason);
    logger?.error?.(`meta_reframe 未注册：无法加载宿主工具定义器。原因：${reason}`);
    return;
  }

  // 从宿主上下文探测 CLIS 三个服务。
  //
  // 每次调用都重新探测而不是装载时缓存：dsh-clis 可能比本插件晚装载，
  // 装载时探测会错过它。探测本身很轻（三次 ctx.get）。
  const session = () => {
    try {
      return createClisSession(ctx);
    } catch {
      // 宿主 ctx 形状不符（或探测抛错）等价于"服务不可用"
      return undefined;
    }
  };

  const tool = defineTool({
    name: TOOL_NAME,
    description:
      '把一个问题重新审视一遍：给出重定义、适用范围（边界）、因果结构判断与候选方向。' +
      '适用于「改了参数没效果 / 反复调整反而更糟 / 两个因素分不清谁因谁果 / 想确认自己的理解是否遗漏」这类情形。' +
      '**这是诊断工具，不是决策工具**：它帮你换一个角度看问题，不替你决定下一步做什么。' +
      '提供四问作答时会给出因果结构判断（环 / 对偶 / 单向 / 嵌套）；不提供则只做通用重定义。',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '用一句话说清你面对的**问题本身**（不是"下一步做什么"）。例：为什么调了价格需求没降。',
      },
      context: {
        type: 'string',
        description: '可选：补充上下文（已试过什么、观察到什么、有哪些约束）。',
      },
      q1: {
        type: 'string',
        enum: ['yes', 'no', 'unknown'],
        description: `可选：${QUESTION_DOCS.q1}四项都给才会做因果判断。`,
      },
      q2: {
        type: 'string',
        enum: ['yes', 'no', 'unknown'],
        description: `可选：${QUESTION_DOCS.q2}`,
      },
      q3: {
        type: 'string',
        enum: ['yes', 'no', 'unknown'],
        description: `可选：${QUESTION_DOCS.q3}`,
      },
      q4: {
        type: 'string',
        enum: ['yes', 'no', 'unknown'],
        description: `可选：${QUESTION_DOCS.q4}`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs) {
      try {
        return await reframe(rawArgs, session());
      } catch (error) {
        // 工具失败要说清是哪一环，不要把异常堆栈直接抛给 agent ——
        // 那对使用者没有信息量，且会中断整轮对话。
        return {
          error: 'meta_reframe 执行失败',
          reason: error instanceof Error ? error.message : String(error),
          hint: '若提示找不到 meta-framework，确认本插件的 dependencies 已安装。',
        };
      }
    },
  });

  ctx.tools.register(tool);
  // 走到这里才算真的注册成功 —— 探针唯一的事实来源就是这一行。
  recordRegistration('ok');
}
