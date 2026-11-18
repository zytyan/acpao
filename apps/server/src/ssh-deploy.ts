import { spawn } from "node:child_process";
import { request, type Server } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { generate } from "selfsigned";
import { id, secret, type Store } from "../../../packages/core/src/store.js";
import { AppError, type Host } from "../../../packages/core/src/types.js";
import { gatewayBinary, type GatewayPlatform } from "./gateway-assets.js";
import {
  SshPasswordVault,
  execWithPassword,
  passwordTunnel,
  resolvePasswordTarget,
  sshConfigArgs,
  sshProcessEnv,
  type SealedPassword,
  type SshTarget,
} from "./ssh-password.js";

const address = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.:-]*|\[[a-fA-F0-9:]+\])$/,
    "请输入 SSH 主机别名或 user@host",
  );
export const sshDeploySchema = z.object({
  name: z.string().trim().min(1).max(100),
  target: address,
  port: z.number().int().min(1).max(65535).optional(),
  jump: address.optional(),
  root: z.string().trim().max(1024).optional(),
  password: z.string().min(1).max(1024).optional(),
});
type Tunnel = SshTarget & { host: string; portAtGateway: number; sealedPassword?: SealedPassword };
type RunCommand = (command: string, stage: string, input?: Buffer | string) => Promise<string>;

function sshArgs(target: SshTarget, forward?: string) {
  return [
    ...sshConfigArgs(),
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(target.jump ? ["-J", target.jump] : []),
    ...(forward
      ? ["-o", "ExitOnForwardFailure=yes", "-N", "-R", forward]
      : ["-o", "ClearAllForwardings=yes"]),
    "--",
    target.target,
  ];
}
function runSSH(target: SshTarget, command: string, stage: string, input?: Buffer | string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target), command], {
      env: sshProcessEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(45000),
    });
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("error", (err) =>
      reject(
        new AppError(
          "SSH_FAILED",
          err.name === "AbortError" ? stage + "超时" : "无法启动 OpenSSH 客户端",
          502,
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) return resolve(output.trim());
      const hint =
        /host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
          error,
        )
          ? "。请核对指纹并把主机密钥加入中心账户的 known_hosts"
          : /permission denied/i.test(error)
            ? "。请检查 SSH 用户、密钥或 ssh-agent"
            : "";
      reject(new AppError("SSH_FAILED", stage + "失败" + hint, 502));
    });
  });
}

const powerShell = (script: string) =>
  "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
  Buffer.from(script, "utf16le").toString("base64");

async function platformFor(run: RunCommand): Promise<GatewayPlatform> {
  let linux: string | undefined;
  try {
    linux = await run("uname -sm", "读取目标平台");
  } catch (err) {
    if (err instanceof AppError && err.message.includes("。")) throw err;
  }
  if (linux && /^Linux\s+(x86_64|amd64)$/im.test(linux)) return "linux-x64";
  if (linux && /^Linux\s+(aarch64|arm64)$/im.test(linux)) return "linux-arm64";
  if (!linux || /windows|mingw|msys|cygwin/i.test(linux)) {
    const windows = await run(
      powerShell(
        "[Console]::WriteLine([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)",
      ),
      "读取目标平台",
    );
    if (/^x64$/im.test(windows)) return "windows-x64";
  }
  throw new AppError(
    "SSH_PLATFORM_UNSUPPORTED",
    "目标平台不受支持。请选择 Linux x64、Linux ARM64 或 Windows x64。",
    422,
  );
}

function gatewayCommands(host: string, platform: GatewayPlatform) {
  if (platform === "windows-x64") {
    const directory = `$ErrorActionPreference='Stop'; $d=Join-Path $env:USERPROFILE '.acpao\\gateways\\${host}';`;
    return {
      upload: powerShell(
        directory +
          `
        New-Item -ItemType Directory -Force -Path $d | Out-Null;
        $temp=Join-Path $d 'gateway.tmp'; $file=[IO.File]::Create($temp);
        try { [Console]::OpenStandardInput().CopyTo($file) } finally { $file.Dispose() }
        Move-Item -LiteralPath $temp -Destination (Join-Path $d 'acpao-gateway.exe');
      `,
      ),
      provision: powerShell(
        directory +
          `
        & (Join-Path $d 'acpao-gateway.exe') --provision --config (Join-Path $d 'state\\config.json');
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & (Join-Path $d 'acpao-gateway.exe') --daemon --config (Join-Path $d 'state\\config.json');
        exit $LASTEXITCODE;
      `,
      ),
    };
  }
  const script = (command: string) =>
    `sh -c 'umask 077; d="$HOME/.acpao/gateways/${host}"; ${command}'`;
  return {
    upload: script(
      'mkdir -p "$d" && cat > "$d/gateway.tmp" && chmod 700 "$d/gateway.tmp" && mv "$d/gateway.tmp" "$d/acpao-gateway"',
    ),
    provision: script(
      '"$d/acpao-gateway" --provision --config "$d/state/config.json" && "$d/acpao-gateway" --daemon --config "$d/state/config.json"',
    ),
  };
}

export class SshDeploy {
  private readonly tunnels = new Map<string, AbortController>();
  private proxy?: HttpsServer;
  private proxyStarting?: Promise<{ port: number; cert: string }>;
  private readonly proxySockets = new Set<Socket>();
  private readonly passwords: SshPasswordVault;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly center: Server,
    private readonly project: string,
    data: string,
  ) {
    this.passwords = new SshPasswordVault(data);
  }

  restore() {
    for (const tunnel of this.store.all<Tunnel>("ssh-tunnel")) {
      const host = this.store.get<Host>("host", tunnel.host);
      if (host && host.status !== "revoked") this.start(tunnel);
    }
  }

  private ingress() {
    if (this.proxyStarting) return this.proxyStarting;
    this.proxyStarting = this.createIngress().catch((err) => {
      this.proxyStarting = undefined;
      throw err;
    });
    return this.proxyStarting;
  }

  private async createIngress() {
    const center = this.center.address();
    if (!center || typeof center === "string")
      throw new AppError("SSH_CENTER_UNAVAILABLE", "中心需要先启动 HTTP 监听", 503);
    const hostname =
      center.address === "0.0.0.0" ? "127.0.0.1" : center.address === "::" ? "::1" : center.address;
    const saved = this.store.get<{ cert: string; key: string }>("ssh-ingress", "certificate");
    let credentials = saved;
    if (!credentials) {
      const now = new Date();
      const pair = await generate([{ name: "commonName", value: "ACPAO SSH Gateway ingress" }], {
        algorithm: "sha256",
        keyType: "ec",
        curve: "P-256",
        notBeforeDate: new Date(now.getTime() - 3600000),
        notAfterDate: new Date(now.getFullYear() + 10, now.getMonth(), now.getDate()),
        extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
      });
      if (this.stopped) throw new Error("SSH ingress stopped");
      credentials = { cert: pair.cert, key: pair.private };
      this.store.put("ssh-ingress", "certificate", credentials);
    }
    const { cert, key } = credentials;
    const proxy = createServer({ cert, key, minVersion: "TLSv1.2" }, (req, res) => {
      const authorization = req.headers.authorization;
      const role = authorization?.startsWith("Bearer ")
        ? this.store.authenticate(authorization.slice(7))?.kind
        : undefined;
      const path = req.url ?? "";
      const deviceTokenRequest =
        role === "device" && req.method === "POST" && path === "/api/gateway/session-token";
      const agentToolRequest =
        role === "agent" &&
        ((req.method === "GET" && path === "/api/tool-schema") ||
          (req.method === "POST" &&
            (path === "/mcp" || /^\/api\/tools\/(delegate|send|wait|sessions|hosts)$/.test(path))));
      if (!authorization || !(deviceTokenRequest || agentToolRequest)) {
        res.writeHead(404).end();
        return;
      }
      const upstream = request(
        {
          hostname,
          port: center.port,
          method: req.method,
          path,
          headers: {
            authorization,
            ...(req.headers["content-length"]
              ? { "content-length": req.headers["content-length"] }
              : {}),
            ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
            ...(req.headers.accept ? { accept: req.headers.accept } : {}),
            ...(req.headers["mcp-protocol-version"]
              ? { "mcp-protocol-version": req.headers["mcp-protocol-version"] }
              : {}),
          },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    proxy.on("connection", (socket) => {
      this.proxySockets.add(socket);
      socket.on("close", () => this.proxySockets.delete(socket));
    });
    proxy.on("upgrade", (req, socket, head) => {
      const {
        authorization,
        upgrade,
        "sec-websocket-key": key,
        "sec-websocket-version": version,
      } = req.headers;
      if (
        req.url !== "/gateway" ||
        req.method !== "GET" ||
        upgrade?.toLowerCase() !== "websocket" ||
        !authorization ||
        typeof key !== "string" ||
        !/^[a-zA-Z0-9+/]{22}==$/.test(key) ||
        version !== "13"
      ) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connect(center.port, hostname, () => {
        upstream.write(
          "GET /gateway HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " +
            key +
            "\r\nAuthorization: " +
            authorization +
            "\r\n\r\n",
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    this.proxy = proxy;
    return new Promise<{ port: number; cert: string }>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        const bound = proxy.address();
        if (!bound || typeof bound === "string") reject(new Error("SSH ingress unavailable"));
        else resolve({ port: bound.port, cert });
      });
    });
  }

  private start(tunnel: Tunnel) {
    if (this.stopped || this.tunnels.has(tunnel.host)) return;
    const controller = new AbortController();
    const { signal } = controller;
    this.tunnels.set(tunnel.host, controller);
    void (async () => {
      let backoff = 500;
      while (!signal.aborted) {
        const started = Date.now();
        try {
          const { port } = await this.ingress();
          if (signal.aborted) break;
          if (tunnel.sealedPassword) {
            const password = await this.passwords.open(tunnel.host, tunnel.sealedPassword);
            const destination = await resolvePasswordTarget(tunnel);
            await passwordTunnel(destination, password, tunnel.portAtGateway, port, signal);
          } else {
            const child = spawn(
              "ssh",
              sshArgs(tunnel, `127.0.0.1:${tunnel.portAtGateway}:127.0.0.1:${port}`),
              {
                env: sshProcessEnv(),
                windowsHide: true,
                stdio: ["ignore", "ignore", "ignore"],
                signal,
              },
            );
            await new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              child.once("error", () => resolve());
            });
          }
        } catch {
          // Retry an unavailable ingress with the same remote port.
        }
        if (Date.now() - started > 30000) backoff = 500;
        await delay(backoff, undefined, { signal }).catch(() => {});
        backoff = Math.min(backoff * 2, 15000);
      }
      if (this.tunnels.get(tunnel.host) === controller) this.tunnels.delete(tunnel.host);
    })();
  }

  remove(host: string) {
    this.tunnels.get(host)?.abort();
    this.tunnels.delete(host);
    this.store.remove("ssh-tunnel", host);
  }

  close() {
    this.stopped = true;
    for (const tunnel of this.tunnels.values()) tunnel.abort();
    for (const socket of this.proxySockets) socket.destroy();
    if (this.proxy) this.proxy.close();
  }

  async deploy(input: z.infer<typeof sshDeploySchema>, actor: Parameters<Store["audit"]>[0]) {
    const { name, root, target, port, jump, password } = input;
    const ssh = { target, port, jump };
    let run: RunCommand;
    if (password !== undefined) {
      const destination = await resolvePasswordTarget(ssh);
      run = (command, stage, stdin) =>
        execWithPassword(destination, password, command, stage, stdin);
    } else {
      run = (command, stage, stdin) => runSSH(ssh, command, stage, stdin);
    }
    const platform = await platformFor(run);
    const binary = await gatewayBinary(platform, this.project);
    const host = id("h"),
      token = secret();
    const tunnel: Tunnel = {
      ...ssh,
      host,
      portAtGateway: randomInt(20000, 60000),
      ...(password !== undefined
        ? { sealedPassword: await this.passwords.seal(host, password) }
        : {}),
    };
    const commands = gatewayCommands(host, platform);
    await run(commands.upload, "上传内置 Gateway", binary);
    if (this.stopped) throw new AppError("SSH_CENTER_UNAVAILABLE", "中心正在停止", 503);
    const { cert } = await this.ingress();
    this.store.transaction(() => {
      this.store.put("host", host, {
        id: host,
        name,
        kind: "remote",
        status: "offline",
        agents: [],
        cwd: "",
      } satisfies Host);
      this.store.credential(token, { kind: "device", id: host, host });
      this.store.put("ssh-tunnel", host, tunnel);
      this.store.audit(actor, "host.ssh.deploy", host);
    });
    this.start(tunnel);
    try {
      await run(
        commands.provision,
        "配置并启动 Gateway",
        JSON.stringify({
          host,
          token,
          center: `https://127.0.0.1:${tunnel.portAtGateway}`,
          centerCertificate: cert,
          root,
        }),
      );
    } catch (error) {
      this.remove(host);
      this.store.revoke("device", host);
      this.store.remove("host", host);
      this.store.audit(actor, "host.ssh.failed", host);
      throw error;
    }
    this.store.event("", "hosts", {});
    // Preserve the installation if connectivity needs attention so its durable tunnel keeps retrying.
    for (let attempt = 0; attempt < 80 && !this.stopped; attempt++) {
      if (this.store.get<Host>("host", host)?.status === "online")
        return { host, platform, online: true };
      await delay(250);
    }
    return { host, platform, online: false };
  }
}
