# 阶段4进展：DL-4.1修正证据与模式候选

日期：2026-11-17。工作树`D:/个人开发/dsh-execution-runtime`，分支`feat/dual-loop-runtime`，起点为阶段3检查点`4dd9d43`。本轮只在隔离环境开发，没有部署、发布、修改阀门规则库或活动profile。

## 1. 完成边界

| 节点 | 当前状态 | 本轮证明 |
| :--- | :--- | :--- |
| DL-4.1 修正证据与模式候选视图 | 隔离已验 | 身份按实际约束生成、失败只进分母、不可判与取证不计样本、同run只算一个独立样本、重复回执去重、候选恒不可生效 |
| DL-4.2 接既有阀门与确认适配 | 隔离已验 | pending请求不能授权；确认须显式human且绑定被评审版本；模式编辑后旧批准失效；撤销保留审计；运行时不能自签票；阀门拒绝/抛错不静默 |
| DL-4.3 命中、弃权、撤销与版本回退 | 隔离已验 | 命中需有效批准+范围/触发/工具/模板版本匹配+证据达标，且不调分析器（实测0次）；弃权照常分析（实测1次）并留事件；撤销恢复原行为；回退恢复内容但清空票据需重审 |
| DL-4.4 知识读写适配器与治理outbox | 隔离已验 | 域身份显式、scratch不可冒充formal；存储与索引分开报告（stored_not_indexed可区分）；daily origin限formal；outbox按event+kind幂等、失败保持pending |

## 2. 模式身份：按约束，不按标签

`patternIdentity`只读实际约束：模板与版本、范围、Verifier及版本、触发类型、工具名。退出码与错误文本**不参与**身份计算——同一次失败换个报错文案、换一次退出码，仍是同一个模式；反过来，不同工具或不同范围不会被折叠成一个"成功经验"。

这条判据针对的是最容易被伪造的入口：如果身份来自"错误信息里的字符串"或"退出码"，那么改一句文案就能造出"新样本"，而把多个不同问题合并又能刷出"高成功率"。

## 3. 什么算样本：失败进分母，不可判不进

`classifyRepairEvidence`把一条修正记录分成三类处置：

- `settled`且明确成功：计入分子与分母。
- **`settled`但已核验失败：计入分母，不计分子。** 这是本轮修掉的一个真实判据错误——初版实现把失败归到`rejected`，结果成功率只由成功样本构成，必然虚高；一次失败既不进分母也不影响比率，等于被悄悄抹掉。
- `blocked`/`unknown`/取证`observed`：既不进分子也不进分母，但保留在`rejected`里并注明原因，不静默丢弃。

`settled`但没声明成败的记录直接拒绝，不默认成功。这与"静默回退比失败更危险"是同一条：宁可报错，不要替调用方猜。

## 4. 独立样本：同一个run刷不出置信度

`summarizePatternEvidence`按**独立run**计数：同一run内反复修正只算一个独立样本；重复回执按`repairId`去重。`eligible`要求独立run数达阈值**且**成功率达标，两个条件缺一不可。

字节级用例：一个run里四次成功修复 → `samples:4, independentRuns:1, insufficient_runs`；三个run各修一次 → 合格候选；混入一次已验证失败后成功率降到0.667，在0.9阈值下判`insufficient_success`。

## 5. 候选不是规则

`buildPatternCandidates`只返回冻结的候选视图，`activatable:false`并附注"候选不是生效规则"。它不写规则库、不改阀门、不触发推广——真正生效必须走DL-4.2的人工确认通道。这样"跑出候选"不会被误读成"系统已学会"。

## 6. 人工确认与阀门写入

确认流程分三段，任何一段缺失都不生效：

1. `proposeApproval`只接受`activatable:false`的候选，产出带版本与过期时间的`pending`请求。请求本身**不能授权任何事**——`approvalApplies`对`pending`一律返回`not_confirmed`。
2. `confirmApproval`要求显式`human:true`。分析结果、候选自带字段、`'yes'`字符串都不算人体行为；同时必须提交与被评审请求**相同的版本**，不符直接拒。
3. `approvalApplies`在生效时再核一次：`confirmed`、未过期、且当前模式版本仍等于批准版本。

模式版本由`patternVersionOf`对"身份+陈述+负向类型+关键词集合+范围"求哈希：关键词换序不算改版，换一个词就算。这样"评审过的内容"与"生效的内容"必须是同一样东西；模式被编辑后旧批准自动`pattern_version_changed`，不会批准一次永久有效。

`revokeApproval`保留`reviewTicket`等审计字段，撤销后不再适用；`rejectBorrowedTicket`拒绝携带`reviewTicket`/`approvalId`/`permit`/`confirmedBy`的候选——票只能来自人工确认。

`createValveWriter`把已批准模式交给宿主阀门写入：先验批准，再调`confirmRule`，且**不传`human`也不传`permit`**，所以运行时没有自签票能力；阀门拒绝或抛错一律转成失败，不静默成功。既有阀门的许可只绑`ruleId`、不绑版本，版本绑定由本层补齐并随写入交给宿主。

实测中，用"人味"模拟宿主阀门时，即使持有真实确认的批准，写入仍被阀门的`not_human_confirmed`拒绝——这正说明运行时确实没有替人签字的能力，而不是"看起来没有"。

## 7. 命中、弃权与回退

`matchPattern`只有在四条同时成立时才替代分析：批准仍有效（`confirmed`、未过期、版本一致）、范围/触发/工具/模板版本全部匹配、证据达阈值。任何一条不满足就弃权，且弃权**不抑制分析**——不是为了省成本而静默跳步。

用真实宿主管线与计数器验证，而不是只看返回值：命中时`analyze()`返回`pattern_applied`，注入的分析器调用数为**0**，`pattern_applied`事件带模式ID与版本；弃权时分析照常运行，调用数为**1**，并留下`pattern_abstained`事件说明原因。未配置匹配器时行为与之前完全一致，两个事件都不出现。

这里抓到一个真实缺陷：`pattern_abstained`事件本身会推进run版本，而后续`reserveAnalysis`仍用旧版本，导致"版本已变"错误。修法是记录事件后用返回的新版本继续。这类"写事件改变了自己依赖的版本"是状态机里很典型的一类bug。

`planRollback`/`applyRollback`把回退定义清楚：目标版本必须是历史中确认过的、且不是当前版本；回退后该版本变回`pending`并**清空`reviewTicket`**，当前批准记为`superseded`。**回退恢复内容，不恢复票据**——旧版本必须重新评审才能再次生效，否则"回退"就成了绕过评审的后门。

## 8. 知识读写与治理outbox

SAG在这里是**读写引擎**，不是身份判定者。`knowledgeRef`要求显式的`domain:id@version`，`domain`只允许`formal`/`workspace`/`scratch`；身份来自所属域，而不是"从哪条检索路径读到的"。

读：`scratch`内容经同一引擎读出仍是`scratch`，`verified`恒为`false`；只有`formal`且适配器明确标记才算已验证。这条针对的是"经过正式检索就默认可信"的常见混淆。

写：`stored`与`indexed`是两个独立事实。`stored_not_indexed`表示"写进去了但还搜不到"并带`indexError`；`write_failed`表示根本没写进去。把两者压成一个`ok`，正是"静默降级"最常见的来源。

`origin:'daily'`只允许`formal`域，避免验证样本污染日常校准记录（这是DL-4.1那条"样本要干净"的延续）。

`createGovernanceOutbox`按`eventId+kind`派生稳定ID，重放返回原条目并标`duplicate:true`而不新增行；`markFailed`只增加尝试次数并保持`pending`，`markDelivered`才置`delivered`——**"投递过"不等于"投递成功"**，否则重试机制会在第一次网络抖动后就静默放弃。

7个变异全部被指定断言杀死：scratch冒充formal、存储冒充索引、失败写冒充已存、daily origin不限域、outbox重放不幂等、失败投递显示已投递、未知域被接受。

## 9. 执行的检查

```powershell
node --test packages/dsh-execution-runtime/test/*.test.js
node packages/dsh-execution-runtime/scripts/verify-pattern-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-approval-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-hit-mutations.mjs
node packages/dsh-execution-runtime/scripts/verify-knowledge-mutations.mjs
```

整包394 tests / 394 pass / 0 fail / 0 skipped，退出码0：阶段1既有171，加Analyzer17、分析存储24、异常协调器13、JSON修复策略47、修复管线19、修复存储12、取证探针7、恢复与幂等7、租约与暂停12、补偿契约8、插件与卸载9、模式证据9、确认适配8、阀门桥接8、命中与回退11、命中集成3、知识读写与outbox8。

确认变异10个、命中变异8个、知识变异7个全部由指定断言检出：pending请求可授权、分析结果可签票、票不绑版本、编辑后旧批准仍生效、忽略过期、撤销后仍适用、夹带票被接受、运行时自签human、阀门拒绝报成功、无有效批准仍写入；弃权抑制分析、越界工具被忽略、模板版本变更被忽略、证据不足仍命中、回退恢复票据、伪造命中被记录、弃权不留痕、命中仍调分析器；scratch冒充formal、存储冒充索引、失败写冒充已存、daily origin不限域、outbox重放不幂等、失败投递显示已投递、未知域被接受。

其中"失败被排除出分母"这条，最初是我的**实现**错了而不是测试错了：测试先失败、我一度怀疑断言，排查后发现失败样本确实没进分母。这正是本轮最值得记的一点——成功率的分母必须包含失败，否则它只是"成功了多少次"。

## 10. 下一步

阶段4机制已完成（DL-4.1–4.4全部隔离已验），但**真实样本不足，自动推广维持关闭**——这是方案写明的阶段门。剩余工作属阶段5与生产侧：任务集与三组对照实验（DL-5.1）、故障注入与延迟测试（DL-5.2）、文档与隔离部署回退演练（DL-5.3）；以及DL-3.4剩余（合成构建/发布守卫）、真实Jev与推理提供者、生产装配，均继续单列待验。
