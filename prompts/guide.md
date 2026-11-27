## run_code usage rules

- code is the body of an async TypeScript function. Top-level await and return work; use erasable syntax only.
- run_code is one complete call. The program reads its arguments and sibling fields from run_code_itself; nested tool metadata is in run_code_subtools, one entry per tool with { description, parameters, output }.
- Put data and every nested tool argument in sibling fields as real JSON objects. Never encode them as JSON strings, and never inline tools.x({...}) in code.
- Call tools as await tools.name(args). Quote names that are not identifiers: await tools["my-tool"](args).
- A failed nested call rejects with ToolCallError carrying toolName and message; catch it when the program should continue.
- Promise.all may overlap independent read-only calls; mutating calls are ordered.
- Arguments and results are lossless JSON. Return only JSON-safe values. Only printed or returned values are program output; image-bearing results attach after the run.
- Common tools have JSON contracts below. Other tools use their signatures and run_code_subtools.parameters.

### Other tools

{{OTHER_TOOLS}}

## Common tools JSON

The values below are plain JSON and use exactly the same entry shape as run_code_subtools.<tool>:

{{COMMON_TOOLS_JSON}}

## Examples

Sibling field (small literal moved to a field; do not put a newline escape in code):
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stderr.text ? run_code_itself.errPrefix + r.stderr.text : r.stdout.text","description":"Run and format stderr","bash":{"description":"Run and format stderr","command":"ls -la"},"errPrefix":"\nERR:"}

Schema check and direct write:
{"code":"const s = run_code_subtools.write.parameters; if (!s.required.every(k => k in run_code_itself.write)) throw new Error('missing write fields'); return (await tools.write(run_code_itself.write)).path","description":"Write file","write":{"file_path":"a.txt","content":"hi"}}

Array and loop:
{"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

Never write tools.bash({...}) or tools.x({...}) inside code.
