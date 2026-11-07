#!/usr/bin/env node
/**
 * Render the *real* `npm test` output to a PNG for the README.
 *
 * The text is captured from the actual test run; only the terminal frame is
 * styled. No output is invented. Requires Google Chrome (or CHROME_BIN).
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = process.env.CHROME_BIN || 'google-chrome'
const out = path.join(root, 'docs/images/tests.png')

const result = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const output = `${result.stdout || ''}${result.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
if (result.status !== 0) {
  console.error(output)
  console.error('npm test failed; refusing to render a misleading screenshot')
  process.exit(1)
}

const escape = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
const lines = output.split('\n')
const height = Math.max(720, Math.min(1700, 180 + lines.length * 21))
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 36px; background: #0b0f17; color: #d7e0ee;
         font-family: "SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace; }
  .window { max-width: 1120px; margin: 0 auto; border: 1px solid #263041; border-radius: 14px;
            background: #0f1520; box-shadow: 0 24px 70px rgba(0,0,0,.45); overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; background: #141c2a;
         border-bottom: 1px solid #263041; color: #8ea0b8; font-size: 13px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #2a3445; }
  .title { margin-left: 6px; letter-spacing: .02em; }
  .cmd { padding: 18px 22px 6px; color: #8bd5a5; font-size: 14px; }
  .cmd b { color: #d7e0ee; font-weight: 600; }
  pre { margin: 0; padding: 10px 22px 24px; font: inherit; font-size: 13.5px; line-height: 1.55;
        white-space: pre-wrap; word-break: break-word; }
  .ok { color: #8bd5a5; } .fail { color: #ff8a8a; } .muted { color: #8ea0b8; }
  .footer { padding: 10px 22px 18px; border-top: 1px solid #222c3b; color: #7f91aa; font-size: 12px; }
</style></head><body>
  <div class="window">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="title">dsh-prompt-enhance — verification</span></div>
    <div class="cmd">$ <b>npm test</b></div>
    <pre>${escape(output)}</pre>
    <div class="footer">Real output of the local test suite · node ${process.version} · ${new Date().toISOString().slice(0, 10)}</div>
  </div>
</body></html>`

const dir = await mkdtemp(path.join(os.tmpdir(), 'pe-terminal-'))
const htmlPath = path.join(dir, 'terminal.html')
await writeFile(htmlPath, html)
const profile = path.join(dir, 'chrome')
const shot = spawnSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  `--user-data-dir=${profile}`,
  `--window-size=1200,${height}`,
  `--screenshot=${out}`,
  `file://${htmlPath}`,
], { encoding: 'utf8' })
try {
  await readFile(out)
} catch {
  console.error(shot.stderr || shot.stdout || 'chrome screenshot failed')
  await rm(dir, { recursive: true, force: true })
  process.exit(1)
}
await rm(dir, { recursive: true, force: true })
console.log(`rendered ${path.relative(root, out)} (${output.split('\n').length} lines)`)
