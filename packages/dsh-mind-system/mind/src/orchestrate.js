/**
 * 按处境收放工具面 —— 在**不损失任何能力**的前提下，让工具面跟着当下的问题走。
 *
 * ## 为什么要做这件事，以及为什么不能做"卸载"
 *
 * 工具全平铺在提示里有两个代价：token 常驻、注意力被稀释。直觉的解法是
 * "用不到的就不给它看"，但那条路在本宿主上是**危险**的：
 *
 * - 工具只有出现在声明里，模型才知道它叫什么；藏掉之后它连"想问"的机会都没有
 * - `tools.restrict()` 才是让工具**不可调用**的官方口子；只改装配结果
 *   属于"看不见但仍注册"，语义含糊，不该拿来当卸载
 *
 * 所以这里做两件**可逆**的事，都不减少能力：
 *
 * 1. **重排**：把与当前处境同族的工具排到前面（纯顺序，无副作用）
 * 2. **延后载入**（可选，缺省关）：给异族工具打 `deferLoading: true` ——
 *    这是宿主自己的原语（"Requests deferred loading of the tool definition
 *    into model context"），由 `tool-addition` 块按需激活，
 *   工具**只是不常驻声明**，并没有消失
 *
 * ## 处境的来源与那一拍延迟
 *
 * 处境取自 `agent/pre-step` 的 `payload.messages`（那是唯一能看到本轮
 * 用户输入的地方）。但宿主 `preStep()` 的次序是：
 *
 * ```
 * :907  assemble()          ← 装配先发生
 * :909  agent/pre-step      ← 处境后发生
 * ```
 *
 * 也就是说，第 N 步读到的处境会作用在第 N+1 步的工具面上。这是**结构性的**
 * 而非缺陷：memory-manager 的召回注入、clis 的提示注入都遵循同一时序。
 * 写在这里是为了让后来者不要试图"修"它 —— 那需要改动宿主时序。
 *
 * ## 一条硬约束：core 永远不动
 *
 * 文件、shell、搜索、任务清单这类工具是任何处境都可能需要的。它们**永不**被
 * 重排到后面，也永不被打 deferLoading。判断标准不是"现在用不用得上"，
 * 而是"这个处境里如果突然要用，藏了它会不会把人卡住"。
 *
 * ## 失败时的行为
 *
 * 任何一步出错都原样返回装配结果 —— 工具面是主干道，这里的增强
 * 绝不能让它中断。
 */

/**
 * 处境模式。
 *
 * 分四类而不是更多：每多一类就多一份判据、多一处会判错的地方，
 * 而工具面重排的收益随分类变细迅速衰减。
 */
export const SITUATIONS = {
  /** 解法未知、反复无效、分不清因果 —— 该先判结构。 */
  diagnose: 'diagnose',
  /** 知道要做什么，只差动手改 —— 该直接执行。 */
  execute: 'execute',
  /** 涉及既有约定/踩过的坑 —— 该先查记忆。 */
  recall: 'recall',
  /** 需要外部事实 —— 该先取信息。 */
  retrieve: 'retrieve',
  /** 判不出来就什么都不做，保持默认顺序。 */
  unknown: 'unknown',
};

/**
 * 处境 → 该优先的工具族（前缀匹配）。
 *
 * 前缀是稳定的工具命名约定：`clis_`/`meta_` 是判结构的，`memory_` 是记忆的，
 * 检索类工具没有统一前缀，按名字列举。
 *
 * ## ⚠️ execute 族曾经整族是死代码（2026-11-02 对抗式审查修）
 *
 * 旧值：`['pwsh','read','edit','write','glob','grep']`。
 *
 * 但这六个**全是 core 工具**，而 `rank()` 先判 core：
 *
 * ```js
 * const rank = (tool) => {
 *   if (isCoreTool(name)) return 1;      // ← core 先判
 *   return isRelevant(name) ? 0 : 2;     // ← 族永远进不了 0
 * };
 * ```
 *
 * 于是 execute 族**一个成员都进不了 rank 0** —— 该处境的重排与 unknown
 * 完全相同。实测：execute 重排后首位是 `read`（core），而"动手工具排最前"
 * 这个意图从未成立过。
 *
 * 修法：**core 工具本来就在第 1 档，不需要在族里再写一遍**。execute 的真实
 * 意图是"把动手类工具**排在非动手工具之前**"，而 core 恰恰已经做到了这一点。
 * 所以 execute 族改为**只列 core 之外、仍属动手类的工具**。
 *
 * 宿主里这类工具的真实名字（见 dsh-tool-* 包）：
 * `str_replace_editor`（编辑）、`file_reference`（文件引用）、
 * `cordis`（宿主命令）、`bash`/`terminal`（终端）。
 *
 * 若某个前缀在本机不存在，族退化为"无额外成员" —— execute 就等于"把非 core
 * 推后"，这仍然是一个有意义且可观测的行为（不是空转）。
 */
const PRIORITY_FAMILIES = {
  diagnose: ['clis_', 'meta_'],
  execute: ['str_replace_editor', 'file_reference', 'cordis', 'bash', 'terminal'],
  recall: ['memory_'],
  retrieve: ['web_search', 'web_fetch', 'advanced_search', 'multi_search', 'platform_search', 'domain_search'],
};

/**
 * 任何处境都必须在场的工具（前缀或全名）。
 *
 * 判据："如果这个处境里突然要用它，藏了会不会把人卡住"。会，就留。
 * 这些工具**既不被重排到后面，也不被打 deferLoading**。
 */
const CORE_TOOLS = [
  'pwsh',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'present',
  'todo_write',
  'ask_user_question',
  'list_agents',
  'send_message',
  'team_task_',
  'workflow',
  'subagent',
];

/**
 * 判断某工具是否属于核心集。
 *
 * 前缀匹配要小心：`read_image`（视觉）不该被当成 `read`（文本）。这里用
 * "全名相等 或 以 `前缀 + 分隔符` 开头"两条，不用裸 `startsWith`，
 * 避免把无关工具误判成核心。
 *
 * @param name 工具名。
 * @returns 是核心则为 true。
 */
export function isCoreTool(name) {
  for (const core of CORE_TOOLS) {
    if (name === core) return true;
    // `team_task_` 这类明显是前缀族，用下划线续接；其余要求精确相等，
    // 免得 `read_image` 被 `read` 捞进来。
    if (core.endsWith('_') && name.startsWith(core)) return true;
  }
  return false;
}

/**
 * 从一批消息里判处境。
 *
 * **只读最后一条 user 消息**：往前的历史会带上早已解决的老问题，
 * 用它判处境等于让几十步之前的状态决定现在看得到什么。
 *
 * 判据用**症状词**而不是任务类型：agent 能观察到的就是自己眼前这些话，
 * "这是个重构任务"这种判断它做不出来，也不该在这里做。
 *
 * @param messages 本步的入站消息。
 * @returns 处境代号（判不出返回 unknown）。
 */
export function classifySituation(messages) {
  if (!Array.isArray(messages)) return SITUATIONS.unknown;

  let text = '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (text.length > 0) break;
  }
  if (text.length === 0) return SITUATIONS.unknown;

  const has = (words) => words.some((w) => text.includes(w));

  // 顺序即优先级：诊断信号最强（反复无效本身就是"别再来一次"），
  // 其次是"要外部事实"（明确），再是记忆，最后才是默认执行。
  if (
    has(['没效果', '无效', '越调越糟', '还是不行', '反复', '震荡', '弹回来', '谁因谁果', '判一下', '因果结构'])
  ) {
    return SITUATIONS.diagnose;
  }
  if (has(['搜一下', '查一下网上', '最新', '外部', '文档', '资料', '论文', '版本'])) {
    return SITUATIONS.retrieve;
  }
  if (has(['以前', '上次', '之前说', '约定', '踩过', '记得', '记忆', '历史'])) {
    return SITUATIONS.recall;
  }
  if (has(['改', '修', '写', '跑', '执行', '加', '删', '安装', '部署'])) {
    return SITUATIONS.execute;
  }
  return SITUATIONS.unknown;
}

/**
 * 取某处境优先族的**前缀清单**（只读）。
 *
 * ## 为什么对外暴露这个
 *
 * 诊断要判断"模型用的工具是不是我推到前面的那一族"。如果诊断自己再写一份
 * 族清单，两份就会漂移 —— 改了排序、忘了改诊断，于是诊断开始谎报
 * "已照做"。判据只能一处实现，展示层只读不判。
 *
 * @param situation 处境代号。
 * @returns 前缀数组；未知处境返回空数组（= 没有可被"照做"的对象）。
 */
export function familyOf(situation) {
  return PRIORITY_FAMILIES[situation] ?? [];
}

/**
 * 判断某工具名是否属于某处境的优先族（与 `arrangeTools` 同一判据）。
 *
 * @param situation 处境代号。
 * @param name 工具名。
 * @returns 属该族则为 true。
 */
export function isFamilyTool(situation, name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return familyOf(situation).some((p) => name.startsWith(p));
}

/**
 * 按处境给工具面排序（并把异族工具打上 deferLoading，可选）。
 *
 * ## 为什么不删元素
 *
 * 只**重排**，绝不 `filter` 掉任何一个 schema。理由是能力安全：
 * 少了声明，模型连工具名都看不到；而重排只影响注意力顺序，
 * 任何工具都还在，随时可调。
 *
 * `park` 打开时给异族工具打 `deferLoading: true` —— 那也是"声明仍在、
 * 载入延后"，由宿主按需激活，不是删除。
 *
 * @param tools 装配里的工具 schema 列表。
 * @param situation 处境代号。
 * @param options `park` 为 true 时给异族工具打 deferLoading。
 * @returns 重排后的新列表（不改入参）。
 */
export function arrangeTools(tools, situation, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const priority = PRIORITY_FAMILIES[situation];
  if (priority === undefined) return tools; // unknown：保持默认，什么都不做

  const park = options.park === true;
  const isRelevant = (name) => priority.some((p) => name.startsWith(p));

  // 三段排序：相关族 → 核心 → 其余。核心排在相关族之后，
  // 是为了让"当下最该看的东西"真的在最前面，而不是被通用工具淹没。
  const rank = (tool) => {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (isCoreTool(name)) return 1;
    return isRelevant(name) ? 0 : 2;
  };

  return tools
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => rank(a.tool) - rank(b.tool) || a.index - b.index)
    .map(({ tool }) => {
      const name = typeof tool?.name === 'string' ? tool.name : '';
      // 核心工具永不打 deferLoading：藏它可能把人卡住。
      if (!park || isCoreTool(name) || isRelevant(name)) return tool;
      return { ...tool, deferLoading: true };
    });
}