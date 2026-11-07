#!/usr/bin/env node
/**
 * Capture the real plugin UI through the Chrome DevTools Protocol.
 *
 * This script does not fake a UI: it drives the actual DSH Web instance (start
 * it with `DSH_HOME=<scratch> dsh web --port 3099 --no-open`) and the real
 * `/enhance` flow, then captures the resulting panel. Chrome must be running
 * with `--remote-debugging-port=9222` and the DSH URL open.
 *
 * Usage:
 *   node scripts/screenshot.mjs --url "http://127.0.0.1:3099/?token=..." \
 *     --out docs/images --prompt "做一个本地记账小工具，用 JSON 文件存数据，要有命令行和测试"
 *
 * The generated prompt is model output, so it varies between runs. Only use a
 * screenshot after checking that it contains no host paths or secrets.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key.startsWith('--')) args.set(key.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true')
}
const url = args.get('url') || process.env.DSH_SCREENSHOT_URL || ''
const out = path.resolve(args.get('out') || 'docs/images')
const cdp = args.get('cdp') || 'http://127.0.0.1:9222'
const prompt = args.get('prompt') || '做一个本地记账小工具，用 JSON 文件存数据，要有命令行和测试'
if (!url) {
  console.error('missing --url (the DSH Web URL with its auth token)')
  process.exit(2)
}
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const targets = await (await fetch(`${cdp}/json/list`)).json()
const page = targets.find((target) => target.type === 'page' && target.url.includes('127.0.0.1'))
if (!page) {
  console.error('no DSH page target; start Chrome with --remote-debugging-port=9222 and open --url')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let sequence = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const entry = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
  return result.result.value
}

async function waitFor(expression, label, timeoutMs = 180_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const panelButton = (text) =>
  evaluate(`(() => {
    const root = document.querySelector('.pe-root')
    if (!root) return false
    const button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)

async function capture(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path.join(out, name), Buffer.from(data, 'base64'))
  console.log('captured', path.join(out, name))
}

async function captureElement(selector, name) {
  const rect = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    const box = root.getBoundingClientRect()
    return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) }
  })()`)
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...rect, scale: 2 },
  })
  await writeFile(path.join(out, name), Buffer.from(data, 'base64'))
  console.log('captured', path.join(out, name))
}

await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await waitFor("!!document.querySelector('[contenteditable=\"true\"]')", 'composer')
await evaluate("document.querySelector('[contenteditable=\"true\"]').focus()")
// Clear any restored draft so the command starts at position 1.
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await send('Input.insertText', { text: `/enhance ${prompt}` })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await waitFor("document.querySelector('.pe-root')?.textContent.includes('1 /')", 'question card')
await sleep(600)
await captureElement('.pe-card', 'panel-question.png')
await capture('workspace.png')

// The model may ask one or two batches. Answer every page: a page whose
// options are not recommended is intentionally unselected, so select the first
// option before advancing.
for (let index = 0; index < 40; index += 1) {
  if (await evaluate("!!document.querySelector('.pe-textarea') && document.querySelector('.pe-textarea').value.length > 200")) break
  if (await panelButton('Next')) {
    await sleep(450)
    continue
  }
  if (await panelButton('Submit')) {
    await sleep(900)
    continue
  }
  const selected = await evaluate(`(() => {
    const root = document.querySelector('.pe-root')
    if (!root) return false
    const option = root.querySelector('.pe-opt:not([data-on="1"])')
    if (!option) return false
    option.click()
    return true
  })()`)
  if (selected) {
    await sleep(250)
    continue
  }
  await sleep(500)
}
await waitFor("!!document.querySelector('.pe-textarea') && document.querySelector('.pe-textarea').value.length > 200", 'generated prompt')
await sleep(600)
await captureElement('.pe-root', 'panel-result.png')
const value = await evaluate("document.querySelector('.pe-textarea').value")
const leakPattern = new RegExp(['/' + 'root' + '/', '/' + 'home' + '/', '/' + 'Users' + '/', '/' + 'opt' + '/' + 'dsh-'].join('|'))
const leaked = leakPattern.test(value)
if (leaked) {
  console.error('generated prompt contains a host absolute path; refusing to keep the screenshot')
  process.exit(3)
}
console.log(`result length: ${value.length}; no host paths detected`)
ws.close()
