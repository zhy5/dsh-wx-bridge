// Unit test: runAutoUnarchive（自动解档执行器，含诊断返回）+ 可选真实数据仿真。
// 模块定位：默认按仓库布局 import ../lib/index.js；可用 WXBRIDGE_MODULE 覆盖。
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modPath = process.env.WXBRIDGE_MODULE
  ? pathToFileURL(resolve(process.env.WXBRIDGE_MODULE)).href
  : new URL('../lib/index.js', import.meta.url).href
const mod = await import(modPath)
const { runAutoUnarchive } = mod
if (typeof runAutoUnarchive !== 'function') throw new Error('runAutoUnarchive 未导出')

let pass = 0
const ok = (name, cond) => { if (!cond) { console.error('FAIL ' + name); process.exit(1) } pass++; console.log('ok ' + name) }

// mock reg（archived 可为数组或 Set，直接以普通属性提供）
const mkReg = ({ workspaces = [], archived = [], withUnarchive = true, listImpl } = {}) => {
  const calls = []
  const reg = {
    list: listImpl || (() => Promise.resolve(workspaces)),
    archivedSessionIds: archived,
  }
  if (withUnarchive) reg.unarchiveSession = async (id) => { calls.push(id) }
  reg._calls = calls
  return reg
}

const WS = [{ path: 'D:\\Work\\dshProject\\wx-bridge', sessionIds: ['A', 'B', 'C'] }]
const PHONE_CWD = 'D:\\Work\\dshProject\\wx-bridge'

// 1. happy path：归档∩工作区∩非live → 全部解档
{
  const reg = mkReg({ workspaces: WS, archived: ['A', 'X'] })
  const r = await runAutoUnarchive(reg, PHONE_CWD, ['C'])
  ok('happy: unarchived 1', r.ok === true && r.unarchived === 1 && r.candidates.length === 1 && r.candidates[0] === 'A')
  ok('happy: calls', reg._calls.length === 1 && reg._calls[0] === 'A')
  ok('happy: wsFound/archived', r.wsFound === true && r.archived === 2)
}

// 2. 无候选（都没归档）→ ok, 不调 unarchive
{
  const reg = mkReg({ workspaces: WS, archived: ['Z'] })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('no-candidates', r.ok === true && r.candidates.length === 0 && reg._calls.length === 0 && r.error === '')
}

// 3. registry 缺 unarchiveSession → 明确 error（此前静默失败的场景）
{
  const reg = mkReg({ workspaces: WS, archived: ['A'], withUnarchive: false })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('missing-method error', r.unarchived === 0 && r.error.includes('unarchiveSession') && r.candidates.length === 1)
}

// 4. archivedSessionIds 是 Set → 兼容
{
  const reg = mkReg({ workspaces: WS, archived: new Set(['A']), withUnarchive: true })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('set-archived', r.unarchived === 1 && r.archived === 1)
}

// 5. 工作区 path 未命中
{
  const reg = mkReg({ workspaces: [{ path: 'D:\\Other\\ws', sessionIds: ['A'] }], archived: ['A'] })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('no-workspace-match', r.wsFound === false && r.ok === true && r.unarchived === 0)
}

// 6. 路径归一：尾分隔符 + 大小写
{
  const reg = mkReg({ workspaces: [{ path: 'd:\\work\\dshproject\\wx-bridge\\', sessionIds: ['A'] }], archived: ['A'] })
  const r = await runAutoUnarchive(reg, PHONE_CWD + '\\', [])
  ok('path-normalized', r.wsFound === true && r.unarchived === 1)
}

// 7. unarchive 抛错 → 折进 errors，不中断
{
  const reg = mkReg({ workspaces: WS, archived: ['A', 'B'], withUnarchive: true })
  reg.unarchiveSession = async (id) => { if (id === 'A') throw new Error('boom-A'); reg._calls.push(id) }
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('partial-error', r.unarchived === 1 && r.errors.length === 1 && r.errors[0].includes('boom-A') && r.ok === false)
}

// 8. list 为同步数组（非 Promise）→ 兼容
{
  const reg = mkReg({ workspaces: WS, archived: ['A'], listImpl: () => WS })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('sync-list', r.unarchived === 1)
}

// 9. list 返回 {items} 包装 → 兼容
{
  const reg = mkReg({ workspaces: WS, archived: ['A'], listImpl: async () => ({ items: WS }) })
  const r = await runAutoUnarchive(reg, PHONE_CWD, [])
  ok('items-wrapped', r.unarchived === 1)
}

// 10. reg 缺失 → error，不抛
{
  const r = await runAutoUnarchive(null, PHONE_CWD, [])
  ok('null-reg', r.ok === false && r.error.length > 0)
}

// 11. live 全含 → 不拉回
{
  const reg = mkReg({ workspaces: WS, archived: ['A', 'B'] })
  const r = await runAutoUnarchive(reg, PHONE_CWD, ['A', 'B'])
  ok('live-excluded', r.candidates.length === 0 && r.ok === true && reg._calls.length === 0)
}

// 12. 真实数据仿真（只读，可选）：本机有 DSH 数据时，用真实 workspace.json + wxbridge/config.json 复算候选集，
// 与独立复算（工作区 sessionIds ∩ 归档集，withUnarchive=false 保证只诊断不写）比对；CI/无数据环境自动跳过。
{
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const wsJson = join(dshHome, 'storages', 'workspace.json')
  const cfgJson = join(dshHome, 'wxbridge', 'config.json')
  if (!existsSync(wsJson) || !existsSync(cfgJson)) {
    console.log('SKIP real-data（本机无 DSH 数据，CI 预期行为）')
  } else {
    const wsj = JSON.parse(readFileSync(wsJson, 'utf8'))
    const cfgf = JSON.parse(readFileSync(cfgJson, 'utf8'))
    const arch = (wsj.global.archivedSessionIds || []).map(String)
    const workspaces = Object.values(wsj.tables.workspaces || {})
    const live = [] // 仿真：假设无 live（真实宿主调用时由 sessions.list() 提供）
    const reg = mkReg({ workspaces, archived: arch, withUnarchive: false })
    const r = await runAutoUnarchive(reg, cfgf.cwd, live)
    const phoneWs = workspaces.find((w) => String(w.path || '').toLowerCase().replace(/[/\\]+$/, '') === String(cfgf.cwd).toLowerCase().replace(/[/\\]+$/, ''))
    const expected = new Set(phoneWs ? phoneWs.sessionIds.map(String) : []).size
      ? [...new Set((phoneWs.sessionIds || []).map(String))].filter((id) => arch.includes(id) && !live.includes(id))
      : []
    console.log('--- real-data ---')
    console.log('phoneCwd=' + r.phoneCwd, 'wsFound=' + r.wsFound, 'archived=' + r.archived)
    console.log('candidates=' + JSON.stringify(r.candidates))
    ok('real: wsFound', r.wsFound === true)
    ok('real: candidates=独立复算交集', JSON.stringify(r.candidates) === JSON.stringify(expected))
    // withUnarchive=false：有候选时才应报 missing-method；无候选时 error 必须为空（不空跑）
    ok('real: 诊断一致', r.candidates.length > 0 ? r.error.includes('unarchiveSession') : (r.error === '' && r.unarchived === 0))
  }
}

console.log('ALL PASSED (' + pass + ' assertions)')
