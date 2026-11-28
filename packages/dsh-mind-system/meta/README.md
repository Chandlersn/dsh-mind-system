# dsh-meta-framework

`meta_reframe` 帮助 agent 重新审视问题的定义、边界与候选方向。适合在反复调整无效时，检查对问题的理解。插件按 `redefine → customize → select` 调用 `@causal-layers/meta-framework`，返回最多三个候选，不执行候选路径，也不进入 `observe` 的反馈循环。

## 定位与实测边界

工具定义将 `meta_reframe` 称为“诊断工具，不是决策工具”。上游 D11 的历史试用选了 5 个问题，其中 3 个因果样例的类型 3/3 判对，分别是 `cyclic`、`structural_duality` 和 `nested`。这 3 个样例在使用占位执行器跑完整四层时都到了 `human_gate`。样本范围限于当时的任务与执行器，不能据此给其他问题估计准确率或断定完整执行必然回退。这个工具保留了可独立核对的诊断输出。

## 相对上游的取舍与已知限制

| 上游接口 | DSH 工具如何使用 |
|---|---|
| `createClisSession` | 按调用探测宿主服务，使已安装的分类与策略服务可参与诊断。 |
| `redefine`、`customize`、`select` | 依次处理问题定义、边界、候选。通用重定义采用固定规则，有些输入会原样返回。 |
| `writeTrace` | 三个分步接口不会自动保存轨迹。插件在选出候选后自行构造十个契约字段，再调用上游写入器。 |
| `run`、`observe`、人工审批接口 | 完整执行、变更观察和回退属于上游运行流程，工具在 `select` 后结束。 |
| `META_FRAMEWORK_SERVICE` | 对想通过宿主服务调用 meta 的插件而言，这是一个真缺口：包装器只注册工具，未调用上游的服务注册入口。 |

### 什么时候该重新评估

历史试用提出三个复查条件：另一位真实使用者也在完整流程反复遇到 `human_gate`，出现能实际操作与观测的执行器，或任务需要依靠领域知识生成更具体的候选。届时可针对真实输入对照模板与执行后结果，再决定是否扩展执行器接口。单次模板排序不足以回答这个问题。

## 安装与配置

独立包 `dsh-meta-framework@0.1.0` 要求 Node.js ≥22。在仓库根运行 `npm --prefix packages/dsh-meta-framework ci` 准备本地包依赖。在目标 profile 的 Plugins → Add plugin 中选择 `packages/dsh-meta-framework` 目录，或以其绝对路径作为 `plugin_manager` 的 `install_bundle` 目标。以下为路径示例，请换成本机仓库位置。已启用合成包 `dsh-mind-system` 的 profile 使用其中的 meta 条目即可。

```json
{"action":"install_bundle","target":"C:/src/dsh-mind-system/packages/dsh-meta-framework"}
```

发布包的 `cordis.patch.yml` 注册 `meta-framework` 条目，默认配置 `{}`。入口硬依赖宿主的 `tools` 服务，使用本包依赖 `@causal-layers/meta-framework`（`^1.0.1`），从宿主安装目录加载 `@deepseek-ai/dsh-tools`。工具每次调用时通过 `createClisSession(ctx)` 探测可选 CLIS 服务，因此分类器晚于本插件装载也能被后续调用发现。没有分类器时仍可通用重定义、定边界与排序。工具入口没有注册上游的 `causalLayers.metaFramework` 服务。

## 工具参数

| 参数 | 取值与意义 |
|---|---|
| `description` | 必填字符串，描述要重新审视的问题。原文保留在 `original_definition`。 |
| `context` | 可选字符串，传入尝试过的措施、观测与约束。 |
| `q1` | 两个因素是否同时成立、彼此定义且无先后？ |
| `q2` | 是否存在带延迟的相互影响？ |
| `q3` | 是否有严格先后且不可逆的因果方向？ |
| `q4` | 是否有多种结构共存？ |

每问可省略，也可填 `yes`、`no` 或 `unknown`。`unknown` 是有效作答。以下是一个 `meta_reframe` 输入示例，在 CLIS 分类器可用时返回 `causal_type: "cyclic"`。

```json
{"description":"为什么改变扩容阈值没效果？","context":"调整后波动短暂减弱，随后恢复。","q1":"no","q2":"yes","q3":"no","q4":"no"}
```

## 怎样读结果

`reframed` 为新定义，维持原定义时为 `null`。`boundary_declaration`、`redefine_reason`、`success_criteria` 和 `forbidden_actions` 说明边界、判断理由与检查条件。`candidates` 按排名返回 `path_id`、`description`、`source`、`score` 和 `rank`。这些分数用于候选排序。

| 输入与服务状态 | 怎样辨认 |
|---|---|
| 未提供作答或只给了部分 | `answered: false`，`answers_submitted` 为 0–3，`answers_missing` 列出缺项。只有四问齐全才提交给分类器。 |
| 四问齐全，分类器不可用 | `answered: true`、`clis_available: false`、`causal_type: null`。建会话抛错时查看 `clis_unavailable_reason`。 |
| 分类器抛错或返回空 | `clis_available: true`、`clis_used: false`、`causal_type: null`，`note` 提示调用失败。 |
| 分类器正常返回 `unknown` | 当前依赖保留使用记录，返回 `clis_used: true`、`causal_type: null`。`note` 说明分类器给出了 `unknown`，即这些作答不足以确定四种结构中的一种。 |
| 分类器返回契约外的类型名 | `causal_type: null`、`clis_used: false`，`off_contract_type` 保存收到的类型名。 |
| 得到确定类型 | `causal_type` 为 `structural_duality`、`cyclic`、`unidirectional` 或 `nested`。 |

`answers_submitted` 为 0 时，`answers_missing` 列出全部四项。对分类状态有疑问时结合 `note` 与上述字段判断。执行体抛错时，入口改为返回 `error`、`reason`、`hint`，并记录执行失败。

## 诊断轨迹

诊断完成后尝试写一条 JSON 轨迹。宿主进程环境变量 `META_FRAMEWORK_TRACE_DIR` 指定目录，默认使用宿主当前工作目录下的 `data/meta-traces`。写入成功时 `trace.path` 是实际绝对路径，文件名包含问题 ID 与轨迹时间戳。写入失败时返回的诊断仍可用，`trace.written` 为 `false`，`trace.path` 为 `null`，`trace.error` 给出原因。

轨迹包含 `problem_id`、`definition`、`boundary`、`selected_path`、`execution`、`change`、`clis_used`、`gate`、`rollback_count` 和 `ts`。`selected_path` 记录排名第一的候选，无候选时为 `null`。这次诊断没有执行步骤，因此 `execution` 和 `change` 均为 `null`，`rollback_count` 为 0。

## 健康探针与排错

具名导出 `healthProbe` 供 CLIS 检查。探针分别读取工具注册结果、最近一次调用结果，并检查当前宿主上能否取得具有 `classify()` 方法的分类服务。

| 发现代号 | 含义与检查位置 |
|---|---|
| `meta-framework.not-loaded` | 缺少注册记录。查看宿主的激活错误和 `tools` 依赖。 |
| `meta-framework.host-root-missing` | 定位宿主安装目录失败。可用 `DSH_INSTALL_DIR` 指定安装根。 |
| `meta-framework.tools-unavailable` | 宿主工具定义器加载失败。查看错误原因和宿主包依赖。 |
| `meta-framework.execution-failed` | 最近一次工具执行抛错。检查返回的 `reason`。 |
| `meta-framework.classifier-missing` | 缺少可用分类器或无法检查上下文。此项为 `info`，通用诊断仍可用的前提是工具已注册。 |
| `meta-framework.ok` | 没有其他发现。消息区分最近一次执行成功与尚无执行记录。 |

## 仓库验证

在完整仓库根目录运行以下命令。测试包括工具注册、宿主根定位、健康探针、部分作答、分类器故障、候选与轨迹。分类规则测试依赖同级 `dsh-clis` 包的分类器 chunk，并与测试分类器逐项比较 81 种作答组合。npm 发布包只包含运行文件，测试目录保留在仓库中。

```sh
npm --prefix packages/dsh-meta-framework ci
npm --prefix packages/dsh-meta-framework test
```
