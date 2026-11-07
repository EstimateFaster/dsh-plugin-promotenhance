#!/usr/bin/env node
/**
 * Dependency-free static checks: syntax, version consistency, secrets/local
 * paths, placeholder markers, locale JSON and screenshot budget.
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFile(path.join(root, file), 'utf8')

async function walk(dir) {
  const out = []
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(relative)))
    else out.push(relative)
  }
  return out
}

const sourceFiles = [
  ...(await walk('lib')),
  ...(await walk('test')),
  ...(await walk('scripts')),
].filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
assert.ok(sourceFiles.length > 0)

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${file} failed node --check:\n${result.stderr}`)
}

const pkg = JSON.parse(await read('package.json'))
const { VERSION, PLUGIN_NAME } = await import(new URL('../lib/version.js', import.meta.url))
assert.equal(pkg.version, VERSION, 'package.json version differs from lib/version.js')
assert.equal(pkg.name, PLUGIN_NAME, 'package.json name differs from PLUGIN_NAME')

const textFiles = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'package.json',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  ...sourceFiles,
  ...(await walk('docs')).filter((file) => file.endsWith('.md')),
  ...(await walk('examples')),
]
const allText = new Map()
for (const file of textFiles) allText.set(file, await read(file))

const rootSegment = '/' + 'root' + '/'
const homeSegment = '/' + 'home' + '/[^/\\s]+/'
const optSegment = '/' + 'opt' + '/' + 'dsh-'
const absolutePath = new RegExp(`(?:^|[^A-Za-z0-9_])(?:${rootSegment}|${homeSegment}|${optSegment})`)
const secret = /(?:sk-[A-Za-z0-9_-]{16,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|DEEPSEEK_API_KEY\s*=\s*\S+)/
for (const [file, text] of allText) {
  assert.equal(absolutePath.test(text), false, `${file} contains a local absolute path`)
  assert.equal(secret.test(text), false, `${file} appears to contain a credential`)
}

for (const file of ['lib/index.js', 'lib/engine.js', 'lib/http.js', 'lib/runs.js', 'lib/digest.js', 'lib/tools.js', 'lib/client.js']) {
  const text = await read(file)
  assert.equal(/\b(?:TODO|FIXME|XXX)\b/.test(text), false, `${file} contains a placeholder marker`)
}

for (const file of ['locale/en.json', 'locale/zh.json']) {
  const dict = JSON.parse(await read(file))
  assert.equal(typeof dict.meta.description, 'string')
}

const imagesDir = path.join(root, 'docs/images')
const images = (await readdir(imagesDir).catch(() => [])).filter((file) => file.endsWith('.png'))
assert.ok(images.length >= 2, 'docs/images must contain at least two PNG screenshots')
for (const image of images) {
  const info = await stat(path.join(imagesDir, image))
  assert.ok(info.size > 1024, `${image} looks empty`)
  assert.ok(info.size < 1024 * 1024, `${image} exceeds 1 MiB`)
}

console.log(`lint ok — ${sourceFiles.length} source files, ${images.length} screenshots, v${VERSION}`)
