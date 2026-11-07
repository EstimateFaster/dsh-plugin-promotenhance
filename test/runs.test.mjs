import test from 'node:test'
import assert from 'node:assert/strict'

import { createRunStore, isTerminal, publicState } from '../lib/runs.js'

const seed = (rough = 'x') => ({ rough, digest: { turns: [], truncated: false, omittedTurns: 0 }, doc: {}, cwd: '/tmp/demo' })

test('seed is one-shot and expires after two minutes', () => {
  let now = 1_000
  const store = createRunStore({ now: () => now })
  store.seed('s1', seed())
  assert.equal(store.takeSeed('s1').rough, 'x')
  assert.equal(store.takeSeed('s1'), undefined)

  store.seed('s2', seed())
  now += 2 * 60 * 1000 + 1
  assert.equal(store.takeSeed('s2'), undefined)
})

test('one run per session: a new run cancels and aborts the previous one', () => {
  const store = createRunStore()
  store.seed('s1', seed())
  const first = store.create('s1', store.takeSeed('s1'))
  let aborted = false
  first.abort = { abort: () => { aborted = true } }
  const second = store.create('s1', seed())
  assert.equal(aborted, true)
  assert.equal(first.phase, 'cancelled')
  assert.equal(store.get('s1').runId, second.runId)
  assert.notEqual(first.runId, second.runId)
})

test('expired runs stay readable for 60 seconds before sweeping', () => {
  let now = 1_000
  const store = createRunStore({ now: () => now })
  store.seed('s1', seed())
  const run = store.create('s1', store.takeSeed('s1'))
  now += 30 * 60 * 1000 + 1
  assert.equal(store.get('s1').phase, 'expired')
  const expiresAt = store.get('s1').expiresAt
  assert.ok(expiresAt > now)
  now += 30 * 1000
  store.sweep()
  assert.ok(store.get('s1'))
  now += 31 * 1000
  store.sweep()
  assert.equal(store.get('s1'), undefined)
})

test('cancelled runs retain their result for five minutes and abort in-flight work', () => {
  let now = 0
  const store = createRunStore({ now: () => now })
  store.seed('s1', seed())
  const run = store.create('s1', store.takeSeed('s1'))
  run.prompt = { title: 'x', markdown: 'y', assumptions: [] }
  let aborted = false
  run.abort = { abort: () => { aborted = true } }
  store.cancel(run)
  assert.equal(run.phase, 'cancelled')
  assert.equal(aborted, true)
  now += 4 * 60 * 1000
  assert.equal(store.get('s1').phase, 'cancelled')
  now += 2 * 60 * 1000
  store.sweep()
  assert.equal(store.get('s1'), undefined)
})

test('the store evicts the oldest run at capacity', () => {
  const store = createRunStore({ maxRuns: 2 })
  store.seed('a', seed())
  const first = store.create('a', store.takeSeed('a'))
  store.seed('b', seed())
  const second = store.create('b', store.takeSeed('b'))
  store.seed('c', seed())
  const third = store.create('c', store.takeSeed('c'))
  assert.equal(store.size(), 2)
  assert.equal(store.get('a'), undefined)
  assert.equal(store.get('b').runId, second.runId)
  assert.equal(store.get('c').runId, third.runId)
  assert.equal(first.phase, 'cancelled')
})

test('statusMap reports enhancing and used phases but not terminal failures', () => {
  let now = 0
  const store = createRunStore({ now: () => now })
  store.seed('s1', seed())
  const run = store.create('s1', store.takeSeed('s1'))
  assert.deepEqual(store.statusMap(), { s1: 'enhancing' })
  run.phase = 'ready'
  assert.deepEqual(store.statusMap(), { s1: 'used' })
  run.phase = 'failed'
  assert.deepEqual(store.statusMap(), {})
})

test('publicState exposes the panel contract and nothing else', () => {
  const store = createRunStore()
  store.seed('s1', seed())
  const run = store.create('s1', store.takeSeed('s1'))
  run.pending = { batchId: 'b1', callId: 'c1', questions: [{ id: 'q1' }] }
  store.setPhase(run, 'questioning')
  const state = publicState(run)
  assert.deepEqual(Object.keys(state).sort(), [
    'error',
    'expiresAt',
    'phase',
    'prompt',
    'questions',
    'round',
    'runId',
    'session',
    'updatedAt',
  ])
  assert.equal(state.questions.batchId, 'b1')
  assert.equal(state.messages, undefined)
  assert.equal(state.seed, undefined)
})

test('isTerminal includes every non-working phase', () => {
  for (const phase of ['ready', 'inserted', 'failed', 'cancelled', 'expired']) assert.equal(isTerminal(phase), true)
  for (const phase of ['collecting', 'drafting', 'questioning']) assert.equal(isTerminal(phase), false)
})
