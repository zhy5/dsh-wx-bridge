/**
 * approval-reply.mjs — 审批卡与「微信里的回复」之间的纯函数层（无 IO，可离线自测）
 *
 * 为什么单独一层：审批的解析/选择/文案都必须可离线验证（桥本身的启动路径会连 iLink、拉子进程，
 * 单测没法用）。协议事实：ACP 的 `session/request_permission` 请求**必须应答**，
 * 参数里给的是若干 option（各带 optionId / kind / name），客户端要挑一个回去。
 */

/** 同意 / 拒绝（对外只有这两个语义，选项到 optionId 的映射由 pickOptionByDecision 决定）。 */
export const DECISION_ALLOW = 'allow'
export const DECISION_REJECT = 'reject'

// 先判拒绝词：'不同意' 里含 '同意'、'不许' 里含 '许'，顺序反了会把拒绝读成同意。
const REJECT_WORDS = ['拒绝', '不同意', '驳回', '不许', '不行', '不准', 'deny', 'reject', 'no']
const ALLOW_WORDS = ['批准', '同意', '允许', '准许', '通过', '可以', 'approve', 'allow', 'yes', 'ok']

/**
 * 解析用户回复：支持「批准 / 拒绝 / 同意 / 不同意 / yes / no」与「#3 批准」「3 拒绝」「2」。
 * @returns {{decision: 'allow'|'reject'|null, index: number|null, keyword: string}}
 */
export function parseApprovalReply(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { decision: null, index: null, keyword: '' }
  const nums = text.match(/\d{1,2}/g) || []
  const index = nums.length ? Number(nums[0]) : null
  const lower = text.toLowerCase()
  const hit = (words) => words.find((w) => lower.includes(w)) || ''
  const rej = hit(REJECT_WORDS)
  const alw = rej ? '' : hit(ALLOW_WORDS)
  let decision = rej ? DECISION_REJECT : (alw ? DECISION_ALLOW : null)
  // 只回数字：1=批准、2=拒绝（与卡片里「1) 允许 2) 拒绝」的编号一致）
  if (!decision && index !== null) decision = index === 1 ? DECISION_ALLOW : (index === 2 ? DECISION_REJECT : null)
  return { decision, index, keyword: rej || alw }
}

const optionText = (o) => [o?.optionId, o?.kind, o?.name, o?.title].map((v) => String(v ?? '')).join(' ').toLowerCase()
const looksReject = (o) => /reject|deny|refuse|abort|cancel|no\b/.test(optionText(o))

/** 选项的可读标签（卡片里显示编号用）。 */
export function optionLabel(o, i) {
  const name = String(o?.name || o?.title || '').trim()
  if (name) return name
  const kind = String(o?.kind || '').trim()
  if (kind) return kind
  return '选项 ' + ((i ?? 0) + 1)
}

/**
 * 决策 → 具体 optionId。挑不到时返回 null（调用方按「取消应答」处理，即 fail-closed）。
 */
export function pickOptionByDecision(options, decision) {
  const list = Array.isArray(options) ? options : []
  if (!list.length) return null
  if (decision === DECISION_ALLOW) {
    const allow = list.find((o) => /allow|approve|accept|permit|once|yes/.test(optionText(o)) && !looksReject(o))
    return allow || list.find((o) => !looksReject(o)) || null
  }
  if (decision === DECISION_REJECT) {
    return list.find(looksReject) || null
  }
  return null
}

/** 微信侧审批卡（纯文本；微信只能收文本）。 */
export function formatApprovalCard(o = {}) {
  const n = Number(o.n || 1)
  const tool = String(o.tool || '工具调用').replace(/\s+/g, ' ').slice(0, 180)
  const sec = Math.max(5, Number(o.timeoutSec || 120))
  const options = Array.isArray(o.options) ? o.options : []
  const rows = options.slice(0, 4).map((it, i) => (i + 1) + ') ' + optionLabel(it, i))
  return [
    '【需要你批准】#' + n,
    '操作：' + tool,
  ].concat(rows.length ? ['选项：'].concat(rows) : [])
    .concat([
      '回复：批准 / 拒绝（也可以回 1 / 2）',
      sec + ' 秒内没回复＝按拒绝处理（需要审批的操作会失败；想让桥不再问，发 /审批 自动）。',
    ]).join('\n')
}

/** 决策确认语（回执给用户，让他知道刚才那句被当成了什么）。 */
export function decisionAck(decision, note) {
  if (decision === DECISION_ALLOW) return '✅ 已批准' + (note ? '（' + note + '）' : '') + '，继续执行。'
  if (decision === DECISION_REJECT) return '🚫 已拒绝' + (note ? '（' + note + '）' : '') + '，这一项不会执行。'
  return '（审批应答已作废：' + (note || '无待批事项') + '）'
}
