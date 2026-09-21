# @zmainer/wxbridge

DSH（DeepSeek Harness）插件：把**手机微信**接到本机 DSH，让微信消息驱动本机执行任务。

- **宿主半**：注册独立前缀路由 `/wxbridge/*`，托管桥进程（启动/停止/重启/体检），并向设置页提供实时状态。
- **客户端半**：设置 → **微信连接** 面板（React），显示桥的真实状态，提供启停按钮与首台设备登记 token。
- **内核**：`lib/kernel/` 内置零依赖的 `bridge.mjs`（iLink 长轮询收发 + 调 headless 执行）与 `keeper.mjs`（存活自检 + 脱树重启）。路径、工作区、知识库位置全部可配置，无硬编码。

## 安装

```bash
dsh plugin --profile <profile> add @zmainer/wxbridge
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `@zmainer/wxbridge`（pnpm 因被忽略的构建脚本非零退出时，这一步会被跳过，需手工追加）。

## 配置

配置优先级：插件 config → 配置文件 → 环境变量 → 默认值。

配置文件位置：`$DSH_HOME/wxbridge/config.json`

```json
{
  "dataDir": "D:\\DSH\\.scratch\\weixin-bridge",
  "cwd": "D:\\DSH",
  "vault": "D:\\MyBrain\\Company-Brain",
  "intervalMs": 300000,
  "staleMs": 300000
}
```

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `dataDir` | 桥的状态/日志/契约目录 | `$DSH_HOME/wxbridge` |
| `cwd` | 微信任务的默认工作目录 | 宿主启动目录 |
| `vault` | Obsidian 知识库绝对路径（注入身份契约） | 空（用契约模板默认值） |
| `intervalMs` / `staleMs` | 自检间隔 / 心跳判新阈值 | 300000 |

环境变量：`WXBRIDGE_DATA`（= dataDir）、`BRIDGE_CWD`、`BRAIN_VAULT`、`DSH_BIN`；`WXBRIDGE_NO_AUTOSTART=1` / `WXBRIDGE_NO_SUPERVISE=1` 可关掉自动拉起与自动守护。

## 配对（首台设备）

1. 宿主启动后，桥会在 `dataDir/auth-token.txt` 生成一次性登记 token（ACL 限本人）。
2. 在手机微信里把该 token 发给机器人（例如 `<token> /help`）完成登记；之后该设备免 token。
3. 未登记的发送者会被静默丢弃并写审计日志。

## HTTP 接口（宿主半）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/wxbridge/status` | 桥实时状态（phase/polls/pid/心跳年龄/会话数/任务数）+ 数据目录 |
| GET | `/wxbridge/pairing` | 数据目录、登记 token、知识库路径、已装 profile |
| POST | `/wxbridge/start` · `/stop` · `/restart` · `/tick` | 桥生命周期（`tick` = 立即做一次健康自检并按需自愈） |
| POST | `/wxbridge/config` | 写配置文件（`dataDir`/`cwd`/`vault`/`intervalMs`/`staleMs`），重启宿主后生效 |

## 安全基线

- 发送者白名单（TOFU）+ 一次性登记 token；未登记静默丢弃。
- 子进程使用**专用 `DSH_HOME`**（`dataDir/dsh-home`），权限 `workspace-write`，**只拿模型密钥、不含微信 token**。
- 状态文件原子写 + SHA256 校验，校验失败即隔离为 `.tampered-*`。
- 输出审计：密钥形态脱敏、外发命令阻断、超大输出截断。
- 任务超时/取消走 `taskkill /T /F` 终止整棵进程树。

> 数据经腾讯 iLink 通道，**不得用于涉密内容**。状态与凭据文件为明文，仅靠 ACL 保护。

## 微信侧指令

`/help` `/ping` `/status` `/task` `/cancel` `/ws` `/ws <序号|路径>` `/new` `/approve` `/reject`；其余任意文本交给 DSH 执行。

## 许可

MIT
