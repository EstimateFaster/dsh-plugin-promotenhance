/**
 * 插件内存里的增强任务表：一个目标会话同时只有一个 run。
 *
 * 所有状态都是进程内的，进程重启即丢；面板拿到 404 就提示用户重新 `/enhance`。
 */

const SEED_TTL_MS = 2 * 60 * 1000
const ACTIVE_TTL_MS = 30 * 60 * 1000
const TERMINAL_TTL_MS = 60 * 1000
const CANCEL_TTL_MS = 5 * 60 * 1000

/** 终态集合。 */
const TERMINAL = new Set(['ready', 'inserted', 'failed', 'cancelled', 'expired'])

/**
 * @param {{ now?: () => number }} [options]
 */
export function createRunStore(options = {}) {
  const now = options.now ?? Date.now
  /** @type {Map<string, { rough: string, digest: any, doc: any, cwd: string, createdAt: number }>} */
  const seeds = new Map()
  /** @type {Map<string, any>} */
  const runs = new Map()
  let counter = 0

  function ttlFor(phase) {
    if (phase === 'expired') return TERMINAL_TTL_MS
    if (phase === 'cancelled') return CANCEL_TTL_MS
    if (TERMINAL.has(phase)) return ACTIVE_TTL_MS
    return ACTIVE_TTL_MS
  }

  function touch(run) {
    run.updatedAt = now()
    run.expiresAt = run.updatedAt + ttlFor(run.phase)
  }

  return {
    /** 命令执行时留下的一次启动材料。 */
    seed(sessionId, seed) {
      seeds.set(sessionId, {
        rough: seed.rough,
        digest: seed.digest,
        doc: seed.doc,
        cwd: seed.cwd,
        createdAt: now(),
      })
    },

    /** 取出启动材料（一次性）。 */
    takeSeed(sessionId) {
      const seed = seeds.get(sessionId)
      if (!seed) return undefined
      seeds.delete(sessionId)
      if (now() - seed.createdAt > SEED_TTL_MS) return undefined
      return seed
    },

    peekSeed(sessionId) {
      const seed = seeds.get(sessionId)
      if (!seed) return undefined
      if (now() - seed.createdAt > SEED_TTL_MS) {
        seeds.delete(sessionId)
        return undefined
      }
      return seed
    },

    get(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return undefined
      if (run.expiresAt < now() && run.phase !== 'expired') {
        run.phase = 'expired'
        run.pending = null
        run.error = null
        touch(run)
      }
      return run
    },

    /** 新建一个 run，顺便取消同会话的旧 run。 */
    create(sessionId, seed) {
      const previous = runs.get(sessionId)
      if (previous) {
        try {
          previous.abort?.abort()
        } catch {
          /* ignore */
        }
      }
      counter += 1
      const run = {
        runId: `pe-${counter}`,
        sessionId,
        phase: 'collecting',
        messages: [],
        pending: null,
        prompt: null,
        error: null,
        seed,
        rounds: 0,
        retries: 0,
        abort: null,
        createdAt: now(),
        updatedAt: now(),
        expiresAt: 0,
      }
      touch(run)
      runs.set(sessionId, run)
      return run
    },

    setPhase(run, phase) {
      run.phase = phase
      if (phase !== 'questioning') run.pending = null
      touch(run)
    },

    fail(run, code, message) {
      run.phase = 'failed'
      run.pending = null
      run.error = { code, message }
      run.abort = null
      touch(run)
    },

    sweep() {
      const at = now()
      for (const [sessionId, run] of runs) {
        if (at > run.expiresAt) {
          try {
            run.abort?.abort()
          } catch {
            /* ignore */
          }
          runs.delete(sessionId)
        }
      }
      for (const [sessionId, seed] of seeds) {
        if (at - seed.createdAt > SEED_TTL_MS) seeds.delete(sessionId)
      }
    },

    /**
     * 侧栏角标用的状态表：sessionId → 'enhancing' | 'used'。
     * 提问/生成中算 enhancing（黄），已产出/已插入算 used（绿）。
     */
    statusMap() {
      const out = {}
      for (const [sessionId, run] of runs) {
        if (run.phase === 'collecting' || run.phase === 'drafting' || run.phase === 'questioning') out[sessionId] = 'enhancing'
        else if (run.phase === 'ready' || run.phase === 'inserted') out[sessionId] = 'used'
      }
      for (const sessionId of seeds.keys()) {
        if (!out[sessionId]) out[sessionId] = 'enhancing'
      }
      return out
    },

    /** 仅测试用。 */
    size() {
      return runs.size
    },
  }
}

/** 对外暴露的状态（面板只读这个）。 */
export function publicState(run) {
  return {
    runId: run.runId,
    session: run.sessionId,
    phase: run.phase,
    round: run.rounds,
    questions: run.pending
      ? { batchId: run.pending.batchId, questions: run.pending.questions }
      : null,
    prompt: run.prompt,
    error: run.error,
    updatedAt: run.updatedAt,
  }
}
