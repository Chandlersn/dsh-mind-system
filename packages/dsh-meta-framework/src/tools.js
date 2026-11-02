/**
 * meta-framework 的 DSH 工具实现。
 *
 * ## 为什么只暴露一个工具 `meta_reframe`
 *
 * 真实任务测试（DECISIONS.md D11）证明：这套框架**擅长诊断结构**，
 * 但不擅长给可执行方案 —— 三个因果任务全部卡在 `human_gate`。
 *
 * 所以工具面不该照搬四层流程，而应该只暴露它真正有价值的那个动作：
 * **重新审视**（redefine + customize + 因果结构判断），把
 * `select`/`observe` 的结果作为附注给出，而不是当作可执行的下一步。
 *
 * 如果把它包装成"帮你选方案"的工具，使用者第一次用就会撞上 human_gate，
 * 那比不提供更伤。工具的名字与描述必须如实反映它擅长什么。
 *
 * ## 为什么不直接 `run()`
 *
 * `run()` 会走完整四层，因果任务上必定撞回退上限转人工。这里改走
 * 分步调用：`redefine` → `customize` → `select`，拿到结构判断就停，
 * **不进入 observe 的回退循环**。这样工具输出稳定、每次都可用。
 *
 * ## 但 trace 仍然必须写
 *
 * 分步调用绕过了 `run()`，而 `writeTrace()` 只在 `run()` 里被调用 ——
 * 于是工具路径上原本**一条 trace 都不落**（实测：连调三次后全盘搜不到
 * 任何 `meta-*.json`）。这等于"每次运行都可回放"这个承诺在工具路径上失效。
 *
 * 所以这里自己拼一条 trace 并落盘。字段按 `MetaTrace` 契约填满 10 个：
 * 没走 observe，故 `execution` / `change` 为 null、`rollback_count` 为 0 ——
 * **如实反映"这次只做了诊断，没有执行"**，而不是编造执行结果。
 */

import { loadHost } from './host.js';

/** 缓存 meta-framework 模块。 */
let metaModule;

/**
 * 加载 meta-framework 库。
 *
 * 它是本插件自己的 dependencies（不是宿主包），所以用普通的动态 import。
 * 之所以做成函数：工具执行时才加载，插件装载阶段不受它影响。
 *
 * @returns meta-framework 模块。
 */
async function getMeta() {
  if (metaModule === undefined) {
    metaModule = await import('@causal-layers/meta-framework');
  }
  return metaModule;
}

/**
 * 写一条 trace。
 *
 * 单独抽出来是为了让 `reframe()` 读起来是一条直线（诊断 → 落盘 → 返回），
 * 也方便测试注入临时目录。
 *
 * @param trace — trace 内容。
 * @param options — 落盘配置。
 * @returns 落盘结果（永不抛错，失败体现在 `ok: false`）。
 */
async function writeTrace(trace, options = {}) {
  const meta = await getMeta();
  return meta.writeTrace(trace, options);
}

/** 四问在工具参数里的键名 → 契约 `FourAnswers` 的字段名。 */
const ANSWER_KEYS = {
  q1: 'q1_simultaneous_mutual_definition',
  q2: 'q2_delayed_mutual_influence',
  q3: 'q3_strict_irreversible_order',
  q4: 'q4_coexisting_causal_structures',
};

/**
 * 契约承认的四种**确定**因果类型。
 *
 * 与 `dsh-clis` 的 `KNOWN_CAUSAL_TYPES` 一致（`structural_duality` /
 * `cyclic` / `unidirectional` / `nested`），另加 `unknown` ——
 * `unknown` 是合法的**结论**（"不属于已知结构"），但不是可执行类型，
 * 契约的 `FAMILY_BY_TYPE` 不覆盖它。
 *
 * ## 为什么需要这份白名单
 *
 * 库的 `isUsableCausalType()` 只判 `causalType !== 'unknown'` ——
 * **任何非 unknown 的字符串都算数**，包括 `'totally_made_up_type'`。
 *
 * 后果有两处：
 *
 * 1. `clis_used: true` + note 把它当结论呈现 —— 垃圾输出被当成"CLIS 干成了"
 * 2. `meta.customize(definition)` 里 `FOCUS_BY_TYPE[causalType]` 是 `undefined`
 *    → **解构时抛错**（`const { focus, criterion } = undefined`）
 *
 * 第 2 条是真实故障：分类器返回一个越界类型，工具就整个炸掉，
 * 而这条路径 `reframe()` 会向上传播（`customize()` 在 try 之外）。
 *
 * 所以本插件对分类器返回的类型做**白名单校验**：
 * 不在表内的类型不当成"判出了类型"，而是当成**离契约的返回值**如实报出来。
 */
export const KNOWN_CAUSAL_TYPES = [
  'structural_duality',
  'cyclic',
  'unidirectional',
  'nested',
];

/** `unknown`：合法的结论，但**不是**可执行类型（契约 `FAMILY_BY_TYPE` 不覆盖它）。 */
export const UNKNOWN_CAUSAL_TYPE = 'unknown';

/**
 * 判断一个因果类型是否在契约承认的范围内。
 *
 * @param causalType — 分类器返回的类型。
 * @returns 是则返回该类型（`unknown` 也返回），否则 undefined。
 */
export function knownCausalType(causalType) {
  if (causalType === UNKNOWN_CAUSAL_TYPE) return UNKNOWN_CAUSAL_TYPE;
  return KNOWN_CAUSAL_TYPES.includes(causalType) ? causalType : undefined;
}

/** 四问的说明文本（工具参数用）。 */
export const QUESTION_DOCS = {
  q1: 'Q1：A 与 B 是否同时成立、彼此定义、且无时间先后？（对偶，如正与反、买与卖）',
  q2: 'Q2：是否存在带时间延迟的相互影响（A→B→A，可能振荡）？（环，如供需-价格）',
  q3: 'Q3：是否 A→B 严格先后且不可逆？（单向，如火→热）',
  q4: 'Q4：系统中是否同时存在多种因果结构（需拆子模块）？（嵌套）',
};

/**
 * 把工具参数转成 `ProblemContext`，同时**如实报告作答的完整度**。
 *
 * 四问作答**只在四项都给全时**才构造 `causal_answers` —— 契约规定
 * 判据只由作答决定，缺一不可；给不全就不传，让框架如实走通用逻辑
 * （而不是拿半份作答去猜类型）。
 *
 * ## 为什么要把"缺哪几项"带出来
 *
 * 上一版只返回 `answered: boolean`，于是"一项没给"与"给了三项、差第四项"
 * 在输出里**完全同形**，note 还会说"未提供四问作答"。
 * agent 读到那句会以为自己没填，而不会去补那一项 —— 它被自己的工具误导了。
 *
 * 所以这里额外返回 `missing`：究竟缺哪几问。note 据此给出可执行的补救。
 *
 * @param args — 工具参数。
 * @returns `{ problem, submitted, missing }`。
 */
function toProblem(args) {
  const answers = {};
  const missing = [];
  let submitted = 0;
  for (const [short, full] of Object.entries(ANSWER_KEYS)) {
    const value = args[short];
    if (value === 'yes' || value === 'no' || value === 'unknown') {
      answers[full] = value;
      submitted += 1;
    } else {
      missing.push(short);
    }
  }

  // 问题标识：用时间戳保证 trace 文件名不冲突，也让使用者能按时间找。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const problem = {
    problem_id: `meta-${stamp}`,
    description: args.description,
  };

  if (typeof args.context === 'string' && args.context.length > 0) {
    problem.context = args.context;
  }

  // 四问齐全才声明"这是因果问题"：少一项都不足以让 classify 有判据。
  if (submitted === 4) {
    problem.suspected_causal = true;
    problem.causal_answers = answers;
  }

  return { problem, submitted, missing };
}

/**
 * 跑"重新审视"：redefine → customize → select，**不进 observe 循环**。
 *
 * ## 为什么必须传 session
 *
 * `redefine(problem)` 不带第二参数时，`session` 为 undefined，
 * 框架**永远不会调用 classify** —— 四问作答给得再全也判不出因果类型。
 * （实测：不传 session 时 `causal_type` 恒为 null，看起来像"判断失败"，
 * 实际是"根本没去问"。）
 *
 * 所以接受一个 `session`（由插件从宿主 ctx 建好后传入）。
 * 拿不到 CLIS 服务时如实退化为通用逻辑，不假装判过。
 *
 * @param args — 工具参数。
 * @param session — CLIS 会话（可选）；缺省表示 CLIS 全不可用。
 * @param traceWriteOptions — trace 落盘配置（测试用于指定临时目录）。
 * @returns 结构化的审视结果。
 */
export async function reframe(args, session, traceWriteOptions = {}, clisUnavailableReason = undefined) {
  const meta = await getMeta();
  const { problem, submitted, missing } = toProblem(args);

  // ① 重定义（有 session 且作答齐全时才会真的调 classify）
  const { definition } = await meta.redefine(problem, session);

  // ② 边界
  //
  // ## 为什么这里要挡住"离契约的类型"
  //
  // 库的 `customize()` 里是 `FOCUS_BY_TYPE[causalType]` 的解构 ——
  // 而 `FOCUS_BY_TYPE` 只有四种确定类型 + unknown。
  // 分类器若返回 `'totally_made_up_type'`（库的 `isUsableCausalType()` 只判
  // `!== 'unknown'`，所以这种值能一路混进来），这里就会
  // `const { focus, criterion } = undefined` → **抛 TypeError**，
  // 而 `customize()` 不在 try 里 → 整个工具炸掉。
  //
  // 所以先校验类型，**离契约就当没判出**（并在 note 里如实说）。
  const rawCausalType = definition.causal_type_hint;
  const validatedType = rawCausalType === undefined ? undefined : knownCausalType(rawCausalType);
  const offContractType = rawCausalType !== undefined && validatedType === undefined ? rawCausalType : undefined;

  /** 交给下游的 definition：离契约的类型不能让 customize() 撞上。 */
  const safeDefinition =
    offContractType === undefined
      ? definition
      : { ...definition, causal_type_hint: undefined };

  const boundary = meta.customize(safeDefinition);

  // ③ 候选（只取排序结果，不执行）
  const ranked = await meta.select(safeDefinition, boundary, session);

  const candidates = ranked.slice(0, 3).map((item) => ({
    path_id: item.path.path_id,
    description: item.path.description,
    source: item.path.source,
    score: item.score,
    rank: item.rank,
  }));

  // 区分**五种**"没判出类型"的情形 —— 它们的含义完全不同，
  // 尤其是最后三种：一个是"这问题不属于已知结构"（结论），
  // 另外两个是"分类器坏了"（故障）。把故障说成结论就是在撒谎。
  //
  //   a) 一项都没给                 → 请补作答
  //   a') 给了一部分（缺 1–3 项）   → 请补上**具体缺的那几项**
  //   b) 给了但 CLIS 服务不可用       → 说清**真实**原因（装 clis-* 还是查询抛错）
  //   c) 给了、服务在，但分类器抛错/返回空 → **故障**，不是结论
  //   d) 给了、服务在、分类器正常返回 unknown → 结论：不属于已知四种
  //   e) 给了、服务在、但返回**离契约的类型** → 故障（不是结论），且工具不能炸
  const answered = problem.causal_answers !== undefined;
  const clisAvailable = session !== undefined && session.hasClassifier;

  // `clis_used` 取库自己的记账（`session.clisUsed`），**不是**"有没有类型"。
  //
  // 差别在 unknown：库里 `markUsed()` 在**分类调用成功**时就置位，
  // 哪怕结论是 unknown（源码 redefine.js：「调用成功即记一次使用 ——
  // 即使结论是 unknown，那也是分类器给出的结论」）。所以 unknown 时
  // 库的语义是 `clis_used = true`，而 `causalType !== undefined` 会给出 false。
  //
  // 这个字段会被读 trace 的人当作"当时到底问没问 CLIS"，
  // 用错判据会让历史记录撒谎。所以优先取库的记账，拿不到才回退。
  //
  // **但离契约的类型要单独处理**：库的记账说"调用成功了"，
  // 而返回的是 `'totally_made_up_type'` —— 那不是"CLIS 干成了"，
  // 那是"CLIS 返回了垃圾"。报 `clis_used: true` 会把垃圾粉饰成结论。
  // 所以离契约时 `clis_used` 报 false，并在 note 里说清**返回了什么**。
  const libraryMarkedUsed =
    session !== undefined && typeof session.clisUsed === 'boolean' ? session.clisUsed : undefined;
  const clisUsed =
    offContractType !== undefined ? false : libraryMarkedUsed ?? validatedType !== undefined;

  // 分类器"调用失败"的判据：服务在、作答给了、但库没记上使用 ——
  // 说明 safeClassify 抛错或拿到空结果，库在 redefine.js 里 return 了 generic。
  //
  // 这个区分很关键：库里 unknown 是**成功**（会 markUsed），
  // 失败则不会 markUsed。所以 `answered && clisAvailable && !clisUsed`
  // 精确对应"调了但没成"。
  const classifierFailed = answered && clisAvailable && !clisUsed;

  let note;
  if (validatedType !== undefined && validatedType !== UNKNOWN_CAUSAL_TYPE) {
    note =
      `因果结构判为「${validatedType}」。候选路径仅作参考——本框架擅长诊断结构，` +
      '不擅长给可执行步骤，请据此自行决策。';
  } else if (offContractType !== undefined) {
    // 离契约的类型：**如实报出收到了什么**，并说清这不是一个可用结论。
    // 不能说成"unknown"（那是谎话：那等于把"分类器返回垃圾"说成
    // "这问题不属于已知结构"，使用者会因此放弃一个本来能判出来的问题）。
    note =
      `CLIS 分类器返回了契约之外的类型「${offContractType}」，本次**没有拿到可用的因果结论**——` +
      '这不代表这个问题不属于已知的四种结构，而是分类器的返回值不在契约允许的范围内' +
      `（${KNOWN_CAUSAL_TYPES.join(' / ')}）。请检查分类器实现。`;
  } else if (!answered && submitted === 0) {
    note = '未提供四问作答，本次只做通用重定义与候选排序；因果结构未经判断。补全 q1–q4 可得到结构判断。';
  } else if (!answered) {
    // 一部分作答被丢弃时必须说清楚：上一版这里与"一项没给"同文案，
    // agent 会以为自己没填，从而不会去补那一项。
    note =
      `已收到 ${submitted} 项四问作答（${missing.map((k) => k.toUpperCase()).join('、')} 未给），` +
      '但因果判断要求四项齐全，本次**这 '+submitted+' 项已被忽略**，只做了通用重定义与候选排序。' +
      `补上 ${missing.map((k) => k.toUpperCase()).join('、')} 即可得到结构判断。`;
  } else if (!clisAvailable) {
    // **说真实的原因**，不说"未安装 clis-classifier"。
    //
    // 上一版这里无条件写死"（未安装 clis-classifier）"—— 而插件入口
    // 那一层把**所有**建会话失败都压成"没有 session"，于是
    // "建会话时抛了"也被说成"没装"。那是一句**具体但可能是假**的断言，
    // 排查方向完全相反。
    //
    // 现在入口把真实原因带进来（`clisUnavailableReason`）：
    // 有原因 → 说原因；没原因（真的是"服务不存在"）→ 才说"未安装"。
    note =
      clisUnavailableReason === undefined
        ? '已提供四问作答，但 CLIS 分类服务不可用（未安装 clis-classifier），故未做因果判断。'
        : `已提供四问作答，但 CLIS 分类服务不可用，故未做因果判断。真实原因：${clisUnavailableReason}——` +
          '这不是"未安装"的结论，请按上面的原因排查宿主集成。';
  } else if (classifierFailed) {
    // 故障 ≠ 结论。这句话必须与 unknown 那句明确分开，否则使用者会以为
    // "这问题本来就没有因果结构"，从而放弃一个本来能判出来的问题。
    note =
      '已提供四问作答，CLIS 服务也在，但分类器调用失败（抛错或返回空）——' +
      '本次**没有拿到因果结论**，不代表这个问题不属于已知的四种结构。请检查分类器实现或重试。';
  } else {
    note = '已提供四问作答且 CLIS 正常工作，结论为 unknown —— 这个问题不属于已知的四种结构。';
  }

  // ④ 落 trace。
  //
  // 分步调用绕过了 run()，而 writeTrace() 只在 run() 里被调用 ——
  // 于是工具路径上一条 trace 都不落（实测：连调三次后全盘搜不到任何
  // meta-*.json）。这与框架"每次运行都可回放"的承诺不符，所以这里自己写。
  //
  // 字段如实填：没走 observe，故 execution / change 为 null、
  // rollback_count 为 0 —— 反映"这次只诊断、没执行"，不编造执行结果。
  const ts = new Date().toISOString();
  const traceWrite = await writeTrace(
    {
      problem_id: problem.problem_id,
      definition: safeDefinition,
      boundary,
      // 只取了候选、没有"选中并执行"，故 selected_path 取排序第一名作为
      // **诊断推荐**，而不是"已选中的执行路径"。
      //
      // 用 `ranked[0]?.path ?? null` 而不是先判 candidates —— 两者等价
      // （candidates 就是 ranked 的切片），但 ?. 一眼能看出越界安全。
      selected_path: ranked[0]?.path ?? null,
      execution: null,
      change: null,
      clis_used: clisUsed,
      gate: { insight_gate: 'pending', macro_gate: 'n/a' },
      rollback_count: 0,
      ts,
    },
    traceWriteOptions,
  );

  return {
    problem_id: problem.problem_id,
    /** 重定义后的定义；缺省表示维持原定义。 */
    reframed: definition.new_definition ?? null,
    original_definition: definition.original_definition,
    boundary_declaration: definition.boundary_declaration,
    redefine_reason: definition.redefine_reason,
    /** CLIS 判出的因果类型；未判出时为 null。 */
    causal_type: validatedType ?? null,
    /**
     * 分类器返回的**离契约**类型（不在四种已知类型里，也不是 unknown）。
     *
     * 报出来而不是吞掉：它是"分类器实现有问题"的直接证据。
     * 为 null 时表示分类器没返回类型，或返回的是契约内的类型。
     */
    off_contract_type: offContractType ?? null,
    /** 四问是否给全了。 */
    answered,
    /** 给了几项（0–4）；与 `answered` 配合才能区分"没给"和"给不全"。 */
    answers_submitted: submitted,
    /** 缺哪几项（`q1`–`q4`）；空数组表示齐全或一项没给（看 `answers_submitted`）。 */
    answers_missing: missing,
    /** CLIS 分类服务是否可用。 */
    clis_available: clisAvailable,
    /**
     * CLIS 不可用的**真实原因**（字符串）；可用时为 null。
     *
     * 上一版把"不可用"压成一个布尔量，于是 note 只能写死
     * "（未安装 clis-classifier）" —— 而"建会话时抛了"也被说成"没装"。
     * 这里把原因单独给出来，调用方能据此选排查方向（查安装 vs 查宿主集成）。
     */
    clis_unavailable_reason: clisAvailable ? null : (clisUnavailableReason ?? null),
    /** 本次是否真的拿到了因果判断。 */
    clis_used: clisUsed,
    success_criteria: boundary.success_criteria,
    forbidden_actions: boundary.forbidden_actions,
    candidates,
    /**
     * trace 落盘结果。
     *
     * 把路径交给使用者/agent，让它知道"这次调用有据可查"；
     * 落盘失败也如实说（`ok: false`），不静默吞掉 ——
     * 与框架 `trace_write_failed` 的口径一致。
     */
    trace: {
      written: traceWrite.ok,
      path: traceWrite.path,
      ...(traceWrite.error !== undefined ? { error: traceWrite.error } : {}),
    },
    note,
  };
}

/** 工具名。 */
export const TOOL_NAME = 'meta_reframe';

/**
 * 取 `defineTool`。
 *
 * 从宿主侧加载，不能直接 import（插件的 node_modules 里没有它）。
 *
 * @returns defineTool 函数。
 */
export function getDefineTool() {
  return loadHost('@deepseek-ai/dsh-tools').defineTool;
}
