# @zmainer/dsh-wx-bridge

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

> **改名说明**：本插件原名 `@zmainer/wxbridge`，自 1.0.8 起改名为 **`@zmainer/dsh-wx-bridge`**
> （旧包已弃用，仅保留历史版本）。插件**内部标识仍是 `wxbridge`**（cordis 插件 id、设置页面板 id、
> HTTP 路由前缀 `/wxbridge/*` 均不变），所以迁移只需换包名，配置与数据目录都不用动。



```bash
dsh plugin --profile <profile> add @zmainer/dsh-wx-bridge
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `@zmainer/dsh-wx-bridge`（pnpm 因被忽略的构建脚本非零退出时，这一步会被跳过，需手工追加）。

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
  "dataDir": "<你的数据目录，留空则用 $DSH_HOME/wxbridge>",
  "cwd": "<默认工作区，留空则用宿主启动目录>",
  "vault": "<可选：Obsidian 知识库绝对路径>",
  "intervalMs": 300000,
  "staleMs": 300000,
  "acp": { "preset": "<预设 id，留空跟随 DSH 默认预设>", "enabled": true, "permPolicy": "allow" }
}
```

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `dataDir` | 桥的状态/日志/工作目录 | `$DSH_HOME/wxbridge` |
| `cwd` | 微信任务的默认工作目录 | 宿主启动目录 |
| `vault` | Obsidian 知识库绝对路径（可选，供提示词模板占位符使用） | 空 |
| `dshBin` | DSH 运行时入口（`<安装目录>/resources/dsh-runtime/lib/bin.js`）。**留空＝五级自动探测**：显式参数/环境变量 → 宿主自证快照 → PATH/npm 全局 → 桌面安装目录扫描 → 运行中进程嗅探 | 自动 |
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

- **权限预设（1.0.7 起为 `danger-full-access`）**：手机端**没有可应答审批的界面**，
  而 DSH 的审批在无应答者时 fail-closed → 任何需要审批的操作都会直接失败。
  因此本插件把**手机通道**的权限预设放到最宽；**这等于把本机交给能驱动该机器人的人**，
  请配合白名单/凭据保管使用。收紧办法：叠层里 `permission.defaultPreset` 改
  `workspace-write` 或 `read-only`（后者只读）。
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

- **1.0.11**：三条体验/正确性修复（均来自用户反馈）——
  ① **非文本消息不再静默丢弃**：图片/语音/表情/文件此前是 `if (!from || !text) return` 直接丢弃，
  连回执都没有（用户只看到"发了没反应"）；现在会回一句「只认文字消息」并把条目类型记进日志
  （同一个人 60 秒内只提醒一次，避免连发图片被刷屏）；
  ② **会话自动归组修好**：宿主半原来在开机补登记时直接读 `ctx.workspaceRegistry`，而没声明 inject
  → cordis 在**属性访问那一刻**就抛 `cannot get property "workspaceRegistry" without inject`，
  "未注入就跳过"的兜底分支根本走不到 ⇒ 手机会话永远不进桌面 GUI 的工作区列表。
  现在改用**注入进来的 webCtx**（并保留周期兜底扫描，10 分钟一次），失败只记日志、不影响其它功能；
  ③ **宿主端口探测修正**：`dsh-host-webserver` 暴露的是**方法** `webServer.port()`，不是属性——
  之前写出的 `host-address.json` 里 `port: 0`，桥只能去扒 `desktop.log` 猜端口（日志一换就瞎）。
  另外桥**新建 ACP 会话后会主动上报宿主**（`POST /wxbridge/attach`），手机对话即刻出现在工作区里。
- **1.0.10**：面板「运行时入口」一行区分「字段缺失」与「解析失败」——
  升级了包但还没重启宿主时，宿主半仍是旧版、不上报该字段，此前会误显示成「未解析（手机对话会失败）」；
  现在显示「—（宿主半未上报；重启宿主后显示）」。纯客户端修正。
- **1.0.9**：修「手机发消息永远没答复 / 5 分钟后才报 ACP 超时」——
  根因是**运行时入口解析不到**（桌面端装在非标准目录时三级探测全部落空），ACP 子进程拿到空路径，
  而 `node "" --profile acp` 会进入「读 stdin」模式：**不回应协议、也不退出**，只能等满超时。
  ① `dshBin` 改为**五级解析**：显式参数/环境变量 → **宿主自证快照**（宿主进程自己就是 `<runtime>/lib/bin.js`，
  每次启动写 `<dataDir>/host-runtime.json`）→ PATH/npm 全局 → 桌面安装目录扫描（`%LOCALAPPDATA%\Programs\*`、
  `Program Files*`）→ **运行中进程嗅探**（从别的 DSH 进程命令行里取 `dsh-runtime\lib\bin.js`）；
  ② **空入口快速失败**：ACP 入口不存在直接报错（不再空跑 5 分钟），一次性兜底路径也不再盲试 `spawn('dsh')`，
  报错文案直接给出该填什么；
  ③ 独立 keeper 每轮自检补读快照/配置 —— 改好配置**不必重启 keeper**；
  ④ 面板诊断新增「运行时入口」一行，`node lib/kernel/bridge.mjs --selftest-runtime` 一次看全解析链。
- **1.0.8**：手机指令可用性打磨 ——
  ① `/help` 重写：按「看状态 / 管任务 / 会话 / 档位模型 / 工作区 / 权限」分组，每条写清**作用**；
  ② `/task` 带**进度**（已跑多久、最近在用哪个工具、多久之前），不再只显示"running"；
  ③ `/approve`、`/reject` 从"只记一条审计"变成**真开关**（切桥对审批的应答策略，落 `config.json` 的
  `acp.permPolicy`，并作用于已在跑的 ACP 子进程）；
  ④ `/预设 自检` 更宽容：还没跑过一轮、或找不到会话日志时都能说清原因（并回报 ACP home）。
- **1.0.7**：**手机通道不再被审批卡死** —— `dsh-acp` 只应答**带 `callId` 的工具审批**；
  沙箱升级类审批（如写工作区之外的路径）会 `next()` 转给桌面端弹窗，而手机端没有可应答的界面 →
  按 "fail-closed" 直接**执行失败**（其他用户实测）。现在把通道的权限预设设为 **`danger-full-access`**
  （叠层 `permission.defaultPreset`），手机侧新增 `/权限` 查看；实测：让 ACP 会话往工作区之外写文件，
  **权限请求帧 = 0**、一次成功。
  ⚠️ 这是**放宽**：该通道上的一切操作不再询问。要收紧就把叠层里的 `defaultPreset` 改成
  `workspace-write`（默认，写工作区之外会问）或 `read-only`。
- **1.0.6**：日志不再误导 —— `bridge-standalone.log` 是追加写的，以前面板直接 tail，
  会把**上一次尝试的崩溃**当成这一次的问题（用户实测："为什么还有 error 日志"）。
  现在每次启动前由 keeper 写一条分隔线（时间 + kernel 版本 + `data`/`cwd`/`detached` 参数），
  面板 `/bridge-log` **只显示最后一次启动之后的段落**并注明省略了多少行历史。
  （顺带修掉分隔线里一个未定义常量导致的静默失败：写日志失败现在会打到 keeper 控制台。）
- **1.0.5**：**首次使用不再"启动不了"** —— 新用户还没有微信凭据时，桥此前会在启动阶段直接抛错退出；
  现在改为照常启动、进入 `wait-credentials` 状态并提示「先在面板扫码配对」，**配对写入凭据后自动接手、
  无需重启**（实测：无凭据启动 → 写凭据 → 12 秒内 phase 转 poll）。另：删掉包内写死某台机器路径的
  `bridge-watchdog.ps1`（无运行时引用），并把 README 的配置示例改成中性占位。
- **1.0.4**：修「启动了却没起来」的三个沉默原因 —— ① 被拉起的桥的 stdout/stderr 以前被丢弃
  （现在落 `<dataDir>/bridge-standalone.log`）；② 单实例锁只看 pid 存在，Windows pid 复用会让新实例
  **静默退出**（现在要求「pid 活着 **且** 心跳新鲜 120s」，否则接管并打印原因）；
  ③ 新增 `GET /wxbridge/bridge-log`，面板「启动/重启」后会自动回读桥的启动输出。
  （另：宿主内嵌 keeper 是**只观测**，不会自愈；要"死了自动拉起"需装独立 keeper。）
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
