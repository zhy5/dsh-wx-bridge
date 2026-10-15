// Unit test: wxbridge host-side computeAutoUnarchive (pure function) + optional real-data simulation.
// 模块定位：默认按仓库布局 import ../lib/index.js；可用环境变量 WXBRIDGE_MODULE 覆盖（指向任意已构建的宿主半路径）。
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modPath = process.env.WXBRIDGE_MODULE
  ? pathToFileURL(resolve(process.env.WXBRIDGE_MODULE)).href
  : new URL('../lib/index.js', import.meta.url).href
const mod = await import(modPath)
const { computeAutoUnarchive } = mod
if (typeof computeAutoUnarchive !== 'function') throw new Error('computeAutoUnarchive 未导出')

const PHONE = 'D:\\Work\\dshProject\\wx-bridge'
const ws = (path, sessionIds) => ({ id: 'ws-' + path, path, sessionIds })
let n = 0
const check = (name, got, want) => {
  n++
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) { console.error(`FAIL ${name}: got ${g}, want ${w}`); process.exitCode = 1 }
  else console.log(`ok ${n} ${name}`)
}

// 1. 基本命中：手机工作区里已归档且非 live 的会话 → 解档
check('basic',
  computeAutoUnarchive([ws(PHONE, ['session-a', 'session-b'])], PHONE, ['session-b'], []),
  ['session-b'])

// 2. 工作区 path 不匹配（其它工作区一律不动）
check('other-workspace-untouched',
  computeAutoUnarchive([ws('D:\\Work\\other', ['session-a'])], PHONE, ['session-a'], []),
  [])

// 3. phoneCwd 为空 / 参数全空 → 不做任何事
check('empty-phone-cwd',
  computeAutoUnarchive([ws(PHONE, ['session-a'])], '', ['session-a'], []),
  [])
check('null-args',
  computeAutoUnarchive(null, null, null, null),
  [])

// 4. archived ∩ live → 排除（GUI 正在用 / 用户有意归档的当前会话不拉回）
check('live-excluded',
  computeAutoUnarchive([ws(PHONE, ['session-a', 'session-b'])], PHONE, ['session-a', 'session-b'], ['session-a']),
  ['session-b'])

// 5. 无归档 → 空
check('nothing-archived',
  computeAutoUnarchive([ws(PHONE, ['session-a'])], PHONE, [], []),
  [])

// 6. 多工作区：只解手机工作区，其它工作区的归档会话不受影响
check('multi-workspace',
  computeAutoUnarchive(
    [ws('D:\\Work\\other', ['session-x']), ws(PHONE, ['session-y', 'session-z'])],
    PHONE, ['session-x', 'session-y'], []),
  ['session-y'])

// 7. 路径大小写 / 尾部分隔符不敏感（Windows；分隔符风格须一致——与插件 /attach、scan 的 norm 行为相同）
check('path-normalization',
  computeAutoUnarchive([ws('d:\\WORK\\DSHProject\\WX-BRIDGE\\', ['session-a'])], 'D:\\work\\dshproject\\wx-bridge', ['session-a'], []),
  ['session-a'])
// 7b. 分隔符风格不一致时不做解档（保守 no-op，不回归）
check('separator-style-mismatch-noop',
  computeAutoUnarchive([ws('d:/work/dshproject/wx-bridge/', ['session-a'])], 'D:\\work\\dshproject\\wx-bridge', ['session-a'], []),
  [])

// 8. 去重 + 跳过空 id
check('dedupe-and-empty-ids',
  computeAutoUnarchive([ws(PHONE, ['session-a', '', 'session-a', null])], PHONE, ['session-a', ''], []),
  ['session-a'])

// 9. sessionIds 缺失的工作区
check('no-session-ids',
  computeAutoUnarchive([{ id: 'w', path: PHONE }], PHONE, ['session-a'], []),
  [])

// ── 10. 真实数据仿真（只读，可选）：本地有 DSH 数据（workspace.json + wxbridge/config.json）时，
// 用真实存储复算「重启后首次 autoGroup 会解档哪些」，并与独立复算（交集）比对；CI/无数据环境自动跳过。
// live 集合可用 WXBRIDGE_LIVE_IDS（逗号分隔）注入，默认空。
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const wsJson = join(dshHome, 'storages', 'workspace.json')
const cfgJson = join(dshHome, 'wxbridge', 'config.json')
if (!existsSync(wsJson) || !existsSync(cfgJson)) {
  console.log('SKIP real-data-simulation（本机无 DSH 数据，CI 预期行为）')
} else {
  const store = JSON.parse(readFileSync(wsJson, 'utf8'))
  const realWorkspaces = Object.values(store.tables && store.tables.workspaces || {}).map((w) => ({ id: w.path, path: w.path, sessionIds: w.sessionIds || [] }))
  const realArchived = ((store.global && store.global.archivedSessionIds) || []).map(String)
  const realCfg = JSON.parse(readFileSync(cfgJson, 'utf8'))
  const realPhoneCwd = String(realCfg.cwd || '')
  const liveIds = (process.env.WXBRIDGE_LIVE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const norm = (v) => String(v || '').replace(/[/\\]+$/, '').toLowerCase()
  const phoneWs = realWorkspaces.find((w) => norm(w.path) === norm(realPhoneCwd))
  const realResult = computeAutoUnarchive(realWorkspaces, realPhoneCwd, realArchived, liveIds)
  const phoneSet = new Set(phoneWs ? phoneWs.sessionIds.map(String) : [])
  const archSet = new Set(realArchived)
  const liveSet = new Set(liveIds)
  const expected = [...phoneSet].filter((id) => archSet.has(id) && !liveSet.has(id))
  check('real-data-simulation', realResult, expected)
  console.log('--- real-data summary ---')
  console.log('phoneCwd =', realPhoneCwd, '| 归档集大小 =', realArchived.length, '| 将解档 =', realResult.join(', ') || '(无)')
}
if (process.exitCode === 1) console.log('SOME ASSERTIONS FAILED')
else console.log('ALL ASSERTIONS PASSED (' + n + ')')
