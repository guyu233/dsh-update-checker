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
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isNewerVersion, parseFeedYaml, resolveFeedFileUrl } from './lib/feed.js'

/**
 * A directory install is linked from the workspace, so Node resolves bare imports from
 * that workspace and cannot see the desktop app's bundled packages. Load them from the
 * installation that is actually running.
 * @param {string} name - Package directory under the desktop `node_modules`.
 * @param {string} relative - ESM entry inside that package.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importDesktopPackage(name, relative) {
  const file = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', name, relative)
  return import(pathToFileURL(file).href)
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
})

const PACKAGE = 'dsh-update-checker'
const DAY_MS = 24 * 60 * 60 * 1000
const FEED_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const HANDOFF_MINUTES = 30

/** @type {import('@deepseek-ai/cordis').Context | null} */
let hostContext = null
/** @type {Record<string, unknown>} */
let activationConfig = {}

/** In-memory view returned to the settings row and the check tool. */
let view = emptyView()
/** True after this process has already run its automatic check. */
let sessionChecked = false
/** Set synchronously so overlapping status calls cannot start two automatic checks. */
let autoGate = false
/** @type {Promise<Record<string, unknown>> | null} */
let checkTask = null
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
 * @returns {Promise<{lastCheckedAt: string | null, dismissedVersion: string | null, handoff: Record<string, unknown> | null}>} Stored state.
 */
async function readState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'))
    const handoff = raw?.handoff
    return {
      lastCheckedAt: typeof raw?.lastCheckedAt === 'string' ? raw.lastCheckedAt : null,
      dismissedVersion: typeof raw?.dismissedVersion === 'string' ? raw.dismissedVersion : null,
      handoff: handoff !== null && typeof handoff === 'object' ? handoff : null,
    }
  } catch {
    return { lastCheckedAt: null, dismissedVersion: null, handoff: null }
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
  const handoff = stored.handoff
  let handoffView = null
  if (handoff && typeof handoff.version === 'string') {
    const installed = facts.currentVersion !== null && !isNewerVersion(handoff.version, facts.currentVersion)
    if (installed) {
      stored.handoff = null
      await writeState(stored).catch(() => {})
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
  const known = ['feed', 'parse', 'download', 'hash', 'signature', 'install', 'busy', 'config']
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
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {'launch' | 'daily' | 'off'} cadence - Requested cadence.
 * @returns {Promise<void>} After the profile accepts the volatile write.
 */
async function saveCadence(ctx, cadence) {
  const entry = ctx.fiber?.entry ?? ctx.configEditor.entries().find((candidate) => candidate?.options?.name === PACKAGE)
  if (entry === undefined) throw Object.assign(new Error('configuration cannot be saved'), { code: 'config' })
  await ctx.configEditor.edit(entry, (current) => ({ ...current, cadence }))
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
      void considerAuto()
    }, 8000)
    return () => clearTimeout(timer)
  }, 'dsh-update-checker: automatic upstream check')

  ctx.effect(() => {
    try {
      return ctx.tools.register(defineTool({
        name: 'dsh_update_check',
        description:
          'Check the desktop development-channel feed for a newer installer and ignore staged-rollout percentage. ' +
          'Use it when the user asks whether an update exists or why the built-in updater shows no update. ' +
          'It cannot download or install. Installation is confirmed by the user in Settings, General, under the update channel.',
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
