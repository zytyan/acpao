import { execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { Client, type ClientChannel, type ServerHostKeyAlgorithm } from "ssh2";
import { AppError } from "../../../packages/core/src/types.js";

const exec = promisify(execFile);
const loopback = "127.0.0.1";

export type SshTarget = { target: string; port?: number; jump?: string };
type Destination = {
  user: string;
  hostname: string;
  port: number;
  jump?: string;
  keys: Buffer[];
  algorithms: ServerHostKeyAlgorithm[];
};
export type SealedPassword = { iv: string; tag: string; data: string };

export const sshConfigArgs = () =>
  process.env.ACPAO_SSH_CONFIG ? ["-F", process.env.ACPAO_SSH_CONFIG] : [];

export const sshProcessEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ACPAO_/i.test(key)));

export class SshPasswordVault {
  private pending?: Promise<Buffer>;

  constructor(private readonly data: string) {}

  private key(create: boolean) {
    if (this.pending) return this.pending;
    this.pending = this.loadKey(create).catch((error) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private async loadKey(create: boolean) {
    const dir = resolve(this.data, "ssh-secrets");
    const path = resolve(dir, "key");
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const { stdout } = await exec("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
      });
      const sid = stdout.match(/S-1-[\d-]+/)?.[0];
      if (!sid) throw new Error("Windows user SID unavailable");
      await exec("icacls.exe", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
        windowsHide: true,
      });
    } else {
      await chmod(dir, 0o700);
    }
    if (create) {
      await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("invalid SSH password key");
    return key;
  }

  async seal(host: string, password: string): Promise<SealedPassword> {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(true), iv);
      cipher.setAAD(Buffer.from(host));
      const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      return {
        data: data.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    } catch {
      throw new AppError(
        "SSH_PASSWORD_STORE_FAILED",
        "无法安全保存 SSH 密码，请检查中心数据目录权限。",
        503,
      );
    }
  }

  async open(host: string, sealed: SealedPassword) {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(false),
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(host));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function expandKnownHosts(value: string, home: string, localUser: string, hostname: string) {
  const expanded = value
    .replace(/^~(?=[/\\])/, home)
    .replace(/%([%dhLru])/g, (match, code: string) => {
      if (code === "%") return "%";
      if (code === "d") return home;
      if (code === "u") return localUser;
      if (code === "h") return hostname;
      return match;
    });
  return expanded;
}

export async function resolvePasswordTarget(target: SshTarget): Promise<Destination> {
  try {
    const { stdout } = await exec(
      "ssh",
      [
        ...sshConfigArgs(),
        ...(target.port ? ["-p", String(target.port)] : []),
        ...(target.jump ? ["-J", target.jump] : []),
        "-G",
        "--",
        target.target,
      ],
      { timeout: 10000, windowsHide: true, env: sshProcessEnv() },
    );
    const config = new Map(
      stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const index = line.indexOf(" ");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    const user = config.get("user");
    const hostname = config.get("hostname");
    const port = Number(config.get("port"));
    if (!user || !hostname || !port) throw new Error("invalid OpenSSH configuration");
    const proxy = config.get("proxycommand");
    if (proxy && proxy !== "none")
      throw new AppError(
        "SSH_PASSWORD_PROXY_UNSUPPORTED",
        "密码配对支持 ProxyJump。请将自定义 ProxyCommand 改为 SSH 跳板。",
        422,
      );
    const name = config.get("hostkeyalias") || (port === 22 ? hostname : `[${hostname}]:${port}`);
    const paths = ["userknownhostsfile", "globalknownhostsfile"].flatMap(
      (key) => (config.get(key) ?? "").match(/"[^"]+"|\S+/g) ?? [],
    );
    const known: { key: Buffer; algorithms: ServerHostKeyAlgorithm[] }[] = [];
    const revoked: Buffer[] = [];
    for (const file of new Set(paths)) {
      if (file.toLowerCase() === "none") continue;
      const path = expandKnownHosts(
        file.replace(/^"|"$/g, ""),
        homedir(),
        process.env.USER ?? process.env.USERNAME ?? "",
        hostname,
      );
      const matches = await exec("ssh-keygen", ["-F", name, "-f", path], {
        timeout: 5000,
        windowsHide: true,
        env: sshProcessEnv(),
      }).then(
        (result) => result.stdout,
        () => "",
      );
      for (const line of matches.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        const parts = line.trim().split(/\s+/);
        const marker = parts[0]?.startsWith("@") ? parts.shift() : undefined;
        if (parts.length < 3 || (marker && marker !== "@revoked")) continue;
        const key = Buffer.from(parts[2]!, "base64");
        if (!key.length) continue;
        if (marker === "@revoked") {
          revoked.push(key);
          continue;
        }
        const type = parts[1];
        if (type === "ssh-rsa") known.push({ key, algorithms: ["rsa-sha2-512", "rsa-sha2-256"] });
        else if (
          type === "ssh-ed25519" ||
          type === "ecdsa-sha2-nistp256" ||
          type === "ecdsa-sha2-nistp384" ||
          type === "ecdsa-sha2-nistp521"
        ) {
          known.push({ key, algorithms: [type] });
        }
      }
    }
    const trusted = known.filter(({ key }) => !revoked.some((other) => other.equals(key)));
    if (!trusted.length)
      throw new AppError(
        "SSH_HOST_KEY_UNKNOWN",
        "请核对 SSH 主机指纹并把目标公钥加入中心账户的 known_hosts。",
        422,
      );
    const jump = config.get("proxyjump");
    return {
      user,
      hostname,
      port,
      jump: jump && jump !== "none" ? jump : undefined,
      keys: trusted.map(({ key }) => key),
      algorithms: [...new Set(trusted.flatMap(({ algorithms }) => algorithms))],
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "SSH_CONFIG_FAILED",
      "无法读取 OpenSSH 配置，请确认 ssh 和 ssh-keygen 可用。",
      502,
    );
  }
}

function jumpTransport(destination: Destination) {
  if (!destination.jump) return undefined;
  const hops = destination.jump.split(",");
  const last = hops.pop()!;
  // OpenSSH handles the jump host's own trusted key and identity. It receives no target password.
  const spec = /^(.*?)(?::(\d+))?$/.exec(last);
  const server = spec?.[1];
  if (!server || server.startsWith("-") || !/^[\w.@:\[\]-]+$/.test(server))
    throw new AppError("SSH_CONFIG_FAILED", "SSH 跳板格式不支持。请使用 SSH 配置中的别名。", 422);
  const host = destination.hostname.includes(":")
    ? `[${destination.hostname}]`
    : destination.hostname;
  const child = spawn(
    "ssh",
    [
      ...sshConfigArgs(),
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ConnectTimeout=8",
      ...(hops.length ? ["-J", hops.join(",")] : []),
      ...(spec?.[2] ? ["-p", spec[2]] : []),
      "-W",
      `${host}:${destination.port}`,
      "--",
      server,
    ],
    { env: sshProcessEnv(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const socket = Duplex.from({
    readable: Readable.toWeb(child.stdout),
    writable: Writable.toWeb(child.stdin),
  });
  socket.on("error", () => {});
  child.once("error", () => socket.destroy());
  child.once("close", () => socket.destroy());
  socket.once("close", () => child.kill());
  return socket;
}

export async function connectWithPassword(
  destination: Destination,
  password: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const client = new Client();
  const socket = jumpTransport(destination);
  let wrongHost = false;
  return new Promise<Client>((resolve, reject) => {
    const abort = () => {
      client.destroy();
      socket?.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", () =>
      reject(
        new AppError(
          wrongHost ? "SSH_HOST_KEY_MISMATCH" : "SSH_AUTH_FAILED",
          wrongHost
            ? "SSH 主机公钥与 known_hosts 不匹配。"
            : "SSH 密码认证未成功，请检查用户名、密码及远端是否启用密码登录。",
          502,
        ),
      ),
    );
    client.once("close", () => {
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      reject(new AppError("SSH_FAILED", "SSH 连接已关闭。", 502));
    });
    client.once("ready", () => resolve(client));
    try {
      client.connect({
        host: destination.hostname,
        port: destination.port,
        username: destination.user,
        password,
        ...(socket ? { sock: socket } : {}),
        hostVerifier: (key: Buffer | string) => {
          const valid = Buffer.isBuffer(key) && destination.keys.some((known) => known.equals(key));
          wrongHost = !valid;
          return valid;
        },
        authHandler: ["password"],
        algorithms: { serverHostKey: destination.algorithms },
        keepaliveInterval: 10000,
        keepaliveCountMax: 2,
        readyTimeout: 12000,
      });
    } catch (error) {
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      reject(error);
    }
  });
}

export async function execWithPassword(
  destination: Destination,
  password: string,
  command: string,
  stage: string,
  input?: Buffer | string,
) {
  const signal = AbortSignal.timeout(45000);
  const client = await connectWithPassword(destination, password, signal);
  try {
    return await new Promise<string>((resolve, reject) => {
      client.once("close", () => reject(new AppError("SSH_FAILED", stage + "时连接中断。", 502)));
      client.exec(command, (error, channel) => {
        if (error) return reject(new AppError("SSH_FAILED", stage + "失败。", 502));
        let output = "";
        channel.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096);
        });
        channel.stderr.resume();
        channel.on("error", () => reject(new AppError("SSH_FAILED", stage + "时连接中断。", 502)));
        channel.on("close", (status: number) => {
          if (status === 0) resolve(output.trim());
          else reject(new AppError("SSH_FAILED", stage + "失败。", 502));
        });
        channel.end(input);
      });
    });
  } finally {
    client.end();
  }
}

export async function passwordTunnel(
  destination: Destination,
  password: string,
  portAtGateway: number,
  ingress: number,
  signal: AbortSignal,
) {
  const client = await connectWithPassword(destination, password, signal);
  const channels = new Set<ClientChannel>();
  try {
    await new Promise<void>((resolve) => {
      client.on("tcp connection", (info, accept, reject) => {
        if (info.destPort !== portAtGateway) return reject();
        const channel = accept();
        const socket = connect(ingress, loopback);
        channels.add(channel);
        channel.on("error", () => socket.destroy());
        channel.on("close", () => {
          channels.delete(channel);
          socket.destroy();
        });
        socket.on("error", () => channel.destroy());
        socket.on("close", () => channel.destroy());
        channel.pipe(socket).pipe(channel);
      });
      client.once("close", resolve);
      client.forwardIn(loopback, portAtGateway, (err) => {
        if (err) client.end();
      });
    });
  } finally {
    for (const channel of channels) channel.destroy();
    client.end();
  }
}
