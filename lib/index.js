/**
 * Host half of the prompt-enhance bundle.
 *
 * `/enhance <rough prompt>` folds the target session's visible transcript into
 * an in-memory seed. The right-side panel then drives the model through
 * `/prompt-enhance/*` and finally writes the finished prompt back into the
 * composer. No DSH session, workspace entry, or transcript record is created.
 */

import { randomBytes } from 'node:crypto'
import { buildDigest, digestDoc, visibleEvents } from './digest.js'
import { buildInitialMessages, createEngine } from './engine.js'
import { normalizeConfig } from './config.js'
import { createRoute } from './http.js'
import { createRunStore } from './runs.js'
import { createFileTools } from './tools.js'

const ROUTE = '/prompt-enhance'
const TOKEN_META = 'dsh-prompt-enhance-token'

/**
 * Inject the panel token into the SPA index. The token is random per host
 * process; the browser reads it from the meta tag and sends it on every
 * `/prompt-enhance` request.
 */
export function injectToken(html, token) {
  const meta = `<meta name="${TOKEN_META}" content="${token}">`
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${meta}</head>`)
  return `${meta}${html}`
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const log = ctx.logger('prompt-enhance')
  const config = normalizeConfig(rawConfig, log)
  const hasIndexTap = typeof ctx.webServer.tapIndex === 'function'
  const token = hasIndexTap ? randomBytes(24).toString('base64url') : ''
  if (!hasIndexTap) log.warn('prompt-enhance: webServer.tapIndex is unavailable; the data route runs without a page token')
  const runs = createRunStore()
  const engine = createEngine(ctx, config, log, { store: runs })
  const route = createRoute({ ctx, runs, engine, log, token })

  /**
   * `/enhance`: only collect launch material; never call the model here.
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
   */
  async function onEnhance(invocation) {
    const session = ctx.sessions.get(invocation.agent.id)
    if (!session) return { kind: 'error', text: '当前会话不可用，无法启动提示词增强' }

    const rough = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    if (rough.length > config.maxRoughChars) {
      return {
        kind: 'error',
        text: `粗糙提示词太长了（上限 ${config.maxRoughChars} 字符），请精简后再试`,
      }
    }

    let cwd = ''
    try {
      cwd = ctx.workingDirectory.get(session) || ''
    } catch {
      cwd = ''
    }

    let digest
    try {
      digest = buildDigest(visibleEvents(session))
    } catch (error) {
      log.warn('prompt-enhance: digest failed — %s', String(error))
      digest = { turns: [], truncated: false, omittedTurns: 0 }
    }
    runs.seed(session.id, { rough, digest, doc: digestDoc(digest, cwd), cwd })
    log.info('prompt-enhance: seeded session %s (%d turns, %d chars rough)', session.id, digest.turns.length, rough.length)
    return { kind: 'success', text: '提示词增强面板已打开（右侧）' }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: route }),
    'prompt-enhance: data route',
  )

  if (hasIndexTap) {
    ctx.effect(
      () => ctx.webServer.tapIndex((html) => injectToken(html, token)),
      'prompt-enhance: index token',
    )
  }

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'enhance',
        description: '提示词增强：把粗糙提示词澄清成可直接使用的完整提示词',
        input: { hint: '要增强的粗糙提示词（可留空，会先问你要做什么）' },
        handler: onEnhance,
      }),
    'prompt-enhance: /enhance command',
  )

  // `fs` is optional at composition time: without it the model simply gets the
  // two control tools and a shorter system prompt.
  ctx.inject(['fs'], (scope) => {
    engine.setFileTools(createFileTools(scope.fs, log))
    return () => engine.setFileTools(null)
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        runs.sweep()
      } catch (error) {
        log.warn('prompt-enhance: sweep failed — %s', String(error))
      }
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'prompt-enhance: sweeper')

  /** Exposed for tests and other composition code. */
  return { runs, engine, config, buildInitialMessages }
}

export const inject = ['commands', 'sessions', 'workingDirectory', 'llm', 'sessionController', 'webServer']

export const __test = { injectToken, TOKEN_META }
