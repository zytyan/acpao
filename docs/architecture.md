# ACPAO 实施记录

中心采用 Node.js 24 + TypeScript strict + Fastify + node:sqlite（WAL），前端为 React/Vite/Tailwind；远端 Gateway 使用 Go。中心不调用模型 API。稳定 ACP v1 接口以安装包声明为准；MCP 使用正式 1.x SDK。每个会话独立进程，平台 ID 与 ACP ID 分开；Steering 只在 Agent 的 `_meta.steering.supported` 明确声明后使用。

中心：Host 身份、Session 目录、指令投递、中心事件游标、审批与审计。执行端（本地 Runtime / Gateway）：ACP 连接、执行状态、串行队列、权限等待、原始事件。远程状态只经带序号的执行端事件更新中心投影。网关指令稳定 ID，落盘后应答；重试返回原结果，崩溃中的指令标记 interrupted，绝不自动重放副作用。

人类由管理密钥登录 HttpOnly Cookie；Agent 使用独立、可撤销、限制到源 Host 的委派凭据，只可访问自己及委派的 Session，不能配对、配置命令或审批。网关使用独立设备凭据，数据库仅存哈希；一次性配对码与长期身份分离。远程连接必须 HTTPS/WSS，开发仅容许显式启用的 loopback HTTP。ACP 权限不是 OS 沙箱，生产应以独立 OS 账户或容器运行。

## 纵向切片

- [x] 1：真实 ACP 连接、SQLite、流式对话、主会话、会话列表、首次引导。
- [x] 2：MCP 五工具、幂等指令、排队、权限、取消、恢复与自动化集成测试。
- [x] 3：出站网关、配对、断线重连、本地 WAL 与事件补发。
- [ ] 4：主机管理、主题、键盘、Markdown、部署说明与 UI 验证已完成；SSH 自动部署与 Web 内 Agent 登录仍待实现。

不实现 DAG、模型网关或自动任务规划。SSH Bootstrap 优先采用可审阅的安装命令，不接收或保存 SSH 私钥。恢复身份不等于恢复数据库或 ACP 本地数据。事件分页与保留策略应保留可读对话，删除旧原始事件后显式返回游标缺口。

阶段 3 的勾选表示实现和同机网络模拟验收完成，非远端实机 TLS 验收。阶段 4 尚有 SSH 自动部署与 Web 内登录未实现，详见 [实施结果](implementation.md)。
