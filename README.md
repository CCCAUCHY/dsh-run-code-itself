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

The model-facing `run_code` schema is open (`additionalProperties: true`) and its description explains the contract.

## Passing data

Extra fields are values in the same JSON object as `code` — write them as JSON, not as a stringified JSON string:

```json
{"code":"return run_code_itself.rows.length","description":"Count rows","rows":[{"id":"AB-123-4567"}]}
```

Inside `code`, the same payload needs a JavaScript literal and a second escaping layer for the `code` string. An extra field has only the outer JSON layer, and the program receives the parsed value directly.

This applies regardless of payload size: even a single path, command, regex, or small object belongs in an extra field when it is a subtool argument.

Prepare nested tool arguments the same way:

```json
{"code":"const r = await tools.bash(run_code_itself.bash); return r.stdout.text","description":"List files","bash":{"description":"List files","command":"ls -la"}}
```

## Metaprogramming

`run_code_itself.code` is the exact source of the running program. A program can read it, split it at its own markers, or `eval` a piece to generate code from a template. Keep the evaluated result valid JavaScript; extra fields are the easiest place to carry the template or its data.

## Requirements

- DSH `0.2.2-rc.5`
- A TypeScript PTC runtime (the shipped `@deepseek-ai/dsh-ptc-runtime-node`)

## Install

```sh
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself
# or a packed tarball:
dsh plugin --profile <profile> add /path/to/dsh-run-code-itself-0.1.7.tgz
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

- `describe()` appends the extra-fields contract to the tool description and sets `additionalProperties: true`;
- `execute()` prepends one declaration to the program and hands it to the standard transport:

  ```js
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
