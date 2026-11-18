# DL-0.3：真实安装宿主管线隔离验证

日期：2026-11-17。结论：真实安装的 Cordis Context、ToolRuntime 与 NodePtcRuntime 已在隔离上下文中通过 14 个正反控测试；原生持久会话日志归属仍未验证，不能由管线通知推断该项已完成。没有宿主安装包无法加载的阻塞。

## 验证对象与边界

- 工作树：`D:/个人开发/dsh-execution-runtime`，基线 `28029f9df67394eaa228d0b6e52ee0a6fb68b713`。
- Node.js：`v22.23.3`。
- 安装源：`D:/dsh/node_modules/@deepseek-ai/`；使用 `createRequire(pathToFileURL(hostPackageJson))` 解析，再以 `import(pathToFileURL(entry).href)` 加载 ESM。
- Cordis：`4.0.5`；ToolRuntime：`0.2.1-rc.2`。
- 测试在新的真实 `Context` 中通过 `ctx.plugin(...).await()` 挂载真实服务；没有替代工具注册表，没有从定义直接调用 `execute`。
- 每个测试建立独立 `mkdtemp` 根目录、`storage` 子目录与进程内临时 `DSH_HOME`；结束时恢复原环境。工具体只写临时目录中的 fixture 文件与 JSONL 副作用记录。
- 清理前校验实际路径、临时目录父路径与固定前缀，仅递归删除本次创建并验证过的目录；先传播取消并等待已跟踪工作、scope、Cordis fiber 收敛。
- 没有网络、真实业务工具、安装、提交、合成构建、活动 profile 或运行中宿主变更，也没有记忆写入。

安装入口 SHA-256：

| 安装包入口 | SHA-256 |
| --- | --- |
| Cordis `lib/index.js` | `6A9394C0877FF45218818C6E815EDD038F8057E1A1DEB390A8D43EC81C57691E` |
| dsh-tools `lib/index.js` | `1E53932E7C4213EA24A7D87F06960B7A7702CB21F8A5741C97242B4A470A442A` |

## 最小服务装配

原生 ToolRuntime 的静态注入要求仅为 `systemPrompt`，因此原生测试挂载真实 `SystemPrompt` 与真实 `ToolRuntime` 即可。`approval` 是可选服务，缺失时 `ask` 被拒绝。

完整 PTC 测试进一步挂载以下真实安装服务：

| 安装包 | 服务 | 用途 |
| --- | --- | --- |
| `dsh-session-projection` | `sessionProjections` | SandboxPolicyService 的真实依赖 |
| `dsh-fs-local` | `fs` | 执行世界的真实文件系统与 bootstrap 路径映射 |
| `dsh-subprocess-local` | `subprocess` | 真正启动并回收 Node 子进程 |
| `dsh-sandbox-local` | `sandbox` | NodePtcRuntime 的真实依赖 |
| `dsh-sandbox-policy` | `sandboxPolicy` | 当前隔离上下文的真实策略解析 |
| `dsh-ptc-runtime-node` | `ptcRuntime` | 真实 `run_code` 程序与 SDK 派发 |

PTC 的隔离测试上下文使用 `danger-full-access` 策略，工作目录指向临时根目录。此配置只存在于新建的 Context，不写活动配置；该模式不触发 Windows sandbox ACL 授权。子程序只调用本测试注册的 fixture。这里没有验证 OS 文件沙箱强制能力。

真实 PTC 用例采用无 Agent 的独立 scope，从而无需虚构会话或工作目录服务。带 Agent 的嵌套上下文传播在另一条原生 composite 用例中验证：Agent 身份是通过真实 `createScope` 建立的 fixture 对象，不代表完整 AgentFactory 生命周期已验。

## 可复用的宿主 API 事实

公开入口：

```js
const result = await ctx.get('tools').execute({
  callId,
  rootCallId,
  name,
  arguments: args,
  agent,
  signal,
  parent,
});
```

根调用省略 `parent`，可省略 `rootCallId`，宿主将其设为 `callId`。`signal` 必须由调用者显式提供。宿主为每次执行生成独立 `exec.token`。嵌套 composite 从正在执行的真实工具体接收 `exec` 后派发：

```js
await tools.execute({
  callId: `${exec.callId}:child`,
  rootCallId: exec.rootCallId,
  name: 'fixture_leaf',
  arguments: {},
  agent: exec.agent,
  signal: exec.signal,
  parent: exec.token,
});
```

这只是上下文传播的接缝证据，不把 parent token 当授权票据。测试不创建伪造 parent token，也不伪造审批。

安装版本中，取消与未知工具的错误码在 `result.error.info.code`，不是 `result.error.code`：

- `ABORTED_BEFORE_DISPATCH`：工具体未开始。
- `ABORTED`：工具体已开始，取消后等待工作收敛。
- `UNKNOWN_TOOL`：不存在、当前 scope 不可见或 PTC 模式禁止直接调用的工具。

pre deny 与缺少 approval 的 ask 保留拒绝原因，不保证存在标准错误码。post block 可能发生在已经产生副作用之后；调用方不能将所有 `isError` 都解释为未执行。

## 14 个可失败观测

| 用例 | 正控与反控／外部观测 |
| --- | --- |
| allow 完整管线 | 临时目标文件内容正确；JSONL 顺序为 pre → around → body → post → result；最终 result 和执行身份冻结 |
| pre deny / ask | deny、缺少 approval 的 ask 都无 body 记录；随后改为 allow，body 记录恰增 1；拒绝仍进入 post/result |
| 单调 guard | pre 强制 allow、后续 guard 放行均不能覆盖已有 guard 否决；注销否决 guard 后 body 恰增 1 |
| post block | body 副作用计数已增，post block 使最终 result 失败；取消 block 后同工具成功，最终通知分别为失败／成功 |
| 调用前取消 | 无 pre、无 body；有最终 result，码为 `ABORTED_BEFORE_DISPATCH`；新鲜 signal 的正控执行 |
| pre 等待中取消 | 取消不提前返回；先释放并收敛 pre，再返回未派发取消；body 计数为 0 |
| body 中取消 | around 故意替换 signal，宿主仍融合原 caller signal；body 观察 abort；释放清理屏障前 execute 未返回、无 result；body drain 后才 post/result |
| scope 隔离 | A 拒绝的全局工具在 B 可执行；A 本地工具在 B 不可见；A/B pre/result 仅收到各自调用；A guard 不阻断 B；移除 A guard 后恢复执行 |
| nested composite | agent、signal、rootCallId 保持；inner.parent 严格等于真实 outer.token；inner.token 独立；PTC 模式直接 leaf 拒绝，但真实 enclosing parent 的 leaf 执行 |
| PTC 缺少后端 | 直接 fixture 为 `UNKNOWN_TOOL`；`run_code` 明确报告缺少 PTC runtime；无 fixture 副作用与回退直调 |
| 真实 Node PTC | 真子进程的 `run_code` → SDK → ToolRuntime → fixture 写出临时产物；inner.parent 等于实际 run_code token；post/result 覆盖内外两次调用；改为拒绝 leaf 后再次 run_code 失败，body 计数不增加 |
| 真实 PTC 取消 | 取消 root signal 传播到 SDK 派发的 fixture；fixture 观察 abort；释放 drain 屏障前外层仍未返回；最终失败且 body/drain 各恰 1 |
| 工具体抛错 | body 记录真实发生，post 与最终 result 都观察失败，错误原因保留 |
| 原生通知与会话区别 | fixture 已执行且 `tools/result` 计数为 1；可观察 session.append port 的调用数为 0 |

JSONL 计数和目标文件是工具执行过程留下的外部事实，断言从文件重新读取，不将 runtime 自报成功作为副作用成立的唯一证据。负控之后包含放行／恢复执行的对照，避免所有调用都被拒绝时仍误报边界有效。

## 通知、会话日志与未验证范围

`tools/result` 是执行管线的最终结果通知，本身不等于原生持久化。原生调用测试给 Agent 绑定可观察的 `session.append` port，确认 `ToolRuntime.execute` 不自动追加 session 事件；这个 port 是观察 fixture，不是 Session 存储实现。

真实 Node PTC 测试使用 agent-less 执行，验证 transport 和子调用的真实管线、父 token、取消及工作收敛。没有据此宣称原生 `tool/result` 或 PTC `tool/ptc-dispatch` 已写入持久 Session 日志，也没有验证日志恢复、Web 投影、完整 AgentFactory、真实会话预算或 profile 卸载。因此 DL-0.3 的管线接缝已取得真实安装包隔离证据，会话持久化归属仍是开放项；不能将其整体标成活动宿主／真实任务已验。

真实 Node PTC 后端依赖当前 Node 的实验性 `stripTypeScriptTypes`，测试会输出 Node ExperimentalWarning；当前用例退出成功，不隐藏该依赖。

## 复现与结果

```powershell
node --test packages/dsh-execution-runtime/test/host-pipeline.test.js
```

最终 focused 结果：14 tests，14 pass，0 fail，0 skipped，退出码 0。当前安装环境整套耗时约 1.05 秒，只作为本次运行记录，不作为延迟基准或生产性能保证。

可通过 `DSH_SEAM_HOST_ROOT` 指定另一安装宿主根目录，默认 `D:/dsh`。安装包无法解析或加载时测试直接失败，不会 skip 后报告通过。

产物：测试入口为 [host-pipeline.test.js](../packages/dsh-execution-runtime/test/host-pipeline.test.js)，装配与清理 helper 为 [host.js](../packages/dsh-execution-runtime/test/helpers/host.js)。helper 导出 `createHost(t, { mode })`、`installNodePtc(host)`、`deferred()`、`waitFor()`、`installed`、`Context`、`ToolRuntime`；仅供隔离测试使用。
