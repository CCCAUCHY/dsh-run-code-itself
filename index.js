/**
 * Data-Code Separation for DSH PTC: preload the complete call and per-tool
 * templates, and expose the same executor under a neutral tool name.
 * @module
 */
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'run-code-itself'

/** Host services used by the executor and per-agent installation. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'agents']

/** Plugin configuration. Deprecated prompt fields are accepted but ignored. */
export const Config = z.object({
  maxSubCallsPerMinute: z.natural().min(1).description(
    'Nested tool-call attempts per minute of run_code timeout; inherits the replaced PTC executor when omitted.',
  ),
  maxParallelSubCalls: z.natural().min(1).description(
    'Maximum overlapping concurrency-safe run_code subcalls; inherits the replaced PTC executor when omitted.',
  ),
  promptMode: z.string().default('system').description('Deprecated and ignored; the guide always lives in the system prompt.'),
  sdkStyle: z.string().default('rules').description('Deprecated and ignored; no PTC SDK declarations are rendered.'),
})

/** Model-facing tool name. Deliberately not run_code. */
export const PROGRAM_TOOL = 'run_code'
/** Program-visible preset variables. */
export const PROGRAM_ITSELF = 'run_code_itself'
export const PROGRAM_SUBTOOLS = 'run_code_subtools'
/** Tools whose compact signatures stay in the system guide. */
const COMMON_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep'])

/** Tool description: deliberately short; the rules live in the system prompt. */
const TOOL_DESCRIPTION = 'Run one program against the available tools. code is the body of an async TypeScript function; top-level await and return work, and erasable syntax only is allowed. Put data and every subtool argument in sibling fields of this call; the complete arguments are run_code_itself and the per-tool metadata is run_code_subtools. Never write tools.x({...}) inside code. Follow the Data-Code Separation rules in the system prompt. Only printed or returned output is model-visible; image results attach after the run; nested tools keep their own policies.'

/** True for a non-null non-array object. */
function isObjectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON text safe to embed as a JavaScript expression. */
function jsonLiteral(value) {
  const json = JSON.stringify(value)
  const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return safe.includes('"__proto__"') ? 'JSON.parse(' + JSON.stringify(safe) + ')' : safe
}

/** Declare one run_code-visible variable with a JSON literal. */
export function declarationFor(name, payload) {
  return 'const ' + name + ' = ' + jsonLiteral(payload) + ';'
}

/** Simple empty placeholder for a required JSON Schema property. */
function emptyValue(property) {
  if (Object.prototype.hasOwnProperty.call(property, 'const')) return property.const
  switch (property.type) {
    case 'string': return ''
    case 'number': return 0
    case 'integer': return 0
    case 'boolean': return false
    case 'array': return []
    case 'object': return {}
    default: return null
  }
}

/** Build one { description, template } entry per visible tool. */
export function buildSubtools(definitions) {
  const subtools = Object.create(null)
  for (const definition of definitions) {
    const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
    const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
    const required = Array.isArray(parameters.required) ? parameters.required : []
    const template = Object.create(null)
    for (const key of required) {
      const property = properties[key]
      template[key] = isObjectRecord(property) ? emptyValue(property) : ''
    }
    for (const [key, property] of Object.entries(properties)) {
      if (!isObjectRecord(property) || required.includes(key)) continue
      if (Object.prototype.hasOwnProperty.call(property, 'default')) template[key] = property.default
    }
    subtools[definition.name] = {
      description: definition.description === undefined ? '' : String(definition.description),
      template,
      signature: signatureFor(definition),
    }
  }
  return subtools
}

/** First sentence of a tool description. */
function firstSentence(text) {
  const value = typeof text === 'string' ? text : ''
  const index = value.indexOf('. ')
  return index === -1 ? value : value.slice(0, index + 1)
}

/** Collapse one-line JSDoc text. */
function docText(text) {
  return (typeof text === 'string' ? text : '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()
}

/** Compact argument and return names for one tool. */
function signatureFor(definition) {
  const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
  const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  const args = Object.keys(properties).map(key => required.has(key) ? key : key + '?').join(', ')
  const output = definition.output !== undefined && isObjectRecord(definition.output.schema) ? definition.output.schema : {}
  const outputProperties = isObjectRecord(output.properties) ? Object.keys(output.properties) : []
  return definition.name + '(' + args + ') -> ' + (outputProperties.length > 0 ? '{' + outputProperties.join(', ') + '}' : 'JsonValue')
}

/** The complete system-prompt guide. Deliberately longer than the tool description. */
export function renderProgramGuide(tools) {
  const common = tools.filter(tool => COMMON_TOOLS.has(tool.name))
  const other = tools.filter(tool => !COMMON_TOOLS.has(tool.name))
  const hiddenLabel = other.length === 1 ? '1 other tool' : other.length + ' other tools'
  const lines = [
    '## Data-Code Separation',
    '',
    'This tool runs one program. code is logic only. Data is supplied in sibling fields of the call and read inside the program from run_code_itself.',
    '',
    '1. **Never put literal data or escaping in code.** Put data in a sibling field and pass run_code_itself.<field>, or fill run_code_subtools.<tool>.template. Never write tools.x({...}).',
    '2. **Keep escaping out of code.** Any value that would need quotes, backslashes, newlines, JSON.stringify, or JSON.parse belongs in a sibling field.',
    '3. **Decide by actual escaping cost, not by type or size.** Simple control flow, loop bounds, flags, and short literals may stay in code.',
    '',
    '## Program variables',
    '',
    'run_code_itself: the complete arguments of this call, including every sibling field.',
    'run_code_subtools: one entry per tool, shaped as { description, template, signature }.',
    'The template is a structural skeleton. Complex enum, union, or nested values must be filled in code and checked against the tool schema.',
    '',
    '## How to call a tool',
    '',
    'Sibling field:',
    '{"code":"return await tools.bash(run_code_itself.bash)","description":"List files","bash":{"description":"List files","command":"ls -la"}}',
    '',
    'Template (sibling fields are arbitrary; this example uses label and command):',
    '{"code":"const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)","description":"List files","label":"List files","command":"ls -la"}',
    '',
    'Never write tools.bash({...}) or tools.x({...}) inside code.',
    '',
    '## Common tools',
    '',
    'These are the commonly used tools. Other tools are not listed here.',
    '',
  ]
  for (const tool of common) {
    lines.push('- ' + signatureFor(tool) + ': ' + docText(tool.description))
  }
  lines.push(
    '',
    '## Hidden tools',
    '',
    'All other tools are available in run_code_subtools. There are ' + hiddenLabel + '; do not print the whole list, inspect a named entry when needed.',
  )
  return lines.join('\n')
}

/** The run_code transport with the run_code alias and injected variables. */
export class RunCodeItselfExecutor extends PtcExecutor {
  #transport

  constructor(ctx, config) {
    const { maxSubCallsPerMinute, maxParallelSubCalls } = config ?? {}
    super(ctx, {
      ...(maxSubCallsPerMinute === undefined ? {} : { maxSubCallsPerMinute }),
      ...(maxParallelSubCalls === undefined ? {} : { maxParallelSubCalls }),
    })
    this.sections = [{
      name: 'tools:run_code',
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      interpolate: false,
      text: tools => renderProgramGuide(tools),
    }]
  }

  /** Wrap the reserved transport once. */
  requirePtcTransport() {
    const original = super.requirePtcTransport()
    if (this.#transport !== undefined && this.#transport.original === original) return this.#transport.proxy
    const proxy = new Proxy(original, {
      get: (target, property, receiver) => property === 'execute'
        ? (args, exec) => this.#execute(target, args, exec)
        : Reflect.get(target, property, receiver),
    })
    this.#transport = { original, proxy }
    return proxy
  }

  /** Rename the direct schema and replace the stock PTC description. */
  describe(tools) {
    const described = super.describe(tools)
    return {
      ...described,
      knownNames: [PROGRAM_TOOL],
      schemas: described.schemas.map(schema => {
        if (schema.name !== RUN_CODE_NAME || !isObjectRecord(schema.parameters)) return schema
        const parameters = schema.parameters
        const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
        const code = isObjectRecord(properties.code) ? properties.code : undefined
        const description = isObjectRecord(properties.description) ? properties.description : undefined
        return {
          ...schema,
          name: PROGRAM_TOOL,
          description: TOOL_DESCRIPTION,
          parameters: {
            ...parameters,
            additionalProperties: true,
            properties: {
              ...properties,
              ...code === undefined ? {} : {
                code: {
                  ...code,
                  description: 'Program logic only. Data and subtool arguments are parsed values on run_code_itself; run_code_itself.code is this exact source text.',
                },
              },
              ...description === undefined ? {} : {
                description: {
                  ...description,
                  description: 'Short active-voice summary of what this run_code does, 5-10 words (shown in the UI).',
                },
              },
            },
          },
        }
      }),
    }
  }

  /** Inject the complete call and all templates before user code. */
  async #execute(transport, args, exec) {
    if (!isObjectRecord(args) || typeof args.code !== 'string') return transport.execute(args, exec)
    const runtime = this.ctx.get('ptcRuntime')
    if (runtime !== undefined && runtime.language !== 'typescript') {
      throw new Error('dsh-run-code-itself supports TypeScript PTC only; Python PTC is not supported.')
    }
    const subtools = buildSubtools(this.ctx.tools.definitions(exec.agent, exec.toolSet))
    const prelude = [
      declarationFor(PROGRAM_SUBTOOLS, subtools),
      declarationFor(PROGRAM_ITSELF, args),
    ].join('\n')
    return transport.execute({ ...args, code: prelude + '\n' + args.code }, exec)
  }
}

/** Cross-generation brand so a reloaded plugin never stacks a second executor. */
const ENHANCED = Symbol.for('dsh-run-code-itself/enhanced')
Object.defineProperty(RunCodeItselfExecutor.prototype, ENHANCED, { value: true })

/** Whether a selected executor is a PTC executor this plugin can extend. */
function isPtcExecutor(executor) {
  return executor instanceof PtcExecutor
    || (typeof executor?.requirePtcTransport === 'function' && typeof executor?.describe === 'function')
}

/** Merge plugin limits with the limits of the executor being replaced. */
function executorConfig(settings, inherited) {
  const config = {}
  const maxSubCalls = settings.maxSubCallsPerMinute ?? inherited.maxSubCallsPerMinute
  const maxParallel = settings.maxParallelSubCalls ?? inherited.maxParallelSubCalls
  if (maxSubCalls !== undefined) config.maxSubCallsPerMinute = maxSubCalls
  if (maxParallel !== undefined) config.maxParallelSubCalls = maxParallel
  return config
}

/** Select the enhanced executor for the mounting scope. */
export function apply(ctx, config) {
  const settings = config ?? {}
  ctx.logger.info('run-code-itself: active')
  const select = ctx.tools.selectExecutor
  if (typeof select !== 'function' || typeof PtcExecutor.prototype.requirePtcTransport !== 'function') {
    ctx.logger.warn('run-code-itself: this DSH version changed its executor internals; the plugin stays inactive')
    return
  }
  if (scopeOf(ctx) !== undefined) {
    ctx.tools.setExecutor(new RunCodeItselfExecutor(ctx, executorConfig(settings, {})))
    ctx.logger.info('run-code-itself: registered as this preset tool executor')
    return
  }
  const installed = new WeakSet()

  const install = (agent) => {
    if (installed.has(agent)) return
    let selected
    try {
      selected = ctx.tools.selectExecutor(agent)
    } catch {
      return
    }
    if (!isPtcExecutor(selected) || selected[ENHANCED] === true) return
    try {
      const executor = new RunCodeItselfExecutor(agent.ctx, executorConfig(settings, selected.config ?? {}))
      const dispose = agent.ctx.tools.setExecutor(executor)
      installed.add(agent)
      ctx.effect(() => () => {
        installed.delete(agent)
        dispose()
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('run-code-itself: cannot install on agent "' + agent.id + '": ' + detail)
    }
  }

  ctx.on('agent/created', ({ agent }) => { install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
}
