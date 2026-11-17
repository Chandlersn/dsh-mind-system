# 阶段3进展：恢复核对、幂等与单写者

日期：2026-11-17。工作树`D:/个人开发/dsh-execution-runtime`，分支`feat/dual-loop-runtime`，起点为阶段2检查点`dd5379a`。本轮只在隔离环境开发，没有部署、发布或更改活动profile。

## 1. 完成边界

| 节点 | 当前状态 | 本轮证明 |
| :--- | :--- | :--- |
| DL-3.1 恢复、幂等与补偿 | 部分已验 | 未知副作用冻结、逐条外部核对、核对不冒充目标验证、按工具+键的幂等守卫；补偿计划未做 |
| DL-3.2 pause/resume/cancel与单写者 | 隔离已验 | 租约与fence拦截旧owner的派发与结算；暂停清owner并推进fence；重复resume被拒；越截止拒绝恢复；模板/范围/工作区/工具集变更拒绝盲恢复 |
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

## 4. 单写者、暂停与恢复

租约每次授予都把`fence`加一，旧持有者即使仍在运行也不再是写者。`reserveAttempt`、`markStarted`、`recordOutcome`在事务内校验fence，不一致即`stale_owner`；因此"以为自己是写者"的旧worker既不能派发也不能结算。同一未过期租约不能重复获取，过期后同owner重取得到更大fence；fence与owner持久化，进程重启不能凭旧状态绕过（重开数据库的用例验证了owner与fence都还在）。

调度器现在真正带fence：`RuntimeScheduler.run`创建或取得run后立即申请租约，并把fence注入其后所有写入。对照用例让工具执行中途被新worker接管，旧调度器的`recordOutcome`被`stale_owner`拒绝，被接管的attempt保持未结——这正是"旧worker恢复不双写"的可观察证据，而不是只证明存储层有检查。

`pauseRun`要求先结清或核对未结动作（未知副作用不允许被暂停悄悄掩盖），暂停时fence加一并清空owner，所以发起暂停的一方随即失去写权；同时记录暂停时的模板与授权快照。暂停只阻止新派发，不宣称杀死在途工具。`resumeRun`只接受`paused`，并要求提交当前快照逐项比对：模板版本、范围、工作区或工具集任一变化即拒绝，不做盲恢复。恢复时fence再加一；对`running`重复resume被拒，因此不能靠重复恢复撑开双写窗口；暂停期间越过截止直接拒绝恢复。

## 5. 执行的检查

```powershell
node --test packages/dsh-execution-runtime/test/*.test.js
node packages/dsh-execution-runtime/scripts/verify-lease-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-recovery-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-repair-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-analysis-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-core-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-phase1-mutations.mjs
```

整包329 tests / 329 pass / 0 fail / 0 skipped，退出码0：阶段1既有171，加Analyzer17、分析存储24、异常协调器13、JSON修复策略47、修复管线19、修复存储12、取证探针7、恢复与幂等7、租约与暂停12。

恢复变异4个、租约与暂停变异7个全部由指定断言检出：未知副作用不冻结、核对冒充目标成功、幂等守卫被删、核对缺少外部证据；fence校验被删、租约复用fence、暂停允许未结动作、resume不推进fence、resume忽略截止、调度器忽略fence、resume忽略环境变更。前序6个修复变异、4个分析变异、4个核心变异与阶段1的9个同轮复跑仍全部命中。

## 6. 下一步

DL-3.1剩余：显式、有界、可审计的补偿契约，而不是自动回滚。之后是DL-3.3插件装载与DL-3.4合成构建；真实Jev、推理提供者、生产装配与跨任务推广均未验收。
