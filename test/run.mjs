/**
 * Verification for the run_code_itself plugin. Runs against the installed DSH
 * packages through test/loader.mjs, with the PTC runtime faked so the real
 * run_code transport builds the program the plugin hands it.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import * as plugin from '../index.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BT = String.fromCharCode(96)
const LS = String.fromCharCode(0x2028)
const original = 'const { rows, regex } = run_code_itself; return rows.filter(row => new RegExp(regex).test(row.id))'

function harness() {
  const ctx = new Context()
  const programs = []
  const runtime = {
    language: 'typescript',
    programFormat: 'function-body',
    retainsState: false,
    sandboxMode: undefined,
    timeout: { defaultMs: 120000, maxMs: 600000 },
    executionInstructions: '',
    resolve(request) {
      return { ...request, cwd: '/tmp', timeoutMs: request.timeoutMs ?? 120000 }
    },
    async run(spec) {
      programs.push(spec.program)
      return { logs: [], value: 'ran' }
    },
  }
  const tools = {
    schemas: () => [],
    definitions: () => [],
    executable: () => undefined,
    get: () => undefined,
    selectExecutor: () => undefined,
  }
  const systemPrompt = { getSectionOrder: () => 0, section: () => () => {} }
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', systemPrompt)
  ctx.provide('ptcRuntime', runtime)
  return { ctx, programs, runtime, tools }
}

function toolExec() {
  return {
    name: 'run_code',
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('exec'),
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

async function runProgram(executor, args) {
  const transport = executor.requirePtcTransport()
  const result = await transport.execute(args, toolExec())
  assert.equal(result.logs.length, 0)
  const program = executor.programs.at(-1)
  assert.equal(typeof program, 'string')
  return { program, value: await new AsyncFunction(program)() }
}

const { ctx, programs } = harness()
const executor = new plugin.RunCodeItselfExecutor(ctx, {})
executor.programs = programs

// --- schema ---------------------------------------------------------------
const described = executor.describe([])
assert.equal(described.schemas.length, 1)
const schema = described.schemas[0]
assert.equal(schema.name, 'run_code')
assert.equal(schema.parameters.additionalProperties, true)
assert.equal(schema.parameters.required.includes('code'), true)
assert.equal(schema.parameters.required.includes('description'), true)
assert.ok(schema.description.includes('Extra top-level sibling fields are allowed'))
assert.ok(!schema.description.includes('Code-Data'))
assert.ok(!schema.description.includes('MUST'))
assert.ok(schema.parameters.properties.code.description.includes('run_code_itself'))
assert.ok(schema.parameters.properties.code.description.includes('metaprogramming'))
console.log('schema: open parameters and guidance present')

// --- the proposed metaprogramming example ---------------------------------
{
  const rows = [{ id: 'AB-123-4567' }, { id: 'ZZ-9999' }]
  const { program, value } = await runProgram(executor, {
    code: original,
    description: 'Filter rows by id pattern',
    regex: '\\b\\d{3}-\\d{4}\\b',
    rows,
  })
  assert.ok(program.startsWith('const run_code_subtools = '))
  assert.ok(program.includes('const run_code_itself = {'))
  assert.ok(program.includes('\\\\b\\\\d{3}-\\\\d{4}\\\\b'))
  assert.deepEqual(value, [{ id: 'AB-123-4567' }])
  console.log('example: filtered', JSON.stringify(value))
}

// --- code identity and parsed extras --------------------------------------
{
  const code = 'return { same: run_code_itself.code, rows: run_code_itself.rows, n: run_code_itself.n }'
  const { value } = await runProgram(executor, { code, description: 'identity', rows: [{ id: 'a' }], n: 3 })
  assert.deepEqual(value, { same: code, rows: [{ id: 'a' }], n: 3 })
  console.log('identity: code and extra fields preserved')
}

// --- no extra fields ------------------------------------------------------
{
  const { value } = await runProgram(executor, { code: 'return typeof run_code_itself.rows', description: 'no extras' })
  assert.equal(value, 'undefined')
  console.log('empty extras: variable still present')
}

// --- __proto__ payload ----------------------------------------------------
{
  const args = JSON.parse('{"code":"return run_code_itself.__proto__.x","description":"proto","__proto__":{"x":7}}')
  const { program, value } = await runProgram(executor, args)
  assert.ok(program.includes('JSON.parse('))
  assert.equal(value, 7)
  console.log('__proto__: own key preserved')
}

// --- U+2028 payload -------------------------------------------------------
{
  const code = 'return run_code_itself.text.charCodeAt(0)'
  const { program, value } = await runProgram(executor, { code, description: 'line separator', text: LS })
  assert.equal(value, 0x2028)
  assert.ok(!program.includes(LS))
  console.log('U+2028: escaped and round-tripped')
}

// --- malformed arguments pass through to the transport --------------------
{
  const transport = executor.requirePtcTransport()
  await assert.rejects(() => transport.execute({ code: 5, description: 'x' }, toolExec()), /invalid arguments/)
  await assert.rejects(() => transport.execute({ code: 'return 1' }, toolExec()), /invalid arguments/)
  console.log('invalid arguments: still rejected by the transport')
}

// --- per-agent installation -----------------------------------------------
{
  const ctx2 = new Context()
  const installed = []
  const systemPrompt2 = { getSectionOrder: () => 0, section: () => () => {} }
  const runtime2 = {
    language: 'typescript', programFormat: 'function-body', retainsState: false,
    timeout: { defaultMs: 120000, maxMs: 600000 }, executionInstructions: '',
  }
  ctx2.provide('systemPrompt', systemPrompt2)
  ctx2.provide('ptcRuntime', runtime2)
  const current = new PtcExecutor(ctx2, { maxSubCallsPerMinute: 77 })
  const tools2 = {
    schemas: () => [],
    definitions: () => [],
    executable: () => undefined,
    get: () => undefined,
    selectExecutor: () => current,
    setExecutor(executor) { installed.push(executor); return () => {} },
  }
  ctx2.provide('tools', tools2)
  const agents = []
  ctx2.provide('agents', { list: () => agents })
  const scope = createScope(ctx2, { agent: 'a1' })
  const agent = { id: 'a1', ctx: scope.ctx }
  agents.push(agent)
  await ctx2.plugin(plugin)
  assert.equal(installed.length, 1)
  assert.ok(installed[0] instanceof plugin.RunCodeItselfExecutor)
  assert.equal(installed[0].config.maxSubCallsPerMinute, 77)
  console.log('installation: enhanced executor inherits PTC limits')
  await scope.dispose()
}
console.log('')

// --- real registry: agent scope shadows the preset scope -------------------
{
  const ctx3 = new Context()
  let promptAssembly
  const prompt = {
    getSectionOrder: () => 0,
    section: () => () => {},
    tools(callback) { promptAssembly = callback; return () => {} },
  }
  ctx3.provide('systemPrompt', prompt)
  const runtime3 = {
    language: 'typescript', programFormat: 'function-body', retainsState: false,
    timeout: { defaultMs: 120000, maxMs: 600000 }, executionInstructions: '',
    resolve(request) { return { ...request, cwd: '/tmp', timeoutMs: 120000 } },
    async run() { return { logs: [], value: 'ok' } },
  }
  ctx3.provide('ptcRuntime', runtime3)
  const tools3 = new ToolsService(ctx3)
  const rootExecutor = new PtcExecutor(ctx3, {})
  tools3.setExecutor(rootExecutor)
  const agent = { id: 'a2' }
  const scope = createScope(ctx3, agent)
  agent.ctx = scope.ctx
  const agents = [agent]
  ctx3.provide('agents', { list: () => agents })
  await ctx3.plugin(plugin)
  assert.notEqual(tools3.selectExecutor(agent), rootExecutor)
  assert.ok(tools3.selectExecutor(agent) instanceof plugin.RunCodeItselfExecutor)
  assert.equal(tools3.selectExecutor(undefined), rootExecutor)
  const assembled = promptAssembly({ scope: agent })
  assert.equal(assembled.schemas.length, 1)
  assert.equal(assembled.schemas[0].parameters.additionalProperties, true)
  console.log('scope shadowing: agent executor wins and its schema is assembled')
  await scope.dispose()
}
// --- preset-scoped mount replaces the preset executor ----------------------
{
  const ctx4 = new Context()
  let assembly
  const prompt = {
    getSectionOrder: () => 0,
    section: () => () => {},
    tools(callback) { assembly = callback; return () => {} },
  }
  ctx4.provide('systemPrompt', prompt)
  const runtime4 = {
    language: 'typescript', programFormat: 'function-body', retainsState: false,
    timeout: { defaultMs: 120000, maxMs: 600000 }, executionInstructions: '',
    resolve(request) { return { ...request, cwd: '/tmp', timeoutMs: 120000 } },
    async run() { return { logs: [], value: 'ok' } },
  }
  ctx4.provide('ptcRuntime', runtime4)
  const tools4 = new ToolsService(ctx4)
  const root = new PtcExecutor(ctx4, {})
  tools4.setExecutor(root)
  ctx4.provide('agents', { list: () => [] })
  const presetKey = { preset: 'main' }
  const scope = createScope(ctx4, presetKey)
  await scope.ctx.plugin(plugin)
  assert.notEqual(tools4.selectExecutor(presetKey), root)
  assert.ok(tools4.selectExecutor(presetKey) instanceof plugin.RunCodeItselfExecutor)
  const assembled = assembly({ scope: presetKey })
  assert.equal(assembled.schemas.length, 1)
  assert.equal(assembled.schemas[0].parameters.additionalProperties, true)
  console.log('preset mount: enhanced executor registered in the preset scope')
  await scope.dispose()
}
// --- preloaded tool templates ----------------------------------------------
{
  const bashSchema = {
    name: 'bash',
    description: 'Execute a shell command and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['description', 'command'],
    },
  }
  const bashDefinition = {
    ...bashSchema,
    output: {
      schema: {
        type: 'object',
        properties: {
          stdout: { type: 'object', properties: { text: { type: 'string' } } },
          exitCode: { type: 'number' },
        },
      },
    },
  }
  const subtools = plugin.buildSubtools([bashDefinition])
  assert.equal(subtools.bash.description, 'Execute a shell command and return stdout/stderr.')
  assert.deepEqual({ ...subtools.bash.template }, { description: '', command: '' })
  const readDefinition = {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' } },
      required: ['file_path'],
    },
    output: { schema: {} },
  }
  assert.deepEqual({ ...plugin.buildSubtools([readDefinition]).read.template }, { file_path: '' })
  const defaultDefinition = {
    name: 'demo',
    description: 'Demo tool.',
    parameters: {
      type: 'object',
      properties: { required: { type: 'string' }, optional: { type: 'number', default: 7 } },
      required: ['required'],
    },
    output: { schema: {} },
  }
  assert.deepEqual({ ...plugin.buildSubtools([defaultDefinition]).demo.template }, { required: '', optional: 7 })

  const webDefinition = { name: 'web_search', description: 'Search the web. Returns results.', parameters: {}, output: { schema: {} } }
  const sdk = plugin.renderCompactSdk([bashDefinition, webDefinition])
  assert.ok(sdk.includes('## Code-Data Separation'))
  assert.ok(sdk.includes('**Minimize escaping in code.**'))
  assert.ok(sdk.includes('**Subtool metadata**'))
  assert.ok(sdk.includes('Do not inline subtool JSON'))
  assert.ok(sdk.includes('declare const run_code_itself'))
  assert.ok(sdk.includes('declare const run_code_subtools'))
  assert.ok(sdk.includes('args.description = run_code_itself.label'))
  assert.ok(sdk.includes('interface ToolArgsMap'))
  assert.ok(sdk.includes('tools.bash(run_code_itself.bash)'))
  assert.ok(sdk.includes('web_search: Search the web.'))
  assert.ok(sdk.includes('run_code_subtools'))

  const { ctx, programs, tools } = harness()
  tools.schemas = () => [bashSchema]
  tools.definitions = () => [bashDefinition]
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const transport = executor.requirePtcTransport()
  await transport.execute({
    code: 'return { description: run_code_subtools.bash.description, template: run_code_subtools.bash.template, arg: run_code_itself.bash }',
    description: 'Template test',
    bash: { command: 'ls -la', description: 'List files' },
  }, toolExec())
  const program = programs.at(-1)
  assert.ok(program.includes('const run_code_subtools = '))
  assert.ok(program.includes('const run_code_itself = '))
  assert.ok(!program.includes('run_code_call'))
  assert.ok(!program.includes('run_code_templates'))
  const fn = new AsyncFunction(program)
  const value = await fn()
  assert.equal(value.description, 'Execute a shell command and return stdout/stderr.')
  assert.deepEqual(value.template, { description: '', command: '' })
  assert.deepEqual(value.arg, { command: 'ls -la', description: 'List files' })

  const indexSdk = plugin.renderCompactSdk([bashDefinition, webDefinition], { sdkStyle: 'index' })
  assert.ok(indexSdk.includes('## Tools'))
  assert.ok(indexSdk.includes('web_search: Search the web.'))
  assert.ok(!indexSdk.includes('declare const tools'))
  const fullIndex = plugin.renderCompactSdk([bashDefinition, webDefinition], { sdkStyle: 'index', fullDescriptions: true })
  assert.ok(fullIndex.includes('web_search: Search the web. Returns results.'))

  const { ctx: toolCtx } = harness()
  const toolExecutor = new plugin.RunCodeItselfExecutor(toolCtx, { promptMode: 'tool' })
  const toolSchema = toolExecutor.describe([bashDefinition, webDefinition]).schemas[0]
  assert.ok(toolSchema.description.includes('## Code-Data Separation'))
  assert.ok(toolSchema.description.includes('## Tools'))
  assert.ok(toolSchema.description.includes('Search the web. Returns results.'))
  assert.ok(!toolSchema.description.includes('declare const tools'))
  assert.equal(toolExecutor.sections.length, 1)
  console.log('prompt modes: index SDK and tool-description mode')

  console.log('subtools: description and full template preloaded; only run_code_itself and run_code_subtools')
}
console.log('All checks passed')