# 写入调用与实际文件操作的关联契约

状态：最小关联基础与有界原始行查询均已实现并构建；本轮记忆全量回归通过，组合查询相关 56/56（406 文件一致）。前轮 valves 366/366、组合关联相关 76/76。活动宿主以实际 capability 登记验证 v2 准入、操作行和查询同 ID，独立读取文件哈希一致。对应 UPGRADE-PLAN 队列 4；先完成同次调用关联，再谈执行结果、采纳和反馈。

## 同一对象的读后使用链（object_trace，2026-11-23）

`memory_read(kind=object_trace, objectKey=<canonical key>)` 是**只读**查询，把一个逻辑对象串过 write（物理账本）→ index（MEMORY.md 行）→ recall（usage 曝光）→ read（usage 读取）→ adoption（账本中声明的 positive/correction 信号）。每跳独立报 present/missing/unknown/not_observed/not_applicable 与有界证据指针；`absenceMeansNoWrites/NoAdoption=false`。adoption 的 present 只表示发现匹配记录，不认证用户身份，也不证明真实采纳。

设计取舍：**身份不落盘、只派生**。`canonicalObjectKey()` 是单一纯函数，从已校验的 `target/key/href` 现算出规范对象键（`src/object-key.js`），不新增账本字段、不改必填 schema、不改任何计数口径。这样避免"落盘字段与派生值两份身份不一致"，且 v1 旧行天然可读；派生不出即 unknown，绝不编造。调用方传入的 `objectKey` 只作查询过滤、永不作权威身份。

认知边界：write/index/recall/read 只报告账本中的对应记录，recall 仍只算曝光不进 uses；adoption 匹配对象键一致的 `positive/correction` 账本行，包括调用方声明和来源未经验证的历史行。`present` 仅指信号记录存在；`not_observed` 不证明没有采纳。该 hop 固定标注 `attestation=usage_signal_record`、`provenance=unverified_legacy_or_caller_declaration`、`userIdentity=unverified`、`goalProof/principleAttribution=not_evaluated` 和 `governanceEligible=false`。分页接口 adoption-evidence 为兼容保留 `provenance=caller/user-action`，该值不认证用户身份或证明真实采纳。查询过程不 appendUsage、不 recordDownwardWrite、不改账本/索引/计数，验证前后字节与 mtime 不变。有界：单文件 8 MiB、行 64 KiB、10000 行、256 匹配、响应 64 KiB、分片上限 48；任一源超限或坏行 → incomplete 且丢弃全部匹配。真实账本首行带 UTF-8 BOM 属合法历史数据，按行剥离。真机抽样：`functions/心智编排层.md` 读到 3 写/127 曝光/45 读/未观察到匹配信号，`insights/读数先经旁证再行动.md` 有曝光无读取——曝光不等于使用或采纳。

覆盖边界不变：MEMORY.md 本体、技能文件、federation 副本、暂存清理、外部编辑器/shell 未纳入 per-object 账本，trace 对这些如实 unknown/not_applicable，不宣传全链完备。

## 已核对的断点

memory 的 transactionTool 在进入根事务队列前记录准入。根事务只有按规范根路径组织的共享 Promise 队列，没有异步调用上下文、回滚或跨进程原子性。实施前 write_context v1 保存请求对象，write-ledger 保存部分实际文件操作，二者没有共同 ID；当前 v2 及受作用域覆盖的行已补共同 ID。相同名称、时间接近、相同内容均不能代替调用身份。

## 已实现的关联基础与下一步查询

1. 新建共享 operation-context 模块，以版本化 Symbol.for 保存 AsyncLocalStorage。包装器每次调用生成新的 UUID，作用域包住准入和等待根事务完成；辅助函数继承同一 ID。参数不能指定或覆盖 ID。结束时关闭上下文，脱离生命周期的延迟回调不能继续归属旧请求。不要用全局 current-id 或 enterWith。
2. write_context 严格增加 v2：原十个字段加 request_id；继续读取严格 v1，保留无关联状态。执行结果和采纳仍为 not_observed。保持当前五类写工具的准入选择、顶层 origin/decision/outcome 和计数不变。
3. 在 write-ledger 的 recordWrite、recordDeleteEvent 入口同步捕获有效上下文，在已有行上追加 request_id。无作用域不补 ID，忽略调用方自行提供的 entry.request_id。删除意图/完成的原 id 不变：它配对单次删除，request_id 关联整次调用。
4. memory_read(kind=operation, request_id=<canonical v4 UUID>) 读取宿主配置根的原始行，入口拒绝路径和其他模式参数；不追加准入或使用计数。上限：8 MiB 文件、64 KiB 单行、10000 行、256 匹配、64 KiB 序列化报告。全段验证含无关/旧行；坏尾、截断、并发变化或超限清空匹配并标扫描未完成。直接根/账本链接、硬链接和非普通文件拒绝；只承诺协作式文件系统观察，不承诺恶意竞争安全。现有 readLedger 的每路径最后状态未用于此查询。
5. 查询区分 missing/error/unknown/incomplete/match/no_matching_rows；scanComplete 只指受限账本扫描，execution/adoption 始终 not_observed，absenceMeansNoWrites=false。未受跟踪写入不在账本中，空结果不证明没写。查询报告单独渲染，不套用旧读取分支的“空目录”文案。活动验收需同时加载 memory 作用域/查询与 valves v2 解析器，单独热换 memory 不足以证明跨包协议生效。

## 验收

- 实际注册工具→真实 valves→准入落盘，与真实 write-ledger 原始行拥有同一 ID；独立读取文件字节确认操作确实发生，不能只比较自产 ID。
- 同目标重复调用 ID 不同；并发不同根、排队同根及根路径别名不串号；多份 ESM 模块共用作用域；await 后继承，调用结束及失败后清理，延迟回调不泄漏。
- 同调用的多文件、candidate/active、supersedes 保持独立操作行。索引目标是逻辑条目，不得伪造对应正文文件被写入。
- 已提交文件后清理失败、账本追加后抛错、提交确认丢失分别保持原错误及实际可观察行。不删前序行，不从抛错推断没写，不从已有行推断工具成功。
- 旧 v1、旧物理行、无作用域及缺 valves 服务保持未知或无法配对；不改回执形状，不增加 completion decision，不改变准入统计分母。

## 覆盖边界

当前物理账本不覆盖 MEMORY.md、技能文件、federation 副本、暂存清理及部分旁路日志。面板/归档/采集即使用了根事务，也没有相同的工具准入身份；外部编辑器、shell、其他进程均未覆盖。最小实现只关联已有受跟踪操作，不宣传整次写入完备性。

记录位于文件提交之后，追加可能失败或结果不确定；工具可能写完正文后在更新索引、自检或清理时抛错。request_id 只标识作用域，既不是调用成功证明，也不是当前文件版本或原则采纳证明。result: reverted 仍是调用方正文声明，不能当作实际回滚。
