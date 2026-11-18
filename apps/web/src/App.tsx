import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  Layers,
  Server,
  Sun,
  Moon,
  Monitor,
  Search,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  Check,
  X,
  Square,
  Terminal,
  Pencil,
  Folder,
  Link,
  ShieldCheck,
  MoreHorizontal,
  LogOut,
  AlertCircle,
  LoaderCircle,
  GitBranch,
  Download,
} from "lucide-react";

import {
  api,
  busy,
  type Host,
  type Session,
  type ChatData,
  type Agent,
  type DiagnosticData,
} from "./api";
import { Mark, Status, Modal, Copy, relativeTime, Conversation, AgentForm } from "./ui";
import { version } from "../../../package.json";

const gatewayRelease = `https://github.com/zytyan/acpao/releases/download/v${version}`;

export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [login, setLogin] = useState(""),
    [route, setRoute] = useState(location.hash.slice(1) || "/workspace"),
    [hosts, setHosts] = useState<Host[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [config, setConfig] = useState<{
      main: string | null;
      root: string;
      testFeatures: boolean;
      supervised?: boolean;
    }>({
      main: null,
      root: "",
      testFeatures: false,
    }),
    [chat, setChat] = useState<ChatData | null>(null),
    [older, setOlder] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [online, setOnline] = useState(true),
    [collapsed, setCollapsed] = useState(false),
    [modal, setModal] = useState<"create" | "agent" | "pair" | "search" | "diagnostics" | null>(
      null,
    ),
    [search, setSearch] = useState(""),
    [theme, setTheme] = useState(localStorage.getItem("acpao-theme") ?? "system"),
    [fixture, setFixture] = useState<Agent>(),
    [editingAgent, setEditingAgent] = useState<Agent | null>(null),
    [agentHostId, setAgentHostId] = useState("local"),
    [detected, setDetected] = useState<Agent[]>([]),
    [working, setWorking] = useState(false),
    [text, setText] = useState(""),
    [hostId, setHostId] = useState("local"),
    [agentId, setAgentId] = useState(""),
    [cwd, setCwd] = useState(""),
    [title, setTitle] = useState(""),
    [isolate, setIsolate] = useState(false),
    [pairName, setPairName] = useState(""),
    [pairMode, setPairMode] = useState<"ssh" | "manual">("ssh"),
    [sshAuth, setSshAuth] = useState<"key" | "password">("key"),
    [sshPending, setSshPending] = useState(false),
    [sshError, setSshError] = useState(""),
    [sshResult, setSshResult] = useState<{ online: boolean } | null>(null),
    [pairCenter, setPairCenter] = useState(location.origin),
    [pairPlatform, setPairPlatform] = useState<"linux-x64" | "linux-arm64" | "windows-x64">("linux-x64"),
    [pair, setPair] = useState<{ code: string; host: string } | null>(null),
    [diagnostics, setDiagnostics] = useState<DiagnosticData | null>(null),
    [logSearch, setLogSearch] = useState(""),
    [logLevel, setLogLevel] = useState("all"),
    [recovery, setRecovery] = useState<{
      host: string;
      token: string;
      warning: string;
    } | null>(null);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : "操作失败"),
    [],
  );
  const navigate = (path: string) => {
    location.hash = path;
    setCollapsed(false);
  };
  const sessionId = route.startsWith("/session/")
    ? route.slice(9)
    : route === "/workspace"
      ? config.main
      : null;
  const activeRef = useRef(sessionId);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  activeRef.current = sessionId;
  const host = hosts.find((h) => h.id === hostId);
  const agentHost = hosts.find((h) => h.id === agentHostId);
  const currentSession = sessions.find((s) => s.id === sessionId);
  const isWorkspace = route === "/workspace";
  const pairCenterOrigin = (() => {
    try { return new URL(pairCenter).origin; } catch { return ""; }
  })();
  const pairCommand = pair
    ? pairPlatform === "windows-x64"
      ? `Invoke-WebRequest '${gatewayRelease}/acpao-gateway-windows-x64.exe' -OutFile acpao-gateway.exe\n$env:ACPAO_CENTER='${pairCenterOrigin}'\n$env:ACPAO_PAIR_CODE='${pair.code}'\n$env:ACPAO_ROOT='.'\n./acpao-gateway.exe --pair\n./acpao-gateway.exe --daemon`
      : `curl -fL '${gatewayRelease}/acpao-gateway-${pairPlatform}' -o acpao-gateway\nchmod +x acpao-gateway\nexport ACPAO_CENTER='${pairCenterOrigin}'\nexport ACPAO_PAIR_CODE='${pair.code}'\nexport ACPAO_ROOT='.'\n./acpao-gateway --pair\n./acpao-gateway --daemon`
    : "";
  const refresh = useCallback(async () => {
    try {
      const [hs, ss, cf] = await Promise.all([
        api<Host[]>("/hosts"),
        api<Session[]>("/sessions"),
        api<{ main: string | null; root: string; testFeatures: boolean; supervised?: boolean }>(
          "/config",
        ),
      ]);
      setHosts(hs);
      setSessions(ss);
      setConfig(cf);
    } catch (e) {
      report(e);
    }
  }, [report]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node))
        moreMenu.current?.removeAttribute("open");
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") moreMenu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, []);
  useEffect(() => {
    if (modal !== "diagnostics") return;
    const timer = setInterval(() => {
      void api<DiagnosticData>("/diagnostics")
        .then((fresh) =>
          setDiagnostics((old) => ({
            ...fresh,
            logs: [
              ...new Map(
                [...fresh.logs, ...(old?.logs ?? [])].map((log) => [log.id, log]),
              ).values(),
            ]
              .sort((a, b) => b.id - a.id)
              .slice(0, 1000),
          })),
        )
        .catch(report);
    }, 5000);
    return () => clearInterval(timer);
  }, [modal, report]);
  const refreshChat = useCallback(async () => {
    const key = activeRef.current;
    if (!key) return;
    try {
      const d = await api<ChatData>(`/sessions/${key}`);
      if (activeRef.current !== key) return;
      setChat((prev) => {
        const messages =
          prev?.session.id === key
            ? [...new Map([...prev.messages, ...d.messages].map((m) => [m.id, m])).values()].sort(
                (a, b) => a.id - b.id,
              )
            : d.messages;
        return { ...d, messages };
      });
    } catch (e) {
      report(e);
    }
  }, [report]);
  useEffect(() => {
    const launch = location.hash.startsWith("#launch=")
      ? location.hash.slice("#launch=".length)
      : null;
    if (launch) {
      history.replaceState(null, "", location.pathname + location.search);
      setRoute("/workspace");
      void api("/login", { token: launch })
        .then(() => setAuth(true))
        .catch((error) => {
          setAuth(false);
          report(error);
        });
    } else {
      void api<{ authenticated: boolean }>("/auth")
        .then((a) => setAuth(a.authenticated))
        .catch(report);
    }
    const change = () => setRoute(location.hash.slice(1) || "/workspace");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [report]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)"),
      apply = () => {
        document.documentElement.dataset.theme =
          theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      };
    apply();
    localStorage.setItem("acpao-theme", theme);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (!auth) return;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource("/api/stream");
    source.onopen = () => setOnline(true);
    source.onerror = () => setOnline(false);
    source.addEventListener("change", () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
          void refreshChat();
        }, 120);
    });
    const visibility = () => {
      if (!document.hidden) {
        void refresh();
        void refreshChat();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [auth, refresh, refreshChat]);
  useEffect(() => {
    setChat(null);
    setText("");
    setOlder(false);
    if (sessionId) void refreshChat();
  }, [sessionId, refreshChat]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch("");
        setModal("search");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const detect = async () => {
    try {
      const d = await api<{ agents: Agent[]; fixture: Agent | null }>("/agents/detect");
      setDetected(d.agents);
      setFixture(d.fixture ?? undefined);
    } catch (e) {
      report(e);
    }
  };
  const openAgent = (target: string) => {
    setAgentHostId(target);
    setEditingAgent(null);
    setDetected([]);
    if (target === "local") void detect();
    setModal("agent");
  };
  const addAgent = async (a: Agent) => {
    const result = await api<{
      ok: boolean;
      updated?: boolean;
      probe: { stage: string; message: string; stderr?: string };
    }>(`/hosts/${encodeURIComponent(agentHostId)}/agent`, { agent: a });
    if (!result.ok)
      throw new Error(
        `${result.probe.message}${result.probe.stderr ? `\n${result.probe.stderr}` : ""}`,
      );
    await refresh();
    if (agentHostId === hostId) setAgentId(a.id);
    setModal(null);
    setEditingAgent(null);
    setToast(result.updated ? "Agent 已测试并更新" : "Agent 已测试并添加");
  };
  const editAgent = async (target: string, key: string) => {
    const agent = await api<Agent>(`/hosts/${encodeURIComponent(target)}/agents/${encodeURIComponent(key)}`);
    setAgentHostId(target);
    setDetected([]);
    setEditingAgent(agent);
    setModal("agent");
  };
  const openCreate = () => {
    setHostId("local");
    setAgentId(hosts.find((h) => h.id === "local")?.agents[0]?.id ?? "");
    setCwd(config.root);
    setTitle("");
    setIsolate(false);
    setModal("create");
  };
  const createSession = async (main = false) => {
    setWorking(true);
    try {
      const s = await api<Session>("/sessions", {
        host: hostId,
        agent: agentId || undefined,
        cwd: cwd || host?.cwd || config.root,
        title: title || "新的工作",
        main,
        isolate,
      });
      await refresh();
      setModal(null);
      navigate(main ? "/workspace" : `/session/${s.id}`);
    } catch (e) {
      report(e);
    } finally {
      setWorking(false);
    }
  };
  const send = async (e?: FormEvent, mode: "auto" | "steer" = "auto") => {
    e?.preventDefault();
    if (!sessionId || !text.trim() || working) return;
    setWorking(true);
    const content = text;
    try {
      const result = await api<{ delivery: string }>(`/sessions/${sessionId}/send`, {
        text: content,
        mode,
        requestId: crypto.randomUUID(),
      });
      setText("");
      if (result.delivery === "queued") setToast("已加入队列，将在当前工作结束后发送");
      if (result.delivery === "steering") setToast("已引导当前执行");
      await refreshChat();
    } catch (e) {
      report(e);
    } finally {
      setWorking(false);
    }
  };
  const action = async (kind: string) => {
    if (!sessionId) return;
    setWorking(true);
    try {
      await api(`/sessions/${sessionId}/${kind}`, {});
      await refreshChat();
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setWorking(false);
    }
  };
  const loadOlder = async () => {
    if (!sessionId || !chat?.messages[0]) return;
    try {
      const d = await api<ChatData>(`/sessions/${sessionId}?before=${chat.messages[0].id}`);
      if (activeRef.current !== sessionId) return;
      setOlder(d.messages.length === 0);
      setChat((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...new Map([...d.messages, ...prev.messages].map((m) => [m.id, m])).values(),
              ].sort((a, b) => a.id - b.id),
            }
          : prev,
      );
    } catch (e) {
      report(e);
    }
  };
  const download = (value: unknown, name: string) => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  const nav = [
    { path: "/workspace", label: "工作区", icon: MessageSquare },
    { path: "/sessions", label: "会话", icon: Layers },
    { path: "/hosts", label: "主机", icon: Server },
  ];
  if (auth === null)
    return (
      <div className="loading-page">
        <Mark />
        <span>正在连接工作区</span>
      </div>
    );
  if (!auth)
    return (
      <div className="login-page">
        <div className="login-brand">
          <Mark />
          <span>
            合流<span>ACPAO</span>
          </span>
        </div>
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            setWorking(true);
            void api("/login", { token: login })
              .then(() => {
                setAuth(true);
                setLogin("");
                setError("");
              })
              .catch(report)
              .finally(() => setWorking(false));
          }}
        >
          <div className="eyebrow">YOUR AGENT WORKSPACE</div>
          <h1>让想法，开始流动。</h1>
          <p>
            一个目标，一个对话。
            <br />让 Agent 协作完成其余的工作。
          </p>
          <label>
            工作区登录密钥
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="输入管理员密钥"
              required
            />
          </label>
          {error && (
            <div role="alert" className="inline-error">
              {error}
            </div>
          )}
          <button className="button primary" disabled={working}>
            {working ? <LoaderCircle size={16} className="spin" /> : null}
            进入工作区 <ArrowUpRight size={17} />
          </button>
          <p className="hint login-hint">
            首次启动的密钥保存在服务器 <code>.data/admin-token</code>。<br />
            也可以通过 ACPAO_ADMIN_TOKEN 配置。
          </p>
        </form>
        <div className="login-foot">由你确定方向 · 由 Agent 组织工作</div>
      </div>
    );
  return (
    <div className={`app ${collapsed ? "sidebar-hidden" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span>
            合流<small>ACPAO</small>
          </span>
          <button
            className="icon-button collapse-button"
            onClick={() => setCollapsed(true)}
            aria-label="收起导航"
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="search-trigger"
          onClick={() => {
            setSearch("");
            setModal("search");
          }}
        >
          <Search size={15} />
          <span>快速查找</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="主导航">
          {nav.map((n) => (
            <a
              href={`#${n.path}`}
              key={n.path}
              className={
                route === n.path || (n.path === "/sessions" && route.startsWith("/session/"))
                  ? "selected"
                  : ""
              }
            >
              <n.icon size={18} />
              {n.label}
              {n.path === "/sessions" && sessions.filter((s) => busy(s.status)).length > 0 && (
                <span className="nav-count">{sessions.filter((s) => busy(s.status)).length}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-label">
            最近的工作
            <button className="icon-button" aria-label="新建会话" onClick={openCreate}>
              <Plus size={15} />
            </button>
          </div>
          {sessions
            .filter((s) => s.status !== "closed")
            .slice(0, 7)
            .map((s) => (
              <a
                className={`recent-session ${s.id === sessionId ? "active" : ""}`}
                href={`#/session/${s.id}`}
                key={s.id}
              >
                <i className={busy(s.status) ? "active-dot" : ""} />
                <span>{s.title}</span>
              </a>
            ))}
          {sessions.length === 0 && <p className="sidebar-empty">你的工作会在这里延续</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={14} />
            <span>你的主机，你的 Agent</span>
          </div>
          <div className="sidebar-controls">
            <div className="theme-control" aria-label="外观">
              {[
                { value: "light", icon: Sun, label: "亮色主题" },
                { value: "dark", icon: Moon, label: "暗色主题" },
                { value: "system", icon: Monitor, label: "跟随系统" },
              ].map((t) => (
                <button
                  key={t.value}
                  aria-label={t.label}
                  title={t.label}
                  onClick={() => setTheme(t.value)}
                  className={theme === t.value ? "active" : ""}
                >
                  <t.icon size={15} />
                </button>
              ))}
            </div>
            <details className="more-menu" ref={moreMenu}>
              <summary className="icon-button" aria-label="更多设置">
                <MoreHorizontal size={19} />
              </summary>
              <div>
                <button
                  onClick={() => {
                    moreMenu.current?.removeAttribute("open");
                    void api<DiagnosticData>("/diagnostics").then(setDiagnostics).catch(report);
                    setModal("diagnostics");
                  }}
                >
                  日志与诊断
                </button>
                <button
                  onClick={() => {
                    moreMenu.current?.removeAttribute("open");
                    void api("/logout", {})
                      .then(() => setAuth(false))
                      .catch(report);
                  }}
                >
                  <LogOut size={14} />
                  退出登录
                </button>
              </div>
            </details>
          </div>
        </div>
      </aside>
      <main className="main">
        {collapsed && (
          <button
            className="show-sidebar icon-button"
            onClick={() => setCollapsed(false)}
            aria-label="展开导航"
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
        <header className="topbar">
          <div className="breadcrumb">
            <span>个人工作空间</span>
            <ChevronRight size={13} />
            <strong>{nav.find((n) => n.path === route)?.label ?? "会话"}</strong>
          </div>
          <div className="connection">
            <i className={online ? "" : "offline"} />
            {online ? "已连接" : "正在重新连接"}
          </div>
        </header>
        {!online && (
          <div className="reconnect-banner" role="status">
            <LoaderCircle size={14} className="spin" />
            与中心的连接已断开，正在重连。已有执行可能仍在继续。
          </div>
        )}
        {isWorkspace && !config.main ? (
          <section className="onboarding">
            <div className="eyebrow">WELCOME TO ACPAO</div>
            <h1>
              为你的工作，
              <br />
              <span>连接一位 Agent。</span>
            </h1>
            <p className="lead">
              你负责目标，Agent 负责组织。
              <br />
              先选择一台主机，开启第一段协作。
            </p>
            <div className="setup-card">
              <div className="step-title">
                <span>01</span>
                <h2>选择工作主机</h2>
                <span className="step-meta">约 1 分钟开始</span>
              </div>
              <div className="host-choices">
                {hosts
                  .filter((h) => h.status === "online")
                  .map((h) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        setHostId(h.id);
                        setCwd(h.cwd);
                        setAgentId(h.agents[0]?.id ?? "");
                      }}
                      className={h.id === hostId ? "chosen" : ""}
                    >
                      <Monitor size={23} />
                      <strong>{h.name}</strong>
                      <span>{h.kind === "local" ? "在当前设备运行" : "已配对的远程设备"}</span>
                      {h.id === hostId && <Check size={15} />}
                    </button>
                  ))}
                <button onClick={() => navigate("/hosts")}>
                  <Link size={23} />
                  <strong>远程主机</strong>
                  <span>连接你的 Linux 设备</span>
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="step-title second">
                <span>02</span>
                <h2>选择 ACP Agent</h2>
              </div>
              {host?.agents.length ? (
                <>
                  <label className="sr-only" htmlFor="setup-agent">
                    选择 Agent
                  </label>
                  <select
                    id="setup-agent"
                    value={agentId || host.agents[0]?.id}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    {host.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <label className="directory-label">
                    <Folder size={14} />
                    工作目录
                    <input value={cwd || host.cwd} onChange={(e) => setCwd(e.target.value)} />
                  </label>
                  <button
                    className="button primary start-button"
                    disabled={working}
                    onClick={() => void createSession(true)}
                  >
                    {working ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                    开启工作区
                  </button>
                </>
              ) : (
                <div className="agent-empty">
                  <Terminal size={20} />
                  <div>
                    <strong>还没有配置 Agent</strong>
                    <p>检测已安装的适配器，或填写启动命令。</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => {
                      if (host?.kind === "remote" && (!host.manageAgents || host.status !== "online")) {
                        navigate("/hosts");
                        return;
                      }
                      openAgent(host?.id ?? "local");
                    }}
                  >
                    配置 Agent
                  </button>
                </div>
              )}
            </div>
            <p className="onboarding-foot">
              <ShieldCheck size={14} />
              对话由主机上的 ACP Agent 完成，平台不调用模型 API。
            </p>
          </section>
        ) : sessionId ? (
          <section className="chat-page">
            <div className="chat-heading">
              <div>
                {!isWorkspace && (
                  <button className="text-button back-link" onClick={() => navigate("/sessions")}>
                    <ArrowLeft size={13} />
                    全部会话
                  </button>
                )}
                <h1>
                  {isWorkspace ? "一起，把工作向前推进。" : (currentSession?.title ?? "加载会话")}
                </h1>
                <div className="chat-meta">
                  <span>{currentSession?.agent}</span>
                  <span>·</span>
                  <span>{hosts.find((h) => h.id === currentSession?.host)?.name}</span>
                  {currentSession && <Status status={currentSession.status} />}
                </div>
              </div>
              <div className="chat-actions">
                {!isWorkspace && (
                  <button
                    className="subtle-button"
                    disabled={working || config.main === sessionId}
                    onClick={() =>
                      void api("/main", { session: sessionId })
                        .then(() => {
                          void refresh();
                          navigate("/workspace");
                        })
                        .catch(report)
                    }
                  >
                    {config.main === sessionId ? "当前主 Agent" : "设为主 Agent"}
                  </button>
                )}
                <details className="action-menu">
                  <summary className="icon-button" aria-label="会话操作">
                    <MoreHorizontal size={21} />
                  </summary>
                  <div>
                    <button
                      onClick={() => {
                        void action("resume");
                      }}
                      disabled={!currentSession?.capabilities?.load || busy(currentSession?.status)}
                    >
                      恢复历史会话
                    </button>
                    <button onClick={() => void action("close")}>关闭会话</button>
                  </div>
                </details>
              </div>
            </div>
            {chat?.session.error && (
              <div className="session-notice">
                <AlertCircle size={17} />
                <span>{chat.session.error}</span>
                {chat.session.capabilities?.load && (
                  <button className="text-button" onClick={() => void action("resume")}>
                    恢复会话
                  </button>
                )}
              </div>
            )}
            {currentSession &&
              hosts.find((h) => h.id === currentSession.host)?.status !== "online" && (
                <div className="session-notice">
                  主机未连接，执行状态暂时无法确认。网关重连后将同步进展。
                </div>
              )}
            {chat ? (
              <Conversation
                data={chat}
                canOlder={!older && chat.messages.length >= 80}
                onOlder={() => void loadOlder()}
              />
            ) : (
              <div className="chat-loading">
                <LoaderCircle size={20} className="spin" />
                正在读取会话
              </div>
            )}
            <div className="composer-area">
              {chat?.queuedCommands?.length &&
              currentSession?.capabilities?.steering &&
              busy(currentSession.status) ? (
                <div className="queued-steering">
                  {chat.queuedCommands.map((command) => (
                    <div key={command.id}>
                      <span title={command.text}>等待发送：{command.text}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void api<{ delivery: string }>(
                            `/sessions/${sessionId}/queue/${command.id}/steer`,
                            {},
                          )
                            .then((result) => {
                              setToast(
                                result.delivery === "steering"
                                  ? "已引导当前执行"
                                  : "当前不能引导，消息仍在队列中",
                              );
                              return refreshChat();
                            })
                            .catch(report)
                        }
                      >
                        转为引导
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {chat?.delegations.length ? (
                <div className="delegation-strip">
                  {chat.delegations.map((d) => (
                    <a href={`#/session/${d.session}`} key={d.session}>
                      <Layers size={14} />
                      <span>{d.title}</span>
                      <Status status={d.status} />
                      <ArrowUpRight size={13} />
                    </a>
                  ))}
                </div>
              ) : null}
              {chat?.approvals.map((a) => (
                <div className="approval-card" key={a.id}>
                  <div>
                    <ShieldCheck size={19} />
                    <div>
                      <strong>Agent 需要你的确认</strong>
                      <p>{a.request.toolCall.title ?? "执行工具操作"}</p>
                    </div>
                  </div>
                  <details className="approval-details">
                    <summary>查看操作详情</summary>
                    <pre>{JSON.stringify(a.request.toolCall, null, 2)}</pre>
                  </details>
                  <div className="approval-options">
                    {a.request.options.map((o) => (
                      <button
                        className={`button ${o.kind.startsWith("allow") ? "primary" : ""}`}
                        key={o.optionId}
                        onClick={() =>
                          void api(`/approvals/${a.id}`, { option: o.optionId })
                            .then(refreshChat)
                            .catch(report)
                        }
                      >
                        {o.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <form className="composer" onSubmit={(e) => void send(e)}>
                <textarea
                  aria-label="发送给 Agent 的指令"
                  placeholder={
                    busy(currentSession?.status)
                      ? "补充要求… 发送后会排队等待当前工作结束"
                      : "描述你想完成的工作…"
                  }
                  value={text}
                  rows={2}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={["closed", "interrupted", "error", "creating"].includes(
                    currentSession?.status ?? "creating",
                  )}
                />
                <div className="composer-bottom">
                  <span title={currentSession?.cwd}>
                    <Folder size={14} />
                    {currentSession?.cwd.split("/").filter(Boolean).slice(-2).join("/") ||
                      "工作目录"}
                  </span>
                  <div>
                    {busy(currentSession?.status) && currentSession?.capabilities?.steering && (
                      <button
                        type="button"
                        className="steer-button"
                        disabled={!text.trim() || working}
                        onClick={() => void send(undefined, "steer")}
                      >
                        引导当前执行
                      </button>
                    )}
                    {busy(currentSession?.status) && (
                      <button
                        type="button"
                        className="stop-button"
                        aria-label="取消当前执行"
                        onClick={() => void action("cancel")}
                      >
                        <Square size={12} />
                        停止
                      </button>
                    )}
                    <button
                      className="send-button"
                      aria-label="发送消息"
                      disabled={!text.trim() || working}
                    >
                      <ArrowUp size={19} />
                    </button>
                  </div>
                </div>
              </form>
              <div className="composer-hint">
                <span>
                  {currentSession?.status === "waiting_permission"
                    ? "Agent 正等待你的审批，处理后会继续工作。"
                    : currentSession?.status === "running"
                      ? `Agent 正在执行${chat?.queued ? ` · 还有 ${chat.queued} 条消息待发送` : " · 新消息会排队"}`
                      : currentSession?.status === "interrupted"
                        ? "Agent 连接已中断，可在会话操作中尝试恢复历史。"
                        : currentSession?.agent === "mock"
                          ? "协议测试 Agent · 无模型推理"
                          : "Agent 可操作工作目录。权限确认不等同于系统沙箱。"}
                </span>
                <span>Enter 发送 · Shift Enter 换行</span>
              </div>
            </div>
          </section>
        ) : route === "/sessions" ? (
          <section className="content-page">
            <div className="page-title">
              <div>
                <div className="eyebrow">CONVERSATIONS</div>
                <h1>每一段工作，都有上下文。</h1>
                <p>随时进入任意会话，查看进展或补充想法。</p>
              </div>
              <button className="button primary" onClick={openCreate}>
                <Plus size={16} />
                新建会话
              </button>
            </div>
            <div className="list-toolbar">
              <Search size={16} />
              <input
                aria-label="搜索会话"
                placeholder="按工作内容搜索…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span>{sessions.length} 个会话</span>
            </div>
            <div className="session-list">
              {sessions
                .filter((s) => `${s.title} ${s.agent}`.toLowerCase().includes(search.toLowerCase()))
                .map((s) => (
                  <a href={`#/session/${s.id}`} key={s.id} className="session-row">
                    <span className="session-row-icon">
                      <MessageSquare size={19} />
                    </span>
                    <div>
                      <strong>{s.title}</strong>
                      <span>
                        {s.agent}
                        <i>·</i>
                        {hosts.find((h) => h.id === s.host)?.name}
                        {s.id === config.main && <em>主 Agent</em>}
                      </span>
                    </div>
                    <Status status={s.status} />
                    <time>{relativeTime(s.updatedAt)}</time>
                    <ChevronRight size={16} />
                  </a>
                ))}
              {sessions.length === 0 && (
                <div className="empty-state">
                  <Layers size={32} />
                  <h2>为一件事，开启一段对话</h2>
                  <p>不同工作拥有独立的 Agent 上下文。</p>
                  <button className="button" onClick={openCreate}>
                    <Plus size={16} />
                    新建会话
                  </button>
                </div>
              )}
            </div>
          </section>
        ) : route === "/hosts" ? (
          <section className="content-page hosts-page">
            <div className="page-title">
              <div>
                <div className="eyebrow">CONNECTED MACHINES</div>
                <h1>工作，在你的设备上发生。</h1>
                <p>连接主机，配置 Agent。其余的交给工作区。</p>
              </div>
              <button
                className="button primary"
                onClick={() => {
                  setPair(null);
                  setPairMode("ssh");
                  setSshAuth("key");
                  setSshResult(null);
                  setSshError("");
                  setModal("pair");
                }}
              >
                <Plus size={16} />
                配对主机
              </button>
            </div>
            <div className="hosts-list">
              {hosts.map((h) => (
                <article className="host-card" key={h.id}>
                  <div className="host-card-head">
                    <span className="host-icon">
                      {h.kind === "local" ? <Monitor size={24} /> : <Server size={24} />}
                    </span>
                    <div>
                      <h2>
                        {h.name}
                        <span>{h.kind === "local" ? "本地" : "远程"}</span>
                      </h2>
                      <p>
                        {h.platform ?? "等待 Gateway 注册"}
                        <i>·</i>
                        {h.status === "online"
                          ? "已连接"
                          : h.status === "revoked"
                            ? "访问已撤销"
                            : "未连接"}
                      </p>
                    </div>
                    <i className={`host-dot ${h.status}`} />
                  </div>
                  {h.error && <p className="host-error">{h.error}</p>}
                  <div className="host-agents">
                    {h.agents.map((a) => (
                      <div key={a.id}>
                        <Terminal size={15} />
                        <span>{a.name}</span>
                        <span>ACP</span>
                        {(h.kind === "local" || (h.manageAgents && h.status === "online")) && (
                          <button
                            className="icon-button"
                            aria-label={`编辑 ${a.name}`}
                            onClick={() => void editAgent(h.id, a.id).catch(report)}
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                    {h.agents.length === 0 && <p>尚未配置 ACP Agent</p>}
                    {h.kind === "remote" && h.status === "online" && !h.manageAgents &&
                      <p>升级远程 Gateway 后即可在此添加 Agent。</p>}
                  </div>
                  <footer>
                    <span>
                      <Folder size={13} />
                      {h.cwd || "工作目录将在连接后同步"}
                    </span>
                    <div className="host-actions">
                      {h.status !== "revoked" && (
                        <button className="subtle-button" onClick={() => openAgent(h.id)}
                          disabled={h.kind === "remote" && (h.status !== "online" || !h.manageAgents)}>
                          <Plus size={14} /> 添加 Agent
                        </button>
                      )}
                      {h.kind === "remote" && h.status !== "revoked" && (
                        <details className="host-options">
                          <summary className="subtle-button">
                            身份管理
                            <ChevronDown size={14} />
                          </summary>
                          <div>
                            <p>
                              轮换会立即使旧凭据失效。恢复文件只包含设备身份，不能恢复数据库或 Agent
                              本地会话。
                            </p>
                            <button
                              className="button"
                              onClick={() =>
                                void api<{
                                  host: string;
                                  token: string;
                                  warning: string;
                                }>(`/hosts/${h.id}/rotate`, {})
                                  .then((r) => setRecovery(r))
                                  .catch(report)
                              }
                            >
                              <Download size={14} />
                              轮换并导出凭据
                            </button>
                            <button
                              className="text-button danger"
                              onClick={() =>
                                void api(`/hosts/${h.id}/revoke`, {}).then(refresh).catch(report)
                              }
                            >
                              撤销设备访问
                            </button>
                          </div>
                        </details>
                      )}
                    </div>
                  </footer>
                </article>
              ))}
            </div>
            <div className="host-explainer">
              <ShieldCheck size={22} />
              <div>
                <h3>安全的连接，明确的边界。</h3>
                <p>
                  每台设备使用独立身份，Gateway 主动连接中心。远程连接需要
                  HTTPS；断线时，本地工作尽可能继续，重连后同步进展。
                </p>
              </div>
            </div>
          </section>
        ) : (
          <div className="empty-state">
            <h2>请从导航进入工作区</h2>
          </div>
        )}
      </main>
      {error && (
        <div className="notification error" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button aria-label="关闭错误" className="icon-button" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {toast && (
        <div className="notification" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {modal === "create" && (
        <Modal title="开启一段新的工作" onClose={() => setModal(null)}>
          <p className="modal-description">独立的上下文，专注于一件事。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createSession();
            }}
          >
            <label>
              工作内容
              <input
                placeholder="例如：检查 SQLite 并发问题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
              />
            </label>
            <div className="form-grid">
              <label>
                主机
                <select
                  value={hostId}
                  onChange={(e) => {
                    setHostId(e.target.value);
                    const h = hosts.find((h) => h.id === e.target.value);
                    setAgentId(h?.agents[0]?.id ?? "");
                    setCwd(h?.cwd ?? "");
                  }}
                >
                  {hosts
                    .filter((h) => h.status === "online")
                    .map((h) => (
                      <option value={h.id} key={h.id}>
                        {h.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Agent
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
                  <option value="" disabled>
                    选择 Agent
                  </option>
                  {host?.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              工作目录
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} required />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
              />
              <GitBranch size={15} />
              使用独立 Git worktree<span>按需隔离修改</span>
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={() => setModal(null)}>
                取消
              </button>
              <button className="button primary" disabled={working || !agentId}>
                {working ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />}
                创建会话
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "agent" && (
        <Modal
          title={editingAgent ? "编辑 ACP Agent" : "连接 ACP Agent"}
          backdropClose={false}
          onClose={() => setModal(null)}
        >
          {agentHost?.kind === "remote" && (
            <p className="modal-description">目标主机：<strong>{agentHost.name}</strong>。启动命令将在这台主机上测试和运行。</p>
          )}
          {agentHostId === "local" && !editingAgent && detected.length > 0 && (
            <div className="detected">
              <p>检测到以下启动程序（尚未验证登录状态）</p>
              {detected.map((a) => (
                <button
                  className="button"
                  key={a.id}
                  onClick={() => void addAgent(a).catch(report)}
                >
                  <Terminal size={15} />
                  {a.name}
                  <Plus size={14} />
                </button>
              ))}
            </div>
          )}
          <AgentForm
            key={agentHostId + ":" + (editingAgent?.id ?? "new")}
            initial={editingAgent ?? undefined}
            windows={["win32", "windows"].includes(agentHost?.platform ?? "")}
            onSave={addAgent}
            fixture={
              agentHostId !== "local" || editingAgent ||
              hosts.find((h) => h.id === "local")?.agents.some((a) => a.id === "mock")
                ? undefined
                : fixture
            }
          />
          {agentHostId === "local" && config.testFeatures && (
            <p className="hint">测试 Agent 仅用于验证协议、流式输出和委派，不具备模型推理能力。</p>
          )}
        </Modal>
      )}
      {modal === "pair" && (
        <Modal
          title="配对远程主机"
          backdropClose={false}
          canClose={!sshPending}
          onClose={() => {
            setModal(null);
            setPair(null);
          }}
        >
          {!pair && !sshResult && (
            <div className="pair-modes" role="group" aria-label="连接方式">
              <button type="button" className="button" aria-pressed={pairMode === "ssh"} disabled={sshPending} onClick={() => setPairMode("ssh")}>通过 SSH 添加</button>
              <button type="button" className="button" aria-pressed={pairMode === "manual"} disabled={sshPending} onClick={() => setPairMode("manual")}>手动配对</button>
            </div>
          )}
          {pairMode === "ssh" ? sshResult ? (
            <div className="pair-result">
              <p role="status">{sshResult.online ? "Gateway 已安装并连接。" : "Gateway 已启动，中心正在重试连接。请检查 SSH 服务端是否允许反向端口转发。"}</p>
              <button className="button primary" onClick={() => setModal(null)}>完成</button>
            </div>
          ) : (
            <form onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const get = (key: string) => String(values.get(key) ?? "").trim();
              setSshError("");
              setSshPending(true);
              void api<{ online: boolean }>("/hosts/ssh", {
                name: pairName,
                target: get("target"),
                ...(get("port") ? { port: Number(get("port")) } : {}),
                jump: get("jump") || undefined,
                root: get("root") || undefined,
                ...(sshAuth === "password" ? { password: values.get("password") } : {}),
              }).then((result) => {
                setSshResult(result);
                void refresh();
              }).catch((error: Error) => setSshError(error.message))
                .finally(() => setSshPending(false));
            }}>
              <fieldset className="ssh-fields" disabled={sshPending}>
                <p className="modal-description">中心会上传内置 Gateway，并维持 SSH 隧道。无需给中心配置 HTTPS。</p>
                <label>主机名称<input value={pairName} onChange={(event) => setPairName(event.target.value)} required maxLength={100} placeholder="例如：开发服务器" /></label>
                <div className="ssh-address">
                  <label>SSH 主机<input name="target" placeholder="例如：devbox 或 dev@10.0.0.12" required maxLength={255} /></label>
                  <label>SSH 端口<input name="port" inputMode="numeric" type="number" min="1" max="65535" placeholder="默认" /></label>
                </div>
                <label>认证方式
                  <select value={sshAuth} onChange={(event) => setSshAuth(event.target.value as typeof sshAuth)}>
                    <option value="key">SSH 密钥 / ssh-agent</option>
                    <option value="password">SSH 密码</option>
                  </select>
                </label>
                {sshAuth === "password" && (
                  <label>SSH 密码<input name="password" type="password" autoComplete="new-password" required maxLength={1024} /></label>
                )}
                <p className="hint">首次连接请在中心机器核对并保存 SSH 主机指纹。{sshAuth === "password" && "密码会加密保存在中心，用于隧道自动重连。跳板仍使用 SSH 密钥。"}</p>
                <details className="ssh-options">
                  <summary>连接选项</summary>
                  <label>SSH 跳板<input name="jump" maxLength={255} placeholder="例如：bastion" /></label>
                  <label>远程工作目录<input name="root" maxLength={1024} placeholder="默认使用远程用户的家目录" /></label>
                </details>
                {sshError && <p role="alert" className="hint">{sshError}</p>}
                <div className="form-actions">
                  <button className="button primary">{sshPending ? "正在上传并连接…" : "上传并连接"}{sshPending ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />}</button>
                </div>
              </fieldset>
            </form>
          ) : !pair ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void api<{ code: string; host: string }>("/hosts/pairings", {
                  name: pairName,
                })
                  .then(setPair)
                  .catch(report);
              }}
            >
              <p className="modal-description">
                在目标设备运行 Go Gateway。它会主动连接中心，无需设备拥有公网 IP。
              </p>
              <label>
                主机名称
                <input
                  placeholder="例如：开发服务器"
                  value={pairName}
                  onChange={(e) => setPairName(e.target.value)}
                  required
                  maxLength={100}
                />
              </label>
              <label>目标设备
                <select value={pairPlatform} onChange={(event) => setPairPlatform(event.target.value as typeof pairPlatform)}>
                  <option value="linux-x64">Linux x64</option>
                  <option value="linux-arm64">Linux ARM64</option>
                  <option value="windows-x64">Windows x64</option>
                </select>
              </label>
              <label>目标设备可访问的中心地址
                <input type="url" value={pairCenter} onChange={(event) => setPairCenter(event.target.value)} required placeholder="https://acp.example.com" />
              </label>
              <p className="hint">无需在设备上安装 Node.js。中心需要可访问的 HTTPS 地址。</p>
              <div className="form-actions">
                <button className="button primary">
                  生成一次性配对码
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </form>
          ) : (
            <div className="pair-result">
              <p>先进入目标工作目录，再运行以下命令。配对码 10 分钟有效，只能使用一次。</p>
              <label>目标设备
                <select value={pairPlatform} onChange={(event) => setPairPlatform(event.target.value as typeof pairPlatform)}>
                  <option value="linux-x64">Linux x64</option>
                  <option value="linux-arm64">Linux ARM64</option>
                  <option value="windows-x64">Windows x64</option>
                </select>
              </label>
              <label>中心地址
                <input type="url" value={pairCenter} onChange={(event) => setPairCenter(event.target.value)} placeholder="https://acp.example.com" />
              </label>
              <pre>{pairCommand}</pre>
              <Copy text={pairCommand} />
              <p className="hint">
                配对后在 .gateway/config.json 的 agents 中配置本机 ACP Agent，再运行 `--stop` 和 `--daemon` 重启 Gateway。配置文件包含设备凭据，请限制访问。
              </p>
              <button
                className="button primary"
                onClick={() => {
                  setModal(null);
                  void refresh();
                }}
              >
                完成
              </button>
            </div>
          )}
        </Modal>
      )}
      {modal === "search" && (
        <Modal title="跳转到工作" onClose={() => setModal(null)}>
          <label className="palette-search">
            <Search size={18} />
            <input
              autoFocus
              placeholder="搜索会话标题…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const s = sessions.find((s) =>
                    s.title.toLowerCase().includes(search.toLowerCase()),
                  );
                  if (s) {
                    navigate(`/session/${s.id}`);
                    setModal(null);
                    setSearch("");
                  }
                }
              }}
            />
          </label>
          <div className="palette-results">
            {sessions
              .filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
              .slice(0, 12)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    navigate(`/session/${s.id}`);
                    setModal(null);
                    setSearch("");
                  }}
                >
                  <MessageSquare size={16} />
                  <span>{s.title}</span>
                  <Status status={s.status} />
                </button>
              ))}
            {sessions.length === 0 && <p className="hint">还没有会话。先连接一位 Agent。</p>}
          </div>
        </Modal>
      )}
      {modal === "diagnostics" && (
        <Modal title="日志与诊断" onClose={() => setModal(null)}>
          <div className="diagnostic-settings">
            <div>
              <strong>测试功能</strong>
              <p>开启后可使用测试 Agent；正式 Agent 的连接不受影响。</p>
            </div>
            <input
              type="checkbox"
              aria-label="测试功能"
              checked={diagnostics?.testFeatures ?? false}
              onChange={(event) => {
                const enabled = event.target.checked;
                setDiagnostics((old) => (old ? { ...old, testFeatures: enabled } : old));
                setConfig((old) => ({ ...old, testFeatures: enabled }));
                void api("/settings/test-features", { enabled })
                  .then(() => {
                    void detect();
                  })
                  .catch((error) => {
                    setDiagnostics((old) => (old ? { ...old, testFeatures: !enabled } : old));
                    setConfig((old) => ({ ...old, testFeatures: !enabled }));
                    report(error);
                  });
              }}
            />
          </div>
          {config.supervised && (
            <div className="diagnostic-settings">
              <div>
                <strong>重启中心</strong>
                <p>先等待本机 Agent 完成当前工作，再重启服务。远程 Gateway 会自动重连。</p>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => {
                  void api<{ status: string }>("/system/restart", {})
                    .then(() => {
                      setToast("已安排重启，当前工作完成后会自动恢复连接");
                      setModal(null);
                      void (async () => {
                        let disconnected = false;
                        for (let attempt = 0; attempt < 720; attempt++) {
                          await new Promise((resolve) => setTimeout(resolve, 1000));
                          const ready = await fetch("/api/auth", { cache: "no-store" })
                            .then((r) => r.ok)
                            .catch(() => false);
                          if (!ready) disconnected = true;
                          if (disconnected && ready) {
                            location.reload();
                            return;
                          }
                        }
                      })();
                    })
                    .catch(report);
                }}
              >
                等待完成后重启
              </button>
            </div>
          )}
          <div className="diagnostic-filters">
            <input
              aria-label="搜索日志"
              placeholder="搜索 Agent、错误或会话…"
              value={logSearch}
              onChange={(event) => setLogSearch(event.target.value)}
            />
            <select
              aria-label="日志级别"
              value={logLevel}
              onChange={(event) => setLogLevel(event.target.value)}
            >
              <option value="all">全部</option>
              <option value="error">错误</option>
              <option value="warning">提示</option>
              <option value="info">信息</option>
            </select>
          </div>
          <div className="diagnostic-list">
            {diagnostics?.logs
              .filter(
                (log) =>
                  (logLevel === "all" || log.level === logLevel) &&
                  `${log.message} ${log.agent ?? ""} ${log.session ?? ""} ${log.code}`
                    .toLowerCase()
                    .includes(logSearch.toLowerCase()),
              )
              .map((log) => (
                <details className={`diagnostic-entry ${log.level}`} key={log.id}>
                  <summary>
                    <span>{new Date(log.createdAt).toLocaleString()}</span>
                    <strong>{log.message.split("\n")[0]}</strong>
                    <small>{log.agent ?? log.source}</small>
                  </summary>
                  <pre>{log.message}</pre>
                  <p>
                    {log.code}
                    {log.session ? ` · ${log.session}` : ""}
                  </p>
                </details>
              ))}
            {diagnostics?.logs.length === 0 && <p className="hint">还没有诊断记录。</p>}
          </div>
          {diagnostics?.logs.length && diagnostics.logs.length < 1000 ? (
            <button
              className="text-button"
              onClick={() => {
                const before = diagnostics.logs.at(-1)?.id;
                if (!before) return;
                void api<DiagnosticData>(`/diagnostics?before=${before}`)
                  .then((older) =>
                    setDiagnostics((current) =>
                      current ? { ...current, logs: [...current.logs, ...older.logs] } : current,
                    ),
                  )
                  .catch(report);
              }}
            >
              查看更早记录
            </button>
          ) : null}
        </Modal>
      )}
      {recovery && (
        <Modal title="保存新的设备身份" onClose={() => setRecovery(null)}>
          <p className="modal-description">{recovery.warning}</p>
          <p>
            在目标设备停止 Gateway 后，运行 acpao-gateway --import-identity
            /安全路径/identity.json。该操作保留原有工作目录、Agent 配置和本地记录。
          </p>
          <p className="hint">请将文件保存在安全位置；获得它的人可以冒充该设备。</p>
          <div className="form-actions">
            <button
              className="button primary"
              onClick={() =>
                download(
                  { host: recovery.host, token: recovery.token },
                  `acpao-${recovery.host}-identity.json`,
                )
              }
            >
              <Download size={16} />
              下载恢复凭据
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
