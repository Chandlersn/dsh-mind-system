# 接入系统：运行时成为合成包成员（默认关闭）

目标：把双循环执行运行时**接进心智系统**，随正常开发迭代走，不做单独演示。

## 1. 先纠正一个判断错误

上一轮我说"`src/plugin.js` 只有工厂、不是 Cordis 插件，所以要写适配层"。**这是错的**：`createExecutionRuntimePlugin` 返回的**就是**完整插件——实测其形状为 `name / inject / apply / drain / healthProbe / describe`。

真实缺的只有**装配**：工厂不能自己造 store、executor、配方与任务，那些必须由宿主提供。所以 `src/host-plugin.js` 做的是装好依赖后把 `apply(ctx)` 委托给那个插件，而不是再造一层插件。

## 2. 真宿主装载踩到的四个坑

每一个都是记忆里"不报错但行为错"的同一族，且都在真实 Cordis 装载中才暴露：

| 现象 | 真因 | 修法 |
|---|---|---|
| `cannot get property "href" without inject` | 宿主用 `const { default: plugin } = await import(entry)` 取插件；没有 default 时它拿模块命名空间，读到的 `href` 不是服务 | 导出显式的 `plugin` 对象并作为 `default` |
| `executor_config` | `HostExecutor` 要求明确调用者 agent，缺了直接抛 | 必须由 config 提供 `agent`，绝不给匿名默认值 |
| 目录删除 `EBUSY` | 内层 `apply` 只清工具，不关 SQLite；`fiber.dispose()` 不调用我返回的清理函数 | 用 `ctx.effect()` 让宿主驱动释放 |
| 探针 ready 但任务为空 | 装配成功 ≠ 可用 | 无任务时探针补 `no-tasks`，不假装能跑 |

另有一条**我自己的测试错**：用 `host.ctx.get('tools')` 断言，但它本身会触发未 inject 的访问。改成从宿主侧证明"工具未注册"（调用报错）。

还有一条是**可选服务必须走 `ctx.get`**：我最初用 `ctx.logger`/`ctx.agent` 属性访问，一个可选服务缺失就会让整个插件不激活。

## 3. 接入方式

- **成员声明**：`build.manifest.json` 增加 `dsh-execution-runtime` → `dir: "runtime"`；
- **装配 patch**：`cordis.patch.yml` 增加 `execution-runtime`，`config.enabled: false`；
- **子路径导出**：合成包 `exports['./runtime'] → ./runtime/src/host-plugin.js`；
- **包级导出**：源包 `exports['./host-plugin']`。

默认 `enabled: false` 是刻意的：装载适配层但不注册任何工具，探针报告 `disabled`。**装了等于没装**，不改变现有五个成员的行为。要启用须显式 `enabled: true` 并提供 `agent`。

## 4. 执行证据

```
node scripts/build-combined.mjs
  写入 75 个（runtime 进入产物）
node scripts/verify-combined.mjs
  ALL PASS（317 个产物文件与源一致；1 个运行依赖在位且可解析）

node --test packages/dsh-execution-runtime/test/*.test.js
  # tests 465 / pass 465 / fail 0

node scripts/verify-plan.mjs              → ALL PASS
node scripts/verify-subpackages.mjs       → ALL PASS
node scripts/verify-isolation-load.mjs    → ALL PASS（14 项，6 项因环境跳过）
```

`host-plugin.test.js` 六项全部走**真实 `ctx.plugin(...)` 装载**，不是直接调 `apply`：

1. disabled 装载激活但不暴露工具（从宿主侧证明调用报错）；
2. enabled 装载后 `runtime_status` 可从宿主调用，模板以对象数组报告；
3. 无声明任务时探针报 `no-tasks`；
4. 过滤掉全部配方仍激活（降级而非消失）；
5. 卸载后状态转为 `unloaded`，无 EBUSY 残留；
6. 声明的任务出现在 `runtime_status.tasks`，且查询未创建的 run 报错而非编造。

## 5. 一次被校验抓住的清单错误

`build.manifest.json` 的排除项我连错两次（声明了运行时不存在的 `cordis.patch.yml`、`.gitignore`，又把目录名 `scripts` 当文件路径写）。构建守卫每次都精确报错并拒绝继续——**这是它应有的行为**。

教训：`walkFiles` 只产出**文件**路径，不含目录名；排除项必须写实际存在的文件。最后只保留 `README.md` 一条真实排除项即可。

## 6. 现状与边界

- 运行时**已是合成包第六个成员**，默认关闭；
- 未向活动 junction 构建、未改 profile 默认值、未发布 —— 按用户约束；
- 要真正启用：宿主 patch 改为 `enabled: true` 并提供 `agent` 与 `tasks`。
