# DR 验收条目与现有证据的对齐核对

日期：2026-11-17。检查点`85ed270`之后的收口核对，随后闭合了G-1/G-2第一子项/G-3。做法是把18项DR逐条对到**具体测试名或变异名**，对不上的就记为缺口——不用节点状态代替条目证据。

测试清单来自`packages/dsh-execution-runtime/test/`28个文件的290个静态用例名（参数化展开后运行416项）；变异来自14个套件共95个边界变异。

## 1. 已对上的条目

| DR | 对得上的具体证据（节选） |
| :--- | :--- |
| DR-01 | `exceptions.test.js`正常任务分析调用0并独立验收产物；错误产物调用1、业务写入仍1（外部传输spy，非计数器初值） |
| DR-02 | `admission.test.js`全套（44项）+ 变异`effect_downgrade_allowed`、`dispatch_recheck_ignored`、`caller_identity_mismatch_accepted` |
| DR-03 | `scheduler.test.js`伪造验证载荷不能绕过登记Verifier；变异`bad_output_marked_pass`、`unobserved_success_accepted`、`verifier_binding_ignored` |
| DR-04 | `decision-client.test.js`32项（缺项/重复/越界/取消/重定向/凭据）；变异`provider_budget_bypassed` |
| DR-05 | `repair.test.js`端到端修复经再准入与原Verifier；`store-repair.test.js`意图归属拒绝旧/外来attempt（rowid下限） |
| DR-06 | `probes.test.js`引用回送下一包、越界读被拒；`store-analysis.test.js`两读/32KiB/UTF8前缀/篡改；变异`analysis_ref_allowlist_removed`、`probe_result_not_persisted` |
| DR-07 | `repair.test.js`五类越界提议（外来目标、漏检查、削弱后置条件、伪造哈希、副作用降级）业务写入均0 |
| DR-08-a | `store.test.js`过期派发与预算不返还；变异`dispatch_budget_allows_one_extra` |
| DR-08-b | `store-repair.test.js`同签名两次失败停止、分析/取证计费；变异`repeated_repair_failure_never_stops` |
| DR-08-c | `compensation.test.js`恢复额度扣减与耗尽转人工、恢复用量不占业务预算；`recovery.test.js`核对走恢复额度；变异`compensation_skips_recovery_reserve`、`exhaustion_not_persisted` |
| DR-09 | `analyzer.test.js`坏JSON/迟到/取消隔离；`recovery.test.js`核对不冒充成功；变异`array_kind_coercion_allowed`、`late_task_proposal_accepted`、`reconciliation_claims_goal_success` |
| DR-10 | `recovery.test.js`崩溃式未知冻结、核对前不重放；`exceptions.test.js`未知副作用不触发分析也不使retry可执行；变异`unknown_effect_unfrozen`、`unknown_outcome_keeps_running` |
| DR-11 | `rollback.test.js`三档处置与跨环境拒绝；`compensation.test.js`目标事实必需；变异`irreversible_rollback_allowed`、`rollback_settles_without_target_fact`、`failed_compensation_reports_finished_rollback` |
| DR-12 | `lease.test.js`12项（fence推进、旧owner派发/结算被拒、暂停清owner、双resume拒绝、越截止拒绝、重启后fence仍在）；`plugin.test.js`卸载后排空；变异`scheduler_ignores_lease_fence` |
| DR-14 | `repair-patterns.js`失败只进分母、同run只算1样本、重复回执去重；变异`verified_failure_excluded_from_rate`、`one_run_manufactures_samples` |
| DR-15 | `pattern-integration.test.js`命中时分析器调用0、弃权时1（真实管线计数）；`pattern-approval.test.js`撤销后不再复用、编辑后批准失效 |
| DR-16 | `knowledge.test.js`scratch不冒充formal、`stored_not_indexed`可区分、daily origin限域、outbox幂等；变异`stored_reported_as_indexed`、`failed_delivery_looks_delivered` |

## 2. 未对上的条目（真实缺口）

**G-1 DR-08-c：恢复预留只有声明，没有执行路径。（已闭合）** 核对时的状态：`DEFAULT_BUDGET`里有`maxRecoveryReads:3`、`maxCompensations:1`、`recoveryTimeoutMs:60000`，`validateBudget`也校验它们，但全仓无任何地方读取或扣减——形状对、校验过、测试全绿，却从未约束过任何行为。这正是记忆里那条判据的实例：闸门只证"没坏"，不证"有内容"；能被校验的字段不等于被执行的约束。

闭合方式：`#chargeRecoveryWithinTx`在调用方事务内先扣再做事，超限抛`recovery_exhausted`并在错误对象上携带原因（计数或超时，不让调用方从消息文本里猜）；`reconcileAttempt`与`recordCompensation`都走这条路径，恢复用量单独记在`runs`表并出现在`getRun().budgetUsage.recovery`，与业务用量分开呈报，谁也不能替谁掩盖。耗尽后由`#recordRecoveryExhausted`在自己的事务里落`waiting_human`与`recovery_exhausted`事件——被拒的尝试没写补偿行，但耗尽这件事必须留在持久状态里，不能只活在抛出的错误里。限额是**每run**的：一次失败的补偿不能靠重试买到第二次机会。

对应新增2个测试（额度扣减/耗尽转人工、恢复不占业务预算）与2个变异（跳过扣减、耗尽不落盘），compensation套件共7个变异全中。

**G-2 DR-13两处子项不完整。** 第一子项**已闭合**：`plugin.test.js`新增用例，在`tools/pre-execute`处中止调用方信号，验证外层调用以`isError:true`收敛、持久run落在`cancelled`、无未结动作、且未产生业务文件。这里我最初把外层结果断言写成"不是错误"，被真实宿主纠正——中止一个调用，宿主本就该报告该调用被取消，正确的不变式在**持久状态收敛**那一侧。第二子项仍未闭合：只在合成host上验证过"其他工具仍可用"，**未对活动宿主的原有五成员验证**，需真实装载，属DL-3.4/生产侧。

**G-3 DR-01第二个子项缺显式反证。（已闭合）** 新增变异`goal_verifier_always_passes`：把JSON模板Verifier改成恒`pass`后，"错误产物触发分析"用例必须变红。analysis套件5个变异全中，这条反事实从此有了直接证据，不再依赖间接传导。

**G-4 DR-17、DR-18完全未开始。** 前者要独立标签对照、关检测器看漏检恶化、全拦截看误报恶化；后者要同任务集三组对照与P50/P95、样本数、成功率、总成本。全仓检索无`P50`/`P95`/`ground truth`/漏检误报相关实现。属阶段5，需要真实任务集。

**G-5 计划文档的表述需修正。（随G-1闭合而消解）** 原先的问题是：DL-3.1标为隔离已验，但同节点的恢复预留子项未做，节点粒度掩盖了条目缺口。现在DR-08-c已闭合，该表述失真已消除；仍保留的教训是**节点状态不能代替条目证据**，所以下面结论按条目而非节点计数。

## 3. 结论（本轮复核后更新）

18项DR中：**16项可对上具体证据**（含本轮闭合的DR-08-c）；**DR-13只过了第一子项**，第二子项需真实装载；**DR-17/DR-18未开始**，需真实任务集与标签对照。

因此"运行时主线可验证"当前的准确表述是：**机制与边界已在隔离环境逐条验证，但阶段门未全部通过**——阶段3差DR-13第二子项（活动宿主五成员对照），阶段4差真实样本（自动推广维持关闭），阶段5未开始。

不需要外部输入的缺口已全部闭合。剩余三项都卡在外部条件上：DR-13第二子项与DL-3.4合成构建需用户授权（会触碰活动junction/profile），DR-17/18需真实任务集与性能数据。
