import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../lib/config.js'
import {
  buildInitialMessages,
  createEngine,
  validateAnswers,
  validateQuestions,
} from '../lib/engine.js'
import { createRunStore } from '../lib/runs.js'

const seed = {
  rough: '做一个记账工具',
  digest: { turns: [], truncated: false, omittedTurns: 0 },
  doc: { kind: 'session-digest', version: 1, cwd: '/tmp/demo', turns: [], truncated: false, omittedTurns: 0 },
  cwd: '/tmp/demo',
}

const deliverCall = (id = 'c1', args = { title: '记账工具', markdown: '## 目标\n做一个记账工具', assumptions: ['本地单用户'] }) => ({
  type: 'block-end',
  block: { type: 'tool-call', id, name: 'deliver_prompt', arguments: JSON.stringify(args) },
})

const askCall = (id = 'c1', args = {
  questions: [
    {
      id: 'q1',
      question: '形态？',
      options: [
        { id: 'o1', label: 'CLI', recommended: true },
        { id: 'o2', label: '网页' },
      ],
    },
  ],
}) => ({
  type: 'block-end',
  block: { type: 'tool-call', id, name: 'ask_questions', arguments: JSON.stringify(args) },
})

const toolCall = (id, name, args) => ({
  type: 'block-end',
  block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
})

const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const usage = (inputTokens = 10, outputTokens = 20) => ({ type: 'usage', usage: { inputTokens, outputTokens } })

function makeCtx(scripts, options = {}) {
  const calls = []
  let index = 0
  const ctx = {
    llm: {
      async listModels() {
        return options.models || [{ id: 'deepseek-flash' }]
      },
      stream(request) {
        calls.push(request)
        const chunks = scripts[index] || [finish()]
        index += 1
        return (async function* () {
          if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
          for (const chunk of chunks) {
            if (request.signal && request.signal.aborted) {
              const error = new Error('aborted')
              error.name = 'AbortError'
              throw error
            }
            yield chunk
          }
        })()
      },
    },
    sessionController: {
      async modelCatalog() {
        return { default: { provider: 'default-provider', model: 'default-model' } }
      },
    },
  }
  return { ctx, calls }
}

function makeRun(ctx, overrides = {}, fileTools) {
  const store = createRunStore()
  store.seed('s1', seed)
  const run = store.create('s1', store.takeSeed('s1'))
  run.messages = buildInitialMessages(seed)
  store.setPhase(run, 'collecting')
  const config = { ...DEFAULT_CONFIG, ...overrides }
  const engine = createEngine(ctx, config, null, { store, fileTools })
  return { store, run, engine, config }
}

test('deliver_prompt completes a run and uses the configured model budget', async () => {
  const { ctx, calls } = makeCtx([[deliverCall(), usage(), finish()]])
  const { run, engine } = makeRun(ctx, { maxTokens: 4321 })
  await engine.advance(run)
  assert.equal(run.phase, 'ready')
  assert.equal(run.prompt.title, '记账工具')
  assert.equal(run.modelCalls, 1)
  assert.deepEqual(run.usage, { inputTokens: 10, outputTokens: 20 })
  assert.equal(calls[0].maxTokens, 4321)
  assert.ok(calls[0].system.includes('提示词增强器'))
  assert.deepEqual(calls[0].tools.map((tool) => tool.name), ['ask_questions', 'deliver_prompt'])
})

test('ask_questions pauses the run and a later advance can deliver', async () => {
  const { ctx } = makeCtx([[askCall(), finish()], [deliverCall('c2'), finish()]])
  const { store, run, engine } = makeRun(ctx)
  await engine.advance(run)
  assert.equal(run.phase, 'questioning')
  assert.equal(run.questions, undefined)
  assert.equal(run.pending.batchId, 'b1')
  assert.equal(run.questionRounds, 1)
  store.setPhase(run, 'drafting')
  await engine.advance(run)
  assert.equal(run.phase, 'ready')
  assert.equal(run.prompt.title, '记账工具')
})

test('invalid JSON is answered with a tool error and retried once', async () => {
  const bad = { type: 'block-end', block: { type: 'tool-call', id: 'bad', name: 'deliver_prompt', arguments: '{nope' } }
  const { ctx, calls } = makeCtx([[bad, finish()], [deliverCall('c2'), finish()]])
  const { run, engine } = makeRun(ctx)
  await engine.advance(run)
  assert.equal(run.phase, 'ready')
  assert.equal(run.modelCalls, 2)
  assert.equal(calls.length, 2)
  assert.ok(run.messages.some((message) => message.role === 'tool' && message.isError === true))
  assert.ok(run.messages.some((message) => message.role === 'user' && JSON.stringify(message).includes('format-error')))
})

test('a model that never calls a tool fails after the single retry', async () => {
  const { ctx } = makeCtx([[finish()], [finish()]])
  const { run, engine } = makeRun(ctx)
  await engine.advance(run)
  assert.equal(run.phase, 'failed')
  assert.equal(run.error.code, 'INVALID_MODEL_OUTPUT')
})

test('question rounds are capped even when the model keeps asking', async () => {
  const { ctx, calls } = makeCtx([
    [askCall('a1'), finish()],
    [askCall('a2'), finish()],
    [askCall('a3'), finish()],
    [deliverCall('d1'), finish()],
  ])
  const { store, run, engine } = makeRun(ctx, { maxQuestionRounds: 2 })
  await engine.advance(run)
  store.setPhase(run, 'drafting')
  await engine.advance(run)
  store.setPhase(run, 'drafting')
  await engine.advance(run)
  assert.equal(run.phase, 'ready')
  assert.equal(run.questionRounds, 2)
  assert.equal(calls.length, 4)
  assert.ok(run.messages.some((message) => JSON.stringify(message).includes('提问轮数已达上限')))
})

test('the model-call budget stops a looping run with BUDGET_EXCEEDED', async () => {
  const { ctx, calls } = makeCtx([
    [askCall('a1'), finish()],
    [askCall('a2'), finish()],
    [askCall('a3'), finish()],
  ])
  const { store, run, engine } = makeRun(ctx, { maxQuestionRounds: 2, maxModelCalls: 3 })
  await engine.advance(run)
  store.setPhase(run, 'drafting')
  await engine.advance(run)
  store.setPhase(run, 'drafting')
  await engine.advance(run)
  assert.equal(run.phase, 'failed')
  assert.equal(run.error.code, 'BUDGET_EXCEEDED')
  assert.equal(calls.length, 3)
})

test('a cancelled run is never sent to the model', async () => {
  const { ctx, calls } = makeCtx([[deliverCall(), finish()]])
  const { run, engine } = makeRun(ctx)
  run.phase = 'cancelled'
  await engine.advance(run)
  assert.equal(calls.length, 0)
  assert.equal(run.phase, 'cancelled')
})

test('a slow model call times out with a readable error code', async () => {
  const { ctx } = makeCtx([[deliverCall(), finish()]], { delay: 120 })
  const { run, engine } = makeRun(ctx, { timeoutMs: 20 })
  await engine.advance(run)
  assert.equal(run.phase, 'failed')
  assert.equal(run.error.code, 'TIMEOUT')
})

test('read-only file tools can be called in parallel and the model then delivers', async () => {
  const executed = []
  const fileTools = {
    enabled: true,
    schemas: [{ name: 'read_file', description: 'x', parameters: { type: 'object' } }],
    async execute(name, args) {
      executed.push([name, args.path])
      return { ok: true, path: args.path, content: 'line' }
    },
  }
  const { ctx, calls } = makeCtx([
    [toolCall('f1', 'read_file', { path: 'a.js' }), toolCall('f2', 'read_file', { path: 'b.js' }), finish()],
    [deliverCall('d1'), finish()],
  ])
  const { run, engine } = makeRun(ctx, {}, fileTools)
  await engine.advance(run)
  assert.equal(run.phase, 'ready')
  assert.deepEqual(executed, [['read_file', 'a.js'], ['read_file', 'b.js']])
  assert.equal(run.toolCalls, 2)
  assert.ok(calls[0].system.includes('read_file'))
  assert.equal(calls[0].tools.length, 3)
})

test('the tool budget turns excess calls into tool errors without failing the run', async () => {
  let executed = 0
  const fileTools = {
    enabled: true,
    schemas: [{ name: 'read_file', description: 'x', parameters: { type: 'object' } }],
    async execute() {
      executed += 1
      return { ok: true, content: 'x' }
    },
  }
  const { ctx } = makeCtx([
    [toolCall('f1', 'read_file', { path: 'a' }), toolCall('f2', 'read_file', { path: 'b' }), finish()],
    [deliverCall('d1'), finish()],
  ])
  const { run, engine } = makeRun(ctx, { maxToolCalls: 1 }, fileTools)
  await engine.advance(run)
  assert.equal(executed, 1)
  assert.equal(run.phase, 'ready')
  assert.ok(run.messages.some((message) => JSON.stringify(message).includes('TOOL_BUDGET_EXCEEDED')))
})

test('an explicit provider/model override is validated against the catalog', async () => {
  const { ctx, calls } = makeCtx([[deliverCall(), finish()]], { models: [{ id: 'deepseek-flash' }] })
  const { run, engine } = makeRun(ctx, { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' })
  await engine.advance(run)
  assert.equal(calls[0].provider, 'deepseek')
  assert.equal(calls[0].model, 'deepseek-flash')
  assert.equal(calls[0].reasoningEffort, 'high')
})

test('answers normalize skipped questions and reject custom text when disabled', () => {
  const pending = {
    questions: [
      { id: 'q1', question: 'x', multiSelect: false, allowCustom: true, options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }] },
      { id: 'q2', question: 'y', multiSelect: false, allowCustom: false, options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }] },
    ],
  }
  const skipped = validateAnswers(pending, [
    { questionId: 'q1', selected: ['o1'], skipped: true },
    { questionId: 'q2', selected: ['o1'] },
  ])
  assert.equal(skipped.ok, true)
  assert.deepEqual(skipped.value[0], { questionId: 'q1', selected: [], custom: null, skipped: true })
  const custom = validateAnswers(pending, [
    { questionId: 'q1', selected: [], custom: 'x' },
    { questionId: 'q2', selected: [], custom: 'not allowed' },
  ])
  assert.equal(custom.ok, false)
})

test('buildInitialMessages tolerates a missing digest document', () => {
  const messages = buildInitialMessages({ rough: 'hi' })
  assert.equal(messages[0].content.length, 2)
  assert.equal(JSON.parse(messages[0].content[1].text).kind, 'session-digest')
})

test('validateQuestions rejects blank ids/questions and unknown extra option shapes', () => {
  assert.equal(validateQuestions({ questions: [{ id: 'q1', question: '   ', options: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] }] }).ok, false)
  assert.equal(validateQuestions({ questions: [{ id: 'q1', question: 'x', options: [{ id: 'a', label: 'a' }] }] }).ok, false)
})
