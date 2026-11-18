# 部署与恢复

## 中心

Release 的 `acpao-open-*` 是受监督的 UI 启动器。Windows 构建为 GUI 子系统，启动中心时隐藏控制台；直接运行 `acpao-windows-x64.exe` 保留命令行输出，适合无浏览器设备与故障排查。启动器与同平台中心二进制必须放在同一目录。诊断页提供“等待完成后重启”：中心停止接收新写入、等待本机 Prompt 完成、退出后由启动器重新启动。远程 Gateway 在这段时间继续本地工作并重连。启动器不会记录带授权 token 的启动 URL。

先运行 `npm ci && npm run build`。建议以专门 OS 用户运行 Node，项目、Agent 凭据、工作根目录与 SQLite 目录都由该账户管理，避免用 root 运行生产 Agent。

环境变量：

| 变量                | 默认 / 含义                                         |
| ------------------- | --------------------------------------------------- |
| `HOST`              | `127.0.0.1`，默认仅本机监听                         |
| `PORT`              | `4310`                                              |
| `ACPAO_ROOT`        | 允许的工作根目录，默认项目目录                      |
| `ACPAO_DATA_DIR`    | `.data`，持久保存；权限 0700                        |
| `ACPAO_ADMIN_TOKEN` | 可省略，自动生成 `.data/admin-token`                |
| `ACPAO_PUBLIC_URL`  | 外部 HTTPS 基址，供 Cookie 和 Agent 桥使用          |
| `ACPAO_TRUST_PROXY` | 仅可信反向代理前设置 `1`，使 Fastify 正确认识 HTTPS |

例如中心只在 loopback 监听，由 Caddy 终止 TLS：

```bash
ACPAO_PUBLIC_URL=https://acp.example.com \
ACPAO_TRUST_PROXY=1 \
ACPAO_ROOT=/srv/work \
ACPAO_DATA_DIR=/var/lib/acpao \
npm start
```

Caddy 示例（自行配置 DNS，**不是代码内自建 TLS 或 VPN**）：

```caddyfile
acp.example.com {
    reverse_proxy 127.0.0.1:4310 {
        flush_interval -1
    }
}
```

Caddy 负责成熟 TLS、WebSocket Upgrade；SSE 禁止代理缓冲。不要同时向不可信网络公开可以伪造 `X-Forwarded-*` 的中心监听口。非 loopback 监听时，启动脚本要求配置 HTTPS 公共地址，但该检查本身不负责配置 TLS，生产仍需正确反代。

Dockerfile 提供可选 Node 镜像入口，默认普通 `node` 用户。镜像不会自带你的主机 Agent 或认证；要使用容器内安装的适配器和专门挂载的工作根目录。未在当前环境执行 Docker 镜像构建，主流程使用本机 Node 验证。

## Gateway

### 通过 SSH 添加

在「主机 → 配对主机 → 通过 SSH 添加」填写远程主机的 SSH 别名或 `user@host`。中心使用运行该服务的账户的 OpenSSH 配置、密钥或 ssh-agent。首次使用前，请从中心机器核对目标与跳板的主机指纹，并保存到该账户的 `known_hosts`。可选的 `ACPAO_SSH_CONFIG` 指定中心使用的 SSH 配置文件。

目标也支持 SSH 密码认证。密码经 AES-GCM 加密保存在中心，用于重启后恢复反向隧道。中心数据备份应保留 `ssh-secrets/key`，并与数据库一起限制访问。撤销主机会删除该主机的加密密码。密码用于目标主机，SSH 跳板继续使用中心已有的密钥配置。使用密码时，目标公钥需要已存在于 `known_hosts`。

中心自动识别 Linux x64、Linux ARM64 或 Windows x64，从当前中心二进制解压对应 Gateway 并通过 SSH 上传。远程机器无需访问 GitHub，也无需 Node.js 或 zstd。用于编译中心二进制的 Node.js 与 Go 只需要在构建机器上可用。源码开发模式可先运行 `npm run build:gateway-assets`。

SSH 服务端需要允许反向 TCP 转发，使用 `GatewayPorts no` 或 `clientspecified`。中心只转发 Gateway 用到的接口，并自动生成和固定隧道内部的 TLS 证书。中心可以维持默认的本机 HTTP 地址，无需公网 HTTPS 或证书。中心重启会从 SQLite 重新建立隧道。已完全离线的 Gateway 继续执行本地工作，连接恢复后补发事件。

部署文件位于远程 SSH 用户家目录下的 `.acpao/gateways/<主机 ID>/`，工作根目录默认是该用户的家目录。平台会尝试发现该账户 PATH 内的 `codex-acp` 和 `opencode`。其他 Agent 先以运行 Gateway 的用户完成安装与登录，再从「主机 → 远程主机 → 添加 Agent」填写启动命令（例如 `opencode acp`）并测试。Gateway 在远端打开 ACP 会话验证后保存配置。旧版 Gateway 仍可编辑 `state/config.json` 后按原方式重启，升级后可使用界面。

Windows 上可以填写 `.cmd` 或 `.bat` 启动程序。带空格的路径和参数请加引号。如果参数包含 CMD 特殊字符，请使用真实的 `.exe`，或用 `node.exe` 直接启动 ACP JavaScript 适配器。

### 手动添加

目标主机下载 Release 中匹配平台的 `acpao-gateway-*` 可执行文件。`--config` 可指定配置文件路径，默认 `.gateway/config.json`。设备配置目录与 `gateway-go.sqlite` 必须持久保存；Agent 自身的安装与登录资料需另行保存。

手动配对需要先通过中心 UI 生成一次性配对码，并填入目标主机可访问的中心 HTTPS 地址。Gateway 状态目录在 Unix 下限制为 0700；Windows 下通过系统 `icacls` 限制继承和当前用户权限。自定义 `--config` 路径应放在专用目录中。

普通主机可运行 `acpao-gateway-linux-x64 --daemon`：命令返回终端，后台 manager 监视 worker 并在退出后重启。`--stop` 结束后台 manager；`--manager` 用于前台诊断。Docker 容器内使用 `--foreground`，由容器 restart policy 管理整个进程。跳板连接可在配对时设置 `ACPAO_SSH_JUMP` 和 `ACPAO_SSH_TARGET`，Gateway 使用系统 `ssh -J` 建立本地转发，HTTPS/TLS 仍按中心原域名校验。该模式要求 SSH 密钥、已信任的主机指纹和目标机器上的 `ssh` 命令预先可用。不要把凭据写进启动参数和日志。

有 manager 时，运行 `acpao-gateway-linux-x64 --upgrade /path/to/new-binary`。候选二进制会复制到受限版本目录并通过 `--version` 验证；worker 等待执行中的 Prompt 结束后退出，manager 启动新文件。不会重放不确定结果的 Prompt；Agent 若不支持 `session/load`，其历史会话仍需人工处理。

## 备份与恢复

- **中心**：停止服务后备份整个 `.data`（数据库、必要密钥文件）；在线备份需用 SQLite 正式备份机制，不能单独拷贝 WAL 活跃时的主文件。
- **Gateway**：备份整个 `.gateway`，包含设备身份和 Go SQLite 执行日志。备份 Agent 自己的本地历史/登录目录和工作目录是另外的操作。
- **身份恢复**：下载的 JSON 仅恢复设备 Host ID 和 token。轮换后将其通过 `--import-identity` 导入已有配置；不会重建丢失的执行日志。
- **中心重启**：本地会话标记中断，远端主机先标记离线；Gateway 重连同步后更新远端会话，不自动重复 Prompt。
- **Gateway 重启**：未知执行结果标记中断；真实 `session/load` 只恢复历史，当前 Prompt 不自动恢复。
- **中心旧备份晚于日志保留界限**：Gateway 会报告同步缺口。先恢复合适的中心备份，必要时人工对照网关本地可读历史恢复工作；MVP 不会自动合并互相矛盾的备份。

## 当前验证范围

Linux x64 已用独立 OpenSSH 服务验证中心二进制上传内置 Gateway、本地 HTTP 中心搭建反向隧道以及中心重启后的事件恢复。SSH 部署到 Windows 与 Linux ARM64 已完成交叉构建，仍需目标实机验收。
