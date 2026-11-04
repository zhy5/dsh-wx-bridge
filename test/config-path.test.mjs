/**
 * 面板写入路径 必须等于 keeper/桥 的读取路径。
 * 运行：node --test test/config-path.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { bridgeConfigFile } from '../lib/index.js'

/** keeper.mjs:47-52 的读法，逐字照搬，作为对照真值。 */
function keeperConfigFile(env) {
  return env.WXBRIDGE_CONFIG || join(env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge', 'config.json')
}

/** keeper.resolveDataDir 的默认值：末段就是 wxbridge。 */
const KEEPER_DATA = join(homedir(), '.dsh', 'wxbridge')

test('显式 WXBRIDGE_CONFIG 最大', () => {
  const env = { WXBRIDGE_CONFIG: '/tmp/custom.json', DSH_HOME: '/tmp/home' }
  assert.equal(bridgeConfigFile(env, KEEPER_DATA), '/tmp/custom.json')
  assert.equal(bridgeConfigFile(env, KEEPER_DATA), keeperConfigFile(env))
})

test('有 DSH_HOME 时与 keeper 一致', () => {
  const env = { DSH_HOME: '/data/dsh' }
  assert.equal(bridgeConfigFile(env, ''), join('/data/dsh', 'wxbridge', 'config.json'))
  assert.equal(bridgeConfigFile(env, KEEPER_DATA), keeperConfigFile(env))
})

test('桌面宿主：DSH_HOME 为空，只有 keeper.dataDir —— 这正是 issue #3 附注的路径', () => {
  const env = {}
  const got = bridgeConfigFile(env, KEEPER_DATA)
  assert.equal(got, keeperConfigFile(env), '面板写的必须就是桥读的那个文件')
  assert.ok(!got.includes(join('wxbridge', 'wxbridge')), '不能再出现 wxbridge/wxbridge：' + got)
})

test('既无 DSH_HOME 也无 keeper（面板先于 keeper 就绪）', () => {
  const env = {}
  assert.equal(bridgeConfigFile(env, ''), keeperConfigFile(env))
})

test('自定义 dataDir 不改变 keeper/bridge 的配置读取位置', () => {
  const env = {}
  const got = bridgeConfigFile(env, join(homedir(), 'bridge-data'))
  assert.equal(got, keeperConfigFile(env))
})
