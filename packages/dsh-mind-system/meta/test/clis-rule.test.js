/**
 * 缺陷 2 的**漂移守卫**：mock 判据必须与真实 CLIS 逐条一致。
 *
 * ## 缺陷是什么
 *
 * `test/tools.test.js` 里的 mock 分类器手写了一份四问→类型的规则，
 * 而真实规则住在 `dsh-clis/chunk-2HMO3QIV.js` 的 `decide()` 里。
 *
 * 两份规则在 81 种组合里有 **14 种**给出不同结论 ——
 * 全部落在"两个以上 yes"的情形：
 *
 * | 四问（q1 q2 q3 q4） | 真实 CLIS | 旧 mock |
 * |---|---|---|
 * | yes yes no no | nested | cyclic |
 * | yes yes yes no | nested | cyclic |
 * | no yes yes no | nested | cyclic |
 * | no no yes yes | nested | unidirectional |
 * | …共 14 种 | **nested**（结构冲突） | 短路取第一个 yes |
 *
 * 真实规则：Q4=yes→nested；Q1..Q3 恰好一个 yes→那个类型；
 * **两个以上 yes→nested（结构冲突）**；没有 yes→unknown。
 *
 * ## 为什么这个错法危险
 *
 * 旧 mock 按 Q1→Q2→Q3 短路取**第一个** yes，而真实规则认为
 * "同时符合两种结构"是**结构冲突**，判 `nested`。
 *
 * 这直接改变下游：`customize()` 给哪种关注点、`select()` 走哪套策略族，
 * 全都跟着变。判错方向，诊断结论就反了 —— 而测试还全绿。
 *
 * ## 这个文件怎么守住
 *
 * **穷举** 3^4 = 81 种组合，把 mock 规则与**真实实现**逐条比对。
 * 任何一条不一致就红。
 *
 * 关键：真实实现是**真加载**的（`dsh-clis` 的 chunk），
 * 不是把它的规则再抄一遍 —— 抄一遍就变成"自己和自己比"，永远绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideType, loadRealClassifier, allAnswerCombinations } from './clis-rule.js';

test('缺陷 2：mock 判据与真实 CLIS 在全部 81 种组合上逐条一致', async (t) => {
  const real = await loadRealClassifier();
  t.after(() => real.cleanup());

  const combinations = allAnswerCombinations();
  assert.equal(combinations.length, 81, '3^4 = 81 种组合，一个都不能少');

  const divergences = [];
  for (const { short, long } of combinations) {
    const realType = real.classifyProblem({ description: 'x', answers: long }).causal_type;
    const mockType = decideType(short);
    if (realType !== mockType) {
      divergences.push(
        `${short.q1} ${short.q2} ${short.q3} ${short.q4} → 真实 ${realType}，mock ${mockType}`,
      );
    }
  }

  assert.deepEqual(
    divergences,
    [],
    `mock 判据与真实 CLIS 有 ${divergences.length} 处不一致：\n${divergences.join('\n')}`,
  );
});

test('缺陷 2：旧 mock 的具体错误已被钉住（两个以上 yes ⇒ nested）', () => {
  // 这条是**定点**回归：缺陷报告里点名的那个组合。
  // 上一版 mock 在这里给 cyclic，真实 CLIS 给 nested。
  assert.equal(
    decideType({ q1: 'yes', q2: 'yes', q3: 'no', q4: 'no' }),
    'nested',
    '两个 yes 是结构冲突，判 nested（不是取第一个）',
  );

  // 再钉几个：0 个 yes → unknown；1 个 yes → 那个类型；Q4=yes → nested
  assert.equal(decideType({ q1: 'no', q2: 'no', q3: 'no', q4: 'no' }), 'unknown');
  assert.equal(decideType({ q1: 'yes', q2: 'no', q3: 'no', q4: 'no' }), 'structural_duality');
  assert.equal(decideType({ q1: 'no', q2: 'yes', q3: 'no', q4: 'no' }), 'cyclic');
  assert.equal(decideType({ q1: 'no', q2: 'no', q3: 'yes', q4: 'no' }), 'unidirectional');
  assert.equal(decideType({ q1: 'no', q2: 'no', q3: 'no', q4: 'yes' }), 'nested');

  // 三个 yes 也一样是 nested
  assert.equal(decideType({ q1: 'yes', q2: 'yes', q3: 'yes', q4: 'no' }), 'nested');
});

test('缺陷 2：unknown 作答不算肯定（不能被当成 yes）', () => {
  // 真实规则里 `unknown` 只是"未定"，既不算 yes 也不构成冲突。
  assert.equal(
    decideType({ q1: 'unknown', q2: 'unknown', q3: 'unknown', q4: 'unknown' }),
    'unknown',
  );
  assert.equal(
    decideType({ q1: 'unknown', q2: 'yes', q3: 'unknown', q4: 'unknown' }),
    'cyclic',
    '一个 yes + 其它 unknown → 那个类型',
  );
  assert.equal(
    decideType({ q1: 'unknown', q2: 'yes', q3: 'yes', q4: 'unknown' }),
    'nested',
    '两个 yes（哪怕另一个是 unknown）→ 结构冲突',
  );
});
