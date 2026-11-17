/**
 * Pure helpers for reading an electron-builder update feed and comparing versions.
 *
 * The feed is a small YAML document written by electron-builder:
 *
 *   version: 0.2.2-rc.3
 *   files:
 *     - url: https://…/deepseek-harness-0.2.2-rc.3-win-x64.exe
 *       size: 299595752
 *       sha512: GiJf…
 *   path: https://…/deepseek-harness-0.2.2-rc.3-win-x64.exe
 *   sha512: GiJf…
 *   stagingPercentage: 100
 *   releaseDate: '2026-11-13T07:31:42.937Z'
 *
 * A full YAML engine would be a runtime dependency; this reader implements exactly the
 * subset the updater emits (block mappings, block sequences, folded/literal scalars and
 * quoted strings) and rejects nothing it does not understand — unknown keys are ignored.
 * It is deliberately dependency free so the bundle installs without a package manager.
 */

/**
 * Parse one scalar written by builder-util.
 * @param {string} raw - Text after the colon, already trimmed.
 * @returns {string|number|boolean|null} The scalar value.
 */
function parseScalar(raw) {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) {
    const value = Number(text)
    return Number.isSafeInteger(value) ? value : text
  }
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if (first === "'" && last === "'") return text.slice(1, -1).replaceAll("''", "'")
    if (first === '"' && last === '"') {
      try {
        return JSON.parse(text)
      } catch {
        return text.slice(1, -1)
      }
    }
  }
  return text
}

/** Whether a line is blank or a comment. */
function isIgnorable(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** Indentation width of a line (tabs are not emitted by builder-util). */
function indentOf(line) {
  let index = 0
  while (index < line.length && line[index] === ' ') index += 1
  return index
}

/**
 * Read a folded (`>`) or literal (`|`) block that follows a `key: >-` line.
 * @param {string[]} lines - All lines.
 * @param {number} start - Index of the first line after the key line.
 * @param {number} parentIndent - Indentation of the key line.
 * @returns {{text: string, next: number}} Block text and the first index past it.
 */
function readBlockScalar(lines, start, parentIndent) {
  const body = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      body.push('')
      index += 1
      continue
    }
    if (indentOf(line) <= parentIndent) break
    body.push(line.trim())
    index += 1
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return { text: body.join(' ').trim(), next: index }
}

/**
 * Parse a block value (mapping or sequence) at one indentation level.
 * @param {string[]} lines - All lines.
 * @param {number} start - First index to read.
 * @param {number} indent - Exact indentation owned by this block.
 * @returns {{value: unknown, next: number}} Parsed value and the first index past the block.
 */
function parseBlock(lines, start, indent) {
  let index = start
  while (index < lines.length && isIgnorable(lines[index])) index += 1
  if (index >= lines.length) return { value: null, next: index }
  const first = lines[index]
  if (indentOf(first) < indent) return { value: null, next: index }
  if (first.trimStart().startsWith('- ')) return parseSequence(lines, index, indent)
  return parseMapping(lines, index, indent)
}

/**
 * Parse a block mapping.
 * @param {string[]} lines - All lines.
 * @param {number} start - First index (at `indent`).
 * @param {number} indent - Mapping indentation.
 * @returns {{value: Record<string, unknown>, next: number}} The mapping.
 */
function parseMapping(lines, start, indent) {
  const value = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (isIgnorable(line)) {
      index += 1
      continue
    }
    if (indentOf(line) !== indent) break
    const text = line.trimStart()
    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(text)
    if (match === null) break
    const key = match[1]
    const rest = (match[2] ?? '').trim()
    index += 1
    if (/^[>|][+-]?$/.test(rest)) {
      const block = readBlockScalar(lines, index, indent)
      value[key] = block.text
      index = block.next
      continue
    }
    if (rest === '') {
      // A nested block starts on the next non-empty line with deeper indentation.
      let lookahead = index
      while (lookahead < lines.length && isIgnorable(lines[lookahead])) lookahead += 1
      if (lookahead < lines.length && indentOf(lines[lookahead]) > indent) {
        const nested = parseBlock(lines, lookahead, indentOf(lines[lookahead]))
        value[key] = nested.value
        index = nested.next
      } else {
        value[key] = null
      }
      continue
    }
    value[key] = parseScalar(rest)
  }
  return { value, next: index }
}

/**
 * Parse a block sequence of mappings (the `files:` list).
 * @param {string[]} lines - All lines.
 * @param {number} start - First index (at `indent`, beginning with `- `).
 * @param {number} indent - Sequence indentation.
 * @returns {{value: Record<string, unknown>[], next: number}} The sequence.
 */
function parseSequence(lines, start, indent) {
  const value = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (isIgnorable(line)) {
      index += 1
      continue
    }
    if (indentOf(line) !== indent || !line.trimStart().startsWith('- ')) break
    const firstText = line.trimStart().slice(2).trim()
    const item = {}
    let itemIndent = indent + 2
    if (firstText !== '') {
      const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(firstText)
      if (match === null) {
        value.push(parseScalar(firstText))
        index += 1
        continue
      }
      const rest = (match[2] ?? '').trim()
      index += 1
      if (/^[>|][+-]?$/.test(rest)) {
        const block = readBlockScalar(lines, index, itemIndent)
        item[match[1]] = block.text
        index = block.next
      } else {
        item[match[1]] = parseScalar(rest)
      }
    } else {
      index += 1
      let lookahead = index
      while (lookahead < lines.length && isIgnorable(lines[lookahead])) lookahead += 1
      if (lookahead < lines.length && indentOf(lines[lookahead]) > indent) itemIndent = indentOf(lines[lookahead])
    }
    // Remaining keys of this item sit deeper than the dash.
    while (index < lines.length) {
      const nextLine = lines[index]
      if (isIgnorable(nextLine)) {
        index += 1
        continue
      }
      if (indentOf(nextLine) <= indent) break
      const text = nextLine.trimStart()
      const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(text)
      if (match === null) break
      const rest = (match[2] ?? '').trim()
      index += 1
      if (/^[>|][+-]?$/.test(rest)) {
        const block = readBlockScalar(lines, index, indentOf(nextLine))
        item[match[1]] = block.text
        index = block.next
      } else {
        item[match[1]] = parseScalar(rest)
      }
    }
    value.push(item)
  }
  return { value, next: index }
}

/**
 * Parse a YAML mapping written by electron-builder. Unknown keys are kept.
 * @param {string} source - Raw YAML text.
 * @returns {Record<string, unknown>} The top-level mapping.
 */
export function parseYamlMapping(source) {
  const lines = String(source).replace(/\r\n?/gu, '\n').split('\n')
  const parsed = parseBlock(lines, 0, 0)
  const raw = parsed.value
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('update feed is not a YAML mapping')
  }
  return /** @type {Record<string, unknown>} */ (raw)
}

/**
 * Parse an electron-builder update document.
 * @param {string} source - Raw YAML text.
 * @returns {{version?: string, files?: Array<Record<string, unknown>>, path?: string, sha512?: string, stagingPercentage?: number, releaseDate?: string, url?: string, channel?: string}} The document.
 */
export function parseFeedYaml(source) {
  const document = parseYamlMapping(source)
  const result = {}
  if (typeof document.version === 'string') result.version = document.version.trim()
  if (typeof document.url === 'string') result.url = document.url.trim()
  if (typeof document.channel === 'string') result.channel = document.channel.trim()
  if (typeof document.path === 'string') result.path = document.path.trim()
  if (typeof document.sha512 === 'string') result.sha512 = document.sha512.trim()
  if (typeof document.releaseDate === 'string') result.releaseDate = document.releaseDate.trim()
  if (document.stagingPercentage !== undefined && document.stagingPercentage !== null) {
    const percentage = Number(document.stagingPercentage)
    if (Number.isFinite(percentage)) result.stagingPercentage = percentage
  }
  if (Array.isArray(document.files)) {
    result.files = document.files
      .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        url: typeof item.url === 'string' ? item.url.trim() : undefined,
        size: item.size === undefined ? undefined : Number(item.size),
        sha512: typeof item.sha512 === 'string' ? item.sha512.trim() : undefined,
      }))
  }
  return result
}

/**
 * Split a semantic version into its numeric core and prerelease identifiers.
 * @param {string} version - Version such as `0.2.2-rc.3`.
 * @returns {{core: number[], prerelease: string[]}|null} Parsed parts, or null when invalid.
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(version).trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two semantic versions with semver precedence rules.
 * @param {string} left - Left version.
 * @param {string} right - Right version.
 * @returns {number} Negative when left is older, positive when newer.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) throw new Error(`cannot compare versions "${left}" and "${right}"`)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index]
    const two = b.prerelease[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const oneNumeric = /^\d+$/u.test(one)
    const twoNumeric = /^\d+$/u.test(two)
    if (oneNumeric && twoNumeric) return Number(one) - Number(two)
    if (oneNumeric) return -1
    if (twoNumeric) return 1
    return one < two ? -1 : 1
  }
  return 0
}

/**
 * Whether `candidate` is strictly newer than `current`.
 * @param {string} candidate - Feed version.
 * @param {string} current - Installed version.
 * @returns {boolean} True when the feed carries a newer build.
 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * Absolute URL for a feed-relative file reference.
 * @param {string} baseUrl - Feed directory URL ending with `/`.
 * @param {string} reference - Absolute or relative file URL.
 * @returns {string} The absolute URL.
 */
export function resolveFeedFileUrl(baseUrl, reference) {
  try {
    return new URL(reference, baseUrl).toString()
  } catch {
    return reference
  }
}
