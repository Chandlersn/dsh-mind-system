# 阶段3进展：恢复核对、幂等与单写者

日期：2026-11-17。工作树`D:/个人开发/dsh-execution-runtime`，分支`feat/dual-loop-runtime`，起点为阶段2检查点`dd5379a`。本轮只在隔离环境开发，没有部署、发布或更改活动profile。

## 1. 完成边界

| 节点 | 当前状态 | 本轮证明 |
| :--- | :--- | :--- |
| DL-3.1 恢复、幂等与补偿 | 隔离已验 | 未知副作用冻结、逐条外部核对、核对不冒充目标验证、按工具+键的幂等守卫；补偿计划需目标事实、拒绝不可逆、失败不冒充已回滚 |
| DL-3.2 pause/resume/cancel与单写者 | 隔离已验 | 租约与fence拦截旧owner的派发与结算；暂停清owner并推进fence；重复resume被拒；越截止拒绝恢复；模板/范围/工作区/工具集变更拒绝盲恢复 |
| DL-3.3 任务级工具与健康接口 | 隔离已验 | 真Cordis装载：runtime_status/runtime_run注册成功、原生任务端到端完成、未登记引用与匿名调用被拒、卸载后宿主其他工具仍可用、探针区分unloaded与not-applied |
| DL-3.4 合成构建与隔离加载 | 部分已验 | HMR/卸载语义：卸载先拒新派发、`drain()`等待在途work、活动run持久可恢复、探针区分draining；合成构建、发布守卫与源产物一致未做 |

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

## 4. 补偿不是回滚标志

补偿契约要求计划恰好声明补偿ID、目标工具与参数、来源动作、`expectedBeforeSha256`、`expectedAfterSha256`与`reason: 'restore_prior_version'`；前后版本必须是**不同**的真实哈希，任何多余字段被拒。`irreversible`与`unknown`效应直接判为不可补偿——不可逆或未知副作用不能被自动"撤回"。只读动作没有需要补偿的状态，注册接口也只接受`reversible_write`。

完成判定不靠布尔值：`assessCompensation`同时要求登记的Verifier通过、带证据引用、且**观察到的目标哈希等于计划中的目标版本**。三者缺一返回`unverified`或`diverged`。存储层再加一道：`recordCompensation`在写库前要求`status:'completed'`必须带`verifiedByTarget`；完成后运行状态保持原样，不因为"补偿完成"就把目标标成达成。失败、分歧、不支持会让`running`进入`waiting_human`，保留未决而不冒充"已回滚"。

字节级用例覆盖：缺目标事实、目标哈希偏离、验证失败、缺证据、重定向到别的工具（同参数形状下仅工具身份不同）、来源动作未结算。变异证明这些闸门都在链路上：删除目标事实比对、允许不可逆补偿、删除工具身份检查、允许无事实写完成、让失败补偿返回完成，五个变异全部被指定断言杀死。

其中两次变异最初没被杀死，原因都是**测试没走到目标分支**：重定向用例先被参数形状检查拦下，失败补偿用例的运行态已不是`running`。补上"同参数形状不同工具"与"验证通过但目标未完"的用例后，变异才被检出——这与上一轮幂等守卫的教训一致：断言必须落在真正执行该分支的路径上。

## 5. 单写者、暂停与恢复

租约每次授予都把`fence`加一，旧持有者即使仍在运行也不再是写者。`reserveAttempt`、`markStarted`、`recordOutcome`在事务内校验fence，不一致即`stale_owner`；因此"以为自己是写者"的旧worker既不能派发也不能结算。同一未过期租约不能重复获取，过期后同owner重取得到更大fence；fence与owner持久化，进程重启不能凭旧状态绕过（重开数据库的用例验证了owner与fence都还在）。

调度器现在真正带fence：`RuntimeScheduler.run`创建或取得run后立即申请租约，并把fence注入其后所有写入。对照用例让工具执行中途被新worker接管，旧调度器的`recordOutcome`被`stale_owner`拒绝，被接管的attempt保持未结——这正是"旧worker恢复不双写"的可观察证据，而不是只证明存储层有检查。

`pauseRun`要求先结清或核对未结动作（未知副作用不允许被暂停悄悄掩盖），暂停时fence加一并清空owner，所以发起暂停的一方随即失去写权；同时记录暂停时的模板与授权快照。暂停只阻止新派发，不宣称杀死在途工具。`resumeRun`只接受`paused`，并要求提交当前快照逐项比对：模板版本、范围、工作区或工具集任一变化即拒绝，不做盲恢复。恢复时fence再加一；对`running`重复resume被拒，因此不能靠重复恢复撑开双写窗口；暂停期间越过截止直接拒绝恢复。

## 6. 作为真宿主插件装载

运行时现在有标准Cordis插件形状（`name`/`inject`/`apply`/`healthProbe`），用真实安装的Cordis与ToolRuntime装载，注册`runtime_status`与`runtime_run`两个任务级工具。这两点都不靠自检：注册后能用注册表查询到，工具调用走宿主真实执行器并返回`{isError, content, value}`。

权限边界在工具入口：`runtime_run`只接受`taskRef`，目标、工作区、允许工具与Verifier全部来自原生`tasks`工厂；未登记的引用直接拒绝且不创建run，没有显式调用Agent时也拒绝。执行器与调度器按Agent缓存，模型无法用参数扩大身份。

卸载路径同样有外部证据：`fiber.dispose()`之后`runtime_status`与`runtime_run`从注册表消失，而宿主其他工具仍能执行，说明关插件不影响原系统。探针在未apply时返回`degraded/execution-runtime.not-applied`，apply后`ok`，卸载后`execution-runtime.unloaded`——三种状态可区分，不冒充健康。

本轮抓到两个真实的实现缺陷：

1. 探针状态原本放在**模块级**变量里，两个插件实例会互相污染；测试里表现为"未加载的实例报告ok"。改为实例字段后修复，这正是"全局状态冒充实例状态"的典型。
2. 我凭想象写了`output.schema:{type:'json'}`、`result.success`、`result.value.report`与`tools.list()`，宿主真实契约全是另一套：schema类型只允许`object/.../null`，结果是`{isError, content, value}`，注册表只有`get(name, scope)`。这些错误全部由真实宿主报出，而不是我推断出来的——**先跑一次真管线，再写断言**。

插件变异4个全部被指定断言杀死：未登记引用放行、匿名调用放行、卸载不标记unloaded、未apply仍报ok。而"删除工具disposer"这个变异杀不死，因为宿主在fiber析构时本身就会回收工具；那说明该变异测的不是我的代码路径，已换成能区分的断言。

## 7. 卸载、排空与恢复语义

卸载顺序按"HMR先停派发再排空"落地：`apply`返回的dispose先置`disposed`拒绝新派发，再释放工具，最后记录状态。工具从注册表消失后宿主会以`UNKNOWN_TOOL`拒绝外部调用；而直接调用已捕获的工具定义体，则被运行时自身的`runtime_unloaded`拒绝——两层都有断言，不是只靠其中一层。

`drain()`等待真正的在途work：用例用一个受gate阻塞的工具体把run停在半途，确认`describe().active===1`后才卸载，并断言`drain()`在gate释放前**不resolve**。这条断言暴露出一个真实缺陷——原实现先`await`再读`active.size`，返回的`drained`恒为0，使"真的等了"与"什么都没做"无法区分；改为先快照pending再等待。

活动任务在卸载后仍可查：run持久在SQLite里，卸载只影响插件实例，所以`store.getRun()`仍能读到完成或待分析状态，后续owner可以resume或reconcile。探针在有在途work时返回`degraded/execution-runtime.draining`，而不是把"还在排空"报成干净卸载。

本轮变异脚本自身也有一处误判值得记：`inflight_work_not_tracked`最初被判"未杀死"，手动复现却发现用例确实失败了——原因是该变异让用例挂到60秒测试超时，而脚本`spawnSync`的timeout也是60秒，超时被当成"没有指定断言失败"。把脚本上限提到180秒后判定正确。**变异脚本的超时必须宽于被测用例自身的超时，否则超时会伪装成"变异存活"。**

## 8. 执行的检查

```powershell
node --test packages/dsh-execution-runtime/test/*.test.js
node packages/dsh-execution-runtime/scripts/verify-plugin-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-compensation-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-lease-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-recovery-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-repair-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-analysis-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-core-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-phase1-mutations.mjs
```

整包346 tests / 346 pass / 0 fail / 0 skipped，退出码0：阶段1既有171，加Analyzer17、分析存储24、异常协调器13、JSON修复策略47、修复管线19、修复存储12、取证探针7、恢复与幂等7、租约与暂停12、补偿契约8、插件与卸载9。

插件变异7个、补偿变异5个、恢复变异4个、租约与暂停变异7个全部由指定断言检出：未登记引用放行、匿名调用放行、卸载不标记unloaded、卸载后仍可派发、在途work不追踪、忽略在途排空、卸载隐藏draining、未apply仍报ok；无目标事实仍记完成、允许不可逆补偿、计划重定向工具、无事实写完成、失败补偿返回完成；未知副作用不冻结、核对冒充目标成功、幂等守卫被删、核对缺少外部证据；fence校验被删、租约复用fence、暂停允许未结动作、resume不推进fence、resume忽略截止、调度器忽略fence、resume忽略环境变更。前序6个修复变异、4个分析变异、4个核心变异与阶段1的9个同轮复跑仍全部命中。

## 9. 下一步

DL-3.4剩余：接合成构建与隔离加载——源/产物一致、结构/发布/原计划守卫通过（本轮只做了卸载/排空语义，没有触碰合成成员与活动junction）。DL-3.3剩余：在原生scope下验证取消路径与"不影响原有五成员"的完整对照（本轮只验证了宿主其他工具仍可用）。真实Jev、推理提供者、生产装配与跨任务推广均未验收。
