/**
 * Read-only workspace tools exposed to the enhancement model.
 *
 * The model may inspect the target session's working directory while drafting
 * a prompt (for example to match an existing CLI or test layout). Every path is
 * resolved through `ctx.fs` and must be contained by the session working
 * directory: the plugin never writes, never executes commands, and never
 * follows a path outside the workspace.
 *
 * The module is deliberately dependency-free. It takes the DSH filesystem
 * service as an argument so unit tests can supply an in-memory implementation.
 */

import path from 'node:path'

const MAX_READ_LINES = 400
const MAX_READ_CHARS = 16_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LIST_ENTRIES = 200
const MAX_GREP_MATCHES = 100
const MAX_GREP_FILES = 200
const MAX_GREP_BYTES = 2 * 1024 * 1024
const MAX_GREP_LINE = 300
const MAX_DEPTH = 6
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.turbo', '.cache'])
const SENSITIVE_NAMES = new Set(['.env', '.env.local', '.env.production', '.credentials.yaml', '.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519'])
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

function isSensitive(relativePath) {
  const name = relativePath.split('/').pop() || ''
  if (SENSITIVE_NAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  return SENSITIVE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))
}

/** @param {string} code @param {string} message */
function toolError(code, message) {
  return { ok: false, code, message }
}

function isInside(base, target, fs) {
  try {
    return fs.contains(base, target)
  } catch {
    return false
  }
}

function display(baseDisplay, target) {
  const value = target && typeof target.displayPath === 'string' ? target.displayPath : ''
  if (!value) return ''
  if (path.isAbsolute(value)) {
    const rel = path.relative(baseDisplay, value).split(path.sep).join('/')
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  }
  return value
}

function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function includeMatcher(include) {
  if (!include) return () => true
  const withDirectories = globToRegExp(include.includes('/') ? include : `**/${include}`)
  const basename = globToRegExp(include)
  return (relativePath) => withDirectories.test(relativePath) || basename.test(relativePath)
}

function normalizeArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

/**
 * Build the read-only tool suite.
 *
 * @param {any} fs DSH filesystem service (resolve/stat/readText/listDir/contains)
 * @param {any} [log]
 */
export function createFileTools(fs, log = null) {
  const available = Boolean(
    fs &&
      typeof fs.resolve === 'function' &&
      typeof fs.stat === 'function' &&
      typeof fs.readText === 'function' &&
      typeof fs.listDir === 'function' &&
      typeof fs.contains === 'function',
  )

  if (!available) {
    return {
      enabled: false,
      schemas: [],
      async execute() {
        return toolError('TOOLS_UNAVAILABLE', '当前部署没有可用的文件服务')
      },
    }
  }

  /**
   * Resolve a user-supplied path and prove it stays inside the session cwd.
   * Resolution follows symlinks, so the containment check is authoritative.
   */
  async function resolveWithin(cwd, requested, signal) {
    if (!cwd) return { error: toolError('NO_WORKDIR', '当前会话没有工作目录，文件工具不可用') }
    let base
    let target
    try {
      base = await fs.resolve(cwd, { signal })
      target = await fs.resolve(requested || '.', { cwd, signal })
    } catch (error) {
      return { error: toolError('NOT_FOUND', String(error && error.message ? error.message : error)) }
    }
    if (!isInside(base, target, fs)) {
      return { error: toolError('PATH_DENIED', '路径不在当前会话的工作目录内') }
    }
    return { base, target }
  }

  async function readFile(args, context) {
    const input = normalizeArgs(args)
    if (typeof input.path !== 'string' || !input.path.trim()) return toolError('INVALID_ARGS', 'read_file.path 必须是非空字符串')
    const offset = input.offset === undefined ? 1 : Number(input.offset)
    const limit = input.limit === undefined ? 200 : Number(input.limit)
    if (!Number.isInteger(offset) || offset < 1) return toolError('INVALID_ARGS', 'read_file.offset 必须是 ≥1 的整数')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LINES) {
      return toolError('INVALID_ARGS', `read_file.limit 必须是 1-${MAX_READ_LINES} 的整数`)
    }
    const requestedPath = input.path.split(path.sep).join('/')
    if (isSensitive(requestedPath)) return toolError('SENSITIVE_PATH', '该路径可能是密钥或环境文件，已拒绝读取')
    const resolved = await resolveWithin(context.cwd, input.path, context.signal)
    if (resolved.error) return resolved.error
    let info
    try {
      info = await fs.stat(resolved.target, context.signal)
    } catch (error) {
      return toolError('READ_FAILED', String(error && error.message ? error.message : error))
    }
    if (!info) return toolError('NOT_FOUND', `文件不存在：${input.path}`)
    if (info.type !== 'file') return toolError('NOT_A_FILE', `不是普通文件：${input.path}`)
    if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) {
      return toolError('FILE_TOO_LARGE', `文件超过 ${Math.round(MAX_FILE_BYTES / 1024)} KiB 上限`)
    }
    let text
    try {
      text = await fs.readText(resolved.target, context.signal)
    } catch (error) {
      return toolError('READ_FAILED', String(error && error.message ? error.message : error))
    }
    const allLines = String(text).split(/\r?\n/)
    const totalLines = allLines.length
    const start = offset - 1
    const selected = allLines.slice(start, start + limit)
    let content = selected.join('\n')
    let truncated = start + limit < totalLines
    if (content.length > MAX_READ_CHARS) {
      content = content.slice(0, MAX_READ_CHARS)
      truncated = true
    }
    return {
      ok: true,
      path: display(resolved.base.displayPath, resolved.target),
      startLine: offset,
      endLine: start + selected.length,
      totalLines,
      truncated,
      content,
    }
  }

  async function listDir(args, context) {
    const input = normalizeArgs(args)
    const requested = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
    const resolved = await resolveWithin(context.cwd, requested, context.signal)
    if (resolved.error) return resolved.error
    let info
    try {
      info = await fs.stat(resolved.target, context.signal)
    } catch (error) {
      return toolError('LIST_FAILED', String(error && error.message ? error.message : error))
    }
    if (!info) return toolError('NOT_FOUND', `目录不存在：${requested}`)
    if (info.type !== 'directory') return toolError('NOT_A_DIRECTORY', `不是目录：${requested}`)
    let entries
    try {
      entries = await fs.listDir(resolved.target, context.signal)
    } catch (error) {
      return toolError('LIST_FAILED', String(error && error.message ? error.message : error))
    }
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return {
      ok: true,
      path: display(resolved.base.displayPath, resolved.target),
      entries: sorted.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.type,
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      })),
      truncated: sorted.length > MAX_LIST_ENTRIES,
    }
  }

  async function grep(args, context) {
    const input = normalizeArgs(args)
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) return toolError('INVALID_ARGS', 'grep.pattern 必须是非空字符串')
    if (input.pattern.length > 200) return toolError('INVALID_ARGS', 'grep.pattern 最多 200 字符')
    let regex
    try {
      regex = new RegExp(input.pattern, input.ignoreCase === true ? 'i' : '')
    } catch (error) {
      return toolError('INVALID_PATTERN', `正则不合法：${String(error && error.message ? error.message : error)}`)
    }
    const requested = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
    const include = typeof input.include === 'string' ? input.include.trim() : ''
    const matches = []
    let scannedFiles = 0
    let scannedBytes = 0
    let truncated = false
    const matcher = includeMatcher(include)

    const resolved = await resolveWithin(context.cwd, requested, context.signal)
    if (resolved.error) return resolved.error

    async function scanFile(target, relativePath) {
      if (scannedFiles >= MAX_GREP_FILES || scannedBytes >= MAX_GREP_BYTES) {
        truncated = true
        return
      }
      if (context.signal?.aborted) return
      let info
      try {
        info = await fs.stat(target, context.signal)
      } catch {
        return
      }
      if (!info || info.type !== 'file') return
      if (typeof info.size === 'number' && info.size > 256 * 1024) return
      scannedFiles += 1
      scannedBytes += typeof info.size === 'number' ? info.size : 0
      let text
      try {
        text = await fs.readText(target, context.signal)
      } catch {
        return
      }
      if (text.includes('\u0000')) return
      const lines = String(text).split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!regex.test(lines[index])) continue
        matches.push({
          file: relativePath,
          line: index + 1,
          text: lines[index].trim().slice(0, MAX_GREP_LINE),
        })
        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true
          return
        }
      }
    }

    async function walk(target, relativeDir, depth) {
      if (truncated || depth > MAX_DEPTH || context.signal?.aborted) {
        truncated = true
        return
      }
      let entries
      try {
        entries = await fs.listDir(target, context.signal)
      } catch {
        return
      }
      for (const entry of entries) {
        if (truncated || context.signal?.aborted) return
        if (entry.type === 'directory') {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          if (!isInside(resolved.base, entry.target, fs)) continue
          await walk(entry.target, `${relativeDir}/${entry.name}`, depth + 1)
        } else if (entry.type === 'file') {
          const relativePath = `${relativeDir}/${entry.name}`.replace(/^\.\//, '')
          if (isSensitive(relativePath)) continue
          if (!matcher(relativePath)) continue
          if (!isInside(resolved.base, entry.target, fs)) continue
          await scanFile(entry.target, relativePath)
        }
      }
    }

    let info
    try {
      info = await fs.stat(resolved.target, context.signal)
    } catch (error) {
      return toolError('GREP_FAILED', String(error && error.message ? error.message : error))
    }
    if (!info) return toolError('NOT_FOUND', `路径不存在：${requested}`)
    if (info.type === 'file') {
      const relativePath = display(resolved.base.displayPath, resolved.target)
      if (isSensitive(relativePath)) return toolError('SENSITIVE_PATH', '该路径可能是密钥或环境文件，已拒绝读取')
      if (matcher(relativePath)) await scanFile(resolved.target, relativePath)
    } else if (info.type === 'directory') {
      await walk(resolved.target, '.', 0)
    } else {
      return toolError('NOT_A_FILE', `不是文件或目录：${requested}`)
    }

    log?.debug?.('prompt-enhance: grep scanned %d files / %d bytes', scannedFiles, scannedBytes)
    return { ok: true, pattern: input.pattern, matches, scannedFiles, scannedBytes, truncated }
  }

  async function execute(name, args, context) {
    if (context.signal?.aborted) return toolError('ABORTED', '请求已取消')
    if (name === 'read_file') return readFile(args, context)
    if (name === 'list_dir') return listDir(args, context)
    if (name === 'grep') return grep(args, context)
    return toolError('UNKNOWN_TOOL', `未知工具：${name}`)
  }

  return {
    enabled: true,
    schemas: [
      {
        name: 'read_file',
        description: '读取目标会话工作目录内的 UTF-8 文本文件，最多 400 行。用于核对现有代码、配置或文档。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500, description: '相对于工作目录的路径' },
            offset: { type: 'integer', minimum: 1, description: '起始行号，默认 1' },
            limit: { type: 'integer', minimum: 1, maximum: 400, description: '最多读取行数，默认 200' },
          },
        },
      },
      {
        name: 'list_dir',
        description: '列出目标会话工作目录内的一个目录，最多 200 项。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', maxLength: 500, description: '相对于工作目录的目录路径，默认 .' },
          },
        },
      },
      {
        name: 'grep',
        description: '在目标会话工作目录内按正则搜索文本文件，最多返回 100 条命中。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['pattern'],
          properties: {
            pattern: { type: 'string', minLength: 1, maxLength: 200 },
            path: { type: 'string', maxLength: 500, description: '搜索起点，默认 .' },
            include: { type: 'string', maxLength: 100, description: '文件名 glob，例如 *.js' },
            ignoreCase: { type: 'boolean' },
          },
        },
      },
    ],
    execute,
  }
}

/** Tool names the engine treats as read-only workspace tools. */
export const FILE_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grep'])

export const __test = { globToRegExp, includeMatcher, display, isSensitive, MAX_READ_CHARS, MAX_GREP_MATCHES }
