# 合流 · ACPAO

一个可运行的 ACP 多 Agent 工作环境。人类与主 Agent 对话；Agent 通过 MCP 委派；确定性执行端负责进程、队列、权限与恢复。中心不调用模型 API。

## 启动

GitHub Release 提供 Windows x64、Linux x64、Linux ARM64 的中心程序及独立 Go Gateway 可执行文件。下载对应平台文件后直接运行，无需安装 Node.js 或 npm；中心程序首次运行会在当前目录的 `.data/runtime` 解出内置 Web 资源和服务代码，因此工作目录需要可写。Linux 先执行 `chmod +x acpao-linux-* acpao-gateway-linux-*`。有桌面浏览器时会自动打开并登录；否则终端只显示一个可复制的授权链接。加 `--no-browser` 可强制只显示链接。链接 30 分钟内可使用一次，登录后令牌从地址栏移除，身份保存在 HttpOnly Cookie。本机登录保持有效，直到主动登出、清除浏览器数据或更换管理员密钥；远程登录有效期 30 天。默认工作目录为启动程序时的当前目录，需要指定其他目录时可设置 `ACPAO_ROOT`。远程设备使用 `acpao-gateway-*`；真实 ACP Agent 及其登录凭据仍需在目标主机另行安装。

从源码运行或开发时：

需要 **Node.js 24+**、npm 和 Linux/macOS。首次安装：

```bash
npm ci
npm run build
npm start
```

启动后浏览器会自动打开，或在终端显示授权链接。手动登录仍可使用 `.data/admin-token` 中的密钥；也可通过 `ACPAO_ADMIN_TOKEN` 指定至少 16 字符的密钥。密钥不会出现在服务日志或 Agent 工具返回中。

当前实施环境原先没有 Node.js，已校验并安装独立运行时到 `/tmp/node-v24.22.3-linux-x64`。在当前环境可以先执行：

```bash
export PATH=/tmp/node-v24.22.3-linux-x64/bin:$PATH
npm start
```

第一次进入会引导选择主机、配置 ACP Agent、创建主 Session。侧栏始终可以直接进入会话和主机管理。没有自动创建伪装成真实模型的演示对话。

开发时分别运行 `npm run dev`（中心 4310）和 `npm run dev:web`（Vite 5173）。Vite 的 API 代理共用登录 Cookie；如通过其他域名访问，请配置同源反向代理。

## 接入真实 ACP Agent

普通 CLI 命令不一定支持 ACP；请安装对应适配器并在主机终端完成登录。已核实并实际启动的 Codex 适配器是 **`@agentclientprotocol/codex-acp@2.7.0`**，不是已弃用的 `@zed-industries/codex-acp`。

```bash
npm install -g @agentclientprotocol/codex-acp@2.7.0
codex login
```

在「主机 → 添加 Agent」填写 `codex-acp` 或其绝对路径，参数 `[]`。也可填写启动程序 `npx`，参数 `["--yes","@agentclientprotocol/codex-acp@2.7.0"]`，首次使用会下载依赖。

Agent 仅继承 `PATH`、`HOME`、`LANG`、`TERM` 以及显式配置的环境变量，避免把中心认证信息传给子进程。需要其他变量（如 Agent 自己的登录目录）时，在高级配置中明确填写。ACP 登录交互暂不在 Web 内实现；认证问题需在主机终端处理。

执行端支持稳定 ACP v1 的初始化、`session/new`、`session/prompt`、`session/update`、`session/request_permission`、`session/cancel`，以及协商成功后的 `session/load`。SDK 2.7.0 使用 `client()/agent()` 和 `methods`，没有依赖被移除的旧连接类。每个 Session 使用独立进程，因此跨会话 ID 不会混用，也不假定 Agent 支持同进程并行。

主 Agent 的 `session/new` 自动附加 `acpao` stdio MCP 桥。它获得独立、可撤销、限制到当前主机及自身/委派后代会话的凭据。**Agent 无权添加主机、改启动程序、导出密钥或审批。** 跨主机委派暂需人类直接创建目标 Session；MVP 不默认授予 Agent 全局主机权限。

## 不依赖模型的体验与测试

首次引导中的「使用测试 Agent」会添加清楚标记的 Mock，它使用官方 SDK 和真实 stdio 协议，但**不调用模型**。也可在空数据目录启动：

```bash
ACPAO_DEMO=1 npm start
```

Mock 支持：普通文本流式回显；`/delegate 检查队列` 通过真实 MCP 桥委派另一个 Mock、等待真实结果并回传；`/permission 测试` 请求人工审批；`/slow 工作` 验证补充消息排队与取消；`/crash` 验证进程退出。`ACPAO_DEMO` 只影响首次创建的本机配置，不覆盖已有设置。

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

如果已有可用浏览器，设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 可复用它。UI 测试在 4317 启动独立临时服务，不读取生产数据；执行前先构建 Web。测试输出与截图位于被忽略的 `test-results/`。

可选真实 Agent 探针：设置 `ACPAO_PROBE_COMMAND`、`ACPAO_PROBE_ARGS`（JSON 数组）后运行 `npm run probe:agent`。它只验证初始化和创建 Session，**不发送模型 Prompt**。验证记录见 [docs/implementation.md](docs/implementation.md)。

## MCP 自然动作

| 工具       | 行为                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `delegate` | 异步委派独立会话；默认源 Host/cwd，可指定 Agent 或 worktree。可提供 `requestId` 去重。                                     |
| `send`     | `auto` 空闲立即、忙时排队；`queue` 同样串行调度；`immediate` 无法立即执行时失败；`steer` 明确返回 `STEERING_UNSUPPORTED`。 |
| `wait`     | 一次等待 1–32 个会话，增量 `cursor`，`until=change/terminal`，最长 30 秒。摘要仅截取实际输出。                             |
| `sessions` | list/get/history/create/cancel/close/resume。无恢复能力时返回明确错误。                                                    |
| `hosts`    | 只返回授权主机的简短信息，不返回命令、环境变量或密钥。                                                                     |

MCP 提供 Streamable HTTP `/mcp`；ACP 客户端可通过 Streamable HTTP `/acp` 连接中心，两者都需要授权。`/acp` 支持文本 Prompt、流式消息、Session 创建/加载和取消；外部 ACP 客户端传入自己的 MCP Server 或非文本 Prompt 会收到明确错误。REST `/api/tools/:tool` 与 MCP 共享 Schema、授权和审计。

同一会话最多排队 100 条；默认同时执行 4 个 Prompt、最多保持 32 个本地 ACP 进程。Agent 同源会话默认最多直接委派 16 个未关闭后代。取消会清空该 Session 的队列；Agent 3 秒未确认取消时终止进程。单次 Prompt 最长 10 分钟。恢复会话不等于自动重放中断的 Prompt。

## Remote Gateway

1. 给中心配置可达的 **HTTPS** 地址和 TLS 反向代理，参见 [部署说明](docs/deployment.md)。
2. 在「主机 → 配对主机」生成一次性配对码，10 分钟有效、仅能使用一次。
3. 在远端下载匹配平台的 `acpao-gateway-*` 二进制，不需要 Node.js；被管理的 ACP Agent 本身可能另有运行时要求。
4. 在目标设备执行配对命令：

```bash
export ACPAO_CENTER='https://acp.example.com'
export ACPAO_PAIR_CODE='从 UI 取得的一次性配对码'
export ACPAO_ROOT='/srv/work'
# 可选：一个 Agent 配置数组文件，便于首次配对直接注册 Agent
export ACPAO_AGENTS='/secure/agents.json'
./acpao-gateway-linux-x64 --pair
```

示例 `agents.json`：

```json
[{ "id": "codex", "name": "Codex", "command": "/usr/local/bin/codex-acp", "args": [], "env": {} }]
```

设备身份保存在 `.gateway/config.json`（0600），执行日志与 Session 关联保存在 `.gateway/gateway-go.sqlite`。若首次未提供 Agent 配置，在 `config.json` 中填写 `agents` 后重启 Gateway。Gateway 只使用本机配置中的可执行程序；中心无法通过远程指令替换它。

Gateway 主动建立 WSS，无需远端公网 IP，不依赖 VPN。仅同机开发可设置 `ACPAO_INSECURE_LOCAL=1` 使用 loopback HTTP。日常运行 `./acpao-gateway-linux-x64 --daemon`，manager 会重启异常退出的 worker；Docker 中使用 `--foreground` 并设置容器 restart policy。需要 SSH 跳板时，配对前设置 `ACPAO_SSH_JUMP` 和 `ACPAO_SSH_TARGET`，后者为能访问中心地址的 SSH 目标；配置会存入设备文件，TLS 主机名仍按中心原地址校验。

Gateway manager 运行时，可用 `./acpao-gateway-linux-x64 --upgrade ./新版本二进制` 暂存更新。它会等待当前 Prompt 完成，再停止旧 worker、启动新版本并通过 `session/load` 恢复可恢复的历史。升级过程中暂时不接收新指令；中心会在重连后重发尚未确认的指令。Docker 前台模式由容器编排器滚动更新。

网断时本地 ACP 进程继续，关键事件持久化；重连按序号补发、中心事务去重。未确认的控制指令沿用稳定 ID 重发，Gateway 持久化执行回执，避免重复执行。Gateway **进程崩溃**时 stdio 不可恢复：启动后如实标记中断，不重放未知副作用；Agent 声明支持 `session/load` 时可以手动恢复历史并发送新的指令。

主机的「身份管理」可撤销访问或轮换、下载恢复凭据。轮换立即使旧凭据失效；在目标设备先停止旧 Gateway，再执行：

```bash
./acpao-gateway-linux-x64 --import-identity /secure/identity.json
```

恢复设备身份、恢复中心数据库、恢复 Agent 本地历史是三件不同的事。设备凭据泄露应立即轮换或撤销。撤销阻止连接与中心操作，不会远程杀死设备上已有进程。

## 工作目录、数据与安全

- `ACPAO_ROOT` 是允许分配的根目录，默认项目根目录。创建时要求绝对路径，解析真实路径后校验边界，拒绝符号链接逃逸。该检查只是 cwd 分配限制，**不是 OS 文件访问沙箱**。
- 按需勾选 Git worktree 隔离，创建 detached worktree 到源仓库 `.acpao-worktrees/`；保留工作成果，不自动删除。它不是独立文件权限边界。
- 中心只在 SQLite 中维护本地执行事实或远端事件投影；远端执行状态以 Gateway 为来源。主机离线时 UI 说明状态尚未确认，不虚构完成或失败。
- 中心原始协议事件保留 30 天，可读对话独立保存；历史分页返回实际下一游标和 `truncatedBefore`。Gateway 仅删除超过 30 天且**已被中心确认**的日志前缀，未确认事件保留。若恢复的中心游标早于 Gateway 保留范围，会停止同步并报告缺口，要求恢复匹配备份，不静默跳过。
- 中心设备/Agent/Cookie 凭据只存 SHA-256 哈希；首次管理员密钥文件和 Gateway 配置由文件权限保护。人工配置的 Agent 环境凭据属于必要启动配置，仍保存在受限 SQLite/文件中，应结合专门 OS 用户和磁盘加密保护。
- UI 使用 HttpOnly、SameSite=Strict Cookie（HTTPS 下 Secure），登录及配对限流，校验跨域 Origin。日志隐藏认证头和 Cookie；控制操作有审计。管理员登录密钥改变后重启中心会使旧管理员凭据失效。
- 所有 ACP 权限默认需要人类确认，5 分钟不响应自动取消。Agent 自己在操作系统中能做什么取决于其账号和沙箱，ACP 权限并非完整的危险动作拦截器。
- 原始审计保留 90 天；Session/对话/指令去重回执保留以供追溯。MVP 没有自动归档和删除 Session 历史功能。

架构与事实来源见 [docs/architecture.md](docs/architecture.md)。工程实现范围、验证结果与剩余限制见 [docs/implementation.md](docs/implementation.md)。
