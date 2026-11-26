# dsh-run-code-itself

让 PTC（`run_code`）程序直接读取本次工具调用的完整 JSON：除 `code` 外的任意顶层字段都会以解析好的值出现在程序里的 `run_code_itself` 变量中，不再需要把数据序列化成字符串塞进 `code`。

## 它解决什么

PTC 模式的 `run_code` 只执行 `code`。要把一份数组、一段正则或一份 JSON 交给程序，过去只能在 `code` 里写转义后的字符串字面量再 `JSON.parse`，嵌套引号、换行、反斜杠层层转义，很容易写错。

安装本插件后，这些数据作为 `run_code` 调用的普通 JSON 字段传入：

```json
{
  "code": "const { rows, regex } = run_code_itself; return rows.filter(row => new RegExp(regex).test(row.id))",
  "description": "按 id 模式筛选行",
  "regex": "\\b\\d{3}-\\d{4}\\b",
  "rows": [{ "id": "AB-123-4567" }, { "id": "ZZ-9999" }]
}
```

程序里：

- `run_code_itself` 就是这次调用的完整参数对象；
- `run_code_itself.code` 是传入的 `code` 原文；
- `run_code_itself.rows`、`run_code_itself.regex` 等额外字段已经是解析后的 JavaScript 值；
- 不要在程序里再次声明 `run_code_itself`。

模型看到的 `run_code` 参数 schema 会把对象标记为可接受额外字段；硬规则放在系统提示词的 **Code-Data Separation** 段落里，工具描述只说明兄弟字段会被注入 `run_code_itself`。

## Code-Data Separation

`code` 只放程序逻辑。数据和子工具参数是 `run_code` 调用的兄弟 JSON 字段，程序里以解析好的值挂在 `run_code_itself` 上。值直接写 JSON，不要写成“JSON 字符串”：

```json
{"code":"return run_code_itself.rows.length","description":"数行数","rows":[{"id":"AB-123-4567"}]}
```

目标是减少 `code` 字段内的转义开销，而不是按类型划分。如果内联一个值需要引号、反斜杠、换行、`JSON.stringify`/`JSON.parse` 或很长的字面量，就放进兄弟字段；简单值可以内联。子工具参数放自由兄弟字段或预加载模板变量，不能写成内联对象字面量。

子工具的 JSON 也这样提前放好：

```json
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stdout.text","description":"列文件","bash":{"description":"列文件","command":"ls -la"}}
```

## 子工具元数据

每个可见工具在 `run_code_subtools` 里有一个条目：

```json
{
  "description": "完整工具描述",
  "template": {
    "required_field": "",
    "optional_field": "默认值或空占位"
  }
}
```

模板包含全部必填字段（空值），以及有 schema 默认值的选填字段；没有默认值的选填字段省略，所以填完必填字段后模板可以直接使用。打印其中一个：

```json
{"code":"return run_code_subtools.bash","description":"查看 bash 元数据"}
```

结果：

```json
{"description":"Execute a shell command and return stdout/stderr.","template":{"description":"","command":""}}
```

`run_code_subtools.bash` 是包装对象，不是参数。`run_code_subtools.bash.template` 才是参数对象；从额外字段取值填完必填字段后，可以直接传给 `tools.bash`：

```json
{"code":"const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)","description":"列文件","label":"列文件","command":"ls -la"}
```

值都在额外字段里，所以 `code` 字符串本身不需要带引号的字面量，也就少一层转义。

`bash` 兄弟字段是 `run_code` 调用里的另一个自由字段，运行时解析成 `run_code_itself.bash`；这条路也有效：

```json
{"code":"return await tools.bash(run_code_itself.bash)","description":"列文件","bash":{"description":"列文件","command":"ls -la"}}
```

不要把 `run_code_subtools.bash` 本身传给 `tools.bash`；它里面是 `description` 和 `template`，不是命令参数。

## 按需工具文档

系统提示词里渲染一份紧凑 SDK：常用工具（`bash`、`read`、`write`、`edit`、`glob`、`grep`）有完整 TypeScript 声明，其余可见工具只列名字和一句话描述。所有工具仍然可调用；对未展开的工具，先打印 `run_code_subtools.<tool>` 拿到完整描述和模板，再用 `tools.name` 和嵌套兄弟字段调用。

## 元编程

`run_code_itself.code` 是当前程序的完整原文。程序可以读取它、按自己的标记切分，或对其中一段执行 `eval`，从一个模板动态生成并运行代码。注意被 eval 的内容必须是合法 JavaScript；模板及其数据最好放在额外字段里。

## 安装

```sh
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself
# 或 tgz：
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself-0.4.4.tgz
```

也可以在 **插件** 页面选择 **添加插件**，指向目录或 tgz。命令行只安装包；UI 的 **添加插件** 还会把 bundle 选进 profile（bundle 的补丁是空的，所以只影响插件页的显示）。

## 挂载方式

bundle 自带的 `cordis.patch.yml` 是**空的**：安装只会把包装进 profile，并让它可被 Loader 解析，不会自动插入任何插件行。装完之后由你决定挂在哪里，二选一：

**A. Host 行（对该 profile 内所有使用 PTC 的 Agent 生效）**

在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）里加：

```yaml
- insert:
    - id: run-code-itself
      name: 'dsh-run-code-itself'
```

新建 Agent 时，如果它选中的是标准 PTC 执行器，就会在 Agent 作用域安装本插件的执行器。安装前已存在的 Agent 保持原样；使用原生执行器的 Agent 不受影响。

**B. 直接放进 preset，替换标准执行器**

在 preset 的 `plugins` 列表里把 `@deepseek-ai/dsh-tool-executor-ptc` 行换成：

```yaml
- id: tool-executor-ptc
  name: 'dsh-run-code-itself'
```

插件挂载在 preset 作用域时会直接在同一个作用域注册执行器，因此这一行就是该 preset 的执行器；不会再走 Host 行的按 Agent 覆盖逻辑。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSubCallsPerMinute` | 继承被替换的 PTC 执行器 | 程序内每分钟允许的嵌套工具调用次数 |
| `maxParallelSubCalls` | 继承被替换的 PTC 执行器 | 并发安全的嵌套调用上限 |
| `promptMode` | `system` | `system` 把 Code-Data 指南放在 SDK 段；`tool` 把它追加到 `run_code` 工具描述 |
| `sdkStyle` | `declarations` | `declarations` 渲染 TypeScript SDK；`index` 渲染紧凑工具索引，不含 PTC 风格声明 |

### 提示词位置实验

系统提示词里的 SDK 本质上是一段 PTC 声明，可能诱导模型直接写 `tools.x({...})`。隔离这个因素时，在**预设副本**里测试：

1. persona 改成最小 complete 提示词：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |
      You are a helpful assistant. Use run_code for every action.
      Follow the Code-Data Separation rules and tool list in the run_code tool description.
    complete: true
    includeRuntimeContext: false
```

2. 把指南移进工具描述，并去掉 SDK 声明：

```yaml
- id: run-code-itself
  name: 'dsh-run-code-itself'
  config:
    promptMode: tool
    sdkStyle: index
```

3. 新建会话，试“随便调用一下”。

`complete: true` 会屏蔽**所有其他系统提示词段**，包括 AGENTS.md、技能、运行时上下文和 PTC-only 说明。这是实验配置，不建议直接用于生产。如果仍然失败，说明 PTC SDK 不是全部原因；如果成功，再回退到只开 `sdkStyle: index`，最后再恢复 `promptMode: system`。

## 实现与限制

- 插件只替换 `run_code` 传输的 `execute` 与 `describe`：在程序开头注入 `run_code_subtools` 和 `run_code_itself` 两个声明，并在 schema 中打开 `additionalProperties`。校验、嵌套调用调度、审批、沙箱、结果渲染仍由标准 PTC 执行器负责。
- Host 行在 `agent/created` 时为该 Agent 安装一个继承标准 `PtcExecutor` 的 Agent 作用域执行器；preset 行则直接在 preset 作用域注册同一个执行器。
- 声明行按 JSON 字面量生成；含 `__proto__` 键的载荷改用 `JSON.parse` 还原，U+2028/U+2029 会被转义。
- 程序源码里会多一行声明；用户代码的错误行号会比原始 `code` 偏移一行。
- 载荷会在程序里出现一次（`run_code_itself`），同时仍作为模型工具调用的参数保存在会话日志中。
- 依赖 DSH 0.2.2-rc.5 的 `PtcExecutor` 内部接口（`requirePtcTransport`）；升级 DSH 后若该接口变化，插件会记录警告并保持标准 PTC 行为。

## 安全

插件在 DSH Host 进程里以你的用户权限运行，只安装你信任的代码。`run_code` 程序本身受 Session 的 PTC 沙箱策略约束，但这个插件本身运行在 Host 里。

## 开发

集成测试导入本机安装的 DSH 包（真实的 `PtcExecutor`、`createRunCodeTool`、`ToolsService`）。把 `DSH_PACKAGES_DIR` 指向包含 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-tool-executor-ptc`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 的 `node_modules` 目录：

```sh
DSH_PACKAGES_DIR=/path/to/node_modules npm test
```

不设置时会尝试 `DSH_INSTALL_DIR` 和 `NODE_PATH` 里的目录；详见 [test/README.md](test/README.md)。

```sh
npm run check   # node --check index.js
npm test        # 集成检查
```

## 卸载

在 **插件** 页面停用或移除本 bundle 后，新的 Agent 恢复为标准 PTC 执行器。
