# 部署与恢复

## 中心

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

目标主机下载 Release 中匹配平台的 `acpao-gateway-*` 可执行文件。`--config` 可指定配置文件路径，默认 `.gateway/config.json`。设备配置目录与 `gateway-go.sqlite` 必须持久保存；Agent 自身的安装与登录资料需另行保存。

首次配对需要先通过中心 UI 生成一次性配对码；不要把中心管理员密钥复制给 Gateway。SSH 自动上传、安装 Agent 和远程登录 UI 尚未实现；目前由人类通过 SSH 或目标设备终端执行明确命令。

普通主机可运行 `acpao-gateway-linux-x64 --daemon`：manager 监视 worker 并在退出后重启。Docker 容器内使用 `--foreground`，由容器 restart policy 管理整个进程。跳板连接可在配对时设置 `ACPAO_SSH_JUMP` 和 `ACPAO_SSH_TARGET`，Gateway 使用系统 `ssh -J` 建立本地转发，HTTPS/TLS 仍按中心原域名校验。该模式要求 SSH 密钥、已信任的主机指纹和目标机器上的 `ssh` 命令预先可用。不要把凭据写进启动参数和日志。

## 备份与恢复

- **中心**：停止服务后备份整个 `.data`（数据库、必要密钥文件）；在线备份需用 SQLite 正式备份机制，不能单独拷贝 WAL 活跃时的主文件。
- **Gateway**：备份整个 `.gateway`，包含设备身份和 Go SQLite 执行日志。备份 Agent 自己的本地历史/登录目录和工作目录是另外的操作。
- **身份恢复**：下载的 JSON 仅恢复设备 Host ID 和 token。轮换后将其通过 `--import-identity` 导入已有配置；不会重建丢失的执行日志。
- **中心重启**：本地会话标记中断，远端主机先标记离线；Gateway 重连同步后更新远端会话，不自动重复 Prompt。
- **Gateway 重启**：未知执行结果标记中断；真实 `session/load` 只恢复历史，当前 Prompt 不自动恢复。
- **中心旧备份晚于日志保留界限**：Gateway 会报告同步缺口。先恢复合适的中心备份，必要时人工对照网关本地可读历史恢复工作；MVP 不会自动合并互相矛盾的备份。

## 当前验证范围

实际验证了本机独立中心/网关进程间协议与回放；远端 Linux 实机、公开证书反代和 Docker 部署尚未现场验证。这些配置是可复用的部署入口，不能视作已完成环境验收。
