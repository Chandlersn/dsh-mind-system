# dsh-clis

DSH 插件。`clis_classify` 用四问判断因果结构，`clis_plan` 列出候选策略，`clis_run` 将规划与调用方回填的结果关联。`clis_probe` 检查宿主插件的装载状态或领域探针。插件还会在工具重复失败时向 agent 提示可以调用 CLIS。

## 为什么做这个

当一个调整暂时缓解问题、随后又反弹时，继续调整前需要区分两种情况：改动是否经过延迟反馈再次影响原来的指标，还是上游条件一直未变。四问把这个区别落实到可核查的关系上。插件监督则处理另一类问题：当几个插件同时报告异常，先列出报错来源和覆盖范围，才能判断是否还有一个上游依赖需要调查。

## 安装与组件

独立包 `dsh-clis@0.3.0` 要求 Node.js ≥22.13。在目标 profile 的 Plugins → Add plugin 中选择本地 `packages/dsh-clis` 目录，或以其绝对路径作为 `plugin_manager` 的 `install_bundle` 目标。以下为路径示例，请换成本机仓库位置。已启用合成包 `dsh-mind-system` 的 profile 使用其中的 CLIS 条目即可。

```json
{"action":"install_bundle","target":"C:/src/dsh-mind-system/packages/dsh-clis"}
```

发布包自带 JavaScript 入口和共享 chunk，运行时由 shim 从 DSH 安装目录加载宿主的 Cordis。包内的 `cordis.patch.yml` 插入以下五个条目，各行默认配置均为 `{}`。可在 Settings → Plugins 分别启停。停用上游会使依赖它的条目失去所需服务。

| 插件 ID | 提供的服务或工具 | 直接依赖 |
|---|---|---|
| `clis-classifier` | `clis.causalClassifier` | 无 |
| `clis-strategy` | `clis.causalStrategy` | 分类器 |
| `clis-feedback` | `clis.causalFeedback` | 无 |
| `clis-orchestrator` | `clis.causalOrchestrator` | 分类器、策略、反馈 |
| `clis-tools` | 下列六个 agent 工具 | `tools`、`systemPrompt`、分类器、策略、编排器 |

## 工具与四问

| 工具 | 输入与结果 |
|---|---|
| `clis_classify` | 必填 `description` 和 `q1`–`q4`，返回类型、置信度、触发的判断依据及探索信息。 |
| `clis_plan` | 相同必填项。可用 `forbidden_actions`（动作名字符串数组）约束候选路径，返回 `paths` 中的排序、评分、步骤和可执行状态。 |
| `clis_run` | 相同必填项。另接受 `forbidden_actions`、`allow_writes`（均为动作名数组）、`last_outcome` 和 `last_detail`。返回规划结果、动作回执、历史摘要和事件状态。 |
| `clis_event_feedback` | 必填同一次 `clis_run` 的 `event.producerId` 和 `event.eventId`，按这对标识查询技术消费分类。 |
| `clis_probe` | 省略参数以检查可发现的来源。`only` 是来源 ID 字符串数组，精确匹配本轮要检查的来源。 |
| `clis_metrics` | 可传 `window_days` 或 `probe_self_test`，详见下文。 |

四问各接受 `yes`、`no`、`unknown`。Q1 问两个因素是否同时成立、互为定义且无先后，Q2 问是否有带延迟的相互影响，Q3 问是否严格先后且不可逆，Q4 问是否有多种结构并存。分类由作答决定。以下是 `clis_classify` 的参数，结果为 `cyclic`。

```json
{"description":"扩容改变负载，负载延迟触发下一次扩缩容。","q1":"no","q2":"yes","q3":"no","q4":"no"}
```

Q4 为 `yes` 或前三问有多个 `yes` 时为 `nested`。其余情况下，前三问唯一的 `yes` 分别对应 `structural_duality`、`cyclic`、`unidirectional`。全无肯定作答为 `unknown`。置信度上限为 0.9。

置信度低于 0.7 会标记 `needs_exploration`。策略匹配器按结构选策略族：对偶侧重对称关系和定义，循环考虑增益、延迟和阻尼，单向追溯上游和必要条件，嵌套拆子模块，未知结构先探测。`forbidden_actions` 命中的步骤会被剔除，受影响路径标为不可执行。编排器默认最多回退三次，达到上限且仍收到未解决信号时转人工；同一类型两次连续误判回退会触发一轮锁定。

### 怎样读 `clis_run`

`actions.observed` 列出待采集实际数据的观测动作。已知写动作默认落入 `actions.blocked_writes`，列入 `allow_writes` 仅会让内置执行器返回 `ok` 回执。该执行器没有调用外部系统实施观测、调参或干预。`outcome` 和 `signal_type` 描述本轮规划经过。

首次分析可传 `last_outcome: "not_tried"`。实际尝试后，用同一问题描述与四问再次调用，传 `achieved` 或 `failed`，并用 `last_detail` 说明观测结果。历史键取决于规范化后的描述和四项作答。首次调用建立基线，有先前历史时才将回填结果关联到它。历史保存在 DSH 数据目录的 `storages/clis-history.json`。

`event.status` 为 `persisted_pending` 时，事件已写入 `storages/clis-events.sqlite`，可以取其两个 ID 查询反馈。`persistence_failed` 表示持久化失败。已记录的技术分类仍标记 `authenticated: false`、`humanAdoption: "unknown"`、`principleAttribution: "unknown"` 和 `governanceEligible: false`。

## 失败提示与指标

插件注册系统提示段 `clis-causal-reasoning`，并通过 `mind/register-signal` 广播 `clis-causal`（`situation: "diagnose"`，权重 3）。重复失败提示由 `tools/post-execute` 单独触发。监听器识别工具错误和没有终止信号的非零退出码，过滤命中机械错误或基础设施错误规则的记录。同一 agent 的同一工具在 10 分钟内至少两次出现相同签名后，才有机会注入提示。已提示的签名和 agent 的 10 分钟冷却期均会阻止再次提示。调用 `clis_run` 或 `clis_classify` 会清除该 agent 的提示与冷却状态。

`clis_metrics({window_days: 7})` 读取 `storages/clis-interventions.jsonl`。默认 30 天，输入 0 也取 30，其他数值限制在 1–365 天。汇总按文件顺序最多扫描前 10,000 条非空行，再按时间筛选。

| 返回字段 | 计算口径 |
|---|---|
| `hinted` | 被记录为注入提示的次数。 |
| `adopted` / `spontaneous` | 同一 agent 的 `clis_run` 或 `clis_classify` 调用与此前 30 分钟内的提示匹配时计入 `adopted`，每次匹配消费一条待匹配提示。其余调用计入 `spontaneous`。 |
| `adoption_rate` | `adopted / hinted`，上限 1。`hinted` 为 0 时为 `null`。 |
| `skipped` / `evaluated` | `skipped` 统计跳过记录，也包括订阅失败记录。`evaluated = hinted + skipped`。可用 `skipped_by_reason`、`skipped_by_gate` 看构成。 |
| `miss_rate` | `skipped / evaluated`，分母为 0 时为 `null`。该值衡量记录中跳过的比例；判断哪些失败本应提示还需独立标注。 |

例如 `hinted = 2`、`adopted = 1`、`skipped = 6` 时，`evaluated = 8`、`adoption_rate = 0.5`、`miss_rate = 0.75`。匹配只说明调用时间与 agent 对得上。`hinted = 0` 有多种原因，可先检查跳过分组、账本是否可读及宿主日志中的订阅错误。

普通汇总也带 `probe_self_test`。调用 `clis_metrics({probe_self_test: true})` 仅返回这一项，自检比较当前 agent 可见的工具注册并用合成样本检查监督链，可调用当前分类服务，不扫描真实插件探针或读取历史账本。

## 插件监督的自动层与协作层

`clis_probe` 合并已登记的探针、已知服务键以及 loader 能枚举的未停用非内建条目。领域探针优先，剩余条目用装载元数据检查导入、导出形式、加载状态、意外未激活与声明的依赖。`supervision.supervised` 是应用 `only` 后的来源数，`domain_probes` 和 `structural_only` 列出过滤前的覆盖情况。`supervised = 0` 时也会返回 `status: "ok"`，此时没有来源接受检查。

插件可以具名导出领域探针，或通过 `clis/register-probe` 提交 `{plugin, probe}`。以下是合法的最小导出。

```js
export const healthProbe = {
  async probe() {
    return { plugin: 'my-plugin', status: 'ok', findings: [] }
  },
}
```

检查结果按发现代号分组，由 `evidence` 给出次数与来源。只凭一次扫描无法回答关系和时间问题，有发现或探针异常时，`analysis.causalType` 固定为 `unknown`；无发现且无探针异常时省略 `analysis`。探针抛错或报告格式无效可产生 `structure.probe-broken` 通知。当前入口不关联跨轮对象，`dispositions` 为空，`history_status` 说明原因。普通业务发现只进入汇总，`notices.notified_plugins` 计的是成功发出事件的调用次数，无法确认收件方已处理。

## 排错

| 症状 | 如何区分原因 |
|---|---|
| 找不到 `clis_probe` | 核对 `clis-tools` 是否在目标 profile 中激活，再按组件表检查所需服务。宿主定位失败时，可将 `DSH_INSTALL_DIR` 指向含宿主 Cordis 的安装根。 |
| 插件只在 `structural_only` 中出现 | loader 能检查其装载元数据。检查该条目的模块是否导出了 `healthProbe.probe`，或是否在 CLIS 监听时成功广播了探针。 |
| `miss_rate` 接近 1 | 检查 `skipped_by_reason`。`below-threshold` 表示相同签名次数不足，`cooldown` 表示近期已提示，`subscriber-missing` 提示应核查宿主订阅。 |
| `clis_run` 有回执，外部系统没有变化 | 读取 `actions.observed` 和 `actions.blocked_writes`。调用方负责独立采集数据、执行获授权的操作，并在下次调用时回填结果。 |

## 借鉴出处与已知限制

四问与策略族沿用系统论中的反馈、延迟、阻尼和上游条件概念。这个实现把它们映射为固定规则和路径模板，适合比较结构假设。判断在某个系统里是否成立，仍需观察两因素实际的时间顺序和影响方向。提示后调用率、规则测试及探针自检都不足以估计真实任务改善了多少；这需要独立的任务结果和对照。

自动层依赖 loader 可见性和内建条目的识别规则。服务键兜底只扫描 `clis.healthProbe`、`memory.healthProbe`、`mind.healthProbe`。诊断范围应以本轮 `supervision` 返回值为准。

## 仓库验证

从仓库根目录运行事件存储测试，覆盖重新打开、重复记录、冲突、事务回滚、跨进程并发和损坏数据检查。

```sh
node --test packages/dsh-clis/clis-event-store.test.js
```
