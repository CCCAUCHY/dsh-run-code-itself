# dsh-run-code-itself

DSH PTC 的 Data-Code Separation 插件。

直接工具仍然是 run_code。每次调用预置两个变量：

- run_code_itself：本次调用的完整参数，包括所有兄弟字段；
- run_code_subtools：每个工具的描述、紧凑签名和输入 schema。

只有 run_code 可以直接调用；其他工具都要在程序内部调用。目标很简单：不要把数据写进 code 字符串，也不要把子工具参数作为 JSON 字符串传递，而是直接在兄弟字段里放真正的 JSON 对象。

## 它做什么

以前：

    const svg = "<svg>...</svg>"
    await tools.write({ file_path: "out.svg", content: svg })

现在：

    {"code":"return await tools.write(run_code_itself.write)","description":"写 SVG","write":{"file_path":"out.svg","content":"<svg>...</svg>"}}

或者根据 schema 直接写一次调用：

    {"code":"const s = run_code_subtools.write.schema; if (!s.required.every(k => k in run_code_itself.write)) throw new Error('missing write fields'); return (await tools.write(run_code_itself.write)).path","description":"写文件","write":{"file_path":"a.txt","content":"hi"}}

数组与循环：

    {"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"批量编辑","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

run_code_subtools 是普通 JSON；所有可见工具都在里面，系统规范里也会列出全部工具的紧凑目录。可以用 Object.keys(run_code_subtools) 或打印某个条目。

不再生成模板。run_code_subtools.<tool>.schema 是工具真实的输入 JSON Schema；直接在兄弟字段里构造参数对象，由工具 schema 校验。

## 系统规范与工具描述

系统提示词包含：

- Data-Code Separation 规则；
- 常用工具签名：bash、read、write、edit、glob、grep、read_image；
- 其他所有可见工具的紧凑目录。

run_code 工具描述故意很短，但保留了最基本的契约，所以系统规范被抑制时规则不会完全消失。规范段比工具描述长。

persona 必须使用 complete: false；complete: true 会抑制系统规范段。

## 提示词技巧

下面这些属于 profile 或 dsh_home 级 patch，不属于插件自己的 cordis.patch.yml。插件级文件保持空数组（[]），只负责让插件可用，由 profile 或 preset 挂载。

### 全局关闭 harness 身份

    - id: harness-dev-context
      disabled: true
    - id: system-prompt
      config:
        includeHarnessIdentity: false

这会从全局系统提示词里去掉 implementation checkout / Web GUI 上下文和 harness 身份文字。

### Persona

把下面的 prefix 用作 persona；complete 必须保持 false，否则系统规范段会被抑制：

    - id: persona
      name: '@deepseek-ai/dsh-persona'
      config:
        prefix: |
          You are a helpful software engineer assistant. You MUST follow the run_code usage rules in the run_code tool description. Never inline subtool arguments. Put them as real JSON objects in run_code_itself sibling fields; inspect run_code_subtools.<tool>.schema when needed, and return only JSON-safe values.
        complete: false
        includeRuntimeContext: false

如果使用多个 preset，需要在每个 preset 的 plugins 列表里都加同样的 persona 条目。

### AGENTS.md 强调

在用户级或工作区级 AGENTS.md 里追加：

    ## run_code Data-Code Separation

    - Never inline tools.x({...}) inside run_code code.
    - Put data and every subtool argument in sibling fields of the call.
    - Read run_code_itself sibling fields; inspect run_code_subtools.<tool>.schema when needed; return only JSON-safe values.
    - If a value needs quotes, backslashes, or newlines, move it to a sibling field.

仓库自己的 cordis.patch.yml 故意保持 []；不要把上面的 profile 配置复制进去。

## 挂载

Preset：

    - id: run-code-itself
      name: 'dsh-run-code-itself'

Host 行：

    - insert:
        - id: run-code-itself
          name: 'dsh-run-code-itself'

## 安装

    dsh plugin --profile <profile> add /path/to/dsh-run-code-itself

## 配置

- maxSubCallsPerMinute：run_code 超时内每分钟的嵌套调用尝试数。
- maxParallelSubCalls：并发安全的子调用上限。
- commonTools：显示在常用工具段的工具名；其他可见工具仍会列在紧凑目录里。默认：bash、read、write、edit、glob、grep、read_image。
- promptMode / sdkStyle：已废弃，仅为兼容保留，忽略。

profile 配置示例：

    config:
      commonTools:
        - bash
        - read
        - write
        - edit
        - glob
        - grep
        - read_image

## 为什么工具名仍然是 run_code

之前实验过把工具暴露为 program。三组独立 review 发现：插件层别名会破坏 DSH 的不变量——tool/call 日志、会话迁移、审批与 presentCall、knownNames/tool ordering 都绑定真实工具名。最终版本保留 run_code，把 Data-Code Separation 的投入放在变量、schema、系统规范和工具描述上。

## 行为与限制

- 面向 TypeScript PTC 运行时；插件不导入、也不切换到 Python PTC 运行时。
- 插件不做 Code-Data Separation 的硬拦截；任意 TypeScript 仍可在代码里构造参数对象，合规性取决于模型。
- 小范围跨模型观察：OpenAI、Google 模型能按规范工作；DeepSeek-flash 在复杂任务下回退到内联。
- 如果需要确定性拦截，应使用运行时 provenance 或无代码管道；本插件没有实现。

## 开发

    DSH_PACKAGES_DIR=... node --experimental-loader ./test/loader.mjs ./test/run.mjs

测试覆盖 schema、规范长度、工具 schema、变量注入、特殊载荷、别名分发和 preset 挂载。

固定提示词放在 prompts/ 下：guide.md 和 tool-description.txt；index.js 只负责加载和渲染，不再内联大段提示词。

MIT。
