// Trang build staging DNSO lên VPS HappyFinate: https://hf-deploy-dnso.senow.tech
//
// Chạy trên PC quản trị (Windows, Bun, Git, OpenSSH với alias HappyFinate, cloudflared). Khác dnso-stg (DMST_05, ảnh
// dựng trên PC): ở đây VPS TỰ BUILD từ mã nguồn, đúng cách staging HappyFinate vẫn chạy (bind mount ./src/app vào
// container oven/bun, xem /opt/dnso-staging/docker-compose.yml trên VPS).
//
// Bấm "Build & deploy":
//   1. PC fetch kho DNSO từ GitHub (VPS không có quyền đọc kho), lấy sha của nhánh/commit đã chọn (mặc định staging);
//   2. `git push` commit đó vào kho git trần REMOTE_DIR/repo.git trên VPS qua SSH;
//   3. chép vps/build-tu-git.sh sang VPS rồi chạy nó tách khỏi phiên SSH (setsid nohup, log ở
//      REMOTE_DIR/nhat-ky-build/<id>.log), PC đọc log theo `tail -F` cho tới khi script thoát:
//      VPS lấy mã từ repo.git → bun install + build (1.5 CPU/4 GB) → migrate → dựng lại web/worker → chờ /suc-khoe.
//      Lỗi ở migrate hoặc /suc-khoe thì VPS tự trả mã cũ về.
//   Báo nhóm Nhắn tin DNSO một tin kết quả nếu secrets.json có DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID.
//
// Không có gói phụ thuộc, chỉ API có sẵn của Bun. Cài đặt/khởi động: start.ps1. Mã chạy thẳng từ clone dmst-cicd ở
// WORK_DIR/cicd theo origin/main; khi thư mục dnso-hf trên origin/main đổi, trang tự thoát lúc rảnh để start.ps1 lấy mã
// mới và chạy lại. Sửa trang = commit + push main của dmst-cicd.
//
// Thư mục làm việc WORK_DIR (mặc định D:/DMST/dnso-hf-work, ngoài repo):
//   secrets.json   { DEPLOY_PASSWORD, SESSION_SECRET, TUNNEL_TOKEN, DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID }
//   cicd/          clone dmst-cicd theo origin/main (start.ps1 quản lý)
//   repo/          clone trần kho DNSO (chỉ fetch + push sang VPS)
//   jobs/          log từng lượt
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pageHtml } from "./ui";

const asset = (f: string) => readFileSync(join(import.meta.dir, f));
const STATIC: Record<string, [Buffer, string]> = {
  // Giao diện dùng chung bộ CSS với stg-deploy (cùng repo dmst-cicd) + vài dòng riêng của dnso-stg.
  "/app.css": [Buffer.concat([readFileSync(join(import.meta.dir, "..", "stg-deploy", "app.css")), Buffer.from("\n"), readFileSync(join(import.meta.dir, "..", "dnso-stg", "dnso.css"))]), "text/css; charset=utf-8"],
  "/app.js": [asset("app.js"), "text/javascript; charset=utf-8"],
  "/logo.svg": [readFileSync(join(import.meta.dir, "..", "dnso-stg", "logo.svg")), "image/svg+xml"],
};
const BUILD_SCRIPT = asset(join("vps", "build-tu-git.sh")).toString("utf8").replace(/\r\n/g, "\n");

const E = process.env;
const PORT = Number(E.PORT ?? 8100);
const WORK = E.WORK_DIR ?? "D:/DMST/dnso-hf-work";
const REPO_URL = E.REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/doanhnghiepso.git";
const GH_REPO = "KHCN-Thanh-Hoa/doanhnghiepso";
const DEPLOY_BRANCH = E.DEPLOY_BRANCH ?? "staging";
const SSH_HOST = E.SSH_HOST ?? "HappyFinate"; // alias trong ~/.ssh/config của user Windows
const VPS_NAME = E.VPS_NAME ?? "Senow"; // tên VPS hiện trên giao diện (alias SSH thật vẫn là SSH_HOST)
const REMOTE_DIR = E.REMOTE_DIR ?? "/opt/dnso-staging";
const SITE = E.SITE ?? "https://dmst.senow.tech";
const SITE_HOST = new URL(SITE).host;
const CLOUDFLARED = E.CLOUDFLARED ?? join(WORK, "bin", "cloudflared.exe");
const SESSION_HOURS = 12, COOKIE = "dnsohf";

mkdirSync(join(WORK, "jobs"), { recursive: true });
const SECRETS_FILE = join(WORK, "secrets.json");
const secrets: Record<string, string> = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
if (!secrets.DEPLOY_PASSWORD) secrets.DEPLOY_PASSWORD = randomBytes(12).toString("base64url");
if (!secrets.SESSION_SECRET) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
const DEPLOY_PASSWORD = E.DEPLOY_PASSWORD ?? secrets.DEPLOY_PASSWORD;
const SESSION_SECRET = secrets.SESSION_SECRET;

// Dịch vụ compose dnso-staging trên VPS
const SERVICES = [
  { key: "web", label: "Web", note: "bun run start, sau Traefik (dmst / az / nen-tang.senow.tech)", restart: true },
  { key: "worker", label: "Worker", note: "tác vụ nền + lịch định kỳ", restart: true },
  { key: "db", label: "PostgreSQL 16", note: "CSDL staging", restart: false },
  { key: "redis", label: "Redis", note: "hàng đợi BullMQ", restart: false },
];

// ---------------- Tiến trình con ----------------
type RunOpts = { cwd?: string; env?: Record<string, string>; onLine?: (l: string) => void; quiet?: boolean; stdin?: ReadableStream<Uint8Array> | Blob | null };
async function run(cmd: string[], o: RunOpts = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...E, ...o.env }, stdin: (o.stdin as any) ?? "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of s) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === "\r" ? i + 2 : i + 1);
        if (out.length < 200_000) out += line + "\n";
        o.onLine?.(line);
      }
    }
    if (buf) { out += buf; o.onLine?.(buf); }
  };
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  return { code: await p.exited, out };
}
async function must(cmd: string[], o: RunOpts = {}) {
  const r = await run(cmd, o);
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
  return r.out;
}
// BatchMode: không bao giờ treo chờ nhập mật khẩu.
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"];
const SSH = ["ssh", ...SSH_OPTS, SSH_HOST];
const ssh = (script: string, o: RunOpts = {}) => run([...SSH, script], o);
const sshMust = (script: string, o: RunOpts = {}) => must([...SSH, script], o);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const RD = shq(REMOTE_DIR);

// Giữ sống cloudflared (tunnel ra hf-deploy-dnso.senow.tech). Khi trang tự thoát để cập nhật mã thì dừng hẳn.
const children = new Set<ReturnType<typeof Bun.spawn>>();
let exiting = false;
function keepAlive(name: string, cmd: () => string[] | null, env: Record<string, string> = {}) {
  const start = () => {
    if (exiting) return;
    const c = cmd();
    if (!c) return console.log(`[${name}] bỏ qua (thiếu cấu hình)`);
    const p = Bun.spawn(c, { env: { ...E, ...env }, stdout: "ignore", stderr: "pipe" });
    children.add(p);
    console.log(`[${name}] chạy pid ${p.pid}`);
    (async () => { let n = 0; for await (const ch of p.stderr) { if (n++ < 50) process.stdout.write(`[${name}] ${new TextDecoder().decode(ch)}`); } })();
    p.exited.then((code) => {
      children.delete(p);
      if (exiting) return;
      console.log(`[${name}] thoát mã ${code}, chạy lại sau 5 giây`); setTimeout(start, 5000);
    });
  };
  start();
}
keepAlive("cloudflared", () => (secrets.TUNNEL_TOKEN && existsSync(CLOUDFLARED) ? [CLOUDFLARED, "tunnel", "--no-autoupdate", "run"] : null), { TUNNEL_TOKEN: secrets.TUNNEL_TOKEN ?? "" });

// ---------------- Git (clone trần riêng trong WORK) ----------------
const REPO = join(WORK, "repo");
const git = (args: string[], o: RunOpts = {}) => must(["git", "-C", REPO, ...args], o);
let repoReady: Promise<void> | null = null;
function ensureRepo(log?: (l: string) => void) {
  repoReady ??= (async () => {
    if (existsSync(join(REPO, "HEAD"))) return;
    log?.(`Clone ${REPO_URL} (lần đầu, không checkout)…`);
    await must(["git", "clone", "--bare", REPO_URL, REPO], { onLine: log });
    // clone --bare không tạo refs/remotes/origin/*: đặt lại refspec để fetch giống clone thường
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await git(["fetch", "-q", "--prune", "origin"]);
  })().catch((e) => { repoReady = null; throw e; });
  return repoReady;
}
let lastFetch = 0;
let fetching: Promise<void> | null = null;
function fetchRepo(force = false): Promise<void> {
  if (fetching) return fetching.then(() => (force ? fetchRepo(true) : undefined));
  if (!force && Date.now() - lastFetch < 60_000) return Promise.resolve();
  fetching = git(["fetch", "-q", "--prune", "origin"]).then(() => { lastFetch = Date.now(); }).finally(() => { fetching = null; });
  return fetching;
}
async function resolveRef(ref: string) {
  await ensureRepo();
  await fetchRepo();
  const rev = /^[0-9a-f]{7,40}$/.test(ref) ? ref : `origin/${ref}`;
  const sha = await resolveSha(rev);
  if (!sha) return null;
  return { sha, subject: (await subjectOf(sha)) ?? "", date: (await git(["log", "-1", "--format=%cI", sha])).trim() };
}
async function branches() {
  await ensureRepo();
  await fetchRepo();
  const out = await git(["for-each-ref", "--sort=-committerdate", "--count=40", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(objectname:short)%1f%(subject)", "refs/remotes/origin"]);
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [ref, date, sha, subject] = l.split("\x1f");
    return { name: ref.replace(/^origin\//, ""), date, sha, subject };
  }).filter((b) => b.name !== "HEAD" && b.name !== "origin");
}
const subjectOf = async (rev: string) => (await run(["git", "-C", REPO, "log", "-1", "--format=%s", rev], { quiet: true })).out.trim() || null;
const resolveSha = async (rev: string | null) =>
  rev ? (await run(["git", "-C", REPO, "rev-parse", "--verify", "-q", `${rev}^{commit}`], { quiet: true })).out.trim() || null : null;
const soCommitCham = async (tu: string, den: string) =>
  Number((await run(["git", "-C", REPO, "rev-list", "--count", `${tu}..${den}`], { quiet: true })).out.trim()) || 0;

// ---------------- Tự cập nhật mã của trang ----------------
const TOOL_BRANCH = E.TOOL_BRANCH ?? "main";
const toolGit = (args: string[]) => run(["git", "-C", import.meta.dir, ...args], { quiet: true })
  .then((r) => (r.code === 0 ? r : { code: r.code, out: "" }), () => ({ code: 1, out: "" }));
const TOOL_PATH = (await toolGit(["rev-parse", "--show-prefix"])).out.trim().replace(/\/$/, "");
// Trang đọc cả app.css của stg-deploy, dnso.css + logo của dnso-stg: so cả ba
const treeOf = async (rev: string) => (await toolGit(["rev-parse", `${rev}:${TOOL_PATH}`, `${rev}:stg-deploy/app.css`, `${rev}:dnso-stg/dnso.css`, `${rev}:dnso-stg/logo.svg`])).out.trim();
const RUNNING_TREE = TOOL_PATH ? await treeOf("HEAD") : "";
if (RUNNING_TREE) console.log(`Mã trang: ${RUNNING_TREE.split("\n")[0].slice(0, 10)} (${import.meta.dir})`);
else console.log(`⚠ ${import.meta.dir} không nằm trong git, không tự cập nhật mã trang.`);
let restartPending = false;
const busyJobs = () => jobs.filter((j) => j.status === "queued" || j.status === "running").length;
function exitForUpdate() {
  if (exiting) return;
  exiting = true;
  console.log(`${new Date().toISOString()} dmst-cicd origin/${TOOL_BRANCH} có mã trang mới, thoát để start.ps1 cập nhật và chạy lại.`);
  for (const p of children) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 1000);
}
let lastToolFetch = 0;
async function codeStale(): Promise<boolean> {
  if (restartPending) return true;
  if (!RUNNING_TREE) return false;
  if (Date.now() - lastToolFetch > 30_000) { if ((await toolGit(["fetch", "-q", "--prune", "origin"])).code === 0) lastToolFetch = Date.now(); }
  const remote = await treeOf(`origin/${TOOL_BRANCH}`);
  if (!remote || remote === RUNNING_TREE) return false;
  restartPending = true;
  if (!busyJobs()) exitForUpdate();
  else console.log(`${new Date().toISOString()} mã trang mới, chờ ${busyJobs()} việc xong rồi khởi động lại.`);
  return true;
}
const STALE_MSG = "Trang vừa có mã mới (repo dmst-cicd), đang khởi động lại để dùng mã mới. Bấm lại sau khoảng 30 giây.";

// ---------------- VPS ----------------
type May = {
  ok: boolean; error: string | null; phienBan: string | null; subject: string | null; dangBuild: boolean;
  services: { key: string; label: string; note: string; restart: boolean; containers: { name: string; state: string; health: string; status: string }[] }[];
  sucKhoe: any; lichSu: { luc: string; the: string; ai: string; subject: string | null }[];
  nhanh: { sha: string; subject: string; date: string; cham: number } | null; luc: string;
};
// Một lệnh SSH lấy toàn bộ trạng thái, đệm 8 giây (trình duyệt hỏi 5 giây/lần)
let mayCache: { at: number; p: Promise<May> } | null = null;
function mayVps(force = false): Promise<May> {
  if (!force && mayCache && Date.now() - mayCache.at < 8000) return mayCache.p;
  const p = (async (): Promise<May> => {
    const empty = { phienBan: null, subject: null, dangBuild: false, services: [], sucKhoe: null, lichSu: [], nhanh: null, luc: new Date().toISOString() };
    const r = await ssh(`cd ${RD} && echo "@@PB" && cat PHIEN_BAN 2>/dev/null; echo "@@LOCK" && (flock -n .build.lock true 2>/dev/null && echo ranh || echo ban); echo "@@PS" && docker compose ps -a --format json; echo "@@LS" && tail -n 30 lich-su-trien-khai.log 2>/dev/null; echo "@@SK" && curl -sk -m 8 --resolve ${SITE_HOST}:443:127.0.0.1 https://${SITE_HOST}/suc-khoe; echo`, { quiet: true });
    if (r.code !== 0) return { ok: false, error: `Không SSH được tới VPS ${VPS_NAME}: ${r.out.trim().split("\n").slice(-2).join(" ")}`, ...empty };
    // Tách theo dòng đánh dấu "@@XYZ" (phần rỗng, vd. chưa có lịch sử, vẫn đúng)
    const sec: Record<string, string[]> = {};
    let cur = "";
    for (const l of r.out.split("\n")) { const m = l.match(/^@@([A-Z]+)$/); if (m) sec[(cur = m[1])] = []; else if (cur) sec[cur].push(l); }
    const part = (k: string) => (sec[k] ?? []).join("\n");
    const ps = part("PS").trim().split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const phienBan = part("PB").trim() || null;
    let sucKhoe: any = null;
    try { sucKhoe = JSON.parse(part("SK").trim()); } catch { sucKhoe = part("SK").trim() ? { trangThai: "loi", raw: part("SK").trim().slice(0, 200) } : null; }
    const services = SERVICES.map((s) => ({
      ...s,
      containers: ps.filter((c: any) => c.Service === s.key).map((c: any) => ({ name: c.Service, state: c.State, health: c.Health ?? "", status: c.Status })),
    }));
    const lichSu = [];
    for (const l of part("LS").trim().split("\n").filter(Boolean).reverse()) {
      const [d, t, the, ...ai] = l.split(/\s+/);
      lichSu.push({ luc: `${d}T${t}+07:00`, the, ai: ai.join(" "), subject: /^[0-9a-f]{7,40}$/.test(the) ? await subjectOf(the) : null });
    }
    // Đầu nhánh triển khai trên GitHub so với bản đang chạy
    let nhanh: May["nhanh"] = null;
    try {
      const h = await resolveRef(DEPLOY_BRANCH);
      const pb = phienBan ? await resolveSha(phienBan) : null;
      if (h) nhanh = { ...h, cham: pb ? await soCommitCham(pb, h.sha) : -1 };
    } catch {}
    return { ok: true, error: null, phienBan, subject: phienBan ? await subjectOf(phienBan) : null, dangBuild: part("LOCK").trim() === "ban",
      services, sucKhoe, lichSu, nhanh, luc: new Date().toISOString() };
  })().catch((e) => ({ ok: false, error: String(e?.message ?? e), phienBan: null, subject: null, dangBuild: false, services: [], sucKhoe: null, lichSu: [], nhanh: null, luc: new Date().toISOString() }));
  mayCache = { at: Date.now(), p };
  return p;
}

// ---------------- Báo nhóm Nhắn tin DNSO ----------------
// Một tin kết quả cho mỗi lượt (giống dnso-stg). Lỗi báo tin chỉ ghi cảnh báo, không làm hỏng job.
const DNSO = {
  url: (E.DNSO_URL ?? secrets.DNSO_URL ?? "https://dmst.dnso.vn").replace(/\/+$/, ""),
  key: E.DNSO_API_KEY ?? secrets.DNSO_API_KEY ?? "",
  thayMat: E.DNSO_THAY_MAT ?? secrets.DNSO_THAY_MAT ?? "",
  nhom: E.DNSO_NHOM_ID ?? secrets.DNSO_NHOM_ID ?? "",
};
const thoiLuong = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m ? `${m} phút ${s % 60} giây` : `${s} giây`;
};
async function dnsoPost(than: unknown, log: (l: string) => void) {
  let cuoi = "";
  for (let lan = 1; lan <= 3; lan++) {
    let ma = 0, text = "";
    try {
      const r = await fetch(`${DNSO.url}/api/v1/nhan-tin/nhom/${encodeURIComponent(DNSO.nhom)}/thong-bao`, {
        method: "POST",
        headers: { Authorization: `Bearer ${DNSO.key}`, "X-Thay-Mat": DNSO.thayMat, "Content-Type": "application/json" },
        body: JSON.stringify(than), signal: AbortSignal.timeout(20_000),
      });
      ma = r.status; text = await r.text();
    } catch (e: any) { text = String(e?.message ?? e); }
    if (ma >= 200 && ma < 300) { log(`Báo nhóm DNSO: HTTP ${ma}.`); return; }
    let loi = text.slice(0, 300);
    try { loi = JSON.parse(text).loi ?? loi; } catch {}
    cuoi = `HTTP ${ma || "lỗi mạng"}: ${loi}`;
    if (ma >= 400 && ma < 500) break;
    if (lan < 3) await Bun.sleep(lan * 3000);
  }
  log(`⚠ Báo nhóm DNSO không thành công (${cuoi}), bỏ qua.`);
}
// Tiêu đề commit → câu cho người không làm kỹ thuật; null = thay đổi kỹ thuật, không đưa lên thẻ.
function dichCommit(t: string): string | null {
  t = t.trim();
  if (/^merge\b/i.test(t)) return null;
  const m = t.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
  if (!m) return t;
  const noi = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  const loai = m[1].toLowerCase();
  if (loai === "feat") return `Mới: ${noi}`;
  if (loai === "fix" || loai === "hotfix") return `Sửa lỗi: ${noi}`;
  if (loai === "perf") return `Nhanh hơn: ${noi}`;
  return null;
}
async function dnsoCommits(tu: string | null, den: string) {
  const range = tu ? [`${tu}..${den}`] : ["-1", den];
  const out = (await run(["git", "-C", REPO, "log", "--no-merges", "-n", "200", "--format=%an%x1f%s", ...range], { quiet: true })).out;
  const da = new Set<string>();
  const commits = out.split("\n").filter(Boolean)
    .map((l) => { const [tacGia, s] = l.split("\x1f"); const tieuDe = dichCommit(s ?? ""); return tieuDe ? { ma: "", tieuDe, tacGia } : null; })
    .filter((c): c is { ma: string; tieuDe: string; tacGia: string } => !!c && !da.has(c.tieuDe) && !!da.add(c.tieuDe));
  return commits.length ? { commits: commits.slice(0, 15), tongCommit: commits.length } : {};
}
async function baoKetThuc(j: Job, log: (l: string) => void) {
  try {
    if (!j.bao) return;
    if (!DNSO.key || !DNSO.thayMat || !DNSO.nhom) return;
    const ok = j.status === "ok";
    await dnsoPost({
      trangThai: ok ? "success" : "failure",
      tieuDe: ok ? "Staging DNSO (Senow) đã cập nhật bản mới, mời mọi người vào kiểm tra" : "Cập nhật staging DNSO (Senow) thất bại: vẫn chạy bản cũ, đội kỹ thuật đang xử lý",
      tacGia: j.user,
      thoiLuong: thoiLuong(Date.parse(j.ended ?? new Date().toISOString()) - Date.parse(j.started!)),
      khoaGop: `DNSO|staging-hf|${j.sha}|${j.id}`,
      lienKet: SITE + "/",
      ...(ok ? {} : { noiDung: `Mọi người vẫn dùng bản cũ bình thường.\nChi tiết cho đội kỹ thuật (commit ${j.sha!.slice(0, 8)}): ${(j.error ?? "").slice(0, 400)}` }),
      ...(await dnsoCommits(j.bao.tu, j.bao.den)),
    }, log);
  } catch (e: any) { log(`⚠ Báo nhóm DNSO lỗi: ${e?.message ?? e}`); }
}

// ---------------- Hàng đợi build ----------------
type Job = {
  id: string; user: string; ref: string; sha?: string; subject?: string;
  status: "queued" | "running" | "ok" | "failed";
  created: string; started?: string; ended?: string; error?: string;
  bao?: { tu: string | null; den: string };
  log: string[];
};
const JOBS_DIR = join(WORK, "jobs");
const jobs: Job[] = [];
// Nạp lại danh sách lượt cũ (log đọc từ tệp khi mở)
try {
  const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 100))) { rmSync(join(JOBS_DIR, f)); rmSync(join(JOBS_DIR, f.replace(/\.json$/, ".log")), { force: true }); }
  for (const f of files.slice(-30).reverse()) {
    const j: Job = JSON.parse(readFileSync(join(JOBS_DIR, f), "utf8"));
    j.log = [];
    if (j.status === "queued" || j.status === "running") {
      j.status = "failed"; j.ended ??= new Date().toISOString();
      j.error = "Trang khởi động lại khi lượt đang chạy. Lượt build trên VPS (nếu đã bắt đầu) vẫn chạy tiếp: xem Lịch sử triển khai.";
    }
    jobs.push(j);
  }
} catch (e: any) { console.error("Đọc lượt cũ lỗi:", e.message); }
const saveJob = (j: Job) => { const { log, ...rest } = j; try { writeFileSync(join(JOBS_DIR, `${j.id}.json`), JSON.stringify(rest)); } catch {} };
const jobLines = (j: Job) => {
  if (j.log.length) return j.log;
  try { return readFileSync(join(JOBS_DIR, `${j.id}.log`), "utf8").split("\n").filter(Boolean); } catch { return []; }
};
let queue: Promise<void> = Promise.resolve();
function enqueue(j: Job) {
  jobs.unshift(j);
  jobs.splice(30);
  saveJob(j);
  queue = queue.then(async () => {
    const log = (line: string) => {
      const l = line.replace(/\x1b\[[0-9;]*m/g, "");
      j.log.push(l);
      if (j.log.length > 20_000) j.log.splice(0, 5_000);
      try { appendFileSync(join(JOBS_DIR, `${j.id}.log`), l + "\n"); } catch {}
    };
    j.status = "running"; j.started = new Date().toISOString(); saveJob(j);
    try { await buildJob(j, log); j.status = "ok"; log("✔ Xong."); }
    catch (e: any) { j.status = "failed"; j.error = String(e?.message ?? e); log("✘ " + j.error); }
    j.ended = new Date().toISOString();
    saveJob(j);
    mayCache = null;
    await baoKetThuc(j, log);
    j.log = [];
    console.log(`${j.ended} build ${j.id} ${j.sha?.slice(0, 8)} ${j.status} (${j.user})`);
    if (restartPending && !busyJobs()) exitForUpdate();
  });
}

async function buildJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  log("Lấy mã mới từ GitHub (trên PC)…");
  await fetchRepo(true);
  const sha = j.sha!;
  log(`Commit ${sha.slice(0, 8)}: ${j.subject}`);
  const may = await mayVps(true);
  if (!may.ok) throw new Error(may.error ?? "Không đọc được trạng thái VPS");
  if (may.dangBuild) throw new Error("VPS đang có lượt build khác (khoá .build.lock), đợi xong rồi bấm lại");
  j.bao = { tu: may.phienBan ? await resolveSha(may.phienBan) : null, den: sha };

  log(""); log(`══ Đẩy commit sang VPS ${VPS_NAME} (${REMOTE_DIR}/repo.git)`);
  await sshMust(`test -d ${RD}/repo.git || git init -q --bare ${RD}/repo.git; mkdir -p ${RD}/nhat-ky-build`);
  const t0 = Date.now();
  await must(["git", "-C", REPO, "push", "-q", "--force", `${SSH_HOST}:${REMOTE_DIR}/repo.git`, `${sha}:refs/heads/${DEPLOY_BRANCH}`],
    { env: { GIT_SSH_COMMAND: ["ssh", ...SSH_OPTS].join(" ") }, onLine: log });
  log(`Đẩy xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);

  // Chép script build (bản trong repo dmst-cicd) rồi chạy tách khỏi phiên SSH
  await must([...SSH, `cat > ${RD}/build-tu-git.sh && chmod +x ${RD}/build-tu-git.sh`], { stdin: new Blob([BUILD_SCRIPT]) });
  const logRemote = `nhat-ky-build/${j.id}.log`;
  const pid = (await sshMust(`cd ${RD} && setsid nohup bash build-tu-git.sh ${sha} ${shq(j.user)} > ${logRemote} 2>&1 < /dev/null & echo $!`)).trim();
  if (!/^\d+$/.test(pid)) throw new Error(`Không chạy được build-tu-git.sh trên VPS: ${pid.slice(0, 200)}`);
  log(`VPS bắt đầu build (pid ${pid}, log ${REMOTE_DIR}/${logRemote}).`);

  // Đọc log tới khi script thoát. Rớt SSH thì nối lại, đọc tiếp từ dòng đã có.
  let maThoat: number | null = null, daDoc = 0;
  for (let lan = 0; maThoat === null && lan < 20; lan++) {
    if (lan) { log(`⚠ Mất kết nối đọc log, nối lại (${lan})…`); await Bun.sleep(5000); }
    let n = 0;
    await ssh(`cd ${RD} && tail -n +${daDoc + 1} -F --pid=${pid} ${logRemote} 2>/dev/null; echo @@TAIL_XONG`, {
      onLine: (l) => {
        if (l === "@@TAIL_XONG") return;
        n++;
        const m = l.match(/^@@MA_THOAT (\d+)$/);
        if (m) { maThoat = Number(m[1]); return; }
        // bớt dòng ồn của compose/docker và danh sách ~1.000 tệp vite in ra
        if (/^\s*(Container |#\d+ |\[\d+\/\d+\] )|^build\/(client|server)\/|^\s+- |^(Measured|Those rows|Not measurable|See https)/.test(l)) return;
        log(l);
      },
    });
    daDoc += n;
    if (maThoat === null) {
      // tail thoát mà chưa thấy mã: tiến trình đã chết (bị kill) hay chỉ rớt mạng?
      const st = await ssh(`kill -0 ${pid} 2>/dev/null && echo song || (grep -a '^@@MA_THOAT' ${RD}/${logRemote} | tail -1)`, { quiet: true });
      const m = st.out.match(/@@MA_THOAT (\d+)/);
      if (m) maThoat = Number(m[1]);
      else if (st.code === 0 && !st.out.includes("song")) throw new Error("Script build trên VPS dừng bất thường (không có mã thoát). Kiểm tra src/ trên VPS.");
    }
  }
  mayCache = null;
  if (maThoat === null) throw new Error("Không đọc được kết quả build từ VPS sau nhiều lần nối lại.");
  const LOI: Record<number, string> = {
    2: "VPS không nhận được commit", 3: "VPS đang có lượt build khác",
    4: "Migrate lỗi, staging vẫn chạy bản cũ", 5: "Bản mới không lành (/suc-khoe), đã trả về bản cũ",
  };
  if (maThoat !== 0) throw new Error(LOI[maThoat] ?? `Build trên VPS lỗi (mã ${maThoat}), staging vẫn chạy bản cũ. Xem log phía trên.`);
}

// ---------------- Phiên đăng nhập ----------------
const sign = (data: string) => createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
function makeSession(name: string) {
  const data = Buffer.from(JSON.stringify({ n: name, e: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  return `${data}.${sign(data)}`;
}
function readSession(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [data, sig] = m[1].split(".");
  if (!data || !sig) return null;
  const want = Buffer.from(sign(data)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return s.e > Date.now() && typeof s.n === "string" ? s.n : null;
  } catch { return null; }
}
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const passwordOk = (p: string) => timingSafeEqual(sha256(p), sha256(DEPLOY_PASSWORD));
const fails = new Map<string, { n: number; until: number }>();
const clientIp = (req: Request, srv: any) => req.headers.get("cf-connecting-ip") ?? srv.requestIP(req)?.address ?? "?";

// ---------------- HTTP ----------------
const SEC = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8" } });
const html = (b: string, status = 200) => new Response(b, { status, headers: { ...SEC, "Content-Type": "text/html; charset=utf-8" } });
const redirect = (to: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { ...SEC, Location: to, ...extra } });
const cookie = (v: string, maxAge: number) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const REF_OK = /^(?!.*\.\.)(?!-)[A-Za-z0-9._\/-]{1,100}$/;
const NAME_OK = /^[\p{L}\p{N} ._-]{2,40}$/u;
const sameOrigin = (req: Request) => {
  try { return new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { return false; }
};
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");
const cfg = { deployBranch: DEPLOY_BRANCH, sshHost: VPS_NAME, remoteDir: REMOTE_DIR, site: SITE, repo: GH_REPO };

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

    if (p === "/login" && req.method === "POST") {
      const ip = clientIp(req, srv);
      const f = fails.get(ip);
      if (f && f.n >= 8 && f.until > Date.now()) return html(pageHtml({ error: "Sai quá nhiều lần, thử lại sau 15 phút." }), 429);
      const form = await req.formData();
      const name = String(form.get("name") ?? "").trim();
      if (!NAME_OK.test(name)) return html(pageHtml({ error: "Tên 2–40 ký tự (chữ, số, khoảng trắng, . _ -).", name }), 400);
      if (!passwordOk(String(form.get("password") ?? ""))) {
        const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 15 * 60_000 };
        cur.n++; fails.set(ip, cur);
        console.log(`${new Date().toISOString()} đăng nhập SAI "${name}" từ ${ip}`);
        return html(pageHtml({ error: "Sai mật khẩu.", name }), 401);
      }
      fails.delete(ip);
      console.log(`${new Date().toISOString()} đăng nhập "${name}" từ ${ip}`);
      return redirect("/", { "Set-Cookie": cookie(makeSession(name), SESSION_HOURS * 3600) });
    }
    if (p === "/logout" && req.method === "POST") return redirect("/", { "Set-Cookie": cookie("", 0) });

    const who = readSession(req);
    if (p === "/") return html(pageHtml(who ? { user: who, ...cfg } : {}));
    if (!p.startsWith("/api/")) return new Response("Không tìm thấy", { status: 404 });
    if (!who) return json({ error: "Chưa đăng nhập" }, 401);
    if (req.method === "POST" && !sameOrigin(req)) return json({ error: "Origin không hợp lệ" }, 403);

    try {
      if (req.method === "GET") {
        if (p === "/api/state") {
          return json({ user: who, now: new Date().toISOString(), ...cfg, may: await mayVps(),
            jobs: jobs.map(({ log, ...j }) => j) });
        }
        if (p === "/api/branches") return json(await branches());
        if (p === "/api/ref") {
          const ref = String(url.searchParams.get("ref") ?? "").trim();
          if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
          const r = await resolveRef(ref);
          if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
          return json({ ref, ...r });
        }
        if (p === "/api/job") {
          const j = jobs.find((x) => x.id === url.searchParams.get("id"));
          if (!j) return json({ error: "Không có lượt build" }, 404);
          const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
          const lines = jobLines(j);
          const { log, ...rest } = j;
          return json({ ...rest, from, lines: lines.slice(from), total: lines.length });
        }
        if (p === "/api/logs") {
          const s = SERVICES.find((x) => x.key === url.searchParams.get("svc"));
          if (!s) return json({ error: "Dịch vụ không hợp lệ" }, 400);
          const r = await ssh(`cd ${RD} && docker compose logs --no-color --timestamps --tail 400 ${s.key} 2>&1`, { quiet: true });
          return json({ svc: s.key, text: r.out });
        }
        return json({ error: "Không tìm thấy" }, 404);
      }
      if (req.method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
      const body: any = await req.json().catch(() => ({}));

      if (p === "/api/build") {
        if (await codeStale()) return json({ error: STALE_MSG }, 503);
        const ref = String(body.ref ?? DEPLOY_BRANCH).trim();
        if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
        if (busyJobs()) return json({ error: "Đang có lượt build chạy hoặc chờ, đợi xong rồi bấm lại" }, 429);
        await fetchRepo(true);
        const r = await resolveRef(ref);
        if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
        if (body.sha && !r.sha.startsWith(String(body.sha))) return json({ error: `${ref} vừa có commit mới (${r.sha.slice(0, 7)}), xem lại trước khi Build` }, 409);
        const j: Job = { id: newId(), user: who, ref, sha: r.sha, subject: r.subject, status: "queued", created: new Date().toISOString(), log: [] };
        enqueue(j);
        console.log(`${j.created} [${who}] build ${ref} @ ${r.sha.slice(0, 7)}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/restart") {
        const s = SERVICES.find((x) => x.key === body.svc && x.restart);
        if (!s) return json({ error: "Dịch vụ không khởi động lại được từ trang này" }, 400);
        if (busyJobs() || (await mayVps(true)).dangBuild) return json({ error: "Đang có lượt build, đợi xong rồi khởi động lại" }, 409);
        await sshMust(`cd ${RD} && docker compose restart ${s.key}`, { quiet: true });
        console.log(`${new Date().toISOString()} [${who}] restart ${s.key}`);
        mayCache = null;
        return json({ ok: true });
      }
      return json({ error: "Không tìm thấy" }, 404);
    } catch (e: any) {
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});
console.log(`dnso-hf chạy http://127.0.0.1:${server.port} (WORK_DIR ${WORK}, VPS ${SSH_HOST}:${REMOTE_DIR}, nhánh ${DEPLOY_BRANCH})`);
ensureRepo((l) => console.log(l)).catch((e) => console.error("Chuẩn bị repo lỗi:", e.message));
setInterval(() => { codeStale().catch((e) => console.error("Kiểm tra mã trang lỗi:", e.message)); }, 120_000);
