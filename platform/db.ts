// CSDL của nền tảng: một tệp SQLite (bun:sqlite) trong WORK_DIR. Cấu hình dự án nằm trong mã (projects.ts), CSDL chỉ
// giữ dữ liệu vận hành: người dùng, quyền, phiên, token, nhật ký kiểm toán, job, lượt kiểm tra.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { WORK, now } from "./lib";

export const db = new Database(join(WORK, "cicd.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, display TEXT, picture TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, invited_by INTEGER, last_login TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, project TEXT NOT NULL, env TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','tester','developer','releaser','admin')),
  PRIMARY KEY (user_id, project, env)
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created TEXT NOT NULL, expires TEXT NOT NULL, last_seen TEXT, ip TEXT, ua TEXT, via TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created TEXT NOT NULL, expires TEXT, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail TEXT, ip TEXT, ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, env TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  created TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_t ON jobs(project, env, created);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, sha TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_p ON checks(project, created);
CREATE INDEX IF NOT EXISTS checks_sha ON checks(project, sha);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
// Nhật ký kiểm toán chỉ ghi thêm: chặn sửa/xoá ngay trong CSDL.
db.exec(`
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit chỉ ghi thêm'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit chỉ ghi thêm'); END;
`);

export type AuditIn = { userId?: number | null; actor: string; action: string; target?: string; detail?: unknown; ip?: string; ok?: boolean };
export function audit(a: AuditIn) {
  db.query("INSERT INTO audit (at, user_id, actor, action, target, detail, ip, ok) VALUES (?,?,?,?,?,?,?,?)").run(
    now(), a.userId ?? null, a.actor, a.action, a.target ?? null,
    a.detail === undefined ? null : typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail), a.ip ?? null, a.ok === false ? 0 : 1);
}

export const kvGet = <T>(k: string): T | null => {
  const r = db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null;
  return r ? JSON.parse(r.v) : null;
};
export const kvSet = (k: string, v: unknown) => db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
