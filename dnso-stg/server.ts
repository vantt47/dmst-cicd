// Trang CI/CD staging của DNSO (KHCN-Thanh-Hoa/doanhnghiepso): https://stg-deploy-dnso.senow.tech
//
// Chạy trên PC quản trị (Windows, Bun, Docker Desktop, SSH tới DMST_05 qua Tailscale, cloudflared), KHÔNG chạy trên máy
// staging. Máy staging chỉ nhận ảnh đã dựng sẵn (quy ước: ảnh dựng ở máy khác, máy chủ không dựng ảnh).
//
//   CI  Mỗi push vào nhánh trong AUTO_CHECK_BRANCHES (mặc định staging, main) tự chạy Kiểm tra (kiem-tra.ts) trong
//       container dùng một lần. Dev cũng bấm "Chạy kiểm tra" cho nhánh/commit bất kỳ.
//   CD  Commit đầu nhánh DEPLOY_BRANCH (staging) qua kiểm tra thì tự Build & deploy (tắt: AUTO_DEPLOY=0):
//         1. docker build hai đích `web`, `worker` của app/Dockerfile, ngữ cảnh là `git archive <sha>:app` (không lấy
//            tệp chưa commit, không lấy bí mật của PC), thẻ = 8 ký tự đầu của sha;
//         2. `docker save | ssh DMST_05 docker load`;
//         3. đồng bộ bộ triển khai `trien-khai/` của CHÍNH commit đó vào REMOTE_DIR (compose.yml, Caddyfile,
//            trien-khai.sh…; tệp `.env*` không nằm trong git nên không bị đè), dựng ảnh cổng vào nếu Dockerfile.caddy đổi;
//         4. `ssh DMST_05 REMOTE_DIR/trien-khai.sh <thẻ>`: migrate → dựng màu web đang tắt → chờ lành → dừng êm màu cũ
//            → dựng lại worker. Không lành thì màu cũ vẫn phục vụ, job báo lỗi.
//       "Đổi bản": chạy lại một thẻ còn trên máy staging (quay lui, mặc định bỏ qua migrate).
//   Báo nhóm Nhắn tin DNSO một tin kết quả mỗi lượt triển khai (nếu secrets.json có DNSO_API_KEY/DNSO_THAY_MAT/DNSO_NHOM_ID).
//
// Không có gói phụ thuộc, chỉ API có sẵn của Bun. Cài đặt/khởi động: start.ps1. Mã chạy thẳng từ clone dmst-cicd ở
// WORK_DIR/cicd theo origin/main; khi thư mục dnso-stg trên origin/main đổi, trang tự thoát lúc rảnh để start.ps1 lấy mã
// mới và chạy lại. Sửa trang = commit + push main của dmst-cicd.
//
// Thư mục làm việc WORK_DIR (mặc định D:/DMST/dnso-stg-work, ngoài repo):
//   secrets.json   { DEPLOY_PASSWORD, SESSION_SECRET, TUNNEL_TOKEN, DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID }  (chỉ user Windows đọc)
//   cicd/          clone dmst-cicd theo origin/main (start.ps1 quản lý)
//   repo/          clone kho DNSO (bare-ish: chỉ fetch + git archive, không checkout cây làm việc)
//   jobs/, checks/ log từng lượt
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pageHtml } from "./ui";
import { newCheck, runCheck, type CheckRun } from "./kiem-tra";

const asset = (f: string) => readFileSync(join(import.meta.dir, f));
const STATIC: Record<string, [Buffer, string]> = {
  // Giao diện dùng chung bộ CSS với stg-deploy (cùng repo dmst-cicd), thêm vài dòng riêng ở dnso.css.
  "/app.css": [Buffer.concat([readFileSync(join(import.meta.dir, "..", "stg-deploy", "app.css")), Buffer.from("\n"), asset("dnso.css")]), "text/css; charset=utf-8"],
  "/app.js": [asset("app.js"), "text/javascript; charset=utf-8"],
  "/logo.svg": [asset("logo.svg"), "image/svg+xml"],
};

const E = process.env;
const PORT = Number(E.PORT ?? 8097);
const WORK = E.WORK_DIR ?? "D:/DMST/dnso-stg-work";
const REPO_URL = E.REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/doanhnghiepso.git";
const GH_REPO = "KHCN-Thanh-Hoa/doanhnghiepso";
const DEPLOY_BRANCH = E.DEPLOY_BRANCH ?? "staging";
const AUTO_DEPLOY = (E.AUTO_DEPLOY ?? "1") !== "0";
const AUTO_CHECK_BRANCHES = (E.AUTO_CHECK_BRANCHES ?? `${DEPLOY_BRANCH},main`).split(",").map((s) => s.trim()).filter(Boolean);
const SSH_HOST = E.SSH_HOST ?? "DMST_05"; // alias trong ~/.ssh/config của user Windows
const REMOTE_DIR = E.REMOTE_DIR ?? "/opt/dnso-staging";
const SITE = E.SITE ?? "https://dmst.senow.tech"; // trang mở khi bấm liên kết; cũng là host kiểm sức khoẻ sau triển khai
const SITE_HOST = new URL(SITE).host;
const CLOUDFLARED = E.CLOUDFLARED ?? join(WORK, "bin", "cloudflared.exe");
const PUBLIC_HOST = E.PUBLIC_HOST ?? "stg-deploy-dnso.senow.tech";
const KEEP_TAGS = Number(E.KEEP_TAGS ?? 6); // số thẻ ảnh giữ lại trên máy staging để quay lui
const SESSION_HOURS = 12, COOKIE = "dnsostg";

mkdirSync(join(WORK, "jobs"), { recursive: true });
const SECRETS_FILE = join(WORK, "secrets.json");
const secrets: Record<string, string> = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
if (!secrets.DEPLOY_PASSWORD) secrets.DEPLOY_PASSWORD = randomBytes(12).toString("base64url");
if (!secrets.SESSION_SECRET) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
const DEPLOY_PASSWORD = E.DEPLOY_PASSWORD ?? secrets.DEPLOY_PASSWORD;
const SESSION_SECRET = secrets.SESSION_SECRET;

// Dịch vụ compose trên máy staging được xem log / khởi động lại. Web có hai màu, chỉ một màu chạy (trien-khai/compose.yml).
const SERVICES = [
  { key: "web", label: "Web", note: "web-xanh / web-luc, đổi màu khi triển khai", restart: false },
  { key: "worker", label: "Worker", note: "tác vụ nền + lịch định kỳ (một bản duy nhất)", restart: true },
  { key: "postgres", label: "PostgreSQL 18", note: "CSDL staging, vai trò erp / cds_app như prod", restart: false },
  { key: "redis", label: "Valkey", note: "hàng đợi BullMQ", restart: false },
  { key: "cong-vao", label: "Cổng vào (Caddy)", note: "cân tải hai màu web", restart: true },
  { key: "cloudflared", label: "Cloudflare Tunnel", note: "dmst / az / nen-tang.senow.tech", restart: true },
  { key: "autoheal", label: "Autoheal", note: "khởi động lại container unhealthy", restart: false },
];
const tagFor = (sha: string) => sha.slice(0, 8);

// ---------------- Tiến trình con ----------------
type RunOpts = { cwd?: string; env?: Record<string, string>; onLine?: (l: string) => void; quiet?: boolean; stdin?: ReadableStream<Uint8Array> | null };
async function run(cmd: string[], o: RunOpts = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...E, ...o.env }, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
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
// Lệnh trên máy staging. BatchMode: không bao giờ treo chờ nhập mật khẩu.
const SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", SSH_HOST];
const ssh = (script: string, o: RunOpts = {}) => run([...SSH, script], o);
const sshMust = (script: string, o: RunOpts = {}) => must([...SSH, script], o);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const RD = shq(REMOTE_DIR);

// Ống dẫn a | b, trả lỗi của bên nào hỏng
async function pipe(a: string[], b: string[], log: (l: string) => void) {
  const pa = Bun.spawn(a, { stdout: "pipe", stderr: "pipe" });
  const r = await run(b, { stdin: pa.stdout, onLine: log });
  const ca = await pa.exited;
  if (ca !== 0) throw new Error(`${a.slice(0, 2).join(" ")} lỗi (mã ${ca}): ${(await new Response(pa.stderr).text()).trim().slice(-300)}`);
  if (r.code !== 0) throw new Error(`${b.slice(0, 2).join(" ")} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
}

// Giữ sống cloudflared (tunnel ra PUBLIC_HOST). Khi trang tự thoát để cập nhật mã thì dừng hẳn.
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

// ---------------- Git (clone riêng trong WORK) ----------------
const REPO = join(WORK, "repo");
const git = (args: string[], o: RunOpts = {}) => must(["git", "-C", REPO, ...args], o);
let repoReady: Promise<void> | null = null;
function ensureRepo(log?: (l: string) => void) {
  repoReady ??= (async () => {
    // `git archive` áp core.autocrlf: Git for Windows mặc định true → tệp ra CRLF, kiểm thử đọc tệp bằng regex `\n`
    // vỡ hàng loạt và ảnh dựng mang CRLF. Ghim false trong cấu hình của chính kho, kể cả kho đã clone trước đó.
    if (existsSync(join(REPO, "HEAD")) || existsSync(join(REPO, ".git"))) { await git(["config", "core.autocrlf", "false"]); return; }
    log?.(`Clone ${REPO_URL} (lần đầu, không checkout)…`);
    await must(["git", "-c", "core.autocrlf=false", "clone", "--bare", REPO_URL, REPO], { onLine: log });
    await git(["config", "core.autocrlf", "false"]);
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
  if (!force && Date.now() - lastFetch < 30_000) return Promise.resolve();
  fetching = git(["fetch", "-q", "--prune", "origin"]).then(() => { lastFetch = Date.now(); }).finally(() => { fetching = null; });
  return fetching;
}
async function resolveRef(ref: string) {
  await ensureRepo();
  await fetchRepo();
  const rev = /^[0-9a-f]{7,40}$/.test(ref) ? ref : `origin/${ref}`;
  const r = await run(["git", "-C", REPO, "rev-parse", "--verify", "-q", `${rev}^{commit}`], { quiet: true });
  const sha = r.code === 0 ? r.out.trim() : "";
  if (!sha) return null;
  const subject = (await git(["log", "-1", "--format=%s", sha])).trim();
  return { sha, subject };
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

// ---------------- Tự cập nhật mã của trang ----------------
const TOOL_BRANCH = E.TOOL_BRANCH ?? "main";
const toolGit = (args: string[]) => run(["git", "-C", import.meta.dir, ...args], { quiet: true })
  .then((r) => (r.code === 0 ? r : { code: r.code, out: "" }), () => ({ code: 1, out: "" }));
const TOOL_PATH = (await toolGit(["rev-parse", "--show-prefix"])).out.trim().replace(/\/$/, "");
// Trang đọc cả app.css của stg-deploy: so cả hai thư mục
const treeOf = async (rev: string) => (await toolGit(["rev-parse", `${rev}:${TOOL_PATH}`, `${rev}:stg-deploy/app.css`])).out.trim();
const RUNNING_TREE = TOOL_PATH ? await treeOf("HEAD") : "";
if (RUNNING_TREE) console.log(`Mã trang: ${RUNNING_TREE.split("\n")[0].slice(0, 10)} (${import.meta.dir})`);
else console.log(`⚠ ${import.meta.dir} không nằm trong git, không tự cập nhật mã trang.`);
let restartPending = false;
const busyJobs = () => [...jobs, ...checks].filter((j) => j.status === "queued" || j.status === "running").length;
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

// ---------------- Máy staging ----------------
type MayStaging = {
  ok: boolean; error: string | null; phienBan: string | null; subject: string | null; mau: string | null;
  services: { key: string; label: string; note: string; restart: boolean; containers: { name: string; state: string; health: string; status: string; image: string }[] }[];
  sucKhoe: any; lichSu: { luc: string; the: string; mau: string; subject: string | null }[]; luc: string;
};
// Một lệnh SSH lấy toàn bộ trạng thái, đệm 8 giây (trình duyệt hỏi 5 giây/lần)
let mayCache: { at: number; p: Promise<MayStaging> } | null = null;
function mayStaging(force = false): Promise<MayStaging> {
  if (!force && mayCache && Date.now() - mayCache.at < 8000) return mayCache.p;
  const p = (async (): Promise<MayStaging> => {
    const empty = { phienBan: null, subject: null, mau: null, services: [], sucKhoe: null, lichSu: [], luc: new Date().toISOString() };
    const r = await ssh(`cd ${RD} && echo "@@ENV" && grep -E '^PHIEN_BAN(_XANH|_LUC)?=' .env; echo "@@PS" && docker compose ps -a --format json; echo "@@LS" && tail -n 30 lich-su-trien-khai.log 2>/dev/null; echo "@@SK" && curl -sk -m 8 --resolve ${SITE_HOST}:443:127.0.0.1 https://${SITE_HOST}/suc-khoe; echo`, { quiet: true });
    if (r.code !== 0) return { ok: false, error: `Không SSH được tới ${SSH_HOST} (Tailscale trên PC?): ${r.out.trim().split("\n").slice(-2).join(" ")}`, ...empty };
    const part = (k: string) => (r.out.split(`@@${k}\n`)[1] ?? "").split(/\n@@[A-Z]+\n/)[0];
    const env = Object.fromEntries(part("ENV").trim().split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
    const ps = part("PS").trim().split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const running = ps.filter((c: any) => c.State === "running").map((c: any) => c.Service as string);
    const mau = running.includes("web-xanh") ? "xanh" : running.includes("web-luc") ? "luc" : null;
    const phienBan = env.PHIEN_BAN ?? null;
    let sucKhoe: any = null;
    try { sucKhoe = JSON.parse(part("SK").trim()); } catch { sucKhoe = part("SK").trim() ? { trangThai: "loi", raw: part("SK").trim().slice(0, 200) } : null; }
    const services = SERVICES.map((s) => ({
      ...s,
      containers: ps.filter((c: any) => (s.key === "web" ? /^web-(xanh|luc)$/.test(c.Service) : c.Service === s.key))
        .filter((c: any) => s.key !== "web" || c.State === "running" || ps.every((x: any) => !/^web-/.test(x.Service) || x.State !== "running"))
        .map((c: any) => ({ name: c.Service, state: c.State, health: c.Health ?? "", status: c.Status, image: c.Image })),
    }));
    const lichSu = [];
    for (const l of part("LS").trim().split("\n").filter(Boolean).reverse()) {
      const [d, t, the, mauX] = l.split(/\s+/);
      lichSu.push({ luc: `${d}T${t}+07:00`, the, mau: mauX, subject: /^[0-9a-f]{7,40}$/.test(the) ? await subjectOf(the) : null });
    }
    return { ok: true, error: null, phienBan, subject: phienBan ? await subjectOf(phienBan) : null, mau, services, sucKhoe, lichSu, luc: new Date().toISOString() };
  })().catch((e) => ({ ok: false, error: String(e?.message ?? e), phienBan: null, subject: null, mau: null, services: [], sucKhoe: null, lichSu: [], luc: new Date().toISOString() }));
  mayCache = { at: Date.now(), p };
  return p;
}
async function theTrenMay(): Promise<{ tag: string; created: string; subject: string | null; dangChay: boolean }[]> {
  const r = await sshMust(`docker image ls dnso-web --format '{{.Tag}}|{{.CreatedAt}}'; echo @@; docker image ls dnso-worker --format '{{.Tag}}'; echo @@; grep -E '^PHIEN_BAN=' ${RD}/.env | cut -d= -f2`, { quiet: true });
  const [web, worker, cur] = r.split("@@\n");
  const coWorker = new Set(worker.trim().split("\n"));
  const out = [];
  for (const l of web.trim().split("\n").filter(Boolean)) {
    const [tag, created] = l.split("|");
    if (!coWorker.has(tag) || tag === "<none>" || tag === "moi-nhat") continue;
    out.push({ tag, created: created.replace(/ \+\d{4} \+\d+$| [A-Z]+$/, ""), subject: /^[0-9a-f]{7,40}$/.test(tag) ? await subjectOf(tag) : null, dangChay: tag === cur.trim() });
  }
  return out;
}

// ---------------- Báo nhóm Nhắn tin DNSO ----------------
// Một tin kết quả cho mỗi lượt triển khai (giống stg-deploy). Lỗi báo tin chỉ ghi cảnh báo, không làm hỏng job.
const DNSO = {
  url: (E.DNSO_URL ?? secrets.DNSO_URL ?? "https://dmst.dnso.vn").replace(/\/+$/, ""),
  key: E.DNSO_API_KEY ?? secrets.DNSO_API_KEY ?? "",
  thayMat: E.DNSO_THAY_MAT ?? secrets.DNSO_THAY_MAT ?? "",
  nhom: E.DNSO_NHOM_ID ?? secrets.DNSO_NHOM_ID ?? "",
  duAn: "DNSO",
  moiTruong: "staging",
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
async function dnsoCommits(tu: string | null, den: string | null) {
  if (!den) return {};
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
    if (!j.deploy || !j.bao) return;
    if (!DNSO.key || !DNSO.thayMat || !DNSO.nhom) { log("Báo nhóm DNSO: chưa cấu hình DNSO_API_KEY/DNSO_THAY_MAT/DNSO_NHOM_ID trong secrets.json, bỏ qua."); return; }
    const ok = j.status === "ok";
    await dnsoPost({
      trangThai: ok ? "success" : "failure",
      tieuDe: ok ? "Staging DNSO đã cập nhật bản mới, mời mọi người vào kiểm tra" : "Cập nhật staging DNSO thất bại: vẫn chạy bản cũ, đội kỹ thuật đang xử lý",
      tacGia: j.user,
      thoiLuong: thoiLuong(Date.parse(j.ended ?? new Date().toISOString()) - Date.parse(j.started!)),
      khoaGop: `${DNSO.duAn}|${DNSO.moiTruong}|${j.bao.den ?? j.tag}|${j.id}`,
      lienKet: SITE + "/",
      ...(ok ? {} : { noiDung: `Mọi người vẫn dùng bản cũ bình thường.\nChi tiết cho đội kỹ thuật (phiên bản ${j.tag}): ${(j.error ?? "").slice(0, 400)}` }),
      ...(await dnsoCommits(j.bao.tu, j.bao.den)),
    }, log);
  } catch (e: any) { log(`⚠ Báo nhóm DNSO lỗi: ${e?.message ?? e}`); }
}

// ---------------- Hàng đợi build/deploy ----------------
type Job = {
  id: string; kind: "build" | "deploy"; user: string; ref: string; sha?: string; subject?: string; tag?: string;
  deploy: boolean; migrate: boolean; bypass?: boolean; auto?: boolean;
  status: "queued" | "running" | "ok" | "failed";
  created: string; started?: string; ended?: string; error?: string;
  bao?: { tu: string | null; den: string | null };
  log: string[];
};
const jobs: Job[] = [];
let queue: Promise<void> = Promise.resolve();
const jobFile = (j: Job) => join(WORK, "jobs", `${j.id}.log`);
function jobLog(j: Job, line: string) {
  const l = line.replace(/\x1b\[[0-9;]*m/g, "");
  j.log.push(l);
  if (j.log.length > 20_000) j.log.splice(0, 5_000);
  try { appendFileSync(jobFile(j), l + "\n"); } catch {}
}
function enqueue(j: Job, work: (j: Job, log: (l: string) => void) => Promise<void>) {
  jobs.unshift(j);
  jobs.splice(30);
  queue = queue.then(async () => {
    const log = (l: string) => jobLog(j, l);
    j.status = "running"; j.started = new Date().toISOString();
    try { await work(j, log); j.status = "ok"; log("✔ Xong."); }
    catch (e: any) { j.status = "failed"; j.error = String(e?.message ?? e); log("✘ " + j.error); }
    j.ended = new Date().toISOString();
    mayCache = null;
    await baoKetThuc(j, log);
    console.log(`${j.ended} job ${j.id} ${j.kind} ${j.status} (${j.user})`);
    if (restartPending && !busyJobs()) exitForUpdate();
  });
}
try { const fs = readdirSync(join(WORK, "jobs")).sort(); for (const f of fs.slice(0, Math.max(0, fs.length - 200))) rmSync(join(WORK, "jobs", f)); } catch {}

// Dựng ảnh từ git archive (ngữ cảnh qua stdin). Mạng chập chờn làm `bun install` trong Dockerfile lỗi: thử lại một lần.
async function dockerBuild(ctx: string, target: string | null, ref: string, sha: string, user: string, log: (l: string) => void, file?: string) {
  for (let lan = 1; lan <= 2; lan++) {
    const cmd = ["docker", "build", "--progress=plain", "-t", ref, "--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dnso.stg.by=${user}`];
    if (target) cmd.push("--target", target);
    if (file) cmd.push("-f", file);
    cmd.push("-");
    const t0 = Date.now();
    try {
      await pipe(["git", "-C", REPO, "archive", "--format=tar", `${sha}:${ctx}`], cmd,
        (l) => { if (!/^#\d+ (sha256|extracting|transferring)|^#\d+ \d+\.\d+ (Downloading|Extracting)/.test(l)) log(l); });
      log(`Dựng ${ref} xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
      return;
    } catch (e: any) {
      if (lan === 2) throw e;
      log(`⚠ Dựng ${ref} lỗi (${e.message}), thử lại một lần…`);
    }
  }
}

async function buildJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  log("Lấy mã mới từ GitHub…");
  await fetchRepo(true);
  const sha = j.sha!;
  const ck = checkOf(sha);
  if (j.bypass) log(`⚠ BỎ QUA CHẶN (khẩn cấp, ${j.user}): CI ${ck?.status === "ok" ? "đã đạt" : "chưa đạt/chưa chạy"}.`);
  else if (ck?.status !== "ok") throw new Error(`Commit ${sha.slice(0, 7)} chưa qua kiểm tra (CI)`);
  if (ck?.status === "ok") log(`Kiểm tra (CI) đạt lúc ${ck.ended} (lượt ${ck.id}).`);
  const tag = (j.tag = tagFor(sha));
  log(`Commit ${sha.slice(0, 7)}: ${j.subject}`);
  const truoc = (await mayStaging(true)).phienBan;
  j.bao = { tu: await resolveSha(truoc), den: sha };

  const coSan = (await ssh(`docker image inspect dnso-web:${tag} dnso-worker:${tag} >/dev/null 2>&1`, { quiet: true })).code === 0;
  if (coSan) log(`Máy staging đã có dnso-web:${tag} và dnso-worker:${tag}, bỏ qua dựng ảnh.`);
  else {
    for (const target of ["web", "worker"]) {
      log(""); log(`══ Dựng dnso-${target}:${tag}`);
      await dockerBuild("app", target, `dnso-${target}:${tag}`, sha, j.user, log);
    }
    log(""); log(`══ Chuyển ảnh sang ${SSH_HOST} (docker save | ssh docker load)…`);
    const t0 = Date.now();
    await pipe(["docker", "save", `dnso-web:${tag}`, `dnso-worker:${tag}`], [...SSH.slice(0, -1), "-C", SSH_HOST, "docker load"], log);
    log(`Chuyển xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
    for (const t of ["web", "worker"]) await run(["docker", "image", "rm", `dnso-${t}:${tag}`], { quiet: true });
  }
  if (!j.deploy) { log(`Chỉ build, không triển khai. Thẻ ${tag} đã có trên ${SSH_HOST}, dùng "Đổi bản" để chạy.`); return; }
  await dongBoBoTrienKhai(sha, j.user, log);
  await trienKhai(tag, j.migrate, log);
}

// Bộ triển khai trien-khai/ của commit được triển khai → REMOTE_DIR. Commit cũ chưa có thư mục này thì giữ bản trên máy.
async function dongBoBoTrienKhai(sha: string, user: string, log: (l: string) => void) {
  log(""); log("══ Đồng bộ bộ triển khai (trien-khai/)");
  if ((await run(["git", "-C", REPO, "cat-file", "-e", `${sha}:trien-khai/compose.yml`], { quiet: true })).code !== 0) {
    log("Commit này chưa có trien-khai/compose.yml, giữ bộ triển khai đang có trên máy.");
    return;
  }
  // Chỉ tệp đã commit; .env* nằm trong .gitignore nên không bao giờ bị đè.
  await pipe(["git", "-C", REPO, "archive", "--format=tar", `${sha}:trien-khai`],
    [...SSH, `cd ${RD} && tar -x --no-same-owner -f - && chmod +x trien-khai.sh && echo "Đã chép: $(ls -1 | tr '\\n' ' ')"`], log);
  // Ảnh cổng vào: thẻ theo băm Dockerfile.caddy (giống cách dựng tay), dựng khi máy chưa có.
  const dockerfile = await git(["show", `${sha}:trien-khai/Dockerfile.caddy`], { quiet: true });
  const cv = createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
  if ((await ssh(`docker image inspect dnso-cong-vao:${cv} >/dev/null 2>&1`, { quiet: true })).code !== 0) {
    log(`Dockerfile.caddy đổi → dựng dnso-cong-vao:${cv}`);
    await dockerBuild("trien-khai", null, `dnso-cong-vao:${cv}`, sha, user, log, "Dockerfile.caddy");
    await pipe(["docker", "save", `dnso-cong-vao:${cv}`], [...SSH, "docker load"], log);
    await run(["docker", "image", "rm", `dnso-cong-vao:${cv}`], { quiet: true });
  }
  await sshMust(`cd ${RD} && if grep -q '^PHIEN_BAN_CONG_VAO=' .env; then sed -i 's|^PHIEN_BAN_CONG_VAO=.*|PHIEN_BAN_CONG_VAO=${cv}|' .env; else echo PHIEN_BAN_CONG_VAO=${cv} >> .env; fi`);
}

async function trienKhai(tag: string, migrate: boolean, log: (l: string) => void) {
  log(""); log(`══ Triển khai ${tag} trên ${SSH_HOST} (${migrate ? "có migrate" : "bỏ qua migrate"})`);
  const r = await run([...SSH, `cd ${RD} && ./trien-khai.sh ${tag}${migrate ? "" : " --bo-qua-migrate"} </dev/null 2>&1`], {
    onLine: (l) => { if (!/^\s*(Container|[0-9a-f]{12} (Pull|Download|Extract|Verif|Waiting))/.test(l)) log(l); },
  });
  if (r.code !== 0) throw new Error(`trien-khai.sh lỗi (mã ${r.code}), xem log phía trên. Màu web cũ vẫn phục vụ nếu màu mới không lành.`);
  // Kiểm qua cổng vào thật (Caddy) như người dùng, không qua tunnel để khỏi phụ thuộc DNS
  const sk = await ssh(`curl -sk -m 15 --resolve ${SITE_HOST}:443:127.0.0.1 https://${SITE_HOST}/suc-khoe`, { quiet: true });
  let tt = "";
  try { tt = JSON.parse(sk.out).trangThai; } catch {}
  if (tt !== "ok") throw new Error(`Đã đổi bản nhưng /suc-khoe qua cổng vào không "ok": ${sk.out.trim().slice(0, 300)}`);
  log(`/suc-khoe qua cổng vào: ok.`);
  // Dọn thẻ cũ, giữ KEEP_TAGS thẻ gần nhất (theo lịch sử triển khai) để quay lui
  await ssh(`cd ${RD} && giu=$( (grep -E '^PHIEN_BAN(_XANH|_LUC)?=' .env | cut -d= -f2; awk '{print $3}' lich-su-trien-khai.log | tac | awk '!a[$0]++' | head -n ${KEEP_TAGS}) | sort -u); for r in dnso-web dnso-worker; do docker image ls $r --format '{{.Tag}}' | while read t; do echo "$giu" | grep -qx "$t" || docker image rm -f "$r:$t" >/dev/null 2>&1; done; done; docker image prune -f >/dev/null 2>&1; true`, { quiet: true });
}

async function deployJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  await fetchRepo(true);
  const tag = j.tag!;
  if ((await ssh(`docker image inspect dnso-web:${tag} dnso-worker:${tag} >/dev/null 2>&1`, { quiet: true })).code !== 0)
    throw new Error(`Máy staging không còn ảnh dnso-web:${tag} / dnso-worker:${tag}`);
  const truoc = (await mayStaging(true)).phienBan;
  j.bao = { tu: await resolveSha(truoc), den: await resolveSha(tag) };
  await trienKhai(tag, j.migrate, log);
}

// ---------------- Kiểm tra (CI) ----------------
const CHECK_DIR = join(WORK, "checks");
mkdirSync(CHECK_DIR, { recursive: true });
const checks: CheckRun[] = [];
try {
  const files = readdirSync(CHECK_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 200))) { rmSync(join(CHECK_DIR, f)); rmSync(join(CHECK_DIR, f.replace(/\.json$/, ".log")), { force: true }); }
  for (const f of files.slice(-200).reverse()) {
    const c: CheckRun = JSON.parse(readFileSync(join(CHECK_DIR, f), "utf8"));
    c.log = [];
    if (c.status === "queued" || c.status === "running") { c.status = "failed"; c.error = "Bị ngắt do trang khởi động lại, chạy lại kiểm tra"; c.ended ??= new Date().toISOString(); }
    checks.push(c);
  }
} catch (e: any) { console.error("Đọc kết quả kiểm tra cũ lỗi:", e.message); }
const saveCheck = (c: CheckRun) => { const { log, ...rest } = c; try { writeFileSync(join(CHECK_DIR, `${c.id}.json`), JSON.stringify(rest)); } catch {} };
const checkLogLines = (c: CheckRun) => {
  if (c.log.length) return c.log;
  try { return readFileSync(join(CHECK_DIR, `${c.id}.log`), "utf8").split("\n").filter(Boolean); } catch { return []; }
};
const checkOf = (sha: string) => checks.find((c) => c.sha === sha);
const checkSummary = ({ log, ...c }: CheckRun) => c;
let checkQueue: Promise<void> = Promise.resolve();
function enqueueCheck(c: CheckRun) {
  checks.unshift(c);
  saveCheck(c);
  checkQueue = checkQueue.then(async () => {
    if (c.superseded) {
      checks.splice(checks.indexOf(c), 1);
      rmSync(join(CHECK_DIR, `${c.id}.json`), { force: true });
      if (restartPending && !busyJobs()) exitForUpdate();
      return;
    }
    const log = (l: string) => {
      const x = l.replace(/\x1b\[[0-9;]*m/g, "");
      c.log.push(x);
      if (c.log.length > 40_000) c.log.splice(0, 10_000);
      try { appendFileSync(join(CHECK_DIR, `${c.id}.log`), x + "\n"); } catch {}
    };
    c.status = "running"; c.started = new Date().toISOString(); saveCheck(c);
    let t: Timer | null = null;
    const changed = () => { t ??= setTimeout(() => { t = null; saveCheck(c); }, 1000); };
    try { await runCheck(c, { run, repo: REPO, log, changed }); c.status = "ok"; log("✔ Kiểm tra đạt, có thể Build commit này."); }
    catch (e: any) { c.status = "failed"; c.error = String(e?.message ?? e); log("✘ " + c.error); }
    c.ended = new Date().toISOString();
    saveCheck(c);
    c.log = [];
    console.log(`${c.ended} kiểm tra ${c.id} ${c.sha.slice(0, 7)} ${c.status} (${c.user})`);
    await tuTrienKhai(c).catch((e) => console.error("Tự triển khai lỗi:", e.message));
    if (restartPending && !busyJobs()) exitForUpdate();
  });
}

// CD: lượt kiểm tra vừa đạt là commit ĐẦU nhánh triển khai, chưa chạy trên staging, chưa có job cho nó → Build & deploy.
async function tuTrienKhai(c: CheckRun) {
  if (!AUTO_DEPLOY || c.status !== "ok" || exiting) return;
  await fetchRepo(true);
  const head = await resolveSha(`origin/${DEPLOY_BRANCH}`);
  if (head !== c.sha) return;
  if (jobs.some((j) => j.sha === c.sha && j.status !== "failed")) return;
  const may = await mayStaging(true);
  if (may.phienBan === tagFor(c.sha)) return;
  const j: Job = { id: newId(), kind: "build", user: AUTO_USER, ref: DEPLOY_BRANCH, sha: c.sha, subject: c.subject, deploy: true, migrate: true, auto: true, status: "queued", created: new Date().toISOString(), log: [] };
  enqueue(j, buildJob);
  console.log(`${j.created} [${AUTO_USER}] build & deploy ${DEPLOY_BRANCH} @ ${c.sha.slice(0, 7)}`);
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
const TAG_OK = /^[0-9a-f]{7,40}$/;
const REF_OK = /^(?!.*\.\.)(?!-)[A-Za-z0-9._\/-]{1,100}$/;
const NAME_OK = /^[\p{L}\p{N} ._-]{2,40}$/u;
const sameOrigin = (req: Request) => {
  try { return new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { return false; }
};
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");
const AUTO_USER = "Tự động (push)";
const cfg = { deployBranch: DEPLOY_BRANCH, autoDeploy: AUTO_DEPLOY, autoCheck: AUTO_CHECK_BRANCHES, sshHost: SSH_HOST, remoteDir: REMOTE_DIR, site: SITE, repo: GH_REPO };

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
          return json({ user: who, now: new Date().toISOString(), ...cfg, may: await mayStaging(),
            jobs: jobs.map(({ log, ...j }) => ({ ...j, lines: log.length })), checks: checks.slice(0, 15).map(checkSummary) });
        }
        if (p === "/api/branches") return json(await branches());
        if (p === "/api/tags") return json(await theTrenMay());
        if (p === "/api/job") {
          const j = jobs.find((x) => x.id === url.searchParams.get("id"));
          if (!j) return json({ error: "Không có job" }, 404);
          const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
          const { log, ...rest } = j;
          return json({ ...rest, from, lines: log.slice(from), total: log.length });
        }
        if (p === "/api/check") {
          const ref = String(url.searchParams.get("ref") ?? "").trim();
          if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
          const r = await resolveRef(ref);
          if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
          const c = checkOf(r.sha);
          return json({ ref, ...r, check: c ? checkSummary(c) : null });
        }
        if (p === "/api/checkrun") {
          const c = checks.find((x) => x.id === url.searchParams.get("id"));
          if (!c) return json({ error: "Không có lượt kiểm tra" }, 404);
          const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
          const lines = checkLogLines(c);
          return json({ ...checkSummary(c), from, lines: lines.slice(from, from + 5000), total: Math.min(lines.length, from + 5000) });
        }
        if (p === "/api/logs") {
          const s = SERVICES.find((x) => x.key === url.searchParams.get("svc"));
          if (!s) return json({ error: "Dịch vụ không hợp lệ" }, 400);
          // Web: màu đang chạy (hoặc màu chạy gần nhất)
          const may = await mayStaging();
          const svc = s.key === "web" ? (may.mau ? `web-${may.mau}` : "web-xanh web-luc") : s.key;
          const r = await ssh(`cd ${RD} && docker compose logs --no-color --timestamps --tail 400 ${svc} 2>&1`, { quiet: true });
          return json({ svc, text: r.out });
        }
        return json({ error: "Không tìm thấy" }, 404);
      }
      if (req.method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
      const body: any = await req.json().catch(() => ({}));
      if ((p === "/api/build" || p === "/api/deploy" || p === "/api/check") && (await codeStale())) return json({ error: STALE_MSG }, 503);

      if (p === "/api/check") {
        const ref = String(body.ref ?? DEPLOY_BRANCH).trim();
        if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
        await fetchRepo(true);
        const r = await resolveRef(ref);
        if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
        const cur = checkOf(r.sha);
        if (cur?.superseded) cur.superseded = false;
        if (cur && cur.status !== "failed") return json({ ok: true, id: cur.id, sha: r.sha, reused: true });
        if (checks.filter((c) => c.status === "queued" || c.status === "running").length >= 3) return json({ error: "Đã có 3 lượt kiểm tra đang chờ, đợi bớt" }, 429);
        const c = newCheck({ id: newId(), sha: r.sha, ref, subject: r.subject, user: who });
        enqueueCheck(c);
        console.log(`${c.created} [${who}] kiểm tra ${ref} @ ${r.sha.slice(0, 7)}`);
        return json({ ok: true, id: c.id, sha: r.sha });
      }
      if (p === "/api/build") {
        const ref = String(body.ref ?? DEPLOY_BRANCH).trim();
        if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
        if (busyJobs() >= 5) return json({ error: "Hàng đợi đã có 5 việc, đợi bớt" }, 429);
        await fetchRepo(true);
        const r = await resolveRef(ref);
        if (!r) return json({ error: `Không thấy ${ref} trên GitHub` }, 404);
        if (body.sha && !r.sha.startsWith(String(body.sha))) return json({ error: `${ref} vừa có commit mới (${r.sha.slice(0, 7)}), kiểm tra lại trước khi Build` }, 409);
        const bypass = body.bypass === true;
        if (!bypass && checkOf(r.sha)?.status !== "ok") return json({ error: `Commit ${r.sha.slice(0, 7)} chưa qua kiểm tra (CI). Bấm "Chạy kiểm tra" trước.` }, 409);
        const j: Job = { id: newId(), kind: "build", user: who, ref, sha: r.sha, subject: r.subject, deploy: body.deploy !== false, migrate: true, bypass, status: "queued", created: new Date().toISOString(), log: [] };
        enqueue(j, buildJob);
        console.log(`${j.created} [${who}] build ${ref} @ ${r.sha.slice(0, 7)}${j.deploy ? "" : " (chỉ build)"}${bypass ? " (BỎ QUA CHẶN)" : ""}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/deploy") {
        const tag = String(body.tag ?? "").trim();
        if (!TAG_OK.test(tag)) return json({ error: "Thẻ ảnh không hợp lệ" }, 400);
        const j: Job = { id: newId(), kind: "deploy", user: who, ref: tag, tag, subject: (await subjectOf(tag)) ?? undefined, deploy: true, migrate: body.migrate === true, status: "queued", created: new Date().toISOString(), log: [] };
        enqueue(j, deployJob);
        console.log(`${j.created} [${who}] đổi bản ${tag}${j.migrate ? " (có migrate)" : ""}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/restart") {
        const s = SERVICES.find((x) => x.key === body.svc && x.restart);
        if (!s) return json({ error: "Dịch vụ không khởi động lại được từ trang này" }, 400);
        if (busyJobs()) return json({ error: "Đang có việc build/triển khai, đợi xong rồi khởi động lại" }, 409);
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
console.log(`dnso-stg chạy http://127.0.0.1:${server.port} (WORK_DIR ${WORK}, máy ${SSH_HOST}:${REMOTE_DIR}, tự triển khai ${AUTO_DEPLOY ? DEPLOY_BRANCH : "TẮT"})`);
ensureRepo((l) => console.log(l)).catch((e) => console.error("Chuẩn bị repo lỗi:", e.message));
setInterval(() => { codeStale().catch((e) => console.error("Kiểm tra mã trang lỗi:", e.message)); }, 120_000);

// ---------------- Tự chạy Kiểm tra (CI) khi có push ----------------
// Mỗi AUTO_CHECK_SEC giây fetch kho DNSO; nhánh trong AUTO_CHECK_BRANCHES có commit đầu mới thì xếp một lượt kiểm tra.
// Đầu nhánh đã thấy lưu ở WORK/auto-check.json; lần đầu (chưa có tệp) chỉ ghi mốc. Lượt tự động cũ còn chờ của cùng
// nhánh bị bỏ khi có commit mới hơn. Kiểm tra đạt ở nhánh DEPLOY_BRANCH thì tuTrienKhai() xếp Build & deploy.
const AUTO_CHECK_SEC = Number(E.AUTO_CHECK_SEC ?? 60);
const AUTO_FILE = join(WORK, "auto-check.json");
let autoHeads: Record<string, string> | null = null;
try { autoHeads = JSON.parse(readFileSync(AUTO_FILE, "utf8")); } catch {}
let autoBusy = false;
async function autoCheck() {
  if (autoBusy || exiting) return;
  autoBusy = true;
  try {
    if (await codeStale()) return;
    await ensureRepo();
    await fetchRepo(true);
    const heads: Record<string, { sha: string; subject: string }> = {};
    for (const name of AUTO_CHECK_BRANCHES) {
      const sha = await resolveSha(`origin/${name}`);
      if (sha) heads[name] = { sha, subject: (await subjectOf(sha)) ?? "" };
    }
    if (autoHeads) {
      for (const [name, h] of Object.entries(heads)) {
        if (autoHeads[name] === h.sha) continue;
        const cur = checkOf(h.sha);
        if (cur) { if (cur.status === "ok") await tuTrienKhai(cur); continue; } // commit đã kiểm (vd. nhánh khác) → chỉ còn bước CD
        for (const old of checks) if (old.auto && old.ref === name && old.status === "queued") old.superseded = true;
        const c = newCheck({ id: newId(), sha: h.sha, ref: name, subject: h.subject, user: AUTO_USER });
        c.auto = true;
        enqueueCheck(c);
        console.log(`${c.created} [${AUTO_USER}] kiểm tra ${name} @ ${h.sha.slice(0, 7)}`);
      }
    } else console.log(`Tự kiểm tra khi push: ghi mốc ${Object.keys(heads).join(", ")} (lần đầu, không kiểm tra).`);
    autoHeads = Object.fromEntries(Object.entries(heads).map(([n, h]) => [n, h.sha]));
    writeFileSync(AUTO_FILE, JSON.stringify(autoHeads, null, 1));
  } catch (e: any) {
    console.error("Tự kiểm tra khi push lỗi:", e.message);
  } finally { autoBusy = false; }
}
if (AUTO_CHECK_SEC > 0) { setTimeout(autoCheck, 10_000); setInterval(autoCheck, AUTO_CHECK_SEC * 1000); }
