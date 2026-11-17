# 阶段2进展：DL-2.1有界异常分析与提议持久化

日期：2026-11-17。工作树`D:/个人开发/dsh-execution-runtime`，分支`feat/dual-loop-runtime`，起点为阶段1检查点`bd58fae`。本轮只在隔离环境开发；没有部署、发布、安装合成包或更改活动profile。

## 1. 完成边界

| 节点 | 当前状态 | 本轮证明 |
| :--- | :--- | :--- |
| DL-2.1 有界分析包、证据与Analyzer | 隔离已验 | 大字段引用与省略、严格修正联合、分析/取证预算、取消/超时、提议持久化、迟到隔离 |
| DL-2.2 修正后的再次准入与执行 | 部分已验 | retry/abort/取证经原生策略再准入、公开宿主管线派发与原Verifier；第二次修复可从已核验owned替换延续上下文；回滚只到"检查点记录+规划+结算"契约，`rollback_to`提议尚未接入派发执行 |
| DL-2.3 任务内修正回写与失败上限 | 隔离已验 | 提议消费、意图与新attempt归属、结果记账；同一原生签名两次失败停止；有界修复历史经显式入口进入下一次候选，普通模板见修复记录即拒绝重发原动作；跨任务推广未做 |
| DL-2.4 CLIS/meta选择性诊断 | 隔离已验 | 自解释错误与首次出现直接修；仅重复无进展才诊断；unknown不接受置信度、不被补成具体结构；每任务限次、坏答案转unavailable；诊断不解锁修复、未知停人工 |

本轮补上DR-01的调用spy正反控；DR-06/09取得有界输入、引用、坏输出与超时的隔离子项证据。模型主动取证循环、修复实际执行、再次准入和修复后验证仍待DL-2.2，不能把整个阶段2标为完成。

## 2. 分析入口与正常路径对照

[分析协调器](../packages/dsh-execution-runtime/src/exceptions.js)提供`runWithAnalysis`：先执行已有调度器，再按持久状态判断是否提交异常。使用同一显式Agent与任务授权；完成、拒绝和`reconciling`不会进入普通分析修复。即使模型能提出retry，也没有绕过未决副作用冻结的调用入口。

同一入口的真实安装包工具管线对照：正常JSON任务独立读磁盘验收完成，注入传输spy调用数0；工具返回成功但产物错误时，spy调用数1，分析结果保存为提议，业务写入仍是1。这里的正控是实际调用`Analyzer`及其注入传输，不是计数器初值为0。真实推理模型提供者和生产质量尚未验证。

## 3. 有界异常包与取证

包保留任务身份、目标、授权摘要、触发类型与动作上下文；上限16KiB，最近3条事件身份。过大字段转为任务隔离的证据引用，包中明确记录省略字段及UTF-8字节数。必需身份无法容纳时停止，不静默裁剪目标或授权。尚未执行动作时有明确的合成attempt身份，而非伪造已派发记录。

原始证据单条最多4MiB无损JSON，采用SHA-256引用与SQLite不可改触发器；事件只记录引用、标签、字节元数据。超出单条上限时停止打包并记录失败，不把裁剪内容当作完整证据。读取只接受本次分析已绑定、属于同一任务的runtime证据引用；外部文件链接可用于引用既有验证事实，但不能由此直接打开任意文件。

每次分析最多读2次、累计32KiB；跨连接/重开仍保留计数，读取同时扣任务I/O预算。返回UTF-8完整前缀与省略数，不用替换字符掩盖半个码点。完整性测试通过外部数据库连接移除触发器后篡改内容，再读取必须拒绝，证明并非只读取自产ok状态。

## 4. Analyzer协议与生命周期

[Analyzer](../packages/dsh-execution-runtime/src/analyzer.js)只使用显式注入的`invoke({instructions,input,signal})`传输，返回原始JSON文本；没有自动选择提供者或扫描凭据。英文固定指令与不可信异常数据分离。返回最多16KiB，默认30秒超时；协调器还检查任务墙钟和本次分析的单调截止，防止同步返回恰好越过截止但计时器尚未运行时被接受。

修正是严格互斥联合：retry_with完整候选、gather_evidence探针ID、rollback_to检查点/补偿计划、abort原因。拒绝未知字段、混合分支、重复/转义重名键、伪造引用、目标/授权修改和不可保真的JSON。未知归因必须人工审查。kind必须是字符串，不能用数组强制转成属性键后跳过分支校验。

超时和取消后，迟到成功或拒绝都被消费并隔离，不会更新已结束的分析记录。`pendingCount`显示未收敛的真实传输promise；`dispose()`有界取消，`drain()`是显式真实收敛等待，不承诺结束不响应信号的传输。测试均主动释放晚到fixture，不遗留永久等待。

## 5. 持久化与预算语义

[存储](../packages/dsh-execution-runtime/src/store.js)在事务中预留分析额度、设置analyzing并记录analysisId；未知/未结业务动作禁止预留。pending/proposed唯一约束与CAS阻止并发重复分析；提议未经消费时不能再刷同任务分析。

模型输出经双层契约验证，保存为有界结果。提议需要人工时进入waiting_human，其余停在waiting_analysis且标明repair_proposed；坏JSON、超时、打包失败等停至人工处理，取消则结束为cancelled。迟到、错ID或过期版本不能覆盖已结束记录。这里只保存待验证提议，没有把模型自报的修复记成成功。

analysisCalls是发起前的保守预留维度，打包失败也不返还；analysis_submitted只表示提交给分析接口，不表示供应商已完成、已计费或令牌用量为0。真实调用次数由外部spy观测，供应商成本仍未验证。

## 6. 执行的检查

```powershell
node --test --test-reporter=spec packages/dsh-execution-runtime/test/*.test.js
node packages/dsh-execution-runtime/scripts/verify-analysis-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-core-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-phase1-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-repair-mutations.mjs
```

整包310 tests / 310 pass / 0 fail / 0 skipped，退出码0：阶段1既有171，加Analyzer17、分析存储24、异常协调器13、JSON修复策略47、修复管线19、修复存储12、取证探针7。覆盖正常0/异常1调用、大Unicode输出、省略与引用、无执行异常、任务/Agent隔离、4MiB边界、两读/32KiB、持久预算、并发与事务回滚、引用篡改、坏JSON/混合分支、解析失败、模型超时、取消、迟到及畸形原生返回。

新增19个变异全部由指定断言检出：数组kind绕过分支、诊断伪造证据、删除证据读取allowlist、接受越过任务截止的提议；修复策略替换原Verifier、失败上限失效、取消修复无法结清、陈旧产物进入修复体、下一次候选忽略修复历史、探针结果不入库。原核心4个与阶段1的9个变异同轮检出；每组基线退出0、每个变异语法有效，拒绝以导入/语法错误冒充正确检出。存储新增Analyzer依赖后，旧脚本的显式暂存文件列表也同步补齐。

只读审查发现数组kind的类型强制转换漏洞，已增加类型检查及原始JSON反例；另补上截止验收、不可变引用白名单和原生返回规范化，避免数据错误留下analyzing孤儿。修复管线审查另发现派发前取消会让修复永久停留在reserved，已允许取消态结清且不计失败样本，并补取消反例。最终静态审查没有未解决的实质问题；没有将后续租约、恢复和生产装配要求混为本节点通过。

## 7. 修复执行与失败上限

`jsonNormalizeRepairPolicy`只授权替换本任务独占创建、哈希未变的产物；原生上下文由`WeakSet`标记身份并深冻结，模型不能提交或重建。目标、模板版本、后置条件与Verifier始终取自原任务登记，策略即使自带`verifier`也会被覆盖为原登记项，并有反例证明自报成功不能通关。

`scheduler.repair`先重新准入（必需前置条件、副作用、宿主schema、工作区再校验），再经公开宿主管线派发；发现日志证明陈旧产物与非授权提议在写入体之外被拒。成功只由原Verifier的`status/ goalSatisfied`派生；派发后策略失败或回执异常保持`reconciling`，不重放、不计成功。

`startRepair/finishRepair`按rowid下限要求新attempt，旧attempt、外来任务或结构不符的候选不能冒领；提议消费、修复记录与失败计数同事务提交。同一原生签名两次实际失败转为`waiting_human/repair_limit`，取消与非派发不计样本，未知保持冻结。

修复状态不只停留在数据库：`readRepairTrace`返回最近3条有界记录（标识、种类、签名、状态、attempt、成败），`scheduler.nextRepairContext`在核对显式Agent与任务范围后交给下一次候选决策。普通JSON模板收到`retry_with`记录即拒绝重新生成原创建动作（`repair_history_present`），避免已知不足的动作被静默重放；非retry记录不触发该拒绝。该历史不是新授权来源：候选仍要按原模板、工具、目标与Verifier重新准入。

当前仅支持首个JSON `retry_with`、`gather_evidence`与`abort`；回滚/补偿、第二次修复上下文刷新和正式工具注册仍待后续。

## 8. 受控取证分支

分析器的`gather_evidence`不再只是解析通过的空分支。`createProbeRegistry`只接受可信原生代码登记、带唯一`probeId`与只读`run`的探针；调度器按`probeIds`逐个运行，未登记的名称记为`unavailable`而不是失败执行，也不会退回任意文件读取。

`probeIo`复用调度器的范围与I/O纪律：越界目标直接`probe_scope_denied`，符号链接在解析后再次校验，每次观察计一个逻辑I/O，单次读取上限4MiB。探针返回的事实经无损JSON存为`probe:<id>`任务证据；超过4MiB或抛错记为`unavailable`，不静默截断后冒充完整证据。

观察到的事实不会变成业务动作：修复记录结为`observed`（不写`attemptId`、不写`succeeded`），运行回到`waiting_analysis/evidence_gathered`，下一轮异常包自动把这些引用加入`evidenceRefs`，因此分析器能看到自己上一次取证的实际结果。取证不消耗工具调用、不触发再准入、不计修复成败；同一提议消费后不能重放。

验证用真实安装宿主管线与真实文件：探针读取自有产物并核对哈希、越界读被拒、未登记探针记为不可用、超大输出被拒、结果引用进入下一包、同任务重复消费被拒。存储层新增`observed`状态需同步更新CHECK约束，旧库通过受控重建迁移，首次实现曾因遗漏该约束在写入时失败——这也是本轮真实抓到的缺陷。

## 9. 选择性结构诊断（DL-2.4，后补）

路由判据是"该不该花这次诊断"，不是"能不能诊断"：**自解释的错误直接修**（错误本身已说清原因，诊断只加成本不加信息）、首次出现直接修、只有**重复且无进展**才升级。是否重复读持久化的修复历史，而不是单次失败的主观感觉；`AnalysisCoordinator.lastRoute`可查最近一次判定。

`unknown`是一等答案：不允许携带置信度、`resolved`恒为false、也不允许被补成某个具体结构。`createDiagnosisEscalation`每任务限1–3次，超限直接`budget_exhausted`；传输失败或结构不合法一律转`unavailable`——**坏答案不会被放宽成可用的"原因"**。

落点明确：已诊断 → `waiting_analysis`但`repairAuthorized:false`（结构只是指引，修复仍须准入门与验证）；`unknown`/`unavailable`/预算耗尽 → `waiting_human`。诊断预算耗尽本身是停止条件，不是继续猜的许可。

8个变异全部被指定断言杀死：所有错误都诊断、自解释错误仍诊断、unknown可带置信度、unknown被标为已解决、诊断解锁修复、unknown继续而非停人工、同任务可重复诊断、坏答案被放宽。测试写法上，我先写了一版过深的集成用例（试图手工拼出两次失败修复历史），它偏离目标且自身出错；删掉后只保留"路由读持久历史"与"自解释不诊断"两条，判据覆盖仍完整——**集成用例不该替单元测试复述逻辑**。

## 10. 回滚编排与重复修复（契约层）

回滚不是"加载旧JSON"。`createCheckpoint`同时记录业务游标与**产生时的环境**（模板与版本、范围、工作区）和外部证据引用；`planRollbackTo`据此分三档：

- 只读步骤 → 直接恢复游标，无需补偿；
- 可逆写 → 必须带已登记补偿（前后版本可观测），否则`compensation_required`；
- 不可逆/未知 → `not_compensable`，没有安全撤销就不假装能撤销。

环境任一项变化即`environment_changed:<key>`：跨模板或跨工作区的检查点不是回滚点，是另一个任务。`settleRollback`只在补偿被独立验证且目标事实匹配时置`restored`，其余一律`unresolved`留人工。

重复修复的上下文也补齐了：第一次修复要求原始`createOnly`动作建立所有权，**第二次**允许从"上一次已核验的owned替换"继续，但仍要求同一产物路径、同一模板版本、同一`inputVersion`、同一后置条件集与修复策略前置条件。所有权仍可回溯到最初的创建动作，路径或条件不符继续fail closed。

6个回滚变异全部被指定断言杀死：不可逆允许回滚、可逆写免补偿、跨环境仍恢复、无目标事实即结算、检查点无环境、无效补偿被接受。

## 11. 检查点真正被记录（DL-2.2表述修正）

复核时发现我自己把DL-2.2写高了：`rollback.js`只有单元测试引用，运行期**没有任何地方记录检查点**，调度器对`rollback_to`仍返回`repair_branch_unavailable`。也就是说"回滚已验"只覆盖了纯函数契约，不覆盖链路——正是我这轮反复引用的那条判据（可被校验的字段≠被执行的约束）反打在我自己写的状态上。

先修状态表述（降为部分已验），再补上真实缺的一环：调度器在**验证通过且带证据**的步骤后写检查点，记录业务游标、当时环境与Verifier证据引用。存环境是为了让"同一个状态但模板/范围已变"不再是合法恢复点。

链路证据用真实宿主管线跑：正常完成留1条检查点（stepIndex=1、evidenceRef为`file:`、环境四项齐全、有`checkpoint_recorded`事件）；负控用"工具忽略content写出错误产物"让Verifier真实判`output_mismatch`，检查点为0——断言里同时锁`status/reason`，避免"运行提前崩了"伪装成"验证未通过所以没记录"。

两个新变异证明这条路径确实在跑：`pipeline_records_no_checkpoint`（去掉记录调用）、`checkpoint_recorded_without_verification`（不校验就记录）。rollback套件现8个变异全中，整包419项通过。

**仍未完成**：`rollback_to`提议的派发执行（按恢复预留走补偿、把游标真正回退并再验证）。这属DL-2.2剩余，也仍是DR-11的最后一环。

## 12. 下一步

本文按轮次累积，§6的计数对应DL-2.1轮（310项）；最新整体口径见§11（419项）。

阶段2现状：DL-2.1/2.3/2.4隔离已验，**DL-2.2为部分已验**（剩`rollback_to`派发执行）。阶段4机制（DL-4.1–4.4）已完成。剩余：DL-5.1–5.3对照实验与部署演练（需真实任务与性能数据）、DL-3.4合成构建与发布守卫（本隔离树因行尾与gitignored运行依赖无法过守卫，需环境前置或用户授权）、真实Jev与推理提供者（需凭据）。

关于DL-3.4的核对结论（本轮实测）：本工作树`core.autocrlf=true`导致签出为CRLF、改写规则按LF匹配；且合成包的一个运行依赖被gitignore、任何checkout都不会有。在LF干净导出下改写规则全部命中，但仍有19个产物文件与已提交指纹不符——原仓库构建时用到的部分输入未入库。**因此`verify-combined`在这份fork的隔离树里本就无法通过，属环境前置条件缺失，不是运行时代码缺陷。**要在隔离树跑通合成构建，需要先决定：统一行尾策略（加`.gitattributes`）并把运行依赖纳入构建管理或明确其来源。
