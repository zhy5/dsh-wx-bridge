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

function Panel() {
  const R = require('react')
  const [j, setJ] = R.useState(null)
  const [pair, setPair] = R.useState(null)
  const [err, setErr] = R.useState('')
  const [busy, setBusy] = R.useState('')
  const [note, setNote] = R.useState('')

  R.useEffect(() => {
    let alive = true
    const paint = async () => {
      try {
        const r = await fetch('/wxbridge/status', { cache: 'no-store' })
        const d = await r.json()
        if (alive) { setJ(d); setErr('') }
      } catch (e) { if (alive) setErr(String(e && e.message ? e.message : e)) }
    }
    paint()
    const t = setInterval(paint, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  R.useEffect(() => {
    let alive = true
    fetch('/wxbridge/pairing', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setPair(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const act = async (path) => {
    setBusy(path); setNote('')
    try {
      const r = await fetch('/wxbridge/' + path, { method: 'POST' })
      const d = await r.json()
      setNote(path + ' → ' + JSON.stringify(d))
      const s = await fetch('/wxbridge/status', { cache: 'no-store' })
      setJ(await s.json())
    } catch (e) { setNote(path + ' 失败：' + String(e && e.message ? e.message : e)) } finally { setBusy('') }
  }

  const b = (j && j.bridge) || {}
  const dot = b.pidOk ? (b.fresh ? '#2ecc71' : '#f1c40f') : '#e74c3c'
  const state = b.pidOk ? (b.fresh ? '运行中' : '心跳陈旧') : '未运行'
  const dim = { color: '#9aa4b8', fontSize: '12px', margin: '0 0 4px 0' }
  const btn = (label, path, primary) => R.createElement('button', {
    key: path, onClick: () => act(path), disabled: !!busy,
    style: {
      marginRight: '8px', padding: '5px 12px', borderRadius: '6px', cursor: busy ? 'default' : 'pointer',
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
      btn('启动', 'start', !b.pidOk), btn('停止', 'stop'), btn('重启', 'restart'), btn('体检', 'tick')),
    pair && pair.token ? R.createElement('div', { style: { marginBottom: '10px' } },
      R.createElement('p', { style: dim }, '在手机微信里给机器人发送下面这条，完成首台设备登记（token 只显示给本机）：'),
      R.createElement('pre', { style: { margin: '0 0 8px 0', padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '12px', overflow: 'auto' } },
        pair.token + ' /help')) : null,
    R.createElement('p', { style: dim }, '数据来自 /wxbridge/status（宿主半实时读桥的心跳与状态文件）。插件 v0.0.3'),
    note ? R.createElement('pre', { style: { margin: '8px 0 0 0', padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '11px', overflow: 'auto', maxHeight: '160px' } }, note) : null,
    R.createElement('pre', { style: { margin: '10px 0 0 0', padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,.12)', fontSize: '11px', overflow: 'auto', maxHeight: '200px' } }, JSON.stringify(j || {}, null, 1))
  )
}
