# dsh-execution-runtime

本包提供 DSH 任务调度器、SQLite 运行库和 Cordis 宿主入口。合成包可装载它；源码包自身标为 `private`，要求 Node.js ≥22.23.0。默认合成配置启用运行时、允许动态任务分析，并以空原生任务列表启动。`no-tasks` 只影响按引用启动原生任务。宿主装配或 schema 校验器不可用时，应查看 `load-failed` 和具体错误。[宿主装配](src/host-plugin.js) · [启用测试](test/host-enablement.test.js)

## 执行与验收

| 入口 | 输入、权限与结果 |
|---|---|
| `runtime_run` | 传入 `taskRef`。目标、配方、工作区、工具许可和可选验收合同来自宿主注册的原生任务。 |
| `runtime_execute` | 调用方提供目标、输入、配方规格和预期结果。支持单步、多步 `steps[]` 及 `next[]` 分支。挂载实例决定工作区、范围、可见工具和可信副作用声明。 |
| `runtime_verifiers` | 列出验收原语 `exact_bytes`、`line_set`、`structure`、`sorted_lines`、`json_fields` 和分支条件 `file_exists`、`file_sha256`、`step_less_than`、`always`。 |
| `runtime_status` | 查看已注册任务及运行状态、原因、预算和配方绑定覆盖情况。数据库标识来自 SQLite 主库路径的哈希，同一标识不足以识别被替换的数据库文件。 |
| `runtime_recovery_diagnosis` | 只读比较持久化原生绑定与当前注册；匹配只涉及可比较的字段，手写配方的完整身份未知。查询不授权恢复。 |

调度器检查范围、模板版本、宿主与配方的工具许可、必需前置条件、参数 schema 和副作用声明。只有 `read` 和 `reversible_write` 可进入派发；不可逆或未知效应在执行前被拒。规则模式需要唯一的准入候选。已选动作在派发前再次准入，工具随后走调用 Agent 的公开宿主管线。没有计划或选择有歧义可进入 `waiting_analysis`，检查条件不可用可进入 `waiting_human`；已派发且结果未知的动作冻结在 `reconciling`。[准入](src/admission.js) · [调度器测试](test/scheduler.test.js)

`runtime_write_json` 和 `runtime_write_text` 在挂载工作区内独占新建文件，通过临时文件和硬链接发布完整内容，遇到已有目标、`createOnly:false` 或不支持硬链接时拒绝。`repair.replaceTool: true` 可额外注册按目标哈希核对的 `runtime_replace_json`，使用它仍需任务和配方同时授权。路径检查的保证以协作式文件系统为前提。[写入工具](src/write-tools.js)

读运行结果时应区分两个字段。

- `status: completed` 表示已通过该配方登记的验证器。动态配方的验收原语和参数由调用方选择；检查目标是否被充分表达仍需核对判据。`sorted_lines` 可核对输入与输出的重复行计数，`json_fields` 按指定字段比较值。
- 原生任务可另外配置 `acceptanceContract`。受支持的 v1 合同在派发前绑定原生引用、合同与授权；运行后重读工作区文件，单独报告 SHA-256 谓词结果。`status: completed` 和 `acceptance.status: fail` 可以同时出现；文件缺失可返回 `unknown`。该结果不证明整体目标、原则归因或治理资格。[宿主验收用例](test/acceptance-host-guard.test.js)

## 预算、持久化与恢复

数据库使用 `stateDir`，未指定时使用 `DSH_HOME/execution-runtime`，再回退到工作目录的 `.execution-runtime`，文件名为 `runtime.sqlite`。动作、工具调用、逻辑 I/O、判别和分析分别计量。验证器声明的 I/O 在业务派发前预留；超出预算会停止。逻辑读取量和模型调用次数不能换算为系统调用数或 token 消耗。[存储实现](src/store.js)

租约和递增的 `fence` 用于拒绝失权写者后续的预留和结算。`recoverRun` 冻结未结尝试，保留已用预算。旧 worker 的在途副作用仍可能稍后发生，调用方声明的 `evidenceRef` 不足以自动对账或重放。底层有暂停、环境比对、恢复预留、检查点和补偿逻辑；绑定了原生验收合同的任务拒绝恢复、修复和对账，绑定了生成配方的任务也拒绝恢复、修复。工具入口只提供恢复诊断。[迟到副作用测试](test/late-effect-recovery.test.js) · [配方绑定测试](test/recipe-run-binding.test.js)

## 异常分析与原生修复

宿主可使用显式配置的 HTTP 分析器，或使用可用的宿主 LLM。动态任务还要求 `analysis.allowDynamic: true`；调用方的任务参数不能启用它。异常包可能包含目标、工作区路径、参数、结果和证据引用，传给所配置的服务时无脱敏保证。分析受任务截止时间、分析预算和传输超时约束，迟到的结果不会取得派发权。[分析装配](src/host-plugin.js) · [动态任务分析测试](test/dynamic-analysis-host.test.js)

动态任务只记录提议。原生 `runtime_run` 的自动修复入口要求模板启用 `autoRepair`、任务处于 `waiting_analysis`、分析路线为 `repair_directly`，并有持久、未消费、无需人工复核的 `retry_with`。候选须匹配原配方版本和许可工具，重新准入后由原验证器核对。JSON 修复策略另查产物所有权与预期哈希。底层调度器还处理受信探针取证、放弃和有检查点的回滚；原生工具的自动分支只选择符合上述条件的重试。未知结果保持冻结。[原生派发条件](src/plugin.js) · [原生修复测试](test/native-repair-entry.test.js) · [修复策略](recipes/json-repair.js)

`tools/post-execute` 可在重复且相关的失败后附加可选提示，默认阈值为两次。提示只提供入口；是否采用、后续目标是否达成需另查。[介入策略测试](test/intervention.test.js)

## 跨任务修复模式与阀门

模式汇总器按 `repairId` 去重，按已结算且明确成败的修复计算成功率，另按不同 `taskId` 计算覆盖数。达到阈值可产生候选。**当前宿主的持久记录无法直接供此解析器复用。** `listPatternEvidence()` 按签名返回分组，`taskId` 和 `repairId` 在 `repairs[]` 内；解析器把整组直接传给要求顶层逐条身份的汇总器。非空分组进入汇总时会被拒。解析器测试注入扁平样例，不能据此断言真实历史已触发命中或减少分析调用。[数据库输出](src/store.js) · [解析器](src/pattern-resolver.js) · [汇总器](src/repair-patterns.js) · [解析器测试](test/pattern-resolver.test.js)

`runtime_pattern` 用 `patternId` 选择宿主登记的正文，并检查批准状态、到期时间和正文版本。`human:true` 是调用声明；显式委托策略也可在满足条件时签发标记为 `automation:` 的批准。启用 `valves.enabled` 后，宿主优先使用传入的 `confirmRule`，缺省时可调用已挂载的 `valves.confirm`。后者自行签写入许可；桥未传 `human` 或 `permit` 不能证明有真人在场。要求真人批准的部署由宿主写入端核实该条件。[批准条件](src/pattern-approval.js) · [阀门桥](src/valve-bridge.js) · [宿主写入端选择](src/host-plugin.js)

独立的修复事件投递路径已经接入。修复结算时在 SQLite 事务中保存 `repair_finished` 及待投递记录；宿主派发器向 valves 接收器投递，按回执标记，未确认可重试。接收、双端记录一致、复读当前文件字节和持久技术审查分别回答不同问题。它们不会自动确认规则，也不提供目标或原则归因证明。[投递器](src/outbox-dispatcher.js) · [宿主证据集成测试](test/host-evidence-service.test.js)

## 历史配方与知识接口

`runtime_recipes` 返回历史规格。`identity_unverifiable` 表示无法核验身份，`identity_verified_requires_admission` 表示身份匹配且重新使用仍需当前授权和验证。历史计数混合所有来源，可能丢失或重复；`verifiedRuns` 仅计通过所选验证器的完成。新记录只把 `failed` 和 `cancelled` 计为失败，历史失败计数可能含其他状态。排序用于检索，无法独立证明生产成效。损坏的规格返回 `recipe_library_corrupt`。[配方库](src/recipe-library.js)

`runtime_status` 的 `recipeOutcome.coverage` 区分 `bound`、`unbound`、`unavailable`。`runtime_recipes(bindingLimit)` 可另查 1–100 行绑定汇总；加 `bindingCursor: ""` 从第一页开始，后续传 `nextCursor`。分页固定 rowid 高水位，状态逐页取快照；游标由调用方控制，部分不可读的数据保留为未知。成员稳定性依赖正常隐式插入、无替换或删除、无 VACUUM 或数据库替换。历史未绑定任务不回填。`origin` 取自声明。[绑定读写实现](src/store.js)

`runtime_knowledge` 要求 `domain`（`formal`、`workspace`、`scratch`）、对象 ID 和版本。默认适配器关闭。内置 SAG 适配器无法验证域、对象与版本；配置有效凭据后，读和带路径的写均在发起检索或索引前以 `knowledge_identity_unsupported` 拒绝。无密钥的读、缺路径的写各有自己的错误。抽象接口支持可信适配器分别报告存储与索引状态；已注册目录的正文检索由记忆插件的 `memory_sag` 提供。[SAG 适配器](src/knowledge-sag.js) · [知识接口测试](test/knowledge-wiring.test.js)

## 验证

在本包目录运行 `npm test`。宿主集成用例需能解析已安装的 DSH 模块，可用 `DSH_SEAM_HOST_ROOT` 指定安装根；涉及 valves 的集成测试也可设置 `DSH_INSTALL_DIR`。变异测试和外部探针的命令见[包脚本](package.json)。真实 Jev 探针另需 endpoint、model 和 API key，缺少配置时报告 `external_dependency_not_verified`。
