# dsh-run-code-itself

A DeepSeek Harness (DSH) PTC plugin that exposes the **complete `run_code` tool-call arguments** inside the program as `run_code_itself`, so structured payloads can be passed as ordinary JSON fields instead of escaped string literals.

[中文](README.zh.md)

## Why

In PTC mode, `run_code` executes only the `code` string. Passing an array, a JSON document, or a regular expression used to mean serializing it into a string literal inside `code` — escaping quotes, newlines, and backslashes through multiple layers.

With this plugin, the data stays as normal JSON fields on the tool call:

```json
{
  "code": "const { rows, regex } = run_code_itself; return rows.filter(row => new RegExp(regex).test(row.id))",
  "description": "Filter rows by id pattern",
  "regex": "\\b\\d{3}-\\d{4}\\b",
  "rows": [{ "id": "AB-123-4567" }, { "id": "ZZ-9999" }]
}
```

Inside the program:

- `run_code_itself` is the complete arguments object of this call;
- `run_code_itself.code` is the exact `code` source;
- `run_code_itself.rows`, `run_code_itself.regex`, etc. are already parsed JavaScript values;
- do not declare `run_code_itself` yourself.

The model-facing `run_code` schema is open (`additionalProperties: true`). The hard rules live in the system prompt's **Code-Data Separation** section; the tool description only notes that sibling fields are allowed and become `run_code_itself`.

## Code-Data Separation

`code` is program logic. Data and subtool arguments are sibling JSON fields of the `run_code` call; inside the program they are parsed values on `run_code_itself`. Write them as JSON, not as a stringified JSON string:

```json
{"code":"return run_code_itself.rows.length","description":"Count rows","rows":[{"id":"AB-123-4567"}]}
```

Inside `code`, the same payload needs a JavaScript literal and a second escaping layer for the `code` string. An extra field has only the outer JSON layer, and the program receives the parsed value directly.

The goal is to minimize escaping inside `code`, not to classify values by type. If inlining a value needs quotes, backslashes, newlines, `JSON.stringify`/`JSON.parse`, or a large literal, put it in a sibling field; simple values can stay inline. Subtool arguments go in a free-form sibling field or the preloaded template variable, never in an inline object literal.

Prepare nested tool arguments the same way:

```json
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stdout.text","description":"List files","bash":{"description":"List files","command":"ls -la"}}
```

## Subtool metadata

Every visible tool has one entry in `run_code_subtools`:

```json
{
  "description": "full tool description",
  "template": {
    "required_field": "",
    "optional_field": "schema default or empty placeholder"
  }
}
```

The template contains every required field (empty) plus optional fields that have a schema default. Optional fields without a default are omitted, so the template is directly usable after filling the required values. Print one:

```json
{"code":"return run_code_subtools.bash","description":"Read the bash metadata"}
```

Result:

```json
{"description":"Execute a shell command and return stdout/stderr.","template":{"description":"","command":""}}
```

`run_code_subtools.bash` is the wrapper, not the arguments. `run_code_subtools.bash.template` is the argument object; fill the required values from extra fields, then pass it directly to `tools.bash`:

```json
{"code":"const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)","description":"List files","label":"List files","command":"ls -la"}
```

The values live in extra fields, so the `code` string contains no quoted literals to escape.

The `bash` sibling field is a separate free-form field you write into the `run_code` call; at runtime it is `run_code_itself.bash`. That path is also valid:

```json
{"code":"return await tools.bash(run_code_itself.bash)","description":"List files","bash":{"description":"List files","command":"ls -la"}}
```

Do not pass `run_code_subtools.bash` itself to `tools.bash`; it contains `description` and `template`, not command arguments.

## On-demand tool documentation

The system prompt renders a compact SDK with full TypeScript declarations for the common tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`) and a one-line index for all other visible tools. Every tool remains callable; for a hidden tool, print `run_code_subtools.<tool>` first for its full description and template, then call it with `tools.name` and a nested sibling field.

## Metaprogramming

`run_code_itself.code` is the exact source of the running program. A program can read it, split it at its own markers, or `eval` a piece to generate code from a template. Keep the evaluated result valid JavaScript; extra fields are the easiest place to carry the template or its data.

## Requirements

- DSH `0.2.2-rc.5`
- A TypeScript PTC runtime (the shipped `@deepseek-ai/dsh-ptc-runtime-node`)

## Install

```sh
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself
# or a packed tarball:
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself-0.4.8.tgz
```

Or use **Plugins → Add plugin** in the DSH Web UI and point it at the directory or tarball. The CLI only installs the package; the Web UI also selects the bundle (its patch is empty, so this only affects the Plugins listing).

The bundle ships an **empty `cordis.patch.yml`**: installing it only makes the package available to the profile. Mount it yourself, one of two ways.

### A. Host row — every PTC agent in the profile

Add to the profile's `cordis.patch.yml` (or `$DSH_HOME/cordis.patch.yml`):

```yaml
- insert:
    - id: run-code-itself
      name: 'dsh-run-code-itself'
```

On `agent/created`, agents whose selected executor is PTC receive an agent-scoped enhanced executor. Native-executor agents are untouched.

### B. Preset row — replace one preset's executor

In the preset's `plugins` list, replace the stock PTC executor row:

```yaml
- id: tool-executor-ptc
  name: 'dsh-run-code-itself'
```

When mounted in a preset scope, the plugin registers itself as that preset's executor directly.

Restart DSH (or create a new session) after either change.

## How it works

`RunCodeItselfExecutor` extends DSH's `PtcExecutor` and wraps only the reserved `run_code` transport:

- `describe()` adds the extra-fields note and, in `promptMode: tool`, the Code-Data guide to the tool description, and sets `additionalProperties: true`;
- `execute()` prepends two declarations to the program and hands it to the standard transport:

  ```js
  const run_code_subtools = { ...description and template per tool... };
  const run_code_itself = { ...the complete tool-call arguments... };
  ```

Validation, nested-call scheduling, approvals, sandboxing, and result rendering remain owned by DSH's PTC executor.

Mount modes:

- **Host row**: an agent-scoped executor shadows the preset's PTC executor for that agent.
- **Preset row**: the executor is registered in the preset scope.

If a future DSH version changes the internal `requirePtcTransport` hook, the plugin logs a warning and stays inactive instead of breaking the tool schema.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxSubCallsPerMinute` | inherited from the replaced PTC executor | Nested tool-call attempts per minute of `run_code` timeout |
| `maxParallelSubCalls` | inherited from the replaced PTC executor | Maximum overlapping concurrency-safe program subcalls |
| `promptMode` | `system` | `system` keeps the Code-Data guide in the SDK section; `tool` appends it to the `run_code` tool description |
| `sdkStyle` | `declarations` | `declarations` renders the TypeScript SDK; `index` renders a compact tool index without PTC-style declarations |

### Minimal mode

`persona.complete: true` replaces the **system prompt** with the persona prefix. It does **not** suppress the separate user system-reminders: AGENTS.md, the skill catalog, runtime context, and time context are still injected as user messages.

1. Minimal persona:

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |
      You are a helpful software engineer assistant.
      You MUST follow the run_code usage rules in the run_code tool description.
      Never inline subtool arguments: use run_code_itself sibling fields or run_code_subtools templates, and return only JSON-safe values.
    complete: true
    includeRuntimeContext: false
```

2. Move the guide and full tool descriptions into the `run_code` tool description:

```yaml
- id: run-code-itself
  name: 'dsh-run-code-itself'
  config:
    promptMode: tool
    sdkStyle: index
```

3. Start a new session.

Result:

- system message: the persona prefix only;
- user reminders: AGENTS.md, skills, runtime context, and time unchanged;
- tools array: only `run_code`, whose description is ordered as: run_code base → tool list → run_code usage rules;
- no system SDK section and no PTC-only section.

`promptMode: tool` drops both `tools:ptc-only` and `tools:sdk`. The tools array already sends only `run_code`, so the PTC-only instruction is redundant. The base `run_code` description is adjusted to point at the tool list in that same description.

This is a supported minimal configuration, not the default; use a preset copy for A/B comparison. If the model still inlines, the PTC SDK shape is not the whole cause.

## Limitations

- `run_code_itself` is reserved inside the program.
- One extra line is prepended, so error line numbers in user code shift by one.
- The payload appears once in the program and remains in the session log as the tool-call arguments.
- Requires the TypeScript PTC runtime; Python PTC was not a target.
- Depends on DSH 0.2.2-rc.5's `PtcExecutor` internals; see the guard above.

## Security

Plugins run with your user permissions inside the DSH Host process. Install only code you trust.

`run_code` programs execute under the Session's PTC sandbox policy, but this plugin itself runs in the Host — review the source before installing.

## Development

The integration test imports the installed DSH packages (real `PtcExecutor`, `createRunCodeTool`, and `ToolsService`). Point `DSH_PACKAGES_DIR` at a `node_modules` directory that contains `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-tool-executor-ptc`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/cordis`, and `@deepseek-ai/schemastery`:

```sh
DSH_PACKAGES_DIR=/path/to/node_modules npm test
```

Without it, the loader tries `DSH_INSTALL_DIR` and the entries of `NODE_PATH`. See [test/README.md](test/README.md).

```sh
npm run check   # node --check index.js
npm test        # integration checks
```

## License

MIT
