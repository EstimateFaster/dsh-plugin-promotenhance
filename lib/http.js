/**
 * 面板与宿主之间的数据平面：一个挂在现有 Web 服务上的 JSON 路由。
 *
 * 为什么不复用命令：命令的返回内容会被当成聊天消息显示，问题与答案就会写进
 * 用户会话转写里；这里只收发数据，不落任何 DSH 会话。
 */

import { buildInitialMessages, validateAnswers } from './engine.js'
import { publicState } from './runs.js'

const PREFIX = '/prompt-enhance'
const MAX_BODY = 256 * 1024

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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

/** 读取 JSON 请求体，超过上限直接拒绝。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'INVALID_BODY' }))
      }
    })
    req.on('error', reject)
  })
}

/** 只允许同源请求（网关会把 Origin 改写成上游源）。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * @param {{ ctx: any, runs: any, engine: any, log: any }} deps
 */
export function createRoute({ ctx, runs, engine, log }) {
  function kick(run) {
    Promise.resolve()
      .then(() => engine.advance(run))
      .catch((error) => {
        log?.warn?.('prompt-enhance: advance failed — %s', String(error))
        run.phase = 'failed'
        run.error = { code: 'LLM_FAILED', message: String(error && error.message ? error.message : error) }
      })
  }

  async function start(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    if (!session) return fail(res, 400, 'INVALID_BODY', '缺少 session')
    const restart = body.restart === true
    const existing = runs.get(session)
    // 新的 /enhance 总会留下一个更新的 seed：优先用它，面板开着时也能立刻换任务。
    const fresh = runs.takeSeed(session)

    if (!fresh && existing && !restart && existing.phase !== 'expired') {
      return ok(res, { state: publicState(existing) })
    }

    const seed = fresh || (existing && existing.seed)
    if (!seed) return fail(res, 404, 'NO_SEED', '没有可用的启动材料，请重新 /enhance')

    const run = runs.create(session, seed)
    run.messages = buildInitialMessages(seed)
    runs.setPhase(run, 'collecting')
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
    try {
      run.abort?.abort()
    } catch {
      /* ignore */
    }
    runs.setPhase(run, 'cancelled')
    return ok(res, { state: publicState(run) })
  }

  function take(body, res) {
    const session = typeof body.session === 'string' ? body.session : ''
    const run = runs.get(session)
    if (!run) return fail(res, 404, 'NO_RUN', '增强任务不存在或已过期')
    if (body.runId !== undefined && body.runId !== run.runId) return fail(res, 409, 'STALE_RUN', '这不是当前任务')
    if (!run.prompt) return fail(res, 409, 'NOT_READY', '提示词还没生成完')
    if (typeof body.markdown === 'string') {
      const markdown = body.markdown.trim()
      if (!markdown) return fail(res, 400, 'INVALID_BODY', 'markdown 不能为空')
      if (markdown.length > 60000) return fail(res, 400, 'INVALID_BODY', 'markdown 太长')
      run.prompt = { ...run.prompt, markdown }
    }
    runs.setPhase(run, 'inserted')
    return ok(res, { prompt: run.prompt, state: publicState(run) })
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(PREFIX)) return fail(res, 404, 'NOT_FOUND', 'not found')
      const action = url.pathname.slice(PREFIX.length) || '/'

      if (req.method === 'GET' && action === '/state') return state(url, res)
      if (req.method === 'GET' && action === '/sessions') return ok(res, { sessions: runs.statusMap() })

      if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed')
      if (!sameOrigin(req)) return fail(res, 403, 'FORBIDDEN', 'cross-origin request rejected')
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '需要 application/json')

      let body
      try {
        body = await readJson(req)
      } catch (error) {
        if (error && error.code === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '提交内容太大')
        return fail(res, 400, 'INVALID_BODY', '请求体不是合法 JSON')
      }

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
}

/** 供测试复用。 */
export const __test = { PREFIX, MAX_BODY, sameOrigin }
