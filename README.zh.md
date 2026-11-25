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

模型看到的 `run_code` 参数 schema 会把对象标记为可接受额外字段，并在工具说明里得到同样的用法说明。

## 数据怎么传

额外字段和 `code` 在同一个 JSON 对象里，值直接写 JSON，不要写成“JSON 字符串”：

```json
{"code":"return run_code_itself.rows.length","description":"数行数","rows":[{"id":"AB-123-4567"}]}
```

同样的数据如果写在 `code` 里，需要先写成 JavaScript 字面量，再作为 `code` 字符串做一层转义；额外字段只有外层 JSON 一层，程序里直接拿到解析好的值。

子工具的 JSON 也这样提前放好：

```json
{"code":"await tools.write(run_code_itself.write); return 1","description":"写 SVG","write":{"file_path":"out.svg","content":"<svg ...>...</svg>"}}
```

每个字段保持小（几 KB）；大文档拆成多个字段或多次调用。

## 元编程

`run_code_itself.code` 是当前程序的完整原文。程序可以读取它、按自己的标记切分，或对其中一段执行 `eval`，从一个模板动态生成并运行代码。注意被 eval 的内容必须是合法 JavaScript；模板及其数据最好放在额外字段里。

## 安装

```sh
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself
# 或 tgz：
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself-0.1.4.tgz
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

## 实现与限制

- 插件只替换 `run_code` 传输的 `execute` 与 `describe`：把参数对象写进程序开头的 `const run_code_itself = …` 声明，并在 schema 中打开 `additionalProperties`。校验、嵌套调用调度、审批、沙箱、结果渲染仍由标准 PTC 执行器负责。
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
