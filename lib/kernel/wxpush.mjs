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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

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

const text = (argOf('--text') || (args.includes('--stdin') ? await readStdin() : '') || positionalText()).trim()
if (!text) {
  console.error('[wxpush] 没有内容：用法 node wxpush.mjs "要推送的话"（或 --text / --stdin）')
  process.exit(2)
}

const dataDir = resolve(argOf('--data-dir') || process.env.WXBRIDGE_DATA || process.env.BRIDGE_DATA
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wxbridge'))
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
