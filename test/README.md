# Tests

`run.mjs` is an integration check against the installed DSH packages: it imports the real `PtcExecutor`, `createRunCodeTool`, and `ToolsService`, fakes the PTC runtime to capture the generated program, and executes that program with `AsyncFunction`.

```sh
DSH_PACKAGES_DIR=/path/to/node_modules npm test
```

`DSH_PACKAGES_DIR` must contain:

- `@deepseek-ai/dsh-tools`
- `@deepseek-ai/dsh-tool-executor-ptc`
- `@deepseek-ai/dsh-scope`
- `@deepseek-ai/cordis`
- `@deepseek-ai/schemastery`

`test/loader.mjs` resolves every bare `@deepseek-ai/*` import from these roots, in order: `DSH_PACKAGES_DIR`, `DSH_INSTALL_DIR/../..`, then each `NODE_PATH` entry.

What it covers:

1. `describe()` returns an open `run_code` schema (`additionalProperties: true`) with the `run_code_itself` guidance.
2. The real `run_code` transport receives the injected program; executing it verifies extra fields and `run_code_itself.code`.
3. `__proto__` and U+2028 payloads stay literal-safe.
4. Invalid arguments are still rejected by the original transport.
5. The real `ToolsService` shadows a root executor with an agent-scoped enhanced executor and assembles its schema.
6. The plugin mounts through `ctx.plugin` in a preset scope and registers itself as that preset's executor.
