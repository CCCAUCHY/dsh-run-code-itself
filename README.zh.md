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

或者使用模板：

    const args = run_code_subtools.write.template
    args.file_path = run_code_itself.write.file_path
    args.content = run_code_itself.write.content
    return await tools.write(args)

run_code_subtools 是普通 JSON；所有可见工具都在里面，包括没有列在提示词里的工具。可以用 Object.keys(run_code_subtools) 或打印某个条目。

模板是结构骨架：必填字段给出简单空占位，有 schema 默认值的选填字段会带上默认值。复杂 enum、union、嵌套 required 的值不做猜测；在代码里填写，由工具 schema 校验。

## 系统规范与工具描述

系统提示词包含：

- Data-Code Separation 规则；
- 常用工具签名：bash、read、write、edit、glob、grep；
- 隐藏工具说明。

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

- 只支持 TypeScript PTC；Python PTC 会明确报错。
- 插件不做 Code-Data Separation 的硬拦截；任意 TypeScript 仍可在代码里构造参数对象，合规性取决于模型。
- 小范围跨模型观察：OpenAI、Google 模型能按规范工作；DeepSeek-flash 在复杂任务下回退到内联。
- 如果需要确定性拦截，应使用运行时 provenance 或无代码管道；本插件没有实现。

## 开发

    DSH_PACKAGES_DIR=... node --experimental-loader ./test/loader.mjs ./test/run.mjs

测试覆盖 schema、规范长度、枚举/嵌套模板、变量注入、特殊载荷、别名分发、Python 拒绝和 preset 挂载。

MIT。
