import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, normalizeConfig, hasModelOverride } from '../lib/config.js'

test('normalizeConfig returns safe defaults for an empty profile row', () => {
  const config = normalizeConfig({})
  assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(config.maxTokens, DEFAULT_CONFIG.maxTokens)
  assert.equal(config.maxQuestionRounds, 2)
  assert.equal(config.maxModelCalls, 10)
  assert.equal(config.maxToolCalls, 12)
  assert.equal(config.fileTools, true)
  assert.equal(hasModelOverride(config), false)
})

test('normalizeConfig clamps numeric settings and reports the clamp', () => {
  const warnings = []
  const config = normalizeConfig(
    { timeoutMs: 1, maxTokens: 999999, maxQuestionRounds: -2, maxModelCalls: 1, maxToolCalls: 999, maxRoughChars: 3 },
    { warn: (...args) => warnings.push(args.join(' ')) },
  )
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.maxTokens, 32000)
  assert.equal(config.maxQuestionRounds, 0)
  assert.equal(config.maxModelCalls, 2)
  assert.equal(config.maxToolCalls, 50)
  assert.equal(config.maxRoughChars, 256)
  assert.equal(warnings.length, 6)
})

test('normalizeConfig only accepts a complete provider/model pair', () => {
  const warnings = []
  const partial = normalizeConfig({ provider: 'deepseek' }, { warn: (...args) => warnings.push(args.join(' ')) })
  assert.equal(partial.provider, '')
  assert.equal(partial.model, '')
  assert.equal(warnings.length, 1)
  const complete = normalizeConfig({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(hasModelOverride(complete), true)
  assert.equal(complete.reasoningEffort, 'high')
})

test('normalizeConfig ignores arrays and non-integer values', () => {
  const config = normalizeConfig([1, 2, 3])
  assert.equal(config.maxTokens, DEFAULT_CONFIG.maxTokens)
  const warnings = []
  const bad = normalizeConfig({ maxTokens: 1.5, fileTools: false }, { warn: (...args) => warnings.push(args.join(' ')) })
  assert.equal(bad.maxTokens, DEFAULT_CONFIG.maxTokens)
  assert.equal(bad.fileTools, false)
  assert.equal(warnings.length, 1)
})
