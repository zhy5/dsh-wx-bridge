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

/**
 * 原生控件的皮肤适配。
 * 坑（2026-09-21 用户实测）：暗色皮肤下原生 <select>/<input> 的**弹出层**会退回系统白底，
 * 而文字用 `color: inherit` 继承了皮肤的浅色 → 白底白字、看不到内容。
 * 对策：① 控件给**不透明**底色（弹出层无法合成半透明）；② 同步给 `color-scheme`，
 * Chromium 会据此渲染原生控件与弹出层；③ `option` 也逐项上色兜底。
 * 底色来源：皮肤根/body 的 color-scheme → body 背景亮度 → prefers-color-scheme，
 * 并把 body 背景提亮一点点，尽量贴合当前皮肤。
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
    control: { colorScheme: dark ? 'dark' : 'light', background: bg, color: fg, border: '1px solid rgba(127,127,127,.45)' },
    option: { background: bg, color: fg },
  }
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
  const [presetState, setPresetState] = R.useState(null)

  R.useEffect(() => {
    let alive = true
    const paint = async () => {
      try {
        const [sr, lr] = await Promise.all([
          fetch('/wxbridge/status', { cache: 'no-store' }),
          fetch('/wxbridge/log', { cache: 'no-store' }),
        ])
        const d = await sr.json()
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
      // 立刻回读，并连拍几次：桥的启动/停止有几百毫秒延迟，只读一次会看不到变化
      await readAll()
      setTimeout(readAll, 400)
      setTimeout(readAll, 1500)
      setTimeout(readAll, 3000)
    } catch (e) { setNote(path + ' 失败：' + String(e && e.message ? e.message : e)) } finally { setBusy('') }
  }

  const b = (j && j.bridge) || {}
  const stoppedBy = b.manualStop && b.manualStop.at
  const dot = b.pidOk ? (b.fresh ? '#2ecc71' : '#f1c40f') : (stoppedBy ? '#7f8c8d' : '#e74c3c')
  const state = b.pidOk
    ? (b.fresh ? '运行中' : '心跳陈旧')
    : (stoppedBy ? '已人工停止（自检不会自动拉起，点「启动」恢复）' : '未运行')
  const dim = { color: '#9aa4b8', fontSize: '12px', margin: '0 0 6px 0' }
  const btn = (label, path, primary, body) => R.createElement('button', {
    key: path, onClick: () => call(path, body), disabled: !!busy,
    style: {
      marginRight: '8px', marginBottom: '6px', padding: '5px 12px', borderRadius: '6px', cursor: busy ? 'default' : 'pointer',
      border: '1px solid rgba(127,127,127,.35)', background: primary ? 'rgba(64,140,255,.18)' : 'rgba(127,127,127,.12)',
      color: 'inherit', fontSize: '12px',
    },
  }, busy === path ? '…' : label)

  const rows = [
    ['桥状态', state + '（' + (b.phase || 'n/a') + '）'],
    ['进程', b.pid ? ('pid ' + b.pid + '｜心跳 ' + (b.ageSec === null ? 'n/a' : b.ageSec + 's 前')) : '无'],
    ['轮询', (b.polls === null || b.polls === undefined) ? 'n/a' : String(b.polls)],
    ['任务', (b.running || 0) + ' 运行中 ｜ ' + (b.tasks || 0) + ' 总计'],
    ['会话', (b.peers || 0) + ' 个' + (b.allowedUsers ? '｜已授权 ' + b.allowedUsers + ' 人' : '')],
    ['数据目录', b.dataDir || 'n/a'],
    ['默认工作区', b.cwd || 'n/a'],
  ]

  const pg = (pair && pair.pairing) || null
  const qrNode = pg && pg.active ? R.createElement('div', { style: { margin: '10px 0', padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,.08)' } },
    R.createElement('p', { style: { margin: '0 0 8px 0', fontSize: '13px' } }, '扫码配对：' + (STATUS_TEXT[pg.status] || pg.status || '…')),
    pg.qrDataUrl
      ? R.createElement('img', { src: pg.qrDataUrl, width: 220, height: 220, alt: '微信扫码配对', style: { display: 'block', background: '#fff', padding: '6px', borderRadius: '6px' } })
      : R.createElement('p', { style: dim }, '（本机 qrcode 渲染不可用，请用下面的备用链接）'),
    pg.qrContent ? R.createElement('p', { style: { ...dim, wordBreak: 'break-all' } }, '备用链接：' + pg.qrContent) : null,
    pg.status === 'need_verifycode' ? R.createElement('div', { style: { marginTop: '8px' } },
      R.createElement('input', {
        value: code, onChange: (e) => setCode(e.target.value), placeholder: '手机微信显示的数字配对码',
        style: { ...skin.control, padding: '4px 8px', borderRadius: '6px', marginRight: '8px', width: '180px' },
      }),
      R.createElement('button', {
        onClick: () => call('qr/verify', { code }),
        style: { padding: '5px 12px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)', background: 'rgba(127,127,127,.12)', color: 'inherit', fontSize: '12px' },
      }, '提交配对码')
    ) : null,
    pg.error ? R.createElement('p', { style: { ...dim, color: '#e67e22' } }, '提示：' + pg.error) : null,
    pg.status === 'confirmed' && pg.confirmed
      ? R.createElement('p', { style: dim }, '账号 ' + pg.confirmed.accountId + '｜用户 ' + pg.confirmed.userId +
          '｜凭据已写入 ' + pg.confirmed.credentialFile + '（重启桥后生效）')
      : null,
    R.createElement('div', { style: { marginTop: '8px' } }, btn('停止配对', 'qr/stop'))
  ) : null

  return R.createElement('div', { style: { padding: '14px' } },
    R.createElement('h3', { style: { margin: '0 0 10px 0' } }, '微信连接（wxbridge）'),
    R.createElement('p', { style: { margin: '0 0 10px 0', fontSize: '13px' } },
      R.createElement('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: dot, marginRight: '6px' } }),
      err ? ('宿主路由读取失败：' + err) : ('桥：' + state)),
    R.createElement('table', { style: { borderCollapse: 'collapse', fontSize: '12px', marginBottom: '10px' } },
      R.createElement('tbody', null, rows.map((r) => R.createElement('tr', { key: r[0] },
        R.createElement('td', { style: { padding: '2px 12px 2px 0', color: '#9aa4b8', verticalAlign: 'top' } }, r[0]),
        R.createElement('td', { style: { padding: '2px 0' } }, String(r[1]))
      )))),
    R.createElement('div', { style: { marginBottom: '10px' } },
      btn('启动', 'start', !b.pidOk), btn('停止', 'stop'), btn('重启', 'restart'), btn('体检', 'tick'),
      btn('扫码配对', 'qr/start', true), btn('归组未分组会话', 'scan')),
    qrNode,
    pair && pair.token ? R.createElement('div', { style: { marginBottom: '10px' } },
      R.createElement('p', { style: dim }, '备用登记方式（无法扫码时）：在手机微信里给机器人发送下面这条'),
      R.createElement('pre', { style: { margin: 0, padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '12px', overflow: 'auto' } }, pair.token + ' /help')) : null,
    R.createElement('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(127,127,127,.18)' } },
      R.createElement('p', { style: { margin: '0 0 4px 0', fontSize: '13px' } }, '手机通道预设（全局预设）'),
      R.createElement('p', { style: { ...dim, marginBottom: '6px' } },
        '手机上的对话按选定的预设运行：工具、提示词、技能都来自该预设。列表取自 DSH 的预设名册（你的 .agent-presets ＋ 运行时出厂预设）。'),
      R.createElement('select', {
        value: presetSel, onChange: (e) => setPresetSel(e.target.value),
        style: { ...skin.control, width: '100%', boxSizing: 'border-box', padding: '7px 8px', borderRadius: '6px', fontSize: '12px' },
      }, [R.createElement('option', { key: '__none', value: '', style: skin.option }, '（不指定 · 跟随 DSH 默认预设）')].concat(
        presets.map((pr) => R.createElement('option', { key: pr.id, value: pr.id, style: skin.option },
          pr.name + '（' + pr.id + '）' + (pr.description ? ' · ' + String(pr.description).slice(0, 28) : ''))),
      )),
      R.createElement('div', { style: { marginTop: '6px' } },
        R.createElement('button', {
          onClick: () => savePreset(presetSel), disabled: !!busy,
          style: { marginRight: '8px', padding: '5px 12px', borderRadius: '6px', cursor: busy ? 'default' : 'pointer',
                   border: '1px solid rgba(127,127,127,.35)', background: 'rgba(64,140,255,.18)', color: 'inherit', fontSize: '12px' },
        }, busy === 'preset' ? '…' : '保存预设'),
        R.createElement('a', {
          href: '#', onClick: (e) => { e.preventDefault(); loadPresets() },
          style: { marginRight: '8px', fontSize: '12px', color: '#7aa2f7' },
        }, '刷新列表'),
        R.createElement('span', { style: dim },
          presets.length ? ('当前：' + (presetSel || '默认') + '（' + presets.length + ' 个可选）') : '未读到预设名册')
      )
    ),
    note ? R.createElement('pre', { style: { margin: '8px 0 0 0', padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '11px', overflow: 'auto', maxHeight: '160px' } }, note) : null,
    R.createElement('div', { style: { marginTop: '12px' } },
      R.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '4px' } },
        R.createElement('span', { style: { fontSize: '12px', color: '#9aa4b8' } }, '操作日志（宿主半记录，最近 ' + log.length + ' 条）'),
        R.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); readAll() }, style: { marginLeft: '8px', fontSize: '12px', color: '#7aa2f7' } }, '刷新')),
      log.length === 0
        ? R.createElement('p', { style: dim }, '暂无记录——点一下上面的按钮试试。')
        : R.createElement('div', { style: { maxHeight: '200px', overflow: 'auto', border: '1px solid rgba(127,127,127,.18)', borderRadius: '6px' } },
            log.map((a, i) => R.createElement('div', { key: i, style: { display: 'flex', gap: '8px', padding: '4px 8px', fontSize: '11px', borderBottom: '1px solid rgba(127,127,127,.12)' } },
              R.createElement('span', { style: { color: '#9aa4b8', flex: '0 0 62px' } }, String(a.at || '').slice(11, 19)),
              R.createElement('span', { style: { color: a.ok ? '#2ecc71' : '#e74c3c', flex: '0 0 78px' } }, (a.ok ? '✓ ' : '✗ ') + String(a.action || '')),
              R.createElement('span', { style: { wordBreak: 'break-all' } }, String(a.detail || ''))
            ))
          )
    ),
    R.createElement('p', { style: { ...dim, marginTop: '10px' } },
      '插件 v0.0.16｜数据来自 /wxbridge/status（宿主半实时读桥的心跳与状态文件）',
      R.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); setShowRaw(!showRaw) }, style: { marginLeft: '8px', color: '#7aa2f7' } }, showRaw ? '收起原始 JSON' : '查看原始 JSON')),
    showRaw ? R.createElement('pre', { style: { margin: '8px 0 0 0', padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '11px', overflow: 'auto', maxHeight: '200px' } }, JSON.stringify(j || {}, null, 1)) : null
  )
}
