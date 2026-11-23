# 2026-11-23 数据流验证记录

## 验证范围

本记录为部署验证及反例，不是生产任务分布。源码、构建、活动宿主与真实修复证据分别判断。用户授权依据实际验证结果重写计划并继续执行；当前顺序见[升级计划](../UPGRADE-PLAN.md)。

## 已观察结果

| 层次 | 操作 | 外部结果 | 能证明与不能证明 |
| :--- | :--- | :--- | :--- |
| 源码 | runtime 全包 node:test | 608 项，607 通过，1 符号链接权限跳过 | 验证测试覆盖下的行为；不证明生产故障处理 |
| 构建 | build + verify-combined | 381 产物文件与源一致 | 已安装 junction 文件已更新；不单独证明模块重载 |
| 组合包 | host/outbox/validator 四组定向回归 | 27/27 通过 | 读取失败、积压、验证器缺失及正常对照通过 |
| 活动宿主 | detached restart 与 listener 两次采样 | 新进程持续监听；runtime_status 可调用 | 证明重载后服务可用；没有给生产库注入故障 |
| 活动执行反例 | deploy-verification-20261123-0905：缺 inputFile，仅有 outputFile | reconciling / invalid_verifier_primitive，toolCalls=1；输出文件实际存在 | 揭露验证输入检查发生在副作用之后；不得记为完成 |
| 活动执行对照 | deploy-verification-20261123-0905-control：补齐 inputFile | completed；独立 read 读到 host-validator-ok | 合法参数的宿主写入与验收链可用；不是修复事件投递证据 |

上述两次调用的输出在宿主工作目录，不是会话工作目录。任务 ID 明确标记为部署验证，但当前执行接口没有强制的 origin 分类字段；不能把文字标记当成已实现的分布隔离机制，后续治理接线必须显式排除这类样本。

## 按结果改变任务

1. 已构建部署既有状态修正；生产故障仍以未注入记录。
2. 新增优先任务 1a：在生成候选前验证全部所需输入，包括后续步骤与 targetFile 约束；以坏输入零派发、零写入为完成条件，已完成。修复后全包 614 项、613 通过/1 权限跳过；组合包定向 34/34。再次重载后的负对照 deploy-verification-20261123-preflight-negative 返回 waiting_analysis / invalid_verifier_primitive，attempts/toolCalls/ioOperations 均为 0，文件系统确认输出不存在；正对照 deploy-verification-20261123-preflight-positive completed，独立读取确认输出内容。字段形状提前检查不等于预读所有输入文件，也不改变故障后恢复的语义。
3. 被动修复收件箱没有进入 govern 的读取链。先实现可审查的有界只读接口，再定义可核验来源和消费契约；单纯等样本不能补这段代码。
4. SAG 运行时适配器仍主动拒绝无法核验身份的读写。须实现所属域和版本验证，不能把补 key/endpoint 当作修复。

## 收件审查交付

新增 readRepairEventPage 与 valve_repair_events，采用原生只读 SQLite 连接；默认 20/最多 100 条，完整 JSON 响应最多 64 KiB，单条 payload 最多读取 16 KiB。稳定 rowid 高水位分页依赖追加式收件表；删除、替换与 VACUUM 不属于跨页历史快照保证。缺库显式 unavailable；损坏显式 error；超大或坏 JSON 行保留行身份及状态，不改写也不接受其为证据。

源码 valves 全包 349/349；真实宿主编译加读边界定向 24/24；组合包同组 24/24，383 文件与源一致。测试覆盖缺库无创建、打开前删库竞态、并发追加、超大内容、坏 JSON、完整响应字节上限，以及读取前后数据库/WAL 字节和治理账本不变。重载后活动 valve_repair_events 返回 {status: unavailable, code: database_missing}，预期存储位置仍无数据库。这证明新工具可调用且未假报空收件，不是生产投递或治理消费证据。

## 修复证据与治理计数

运行时新增同事务生成的版本化 evidence 封装，来源为持久尝试/验证记录。恢复游标仍是 restored，不被提升为 verified_success；缺来源分类/原则引用/工具版本继续标为 unknown 或 unavailable。固定 producer/unreviewed/governanceEligible=false，尚未独立解析证据。隔离集成测试实走 store→outbox→接收→丢回执重试→重开→只读审查，封装内容一致且治理决策计数保持 0。

治理侧实测发现同一 trace_ref 改三个 source 会被当成 3 条反例、3 种来源。新增去重和来源冲突排除，独立引用保留原路径。源码两个包合计 974 项，973 通过/1 权限跳过；组合包 385 文件一致、定向 35/35。已重载宿主，使用 origin=verification 的同输入对照：修复前生成 redefinition_proposed；修复后 anti_example_count=0、duplicates=2、conflicts=1、source_diversity=0，无提议；三条独立引用正对照仍生成需要人工确认的提议。两次对照的 daily sample_total 均为 168，没有把部署验证混入分母。

这些引用明确使用 verification-only 前缀，是声明计数及部署测试，不是真实原则反例。新运行时封装已构建并通过隔离实际管线，尚无活动宿主真实修复事件证据。完整字段和后续接线顺序见[修复证据契约](repair-evidence-contract.md)。

## 显式任务来源与原则引用

新增 origin/principleRefs 的任务入口与持久化契约，数据只保留声明性质；省略不推断 daily，空数组不等于未声明。宿主编译路径的正反对照覆盖合法执行和非法来源/null/空白引用无任务行、无产物；存储测试覆盖重开、恢复及重复任务 ID 不能改写既有来源。两包 984 项首轮 981 通过、3 跳过；补指定宿主目录的 entry 12/12 后合计 983 通过、仅 1 符号链接权限跳过。组合包 387 文件一致，定向 21/21。

重载后实际调用 deploy-verification-20261123-provenance completed；只读 SQLite 读回 origin=verification、principleRefs=[verification-only:task-provenance]，输出文件内容为 provenance-verification。空白引用反例在入口拒绝，数据库无对应任务且产物不存在。旧 preflight-positive 任务仍无来源/原则声明，没有追认历史。

同时修复来源多样性把缺失来源计作一个独立来源的问题，活动调用缺 source 时 source_diversity=0。此调用看到 sample_total=169，较上一轮 168 多 1；账本新增项是 01:26:43Z 的 downward_L2_L3/daily，时间早于本次任务部署验证，并非新 runtime 任务自动写入的治理行。行内缺 tool/target 等归因字段，不能认定具体对象。源码 memory/valves-bridge 的写入桥固定 daily 且只向门传目标字符串，需继续核验并补身份；这也是下一轮计划 4 的具体入口。

## 只读动作污染准入分母

追查时实机调用 memory_capability(action=read,name=sag-cli)，账本从 268 行变为 269 行，新增 daily/admitted/downward_L2_L3；不是推测。根因是记忆工具包装层按工具名分派 WRITE_LAYERS，忽略 action，使 capability 的 list/read 和 dao 的 list_candidates 也走写入记账。已按分支排除，只读不再计入准入；真实 record 正对照仍有且仅有一次。源码和组合包定向各 8/8（含宿主 schema 19 断言），组合包 388 文件一致。重载后同一 capability read 调用成功，账本仍 269 行。

额外实机发现 dao/list_candidates 的执行返回值与 output schema 不匹配，宿主拒绝输出：固定的写入结果字段被设为必需，列表字段又被禁止。测试桩只跑 execute，没验证输出边界，因而未发现此缺口；列入下一轮任务 4 的首项，并一并检查目录读取错误不能被伪装成空列表。当时该工具不可用，后续修复见下节。历史 daily 污染记录缺动作身份，保留原样不追认、不删除。

## 候选公理的实际输出边界

memory_dao 的正式写入、候选写入、列表现使用三种严格 oneOf 输出分支，正式写入原有必需证据不放宽。列表过去还调用了未定义的 readText，其 ReferenceError 被吞成每条候选不可读；现改用实际文件读取。只有候选目录 ENOENT 可以表示空列表；ENOTDIR/EACCES/EIO 报错，单项读取失败以 unreadable/error 表示，命题和来源数量未知。

新增 10 个契约用例使用安装中的真实宿主编译器、输出校验器及 renderer；另有缺必需证据/额外字段的拒绝反例、真实候选写入后列表对照。源码定向 23/23，组合包加 schema 检查 24/24，389 文件一致。权限/I/O 反例采用确定性注入，ENOTDIR 则用真实文件占据目录的位置。重载后实机 list_candidates 被宿主接受并展示 0 条候选，账本仍 269 行；非空与候选写入只在隔离环境验证，没有向真实记忆制造公理候选。列表仍按现有契约列出所有候选，不声称有分页或资源上限。

独立证据解析已完成只读设计审计、尚无实现：RuntimeStore 打开有建表/迁移副作用，完整证据在不可变 events 而非 outbox 标记；实际目标证明与当前哈希一致必须分开。验收已细化至[证据契约](repair-evidence-contract.md)的 2a/2b/2c，下一步从宿主绑定生产者的精确只读读取开始。

## 精确只读证据解析的模块验证

运行时只读查询已能按生产者/事件精确核验任务、修复、已消费分析、绑定尝试、配方与验证器及完整证据封装；接收端新增精确复合键查询。组合解析器由可信构造配置注入来源绑定和读取器，比较实际接收 payload 与生产事件投递结构；请求路径和构造后的外部配置修改不能扩大读取范围。已确认投递后仍可查，不依赖 pending outbox。

实际 RuntimeStore → receiver → 双端解析的隔离测试通过，包含键顺序规范化、接收篡改、错身份和“verified_success 但 goalSatisfied=false”对照；匹配结果固定 record_consistency、governanceEligible=false，文件/目标/原则归因均未评估。另修复原型读取中的 native SQLite TEXT 内嵌 NUL 截断风险，用 SQL 有界 BLOB 投影后解码，非法尾部不能变成合法前缀。主库/WAL 持久字节不变，但 SQLite 可更新 SHM 临时读标记，不能宣称侧文件绝对无变化。

双包源码全量 1003 项，1002 通过、1 跳过；组合包定向 38/38，394 文件一致。组合产物已生成并位于安装 junction，尚无宿主服务注册/可信来源配置/工具入口，本轮没有把模块测试冒充活动宿主验证，也未为此重启。下一项是宿主接线，然后文件复核、独立归因、持久审查与幂等消费；详见[证据契约](repair-evidence-contract.md)。

## 宿主服务与工具接线的隔离装配验证

运行时现发布冻结的 executionRuntimeEvidence 服务，producerId 来自现有宿主身份，数据库路径仅保留在私有闭包；只接受 producerId/eventId，路径与额外字段均拒绝，卸载后旧服务引用不可用。阀门新增 valve_repair_identity，按调用时服务发现核对双端；组件晚加载不会被永久认作缺失，返回仍仅有记录一致性的含义。

安装版 Cordis/ToolRuntime 中同时装配真实运行时和阀门插件，诱发原生 JSON 任务首次验证失败，通过固定分析响应修复，再经实际接收器、投递确认、卸载重装和新工具完成身份核对；两个库的持久字节不变，无治理账本。分析响应是测试替身，任务显式 verification，不能记为真实生产修复。对照覆盖缺服务、缺库、错身份、额外路径及旧服务卸载。

这条联合测试首先暴露 EBUSY：阀门监听 dispose 事件，但安装版 Cordis 通过 ctx.effect 驱动释放，接收库句柄未关闭。改为 effect 清理并捕获本次 runtime，联合测试及卸载后服务消失断言通过。宿主工具边界对额外参数的拒绝不能只依赖 schema，执行方法显式限制自己的字段。

源码双包 1007 项，1006 通过/1 跳过；组合包宿主接线定向 18/18，395 文件一致。本轮未重启当前 3080，计划与下一项有界文件复核合并重载，活动调用仍单列待验收，不将隔离装配冒充线上验证。

## 尚未兑现的结论

没有真实修复事件进入治理并推动经过人工确认的规则变更的证据。没有 Jev 三臂生产分布证据。没有对缺失历史原则引用作追认，也没有调整阈值来迫使状态转绿。
