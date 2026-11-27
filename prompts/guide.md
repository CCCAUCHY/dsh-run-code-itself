## Data-Code Separation

Only run_code is callable directly. Every other tool is called from inside the program with tools.<name>(...).

This tool runs one program. code is logic only. Data is supplied in sibling fields of the call and read inside the program from run_code_itself.

1. **Put arguments in sibling fields as real JSON objects.** Put data in a sibling field and pass run_code_itself.<field>. Never write tools.x({...}).
2. **Never encode a subtool argument as a JSON string.** Do not JSON.stringify or JSON.parse a subtool argument, and do not place JSON text in a field.
3. **Keep escaping out of code.** Any value that would need quotes, backslashes, or newlines belongs in a sibling field.
4. **Short literals are for control only.** Loop bounds, flags, and conditions may stay in code; data literals move to fields.

## Program variables

run_code_itself: the complete arguments of this call, including every sibling field.
run_code_subtools: one entry per tool, keyed by tool name.

## Tool schema

run_code_subtools.<tool> = { description, parameters }.
parameters is the tool's input JSON Schema. Build the actual argument object directly in a sibling field of the run_code call; do not pass a stringified schema.

## Examples

Sibling field (small literal moved to a field; do not put a newline escape in code):
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stderr.text ? run_code_itself.errPrefix + r.stderr.text : r.stdout.text","description":"Run and format stderr","bash":{"description":"Run and format stderr","command":"ls -la"},"errPrefix":"\nERR:"}

Schema check and direct write:
{"code":"const s = run_code_subtools.write.parameters; if (!s.required.every(k => k in run_code_itself.write)) throw new Error('missing write fields'); return (await tools.write(run_code_itself.write)).path","description":"Write file","write":{"file_path":"a.txt","content":"hi"}}

Array and loop:
{"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

Never write tools.bash({...}) or tools.x({...}) inside code.

## Tools

Common tools:

{{COMMON_TOOLS}}

Other tools:

{{OTHER_TOOLS}}
