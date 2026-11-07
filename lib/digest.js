/**
 * 会话上下文的折叠：只取「用户说过的话 + 每轮助手最后的收尾文本」。
 *
 * v1 把这段折成一段自然语言；v2 折成结构化数组，交给模型时再包成 JSON 文档。
 */

const MAX_TURNS = 16
const MAX_CHARS = 24000

/**
 * 取模型当前可见的事件序列：`session.surface.nodes` 已经过压缩/替换折叠，
 * 用它过滤完整日志，避免把已被替换掉的历史重复折进上下文。
 *
 * @param {any} session 宿主 Session
 * @returns {readonly any[]}
 */
export function visibleEvents(session) {
  let all = []
  try {
    all = session?.snapshotEvents?.() ?? []
  } catch {
    all = []
  }
  let nodes = []
  try {
    nodes = session?.surface?.nodes ?? []
  } catch {
    nodes = []
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return all
  const bySeq = new Map()
  for (const event of all) {
    if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
  }
  const visible = []
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event) visible.push(event)
  }
  return visible.length > 0 ? visible : all
}

/** 只保留 text block。 */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 真人发出的用户消息（排除 runtime-context 等注入）。 */
function isUserPrompt(event) {
  const kind = event?.data?.source?.kind
  return kind === 'user' || kind === 'user-rpc'
}

/**
 * 折叠成轮次数组：每轮一条 user（可能多段）与一条 assistant 收尾文本。
 *
 * @param {readonly any[]} events
 * @returns {{ turns: { user: string, assistant: string }[], truncated: boolean, omittedTurns: number }}
 */
export function buildDigest(events) {
  /** @type {{ role: 'user' | 'assistant', text: string }[]} */
  const entries = []

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      if (!isUserPrompt(event)) continue
      const text = blocksText(event.data?.content)
      if (text) entries.push({ role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = blocksText(event.data?.message?.content)
      if (!text) continue
      const last = entries[entries.length - 1]
      if (last && last.role === 'assistant') last.text = text
      else entries.push({ role: 'assistant', text })
      continue
    }
  }

  /** @type {{ user: string, assistant: string }[]} */
  const turns = []
  let current = null
  for (const entry of entries) {
    if (entry.role === 'user') {
      current = { user: entry.text, assistant: '' }
      turns.push(current)
    } else if (current) {
      current.assistant = entry.text
    } else {
      current = { user: '', assistant: entry.text }
      turns.push(current)
    }
  }

  const total = turns.length
  const kept = []
  let chars = 0
  let truncated = false
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    const size = turn.user.length + turn.assistant.length
    if (kept.length >= MAX_TURNS || chars + size > MAX_CHARS) {
      truncated = true
      break
    }
    kept.push(turn)
    chars += size
  }
  kept.reverse()

  return { turns: kept, truncated, omittedTurns: total - kept.length }
}

/**
 * 交给模型的结构化文档。
 *
 * @param {{ turns: {user:string,assistant:string}[], truncated: boolean, omittedTurns: number }} digest
 * @param {string} cwd
 */
export function digestDoc(digest, cwd) {
  return {
    kind: 'session-digest',
    version: 1,
    cwd: cwd || '',
    turns: digest.turns.map((turn) => ({ user: turn.user, assistant: turn.assistant })),
    truncated: digest.truncated,
    omittedTurns: digest.omittedTurns,
  }
}
