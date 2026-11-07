/**
 * Host half of the prompt-enhance bundle.
 *
 * v2 不再新建 DSH 会话：
 *   `/enhance <粗糙提示词>` 只把「目标会话 + 粗糙提示词」折叠成一份内存里的启动材料，
 *   右侧面板通过 /prompt-enhance 路由驱动模型，最终把提示词写回输入框。
 *
 * 会话列表、工作区、~/.dsh/sessions 都不会因为增强多出任何条目。
 */

import { buildDigest, digestDoc, visibleEvents } from './digest.js'
import { buildInitialMessages, createEngine } from './engine.js'
import { createRoute } from './http.js'
import { createRunStore } from './runs.js'

const ROUTE = '/prompt-enhance'
const MAX_ROUGH = 8192

/**
 * @param {any} ctx
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger('prompt-enhance')
  const runs = createRunStore()
  const engine = createEngine(ctx, config ?? {}, log)
  const route = createRoute({ ctx, runs, engine, log })

  /**
   * /enhance：只留启动材料，不调用模型。
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
   */
  async function onEnhance(invocation) {
    const session = ctx.sessions.get(invocation.agent.id)
    if (!session) return { kind: 'error', text: '当前会话不可用，无法启动提示词增强' }

    const rough = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    if (rough.length > MAX_ROUGH) {
      return { kind: 'error', text: `粗糙提示词太长了（上限 ${Math.round(MAX_ROUGH / 1024)} KB），请精简后再试` }
    }

    let cwd = ''
    try {
      cwd = ctx.workingDirectory.get(session) || ''
    } catch {
      cwd = ''
    }

    const digest = buildDigest(visibleEvents(session))
    runs.seed(session.id, { rough, digest, doc: digestDoc(digest, cwd), cwd })
    return { kind: 'success', text: '提示词增强面板已打开（右侧）' }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: route }),
    'prompt-enhance: data route',
  )

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

  /** 供其它代码/测试复用。 */
  return { runs, engine, buildInitialMessages }
}

export const inject = ['commands', 'sessions', 'workingDirectory', 'llm', 'sessionController', 'webServer']
