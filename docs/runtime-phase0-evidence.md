# 双循环运行时：阶段0执行证据

> 日期：2026-11-17。状态：隔离契约验证；没有生产部署或活动Web profile变更。

## 1. 隔离与基线

- 基线提交：`28029f9df67394eaa228d0b6e52ee0a6fb68b713`。
- 隔离工作树：`D:/个人开发/dsh-execution-runtime`；分支 `feat/dual-loop-runtime`。
- 原仓库：`C:/Users/lyq/Documents/deepseek-harness/default-workspace/dsh-mind-system-repo`。活动profile的junction仍指向原仓库合成包，未改指向。
- 原仓库在开发开始时只有未跟踪的新融合方案；没有挪动或覆盖其他用户改动。
- 本机Node.js：v22.23.3；内建SQLite：3.51.3。`node:sqlite`仍有ExperimentalWarning，本轮只确认本机原型可运行。
- 临时测试profile以独立Cordis Context装配真实服务，临时DSH_HOME、存储、工具和scope由[宿主测试辅助器](../packages/dsh-execution-runtime/test/helpers/host.js)创建并销毁。不建立新Web服务，不接管真实会话；它不是一个已部署的持久Web profile。

## 2. DL-0节点结果

| 节点 | 当前状态 | 证据与边界 |
| :--- | :--- | :--- |
| DL-0.1 | 隔离已验 | Git工作树、分支、宿主版本及活动junction核对；旧升级计划的F/N状态不修改。隔离测试装配不等于活动Web验收 |
| DL-0.2 | 开发中：真实提供者外部依赖未验证 | 协议适配与HTTP fixture已有隔离证据；专用端点/模型/密钥环境未配置，实际外部请求0。详见[Jev证据](runtime-jev-evidence.md) |
| DL-0.3 | 隔离已验 | 使用真实安装的Cordis/ToolRuntime执行正反控，详见[宿主管线证据](runtime-host-evidence.md)；不等于完整Agent生命周期和会话持久化验收 |
| DL-0.4 | 隔离已验 | 首个JSON模板、独立目标Verifier、SQLite事务/事件/重启冻结已有反例；不等于完整调度器、恢复租约或补偿已实现 |

## 3. 持久化与模板的外部观测

[SQLite测试](../packages/dsh-execution-runtime/test/store.test.js)验证：动作意图与预算预留持久化、关闭重开后结果和证据仍在、旧版本CAS被拒、预算边界不追加事件、假成功/无证据完成被拒，以及不可改事件的触发器限制。

最关键的崩溃用例由独立子进程完成：先提交intent/start记录，再真实写入临时文件，随后用指定退出码42中断而不记录outcome。新进程打开数据库后保留已消耗预算，将未结动作置为unknown并冻结run；没有再次执行写入。该用例证明“已产生副作用但未获回执”不能自动重放，不证明工具副作用可与SQLite exactly-once提交。

在线回执未知同样进入reconciling，不能用剩余预算继续派发。故意在事件插入前制造SQLite错误，验证run行也被事务回滚，没有半创建的run。

[JSON模板测试](../packages/dsh-execution-runtime/test/json-recipe.test.js)直接读取源文件和产物：正确转换通过；名字错误、顺序错误、重复ID、缺失记录、额外字段和伪success对象均失败。源文件变更返回unknown，已有输出阻止盲目重建，路径穿越与输入输出同名在执行前拒绝。

## 4. 变异验证

[变异脚本](../packages/dsh-execution-runtime/scripts/verify-core-mutations.mjs)仅在新建临时目录复制明确文件清单，不修改开发源文件。先确认未修改的基线测试通过，再逐个注入可解析的回归，并要求指定的目标测试失败，避免“导入失败也算杀死变异”。

本轮4/4变异均被指定断言抓住：

1. 未知结果仍标running；
2. 预算允许额外一次派发；
3. 事务异常时提交半成品；
4. 错误产物仍标pass。

这验证上述断言能检测对应回归，不代表穷尽所有状态或攻击面。

## 5. 最终回归与审查修正

执行 `node --test --test-reporter=spec packages/dsh-execution-runtime/test/*.test.js`：68 tests / 68 pass / 0 fail / 0 skipped，退出码0。其中协议32、真实安装包管线14、JSON模板13、SQLite与契约9项。另运行变异脚本：基线退出0，4/4目标变异由指定测试检出。

只读审查发现并已修复两项具体缺陷：空attemptId可在SQLite中形成不可寻址预留，现增加字符串验证与NOT NULL约束；宽松UTF-8解码可把非法字节替换成正常字符，现对源文件、产物和协议响应使用fatal解码，并增加相应反例。审查不是以“全绿”替代输入边界检查。

旧升级计划守卫退出0，原F/N状态不变。真实Jev探针明确返回未配置、实际请求0；此退出0仅表示配置检查完成。

## 6. 尚未实现的关键约束

- 调度器、生产ExecutorAdapter、完整准入与工具schema验证。
- 验证器由调度器固定登记与调用；当前Store只能验证证据结构，不能证明调用者提交的引用真实性。
- 恢复单写者/租约与fencing、恢复预留额度、补偿、人工继续凭据。
- 输入准备阶段I/O预算化、模板执行时的完整文件系统并发边界。
- 真实Jev提供者、真实模型修复及线上延迟/成功率对照。
- 活动Agent生命周期、原生会话事件持久化和UI显示。公开tools/result通知不等于已经写入会话日志。

阶段0的确定性前置可进入阶段1；Jev真实提供者仍保留独立依赖状态。没有为通过验收而编造API数据，也没有将fixture冒充真实任务。
