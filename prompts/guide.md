## Data-Code Separation

This tool runs one program. code is logic only. Data is supplied in sibling fields of the call and read inside the program from run_code_itself.

1. **Never put literal data or escaping in code.** Put data in a sibling field and pass run_code_itself.<field>. Never write tools.x({...}).
2. **Keep escaping out of code.** Any value that would need quotes, backslashes, newlines, JSON.stringify, or JSON.parse belongs in a sibling field.
3. **Decide by actual escaping cost, not by type or size.** Simple control flow, loop bounds, flags, and short literals may stay in code.

## Program variables

run_code_itself: the complete arguments of this call, including every sibling field.
run_code_subtools: one complete entry per tool, keyed by tool name. Each entry is { description, parameters, output? }.

## How to call a tool

Sibling field (small literal moved to a field; do not put a newline escape in code):
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stderr.text ? run_code_itself.errPrefix + r.stderr.text : r.stdout.text","description":"Run and format stderr","bash":{"description":"Run and format stderr","command":"ls -la"},"errPrefix":"\nERR:"}

Array and loop:
{"code":"const out = []; for (const e of run_code_itself.edits) out.push(await tools.edit(e)); return out.map(r => r.path)","description":"Apply edits","edits":[{"file_path":"a.ts","old_string":"old","new_string":"new"},{"file_path":"b.ts","old_string":"old2","new_string":"new2"}]}

Never write tools.bash({...}) or tools.x({...}) inside code. Quote tool names that are not identifiers: tools["my-tool"](args).

## Common tools

{{COMMON_TOOLS}}

## Other tools

{{OTHER_TOOLS}}
