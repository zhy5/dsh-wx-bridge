#!/usr/bin/env node
/**
 * wxpush.mjs — 主动推送 CLI（桥开机时会把它复制到 <dataDir>/wxpush.mjs）
 *
 * 用法（任何进程都能跑：手机通道会话里的 agent、桌面会话、定时任务）：
 *   node wxpush.mjs "要推送到微信的话"
 *   node wxpush.mjs --text "带换行的
 *   多行文本"  --to <peerId>  --data-dir <桥的数据目录>
 *   echo "来自管道的文本" | node wxpush.mjs --stdin
 *
 * 它只做一件事：把一条 JSON 丢进 <dataDir>/outbox/，桥轮询时替它发出去。
 * 零依赖、零网络：没有微信凭据 / 桥没在跑时也只是排队，不会报错给你。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, def = '') => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def }

function positionalText() {
  const skip = new Set()
  for (const key of ['--text', '--to', '--data-dir', '--source']) {
    const i = args.indexOf(key)
    if (i >= 0) { skip.add(i); skip.add(i + 1) }
  }
  return args.filter((a, i) => !skip.has(i) && !a.startsWith('--')).join(' ').trim()
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let out = ''
  try {
    for await (const chunk of process.stdin) out += chunk
  } catch { return '' }
  return out.trim()
}

/**
 * 数据目录解析（顺序很重要，2026-09-24 实测踩过）：
 *   ① --data-dir / WXBRIDGE_DATA / BRIDGE_DATA —— 显式指定，永远最大
 *   ② WXBRIDGE_CONFIG 指向的配置里的 dataDir —— 同样的显式配置链
 *   ③ **本文件自己所在的目录** —— 桥每次启动都会把本文件刷到 <dataDir>/wxpush.mjs 一份，
 *      所以"跟着这个文件走"永远等于桥真正在用的目录，不依赖任何环境变量
 * 刻意**不读** $DSH_HOME/wxbridge/config.json 之类：桌面端（Electron）里 DSH_HOME 常为空或指向
 * 另一个 home，读到的可能是旧目录里的旧 dataDir；实测症状就是"推送排了队，桥那头没人取件"。
 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url))

function explicitConfigDataDir() {
  const f = process.env.WXBRIDGE_CONFIG
  if (!f) return ''
  try {
    const d = JSON.parse(readFileSync(f, 'utf8')).dataDir
    return d ? resolve(String(d)) : ''
  } catch { return '' }
}

const dataDir = resolve(argOf('--data-dir') || process.env.WXBRIDGE_DATA || process.env.BRIDGE_DATA
  || explicitConfigDataDir() || SELF_DIR)

const text = (argOf('--text') || (args.includes('--stdin') ? await readStdin() : '') || positionalText()).trim()
if (args.includes('--print-dir')) {
  console.log('[wxpush] dataDir=' + dataDir + (text ? '' : '（未给内容，仅打印目录）'))
  process.exit(0)
}
if (!text) {
  console.error('[wxpush] 没有内容：用法 node wxpush.mjs "要推送的话"（或 --text / --stdin）')
  process.exit(2)
}

const outbox = join(dataDir, 'outbox')
const entry = {
  text: text.slice(0, 4000),
  to: argOf('--to'),
  at: new Date().toISOString(),
  source: argOf('--source') || 'wxpush',
}
try {
  mkdirSync(outbox, { recursive: true })
  const file = join(outbox, Date.now() + '-' + randomUUID().slice(0, 8) + '.json')
  writeFileSync(file, JSON.stringify(entry, null, 2))
  console.log('[wxpush] 已排队：' + file)
} catch (e) {
  console.error('[wxpush] 写入失败：' + String(e?.message ?? e))
  process.exit(1)
}
