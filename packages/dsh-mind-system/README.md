# dsh-mind-system

面向 DeepSeek Harness 的心智系统合成包。它将处境编排、因果分析、问题重审、跨会话记忆、规则治理和任务执行装配到一个 bundle 中。每项能力都由成员插件实现；包根负责装载清单和文件存在性探针。

源码、完整运行机制和开发说明见[仓库 README](https://github.com/Chandlersn/dsh-mind-system#readme)。

## 适用范围

本包适合需要跨会话查证、分析反复失败或保留规则决策记录的 DSH 工作流。它不适合被当作自动保证答案正确、强制执行工具顺序或证明人工授权的安全边界；单步任务也未必需要调用其中任何分析工具。

## 成员

| 成员 | 职责 | 主要入口 |
|---|---|---|
| agent-mind | 根据用户输入判断处境并提供判断提示；工具排序依赖宿主兼容 | `mind/index.js` |
| CLIS | 判断因果结构、提供策略与反馈、跨插件健康监督 | `clis/index.js` 与四个 CLIS 服务入口 |
| meta-framework | 重定义问题并说明边界，可接入 CLIS 分类 | `meta/index.js` |
| memory-manager | 检索、层级记忆写入、体检、问题收件箱及面板 | `memory/server.js` |
| valves | 候选准入、决策账本、负向规则及巡检 | `valves/index.js` |
| execution-runtime | 任务执行、配方和验收 | `runtime/src/host-plugin.js` |

[`cordis.patch.yml`](cordis.patch.yml) 按依赖顺序注册 CLIS 四个服务、CLIS 工具包、meta、valves、memory、mind、runtime 和包根。成员通过宿主服务和事件交互，并非每个任务都会顺次运行全部成员。

## 安装

需要 Node.js 22 或更高版本及可运行的 DSH 宿主。若当前包源提供此包，可运行：

```bash
dsh plugin --profile web add dsh-mind-system
```

安装后按宿主的加载方式重新加载或重启，并通过真实工具调用确认。合成包已经注册成员，避免同时启用同一成员的独立 bundle 造成重复注册。各成员的参数与配置请参阅[源码仓库](https://github.com/Chandlersn/dsh-mind-system/tree/main/packages)。

## 使用

- 当调整反复无效时，提供观察到的现象，用 `clis_classify` 判断可能的因果结构；需要比较路径时可调用 `clis_plan` 或 `clis_run`。
- 需要重定义问题及其边界时，用 `meta_reframe`。该工具提供诊断，不自动决定或执行干预。
- 遇到既有约定、历史决策或反复出现的问题，先用 `memory_read` / `memory_search` 查找相关证据，再决定是否沉淀。
- 用 `mind_signals` 检查调度信号，用 `valve_metrics` 检查阀门账本；这些读数不等于任务成效。

## 依赖与配置

宿主提供工具、系统提示与相应事件；meta 可选读取 CLIS 分类器，memory 可选读取 valves 服务。缺少可选能力时的降级方式以对应成员实际实现为准。插件配置属于各成员：例如 memory 的 `memoryRoot` 可指定记忆根，valves 的 `thresholds` 和 `patrol` 配置阈值与巡检输入；完整字段见成员文档。

## 排错

| 现象 | 核查方向 |
|---|---|
| 工具没有出现 | 检查宿主服务、合成包装载点和是否重复装载成员。 |
| 处境已判断但顺序未改变 | 当前宿主的工具顺序由 provider 提供，装配事件未暴露工具列表；处境重排尚不兼容。 |
| 巡检没有内容 | 检查原则或候选来源、层计数与报告中的 `no_input` / 跳过状态。 |
| 修改源码后行为未变 | 检查合成包是否重建、运行实例指向的路径及宿主重载结果，再执行真实调用。 |

## 已知限制

- agent-mind 的 `agent/inbox/claimed` 是处境判断主路径，`agent/pre-step` 是兼容路径；当前宿主的提示装配不提供工具列表，源码的重排逻辑无法在此生效，兼容方式待验证。重排设计不删除工具、核心工具保持原位，延后加载默认关闭；判断不保证模型调用某工具。未命中或歧义样本可能写入规则脱敏、截断后的输入摘要；`DSH_MIND_SAMPLING=0` 可关闭采样。
- memory-manager 的层级门槛和自检检查可机械验证的形态，不能自动证明结论真实。记忆写入守卫覆盖宿主 `write` / `edit`，不全面覆盖 shell 和其他写入方式；R26 哈希对账也不能证明完整来源。
- 候选道在 `dao/_candidates/` 等待处理。当前面板会话认证不能证明操作由真人点击，`memory_dao` 亦存在直接写正式道的 active 路径；人工确认仍依赖操作纪律。
- valves 的阈值是待真实数据校准的暂定值。规则确认要求用户明确授权，但工具调用本身没有独立的人类身份凭据验证。
- 巡检调度默认开启不代表输入已配置。周检原则清单未配置时会从记忆根 `insights/` 与决策账本枚举，两者都没有才报告 `no_input`；外部召回探针未接时召回边界段的违例数记未知（`null`）而非 0；季度巡检缺少层统计时跳过。
- 记忆面板默认打开架构页，诊断与最近改动可展开；活动观测和历史架构证据均不证明任务成功或人工采纳。
- 使用反馈由调用方声明，关联身份未经认证；重复关联可能歧义，不具治理资格。
- 合成包健康探针只检查成员文件是否存在，不证明它们已在真实宿主装载，或某次任务结果正确。

## 验证与开发

在源码仓库根目录执行 `npm run build`、`npm run verify-combined` 和 `npm test`。部分集成测试需要设置 `DSH_INSTALL_DIR` 指向真实宿主安装。完整测试和部署说明见[仓库 README](https://github.com/Chandlersn/dsh-mind-system#readme)。

如果 profile 中的安装目录是指向仓库产物的 junction，构建会直接修改运行实例的磁盘文件。仓库的 `install-profile.mjs` 使用拷贝并替换目标目录，不会创建 junction；执行前应核对目标及备份。

## 许可

MIT。
