import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import {
  AppError,
  type Session,
  type Host,
  type Event,
  type Message,
  type Command,
  type Approval,
  type Principal,
} from "./types.js";
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const decode = <T>(row: unknown): T | undefined =>
  row ? (JSON.parse((row as { data: string }).data) as T) : undefined;
export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL,origin TEXT,originSeq INTEGER, UNIQUE(origin,originSeq));
  CREATE INDEX IF NOT EXISTS events_session ON events(session,seq);
  CREATE INDEX IF NOT EXISTS object_status ON objects(kind,json_extract(data,'$.status'),json_extract(data,'$.session'));
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,run TEXT NOT NULL,createdAt INTEGER NOT NULL, UNIQUE(session,role,run));
  CREATE INDEX IF NOT EXISTS messages_session ON messages(session,id);
  CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,createdAt INTEGER NOT NULL);
  `);
    this.changes.setMaxListeners(200);
  }
  get<T>(kind: string, key: string) {
    return decode<T>(
      this.db.prepare("SELECT data FROM objects WHERE kind=? AND id=?").get(kind, key),
    );
  }
  all<T>(kind: string) {
    return this.db
      .prepare("SELECT data FROM objects WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => decode<T>(r)!);
  }
  put(kind: string, key: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, key, JSON.stringify(data));
  }
  remove(kind: string, key: string) {
    this.db.prepare("DELETE FROM objects WHERE kind=? AND id=?").run(kind, key);
  }
  transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = f();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  session(key: string) {
    const s = this.get<Session>("session", key);
    if (!s) throw new AppError("SESSION_NOT_FOUND", "会话不存在", 404);
    return s;
  }
  sessions() {
    return this.all<Session>("session").sort((a, b) => b.updatedAt - a.updatedAt);
  }
  host(key: string) {
    const h = this.get<Host>("host", key);
    if (!h) throw new AppError("HOST_NOT_FOUND", "主机不存在", 404);
    return h;
  }
  event(session: string, kind: string, data: unknown, origin?: string, originSeq?: number) {
    const row = this.db
      .prepare(
        "INSERT OR IGNORE INTO events(session,kind,data,createdAt,origin,originSeq) VALUES (?,?,?,?,?,?) RETURNING seq",
      )
      .get(session, kind, JSON.stringify(data), Date.now(), origin ?? null, originSeq ?? null) as
      { seq: number } | undefined;
    if (row) {
      this.changes.emit("event");
      return row.seq;
    }
    return undefined;
  }
  updateSession(key: string, patch: Partial<Session>) {
    const s = { ...this.session(key), ...patch, updatedAt: Date.now() };
    this.transaction(() => {
      this.put("session", key, s);
      this.event(key, "session", s);
    });
    return s;
  }
  events(session: string | undefined, after = 0, limit = 100): Event[] {
    const rows = session
      ? this.db
          .prepare("SELECT * FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT ?")
          .all(session, after, limit)
      : this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit);
    return rows.map((r) => ({
      ...r,
      data: JSON.parse(r.data as string),
    })) as unknown as Event[];
  }
  cursor() {
    return Number(
      (
        this.db
          .prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n")
          .get() as {
          n: number;
        }
      ).n,
    );
  }
  message(session: string, role: Message["role"], run: string, body: string, append = false) {
    // Bound individual messages; raw protocol updates remain separately traceable.
    this.db
      .prepare(
        `INSERT INTO messages(session,role,body,run,createdAt) VALUES (?,?,?,?,?) ON CONFLICT(session,role,run) DO UPDATE SET body=substr(${append ? "messages.body || excluded.body" : "excluded.body"},1,2000000)`,
      )
      .run(session, role, body, run, Date.now());
  }
  messages(session: string, before = Number.MAX_SAFE_INTEGER, limit = 80) {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE session=? AND id<? ORDER BY id DESC LIMIT ?")
        .all(session, before, limit) as unknown as Message[]
    ).reverse();
  }
  command(c: Command) {
    this.put("command", c.id, c);
  }
  commands(session?: string, status?: Command["status"]) {
    return this.db
      .prepare(
        "SELECT data FROM objects WHERE kind='command' AND (? IS NULL OR json_extract(data,'$.session')=?) AND (? IS NULL OR json_extract(data,'$.status')=?) ORDER BY rowid",
      )
      .all(session ?? null, session ?? null, status ?? null, status ?? null)
      .map((row) => decode<Command>(row)!);
  }
  approval(a: Approval) {
    this.put("approval", a.id, a);
    this.event(a.session, "approval", a);
  }
  approvals(session?: string) {
    return this.all<Approval>("approval").filter(
      (a) => a.status === "pending" && (!session || a.session === session),
    );
  }
  credential(token: string, p: Principal, expires?: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO credentials VALUES (?,?,?)")
      .run(hash(token), JSON.stringify(p), expires ?? null);
  }
  authenticate(token: string) {
    const r = this.db
      .prepare("SELECT * FROM credentials WHERE hash=? AND (expires IS NULL OR expires>?)")
      .get(hash(token), Date.now());
    return r ? (JSON.parse(r.data as string) as Principal) : undefined;
  }
  revoke(kind: string, key: string) {
    this.db
      .prepare(
        "DELETE FROM credentials WHERE json_extract(data,'$.kind')=? AND (json_extract(data,'$.id')=? OR json_extract(data,'$.host')=?)",
      )
      .run(kind, key, key);
  }
  audit(p: Principal, action: string, target: string) {
    this.db
      .prepare("INSERT INTO audit(actor,action,target,createdAt) VALUES (?,?,?,?)")
      .run(`${p.kind}:${p.id}`, action, target, Date.now());
  }
  prune(days = 30) {
    const cutoff = Date.now() - days * 86400000;
    const pruned = (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) n FROM events WHERE createdAt<? AND kind NOT IN ('session','approval')",
        )
        .get(cutoff) as { n: number }
    ).n;
    if (pruned)
      this.put(
        "setting",
        "pruned-through",
        Math.max(pruned, this.get<number>("setting", "pruned-through") ?? 0),
      );
    this.db
      .prepare("DELETE FROM events WHERE createdAt<? AND kind NOT IN ('session','approval')")
      .run(cutoff);
    this.db.prepare("DELETE FROM audit WHERE createdAt<?").run(Date.now() - 90 * 86400000);
    this.db
      .prepare("DELETE FROM credentials WHERE expires IS NOT NULL AND expires<?")
      .run(Date.now());
  }
  eventFloor() {
    return Number(
      (
        this.db.prepare("SELECT COALESCE(MIN(seq),0) n FROM events").get() as {
          n: number;
        }
      ).n,
    );
  }
  pruneJournal(acknowledged: number, days = 30) {
    const through = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0) n FROM events WHERE seq<=? AND createdAt<?")
        .get(acknowledged, Date.now() - days * 86400000) as { n: number }
    ).n;
    if (through)
      this.transaction(() => {
        this.put("setting", "journal-floor", through);
        this.db.prepare("DELETE FROM events WHERE seq<=?").run(through);
      });
  }
  close() {
    this.changes.removeAllListeners();
    this.db.close();
  }
}
