# dsh-run-code-itself

DSH PTC 的 Data-Code Separation 插件。

直接工具仍然是 run_code。每次调用预置两个变量：

- run_code_itself：本次调用的完整参数，包括所有兄弟字段；
- run_code_subtools：每个工具的描述、最小模板和紧凑签名。

目标很简单：不要把数据写进 code 字符串。

## 它做什么

以前：

    const svg = "<svg>...</svg>"
    await tools.write({ file_path: "out.svg", content: svg })

现在：

    {"code":"return await tools.write(run_code_itself.write)","description":"写 SVG","write":{"file_path":"out.svg","content":"<svg>...</svg>"}}

或者把模板写成一次完整调用：

    {"code":"const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)","description":"列文件","label":"列文件","command":"ls -la"}

数组与循环：

    {"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"批量编辑","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

run_code_subtools 是普通 JSON；所有可见工具都在里面，系统规范里也会列出全部工具的紧凑目录。可以用 Object.keys(run_code_subtools) 或打印某个条目。

模板是结构骨架：必填字段给出简单空占位，有 schema 默认值的选填字段会带上默认值。复杂 enum、union、嵌套 required 的值不做猜测；在代码里填写，由工具 schema 校验。

## 系统规范与工具描述

系统提示词包含：

- Data-Code Separation 规则；
- 常用工具签名：bash、read、write、edit、glob、grep、read_image；
- 其他所有可见工具的紧凑目录。

run_code 工具描述故意很短，但保留了最基本的契约，所以系统规范被抑制时规则不会完全消失。规范段比工具描述长。

persona 必须使用 complete: false；complete: true 会抑制系统规范段。

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
- promptMode / sdkStyle：已废弃，仅为兼容保留，忽略。

## 为什么工具名仍然是 run_code

之前实验过把工具暴露为 program。三组独立 review 发现：插件层别名会破坏 DSH 的不变量——tool/call 日志、会话迁移、审批与 presentCall、knownNames/tool ordering 都绑定真实工具名。最终版本保留 run_code，把 Data-Code Separation 的投入放在变量、模板、系统规范和工具描述上。

## 行为与限制

- 面向 TypeScript PTC 运行时；插件不导入、也不切换到 Python PTC 运行时。
- 插件不做 Code-Data Separation 的硬拦截；任意 TypeScript 仍可在代码里构造参数对象，合规性取决于模型。
- 小范围跨模型观察：OpenAI、Google 模型能按规范工作；DeepSeek-flash 在复杂任务下回退到内联。
- 如果需要确定性拦截，应使用运行时 provenance 或无代码管道；本插件没有实现。

## 开发

    DSH_PACKAGES_DIR=... node --experimental-loader ./test/loader.mjs ./test/run.mjs

测试覆盖 schema、规范长度、枚举/嵌套模板、变量注入、特殊载荷、别名分发、Python 拒绝和 preset 挂载。

MIT。
