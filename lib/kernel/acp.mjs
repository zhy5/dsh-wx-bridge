/**
 * acp.mjs — DSH ACP 客户端（内核组件）
 *
 * 为什么需要它：旧路径把「契约 + 历史 + 本轮」拼成一个提示词交给一次性 headless 子进程，
 * 上下文由**桥**维护（拼接），因此每轮都是新会话、也没有会话可续。
 * 新路径：由桥起一个常驻的 `dsh --profile acp` 进程，用 ACP（Agent Client Protocol v1）
 * 驱动 **DSH 自己的会话**——会话由 DSH 持久化，上下文归 DSH，桥只负责传话。
 *
 * 协议要点（源自 @deepseek-ai/dsh-acp 的 README 与实现）：
 *   initialize / session/new / session/list / session/resume / session/close /
 *   session/set_config_option / session/prompt / session/cancel（通知）
 *   服务端→客户端：session/update（通知）、session/request_permission（请求，必须应答）
 *   v1 不再有 session/load（已声明不支持）。
 *
 * 传输：stdio 上的 NDJSON（一行一个 JSON-RPC）。stdout 只有协议流量，日志在 stderr。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PROTOCOL_VERSION = 1
const NL = '\n'

export class AcpHost {
  /**
   * @param {object} o
   * @param {string} o.bin        dsh 入口（bin.js 绝对路径）
   * @param {string} [o.node]      用哪个 node 跑它（默认本进程的 execPath）
   * @param {string} [o.home]     子进程 DSH_HOME（决定会话写进哪个仓库）
   * @param {string} [o.cwd]      子进程工作目录（默认进程 cwd）
   * @param {string} [o.patch]    --patch 叠加层文件（如停用宿主专属插件）
   * @param {'ask'|'allow'|'reject'} [o.permPolicy] 权限策略：
   *        'ask'（默认）把审批请求交给 onPermission 去问人；'allow'/'reject' 自动应答（旧行为）
   * @param {(req:{sessionId:string, toolCall:object, options:Array, seq:number})=>Promise<string|null>} [o.onPermission]
   *        返回要选的 optionId；返回 null/抛错 → 按 permFallback 应答
   * @param {'allow'|'reject'} [o.permFallback] 问不到人时的兜底（默认 reject，fail-closed）
   * @param {number} [o.promptTimeoutMs]
   * @param {(m:string, e?:object)=>void} [o.log]
   */
  constructor(o) {
    this.bin = o.bin
    this.node = o.node || process.execPath
    this.home = o.home || ''
    this.cwd = o.cwd || process.cwd()
    this.patch = o.patch || ''
    this.permPolicy = ['ask', 'allow', 'reject'].includes(o.permPolicy) ? o.permPolicy : 'ask'
    this.onPermission = typeof o.onPermission === 'function' ? o.onPermission : null
    this.permFallback = o.permFallback === 'allow' ? 'allow' : 'reject'
    this.permSeq = 0
    this.promptTimeoutMs = Number(o.promptTimeoutMs || 300000)
    this.log = o.log || (() => {})
    this.child = null
    this.ready = null
    this.nextId = 1
    this.pending = new Map()
    this.inflight = new Map()
    /** 本进程内已挂载（激活）的会话：这些不能 resume（resume 只接非激活的持久会话）。 */
    this.sessions = new Set()
    this.buf = ''
    this.errTail = ''
    this.notes = []
  }

  get pid() { return this.child?.pid ?? 0 }
  /** 该会话是否已由本进程挂载（激活）。 */
  has(sessionId) { return this.sessions.has(sessionId) }
  get alive() { return !!this.child && this.child.exitCode === null }

  /** 惰性启动 + 握手（并发调用共享同一个 promise）。 */
  ensure() {
    if (this.ready) return this.ready
    this.ready = this._start().catch((e) => { this.ready = null; throw e })
    return this.ready
  }

  async _start() {
    // 入口必须先自证存在：spawn(node, ['']) 会让 node 进入「读 stdin」模式——
    // 不回应协议、也不退出，调用方只能等满超时（2026-09-22 其他用户实况：
    // 「手机发消息永远没答复，5 分钟后收到一条失败提示」）。宁可当场报错。
    if (!this.bin || !existsSync(this.bin)) {
      this.log('acp-bin-missing', { bin: this.bin || '', node: this.node })
      throw new Error('ACP 通道不可用：DSH 运行时入口未解析（dshBin=' + (this.bin || '空') + '）。'
        + '请把插件配置里的 dshBin 指向 <安装目录>/resources/dsh-runtime/lib/bin.js，或设环境变量 DSH_BIN 后重启。')
    }
    const args = [this.bin, '--profile', 'acp']
    if (this.patch) args.push('--patch', this.patch)
    const env = { ...process.env }
    if (this.home) env.DSH_HOME = this.home
    const child = spawn(this.node, args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    this.child = child
    this.log('acp-spawn', { pid: child.pid, home: this.home || '(inherit)', patch: this.patch || null })
    child.stdout.on('data', (b) => this._onData(b))
    child.stderr.on('data', (b) => {
      const s = String(b)
      this.errTail = (this.errTail + s).slice(-2000)
      this.log('acp-stderr', { s: s.slice(0, 300) })
    })
    child.on('exit', (code, signal) => {
      this.log('acp-exit', { code, signal, stderr: this.errTail.slice(-400) })
      this.ready = null
      this.sessions.clear()
      for (const [, p] of this.pending) p.reject(new Error('ACP 进程已退出(code=' + code + ')'))
      this.pending.clear()
    })
    if (child.stdin.on) child.stdin.on('error', () => {})
    const init = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    this.notes.push(init?.agentInfo?.name || 'acp')
    return init
  }

  _onData(b) {
    this.buf += String(b)
    let i
    while ((i = this.buf.indexOf(NL)) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let f
      try { f = JSON.parse(line) } catch { continue }
      this._onFrame(f)
    }
  }

  _onFrame(f) {
    if (f.id !== undefined && f.method === undefined) {
      const p = this.pending.get(f.id)
      if (!p) return
      this.pending.delete(f.id)
      if (p.late) {
        // 迟到帧：调用方早已按超时返回，但这一轮其实跑完了 → 交回给它补发结果
        try { p.late(f.error ? null : f.result, f.error ? new Error(String(f.error.message || 'rpc error')) : null) } catch (e) { this.log('acp-late-handler-failed', { error: String(e?.message ?? e) }) }
        return
      }
      if (f.error) p.reject(Object.assign(new Error(String(f.error.message || 'rpc error')), { rpc: f.error }))
      else p.resolve(f.result)
      return
    }
    if (f.method === 'session/update') {
      const sid = f.params?.sessionId
      const u = f.params?.update ?? {}
      const sink = this.inflight.get(sid)
      if (sink) sink(u)
      return
    }
    if (f.method === 'session/request_permission') {
      const params = f.params ?? {}
      const opts = Array.isArray(params.options) ? params.options : []
      const seq = ++this.permSeq
      const pickByPolicy = (policy) => policy === 'reject'
        ? (opts.find((o) => /reject/.test(String(o.kind))) || opts.find((o) => /reject/.test(String(o.optionId))))
        : (opts.find((o) => /allow/.test(String(o.kind))) || opts.find((o) => /allow/.test(String(o.optionId))))
      if (this.permPolicy === 'ask' && this.onPermission) {
        // 问人：**不能阻塞读循环**（同一进程还要收 session/update 与别的请求），所以异步应答。
        const ask = this.onPermission
        ;(async () => {
          let picked = null
          let how = 'ask'
          try {
            const optionId = await ask({ sessionId: params.sessionId, toolCall: params.toolCall ?? {}, options: opts, seq })
            picked = optionId ? (opts.find((o) => String(o.optionId) === String(optionId)) || { optionId }) : null
          } catch (e) {
            this.log('acp-permission-ask-failed', { seq, error: String(e?.message ?? e) })
          }
          if (!picked) {
            how = 'fallback:' + this.permFallback
            picked = pickByPolicy(this.permFallback === 'allow' ? 'allow' : 'reject')
          }
          this.log('acp-permission', { seq, tool: params.toolCall?.title, policy: 'ask', how, picked: picked?.optionId ?? null })
          this._raw({ jsonrpc: '2.0', id: f.id, result: picked ? { outcome: { outcome: 'selected', optionId: picked.optionId } } : { outcome: { outcome: 'cancelled' } } })
        })()
        return
      }
      const pick = pickByPolicy(this.permPolicy)
      this.log('acp-permission', { seq, tool: params.toolCall?.title, policy: this.permPolicy, picked: pick?.optionId ?? null })
      this._raw({ jsonrpc: '2.0', id: f.id, result: pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } } })
      return
    }
    if (f.id !== undefined && f.method) {
      this._raw({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: 'unsupported by wxbridge client: ' + f.method } })
    }
  }

  _raw(frame) {
    try { this.child.stdin.write(JSON.stringify(frame) + NL) } catch (e) { this.log('acp-write-failed', { error: String(e?.message ?? e) }) }
  }

  _request(method, params, timeoutMs, opts) {
    const o = opts || {}
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const t = setTimeout(() => {
        const err = Object.assign(new Error('ACP 超时：' + method), { code: 'ACP_TIMEOUT', method })
        // 超时 ≠ 失败：`session/prompt` 的一方仍在跑，服务端最后一定会回这一帧。
        // keepAliveOnTimeout 时**保留 pending 条目**，让它落地时走 onLate（避免"以为失败了"→ 兜底重跑一遍）。
        if (o.keepAliveOnTimeout) {
          const p = this.pending.get(id)
          if (p) { p.late = o.onLate || null; p.timedOutAt = Date.now() }
          this.log('acp-request-timeout-kept-alive', { id, method, timeoutMs: Number(timeoutMs || this.promptTimeoutMs) })
        } else {
          this.pending.delete(id)
        }
        reject(err)
      }, Number(timeoutMs || this.promptTimeoutMs))
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      this._raw({ jsonrpc: '2.0', id, method, params })
    })
  }

  async newSession(cwd) {
    await this.ensure()
    const r = await this._request('session/new', { cwd: String(cwd || this.cwd), mcpServers: [] })
    if (r?.sessionId) this.sessions.add(r.sessionId)
    this.log('acp-session-new', { sessionId: r?.sessionId, cwd })
    return r
  }

  async resumeSession(sessionId, cwd) {
    await this.ensure()
    if (this.sessions.has(sessionId)) {
      this.log('acp-session-already-mounted', { sessionId })
      return { sessionId }
    }
    const r = await this._request('session/resume', { sessionId, cwd: String(cwd || this.cwd) })
    this.sessions.add(sessionId)
    this.log('acp-session-resume', { sessionId })
    return r
  }

  /** 列出可续接的持久会话（可选按 cwd 过滤）。 */
  async listSessions(cwd) {
    await this.ensure()
    const r = await this._request('session/list', cwd ? { cwd: String(cwd) } : {})
    return r?.sessions ?? []
  }

  /** 建立/接续一条会话：先试 resume，失败则新建。 */
  async attach(sessionId, cwd) {
    if (sessionId) {
      try { await this.resumeSession(sessionId, cwd); return { sessionId, resumed: true } } catch (e) {
        this.log('acp-resume-failed', { sessionId, error: String(e?.message ?? e) })
      }
    }
    const r = await this.newSession(cwd)
    return { sessionId: r?.sessionId, resumed: false, configOptions: r?.configOptions ?? null }
  }

  /**
   * 发一轮提示词，收集助手正文（思考块与工具生命周期走 onUpdate，便于回传进度）。
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]            本轮等待上限（默认 promptTimeoutMs）
   * @param {boolean} [opts.keepAliveOnTimeout]  超时后**不要丢弃**这一轮：迟到帧交给 onLate
   * @param {(r:{text:string,stopReason:string|null,toolCalls:number,error:Error|null})=>void} [opts.onLate]
   * @returns {Promise<{text:string, stopReason:string, toolCalls:number}>}
   */
  async ask(sessionId, text, onUpdate, opts) {
    await this.ensure()
    const o = opts || {}
    let out = ''
    let tools = 0
    const sink = (u) => {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') out += u.content.text
      else if (u.sessionUpdate === 'tool_call') tools++
      if (onUpdate) { try { onUpdate(u) } catch {} }
    }
    const dropSink = () => { if (this.inflight.get(sessionId) === sink) this.inflight.delete(sessionId) }
    this.inflight.set(sessionId, sink)
    const late = o.onLate
      ? (result, error) => {
        dropSink()
        try { o.onLate({ text: out.trim(), stopReason: result?.stopReason ?? null, toolCalls: tools, error: error || null }) }
        catch (e) { this.log('acp-late-callback-failed', { error: String(e?.message ?? e) }) }
      }
      : null
    try {
      const r = await this._request('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(text) }] },
        o.timeoutMs, { keepAliveOnTimeout: !!o.keepAliveOnTimeout, onLate: late })
      dropSink()
      return { text: out.trim(), stopReason: r?.stopReason ?? null, toolCalls: tools }
    } catch (e) {
      // 超时且已保留：**留着 sink**——这一轮还在跑，正文要靠后续 session/update 累积
      if (!(o.keepAliveOnTimeout && isAcpTimeout(e))) dropSink()
      throw e
    }
  }

  /** 改会话配置（model / reasoning_effort）。value 形如 '["provider","model"]' 或 'high'。 */
  async setConfigOption(sessionId, configId, value) {
    await this.ensure()
    const r = await this._request('session/set_config_option', { sessionId, configId, value })
    this.log('acp-set-config', { sessionId, configId, value })
    return r
  }

  async cancel(sessionId) {
    this._raw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  async closeSession(sessionId) {
    try { await this._request('session/close', { sessionId }); this.sessions.delete(sessionId) } catch (e) { this.log('acp-close-failed', { error: String(e?.message ?? e) }) }
  }

  stop() {
    try { if (this.child && this.child.exitCode === null) this.child.kill() } catch {}
    this.child = null
    this.ready = null
  }
}

/**
 * 这个错误是不是"本轮超时"（而不是"通道不可用"）？
 * 超时意味着 **ACP 那一轮还在跑**，调用方不该把它当失败去走兜底（会重复执行同一件事）。
 */
export function isAcpTimeout(err) {
  if (!err) return false
  if (err.code === 'ACP_TIMEOUT') return true
  return /ACP 超时|ACP_TIMEOUT/.test(String(err.message || ''))
}
