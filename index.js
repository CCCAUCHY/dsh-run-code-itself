/**
 * Data-Code Separation for DSH PTC: preload the complete call and every
 * tool's input schema, without passing subtool arguments as JSON strings.
 * @module
 */
import { readFileSync } from 'node:fs'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'run-code-itself'

/** Host services used by the executor and per-agent installation. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'agents']

/** Default tools shown in the common section. */
export const DEFAULT_COMMON_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image']

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
  commonTools: z.array(z.string()).default(DEFAULT_COMMON_TOOLS).description(
    'Tool names listed with compact signatures in the prompt. Every other visible tool appears by name.',
  ),
})

/** Model-facing tool name. Deliberately not run_code. */
export const PROGRAM_TOOL = 'run_code'
/** Program-visible preset variables. */
export const PROGRAM_ITSELF = 'run_code_itself'
export const PROGRAM_SUBTOOLS = 'run_code_subtools'
/** Fixed prompt data lives beside the code, not inside it. */
const TOOL_DESCRIPTION = readFileSync(new URL('./prompts/tool-description.txt', import.meta.url), 'utf8').trim()
const GUIDE_TEMPLATE = readFileSync(new URL('./prompts/guide.md', import.meta.url), 'utf8').trim()

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

/** Build one complete entry per visible tool: DSH original fields plus output schema. */
export function buildSubtools(definitions) {
  const subtools = Object.create(null)
  for (const definition of definitions) {
    const entry = {
      description: definition.description === undefined ? '' : String(definition.description),
      parameters: isObjectRecord(definition.parameters) ? definition.parameters : { type: 'object', properties: {} },
    }
    if (definition.output !== undefined && isObjectRecord(definition.output.schema)) entry.output = definition.output.schema
    subtools[definition.name] = entry
  }
  return subtools
}

/** Quote a non-identifier key for display/TypeScript access. */
function renderKey(value) {
  const key = String(value)
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

/** Compact argument and return hint for non-common tools. */
function signatureFor(definition) {
  const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
  const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  const args = Object.keys(properties).map(key => renderKey(key) + (required.has(key) ? '' : '?')).join(', ')
  const output = definition.output !== undefined && isObjectRecord(definition.output.schema) ? definition.output.schema : {}
  const outputProperties = isObjectRecord(output.properties) ? Object.keys(output.properties) : []
  return renderKey(definition.name) + '(' + args + ') -> ' + (outputProperties.length > 0 ? '{' + outputProperties.map(renderKey).join(', ') + '}' : 'JsonValue')
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

/** Common tools in the prompt: compact signature and short description. */
function renderCommonTools(tools) {
  return tools.map(tool => '- ' + signatureFor(tool) + ': ' + firstSentence(docText(tool.description))).join('\n')
}

/** Other tools in the prompt: names only. */
function renderOtherTools(tools) {
  return tools.map(tool => '- ' + tool.name).join('\n')
}

/** Compact rewritten PTC section: rules, common signatures, other names. */
export function renderProgramGuide(tools, commonTools = DEFAULT_COMMON_TOOLS) {
  const commonSet = new Set(Array.isArray(commonTools) ? commonTools : DEFAULT_COMMON_TOOLS)
  const common = tools.filter(tool => commonSet.has(tool.name))
  const other = tools.filter(tool => !commonSet.has(tool.name))
  const values = {
    COMMON_TOOLS: renderCommonTools(common),
    OTHER_TOOLS: renderOtherTools(other),
  }
  return GUIDE_TEMPLATE.replace(/\{\{(COMMON_TOOLS|OTHER_TOOLS)\}\}/g, (_, key) => values[key])
}

/** The run_code transport with the run_code alias and injected variables. */
export class RunCodeItselfExecutor extends PtcExecutor {
  #transport

  constructor(ctx, config) {
    const { maxSubCallsPerMinute, maxParallelSubCalls, commonTools } = config ?? {}
    super(ctx, {
      ...(maxSubCallsPerMinute === undefined ? {} : { maxSubCallsPerMinute }),
      ...(maxParallelSubCalls === undefined ? {} : { maxParallelSubCalls }),
    })
    this.commonTools = Array.isArray(commonTools) ? commonTools : DEFAULT_COMMON_TOOLS
    this.sections = [{
      name: 'tools:sdk',
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      text: tools => renderProgramGuide(tools, this.commonTools),
      interpolate: false,
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
                  description: 'Program text: the body of an async TypeScript function. Data and nested tool arguments live in sibling fields on run_code_itself; run_code_itself.code is this exact source text.',
                },
              },
              ...description === undefined ? {} : {
                description: {
                  ...description,
                  description: 'Short active-voice summary of what this run_code does (shown in the UI).',
                },
              },
            },
          },
        }
      }),
    }
  }

  /** Inject the complete call and every tool schema before user code. */
  async #execute(transport, args, exec) {
    if (!isObjectRecord(args) || typeof args.code !== 'string') return transport.execute(args, exec)
    const subtools = buildSubtools(this.ctx.tools.definitions(exec.agent, exec.toolSet))
    const prelude = [
      declarationFor(PROGRAM_SUBTOOLS, subtools),
      declarationFor(PROGRAM_ITSELF, args),
    ].join('\n')
    const program = prelude + '\n' + args.code
    const format = this.ctx.get('ptcRuntime')?.programFormat ?? 'function-body'
    const code = format === 'function-body'
      ? 'return await (async () => {\n' + program + '\n})()'
      : 'await (async () => {\n' + program + '\n})()'
    return transport.execute({ ...args, code }, exec)
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
  const commonTools = settings.commonTools ?? inherited.commonTools
  if (maxSubCalls !== undefined) config.maxSubCallsPerMinute = maxSubCalls
  if (maxParallel !== undefined) config.maxParallelSubCalls = maxParallel
  if (Array.isArray(commonTools)) config.commonTools = commonTools
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
