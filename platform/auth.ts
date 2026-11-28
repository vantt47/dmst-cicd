// Đăng nhập (Google), phiên, API token, vai trò và quyền.
//
// Vai trò hệ thống: owner (toàn quyền), admin (quản lý người dùng + mọi dự án), member (chỉ theo quyền dự án).
// Vai trò dự án × môi trường: viewer < tester < developer < releaser < admin. Chỉ người được mời mới đăng nhập được.
import { createHash, randomBytes } from "node:crypto";
import { db, audit } from "./db";
import { E, now } from "./lib";

export const GOOGLE_CLIENT_ID = E.GOOGLE_CLIENT_ID ?? "764794139184-sn5rdvuqkqevqtrupcl8kkm7p53h5d1g.apps.googleusercontent.com";
// Super admin (owner) DUY NHẤT, ghim trong mã (quyết định 27/11/2026): không đổi qua biến môi trường, giao diện/API không
// cấp được vai trò owner cho ai khác, không khoá/xoá/hạ quyền được tài khoản này. Người khác do owner/admin mời.
export const OWNER_EMAIL = "vantt47@gmail.com";
export const SESSION_HOURS = 12;
export const COOKIE = "dmstcicd";

export type SysRole = "owner" | "admin" | "member";
export type Role = "viewer" | "tester" | "developer" | "releaser" | "admin";
export const ROLES: Role[] = ["viewer", "tester", "developer", "releaser", "admin"];
export const ROLE_LABEL: Record<Role, string> = { viewer: "Viewer", tester: "Tester", developer: "Developer", releaser: "Releaser", admin: "Project Admin" };
export type Perm = "view" | "logs" | "deploy" | "restart" | "check" | "build" | "bypass" | "manage";
// Ma trận quyền (docs/de-xuat-nen-tang-cicd.md mục 4.3). Không có quy tắc 2 người (quyết định 23/11/2026).
export const PERMS: Record<Role, Perm[]> = {
  viewer: ["view"],
  tester: ["view", "logs", "deploy", "restart"],
  developer: ["view", "logs", "deploy", "restart", "check", "build"],
  releaser: ["view", "logs", "deploy", "restart", "check", "build", "bypass"],
  admin: ["view", "logs", "deploy", "restart", "check", "build", "bypass", "manage"],
};
export const PERM_LABEL: Record<Perm, string> = {
  view: "Xem trạng thái, lịch sử, log job", logs: "Xem log pod/container", deploy: "Deploy thẻ có sẵn (đổi bản)",
  restart: "Khởi động lại service", check: "Chạy kiểm tra (CI)", build: "Build & deploy",
  bypass: "Bỏ qua chặn CI/Trivy (khẩn cấp)", manage: "Gán quyền trong dự án",
};

export type User = { id: number; email: string; name: string | null; display: string | null; picture: string | null; role: SysRole; active: number; created: string; last_login: string | null };
export const displayName = (u: Pick<User, "display" | "name" | "email">) => u.display || u.name || u.email;

// Mỗi lần khởi động: owner luôn tồn tại, luôn hoạt động; mọi tài khoản khác lỡ mang vai trò owner bị hạ về admin.
db.query("UPDATE users SET role = 'admin' WHERE role = 'owner' AND email <> ?").run(OWNER_EMAIL);
db.query("INSERT INTO users (email, role, created) VALUES (?, 'owner', ?) ON CONFLICT(email) DO UPDATE SET role = 'owner', active = 1").run(OWNER_EMAIL, now());
// Chặn ngay trong CSDL: chỉ OWNER_EMAIL được là owner, và tài khoản đó không bị khoá/xoá/đổi email.
db.exec(`
CREATE TRIGGER IF NOT EXISTS owner_only_ins BEFORE INSERT ON users WHEN NEW.role = 'owner' AND NEW.email <> '${OWNER_EMAIL}'
  BEGIN SELECT RAISE(ABORT, 'chỉ có một super admin'); END;
CREATE TRIGGER IF NOT EXISTS owner_only_upd BEFORE UPDATE ON users WHEN (NEW.role = 'owner' AND NEW.email <> '${OWNER_EMAIL}')
  OR (OLD.email = '${OWNER_EMAIL}' AND (NEW.role <> 'owner' OR NEW.active = 0 OR NEW.email <> OLD.email))
  BEGIN SELECT RAISE(ABORT, 'không đổi được super admin'); END;
CREATE TRIGGER IF NOT EXISTS owner_no_delete BEFORE DELETE ON users WHEN OLD.email = '${OWNER_EMAIL}'
  BEGIN SELECT RAISE(ABORT, 'không xoá được super admin'); END;
`);
export const isOwner = (u: Pick<User, "email" | "role">) => u.role === "owner" && u.email === OWNER_EMAIL;
// Người u có được đổi vai trò hệ thống/khoá tài khoản target không. Owner không ai đụng được; admin chỉ owner gán/gỡ.
export function canManageUser(u: User, target: User, newRole?: SysRole) {
  if (target.email === OWNER_EMAIL || newRole === "owner") return false;
  if (isOwner(u)) return true;
  return u.role === "admin" && target.role === "member" && (newRole === undefined || newRole === "member");
}

export const userById = (id: number) => db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
export const userByEmail = (email: string) => db.query("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as User | null;
export const isSysAdmin = (u: User) => u.role === "owner" || u.role === "admin";
export function memberships(userId: number) {
  return db.query("SELECT project, env, role FROM memberships WHERE user_id = ?").all(userId) as { project: string; env: string; role: Role }[];
}
export function roleOf(u: User, project: string, env: string): Role | null {
  if (isSysAdmin(u)) return "admin";
  const r = db.query("SELECT role FROM memberships WHERE user_id = ? AND project = ? AND env = ?").get(u.id, project, env) as { role: Role } | null;
  return r?.role ?? null;
}
export const can = (u: User, project: string, env: string, perm: Perm) => {
  const r = roleOf(u, project, env);
  return !!r && PERMS[r].includes(perm);
};
// Quyền ở cấp dự án (kiểm tra CI dùng chung cho mọi môi trường của dự án): có quyền ở ít nhất một môi trường.
export const canProject = (u: User, project: string, envs: string[], perm: Perm) => envs.some((e) => can(u, project, e, perm));

// ---------------- Phiên ----------------
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function createSession(u: User, ip: string, ua: string, via: string) {
  const id = randomBytes(32).toString("base64url");
  const exp = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  db.query("INSERT INTO sessions (hash, user_id, created, expires, last_seen, ip, ua, via) VALUES (?,?,?,?,?,?,?,?)").run(sha(id), u.id, now(), exp, now(), ip, ua.slice(0, 200), via);
  db.query("UPDATE users SET last_login = ? WHERE id = ?").run(now(), u.id);
  db.query("DELETE FROM sessions WHERE expires < ?").run(now());
  return id;
}
export const cookieOf = (req: Request) => (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1] ?? null;
export function sessionUser(req: Request): { user: User; via: "session" | "token"; tokenId?: number } | null {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(dmst_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (bearer) {
    const t = db.query("SELECT id, user_id, expires FROM tokens WHERE hash = ? AND revoked = 0").get(sha(bearer)) as { id: number; user_id: number; expires: string | null } | null;
    if (!t || (t.expires && t.expires < now())) return null;
    const u = userById(t.user_id);
    if (!u || !u.active) return null;
    db.query("UPDATE tokens SET last_used = ? WHERE id = ?").run(now(), t.id);
    return { user: u, via: "token", tokenId: t.id };
  }
  const c = cookieOf(req);
  if (!c) return null;
  const s = db.query("SELECT user_id, expires FROM sessions WHERE hash = ?").get(sha(c)) as { user_id: number; expires: string } | null;
  if (!s || s.expires < now()) return null;
  const u = userById(s.user_id);
  if (!u || !u.active) return null; // khoá tài khoản có hiệu lực ngay
  db.query("UPDATE sessions SET last_seen = ? WHERE hash = ?").run(now(), sha(c));
  return { user: u, via: "session" };
}
export const endSession = (req: Request) => { const c = cookieOf(req); if (c) db.query("DELETE FROM sessions WHERE hash = ?").run(sha(c)); };
export const currentSessionHash = (req: Request) => { const c = cookieOf(req); return c ? sha(c) : null; };

// ---------------- API token ----------------
export function createToken(u: User, name: string, days: number | null) {
  const raw = "dmst_" + randomBytes(24).toString("base64url");
  const exp = days ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  const r = db.query("INSERT INTO tokens (user_id, name, hash, prefix, created, expires) VALUES (?,?,?,?,?,?)").run(u.id, name, sha(raw), raw.slice(0, 10), now(), exp);
  return { id: Number(r.lastInsertRowid), token: raw };
}

// ---------------- Google ----------------
// ID token Google (GIS) → hồ sơ đã xác minh, hoặc null. tokeninfo của Google kiểm chữ ký và hạn; ở đây kiểm aud, iss, email.
export async function googleProfile(credential: string): Promise<{ email: string; name: string | null; picture: string | null } | null> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) || credential.length > 4096) return null;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const t: any = await r.json();
  if (t.aud !== GOOGLE_CLIENT_ID) return null;
  if (t.iss !== "accounts.google.com" && t.iss !== "https://accounts.google.com") return null;
  if (t.email_verified !== "true" && t.email_verified !== true) return null;
  if (!(Number(t.exp) * 1000 > Date.now())) return null;
  if (typeof t.email !== "string") return null;
  return { email: t.email.toLowerCase(), name: typeof t.name === "string" ? t.name : null, picture: typeof t.picture === "string" ? t.picture : null };
}

// Chặn dò: 8 lần sai / 15 phút / IP
const fails = new Map<string, { n: number; until: number }>();
export const tooMany = (ip: string) => { const f = fails.get(ip); return !!f && f.n >= 8 && f.until > Date.now(); };
export const failed = (ip: string) => { const f = fails.get(ip); const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 15 * 60_000 }; cur.n++; fails.set(ip, cur); };
export const succeeded = (ip: string) => fails.delete(ip);

export function loginWith(profile: { email: string; name: string | null; picture: string | null }, ip: string, ua: string, via: string) {
  const u = userByEmail(profile.email);
  if (!u || !u.active) {
    audit({ actor: profile.email, action: "login.denied", detail: u ? "tài khoản bị khoá" : "chưa được mời", ip, ok: false });
    return null;
  }
  db.query("UPDATE users SET name = ?, picture = ? WHERE id = ?").run(profile.name, profile.picture, u.id);
  audit({ userId: u.id, actor: displayName(u), action: "login", detail: via, ip });
  return createSession(userById(u.id)!, ip, ua, via);
}
