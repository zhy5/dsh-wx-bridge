/**
 * acp-preset-shim.mjs — 「让 ACP 会话加入预设」的**上游兼容层**（compat shim）
 *
 * 背景：`@deepseek-ai/dsh-acp` 的 `session/new` / `session/resume` 的 setup 里只装模型选择与 MCP，
 * **没有** `agentPresets.mount()`，所以 ACP 会话永远拿不到用户预设（详见知识库笔记
 * 「DSH ACP 原生会话通道」的「预设」一节）。上游落地前，由插件在启动时给**已装**的 dsh-acp
 * 打一个**幂等**的小补丁（6 处），让 `Config.preset` 生效。
 *
 * 设计原则（产品化要求）：
 *   1. **幂等**：已支持 / 已打过 → 直接返回 'supported' / 'already'，绝不重复写；
 *   2. **只在该功能被用到时才动手**：调用方只在「用户选了预设」且未禁用（config.acp.patchAcp === false）时调用；
 *   3. **形状不符就拒绝**：任何一处锚点对不上（上游改过 / 已原生支持）→ 'shape-mismatch'，一个字节都不写；
 *   4. **写前先字节级备份**，写后先过 `node --check` 才落盘（补丁坏了等于把用户的运行时搞坏）；
 *   5. **如实记录**：每个结果都返回 status + detail，由调用方写日志，不静默。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** 已打过补丁的标记（写进文件注释，便于肉眼/程序双重识别）。 */
export const SHIM_MARK = 'wxbridge:acp-preset-shim'

/** 6 处补丁：每处都必须**恰好命中一次**，否则整体拒绝。 */
const EDITS = [
  ['config', `const Config = Schema.object({
	provider: Schema.string(),
	model: Schema.string(),
	sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE)
});`, `const Config = Schema.object({
	provider: Schema.string(),
	model: Schema.string(),
	preset: Schema.string(),
	sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE)
});`],

  ['new-session', `				record = await AcpSession.create(ctx, {
					sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers,
					agentOptions: agentOptions(config),
					fallbackSelection: initialSelection(config),
					signal,
					notify
				});`, `				record = await AcpSession.create(ctx, {
					sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers,
					agentOptions: agentOptions(config),
					preset: config.preset,
					fallbackSelection: initialSelection(config),
					signal,
					notify
				});`],

  ['resume-session', `					record = await AcpSession.resume(ctx, {
						sessionId,
						cwd: params.cwd,
						mcpServers: params.mcpServers ?? [],
						agentOptions: agentOptions(config),
						fallbackSelection: initialSelection(config),
						signal,
						notify
					});`, `					record = await AcpSession.resume(ctx, {
						sessionId,
						cwd: params.cwd,
						mcpServers: params.mcpServers ?? [],
						agentOptions: agentOptions(config),
						preset: config.preset,
						fallbackSelection: initialSelection(config),
						signal,
						notify
					});`],

  ['create-setup', `			sessionId: options.sessionId,
			meta: { cwd: options.cwd },
			agentOptions: options.agentOptions,
			signal: options.signal,
			setup: async (agentCtx) => {
				modelControl.install(agentCtx);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
			}`, `			sessionId: options.sessionId,
			meta: { cwd: options.cwd, agentPreset: options.preset },
			agentOptions: options.agentOptions,
			signal: options.signal,
			setup: async (agentCtx) => {
				modelControl.install(agentCtx);
				const presets = agentCtx.get("agentPresets");
				if (presets !== void 0 && options.preset !== void 0) await presets.mount(agentCtx, options.preset);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
			}`],

  ['resume-setup', `				modelControl = new AcpModelControl(ctx.llm, selectionFor(agent.session.requestHeader(), options.fallbackSelection));
				modelControl.install(agentCtx);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);`, `				modelControl = new AcpModelControl(ctx.llm, selectionFor(agent.session.requestHeader(), options.fallbackSelection));
				modelControl.install(agentCtx);
				const presets = agentCtx.get("agentPresets");
				if (presets !== void 0 && options.preset !== void 0) await presets.mount(agentCtx, options.preset);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);`],
]

/** 由 dsh 入口（<runtime>/lib/bin.js）推出已装 dsh-acp 的文件路径。 */
export function acpPackageFile(runtimeBin) {
  if (!runtimeBin) return ''
  return resolve(join(dirname(runtimeBin), '..', 'node_modules', '@deepseek-ai', 'dsh-acp', 'lib', 'index.js'))
}

/** 该文件是否已经支持预设（原生支持或已打过补丁）。 */
export function acpPresetSupported(file) {
  try {
    const s = readFileSync(file, 'utf8')
    return /preset:\s*Schema\.string\(\)/.test(s) && /agentPresets/.test(s)
  } catch { return false }
}

/**
 * 确保已装的 dsh-acp 支持 `Config.preset`。幂等、失败即弃、写前备份、写后语法检查。
 * @param {{runtimeBin:string, log?:(m:string,e?:object)=>void, dryRun?:boolean}} o
 * @returns {{status:'supported'|'already'|'patched'|'shape-mismatch'|'missing'|'syntax-failed'|'error', file:string, detail?:string, backup?:string}}
 */
export function ensureAcpPresetSupport(o) {
  const log = o.log || (() => {})
  const file = acpPackageFile(o.runtimeBin)
  if (!file || !existsSync(file)) return { status: 'missing', file, detail: '未找到已装的 dsh-acp（可能不是桌面运行时）' }

  let src
  try { src = readFileSync(file, 'utf8') } catch (e) { return { status: 'error', file, detail: String(e?.message ?? e) } }

  if (src.includes(SHIM_MARK)) return { status: 'already', file, detail: '已打过 wxbridge 预设补丁' }
  if (/preset:\s*Schema\.string\(\)/.test(src)) return { status: 'supported', file, detail: '上游已支持 Config.preset，无需补丁' }

  // 形状检查：所有锚点都必须恰好命中一次，否则整体拒绝
  let out = src
  for (const [name, old, next] of EDITS) {
    const n = out.split(old).length - 1
    if (n !== 1) return { status: 'shape-mismatch', file, detail: `锚点 ${name} 命中 ${n} 次（期望 1）——上游可能已改动，拒绝打补丁` }
    out = out.replace(old, next)
  }
  out = `/* ${SHIM_MARK} · 由 wxbridge 插件在启动时写入；上游支持 Config.preset 后本补丁可移除 */\n` + out

  if (o.dryRun) return { status: 'patched', file, detail: 'dryRun：未写盘' }

  // 写后先过语法检查，再落盘（补丁坏了等于把用户的运行时搞坏）
  try {
    const tmp = join(tmpdir(), 'dsh-acp-check-' + process.pid + '.mjs')
    writeFileSync(tmp, out)
    const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 30000, windowsHide: true })
    if (r.status !== 0) return { status: 'syntax-failed', file, detail: String(r.stderr || '').slice(0, 300) || 'node --check 未通过' }
  } catch (e) {
    return { status: 'syntax-failed', file, detail: String(e?.message ?? e) }
  }

  const backup = file + '.wxbridge-bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  try {
    copyFileSync(file, backup)
    writeFileSync(file, out)
  } catch (e) {
    return { status: 'error', file, detail: '写入失败：' + String(e?.message ?? e) }
  }
  log('acp-shim-patched', { file, backup })
  return { status: 'patched', file, backup, detail: '已打 6 处预设补丁（含备份）' }
}
