/**
 * 扫码配对（iLink ClawBot）：宿主半持有配对会话，客户端只做展示与轮询。
 *
 * 协议（实测自 @local/dsh-weixin 的 IlinkClient）：
 *   POST ilink/bot/get_bot_qrcode?bot_type=3     body {local_token_list:[...]}  → {qrcode, qrcode_img_content}
 *   GET  ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]                    → {status, …}
 *   status: wait | scaned | need_verifycode | scaned_but_redirect | binded_redirect | expired | confirmed
 *   confirmed 返回 {bot_token, ilink_bot_id, ilink_user_id, baseurl}
 *
 * 产出：bot_token 写进凭据文件（merge 语义，保留其它 refs）；state.json 登记 owner 与账号。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

const NL = String.fromCharCode(10)
const API_BASE = process.env.ILINK_BASE || 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const CRED_REF = 'DSH_WEIXIN_BOT_TOKEN'

const headers = () => ({
  'content-type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
})

const post = async (url, body, timeoutMs = 15000) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}), signal: ctl.signal })
    const raw = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 200))
    return JSON.parse(raw)
  } finally { clearTimeout(t) }
}

const get = async (url, timeoutMs = 35000) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', headers: headers(), signal: ctl.signal })
    const raw = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 200))
    return JSON.parse(raw)
  } finally { clearTimeout(t) }
}

function readTokenFromFile(credFile) {
  try {
    const m = readFileSync(credFile, 'utf8').match(new RegExp('^\\s*' + CRED_REF + ':\\s*(.+)$', 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

/** merge 写入凭据：只增改目标 ref，保留其它 refs、顶层键与夹层注释（原子写）。 */
export function writeCredentialRef(credFile, ref, value) {
  const hadFile = existsSync(credFile)
  const lines = hadFile ? readFileSync(credFile, 'utf8').split(/\r?\n/) : []
  const refRe = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):(\s*)(.*)$/
  const head = []
  const entries = []
  const tail = []
  let inRefs = false, refsSeen = false, refsClosed = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; refsSeen = true; head.push(line); continue }
    if (inRefs && refRe.test(line)) { entries.push(line); continue }
    if (inRefs) { inRefs = false; refsClosed = true }
    if (refsClosed) tail.push(line)
    else head.push(line)
  }

  let replaced = false
  const outEntries = entries.map((l) => {
    const m = l.match(refRe)
    if (m && m[1] === ref) { replaced = true; return '  ' + ref + ': ' + value }
    return l
  })
  if (!replaced) outEntries.push('  ' + ref + ': ' + value)

  const headTrim = head.slice()
  while (headTrim.length && headTrim[headTrim.length - 1].trim() === '') headTrim.pop()
  const tailTrim = tail.slice()
  while (tailTrim.length && tailTrim[tailTrim.length - 1].trim() === '') tailTrim.pop()

  const parts = []
  if (!refsSeen) parts.push('refs:')
  parts.push(...headTrim)
  parts.push(...outEntries)
  if (tailTrim.length) parts.push(...tailTrim)

  mkdirSync(dirname(credFile), { recursive: true })
  const tmp = credFile + '.tmp'
  writeFileSync(tmp, parts.join(NL) + NL, 'utf8')
  renameSync(tmp, credFile)
  return true
}

/** 把 owner/账号写进桥的 state.json（保持 checksum 一致，原子写）。 */
export function seedState(stateFile, { userId, accountId, baseUrl }) {
  let s = {}
  try { s = JSON.parse(readFileSync(stateFile, 'utf8')) || {} } catch { s = {} }
  s.peers ||= {}; s.allowedUsers ||= []; s.tasks ||= {}; s.processed ||= []
  if (userId && !s.allowedUsers.includes(userId)) s.allowedUsers.push(userId)
  if (userId) s.peers[userId] ||= { cwd: '', history: [], approvals: [] }
  s.account = { accountId: accountId || null, userId: userId || null, baseUrl: baseUrl || API_BASE, connectedAt: new Date().toISOString() }
  const c = { ...s }; delete c.checksum
  s.checksum = createHash('sha256').update(JSON.stringify(c)).digest('hex')
  mkdirSync(dirname(stateFile), { recursive: true })
  const tmp = stateFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8')
  renameSync(tmp, stateFile)
  return { allowedUsers: s.allowedUsers.length, account: s.account }
}

/**
 * 创建一次配对会话。toDataUrl 由调用方注入（宿主半用 profile 里的 qrcode 包）。
 */
export function createPairing(opts) {
  const dataDir = opts.dataDir
  const dshHome = opts.dshHome || process.env.DSH_HOME
  const credFile = opts.credFile || join(dshHome || join(dataDir, 'dsh-home'), '.credentials.yaml')
  const stateFile = join(dataDir, 'state.json')
  const toDataUrl = opts.toDataUrl
  const log = opts.log || (() => {})

  let session = null

  const status = () => {
    if (!session) return { active: false }
    return {
      active: true, status: session.status, qrcode: session.qrcode, qrDataUrl: session.qrDataUrl,
      qrContent: session.qrContent || null,
      needsVerifyCode: session.status === 'need_verifycode', verifyCodeTried: !!session.verifyCode,
      startedAt: session.startedAt, expiredAt: session.expiresAt, error: session.error || null,
      confirmed: session.confirmed || null, redirectHost: session.redirectHost || null,
    }
  }

  const finish = (resp) => {
    const token = resp.bot_token
    const userId = resp.ilink_user_id
    const accountId = resp.ilink_bot_id
    const baseUrl = resp.baseurl || API_BASE
    writeCredentialRef(credFile, CRED_REF, token)
    const seeded = seedState(stateFile, { userId, accountId, baseUrl })
    session.status = 'confirmed'
    session.confirmed = { accountId, userId, baseUrl, credentialFile: credFile, allowedUsers: seeded.allowedUsers }
    log('pair-confirmed account=' + accountId + ' user=' + String(userId).slice(0, 12) + ' cred=' + credFile)
  }

  const refreshQr = async () => {
    const localTokens = []
    const t = readTokenFromFile(credFile) || process.env.DSH_WEIXIN_BOT_TOKEN
    if (t) localTokens.push(t)
    const qr = await post(API_BASE + '/ilink/bot/get_bot_qrcode?bot_type=' + BOT_TYPE, { local_token_list: localTokens })
    if (!qr || !qr.qrcode || !qr.qrcode_img_content) throw new Error('网关没有返回有效二维码')
    session.qrcode = qr.qrcode
    session.pollBase = API_BASE
    session.verifyCode = undefined
    session.qrDataUrl = toDataUrl ? await toDataUrl(qr.qrcode_img_content) : null
    session.qrContent = qr.qrcode_img_content
    session.status = 'wait'
    session.error = null
    session.startedAt = new Date().toISOString()
    session.expiresAt = new Date(Date.now() + 120000).toISOString()
    session.confirmed = null
    log('pair-qr-issued qrcode=' + qr.qrcode)
  }

  /**
   * 客户端每 ~2.5s 调一次；内部单飞（single-flight）：
   * 网关的 get_qrcode_status 是 ~35s 长轮询，若并发发起会堆积 → 同一时刻只允许一次在途请求，
   * 后来的调用直接复用同一个 promise。
   */
  let inflight = null
  const pollOnce = async () => {
    if (!session) return { active: false }
    try {
      let base = session.pollBase || API_BASE
      if (session.redirectHost) base = 'https://' + session.redirectHost
      let url = base + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(session.qrcode)
      if (session.verifyCode) url += '&verify_code=' + encodeURIComponent(session.verifyCode)
      const r = await get(url, 40000)
      const st = r.status || 'wait'
      if (st === 'confirmed') { finish(r); return status() }
      if (st === 'expired') { await refreshQr(); return status() }
      if (st === 'scaned_but_redirect' && r.redirect_host) session.redirectHost = r.redirect_host
      if (st === 'binded_redirect') { session.status = 'binded_redirect'; session.error = '该 ClawBot 已绑定；如需重新配对，请先在原绑定端解除' }
      else session.status = st
      if (st === 'scaned') session.verifyCode = undefined
      if (st !== 'binded_redirect') session.error = null
    } catch (e) {
      const msg = String(e?.message ?? e)
      session.error = /abort/i.test(msg) ? null : msg
    }
    return status()
  }

  const poll = () => {
    if (!session) return Promise.resolve({ active: false })
    if (session.status === 'confirmed' || session.status === 'binded_redirect') return Promise.resolve(status())
    if (inflight) return inflight
    inflight = pollOnce().finally(() => { inflight = null })
    return inflight
  }

  return {
    start: async () => { session = { startedAt: new Date().toISOString() }; await refreshQr(); return status() },
    poll,
    status,
    setVerifyCode: (code) => { if (!session) return { active: false }; session.verifyCode = String(code || '').trim() || undefined; return status() },
    stop: () => { const was = !!session; session = null; return { active: false, stopped: was } },
    credentialFile: credFile,
  }
}
