# dsh-run-code-itself

Data-Code Separation for DSH PTC.

The direct tool stays run_code. Every call preloads two variables:

- run_code_itself: the complete arguments of this call, including all sibling fields;
- run_code_subtools: one entry per tool with description, minimal template, and compact signature.

The goal is simple: keep data out of the code string.

## What it does

Instead of this:

    const svg = "<svg>...</svg>"
    await tools.write({ file_path: "out.svg", content: svg })

write this:

    {"code":"return await tools.write(run_code_itself.write)","description":"Write SVG","write":{"file_path":"out.svg","content":"<svg>...</svg>"}}

or use the template as a complete call:

    {"code":"const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)","description":"List files","label":"List files","command":"ls -la"}

Array and loop:

    {"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

run_code_subtools is a plain JSON object. All visible tools are there, and the system guide also lists a compact directory of every tool; inspect details with Object.keys(run_code_subtools) or print a named entry.

Templates are structural skeletons: required fields are present with simple empty placeholders, and optional fields with schema defaults are included. Complex enum, union, or nested required values are not guessed; fill them in code and rely on the tool schema for validation.

## System guide and tool description

The system prompt contains:

- Data-Code Separation rules;
- compact signatures for common tools: bash, read, write, edit, glob, grep, read_image;
- the compact directory for every other visible tool.

The run_code tool description is deliberately short and contains the essential contract, so a suppressed system guide does not remove every rule. The guide is longer than the tool description.

The persona must use complete: false. With complete: true, the system-prompt guide is suppressed.

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
- promptMode and sdkStyle: deprecated, accepted for compatibility, ignored.

## Why the tool name is still run_code

A previous experimental version exposed the tool as program. Three independent reviews found that a plugin-level alias breaks DSH invariants: tool/call logs, session migration, approval and presentCall paths, and knownNames/tool ordering all bind the real name. The final version keeps run_code and puts the Data-Code Separation investment into variables, templates, the system guide, and the tool description instead.

## Behaviour and limits

- Targets the TypeScript PTC runtime. The plugin does not import or switch to a Python PTC runtime.
- The plugin does not hard-enforce Code-Data Separation. General TypeScript can still construct argument objects in code; prompt compliance is model-dependent.
- A small cross-model check showed OpenAI and Google models following the guide; a DeepSeek-flash route reverted to inline calls on complex tasks.
- If deterministic enforcement is required, use runtime provenance or a no-code pipeline; neither is implemented here.

## Development

    DSH_PACKAGES_DIR=... node --experimental-loader ./test/loader.mjs ./test/run.mjs

The test covers schema, guide length, templates with enum/nested objects, injection, special payloads, alias dispatch, Python rejection, and preset mounting.

MIT.
