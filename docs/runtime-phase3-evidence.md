# 阶段3进展：DL-3.1恢复核对与幂等

日期：2026-11-17。工作树`D:/个人开发/dsh-execution-runtime`，分支`feat/dual-loop-runtime`，起点为阶段2检查点`dd5379a`。本轮只在隔离环境开发，没有部署、发布或更改活动profile。

## 1. 完成边界

| 节点 | 当前状态 | 本轮证明 |
| :--- | :--- | :--- |
| DL-3.1 恢复、幂等与补偿 | 部分已验 | 未知副作用冻结、逐条外部核对、核对不冒充目标验证、按工具+键的幂等守卫；补偿计划未做 |
| DL-3.2 pause/resume/cancel与单写者 | 未做 | 本轮没有租约、fencing或resume |
| DL-3.3 任务级工具与健康接口 | 未做 | 包仍是`private`库，不是已装载插件 |
| DL-3.4 合成构建与隔离加载 | 未做 | 未触碰合成成员与活动junction |

## 2. 未知副作用必须先核对

真实安装宿主管线下的对照：工具写入成功但`tools/post-execute`策略拒绝时，运行进入`reconciling`，未结动作被记为`unknown`，业务写入计数保持1。此时任何新的业务派发都被`attempt_unresolved`拒绝，`recoverRun`只重复冻结，不重放、不清空预算。

核对入口`scheduler.reconcile`要求调用方显式提供任务Agent、任务范围、以及**每个**未结动作的结论与外部证据引用；条数、身份、结论枚举、证据长度任一不符即整体拒绝，不做部分提交。全部核完后运行回到`waiting_analysis`，逐条记为`reconciled_applied`或`reconciled_absent`。

关键判断：核对**不是**目标验证。核对写入的verification固定为`status:'unknown'`、`progress:'unknown'`、`goalSatisfied:null`，verifier身份是`runtime-reconciliation`。这样"副作用存在"这一事实可用，但不能被当成"目标已达成"，防止核对顺手把任务标完成。有反例证明：把核对结果改成`pass/goalSatisfied:true`会立刻被指定断言抓住。

## 3. 幂等键的真实语义

本轮踩坑值得记录。最初按"任务+键"判定，结果把合法的JSON修复动作拦掉了：修复候选沿用了原创建动作的`idempotencyKey`，两条不同工具的动作被当成同一意图，修复直接`idempotency_conflict`。随后又反向过度收紧（只要同键已结算就拦），把"已验证失败、仍需修复"的合法路径也堵死。

最终语义按副作用而非字符串判定：

- 维度是**工具+键**：不同工具复用同键不是同一副作用。
- 只在**已核验生效**时拦截：`reconciled_applied`，或已结算且验证通过。
- 已验证失败保留同键可修复；未知动作由冻结阻止，不靠幂等表猜测。

守卫放在`reserveAttempt`内，因此拦在派发之前；测试用真实管线证明同键重复派发被拒且业务写入仍为0。

测试写法也有教训：先只断言`idempotencyClaimed`的查询结果，变异"删掉守卫"不会被抓住。改成构造"验证通过但目标未完"的运行态、真正调用`reserveAttempt`并断言`idempotency_conflict`后，该变异才被杀死。**只查辅助函数不证明守卫在链路上生效。**

## 4. 执行的检查

```powershell
node --test packages/dsh-execution-runtime/test/*.test.js
node packages/dsh-execution-runtime/scripts/verify-recovery-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-repair-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-analysis-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-core-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-phase1-mutations.mjs
```

整包317 tests / 317 pass / 0 fail / 0 skipped，退出码0：阶段1既有171，加Analyzer17、分析存储24、异常协调器13、JSON修复策略47、修复管线19、修复存储12、取证探针7、恢复与幂等7。

新增4个恢复变异全部由指定断言检出：未知副作用不冻结、核对冒充目标成功、幂等守卫被删、核对缺少外部证据。前序6个修复变异、4个分析变异、4个核心变异与阶段1的9个同轮复跑仍全部命中。

## 5. 下一步

DL-3.2将补pause/resume/cancel与单写者：租约、fencing与恢复预留，重复resume不得双写，模板或权限变更时拒绝盲恢复。补偿计划仍属DL-3.1剩余部分，需要显式、有界、可审计的补偿契约而不是自动回滚。真实Jev、推理提供者、生产装配与跨任务推广均未验收。
