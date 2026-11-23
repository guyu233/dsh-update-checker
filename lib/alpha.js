/**
 * Pure helpers for the alpha channel: read GitHub tags, pick the newest
 * `-alpha.N` build, guard the clone directory, and write the build prompt that
 * the desktop hands to a fresh DeepSeek Harness session.
 *
 * Nothing here touches the network or the filesystem; index.js owns the git
 * commands so this module stays testable on its own.
 *
 * @module dsh-update-checker/lib/alpha
 */

import { isAbsolute, parse, relative, resolve } from 'node:path'
import { compareVersions, parseVersion } from './feed.js'

/** Upstream repository that publishes the alpha tags. */
export const ALPHA_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** `owner/name` spelling used for display and remote checks. */
export const ALPHA_SLUG = 'deepseek-ai/deepseek-harness'

/**
 * Strip the tag prefix the repository uses and return a semantic version.
 * @param {string} tag - Raw tag name such as `dsh-v0.2.3-alpha.2`.
 * @returns {string | null} The version, or null when the tag is not a version.
 */
export function versionOfTag(tag) {
  if (typeof tag !== 'string') return null
  let text = tag.trim()
  if (text.startsWith('dsh-')) text = text.slice(4)
  if (text.startsWith('v')) text = text.slice(1)
  return parseVersion(text) === null ? null : text
}

/**
 * @param {string} version - Candidate version.
 * @returns {boolean} Whether it is an `-alpha.N` prerelease.
 */
export function isAlphaVersion(version) {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.prerelease[0] === 'alpha'
}

/**
 * Read `git ls-remote --tags` output into tag entries.
 * @param {string} stdout - Raw command output.
 * @returns {{tag: string, version: string | null, commit: string}[]} One entry per tag, peeled refs dropped.
 */
export function parseTagRefs(stdout) {
  const entries = []
  const seen = new Set()
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const [commit, ref] = line.split('\t')
    if (!ref || !ref.startsWith('refs/tags/') || ref.endsWith('^{}')) continue
    const tag = ref.slice('refs/tags/'.length)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    entries.push({ tag, version: versionOfTag(tag), commit: commit?.trim() ?? '' })
  }
  return entries
}

/**
 * Pick the highest `-alpha.N` tag by semantic-version precedence.
 * @param {{tag: string, version: string | null, commit: string}[]} entries - Parsed tags.
 * @returns {{tag: string, version: string, commit: string} | null} The newest alpha tag.
 */
export function selectNewestAlpha(entries) {
  const candidates = entries.filter((entry) => typeof entry.version === 'string' && isAlphaVersion(entry.version))
  if (candidates.length === 0) return null
  candidates.sort((left, right) => compareVersions(right.version, left.version))
  return /** @type {{tag: string, version: string, commit: string}} */ ({ ...candidates[0] })
}

/**
 * Normalize a git remote so `https://…/repo.git`, `https://…/repo`, and
 * `git@github.com:owner/repo.git` compare equal.
 * @param {string} url - Remote URL.
 * @returns {string} Lowercase `host/owner/repo` form.
 */
export function normalizeRepoUrl(url) {
  let text = String(url ?? '').trim().toLowerCase()
  text = text.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const scp = /^git@([^:]+):(.+)$/u.exec(text)
  if (scp !== null) return `${scp[1]}/${scp[2]}`
  const http = /^(?:https?|ssh):\/\/(?:git@)?([^/]+)\/(.+)$/u.exec(text)
  if (http !== null) return `${http[1]}/${http[2]}`
  return text
}

/**
 * Whether a remote names the upstream repository this plugin clones.
 * @param {string} url - Remote URL from `git remote get-url origin`.
 * @returns {boolean} True for the expected repository.
 */
export function sameRepository(url) {
  const host = normalizeRepoUrl(url)
  return host === `github.com/${ALPHA_SLUG}` || host === `www.github.com/${ALPHA_SLUG}`
}

/**
 * Refuse a source directory that is empty, a drive root, or inside a directory
 * the plugin must not touch.
 * @param {string} value - Configured path.
 * @param {string[]} blocked - Absolute directories that may not contain the source.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}} The resolved path or the refusal.
 */
export function checkSourcePath(value, blocked) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'empty' }
  const input = value.trim()
  if (!isAbsolute(input)) return { ok: false, reason: 'relative' }
  const full = resolve(input)
  const root = parse(full).root
  if (full.toLowerCase() === root.toLowerCase()) return { ok: false, reason: 'root' }
  for (const directory of blocked) {
    if (typeof directory !== 'string' || directory === '') continue
    const rest = relative(resolve(directory), full)
    if (rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))) return { ok: false, reason: 'blocked' }
  }
  return { ok: true, path: full }
}

/**
 * The task the desktop pre-fills into a new session after the clone succeeds.
 * The repository's own documentation drives the toolchain and packaging steps;
 * the plugin only names the paths the user configured.
 * @param {{
 *   version: string,
 *   tag: string,
 *   path: string,
 *   nodePath?: string,
 *   registry?: string,
 *   certificateFile?: string,
 *   signTool?: string,
 *   keyContainer?: string,
 *   signatureCacheDir?: string,
 * }} input - Source facts and toolchain hints.
 * @returns {string} The prompt text.
 */
export function buildBuildPrompt(input) {
  const {
    version, tag, path, nodePath, registry, certificateFile, signTool, keyContainer, signatureCacheDir,
  } = input
  const lines = [
    `源码工作区：${path}`,
    `目标版本：${tag}（${version}）。源码已经检出到这个标签，不要切换标签、不要改动 git 状态、不要提交或推送。`,
    '',
    '任务：按仓库自己的构建说明配置好工具链，并打包出这个版本的 Windows x64 安装包。安装包要带正确的版本号并完成代码签名。',
    '',
    '步骤：',
    '1. 先读仓库根目录的 README、CONTRIBUTING、docs，以及 package.json、pnpm-workspace.yaml 等清单，找到官方构建与打包流程；以仓库文档为准，不要自创流程。',
    '2. 按文档准备 Node 与 pnpm（版本以 .nvmrc、package.json 的 engines、volta 或文档为准），然后安装依赖。',
    '3. 使用仓库自带的打包脚本与 electron-builder 配置构建 Windows x64 安装包；应用版本必须是上面写的目标版本，产物文件名也要带版本号。',
    '4. 按仓库的签名配置完成 Authenticode 签名；构建结束后用 Get-AuthenticodeSignature 核对 Status 与签名主体。',
    '',
    '环境提示（为空则按仓库文档自行决定）：',
  ]
  const hints = [
    ['Node 可执行文件', nodePath],
    ['npm registry', registry],
    ['签名证书文件', certificateFile],
    ['signtool 路径', signTool],
    ['证书容器 / key container', keyContainer],
    ['签名缓存目录', signatureCacheDir],
  ]
  for (const [label, value] of hints) {
    if (typeof value === 'string' && value.trim() !== '') lines.push(`- ${label}：${value.trim()}`)
  }
  if (hints.every(([, value]) => typeof value !== 'string' || value.trim() === '')) lines.push('- 无额外配置')
  lines.push(
    '',
    '完成标准：',
    '- 安装包已生成，绝对路径、版本号、SHA-512 都已核对。',
    '- Authenticode 状态为 Valid，并记录签名主体。',
    '- 只报告结果，不要自动安装，不要退出或重启当前应用。',
    '- 缺少证书、密钥或签名工具时停下来，明确列出缺什么；不要生成自签名证书来冒充正式签名，也不要修改版本号或更新源来"绕过"构建。',
    '',
    '最后请用一段话报告：安装包绝对路径、版本号、SHA-512、签名状态与签名主体。',
  )
  return lines.join('\n')
}
