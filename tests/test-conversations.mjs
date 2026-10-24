// Unit test: wxbridge host-side buildConversationsView（可选真实数据 + 纯降级用例）。
// 模块定位：默认按仓库布局 import ../lib/index.js；可用 WXBRIDGE_MODULE 覆盖。
// 数据目录：WXBRIDGE_DATA_DIR 指定桥数据目录；缺省时探测 <DSH_HOME>\wxbridge；都没有则跳过真实数据段（纯降级用例照跑）。
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modPath = process.env.WXBRIDGE_MODULE
  ? pathToFileURL(resolve(process.env.WXBRIDGE_MODULE)).href
  : new URL('../lib/index.js', import.meta.url).href
const mod = await import(modPath)
const { buildConversationsView } = mod
if (typeof buildConversationsView !== 'function') throw new Error('buildConversationsView 未导出')

let failed = 0
const assert = (cond, msg) => { if (!cond) { console.error('FAIL ' + msg); failed = 1 } }

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const candidates = [process.env.WXBRIDGE_DATA_DIR, join(dshHome, 'wxbridge')].filter(Boolean)
const dataDir = candidates.find((d) => existsSync(join(d, 'state.json'))) || ''

if (!dataDir) {
  console.log('SKIP real-data（本机无桥 state.json，CI 预期行为）')
} else {
  const view = buildConversationsView(dataDir)
  const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
  assert(view.checksum === state.checksum, 'checksum mismatch: ' + view.checksum + ' vs ' + state.checksum)
  assert(Array.isArray(view.peers) && view.peers.length === Object.keys(state.peers).length, 'peers count')
  for (const p of view.peers) {
    assert(typeof p.peer === 'string' && p.peer.length > 0, 'peer id')
    assert(Array.isArray(p.history), 'history array: ' + p.peer)
    assert(p.history.length <= 50, 'history capped')
    for (const h of p.history) {
      assert(typeof h.u === 'string' && typeof h.a === 'string' && typeof h.ok === 'boolean', 'history row shape')
    }
  }
  assert(Array.isArray(view.tasks.running), 'running array')
  assert(Array.isArray(view.tasks.recent), 'recent array')
  for (const t of Object.values(state.tasks)) {
    const found = [...view.tasks.running, ...view.tasks.recent].find((r) => r.id === t.id)
    if (t.status === 'running' || t.status === 'queued') assert(found, 'running task present: ' + t.id)
  }
  console.log('--- view summary ---')
  console.log('checksum:', view.checksum.slice(0, 12) + '…')
  for (const p of view.peers) console.log('peer', p.peer.slice(0, 12) + '…', 'history=' + p.history.length, 'last=' + p.lastSeenAt, 'session=' + p.acpSessionId.slice(0, 8))
  console.log('running:', view.tasks.running.map((t) => t.id).join(',') || '(none)', 'recent:', view.tasks.recent.map((t) => t.id).join(',') || '(none)')
}

// 纯降级用例（无数据依赖，永远跑）
const empty = buildConversationsView('C:/nonexistent-dir-xyz-12345')
assert(empty.checksum === '' && empty.peers.length === 0, 'graceful empty')
const none = buildConversationsView('')
assert(none.checksum === '' && none.peers.length === 0, 'graceful undefined')

if (failed) { console.log('SOME ASSERTIONS FAILED'); process.exit(1) }
console.log('ALL ASSERTIONS PASSED')
