# 双循环执行运行时：隔离开发包

这是融合方案DL-0、DL-1与DL-2.1的隔离开发包，尚未接入活动心智系统，也不是已发布的Host插件。有界异常分析和修正提议已接入；修正执行、生产装配、恢复所有权、补偿及知识访问适配器按后续节点实现。

## 已有能力

- `RuntimeScheduler`：注册模板→完整候选→准入→规则或提供者判别→公开宿主管线→登记的独立Verifier。正常多步任务可完成；没有候选、歧义、拒绝、无进展、预算耗尽、取消与未知结果分别停止。
- `admitCandidate`：绑定可信调用者、工作区、模板版本、必需前置条件、工具可见性、宿主参数schema和可信工具副作用声明。候选不能把写操作自报成读操作，也不能省略必需条件。选中动作在派发前再次准入。
- `HostExecutor`：只调用公开`ToolRuntime.execute`，保持同一显式Agent、root和真实parent token。私有host调用ID隔离观察器；先绑定执行身份与参数引用，再经过已有策略。信号仍可由宿主融合；调用身份和参数不能由普通包装器替换。缺少本次派发准入证据的成功回执会变为未知结果。
- `DecisionClient`：systemone批量评分、严格协议检查、有界超时/取消、显式选择与弃权。普通规则路径不需要提供者；提供者失联仅能降级到已准入、显式登记且唯一的读动作，不自动降级到写动作。真实提供者配置缺失时只有fixture证据。
- `RuntimeStore`：SQLite事务、版本CAS、预算预留和不可改事件。结果、验证与下一业务游标在同一事务提交，防止结果已记账而游标未推进。旧阶段0数据库补齐新增列和有界预算默认值。
- JSON模板：准备、候选生成、两次前置检查和独立验证均接入计量的只读I/O。工具只负责创建文件；Verifier重新读取源文件和产物，不使用工具自报的验证结果。

## 嵌入契约

构造调度器时注入`store`、可信注册的`recipes`、`executor`、可见的`tools`与`validateArguments`。后者必须使用宿主支持的真实schema校验函数，返回错误字符串数组；不能以“无校验器”为放行条件。可选注入`decisionClient`与显式版本的`decisionPolicy`。

运行调用为`await scheduler.run(task, { authority, signal, decisionMode })`。`authority`由可信宿主构造，包含`scopeRef`、绝对`workspaceRoot`、`allowedTools`与`agent`；其Agent必须与执行适配器不可改的Agent相同。模板回调与Verifier由可信原生代码注册，不能由模型提交可执行函数。普通任务输入不能覆盖授权、Verifier或模板代码。

`decisionMode`为`rules`或`provider`。规则主路径只接受唯一准入候选，并记录模板规则版本；这与提供者故障后的只读降级是两个明确入口。提供者超时、HTTP或传输错误可消费登记的`fallbackRule`，协议坏数据、取消和预算耗尽不会自动执行替代动作。

执行适配器调用完成后由其所有者`await executor.dispose()`，再关闭数据库与宿主Context；调度器不擅自销毁可复用的共享执行适配器。

## 预算与I/O

默认预算在契约中定义：50个动作尝试、20个公开工具调用、100个逻辑I/O操作、100个判别请求、5个分析调用。分析协调器只在待分析状态预留并提交分析，正常路径不消耗分析额度。工具意图、判别请求与I/O在发生前持久化预留，失败不返还。`usage`保留旧的动作/工具两项；`budgetUsage`提供完整维度。

I/O计数是文件读取、lstat和realpath等逻辑能力调用，不是操作系统系统调用数；授权根核对等宿主策略元数据开销另属接入层。Verifier的声明I/O额度在业务派发前预留，不足则不派发；超出预留停止并保留未知结果。预留未用完仍保守计入预算，实际成功读取另有`io_observed`事件。

计量能力只暴露只读操作，拒绝自定义文件flag和越界路径，每次读取上限4MiB；JSON源另有限制1MiB、最多10000条记录。此能力限制受信任模板的正常I/O，不是隔离任意原生JavaScript代码的沙箱。

## 有界异常分析

`Analyzer({invoke,timeoutMs,maxResponseBytes})`使用显式注入的可信模型传输；`invoke({instructions,input,signal})`返回原始JSON文本。这里没有自动选择提供者或扫描凭据。指令与不可信异常数据分离，修正结果只接受四种互斥分支：retry_with、gather_evidence、rollback_to、abort。目标/授权字段、混合分支、重复键、伪造证据、数组伪装kind以及不完整候选均拒绝。

`AnalysisCoordinator({store,analyzer,agent})`将同一Agent和任务授权绑定到分析。`runWithAnalysis({scheduler,coordinator,task,options})`先走正常调度，再按状态决定是否分析；已完成、拒绝和未知副作用不会被直接送入普通修复。提议只保存到数据库，当前没有修正执行入口。

异常包最多16KiB、最近3条事件身份；过大字段保存为任务隔离的不可改SHA-256证据引用，并显式记录省略字段与字节数。单条证据原始JSON最多4MiB，超出时停止分析并记录包失败，不静默截断为可用证据。每次分析最多取证2次、累计32KiB，读取还计入任务I/O预算；只读已绑定的同任务引用，不解析任意文件链接。

分析默认30秒超时，并受任务截止约束。超时/取消立即隔离迟到结果；`pendingCount`仍显示尚未结束的提供者工作。`dispose()`取消当前分析并有界返回，不承诺终止不响应信号的传输；仅显式`drain()`等待真实提供者收敛，它可能一直等待。调用方应在正常工作收敛后关闭数据库与Context。分析预算是发起前的保守预留，`analysis_submitted`是提交记录，不等于供应商完成或令牌用量。

完整验收范围见[阶段2·DL-2.1证据](../../docs/runtime-phase2-evidence.md)。真实推理提供者、模型取证工具循环与修复后的再次准入/验证尚未验收。

## 修正提议的执行边界

`json-repair.js`登记了`jsonNormalizeRepairPolicy`，只授权替换本任务**独占创建且哈希未变**的产物；它不提供写入工具，写入仍走宿主工具边界。原生上下文经`WeakSet`标记身份并深冻结，不能由模型提交或序列化重建；目标、模板版本、验收条件与Verifier始终取自原任务登记，修复策略不能替换。

`scheduler.repair(taskId, analysisId, {authority, signal})`只消费已持久化的提议：先以原生模板策略准备原始所有权上下文，再按修复工具集重新准入（必需前置条件、副作用、宿主schema），随后经同一公开宿主管线派发，最后由**原任务登记的独立Verifier**判定。提议中的目标、模板、参数结构或自报成功均不能放行；越界提议在写入前被拒并计为一次失败。

`startRepair`/`finishRepair`把提议消费、修复意图、新attempt归属与结果分开记账。成功只由实际验证派生，模型回执或调度器布尔值都不能替代；派发后结果未知保持`reconciling`，不重放也不计为成功。同一原生异常签名两次实际失败后停止为`waiting_human/repair_limit`；取消与非派发不计失败样本。

## 取证探针

`createProbeRegistry`只接受可信原生代码登记、带唯一`probeId`和只读`run`的探针。取证分支按分析器给出的`probeIds`逐个运行：越界读取被`probeIo`的范围校验拒绝，每次观察计一个逻辑I/O；输出超过4MiB或抛错记为不可用，不静默截断。观察到的事实作为`probe:<id>`证据存入任务库，修复记录结为`observed`，运行回到`waiting_analysis/evidence_gathered`，下一轮异常包自动带上这些引用。取证不派发业务工具、不生成候选、不计修复成败。

当前仅支持首个JSON `retry_with`、`gather_evidence`与`abort`。取证分支只运行可信登记的只读探针：探针输出存入任务证据并按引用返回下一轮分析，不产生业务写入、不生成候选、不计成功；未登记探针记为不可用。回滚/补偿、第二次修复的原生上下文刷新、跨任务推广及正式工具注册仍待后续；未登记策略时拒绝执行。

## 验证

在本包目录运行：

```powershell
node --test test/*.test.js
node scripts/verify-core-mutations.mjs
node scripts/verify-phase1-mutations.mjs
node scripts/verify-analysis-mutations.mjs
node scripts/verify-repair-mutations.mjs
node scripts/verify-recovery-mutations.mjs
node scripts/verify-lease-mutations.mjs
node scripts/probe-jev.mjs
```

宿主测试默认读取本机安装根，可用`DSH_SEAM_HOST_ROOT`显式覆盖。测试创建独立Context、临时DSH_HOME和临时文件，结束后关闭资源并清理目标目录，不更改活动profile。详见[阶段0证据](../../docs/runtime-phase0-evidence.md)、[阶段1证据](../../docs/runtime-phase1-evidence.md)和[宿主管线证据](../../docs/runtime-host-evidence.md)。

真实Jev探针只读取`DSH_JEV_ENDPOINT`、`DSH_JEV_MODEL`、`DSH_JEV_API_KEY`。缺少配置返回`external_dependency_not_verified`，不会发送请求。具体参数见[协议证据](../../docs/runtime-jev-evidence.md)。

## 恢复与幂等

`recoverRun`只把未结动作冻结为`unknown`，不重放、不清空预算，也不证明旧worker已停止。冻结后的run停在`reconciling`，除核对外的业务派发一律被`attempt_unresolved`拒绝。

核对必须逐条给出未结动作的结论与外部证据引用：`scheduler.reconcile(taskId,{authority,resolutions})`把每条未知动作记为`reconciled_applied`或`reconciled_absent`。核对**不冒充目标验证**——它的verification固定为`unknown`、`goalSatisfied=null`，只是把"副作用到底有没有发生"落成可审计的事实；全部核完才回到`waiting_analysis`，是否达成目标仍由原Verifier后续判定。核对不会重放写入，也不会因为模型或调用方声明就记为成功。

`idempotencyKey`按**工具+键**在同一任务内绑定，且只拦"已核验生效"的同一意图：已`reconciled_applied`，或已结算且验证通过。已验证失败的动作保留同键可修复，未知动作先由冻结阻止而非幂等表判断。不同工具复用同键不算同一副作用。该守卫在`reserveAttempt`内生效，因此拦在派发之前。

```powershell
node scripts/verify-recovery-mutations.mjs
```

## 单写者、暂停与恢复

`acquireLease`每次授予都把`fence`加一，旧持有者即使仍在运行也不再是写者。`reserveAttempt`、`markStarted`、`recordOutcome`都接受`fence`并在事务内校验：不一致直接`stale_owner`，因此"以为自己是写者"的旧worker无法派发或结算。同一个未过期租约不能被重复获取；过期后由同一owner重新获取会得到更大的fence。fence与owner持久化在数据库中，进程重启不能凭旧状态绕过。

`pauseRun`要求没有未结动作（未知副作用先走核对），暂停时把fence加一并清空owner，所以"发起暂停的一方"也不再能写。暂停只阻止新派发，不宣称杀死在途工具；已派发动作的收敛仍由公开管线与核对处理。暂停时同时记录当时的模板与授权快照。

`resumeRun`只接受`paused`状态。它要求调用方提交**当前**模板与授权快照，并与暂停时记录的快照逐项比对；模板版本、范围、工作区或工具集任一变化即`resume_environment_changed`，不做"盲恢复"。恢复时fence再加一，重复resume在`running`上被拒，从而不会双写；暂停期间越过任务截止则直接拒绝恢复。

`RuntimeScheduler.run`在创建或取得run后立即申请租约，并把fence带入其后所有写入；有反例证明：工具执行中途被新worker接管时，旧调度器的结算会被`stale_owner`拒绝，被接管的attempt保持未结，留给新owner核对。

## 补偿契约

补偿不是"回滚标志"，而是一次有明确前后版本、有目标事实的独立动作。`validateCompensationPlan`要求恰好声明补偿ID、目标工具与参数、来源动作、`expectedBeforeSha256`、`expectedAfterSha256`与`reason: 'restore_prior_version'`；前后版本必须不同且是真实哈希，多余字段一律拒绝。

`assessCompensation`只在同时满足三条时才认可完成：登记的Verifier判定通过、带证据引用、并且观察到的目标哈希等于计划中的`expectedAfterSha256`。任一不满足返回`unverified`或`diverged`，不冒充"已回滚"。

`assertCompensationSupported`对`irreversible`与`unknown`效应直接拒绝：不可逆或未知副作用不能自动补偿。只读动作没有需要补偿的状态，`registerCompensation`也只接受`reversible_write`。

`RuntimeStore.recordCompensation`要求来源动作已结算；`status:'completed'`必须同时给出`verifiedByTarget`，否则在写库前被拒。完成时运行状态保持原样（不因补偿完成就把目标标成完成），失败/分歧/不支持则让`running`进入`waiting_human`。事件`compensation_recorded`只记录计划ID、状态与证据引用。

JSON模板提供`buildJsonCompensation`：从原Verifier观察到的版本与先前版本构造恢复计划，不接受模型自报的前后哈希。

## 作为宿主插件装载

`createExecutionRuntimePlugin({store,recipes,tasks,validateArguments,owner,...})`返回标准Cordis插件形状：`name`、`inject:['tools']`、`apply(ctx)`、`healthProbe.probe()`。它注册两个任务级工具：

- `runtime_status`：只读报告已登记模板与任务引用；给出`taskId`时返回该run的持久状态、原因、预算用量、fence与owner。
- `runtime_run`：只接受`taskRef`。目标、工作区、工具集与Verifier全部来自原生`tasks`工厂，模型无法自带或放宽；没有显式调用Agent时直接拒绝。

调度器与执行器按调用Agent缓存，身份不会被模型传值扩大。插件卸载时释放自己注册的工具，并让探针报`execution-runtime.unloaded`；从未apply时探针报`degraded/execution-runtime.not-applied`，不冒充健康。关闭插件不影响宿主其他工具。

宿主真实契约（本机实测，不是推测）：工具`output.schema.type`只能是`object/array/string/number/integer/boolean/null`；`execute`返回`{isError, content, value}`；注册表用`get(name, scope)`查询，没有列表面API。

## 卸载与排空

`apply`返回的dispose按HMR语义执行：先置`disposed`拒绝新派发，再释放两个工具，最后记录状态。工具从注册表消失后宿主以`UNKNOWN_TOOL`拒绝调用；持有旧定义直接调用时由运行时自身以`runtime_unloaded`拒绝，两层都有测试。

`drain()`等待真正的在途work，并在等待前快照pending，所以`drained`反映实际等待的条数；卸载时有在途work，探针返回`degraded/execution-runtime.draining`，排空后才回到`execution-runtime.unloaded`。run持久在SQLite中，卸载只影响插件实例，后续owner仍可resume或reconcile。

## 持久化与授权边界

当前使用Node.js内建`node:sqlite`；本机Node v22.23.3仍将该API标记为实验性。原型验证不等于生产驱动选型已完成。事件不可改限制来自SQLite触发器，不能防御拥有数据库文件写权限的外部进程。

`recoverRun`只把未结动作冻结为`reconciling`，不自动重放、不清空预算，也不证明旧worker已停止。运行时暂不提供resume；租约、fencing、恢复预留与补偿仍待后续节点。执行中的取消等待公开管线收敛，不宣称能强杀不响应信号的任意原生回调。

证据引用的类型校验不证明真实性。调度器已强制使用登记的Verifier身份、版本与后置条件，JSON模板实际检查磁盘产物；其他Verifier必须各自证明目标事实。准入支持显式约束/负向检查回调，但尚未接活动valves规则库。

文件路径与指纹检查不抵御并发目录替换的全部竞态；真正写入仍须经宿主工具边界，并使用独占创建或版本核对。固定JSON闭环测试使用独占创建。完整文件系统授权、持久Session/AgentFactory与Web事件投影仍待后续节点。

## 开发约束

仅在隔离工作树开发；不运行面向活动junction的合成构建，不改Web profile。源包通过隔离验收后再按DL-3进入合成成员、装配和发布守卫。此包暂设`private:true`，尚无插件入口或安装patch。
