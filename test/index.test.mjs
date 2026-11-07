import test from 'node:test'
import assert from 'node:assert/strict'

import { injectToken, __test } from '../lib/index.js'

test('injectToken inserts the meta tag before </head>', () => {
  const html = injectToken('<!doctype html><html><head><title>x</title></head><body></body></html>', 'abc123')
  assert.match(html, /<meta name="dsh-prompt-enhance-token" content="abc123"><\/head>/)
})

test('injectToken prepends when the document has no head', () => {
  const html = injectToken('<body></body>', 'abc123')
  assert.ok(html.startsWith('<meta name="dsh-prompt-enhance-token" content="abc123">'))
})

test('the token meta name is stable', () => {
  assert.equal(__test.TOKEN_META, 'dsh-prompt-enhance-token')
})
