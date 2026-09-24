/**
 * outbox.mjs — 主动推送的「信箱」纯函数层（无 IO，可离线自测）
 *
 * 设计：任何进程（手机通道会话里的 agent、桌面会话、定时任务）只做一件事——
 * 往 <dataDir>/outbox/ 里丢一个 JSON 文件；桥每 5 秒扫一次，替它发到微信。
 * 这样推送不依赖网络、不依赖 RPC，也不需要调用方知道 iLink 协议。
 * 投递结果用文件位置表达：成功 → outbox/sent/，失败 → outbox/failed/（附原因）。
 */

/** 单条推送允许携带的字段（其余字段忽略）。 */
export function normalizePushEntry(obj) {
  const text = String((obj && obj.text) || '').trim()
  if (!text) throw new Error('empty text')
  return {
    text: text.slice(0, 4000),
    to: String((obj && obj.to) || '').trim(),
    at: String((obj && obj.at) || new Date().toISOString()),
    source: String((obj && obj.source) || '').trim(),
  }
}

/** 解析一个 outbox 文件的内容（坏 JSON / 空文本都要给出可读原因）。 */
export function parsePushEntry(raw) {
  let obj
  try { obj = JSON.parse(String(raw || '')) } catch (e) { return { error: 'bad-json: ' + String(e?.message ?? e) } }
  try { return { entry: normalizePushEntry(obj) } } catch (e) { return { error: String(e?.message ?? e) } }
}

/**
 * 收件人：显式指定 > 最近发过消息的人 > state 里的默认人 > 唯一已登记的人。
 * **只在已登记白名单里选**：推送不能成为绕过准入的后门；无人可选时返回 ''（调用方判失败）。
 */
export function pickRecipient(entry, ctx = {}) {
  const allowed = Array.isArray(ctx.allowedUsers) ? ctx.allowedUsers.filter(Boolean) : []
  if (!allowed.length) return ''
  const want = String(entry?.to || '').trim()
  if (want && allowed.includes(want)) return want
  for (const cand of [ctx.defaultPeer, ctx.lastPeer]) {
    if (cand && allowed.includes(cand)) return cand
  }
  return allowed.length === 1 ? allowed[0] : ''
}
