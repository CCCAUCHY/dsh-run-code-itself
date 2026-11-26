import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import * as plugin from '../index.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const LS = String.fromCharCode(0x2028)

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
    resolve(request) { return { ...request, cwd: '/tmp', timeoutMs: request.timeoutMs ?? 120000 } },
    async run(spec) { programs.push(spec.program); return { logs: [], value: 'ran' } },
  }
  const tools = {
    schemas: () => [],
    definitions: () => [],
    executable: () => undefined,
    get: () => undefined,
    checkGuards: () => undefined,
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
  const programSource = executor.programs.at(-1)
  assert.equal(typeof programSource, 'string')
  return { programSource, value: await new AsyncFunction(programSource)() }
}

const bashDefinition = {
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
  output: {
    schema: {
      type: 'object',
      properties: { stdout: { type: 'object', properties: { text: { type: 'string' } } }, exitCode: { type: 'number' } },
    },
  },
}
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
const webDefinition = { name: 'web_search', description: 'Search the web. Returns results.', parameters: {}, output: { schema: {} } }

// --- schema -----------------------------------------------------------------
{
  const { ctx, programs } = harness()
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const described = executor.describe([bashDefinition, readDefinition])
  assert.equal(described.schemas.length, 1)
  assert.deepEqual(described.knownNames, ['run_code'])
  const schema = described.schemas[0]
  assert.equal(schema.name, 'run_code')
  assert.equal(schema.parameters.additionalProperties, true)
  assert.equal(schema.parameters.required.includes('code'), true)
  assert.equal(schema.parameters.required.includes('description'), true)
  assert.ok(schema.description.includes('run_code_itself'))
  assert.ok(schema.description.includes('run_code_subtools'))
  assert.ok(schema.description.includes('body of an async TypeScript function'))
  assert.ok(schema.description.includes('Never write tools.x({...})'))
  assert.ok(schema.description.includes('Data-Code Separation'))
  assert.ok(!schema.description.includes('declare const'))
  assert.ok(schema.parameters.properties.code.description.includes('run_code_itself'))
  console.log('schema: neutral run_code name and short description')

  const guide = plugin.renderProgramGuide([bashDefinition, readDefinition, webDefinition])
  assert.ok(guide.includes('## Data-Code Separation'))
  assert.ok(guide.includes('## Program variables'))
  assert.ok(guide.includes('Common tools:'))
  assert.ok(guide.includes('bash(description, command'))
  assert.ok(guide.includes('args.description = run_code_itself.label'))
  assert.ok(guide.includes('Other tools:'))
  assert.ok(guide.includes('web_search()'))
  assert.ok(guide.includes('Search the web.'))
  assert.ok(guide.includes('run_code_itself.errPrefix'))
  assert.ok(guide.includes('"errPrefix":"\\nERR:"'))
  assert.ok(guide.includes('"code":"const args = run_code_subtools.bash.template'))
  assert.ok(guide.includes('"label":"List files"'))
  assert.ok(guide.includes('"command":"ls -la"'))
  assert.ok(guide.includes('Array and loop:'))
  assert.ok(guide.includes('return out.map(r => r.path)'))
  assert.ok(!guide.includes('declare const tools'))
  assert.ok(guide.length > schema.description.length)
  console.log('guide: rules longer than tool description')

  const subtools = plugin.buildSubtools([bashDefinition, readDefinition])
  assert.equal(subtools.bash.description, 'Execute a shell command and return stdout/stderr.')
  assert.ok(subtools.bash.signature.startsWith('bash(description, command'))
  assert.deepEqual({ ...subtools.bash.template }, { description: '', command: '' })
  assert.deepEqual({ ...subtools.read.template }, { file_path: '' })
  console.log('templates: required fields only')

  assert.equal(executor.sections.length, 1)
  assert.equal(executor.sections[0].name, 'tools:run_code')
}

// --- injection and run_code variables ---------------------------------------
{
  const { ctx, programs, tools } = harness()
  tools.definitions = () => [bashDefinition, readDefinition]
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const { programSource, value } = await runProgram(executor, {
    code: 'return { code: run_code_itself.code, script: run_code_itself.script, keys: Object.keys(run_code_subtools) }',
    description: 'identity',
    script: 'a\nb "quote" C:\\tmp',
    rows: [{ id: 'a' }],
  })
  assert.ok(programSource.startsWith('const run_code_subtools = '))
  assert.ok(programSource.includes('const run_code_itself = {'))

  assert.deepEqual(value, {
    code: 'return { code: run_code_itself.code, script: run_code_itself.script, keys: Object.keys(run_code_subtools) }',
    script: 'a\nb "quote" C:\\tmp',
    keys: ['bash', 'read'],
  })
  console.log('injection: run_code_itself and run_code_subtools')
}

// --- __proto__ and U+2028 --------------------------------------------------
{
  const { ctx, programs } = harness()
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const args = JSON.parse('{"code":"return run_code_itself.__proto__.x","description":"proto","__proto__":{"x":7}}')
  const { programSource, value } = await runProgram(executor, args)
  assert.ok(programSource.includes('JSON.parse('))
  assert.equal(value, 7)
  const lsArgs = { code: 'return run_code_itself.text.charCodeAt(0)', description: 'line separator', text: LS }
  const { programSource: lsProgram, value: lsValue } = await runProgram(executor, lsArgs)
  assert.equal(lsValue, 0x2028)
  assert.ok(!lsProgram.includes(LS))
  console.log('special payloads: __proto__ and U+2028')
}

// --- alias dispatch --------------------------------------------------------
{
  const { ctx, programs } = harness()
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const result = await executor.execute({
    calls: [{ type: 'tool-call', id: 'call-1', name: 'run_code', arguments: JSON.stringify({ code: 'return 1', description: 'alias dispatch' }) }],
    signal: new AbortController().signal,
  })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].result.isError, false)
  assert.equal(programs.length, 1)
  assert.equal(programs.length, 1)
  assert.ok(programs[0].includes('const run_code_itself = '))
  console.log('alias: run_code call reaches the run_code transport')
}

// --- invalid arguments -----------------------------------------------------
{
  const { ctx, programs } = harness()
  const executor = new plugin.RunCodeItselfExecutor(ctx, {})
  executor.programs = programs
  const transport = executor.requirePtcTransport()
  await assert.rejects(() => transport.execute({ code: 5, description: 'x' }, toolExec()), /invalid arguments/)
  await assert.rejects(() => transport.execute({ code: 'return 1' }, toolExec()), /invalid arguments/)
  console.log('invalid arguments: still rejected by the transport')
}

// --- preset mount ----------------------------------------------------------
{
  const ctx = new Context()
  let assembly
  const prompt = { getSectionOrder: () => 0, section: () => () => {}, tools(cb) { assembly = cb; return () => {} } }
  ctx.provide('systemPrompt', prompt)
  const runtime = {
    language: 'typescript', programFormat: 'function-body', retainsState: false,
    timeout: { defaultMs: 120000, maxMs: 600000 }, executionInstructions: '',
    resolve(request) { return { ...request, cwd: '/tmp', timeoutMs: 120000 } },
    async run() { return { logs: [], value: 'ok' } },
  }
  ctx.provide('ptcRuntime', runtime)
  const tools = new ToolsService(ctx)
  tools.setExecutor(new PtcExecutor(ctx, {}))
  ctx.provide('agents', { list: () => [] })
  const presetKey = { preset: 'main' }
  const scope = createScope(ctx, presetKey)
  await scope.ctx.plugin(plugin)
  const assembled = assembly({ scope: presetKey })
  assert.equal(assembled.schemas[0].name, 'run_code')
  console.log('preset mount: run_code schema assembled')
  await scope.dispose()
}

console.log('All checks passed')
