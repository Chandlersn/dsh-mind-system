# 双循环执行运行时：隔离开发包

这是融合方案DL-0的契约、协议适配和持久化原型，尚未接入活动心智系统，也不是已发布的Host插件。生产装配、健康探针、状态机、恢复所有权、补偿与知识访问适配器按后续节点实现。

## 已有能力

- `DecisionClient`：systemone批量评分、严格协议检查、有界超时/取消、显式选择与弃权；无真实提供者配置时仅有fixture证据。
- `RuntimeStore`：SQLite事务中的运行记录、预算预留、动作意图、结果与不可改事件；使用版本CAS拒绝旧视图写入。
- JSON模板：固定输入指纹、完整文件创建候选、独立读取源文件和产物验证目标。模板准备阶段I/O尚未进入运行时预算，不能宣称快路径已实现。
- 真实安装包管线测试：验证策略/guard/取消/scope/嵌套派发，不调用活动Web实例。

## 验证

在本包目录运行：

```powershell
node --test test/*.test.js
node scripts/verify-core-mutations.mjs
node scripts/probe-jev.mjs
```

宿主测试默认读取本机安装根，可用 `DSH_SEAM_HOST_ROOT` 显式覆盖。测试创建独立Context、临时DSH_HOME和临时文件，正常结束后关闭资源并清理目标目录，不更改活动profile。

真实Jev探针只读取专用配置：`DSH_JEV_ENDPOINT`、`DSH_JEV_MODEL`、`DSH_JEV_API_KEY`。缺少配置返回 `external_dependency_not_verified`，不会发送请求。具体探针参数见[协议证据](../../docs/runtime-jev-evidence.md)。

## 持久化边界

当前使用Node.js内建 `node:sqlite`；本机Node v22.23.3仍将该API标记为实验性。原型验证不等于生产驱动选型已完成。

`recoverRun`只会把未结动作冻结为 `reconciling`，不自动重放、不把预算清零，也不证明旧worker已停止。租约、fencing、恢复预留、显式核对结果和补偿将在DL-3落地前补齐。事件不可改限制来自SQLite触发器，不能防御拥有数据库文件写权限的外部进程。

校验结果中的证据引用通过类型校验不代表真实性；生产调度器必须调用登记的Verifier，不接受模型自报验证成功。JSON模板的Verifier已在隔离测试中直接检查磁盘目标，其他校验器仍需单独实现。

文件路径与指纹检查是模板前置条件，不是抵御并发目录替换的完整文件系统授权机制。真正写入必须经宿主工具边界并使用创建独占/版本核对；当前模板本身不执行写入。

## 开发约束

仅在隔离工作树开发；不运行面向活动junction的合成构建，不改Web profile。源包通过隔离验收后再按DL-3进入合成成员、装配和发布守卫。此包暂设 `private:true`，尚无插件入口或安装patch。
