#!/usr/bin/env node
/**
 * Offline build/package sanity check.
 *
 * The plugin has no bundler: DSH composes the host entry from package.json and
 * serves lib/client.js to the browser module loader. "Build" therefore means:
 * every public file exists, the client bundle registers a valid factory, the
 * host modules import cleanly, and the version has one source of truth.
 */
import assert from 'node:assert/strict'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFile(path.join(root, file), 'utf8')
const exists = async (file) => {
  try {
    await access(path.join(root, file))
    return true
  } catch {
    return false
  }
}

const pkg = JSON.parse(await read('package.json'))
const version = await import(new URL('../lib/version.js', import.meta.url))
assert.equal(pkg.version, version.VERSION, 'package.json version must equal lib/version.js')
assert.equal(pkg.name, version.PLUGIN_NAME, 'package.json name must equal PLUGIN_NAME')
assert.equal(pkg.type, 'module')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)

for (const file of pkg.files) {
  assert.equal(await exists(file), true, `package.json files entry is missing: ${file}`)
}

const patch = await read('cordis.patch.yml')
assert.ok(patch.includes("name: 'dsh-prompt-enhance'"), 'cordis patch must mount dsh-prompt-enhance')

for (const locale of ['locale/en.json', 'locale/zh.json']) {
  const dict = JSON.parse(await read(locale))
  assert.equal(typeof dict.meta.title, 'string')
  assert.equal(typeof dict.meta.description, 'string')
}

// Load the browser bundle's registration wrapper in a minimal sandbox.
const clientSource = await read('lib/client.js')
let registration = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        registration = definition
      },
    },
  },
  console,
}
vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
assert.ok(registration, 'client bundle did not call window.__ModuleLoader__.load')
assert.equal(registration.id, pkg.name)
assert.equal(typeof registration.factory, 'function')
const reactStub = {
  createElement() {
    return {}
  },
  Fragment: {},
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  useState(value) {
    return [value, () => {}]
  },
  useSyncExternalStore() {
    return null
  },
}
const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected client require: ${specifier}`)
})
assert.ok(Array.isArray(clientExports.inject))
assert.equal(typeof clientExports.apply, 'function')
for (const service of ['slots', 'locale', 'sidebarRight']) {
  assert.ok(clientExports.inject.includes(service), `client inject must include ${service}`)
}

// Host modules must import without touching a live DSH context.
for (const file of ['lib/index.js', 'lib/engine.js', 'lib/http.js', 'lib/runs.js', 'lib/digest.js', 'lib/tools.js', 'lib/config.js']) {
  await import(new URL(`../${file}`, import.meta.url))
}
const host = await import(new URL('../lib/index.js', import.meta.url))
for (const service of ['commands', 'sessions', 'workingDirectory', 'llm', 'sessionController', 'webServer']) {
  assert.ok(host.inject.includes(service), `host inject must include ${service}`)
}

// README images must resolve, and stay under the repository image budget.
const readme = await read('README.md')
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
  const target = match[1]
  if (/^https?:/.test(target)) continue
  const clean = target.replace(/^\.\//, '')
  assert.equal(await exists(clean), true, `README image does not exist: ${target}`)
  const info = await stat(path.join(root, clean))
  assert.ok(info.size < 1024 * 1024, `README image is larger than 1 MiB: ${target}`)
}

const images = await readdir(path.join(root, 'docs/images')).catch(() => [])
assert.ok(images.filter((file) => file.endsWith('.png')).length >= 2, 'docs/images must contain at least two real screenshots')

console.log(`build ok — ${pkg.name} v${pkg.version}, ${images.filter((f) => f.endsWith('.png')).length} screenshots`)
