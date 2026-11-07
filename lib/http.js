/**
 * JSON data plane between the panel and the host, mounted on the existing Web
 * server under `/prompt-enhance`.
 *
 * Commands cannot carry this data: command results are rendered into the chat
 * transcript. These endpoints exchange structured state only and never write a
 * DSH session event.
 *
 * Defenses, in order: a per-process page token, a same-origin check for
 * mutating requests, a JSON content-type requirement, a hard body limit, and a
 * plain-object body check. Responses never include stack traces.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { buildInitialMessages, validateAnswers } from './engine.js'
import { publicState } from './runs.js'
import { PLUGIN_NAME, VERSION } from './version.js'

const PREFIX = '/prompt-enhance'
const MAX_BODY = 256 * 1024
const TOKEN_HEADER = 'x-dsh-prompt-enhance-token'
const STARTED_AT = Date.now()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function ok(res, payload) {
  json(res, 200, { ok: true, ...payload })
}

function fail(res, status, code, message, extra) {
  json(res, status, { ok: false, error: { code, message, retryable: false, ...(extra ?? {}) } })
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Read a JSON request body with a hard byte cap and abort-safe settlement. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) {
        finish(reject, Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
        // Drain rather than destroy: the socket must stay alive long enough to
        // deliver the 413 response.
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        finish(resolve, {})
        return
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(reject, Object.assign(new Error('invalid json'), { code: 'INVALID_BODY' }))
      }
    })
    req.on('error', (error) => finish(reject, error))
    req.on('close', () => {
      if (!settled && !req.readableEnded) {
        finish(reject, Object.assign(new Error('request aborted'), { code: 'ABORTED' }))
      }
    })
  })
}

/** Only same-origin browser requests mutate state (the gateway rewrites Origin upstream). */
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest()
}

/** Constant-time page-token comparison. A missing configured token disables the check. */
function tokenOk(req, expectedHash) {
  if (!expectedHash) return true
  const header = req.headers[TOKEN_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value.length === 0) return false
  const actual = hashToken(value)
  return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash)
}

/**
 * @param {{ ctx: any, runs: any, engine: any, log: any, token?: string }} deps
 */
export function createRoute({ ctx, runs, engine, log, token = '' }) {
  const expectedHash = token ? hashToken(token) : null

  function kick(run) {
    Promise.resolve()
      .then(() => engine.advance(run))
      .catch((error) => {
        if (run.phase === 'cancelled' || run.phase === 'expired' || run.phase === 'ready' || run.phase === 'inserted' || run.phase === 'failed') return
        log?.warn?.('prompt-enhance: advance rejected — %s', String(error))
        if (typeof runs.fail === 'function') runs.fail(run, 'LLM_FAILED', String(error && error.message ? error.message : error))
        else {
          run.phase = 'failed'
          run.error = { code: 'LLM_FAILED', message: String(error && error.message ? error.message : error) }
        }
      })
  }

  async function start(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    if (!session) return fail(res, 400, 'INVALID_BODY', '缺少 session')
    const restart = body.restart === true
    const existing = runs.get(session)
    // A new /enhance always leaves a newer seed: prefer it even if a panel is open.
    const fresh = runs.takeSeed(session)

    if (!fresh && existing && !restart && existing.phase !== 'expired') {
      return ok(res, { state: publicState(existing) })
    }

    const seed = fresh || (existing && existing.seed)
    if (!seed) return fail(res, 404, 'NO_SEED', '没有可用的启动材料，请重新 /enhance')

    const run = runs.create(session, seed)
    run.messages = buildInitialMessages(seed)
    runs.setPhase(run, 'collecting')
    log?.info?.('prompt-enhance: started run %s for %s', run.runId, session)
    kick(run)
    return ok(res, { state: publicState(run) })
  }

  function state(url, res) {
    const session = url.searchParams.get('session') || ''
    if (!session) return fail(res, 400, 'INVALID_BODY', '缺少 session')
    const run = runs.get(session)
    if (!run) return fail(res, 404, 'NO_RUN', '增强任务不存在或已过期')
    return ok(res, { state: publicState(run) })
  }

  async function answer(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    const run = runs.get(session)
    if (!run) return fail(res, 404, 'NO_RUN', '增强任务不存在或已过期')
    if (body.runId !== run.runId) return fail(res, 409, 'STALE_RUN', '这不是当前任务')
    if (run.phase !== 'questioning' || !run.pending) return fail(res, 409, 'NOT_QUESTIONING', '当前没有待回答的问题')
    if (body.batchId !== run.pending.batchId) return fail(res, 409, 'STALE_BATCH', '这批问题已经被回答')

    const checked = validateAnswers(run.pending, body.answers)
    if (!checked.ok) return fail(res, 400, 'INVALID_ANSWER', checked.message)

    run.messages.push({
      role: 'tool',
      id: `pe-${run.runId}-${run.messages.length}`,
      toolCallId: run.pending.callId,
      isError: false,
      source: { kind: 'tool', callId: run.pending.callId },
      content: [
        {
          type: 'text',
          text: JSON.stringify({ kind: 'answers', batchId: run.pending.batchId, answers: checked.value }),
        },
      ],
    })
    run.pending = null
    run.retries = 0
    runs.setPhase(run, 'drafting')
    kick(run)
    return ok(res, { state: publicState(run) })
  }

  function cancel(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    const run = runs.get(session)
    if (!run) return fail(res, 404, 'NO_RUN', '增强任务不存在或已过期')
    if (body.runId !== undefined && body.runId !== run.runId) return fail(res, 409, 'STALE_RUN', '这不是当前任务')
    if (typeof runs.cancel === 'function') runs.cancel(run)
    else {
      try {
        run.abort?.abort()
      } catch {
        /* ignore */
      }
      runs.setPhase(run, 'cancelled')
    }
    return ok(res, { state: publicState(run) })
  }

  function take(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    const run = runs.get(session)
    if (!run) return fail(res, 404, 'NO_RUN', '增强任务不存在或已过期')
    if (body.runId !== undefined && body.runId !== run.runId) return fail(res, 409, 'STALE_RUN', '这不是当前任务')
    if (!run.prompt) return fail(res, 409, 'NOT_READY', '提示词还没生成完')
    if (run.phase !== 'ready' && run.phase !== 'inserted') {
      return fail(res, 409, 'NOT_READY', '当前任务已不在可插入状态')
    }
    if (typeof body.markdown === 'string') {
      const markdown = body.markdown.trim()
      if (!markdown) return fail(res, 400, 'INVALID_BODY', 'markdown 不能为空')
      if (markdown.length > 60_000) return fail(res, 400, 'INVALID_BODY', 'markdown 太长')
      run.prompt = { ...run.prompt, markdown }
    }
    runs.setPhase(run, 'inserted')
    return ok(res, { prompt: run.prompt, state: publicState(run) })
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(PREFIX)) return fail(res, 404, 'NOT_FOUND', 'not found')
      const action = url.pathname.slice(PREFIX.length) || '/'

      if (req.method === 'GET' && action === '/health') {
        return ok(res, {
          name: PLUGIN_NAME,
          version: VERSION,
          uptimeMs: Date.now() - STARTED_AT,
          fileTools: Boolean(engine.hasFileTools && engine.hasFileTools()),
        })
      }

      if (req.method === 'GET' && (action === '/state' || action === '/sessions')) {
        if (!tokenOk(req, expectedHash)) return fail(res, 403, 'FORBIDDEN', '页面令牌无效，请刷新页面')
        if (action === '/state') return state(url, res)
        return ok(res, { sessions: runs.statusMap() })
      }

      if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed')
      if (!sameOrigin(req)) return fail(res, 403, 'FORBIDDEN', 'cross-origin request rejected')
      if (!tokenOk(req, expectedHash)) return fail(res, 403, 'FORBIDDEN', '页面令牌无效，请刷新页面')
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '需要 application/json')

      let body
      try {
        body = await readJson(req)
      } catch (error) {
        if (error && error.code === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '提交内容太大')
        if (error && error.code === 'ABORTED') return fail(res, 400, 'INVALID_BODY', '请求已中断')
        return fail(res, 400, 'INVALID_BODY', '请求体不是合法 JSON')
      }
      if (!isPlainObject(body)) return fail(res, 400, 'INVALID_BODY', '请求体必须是 JSON 对象')

      if (action === '/start') return start(body, res)
      if (action === '/answer') return answer(body, res)
      if (action === '/cancel') return cancel(body, res)
      if (action === '/take') return take(body, res)
      return fail(res, 404, 'NOT_FOUND', 'not found')
    } catch (error) {
      log?.warn?.('prompt-enhance: route error — %s', String(error))
      if (!res.headersSent) fail(res, 500, 'INTERNAL', '内部错误')
      else res.end()
    }
  }

  return handler
}

/** Re-exported for tests and diagnostics. */
export const __test = { PREFIX, MAX_BODY, TOKEN_HEADER, sameOrigin, readJson, isPlainObject }
