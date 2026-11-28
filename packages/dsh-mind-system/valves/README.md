# dsh-valves

本插件评估下行约束、上行候选及原则失效条件，记录裁决，维护负向规则，并接收其他插件的观察记录。**使用 `valve_confirm` 更改规则前，需要用户对具体动作明确确认。** `confirm`、`rollback` 和 `sink` 的宿主服务方法自行签发写入许可；能调用该方法的一方即可发起写入。账本中的 `direction: human` 或 `human_confirmed` 是通道标签，无法认证调用者身份。宿主向自动化提供写入函数时，真人授权要在该边界核实。[宿主入口](index.js) · [写入许可测试](test/guard.test.js)

## 为什么做这个

同一条负向经验可以用于检查后续约束。把候选文本、关键词匹配和裁决结果记下来，使用者就能追查某次拒绝，也能看到哪些候选获准、降级或转人工。若要判断拦截是否准确，还需要对照独立标注的案例。

## 与记忆插件的分工

**判据单一实现**体现在写入边界。记忆插件在自己的写入入口检查素材与层级要求，阀门负责评估提交的候选、维护负向规则并记录裁决。可选桥能把规则匹配带入召回、把写入准入信息带入观察账本；写入是否完成须查记忆端的执行结果。

## 配置与用例

默认阈值全部暂定。下面的配置保留默认层级与巡检，并将技能快速通道关闭。`storageDir` 和 `dshRoot` 留空时分别使用默认存储位置和宿主定位逻辑。[独立插件装载补丁](https://github.com/Chandlersn/dsh-mind-system/blob/main/packages/dsh-valves/cordis.patch.yml) · [阈值定义](src/thresholds.js)

```yaml
config:
  storageDir: ''
  dshRoot: ''
  layers: [L0, L1, L2, L3]
  thresholds:
    skillFastTrackConfidence: 0
  patrol:
    enabled: true
```

例如，检查一条 L1 到 L2 的约束时，可向 `valve_check` 传入以下参数。`origin: verification` 将这次验证与默认日常样本区分；服务会读取当前规则并匹配约束文本，所以返回值取决于该规则库和本次检查。

```json
{"direction":"down","from":"L1","to":"L2","data":{"constraints":["Check that the target file exists before reading it"],"origin":"verification"}}
```

## 裁决、规则与巡检

| 工具 | 输入与作用 |
|---|---|
| `valve_check` | `down` 检查层级、可执行约束和负向规则；`up` 检查证据声明及量化门槛；`principle` 检查原则失效条件。`semantic` 只标记疑似语义越权，可选嵌入模型缺失时降级。裁决本身不写入生效规则。 |
| `valve_confirm` | `confirm` 新建或修订负向规则；`rollback` 按规则 ID 恢复上一版快照，同一规则回退满三次后转人工；`sink` 可按一个或多个 ID 将规则移出匹配并保留内容及快照。 |
| `valve_metrics` | 汇总已落账行的 `admitted`、`skipped`、来源、原因和门槛分布。`missRate` 是 `skipped / evaluated`，无样本时为 `null`。它没有统计应拦未拦的真实案例，无法直接给出误报率或漏报率。 |
| `valve_nominate` | `forbidden` 按 CLIS 失败签名生成候选；`skills` 使用调用方提供的使用量汇总，缺少汇总时报告本次未查，成功率仍需外部证据。一般提名可用 `check` 送入裁决；`clis_trace` 与 `criteria` 有各自的记录与裁决路径。 |
| `valve_govern` | 对给出的原则清单运行一轮治理，输出引用覆盖、反例与修改提议。可另读 CLIS 待审记录及采纳声明；`adoption_pending` 计当前页的行。读取这些记录不触发规则写入，也不把声明计为独立反例。 |

下行负向规则按关键词包含匹配。规则库缺失与读取失败分别处理，读取失败时下行转 `human_gate`。`staged` 规则参与拦截，默认在命中路径累计三次触发记录后可转 `full`。计数描述匹配次数，未核验每次命中的正确性。巡检按默认 90 天窗口列出沉底候选，实际沉底由获授权的写入调用按 ID 执行。[匹配与规则存储](src/store.js) · [放量测试](test/rollout.test.js) · [沉底测试](test/sink.test.js)

阈值可由 `config.thresholds` 覆盖，装配遇到非法覆盖会记录错误并回退默认值。默认的技能正向门槛要求至少 5 次、成功率至少 0.7 且证据种类声明为 `external`；判据还检查证据记录及可外部检验说明。调用方提供的次数、比率和种类仍需核对原始证据。普通合格技能候选转人工；`admitUpward` 收到达到快速通道阈值的 `confidence` 时可返回 `accept`（默认阈值 1，设 0 关闭）。宿主服务用候选标识确定性抽样，默认比率 0.3，并尝试记录 `audit_selected` 或 `audit_skipped`。公开 `valve_check` 的 `data` schema 未列出 `confidence`。抽中只表示入选复核，裁决和抽样均不激活技能。[阈值](src/thresholds.js) · [裁决实现](src/predicates.js) · [快速通道测试](test/fast-track.test.js)

`criteria` 接受调用方提供的 `insight_files` 或 `collide_notes`。实验笔记的抽取器识别文本中的数值和可检验陈述，候选标记 `source_layer: experimental`；来源计数与文本匹配本身无法核验文件归属、内容真实性或预测效果。记忆插件仍负责其自身的写入门槛。记忆写入准入记录可携带 `request_id` 及目标键，`execution_result` 和 `adoption` 在该观察点均为 `not_observed`。[实验笔记测试](test/collide-adapter.test.js) · [准入身份](src/write-context.js)

## 运行时修复与采纳记录

| 工具 | 可核查的事实 |
|---|---|
| `valve_repair_events` | 返回接收库的生产者声明。默认每页 20 行，最多 100 行和 64 KiB；游标固定追加表的行号高水位。缺库、损坏或超限会报告状态。 |
| `valve_repair_identity` | 按 `producerId` 与 `eventId` 比较接收记录和宿主绑定的运行时记录；`match` 表示两侧记录一致。 |
| `valve_repair_artifacts` | 身份匹配后，在宿主工作区重读当前文件并比较字节哈希。最多 32 个引用、每文件 8 MiB、累计 32 MiB。 |
| `valve_repair_record` | 重新核对身份和文件，条件满足时**写入**技术审查快照。相同结果可重复提交，冲突不会覆盖原记录。 |
| `valve_repair_review` | 读取指定生产者与事件的历史技术审查。文件可能在审查后变化；读取不重新散列当前产物，也不创建缺失的库。 |
| `valve_usage_correlation` | 接收小写 UUIDv4 `correlationId`，有界比较 memory 与 valves 两侧的对象键、反馈类型和备注，分别报告 `compared`、`duplicate`、`not_observed`、`incomplete`。 |

修复事件由运行时的持久 outbox 投递给被动接收器。原始收件、双端一致、当前文件哈希、历史技术审查均有独立状态；即使匹配，也不证明任务目标、真人采纳或原则归因，治理资格保持 `false`。收件分页依赖只追加表，不提供跨删除、VACUUM 或换库的历史快照。文件复核依赖协作式文件系统。[双端核对测试](test/repair-event-identity.test.js) · [技术审查存储测试](test/technical-review-store.test.js) · [审查读取测试](test/technical-review-read.test.js)

使用反馈是调用方声明。关联查询的两个快照非原子，备注缺失时比较结果为 `unknown`。对端异步读取超时后，底层调用可继续；同一插件在其结束前不再发起新的对端查询。同步阻塞和事件循环停滞不受该超时约束。匹配不提升证据的治理资格。[关联查询测试](test/correlation-read.test.js) · [双插件集成测试](test/memory-adoption-correlation-integration.test.js)

## 账本与报告

- `storageDir` 默认使用宿主存储目录。`mind-valves.jsonl` 存裁决和独立的 `kind: trace` 行；`mind-negative-rules.json` 存规则，`mind-rule-triggers.jsonl` 存触发记录。裁决与 trace 分别追加且可能写入失败，检查时应分别查找。语义检查可用默认层路径；版本按规则 ID 取 `version`、`confirmed_at` 或占位值 `declared`。缺嵌入模型时语义检查标为 `skipped`。[记录结构](src/trace.js) · [语义检查测试](test/semantic.test.js)
- 普通上下行裁决默认记录 `origin: daily`，验证、演练和提名可显式标记。历史缺失来源保持 `untagged`。`admitted` 包含 `human_gate`、`downgrade` 等结果，统计实际写入或效果应另找证据。校准时应查看来源分布及日常样本分母。[样本口径测试](test/calibration-split.test.js)
- 原则引用覆盖率取窗口内声明引用的合格日常判定数除以合格日常判定总数。默认最小样本数为 10；样本不足或引用声明不完整时结果可为 `null`。空引用列表表示显式未引用。传入 `semantic_coverage` 表示调用方提供的语义判断，其来源未经认证。[治理实现](src/governance.js) · [覆盖率测试](test/governance.test.js)
- 周检与季度巡检默认启用，报告写入存储目录的 `mind-patrol/`。召回检查可使用显式回调或已注册的对端搜索服务；缺少可用探针时报告未知。层变更的提议、评审、启用及兼容映射有独立模块，公开工具见上表。[巡检测试](test/patrol.test.js) · [层变更实现](src/layerchange.js)

## 健康探针

| 代号 | 读取方式 |
|---|---|
| `valves.ok` | 已装载、声明的工具均已注册，当前探针未记录警告或错误。 |
| `valves.not-loaded` | 本进程尚未执行插件装载。 |
| `valves.tool-missing` | 声明的工具未全部注册，检查安装目录与装载错误。 |
| `valves.store-unreadable` | 运行时记录了存储读取失败。 |
| `valves.thresholds-overridden` | 配置提供了阈值覆盖项；非法值是否回退需结合装载日志判断。 |

## 借鉴出处

初版的上下行判据、阈值和外层巡检来自《心智系统开发说明书》§4.1、§4.2、§4.5、§9.2。双侧计数借鉴 CLIS 对 `evaluated`、`skipped` 的记录方式；可选记忆桥沿用记忆插件的层级写入闸门。现行默认值及各项设计出处可在[阈值表](src/thresholds.js)中逐项查看。

## 已知限制

关键词规则可能错过异义表述，也可能在无关上下文命中。语义检查只给复核线索。已接受候选的数量、快速通道抽样行和 `human_confirmed` 标签分别记录机制做过的事；评估一次干预是否有效，需要核对该任务的产物、所用判据和独立反馈。历史技术审查保留当时读到的证据，若要了解文件后续是否变化，应重新进行文件核对。

## 验证

在本包目录运行 `npm test`。涉及 DSH 宿主注册的测试需能定位安装目录，可通过 `DSH_INSTALL_DIR` 指定。`node test/mutation-check.mjs` 可单独检查判据变异。健康探针对照宿主入口声明的 11 个工具名检查注册情况，注册计数只反映挂载状态。[工具注册与探针](index.js) · [入口测试](test/entry.test.js)
