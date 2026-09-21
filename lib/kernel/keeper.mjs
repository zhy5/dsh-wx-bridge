/**
 * WeChat ⇄ DSH bridge keeper (零依赖).
 *
 * 职责：每 KEEPER_INTERVAL_MS 自检一次，不健康则以「脱离父进程树」的方式重新拉起桥。
 * 健康判据：bridge.lock 的 pid 存活 + heartbeat.json 新鲜 + polls 在推进（按 boot 代次）。
 *
 * 全部路径与阈值走环境变量，无任何硬编码绝对路径：
 *   BRIDGE_DATA    数据目录（必填；未给则回退 WXBRIDGE_DATA，再回退 $DSH_HOME/wxbridge）
 *   BRIDGE_CWD     桥与任务的默认工作目录（默认 process.cwd()）
 *   BRIDGE_NODE    node 可执行文件（默认 process.execPath）
 *   KEEPER_INTERVAL_MS / KEEPER_STALE_MS  自检间隔 / 心跳判新阈值（默认 5 分钟）
 *
 * 也可作为模块被宿主进程 import：导出 tick()/status()/startBridge()/stopBridge()。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const NL = String.fromCharCode(10)
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 轮询是否在推进（纯函数，可单测）。
 * 关键：进度下限必须按「桥的代次 boot」隔离——桥重启后 polls 归零，
 * 若沿用上一代的下限，会被误判为「没进展」，导致每轮自检都杀掉重启（死循环）。
 */
export function progressVerdict(hb, floor, staleMs, now = Date.now()) {
  if (!hb) return true
  const sameBoot = floor && floor.polls >= 0 && Number(floor.boot) === Number(hb.boot)
  if (!sameBoot) return true
  if (hb.polls > floor.polls) return true
  return !(now - (floor.seenAt || 0) > 2 * staleMs)
}

export function readConfigFile() {
  const f = process.env.WXBRIDGE_CONFIG || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge', 'config.json')
  try { return JSON.parse(readFileSync(f, 'utf8')) || {} } catch (e) {
    if (e && e.code !== 'ENOENT') process.stderr.write('[keeper] config unreadable (' + String(e.message) + '): ' + f + NL)
    return {}
  }
}

export function resolveDataDir(explicit) {
  const d = explicit || readConfigFile().dataDir || process.env.BRIDGE_DATA || process.env.WXBRIDGE_DATA
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge')
  return d
}

export function createKeeper(opts = {}) {
  const file = readConfigFile()
  const DATA = resolveDataDir(opts.dataDir)
  const CWD = opts.cwd || file.cwd || process.env.BRIDGE_CWD || process.env.BRIDGE_ROOT || process.cwd()
  const NODE = opts.node || process.env.BRIDGE_NODE || process.execPath


  const INTERVAL_MS = Number(opts.intervalMs || file.intervalMs || process.env.KEEPER_INTERVAL_MS || 5 * 60 * 1000)
  const STALE_MS = Number(opts.staleMs || file.staleMs || process.env.KEEPER_STALE_MS || 5 * 60 * 1000)
  const BRIDGE = opts.bridgePath || join(HERE, 'bridge.mjs')
  const BRIDGE_ARGS = Array.isArray(opts.bridgeArgs) ? opts.bridgeArgs : []
  const VAULT = opts.vault || file.vault || process.env.BRAIN_VAULT || ''

  const LOCK = join(DATA, 'bridge.lock')
  const KEEPER_LOCK = join(DATA, 'keeper.lock')
  const HB = join(DATA, 'heartbeat.json')
  const POLL_STATE = join(DATA, 'keeper-polls.json')
  const LOG = join(DATA, 'keeper.log')

  mkdirSync(DATA, { recursive: true })

  const log = (m) => {
    try { appendFileSync(LOG, new Date().toISOString() + ' ' + m + NL) } catch {}
  }
  const childEnv = () => ({ ...process.env, BRIDGE_DATA: DATA, BRIDGE_CWD: CWD, BRIDGE_ROOT: DATA })

  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

  function bridgePid() {
    try {
      if (!existsSync(LOCK)) return 0
      const j = JSON.parse(readFileSync(LOCK, 'utf8'))
      return Number(j?.pid) || 0
    } catch { return 0 }
  }

  function readHeartbeat() {
    try {
      if (!existsSync(HB)) return null
      const j = JSON.parse(readFileSync(HB, 'utf8'))
      const at = Date.parse(j.at)
      const ok = Number.isFinite(at) ? at : 0
      return { at: ok, boot: Number(j.boot) || 0, polls: Number(j.polls) || 0, phase: j.phase, tasks: Number(j.tasks) || 0, age: Date.now() - ok }
    } catch { return null }
  }

  const loadPollFloor = () => { try { return JSON.parse(readFileSync(POLL_STATE, 'utf8')) } catch { return { boot: 0, polls: -1, seenAt: 0 } } }
  const savePollFloor = (v) => { try { writeFileSync(POLL_STATE, JSON.stringify(v)) } catch {} }

  function spawnBridge() {
    const extra = [...BRIDGE_ARGS, ...(VAULT ? ['--vault', VAULT] : [])]
    const child = spawn(NODE, [BRIDGE, ...extra], { cwd: CWD, env: childEnv(), detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return child.pid
  }

  function killTree(pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }

  function cleanOrphans(deadPid) {
    let killed = 0
    try {
      const ps = 'Get-CimInstance Win32_Process -Filter ' + JSON.stringify("name='node.exe'")
        + ' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
      const parsed = JSON.parse(out || '[]')
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const it of list) {
        const cmd = String(it.CommandLine || '')
        if (!cmd.includes('dsh/lib/bin.js')) continue
        if (!cmd.toUpperCase().includes(DATA.toUpperCase())) continue
        if (deadPid && Number(it.ProcessId) === Number(deadPid)) continue
        try { execFileSync('taskkill', ['/PID', String(it.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killed++ } catch {}
      }
    } catch {}
    return killed
  }

  function status() {
    const pid = bridgePid()
    const hb = readHeartbeat()
    const pidOk = pid > 0 && alive(pid)
    const fresh = !!hb && hb.age < STALE_MS
    return { pid, pidOk, fresh, heartbeat: hb, staleMs: STALE_MS, intervalMs: INTERVAL_MS, dataDir: DATA, cwd: CWD }
  }

  function stopBridge() {
    const pid = bridgePid()
    let stopped = false
    if (pid > 0) { killTree(pid); if (alive(pid)) { try { process.kill(pid) } catch {} } stopped = true }
    try { cleanOrphans(pid) } catch {}
    try { writeFileSync(LOCK, '{}') } catch {}
    try { writeFileSync(HB, JSON.stringify({ at: new Date().toISOString(), phase: 'stopped', polls: 0, tasks: 0, pid: 0, boot: 0 })) } catch {}
    log('stopped by request pid=' + pid)
    return stopped
  }

  function tick() {
    const pid = bridgePid()
    const hb = readHeartbeat()
    const pidOk = pid > 0 && alive(pid)
    const fresh = !!hb && hb.age < STALE_MS

    let progressing = true
    if (hb) {
      const floor = loadPollFloor()
      progressing = progressVerdict(hb, floor, STALE_MS)
      if (progressing) {
        if (floor.polls < 0 || Number(floor.boot) !== Number(hb.boot) || hb.polls > floor.polls) {
          savePollFloor({ boot: hb.boot, polls: hb.polls, seenAt: Date.now() })
        }
      }
    }

    if (pidOk && fresh && progressing) {
      return { restarted: false, healthy: true }
    }

    log('UNHEALTHY pid=' + pid + ' pidOk=' + pidOk + ' fresh=' + fresh + ' progressing=' + progressing
      + ' age=' + (hb ? Math.round(hb.age / 1000) + 's' : 'n/a') + ' polls=' + (hb ? hb.polls : 'n/a'))
    const killed = cleanOrphans(pid)
    if (killed) log('cleaned orphan headless children = ' + killed)
    if (pidOk) { killTree(pid); if (alive(pid)) { try { process.kill(pid) } catch {} } log('killed pid=' + pid) }
    try { writeFileSync(LOCK, '{}') } catch {}
    let newPid = 0
    try { newPid = spawnBridge(); log('restart spawned pid=' + newPid) } catch (e) { log('restart FAILED: ' + String(e?.message ?? e)) }
    return { restarted: true, healthy: false, pid: newPid }
  }

  function acquireKeeperLock() {
    try {
      if (existsSync(KEEPER_LOCK)) {
        const old = JSON.parse(readFileSync(KEEPER_LOCK, 'utf8'))
        if (old && old.pid && alive(old.pid)) { log('keeper already running pid=' + old.pid + ' -> exit'); return false }
      }
    } catch {}
    writeFileSync(KEEPER_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    const release = () => { try { writeFileSync(KEEPER_LOCK, '{}') } catch {} }
    process.on('exit', release)
    process.on('SIGINT', () => { release(); process.exit(0) })
    process.on('SIGTERM', () => { release(); process.exit(0) })
    return true
  }

  function run() {
    if (!acquireKeeperLock()) process.exit(0)
    log('keeper start pid=' + process.pid + ' data=' + DATA + ' interval=' + Math.round(INTERVAL_MS / 1000) + 's bridge=' + BRIDGE)
    tick()
    setInterval(tick, INTERVAL_MS)
  }

  return { run, tick, status, startBridge: spawnBridge, stopBridge, log, dataDir: DATA, cwd: CWD, bridgePath: BRIDGE, intervalMs: INTERVAL_MS, staleMs: STALE_MS }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
  const keeper = createKeeper({ dataDir: argOf('--data-dir'), cwd: argOf('--cwd'), intervalMs: argOf('--interval-ms') })
  keeper.run()
}
