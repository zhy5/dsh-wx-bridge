import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire as makeRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

export const name = 'wxbridge'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), 'kernel')
const NL = String.fromCharCode(10)
const TASK_TIMEOUT_MS = Number(process.env.WXBRIDGE_TASK_TIMEOUT_MS || 180000)
const require_ = makeRequire(import.meta.url)

/** 解析 qrcode 渲染器：插件不一定自带该依赖，按 profile 层级逐个探，都找不到就降级为原始文字链接。 */
const loadQrRenderer = () => {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const bases = [import.meta.dirname, join(home, 'profiles', 'web'), join(home, 'profiles', 'desktop'), join(home, 'profiles')]
  for (const b of bases) {
    try {
      const f = require_.resolve('qrcode', { paths: [b] })
      const qr = require_(f)
      if (qr && typeof qr.toDataURL === 'function') {
        return (text) => qr.toDataURL(text, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
      }
    } catch {}
  }
  return null
}

const DEFAULTS = {
  dataDir: '',
  cwd: '',
  vault: '',
  nodePath: '',
  intervalMs: 0,
  staleMs: 0,
  // autoStart 默认关：拉起桥的职责归独立 keeper（HKCU Run / start-keeper.vbs）。
  // 宿主自己 spawn 的桥是宿主进程的后代，宿主被整树终止时会连带杀掉（E-2026-09-21-06）。
  autoStart: false,
  autoSupervise: true,
  /**
   * host = 桥由宿主托管：启动即拉起、宿主退出即结束（你的要求：应用关了就不能远程驱动）；
   * standalone = 由独立 keeper 守护（应用关不关都能用）。
   */
  lifecycle: 'standalone',
  hostHome: '',
  /** 与应用同版本的 DSH 运行时入口（留空则自动探测宿主运行时） */
  dshBin: '',
}

const ACTION_LOG_MAX = 60

  let createUserMessage = null
  let installModelSelection = null
  const loadSessionHelpers = async () => {
    if (createUserMessage && installModelSelection) return { createUserMessage, installModelSelection }
    const load = async (specs, key) => {
      for (const spec of specs) {
        try { const m = await import(spec); if (typeof m[key] === 'function') return m[key] } catch {}
      }
      return null
    }
    if (!createUserMessage) createUserMessage = await load(['@deepseek-ai/dsh-llm', 'dsh-llm'], 'createUserMessage')
    if (!installModelSelection) installModelSelection = await load(['@deepseek-ai/dsh-agent', 'dsh-agent'], 'installModelSelection')
    return (createUserMessage && installModelSelection) ? { createUserMessage, installModelSelection } : null
  }

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  let keeper = null
  let timer = null
  let pairing = null

  /** 按钮操作日志（环形缓冲）：面板要能看到"我点了什么、结果如何"。 */
  const actions = []
  const pushAction = (entry) => {
    actions.unshift({ at: new Date().toISOString(), ...entry })
    if (actions.length > ACTION_LOG_MAX) actions.length = ACTION_LOG_MAX
  }

  const readConfigFile = () => {
    const f = process.env.WXBRIDGE_CONFIG || join(process.env.DSH_HOME || '', 'wxbridge', 'config.json')
    try { return JSON.parse(readFileSync(f, 'utf8')) || {} } catch { return {} }
  }

  const boot = async () => {
    const file = readConfigFile()
    const pick = (k) => cfg[k] || file[k] || undefined
    const dataDir = pick('dataDir')
    const vault = pick('vault')
    const cwd = pick('cwd')
    const hostHome = pick('hostHome') || process.env.DSH_HOME || ''
    // 自动探测宿主运行时：会话 schema 必须与应用一致，否则外部写的会话在应用里打不开
    const dshBin = pick('dshBin') || process.env.DSH_RUNTIME_BIN || ''
    const ownership = cfg.lifecycle === 'host' || file.lifecycle === 'host' ? 'host' : 'standalone'
    const { createKeeper } = await import(new URL('./kernel/keeper.mjs', import.meta.url).href)
    keeper = createKeeper({
      hostHome,
      dshBin,
      dataDir,
      cwd,
      node: cfg.nodePath || undefined,
      intervalMs: cfg.intervalMs || file.intervalMs || undefined,
      staleMs: cfg.staleMs || file.staleMs || undefined,
      bridgePath: join(KERNEL, 'bridge.mjs'),
      // 宿主半只做监测与报告，生命周期归独立 keeper（E-2026-09-21-06）。
      superviseMode: ownership === 'host' ? 'heal' : 'monitor',
      // --host-home 由内核（keeper.mjs）统一追加，这里只补宿主特有的参数，避免重复
      bridgeArgs: [...(vault ? ['--vault', vault] : []), ...(ownership === 'host' ? ['--owner-pid', String(process.pid)] : [])],
      detached: ownership === 'host' ? false : true,
    })
    keeper.lifecycle = ownership
    const st = keeper.status()
    ctx.logger?.info?.('wxbridge: data=' + st.dataDir + ' cwd=' + st.cwd + ' pid=' + st.pid + ' pidOk=' + st.pidOk)
    const standaloneKeeper = (() => { try { const j = JSON.parse(readFileSync(join(st.dataDir, 'keeper.lock'), 'utf8')); return j && j.pid ? Number(j.pid) : 0 } catch { return 0 } })()
    ctx.logger?.info?.('wxbridge: 独立 keeper pid=' + (standaloneKeeper || '无') + '（负责拉起/自愈；宿主半只做看门狗，不抢拉起）')
    if (ownership === 'host') {
      if (!st.pidOk) {
        try { ctx.logger?.info?.('wxbridge: host-owned 模式，拉起桥 pid=' + keeper.startBridge('host-boot', true)) } catch (e) { ctx.logger?.warn?.('wxbridge: 拉起失败 ' + String(e?.message ?? e)) }
      }
      ctx.logger?.info?.('wxbridge: lifecycle=host（宿主退出时结束桥）；hostHome=' + hostHome)
    }
    if (ownership !== 'host' && cfg.autoStart && process.env.WXBRIDGE_NO_AUTOSTART !== '1' && !st.pidOk) {
      try { ctx.logger?.info?.('wxbridge: spawned bridge pid=' + keeper.startBridge()) } catch (e) { ctx.logger?.warn?.('wxbridge: spawn failed ' + String(e?.message ?? e)) }
    }
    // 开机自动归组：把外部（桥/headless）写出的、尚未登记到工作区的会话补登记
    setTimeout(async () => {
      try {
        const fsMod = await import('node:fs')
        const hostHome = process.env.DSH_HOME || ''
        if (!hostHome) return
        // 复用路由里的 attachOne/scanAndAttach 需要 webCtx；这里用等价的独立实现
        const reg = ctx.workspaceRegistry
        if (!reg) { ctx.logger?.info?.('wxbridge: 跳过自动归组（workspaceRegistry 未注入）'); return }
        const workspaces = await reg.list()
        const norm = (v) => String(v || '').replace(/[\/]+$/, '').toLowerCase()
        const known = new Set()
        for (const w of workspaces) for (const id of (w.sessionIds || [])) known.add(id)
        const persistence = ctx.sessionPersistence
        if (!persistence || typeof persistence.list !== 'function') return
        const records = await persistence.list()
        let n = 0
        for (const rec of (records || [])) {
          const header = (rec && (rec.header || rec)) || {}
          const id = String(header.id || '')
          if (!id.startsWith('session-') || known.has(id)) continue
          const ws = workspaces.find((w) => norm(w.path) === norm(header.cwd))
          if (!ws) continue
          try { await ws.attachSession(id); known.add(id); n++ } catch {}
        }
        if (n) ctx.logger?.info?.('wxbridge: 自动归组 ' + n + ' 条会话到对应工作区')
      } catch (e) { ctx.logger?.warn?.('wxbridge: 自动归组失败 ' + String(e?.message ?? e)) }
    }, 15000)
    if (cfg.autoSupervise && process.env.WXBRIDGE_NO_SUPERVISE !== '1') {
      timer = setInterval(() => { try { keeper.tick() } catch (e) { ctx.logger?.warn?.('wxbridge tick: ' + String(e?.message ?? e)) } }, cfg.intervalMs || file.intervalMs || 300000)
      if (timer.unref) timer.unref()
    }
    const { createPairing } = await import(new URL('./pairing.js', import.meta.url).href)
    pairing = createPairing({
      dataDir: st.dataDir,
      dshHome: process.env.DSH_HOME,
      toDataUrl: loadQrRenderer(),
      log: (m) => ctx.logger?.info?.('wxbridge: ' + m),
    })
    pushAction({ action: 'host-boot', ok: true, detail: 'dataDir=' + st.dataDir + ' pidOk=' + st.pidOk + ' qr=' + (loadQrRenderer() ? 'qrcode' : 'text-only') })
    // 把宿主自身的 HTTP 地址写给桥：桥据此把新生成的会话上报回来登记进工作区
    try {
      let port = 0
      try {
        // 依次尝试：webServer 的底层 server → 常见宿主属性 → 配置/环境变量
        const ws = webCtx.webServer || {}
        const cands = [ws.server, ws.httpServer, ws.instance, ws.listener, ws.app]
        for (const srv of cands) {
          if (srv && typeof srv.address === 'function') {
            const addr = srv.address()
            if (addr && typeof addr === 'object' && addr.port) { port = addr.port; break }
          }
        }
        if (!port) {
          for (const k of ['port', 'portNumber', 'listenPort']) if (ws[k]) { port = Number(ws[k]); break }
        }
        if (!port) port = Number(process.env.WXBRIDGE_HOST_PORT || 0)
      } catch {}
      const addrFile = join(st.dataDir, 'host-address.json')
      writeFileSync(addrFile, JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() }, null, 2))
    } catch {}
    ctx.logger?.info?.('wxbridge: pairing ready (qr renderer=' + (loadQrRenderer() ? 'qrcode' : 'text-only') + ')')
  }

  const booted = boot().catch((e) => { ctx.logger?.error?.('wxbridge boot failed: ' + String(e?.message ?? e)) })

  ctx.on?.('dispose', () => {
    if (timer) clearInterval(timer)
    if (keeper && keeper.lifecycle === 'host') {
      try { keeper.stopBridge('host-exit'); ctx.logger?.info?.('wxbridge: 宿主退出，已结束桥') } catch {}
    }
  })

  ctx.inject?.(['webServer', 'workspaceRegistry', 'sessions', 'agents', 'sessionPersistence', 'agentDefaultModel', 'sessionController'], (webCtx) => {
    const send = (res, o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }
    let lastError = null

    const bridgeView = () => {
      if (!keeper) return null
      const st = keeper.status()
      const hb = st.heartbeat || {}
      let peers = 0, tasks = 0, allowed = 0, stateOk = false, manualStop = null
      try {
        const s = JSON.parse(readFileSync(join(st.dataDir, 'state.json'), 'utf8'))
        peers = Object.keys(s.peers || {}).length
        tasks = Object.values(s.tasks || {}).filter((t) => t.status === 'running').length
        allowed = (s.allowedUsers || []).length
        stateOk = !!s.checksum
        manualStop = (s.manualStop && s.manualStop.at) ? s.manualStop : null
      } catch {}
      return {
        phase: hb.phase || 'stopped',
        pid: st.pid, pidOk: st.pidOk, fresh: st.fresh,
        ageSec: st.heartbeat ? Math.round(st.heartbeat.age / 1000) : null,
        polls: hb.polls ?? null, boot: hb.boot ?? null, running: hb.tasks ?? 0,
        peers, tasks, allowedUsers: allowed, stateOk, manualStop,
        dataDir: st.dataDir, cwd: st.cwd, intervalMs: st.intervalMs, staleMs: st.staleMs,
      }
    }

    const infoView = () => {
      const dir = keeper ? keeper.dataDir : ''
      const out = { dataDir: dir, tokenPath: dir ? join(dir, 'auth-token.txt') : null, token: null, vault: cfg.vault || null, contract: null, credentialFile: pairing ? pairing.credentialFile : null, profiles: [] }
      try { out.token = readFileSync(out.tokenPath, 'utf8').trim() } catch {}
      const cp = dir ? join(dir, 'second-brain-contract.txt') : ''
      out.contract = cp && existsSync(cp) ? cp : join(KERNEL, 'second-brain-contract.txt')
      const pdir = join(process.env.DSH_HOME || '', 'profiles')
      try { for (const d of readdirSync(pdir)) { const pj = join(pdir, d, 'package.json'); let nm = d; try { nm = JSON.parse(readFileSync(pj, 'utf8')).name || d } catch {} out.profiles.push(nm) } } catch {}
      return out
    }

    const configPath = () => process.env.WXBRIDGE_CONFIG
      || join(process.env.DSH_HOME || (keeper && keeper.dataDir) || '', 'wxbridge', 'config.json')
    const readJsonFile = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) || {} } catch { return {} } }

    /**
     * 预设名册：用户预设（$DSH_HOME/.agent-presets）优先，其次是运行时的出厂预设树与包内预设。
     * 行 = 一个目录（含 preset.yml + agent.cordis.yml）；无 preset.yml 或缺 composition 的目录视为损坏行，跳过。
     */
    const presetRoots = () => {
      const roots = []
      const home = process.env.DSH_HOME || ''
      if (home) roots.push(join(home, '.agent-presets'))
      for (const bin of [keeper && keeper.dshBin, process.env.DSH_BIN].filter(Boolean)) {
        const rt = dirname(dirname(bin))
        roots.push(join(rt, 'config', 'agent-presets'))
        roots.push(join(rt, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'))
      }
      return roots
    }
    const presetMeta = (dir) => {
      let meta = ''
      try { meta = readFileSync(join(dir, 'preset.yml'), 'utf8') } catch { return null }
      if (!existsSync(join(dir, 'agent.cordis.yml'))) return null
      const pick = (k) => { const m = meta.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : '' }
      return { name: pick('name'), description: pick('description'), order: Number(pick('order') || 999) }
    }
    const listPresets = () => {
      const seen = new Set(); const out = []
      for (const root of presetRoots()) {
        let ids = []
        try { ids = readdirSync(root) } catch { continue }
        for (const id of ids) {
          if (String(id).startsWith('.') || /\.bak/.test(id) || seen.has(id)) continue
          const meta = presetMeta(join(root, id))
          if (!meta) continue
          seen.add(id); out.push({ id, name: meta.name || id, description: meta.description, order: meta.order })
        }
      }
      return out.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)))
    }

    const readBody = (req) => new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy() })
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })

    const disposer = webCtx.webServer.register({
      kind: 'prefix',
      path: '/wxbridge',
      handler: async (req, res) => {
        const p = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/wxbridge/, '') || '/'
        try {
          await booted
          if (p === '/status') { const b = bridgeView(); return send(res, { ok: true, plugin: 'wxbridge', version: '0.0.16', hostPid: process.pid, bridge: b, peers: b ? b.peers : 0 }) }
          if (p === '/log') return send(res, { ok: true, actions, error: lastError })
          if (p === '/info') return send(res, { ok: true, ...infoView() })
          if (p === '/probe') return send(res, { ok: true, path: p, note: 'non-/api prefix served by plugin' })
          // ===== 会话归组：把外部（桥/headless）写出的会话登记进工作区 =====
          const attachOne = async (sessionId, wantWs, cwdHint, title) => {
            const reg = webCtx.workspaceRegistry
            if (!reg) return { ok: false, error: 'workspaceRegistry 不可用' }
            let list = []
            try { list = await reg.list() } catch {}
            const items = Array.isArray(list) ? list : (list && list.items) || []
            const norm = (v) => String(v || '').replace(/[\/]+$/, '').toLowerCase()
            const target = (wantWs ? items.find((w) => String(w.id ?? w.workspaceId) === wantWs) : null)
              || (cwdHint ? items.find((w) => norm(w.path) === norm(cwdHint)) : null)
              || items[0]
            if (!target) return { ok: false, error: '未找到目标工作区' }
            try { await target.attachSession(sessionId) } catch (e) {
              return { ok: false, error: 'attachSession 失败: ' + String(e?.message ?? e) }
            }
            let renamed = false
            try {
              if (title && webCtx.sessions && typeof webCtx.sessions.rename === 'function') { await webCtx.sessions.rename(sessionId, title); renamed = true }
            } catch {}
            pushAction({ action: 'attach', ok: true, detail: sessionId + ' → ' + String(target.path) + (renamed ? '（改名）' : '') })
            return { ok: true, sessionId, workspaceId: target.id ?? target.workspaceId, workspacePath: target.path, renamed }
          }

          // 扫描：把尚未登记进工作区的会话补登记（桥写的会话天然落在工作区路径下，按 cwd 精确匹配）
          const scanAndAttach = async (limit) => {
            const reg = webCtx.workspaceRegistry
            if (!reg) return { ok: false, error: 'workspaceRegistry 不可用' }
            let workspaces = []
            try { workspaces = await reg.list() } catch {}
            workspaces = Array.isArray(workspaces) ? workspaces : []
            const norm = (v) => String(v || '').replace(/[\/]+$/, '').toLowerCase()

            // 已登记集合：直接从各工作区记录里取，天然幂等
            const known = new Set()
            for (const w of workspaces) for (const id of (w.sessionIds || [])) known.add(id)

            // 列出所有持久化会话（宿主内服务，含 header.cwd）
            let records = []
            try {
              const persistence = webCtx.sessionPersistence
              if (persistence && typeof persistence.list === 'function') records = await persistence.list()
              else if (webCtx.sessions && typeof webCtx.sessions.list === 'function') records = webCtx.sessions.list()
            } catch (e) { return { ok: false, error: '无法列出会话: ' + String(e?.message ?? e) } }
            records = Array.isArray(records) ? records : []

            const added = [], failed = []
            let matched = 0
            for (const rec of records) {
              const header = (rec && (rec.header || rec)) || {}
              const id = String(header.id || '')
              if (!id.startsWith('session-') || known.has(id)) continue
              const cwd = norm(header.cwd)
              if (!cwd) continue
              const ws = workspaces.find((w) => norm(w.path) === cwd)
              if (!ws) continue
              matched++
              if (limit && added.length >= limit) continue
              const r = await attachOne(id, ws.id ?? ws.workspaceId, ws.path, '')
              if (r.ok) { added.push(id); known.add(id) } else failed.push({ id, error: r.error })
            }
            return { scanned: records.length, matchedCwd: matched, attached: added.length, added: added.slice(0, 20), failed: failed.slice(0, 5) }
          }

          // ===== 宿主内驱动一轮对话（原生会话 + 原生上下文，替代桥 spawn headless）=====
          const runTask = async (text, opts = {}) => {
            const sc = webCtx.sessionController
            if (!sc) return { ok: false, error: 'sessionController 服务不可用（需宿主注入）' }

            const norm = (v) => String(v || '').replace(/[\/]+$/, '').toLowerCase()
            const workspaces = await (async () => { try { return (await webCtx.workspaceRegistry.list()) || [] } catch { return [] } })()
            const ws = (opts.workspaceId ? workspaces.find((w) => String(w.id ?? w.workspaceId) === String(opts.workspaceId)) : null)
              || (opts.cwd ? workspaces.find((w) => norm(w.path) === norm(opts.cwd)) : null)
              || workspaces[0]
            if (!ws) return { ok: false, error: '未找到工作区' }

            const wsId = ws.id ?? ws.workspaceId
            let sessionId = String(opts.sessionId || '')
            let created = false

            if (!sessionId) {
              // 走宿主自己的 create：它内部就是 workspaceRegistry.get → agents.ensureSession → attachSession
              try {
                const r = await sc.create({ workspaceId: wsId, ...(opts.agentPreset ? { agentPreset: opts.agentPreset } : {}) })
                sessionId = String((r && (r.sessionId || (r.value && r.value.sessionId))) || '')
                created = true
              } catch (e) {
                const msg = String(e?.message ?? e)
                const stack = String(e?.stack || '').split(NL).slice(0, 6).join(' | ')
                return { ok: false, error: 'sessionController.create 失败: ' + msg.slice(0, 600), stack: stack.slice(0, 800), workspaceId: wsId, preset: opts.agentPreset || null }
              }
              if (!sessionId) return { ok: false, error: 'create 未返回 sessionId', workspaceId: wsId }
              pushAction({ action: 'task-create', ok: true, detail: 'session=' + sessionId + ' ws=' + wsId })
            } else {
              try { await ws.attachSession(sessionId) } catch {}
            }

            // 可选：切模型
            if (opts.model && opts.provider) {
              try { await sc.selectModel({ sessionId, selection: { provider: opts.provider, model: opts.model } }) } catch (e) { /* 忽略 */ }
            }

            const before = await (async () => { try { const pg = await sc.page({ sessionId }, AbortSignal.timeout(8000)); return Number(pg && (pg.lastSeq ?? pg.asOfSeq)) || 0 } catch { return 0 } })()

            // 先显式拿 agent（resolveAgent 是 controller 自己的公开方法），把它挂到 sessions 上再 prompt
            let resolved = null
            try { resolved = await sc.resolveAgent(sessionId) } catch (e) { pushAction({ action: 'task-resolve', ok: false, detail: String(e?.message ?? e).slice(0, 160) }) }
            if (resolved && resolved.error) return { ok: false, error: 'resolveAgent: ' + JSON.stringify(resolved.error).slice(0, 300), sessionId, created }
            try {
              await sc.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: String(text) }] }, AbortSignal.timeout(Math.min(TASK_TIMEOUT_MS, 180000)))
            } catch (e) {
              return { ok: false, error: 'sessionController.prompt 失败: ' + String(e?.message ?? e), sessionId, created, resolved: !!resolved }
            }

            // 等这一轮结束并取回助手文本：轮询 page（宿主权威的会话视图）
            let out = '', reason = null, detail = null
            const deadline = Date.now() + Math.min(TASK_TIMEOUT_MS, 180000)
            let lastSeq = before
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1200))
              let pg = null
              try { pg = await sc.page({ sessionId }, AbortSignal.timeout(8000)) } catch {}
              const seqNow = Number((pg && (pg.lastSeq ?? pg.asOfSeq)) || 0)
              if (seqNow > lastSeq) lastSeq = seqNow
              const events = (pg && pg.events) || []
              for (const e of events) {
                if (e.type === 'assistant/message') {
                  const b = (e.data && e.data.message && e.data.message.content) || []
                  const joined = b.filter((x) => x.type === 'text').map((x) => x.text).join('')
                  if (joined) out = joined
                }
                if (e.type === 'turn/end') {
                  reason = e.data && e.data.reason
                  if (reason && reason.kind === 'error' && reason.error) detail = { code: reason.error.code, message: String(reason.error.message || '').slice(0, 300) }
                }
              }
              if (out || detail) break
              if (pg && pg.idle === true) break
            }

            try {
              const dbg = join(keeper ? keeper.dataDir : KERNEL, 'task-debug.jsonl')
              appendFileSync(dbg, JSON.stringify({ at: new Date().toISOString(), via: 'sessionController', sessionId, created, lastSeq, text: out.slice(0, 200), reason, detail }) + NL)
            } catch {}

            pushAction({ action: 'task', ok: !!out, detail: 'session=' + sessionId + ' created=' + created + ' len=' + out.length })
            return { ok: true, sessionId, created, text: out, reason: reason ? String(reason.kind || reason) : null, detail }
          }

          if (p === '/task' && req.method === 'POST') {
            const body = await readBody(req)
            const r = await runTask(String((body && body.text) || ''), body || {})
            return send(res, r, r.ok ? 200 : 500)
          }

          if (p === '/scan' && req.method === 'POST') {
            const body = await readBody(req)
            const r = await scanAndAttach(Number(body && body.limit) || 80)
            pushAction({ action: 'scan', ok: true, detail: '扫描 ' + r.scanned + '，登记 ' + r.attached })
            return send(res, { ok: true, ...r })
          }
          if (p === '/attach' && req.method === 'POST') {
            // 把「外部（桥/headless）写出来的会话」登记进宿主的工作区：
            // 外部进程调不到宿主的 RPC（配对 fence），但宿主内插件可以直接用 workspaceRegistry。
            const body = await readBody(req)
            const sessionId = String((body && body.sessionId) || '').trim()
            const title = (body && body.title) || ''
            const want = (body && body.workspaceId) || ''
            if (!sessionId) return send(res, { ok: false, error: 'sessionId required' }, 400)
            const reg = webCtx.workspaceRegistry
            if (!reg) return send(res, { ok: false, error: 'workspaceRegistry 服务不可用' }, 503)
            let list = []
            try { list = await reg.list() } catch (e) { try { list = reg.listSync?.() || [] } catch {} }
            const items = Array.isArray(list) ? list : (list && list.items) || []
            const target = want
              ? items.find((w) => String(w.id ?? w.workspaceId) === want)
              : items.find((w) => String(w.path || '').toLowerCase() === String((body && body.cwd) || '').toLowerCase())
                || items[0]
            if (!target) return send(res, { ok: false, error: '未找到目标工作区', workspaces: items.map((w) => ({ id: w.id, path: w.path })) }, 404)
            const wsId = target.id ?? target.workspaceId
            try {
              await target.attachSession(sessionId)
            } catch (e) {
              return send(res, { ok: false, error: 'attachSession 失败: ' + String(e?.message ?? e), workspaceId: wsId, path: target.path }, 500)
            }
            let renamed = false
            try {
              if (title && webCtx.sessions && typeof webCtx.sessions.rename === 'function') { await webCtx.sessions.rename(sessionId, title); renamed = true }
            } catch {}
            pushAction({ action: 'attach', ok: true, detail: sessionId + ' → 工作区 ' + target.path + (renamed ? '（已改名）' : '') })
            return send(res, { ok: true, sessionId, workspaceId: wsId, workspacePath: target.path, renamed })
          }
          if (p === '/svc') {
            // 探针：宿主进程内我们能拿到哪些服务（用于判断能否在宿主里创建会话）
            const probe = (fn) => { try { return fn() } catch (e) { return 'ERR:' + String(e?.message ?? e).slice(0, 60) } }
            const seen = {
              workspaceRegistry: probe(() => !!webCtx.workspaceRegistry),
              sessions: probe(() => !!webCtx.sessions),
              agents: probe(() => !!webCtx.agents),
              sessionPersistence: probe(() => !!webCtx.sessionPersistence),
              sessionQuery: probe(() => !!webCtx.sessionQuery),
              llm: probe(() => !!webCtx.llm),
              typert: probe(() => !!webCtx.typert),
              storage: probe(() => !!webCtx.storage),
            }
            const ctxSeen = { defaultCwd: probe(() => !!webCtx.defaultCwd), sessionTitle: probe(() => typeof webCtx.get === 'function' ? !!webCtx.get('sessionTitle') : 'no ctx.get') }
            const reg = probe(() => (webCtx.workspaceRegistry && typeof webCtx.workspaceRegistry.list === 'function') ? 'list() 可用' : '无 list()')
            const ses = probe(() => (webCtx.sessions && typeof webCtx.sessions.create === 'function') ? 'create() 可用' : '无 create()')
            const ag = probe(() => (webCtx.agents && typeof webCtx.agents.createAgent === 'function') ? 'createAgent() 可用' : (webCtx.agents ? Object.getOwnPropertyNames(Object.getPrototypeOf(webCtx.agents)).slice(0, 12).join(',') : '无'))
            const sc = probe(() => {
              const c = webCtx.sessionController
              if (!c) return '无'
              return '方法: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((k) => k !== 'constructor').slice(0, 22).join(',')
            })
            return send(res, { ok: true, services: seen, context: ctxSeen, workspaceRegistryFace: reg, sessionsFace: ses, agentsFace: ag, sessionControllerFace: sc })
          }
          if (p === '/qr/start' && req.method === 'POST') {
            if (!pairing) return send(res, { ok: false, error: 'pairing not ready' }, 503)
            const s = await pairing.start()
            pushAction({ action: 'qr/start', ok: !s.error, detail: 'qrcode=' + s.qrcode + ' status=' + s.status })
            return send(res, { ok: !s.error, pairing: s, error: s.error || undefined })
          }
          if (p === '/qr/status') {
            if (!pairing) return send(res, { ok: false, error: 'pairing not ready' }, 503)
            return send(res, { ok: true, pairing: await pairing.poll() })
          }
          if (p === '/qr/verify' && req.method === 'POST') {
            if (!pairing) return send(res, { ok: false, error: 'pairing not ready' }, 503)
            const body = await readBody(req)
            pairing.setVerifyCode(body && body.code)
            return send(res, { ok: true, pairing: await pairing.poll() })
          }
          if (p === '/qr/stop' && req.method === 'POST') {
            if (!pairing) return send(res, { ok: false, error: 'pairing not ready' }, 503)
            return send(res, { ok: true, pairing: pairing.stop() })
          }
          if (!keeper) return send(res, { ok: false, error: 'not booted' }, 503)
          if (p === '/start') {
            const st = keeper.status()
            if (st.pidOk) { pushAction({ action: 'start', ok: true, detail: 'already running pid=' + st.pid }); return send(res, { ok: true, already: true, pid: st.pid }) }
            const pid = keeper.startBridge('panel', true)
            pushAction({ action: 'start', ok: true, detail: 'pid=' + pid })
            return send(res, { ok: true, pid })
          }
          if (p === '/stop') {
            const stopped = keeper.stopBridge('panel')
            pushAction({ action: 'stop', ok: true, detail: 'stopped=' + stopped + '（人工停止粘性：自检不再自动拉起，直到点「启动」）' })
            return send(res, { ok: true, stopped })
          }
          if (p === '/restart') {
            keeper.stopBridge('panel-restart')
            await new Promise((r) => setTimeout(r, 1500))
            const pid = keeper.startBridge('panel-restart')
            pushAction({ action: 'restart', ok: true, detail: 'new pid=' + pid })
            return send(res, { ok: true, pid })
          }
          if (p === '/tick') {
            const r = keeper.tick()
            pushAction({ action: 'tick', ok: true, detail: JSON.stringify(r) })
            return send(res, { ok: true, result: r })
          }
          // ===== 手机通道预设：读名册 / 写选定值到配置文件（桥每条任务重读配置，改完即生效）=====
          if (p === '/presets') {
            const cfgNow = readJsonFile(configPath())
            const sel = (cfgNow.acp && typeof cfgNow.acp === 'object' && typeof cfgNow.acp.preset === 'string') ? cfgNow.acp.preset : ''
            let out = []
            try { out = listPresets() } catch (e) { lastError = String(e?.message ?? e) }
            return send(res, { ok: true, presets: out, selected: sel, configFile: configPath(),
              note: '预设来自 DSH 名册（用户 .agent-presets + 运行时出厂树）；留空＝跟随默认预设' })
          }
          if (p === '/preset' && req.method === 'POST') {
            const body = await readBody(req)
            const f = configPath()
            const keep = readJsonFile(f)
            const want = body && typeof body.preset === 'string' ? body.preset.trim() : ''
            keep.acp = Object.assign({}, (keep.acp && typeof keep.acp === 'object') ? keep.acp : {}, { preset: want })
            mkdirSync(dirname(f), { recursive: true })
            writeFileSync(f, JSON.stringify(keep, null, 2))
            pushAction({ action: 'preset-save', ok: true, detail: want || '(空=跟随 DSH 默认预设)' })
            return send(res, { ok: true, preset: want, configFile: f, note: '下一条微信任务即生效（桥每条任务都重读配置）' })
          }
          if (p === '/config' && req.method === 'POST') {
            const body = await readBody(req)
            const f = configPath()
            const keep = readJsonFile(f)
            for (const k of ['dataDir', 'cwd', 'vault', 'dshBin', 'intervalMs', 'staleMs']) if (body && body[k]) keep[k] = body[k]
            if (body && typeof body.prompt === 'string') keep.prompt = body.prompt
            mkdirSync(dirname(f), { recursive: true })
            writeFileSync(f, JSON.stringify(keep, null, 2))
            return send(res, { ok: true, written: f, applied: keep, note: '提示词下次任务即生效；其余项重启宿主后生效' })
          }
          if (p === '/prompt') {
            if (req.method === 'POST') {
              const body = await readBody(req)
              const f = configPath()
              const keep = readJsonFile(f)
              keep.prompt = typeof body.prompt === 'string' ? body.prompt : ''
              mkdirSync(dirname(f), { recursive: true })
              writeFileSync(f, JSON.stringify(keep, null, 2))
              pushAction({ action: 'prompt-save', ok: true, detail: '长度 ' + keep.prompt.length + '（空=不注入任何提示词）' })
              return send(res, { ok: true, prompt: keep.prompt, note: '下一条微信任务即生效（桥每条任务都重读配置）' })
            }
            const f = configPath()
            const keep = readJsonFile(f)
            let contractTemplate = ''
            try { contractTemplate = readFileSync(join(KERNEL, 'second-brain-contract.txt'), 'utf8') } catch {}
            return send(res, { ok: true, prompt: typeof keep.prompt === 'string' ? keep.prompt : null,
              usingDefault: typeof keep.prompt !== 'string', contractTemplate, configFile: f })
          }
          return send(res, { ok: false, path: p }, 404)
        } catch (e) {
          lastError = String(e?.message ?? e)
          pushAction({ action: p, ok: false, detail: 'error: ' + lastError })
          return send(res, { ok: false, error: lastError }, 500)
        }
      },
    })
    return disposer
  })
}
