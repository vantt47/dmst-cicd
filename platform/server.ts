// DMST CI/CD: một trang quản lý CI/CD staging của nhiều dự án, https://cicd.dmst.vn (docs/de-xuat-nen-tang-cicd.md).
// Chạy trên PC quản trị (Windows, Bun, Docker Desktop, kubectl/ssh qua Tailscale, cloudflared), chỉ nghe 127.0.0.1.
//
//   - Đăng nhập Google (chỉ người được mời). Super admin duy nhất vantt47@gmail.com (auth.ts).
//   - Quyền theo dự án × môi trường (viewer/tester/developer/releaser/admin), kiểm ở server cho MỌI API.
//   - Mỗi dự án × môi trường một trang /p/<dự án>/<môi trường>/, API ở /p/<dự án>/<môi trường>/api/...
//   - Nhật ký kiểm toán (chỉ ghi thêm) cho đăng nhập, kiểm tra, build, deploy, restart, bỏ qua chặn, đổi quyền, token.
//   - PREVIEW=1 (mặc định): bản xem trước chạy song song trang cũ, chỉ đọc trạng thái thật, thao tác ghi chỉ giả lập.
//
// Chạy thử: `bun platform/server.ts` rồi mở http://localhost:8090 (thêm http://localhost:8090 vào Authorized JavaScript
// origins của OAuth client Google). Không có gói phụ thuộc, chỉ API có sẵn của Bun.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { E, PORT, PREVIEW, PUBLIC_HOST, REF_OK, TAG_OK, children, keepAlive, lifecycle, newId, now, run, secret } from "./lib";
import { db, audit, kvGet, kvSet } from "./db";
import {
  COOKIE, GOOGLE_CLIENT_ID, OWNER_EMAIL, PERMS, PERM_LABEL, ROLES, ROLE_LABEL, SESSION_HOURS,
  can, canManageUser, createToken, displayName, endSession, failed, googleProfile, isOwner, isSysAdmin, loginWith,
  memberships, roleOf, sessionUser, succeeded, tooMany, userByEmail, userById, type Perm, type Role, type SysRole, type User,
} from "./auth";
import { RT, type EnvDef, type ProjectRt } from "./projects";
import type { EnvAdapter } from "./adapters/types";
import { newCheck, runCheck, type CheckRun } from "./ci";
import {
  activeChecks, busyJobs, checkLogLines, checkOf, enqueue, enqueueCheck, getCheck, getJob, lastJob, listChecks, listJobs, logLines,
  setLegacyChecks, type Job,
} from "./queue";
import { notifyDone } from "./notify";
import { adminHtml, envHtml, homeHtml, loginHtml } from "./ui";

// ---------------- Tệp tĩnh ----------------
const WEB = join(import.meta.dir, "web");
const STATIC: Record<string, [ArrayBuffer, string]> = {};
const MIME: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
for (const f of readdirSync(WEB)) { // mọi tệp css/js/svg trong web/ (giao diện từng kiểu adapter: web/<kind>.js)
  const t = MIME[f.split(".").pop()!];
  if (t) STATIC[`/s/${f}`] = [await Bun.file(join(WEB, f)).arrayBuffer(), t];
}

// ---------------- HTTP ----------------
const SEC = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};
// Trang đăng nhập nạp nút Google (GIS): mở CSP đúng các đường dẫn GIS cần; GIS kiểm origin qua Referer.
const SEC_GIS = {
  ...SEC,
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' https://accounts.google.com/gsi/style; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const json = (d: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(d), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8", ...extra } });
const html = (b: string, status = 200, gis = false) => new Response(b, { status, headers: { ...(gis ? SEC_GIS : SEC), "Content-Type": "text/html; charset=utf-8" } });
const redirect = (to: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { ...SEC, Location: to, ...extra } });
// Secure: trình duyệt vẫn nhận trên http://localhost (bản chạy thử)
const cookie = (v: string, maxAge: number) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const sameOrigin = (req: Request) => {
  try { return new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { return false; }
};
const clientIp = (req: Request, srv: any) => req.headers.get("cf-connecting-ip") ?? srv.requestIP(req)?.address ?? "?";
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const deny = (msg = "Bạn không có quyền làm việc này") => { throw new HttpError(403, msg); };
const bad = (msg: string) => { throw new HttpError(400, msg); };

// ---------------- Tự cập nhật mã ----------------
// Mã chạy thẳng từ clone dmst-cicd (WORK/cicd) theo origin/main; thư mục platform/ trên origin/main khác mã đang chạy thì
// thoát lúc rảnh để start.ps1 lấy mã mới. Chạy ngoài git (máy dev) hoặc bản xem trước thì không kiểm tra.
const toolGit = (args: string[]) => run(["git", "-C", import.meta.dir, ...args], { quiet: true }).then((r) => (r.code === 0 ? r.out.trim() : ""), () => "");
const TOOL_BRANCH = E.TOOL_BRANCH ?? "main";
const TOOL_PATH = (await toolGit(["rev-parse", "--show-prefix"])).replace(/\/$/, "");
const SELF_UPDATE = !PREVIEW && E.SELF_UPDATE !== "0" && !!TOOL_PATH;
const RUNNING_TREE = SELF_UPDATE ? await toolGit(["rev-parse", `HEAD:${TOOL_PATH}`]) : "";
let restartPending = false, lastToolFetch = 0;
const busy = () => busyJobs() + activeChecks().length;
function exitForUpdate() {
  if (lifecycle.exiting) return;
  lifecycle.exiting = true;
  console.log(`${now()} dmst-cicd origin/${TOOL_BRANCH} có mã mới, thoát để start.ps1 cập nhật và chạy lại.`);
  for (const p of children) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 1000);
}
const idle = () => { if (restartPending && !busy()) exitForUpdate(); };
async function codeStale() {
  if (restartPending) return true;
  if (!RUNNING_TREE) return false;
  if (Date.now() - lastToolFetch > 30_000) { await toolGit(["fetch", "-q", "--prune", "origin"]); lastToolFetch = Date.now(); }
  const remote = await toolGit(["rev-parse", `origin/${TOOL_BRANCH}:${TOOL_PATH}`]);
  if (!remote || remote === RUNNING_TREE) return false;
  restartPending = true;
  idle();
  return true;
}
const STALE_MSG = "Trang vừa có mã mới (repo dmst-cicd), đang khởi động lại để dùng mã mới. Bấm lại sau khoảng 30 giây.";

// ---------------- Việc chung cho mọi dự án ----------------
const AUTO_USER = "Tự động (push)";
type EnvRt = { p: ProjectRt; pid: string; eid: string; def: EnvDef; adapter: EnvAdapter };
function envOf(pid: string, eid: string): EnvRt | null {
  const p = RT.get(pid);
  const e = p?.envs.get(eid);
  return p && e ? { p, pid, eid, def: e.def, adapter: e.adapter } : null;
}
const visibleEnvs = (u: User) => [...RT.values()].flatMap((p) => [...p.envs.values()].map((e) => ({ p, e }))).filter(({ p, e }) => can(u, p.def.id, e.def.id, "view"));

function startCheck(p: ProjectRt, sha: string, ref: string, subject: string, user: string, userId: number | null, auto = false) {
  const c = newCheck(p.def.ci, { id: newId(), project: p.def.id, sha, ref, subject, user, userId });
  c.auto = auto;
  enqueueCheck(c, async (c, log, changed) => {
    if (PREVIEW) {
      log(`[THỬ] Bản xem trước không chạy CI thật (trang cũ vẫn chạy CI cho commit này).`);
      log(`[THỬ] Sẽ chạy ${p.def.ci.groups.length} nhóm trong container ${p.def.ci.name}-${c.id}: ${p.def.ci.groups.map((g) => g.label).join(", ")}`);
      await Bun.sleep(1500);
      throw new Error("Bản xem trước: không chạy CI thật, xem kết quả của trang cũ");
    }
    await p.repo.ensure(log);
    await runCheck(p.def.ci, c, { repo: p.repo.dir, log, changed });
  }, { after: (c) => autoDeploy(p, c), idle });
  console.log(`${c.created} [${user}] kiểm tra ${p.def.id} ${ref} @ ${sha.slice(0, 7)}`);
  return c;
}

function startJob(env: EnvRt, j: Omit<Job, "id" | "project" | "env" | "status" | "created" | "tags"> & { tags?: Record<string, string> }) {
  const job: Job = { ...j, id: newId(), project: env.pid, env: env.eid, status: "queued", created: now(), tags: j.tags ?? {} };
  const work = job.kind === "build" ? env.adapter.build.bind(env.adapter) : env.adapter.deploy.bind(env.adapter);
  enqueue(job, work, {
    after: async (j, log) => {
      await notifyDone(env.def.notify, env.p.repo.dir, j, log);
      audit({ userId: j.userId ?? null, actor: j.user, action: `${j.kind}.done`, target: `${j.project}/${j.env}`, detail: { id: j.id, status: j.status, sha: j.sha, tags: j.tags, error: j.error }, ok: j.status === "ok" });
    },
    idle,
  });
  console.log(`${job.created} [${job.user}] ${job.kind} ${env.pid}/${env.eid} ${job.ref}${job.bypass ? " (BỎ QUA CHẶN)" : ""}`);
  return job;
}

// CD: lượt kiểm tra vừa đạt là commit ĐẦU nhánh của môi trường bật autoDeploy, chưa có job cho nó → Build & deploy.
async function autoDeploy(p: ProjectRt, c: CheckRun) {
  if (c.status !== "ok" || lifecycle.exiting) return;
  for (const [eid, e] of p.envs) {
    if (!e.def.autoDeploy) continue;
    await p.repo.fetch(true);
    if ((await p.repo.resolveSha(`origin/${e.def.branch}`)) !== c.sha) continue;
    if (listJobs(p.def.id, eid, 10).some((j) => j.sha === c.sha && j.status !== "failed")) continue;
    const cur = await e.adapter.currentSha?.().catch(() => null);
    if (cur && c.sha.startsWith(cur)) continue; // môi trường đã chạy đúng commit này
    const env = envOf(p.def.id, eid)!;
    startJob(env, { kind: "build", user: AUTO_USER, userId: null, ref: e.def.branch, sha: c.sha, subject: c.subject, auto: true, deploy: true,
      services: e.adapter.wholeRelease ? releaseKeys(e.adapter) : e.adapter.services.map((s) => s.key), opts: e.def.autoOpts });
  }
}

// Bản phát hành trọn gói (wholeRelease): mọi service defaultBuild cùng một thẻ
const releaseKeys = (a: EnvAdapter) => a.services.filter((s) => s.defaultBuild).map((s) => s.key);
// Chỉ nhận tuỳ chọn adapter khai (boolean), đúng loại việc, và người bấm có quyền tương ứng
function optsOf(a: EnvAdapter, raw: unknown, on: "build" | "deploy", need: (p: Perm) => void) {
  const o: Record<string, boolean> = {};
  for (const d of a.options ?? []) {
    if (d.on !== on && d.on !== "both") continue;
    const v = (raw as any)?.[d.key];
    if (typeof v !== "boolean") continue;
    if (v && d.perm) need(d.perm);
    o[d.key] = v;
  }
  return o;
}

// ---------------- API theo dự án × môi trường ----------------
async function envApi(req: Request, url: URL, env: EnvRt, rest: string, u: User, ip: string) {
  const { p, pid, eid, adapter } = env;
  const need = (perm: Perm) => { if (!can(u, pid, eid, perm)) deny(`Cần quyền "${PERM_LABEL[perm]}" ở ${p.def.name} ${env.def.label}`); };
  const who = displayName(u);
  const target = `${pid}/${eid}`;
  const q = url.searchParams;
  if (req.method === "GET") {
    need("view");
    if (rest === "state") {
      const role = roleOf(u, pid, eid)!;
      const st = await adapter.state();
      return json({
        user: who, role, roleLabel: ROLE_LABEL[role], perms: PERMS[role], preview: PREVIEW,
        project: { id: pid, name: p.def.name, repo: p.def.ghRepo },
        env: { id: eid, label: env.def.label, branch: env.def.branch, autoDeploy: env.def.autoDeploy, site: env.def.site, requireCi: env.def.requireCi !== false },
        wholeRelease: !!adapter.wholeRelease, options: adapter.options ?? [], autoOpts: env.def.autoOpts ?? {},
        now: now(), ...st,
        jobs: listJobs(pid, eid).map((j) => ({ ...j, lines: undefined })),
        checks: listChecks(pid),
      });
    }
    if (rest === "history") return json(await adapter.history());
    if (rest === "branches") return json(await p.repo.branches());
    if (rest === "job") {
      const j = getJob(q.get("id") ?? "");
      if (!j || j.project !== pid || j.env !== eid) return json({ error: "Không có job" }, 404);
      const from = Math.max(0, Number(q.get("from") ?? 0) | 0);
      const lines = logLines(j.id);
      return json({ ...j, from, lines: lines.slice(from), total: lines.length });
    }
    if (rest === "check") {
      const ref = String(q.get("ref") ?? "").trim();
      if (!REF_OK.test(ref)) bad("Nhánh/commit không hợp lệ");
      const r = await p.repo.resolveRef(ref);
      if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
      return json({ ref, ...r, check: checkOf(pid, r.sha) });
    }
    if (rest === "checkrun") {
      const c = getCheck(q.get("id") ?? "");
      if (!c || c.project !== pid) return json({ error: "Không có lượt kiểm tra" }, 404);
      const from = Math.max(0, Number(q.get("from") ?? 0) | 0);
      const lines = checkLogLines(c);
      return json({ ...c, from, lines: lines.slice(from, from + 5000), total: Math.min(lines.length, from + 5000) });
    }
    if (rest === "tags") return json(await adapter.tags(q.get("svc") ?? ""));
    if (rest === "logs") { need("logs"); return json(await adapter.logs(q)); }
    return json({ error: "Không tìm thấy" }, 404);
  }
  if (req.method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
  const body: any = await req.json().catch(() => ({}));
  if (["check", "build", "deploy"].includes(rest) && (await codeStale())) return json({ error: STALE_MSG }, 503);

  if (rest === "check") {
    need("check");
    const ref = String(body.ref ?? env.def.branch).trim();
    if (!REF_OK.test(ref)) bad("Nhánh/commit không hợp lệ");
    await p.repo.fetch(true);
    const r = await p.repo.resolveRef(ref);
    if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
    const cur = checkOf(pid, r.sha);
    if (cur?.superseded) cur.superseded = false; // lượt tự động sắp bị bỏ: dev chủ động muốn kiểm tra commit này
    if (cur && cur.status !== "failed") return json({ ok: true, id: cur.id, sha: r.sha, reused: true });
    if (activeChecks().length >= 3) return json({ error: "Đã có 3 lượt kiểm tra đang chờ, đợi bớt" }, 429);
    const c = startCheck(p, r.sha, ref, r.subject, who, u.id);
    audit({ userId: u.id, actor: who, action: "check", target, detail: { ref, sha: r.sha, id: c.id }, ip });
    return json({ ok: true, id: c.id, sha: r.sha });
  }
  if (rest === "build") {
    need("build");
    const ref = String(body.ref ?? env.def.branch).trim();
    if (!REF_OK.test(ref)) bad("Nhánh/commit không hợp lệ");
    const keys = adapter.wholeRelease ? releaseKeys(adapter)
      : (Array.isArray(body.services) ? body.services : []).filter((k: string) => adapter.services.some((s) => s.key === k));
    if (!keys.length) bad("Chọn ít nhất 1 service");
    if (busyJobs(pid, eid) >= 5) return json({ error: "Hàng đợi đã có 5 việc, đợi bớt" }, 429);
    await p.repo.fetch(true);
    const r = await p.repo.resolveRef(ref);
    if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
    if (body.sha && !r.sha.startsWith(String(body.sha))) return json({ error: `${ref} vừa có commit mới (${r.sha.slice(0, 7)}), kiểm tra lại trước khi Build` }, 409);
    const bypass = body.bypass === true;
    const reason = String(body.reason ?? "").trim().slice(0, 300);
    if (bypass) { need("bypass"); if (reason.length < 5) bad("Bỏ qua chặn phải ghi lý do (ít nhất 5 ký tự)"); }
    if (!bypass && env.def.requireCi !== false && checkOf(pid, r.sha)?.status !== "ok") return json({ error: `Commit ${r.sha.slice(0, 7)} chưa qua kiểm tra (CI). Bấm "Chạy kiểm tra" trước.` }, 409);
    const opts = optsOf(adapter, body.opts, "build", need);
    const j = startJob(env, { kind: "build", user: who, userId: u.id, ref, sha: r.sha, subject: r.subject, services: keys, deploy: body.deploy !== false, bypass, reason: bypass ? reason : undefined, opts });
    audit({ userId: u.id, actor: who, action: bypass ? "build.bypass" : "build", target, detail: { id: j.id, ref, sha: r.sha, services: keys, deploy: j.deploy, reason: j.reason, opts }, ip });
    return json({ ok: true, id: j.id });
  }
  if (rest === "deploy") {
    need("deploy");
    const tag = String(body.tag ?? "").trim();
    if (!TAG_OK.test(tag)) bad("Thẻ ảnh không hợp lệ");
    const keys = adapter.wholeRelease ? releaseKeys(adapter) : [adapter.services.find((x) => x.key === body.svc)?.key ?? bad("Service không hợp lệ")];
    if (busyJobs(pid, eid) >= 5) return json({ error: "Hàng đợi đã có 5 việc, đợi bớt" }, 429);
    const opts = optsOf(adapter, body.opts, "deploy", need);
    const j = startJob(env, { kind: "deploy", user: who, userId: u.id, ref: tag, services: keys, deploy: true, tags: Object.fromEntries(keys.map((k) => [k, tag])), opts });
    audit({ userId: u.id, actor: who, action: "deploy", target, detail: { id: j.id, services: keys, tag, opts }, ip });
    return json({ ok: true, id: j.id });
  }
  if (rest === "restart") {
    need("restart");
    if (!adapter.services.some((x) => x.key === body.svc)) bad("Service không hợp lệ");
    await adapter.restart(String(body.svc), who);
    audit({ userId: u.id, actor: who, action: "restart", target, detail: { svc: body.svc }, ip });
    return json({ ok: true });
  }
  if (rest === "reconcile") {
    need("deploy");
    await adapter.reconcile?.();
    return json({ ok: true });
  }
  return json({ error: "Không tìm thấy" }, 404);
}

// ---------------- API quản trị ----------------
const userView = (x: User) => ({ id: x.id, email: x.email, name: displayName(x), picture: x.picture, role: x.role, active: !!x.active, created: x.created, lastLogin: x.last_login, owner: x.email === OWNER_EMAIL });
const EMAIL_OK = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
// Người quản lý quyền được ở những môi trường nào (super admin/admin: tất cả; project admin: nơi mình có quyền manage)
const managedEnvs = (u: User) => [...RT.values()].flatMap((p) => [...p.envs.keys()].filter((e) => can(u, p.def.id, e, "manage")).map((e) => ({ project: p.def.id, env: e })));

async function adminApi(req: Request, url: URL, rest: string, u: User, ip: string, tokenId?: number) {
  const who = displayName(u);
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (rest === "me" && req.method === "GET") {
    return json({ user: userView(u), sysAdmin: isSysAdmin(u), owner: isOwner(u), preview: PREVIEW, canManage: managedEnvs(u).length > 0, memberships: memberships(u.id) });
  }
  if (rest === "envs" && req.method === "GET") {
    const list = await Promise.all(visibleEnvs(u).map(async ({ p, e }) => {
      const j = lastJob(p.def.id, e.def.id);
      const role = roleOf(u, p.def.id, e.def.id)!;
      return {
        project: p.def.id, name: p.def.name, logo: p.def.logo, repo: p.def.ghRepo, env: e.def.id, envLabel: e.def.label, site: e.def.site,
        kind: e.adapter.kind, role, roleLabel: ROLE_LABEL[role], summary: await e.adapter.summary(),
        lastJob: j ? { kind: j.kind, status: j.status, user: j.user, ref: j.ref, sha: j.sha, created: j.created, ended: j.ended } : null,
      };
    }));
    return json(list);
  }
  // Token cá nhân: mọi người tự quản lý token của mình. Token không tự tạo token khác.
  if (rest === "tokens" && req.method === "GET") {
    return json(db.query("SELECT id, name, prefix, created, expires, last_used, revoked FROM tokens WHERE user_id = ? ORDER BY id DESC").all(u.id));
  }
  if (rest === "tokens" && req.method === "POST") {
    if (tokenId) deny("Token không tạo được token khác");
    const name = String(body.name ?? "").trim();
    if (!/^[\p{L}\p{N} ._-]{2,60}$/u.test(name)) bad("Tên token 2–60 ký tự");
    const days = body.days === null ? null : Math.min(365, Math.max(1, Number(body.days) || 90));
    const t = createToken(u, name, days);
    audit({ userId: u.id, actor: who, action: "token.create", target: `token:${t.id}`, detail: { name, days }, ip });
    return json({ ok: true, ...t });
  }
  if (rest === "tokens/revoke" && req.method === "POST") {
    const r = db.query("UPDATE tokens SET revoked = 1 WHERE id = ? AND user_id = ?").run(Number(body.id), u.id);
    if (!r.changes) return json({ error: "Không có token" }, 404);
    audit({ userId: u.id, actor: who, action: "token.revoke", target: `token:${body.id}`, ip });
    return json({ ok: true });
  }

  // Từ đây: quản lý người dùng/quyền. Super admin/admin: toàn bộ; Project Admin: chỉ quyền trong dự án mình quản lý.
  const envs = managedEnvs(u);
  if (!envs.length) deny();
  if (rest === "users" && req.method === "GET") {
    const users = (db.query("SELECT * FROM users ORDER BY role = 'owner' DESC, role = 'admin' DESC, email").all() as User[]).map((x) => ({
      ...userView(x), memberships: memberships(x.id),
    }));
    return json({
      users, envs: [...RT.values()].flatMap((p) => p.def.envs.map((e) => ({ project: p.def.id, name: p.def.name, env: e.id, label: e.label, manage: can(u, p.def.id, e.id, "manage") }))),
      roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], perms: PERMS[r].map((x) => PERM_LABEL[x]) })),
      sysAdmin: isSysAdmin(u), owner: isOwner(u),
    });
  }
  if (rest === "users" && req.method === "POST") { // mời người dùng (chỉ super admin/admin)
    if (!isSysAdmin(u)) deny("Chỉ admin hệ thống mời được người dùng");
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_OK.test(email)) bad("Email không hợp lệ");
    const role: SysRole = body.role === "admin" ? "admin" : "member";
    if (role === "admin" && !isOwner(u)) deny("Chỉ super admin gán được vai trò Admin");
    if (userByEmail(email)) bad("Email này đã có trong danh sách");
    db.query("INSERT INTO users (email, role, created, invited_by) VALUES (?, ?, ?, ?)").run(email, role, now(), u.id);
    audit({ userId: u.id, actor: who, action: "user.invite", target: email, detail: { role }, ip });
    return json({ ok: true, user: userView(userByEmail(email)!) });
  }
  if (rest === "users/update" && req.method === "POST") { // đổi vai trò hệ thống / khoá / mở khoá
    const t = userById(Number(body.id));
    if (!t) return json({ error: "Không có người dùng" }, 404);
    const role = body.role === undefined ? undefined : (["admin", "member"].includes(body.role) ? body.role as SysRole : bad("Vai trò không hợp lệ"));
    if (!isSysAdmin(u) || !canManageUser(u, t, role as SysRole | undefined)) deny(t.email === OWNER_EMAIL ? "Không ai đổi được tài khoản super admin" : undefined);
    if (role !== undefined) db.query("UPDATE users SET role = ? WHERE id = ?").run(role, t.id);
    if (body.active !== undefined) {
      db.query("UPDATE users SET active = ? WHERE id = ?").run(body.active ? 1 : 0, t.id);
      if (!body.active) db.query("DELETE FROM sessions WHERE user_id = ?").run(t.id); // khoá là đăng xuất mọi nơi
    }
    audit({ userId: u.id, actor: who, action: "user.update", target: t.email, detail: { role, active: body.active }, ip });
    return json({ ok: true });
  }
  if (rest === "members" && req.method === "POST") { // gán/gỡ quyền dự án × môi trường
    const t = userById(Number(body.userId));
    if (!t) return json({ error: "Không có người dùng" }, 404);
    const project = String(body.project ?? ""), env = String(body.env ?? "");
    if (!envOf(project, env)) bad("Dự án/môi trường không hợp lệ");
    if (!can(u, project, env, "manage")) deny("Bạn không quản lý quyền ở dự án/môi trường này");
    if (isSysAdmin(t)) bad("Admin hệ thống đã có toàn quyền mọi dự án");
    if (t.id === u.id) bad("Không tự đổi quyền của chính mình");
    const role = body.role === null || body.role === "" ? null : (ROLES.includes(body.role) ? body.role as Role : bad("Vai trò không hợp lệ"));
    if (role) db.query("INSERT INTO memberships (user_id, project, env, role) VALUES (?,?,?,?) ON CONFLICT(user_id, project, env) DO UPDATE SET role = excluded.role").run(t.id, project, env, role);
    else db.query("DELETE FROM memberships WHERE user_id = ? AND project = ? AND env = ?").run(t.id, project, env);
    audit({ userId: u.id, actor: who, action: role ? "member.set" : "member.remove", target: `${t.email} @ ${project}/${env}`, detail: { role }, ip });
    return json({ ok: true });
  }
  if (rest === "audit" && req.method === "GET") {
    const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit")) || 200));
    const before = Number(url.searchParams.get("before")) || 2 ** 52;
    const rows = db.query("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit * 3) as any[];
    // Admin hệ thống xem hết; Project Admin chỉ xem việc ở dự án/môi trường mình quản lý
    const mine = isSysAdmin(u) ? rows : rows.filter((r) => envs.some((e) => (r.target ?? "").includes(`${e.project}/${e.env}`)));
    return json(mine.slice(0, limit));
  }
  return json({ error: "Không tìm thấy" }, 404);
}

// ---------------- Máy chủ ----------------
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // chỉ cloudflared trên máy này gọi vào
  idleTimeout: 60,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/healthz") return new Response("ok");
    const st = STATIC[p];
    if (st) return new Response(st[0], { headers: { "Content-Type": st[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    const ip = clientIp(req, srv);

    if (p === "/login/google" && req.method === "POST") {
      if (!sameOrigin(req)) return json({ error: "Origin không hợp lệ" }, 403);
      if (tooMany(ip)) return json({ error: "Sai quá nhiều lần, thử lại sau 15 phút." }, 429);
      const body: any = await req.json().catch(() => ({}));
      const prof = await googleProfile(String(body.credential ?? "")).catch(() => null);
      const sid = prof ? loginWith(prof, ip, req.headers.get("user-agent") ?? "", "google") : null;
      if (!sid) {
        failed(ip);
        if (!prof) audit({ actor: "?", action: "login.denied", detail: "token Google không hợp lệ", ip, ok: false });
        return json({ error: prof ? `Tài khoản ${prof.email} chưa được mời hoặc đã bị khoá. Liên hệ quản trị viên.` : "Đăng nhập Google không hợp lệ." }, 403);
      }
      succeeded(ip);
      return json({ ok: true }, 200, { "Set-Cookie": cookie(sid, SESSION_HOURS * 3600) });
    }
    if (p === "/logout" && req.method === "POST") {
      const s = sessionUser(req);
      if (s) audit({ userId: s.user.id, actor: displayName(s.user), action: "logout", ip });
      endSession(req);
      return redirect("/", { "Set-Cookie": cookie("", 0) });
    }

    const auth = sessionUser(req);
    const u = auth?.user ?? null;
    const isPage = req.method === "GET" && !p.includes("/api/");
    if (isPage) {
      if (!u) return html(loginHtml({ clientId: GOOGLE_CLIENT_ID, preview: PREVIEW }), 200, true);
      const page = { user: displayName(u), picture: u.picture, sysAdmin: isSysAdmin(u), canManage: managedEnvs(u).length > 0, preview: PREVIEW };
      if (p === "/") return html(homeHtml(page));
      if (p === "/admin" || p === "/admin/") return html(adminHtml(page)); // ai cũng có tab Token; tab quản lý theo quyền
      const m = p.match(/^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
      if (m) {
        const env = envOf(m[1], m[2]);
        if (!env) return new Response("Không tìm thấy", { status: 404 });
        if (!can(u, m[1], m[2], "view")) return html(homeHtml({ ...page, error: `Bạn chưa có quyền xem ${env.def.label} của ${env.p.def.name}.` }), 403);
        if (!p.endsWith("/")) return redirect(p + "/");
        return html(envHtml({ ...page, kind: env.adapter.kind, project: env.p.def.name, projectId: env.pid, env: env.eid, envLabel: env.def.label, branch: env.def.branch, logo: env.p.def.logo, services: env.adapter.services }));
      }
      return new Response("Không tìm thấy", { status: 404 });
    }

    if (!u) return json({ error: "Chưa đăng nhập" }, 401);
    // Chống CSRF cho phiên cookie (token Bearer không đi kèm tự động nên không cần)
    if (req.method === "POST" && auth!.via === "session" && !sameOrigin(req)) return json({ error: "Origin không hợp lệ" }, 403);
    try {
      const m = p.match(/^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)\/api\/([a-z/]+)$/);
      if (m) {
        const env = envOf(m[1], m[2]);
        if (!env) return json({ error: "Không có dự án/môi trường này" }, 404);
        return await envApi(req, url, env, m[3], u, ip);
      }
      const a = p.match(/^\/api\/([a-z/]+)$/);
      if (a) return await adminApi(req, url, a[1], u, ip, auth!.tokenId);
      return json({ error: "Không tìm thấy" }, 404);
    } catch (e: any) {
      if (e instanceof HttpError) {
        if (e.status === 403) audit({ userId: u.id, actor: displayName(u), action: "denied", target: p, detail: e.message, ip, ok: false });
        return json({ error: e.message }, e.status);
      }
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});

console.log(`dmst-cicd chạy http://127.0.0.1:${server.port} (${PREVIEW ? "BẢN XEM TRƯỚC: chỉ đọc, thao tác ghi giả lập" : "THẬT"}, https://${PUBLIC_HOST})`);
for (const p of RT.values()) {
  if (p.def.legacyChecksDir) setLegacyChecks(p.def.id, p.def.legacyChecksDir);
  p.repo.ensure((l) => console.log(`[${p.def.id}] ${l}`)).catch((e) => console.error(`[${p.def.id}] chuẩn bị repo lỗi:`, e.message));
  for (const e of p.envs.values()) e.adapter.start();
}
// Tunnel Cloudflare ra cicd.dmst.vn (token trong secrets.json của nền tảng). Bản xem trước không mở tunnel.
const CLOUDFLARED = E.CLOUDFLARED ?? "D:/DMST/stg-deploy-work/bin/cloudflared.exe";
if (!PREVIEW) keepAlive("cloudflared", () => (secret("TUNNEL_TOKEN") ? [CLOUDFLARED, "tunnel", "--no-autoupdate", "run"] : null), { TUNNEL_TOKEN: secret("TUNNEL_TOKEN") });
if (SELF_UPDATE) setInterval(() => { codeStale().catch((e) => console.error("Kiểm tra mã mới lỗi:", e.message)); }, 120_000);

// ---------------- Tự chạy Kiểm tra (CI) khi có push ----------------
// Mỗi AUTO_CHECK_SEC giây fetch repo từng dự án; nhánh (theo autoCheck) có commit đầu mới thì xếp một lượt kiểm tra, bỏ
// lượt tự động cũ còn chờ của cùng nhánh. Đầu nhánh đã thấy lưu trong kv `heads:<dự án>`; lần đầu chỉ ghi mốc. Bản xem
// trước không tự chạy (trang cũ vẫn chạy, kết quả của nó hiện trên trang này).
const AUTO_CHECK_SEC = Number(E.AUTO_CHECK_SEC ?? (PREVIEW ? 0 : 60));
let autoBusy = false;
async function autoCheck() {
  if (autoBusy || lifecycle.exiting) return;
  autoBusy = true;
  try {
    if (await codeStale()) return;
    for (const p of RT.values()) {
      try {
        await p.repo.fetch(true);
        const all = await p.repo.heads();
        const heads = p.def.autoCheck === "all" ? all : Object.fromEntries(Object.entries(all).filter(([n]) => (p.def.autoCheck as string[]).includes(n)));
        const seen = kvGet<Record<string, string>>(`heads:${p.def.id}`);
        if (seen) {
          for (const [name, h] of Object.entries(heads)) {
            if (seen[name] === h.sha) continue;
            const cur = checkOf(p.def.id, h.sha);
            if (cur) { if (cur.status === "ok") await autoDeploy(p, cur); continue; } // commit đã kiểm (vd. nhánh khác)
            for (const old of activeChecks()) if (old.auto && old.project === p.def.id && old.ref === name && old.status === "queued") old.superseded = true;
            startCheck(p, h.sha, name, h.subject, AUTO_USER, null, true);
          }
        } else console.log(`[${p.def.id}] tự kiểm tra khi push: ghi mốc ${Object.keys(heads).length} nhánh (lần đầu).`);
        kvSet(`heads:${p.def.id}`, Object.fromEntries(Object.entries(heads).map(([n, h]) => [n, h.sha])));
      } catch (e: any) { console.error(`[${p.def.id}] tự kiểm tra khi push lỗi:`, e.message); }
    }
  } finally { autoBusy = false; }
}
if (AUTO_CHECK_SEC > 0) { setTimeout(autoCheck, 10_000); setInterval(autoCheck, AUTO_CHECK_SEC * 1000); }
