/**
 * Model calls and structured output.
 *
 * The model may reply only through tools: `ask_questions`, `deliver_prompt`,
 * and (when the host exposes a filesystem) the read-only `read_file`,
 * `list_dir`, `grep` tools. Each `advance()` call makes one or more model
 * requests until it needs user input, delivers a prompt, fails, or exhausts a
 * configured budget.
 */

import { isTerminal } from './runs.js'
import { hasModelOverride } from './config.js'

const SYSTEM = `你是一个提示词增强器。你不执行任务，只把用户粗糙的需求变成一份可以直接交给另一个智能体执行的完整提示词。

你会收到两条输入：第一条是用户的粗糙提示词，第二条是 JSON 格式的会话摘要（kind 为 session-digest，包含工作目录与最近几轮对话）。摘要可能被截断；缺信息时提问，不要凭空编造。

你有两个控制类动作：
1. ask_questions —— 信息不足时使用。一次提 1 到 3 个问题，每个问题给 2 到 6 个选项，并标出推荐项；只问用户真正需要拍板的事，能自己从摘要里读到的事实不要再问。
2. deliver_prompt —— 信息足够时使用。markdown 必须自包含：目标、背景与现状、要做什么、不要做什么、验收标准、注意事项。

规则：
- 最终结果只能通过工具给出，不要用普通文本当作结论。
- 保留用户的语言；用户用中文就用中文。
- 最多提问两轮；第二轮之后必须交付。
- 用户没提供粗糙提示词时，先用 ask_questions 问他接下来要做什么。
- 不要虚构用户没说的需求；不确定的地方写进 assumptions。
- 一轮只能调用一个控制类工具；需要查看仓库时，可以一次发起多个只读工具调用。`

const FILE_SYSTEM = `
你可以使用只读工具检查目标会话的工作目录：read_file、list_dir、grep。它们只能读取工作目录内部的普通文本文件，密钥与环境文件会被拒绝。需要确认现有代码结构、命名或测试框架时先查再写，不要猜测。`

const ASK_TOOL = {
  name: 'ask_questions',
  description: '向用户提出 1-3 个澄清问题，每题 2-6 个选项并标出推荐项。用户作答后你会继续。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'question', 'options'],
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,16}$' },
            header: { type: 'string', maxLength: 12 },
            question: { type: 'string', minLength: 1, maxLength: 200 },
            multiSelect: { type: 'boolean' },
            allowCustom: { type: 'boolean' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 6,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'label'],
                properties: {
                  id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,16}$' },
                  label: { type: 'string', maxLength: 60 },
                  detail: { type: 'string', maxLength: 200 },
                  recommended: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  },
}

const DELIVER_TOOL = {
  name: 'deliver_prompt',
  description: '交付最终提示词。markdown 会被直接插入用户的输入框。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'markdown'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 80 },
      markdown: { type: 'string', minLength: 1, maxLength: 60000 },
      assumptions: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
    },
  },
}

const CONTROL_TOOLS = [ASK_TOOL, DELIVER_TOOL]
const ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/
const FILE_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grep'])

function textOf(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/** Validate an `ask_questions` argument object. */
export function validateQuestions(args) {
  const list = args && args.questions
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) {
    return { ok: false, message: 'questions 必须是 1-3 项的数组' }
  }
  const seen = new Set()
  const questions = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return { ok: false, message: '每个 question 必须是对象' }
    if (!textOf(raw.id, 16) || !ID_PATTERN.test(raw.id)) return { ok: false, message: `question.id 不合法：${String(raw.id)}` }
    if (seen.has(raw.id)) return { ok: false, message: `question.id 重复：${raw.id}` }
    seen.add(raw.id)
    if (!textOf(raw.question, 200)) return { ok: false, message: `question.question 必须是 1-200 字符：${raw.id}` }
    if (raw.header !== undefined && (typeof raw.header !== 'string' || raw.header.length > 12)) {
      return { ok: false, message: `question.header 最多 12 字符：${raw.id}` }
    }
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 6) {
      return { ok: false, message: `question.options 必须是 2-6 项：${raw.id}` }
    }
    const optionIds = new Set()
    const options = []
    for (const option of raw.options) {
      if (!option || typeof option !== 'object') return { ok: false, message: `option 必须是对象：${raw.id}` }
      if (!textOf(option.id, 16) || !ID_PATTERN.test(option.id)) return { ok: false, message: `option.id 不合法：${raw.id}` }
      if (optionIds.has(option.id)) return { ok: false, message: `option.id 重复：${raw.id}` }
      optionIds.add(option.id)
      if (!textOf(option.label, 60)) return { ok: false, message: `option.label 必须是 1-60 字符：${raw.id}` }
      if (option.detail !== undefined && (typeof option.detail !== 'string' || option.detail.length > 200)) {
        return { ok: false, message: `option.detail 最多 200 字符：${raw.id}` }
      }
      options.push({
        id: option.id,
        label: option.label,
        ...(option.detail === undefined ? {} : { detail: option.detail }),
        ...(option.recommended === true ? { recommended: true } : {}),
      })
    }
    questions.push({
      id: raw.id,
      ...(raw.header === undefined ? {} : { header: raw.header }),
      question: raw.question,
      multiSelect: raw.multiSelect === true,
      allowCustom: raw.allowCustom !== false,
      options,
    })
  }
  return { ok: true, value: questions }
}

/** Validate a `deliver_prompt` argument object. */
export function validatePrompt(args) {
  if (!args || typeof args !== 'object') return { ok: false, message: '参数必须是对象' }
  if (!textOf(args.title, 80)) return { ok: false, message: 'title 必须是 1-80 字符' }
  if (!textOf(args.markdown, 60000)) return { ok: false, message: 'markdown 必须是 1-60000 字符' }
  const assumptions = Array.isArray(args.assumptions) ? args.assumptions : []
  if (assumptions.length > 6) return { ok: false, message: 'assumptions 最多 6 条' }
  if (assumptions.some((item) => typeof item !== 'string' || item.length > 300)) {
    return { ok: false, message: 'assumptions 每条必须是 ≤300 字符的字符串' }
  }
  return {
    ok: true,
    value: { title: args.title, markdown: args.markdown, assumptions: assumptions.slice(0, 6) },
  }
}

/** Validate answers submitted by the panel and normalize them for the model. */
export function validateAnswers(pending, answers) {
  if (!Array.isArray(answers)) return { ok: false, message: 'answers 必须是数组' }
  const byId = new Map(pending.questions.map((question) => [question.id, question]))
  const seen = new Set()
  const normalized = []
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') return { ok: false, message: 'answer 必须是对象' }
    const question = byId.get(answer.questionId)
    if (!question) return { ok: false, message: `未知的 questionId：${String(answer.questionId)}` }
    if (seen.has(question.id)) return { ok: false, message: `重复回答：${question.id}` }
    seen.add(question.id)
    if (answer.selected !== undefined && !Array.isArray(answer.selected)) {
      return { ok: false, message: `selected 必须是数组：${question.id}` }
    }
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    const optionIds = new Set(question.options.map((option) => option.id))
    if (selected.some((id) => !optionIds.has(id))) return { ok: false, message: `选项不存在：${question.id}` }
    if (!question.multiSelect && selected.length > 1) return { ok: false, message: `单选题只能选一个：${question.id}` }
    const custom = typeof answer.custom === 'string' && answer.custom.trim() ? answer.custom.trim() : ''
    if (custom.length > 8192) return { ok: false, message: `自定义回答太长：${question.id}` }
    if (custom && question.allowCustom === false) return { ok: false, message: `该题不允许自定义回答：${question.id}` }
    const skipped = answer.skipped === true
    if (!skipped && selected.length === 0 && !custom) {
      return { ok: false, message: `未回答也未跳过：${question.id}` }
    }
    normalized.push({
      questionId: question.id,
      selected: skipped ? [] : selected,
      custom: skipped ? null : custom || null,
      skipped,
    })
  }
  for (const question of pending.questions) {
    if (!seen.has(question.id)) return { ok: false, message: `缺少回答：${question.id}` }
  }
  return { ok: true, value: normalized }
}

/** First user message: rough prompt and digest each occupy a separate block. */
export function buildInitialMessages(seed) {
  const rough = typeof seed.rough === 'string' && seed.rough.trim() ? seed.rough.trim() : '（用户这次没有提供粗糙提示词）'
  const doc = seed.doc && typeof seed.doc === 'object'
    ? seed.doc
    : { kind: 'session-digest', version: 1, cwd: seed.cwd || '', turns: [], truncated: false, omittedTurns: 0 }
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: rough },
        { type: 'text', text: JSON.stringify(doc) },
      ],
    },
  ]
}

function disabledTools() {
  return {
    enabled: false,
    schemas: [],
    async execute() {
      return { ok: false, code: 'TOOLS_UNAVAILABLE', message: '当前部署没有可用的文件服务' }
    },
  }
}

/**
 * @param {any} ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {any} log
 * @param {{ store?: any, fileTools?: any }} [options]
 */
export function createEngine(ctx, config, log, options = {}) {
  const store = options.store
  let fileTools = options.fileTools && options.fileTools.enabled ? options.fileTools : disabledTools()
  let cached = null
  let cachedAt = 0

  function setFileTools(tools) {
    fileTools = tools && tools.enabled ? tools : disabledTools()
  }

  function hasFileTools() {
    return config.fileTools !== false && fileTools.enabled && fileTools.schemas.length > 0
  }

  function toolList() {
    return hasFileTools() ? [...CONTROL_TOOLS, ...fileTools.schemas] : CONTROL_TOOLS
  }

  function systemPrompt() {
    const rounds =
      config.maxQuestionRounds === 0
        ? '不要提问；信息不足时把假设写进 assumptions 并直接交付。'
        : `最多提问 ${config.maxQuestionRounds} 轮；达到上限后必须交付。`
    const base = SYSTEM.replace('最多提问两轮；第二轮之后必须交付。', rounds)
    return hasFileTools() ? `${base}${FILE_SYSTEM}` : base
  }

  async function resolveModel() {
    if (cached && Date.now() - cachedAt < 60_000) return cached
    if (hasModelOverride(config)) {
      try {
        const models = await ctx.llm.listModels(config.provider)
        const hit = models.find((item) => item.id === config.model)
        if (hit) {
          cached = {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          }
          cachedAt = Date.now()
          return cached
        }
        log?.warn?.('prompt-enhance: configured model %s/%s is not in the provider catalog; falling back', config.provider, config.model)
      } catch (error) {
        log?.warn?.('prompt-enhance: model override unavailable — %s', String(error))
      }
    }
    const catalog = await ctx.sessionController.modelCatalog()
    const fallback = catalog && catalog.default
    if (!fallback || !fallback.provider || !fallback.model) {
      const error = new Error('没有可用的默认模型')
      error.code = 'NO_MODEL'
      throw error
    }
    cached = {
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
    }
    cachedAt = Date.now()
    return cached
  }

  function messageId(run) {
    return `pe-${run.runId}-${run.messages.length}`
  }

  function appendToolResult(run, callId, payload, isError) {
    run.messages.push({
      role: 'tool',
      id: messageId(run),
      toolCallId: callId,
      isError,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    })
  }

  function appendAssistantCall(run, model, calls) {
    run.messages.push({
      role: 'assistant',
      id: messageId(run),
      source: { kind: 'model', provider: model.provider, model: model.model },
      content: calls.map((call) => ({
        type: 'tool-call',
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    })
  }

  function fail(run, code, message) {
    if (isTerminal(run.phase)) return
    if (store && typeof store.fail === 'function') store.fail(run, code, message)
    else {
      run.phase = 'failed'
      run.pending = null
      run.error = { code, message }
    }
    log?.warn?.('prompt-enhance: run %s failed (%s): %s', run.runId, code, message)
  }

  function setPhase(run, phase) {
    if (store && typeof store.setPhase === 'function') store.setPhase(run, phase)
    else run.phase = phase
  }

  /** Append a correction; returns false when the run has exhausted its retry. */
  function retryOrFail(run, reason) {
    if (run.retries >= 1) {
      fail(run, 'INVALID_MODEL_OUTPUT', `模型输出不合法：${reason}`)
      return false
    }
    run.retries += 1
    run.messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify({ kind: 'format-error', message: `上一次回复不符合要求：${reason}。请重新调用工具。` }),
        },
      ],
    })
    return true
  }

  async function step(run, model, signal) {
    const options = {
      provider: model.provider,
      model: model.model,
      system: systemPrompt(),
      messages: run.messages,
      tools: toolList(),
      maxTokens: run.maxTokensBoosted ? Math.min(config.maxTokens * 2, 32_000) : config.maxTokens,
      signal,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    }
    const calls = []
    let text = ''
    let finish = null
    let usage = null
    for await (const chunk of ctx.llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') calls.push(chunk.block)
      else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
      else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
    }
    return { calls, text, finish, usage }
  }

  function mergeUsage(run, usage) {
    if (!usage || typeof usage !== 'object') return
    const previous = run.usage || { inputTokens: 0, outputTokens: 0 }
    run.usage = {
      inputTokens: previous.inputTokens + (Number(usage.inputTokens) || 0),
      outputTokens: previous.outputTokens + (Number(usage.outputTokens) || 0),
    }
  }

  async function runFileCall(run, call, controller) {
    if (run.toolCalls >= config.maxToolCalls) {
      return { ok: false, code: 'TOOL_BUDGET_EXCEEDED', message: `只读工具调用达到上限（${config.maxToolCalls} 次），请直接交付` }
    }
    run.toolCalls += 1
    let args
    try {
      args = JSON.parse(call.arguments)
    } catch {
      return { ok: false, code: 'INVALID_ARGS', message: 'arguments 不是合法 JSON' }
    }
    try {
      return await fileTools.execute(call.name, args, {
        cwd: run.seed?.cwd || '',
        signal: controller.signal,
      })
    } catch (error) {
      log?.warn?.('prompt-enhance: tool %s failed — %s', call.name, String(error))
      return { ok: false, code: 'TOOL_FAILED', message: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Advance a run. The caller owns the phase transition that led here
   * (`collecting` after `/start`, `drafting` after an answer).
   */
  async function advance(run) {
    if (isTerminal(run.phase)) return
    const controller = new AbortController()
    run.abort = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)
    try {
      let model
      try {
        model = await resolveModel()
      } catch (error) {
        fail(run, error && error.code === 'NO_MODEL' ? 'NO_MODEL' : 'LLM_FAILED', error instanceof Error ? error.message : String(error))
        return
      }
      if (timedOut) {
        fail(run, 'TIMEOUT', `模型调用超过 ${Math.round(config.timeoutMs / 1000)} 秒`)
        return
      }
      if (controller.signal.aborted || isTerminal(run.phase)) return

      while (true) {
        if (isTerminal(run.phase)) return
        if (run.modelCalls >= config.maxModelCalls) {
          fail(run, 'BUDGET_EXCEEDED', `模型调用达到上限（${config.maxModelCalls} 次）`)
          return
        }
        run.rounds += 1
        run.modelCalls += 1
        const result = await step(run, model, controller.signal)
        mergeUsage(run, result.usage)
        if (isTerminal(run.phase)) return

        const finishKind = result.finish && result.finish.kind
        if (finishKind === 'error' || finishKind === 'aborted') {
          const failure = (result.finish && result.finish.failure) || {}
          if (timedOut) fail(run, 'TIMEOUT', `模型调用超过 ${Math.round(config.timeoutMs / 1000)} 秒`)
          else fail(run, 'LLM_FAILED', failure.message || (finishKind === 'aborted' ? '模型调用被中断' : '模型调用失败'))
          return
        }
        if (finishKind === 'max-tokens') {
          if (!run.maxTokensBoosted) {
            run.maxTokensBoosted = true
            run.messages.push({
              role: 'user',
              content: [{ type: 'text', text: '上一次输出超过 token 上限。请精简内容，并直接调用 deliver_prompt 交付。' }],
            })
            continue
          }
          fail(run, 'LLM_FAILED', '回复超出长度上限')
          return
        }

        if (result.calls.length === 0) {
          if (!retryOrFail(run, '没有调用任何工具')) return
          continue
        }

        if (result.calls.length > 1) {
          const allFileCalls = hasFileTools() && result.calls.every((call) => FILE_TOOL_NAMES.has(call.name))
          if (allFileCalls) {
            appendAssistantCall(run, model, result.calls)
            for (const call of result.calls) {
              const payload = await runFileCall(run, call, controller)
              appendToolResult(run, call.id, payload, payload.ok !== true)
            }
            continue
          }
          appendAssistantCall(run, model, result.calls)
          for (const call of result.calls) {
            appendToolResult(run, call.id, { kind: 'ignored', reason: 'one action per turn' }, true)
          }
          if (!retryOrFail(run, '一轮只能调用一个控制类工具')) return
          continue
        }

        const call = result.calls[0]
        let args = null
        let parseError = null
        try {
          args = JSON.parse(call.arguments)
        } catch {
          parseError = 'arguments 不是合法 JSON'
        }

        if (parseError) {
          appendAssistantCall(run, model, [call])
          appendToolResult(run, call.id, { kind: 'format-error', message: parseError }, true)
          if (!retryOrFail(run, parseError)) return
          continue
        }

        if (call.name === 'ask_questions') {
          const checked = validateQuestions(args)
          appendAssistantCall(run, model, [call])
          if (!checked.ok) {
            appendToolResult(run, call.id, { kind: 'format-error', message: checked.message }, true)
            if (!retryOrFail(run, checked.message)) return
            continue
          }
          if (config.maxQuestionRounds === 0 || run.questionRounds >= config.maxQuestionRounds) {
            appendToolResult(
              run,
              call.id,
              { kind: 'format-error', message: `提问轮数已达上限（${config.maxQuestionRounds} 轮）。请立即调用 deliver_prompt 交付。` },
              true,
            )
            continue
          }
          run.questionRounds += 1
          run.pending = { batchId: `b${run.rounds}`, callId: call.id, questions: checked.value }
          run.retries = 0
          setPhase(run, 'questioning')
          log?.info?.('prompt-enhance: run %s is waiting for answers (%d questions)', run.runId, checked.value.length)
          return
        }

        if (call.name === 'deliver_prompt') {
          const checked = validatePrompt(args)
          appendAssistantCall(run, model, [call])
          if (!checked.ok) {
            appendToolResult(run, call.id, { kind: 'format-error', message: checked.message }, true)
            if (!retryOrFail(run, checked.message)) return
            continue
          }
          run.prompt = checked.value
          run.retries = 0
          setPhase(run, 'ready')
          log?.info?.('prompt-enhance: run %s delivered a prompt (%d chars)', run.runId, checked.value.markdown.length)
          return
        }

        if (hasFileTools() && FILE_TOOL_NAMES.has(call.name)) {
          appendAssistantCall(run, model, [call])
          const payload = await runFileCall(run, call, controller)
          appendToolResult(run, call.id, payload, payload.ok !== true)
          continue
        }

        appendAssistantCall(run, model, [call])
        appendToolResult(run, call.id, { kind: 'format-error', message: `未知工具：${call.name}` }, true)
        if (!retryOrFail(run, `未知工具：${call.name}`)) return
      }
    } catch (error) {
      if (isTerminal(run.phase)) return
      if (timedOut) fail(run, 'TIMEOUT', `模型调用超过 ${Math.round(config.timeoutMs / 1000)} 秒`)
      else fail(run, 'LLM_FAILED', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (run.abort === controller) run.abort = null
    }
  }

  return {
    advance,
    resolveModel,
    setFileTools,
    hasFileTools,
    systemPrompt,
    toolList,
  }
}

export const __test = { SYSTEM, FILE_SYSTEM, ASK_TOOL, DELIVER_TOOL, CONTROL_TOOLS, FILE_TOOL_NAMES }
