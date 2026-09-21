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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
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
const BRIDGE_VERSION = '0.3.1'
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
      if (old && old.pid) { try { process.kill(old.pid, 0); console.log('[bridge] 已有实例 pid=' + old.pid + '，退出'); process.exit(0) } catch {} }
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
  writeFileSync(join(CHILD_HOME, 'settings.yaml'), 'agent-presets:' + NL + '  default: second-brain' + NL + 'permission:' + NL + '  defaultPreset: workspace-write' + NL)
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

const HELP = ['指令：', '/help 本帮助', '/ping 探活', '/status 状态', '/task 任务与排队', '/cancel 取消运行中任务（连同子进程树）', '/ws 列出工作区', '/ws <序号│路径> 切换工作区', '/new 清空会话记忆', '/approve · /reject 审批记录', '其他任意文本 → 交给 DSH 执行'].join(NL)

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
  const viaHost = (peer.history || []).length >= 0 ? await runViaHost(text, peer, taskId) : null
  if (viaHost) r = viaHost
  else r = await runDsh(prompt, peer.cwd, taskId)
  t.status = r.timedOut ? 'timeout' : (r.ok ? 'done' : 'failed')
  t.endedAt = new Date().toISOString(); t.log = r.log; activeTasks = runningCount()
  peer.history = ((peer.history || []).concat([{ u: text, a: r.ok ? r.text : (r.error || '失败'), ok: !!r.ok, at: t.endedAt }])).slice(-50)
  log('task-done', { id: taskId, ok: r.ok, timeout: !!r.timedOut, outLen: r.text?.length ?? 0 })
  const audited = auditOutput(r.ok ? r.text : '执行失败：' + (r.error ?? '未知错误'))
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
let wechatToken = loadWechatToken()
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
  if (cmd === '/status') return reply(token, from, ['桥状态 v' + BRIDGE_VERSION, 'profile=' + PROFILE, '工作区=' + peer.cwd, '会话轮数=' + (peer.history || []).length, '契约=' + CONTRACT_HASH, '运行中=' + runningCount() + '/' + MAX_CONCURRENT_TASKS, '已处理消息=' + state.processed.length, '允许用户=' + state.allowedUsers.length].join(NL), ctx)
  if (cmd === '/task') {
    const rows = Object.values(state.tasks).slice(-8).map((t) => t.id + ' [' + t.status + '] ' + String(t.text).slice(0, 30))
    return reply(token, from, rows.length ? '任务：' + NL + rows.join(NL) : '当前无任务。', ctx)
  }
  if (cmd === '/cancel') {
    const running = Object.values(state.tasks).filter((t) => t.status === 'running')
    for (const t of running) if (t.pid) { killTree(t.pid); t.status = 'cancelled'; t.endedAt = new Date().toISOString() }
    await saveState(state)
    return reply(token, from, running.length ? '已请求取消 ' + running.length + ' 个运行中任务（连同子进程树）。' : '当前没有运行中任务。', ctx)
  }
  if (cmd === '/new') { peer.history = []; peer.sessionId = ''; await saveState(state); return reply(token, from, '已开启新会话（下一条任务会在宿主里新建一条会话）。', ctx) }
  if (cmd === '/ws' || cmd.startsWith('/ws ')) {
    const target = body.trim().slice(3).trim().replace(/^"|"$/g, '')
    if (!target) return reply(token, from, workspaceListText(peer), ctx)
    if (/^[0-9]+$/.test(target)) {
      const pick = readWorkspaces()[Number(target) - 1]
      if (!pick) return reply(token, from, '序号超出范围。' + NL + workspaceListText(peer), ctx)
      peer.cwd = pick.path; await saveState(state)
      return reply(token, from, '工作区已切换为：' + NL + pick.path + NL + '（' + pick.title + '）', ctx)
    }
    if (!existsSync(target)) return reply(token, from, '路径不存在：' + target, ctx)
    peer.cwd = target; await saveState(state)
    return reply(token, from, '工作区已切换为：' + NL + target, ctx)
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
  acquireLock()
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
