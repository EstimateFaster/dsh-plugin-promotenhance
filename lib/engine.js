/**
 * 模型调用与结构化输出。
 *
 * 约定：模型只能通过两个工具回复 —— `ask_questions`（提问）与 `deliver_prompt`（交付）。
 * 每次 `advance()` 只推进一轮；提问之后等用户作答，答案以 tool result 的形式回灌。
 */

const MAX_TOKENS = 3000
const CALL_TIMEOUT_MS = 120_000

const SYSTEM = `你是一个提示词增强器。你不执行任务，只把用户粗糙的需求变成一份可以直接交给另一个智能体执行的完整提示词。

你会收到两条输入：第一条是用户的粗糙提示词，第二条是 JSON 格式的会话摘要（kind 为 session-digest，包含工作目录与最近几轮对话）。摘要可能被截断；缺信息时提问，不要凭空编造。

你有且只有两个动作：
1. ask_questions —— 信息不足时使用。一次提 1 到 3 个问题，每个问题给 2 到 6 个选项，并标出推荐项；只问用户真正需要拍板的事，能自己从摘要里读到的事实不要再问。
2. deliver_prompt —— 信息足够时使用。markdown 必须自包含：目标、背景与现状、要做什么、不要做什么、验收标准、注意事项。

规则：
- 最终结果只能通过工具给出，不要用普通文本当作结论。
- 保留用户的语言；用户用中文就用中文。
- 最多提问两轮；第二轮之后必须交付。
- 用户没提供粗糙提示词时，先用 ask_questions 问他接下来要做什么。
- 不要虚构用户没说的需求；不确定的地方写进 assumptions。`

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

const TOOLS = [ASK_TOOL, DELIVER_TOOL]

const ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

function textOf(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** 校验 ask_questions 的参数。 */
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

/** 校验 deliver_prompt 的参数。 */
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

/** 校验用户提交的答案。 */
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
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    const optionIds = new Set(question.options.map((option) => option.id))
    if (selected.some((id) => !optionIds.has(id))) return { ok: false, message: `选项不存在：${question.id}` }
    if (!question.multiSelect && selected.length > 1) return { ok: false, message: `单选题只能选一个：${question.id}` }
    const custom = typeof answer.custom === 'string' && answer.custom.trim() ? answer.custom.trim() : ''
    if (custom.length > 8192) return { ok: false, message: `自定义回答太长：${question.id}` }
    const skipped = answer.skipped === true
    if (!skipped && selected.length === 0 && !custom) {
      return { ok: false, message: `未回答也未跳过：${question.id}` }
    }
    normalized.push({ questionId: question.id, selected, custom: custom || null, skipped })
  }
  for (const question of pending.questions) {
    if (!seen.has(question.id)) return { ok: false, message: `缺少回答：${question.id}` }
  }
  return { ok: true, value: normalized }
}

/**
 * @param {any} ctx
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} config
 * @param {any} log
 */
export function createEngine(ctx, config, log) {
  let cached = null
  let cachedAt = 0

  async function resolveModel() {
    if (cached && Date.now() - cachedAt < 60_000) return cached
    if (config.provider && config.model) {
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
      } catch (error) {
        log?.warn?.('prompt-enhance: 覆盖模型不可用 — %s', String(error))
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

  async function step(run, model, signal) {
    const options = {
      provider: model.provider,
      model: model.model,
      system: SYSTEM,
      messages: run.messages,
      tools: TOOLS,
      maxTokens: MAX_TOKENS,
      signal,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    }
    const calls = []
    let text = ''
    let finish = null
    for await (const chunk of ctx.llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') calls.push(chunk.block)
      else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    return { calls, text, finish }
  }

  function fail(run, code, message) {
    run.phase = 'failed'
    run.pending = null
    run.error = { code, message }
  }

  /** 追加一次格式纠错，最多重试一次；否则失败。 */
  function retryOrFail(run, reason) {
    if (run.retries >= 1) {
      fail(run, 'INVALID_MODEL_OUTPUT', `模型输出不合法：${reason}`)
      return
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

  /**
   * 推进一轮模型调用（内部最多纠错一次）。
   * 调用方负责先设置 run.phase（collecting / drafting）与 messages。
   */
  async function advance(run) {
    let model
    try {
      model = await resolveModel()
    } catch (error) {
      fail(run, error && error.code === 'NO_MODEL' ? 'NO_MODEL' : 'LLM_FAILED', error instanceof Error ? error.message : String(error))
      return
    }
    const controller = new AbortController()
    run.abort = controller
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      while (true) {
        run.rounds += 1
        const result = await step(run, model, controller.signal)
        if (run.phase === 'cancelled') return

        const finishKind = result.finish && result.finish.kind
        if (finishKind === 'error' || finishKind === 'aborted') {
          const failure = result.finish.failure || {}
          fail(run, 'LLM_FAILED', failure.message || (finishKind === 'aborted' ? '模型调用被中断' : '模型调用失败'))
          return
        }
        if (finishKind === 'max-tokens') {
          fail(run, 'LLM_FAILED', '回复超出长度上限')
          return
        }

        if (result.calls.length === 0) {
          retryOrFail(run, '没有调用任何工具')
        } else if (result.calls.length > 1) {
          appendAssistantCall(run, model, result.calls)
          for (const call of result.calls) {
            appendToolResult(run, call.id, { kind: 'ignored', reason: 'one action per turn' }, true)
          }
          retryOrFail(run, '一轮只能调用一个工具')
        } else {
          const call = result.calls[0]
          let args
          try {
            args = JSON.parse(call.arguments)
          } catch {
            appendAssistantCall(run, model, [call])
            appendToolResult(run, call.id, { kind: 'format-error', message: 'arguments 不是合法 JSON' }, true)
            retryOrFail(run, 'arguments 不是合法 JSON')
            args = null
          }

          if (args !== null && call.name === 'ask_questions') {
            const checked = validateQuestions(args)
            appendAssistantCall(run, model, [call])
            if (!checked.ok) {
              appendToolResult(run, call.id, { kind: 'format-error', message: checked.message }, true)
              retryOrFail(run, checked.message)
            } else {
              run.pending = { batchId: `b${run.rounds}`, callId: call.id, questions: checked.value }
              run.phase = 'questioning'
              run.retries = 0
              return
            }
          } else if (args !== null && call.name === 'deliver_prompt') {
            const checked = validatePrompt(args)
            if (!checked.ok) {
              appendAssistantCall(run, model, [call])
              appendToolResult(run, call.id, { kind: 'format-error', message: checked.message }, true)
              retryOrFail(run, checked.message)
            } else {
              appendAssistantCall(run, model, [call])
              run.prompt = checked.value
              run.phase = 'ready'
              return
            }
          } else if (args !== null) {
            appendAssistantCall(run, model, [call])
            appendToolResult(run, call.id, { kind: 'format-error', message: `未知工具：${call.name}` }, true)
            retryOrFail(run, `未知工具：${call.name}`)
          }
        }

        if (run.phase === 'failed' || run.phase === 'cancelled') return
        // 未失败 → 带着纠错消息再来一轮。
      }
    } catch (error) {
      if (run.phase === 'cancelled') return
      const aborted = controller.signal.aborted
      fail(run, 'LLM_FAILED', aborted ? '模型调用超时' : error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (run.abort === controller) run.abort = null
    }
  }

  return { advance, resolveModel }
}

/** 首条用户消息：粗糙提示词与摘要各占一个 block。 */
export function buildInitialMessages(seed) {
  const rough = typeof seed.rough === 'string' && seed.rough.trim() ? seed.rough.trim() : '（用户这次没有提供粗糙提示词）'
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: rough },
        { type: 'text', text: JSON.stringify(seed.doc) },
      ],
    },
  ]
}
