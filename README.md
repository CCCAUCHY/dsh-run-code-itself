# dsh-run-code-itself

Data-Code Separation for DSH PTC.

The direct tool stays run_code. Every call preloads two variables:

- run_code_itself: the complete arguments of this call, including all sibling fields;
- run_code_subtools: every tool exposes DSH's original description and parameters; the system prompt shows common tools in full and other tools by signature.

Only run_code is callable directly. Every other tool is called from inside the program. The goal is simple: keep data out of the code string, and pass subtool arguments as real JSON objects rather than JSON strings.

For PTC runtimes configured as script or repl, the plugin wraps the program in an async IIFE. The two prelude variables remain local, top-level return/await keep function-body semantics, and a second evaluation cannot hit a duplicate const declaration.

## What it does

Instead of this:

    const svg = "<svg>...</svg>"
    await tools.write({ file_path: "out.svg", content: svg })

write this:

    {"code":"return await tools.write(run_code_itself.write)","description":"Write SVG","write":{"file_path":"out.svg","content":"<svg>...</svg>"}}

or build a schema-informed direct call:

    {"code":"const s = run_code_subtools.write.parameters; if (!s.required.every(k => k in run_code_itself.write)) throw new Error('missing write fields'); return (await tools.write(run_code_itself.write)).path","description":"Write file","write":{"file_path":"a.txt","content":"hi"}}

Array and loop:

    {"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

run_code_subtools is a plain JSON object keyed by tool name; every entry carries the complete description + parameters for on-demand loading. In the system prompt, common tools are shown in full and all others use a compact signature.

There are no generated templates. run_code_subtools.<tool>.parameters is the tool's original input JSON Schema for every tool; build the argument object directly in a sibling field and let the tool schema validate it. The prompt's signature is only a compact hint for non-common tools.

## System guide and tool description

The system prompt contains:

- Data-Code Separation rules, rewritten from the stock PTC wording;
- common tools with full description + parameters, other tools with compact signature;
- runtime metadata exposing { description, parameters } for every tool, available on demand through run_code_subtools.

The run_code tool description is rewritten too; it preserves the runtime execution instructions, current-directory text, and sandbox guidance. The system guide is longer than the tool description.

The persona must use complete: false. With complete: true, the system-prompt guide is suppressed.

## Prompt techniques

These settings belong to a profile or dsh_home patch, not to the plugin's own cordis.patch.yml. The plugin-level file stays an empty array ([]); it only makes the plugin available and is mounted by the profile or preset.

### Remove the harness identity globally

    - id: harness-dev-context
      disabled: true
    - id: system-prompt
      config:
        includeHarnessIdentity: false

This removes the implementation-checkout / Web-GUI context and the harness identity text from the global system prompt.

### Persona

Use this as the persona prefix; complete must remain false so the system guide is not suppressed:

    - id: persona
      name: '@deepseek-ai/dsh-persona'
      config:
        prefix: |
          You are a helpful software engineer assistant. You MUST follow the run_code usage rules in the run_code tool description. Never inline subtool arguments. Put them as real JSON objects in run_code_itself sibling fields; inspect run_code_subtools.<tool>.parameters when needed, and return only JSON-safe values.
        complete: false
        includeRuntimeContext: false

If you run several presets, add the same persona entry to each preset's plugin list.

### AGENTS.md emphasis

Append a short section to the user/workspace AGENTS.md:

    ## run_code Data-Code Separation

    - Never inline tools.x({...}) inside run_code code.
    - Put data and every subtool argument in sibling fields of the call.
    - Read run_code_itself sibling fields; inspect run_code_subtools.<tool>.parameters when needed; return only JSON-safe values.
    - If a value needs quotes, backslashes, or newlines, move it to a sibling field.

The repository's own cordis.patch.yml is deliberately []; do not copy the profile rows above into it.

## Mount

Preset:

    - id: run-code-itself
      name: 'dsh-run-code-itself'

Host row:

    - insert:
        - id: run-code-itself
          name: 'dsh-run-code-itself'

## Install

    dsh plugin --profile <profile> add /path/to/dsh-run-code-itself

## Configuration

- maxSubCallsPerMinute: nested tool-call attempts per minute of run_code timeout.
- maxParallelSubCalls: maximum overlapping concurrency-safe program subcalls.
- commonTools: tools shown in full in the system prompt; all other tools use signature there. run_code_subtools always has full description + parameters for every tool. Default: bash, read, write, edit, glob, grep, read_image.
- promptMode and sdkStyle: deprecated, accepted for compatibility, ignored.

Example profile config:

    config:
      commonTools:
        - bash
        - read
        - write
        - edit
        - glob
        - grep
        - read_image

## Why the tool name is still run_code

A previous experimental version exposed the tool as program. Three independent reviews found that a plugin-level alias breaks DSH invariants: tool/call logs, session migration, approval and presentCall paths, and knownNames/tool ordering all bind the real name. The final version keeps run_code and puts the Data-Code Separation investment into variables, schemas, the system guide, and the tool description instead.

## Behaviour and limits

- Targets the TypeScript PTC runtime. The plugin does not import or switch to a Python PTC runtime.
- The plugin does not hard-enforce Code-Data Separation. General TypeScript can still construct argument objects in code; prompt compliance is model-dependent.
- A small cross-model check showed OpenAI and Google models following the guide; a DeepSeek-flash route reverted to inline calls on complex tasks.
- If deterministic enforcement is required, use runtime provenance or a no-code pipeline; neither is implemented here.

## Development

    DSH_PACKAGES_DIR=... node --experimental-loader ./test/loader.mjs ./test/run.mjs

The test covers schema, guide length, tool schemas, injection, special payloads, alias dispatch, and preset mounting.

Fixed prompt data lives under prompts/: guide.md and tool-description.txt. index.js only loads and renders it.

MIT.
