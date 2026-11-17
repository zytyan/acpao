# 实施与验证

## 第一阶段：本地工作区

中心为 Node.js 24、TypeScript strict、Fastify 和 SQLite WAL；前端为 React/Vite。每个 Session 使用独立 ACP Agent 进程，分别保存平台 Session ID、ACP Session ID 和进程 ID。工作区、会话列表、主机页、首次引导、流式消息、Markdown、主题、移动布局及历史分页均已实现。

Agent 配置可在添加后编辑。添加或保存前会检查程序并尝试完成 ACP initialize 和 session/new，失败不会保存。命令使用单行 Shell 风格参数解析，不执行 Shell；环境变量逐行按第一个等号切分，默认继承进程环境，并支持 `$VAR` 和 `${VAR}` 引用。Windows 主机在空命令栏粘贴绝对路径时会转为正斜杠，空格路径加引号；气泡按钮和 Ctrl+Z 都能撤销该次修改。

真实 `@agentclientprotocol/codex-acp@2.7.0` 已在本环境完成 initialize 和 session/new。**未使用真实模型额度发送 Prompt**；真实模型输出的端到端验收仍需用户配置已登录的 ACP Agent 后执行。

## 第二阶段：委派与协议

MCP `delegate`、`send`、`wait`、`sessions`、`hosts` 通过 stdio 桥和 `/mcp` 提供，共用授权和审计。可控 Mock 主 Agent 已通过真正的 MCP 调用创建子 Session、等待结果并向用户输出。指令、队列、权限请求、取消、超时、幂等检查和并发限制由确定性代码处理。

ACP `_session/steering` 使用独立扩展 Schema，仅在 Agent 的 initialize `_meta.steering.supported` 为 true 时调用。明确要求 Steering 而未成功时返回错误；自动模式可回退到排队。会话内的排队消息可在本地或 Go Gateway 上转为引导。中心另以官方 SDK Streamable HTTP transport 提供受认证保护的 `/acp`，已用官方 HTTP 客户端验证创建 Session、文本 Prompt 和流式输出。外部 ACP 客户端传入 MCP Server 或非文本 Prompt 会收到明确错误。

## 第三阶段：远程 Gateway

Go Gateway 为独立可执行文件，支持 Linux x64、Linux ARM64、Windows x64。它通过 WSS 主动连接中心，使用每设备独立凭据与一次性配对码，SQLite 保存指令回执、Session 关联与有序事件。断线后已有 ACP Prompt 可继续；重连后补发事件和去重。重启时未完成 Prompt 标记中断，不重放副作用；Agent 声明 `session/load` 时尝试恢复历史。内置 Go stdio MCP 桥支持远程主 Agent 委派。支持系统 `ssh -J` 跳板连接、manager/worker 监护、Docker 前台模式，以及等待 Prompt 完成后切换暂存新二进制。

同机端到端测试覆盖配对、ACP 对话、MCP 委派、Steering、断线重连、事件去重、重启恢复和升级排空。公开 TLS、真实 SSH 跳板、另一台机器及 Windows 运行时尚未现场验收。Go Gateway 对自动 Git worktree 分配返回明确不支持。旧 TypeScript Gateway 数据库与 Go Gateway 的数据库格式不同，迁移前应备份设备配置和本地日志；Go 版不会把旧数据库冒充已导入。

## 第四阶段：使用体验与发布

诊断页提供可查询的结构化日志、测试 Agent 开关和受监督模式下的重启入口。日志按 180 天与 10 万条上限保留。Agent 进程退出后，本地会话仅在其真实支持 `session/load` 时尝试自动恢复；正在执行的 Prompt 不重放。Windows Release 的 `acpao-open-windows-x64.exe` 是 GUI 子系统启动器，不留控制台；中心 CLI 程序仍可在无浏览器环境打印授权 URL。Release 同时提供三平台中心、Gateway 与启动器二进制。

当前仍需人工完成远端 Gateway 下载与首次配对、ACP Agent 安装/登录。SSH 自动部署和 Web 内 Agent 登录尚未实现。Docker 镜像、公开证书部署和长期压力测试尚未在本环境验收。ACP 权限请求不是 OS 沙箱，部署时仍需使用合适的系统账户或容器隔离。

## 验证记录

本机最近一次完整回归：`npm run typecheck`、`npm run build`、`npm test`（34 项通过，启用 `GO_GATEWAY_BIN`）和 `npm run test:ui`（4 项通过）。自包含中心二进制完成 ACP HTTP 冒烟测试。Go Gateway 和启动器已交叉编译 Linux x64/ARM64、Windows x64；Windows 启动器的 PE 类型为 GUI。可控测试不调用付费模型。发布前仍会再运行一次完整回归，并以 GitHub Actions 构建产物为最终发布验证。
