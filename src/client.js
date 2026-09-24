// DSH 客户端半：设置 → 微信连接（React 组件；factory 内可用 require）
export const name = 'wxbridge'
export const inject = ['slots', 'connection']

export function apply(ctx) {
  const slots = ctx && ctx.slots
  if (!slots || typeof slots.inject !== 'function') return
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'wxbridge', order: 31, label: '微信连接' },
    Panel
  ))
}

const STATUS_TEXT = {
  wait: '等待手机扫码…',
  scaned: '已扫码，正在确认…',
  need_verifycode: '需要手机微信上显示的数字配对码',
  scaned_but_redirect: '已扫码，正在切换网关…',
  binded_redirect: '该 ClawBot 已绑定（如本机没有凭据，请先在原绑定端解除）',
  expired: '二维码已过期，正在刷新…',
  confirmed: '✅ 配对成功',
}

/** 微信品牌绿（固定色，深浅皮肤下都成立）。 */
const WX = '#07C160'
const WX_DARK = '#06AD56'

/**
 * 原生控件的皮肤适配。
 * 坑（2026-09-21 用户实测）：暗色皮肤下原生 <select>/<input> 的**弹出层**会退回系统白底，
 * 而文字用 `color: inherit` 继承了皮肤的浅色 → 白底白字、看不到内容。
 * 对策：① 控件给**不透明**底色（弹出层无法合成半透明）；② 同步给 `color-scheme`；
 * ③ `option` 也逐项上色兜底。底色按当前皮肤推导（body 背景亮度 + 提亮）。
 */
function controlSkin() {
  let dark = true
  let base = null
  try {
    const root = document.documentElement
    const cs = String(getComputedStyle(root).colorScheme || '') + ' ' + String(getComputedStyle(document.body).colorScheme || '')
    const m = String(getComputedStyle(document.body).backgroundColor || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
      dark = (r * 0.299 + g * 0.587 + b * 0.114) < 128
      base = [r, g, b]
    }
    if (/dark/i.test(cs) && !/light/i.test(cs)) dark = true
    else if (/light/i.test(cs) && !/dark/i.test(cs)) dark = false
    else if (base === null && window.matchMedia) dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {}
  const lift = (v, d) => Math.max(0, Math.min(255, v + d))
  const bg = base
    ? 'rgb(' + (dark ? base.map((v) => lift(v, 16)).join(',') : '255,255,255') + ')'
    : (dark ? '#2b3040' : '#ffffff')
  const fg = dark ? '#e8eaf1' : '#1b1f27'
  return {
    dark,
    control: { colorScheme: dark ? 'dark' : 'light', background: bg, color: fg, border: '1px solid rgba(127,127,127,.45)' },
    option: { background: bg, color: fg },
    card: { background: dark ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.028)', border: '1px solid ' + (dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)') },
  }
}

/**
 * 微信风格图标：两只叠在一起的聊天气泡（大泡带 3 点、小泡带 2 点）。
 * 纯 SVG 画，不依赖任何外部资源；`sep` 是两泡之间的分隔描边色（取所在卡片底色）。
 */
function wxBubbles(size, fill, dot, sep) {
  const R = require('react')
  const s = (n) => String(n)
  return R.createElement('svg', { width: size, height: size, viewBox: '0 0 64 64', style: { display: 'block' } },
    R.createElement('ellipse', { cx: 26, cy: 27, rx: 20, ry: 17, fill }),
    R.createElement('circle', { cx: 19, cy: 25, r: 2.4, fill: dot }),
    R.createElement('circle', { cx: 26, cy: 25, r: 2.4, fill: dot }),
    R.createElement('circle', { cx: 33, cy: 25, r: 2.4, fill: dot }),
    R.createElement('ellipse', { cx: 45, cy: 42, rx: 15, ry: 13, fill, stroke: sep || 'transparent', strokeWidth: s(3) }),
    R.createElement('circle', { cx: 40, cy: 41, r: 1.9, fill: dot }),
    R.createElement('circle', { cx: 50, cy: 41, r: 1.9, fill: dot }),
  )
}

/** 注入一次样式（keyframes / hover 这些内联样式表达不了）。 */
function useWxStyle() {
  const R = require('react')
  R.useEffect(() => {
    try {
      if (document.getElementById('wxbridge-style')) return
      const el = document.createElement('style')
      el.id = 'wxbridge-style'
      el.textContent = [
        '@keyframes wx-pulse{0%{box-shadow:0 0 0 0 rgba(7,193,96,.55)}70%{box-shadow:0 0 0 7px rgba(7,193,96,0)}100%{box-shadow:0 0 0 0 rgba(7,193,96,0)}}',
        '.wxbridge-card{transition:transform .12s ease}',
        '.wxbridge-btn{transition:background .15s ease,border-color .15s ease,transform .1s ease}',
        '.wxbridge-btn:hover{filter:brightness(1.08)}',
        '.wxbridge-btn:active{transform:translateY(1px)}',
        '.wxbridge-bubble{position:relative}',
        '.wxbridge-bubble:after{content:"";position:absolute;left:-5px;top:12px;width:0;height:0;border:6px solid transparent;border-right-color:currentColor;opacity:.001}',
        '.wxbridge-logrow:hover{background:rgba(127,127,127,.08)}',
      ].join('')
      document.head.appendChild(el)
    } catch {}
  }, [])
}

function Panel() {
  const R = require('react')
  const [j, setJ] = R.useState(null)
  const [pair, setPair] = R.useState(null)
  const [err, setErr] = R.useState('')
  const [busy, setBusy] = R.useState('')
  const [note, setNote] = R.useState('')
  const [code, setCode] = R.useState('')
  const [log, setLog] = R.useState([])
  const [showRaw, setShowRaw] = R.useState(false)
  const skin = controlSkin()
  const [presets, setPresets] = R.useState([])
  const [presetSel, setPresetSel] = R.useState('')
  const [allowlist, setAllowlist] = R.useState('strict')
  const [presetState, setPresetState] = R.useState(null)
  useWxStyle()

  R.useEffect(() => {
    let alive = true
    const paint = async () => {
      try {
        const [sr, lr] = await Promise.all([
          fetch('/wxbridge/status', { cache: 'no-store' }),
          fetch('/wxbridge/log', { cache: 'no-store' }),
        ])
        const d = await sr.json()
        if (d && typeof d.allowlist === 'string') setAllowlist(d.allowlist)
        const lg = await lr.json()
        if (!alive) return
        setJ(d); setErr(''); setLog(lg.actions || [])
      } catch (e) { if (alive) setErr(String(e && e.message ? e.message : e)) }
    }
    paint()
    const t = setInterval(paint, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  R.useEffect(() => {
    let alive = true
    fetch('/wxbridge/info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setPair(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const loadPresets = () => fetch('/wxbridge/presets', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => { setPresetState(d); setPresets(d.presets || []); setPresetSel(typeof d.selected === 'string' ? d.selected : '') })
    .catch(() => {})

  R.useEffect(() => { let alive = true; loadPresets().then(() => {}); return () => { alive = false } }, [])

  const saveAllowlist = async (mode) => {
    setBusy('allowlist')
    try {
      const r = await fetch('/wxbridge/allowlist', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, restart: true }),
      })
      const d = await r.json()
      if (typeof d.allowlist === 'string') setAllowlist(d.allowlist)
      setNote(d.ok
        ? ('准入模式已切到 ' + mode + '：' + (d.note || ''))
        : ('切换失败：' + (d.error || '未知错误')))
    } catch (e) { setNote('切换失败：' + String(e && e.message ? e.message : e)) } finally { setBusy('') }
  }

  const savePreset = async (want) => {
    setBusy('preset')
    try {
      const r = await fetch('/wxbridge/preset', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset: want }),
      })
      const d = await r.json()
      setPresetSel(typeof d.preset === 'string' ? d.preset : '')
      setNote('已保存手机通道预设：' + (d.preset ? d.preset : '（不指定 · 跟随 DSH 默认预设）') + ' —— 下一条微信任务即生效')
    } catch (e) { setNote('保存失败：' + String(e && e.message ? e.message : e)) } finally { setBusy('') }
  }

  const pairingActive = !!(pair && pair.pairing && pair.pairing.active)
  const pairingStatus = (pair && pair.pairing && pair.pairing.status) || ''

  R.useEffect(() => {
    if (!pairingActive || pairingStatus === 'confirmed') return
    let alive = true
    const t = setInterval(async () => {
      try {
        const r = await fetch('/wxbridge/qr/status', { cache: 'no-store' })
        const d = await r.json()
        if (alive && d && d.pairing) setPair((p) => ({ ...(p || {}), pairing: d.pairing }))
      } catch {}
    }, 2500)
    return () => { alive = false; clearInterval(t) }
  }, [pairingActive, pairingStatus])

  const readAll = async () => {
    try {
      const [sr, lr] = await Promise.all([
        fetch('/wxbridge/status', { cache: 'no-store' }),
        fetch('/wxbridge/log', { cache: 'no-store' }),
      ])
      setJ(await sr.json())
      const lg = await lr.json()
      setLog(lg.actions || [])
    } catch {}
  }

  const call = async (path, body) => {
    setBusy(path); setNote('')
    try {
      const t0 = Date.now()
      const r = await fetch('/wxbridge/' + path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await r.json()
      if (d.pairing) setPair((p) => ({ ...(p || {}), pairing: d.pairing }))
      setNote(path + ' → ' + JSON.stringify(d) + '（' + (Date.now() - t0) + 'ms）')
      if (d.pid && d.pid > 0 && (path === 'start' || path === 'restart')) {
        // 启动后回读桥自己的输出：起不来时面板要能直接看到原因（以前 stdio 被丢弃，只剩一个 pid）
        setTimeout(async () => {
          try {
            const lr = await fetch('/wxbridge/bridge-log?lines=25', { cache: 'no-store' })
            const ld = await lr.json()
            setNote((n) => n + '\n--- 桥的启动输出 ---\n' + String(ld.log || '').slice(-1200))
          } catch {}
        }, 1500)
      }
      // 立刻回读，并连拍几次：桥的启动/停止有几百毫秒延迟，只读一次会看不到变化
      await readAll()
      setTimeout(readAll, 400)
      setTimeout(readAll, 1500)
      setTimeout(readAll, 3000)
    } catch (e) { setNote(path + ' 失败：' + String(e && e.message ? e.message : e)) } finally { setBusy('') }
  }

  const b = (j && j.bridge) || {}
  const stoppedBy = b.manualStop && b.manualStop.at
  const tone = b.pidOk ? (b.fresh ? 'ok' : 'warn') : (stoppedBy ? 'off' : 'bad')
  const TONE = { ok: WX, warn: '#f1c40f', off: '#7f8c8d', bad: '#e74c3c' }
  const dot = TONE[tone]
  const state = b.pidOk
    ? (b.fresh ? '运行中' : '心跳陈旧')
    : (stoppedBy ? '已人工停止' : '未运行')
  const stateHint = b.pidOk ? (b.fresh ? '桥在正常轮询微信消息' : '桥在跑，但心跳已过期') : (stoppedBy ? '自检不会自动拉起，点「启动」恢复' : '点「启动」把桥拉起来')

  const dim = { color: skin.dark ? '#9aa4b8' : '#6b7280', fontSize: '12px', margin: '0 0 6px 0' }
  const subtle = '1px solid ' + (skin.dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)')
  const mutedBg = skin.dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.03)'

  /** 按钮：primary=微信绿实底；danger=红；默认=描边。 */
  const btn = (label, path, primary, body, kind) => R.createElement('button', {
    className: 'wxbridge-btn', key: path, onClick: () => call(path, body), disabled: !!busy,
    style: {
      marginRight: '8px', marginBottom: '6px', padding: '6px 14px', borderRadius: '999px', cursor: busy ? 'default' : 'pointer',
      fontSize: '12px', fontWeight: 500, lineHeight: 1.3,
      border: kind === 'danger' ? '1px solid rgba(231,76,60,.5)' : (primary ? '1px solid ' + WX : subtle),
      background: kind === 'danger' ? 'rgba(231,76,60,.14)' : (primary ? WX : mutedBg),
      color: kind === 'danger' ? (skin.dark ? '#ff9d92' : '#c0392b') : (primary ? '#fff' : 'inherit'),
      opacity: busy && busy !== path ? 0.6 : 1,
    },
  }, busy === path ? '处理中…' : label)

  /** 小统计卡。 */
  const stat = (label, value, icon) => R.createElement('div', {
    key: label,
    style: { flex: '1 1 92px', minWidth: '92px', padding: '8px 10px', borderRadius: '10px', background: mutedBg, border: subtle },
  },
    R.createElement('div', { style: { fontSize: '11px', color: dim.color, marginBottom: '2px' } }, icon + ' ' + label),
    R.createElement('div', { style: { fontSize: '15px', fontWeight: 600, letterSpacing: '.2px' } }, String(value)),
  )

  const rows = [
    ['桥状态', state + '（' + (b.phase || 'n/a') + '）'],
    ['进程', b.pid ? ('pid ' + b.pid + '｜心跳 ' + (b.ageSec === null ? 'n/a' : b.ageSec + 's 前')) : '无'],
    // 字段缺失 ≠ 解析失败：升级了包但还没重启宿主时，宿主半仍是旧版、不上报这个字段。
    ['运行时入口', b.runtimeBin === undefined
      ? '—（宿主半未上报；重启宿主后显示）'
      : (b.runtimeBin
        ? (b.runtimeBin + (b.runtimeBinOk ? '' : '（⚠️ 文件不存在）'))
        : '⚠️ 未解析（手机对话会失败，请设置 dshBin）')],
    ['数据目录', b.dataDir || 'n/a'],
    ['默认工作区', b.cwd || 'n/a'],
  ]

  const pg = (pair && pair.pairing) || null
  const qrNode = pg && pg.active ? R.createElement('div', {
    style: { margin: '10px 0', borderRadius: '12px', overflow: 'hidden', border: subtle },
  },
    R.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: WX, color: '#fff', fontSize: '12px', fontWeight: 500 } },
      wxBubbles(18, '#fff', WX, WX),
      R.createElement('span', null, '扫码配对 · ' + (STATUS_TEXT[pg.status] || pg.status || '…'))),
    R.createElement('div', { style: { padding: '12px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start' } },
      pg.qrDataUrl
        ? R.createElement('div', {
            style: { padding: '8px', background: '#fff', borderRadius: '10px', boxShadow: '0 2px 10px rgba(0,0,0,.18)', border: '3px solid ' + WX },
          }, R.createElement('img', { src: pg.qrDataUrl, width: 196, height: 196, alt: '微信扫码配对', style: { display: 'block' } }))
        : R.createElement('p', { style: dim }, '（本机 qrcode 渲染不可用，请用下面的备用链接）'),
      R.createElement('div', { style: { flex: '1 1 180px', minWidth: '180px' } },
        R.createElement('p', { style: { margin: '0 0 6px 0', fontSize: '12px' } }, '用手机「微信 → 扫一扫」扫描左侧二维码'),
        pg.qrContent ? R.createElement('p', { style: { ...dim, wordBreak: 'break-all' } }, '备用链接：' + pg.qrContent) : null,
        pg.status === 'need_verifycode' ? R.createElement('div', { style: { marginTop: '8px' } },
          R.createElement('input', {
            value: code, onChange: (e) => setCode(e.target.value), placeholder: '手机微信显示的数字配对码',
            style: { ...skin.control, padding: '5px 10px', borderRadius: '8px', marginRight: '8px', width: '160px', fontSize: '12px' },
          }),
          R.createElement('button', {
            className: 'wxbridge-btn', onClick: () => call('qr/verify', { code }),
            style: { padding: '6px 12px', borderRadius: '999px', border: '1px solid ' + WX, background: WX, color: '#fff', fontSize: '12px', cursor: 'pointer' },
          }, '提交配对码')
        ) : null,
        pg.error ? R.createElement('p', { style: { ...dim, color: '#e67e22' } }, '提示：' + pg.error) : null,
        pg.status === 'confirmed' && pg.confirmed
          ? R.createElement('p', { style: dim }, '账号 ' + pg.confirmed.accountId + '｜用户 ' + pg.confirmed.userId +
              '｜凭据已写入 ' + pg.confirmed.credentialFile + '（重启桥后生效）')
          : null,
        R.createElement('div', { style: { marginTop: '10px' } }, btn('停止配对', 'qr/stop'))
      )
    )
  ) : null

  return R.createElement('div', { style: { padding: '0 0 6px 0' } },
    // ── 头卡：微信绿 + 气泡 logo + 状态胶囊 ──────────────────────────
    R.createElement('div', {
      style: {
        borderRadius: '14px', overflow: 'hidden', marginBottom: '12px',
        background: 'linear-gradient(135deg,' + WX + ' 0%,#0aa86a 58%,#0b8f63 100%)',
        boxShadow: '0 6px 18px rgba(7,193,96,.22)',
      },
    },
      R.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' } },
        R.createElement('div', {
          style: { width: '42px', height: '42px', borderRadius: '12px', background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 42px' },
        }, wxBubbles(30, '#fff', WX, WX)),
        R.createElement('div', { style: { flex: 1, minWidth: 0 } },
          R.createElement('div', { style: { color: '#fff', fontSize: '16px', fontWeight: 600, letterSpacing: '.3px' } }, '微信连接'),
          R.createElement('div', { style: { color: 'rgba(255,255,255,.85)', fontSize: '12px', marginTop: '2px' } },
            '手机微信 ↔ 本机 DSH · wxbridge')),
        R.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '5px 12px', borderRadius: '999px', background: 'rgba(255,255,255,.16)', color: '#fff', fontSize: '12px', flex: '0 0 auto' },
        },
          R.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: dot, boxShadow: '0 0 0 0 rgba(255,255,255,.5)', animation: tone === 'ok' ? 'wx-pulse 2s infinite' : 'none' } }),
          state)
      ),
      R.createElement('div', { style: { padding: '0 16px 12px 16px', color: 'rgba(255,255,255,.82)', fontSize: '12px' } },
        err ? ('宿主路由读取失败：' + err) : stateHint)
    ),

    // ── 数据卡 ──────────────────────────────────────────────────────
    R.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
      stat('轮询', (b.polls === null || b.polls === undefined) ? 'n/a' : b.polls, '📡'),
      stat('会话', (b.peers || 0) + (b.allowedUsers ? ' / ' + b.allowedUsers + ' 人' : ''), '👥'),
      stat('任务', (b.running || 0) + ' / ' + (b.tasks || 0), '🧩'),
      stat('心跳', b.ageSec === null || b.ageSec === undefined ? 'n/a' : b.ageSec + 's', '💚'),
    ),

    // ── 明细表 ─────────────────────────────────────────────────────
    R.createElement('div', { style: { ...skin.card, borderRadius: '12px', padding: '10px 12px', marginBottom: '10px' } },
      R.createElement('table', { style: { borderCollapse: 'collapse', fontSize: '12px', width: '100%' } },
        R.createElement('tbody', null, rows.map((r) => R.createElement('tr', { key: r[0] },
          R.createElement('td', { style: { padding: '3px 12px 3px 0', color: dim.color, verticalAlign: 'top', whiteSpace: 'nowrap' } }, r[0]),
          R.createElement('td', { style: { padding: '3px 0', wordBreak: 'break-all' } }, String(r[1]))
        )))) ),

    // ── 操作按钮 ────────────────────────────────────────────────────
    R.createElement('div', { style: { marginBottom: '8px' } },
      btn('启动', 'start', !b.pidOk), btn('停止', 'stop', false, null, 'danger'), btn('重启', 'restart'),
      btn('体检', 'tick'), btn('扫码配对', 'qr/start', true), btn('归组未分组会话', 'scan')),
    R.createElement('p', { style: { ...dim, margin: '0 0 10px 0' } },
      '提示：手机微信里发文本派活；也可以直接发图片 / 文件（Excel、Word、PDF…）——我先存到本机，再告诉我要做什么。发 /help 看指令（/预设、/model、/sessions、/new、/ws、/status、/task、/files、/cancel）。'),

    qrNode,

    // ── 备用登记：微信气泡样式 ───────────────────────────────────────
    pair && pair.token ? R.createElement('div', { style: { marginBottom: '12px' } },
      R.createElement('p', { style: dim }, '备用登记方式（无法扫码时）：在手机微信里给机器人发送下面这条'),
      R.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
        R.createElement('div', {
          style: {
            maxWidth: '86%', padding: '9px 12px', borderRadius: '12px 12px 4px 12px', background: WX, color: '#fff',
            fontSize: '12px', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', wordBreak: 'break-all',
            boxShadow: '0 2px 8px rgba(7,193,96,.22)',
          },
        }, pair.token + ' /help'))
    ) : null,

    // ── 通道预设 ───────────────────────────────────────────────────
    R.createElement('div', { style: { ...skin.card, borderRadius: '12px', padding: '12px', marginTop: '4px' } },
      R.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' } },
        wxBubbles(16, WX, skin.dark ? '#0d1220' : '#ffffff', 'transparent'),
        R.createElement('span', { style: { fontSize: '13px', fontWeight: 600 } }, '手机通道预设'),
        R.createElement('span', { style: { fontSize: '11px', color: dim.color } }, '（决定手机那条通道用哪套工具 / 提示词 / 技能）')),
      R.createElement('select', {
        value: presetSel, onChange: (e) => setPresetSel(e.target.value),
        style: { ...skin.control, width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', fontSize: '12px' },
      }, [R.createElement('option', { key: '__none', value: '', style: skin.option }, '（不指定 · 跟随 DSH 默认预设）')].concat(
        presets.map((pr) => R.createElement('option', { key: pr.id, value: pr.id, style: skin.option },
          pr.name + '（' + pr.id + '）' + (pr.description ? ' · ' + String(pr.description).slice(0, 28) : ''))),
      )),
      R.createElement('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center' } },
        R.createElement('button', {
          className: 'wxbridge-btn', onClick: () => savePreset(presetSel), disabled: !!busy,
          style: {
            marginRight: '10px', padding: '6px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 500,
            cursor: busy ? 'default' : 'pointer', border: '1px solid ' + WX, background: WX, color: '#fff',
          },
        }, busy === 'preset' ? '处理中…' : '保存预设'),
        R.createElement('a', {
          href: '#', onClick: (e) => { e.preventDefault(); loadPresets() },
          style: { marginRight: '10px', fontSize: '12px', color: WX, textDecoration: 'none' },
        }, '刷新列表'),
        R.createElement('span', { style: dim },
          presets.length ? ('当前：' + (presetSel || '默认') + '（' + presets.length + ' 个可选）') : '未读到预设名册')
      )
    ),

    R.createElement('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: subtle } },
      R.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
        wxBubbles(16, WX, skin.dark ? '#0d1220' : '#ffffff', 'transparent'),
        R.createElement('span', { style: { fontSize: '13px', fontWeight: 600 } }, '准入模式'),
        R.createElement('span', { style: { fontSize: '11px', color: dim.color } }, '（决定谁能驱动这台机器）')),
      R.createElement('select', {
        value: allowlist, onChange: (e) => setAllowlist(e.target.value),
        style: { ...skin.control, width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', fontSize: '12px' },
      }, [
        R.createElement('option', { key: 'strict', value: 'strict', style: skin.option }, 'strict（默认）· 只服务已登记的设备；未登记不执行，只回一次提示'),
        R.createElement('option', { key: 'auto', value: 'auto', style: skin.option }, 'auto · 任何能给机器人发消息的人首次发言即登记（机器人别被拉进群/加好友）'),
        R.createElement('option', { key: 'open', value: 'open', style: skin.option }, 'open · 不做任何检查（强烈不建议）'),
      ]),
      R.createElement('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center' } },
        R.createElement('button', {
          className: 'wxbridge-btn', onClick: () => saveAllowlist(allowlist), disabled: !!busy,
          style: {
            marginRight: '10px', padding: '6px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 500,
            cursor: busy ? 'default' : 'pointer', border: '1px solid ' + WX, background: WX, color: '#fff',
          },
        }, busy === 'allowlist' ? '处理中…' : '保存并重启桥'),
        R.createElement('span', { style: dim }, '当前：' + allowlist + '（改完会写入 config.json 并重启桥，立即生效）')),
    ),

    note ? R.createElement('pre', { style: { margin: '10px 0 0 0', padding: '9px 11px', borderRadius: '10px', background: mutedBg, border: subtle, fontSize: '11px', overflow: 'auto', maxHeight: '160px' } }, note) : null,

    // ── 操作日志 ───────────────────────────────────────────────────
    R.createElement('div', { style: { marginTop: '12px' } },
      R.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
        R.createElement('span', { style: { fontSize: '12px', color: dim.color } }, '操作日志（宿主半记录，最近 ' + log.length + ' 条）'),
        R.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); readAll() }, style: { marginLeft: '8px', fontSize: '12px', color: WX, textDecoration: 'none' } }, '刷新')),
      log.length === 0
        ? R.createElement('p', { style: dim }, '暂无记录——点一下上面的按钮试试。')
        : R.createElement('div', { style: { maxHeight: '200px', overflow: 'auto', border: subtle, borderRadius: '10px' } },
            log.map((a, i) => R.createElement('div', {
              key: i, className: 'wxbridge-logrow',
              style: { display: 'flex', gap: '8px', padding: '5px 9px', fontSize: '11px', borderBottom: i === log.length - 1 ? 'none' : subtle, alignItems: 'baseline' },
            },
              R.createElement('span', { style: { color: dim.color, flex: '0 0 58px', fontVariantNumeric: 'tabular-nums' } }, String(a.at || '').slice(11, 19)),
              R.createElement('span', { style: { color: a.ok ? WX : '#e74c3c', flex: '0 0 84px' } }, (a.ok ? '● ' : '● ') + String(a.action || '')),
              R.createElement('span', { style: { wordBreak: 'break-all', opacity: .9 } }, String(a.detail || ''))
            ))
          )
    ),

    R.createElement('p', { style: { ...dim, marginTop: '10px' } },
      '插件 v' + ((j && j.version) || '?') + '｜数据来自 /wxbridge/status（宿主半实时读桥的心跳与状态文件）',
      R.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); setShowRaw(!showRaw) }, style: { marginLeft: '8px', color: WX, textDecoration: 'none' } }, showRaw ? '收起原始 JSON' : '查看原始 JSON')),
    showRaw ? R.createElement('pre', { style: { margin: '8px 0 0 0', padding: '10px', borderRadius: '10px', background: mutedBg, fontSize: '11px', overflow: 'auto', maxHeight: '200px' } }, JSON.stringify(j || {}, null, 1)) : null
  )
}
