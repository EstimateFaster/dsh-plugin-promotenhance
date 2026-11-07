/**
 * In-memory run table: one enhancement run per target session.
 *
 * All state is process-local. A host restart drops every seed and run; the
 * panel then receives `NO_RUN` and tells the user to run `/enhance` again.
 * Nothing here touches session files, workspaces, or the DSH transcript.
 */

const SEED_TTL_MS = 2 * 60 * 1000
const ACTIVE_TTL_MS = 30 * 60 * 1000
const EXPIRED_TTL_MS = 60 * 1000
const CANCEL_TTL_MS = 5 * 60 * 1000

/** Phases after which a run no longer does work. */
const TERMINAL = new Set(['ready', 'inserted', 'failed', 'cancelled', 'expired'])

/** True when `phase` is terminal. */
export function isTerminal(phase) {
  return TERMINAL.has(phase)
}

/**
 * @param {{ now?: () => number, maxRuns?: number }} [options]
 */
export function createRunStore(options = {}) {
  const now = options.now ?? Date.now
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : 8
  /** @type {Map<string, { rough: string, digest: any, doc: any, cwd: string, createdAt: number }>} */
  const seeds = new Map()
  /** @type {Map<string, any>} */
  const runs = new Map()
  let counter = 0

  function ttlFor(phase) {
    if (phase === 'expired') return EXPIRED_TTL_MS
    if (phase === 'cancelled') return CANCEL_TTL_MS
    return ACTIVE_TTL_MS
  }

  function touch(run) {
    run.updatedAt = now()
    run.expiresAt = run.updatedAt + ttlFor(run.phase)
  }

  function abortRun(run) {
    try {
      run.abort?.abort()
    } catch {
      /* abort is best effort */
    }
    run.abort = null
  }

  function evictOldest() {
    let oldestId = null
    let oldestAt = Infinity
    for (const [sessionId, run] of runs) {
      if (run.createdAt < oldestAt) {
        oldestAt = run.createdAt
        oldestId = sessionId
      }
    }
    if (oldestId === null) return
    const victim = runs.get(oldestId)
    if (victim) {
      victim.phase = 'cancelled'
      abortRun(victim)
    }
    runs.delete(oldestId)
  }

  return {
    /** Leave launch material for the next `POST /start` (consumed once). */
    seed(sessionId, seed) {
      seeds.set(sessionId, {
        rough: seed.rough,
        digest: seed.digest,
        doc: seed.doc,
        cwd: seed.cwd,
        createdAt: now(),
      })
    },

    /** Take launch material; returns undefined when absent or older than 2 minutes. */
    takeSeed(sessionId) {
      const seed = seeds.get(sessionId)
      if (!seed) return undefined
      seeds.delete(sessionId)
      if (now() - seed.createdAt > SEED_TTL_MS) return undefined
      return seed
    },

    /** Current run for a session, marking it expired on first read after TTL. */
    get(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return undefined
      if (run.expiresAt < now() && run.phase !== 'expired') {
        run.phase = 'expired'
        run.pending = null
        run.error = null
        abortRun(run)
        touch(run)
      }
      return run
    },

    /** Create a run, cancelling the previous one and evicting the oldest at capacity. */
    create(sessionId, seed) {
      const previous = runs.get(sessionId)
      if (previous) {
        previous.phase = 'cancelled'
        abortRun(previous)
        runs.delete(sessionId)
      }
      if (runs.size >= maxRuns) evictOldest()
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
        modelCalls: 0,
        questionRounds: 0,
        toolCalls: 0,
        retries: 0,
        usage: null,
        maxTokensBoosted: false,
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
      if (phase !== 'failed') run.error = null
      touch(run)
    },

    fail(run, code, message) {
      if (run.phase === 'cancelled' || run.phase === 'expired') return
      run.phase = 'failed'
      run.pending = null
      run.error = { code, message }
      abortRun(run)
      touch(run)
    },

    cancel(run) {
      if (isTerminal(run.phase)) return
      run.phase = 'cancelled'
      run.pending = null
      abortRun(run)
      touch(run)
    },

    /** Session map for sidebar badges: enhancing (amber) vs. used (green). */
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

    /** Remove expired runs/seeds. Expired runs are retained for 60 s so the UI can show why. */
    sweep() {
      const at = now()
      for (const [sessionId, run] of runs) {
        if (at > run.expiresAt) {
          abortRun(run)
          runs.delete(sessionId)
        }
      }
      for (const [sessionId, seed] of seeds) {
        if (at - seed.createdAt > SEED_TTL_MS) seeds.delete(sessionId)
      }
    },

    /** Test/diagnostic hook. */
    size() {
      return runs.size
    },
  }
}

/** The subset of run state the browser is allowed to read. */
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
    expiresAt: run.expiresAt,
  }
}
