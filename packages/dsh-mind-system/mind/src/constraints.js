/**
 * 约束（constraint）层 —— 处境之外的第二维。
 *
 * ## 为什么单独成模块，而不是塞进 registerSignal（2026-11-03）
 *
 * dispatch 的信号只回答"**这是什么类型的工作**"（处境）；
 * 授权回答的是"**这件事允不允许做**"。两者不是一个东西：
 *
 * - 信号吃**词表**（文本里出现了什么），是文本的函数；
 * - 约束吃**外部状态**（谁发起、哪版规则、什么范围），`explainSituation(text)`
 *   的签名里根本没有状态入口 —— 硬把授权伪装成信号词，就是把状态伪装成词表。
 *
 * 本模块因此是 dispatch 的**第二入口**：`registerConstraint({ name, applies })`，
 * `applies(context) → 'allow' | 'deny' | 'unavailable'`。context 由调用方注入
 * （superagent 的 Mandate/Policy 就是它的 context）。
 *
 * ## 三级分离纪律的继承（与 situation.js 的 decision/guidance/outcome 同构）
 *
 * 每条裁决必须能分开回答三个问题，缺一格就同形：
 *
 * 1. `result` —— 约束**判**了什么（allow/deny/unavailable）
 * 2. `enforced` —— 调用方**用**了没有（evaluated 记账发生在真被查询之后）
 * 3. 约束缺席时 `admitted: false` + reason `no-constraint` —— **没在管 ≠ 允许**，
 *    这是「闸门指标须成对报」在授权侧的落点：漏放（deny 未拦）与误拒
 *    （allow 未放行）各是一侧，都必须计数。
 *
 * ## 首版是只读的
 *
 * 不参与排序、不阻断执行 —— 和 registerSignal 第一次落地同一路径：
 * 先让"谁贡献了什么约束、判了什么、有没有被用"可查询、可解释、可记账，
 * 真执法等接口生态长出来再说。
 */

/** 约束的三种裁决。unavailable = 判不了（缺上下文），既不放行也不拦。 */
export const VERDICTS = { allow: 'allow', deny: 'deny', unavailable: 'unavailable' }

/** 保守度排序的唯一实现：合成取 rank 最大的一侧。 */
const VERDICT_RANK = { [VERDICTS.allow]: 0, [VERDICTS.unavailable]: 1, [VERDICTS.deny]: 2 }
const mostConservative = (a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a)

/**
 * 评估上下文的最低要求。
 * 只强判 `origin` 有值 —— 具体形状由约束自己解释，
 * 这里不发明 superagent 的字段名（Mandate 等是它的内部概念）。
 */
function usableContext(context) {
  return context !== null && typeof context === 'object' && context.origin != null
}

const registry = new Map()

/**
 * 登记一条约束。与 registerSignal 同一语义：重名覆盖、返回注销函数。
 *
 * @param constraint `{name, owner, applies, description}`。
 *   applies 是 `(context) => verdict`；它抛错**不吞**，由 evaluate 记成 unavailable。
 * @returns 注销函数（只删自己那一次登记的，防止误删覆盖者）。
 */
export function registerConstraint(constraint) {
  const name = String(constraint?.name ?? '').trim()
  if (name.length === 0) throw new Error('约束必须有名字')
  if (typeof constraint.applies !== 'function') throw new Error(`约束「${name}」必须有 applies(context) 判定函数`)
  const entry = {
    name,
    applies: constraint.applies,
    owner: typeof constraint.owner === 'string' && constraint.owner.length > 0 ? constraint.owner : 'unknown',
    ...(typeof constraint.description === 'string' ? { description: constraint.description } : {}),
  }
  registry.set(name, entry)
  return () => {
    if (registry.get(name) === entry) registry.delete(name)
  }
}

/** 列出已登记约束（只读、不含 applies 函数本体）。 */
export function listConstraints() {
  return [...registry.values()].map(({ applies, ...rest }) => ({ ...rest }))
}

/**
 * 对一条上下文记录**逐一评估所有约束**并合成裁决 —— 评估的唯一实现。
 *
 * 合成规则 —— **取最保守的一侧**，优先级 `deny > unavailable > allow`
 * （rank 见 VERDICT_RANK，是这里的唯一实现，消费方不得各自再推）：
 *
 * - 任一 deny → deny（授权是并集里取交集：一票否决，吸收态）；
 * - 任一 unavailable 且无人 deny → unavailable —— 一条"判不了"不许被
 *   另一条侥幸的 allow 掩盖："有一环节没人真判过"不能被读成"都允许"
 *   （变异测试逼出来的：合成只写"任一 deny 即 deny"时，allow×unavailable
 *   的组合侥幸放行过一条真实样本）；
 * - 全 allow 才是 allow；
 * - 没有约束可判（空注册表或上下文不可用）→ **unavailable**，
 *   理由 `no-constraint` / `bad-context`：没在管不等于允许。
 *
 * @param context 外部状态（如 {origin: {sender, scope, mandate}}）。
 * @returns { verdict, reason, by: [逐条裁决] }
 */
export function evaluate(context) {
  const active = [...registry.values()]
  if (active.length === 0) {
    return { verdict: VERDICTS.unavailable, reason: 'no-constraint', by: [] }
  }
  if (!usableContext(context)) {
    return { verdict: VERDICTS.unavailable, reason: 'bad-context', by: [] }
  }
  const by = []
  let verdict = VERDICTS.allow
  let reason = 'all-allow'
  for (const c of active) {
    let v
    try {
      const raw = c.applies(context)
      v = VERDICTS[raw] ? raw : VERDICTS.unavailable
    } catch {
      // applies 抛错 = 判不了，不是拦下也不是放行。吞成 allow/deny 都会说谎。
      v = VERDICTS.unavailable
    }
    by.push({ name: c.name, owner: c.owner, verdict: v })
    // 合成只有一条规则：取最保守的（rank 见 VERDICT_RANK），与遍历顺序无关 ——
    // rank 只升不降，deny/unavailable 是吸收态。
    const folded = mostConservative(verdict, v)
    if (folded !== verdict) {
      verdict = folded
      reason = folded === VERDICTS.deny ? `denied-by:${c.name}` : `unavailable:${c.name}`
    }
  }
  return { verdict, reason, by }
}

/**
 * 消费侧记账：只有**真被查询过**的评估才落账。
 *
 * 落点由宿主注入（mind 用它自己的 sampling 通道；测试传数组即可）。
 * 不注入 = 不记 —— 与"评估是纯函数"分开，纯函数不碰 I/O。
 *
 * @param sink `(record) => void` 或接收 push 的数组。
 */
export function createLedger(sink) {
  const push = typeof sink === 'function' ? sink : (record) => { sink?.push?.(record) }
  return {
    /** 记一次完整评估。outcome 由**调用方**事后回填（照做没有是第三级）。 */
    record(context, evaluation, outcome) {
      push({
        at: new Date().toISOString(),
        origin: usableContext(context) ? context.origin : null,
        verdict: evaluation.verdict,
        reason: evaluation.reason,
        by: evaluation.by,
        ...(outcome !== undefined ? { outcome } : {}),
      })
    },
  }
}
