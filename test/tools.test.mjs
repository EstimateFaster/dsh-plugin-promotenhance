import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { createFileTools, FILE_TOOL_NAMES, __test } from '../lib/tools.js'

const ROOT = '/workspace'

function makeFs(files) {
  const fileMap = new Map()
  const dirs = new Set([ROOT])
  for (const [name, content] of Object.entries(files)) {
    const absolute = path.join(ROOT, name)
    fileMap.set(absolute, content)
    let parent = path.dirname(absolute)
    while (parent.startsWith(ROOT)) {
      dirs.add(parent)
      if (parent === ROOT) break
      parent = path.dirname(parent)
    }
  }
  const target = (value) => ({ targetKey: value, displayPath: value })
  return {
    async resolve(requested, options = {}) {
      return target(path.resolve(options.cwd || ROOT, requested))
    },
    async stat(input) {
      if (fileMap.has(input.targetKey)) {
        return { type: 'file', size: Buffer.byteLength(fileMap.get(input.targetKey)) }
      }
      if (dirs.has(input.targetKey)) return { type: 'directory' }
      return undefined
    },
    async readText(input) {
      if (!fileMap.has(input.targetKey)) throw new Error('ENOENT')
      return fileMap.get(input.targetKey)
    },
    async listDir(input) {
      if (!dirs.has(input.targetKey)) throw new Error('ENOTDIR')
      const entries = []
      for (const file of fileMap.keys()) {
        if (path.dirname(file) === input.targetKey) {
          entries.push({ name: path.basename(file), type: 'file', target: target(file), size: Buffer.byteLength(fileMap.get(file)) })
        }
      }
      for (const dir of dirs) {
        if (dir !== input.targetKey && path.dirname(dir) === input.targetKey) {
          entries.push({ name: path.basename(dir), type: 'directory', target: target(dir) })
        }
      }
      return entries
    },
    contains(parent, child) {
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + path.sep)
    },
  }
}

const files = {
  'README.md': '# Demo\nneedle here\nthird line\n',
  'src/a.js': 'export const needle = 1\n',
  'src/nested/b.js': 'needle\n',
  'node_modules/pkg.js': 'needle\n',
  '.env': 'SECRET=1\n',
  'secret.key': 'shh\n',
}

test('read_file returns a relative path and respects offset/limit', async () => {
  const tools = createFileTools(makeFs(files))
  const result = await tools.execute('read_file', { path: 'README.md', offset: 2, limit: 1 }, { cwd: ROOT })
  assert.equal(result.ok, true)
  assert.equal(result.path, 'README.md')
  assert.equal(result.content, 'needle here')
  assert.equal(result.startLine, 2)
  assert.equal(result.totalLines, 4)
  assert.equal(result.truncated, true)
})

test('read_file rejects traversal, sensitive files and directories', async () => {
  const tools = createFileTools(makeFs(files))
  const traversal = await tools.execute('read_file', { path: '../secret' }, { cwd: ROOT })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.code, 'PATH_DENIED')
  const env = await tools.execute('read_file', { path: '.env' }, { cwd: ROOT })
  assert.equal(env.code, 'SENSITIVE_PATH')
  const key = await tools.execute('read_file', { path: 'secret.key' }, { cwd: ROOT })
  assert.equal(key.code, 'SENSITIVE_PATH')
  const dir = await tools.execute('read_file', { path: 'src' }, { cwd: ROOT })
  assert.equal(dir.code, 'NOT_A_FILE')
  const missing = await tools.execute('read_file', { path: 'nope.txt' }, { cwd: ROOT })
  assert.equal(missing.code, 'NOT_FOUND')
})

test('list_dir sorts directories first and reports the relative path', async () => {
  const tools = createFileTools(makeFs(files))
  const result = await tools.execute('list_dir', { path: 'src' }, { cwd: ROOT })
  assert.equal(result.ok, true)
  assert.equal(result.path, 'src')
  assert.deepEqual(result.entries.map((entry) => `${entry.type}:${entry.name}`), ['directory:nested', 'file:a.js'])
})

test('grep searches the workspace, skips node_modules and sensitive files, and honors include', async () => {
  const tools = createFileTools(makeFs(files))
  const all = await tools.execute('grep', { pattern: 'needle' }, { cwd: ROOT })
  assert.equal(all.ok, true)
  assert.deepEqual(all.matches.map((match) => match.file).sort(), ['README.md', 'src/a.js', 'src/nested/b.js'])
  const js = await tools.execute('grep', { pattern: 'needle', include: '*.js' }, { cwd: ROOT })
  assert.deepEqual(js.matches.map((match) => match.file).sort(), ['src/a.js', 'src/nested/b.js'])
  const secret = await tools.execute('grep', { pattern: 'SECRET' }, { cwd: ROOT })
  assert.equal(secret.matches.length, 0)
})

test('grep reports invalid regular expressions and invalid arguments', async () => {
  const tools = createFileTools(makeFs(files))
  const bad = await tools.execute('grep', { pattern: '[' }, { cwd: ROOT })
  assert.equal(bad.code, 'INVALID_PATTERN')
  const missing = await tools.execute('grep', {}, { cwd: ROOT })
  assert.equal(missing.code, 'INVALID_ARGS')
  const readBad = await tools.execute('read_file', { path: 'README.md', limit: 9999 }, { cwd: ROOT })
  assert.equal(readBad.code, 'INVALID_ARGS')
})

test('tools are disabled without a filesystem service', async () => {
  const tools = createFileTools(null)
  assert.equal(tools.enabled, false)
  assert.deepEqual(tools.schemas, [])
  const result = await tools.execute('read_file', { path: 'x' }, { cwd: ROOT })
  assert.equal(result.code, 'TOOLS_UNAVAILABLE')
})

test('the exported tool names match the schemas', () => {
  const tools = createFileTools(makeFs(files))
  assert.deepEqual(new Set(tools.schemas.map((schema) => schema.name)), FILE_TOOL_NAMES)
  assert.equal(__test.isSensitive('config/.env'), true)
  assert.equal(__test.isSensitive('src/app.js'), false)
  assert.equal(__test.globToRegExp('*.js').test('a.js'), true)
})
