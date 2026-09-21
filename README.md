# @zmainer/wxbridge

DSH（DeepSeek Harness）插件：把**手机微信**接到本机 DSH，让微信消息驱动本机执行任务。

- **宿主半**：注册独立前缀路由 `/wxbridge/*`，托管桥进程（启动/停止/重启/体检），向设置页提供实时状态与**预设下拉**。
- **客户端半**：设置 → **微信连接** 面板（React），显示桥的真实状态、启停按钮、扫码配对，以及**手机通道预设**选择。
- **内核**：`lib/kernel/` 内置零依赖的 `bridge.mjs`（iLink 长轮询收发 + ACP 会话执行）与 `keeper.mjs`（存活自检 + 脱树重启）。路径、工作区、知识库、预设全部可配置，无硬编码。

## 执行路径（1.0 起：ACP 原生会话）

手机消息**不再由插件拼接上下文**，而是交给 **DSH 自己的会话**：

```text
微信 → iLink → bridge（内核） → 常驻 `dsh --profile acp`（Agent Client Protocol v1，stdio）
                              → DSH 原生会话（$DSH_HOME/sessions/…，可 list / resume）
```

- **每个微信联系人一条会话**：会话 id 存在桥状态里；桥或宿主重启后 `session/resume` 续接，上下文不丢。
- **每个「档位」一条独立会话**：档位 = 通道预设（见下），切档不串上下文。
- 执行优先级：① ACP 原生会话 → ② 宿主内执行 → ③ 一次性 headless（兜底，仍用「固定提示词 + 历史」拼接）。
- 模型/推理强度可切（`/model`、`/effort`），选择按 peer 记忆；**每次 new/resume 后重新施加**（ACP 的会话配置不随会话日志持久化）。

## 安装

```bash
dsh plugin --profile <profile> add @zmainer/wxbridge
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `@zmainer/wxbridge`（pnpm 因被忽略的构建脚本非零退出时，这一步会被跳过，需手工追加）。

## 预设（agent preset）

手机通道的身份 = **你选定的全局预设**（工具 + 提示词 + 技能都来自它）。

- **面板**：设置 → 微信连接 → 「手机通道预设」下拉（列表来自 DSH 名册：`$DSH_HOME/.agent-presets/` 用户预设 + 运行时出厂预设），点「保存预设」写入 `$DSH_HOME/wxbridge/config.json` 的 `acp.preset`。
- **手机**：`/预设` 列清单并切换；`/预设 自检` 回报当前档**是否真的按预设组装**（system 长度 + 关键标记 + 会话头 `agentPreset`）。
- 不指定时按 `config.json` 的 `acp.preset` → 宿主 `settings.yaml` 的 `agent-presets.default` → 插件自带「普通对话」。
- 「普通对话」是插件自带的收窄档：不注入技能目录，人格为对话助手，**不会**主动读写工作区/知识库。

### 预设补丁（compat shim，临时）

`@deepseek-ai/dsh-acp` 目前**不会**把会话加入预设（其 `create/resume` 的 setup 只装模型选择与 MCP，
没有 `agentPresets.mount()`），因此选定预设不会生效。插件内置一个**幂等**补丁（`lib/kernel/acp-preset-shim.mjs`），
在启用预设时给**已装**的 `dsh-acp` 补上这一调用：

- 已支持 / 已打过 → 直接跳过；锚点对不上（上游改版）→ **拒绝打补丁**，一个字节都不写；
- 写前备份 `index.js.wxbridge-bak-<时间戳>`，写后先过 `node --check` 才落盘；
- 应用升级覆盖后，下一次启用预设时会自动重打（自愈）；
- 关掉它：`config.json` 里 `"acp": { "patchAcp": false }`（此时预设不生效，通道退回宿主组合）。

> 上游支持 `Config.preset` 后，本补丁会自动让位（检测到原生支持即不再改动文件）。

## 配置

配置优先级：插件 config → 配置文件 → 环境变量 → 默认值。

配置文件位置：`$DSH_HOME/wxbridge/config.json`

```json
{
  "dataDir": "D:\\DSH\\.scratch\\weixin-bridge",
  "cwd": "D:\\DSH",
  "vault": "D:\\MyBrain\\Company-Brain",
  "intervalMs": 300000,
  "staleMs": 300000,
  "acp": { "preset": "second-brain", "enabled": true, "permPolicy": "allow" }
}
```

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `dataDir` | 桥的状态/日志/工作目录 | `$DSH_HOME/wxbridge` |
| `cwd` | 微信任务的默认工作目录 | 宿主启动目录 |
| `vault` | Obsidian 知识库绝对路径（可选，供提示词模板占位符使用） | 空 |
| `intervalMs` / `staleMs` | 自检间隔 / 心跳判新阈值 | 300000 |
| `prompt` | 手机任务的**固定前置提示词**（兜底路径用；留空 = 不加任何前缀） | 空 |
| `acp.enabled` | 关掉 ACP 路径（退回一次性 headless） | true |
| `acp.preset` | 手机通道预设 id | 宿主默认预设 |
| `acp.home` | ACP 子进程的 `DSH_HOME`（决定会话写进哪个仓库） | 宿主 home |
| `acp.dshBin` | ACP 用的 dsh 入口（默认跟随宿主运行时，schema 才一致） | 自动 |
| `acp.patch` | 覆盖叠层文件路径（预设档自动生成） | 插件内置 |
| `acp.permPolicy` | 权限请求策略：`allow` / `reject` | allow |
| `acp.patchAcp` | 是否允许给已装 `dsh-acp` 打预设补丁 | true |

环境变量：`WXBRIDGE_DATA`、`BRIDGE_CWD`、`BRAIN_VAULT`、`DSH_BIN`、`BRIDGE_HOST_HOME`、`WXBRIDGE_ACP=off`；
`WXBRIDGE_NO_AUTOSTART=1` / `WXBRIDGE_NO_SUPERVISE=1` 可关掉自动拉起与自动守护。

## 配对（首台设备）

1. 宿主启动后，桥会在 `dataDir/auth-token.txt` 生成一次性登记 token（ACL 限本人）。
2. 在手机微信里把该 token 发给机器人（例如 `<token> /help`）完成登记；之后该设备免 token。
3. 未登记的发送者会被静默丢弃并写审计日志。
4. 面板「扫码配对」可直接出二维码（需本机 `qrcode` 可用；扫码会**重新绑定** ClawBot）。

## HTTP 接口（宿主半）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/wxbridge/status` | 桥实时状态（phase/polls/pid/心跳年龄/会话数/任务数）+ 数据目录 |
| GET | `/wxbridge/info` | 数据目录、登记 token、已装 profile |
| GET | `/wxbridge/log` | 宿主半操作日志（最近 60 条） |
| GET | `/wxbridge/presets` | **预设名册**（id/name/description）+ 当前选中值 |
| POST | `/wxbridge/preset` | 写入预设选择（`{ "preset": "<id|空>" }`） |
| POST | `/wxbridge/start` · `/stop` · `/restart` · `/tick` | 桥生命周期（`tick` = 立即体检并按需自愈） |
| POST | `/wxbridge/config` | 写配置文件（`dataDir`/`cwd`/`vault`/`intervalMs`/`staleMs`/`prompt`） |
| POST | `/wxbridge/task` · `/scan` · `/attach` | 宿主内执行 / 会话归组 |

## 安全基线

- 发送者白名单（TOFU）+ 一次性登记 token；未登记静默丢弃。
- 子进程使用**专用 `DSH_HOME`**（`dataDir/dsh-home`），权限 `workspace-write`，**只拿模型密钥、不含微信 token**。
- 状态文件原子写 + SHA256 校验，校验失败即隔离为 `.tampered-*`。
- 输出审计：密钥形态脱敏、外发命令阻断、超大输出截断。
- 任务超时/取消走 `taskkill /T /F` 终止整棵进程树；ACP 轮次走协议 `session/cancel`。
- 常驻进程重启时清理遗留 `running` 任务，避免并发闸被永久占死。

> 数据经腾讯 iLink 通道，**不得用于涉密内容**。状态与凭据文件为明文，仅靠 ACL 保护。

## 微信侧指令

| 指令 | 说明 |
| --- | --- |
| `/预设 [序号\|id]` | 列通道预设 / 切换（含插件自带「普通对话」） |
| `/预设 自检` | 验证当前档是否真按预设组装（system 长度 + 关键标记 + 会话头 agentPreset） |
| `/model [序号\|provider/model]` | 列模型 / 切换（按会话） |
| `/effort [序号\|值]` | 推理强度（off/low/high/max） |
| `/sessions [序号]` | 列出 / 接上 DSH 已有会话（可用于接桌面端开着的会话） |
| `/new` | 开新会话（当前档） |
| `/ws [序号\|路径]` | 列/切工作区（换工作区即换会话） |
| `/status` | 桥状态、档位、原生会话 id、模型与强度 |
| `/task` · `/cancel` | 任务与排队 / 取消运行中任务 |
| `/help` `/ping` `/approve` `/reject` | 帮助 / 探活 / 审批记录 |

其余任意文本 → 交给 DSH 执行。

## 最近变更

- **1.0.3**：**配对二维码不再依赖用户环境** —— 此前宿主半靠 `require.resolve('qrcode')` 在用户 profile 里
  找那个包（本包 `dependencies` 为空），干净安装的机器渲染不出二维码、只剩"备用链接"；
  现在把 `qrcode@1.5.4` 的编码核心与 `dijkstrajs@1.0.3`（均 MIT）vendored 进 `lib/vendor/`，
  并用自带渲染器输出 SVG data URL（自带优先，profile 里的 `qrcode` 退为兜底）。
- **1.0.2**：设置页「微信连接」面板换微信风格视觉（微信绿头卡 + 内联 SVG 双气泡 logo + 状态胶囊/呼吸点、
  四张数据卡、胶囊按钮、扫码卡片、聊天气泡样式的登记 token）；修复新面板里「保存预设」会把值清空的问题；
  面板版本号改为从 `package.json` 读取（不再写死）。
- **1.0.1**：ACP 原生会话成为默认路径（上下文归 DSH、可 list/resume）；
  **预设选择**（面板下拉 + `/预设` + `/预设 自检`）；`dsh-acp` 预设补丁（幂等、可关闭、升级自愈）；
  模型/推理强度可切；面板「提示词输入框」改为预设下拉；原生控件的皮肤适配修复。

## 许可

MIT

本包内还**原样包含**以下第三方代码（均为 MIT，用于不依赖用户环境地渲染配对二维码）：

| 位置 | 来源 | 许可 |
| --- | --- | --- |
| `lib/vendor/qrcode-core/` | `qrcode@1.5.4` 的 `lib/core/*`（编码核心，零外部依赖） | MIT © 2012 Ryan Day，见该目录 `LICENSE` |
| `lib/vendor/qrcode-core/dijkstrajs.js` | `dijkstrajs@1.0.3` 的 `dijkstra.js` | MIT，见 `dijkstrajs.LICENSE` |
| `lib/vendor/qr-svg.cjs` | 本插件自带（用上面的核心产出模块矩阵，自绘 SVG） | MIT |

对 vendored 代码的唯一改动：`segments.js` 里 `require('dijkstrajs')` → `require('./dijkstrajs')`
（npm 打包默认忽略 `node_modules/`，改相对路径才能保证发布包里不缺文件）。详见
`lib/vendor/qrcode-core/NOTICE.md`。
