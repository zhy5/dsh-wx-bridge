import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire as makeRequire } from 'node:module'

export const name = 'wxbridge'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), 'kernel')
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
    ctx.logger?.info?.('wxbridge: pairing ready (qr renderer=' + (loadQrRenderer() ? 'qrcode' : 'text-only') + ')')
  }

  const booted = boot().catch((e) => { ctx.logger?.error?.('wxbridge boot failed: ' + String(e?.message ?? e)) })

  ctx.on?.('dispose', () => {
    if (timer) clearInterval(timer)
    if (keeper && keeper.lifecycle === 'host') {
      try { keeper.stopBridge('host-exit'); ctx.logger?.info?.('wxbridge: 宿主退出，已结束桥') } catch {}
    }
  })

  ctx.inject?.(['webServer'], (webCtx) => {
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
          if (p === '/status') { const b = bridgeView(); return send(res, { ok: true, plugin: 'wxbridge', version: '0.0.13', hostPid: process.pid, bridge: b, peers: b ? b.peers : 0 }) }
          if (p === '/log') return send(res, { ok: true, actions, error: lastError })
          if (p === '/info') return send(res, { ok: true, ...infoView() })
          if (p === '/probe') return send(res, { ok: true, path: p, note: 'non-/api prefix served by plugin' })
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
