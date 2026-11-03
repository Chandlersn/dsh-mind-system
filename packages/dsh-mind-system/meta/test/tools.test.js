/**
 * 工具逻辑测试（不需要宿主）。
 *
 * 测的是 `reframe()` 的行为，不是 Cordis 装载 —— 那是另一回事，
 * 得在真宿主里验。
 *
 * 重点：本地跑通不代表真宿主里能用。这里只能证明"参数转换与输出结构正确"，
 * 装载、工具注册、agent 能否看到，都必须在真宿主里验（见 README 的验证步骤）。
 *
 * ## 为什么这里用 mock classifier
 *
 * 真实的 `clis.causalClassifier` 由宿主的 `dsh-clis` 插件提供，不在本插件的
 * dependencies 里（刻意如此：不重复打包一份 CLIS）。所以测试里用一个
 * 最小 classifier 直接验证"给了 session 就会真的走因果判断"这条链路。
 *
 * 这里刻意用**真实分类逻辑**（把四问映射到类型），而不是 `return 'cyclic'`
 * 的空壳 —— 空壳会让"参数是否真的传到了分类器"这件事测不出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClisSession } from '@causal-layers/meta-framework';
import { reframe, TOOL_NAME, QUESTION_DOCS } from '../src/tools.js';
import { decideType } from './clis-rule.js';

/**
 * 造一个临时 trace 目录。
 *
 * 必须每次新建：测试若共用目录，"文件数恰好 1 个"这类断言会互相干扰，
 * 而且残留文件会让"落盘失败"用例误通过。
 *
 * @returns 临时目录绝对路径。
 */
function makeTraceDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-meta-trace-'));
}

/**
 * 一个最小的分类器：按四问判定类型。
 *
 * ## 为什么用 `decideType()` 而不是手写规则
 *
 * 上一版在这里**手写**了一份规则：
 *
 * ```js
 * q4 ? nested : q2 ? cyclic : q1 ? duality : q3 ? unidirectional : unknown
 * ```
 *
 * 那份规则在"两个以上 yes"时**全错**（短路取第一个），
 * 而真实 CLIS 的规则是"两个以上 yes ⇒ nested（结构冲突）"。
 * 实测 81 种组合里 **14 种**给出不同结论 —— 而测试还全绿。
 *
 * 现在直接调用 `test/clis-rule.js` 里的 `decideType()`，
 * 那是真实规则的**忠实复刻**，并由 `test/clis-rule.test.js` 用
 * **穷举 81 种组合**与真实现逐条比对把住 —— 两者不可能再漂。
 *
 * 规则本身（来自 `dsh-clis/chunk-2HMO3QIV.js` 的 `decide()`）：
 *   Q4=yes → nested
 *   Q4≠yes 且 Q1..Q3 恰好一个 yes → 那个类型
 *   Q4≠yes 且 Q1..Q3 两个以上 yes → nested（结构冲突）
 *   没有 yes → unknown
 */
function makeClassifier() {
  return {
    async classify(problem) {
      const type = decideType(problem.answers);
      return { causal_type: type, confidence: 0.9, rationale: 'mock', evidence: [] };
    },
  };
}

/** 造一个带 classifier 的会话。 */
function sessionWithClassifier() {
  return new ClisSession({ classifier: makeClassifier() });
}

test('工具名稳定（改名字会让 agent 里已有的调用失效）', () => {
  assert.equal(TOOL_NAME, 'meta_reframe');
});

test('四问说明齐全（缺一项就无法引导使用者作答）', () => {
  for (const key of ['q1', 'q2', 'q3', 'q4']) {
    assert.ok(QUESTION_DOCS[key], `缺少 ${key} 的说明`);
    assert.ok(QUESTION_DOCS[key].length > 10, `${key} 的说明太短`);
  }
});

test('只给描述（无四问）：走通用逻辑，不编造因果类型', async () => {
  const out = await reframe({ description: '为什么调了价格需求没降' }, undefined, { root: makeTraceDir() });

  assert.equal(out.causal_type, null, '没作答就不能有因果类型');
  assert.equal(out.answered, false);
  assert.equal(out.clis_used, false);
  assert.ok(out.problem_id.startsWith('meta-'), 'problem_id 应带可追溯前缀');
  assert.ok(out.original_definition.includes('价格'), '原定义必须原样保留');
  assert.ok(Array.isArray(out.candidates) && out.candidates.length > 0, '至少给一条候选');
  assert.ok(out.note.includes('未提供四问作答'), 'note 要说明本次没做因果判断');
});

test('四问给全 + CLIS 可用：真的判出 cyclic', async () => {
  const out = await reframe(
    {
      description: '为什么我干预之后，问题反而反复出现',
      q1: 'no',
      q2: 'yes',
      q3: 'no',
      q4: 'no',
    },
    sessionWithClassifier(),
    { root: makeTraceDir() },
  );

  assert.equal(out.causal_type, 'cyclic', 'Q2=yes 应判为环');
  assert.equal(out.clis_used, true);
  assert.equal(out.clis_available, true);
  assert.ok(out.note.includes('cyclic'), 'note 应点出判出的类型');
  assert.ok(out.note.includes('不擅长给可执行步骤'), 'note 必须声明它不是决策工具');
});

test('四问给全但 CLIS 不可用：如实说"服务不可用"，不说"不是因果问题"', async () => {
  const out = await reframe(
    {
      description: '为什么我干预之后，问题反而反复出现',
      q1: 'no',
      q2: 'yes',
      q3: 'no',
      q4: 'no',
    },
    undefined, // 没有 session
    { root: makeTraceDir() },
  );

  assert.equal(out.causal_type, null);
  assert.equal(out.answered, true, '作答是给了的');
  assert.equal(out.clis_available, false);
  assert.ok(out.note.includes('不可用'), 'note 要说清是服务不可用');
});

test('四问只给一部分：不传作答（缺一不可），不猜', async () => {
  const out = await reframe(
    {
      description: '为什么我干预之后，问题反而反复出现',
      q1: 'no',
      q2: 'yes',
      // q3 q4 缺失
    },
    sessionWithClassifier(),
    { root: makeTraceDir() },
  );

  assert.equal(out.causal_type, null, '作答不全就不能做因果判断');
  assert.equal(out.answered, false);
});

test('部分作答必须如实报告缺哪几项（不能与"一项没给"同形）', async () => {
  // 上一版这里只给 answered:false，note 还说"未提供四问作答" ——
  // agent 会以为自己没填，而不会去补 q3/q4。它被自己的工具误导了。
  const out = await reframe(
    {
      description: '为什么我干预之后，问题反而反复出现',
      q1: 'no',
      q2: 'yes',
      // q3 q4 缺失
    },
    sessionWithClassifier(),
    { root: makeTraceDir() },
  );

  assert.equal(out.answers_submitted, 2, '要报告收到了几项');
  assert.deepEqual(out.answers_missing, ['q3', 'q4'], '要报告缺哪几项');
  assert.ok(
    out.note.includes('Q3') && out.note.includes('Q4'),
    `note 必须点名缺的项（否则不知道补什么），实际：${out.note}`,
  );
  assert.ok(out.note.includes('已被忽略'), `note 必须说清已给的作答被忽略，实际：${out.note}`);
  assert.ok(
    !out.note.includes('未提供四问作答'),
    `不能把"给不全"说成"未提供"，实际：${out.note}`,
  );
});

test('一项没给时才说"未提供"（两种情形文案必须分开）', async () => {
  const out = await reframe(
    { description: '把文档结构整理清楚' },
    sessionWithClassifier(),
    { root: makeTraceDir() },
  );

  assert.equal(out.answers_submitted, 0);
  assert.deepEqual(out.answers_missing, ['q1', 'q2', 'q3', 'q4']);
  assert.ok(out.note.includes('未提供四问作答'), `实际：${out.note}`);
});

test('判为 unknown 时 clis_used 仍为 true（库的语义：调用成功即算用过）', async () => {
  // 这是一个容易搞错的语义：库在**分类调用成功**时就 markUsed()，
  // 哪怕结论是 unknown。所以"没判出可用类型" ≠ "没用过 CLIS"。
  // 用 causalType !== undefined 判断会把这个场景错报成 false，
  // 而读 trace 的人会据此以为"当时根本没问 CLIS"。
  const unknownSession = new ClisSession({
    classifier: {
      async classify() {
        return { causal_type: 'unknown', confidence: 0.3, rationale: '看不出结构', evidence: [] };
      },
    },
  });

  const out = await reframe(
    { description: '看不出结构的问题', q1: 'unknown', q2: 'unknown', q3: 'unknown', q4: 'unknown' },
    unknownSession,
    { root: makeTraceDir() },
  );

  assert.equal(out.causal_type, null, 'unknown 不是可用类型，故无 hint');
  assert.equal(out.clis_used, true, '但 CLIS 确实被调用了');
  assert.ok(out.note.includes('unknown'), 'note 要说明是判为 unknown');
});

test('分类器崩溃不能说成"未知结构"（故障 ≠ 结论）', async () => {
  // 这是"note 会说谎"的回归闸门。
  //
  // 两种情形输出完全一样（causal_type 都是 null、clis_available 都是 true），
  // 但含义相反：一个是"这问题不属于已知结构"（结论），
  // 一个是"分类器挂了"（故障）。
  //
  // 把它们说成同一句话，使用者会放弃一个本来能判出来的问题 ——
  // 那比不提供工具更糟。
  const CYCLIC = { q1: 'no', q2: 'yes', q3: 'no', q4: 'no' };

  const throwing = new ClisSession({
    classifier: {
      async classify() {
        throw new Error('classifier exploded');
      },
    },
  });
  const broken = await reframe({ description: '测试', ...CYCLIC }, throwing, {
    root: makeTraceDir(),
  });

  const unknown = new ClisSession({
    classifier: {
      async classify() {
        return { causal_type: 'unknown', confidence: 0.3, rationale: 'x', evidence: [] };
      },
    },
  });
  const unknownOut = await reframe({ description: '测试', ...CYCLIC }, unknown, {
    root: makeTraceDir(),
  });

  // 两者都必须没有类型
  assert.equal(broken.causal_type, null);
  assert.equal(unknownOut.causal_type, null);

  // 但 note 必须不同
  assert.notEqual(broken.note, unknownOut.note, '故障与结论不能是同一句话');

  // 故障的要明说"没拿到结论"
  assert.ok(broken.note.includes('失败') || broken.note.includes('没有拿到'), '要说明是调用失败');

  // 且必须出现"不代表"这种否定式 —— 不能是断言式的"这个问题不属于已知结构"。
  // 注意不能简单断言 `!includes('不属于已知')`：故障说明里那句
  // "**不代表**这个问题不属于已知的四种结构" 本身就含这几个字。
  // 判据要落在"是否加了否定前缀"上，而不是关键词是否出现。
  assert.ok(
    broken.note.includes('不代表') || broken.note.includes('没有拿到因果结论'),
    '故障说明必须明确否定"问题不属于已知结构"这个结论',
  );

  // unknown 的才可以说"不属于已知结构"，且不带否定前缀
  assert.ok(unknownOut.note.includes('不属于已知'), '真 unknown 应给结论性表述');
  assert.ok(!unknownOut.note.includes('不代表'), 'unknown 是结论，不需要否定前缀');

  // clis_used 也能区分：故障时库没记使用
  assert.equal(broken.clis_used, false, '调用失败不算用过');
  assert.equal(unknownOut.clis_used, true, 'unknown 是成功返回，算用过');
});

test('分类器返回 null 同样按"故障"处理（不是 unknown）', async () => {
  const nulling = new ClisSession({
    classifier: {
      async classify() {
        return null;
      },
    },
  });
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    nulling,
    { root: makeTraceDir() },
  );

  assert.equal(out.causal_type, null);
  assert.equal(out.clis_used, false, '返回空不算用过');
  assert.ok(!out.note.includes('不属于已知') || out.note.includes('不代表'), '返回空也不能说成"未知结构"');
});

test('四种类型都能判出（证明参数映射没写错）', async () => {
  const cases = [
    [{ q1: 'yes', q2: 'no', q3: 'no', q4: 'no' }, 'structural_duality'],
    [{ q1: 'no', q2: 'yes', q3: 'no', q4: 'no' }, 'cyclic'],
    [{ q1: 'no', q2: 'no', q3: 'yes', q4: 'no' }, 'unidirectional'],
    [{ q1: 'no', q2: 'no', q3: 'no', q4: 'yes' }, 'nested'],
  ];
  for (const [answers, expected] of cases) {
    const out = await reframe({ description: '测试问题', ...answers }, sessionWithClassifier(), { root: makeTraceDir() });
    assert.equal(out.causal_type, expected, `${JSON.stringify(answers)} 应判为 ${expected}`);
  }
});

test('输出结构完整（工具消费方依赖这些字段名）', async () => {
  const out = await reframe({ description: '如何写一篇结构清晰的文章' }, undefined, { root: makeTraceDir() });

  for (const key of [
    'problem_id',
    'reframed',
    'original_definition',
    'boundary_declaration',
    'redefine_reason',
    'causal_type',
    'answered',
    'clis_available',
    'clis_used',
    'success_criteria',
    'forbidden_actions',
    'candidates',
    'note',
  ]) {
    assert.ok(key in out, `输出缺少字段 ${key}`);
  }

  // 候选必须带分数，否则"排序"这件事无法被复核
  for (const c of out.candidates) {
    assert.ok(typeof c.score === 'number', '候选缺少 score');
    assert.ok(typeof c.rank === 'number', '候选缺少 rank');
    assert.ok(c.source === 'meta' || c.source === 'clis', '候选来源不合法');
  }
});

test('候选按分数降序（名次必须与分数一致）', async () => {
  const out = await reframe({ description: '为什么改了配置没生效' }, undefined, { root: makeTraceDir() });
  const scores = out.candidates.map((c) => c.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted, '候选未按分数降序');
});

test('不同问题得到不同的 problem_id（trace 文件不会互相覆盖）', async () => {
  const a = await reframe({ description: '问题一' }, undefined, { root: makeTraceDir() });
  await new Promise((r) => setTimeout(r, 5));
  const b = await reframe({ description: '问题二' }, undefined, { root: makeTraceDir() });
  assert.notEqual(a.problem_id, b.problem_id);
});

// ── trace 落盘 ──────────────────────────────────────────────────────
//
// 这一组是回归闸门：`reframe()` 走的是分步调用（绕过 `run()`），
// 而 `writeTrace()` 原本只在 `run()` 里被调 —— 于是工具路径上一条 trace
// 都不落（实测：连调三次后全盘搜不到任何 meta-*.json）。
// 补了写入逻辑之后，这里守住"真的写出了文件、字段齐全、内容不撒谎"。

test('trace 真的落盘了（不是只在返回值里声称成功）', async () => {
  const dir = makeTraceDir();
  const out = await reframe({ description: '为什么改了配置没生效' }, undefined, { root: dir });

  assert.equal(out.trace.written, true, 'trace 应写成功');
  assert.ok(out.trace.path, '成功时必须有路径');

  // 关键：去磁盘上确认，别只信返回值
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, `目录里应恰好一个 trace 文件，实际 ${files.length}`);
  assert.ok(existsSync(out.trace.path), '返回值给的路径必须真实存在');
});

test('trace 字段齐全（按 MetaTrace 契约 10 个字段）', async () => {
  const dir = makeTraceDir();
  await reframe({ description: '为什么改了配置没生效' }, undefined, { root: dir });

  const file = readdirSync(dir).find((f) => f.endsWith('.json'));
  assert.ok(file, '应写出 trace 文件');
  const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));

  // 字段名与顺序都要对 —— 消费方按名取，少一个就断
  for (const key of [
    'problem_id',
    'definition',
    'boundary',
    'selected_path',
    'execution',
    'change',
    'clis_used',
    'gate',
    'rollback_count',
    'ts',
  ]) {
    assert.ok(key in saved, `trace 缺少字段 ${key}`);
  }
});

test('trace 不撒谎：没执行就写 null，不编造执行结果', async () => {
  const dir = makeTraceDir();
  await reframe({ description: '为什么改了配置没生效' }, undefined, { root: dir });

  const file = readdirSync(dir).find((f) => f.endsWith('.json'));
  const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));

  // 这是本插件最重要的一条诚实性约束：它只做诊断、不做执行。
  // 如果哪天有人为了"看起来完整"把 execution 填成 succeeded，
  // 这条断言会红 —— 那是必须被抓到的倒退。
  assert.equal(saved.execution, null, '未执行就不能有 execution');
  assert.equal(saved.change, null, '未决策就不能有 change');
  assert.equal(saved.rollback_count, 0, '未进入 observe 回滚循环');
  assert.equal(saved.gate.macro_gate, 'n/a', '没到宏观闸门就不该有 pending');
});

test('trace 的 clis_used 与返回值一致（两处口径不能打架）', async () => {
  const dir = makeTraceDir();
  const out = await reframe(
    { description: '为什么干预后反而更糟', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    sessionWithClassifier(),
    { root: dir },
  );

  const file = readdirSync(dir).find((f) => f.endsWith('.json'));
  const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));

  assert.equal(out.clis_used, true, '真实判出了类型');
  assert.equal(saved.clis_used, out.clis_used, 'trace 与返回值的 clis_used 必须一致');
});

test('trace 落盘失败时如实报告（不静默吞掉）', async () => {
  // 指一个必然写不进去的路径（Windows 下驱动器不存在）
  const out = await reframe({ description: '测试落盘失败' }, undefined, {
    root: 'Z:\\definitely\\not\\writable',
  });

  assert.equal(out.trace.written, false, '写入失败要如实反映');
  assert.equal(out.trace.path, null, '失败时不该给路径');
  assert.ok(out.trace.error, '失败要带原因，便于排查');
  // 关键：落盘失败不能拖垮整个工具调用
  assert.ok(out.candidates.length > 0, 'trace 写不了，诊断结果仍要给出');
});

// ── 缺陷 8：分类器返回**离契约的类型** ────────────────────────────
//
// 库的 `isUsableCausalType()` 只判 `causalType !== 'unknown'` ——
// 任何非 unknown 的字符串都算数，包括 `'totally_made_up_type'`。
//
// 后果两处：
//   1. `clis_used: true` + note 把它当结论呈现（垃圾被粉饰成"CLIS 干成了"）
//   2. `meta.customize()` 里 `FOCUS_BY_TYPE[causalType]` 是 undefined
//      → 解构抛 TypeError → 工具整个炸掉（reframe() 会向上传播）

test('缺陷 8：分类器返回离契约的类型 → 工具不能炸，且如实报出来', async () => {
  const garbage = new ClisSession({
    classifier: {
      async classify() {
        return {
          causal_type: 'totally_made_up_type',
          confidence: 0.9,
          rationale: 'garbage',
          evidence: [],
        };
      },
    },
  });

  // 关键：不许抛。上一版这里会 `const { focus, criterion } = undefined` → TypeError
  //
  // 注意：**不能**用 `assert.doesNotThrow(async () => ...)` ——
  // 那个断言对 async 函数不同步等待，抛出的错会变成"未处理的 rejection"，
  // 而 `out` 仍是 undefined（实测报 "Cannot read properties of undefined"）。
  // 所以直接 await 调用：抛了就是测试失败，错误信息还更清楚。
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    garbage,
    { root: makeTraceDir() },
  );

  assert.ok(out !== undefined, '离契约的类型绝不能让工具整个炸掉（customize 会解构 FOCUS_BY_TYPE[类型]）');
  assert.equal(out.causal_type, null, '离契约的类型不是可用结论 → causal_type 必须为 null');
  assert.equal(out.off_contract_type, 'totally_made_up_type', '但必须如实报出收到了什么');
  assert.equal(out.clis_used, false, '垃圾输出不能算"CLIS 干成了"');
});

test('缺陷 8：离契约时 note 必须说清"没有拿到可用结论"，且不能说成"不属于已知结构"', async () => {
  const garbage = new ClisSession({
    classifier: {
      async classify() {
        return { causal_type: 'made_up', confidence: 0.9, rationale: 'x', evidence: [] };
      },
    },
  });

  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    garbage,
    { root: makeTraceDir() },
  );

  assert.ok(
    out.note.includes('没有拿到可用的因果结论'),
    `必须说清没有拿到可用结论，实际：${out.note}`,
  );
  assert.ok(out.note.includes('made_up'), '必须报出实际收到的类型，实际：' + out.note);
  // 不能说成"这个问题不属于已知的四种结构"—— 那是结论，而真相是分类器坏了。
  //
  // 判据要落在"是否加了否定前缀"上，而不是关键词是否出现 ——
  // 故障说明里那句"这**不代表**这个问题不属于已知的四种结构"本身就含这几个字
  // （REVIEW.md 里记过这个坑：断言关键词缺失会误判）。
  assert.ok(
    out.note.includes('不代表'),
    '必须明确否定"问题不属于已知结构"，实际：' + out.note,
  );
  assert.ok(
    !/^[^。]*不属于已知的四种结构。/.test(out.note),
    `不能把故障说成结论（"不属于已知结构"不能作为独立断言出现），实际：${out.note}`,
  );
});

test('缺陷 8：契约内的四种类型仍然照常判出（白名单不能误伤）', async () => {
  const cases = [
    ['structural_duality', { q1: 'yes', q2: 'no', q3: 'no', q4: 'no' }],
    ['cyclic', { q1: 'no', q2: 'yes', q3: 'no', q4: 'no' }],
    ['unidirectional', { q1: 'no', q2: 'no', q3: 'yes', q4: 'no' }],
    ['nested', { q1: 'no', q2: 'no', q3: 'no', q4: 'yes' }],
  ];
  for (const [expected, answers] of cases) {
    const out = await reframe(
      { description: '测试问题', ...answers },
      sessionWithClassifier(),
      { root: makeTraceDir() },
    );
    assert.equal(out.causal_type, expected, `${JSON.stringify(answers)} 应判为 ${expected}`);
    assert.equal(out.off_contract_type, null, '契约内的类型不该被标成离契约');
    assert.equal(out.clis_used, true, '契约内的类型算真的判出了');
  }
});

// ── 缺陷 7：CLIS 不可用的**真实原因** ─────────────────────────────
//
// 上一版入口把 `createClisSession()` 的所有失败都压成"没有 session"，
// 工具的 note 于是无条件写死"（未安装 clis-classifier）" ——
// 而真相可能是"建会话时抛了"。排查方向完全相反。

test('缺陷 7：CLIS 不可用且**有真实原因** → note 必须说原因，不能说"未安装"', async () => {
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    undefined,
    { root: makeTraceDir() },
    'cannot get property "tools" without inject',
  );

  assert.equal(out.clis_available, false);
  assert.ok(
    out.note.includes('cannot get property "tools" without inject'),
    `note 必须带上真实原因，实际：${out.note}`,
  );
  assert.ok(
    !out.note.includes('未安装 clis-classifier'),
    `有真实原因时不能说"未安装"（那是具体但可能假的断言），实际：${out.note}`,
  );
  assert.ok(
    out.note.includes('不是"未安装"的结论'),
    `必须说清这不是"未安装"的结论，实际：${out.note}`,
  );
});

test('缺陷 7：CLIS 真的不可用且**没有原因** → 才可以说"未安装"', async () => {
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    undefined,
    { root: makeTraceDir() },
  );

  assert.equal(out.clis_available, false);
  assert.ok(
    out.note.includes('未安装 clis-classifier'),
    `确实是服务不存在时可以说"未安装"，实际：${out.note}`,
  );
});

test('缺陷 7：真实原因要单独给出来（机器可读，不只藏在文案里）', async () => {
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    undefined,
    { root: makeTraceDir() },
    'boom',
  );

  assert.equal(out.clis_unavailable_reason, 'boom', '原因要能被程序读到');
  assert.ok('clis_unavailable_reason' in out, '字段必须存在（消费方按名取）');
});

test('缺陷 7：CLIS 可用时原因字段为 null（不是空串，也不是 undefined）', async () => {
  const out = await reframe(
    { description: '测试', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' },
    sessionWithClassifier(),
    { root: makeTraceDir() },
  );

  assert.equal(out.clis_available, true);
  assert.equal(out.clis_unavailable_reason, null, '可用时原因必须是 null');
});
