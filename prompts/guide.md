## Program environment

Only run_code is callable directly. A top-level call to any other tool is rejected; every other tool is reached from inside the program.

The program receives bulk data through sibling fields of the run_code call and reads it from run_code_itself. Keep literals, JSON payloads, and escaping out of the program body; keep control flow in code.

## Runtime metadata

run_code_itself: the complete arguments of this call, including every sibling field.
run_code_subtools: one complete entry per tool, keyed by tool name. Each entry is { description, parameters, output? } with DSH's original fields, available for on-demand loading.

Common tools are declared by the typed SDK below. Other tools are listed by signature; read run_code_subtools when a full schema is needed.

## Calling contract

- Call tools as await tools.name(args). Quote names that are not identifiers: await tools["my-tool"](args).
- A failed nested call rejects with ToolCallError carrying toolName and message; catch it when the program should continue.
- Promise.all may overlap independent read-only calls; mutating calls are ordered.
- Arguments and results are lossless JSON. Return only JSON-safe values.
- Common tools have the typed SDK declarations below. Other tools are used through their signatures and run_code_subtools.parameters.

## Other tools

{{OTHER_TOOLS}}

## Common tool SDK declarations

{{SDK}}

## Examples

Sibling field (small literal moved to a field; do not put a newline escape in code):
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stderr.text ? run_code_itself.errPrefix + r.stderr.text : r.stdout.text","description":"Run and format stderr","bash":{"description":"Run and format stderr","command":"ls -la"},"errPrefix":"\nERR:"}

Schema check and direct write:
{"code":"const s = run_code_subtools.write.parameters; if (!s.required.every(k => k in run_code_itself.write)) throw new Error('missing write fields'); return (await tools.write(run_code_itself.write)).path","description":"Write file","write":{"file_path":"a.txt","content":"hi"}}

Array and loop:
{"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

Never write tools.bash({...}) or tools.x({...}) inside code.
