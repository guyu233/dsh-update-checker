/**
 * dsh-update-checker — read the desktop upstream feed directly.
 *
 * The packaged updater drops a build when this machine's anonymous staging id
 * falls outside `stagingPercentage`. The feed itself still lists that build.
 * This plugin compares versions only: the percentage is reported, never applied.
 * Download and install run only after the user confirms in the desktop UI.
 * There is no agent tool that can start the installer.
 *
 * @module dsh-update-checker
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { compareVersions, isNewerVersion, parseFeedYaml, resolveFeedFileUrl } from './lib/feed.js'
import { ALPHA_REPO, buildBuildPrompt, checkSourcePath, parseTagRefs, sameRepository, selectNewestAlpha } from './lib/alpha.js'

/**
 * Load a DSH package this plugin extends. A linked directory install keeps its own
 * `node_modules`, so bare specifiers resolve through the running installation's
 * resolution layer; an unpacked or relocated desktop build is served by the explicit
 * `app.asar` fallback, which is only attempted when the specifier does not resolve.
 * @param {string} name - Package name, such as `@deepseek-ai/cordis`.
 * @param {string} relative - ESM entry inside that package, used by the fallback.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
async function importDesktopPackage(name, relative) {
  try {
    return await import(name)
  } catch (error) {
    // Only an unresolved specifier of this package earns the fallback; a missing
    // dependency inside a package that did resolve must surface unchanged.
    const unresolved = error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(`'${name}'`)
    if (!unresolved) throw error
    const file = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', name, relative)
    return import(pathToFileURL(file).href)
  }
}

const [{ Service }, tools, schema] = await Promise.all([
  importDesktopPackage('@deepseek-ai/cordis', 'lib/index.js'),
  importDesktopPackage('@deepseek-ai/dsh-tools', 'lib/index.js'),
  importDesktopPackage('@deepseek-ai/schemastery', 'lib/index.mjs'),
])
const { defineTool } = tools
const z = schema.default

export const name = 'dsh-update-checker'
export const inject = ['configEditor', 'tools']

/** `launch` checks once per desktop start; `daily` at most once each 24 hours; `off` only when asked. */
export const Config = z.object({
  cadence: z.string().default('launch').volatile(),
  /** Alpha monitoring reads the GitHub tags of the upstream repository. */
  alphaEnabled: z.boolean().default(false).volatile(),
  /** Source checkout, toolchain hints, and post-install cleanup. */
  source: z.object({
    directory: z.string().default('').volatile(),
    nodePath: z.string().default('').volatile(),
    registry: z.string().default('').volatile(),
    certificateFile: z.string().default('').volatile(),
    signTool: z.string().default('').volatile(),
    keyContainer: z.string().default('').volatile(),
    signatureCacheDir: z.string().default('').volatile(),
    deleteInstaller: z.boolean().default(false).volatile(),
    deleteSource: z.boolean().default(false).volatile(),
  }),
})

const PACKAGE = 'dsh-update-checker'
const DAY_MS = 24 * 60 * 60 * 1000
const FEED_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const HANDOFF_MINUTES = 30
const GIT_TIMEOUT_MS = 5 * 60 * 1000
const TAG_TIMEOUT_MS = 30_000
const ALPHA_TIMEOUT_MS = 20 * 60 * 1000

/** @type {import('@deepseek-ai/cordis').Context | null} */
let hostContext = null
/** @type {Record<string, unknown>} */
let activationConfig = {}

/** In-memory view returned to the settings row and the check tool. */
let view = emptyView()
/** Alpha check and hand-off state, kept in memory; durable facts live in state.json. */
let alphaView = emptyAlphaView()
/** True after this process has already run its automatic check. */
let sessionChecked = false
/** True after this process has already run its automatic alpha check. */
let alphaSessionChecked = false
/** Set synchronously so overlapping status calls cannot start two automatic checks. */
let autoGate = false
/** Alpha counterpart of autoGate. */
let alphaAutoGate = false
/** Guards the install-settled cleanup so one process does not repeat git work. */
let alphaSettleGate = false
/** @type {Promise<Record<string, unknown>> | null} */
let checkTask = null
/** @type {Promise<Record<string, unknown>> | null} */
let alphaTask = null
/** @type {Promise<Record<string, unknown>> | null} */
let alphaTransferTask = null
/** @type {Promise<Record<string, unknown>> | null} */
let transferTask = null

/**
 * @returns {Record<string, unknown>} A detached copy of the public snapshot.
 */
function emptyView() {
  return {
    applicable: false,
    channel: null,
    currentVersion: null,
    cadence: 'launch',
    phase: 'idle',
    latest: null,
    progress: null,
    error: null,
    prompt: false,
    attention: false,
    dismissedVersion: null,
    checkedAt: null,
    handoff: null,
    alpha: null,
  }
}

/**
 * @returns {Record<string, unknown>} The in-memory alpha state before any check.
 */
function emptyAlphaView() {
  return {
    phase: 'idle',
    latest: null,
    error: null,
    prompt: false,
    progress: null,
    workspaceId: null,
    promptText: null,
  }
}

/**
 * @param {unknown} error - Any thrown value.
 * @returns {string} A single-line message.
 */
function describe(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * @param {string} value - Candidate cadence.
 * @returns {'launch' | 'daily' | 'off' | null} The accepted value, or null.
 */
function normalizeCadence(value) {
  return value === 'launch' || value === 'daily' || value === 'off' ? value : null
}

/**
 * @returns {string} Directory for the verified installer, the waiter log, and the small state file.
 */
function dataDirectory() {
  const root = process.env.LOCALAPPDATA || tmpdir()
  return join(root, PACKAGE)
}

/**
 * @returns {string} Persisted check and dismissal state.
 */
function statePath() {
  return join(dataDirectory(), 'state.json')
}

/**
 * @returns {Record<string, unknown>} The alpha half of the durable state.
 */
function emptyAlphaState() {
  return {
    lastCheckedAt: null,
    dismissedVersion: null,
    latest: null,
    handoff: null,
    source: null,
  }
}

/**
 * @returns {Promise<{lastCheckedAt: string | null, dismissedVersion: string | null, handoff: Record<string, unknown> | null, alpha: Record<string, unknown>}>} Stored state.
 */
async function readState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'))
    const handoff = raw?.handoff
    const alpha = raw?.alpha !== null && typeof raw?.alpha === 'object' && !Array.isArray(raw.alpha)
      ? { ...emptyAlphaState(), ...raw.alpha }
      : emptyAlphaState()
    return {
      lastCheckedAt: typeof raw?.lastCheckedAt === 'string' ? raw.lastCheckedAt : null,
      dismissedVersion: typeof raw?.dismissedVersion === 'string' ? raw.dismissedVersion : null,
      handoff: handoff !== null && typeof handoff === 'object' ? handoff : null,
      alpha,
    }
  } catch {
    return { lastCheckedAt: null, dismissedVersion: null, handoff: null, alpha: emptyAlphaState() }
  }
}

/**
 * @param {Record<string, unknown>} next - Complete state document.
 * @returns {Promise<void>} After the document is replaced.
 */
async function writeState(next) {
  const directory = dataDirectory()
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `state.${process.pid}.tmp`)
  await writeFile(temporary, JSON.stringify(next), 'utf8')
  await rename(temporary, statePath())
}

/**
 * Paths owned by the packaged desktop shell, not by the Host profile.
 * @returns {{exe: string, updateYaml: string, manifest: string, settings: string | null, installDir: string}} Candidate files.
 */
function desktopPaths() {
  const exe = process.execPath
  const resources = join(dirname(exe), 'resources')
  const appData = process.env.APPDATA
  return {
    exe,
    updateYaml: join(resources, 'app-update.yml'),
    manifest: join(resources, 'app.asar', 'package.json'),
    settings: appData ? join(appData, '@deepseek-ai', 'dsh-desktop', 'desktop', 'settings.json') : null,
    installDir: dirname(exe),
  }
}

/**
 * Read the installed desktop identity and the channel the shell is actually using.
 * A missing `channel` field uses the package default, matching the desktop shell.
 * @returns {Promise<{applicable: boolean, channel: string | null, currentVersion: string | null, feedUrl: string | null, installDir: string, reason: string | null}>} Desktop facts.
 */
async function readDesktop() {
  const paths = desktopPaths()
  if (process.platform !== 'win32') {
    return { applicable: false, channel: null, currentVersion: null, feedUrl: null, installDir: paths.installDir, reason: 'platform' }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(paths.manifest, 'utf8'))
  } catch (error) {
    return { applicable: false, channel: null, currentVersion: null, feedUrl: null, installDir: paths.installDir, reason: describe(error) }
  }
  const currentVersion = typeof manifest?.version === 'string' ? manifest.version : null
  const packagedChannel = manifest?.dshDesktopUpdateChannel === 'stable' ? 'stable' : 'nightly'
  let feedDocument
  try {
    feedDocument = parseFeedYaml(await readFile(paths.updateYaml, 'utf8'))
  } catch (error) {
    return { applicable: false, channel: packagedChannel, currentVersion, feedUrl: null, installDir: paths.installDir, reason: describe(error) }
  }
  const feedUrl = typeof feedDocument.url === 'string' && feedDocument.url.startsWith('https://') ? feedDocument.url : null
  if (paths.settings === null) {
    return { applicable: false, channel: packagedChannel, currentVersion, feedUrl, installDir: paths.installDir, reason: 'settings' }
  }
  let channel = packagedChannel
  try {
    const settings = JSON.parse(await readFile(paths.settings, 'utf8'))
    const selected = settings?.updates?.channel
    if (selected === 'nightly' || selected === 'stable') channel = selected
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') {
      return { applicable: false, channel: null, currentVersion, feedUrl, installDir: paths.installDir, reason: 'settings' }
    }
  }
  // The extra row exists only for the development channel. Stable keeps the built-in updater.
  const applicable = channel === 'nightly' && currentVersion !== null && feedUrl !== null
  return { applicable, channel, currentVersion, feedUrl, installDir: paths.installDir, reason: applicable ? null : 'channel' }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {'launch' | 'daily' | 'off'} The live cadence.
 */
function readCadence(ctx) {
  try {
    const entry = ctx.configEditor.entries().find((candidate) => candidate?.options?.name === PACKAGE)
    const saved = normalizeCadence(entry?.options?.config?.cadence)
    if (saved) return saved
  } catch { /* the activation config still carries the default */ }
  const live = activationConfig?.cadence
  if (live !== null && typeof live === 'object' && typeof live.get === 'function') {
    const value = normalizeCadence(live.get())
    if (value) return value
  }
  return normalizeCadence(live) ?? 'launch'
}

/**
 * Read one live config field: a volatile ref during activation, a plain value after a save.
 * @param {unknown} value - Candidate.
 * @returns {unknown} The underlying value, or undefined.
 */
function unwrapLive(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * Current alpha settings, from the profile entry first and the activation refs second.
 * @param {import('@deepseek-ai/cordis').Context | null} ctx - Host context.
 * @returns {{enabled: boolean, cadence: 'launch' | 'daily' | 'off', path: string, keepSource: boolean, deleteSource: boolean, deleteInstaller: boolean, nodePath: string, registry: string, certificateFile: string, signTool: string, keyContainer: string, signatureCacheDir: string}} Settings.
 */
function readAlphaSettings(ctx) {
  let entryConfig = {}
  try {
    entryConfig = ctx?.configEditor.entries().find((candidate) => candidate?.options?.name === PACKAGE)?.options?.config ?? {}
  } catch { /* fall back to activation refs */ }
  const live = activationConfig ?? {}
  const plain = unwrapLive(live)
  const sourceEntry = entryConfig.source !== null && typeof entryConfig.source === 'object' ? entryConfig.source : {}
  const sourceLiveRaw = unwrapLive(plain?.source)
  const sourceLive = sourceLiveRaw !== null && typeof sourceLiveRaw === 'object' ? sourceLiveRaw : {}
  const value = (key, fallback) => {
    const fromEntry = unwrapLive(entryConfig[key])
    if (fromEntry !== undefined && fromEntry !== null) return fromEntry
    const fromLive = unwrapLive(plain?.[key])
    if (fromLive !== undefined && fromLive !== null) return fromLive
    return fallback
  }
  const sourceValue = (key, fallback) => {
    const fromEntry = unwrapLive(sourceEntry[key])
    if (fromEntry !== undefined && fromEntry !== null) return fromEntry
    const fromLive = unwrapLive(sourceLive[key])
    if (fromLive !== undefined && fromLive !== null) return fromLive
    return fallback
  }
  const text = (input, fallback = '') => (typeof input === 'string' ? input.trim() : fallback)
  const flag = (input, fallback = false) => (typeof input === 'boolean' ? input : fallback)
  const deleteSource = flag(sourceValue('deleteSource', false))
  return {
    enabled: flag(value('alphaEnabled', false)),
    cadence: ctx === null || ctx === undefined ? 'launch' : readCadence(ctx),
    path: text(sourceValue('directory', '')),
    deleteSource,
    keepSource: !deleteSource,
    deleteInstaller: flag(sourceValue('deleteInstaller', false)),
    nodePath: text(sourceValue('nodePath', '')),
    registry: text(sourceValue('registry', '')),
    certificateFile: text(sourceValue('certificateFile', '')),
    signTool: text(sourceValue('signTool', '')),
    keyContainer: text(sourceValue('keyContainer', '')),
    signatureCacheDir: text(sourceValue('signatureCacheDir', '')),
  }
}

/**
 * @param {string | null | undefined} iso - Previous successful check.
 * @returns {boolean} Whether it happened within the last day.
 */
function checkedRecently(iso) {
  if (!iso) return false
  const then = Date.parse(iso)
  return Number.isFinite(then) && Date.now() - then < DAY_MS
}

/**
 * @param {number} pid - Waiter process id.
 * @returns {boolean} Whether the process still exists.
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Publish the fields the client is allowed to see. Installer paths stay on the host.
 * @param {Awaited<ReturnType<typeof readDesktop>>} [desktop] - Facts already read for this call.
 * @param {Awaited<ReturnType<typeof readState>>} [state] - State already read for this call.
 * @returns {Promise<Record<string, unknown>>} The public snapshot.
 */
async function publish(desktop, state) {
  const ctx = hostContext
  const facts = desktop ?? await readDesktop()
  const stored = state ?? await readState()
  const settings = readAlphaSettings(ctx)
  const handoff = stored.handoff
  let handoffView = null
  if (handoff && typeof handoff.version === 'string') {
    const installed = facts.currentVersion !== null && !isNewerVersion(handoff.version, facts.currentVersion)
    if (installed) {
      stored.handoff = null
      await writeState(stored).catch(() => {})
      if (settings.deleteInstaller) await rm(join(dataDirectory(), 'installer.exe'), { force: true }).catch(() => {})
    } else {
      handoffView = {
        version: handoff.version,
        waiting: typeof handoff.pid === 'number' && processAlive(handoff.pid),
      }
    }
  }
  view = {
    applicable: facts.applicable,
    channel: facts.channel,
    currentVersion: facts.currentVersion,
    cadence: ctx ? readCadence(ctx) : view.cadence,
    phase: view.phase,
    latest: view.latest,
    progress: view.progress,
    error: view.error,
    prompt: view.prompt === true,
    attention: view.attention === true,
    dismissedVersion: stored.dismissedVersion,
    checkedAt: stored.lastCheckedAt,
    handoff: handoffView,
    alphaApplicable: process.platform === 'win32' && facts.currentVersion !== null,
    alpha: alphaSnapshot(facts, stored, settings),
  }
  return structuredClone(view)
}

/**
 * @param {string} feedUrl - Feed directory URL.
 * @param {string} channel - `nightly` or `stable`.
 * @returns {string} Absolute channel document URL.
 */
function channelFeedUrl(feedUrl, channel) {
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  const name = channel === 'latest' ? 'latest.yml' : `${channel}.yml`
  return new URL(name, base).toString()
}

/**
 * Refuse an installer URL that is not the feed host over HTTPS.
 * @param {string} feedUrl - Feed directory URL from the installed app.
 * @param {string} target - Candidate installer URL.
 * @returns {URL} The accepted URL.
 */
function acceptedInstallerUrl(feedUrl, target) {
  const feed = new URL(feedUrl)
  const installer = new URL(target)
  if (installer.protocol !== 'https:' || installer.hostname !== feed.hostname) {
    throw Object.assign(new Error('refusing installer URL outside the upstream feed'), { code: 'download' })
  }
  return installer
}

/**
 * @param {ReturnType<typeof parseFeedYaml>} document - Parsed feed.
 * @param {string} feedUrl - Feed directory URL.
 * @returns {{version: string, url: string, sha512: string, size: number | null, releaseDate: string | null, stagingPercentage: number | null}} The newest file.
 */
function selectRelease(document, feedUrl) {
  if (typeof document.version !== 'string' || document.version === '') {
    throw Object.assign(new Error('feed has no version'), { code: 'parse' })
  }
  const files = Array.isArray(document.files) ? document.files : []
  const executable = files.find((file) => typeof file?.url === 'string' && String(file.url).toLowerCase().includes('.exe'))
  const chosen = executable ?? files[0]
  const reference = typeof chosen?.url === 'string' && chosen.url !== '' ? chosen.url : document.path
  if (typeof reference !== 'string' || reference === '') {
    throw Object.assign(new Error('feed has no installer'), { code: 'parse' })
  }
  const sha512 = typeof chosen?.sha512 === 'string' && chosen.sha512 !== '' ? chosen.sha512 : document.sha512
  if (typeof sha512 !== 'string' || sha512 === '') {
    throw Object.assign(new Error('feed has no sha512'), { code: 'parse' })
  }
  const size = chosen?.size
  return {
    version: document.version,
    url: acceptedInstallerUrl(feedUrl, resolveFeedFileUrl(feedUrl, reference)).toString(),
    sha512,
    size: typeof size === 'number' && Number.isFinite(size) ? size : null,
    releaseDate: typeof document.releaseDate === 'string' ? document.releaseDate : null,
    stagingPercentage: typeof document.stagingPercentage === 'number' ? document.stagingPercentage : null,
  }
}

/**
 * @param {string} url - HTTPS URL.
 * @param {number} timeoutMs - Abort deadline.
 * @returns {Promise<Response>} The response, still unread.
 */
async function fetchChecked(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'feed' })
  }
  return response
}

/**
 * Compare base64 digests without leaking the mismatch through a short-circuit.
 * @param {string} actual - Computed digest.
 * @param {string} expected - Feed digest.
 * @returns {boolean} Whether they are identical.
 */
function sameDigest(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {unknown} error - Failure from a check or transfer.
 * @returns {{code: string, detail: string}} A client-translatable error.
 */
function asError(error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'generic'
  const known = ['feed', 'parse', 'download', 'hash', 'signature', 'install', 'busy', 'config', 'git', 'path', 'clone', 'sync', 'cleanup', 'alpha']
  return { code: known.includes(code) ? code : 'generic', detail: describe(error).slice(0, 300) }
}

/**
 * Fetch the channel feed and decide from the version alone.
 * `stagingPercentage` is copied onto the snapshot and then ignored.
 * @param {boolean} manual - Whether the user asked, which may reopen a skipped prompt.
 * @returns {Promise<Record<string, unknown>>} The public snapshot.
 */
async function doCheck(manual) {
  const desktop = await readDesktop()
  const state = await readState()
  view.phase = 'checking'
  view.error = null
  view.progress = null
  if (!desktop.applicable || desktop.feedUrl === null || desktop.channel === null || desktop.currentVersion === null) {
    view.phase = 'idle'
    view.latest = null
    view.prompt = false
    return publish(desktop, state)
  }
  try {
    const response = await fetchChecked(channelFeedUrl(desktop.feedUrl, desktop.channel), FEED_TIMEOUT_MS)
    const document = parseFeedYaml(await response.text())
    const release = selectRelease(document, desktop.feedUrl)
    const newer = isNewerVersion(release.version, desktop.currentVersion)
    view.latest = {
      version: release.version,
      releaseDate: release.releaseDate,
      size: release.size,
      stagingPercentage: release.stagingPercentage,
    }
    view.phase = newer ? 'available' : 'current'
    const fresh = await readState()
    const skipped = fresh.dismissedVersion === release.version
    view.prompt = newer && (manual || !skipped)
    fresh.lastCheckedAt = new Date().toISOString()
    await writeState(fresh)
    state.lastCheckedAt = fresh.lastCheckedAt
    state.dismissedVersion = fresh.dismissedVersion
  } catch (error) {
    view.phase = 'error'
    view.prompt = false
    view.error = asError(error && typeof error === 'object' && 'code' in error ? error : Object.assign(error instanceof Error ? error : new Error(describe(error)), { code: 'feed' }))
  }
  return publish(desktop, state)
}

/**
 * @param {boolean} manual - User-initiated check.
 * @returns {Promise<Record<string, unknown>>} The shared in-flight check, if one is running.
 */
function startCheck(manual) {
  if (checkTask) return checkTask
  checkTask = doCheck(manual).finally(() => {
    checkTask = null
  })
  return checkTask
}

/**
 * Start the launch/daily check once, when this desktop session is on the development channel.
 * @returns {Promise<void>} After the decision; the check itself keeps running.
 */
async function considerAuto() {
  if (autoGate || sessionChecked || checkTask || transferTask) return
  autoGate = true
  try {
    const desktop = await readDesktop()
    if (!desktop.applicable) return
    const ctx = hostContext
    if (!ctx) return
    const cadence = readCadence(ctx)
    if (cadence === 'off') return
    if (cadence === 'daily') {
      const state = await readState()
      if (checkedRecently(state.lastCheckedAt)) return
    }
    sessionChecked = true
    void startCheck(false).catch(() => {})
  } finally {
    autoGate = false
  }
}

/**
 * Resolve git for a desktop process whose PATH may omit Git for Windows.
 * @returns {string} An absolute git.exe when the standard install exists, else `git`.
 */
function gitExecutable() {
  if (process.platform !== 'win32') return 'git'
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    const candidate = join(root, 'Git', 'cmd', 'git.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'git'
}

/**
 * Run one git command with a timeout and no interactive credential prompt.
 * @param {string[]} args - Arguments after `git`.
 * @param {{code?: string, timeout?: number, cwd?: string}} [options] - Failure code and deadline.
 * @returns {Promise<{stdout: string, stderr: string}>} Captured output.
 */
function runGit(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(gitExecutable(), args, {
      cwd: options.cwd,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: 'echo',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim().split(/\r?\n/u).filter(Boolean).slice(-4).join(' ')
        reject(Object.assign(new Error(detail.slice(0, 300) || 'git command failed'), { code: options.code ?? 'git' }))
        return
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * @returns {Promise<void>} Resolves when a usable git is on PATH.
 */
async function ensureGit() {
  try {
    await runGit(['--version'], { timeout: 15_000, code: 'git' })
  } catch {
    throw Object.assign(new Error('git is not available on PATH'), { code: 'git' })
  }
}

/**
 * @param {string} path - Absolute path.
 * @returns {string} A case-folded path for equality on Windows.
 */
function normalizePath(path) {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/**
 * @param {string} path - Candidate source directory.
 * @returns {Promise<'missing' | 'empty' | 'full'>} Directory state.
 */
async function sourceDirectoryState(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw Object.assign(new Error('the source path is not a directory'), { code: 'path' })
    return (await readdir(path)).length === 0 ? 'empty' : 'full'
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return 'missing'
    throw error && typeof error === 'object' && error.code === 'path'
      ? error
      : Object.assign(new Error(describe(error)), { code: 'path' })
  }
}

/**
 * Read the newest alpha tag from the upstream repository.
 * @returns {Promise<{tag: string, version: string, commit: string}>} The newest alpha tag.
 */
async function listAlphaRelease() {
  await ensureGit()
  const { stdout } = await runGit(['ls-remote', '--tags', ALPHA_REPO], { timeout: TAG_TIMEOUT_MS, code: 'git' })
  const release = selectNewestAlpha(parseTagRefs(stdout))
  if (release === null) throw Object.assign(new Error('upstream publishes no alpha tag yet'), { code: 'alpha' })
  return release
}

/**
 * @param {ReturnType<typeof readAlphaSettings>} settings - Live settings.
 * @returns {string} The accepted absolute source directory.
 */
function alphaSourcePath(settings) {
  const checked = checkSourcePath(settings.path, [desktopPaths().installDir, dataDirectory()])
  if (!checked.ok) throw Object.assign(new Error(`source directory rejected: ${checked.reason}`), { code: 'path' })
  return checked.path
}

/**
 * Clone the exact alpha tag, or reuse a verified upstream checkout and fetch.
 * A non-empty directory that is not this repository is never touched.
 * @param {string} tag - Alpha tag such as `dsh-v0.2.3-alpha.2`.
 * @param {string} path - Accepted absolute source directory.
 * @param {(step: string) => void} [onStep] - Progress hook for the status row.
 * @returns {Promise<void>} After the checkout is at the tag.
 */
async function syncAlphaSource(tag, path, onStep) {
  await ensureGit()
  const state = await sourceDirectoryState(path)
  const sparse = ['-c', 'core.longpaths=true']
  if (state === 'missing') {
    await mkdir(dirname(path), { recursive: true })
    onStep?.('clone')
    await runGit([...sparse, 'clone', '--quiet', '--origin', 'origin', ALPHA_REPO, path], {
      timeout: ALPHA_TIMEOUT_MS,
      code: 'clone',
    })
  } else if (state === 'empty') {
    onStep?.('clone')
    await runGit([...sparse, 'clone', '--quiet', '--origin', 'origin', ALPHA_REPO, path], {
      timeout: ALPHA_TIMEOUT_MS,
      code: 'clone',
    })
  } else {
    const { stdout: top } = await runGit(['-C', path, 'rev-parse', '--show-toplevel'], { code: 'sync' })
    const canonical = await realpath(path)
    if (normalizePath(top.trim()) !== normalizePath(canonical)) {
      throw Object.assign(new Error('the source directory holds a different git work tree'), { code: 'path' })
    }
    const { stdout: remote } = await runGit(['-C', path, 'remote', 'get-url', 'origin'], { code: 'sync' })
    if (!sameRepository(remote.trim())) {
      throw Object.assign(new Error('the source directory is not a deepseek-harness clone'), { code: 'path' })
    }
    onStep?.('fetch')
    await runGit([...sparse, '-C', path, 'fetch', '--quiet', '--tags', '--prune', 'origin'], {
      timeout: ALPHA_TIMEOUT_MS,
      code: 'sync',
    })
  }
  onStep?.('checkout')
  await runGit([...sparse, '-C', path, 'checkout', '--quiet', '--force', '--detach', `refs/tags/${tag}`], {
    timeout: GIT_TIMEOUT_MS,
    code: 'sync',
  })
  const { stdout: head } = await runGit(['-C', path, 'rev-parse', 'HEAD'], { code: 'sync' })
  const { stdout: tagged } = await runGit(['-C', path, 'rev-parse', `refs/tags/${tag}^{commit}`], { code: 'sync' })
  if (head.trim() !== tagged.trim()) {
    throw Object.assign(new Error(`the checkout is not at tag ${tag}`), { code: 'sync' })
  }
  try {
    await access(join(path, '.gitmodules'))
    onStep?.('submodules')
    await runGit([...sparse, '-C', path, 'submodule', 'update', '--init', '--recursive', '--quiet'], {
      timeout: ALPHA_TIMEOUT_MS,
      code: 'sync',
    })
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
  }
}

/**
 * Empty a checkout this plugin created, after the installed version caught up.
 * The directory is verified through git first; anything else is refused.
 * @param {string} path - Source directory from the durable hand-off.
 * @returns {Promise<boolean>} Whether anything was removed.
 */
async function purgeAlphaSource(path) {
  const checked = checkSourcePath(path, [desktopPaths().installDir, dataDirectory()])
  if (!checked.ok) throw Object.assign(new Error(`source directory rejected: ${checked.reason}`), { code: 'path' })
  const target = checked.path
  const info = await stat(target).catch(() => null)
  if (info === null) return false
  if (!info.isDirectory()) throw Object.assign(new Error('the source path is not a directory'), { code: 'cleanup' })
  const { stdout: top } = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], { code: 'cleanup' })
  const canonical = await realpath(target)
  if (normalizePath(top.trim()) !== normalizePath(canonical)) {
    throw Object.assign(new Error('the source directory holds a different git work tree'), { code: 'cleanup' })
  }
  const { stdout: remote } = await runGit(['-C', target, 'remote', 'get-url', 'origin'], { code: 'cleanup' })
  if (!sameRepository(remote.trim())) {
    throw Object.assign(new Error('the source directory is not a deepseek-harness clone'), { code: 'cleanup' })
  }
  await runGit(['-C', target, 'clean', '-xdf'], { timeout: ALPHA_TIMEOUT_MS, code: 'cleanup' })
  await runGit(['-C', target, 'reset', '--hard', '--quiet'], { timeout: GIT_TIMEOUT_MS, code: 'cleanup' })
  await rm(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
  return true
}

/**
 * Clear a finished hand-off: once the installed version equals the built tag,
 * either purge the source or just drop the marker.
 * @returns {Promise<void>} After the durable state settles.
 */
async function settleAlpha() {
  if (alphaSettleGate || hostContext === null) return
  alphaSettleGate = true
  try {
    const state = await readState()
    const handoff = state.alpha.handoff
    const source = state.alpha.source
    const version = typeof handoff?.version === 'string'
      ? handoff.version
      : (typeof source?.version === 'string' ? source.version : null)
    if (version === null) return
    const desktop = await readDesktop()
    if (desktop.currentVersion === null) return
    let equal = false
    try {
      equal = compareVersions(version, desktop.currentVersion) === 0
    } catch {
      return
    }
    if (!equal) return
    const settings = readAlphaSettings(hostContext)
    if (settings.deleteSource) {
      const path = typeof handoff?.path === 'string' && handoff.path !== '' ? handoff.path : source?.path
      if (typeof path === 'string' && path !== '') {
        try {
          await purgeAlphaSource(path)
        } catch (error) {
          alphaView.error = asError(error)
          return
        }
      }
      state.alpha.source = null
    }
    state.alpha.handoff = null
    await writeState(state)
    if (alphaView.phase === 'ready' || alphaView.phase === 'handed') {
      alphaView.phase = 'current'
      alphaView.prompt = false
      alphaView.promptText = null
      alphaView.workspaceId = null
      alphaView.progress = null
    }
  } catch (error) {
    alphaView.error = asError(error)
  } finally {
    alphaSettleGate = false
  }
}

/**
 * Build the public alpha snapshot from memory, durable state, and live settings.
 * @param {Awaited<ReturnType<typeof readDesktop>>} facts - Desktop facts.
 * @param {Awaited<ReturnType<typeof readState>>} stored - Durable state.
 * @param {ReturnType<typeof readAlphaSettings>} settings - Live settings.
 * @returns {Record<string, unknown>} The client-facing alpha view.
 */
function alphaSnapshot(facts, stored, settings) {
  const applicable = process.platform === 'win32' && facts.currentVersion !== null
  const alphaState = stored.alpha ?? emptyAlphaState()
  const handoff = alphaState.handoff
  let workspaceId = null
  let promptText = null
  if (alphaView.phase === 'ready' && handoff !== null && typeof handoff === 'object') {
    workspaceId = typeof handoff.workspaceId === 'string' ? handoff.workspaceId : null
    promptText = alphaView.promptText
    if (promptText === null && typeof handoff.version === 'string' && typeof handoff.tag === 'string' && typeof handoff.path === 'string') {
      promptText = buildBuildPrompt({
        version: handoff.version,
        tag: handoff.tag,
        path: handoff.path,
        nodePath: settings.nodePath,
        registry: settings.registry,
        certificateFile: settings.certificateFile,
        signTool: settings.signTool,
        keyContainer: settings.keyContainer,
        signatureCacheDir: settings.signatureCacheDir,
      })
    }
  }
  return {
    applicable,
    enabled: settings.enabled,
    currentVersion: facts.currentVersion,
    path: settings.path,
    keepSource: settings.keepSource,
    phase: applicable ? alphaView.phase : 'idle',
    latest: alphaView.latest,
    error: alphaView.error,
    prompt: applicable && alphaView.prompt === true,
    checkedAt: alphaState.lastCheckedAt,
    dismissedVersion: alphaState.dismissedVersion,
    workspaceId,
    promptText,
    progress: alphaView.progress,
    handoff: handoff !== null && typeof handoff === 'object'
      ? {
          version: handoff.version ?? null,
          tag: handoff.tag ?? null,
          at: handoff.at ?? null,
          workspaceId: handoff.workspaceId ?? null,
        }
      : null,
    source: alphaState.source !== null && typeof alphaState.source === 'object'
      ? {
          version: alphaState.source.version ?? null,
          tag: alphaState.source.tag ?? null,
          at: alphaState.source.at ?? null,
          path: alphaState.source.path ?? null,
        }
      : null,
    advanced: {
      nodePath: settings.nodePath,
      registry: settings.registry,
      certificateFile: settings.certificateFile,
      signTool: settings.signTool,
      keyContainer: settings.keyContainer,
      signatureCacheDir: settings.signatureCacheDir,
      deleteInstaller: settings.deleteInstaller,
    },
  }
}

/**
 * Read the upstream alpha tags and compare them with the installed version.
 * @param {boolean} manual - Whether the user asked, which may reopen a skipped prompt.
 * @returns {Promise<Record<string, unknown>>} The public snapshot.
 */
async function doAlphaCheck(manual) {
  if (alphaTransferTask) return publish()
  const desktop = await readDesktop()
  alphaView.phase = 'checking'
  alphaView.error = null
  alphaView.progress = null
  try {
    if (desktop.currentVersion === null) throw Object.assign(new Error('the installed desktop version is unknown'), { code: 'alpha' })
    const release = await listAlphaRelease()
    alphaView.latest = { version: release.version, tag: release.tag }
    const newer = isNewerVersion(release.version, desktop.currentVersion)
    alphaView.phase = newer ? 'available' : 'current'
    const fresh = await readState()
    alphaView.prompt = newer && (manual || fresh.alpha.dismissedVersion !== release.version)
    fresh.alpha.lastCheckedAt = new Date().toISOString()
    fresh.alpha.latest = { ...alphaView.latest }
    await writeState(fresh)
  } catch (error) {
    alphaView.phase = 'error'
    alphaView.error = asError(error)
    alphaView.prompt = false
  }
  return publish(desktop, await readState())
}

/**
 * @param {boolean} manual - User-initiated check.
 * @returns {Promise<Record<string, unknown>>} The shared in-flight alpha check.
 */
function startAlphaCheck(manual) {
  if (alphaTask) return alphaTask
  alphaTask = doAlphaCheck(manual).finally(() => {
    alphaTask = null
  })
  return alphaTask
}

/**
 * Start the launch/daily alpha check once, when monitoring is enabled.
 * @returns {Promise<void>} After the decision; the check itself keeps running.
 */
async function considerAlphaAuto() {
  if (alphaAutoGate || alphaSessionChecked || alphaTask || alphaTransferTask) return
  const ctx = hostContext
  if (ctx === null) return
  const settings = readAlphaSettings(ctx)
  if (!settings.enabled) return
  alphaAutoGate = true
  try {
    const desktop = await readDesktop()
    if (desktop.currentVersion === null) return
    if (settings.cadence === 'off') return
    if (settings.cadence === 'daily') {
      const state = await readState()
      if (checkedRecently(state.alpha.lastCheckedAt)) return
    }
    alphaSessionChecked = true
    void startAlphaCheck(false).catch(() => {})
  } finally {
    alphaAutoGate = false
  }
}

/**
 * User-confirmed alpha build: sync the source, register the workspace, and
 * prepare the prompt the client is going to place in a fresh session.
 * @param {string} version - Version the user confirmed.
 * @returns {Promise<Record<string, unknown>>} The public snapshot.
 */
async function doAlphaStart(version) {
  const desktop = await readDesktop()
  const settings = readAlphaSettings(hostContext)
  alphaView.prompt = false
  alphaView.error = null
  try {
    if (!settings.enabled) throw Object.assign(new Error('alpha monitoring is disabled'), { code: 'alpha' })
    const latest = alphaView.latest
    if (latest === null || typeof latest !== 'object' || latest.version !== version) {
      throw Object.assign(new Error('confirmation is stale'), { code: 'busy' })
    }
    if (desktop.currentVersion === null || !isNewerVersion(version, desktop.currentVersion)) {
      throw Object.assign(new Error('confirmation is stale'), { code: 'busy' })
    }
    const path = alphaSourcePath(settings)
    alphaView.phase = 'cloning'
    alphaView.progress = { step: 'clone' }
    await syncAlphaSource(latest.tag, path, (step) => {
      alphaView.progress = { step }
    })
    const registry = hostContext?.workspaceRegistry
    if (!registry) throw Object.assign(new Error('workspace registry is unavailable'), { code: 'alpha' })
    const workspace = await registry.create(path, `deepseek-harness ${version}`)
    const promptText = buildBuildPrompt({
      version,
      tag: latest.tag,
      path,
      nodePath: settings.nodePath,
      registry: settings.registry,
      certificateFile: settings.certificateFile,
      signTool: settings.signTool,
      keyContainer: settings.keyContainer,
      signatureCacheDir: settings.signatureCacheDir,
    })
    const state = await readState()
    const at = new Date().toISOString()
    state.alpha.handoff = { version, tag: latest.tag, path, workspaceId: String(workspace.id), at }
    state.alpha.source = { version, tag: latest.tag, path, at }
    await writeState(state)
    alphaView.phase = 'ready'
    alphaView.workspaceId = String(workspace.id)
    alphaView.promptText = promptText
    alphaView.progress = null
    alphaSettleGate = false
  } catch (error) {
    alphaView.phase = 'error'
    alphaView.error = asError(error)
    alphaView.progress = null
  }
  return publish(desktop, await readState())
}

/**
 * @param {string} version - Confirmed version.
 * @returns {Promise<Record<string, unknown>>} The in-flight transfer, if one is already running.
 */
function startAlphaStart(version) {
  if (alphaTransferTask) return alphaTransferTask
  alphaTransferTask = doAlphaStart(version).finally(() => {
    alphaTransferTask = null
  })
  return alphaTransferTask
}

/**
 * Download the fresh feed's installer for an exact confirmed version, then verify it.
 * @param {string} version - Version the user confirmed.
 * @param {string} destination - Final installer path.
 * @returns {Promise<{release: ReturnType<typeof selectRelease>}>} The verified release.
 */
async function downloadVerified(version, destination) {
  const desktop = await readDesktop()
  if (!desktop.applicable || desktop.feedUrl === null || desktop.channel === null) {
    throw Object.assign(new Error('desktop update feed is not available'), { code: 'config' })
  }
  const response = await fetchChecked(channelFeedUrl(desktop.feedUrl, desktop.channel), FEED_TIMEOUT_MS)
  const release = selectRelease(parseFeedYaml(await response.text()), desktop.feedUrl)
  if (release.version !== version) {
    throw Object.assign(new Error('the upstream version changed; check again'), { code: 'busy' })
  }
  const payload = await fetchChecked(release.url, DOWNLOAD_TIMEOUT_MS)
  const finalUrl = payload.url ? acceptedInstallerUrl(desktop.feedUrl, payload.url) : new URL(release.url)
  if (finalUrl.hostname !== new URL(desktop.feedUrl).hostname) {
    throw Object.assign(new Error('download redirected off the upstream feed'), { code: 'download' })
  }
  const expected = release.size
  const limit = expected ?? MAX_BYTES
  if (limit > MAX_BYTES) throw Object.assign(new Error('installer is larger than the accepted limit'), { code: 'download' })
  const partial = `${destination}.partial`
  await rm(partial, { force: true }).catch(() => {})
  const hash = createHash('sha512')
  const stream = createWriteStream(partial, { flags: 'wx' })
  let received = 0
  view.phase = 'downloading'
  view.progress = { received: 0, total: expected, percent: 0 }
  try {
    if (!payload.body) throw Object.assign(new Error('empty installer response'), { code: 'download' })
    const reader = payload.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > limit) throw Object.assign(new Error('installer exceeded the feed size'), { code: 'download' })
      hash.update(chunk.value)
      if (!stream.write(chunk.value)) await new Promise((resolve) => stream.once('drain', resolve))
      const percent = expected ? Math.min(100, Math.floor((received / expected) * 100)) : null
      view.progress = { received, total: expected, percent }
    }
    await new Promise((resolve, reject) => {
      stream.end(() => resolve(undefined))
      stream.once('error', reject)
    })
  } catch (error) {
    stream.destroy()
    await rm(partial, { force: true }).catch(() => {})
    throw error
  }
  if (expected !== null && received !== expected) {
    await rm(partial, { force: true }).catch(() => {})
    throw Object.assign(new Error(`size ${received} does not match the feed size ${expected}`), { code: 'hash' })
  }
  view.phase = 'verifying'
  view.progress = null
  const digest = hash.digest('base64')
  if (!sameDigest(digest, release.sha512)) {
    await rm(partial, { force: true }).catch(() => {})
    throw Object.assign(new Error('sha512 does not match the upstream feed'), { code: 'hash' })
  }
  try {
    await verifySignature(partial)
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {})
    throw error
  }
  await rm(destination, { force: true }).catch(() => {})
  await rename(partial, destination)
  return { release }
}

/**
 * Require a valid Authenticode signature from the desktop publisher.
 * @param {string} file - Installer path.
 * @returns {Promise<void>} Resolves only for a valid DeepSeek signature.
 */
function verifySignature(file) {
  const command = [
    "$sig = Get-AuthenticodeSignature -LiteralPath $env:DSH_UPDATE_FILE",
    "if ($null -eq $sig) { throw 'signature missing' }",
    "$subject = ''",
    "if ($null -ne $sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }",
    "Write-Output ([string]$sig.Status)",
    "Write-Output $subject",
  ].join('; ')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      env: { ...process.env, DSH_UPDATE_FILE: file },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => reject(Object.assign(error, { code: 'signature' })))
    child.once('close', (code) => {
      const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
      const status = lines[0] ?? ''
      const subject = lines.slice(1).join(' ')
      if (code !== 0 || status !== 'Valid' || !subject.includes('DeepSeek')) {
        reject(Object.assign(new Error(stderr.trim() || `signature ${status || 'unreadable'}`), { code: 'signature' }))
        return
      }
      resolve()
    })
  })
}

/**
 * Arm a detached waiter that runs the official silent install only after this app has exited.
 * Closing the window is not enough: the tray process still locks the install directory.
 * @param {string} installer - Verified installer.
 * @param {string} installDir - Current install directory.
 * @param {string} version - Confirmed version.
 * @returns {Promise<{pid: number, log: string}>} The waiter identity.
 */
async function armInstaller(installer, installDir, version) {
  const log = join(dataDirectory(), 'install.log')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$deadline = (Get-Date).AddMinutes(${HANDOFF_MINUTES})`,
    `$log = $env:DSH_UPDATE_LOG`,
    "function Write-Log([string]$message) { Add-Content -LiteralPath $log -Encoding utf8 -Value ((Get-Date).ToString('o') + ' ' + $message) }",
    "Write-Log 'waiting for DeepSeek Harness to exit'",
    'while ($true) {',
    "  $alive = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)",
    '  if ($alive.Count -eq 0) { break }',
    "  if ((Get-Date) -gt $deadline) { Write-Log 'timed out before the app exited'; exit 2 }",
    '  Start-Sleep -Seconds 2',
    '}',
    'Start-Sleep -Seconds 3',
    "Write-Log 'starting installer'",
    "$installerArguments = @('--updated', '/S', '--force-run', $env:DSH_UPDATE_DIR)",
    '$installerProcess = Start-Process -FilePath $env:DSH_UPDATE_INSTALLER -ArgumentList $installerArguments -Wait -PassThru',
    "Write-Log ('installer exit ' + [string]$installerProcess.ExitCode)",
    'if ($null -eq $installerProcess.ExitCode) { exit 1 }',
    'exit $installerProcess.ExitCode',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DSH_UPDATE_LOG: log,
      DSH_UPDATE_INSTALLER: installer,
      DSH_UPDATE_DIR: `/D=${installDir}`,
    },
  })
  child.unref()
  if (!child.pid) throw Object.assign(new Error('could not start the install waiter'), { code: 'install' })
  const state = await readState()
  state.handoff = { version, pid: child.pid, at: new Date().toISOString(), log }
  await writeState(state)
  return { pid: child.pid, log }
}

/**
 * User-confirmed update. The version comes from the dialog; the URL is read again from the feed.
 * @param {string} version - Version the user agreed to install.
 * @returns {Promise<Record<string, unknown>>} The public snapshot.
 */
async function doUpdate(version) {
  if (transferTask) return publish()
  const desktop = await readDesktop()
  view.prompt = false
  view.error = null
  const destination = join(dataDirectory(), 'installer.exe')
  await mkdir(dataDirectory(), { recursive: true })
  try {
    if (desktop.currentVersion === null || !isNewerVersion(version, desktop.currentVersion)) {
      throw Object.assign(new Error('confirmation is stale'), { code: 'busy' })
    }
    await downloadVerified(version, destination)
    await access(destination)
    await armInstaller(destination, desktop.installDir, version)
    view.phase = 'armed'
    view.attention = false
    view.latest = { ...(view.latest ?? {}), version }
  } catch (error) {
    view.phase = 'error'
    view.progress = null
    view.prompt = false
    view.attention = true
    view.error = asError(error)
  }
  return publish()
}

/**
 * @param {string} version - Confirmed version.
 * @returns {Promise<Record<string, unknown>>} The in-flight transfer, if one is already running.
 */
function startUpdate(version) {
  if (transferTask) return transferTask
  transferTask = doUpdate(version).finally(() => {
    transferTask = null
  })
  return transferTask
}

/**
 * Save a partial configuration through the profile editor.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} patch - Top-level keys, with `source` merged one level deep.
 * @returns {Promise<void>} After the profile accepts the write.
 */
async function saveConfig(ctx, patch) {
  const entry = ctx.fiber?.entry ?? ctx.configEditor.entries().find((candidate) => candidate?.options?.name === PACKAGE)
  if (entry === undefined || entry === null) throw Object.assign(new Error('configuration cannot be saved'), { code: 'config' })
  await ctx.configEditor.edit(entry, (current) => {
    const next = { ...(current ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'source') next.source = { ...(next.source ?? {}), ...value }
      else next[key] = value
    }
    return next
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {'launch' | 'daily' | 'off'} cadence - Requested cadence.
 * @returns {Promise<void>} After the profile accepts the volatile write.
 */
async function saveCadence(ctx, cadence) {
  await saveConfig(ctx, { cadence })
}

/**
 * Persist the alpha switch, source path, retention choice, and toolchain hints.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} args - Endpoint arguments in client spelling.
 * @returns {Promise<void>} After the profile accepts the write.
 */
async function saveAlphaConfig(ctx, args) {
  const patch = {}
  if (typeof args?.enabled === 'boolean') patch.alphaEnabled = args.enabled
  const source = {}
  if (typeof args?.path === 'string') {
    const value = args.path.trim()
    if (value !== '') {
      const checked = checkSourcePath(value, [desktopPaths().installDir, dataDirectory()])
      if (!checked.ok) throw Object.assign(new Error(`source directory rejected: ${checked.reason}`), { code: 'path' })
    }
    source.directory = value
  }
  if (typeof args?.keepSource === 'boolean') source.deleteSource = !args.keepSource
  for (const key of ['nodePath', 'registry', 'certificateFile', 'signTool', 'keyContainer', 'signatureCacheDir']) {
    if (typeof args?.[key] === 'string') source[key] = args[key].trim()
  }
  if (typeof args?.deleteInstaller === 'boolean') source.deleteInstaller = args.deleteInstaller
  if (Object.keys(source).length > 0) patch.source = source
  if (Object.keys(patch).length === 0) return
  await saveConfig(ctx, patch)
}

/**
 * @param {Record<string, unknown>} snapshot - Public snapshot.
 * @returns {string} Text for the agent tool. It never includes an install action.
 */
function renderReport(snapshot) {
  const latest = snapshot.latest
  const lines = [
    'Desktop upstream update check. Staged rollout is ignored. This tool cannot download or install.',
    `channel: ${snapshot.channel ?? 'unavailable'}`,
    `installed: ${snapshot.currentVersion ?? 'unknown'}`,
    `cadence: ${snapshot.cadence}`,
    `phase: ${snapshot.phase}`,
  ]
  if (latest && typeof latest === 'object') {
    lines.push(`upstream: ${latest.version ?? 'unknown'}`)
    if (latest.stagingPercentage !== undefined && latest.stagingPercentage !== null) {
      lines.push(`stagingPercentage: ${latest.stagingPercentage} (reported only; it does not hide the build)`)
    }
    if (typeof latest.releaseDate === 'string') lines.push(`releaseDate: ${latest.releaseDate}`)
  }
  if (snapshot.prompt === true) lines.push('The desktop UI is asking the user to confirm the update.')
  if (snapshot.phase === 'armed') lines.push('A verified installer is waiting for the user to quit DeepSeek Harness from the tray.')
  const error = snapshot.error
  if (error && typeof error === 'object') lines.push(`error: ${error.code}: ${error.detail}`)
  if (snapshot.applicable !== true) lines.push('The settings row is shown only while the desktop development channel is selected.')
  const alpha = snapshot.alpha
  if (alpha && typeof alpha === 'object') {
    lines.push('')
    lines.push('Alpha build monitoring: the desktop clones the upstream tags and hands the build to a new session.')
    lines.push(`alpha monitoring: ${alpha.enabled === true ? 'on' : 'off'}`)
    lines.push(`alpha source: ${alpha.path || 'no source directory configured'}`)
    if (alpha.latest && typeof alpha.latest === 'object') lines.push(`alpha upstream: ${alpha.latest.tag ?? alpha.latest.version ?? 'unknown'}`)
    lines.push(`alpha phase: ${alpha.phase}`)
    if (alpha.keepSource !== true) lines.push('The source checkout is removed after the installed version catches up.')
    if (alpha.handoff && typeof alpha.handoff === 'object' && alpha.handoff.version) lines.push(`alpha hand-off: ${alpha.handoff.version}`)
    if (alpha.error && typeof alpha.error === 'object') lines.push(`alpha error: ${alpha.error.code}: ${alpha.error.detail}`)
    if (alpha.phase === 'ready') lines.push('A new session is about to receive the build prompt.')
  }
  return lines.join('\n')
}

/**
 * Dispatch service. The gateway calls `ctx.get('dsh-update-checker').<method>(args)`.
 * `update` is reachable from the settings UI only; the agent tool does not expose it.
 */
class UpdateDispatch extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Owning context.
   */
  constructor(ctx) {
    super(ctx, PACKAGE)
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: PACKAGE,
      namespace: PACKAGE,
    })
  }

  /** @returns {Promise<Record<string, unknown>>} The current snapshot, maybe starting the automatic check. */
  status() {
    if (hostContext === null) return Promise.resolve({ ...emptyView(), error: { code: 'config', detail: 'plugin is not active' } })
    void considerAuto()
    void considerAlphaAuto()
    void settleAlpha()
    return publish()
  }

  /**
   * @param {{manual?: boolean} | undefined} args - Set manual to reopen a skipped version.
   * @returns {Promise<Record<string, unknown>>} The check result.
   */
  check(args) {
    if (hostContext === null) return Promise.resolve({ ...emptyView(), error: { code: 'config', detail: 'plugin is not active' } })
    return startCheck(args?.manual === true)
  }

  /** @returns {Promise<Record<string, unknown>>} The alpha snapshot, maybe starting the automatic check. */
  alphaStatus() {
    if (hostContext === null) return Promise.resolve({ ...emptyView(), error: { code: 'config', detail: 'plugin is not active' } })
    void considerAlphaAuto()
    void settleAlpha()
    return publish()
  }

  /**
   * @param {{manual?: boolean} | undefined} args - Set manual to reopen a skipped version.
   * @returns {Promise<Record<string, unknown>>} The alpha check result.
   */
  alphaCheck(args) {
    if (hostContext === null) return Promise.resolve({ ...emptyView(), error: { code: 'config', detail: 'plugin is not active' } })
    return startAlphaCheck(args?.manual === true)
  }

  /**
   * @param {Record<string, unknown> | undefined} args - Alpha switch, source path, and toolchain hints.
   * @returns {Promise<Record<string, unknown>>} The snapshot after the write.
   */
  async alphaConfig(args) {
    const ctx = hostContext
    if (ctx === null) {
      alphaView.error = { code: 'config', detail: 'plugin is not active' }
      return publish()
    }
    try {
      await saveAlphaConfig(ctx, args)
      alphaView.error = null
      if (args?.enabled === false) alphaView.prompt = false
    } catch (error) {
      alphaView.error = asError(error)
    }
    return publish()
  }

  /**
   * @param {{version?: string} | undefined} args - Version the confirmation showed.
   * @returns {Promise<Record<string, unknown>>} The snapshot after the clone and workspace registration.
   */
  alphaStart(args) {
    const version = typeof args?.version === 'string' ? args.version : ''
    if (version === '' || alphaView.latest?.version !== version) {
      alphaView.prompt = false
      alphaView.error = { code: 'busy', detail: 'confirmation is stale' }
      return publish()
    }
    return startAlphaStart(version)
  }

  /** @returns {Promise<Record<string, unknown>>} The snapshot with the alpha prompt closed. */
  async alphaLater() {
    alphaView.prompt = false
    alphaView.error = null
    return publish()
  }

  /**
   * Reopen the alpha confirmation for the build already found. Does not clone.
   * @returns {Promise<Record<string, unknown>>} The snapshot.
   */
  async alphaAsk() {
    const desktop = await readDesktop()
    const version = alphaView.latest?.version
    if (typeof version === 'string' && desktop.currentVersion !== null && isNewerVersion(version, desktop.currentVersion)) {
      alphaView.prompt = true
      alphaView.error = null
    }
    return publish()
  }

  /**
   * @param {{version?: string} | undefined} args - Version to stop asking about.
   * @returns {Promise<Record<string, unknown>>} The snapshot.
   */
  async alphaDismiss(args) {
    const version = typeof args?.version === 'string' ? args.version : alphaView.latest?.version
    const state = await readState()
    if (typeof version === 'string' && version !== '') state.alpha.dismissedVersion = version
    alphaView.prompt = false
    await writeState(state).catch((error) => {
      alphaView.error = asError(error)
    })
    return publish()
  }

  /**
   * Confirm that the client placed the prompt in a session, so polling stops
   * offering the hand-off again.
   * @param {{version?: string} | undefined} args - The handed-off version.
   * @returns {Promise<Record<string, unknown>>} The snapshot.
   */
  async alphaConsume(args) {
    const state = await readState()
    const handoff = state.alpha.handoff
    if (handoff !== null && typeof handoff === 'object'
      && (typeof args?.version !== 'string' || handoff.version === args.version)) {
      if (alphaView.phase === 'ready') {
        alphaView.phase = 'handed'
        alphaView.promptText = null
        alphaView.prompt = false
      }
    }
    return publish()
  }

  /**
   * @param {{cadence?: string} | undefined} args - Next cadence.
   * @returns {Promise<Record<string, unknown>>} The snapshot after the write.
   */
  async setCadence(args) {
    const ctx = hostContext
    const cadence = normalizeCadence(args?.cadence)
    if (!ctx || cadence === null) {
      view.error = { code: 'config', detail: 'cadence must be launch, daily, or off' }
      return publish()
    }
    try {
      await saveCadence(ctx, cadence)
      if (cadence !== 'off') sessionChecked = false
      view.error = null
    } catch (error) {
      view.error = asError(error)
    }
    return publish()
  }

  /**
   * @param {{version?: string} | undefined} args - Version to stop asking about.
   * @returns {Promise<Record<string, unknown>>} The snapshot.
   */
  async dismiss(args) {
    const version = typeof args?.version === 'string' ? args.version : view.latest?.version
    const state = await readState()
    if (typeof version === 'string' && version !== '') state.dismissedVersion = version
    view.prompt = false
    view.attention = false
    await writeState(state).catch((error) => {
      view.error = asError(error)
    })
    return publish()
  }

  /** @returns {Promise<Record<string, unknown>>} The snapshot with the prompt closed. */
  async later() {
    view.prompt = false
    view.attention = false
    return publish()
  }

  /**
   * Reopen the confirmation for the build already found. Does not download.
   * @returns {Promise<Record<string, unknown>>} The snapshot.
   */
  async ask() {
    const desktop = await readDesktop()
    const version = view.latest?.version
    if (typeof version === 'string' && desktop.currentVersion !== null && isNewerVersion(version, desktop.currentVersion)) {
      view.prompt = true
      view.attention = false
      view.error = null
    }
    return publish()
  }

  /**
   * @param {{version?: string} | undefined} args - The version shown in the confirmation.
   * @returns {Promise<Record<string, unknown>>} The snapshot after download, verification, and handoff.
   */
  update(args) {
    const version = typeof args?.version === 'string' ? args.version : ''
    if (version === '' || view.latest?.version !== version) {
      view.error = { code: 'busy', detail: 'confirmation is stale' }
      view.prompt = false
      view.attention = true
      return publish()
    }
    return startUpdate(version)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} config - Activation config.
 * @returns {void}
 */
export function apply(ctx, config) {
  hostContext = ctx
  activationConfig = config ?? {}
  ctx.effect(() => () => {
    if (hostContext === ctx) hostContext = null
  }, 'dsh-update-checker: release the host context')

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void settleAlpha()
    }, 2000)
    return () => clearTimeout(timer)
  }, 'dsh-update-checker: settle the previous alpha hand-off')

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void considerAuto()
      void considerAlphaAuto()
    }, 8000)
    return () => clearTimeout(timer)
  }, 'dsh-update-checker: automatic upstream check')

  ctx.effect(() => {
    try {
      return ctx.tools.register(defineTool({
        name: 'dsh_update_check',
        description:
          'Check the desktop development-channel feed for a newer installer and ignore staged-rollout percentage. ' +
          'Also reports the alpha-tag monitor: the newest upstream alpha version, the configured source directory, and whether a build was handed to a session. ' +
          'Use it when the user asks whether an update exists or why the built-in updater shows no update. ' +
          'It cannot download or install, and it cannot start a build; the user confirms both in Settings, General.',
        parameters: {
          refresh: {
            type: 'boolean',
            description: 'Fetch the upstream feed again. Omit or false to return the latest snapshot without a new request.',
          },
          cadence: {
            type: 'string',
            description: 'Set the automatic check to launch (every desktop start), daily, or off. Omit unless the user asked to change it.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { report: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.report }],
        },
        async execute(args) {
          const requested = normalizeCadence(args?.cadence)
          if (requested) await saveCadence(ctx, requested)
          if (args?.refresh === true && readAlphaSettings(ctx).enabled) await startAlphaCheck(true)
          const snapshot = args?.refresh === true ? await startCheck(true) : await publish()
          return { report: renderReport(snapshot) }
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('dsh-update-checker: could not register the check tool: %s', describe(error))
    }
  }, 'dsh-update-checker: upstream check tool')

  try {
    ctx.plugin(UpdateDispatch)
  } catch (error) {
    ctx.logger?.warn?.('dsh-update-checker: could not start the dispatch service: %s', describe(error))
  }
}
