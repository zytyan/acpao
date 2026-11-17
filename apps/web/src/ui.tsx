import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Check,
  Copy as CopyIcon,
  X,
  LoaderCircle,
  Plus,
  Terminal,
  Folder,
  ChevronDown,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { statusName, busy, type Message, type ChatData, type Agent } from "./api";
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${busy(status) ? "working" : ""}`}>
      <i />
      {statusName[status] ?? status}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Copy({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="subtle-button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        });
      }}
    >
      {done ? <Check size={14} /> : <CopyIcon size={14} />} {done ? "已复制" : label}
    </button>
  );
}
export function relativeTime(n: number) {
  const m = Math.floor((Date.now() - n) / 60000);
  return m < 1
    ? "刚刚"
    : m < 60
      ? `${m} 分钟前`
      : m < 1440
        ? `${Math.floor(m / 60)} 小时前`
        : new Date(n).toLocaleDateString("zh-CN", {
            month: "short",
            day: "numeric",
          });
}
export function MessageBody({ message }: { message: Message }) {
  if (message.role === "tool")
    return (
      <details className="tool-message">
        <summary>
          <Terminal size={14} />
          {message.body.split("\n")[0]}
          <ChevronDown size={13} />
        </summary>
        <pre>{message.body}</pre>
      </details>
    );
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === "assistant" ? <Mark small /> : "你"}</div>
      <div className="message-content">
        <div className="message-author">
          {message.role === "assistant" ? "Agent" : message.role === "user" ? "你" : "系统"}
          <time>
            {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              pre: ({ children }) => (
                <div className="code-wrap">
                  <pre>{children}</pre>
                </div>
              ),
            }}
          >
            {message.body}
          </Markdown>
        </div>
      </div>
    </article>
  );
}
export function Conversation({
  data,
  onOlder,
  canOlder,
}: {
  data: ChatData;
  onOlder: () => void;
  canOlder: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    last = useRef("");
  const useVirtual = data.messages.length > 60;
  const virtual = useVirtualizer({
    count: useVirtual ? data.messages.length : 0,
    getScrollElement: () => parent.current,
    estimateSize: () => 160,
    overscan: 8,
  });
  const signature = `${data.messages.length}:${data.messages.at(-1)?.body.length}`;
  useEffect(() => {
    if (last.current !== signature && atBottom.current) {
      requestAnimationFrame(() => {
        const el = parent.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    last.current = signature;
  }, [signature]);
  return (
    <div
      ref={parent}
      className="conversation-scroll"
      onScroll={() => {
        const el = parent.current!;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      }}
    >
      <div className="conversation-inner">
        {canOlder && (
          <button
            className="history-button"
            onClick={() => {
              atBottom.current = false;
              onOlder();
            }}
          >
            加载更早的消息
          </button>
        )}
        {data.messages.length === 0 ? (
          <div className="chat-intro">
            <Mark />
            <h2>从一个目标开始</h2>
            <p>描述你想完成的事，让 Agent 组织接下来的工作。</p>
            <div className="intro-details">
              <Folder size={14} />
              <span>{data.session.cwd}</span>
            </div>
          </div>
        ) : useVirtual ? (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => (
              <div
                key={data.messages[item.index]!.id}
                ref={virtual.measureElement}
                data-index={item.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <MessageBody message={data.messages[item.index]!} />
              </div>
            ))}
          </div>
        ) : (
          data.messages.map((m) => <MessageBody key={m.id} message={m} />)
        )}
        {busy(data.session.status) && (
          <div className="thinking">
            <span />
            <span />
            <span />
            {statusName[data.session.status]}
          </div>
        )}
      </div>
    </div>
  );
}
export function AgentForm({
  onSave,
  fixture,
  onError,
}: {
  onSave: (agent: Agent) => Promise<void>;
  fixture?: Agent;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState("Codex ACP"),
    [command, setCommand] = useState("codex-acp"),
    [args, setArgs] = useState("[]"),
    [env, setEnv] = useState("{}"),
    [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        try {
          const a: Agent = {
            id:
              name
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, "-")
                .slice(0, 64) || "agent",
            name,
            command,
            args: JSON.parse(args),
            env: JSON.parse(env),
          };
          void onSave(a)
            .catch(onError)
            .finally(() => setSaving(false));
        } catch (e) {
          onError(e);
          setSaving(false);
        }
      }}
    >
      <label>
        显示名称
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        ACP 启动程序
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          required
          placeholder="/usr/local/bin/codex-acp"
        />
      </label>
      <p className="hint">
        使用支持 ACP 的适配器。普通 Codex / Claude CLI 不一定提供 ACP
        stdio；请先在主机终端完成适配器安装与登录。
      </p>
      <details className="advanced">
        <summary>
          启动参数与环境变量 <ChevronDown size={14} />
        </summary>
        <label>
          参数（JSON 数组）
          <input value={args} onChange={(e) => setArgs(e.target.value)} />
        </label>
        <label>
          环境变量（JSON 对象）
          <textarea value={env} onChange={(e) => setEnv(e.target.value)} />
        </label>
        <p className="hint">
          仅启动配置中的变量会传入 Agent。凭据保存在受限的本地数据库，请使用专门的运行账户。
        </p>
      </details>
      <div className="form-actions">
        {fixture && (
          <button
            type="button"
            className="text-button"
            onClick={() => void onSave(fixture).catch(onError)}
          >
            使用测试 Agent
          </button>
        )}
        <button disabled={saving} className="button primary">
          {saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          添加 Agent
        </button>
      </div>
    </form>
  );
}
