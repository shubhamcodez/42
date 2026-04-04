/**
 * Build the same style of markdown snapshot as backend tools/project_repository.py,
 * from files the user selected in the browser (no server path required).
 */

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'target',
  '.idea',
  '.vs',
  '__MACOSX',
  '.gradle',
  '.cargo',
])

const TEXT_SUFFIXES = new Set([
  '.py',
  '.pyi',
  '.md',
  '.txt',
  '.rst',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.dockerignore',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.env.example',
])

const SPECIAL_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'copying',
  'gemfile',
  'rakefile',
  'cargo.toml',
  'cargo.lock',
  'pyproject.toml',
  'poetry.lock',
  'composer.json',
  'package.json',
  'go.mod',
  'go.sum',
])

const MAX_INDEX_LINES = 1200
const MAX_DEPTH = 14
const MAX_FILES_WITH_BODY = 72
const MAX_BYTES_PER_FILE = 36_000
const MAX_TOTAL_SNAPSHOT_CHARS = 28_000

function shouldSkipRelativePath(rel) {
  const parts = rel.split('/').filter(Boolean)
  if (parts.length > MAX_DEPTH + 1) return true
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (SKIP_DIR_NAMES.has(p) || p.startsWith('.')) return true
  }
  return false
}

function wantFileBody(rel) {
  const base = rel.split('/').pop()?.toLowerCase() || ''
  if (SPECIAL_FILENAMES.has(base)) return true
  const dot = base.lastIndexOf('.')
  const suf = dot >= 0 ? base.slice(dot) : ''
  return TEXT_SUFFIXES.has(suf)
}

async function readTextLimited(file, limit) {
  const slice = file.slice(0, limit)
  const buf = await slice.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.indexOf(0) !== -1 && bytes.indexOf(0) < 8192) return ''
  const dec = new TextDecoder('utf-8', { fatal: false })
  return dec.decode(bytes)
}

async function filePeekLine(file) {
  const slice = file.slice(0, 512)
  const buf = await slice.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.indexOf(0) !== -1 && bytes.indexOf(0) < 2048) return '[binary]'
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const line = text.split(/\r?\n/)[0]?.trim() || ''
  if (!line && file.size === 0) return '[empty]'
  if (!line) return '[empty line]'
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

/** @param {{ rel: string, file: File }[]} records rel paths without root prefix */
async function assembleMarkdown(rootLabel, rootOnDiskLine, prefix, records) {
  const sorted = [...records].sort((a, b) => a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' }))
  const dirSet = new Set()
  for (const { rel } of sorted) {
    const parts = rel.split('/').filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      dirSet.add(`${parts.slice(0, i + 1).join('/')}/`)
    }
  }
  const subdirLinesFull = Array.from(dirSet)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((d) => `${prefix}${d}`)

  const fileMetaFull = []
  for (const { rel, file } of sorted) {
    const base = rel.split('/').pop() || ''
    if (base.startsWith('.')) continue
    const posix = rel
    const peek = file.size === 0 ? '[empty]' : await filePeekLine(file)
    const sizeNote = `${file.size} bytes`
    fileMetaFull.push({
      sort: posix.toLowerCase(),
      line: `${prefix}${posix} | ${sizeNote} | ${peek}`,
      rel: posix,
      file,
    })
  }
  fileMetaFull.sort((a, b) => a.sort.localeCompare(b.sort))

  let subdirLines = subdirLinesFull
  let fileMeta = fileMetaFull
  let truncatedTree = subdirLinesFull.length + fileMetaFull.length > MAX_INDEX_LINES
  if (truncatedTree) {
    const budget = MAX_INDEX_LINES
    subdirLines = subdirLinesFull.slice(0, budget)
    const rest = Math.max(0, budget - subdirLines.length)
    fileMeta = fileMetaFull.slice(0, rest)
  }

  const lines = [
    '# Imported project repository',
    `**Root on disk:** ${rootOnDiskLine}`,
    `**Tree root label:** \`${rootLabel}\``,
    '',
    '_(Index is a path tree + file stats/peek; excerpts follow. Sandbox Python cannot open files on disk.)_',
    '',
    '## Repository tree (recursive index)',
    '',
    prefix,
    '',
  ]

  for (const row of subdirLines) lines.push(row)
  if (subdirLines.length) lines.push('')

  for (const { line } of fileMeta) lines.push(line)

  if (truncatedTree) {
    lines.push('')
    lines.push('_(Tree index truncated; narrow the folder or exclude large trees.)_')
  }

  lines.push('', '## File excerpts', '')

  let used = lines.join('\n').length + lines.length
  let bodies = 0
  const excerptCandidates = sorted.map(({ rel, file }) => ({ rel, file })).sort((a, b) =>
    a.rel.replace(/\\/g, '/').toLowerCase().localeCompare(b.rel.replace(/\\/g, '/').toLowerCase()),
  )

  for (const { rel, file } of excerptCandidates) {
    if (bodies >= MAX_FILES_WITH_BODY) {
      lines.push('_(More files omitted; excerpt limit reached.)_')
      break
    }
    if (!wantFileBody(rel)) continue
    const text = (await readTextLimited(file, MAX_BYTES_PER_FILE)).trim()
    if (!text) continue
    const heading = `### \`${prefix}${rel}\``
    const chunk = `${heading}\n\n\`\`\`\n${text}\n\`\`\`\n\n`
    if (used + chunk.length > MAX_TOTAL_SNAPSHOT_CHARS) {
      lines.push('_(Snapshot size limit reached; remaining files omitted.)_')
      break
    }
    lines.push(chunk)
    used += chunk.length + 1
    bodies += 1
  }

  let out = lines.join('\n').trim()
  if (out.length > MAX_TOTAL_SNAPSHOT_CHARS) {
    out = `${out.slice(0, MAX_TOTAL_SNAPSHOT_CHARS - 20).trim()}\n\n_(truncated)_`
  }
  return out
}

/**
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} rootLabel
 */
export async function buildSnapshotFromDirectoryHandle(dirHandle, rootLabel) {
  const records = []

  async function walk(handle, pathPrefix, depth) {
    for await (const entry of handle.values()) {
      const name = entry.name
      if (entry.kind === 'directory') {
        if (SKIP_DIR_NAMES.has(name) || name.startsWith('.')) continue
        if (depth >= MAX_DEPTH) continue
        await walk(entry, `${pathPrefix}${name}/`, depth + 1)
      } else {
        if (name.startsWith('.')) continue
        const rel = `${pathPrefix}${name}`.replace(/\/+$/, '')
        if (shouldSkipRelativePath(rel)) continue
        const file = await entry.getFile()
        records.push({ rel, file })
      }
    }
  }

  await walk(dirHandle, '', 0)
  const prefix = `${rootLabel}/`
  const rootOnDiskLine =
    '_(Opened from this computer in the browser — the real path is not exposed to the page.)_'
  return assembleMarkdown(rootLabel, rootOnDiskLine, prefix, records)
}

/** @param {FileList | File[]} fileList from <input webkitdirectory> */
export async function buildSnapshotFromFileList(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return ''

  const first = files[0].webkitRelativePath?.replace(/\\/g, '/') || ''
  if (!first) {
    throw new Error('Folder pick is not supported in this browser (missing webkitRelativePath).')
  }
  const rootLabel = first.split('/')[0]
  const records = []

  for (const file of files) {
    let rel = file.webkitRelativePath?.replace(/\\/g, '/') || ''
    if (!rel.startsWith(`${rootLabel}/`)) continue
    rel = rel.slice(rootLabel.length + 1)
    if (!rel || shouldSkipRelativePath(rel)) continue
    const base = rel.split('/').pop() || ''
    if (base.startsWith('.')) continue
    records.push({ rel, file })
  }

  const prefix = `${rootLabel}/`
  const rootOnDiskLine =
    '_(Opened from this computer in the browser — the real path is not exposed to the page.)_'
  return assembleMarkdown(rootLabel, rootOnDiskLine, prefix, records)
}

export function canUseDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}
