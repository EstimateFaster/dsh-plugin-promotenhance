import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

import { createRunStore } from '../lib/runs.js'
import { createRoute, __test } from '../lib/http.js'
import { VERSION } from '../lib/version.js'

const TOKEN = 'test-token-123'

const seed = {
  rough: '做一个记账工具',
  digest: { turns: [], truncated: false, omittedTurns: 0 },
  doc: { kind: 'session-digest', version: 1, cwd: '/tmp/demo', turns: [], truncated: false, omittedTurns: 0 },
  cwd: '/tmp/demo',
}

async function withRoute(engine, providedRuns) {
  const runs = providedRuns || createRunStore()
  const route = createRoute({ ctx: {}, runs, engine, log: null, token: TOKEN })
  const server = http.createServer((req, res) => route(req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  return {
    runs,
    base,
    async close() {
      server.close()
      await once(server, 'close')
    },
    async get(path, headers = {}) {
      return fetch(`${base}/prompt-enhance${path}`, { headers })
    },
    async post(path, body, headers = {}) {
      return fetch(`${base}/prompt-enhance${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [__test.TOKEN_HEADER]: TOKEN, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    },
    async postRaw(path, body, headers = {}) {
      return fetch(`${base}/prompt-enhance${path}`, {
        method: 'POST',
        headers: { [__test.TOKEN_HEADER]: TOKEN, ...headers },
        body,
      })
    },
  }
}

const readyEngine = (runs) => ({
  hasFileTools: () => false,
  async advance(run) {
    run.prompt = { title: 't', markdown: 'm', assumptions: [] }
    runs.setPhase(run, 'ready')
  },
})

const askingEngine = (runs) => {
  let calls = 0
  return {
    hasFileTools: () => false,
    async advance(run) {
      calls += 1
      if (calls === 1) {
        run.pending = {
          batchId: 'b1',
          callId: 'call-1',
          questions: [
            {
              id: 'q1',
              question: '形态？',
              multiSelect: false,
              allowCustom: true,
              options: [{ id: 'o1', label: 'CLI' }, { id: 'o2', label: '网页' }],
            },
          ],
        }
        runs.setPhase(run, 'questioning')
        return
      }
      run.prompt = { title: 't', markdown: 'm', assumptions: [] }
      runs.setPhase(run, 'ready')
    },
  }
}

test('health is public and reports version/features', async () => {
  const ctx = await withRoute(readyEngine(createRunStore()))
  try {
    const response = await ctx.get('/health')
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.ok, true)
    assert.equal(data.version, VERSION)
    assert.equal(data.fileTools, false)
  } finally {
    await ctx.close()
  }
})

test('state and sessions require the page token', async () => {
  const ctx = await withRoute(readyEngine(createRunStore()))
  try {
    assert.equal((await ctx.get('/state?session=s1')).status, 403)
    assert.equal((await ctx.get('/sessions')).status, 403)
    assert.equal((await ctx.get('/sessions', { [__test.TOKEN_HEADER]: 'wrong' })).status, 403)
    assert.equal((await ctx.get('/sessions', { [__test.TOKEN_HEADER]: TOKEN })).status, 200)
  } finally {
    await ctx.close()
  }
})

test('start requires a token and a seed, then exposes ready state', async () => {
  const runs = createRunStore()
  const ctx = await withRoute(readyEngine(runs), runs)
  try {
    const noToken = await fetch(`${ctx.base}/prompt-enhance/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 's1' }),
    })
    assert.equal(noToken.status, 403)

    const noSeed = await ctx.post('/start', { session: 's1' })
    assert.equal(noSeed.status, 404)
    assert.equal((await noSeed.json()).error.code, 'NO_SEED')

    runs.seed('s1', seed)
    const started = await ctx.post('/start', { session: 's1' })
    assert.equal(started.status, 200)
    const startedData = await started.json()
    assert.equal(startedData.state.phase, 'collecting')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const state = await ctx.get(`/state?session=s1`, { [__test.TOKEN_HEADER]: TOKEN })
    assert.equal(state.status, 200)
    assert.equal((await state.json()).state.phase, 'ready')
  } finally {
    await ctx.close()
  }
})

test('answer and take complete the question flow', async () => {
  const runs = createRunStore()
  const ctx = await withRoute(askingEngine(runs), runs)
  try {
    runs.seed('s1', seed)
    const started = await (await ctx.post('/start', { session: 's1' })).json()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const questioning = await (await ctx.get(`/state?session=s1`, { [__test.TOKEN_HEADER]: TOKEN })).json()
    assert.equal(questioning.state.phase, 'questioning')
    const { runId, questions } = questioning.state
    const answered = await ctx.post('/answer', {
      session: 's1',
      runId,
      batchId: questions.batchId,
      answers: [{ questionId: 'q1', selected: ['o1'], custom: null, skipped: false }],
    })
    assert.equal(answered.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const ready = await (await ctx.get(`/state?session=s1`, { [__test.TOKEN_HEADER]: TOKEN })).json()
    assert.equal(ready.state.phase, 'ready')
    const taken = await ctx.post('/take', { session: 's1', runId, markdown: 'edited' })
    assert.equal(taken.status, 200)
    const takenData = await taken.json()
    assert.equal(takenData.state.phase, 'inserted')
    assert.equal(takenData.prompt.markdown, 'edited')
  } finally {
    await ctx.close()
  }
})

test('malformed JSON bodies return 400 instead of crashing', async () => {
  const runs = createRunStore()
  const ctx = await withRoute(readyEngine(runs), runs)
  try {
    runs.seed('s1', seed)
    assert.equal((await ctx.post('/start', 'null')).status, 400)
    assert.equal((await ctx.post('/start', '[]')).status, 400)
    assert.equal((await ctx.post('/start', '"string"')).status, 400)
    assert.equal((await ctx.post('/start', '{bad')).status, 400)
    assert.equal((await ctx.post('/start', { session: 's1' })).status, 200)
  } finally {
    await ctx.close()
  }
})

test('cross-origin, wrong content-type and oversized bodies are rejected', async () => {
  const runs = createRunStore()
  const ctx = await withRoute(readyEngine(runs), runs)
  try {
    runs.seed('s1', seed)
    const cross = await ctx.post('/start', { session: 's1' }, { origin: 'http://evil.example' })
    assert.equal(cross.status, 403)
    assert.equal((await ctx.postRaw('/start', JSON.stringify({ session: 's1' }), { 'content-type': 'text/plain' })).status, 415)
    const huge = JSON.stringify({ session: 's1', padding: 'x'.repeat(__test.MAX_BODY + 10) })
    assert.equal((await ctx.post('/start', huge)).status, 413)
  } finally {
    await ctx.close()
  }
})

test('unknown actions and methods return stable codes', async () => {
  const ctx = await withRoute(readyEngine(createRunStore()))
  try {
    assert.equal((await ctx.get('/health').then(() => fetch(`${ctx.base}/prompt-enhance/nope`))).status, 405)
    assert.equal((await ctx.post('/nope', {})).status, 404)
    const del = await fetch(`${ctx.base}/prompt-enhance/start`, { method: 'DELETE' })
    assert.equal(del.status, 405)
  } finally {
    await ctx.close()
  }
})

test('take before a prompt exists returns NOT_READY', async () => {
  const runs = createRunStore()
  const noopEngine = { hasFileTools: () => false, async advance() {} }
  const ctx = await withRoute(noopEngine, runs)
  try {
    runs.seed('s1', seed)
    const started = await (await ctx.post('/start', { session: 's1' })).json()
    const result = await ctx.post('/take', { session: 's1', runId: started.state.runId })
    assert.equal(result.status, 409)
    assert.equal((await result.json()).error.code, 'NOT_READY')
  } finally {
    await ctx.close()
  }
})

test('cancel aborts the run and is idempotent', async () => {
  const runs = createRunStore()
  const noopEngine = { hasFileTools: () => false, async advance() {} }
  const ctx = await withRoute(noopEngine, runs)
  try {
    runs.seed('s1', seed)
    const started = await (await ctx.post('/start', { session: 's1' })).json()
    const cancelled = await ctx.post('/cancel', { session: 's1', runId: started.state.runId })
    assert.equal(cancelled.status, 200)
    assert.equal((await cancelled.json()).state.phase, 'cancelled')
    const again = await ctx.post('/cancel', { session: 's1', runId: started.state.runId })
    assert.equal(again.status, 200)
  } finally {
    await ctx.close()
  }
})

test('take rejects a cancelled run even when a prompt object exists', async () => {
  const runs = createRunStore()
  const cancelledEngine = {
    hasFileTools: () => false,
    async advance(run) {
      run.prompt = { title: 't', markdown: 'm', assumptions: [] }
      runs.setPhase(run, 'cancelled')
    },
  }
  const ctx = await withRoute(cancelledEngine, runs)
  try {
    runs.seed('s1', seed)
    const started = await (await ctx.post('/start', { session: 's1' })).json()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await ctx.post('/take', { session: 's1', runId: started.state.runId })
    assert.equal(result.status, 409)
    assert.equal((await result.json()).error.code, 'NOT_READY')
  } finally {
    await ctx.close()
  }
})

test('sameOrigin accepts absent/same origins and rejects a mismatch or null', () => {
  assert.equal(__test.sameOrigin({ headers: {} }), true)
  assert.equal(__test.sameOrigin({ headers: { origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081' } }), true)
  assert.equal(__test.sameOrigin({ headers: { origin: 'http://evil.example', host: '127.0.0.1:3081' } }), false)
  assert.equal(__test.sameOrigin({ headers: { origin: 'null', host: '127.0.0.1:3081' } }), false)
})
