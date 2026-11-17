# 实施结果与验证边界

本文件的早期阶段记录仍保留在下方；当前新增能力以本节为准。Go Gateway 已从中心二进制分离，Release 会分别提供 Windows x64、Linux x64/ARM64 可执行文件。Agent 配置支持编辑、启动前测试、Shell 风格命令和环境变量输入；日志与诊断可查询 180 天。ACP `_session/steering` 依据 Agent initialize `_meta` 探测后启用，可将排队消息转为引导。支持 `session/load` 的本地 Agent 进程退出后会尝试自动恢复历史会话，正在执行的 Prompt 不重放。

Go Gateway 使用独立 SQLite 持久化指令回执和有序事件，断线后继续本地执行并补发事件；worker 重启时将未完成指令标记中断，支持历史恢复。支持 `ssh -J` 跳板与独立 manager/worker 模式，Docker 使用前台模式。远端 ACP Agent 通过 Go 内置 stdio MCP 桥调用中心工具。Go Gateway 的本机端到端测试覆盖配对、会话、委派、断线、去重及重启恢复；公开 TLS、真实 SSH 跳板与跨机器部署仍待现场验证。Go Gateway 暂不支持自动 Git worktree 分配，选择该选项会明确报错。

## 1. 本地闭环：已实现并验证

- 从空仓库建立轻量 Monorepo；Node.js 24、TypeScript strict、Fastify、SQLite WAL、React/Vite/Tailwind。
- 官方 ACP SDK **2.7.0** 的稳定 v1 app API 已按安装包声明核实；MCP 使用正式 SDK **1.32.2**。依赖固定版本、保存 lockfile。
- 真实 stdio Agent 进程、初始化与能力协商、平台/ACP Session ID 分离、独立 cwd、流式持久化、多独立 Session、主 Session。
- Web 登录、首次引导、工作区、会话列表和会话对话；SSE 断线重连；Markdown、代码块、Checklist、动态历史分页与大历史列表虚拟化；亮暗主题、移动布局、键盘搜索、错误与空状态。
- 当前环境实际启动 **`@agentclientprotocol/codex-acp@2.7.0`** 并通过本平台 Runtime 完成 initialize + session/new，返回 idle、有效 ACP ID、load=true。**未发送真实模型 Prompt**，不能把它描述为已完成真实模型生成内容验收。

## 2. Agent 委派：已实现并通过集成测试

- MCP `delegate/send/wait/sessions/hosts`，同时提供 stdio 桥和 Streamable HTTP 入口；Schema、授权、审计共用。
- Agent 获得 Session 作用域的独立凭据，只可管理来源 Host 上的自己和委派后代，不能审批或修改主机配置。
- Mock 主 ACP Agent 通过真正的 MCP stdio 子进程创建另一 ACP Session、发送指令、等待真实完成输出，再向用户 Session 流式汇报；没有平台生成摘要或模型 API 调用。
- 串行 Prompt 队列、全局并发限制、重复指令校验、并发委派请求预约去重、远程并发重复请求共享回执；Steering 仅在 Agent 明确声明后启用，忙时 immediate 返回错误。
- 人工 ACP 审批、取消等待、超时终止进程、进程退出检测与资源清理、按真实 load 能力手动恢复。关闭会话后撤销其委派凭据。

## 3. Gateway：已实现；本机模拟远端验证通过

- 独立 Node Gateway 主动连接中心，支持 WSS、设备身份、一次性配对、单设备撤销、轮换、导出及 CLI 导入身份。
- Gateway 启动程序只来自本机配置；工作目录真实路径边界校验；中心不把本机管理员秘密传入 Agent。
- 指令 ID、持久化执行回执、执行前标记、未知结果不自动重放；序号事件日志、事务去重、确认游标、断网本地继续、指数退避重连与对账。
- Gateway 重启标记中断，恢复元数据不冒充恢复正在执行的 Prompt；中心重启将本地执行标记中断、远端等待网关重新提供事实。
- 中心原始事件 30 天保留；网关只清理已确认、超过 30 天的前缀，保留同步缺口标记。对话独立保存，游标不会因清理回退。
- 实际验证使用同机独立中心/Gateway Runtime 和单独 SQLite 文件、真实 TCP/WebSocket、真实 ACP 子进程，主动断开连接后补发、去重、重启和手动 load。**尚未连接另一台 Linux 实机，也未现场验证公开 TLS 部署。**

## 4. 首次体验与部署：部分实现

已实现首次引导、Agent 启动程序检测/手工配置、本地配对命令、身份管理、主题与交互完善、完整中文文档及 Dockerfile。

明确未实现 / 未验收：

- SSH 自动上传和部署 Gateway，远程自动安装 Agent。
- Web 内交互式 Agent 登录；首次认证仍在主机终端完成。
- SSH 私钥管理、企业多租户、自动任务规划、DAG、VPN/NAT 协议（均不在此 MVP）。
- ACP HTTP(S) 入口仍待实现；目前 `/mcp` 是 MCP HTTP 入口，不应称作 ACP。
- 运行中 Prompt 的进程级容错或自动重放；Agent 历史恢复依赖真实能力。
- Docker 镜像与真实远端公开证书部署现场验收。
- 完整事件历史的自动归档导入、自动清除工作树和 Session 数据；目前保留去重回执与可读历史供追溯。
- 大规模、多天断线与万级 Session 压力测试；目前是单中心 SQLite 的小型协作环境。

## 验证

运行命令与测试用例均保存在仓库，不依赖模型额度：

- `npm run typecheck`：通过，中心、Gateway、核心包及 Web 严格类型检查。
- `npm run build`：通过，生成可执行服务与 Web 静态产物。
- `npm test`：**23 项通过**。覆盖生命周期、ACP ID 隔离、真实流式更新、同会话排队、强语义错误、取消与非配合取消、Prompt 超时、实际 Agent 进程退出、人工审批、路径/符号链接限制、实际 Git worktree 修改隔离、重启历史与 load、HTTP/Cookie/Origin/Agent 作用域、MCP 五工具、主 Agent 实际 MCP 委派、并发委派去重、多 Session wait、SSE 关闭清理、网关配对/断线继续/补发/去重/重启对账、TLS 边界、事件保留与游标单调性。
- `npm run test:ui`：Playwright 完整用户流程通过，覆盖登录、空安装配置、主对话、Checklist、审批、委派、第二会话、取消、快速查找、主机配对、暗色/亮色主题、390px 移动布局。浏览器异常列表为空。
- `npm run probe:agent`：真实 Codex ACP 适配器初始化与新 Session 兼容性通过；没有发送模型 Prompt。

UI 截图由 Playwright 写入 `test-results/workspace-{light,dark,mobile}.png`。浏览器测试使用临时数据目录；测试结束后关闭自有服务并删除临时运行数据，不把 Mock 状态或配对凭据写入用户生产配置。

生产入口检查也通过：直接运行 dist/apps/server/src/main.js，页面 200，匿名业务 API 401，Cookie 登录 200，认证配置 API 200，空安装正确返回首次引导状态；检查结束后已关闭自有服务。
