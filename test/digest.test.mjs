import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDigest, digestDoc, visibleEvents } from '../lib/digest.js'
import { buildInitialMessages, validateAnswers, validatePrompt, validateQuestions } from '../lib/engine.js'
import { createRunStore, publicState } from '../lib/runs.js'

const userEvent = (text) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
})

const runtimeEvent = (text) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'runtime-context' }, role: 'user' },
})

const assistantEvent = (turn, text) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'text', text },
      ],
    },
  },
})

test('digest keeps user prompts and the last assistant text of each turn', () => {
  const digest = buildDigest([
    { type: 'turn/start', data: { turn: 1 } },
    userEvent('做一个插件'),
    assistantEvent(1, '先看看项目结构'),
    assistantEvent(1, '最终收尾：计划如下'),
    { type: 'turn/start', data: { turn: 2 } },
    userEvent('继续'),
    assistantEvent(2, '## 完成'),
  ])

  assert.deepEqual(digest.turns, [
    { user: '做一个插件', assistant: '最终收尾：计划如下' },
    { user: '继续', assistant: '## 完成' },
  ])
  assert.equal(digest.truncated, false)
  assert.ok(!JSON.stringify(digest).includes('thinking hard'), 'reasoning must not leak')
  assert.ok(!JSON.stringify(digest).includes('先看看项目结构'), 'intermediate text is replaced')
})

test('digest skips runtime-context injections', () => {
  const digest = buildDigest([
    { type: 'turn/start', data: { turn: 1 } },
    runtimeEvent('Current runtime context. ...'),
    userEvent('真实提问'),
    assistantEvent(1, '好的'),
  ])
  assert.equal(digest.turns.length, 1)
  assert.ok(!JSON.stringify(digest).includes('Current runtime context'))
})

test('digest truncates from the oldest turns and counts omissions', () => {
  const events = []
  for (let turn = 1; turn <= 40; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } })
    events.push(userEvent(`第 ${turn} 轮用户消息`.repeat(200)))
    events.push(assistantEvent(turn, `第 ${turn} 轮回复`.repeat(200)))
  }
  const digest = buildDigest(events)
  assert.equal(digest.truncated, true)
  assert.ok(digest.turns.length <= 16)
  assert.ok(digest.omittedTurns > 0)
  assert.equal(digest.turns.length + digest.omittedTurns, 40)
  assert.ok(JSON.stringify(digest.turns).includes('第 40 轮'))
  assert.ok(!JSON.stringify(digest.turns).includes('第 1 轮用户消息'))
})

test('digestDoc wraps the digest as a structured document', () => {
  const doc = digestDoc({ turns: [{ user: 'a', assistant: 'b' }], truncated: false, omittedTurns: 0 }, '/repo')
  assert.equal(doc.kind, 'session-digest')
  assert.equal(doc.version, 1)
  assert.equal(doc.cwd, 'repo')
  assert.equal(doc.workspace, 'repo')
  assert.deepEqual(doc.turns, [{ user: 'a', assistant: 'b' }])
})

test('visibleEvents keeps only model-visible surface nodes', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '旧消息' }], source: { kind: 'user' } } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '旧回复' }] } } },
    { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '新消息' }], source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '新回复' }] } } },
  ]
  const session = { snapshotEvents: () => events, surface: { nodes: [2, 3] } }
  assert.deepEqual(
    visibleEvents(session).map((event) => event.seq),
    [2, 3],
  )
})

test('visibleEvents falls back to the full log without a surface', () => {
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }]
  assert.deepEqual(
    visibleEvents({ snapshotEvents: () => events }).map((event) => event.seq),
    [0],
  )
})

test('initial messages use two separate blocks, never a concatenated blob', () => {
  const seed = {
    rough: '写个登录页',
    doc: digestDoc({ turns: [{ user: 'a', assistant: 'b' }], truncated: false, omittedTurns: 0 }, '/repo'),
  }
  const messages = buildInitialMessages(seed)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content.length, 2)
  assert.equal(messages[0].content[0].text, '写个登录页')
  const doc = JSON.parse(messages[0].content[1].text)
  assert.equal(doc.kind, 'session-digest')
  const text = messages[0].content.map((block) => block.text).join('\n')
  assert.ok(!text.includes('<rough_prompt>'))
  assert.ok(!text.includes('<conversation>'))
})

test('validateQuestions accepts a well-formed batch', () => {
  const result = validateQuestions({
    questions: [
      {
        id: 'q1',
        header: '形态',
        question: '怎么用？',
        options: [
          { id: 'o1', label: '网页', recommended: true },
          { id: 'o2', label: '命令行' },
        ],
      },
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.value[0].multiSelect, false)
  assert.equal(result.value[0].allowCustom, true)
  assert.equal(result.value[0].options[0].recommended, true)
})

test('validateQuestions rejects bad ids, counts and duplicate options', () => {
  assert.equal(validateQuestions({ questions: [] }).ok, false)
  assert.equal(
    validateQuestions({ questions: [{ id: 'bad id', question: 'x', options: [{ id: 'a', label: 'a' }] }] }).ok,
    false,
  )
  assert.equal(
    validateQuestions({
      questions: [
        {
          id: 'q1',
          question: 'x',
          options: [
            { id: 'a', label: 'a' },
            { id: 'a', label: 'b' },
          ],
        },
      ],
    }).ok,
    false,
  )
})

test('validatePrompt requires title and markdown', () => {
  assert.equal(validatePrompt({ title: 'x', markdown: 'y' }).ok, true)
  assert.equal(validatePrompt({ title: '', markdown: 'y' }).ok, false)
  assert.equal(validatePrompt({ title: 'x', markdown: '' }).ok, false)
  assert.equal(validatePrompt({ title: 'x', markdown: 'y', assumptions: new Array(7).fill('a') }).ok, false)
})

test('validateAnswers enforces coverage, options and multi-select rules', () => {
  const pending = {
    questions: [
      {
        id: 'q1',
        question: 'x',
        multiSelect: false,
        allowCustom: true,
        options: [
          { id: 'o1', label: 'a' },
          { id: 'o2', label: 'b' },
        ],
      },
    ],
  }
  assert.equal(validateAnswers(pending, [{ questionId: 'q1', selected: ['o1'], custom: null, skipped: false }]).ok, true)
  assert.equal(validateAnswers(pending, [{ questionId: 'q1', selected: ['o1', 'o2'], custom: null, skipped: false }]).ok, false)
  assert.equal(validateAnswers(pending, [{ questionId: 'q1', selected: ['zzz'], custom: null, skipped: false }]).ok, false)
  assert.equal(validateAnswers(pending, [{ questionId: 'q1', selected: [], custom: null, skipped: false }]).ok, false)
  assert.equal(validateAnswers(pending, []).ok, false)
})

test('run store keeps one run per session, cancels the old one and expires', () => {
  let now = 1000
  const store = createRunStore({ now: () => now })
  const seed = { rough: 'x', digest: { turns: [], truncated: false, omittedTurns: 0 }, doc: {}, cwd: '' }
  let aborted = false
  store.seed('s1', seed)
  const first = store.create('s1', store.takeSeed('s1'))
  first.abort = { abort: () => { aborted = true } }
  const second = store.create('s1', seed)
  assert.equal(aborted, true)
  assert.equal(store.get('s1').runId, second.runId)
  assert.notEqual(first.runId, second.runId)

  now += 31 * 60 * 1000
  assert.equal(store.get('s1').phase, 'expired')
  now += 2 * 60 * 1000
  store.sweep()
  assert.equal(store.get('s1'), undefined)
})

test('publicState only exposes what the panel needs', () => {
  const store = createRunStore({ now: () => 0 })
  const seed = { rough: 'x', digest: { turns: [], truncated: false, omittedTurns: 0 }, doc: {}, cwd: '' }
  store.seed('s1', seed)
  const run = store.create('s1', store.takeSeed('s1'))
  run.pending = { batchId: 'b1', callId: 'c1', questions: [{ id: 'q1' }] }
  run.phase = 'questioning'
  const state = publicState(run)
  assert.equal(state.session, 's1')
  assert.equal(state.phase, 'questioning')
  assert.equal(state.questions.batchId, 'b1')
  assert.equal(state.prompt, null)
  assert.equal(state.messages, undefined)
})
