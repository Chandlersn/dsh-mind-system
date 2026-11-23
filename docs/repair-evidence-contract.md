# 修复证据接线契约（2026-11-23）

## 当前已实现

`repair_finished` 的既有字段保持兼容，新增 `payload.evidence.schemaVersion = 1`。证据由 `finishRepair` 在同一事务中从已持久化的任务、已消费分析、修复、尝试及验证记录生成，事件与 outbox 标记原子提交。发送端从不可变事件恢复完整 payload；接收端以 `(producerId, eventId)` 去重。旧事件不回填或推断证据。

证据包含任务/修复/分析/尝试标识、执行和验证状态、验证器 ID/版本、进展、目标满足状态、已有 evidenceRefs、配方版本及工具名。工具版本仍没有可信的持久来源，明确不可用。任务入口现可显式声明 origin（daily/verification/drill）及 principleRefs（最多 32 个、每个不超过 256 字符的非空白字符串），两者进入任务快照；省略时不补默认值，空数组与未声明保持不同。修复事件读取持久任务值并标记 declared，声明不等于已验证的来源或原则采纳。原始工具输出与验证 trace 不复制进事件。

| 状态 | 含义 |
| :--- | :--- |
| verified_success | 同一尝试的执行成功，持久验证 pass，且目标满足或进展 advanced |
| verified_failure | 已结算尝试的执行失败或验证 fail；不自动证明任何原则失效 |
| no_progress | 已结算但没有可证明的进展 |
| restored | 恢复游标；旧字段 succeeded=true 不代表重新验证成功 |
| blocked / observed / unknown | 分别为未能执行、只收集信息、结果仍未确定 |

全部封装固定 `attestation=producer`、`reviewStatus=unreviewed`、`governanceEligible=false`。这里 verified 仅指生产端存在符合状态约束的持久验证记录，不表示外部独立复核。审查接口保留 `raw_producer_claims` 标识；收到、读到、重放事件均不增加治理决策数。

## 治理端现有引用入口

手工传给 `valve_govern` 的反例引用仍属于调用方声明，尚无自动文件/事件解析器。统计按去首尾空白后的 trace_ref 去重；同引用的来源声明冲突时整组排除并报告 `anti_example_conflicts`；多次出现报告 `anti_example_duplicates`。重复声明不能制造多条反例或多种来源；未声明或空白来源不增加来源多样性。不同引用仍可能指向同一底层证据，这需要下述解析层处理，当前不能声称已经解决。

## 剩余接线顺序与验收

1. **持久来源分类（基础实现已补）。** 任务显式声明已持久化并传入证据封装，历史任务仍为 unknown。后续消费必须实际过滤 verification/drill，不能把声明的 daily 当独立来源证明。工具版本仍需工具注册拥有者提供。
2. **独立解析与归因。** 使用生产者身份和事件 ID 读取对应持久证据，核验任务/尝试/验证器版本一致，并解析 evidenceRefs。现有内置验证器生成 `file:<path>#sha256:<digest>`，可从宿主允许的工作区重新读取并校验哈希；解析器必须拒绝越界/链接逃逸、未知格式，并限制字节与条数。内容缺失、过期、异域、无法解析必须拒绝或 unknown。验证失败不直接等于原则反例，需单独归因。
3. **持久审查与幂等消费。** 保存审查版本、证据身份、判断依据及游标。收到、已审查、治理已消费三个计数分开。同事件重送或等价引用不重复计数；冲突版本不能覆盖旧判断。消费结果与游标须原子提交，失败可重试。
4. **接治理候选。** 只有经上述检查的事件可形成候选。规则生效继续经过既有人工确认；不允许由修复事件直接写负向规则。用独立正对照和重放、失配、缺证据反例验证，再以真实任务记录验收。

当前 2a 的只读生产端读取、接收端精确查询及双端一致性解析已有实现和隔离链路测试；宿主私有路径绑定服务 executionRuntimeEvidence 与 valve_repair_identity 工具已接入并通过安装版宿主隔离装配；当前 3080 进程仍待重载行为验收。工具版本可信来源、2b/2c、第 3–4 项及真实治理闭环仍未完成。任务声明、封装、接收和记录一致均不等于这些任务完成。

## 第 2 项的实现边界（2a 已接宿主，活动验收及 2b/2c 待做）

- **2a 精确身份读取。** 宿主固定 `producerId -> runtimeFilePath + workspaceRoot` 映射和 inbox 路径，请求只接受 producerId/eventId。分别用只读 SQLite 事务读取接收端精确复合键与生产端不可变事件、同任务修复/分析/尝试/验证记录，并在 SQL 侧限制字段字节。禁止借用会建表/迁移的 RuntimeStore 或会 INSERT 的 getProducerId。已确认投递的事件也应可查；不能拿 pending outbox 或最新尝试代替绑定事件。比较完整事件的投递结构与接收端 canonical payload；outbox 的 status 标记不是完整证据。
- **2b 文件复核。** 仅解析受支持的原生绝对路径及末尾 `#sha256:` 摘要，不作 URL 解码。由宿主允许根约束读取；事件自报 workspaceRoot 不授予权限。限制引用数、单文件/累计字节和输出体积，使用描述符分块读取，检查文件身份及元数据前后变化。明确区分 match/mismatch/unknown/error；不支持的引用、缺文件、目录逃逸、链接、超限或变化不许静默跳过。具体限额在实现时固定并以边界反例测试。
- **2c 独立归因。** 两库记录一致与当前文件哈希匹配均不等于独立目标验证。生产端 verified_success 可表示 advanced 而 goalSatisfied=false；执行失败也不是原则反例。返回保留 `goalProof=not_evaluated`、`principleAttribution=not_evaluated`、`governanceEligible=false`，直到有外部判据及适用性、预测、结果和其他原因的审查。

最低反例集：错误生产者、跨任务/尝试/验证器、已确认投递事件、篡改 payload、缺失/损坏/超大数据库字段、历史无证据和 restored、同长不同内容、未知引用、所有读取上限、链接及路径逃逸、读中变化；另设“哈希匹配但目标错误”对照，确认不会升级为目标证明。读前读后确认没有创建数据库或修改 outbox/治理账本。

2a 当前 API：运行时 `readRepairEvidence({runtimeFilePath,producerId,eventId})`，阀门 `readRepairEventByIdentity({filePath,producerId,eventId})`，组合 `createRepairIdentityResolver({inboxFilePath,sources,readRuntimeEvidence}).resolve({producerId,eventId})`。配置在构造时复制绑定；也支持 sources 中的 readEvidence 宿主闭包。活动接线每次从 executionRuntimeEvidence 服务取得当前 producerId 和只接受身份的读取方法，数据库路径留在运行时私有闭包中，请求或事件自带路径不能替换它。服务缺失/卸载后显式不可用，不缓存启动时的缺失。组合结果 `attestation=record_consistency`，文件/目标/原则归因均 not_evaluated，治理资格恒 false。已确认投递、两端键顺序差异、篡改/错身份、缺库/损坏/超限及“生产者成功但目标 false”对照已验证。

生产端当前限制：主库加 WAL 预检 64 MiB，SQL 单字段 256 KiB、累计字段 1 MiB；接收端保留单 payload 16 KiB、响应 64 KiB 限制。超限明确 unsupported/unresolved；这不是完整历史库的可扩展方案。TEXT 以 BLOB 有界读取再解码，防止内嵌 NUL 被 native TEXT 截断后误认合法前缀。记录后若未知尝试又被协调更新，当前记录与旧事件可能不一致，拒绝匹配，不重写历史。

只读边界：不迁移/建库、不改持久记录/outbox/治理账本，测试前后主库和 WAL 内容一致；SQLite 读事务可能修改 SHM 临时读标记，不承诺其字节不变。严格零侧文件变化需要宿主提供已检查点化的不可变快照。库大小预检不防止检查后的并发增长，不能作为对抗式磁盘上限。

并发边界：单库事务不提供两个库与文件的原子快照；通用 Node 路径检查与描述符前后检查不能保证抵抗恶意父目录置换、同大小改写并恢复时间戳或硬链接别名。第一版须明确协作式文件系统边界，检测到变化返回 unknown；若需对抗式保证，必须采用宿主不可变快照或平台专用的安全打开机制，不能宣传为无竞争窗口。
