/**
 * Plugin configuration: defaults, clamping and diagnostics.
 *
 * The host calls {@link normalizeConfig} once when the plugin is applied.
 * Invalid values never prevent the plugin from loading: they are clamped to a
 * safe range and reported with a warning, because a typo in a profile should
 * not take the whole Web UI down.
 */

/** Configuration accepted by the Cordis plugin row. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Provider id; must be paired with `model`. */
  provider: '',
  /** Model id; must be paired with `provider`. */
  model: '',
  /** Optional reasoning effort forwarded to the model call. */
  reasoningEffort: '',
  /** Abort a single model call after this many milliseconds. */
  timeoutMs: 120_000,
  /** Output token budget for one model call. */
  maxTokens: 6000,
  /** Maximum number of answered question batches per run (0 disables questions). */
  maxQuestionRounds: 2,
  /** Maximum number of model calls per run. */
  maxModelCalls: 10,
  /** Maximum number of read-only tool executions per run. */
  maxToolCalls: 12,
  /** Maximum rough prompt length accepted by `/enhance`. */
  maxRoughChars: 8192,
  /** Expose read-only workspace tools (read_file / list_dir / grep). */
  fileTools: true,
})

const LIMITS = Object.freeze({
  timeoutMs: [5_000, 600_000],
  maxTokens: [512, 32_000],
  maxQuestionRounds: [0, 10],
  maxModelCalls: [2, 30],
  maxToolCalls: [0, 50],
  maxRoughChars: [256, 65_536],
})

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(name, value, fallback, log) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    log?.warn?.('prompt-enhance: config.%s is not an integer; using %d', name, fallback)
    return fallback
  }
  const [min, max] = LIMITS[name]
  if (number < min || number > max) {
    const clamped = Math.min(max, Math.max(min, number))
    log?.warn?.('prompt-enhance: config.%s out of range [%d, %d]; using %d', name, min, max, clamped)
    return clamped
  }
  return number
}

/**
 * Normalize an untrusted plugin config object.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @param {{ warn?: (message: string, ...args: unknown[]) => void } | null} [log]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw, log = null) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let provider = asString(input.provider)
  let model = asString(input.model)
  if ((provider && !model) || (!provider && model)) {
    log?.warn?.('prompt-enhance: config.provider and config.model must be set together; using the session default model')
    provider = ''
    model = ''
  }
  const fileTools = input.fileTools === undefined ? DEFAULT_CONFIG.fileTools : input.fileTools !== false
  return {
    provider,
    model,
    reasoningEffort: asString(input.reasoningEffort),
    timeoutMs: clampInt('timeoutMs', input.timeoutMs, DEFAULT_CONFIG.timeoutMs, log),
    maxTokens: clampInt('maxTokens', input.maxTokens, DEFAULT_CONFIG.maxTokens, log),
    maxQuestionRounds: clampInt('maxQuestionRounds', input.maxQuestionRounds, DEFAULT_CONFIG.maxQuestionRounds, log),
    maxModelCalls: clampInt('maxModelCalls', input.maxModelCalls, DEFAULT_CONFIG.maxModelCalls, log),
    maxToolCalls: clampInt('maxToolCalls', input.maxToolCalls, DEFAULT_CONFIG.maxToolCalls, log),
    maxRoughChars: clampInt('maxRoughChars', input.maxRoughChars, DEFAULT_CONFIG.maxRoughChars, log),
    fileTools,
  }
}

/** True when a provider/model override is fully configured. */
export function hasModelOverride(config) {
  return Boolean(config && config.provider && config.model)
}
