/**
 * WeChat ⇄ DSH 桥 v0.3.1 · 安全加固版（零硬编码路径）
 * P0-1 白名单(TOFU) / P0-2 共享token+防重放 / P0-3 子进程专用HOME(workspace-write)
 * P0-4 状态原子写+校验 / P0-5 子进程只拿模型密钥 / P1-1 轮询与执行解耦
 * P1-2 任务队列 / P1-3 进程树终止 / P1-5 独立任务日志 / P1-6 失败轮不可信
 *
 * 路径解析（全部可配置，无硬编码绝对路径）：
 *   --data-dir / BRIDGE_DATA / WXBRIDGE_DATA / $DSH_HOME/wxbridge   数据目录
 *   --cwd / BRIDGE_CWD                                              默认工作区
 *   --contract / CONTRACT_FILE                                      身份契约文件
 *   DSH_BIN / PATH 上的 dsh / npm 全局安装位                           DSH 入口
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { AcpHost } from './acp.mjs'
import { ensureAcpPresetSupport, acpPresetSupported, acpPackageFile } from './acp-preset-shim.mjs'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const PROFILE = argOf('--profile', 'headless')
const DEBUG = args.includes('--debug')
const NL = String.fromCharCode(10)
const HERE = dirname(fileURLToPath(import.meta.url))

function resolveDshBin() {
  // 显式指定优先：宿主自己的运行时（与应用同版本）才能写出应用读得懂的会话格式，
  // 否则会写成另一个 schema（version 3 vs 0），会话在应用里"不存在"（2026-09-21 实测）。
  const explicit = argOf('--dsh-bin') || process.env.BRIDGE_DSH_BIN || process.env.DSH_BIN
  if (explicit && existsSync(explicit)) return explicit
  const candidates = [process.env.DSH_BIN]
  for (const p of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(join(p, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return candidates.filter(Boolean).find((f) => { try { return existsSync(f) } catch { return false } }) || ''
}

const STATE_DIR = resolve(argOf('--data-dir') || process.env.BRIDGE_DATA || process.env.WXBRIDGE_DATA
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge'))
const CWD = resolve(argOf('--cwd') || process.env.BRIDGE_CWD || process.cwd())
const DSH_BIN = resolveDshBin()
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DESKTOP_HOME = process.env.OHDSH_HOME || join(homedir(), '.ohdsh')

const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = join(STATE_DIR, 'bridge.log')
const HEARTBEAT_FILE = join(STATE_DIR, 'heartbeat.json')
const LOCK_FILE = join(STATE_DIR, 'bridge.lock')
const CONTRACT_FILE = resolve(argOf('--contract') || process.env.CONTRACT_FILE || join(STATE_DIR, 'second-brain-contract.txt'))
function resolveVault(explicit) {
  if (explicit) return explicit
  if (process.env.BRAIN_VAULT) return process.env.BRAIN_VAULT
  const cfgDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge')
  for (const f of [process.env.WXBRIDGE_CONFIG, join(cfgDir, 'config.json'), join(process.cwd(), 'wxbridge.json')]) {
    try { const v = JSON.parse(readFileSync(f, 'utf8')).vault; if (v) return v } catch {}
  }
  return join(homedir(), 'Brain', 'vault')
}
const VAULT_PATH = resolveVault(argOf('--vault'))
/**
 * HOST_HOME：宿主（桌面应用/CLI web）的 DSH_HOME。给了它 → 子进程会话直接写进**宿主的会话仓库**，
 * 于是手机对话会出现在桌面工作区里、可点开继续（同一个工作区按 identity.cwd 绑定）。
 * 不给 → 保持旧行为：私有隔离 home（只拿模型密钥，会话不对外可见）。
 */
const HOST_HOME = argOf('--host-home') || process.env.BRIDGE_HOST_HOME || ''
/**
 * OWNER_PID：宿主托管（lifecycle=host）时由宿主传入自己的 pid。
 * 桥每 20s 检查一次「主人还在不在」，不在就自己退出——保证应用关闭后
 * 不会有游离在外的常驻进程（即使应用是被强杀的、来不及优雅收尾）。
 */
const OWNER_PID = Number(argOf('--owner-pid') || process.env.BRIDGE_OWNER_PID || 0) || 0
const AUTH_FILE = join(STATE_DIR, 'auth-token.txt')
const TASKS_DIR = join(STATE_DIR, 'tasks')
const CHILD_HOME = join(STATE_DIR, 'dsh-home')
const DESKTOP_WS_FILE = join(DESKTOP_HOME, 'storages', 'workspace.json')
const CLI_WS_FILE = join(DSH_HOME, 'storages', 'workspace.json')

const API_BASE = process.env.ILINK_BASE || 'https://ilinkai.weixin.qq.com'
const PROTOCOL_VERSION = '2.4.6'
const BRIDGE_VERSION = '0.4.0'
const BOOT_ID = process.pid
const MESSAGE_TYPE_BOT = 2
const ITEM_TYPE_TEXT = 1
const MAX_CHUNK = 1500
const HEARTBEAT_MS = 30000
const TASK_TIMEOUT_MS = Number(process.env.BRIDGE_TASK_TIMEOUT_MS || 300000)
const MAX_CONCURRENT_TASKS = Number(process.env.BRIDGE_MAX_TASKS || 2)
const DEDUP_WINDOW_MS = 24 * 3600 * 1000
/**
 * 授权策略：
 *   auto   （默认）—— 任何给本 bot 发消息的联系人自动登记 + 记审计日志。
 *                        准入边界前移到「扫码拿到 bot 控制权」那一步：能扫码 = 本来就有权。
 *                        换号/多台手机都无需干预（2026-09-21 用户反馈后定为默认）。
 *   strict —— 只认白名单；未登记的一律丢弃（旧行为）。
 *   open   —— 不做任何检查（不建议：任何能找到该 bot 的号都能驱动本机）。
 */
const ALLOWLIST = (argOf('--allowlist') || process.env.WXBRIDGE_ALLOWLIST || 'auto').toLowerCase()
/**
 * 执行模式：
 *   host     （默认，若宿主可达）—— 任务交给宿主进程执行：原生会话 + 原生上下文，
 *             会话自动归属工作区、手机与桌面是同一条会话。
 *   headless （回落）—— 宿主不可达时仍用一次性 dsh 子进程（行为同旧版）。
 * 配置项 execution 可强制指定；auto = 能用宿主就用宿主。
 */
const EXECUTION = (argOf('--execution') || process.env.WXBRIDGE_EXECUTION || 'auto').toLowerCase()
/**
 * 桥的配置文件（$DSH_HOME/wxbridge/config.json，面板/手写均可）。
 */
function loadBridgeConfig() {
  for (const f of [process.env.WXBRIDGE_CONFIG, join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge', 'config.json')]) {
    try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j && typeof j === 'object') return j } catch {}
  }
  return {}
}
const BRIDGE_CONFIG = loadBridgeConfig()
const ACP_CFG = (BRIDGE_CONFIG && typeof BRIDGE_CONFIG.acp === 'object') ? BRIDGE_CONFIG.acp : {}
/**
 * ACP 路径（首选执行方式）：桥起一个常驻 `dsh --profile acp`，用 Agent Client Protocol
 * 驱动 **DSH 原生会话** —— 上下文由 DSH 持久化持有（可 resume），桥不再把历史拼进提示词。
 * 关掉：config.json 里 acp.enabled=false，或环境变量 WXBRIDGE_ACP=off。
 */
const ACP_ENABLED = !(argOf('--acp') === 'off' || process.env.WXBRIDGE_ACP === 'off' || ACP_CFG.enabled === false)
const ACP_HOME = ACP_CFG.home || HOST_HOME || CHILD_HOME
const ACP_PATCH = ACP_CFG.patch || join(HERE, 'acp-overlay.yml')
const ACP_PERM = ACP_CFG.permPolicy === 'reject' ? 'reject' : 'allow'
/**
 * ACP 用哪个 dsh 入口：会话仓库归谁，就用谁的运行时（schema 必须对得上，
 * 否则应用读不懂外部写的会话 —— 2026-09-21 实锤的 v0/v3 分裂）。
 */
function resolveAcpBin() {
  const explicit = ACP_CFG.dshBin || process.env.BRIDGE_ACP_DSH_BIN
  if (explicit && existsSync(explicit)) return explicit
  if (existsSync(join(ACP_HOME, 'profiles', 'desktop'))) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const cands = [
      join(local, 'Programs', 'Oh-DSH Desktop', 'resources', 'dsh-runtime', 'lib', 'bin.js'),
      join(process.env.PROGRAMFILES || 'C:/Program Files', 'Oh-DSH Desktop', 'resources', 'dsh-runtime', 'lib', 'bin.js'),
    ]
    const hit = cands.filter((f) => { try { return existsSync(f) } catch { return false } })[0]
    if (hit) return hit
  }
  return DSH_BIN
}

for (const d of [STATE_DIR, TASKS_DIR, CHILD_HOME]) mkdirSync(d, { recursive: true })

const log = (m, extra) => {
  const line = new Date().toISOString() + ' ' + m + (extra ? ' ' + JSON.stringify(extra) : '')
  if (DEBUG) console.log(line)
  try { appendFileSync(LOG_FILE, line + NL) } catch {}
}

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const old = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
      if (old && old.pid) {
        let alive = false
        try { process.kill(old.pid, 0); alive = true } catch {}
        let fresh = false
        try {
          const hb = JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8'))
          fresh = !!(hb && hb.pid === old.pid && (Date.now() - Date.parse(hb.at)) < 120000)
        } catch {}
        // 只有「pid 活着 **且** 心跳新鲜」才算真在跑；否则接管陈旧锁并说明原因。
        //（Windows 上 pid 会复用：只看 pid 会让新实例**静默 exit 0**，表现为"启动不了"。）
        if (alive && fresh) { console.log('[bridge] 已有实例 pid=' + old.pid + '，退出'); process.exit(0) }
        console.log('[bridge] 接管陈旧锁 pid=' + old.pid + '（alive=' + alive + ' fresh=' + fresh + '）')
      }
    }
  } catch {}
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const release = () => { try { writeFileSync(LOCK_FILE, '{}') } catch {} }
  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(0) })
  process.on('SIGTERM', () => { release(); process.exit(0) })
}

function loadAuthToken() {
  if (process.env.DSH_BRIDGE_TOKEN) return process.env.DSH_BRIDGE_TOKEN.trim()
  try { const t = readFileSync(AUTH_FILE, 'utf8').trim(); if (t) return t } catch {}
  const t = randomBytes(12).toString('hex')
  writeFileSync(AUTH_FILE, t + NL)
  try { spawn('cmd.exe', ['/c', 'icacls "' + AUTH_FILE + '" /inheritance:r /grant:r "' + process.env.USERNAME + ':R"'], { windowsHide: true, stdio: 'ignore' }).unref() } catch {}
  return t
}
const AUTH_TOKEN = loadAuthToken()

/**
 * 注入给每条手机任务的提示词（原来固定是内置的 second-brain 契约）。
 * 现在优先级：配置里的自定义提示词 > 内置契约模板文件 > 空。
 * 空字符串表示"不注入任何身份提示词"——不想让提示词出现在微信里的用户选这个。
 */
function loadPromptText() {
  const cfgFile = process.env.WXBRIDGE_CONFIG
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge', 'config.json')
  try {
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
    if (typeof cfg.prompt === 'string') return cfg.prompt.trim()
  } catch {}
  try {
    return readFileSync(CONTRACT_FILE, 'utf8').trim()
      .replace(/\{\{vault\}\}/g, VAULT_PATH)
      .replace(/\{\{cwd\}\}/g, CWD)
      .replace(/\{\{model\}\}/g, process.env.BRIDGE_MODEL_LABEL || 'DeepSeek')
  } catch { return '' }
}
let CONTRACT = loadPromptText()
let CONTRACT_HASH = CONTRACT ? createHash('sha256').update(CONTRACT).digest('hex').slice(0, 12) : 'none'
let PROMPT_PREFIX = CONTRACT ? CONTRACT.split(NL).join(' ') + '  【以上为固定身份与铁律；下面是本轮对话】 ' : ''

function promptConfigPath() {
  return process.env.WXBRIDGE_CONFIG
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge', 'config.json')
}
let PROMPT_MTIME = 0
try { PROMPT_MTIME = statSync(promptConfigPath()).mtimeMs } catch {}

/** 提示词热重载：面板保存后下一条任务即生效，不必重启桥。 */
function reloadPromptIfChanged() {
  const f = promptConfigPath()
  let mt = 0
  try { mt = statSync(f).mtimeMs } catch { return }
  if (mt === PROMPT_MTIME) return
  PROMPT_MTIME = mt
  const next = loadPromptText()
  if (next === CONTRACT) return
  CONTRACT = next
  CONTRACT_HASH = CONTRACT ? createHash('sha256').update(CONTRACT).digest('hex').slice(0, 12) : 'none'
  PROMPT_PREFIX = CONTRACT ? CONTRACT.split(NL).join(' ') + '  【以上为固定身份与铁律；下面是本轮对话】 ' : ''
  log('prompt-hot-reloaded', { len: CONTRACT.length, hash: CONTRACT_HASH })
}

function loadRefsFrom(home, excludeWechat) {
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return {}
  const out = {}; let inRefs = false
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (/^[A-Za-z_]/.test(line)) { inRefs = false; continue }
    if (!inRefs) continue
    const m = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/)
    if (!m) continue
    if (excludeWechat && m[1] === 'DSH_WEIXIN_BOT_TOKEN') continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
function prepareChildHome() {
  // 合并所有已知密钥来源：本机 DSH_HOME、宿主 home、已有子进程 home
  const refs = {}
  for (const src of [DSH_HOME, HOST_HOME, CHILD_HOME]) {
    if (!src) continue
    Object.assign(refs, loadRefsFrom(src, true))
  }
  for (const k of Object.keys(refs)) process.env[k] ||= refs[k]

  if (HOST_HOME) {
    // 共享模式：会话写进宿主仓库 → 手机对话在桌面工作区可见、可继续。
    // 只补密钥，**不动**宿主自己的 settings.yaml（那是用户的配置）。
    // 合并写入：保留宿主已有的密钥（ZHIPUAI_API_KEY / OPENCODE_GO_API_KEY / 微信 token 等）
    const cred = join(HOST_HOME, '.credentials.yaml')
    const existing = loadRefsFrom(HOST_HOME, false)
    const merged = { ...existing, ...refs }
    writeFileSync(cred, ['version: 1', 'refs:'].concat(Object.keys(merged).map((k) => '  ' + k + ': ' + merged[k])).join(NL) + NL)
    if (!Object.keys(merged).some((k) => /API_KEY$/.test(k))) log('warn: 宿主 home 里没有找到任何 *_API_KEY，无头任务可能因缺密钥失败')
    const prof = join(HOST_HOME, 'profiles', 'headless')
    mkdirSync(join(prof, 'node_modules'), { recursive: true })
    writeFileSync(join(prof, 'package.json'), JSON.stringify({
      name: 'dsh-profile-headless', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } },
    }, null, 2) + NL)
    writeFileSync(join(prof, 'cordis.yml'), '# dsh profile root (managed by wxbridge)' + NL + '[]' + NL)
    writeFileSync(join(prof, 'cordis.patch.yml'),
      '# wxbridge: keep headless permissions narrow without touching the host settings.yaml' + NL
      + '- id: permission' + NL + '  config:' + NL + '    defaultPreset: workspace-write' + NL)
    return { refs: Object.keys(refs), home: HOST_HOME, shared: true }
  }

  const target = join(CHILD_HOME, '.credentials.yaml')
  writeFileSync(target, ['version: 1', 'refs:'].concat(Object.keys(refs).map((k) => '  ' + k + ': ' + refs[k])).join(NL) + NL)
  // 默认预设**不写死**：预设由用户自己的 DSH 决定（ACP 会话本就不加入预设；写死某个人的预设
  // 等于把插件产品绑到某个人的环境上）。
  writeFileSync(join(CHILD_HOME, 'settings.yaml'), 'permission:' + NL + '  defaultPreset: workspace-write' + NL)
  try { spawn('cmd.exe', ['/c', 'icacls "' + target + '" /inheritance:r /grant:r "' + process.env.USERNAME + ':R"'], { windowsHide: true, stdio: 'ignore' }).unref() } catch {}
  return { refs: Object.keys(refs), home: CHILD_HOME, shared: false }
}
let TOKEN_FILE = ''       // 当前 token 的来源文件（用于热更新检测）
let TOKEN_MTIME = 0
function loadWechatToken() {
  if (process.env.DSH_WEIXIN_BOT_TOKEN) { TOKEN_FILE = '@env'; return process.env.DSH_WEIXIN_BOT_TOKEN }
  // 依次在 本机 DSH_HOME / 宿主 home / 子进程 home 里找微信 token：
  // 桌面端的 token 存在宿主 home，而模型密钥可能存在另一个 home —— 两者都认才不会被部署形态卡死。
  const tried = []
  // 宿主 home 优先：扫码配对是在宿主进程里发生的，新 token 会写进宿主的 home；
  // 若仍优先读旧 DSH_HOME，桥会拿着过期 token 轮询，表现为"消息收不到"（2026-09-21 实锤）。
  for (const home of [HOST_HOME, DSH_HOME, CHILD_HOME]) {
    if (!home) continue
    const f = join(home, '.credentials.yaml')
    tried.push(f)
    try {
      const m = readFileSync(f, 'utf8').match(/^\s*DSH_WEIXIN_BOT_TOKEN:\s*(.+)$/m)
      if (m) { TOKEN_FILE = f; return m[1].trim().replace(/^["']|["']$/g, '') }
    } catch {}
  }
  throw new Error('DSH_WEIXIN_BOT_TOKEN not found in: ' + tried.join(' ; '))
}

const emptyState = () => ({ syncBuf: '', processed: [], peers: {}, allowedUsers: [], tasks: {}, account: null })
const checksumOf = (o) => { const c = { ...o }; delete c.checksum; return createHash('sha256').update(JSON.stringify(c)).digest('hex') }
function loadState() {
  if (!existsSync(STATE_FILE)) return emptyState()
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw.checksum && raw.checksum !== checksumOf(raw)) {
      try { renameSync(STATE_FILE, STATE_FILE + '.tampered-' + Date.now()) } catch {}
      log('state-checksum-mismatch: quarantined')
      return emptyState()
    }
    raw.peers ||= {}; raw.allowedUsers ||= []; raw.tasks ||= {}; raw.processed ||= []
    return raw
  } catch (e) { log('state-load-failed', { error: String(e?.message ?? e) }); return emptyState() }
}
let stateChain = Promise.resolve()
function saveState(s) {
  s.processed = s.processed.slice(-500)
  for (const k of Object.keys(s.peers)) s.peers[k].history = (s.peers[k].history || []).slice(-50)
  for (const k of Object.keys(s.tasks)) { const t = s.tasks[k]; if (t.status !== 'running' && t.endedAt && Date.now() - Date.parse(t.endedAt) > 3600000) delete s.tasks[k] }
  s.checksum = checksumOf(s)
  const tmp = STATE_FILE + '.tmp'
  stateChain = stateChain.then(() => { try { writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, STATE_FILE); lastSelfSave = Date.now() } catch (e) { log('state-write-failed', { error: String(e?.message ?? e) }) } })
  return stateChain
}

let pollCount = 0, activeTasks = 0
function beat(phase) { try { writeFileSync(HEARTBEAT_FILE, JSON.stringify({ at: new Date().toISOString(), phase, polls: pollCount, tasks: activeTasks, pid: process.pid, boot: BOOT_ID })) } catch {} }

function readWorkspaces() {
  const out = []
  const add = (t, p) => { if (p && !out.some((w) => w.path.toLowerCase() === String(p).toLowerCase())) out.push({ title: t || p, path: String(p) }) }
  for (const f of [DESKTOP_WS_FILE, CLI_WS_FILE]) { try { const d = JSON.parse(readFileSync(f, 'utf8')); const ws = (d?.tables?.workspaces) || {}; for (const k of Object.keys(ws)) add(ws[k].title, ws[k].path) } catch {} }
  return out
}
function workspaceListText(peer) {
  const list = readWorkspaces()
  if (!list.length) return '（未读到工作区列表）'
  const lines = ['可用工作区（来自桌面端）：']
  list.forEach((w, i) => lines.push((i + 1) + '. ' + w.title + NL + '   ' + w.path + (peer.cwd && w.path.toLowerCase() === peer.cwd.toLowerCase() ? '  ← 当前' : '')))
  lines.push(NL + '切换：/ws <序号>  或  /ws <完整路径>')
  return lines.join(NL)
}

const BAD_CODES = [34, 38, 124, 60, 62, 94, 37, 33, 96, 45, 40, 41, 123, 125, 91, 93, 59, 58, 39, 92, 36, 35, 42, 43, 61, 126, 64, 63, 47]
const BAD_CHARS = BAD_CODES.map((c) => String.fromCharCode(c)).concat(['—', '–', '　', NL, String.fromCharCode(13)])
const sanitize = (t) => { let o = String(t ?? ''); for (const c of BAD_CHARS) o = o.split(c).join(' '); while (o.indexOf('  ') >= 0) o = o.split('  ').join(' '); return o.trim() }

const randomUin = () => String(1000000000 + (randomBytes(4).readUInt32BE(0) % 1000000000))
const commonHeaders = () => ({ 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6) })
const baseInfo = () => ({ channel_version: PROTOCOL_VERSION, bot_agent: 'DSH-bridge/' + BRIDGE_VERSION })
async function ilink(endpoint, { token, body, method = 'POST', timeoutMs = 15000 } = {}) {
  const url = new URL(endpoint, API_BASE + '/')
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? commonHeaders() : { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': randomUin(), ...commonHeaders(), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: ctl.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 300))
    return JSON.parse(raw)
  } finally { clearTimeout(t) }
}
const getUpdates = (token, syncBuf, timeoutMs) => ilink('ilink/bot/getupdates', { token, body: { get_updates_buf: syncBuf, base_info: baseInfo() }, timeoutMs })
  .catch((e) => { if (e?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: syncBuf }; throw e })
const sendText = (token, to, text, contextToken) => ilink('ilink/bot/sendmessage', {
  token,
  body: { msg: { from_user_id: '', to_user_id: to, client_id: 'dsh-bridge-' + randomUUID(), message_type: MESSAGE_TYPE_BOT, message_state: 2, item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }], ...(contextToken ? { context_token: contextToken } : {}) }, base_info: baseInfo() },
})

function inboundText(msg) { for (const it of msg?.item_list ?? []) if (it?.type === ITEM_TYPE_TEXT && typeof it.text_item?.text === 'string') return it.text_item.text; return '' }
const msgKey = (m) => 'id:' + (m?.msg_id ?? m?.message_id ?? m?.client_id ?? JSON.stringify(m).slice(0, 80))

const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{16,}/g, /ghp_[A-Za-z0-9]{20,}/g, /AKIA[0-9A-Z]{16}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g]
const EXFIL_HINT = /(curl|wget|Invoke-WebRequest|nc\.exe|ncat)[^\n]{0,120}(https?:\/\/|\d{1,3}(\.\d{1,3}){3})/i
function auditOutput(text) {
  let out = String(text ?? ''); const hits = []
  for (const re of SECRET_PATTERNS) if (re.test(out)) { hits.push('secret-pattern'); out = out.replace(re, '[REDACTED]') }
  if (EXFIL_HINT.test(out)) { hits.push('exfil-command'); out = '⚠️ 输出疑似包含外发命令，已阻断回传。' + NL + out.slice(0, 200) }
  if (out.length > 20000) { hits.push('oversize'); out = out.slice(0, 20000) + NL + '…（已截断）' }
  return { text: out, hits }
}

let hostPort = 0
let hostPortCheckedAt = 0
const HOST_HOSTS = ['127.0.0.1']
/** 发现宿主：优先 host-address.json，其次在已知端口上探 /wxbridge/status。 */
async function discoverHost() {
  if (EXECUTION === 'headless') return 0
  const now = Date.now()
  if (hostPort && now - hostPortCheckedAt < 60000) return hostPort
  hostPortCheckedAt = now
  const cands = []
  for (const f of [join(STATE_DIR, 'host-address.json')]) {
    try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j && j.port) cands.push(Number(j.port)) } catch {}
  }
  if (process.env.WXBRIDGE_HOST_PORT) cands.push(Number(process.env.WXBRIDGE_HOST_PORT))
  // 从最近的 dsh web 启动日志里捞端口（桌面/CLI 宿主都会打印）
  for (const f of [join(DESKTOP_HOME, 'logs', 'desktop.log')]) {
    try {
      const txt = readFileSync(f, 'utf8')
      const all = [...txt.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=/g)].map((m) => Number(m[1]))
      for (const v of all.slice(-3)) cands.push(v)
    } catch {}
  }
  for (const port of [...new Set(cands)].filter(Boolean)) {
    for (const h of HOST_HOSTS) {
      try {
        const r = await fetch('http://' + h + ':' + port + '/wxbridge/status', { signal: AbortSignal.timeout(2500) })
        const j = await r.json().catch(() => null)
        if (r.ok && j && j.plugin === 'wxbridge') { hostPort = port; log('host-discovered', { port: hostPort }); return hostPort }
      } catch {}
    }
  }
  hostPort = 0
  return 0
}

/** 把一轮任务交给宿主执行：原生会话 + 原生上下文 + 自动归属工作区。 */
async function runViaHost(text, peer, taskId) {
  const port = await discoverHost()
  if (!port) return null
  try {
    const body = JSON.stringify({ text, cwd: peer.cwd || CWD, sessionId: peer.sessionId || '' })
    const r = await fetch('http://127.0.0.1:' + port + '/wxbridge/task', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
    })
    const j = await r.json()
    if (!j || j.ok !== true) return { ok: false, text: '', error: 'host task: ' + String((j && j.error) || 'unknown') }
    // 宿主路径可用时才采用：宿主返回空文本（=那一轮没真正执行）则回落 headless，避免用户干等超时
    const hostText = String(j.text || '').trim()
    if (!hostText) {
      log('host-task-empty', { session: j.sessionId, reason: j.reason || null, fallback: 'headless' })
      return null
    }
    if (j.sessionId && j.sessionId !== peer.sessionId) {
      peer.sessionId = j.sessionId
      saveState(state)
    }
    log('task-done-host', { id: taskId, session: j.sessionId, created: !!j.created, outLen: (j.text || '').length })
    return { ok: true, text: String(j.text || '').trim() || '(宿主已执行，回复为空)', sessionId: j.sessionId, viaHost: true }
  } catch (e) {
    log('host-task-failed', { error: String(e?.message ?? e) })
    return null
  }
}

/**
 * 每个 peer 一条 DSH 原生会话：有 id 就 resume，没有就新建。
 * 会话 id 存在 state.peers[from].acpSession —— 桥重启后继续用同一条（上下文不丢）。
 */
/**
 * 读宿主 settings.yaml 的 agent-default-model（桌面端默认模型/强度），
 * 作为新会话的初始选择 —— 手机看到的「当前模型」与桌面端一致。
 * YAML 只做定点解析（不引依赖）；解析不到就返回 null。
 */
function readHostDefaultModel() {
  try {
    const t = readFileSync(join(ACP_HOME, 'settings.yaml'), 'utf8')
    const seg = t.split(/^agent-default-model:/m)[1]
    if (!seg) return null
    const block = seg.split(/^[a-z][a-z0-9-]*:/m)[0]
    const provider = (block.match(/provider:\s*([^\s#]+)/) || [])[1]
    const model = (block.match(/model:\s*([^\s#]+)/) || [])[1]
    const effort = (block.match(/reasoningEffort:\s*([^\s#]+)/) || [])[1]
    if (!provider || !model) return null
    return { value: JSON.stringify([provider, model]), effort: effort || '' }
  } catch { return null }
}
/**
 * 模式 → 叠加层。默认「对话模式」：收窄注入面（无技能目录 + 对话人格），
 * 避免手机随口一句话被当成第二大脑任务落盘；`/brain on` 切到第二大脑模式。
 */
/**
 * 通道档位（= 预设档）：'chat' 是插件自带的「普通对话」；其余值是 DSH 名册里的预设 id。
 * 默认档：config.json 的 acp.preset → 宿主 settings 的 agent-presets.default → 'chat'。
 */
const ACP_DEFAULT_PRESET = ACP_CFG.preset || readHostDefaultPreset() || 'chat'
const acpHosts = new Map()
const overlayCache = new Map()
/** 兼容旧字段：peer.acpMode（'brain'/'chat'）仍认，新字段 peer.acpPreset 优先。 */
function presetKey(peer) {
  const k = String(peer.acpPreset || '').trim()
  if (k) return k
  if (peer.acpMode === 'brain') return ACP_DEFAULT_PRESET
  if (peer.acpMode === 'chat') return 'chat'
  return ACP_DEFAULT_PRESET
}
function overlayFor(key) {
  if (key === 'chat') return join(HERE, 'acp-overlay-chat.yml')
  if (!overlayCache.has(key)) overlayCache.set(key, ensurePresetOverlay(key) || '')
  return overlayCache.get(key) || ACP_PATCH
}
function peerMode(peer) { return presetKey(peer) }
/** ACP 会话配置目录（session/new 返回，供 /model、/effort 列选用）。 */
let acpModelCatalog = []
let acpEffortCatalog = []
function flattenConfigOptions(opts) {
  for (const o of opts || []) {
    if (o.id === 'model') {
      const list = []
      for (const g of o.options || []) for (const it of g.options || []) list.push({ group: g.name || g.group || '', label: it.name || it.value, value: it.value })
      if (list.length) acpModelCatalog = list
    }
    if (o.id === 'reasoning_effort') {
      const list = []
      for (const it of o.options || []) list.push({ label: it.name || it.value, value: it.value })
      if (list.length) acpEffortCatalog = list
    }
  }
}
function getAcpHost(key) {
  const k = String(key || ACP_DEFAULT_PRESET).trim() || ACP_DEFAULT_PRESET
  if (!acpHosts.has(k)) acpHosts.set(k, new AcpHost({
    bin: resolveAcpBin(), home: ACP_HOME, cwd: CWD, patch: overlayFor(k),
    permPolicy: ACP_PERM, promptTimeoutMs: TASK_TIMEOUT_MS, log,
  }))
  return acpHosts.get(k)
}
/** 预设名册：用户预设（$ACP_HOME/.agent-presets）优先，其次运行时的出厂树与包内预设。 */
function presetRoots() {
  const roots = [join(ACP_HOME, '.agent-presets')]
  try {
    const rt = dirname(dirname(resolveAcpBin()))
    roots.push(join(rt, 'config', 'agent-presets'))
    roots.push(join(rt, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'))
  } catch {}
  return roots
}
/** 各根的可读性诊断（排障用；也进自检输出）。 */
function presetRootsDiag() {
  return presetRoots().map((r) => { let n = -1; try { n = readdirSync(r).length } catch {} return { path: r, entries: n } })
}
function listPresets() {
  const roots = presetRoots()
  const seen = new Set(); const out = []
  for (const root of roots) {
    let ids = []
    try { ids = readdirSync(root) } catch { continue }
    for (const id of ids) {
      if (String(id).startsWith('.') || /\.bak/.test(id) || seen.has(id)) continue
      const dir = join(root, id)
      if (!existsSync(join(dir, 'agent.cordis.yml'))) continue
      let meta = ''
      try { meta = readFileSync(join(dir, 'preset.yml'), 'utf8') } catch { continue }
      const pick = (k) => { const m = meta.match(new RegExp('^' + k + ':[ \t]*(.+)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : '' }
      seen.add(id)
      out.push({ id, name: pick('name') || id, description: pick('description'), order: Number(pick('order') || 999),
                 src: root === roots[0] ? 'user' : 'shipped' })
    }
  }
  // 用户预设排前面（同 order 时），再按 order 与 id 排
  return out.sort((a, b) => (a.src === b.src ? 0 : (a.src === 'user' ? -1 : 1)) || (a.order - b.order) || String(a.id).localeCompare(String(b.id)))
}
/** peer × 模式 的会话槽；升级兼容：旧 peer.acpSession 归入第二大脑模式槽。 */
function sessionSlot(peer, mode) {
  if (!peer.acpSessions) {
    peer.acpSessions = {}
    if (peer.acpSession) peer.acpSessions.brain = { id: peer.acpSession, cwd: peer.acpCwd || CWD }
  }
  if (!peer.acpSessions[mode]) peer.acpSessions[mode] = { id: '', cwd: '' }
  return peer.acpSessions[mode]
}

/** 逐帧解 DSH 会话文件（多帧 zstd；Node 公开 API 只解第一帧，必须逐帧）。 */
function readSessionEvents(file) {
  let raw
  try { raw = readFileSync(file) } catch { return null }
  const offs = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offs.push(i)
  }
  let text = ''
  for (const off of offs) { try { text += zstdDecompressSync(raw.subarray(off)).toString('utf8') } catch {} }
  const out = []
  for (const line of text.split(NL)) {
    const t = line.trim(); if (!t) continue
    try { out.push(JSON.parse(t)) } catch {}
  }
  return out
}
/** 找会话文件：只需在 $DSH_HOME/sessions/<工作区槽>/<sessionId>/ 一层里找，不依赖槽名规则。 */
function findSessionFile(sessionId) {
  const root = join(ACP_HOME, 'sessions')
  let dirs = []
  try { dirs = readdirSync(root) } catch { return '' }
  for (const d of dirs) {
    const f = join(root, d, sessionId, 'session.jsonl.zstd')
    if (existsSync(f)) return f
  }
  return ''
}
/** 关键标记：能据此判断会话到底按哪一档组装的。 */
const PRESET_MARKS = [
  ['DSH.md', '契约手册'],
  ['唯一记忆真源', '记忆契约'],
  ['四查', '四查检索'],
  ['落盘仪式', '落盘仪式'],
  ['手机微信通道', '插件对话人格'],
]
/**
 * 预设自检：读该档当前会话的日志，回报「system 长度 + 命中标记 + 会话头 agentPreset + 所用叠层」。
 * 没有 request/header（还没跑过一轮）时如实说明。
 */
async function presetSelfCheck(peer) {
  const key = presetKey(peer)
  const sid = await ensurePeerSession(peer)
  const file = findSessionFile(sid)
  const evs = file ? readSessionEvents(file) : null
  const head = evs ? evs.find((e) => e.type === 'session') : null
  const req = evs ? evs.find((e) => e.type === 'request/header') : null
  const sys = String((req && req.data && req.data.header && req.data.header.system) || '')
  return {
    preset: key, default: ACP_DEFAULT_PRESET, session: sid,
    ran: !!req, systemChars: sys.length,
    marks: sys ? PRESET_MARKS.filter(([m]) => sys.includes(m)).map(([, label]) => label) : [],
    agentPreset: (head && head.agentPreset) || null,
    patch: basename(overlayFor(key) || '') || null,
    acpPid: getAcpHost(key).pid || 0,
  }
}

async function ensurePeerSession(peer) {
  const mode = peerMode(peer)
  const host = getAcpHost(mode)
  const slot = sessionSlot(peer, mode)
  const cwd = peer.cwd || CWD
  if (slot.id && slot.cwd === cwd) {
    // 本进程已挂载 → 直接用。**不能 resume**：ACP 的 resume 只接「非激活」的持久会话，
    // 对已激活的会报 "session is already active"（2026-09-21 实测：导致每问一句都新建会话、看起来没上下文）。
    if (host.has(slot.id)) {
      await applyPeerConfig(peer, slot.id)
      return slot.id
    }
    try {
      await host.resumeSession(slot.id, cwd)
      await applyPeerConfig(peer, slot.id)
      return slot.id
    } catch (e) {
      const msg = String(e?.message ?? e)
      log('acp-resume-failed', { mode, session: slot.id, error: msg })
      if (/already active/i.test(msg)) peer.acpNotice = '⚠️ 这条会话正被其它端占用（桌面端开着？），本轮另起了一条新会话继续。'
    }
  }
  const r = await host.newSession(cwd)
  slot.id = r?.sessionId || ''
  slot.cwd = cwd
  flattenConfigOptions(r?.configOptions)
  if (Array.isArray(r?.configOptions)) peer.acpConfig = r.configOptions.map((o) => o.id).join(',')
  await applyPeerConfig(peer, slot.id)
  await saveState(state)
  log('acp-session-ensured', { mode, session: slot.id })
  return slot.id
}

/**
 * 把 peer 选的模型/推理强度施加到当前会话。
 * **必须每次 new/resume 后都做**：实测 resume 后会话会掉回 acp profile 的默认模型
 * （配置不随会话日志持久化），所以不能只在“选的时候”设一次。
 */
/** 读宿主 settings.yaml 的 agent-presets.default（用户默认预设）；解析不到返回 ''。 */
function readHostDefaultPreset() {
  try {
    const t = readFileSync(join(ACP_HOME, 'settings.yaml'), 'utf8')
    const seg = t.split(/^agent-presets:/m)[1]
    if (!seg) return ''
    const block = seg.split(/^[a-z][a-z0-9-]*:/m)[0]
    return (block.match(/default:\s*([^\s#]+)/) || [])[1] || ''
  } catch { return '' }
}
/**
 * 生成「跟随预设」档位用的叠加层：挂预设插件 + 把选定的预设钉给本进程的 ACP 会话。
 * 预设 id 来自 config.acp.preset 或宿主默认（不写死），文件写在数据目录，可人工查看/修改。
 */
function ensurePresetOverlay(presetId) {
  if (!presetId) return ''
  // 上游兼容层：已装的 dsh-acp 还不支持 Config.preset 时，幂等打一个小补丁
  //（应用升级会覆盖它，所以每次启动都校验一次；config.acp.patchAcp=false 可关闭）
  const bin = resolveAcpBin()
  if (ACP_CFG.patchAcp !== false) {
    try {
      const r = ensureAcpPresetSupport({ runtimeBin: bin, log })
      log('acp-preset-shim', { status: r.status, detail: r.detail || null, backup: r.backup ? basename(r.backup) : null })
    } catch (e) { log('acp-preset-shim-failed', { error: String(e?.message ?? e) }) }
  }
  // 护栏：仍不支持 → 退回宿主组合（不写 preset/预设插件，避免未知配置项把整条通道带崩）
  if (!acpPresetSupported(acpPackageFile(bin))) {
    log('acp-preset-unsupported', { note: 'dsh-acp 无 Config.preset（上游未支持 / 形状不符 / 补丁被冲掉）→ 退回宿主组合' })
    return ''
  }
  const f = join(STATE_DIR, 'acp-preset-' + String(presetId).replace(/[^A-Za-z0-9_-]/g, '_') + '.yml')
  const roots = join(ACP_HOME, '.agent-presets').split(String.fromCharCode(92)).join('/')
  const yml = [
    '# 由 wxbridge 生成：ACP 会话加入用户预设（config.acp.preset 或宿主 settings 的 agent-presets.default）',
    '# 依赖 dsh-acp 支持 Config.preset（上游未支持时该行会被忽略，行为退回宿主组合）。',
    '- id: dsh-computer-use',
    '  disabled: true',
    '# 手机通道不需要审批（手机无法应答）：权限预设放到最宽',
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '- id: acp',
    '  config:',
    '    provider: ' + (ACP_CFG.provider || 'deepseek-official'),
    '    model: ' + (ACP_CFG.model || 'deepseek-v4-flash'),
    '    preset: ' + presetId,
    '- insert:',
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '      config:',
    '        default: ' + presetId,
    '        roots:',
    '          - path: ' + roots,
  ].join(NL) + NL
  try { writeFileSync(f, yml); return f } catch (e) {
    log('preset-overlay-write-failed', { error: String(e?.message ?? e) })
    return ''
  }
}

async function applyPeerConfig(peer, sessionId) {
  const sid = sessionId || sessionSlot(peer, peerMode(peer)).id
  if (!sid) return
  // 还没自己选过 → 跟随宿主默认（桌面端 settings.yaml 的 agent-default-model）
  if (!peer.acpModel) {
    const d = readHostDefaultModel()
    if (d) { peer.acpModel = d.value; if (!peer.acpEffort && d.effort) peer.acpEffort = d.effort }
  }
  const host = getAcpHost(peerMode(peer))
  try {
    if (peer.acpModel) await host.setConfigOption(sid, 'model', peer.acpModel)
    if (peer.acpEffort) await host.setConfigOption(sid, 'reasoning_effort', peer.acpEffort)
  } catch (e) { log('acp-config-apply-failed', { error: String(e?.message ?? e) }) }
}

/**
 * 一轮任务走 ACP：把用户原话交给 DSH 会话（**不拼接历史**），上下文由 DSH 维护。
 * 失败返回 null，由调用方回落宿主/headless 路径。
 */
async function runViaAcp(text, peer, taskId) {
  if (!ACP_ENABLED) return null
  try {
    const sessionId = await ensurePeerSession(peer)
    if (!sessionId) return null
    const rec = state.tasks[taskId]
    if (rec) { rec.session = sessionId; rec.mode = 'acp' }
    const r = await getAcpHost(peerMode(peer)).ask(sessionId, text, (u) => {
      if (u.sessionUpdate === 'tool_call') log('acp-tool', { id: taskId, title: u.title, status: u.status })
    })
    log('task-done-acp', { id: taskId, session: sessionId, outLen: (r.text || '').length, tools: r.toolCalls, stop: r.stopReason })
    const notice = peer.acpNotice || ''
    if (notice) peer.acpNotice = ''
    return { ok: true, text: r.text, sessionId, viaAcp: true, stopReason: r.stopReason, notice }
  } catch (e) {
    log('task-acp-failed', { id: taskId, error: String(e?.message ?? e) })
    return null
  }
}

function killTree(pid) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
function runDsh(task, cwd, taskId) {
  return new Promise((resolve) => {
    const taskLog = join(TASKS_DIR, Date.now() + '-' + taskId + '.log')
    const argv = DSH_BIN ? [DSH_BIN, '--profile', PROFILE, task] : ['--profile', PROFILE, task]
    const env = { ...process.env, DSH_HOME: (HOST_HOME || CHILD_HOME) }
    const child = DSH_BIN ? spawn(process.execPath, argv, { cwd, windowsHide: true, env }) : spawn('dsh', argv, { cwd, windowsHide: true, env, shell: process.platform === 'win32' })
    const childPid = child.pid
    const rec = state.tasks[taskId]
    if (rec) { rec.pid = childPid; saveState(state) }
    let out = '', err = '', timedOut = false
    try { appendFileSync(taskLog, '=== ' + new Date().toISOString() + ' task=' + taskId + ' cwd=' + cwd + NL) } catch {}
    const beatTimer = setInterval(() => beat('busy'), 15000)
    const t = setTimeout(() => { timedOut = true; killTree(childPid); resolve({ ok: false, text: out.trim(), error: 'timeout ' + TASK_TIMEOUT_MS + 'ms', log: taskLog, timedOut: true }) }, TASK_TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d.toString(); try { appendFileSync(taskLog, d) } catch {} })
    child.stderr.on('data', (d) => { err += d.toString(); try { appendFileSync(taskLog, d) } catch {} })
    child.on('close', (code) => {
      clearTimeout(t); clearInterval(beatTimer)
      if (timedOut) return
      try { appendFileSync(taskLog, NL + '=== exit=' + code + NL) } catch {}
      if (code === 0 && out.trim()) resolve({ ok: true, text: out.trim(), log: taskLog })
      else resolve({ ok: false, text: out.trim(), error: 'exit=' + code + ' ' + err.trim().slice(-800), log: taskLog })
    })
    child.on('error', (e) => { clearTimeout(t); clearInterval(beatTimer); resolve({ ok: false, text: '', error: e.message, log: taskLog }) })
  })
}

async function reply(token, to, text, ctx) {
  const body = String(text ?? '').trim() || '(空回复)'
  for (let i = 0; i < body.length; i += MAX_CHUNK) {
    const c = body.slice(i, i + MAX_CHUNK)
    try { const r = await sendText(token, to, c, ctx); log('sent', { len: c.length, ret: r?.ret }) } catch (e) { log('send-failed', { error: String(e?.message ?? e) }) }
  }
}

const HELP = ['指令：', '/help 本帮助', '/ping 探活', '/status 状态', '/task 任务与排队', '/cancel 取消运行中任务（连同子进程树）', '/ws 列出工作区', '/ws <序号│路径> 切换工作区', '/new 开新会话', '/预设 [序号|id] 选通道预设（含"普通对话"）', '/预设 自检 验当前档是否真按预设组装', '/sessions [序号] 列出/接上 DSH 原生会话', '/model [序号] 选模型（按会话）', '/effort [序号] 推理强度', '/approve · /reject 审批记录', '其他任意文本 → 交给 DSH 执行'].join(NL)

const peerChains = new Map()
const runningCount = () => Object.values(state.tasks).filter((t) => t.status === 'running').length

async function processTask(token, peerKey, from, taskId, text, contextToken) {
  const peer = state.peers[peerKey]
  const t = state.tasks[taskId]
  t.status = 'running'; t.startedAt = new Date().toISOString(); activeTasks = runningCount()
  await saveState(state)
  const history = (peer.history || []).filter((h) => h.ok !== false).slice(-6)
  const prompt = PROMPT_PREFIX + sanitize(history.length
    ? '以下是本会话此前的对话（供参考）： ' + history.map((h, i) => '[' + (i + 1) + '] 用户： ' + h.u + ' ；你： ' + String(h.a).slice(0, 300)).join(' 。 ') + ' 。 本轮用户任务： ' + text
    : text)
  let r = null
  // ① 首选 ACP：DSH 原生会话 + 原生上下文（桥不拼接历史）
  r = await runViaAcp(text, peer, taskId)
  // ② 其次宿主内执行（历史行为；不产生 turn 时返回空 → 继续回落）
  if (!r) { const viaHost = await runViaHost(text, peer, taskId); if (viaHost && String(viaHost.text || '').trim()) r = viaHost }
  // ③ 最后回落：一次性 headless（沿用拼接提示词，仅作兜底）
  if (!r) r = await runDsh(prompt, peer.cwd, taskId)
  t.status = r.timedOut ? 'timeout' : (r.ok ? 'done' : 'failed')
  t.endedAt = new Date().toISOString(); t.log = r.log; activeTasks = runningCount()
  peer.history = ((peer.history || []).concat([{ u: text, a: r.ok ? r.text : (r.error || '失败'), ok: !!r.ok, at: t.endedAt }])).slice(-50)
  log('task-done', { id: taskId, ok: r.ok, timeout: !!r.timedOut, outLen: r.text?.length ?? 0 })
  const audited = auditOutput((r.notice ? r.notice + NL : '') + (r.ok ? r.text : '执行失败：' + (r.error ?? '未知错误')))
  if (audited.hits.length) log('output-audit', { id: taskId, hits: audited.hits })
  await reply(token, from, audited.text, contextToken)
  await saveState(state)
}

function enqueueTask(token, peerKey, from, text, contextToken) {
  const taskId = randomUUID().slice(0, 8)
  state.tasks[taskId] = { id: taskId, peer: peerKey, text: text.slice(0, 200), status: 'queued', queuedAt: new Date().toISOString(), cwd: state.peers[peerKey].cwd }
  log('task-queued', { id: taskId })
  const prev = peerChains.get(peerKey) || Promise.resolve()
  const cur = prev
    .then(async () => { while (runningCount() >= MAX_CONCURRENT_TASKS) await new Promise((r) => setTimeout(r, 1000)); await processTask(token, peerKey, from, taskId, text, contextToken) })
    .catch((e) => log('task-error', { id: taskId, error: String(e?.message ?? e) }))
    .finally(() => { if (peerChains.get(peerKey) === cur) peerChains.delete(peerKey) })
  peerChains.set(peerKey, cur)
  return taskId
}

let state = loadState()
let lastSelfSave = 0
/**
 * 外部（宿主半的扫码登记、面板动作）会改同一份 state.json；桥只在启动时读一次的话，
 * 「扫码登记了新主人」要等到下次重启才生效 —— 这里在每轮轮询时比较 mtime，
 * 只把「外部拥有的字段」合并进来，绝不用旧快照覆盖桥自己的游标与去重表。
 */
/**
 * 重新读微信 token 并重置游标。场景：用户换微信重新扫码 → 宿主把新 token 写进凭据文件，
 * 运行中的桥若不察觉，就会继续用旧 bot 身份轮询（表现为"扫码成功但收不到消息"，2026-09-21 实锤）。
 * 由调用方比对 token 是否真的变了，再重置 syncBuf（新 bot 的消息序列不能沿用旧游标）。
 */
function rereadWechatToken() {
  if (TOKEN_FILE === '@env') return null
  for (const home of [HOST_HOME, DSH_HOME, CHILD_HOME]) {
    if (!home) continue
    const f = join(home, '.credentials.yaml')
    try {
      const m = readFileSync(f, 'utf8').match(/^\s*DSH_WEIXIN_BOT_TOKEN:\s*(.+)$/m)
      if (!m) continue
      const t = m[1].trim().replace(/^["']|["']$/g, '')
      TOKEN_FILE = f
      return t
    } catch {}
  }
  return null
}
function tokenFileMtime() {
  try { return TOKEN_FILE && TOKEN_FILE !== '@env' ? statSync(TOKEN_FILE).mtimeMs : 0 } catch { return 0 }
}

function reloadStateIfChanged() {
  try {
    const st = statSync(STATE_FILE)
    if (st.mtimeMs <= lastSelfSave) return false
    const disk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const before = JSON.stringify([state.allowedUsers, Object.keys(state.peers), state.account])
    state.allowedUsers = Array.isArray(disk.allowedUsers) ? disk.allowedUsers : state.allowedUsers
    if (disk.peers && typeof disk.peers === 'object') {
      for (const [k, v] of Object.entries(disk.peers)) {
        if (!state.peers[k]) state.peers[k] = v
        else if (!(state.peers[k].history || []).length && (v.history || []).length) state.peers[k].history = v.history
      }
    }
    if (disk.account) state.account = disk.account
    if (disk.manualStop !== undefined) state.manualStop = disk.manualStop
    lastSelfSave = Date.now()
    const after = JSON.stringify([state.allowedUsers, Object.keys(state.peers), state.account])
    if (after !== before) {
      log('state-reloaded-from-disk', { allowedUsers: state.allowedUsers.length, peers: Object.keys(state.peers).length })
      return true
    }
    return false
  } catch { return false }
}
// 顺序很关键：先准备子 home（写入合并后的密钥），再读微信 token ——
// 否则隔离模式下 loadWechatToken 会读不到刚生成的子 home 凭据。
const refsInfo = prepareChildHome()
// 首次使用还没有微信凭据是**正常状态**，不是错误：桥照常起来，进 wait-credentials 等配对，
// 配对写入凭据后由轮询循环自动接手（2026-09-21：其他用户点「启动」时这里直接抛错 = "启动不了"）。
let wechatToken = ''
try {
  wechatToken = loadWechatToken()
} catch (e) {
  console.log('[bridge] 还没有微信凭据（等待配对）')
  console.log('[bridge] 请在「设置 → 微信连接」里扫码配对；配对完成后桥会自动接手，无需重启。')
  log('no-wechat-credentials', { note: '等待配对写入凭据', tried: String(e?.message ?? e).slice(0, 200) })
}
TOKEN_MTIME = tokenFileMtime()

async function handleMessage(token, msg) {
  const from = String(msg?.from_user_id ?? '')
  const text = inboundText(msg)
  const ctx = msg?.context_token
  if (!from || !text) return
  const trimmed = text.trim()
  const firstToken = trimmed.split(/\s+/)[0] || ''
  const authed = firstToken === AUTH_TOKEN
  let isAllowed = state.allowedUsers.includes(from)

  if (!isAllowed && !authed) {
    if (ALLOWLIST === 'open') {
      isAllowed = true
    } else if (ALLOWLIST === 'auto') {
      // 自动登记：能发消息给本 bot 的号本来就在它的会话里，准入边界在扫码那一步
      state.allowedUsers.push(from)
      state.peers[from] ||= { cwd: CWD, history: [], approvals: [] }
      await saveState(state)
      log('auto-enrolled', { from, total: state.allowedUsers.length })
      isAllowed = true
      try { await reply(token, from, '✅ 已登记本机授权（多台手机/换号都无需再设置）。发 /help 看指令。', ctx) } catch {}
    } else {
      // strict：记录完整 from（本地日志，仅本人可读）
      log('rejected-unauthenticated', { from, fromShort: from.slice(0, 12) })
      return
    }
  }
  if (!isAllowed && authed) {
    state.allowedUsers.push(from); await saveState(state); log('owner-claimed', { from: from.slice(0, 12) })
    await reply(token, from, '✅ 已登记为所有者（以后无需再带 token）。发 /help 查看指令。', ctx)
  }
  const body = authed ? trimmed.slice(firstToken.length).trim() : trimmed
  if (!body) { await reply(token, from, '已认证。发送 /help 查看指令。', ctx); return }
  const peerKey = from
  const peer = (state.peers[peerKey] ||= { cwd: CWD, history: [], approvals: [] })
  const cmd = body.toLowerCase()

  if (cmd === '/ping') return reply(token, from, 'pong', ctx)
  if (cmd === '/help') return reply(token, from, HELP, ctx)
  if (cmd === '/status') return reply(token, from, ['桥状态 v' + BRIDGE_VERSION, 'profile=' + PROFILE, '工作区=' + peer.cwd, '会话轮数=' + (peer.history || []).length, '契约=' + CONTRACT_HASH, '运行中=' + runningCount() + '/' + MAX_CONCURRENT_TASKS, '已处理消息=' + state.processed.length, '允许用户=' + state.allowedUsers.length,
    '执行=' + (ACP_ENABLED ? 'ACP 原生会话' : 'headless 一次性') + '｜DSH_HOME=' + ACP_HOME,
    '预设档=' + presetKey(peer) + '｜默认档=' + ACP_DEFAULT_PRESET,
    '原生会话=' + (sessionSlot(peer, peerMode(peer)).id ? String(sessionSlot(peer, peerMode(peer)).id).slice(0, 12) + '…' : '(未建立)')
      + '｜acp pid=' + (getAcpHost(peerMode(peer)).pid || 0),
    '模型=' + (peer.acpModel || '(profile 默认)') + '｜推理强度=' + (peer.acpEffort || '(默认)')].join(NL), ctx)
  if (cmd === '/task') {
    const rows = Object.values(state.tasks).slice(-8).map((t) => t.id + ' [' + t.status + (t.mode === 'acp' ? '/acp' : '') + '] ' + String(t.text).slice(0, 30))
    return reply(token, from, rows.length ? '任务：' + NL + rows.join(NL) : '当前无任务。', ctx)
  }
  if (cmd === '/cancel') {
    const running = Object.values(state.tasks).filter((t) => t.status === 'running')
    let acpCancelled = 0
    for (const t of running) {
      if (t.mode === 'acp' && t.session) {
        try {
          let done = false
          for (const [, h] of acpHosts) { if (h.has(t.session)) { await h.cancel(t.session); done = true; break } }
          if (!done) await getAcpHost(t.mode).cancel(t.session)
          acpCancelled++
        } catch (e) { log('acp-cancel-failed', { error: String(e?.message ?? e) }) }
      } else if (t.pid) killTree(t.pid)
      t.status = 'cancelled'; t.endedAt = new Date().toISOString()
    }
    await saveState(state)
    return reply(token, from, running.length
      ? '已请求取消 ' + running.length + ' 个运行中任务' + (acpCancelled ? '（其中 ' + acpCancelled + ' 个走 DSH 原生会话：已发 session/cancel）' : '（连同子进程树）') + '。'
      : '当前没有运行中任务。', ctx)
  }
  if (cmd === '/new') {
    const slot = sessionSlot(peer, peerMode(peer))
    slot.id = ''; slot.cwd = ''
    await saveState(state)
    return reply(token, from, '已开启新会话（' + (peerMode(peer) === 'brain' ? '第二大脑' : '对话') + '模式，下一条消息由 DSH 新建）。', ctx)
  }
  if (cmd === '/权限' || cmd === '/perm') {
    return reply(token, from, [
      '通道权限：完全访问（danger-full-access）——手机端没有审批界面，所以通道不需要审批',
      '桥对 ACP 审批请求的应答策略：' + ACP_PERM + '（config.json 的 acp.permPolicy 可改）',
      '要收紧：改 config.json 的 acp.patch 叠层里 permission.defaultPreset 为 workspace-write 或 read-only',
    ].join(NL), ctx)
  }
  if (cmd === '/预设' || cmd === '/preset' || cmd.startsWith('/预设 ') || cmd.startsWith('/preset ')
      || cmd === '/brain' || cmd.startsWith('/brain ') || cmd === '/模式' || cmd.startsWith('/模式 ')) {
    if (!ACP_ENABLED) return reply(token, from, 'ACP 路径已关闭（config.json 的 acp.enabled=false）。', ctx)
    const argRaw = body.trim().replace(/^\/(预设|preset|brain|模式)\s*/, '').trim()
    const cur = presetKey(peer)
    const roster = listPresets()
    const entries = [{ id: 'chat', name: '普通对话（插件自带：只聊天，不动文件/库）' }].concat(roster)
    if (!argRaw) {
      const rows = entries.map((e, i) => (i + 1) + '. ' + e.name + '（' + e.id + '）' + (e.id === cur ? ' ← 当前' : ''))
      return reply(token, from, ['通道预设（/预设 <序号|id> 切换）：'].concat(rows)
        .concat(['默认档：' + ACP_DEFAULT_PRESET + '｜每个预设一条独立会话（切档不串上下文）']).join(NL), ctx)
    }
  if (argRaw === 'check' || argRaw === '自检' || argRaw === '验证') {
    try {
      const r = await presetSelfCheck(peer)
      return reply(token, from, [
        '预设自检 · 档位 ' + r.preset + (r.preset === r.default ? '（默认档）' : ''),
        '会话 ' + String(r.session).slice(0, 12) + '…｜acp pid=' + r.acpPid,
        '叠层 ' + (r.patch || '(宿主组合)'),
        r.ran
          ? ('system ' + r.systemChars + ' 字｜命中标记：' + (r.marks.length ? r.marks.join('、') : '无（＝宿主默认组合）'))
          : '该会话还没跑过一轮（发一条任务后 /预设 自检 再看）',
        r.agentPreset ? ('会话头 agentPreset=' + r.agentPreset) : '会话头未记录预设',
      ].join(NL), ctx)
    } catch (e) {
      return reply(token, from, '预设自检失败：' + String(e?.message ?? e), ctx)
    }
  }
    const want = (/^(on|off)$/i.test(argRaw)) ? (argRaw.toLowerCase() === 'off' ? 'chat' : ACP_DEFAULT_PRESET) : argRaw
    const n = Number(want)
    const pick = (Number.isFinite(n) && n >= 1) ? entries[n - 1] : entries.find((e) => e.id === want)
    if (!pick) return reply(token, from, '没这个预设（发 /预设 看清单；序号或 id 都行）。', ctx)
    peer.acpPreset = pick.id
    await saveState(state)
    log('preset-switched', { id: pick.id })
    return reply(token, from, '已切到预设：' + pick.name + '（' + pick.id + '）' + NL
      + '下一条消息在该预设自己的会话里继续；上下文按预设分开（/sessions 可找回别的会话）。', ctx)
  }
  if (cmd === '/model' || cmd.startsWith('/model ')) {
    if (!ACP_ENABLED) return reply(token, from, 'ACP 路径已关闭（config.json 的 acp.enabled=false）。', ctx)
    try { await ensurePeerSession(peer) } catch (e) { return reply(token, from, 'ACP 会话不可用：' + String(e?.message ?? e), ctx) }
    const pickArg = body.trim().slice(6).trim()
    if (!pickArg) {
      if (!acpModelCatalog.length) return reply(token, from, '模型目录暂时不可用（先发一条任务建会话）。', ctx)
      const cur = peer.acpModel || ''
      const label = (m) => { try { const [pv, md] = JSON.parse(m.value); return pv + '/' + md } catch { return m.value } }
      const rows = acpModelCatalog.map((m, i) => (i + 1) + '. ' + m.label + '（' + m.group + '｜' + label(m) + '）' + (m.value === cur ? ' ← 当前' : ''))
      return reply(token, from, ['可选模型（/model <序号> 或 /model provider/model 切换）：'].concat(rows).join(NL), ctx)
    }
    const n = Number(pickArg)
    const byText = (m) => {
      try { const [pv, md] = JSON.parse(m.value); if (pv + '/' + md === pickArg || md === pickArg) return true } catch {}
      return m.value === pickArg || m.label === pickArg
    }
    const pick = Number.isFinite(n) && n >= 1 ? acpModelCatalog[n - 1] : acpModelCatalog.find(byText)
    if (!pick) return reply(token, from, '序号/名称不在目录里（发 /model 看清单）。', ctx)
    peer.acpModel = pick.value
    await applyPeerConfig(peer)
    await saveState(state)
    return reply(token, from, '模型已切换：' + pick.label + '（' + pick.group + '）' + NL + '下一条消息起生效，本会话与手机/桌面共用。', ctx)
  }
  if (cmd === '/effort' || cmd.startsWith('/effort ')) {
    if (!ACP_ENABLED) return reply(token, from, 'ACP 路径已关闭。', ctx)
    try { await ensurePeerSession(peer) } catch (e) { return reply(token, from, 'ACP 会话不可用：' + String(e?.message ?? e), ctx) }
    const pickArg = body.trim().slice(7).trim()
    if (!pickArg) {
      const cur = peer.acpEffort || ''
      const rows = (acpEffortCatalog.length ? acpEffortCatalog : [{ label: 'off', value: 'off' }, { label: 'low', value: 'low' }, { label: 'high', value: 'high' }, { label: 'max', value: 'max' }])
        .map((e, i) => (i + 1) + '. ' + e.label + (e.value === cur ? ' ← 当前' : ''))
      return reply(token, from, ['推理强度（/effort <序号|值> 切换）：'].concat(rows).join(NL), ctx)
    }
    const n = Number(pickArg)
    const list = acpEffortCatalog.length ? acpEffortCatalog : [{ label: 'off', value: 'off' }, { label: 'low', value: 'low' }, { label: 'high', value: 'high' }, { label: 'max', value: 'max' }]
    const pick = Number.isFinite(n) && n >= 1 ? list[n - 1] : list.find((e) => e.value === pickArg)
    if (!pick) return reply(token, from, '没这个强度（发 /effort 看清单）。', ctx)
    peer.acpEffort = pick.value
    await applyPeerConfig(peer)
    await saveState(state)
    return reply(token, from, '推理强度已切换：' + pick.label, ctx)
  }
  if (cmd === '/sessions' || cmd.startsWith('/sessions ')) {
    if (!ACP_ENABLED) return reply(token, from, 'ACP 路径已关闭（config.json 的 acp.enabled=false）。', ctx)
    const pickArg = body.trim().slice(9).trim()
    const host = getAcpHost(peerMode(peer))
    let list = null
    try { list = await host.listSessions(peer.cwd || CWD) } catch (e) { return reply(token, from, '取会话列表失败：' + String(e?.message ?? e), ctx) }
    if (!pickArg) {
      const rows = (list || []).slice(0, 10).map((s, i) => (i + 1) + '. ' + String(s.sessionId).slice(0, 12) + '…' + (s.title ? ' ' + String(s.title).slice(0, 18) : ''))
      return reply(token, from, ['工作区 ' + (peer.cwd || CWD) + ' 的会话（新→旧）：'].concat(rows.length ? rows : ['（无）'])
        .concat(['当前会话：' + (sessionSlot(peer, peerMode(peer)).id ? String(sessionSlot(peer, peerMode(peer)).id).slice(0, 12) + '…' : '(未建立)'), '接上某条：/sessions <序号>']).join(NL), ctx)
    }
    const n = Number(pickArg)
    const pick = Number.isFinite(n) && n >= 1 ? (list || [])[n - 1] : null
    if (!pick) return reply(token, from, '序号超出范围。', ctx)
    const slot = sessionSlot(peer, peerMode(peer))
    slot.id = pick.sessionId; slot.cwd = peer.cwd || CWD
    await saveState(state)
    return reply(token, from, '已接上 DSH 会话 ' + String(pick.sessionId).slice(0, 12) + '…（下一条消息在该会话继续，上下文由 DSH 保存）', ctx)
  }
  if (cmd === '/ws' || cmd.startsWith('/ws ')) {
    const target = body.trim().slice(3).trim().replace(/^"|"$/g, '')
    if (!target) return reply(token, from, workspaceListText(peer), ctx)
    if (/^[0-9]+$/.test(target)) {
      const pick = readWorkspaces()[Number(target) - 1]
      if (!pick) return reply(token, from, '序号超出范围。' + NL + workspaceListText(peer), ctx)
      peer.cwd = pick.path; sessionSlot(peer, peerMode(peer)).id = ''; sessionSlot(peer, peerMode(peer)).cwd = ''; await saveState(state)
      return reply(token, from, '工作区已切换为：' + NL + pick.path + NL + '（' + pick.title + '）' + NL + '（已切新会话，原会话可用 /sessions 找回）', ctx)
    }
    if (!existsSync(target)) return reply(token, from, '路径不存在：' + target, ctx)
    peer.cwd = target; sessionSlot(peer, peerMode(peer)).id = ''; sessionSlot(peer, peerMode(peer)).cwd = ''; await saveState(state)
    return reply(token, from, '工作区已切换为：' + NL + target + NL + '（已切新会话，原会话可用 /sessions 找回）', ctx)
  }
  if (cmd === '/approve' || cmd === '/reject') {
    peer.approvals.push({ at: new Date().toISOString(), decision: cmd === '/approve' ? 'approved' : 'rejected' })
    await saveState(state)
    return reply(token, from, '已记录' + (cmd === '/approve' ? '批准' : '拒绝') + '（审计语义；真拦截待 Phase 3）。', ctx)
  }
  const taskId = enqueueTask(token, peerKey, from, body, ctx)
  return reply(token, from, '已收到（任务 ' + taskId + '），开始执行：' + body.slice(0, 50) + NL + '/task 查进度，/cancel 取消。', ctx)
}

async function main() {
  process.on('exit', () => { for (const [, h] of acpHosts) { try { h.stop() } catch {} } })
  if (args.includes('--selftest-preset-check')) {
    const peer = { cwd: CWD }
    const sp = argOf('--selftest-preset-check', '')
    if (sp) peer.acpPreset = sp
    await runViaAcp('只回复：ok', peer, 'SELFCHECK')
    const r = await presetSelfCheck(peer)
    for (const [, h] of acpHosts) h.stop()
    console.log('[selftest-preset-check] ' + JSON.stringify(r))
    process.exit(0)
  }
  if (args.includes('--selftest-presets')) {
    console.log('[selftest-presets] ' + JSON.stringify({ default: ACP_DEFAULT_PRESET,
      bin: resolveAcpBin(), acpHome: ACP_HOME, roots: presetRootsDiag(),
      roster: listPresets().map((x) => x.id + ':' + x.name) }))
    process.exit(0)
  }
  if (args.includes('--selftest-acp')) {
    const peer = { cwd: CWD }
    const sp = argOf('--selftest-preset', '')
    if (sp) peer.acpPreset = sp
    else if (argOf('--selftest-mode', '') === 'brain') peer.acpPreset = ACP_DEFAULT_PRESET
    else if (argOf('--selftest-mode', '') === 'chat') peer.acpPreset = 'chat'
    if (argOf('--selftest-model', '')) peer.acpModel = argOf('--selftest-model', '')
    // 走生产路径：每轮任务都过 runViaAcp → ensurePeerSession
    const r1 = await runViaAcp('记住一个词：紫色独角兽。只回复：已记住', peer, 'SELFTEST1')
    const r2 = await runViaAcp('我刚才让你记的词是什么？只回复那个词。', peer, 'SELFTEST2')
    const r3 = await runViaAcp('再一次：我刚才让你记的是什么词？只回复那个词。', peer, 'SELFTEST3')
    for (const [, h] of acpHosts) h.stop()
    console.log('[selftest-acp] ' + JSON.stringify({
      bin: resolveAcpBin(), home: ACP_HOME, preset: presetKey(peer), patch: overlayFor(presetKey(peer)),
      session: sessionSlot(peer, peer.acpMode).id,
      turn1: r1?.text, turn2: r2?.text, turn3: r3?.text, notice: r2?.notice || null,
    }))
    process.exit(0)
  }
  if (args.includes('--selftest-resume')) {
    const id = argOf('--selftest-resume', '')
    const host = getAcpHost()
    await host.resumeSession(id, CWD)
    const r = await host.ask(id, '我刚才让你记的词是什么？只回复那个词。')
    host.stop()
    console.log('[selftest-resume] ' + JSON.stringify({ session: id, answer: r.text }))
    process.exit(0)
  }
  acquireLock()
  // 上次进程遗留的运行态任务：本轮一启动就标成 interrupted。
  // 否则 runningCount() 永远虚高，`while (runningCount() >= MAX_CONCURRENT_TASKS)` 会把新任务永久挡住。
  {
    let swept = 0
    for (const t of Object.values(state.tasks || {})) {
      if (t.status === 'running' || t.status === 'queued') { t.status = 'interrupted'; t.endedAt = new Date().toISOString(); swept++ }
    }
    if (swept) { await saveState(state); log('stale-tasks-swept', { count: swept }) }
  }
  // 所有者种子：若历史状态里已有单一 peer，视为已登记所有者（避免重复认证）
  if (!state.allowedUsers.length && Object.keys(state.peers).length === 1) {
    state.allowedUsers = Object.keys(state.peers)
    log('owner-seeded-from-state', { count: 1 })
  }
  const refs = refsInfo.refs
  log('bridge-start', { version: BRIDGE_VERSION, profile: PROFILE, cwd: CWD, contract: CONTRACT_HASH, childRefs: refs })
  console.log('[bridge] v' + BRIDGE_VERSION + ' 已启动｜profile=' + PROFILE + '｜默认工作区=' + CWD)
  console.log('[bridge] 契约=' + CONTRACT_HASH + '｜子进程HOME=' + refsInfo.home + '(workspace-write)' + (refsInfo.shared ? ' ← 与宿主共享会话仓库' : ''))
  console.log('[bridge] 子进程凭据: ' + (refs.join(', ') || '(空)') + '   ← 不含微信 token')
  console.log('[bridge] 授权策略=' + ALLOWLIST + '｜已登记=' + (state.allowedUsers.length ? state.allowedUsers.length + ' 人' : '无'))
  if (!state.allowedUsers.length) console.log('[bridge] ⚠️ 首次使用：微信发送 "' + AUTH_TOKEN + ' /help" 以登记所有者')
  console.log('[bridge] 等待微信消息…')

  if (OWNER_PID) {
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    setInterval(() => {
      if (!alive(OWNER_PID)) { log('owner-exit: 宿主 pid=' + OWNER_PID + ' 已不在，桥自行退出'); process.exit(0) }
    }, 20000).unref()
    console.log('[bridge] 宿主托管模式：主人 pid=' + OWNER_PID + '（主人消失后自动退出）')
  }

  let timeoutMs = 35000
  beat('start')
  setInterval(() => beat(activeTasks > 0 ? 'busy' : 'idle'), HEARTBEAT_MS)

  for (;;) {
    try {
      // ① token 热更新（换号扫码）：变了就换 token 并重置游标
      const mt = tokenFileMtime()
      if (mt !== TOKEN_MTIME) {
        TOKEN_MTIME = mt
        const t2 = rereadWechatToken()
        if (t2 && t2 !== wechatToken) {
          wechatToken = t2
          state.syncBuf = ''
          log('token-hot-reloaded', { file: TOKEN_FILE, note: '换号扫码：已切新 token 并重置游标' })
        }
      }
      // ①-b 还没凭据（首次使用）：每 5 秒试读一次，配对写入后自动接手，不刷错误日志
      if (!wechatToken) {
        try {
          const t = loadWechatToken()
          if (t) {
            wechatToken = t
            TOKEN_MTIME = tokenFileMtime()
            console.log('[bridge] 已读到微信凭据，开始轮询')
            log('token-loaded-late', { file: TOKEN_FILE })
          }
        } catch {}
        if (!wechatToken) { beat('wait-credentials'); await new Promise((r) => setTimeout(r, 5000)); continue }
      }
      // ② 面板改了预设提示词
      reloadPromptIfChanged()
      // ③ 外部改了 state（扫码登记新主人/面板操作）
      reloadStateIfChanged()
      const res = await getUpdates(wechatToken, state.syncBuf, timeoutMs)
      pollCount++
      if (Number.isFinite(res?.longpolling_timeout_ms) && res.longpolling_timeout_ms > 0) timeoutMs = Math.max(5000, Math.min(res.longpolling_timeout_ms, 120000))
      if (typeof res?.get_updates_buf === 'string' && res.get_updates_buf) state.syncBuf = res.get_updates_buf
      if (res?.account) state.account = res.account
      beat('poll')
      const now = Date.now()
      state.processed = state.processed.filter((k) => { const ts = Number(String(k).split(':')[1]); return !Number.isFinite(ts) || now - ts < DEDUP_WINDOW_MS })
      const seen = new Set(state.processed)
      for (const msg of res?.msgs ?? []) {
        const key = msgKey(msg)
        if (seen.has(key)) continue
        seen.add(key); state.processed.push(key)
        log('inbound', { text: inboundText(msg).slice(0, 80) })
        try { await handleMessage(wechatToken, msg) } catch (e) { log('handle-error', { error: String(e?.message ?? e) }) }
      }
      await saveState(state)
    } catch (e) {
      log('poll-error', { error: String(e?.message ?? e) })
      beat('poll-error')
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

main().catch((e) => { console.error('[bridge] 启动失败：', e?.message ?? e); process.exit(1) })
