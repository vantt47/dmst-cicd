// Trang build + deploy thủ công cụm staging: https://stg-deploy-sangiaodich.dmst.vn
// Chạy trên PC quản trị (Windows, Docker Desktop, Tailscale tới cụm), KHÔNG chạy trong cụm:
//   - dev đăng nhập (mật khẩu chung + tên), xem service/pod đang chạy trên staging;
//   - bấm Build: PC lấy mã nhánh/commit từ GitHub, docker build + push GHCR (giống build-push.yml), rồi commit đổi
//     newTag trong deploy/k8s/clusters/staging/kustomization.yaml vào nhánh staging (SSH key của PC) và gọi Flux áp ngay;
//   - hoặc Deploy một thẻ ảnh có sẵn trên GHCR (cũng là commit đổi newTag).
// Tiến trình này tự chạy và giữ sống `kubectl proxy` (API cụm, chỉ 127.0.0.1) và `cloudflared` (tunnel ra domain).
// Không có gói phụ thuộc, chỉ API có sẵn của Bun. Cài đặt/khởi động: xem start.ps1.
// Mã của trang chạy thẳng từ repo: worktree WORK_DIR/tool theo origin/staging (start.ps1 cập nhật mỗi lần khởi động),
// không có bản sao. Khi thư mục deploy/stg-deploy trên origin/staging khác mã đang chạy, trang tự thoát lúc rảnh
// (hoặc ngay khi có người bấm Build/Deploy) để start.ps1 lấy mã mới và chạy lại. Sửa trang = commit + push nhánh staging.
//
// Thư mục làm việc WORK_DIR (mặc định D:/DMST/stg-deploy-work, ngoài repo):
//   secrets.json   { DEPLOY_PASSWORD, SESSION_SECRET, TUNNEL_TOKEN, DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID }  (chỉ user Windows đọc)
//   repo/          clone riêng theo nhánh staging, dùng để commit đổi thẻ ảnh
//   src/           worktree tách rời của repo/, checkout commit cần build
//   jobs/<id>.log  log từng lần build
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pageHtml } from "./ui";

// Tệp tĩnh cùng thư mục, đọc 1 lần lúc chạy
const asset = (f: string) => readFileSync(join(import.meta.dir, f));
const STATIC: Record<string, [Buffer, string]> = {
  "/app.css": [asset("app.css"), "text/css; charset=utf-8"],
  "/app.js": [asset("app.js"), "text/javascript; charset=utf-8"],
  "/logo.svg": [asset("logo-thihub.svg"), "image/svg+xml"],
};

const E = process.env;
const PORT = Number(E.PORT ?? 8099);
const WORK = E.WORK_DIR ?? "D:/DMST/stg-deploy-work";
const REPO_URL = E.REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/5-san-tmdt.git";
const BRANCH = E.GITOPS_BRANCH ?? "staging";
const KPATH = "ecommerce-monorepo/deploy/k8s/clusters/staging/kustomization.yaml";
const KUBECONFIG = E.STG_KUBECONFIG ?? "C:/Users/Admin/.kube/tmdt-staging.yaml";
const CLOUDFLARED = E.CLOUDFLARED ?? join(WORK, "bin", "cloudflared.exe");
const PUBLIC_HOST = E.PUBLIC_HOST ?? "stg-deploy-sangiaodich.dmst.vn";
const PROXY_PORT = Number(E.KUBE_PROXY_PORT ?? 8098);
const K8S = `http://127.0.0.1:${PROXY_PORT}`;
const GH_ORG = "KHCN-Thanh-Hoa";
const REG = "ghcr.io/khcn-thanh-hoa";
// Biến build của ảnh web staging (trùng build-push.yml). Chế độ tên miền: ke-hoach-5-san/tich-hop-5-san/08-che-do-ten-mien-con-va-duong-dan.md
const WEB_ARGS = {
  VITE_API_URL: E.STAGING_API_URL ?? "https://sangiaodich.dmst.vn/api",
  VITE_GOOGLE_CLIENT_ID: E.STAGING_GOOGLE_CLIENT_ID ?? "764794139184-sn5rdvuqkqevqtrupcl8kkm7p53h5d1g.apps.googleusercontent.com",
  VITE_SELLER_CENTER_URL: E.STAGING_SELLER_CENTER_URL ?? "https://nguoiban-sangiaodich.dmst.vn",
  // "" đường dẫn; "{san}-sangiaodich.dmst.vn" tên miền con
  SAN_TEN_MIEN: E.STAGING_SAN_TEN_MIEN ?? "",
};
const FLUX_NS = "flux-system", FLUX_SOURCE = "tmdt", FLUX_KS = "staging";
const SESSION_HOURS = 12, COOKIE = "stgdeploy";

mkdirSync(join(WORK, "jobs"), { recursive: true });
const SECRETS_FILE = join(WORK, "secrets.json");
const secrets: Record<string, string> = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
if (!secrets.DEPLOY_PASSWORD) secrets.DEPLOY_PASSWORD = randomBytes(12).toString("base64url");
if (!secrets.SESSION_SECRET) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
const DEPLOY_PASSWORD = E.DEPLOY_PASSWORD ?? secrets.DEPLOY_PASSWORD;
const SESSION_SECRET = secrets.SESSION_SECRET;
const GH_TOKEN = E.GITHUB_CLASSIC_TOKEN ?? ""; // chỉ để liệt kê thẻ ảnh (Packages API, read:packages)

// ---------------- Service ----------------
type Service = {
  key: string; label: string; note: string; image: string;
  ns: string; deploy: string; container?: string; init?: string;
  // Deployment khác cùng namespace dùng chung ảnh (backend-worker): đổi thẻ là rollout cả nó, Restart cũng khởi động lại nó
  also?: string[];
  // build: thư mục ngữ cảnh + Dockerfile (tương đối ecommerce-monorepo/), target, build-arg; tag theo commit
  build: { context: string; file: string; target?: string; args?: Record<string, string>; suffix: string };
};
const SERVICES: Service[] = [
  { key: "backend", label: "Backend API", note: "api-sangiaodich.dmst.vn", image: `${REG}/tmdt-backend`, ns: "tmdt", deploy: "backend", container: "backend", also: ["backend-worker"],
    build: { context: "backend", file: "backend/Dockerfile", target: "runtime", suffix: "" } },
  { key: "migrate", label: "Migrate CSDL", note: "initContainer của backend: migrate + seed vùng trước khi backend chạy", image: `${REG}/tmdt-migrate`, ns: "tmdt", deploy: "backend", init: "migrate", also: ["backend-worker"],
    build: { context: "backend", file: "backend/Dockerfile.migrate", suffix: "" } },
  { key: "web", label: "Web", note: "sangiaodich, nguoiban-, quantri-sangiaodich.dmst.vn", image: `${REG}/tmdt-web`, ns: "tmdt", deploy: "web", container: "web",
    build: { context: ".", file: "deploy/nginx/Dockerfile", target: "k8s", args: WEB_ARGS, suffix: "-staging" } },
  { key: "ome-agent", label: "OME agent", note: "sidecar của ome-origin, ns tmdt-live", image: `${REG}/tmdt-ome-agent`, ns: "tmdt-live", deploy: "ome-origin", container: "agent",
    build: { context: "deploy/ome/agent", file: "deploy/ome/agent/Dockerfile", suffix: "" } },
];
const VIEW_NS = [...new Set(SERVICES.map((s) => s.ns))];
const tagFor = (s: Service, sha: string) => `stg-${sha.slice(0, 7)}-pc${s.build.suffix}`;

// ---------------- Tiến trình con ----------------
type RunOpts = { cwd?: string; env?: Record<string, string>; onLine?: (l: string) => void; quiet?: boolean };
async function run(cmd: string[], o: RunOpts = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...E, ...o.env }, stdout: "pipe", stderr: "pipe" });
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

// Giữ sống kubectl proxy và cloudflared, chạy lại sau 5 giây nếu thoát. Khi trang tự thoát để cập nhật mã thì dừng hẳn.
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
keepAlive("kubectl-proxy", () => ["kubectl", "--kubeconfig", KUBECONFIG, "proxy", "--address", "127.0.0.1", "--port", String(PROXY_PORT)]);
keepAlive("cloudflared", () => (secrets.TUNNEL_TOKEN && existsSync(CLOUDFLARED) ? [CLOUDFLARED, "tunnel", "--no-autoupdate", "run"] : null), { TUNNEL_TOKEN: secrets.TUNNEL_TOKEN ?? "" });

// ---------------- Kubernetes API (qua kubectl proxy) ----------------
async function k8s(path: string, init: RequestInit & { contentType?: string } = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.contentType) headers["Content-Type"] = init.contentType;
  const r = await fetch(K8S + path, { ...init, headers });
  if (!r.ok) throw new Error(`k8s ${init.method ?? "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return path.includes("/log?") ? r.text() : r.json();
}
const mergePatch = (path: string, body: unknown) =>
  k8s(path, { method: "PATCH", body: JSON.stringify(body), contentType: "application/merge-patch+json" });
async function fluxReconcile() {
  const ann = { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": new Date().toISOString() } } };
  await mergePatch(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/gitrepositories/${FLUX_SOURCE}`, ann);
  await mergePatch(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/kustomizations/${FLUX_KS}`, ann);
}

// ---------------- GHCR ----------------
const tagExists = async (image: string, tag: string) => (await run(["docker", "manifest", "inspect", `${image}:${tag}`])).code === 0;
type TagInfo = { tag: string; created: string | null };
async function listTags(image: string): Promise<TagInfo[]> {
  if (!GH_TOKEN) throw new Error("Thiếu GITHUB_CLASSIC_TOKEN (read:packages) để liệt kê thẻ; vẫn nhập tay thẻ được");
  const pkg = image.split("/").pop();
  const r = await fetch(`https://api.github.com/orgs/${GH_ORG}/packages/container/${pkg}/versions?per_page=40`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GitHub Packages ${r.status}`);
  const out: TagInfo[] = [];
  for (const v of (await r.json()) as any[]) for (const t of v.metadata?.container?.tags ?? []) out.push({ tag: t, created: v.created_at });
  // staging: ẩn thẻ build cho production
  return out.filter((t) => !/production/.test(t.tag)).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}

// ---------------- Git (clone riêng trong WORK) ----------------
const REPO = join(WORK, "repo"), SRC = join(WORK, "src");
const git = (args: string[], o: RunOpts = {}) => must(["git", "-C", o.cwd ?? REPO, ...args], o);
let repoReady: Promise<void> | null = null;
function ensureRepo(log?: (l: string) => void) {
  repoReady ??= prepareRepo(log).catch((e) => { repoReady = null; throw e; });
  return repoReady;
}
async function prepareRepo(log?: (l: string) => void) {
  if (!existsSync(join(REPO, ".git"))) {
    log?.(`Clone ${REPO_URL} (lần đầu)…`);
    await must(["git", "-c", "core.autocrlf=false", "clone", "--branch", BRANCH, REPO_URL, REPO], { onLine: log });
    await git(["config", "core.autocrlf", "false"]);
    await git(["config", "user.name", E.GIT_USER_NAME ?? "vantt47"]);
    await git(["config", "user.email", E.GIT_USER_EMAIL ?? "89087529+vantt47@users.noreply.github.com"]);
  }
  if (!existsSync(join(SRC, ".git"))) await git(["worktree", "add", "--detach", SRC, `origin/${BRANCH}`]);
}
let lastFetch = 0;
let fetching: Promise<void> | null = null;
function fetchRepo(force = false): Promise<void> {
  if (fetching) return fetching.then(() => (force ? fetchRepo(true) : undefined));
  if (!force && Date.now() - lastFetch < 30_000) return Promise.resolve();
  fetching = git(["fetch", "--prune", "origin"]).then(() => { lastFetch = Date.now(); }).finally(() => { fetching = null; });
  return fetching;
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const tagRe = (image: string) => new RegExp(`(-\\s+name:\\s*${escRe(image)}\\s*\\r?\\n\\s*newTag:\\s*)(\\S+)`);
async function gitTags() {
  const text = await git(["show", `origin/${BRANCH}:${KPATH}`], { quiet: true });
  return Object.fromEntries(SERVICES.map((s) => [s.key, text.match(tagRe(s.image))?.[2] ?? null]));
}

// Commit đổi thẻ ảnh vào nhánh staging rồi push (thử lại khi bị từ chối do có commit mới).
async function commitTags(changes: { svc: Service; tag: string }[], who: string, note: string, log: (l: string) => void) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fetchRepo(true);
    await git(["checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`]);
    await git(["reset", "-q", "--hard", `origin/${BRANCH}`]);
    const file = join(REPO, KPATH);
    let text = readFileSync(file, "utf8");
    const diffs: string[] = [];
    for (const { svc, tag } of changes) {
      const old = text.match(tagRe(svc.image))?.[2];
      if (!old) throw new Error(`Không thấy mục images cho ${svc.image} trong kustomization.yaml`);
      if (old !== tag) { text = text.replace(tagRe(svc.image), `$1${tag}`); diffs.push(`${svc.image.split("/").pop()} ${old} → ${tag}`); }
    }
    if (!diffs.length) { log("Thẻ ảnh trong Git đã đúng, không cần commit."); return null; }
    writeFileSync(file, text);
    const msg = `Staging (stg-deploy): ${diffs.join(", ")}\n\n${note}\nThực hiện bởi ${who} qua https://${PUBLIC_HOST}`;
    await git(["commit", "-q", "-m", msg, "--", KPATH]);
    const r = await run(["git", "-C", REPO, "push", "origin", `HEAD:${BRANCH}`], { onLine: log });
    if (r.code === 0) {
      const sha = (await git(["rev-parse", "HEAD"])).trim();
      log(`Đã push commit ${sha.slice(0, 7)} lên nhánh ${BRANCH}: ${diffs.join(", ")}`);
      lastFetch = 0;
      return sha;
    }
    log(`Push bị từ chối (lần ${attempt}), lấy bản mới rồi thử lại…`);
  }
  throw new Error("Không push được vào nhánh staging sau 3 lần");
}

// ---------------- Tự cập nhật mã của trang ----------------
// So cây thư mục deploy/stg-deploy đang chạy (worktree WORK_DIR/tool) với origin/staging. Chạy ngoài git (thử trên máy dev)
// thì RUNNING_TREE rỗng, không kiểm tra.
const TOOL_PATH = "ecommerce-monorepo/deploy/stg-deploy";
const RUNNING_TREE = (await run(["git", "-C", import.meta.dir, "rev-parse", "HEAD:./"], { quiet: true }).catch(() => ({ code: 1, out: "" })))
  .out.trim();
if (RUNNING_TREE) console.log(`Mã trang: cây ${RUNNING_TREE.slice(0, 10)} (${import.meta.dir})`);
else console.log(`⚠ ${import.meta.dir} không nằm trong git, không tự cập nhật mã trang.`);
let restartPending = false;
const busyJobs = () => jobs.filter((j) => j.status === "queued" || j.status === "running").length;
function exitForUpdate() {
  if (exiting) return;
  exiting = true;
  console.log(`${new Date().toISOString()} origin/${BRANCH} có mã trang mới, thoát để start.ps1 cập nhật và chạy lại.`);
  for (const p of children) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 1000);
}
// true: mã đang chạy đã cũ (đã hẹn thoát; có việc đang chạy thì thoát khi hàng đợi rỗng).
async function codeStale(): Promise<boolean> {
  if (restartPending) return true;
  if (!RUNNING_TREE) return false;
  await ensureRepo();
  await fetchRepo();
  const remote = (await run(["git", "-C", REPO, "rev-parse", `origin/${BRANCH}:${TOOL_PATH}`], { quiet: true })).out.trim();
  if (!remote || remote === RUNNING_TREE) return false;
  restartPending = true;
  if (!busyJobs()) exitForUpdate();
  else console.log(`${new Date().toISOString()} mã trang mới trên origin/${BRANCH}, chờ ${busyJobs()} việc xong rồi khởi động lại.`);
  return true;
}
const STALE_MSG = "Trang stg-deploy vừa có mã mới trên nhánh staging, đang khởi động lại để dùng mã mới. Bấm lại sau khoảng 30 giây.";

async function history() {
  await fetchRepo();
  const out = await git(["log", "-20", "--format=%H%x1f%cI%x1f%B%x1e", `origin/${BRANCH}`, "--", KPATH]);
  return out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [sha, date, message] = x.split("\x1f");
    return { sha: sha.slice(0, 7), url: `https://github.com/${GH_ORG}/5-san-tmdt/commit/${sha}`, date, message: message.trim() };
  });
}
async function branches() {
  await fetchRepo();
  const out = await git(["for-each-ref", "--sort=-committerdate", "--count=40", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(objectname:short)%1f%(subject)", "refs/remotes/origin"]);
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [ref, date, sha, subject] = l.split("\x1f");
    return { name: ref.replace(/^origin\//, ""), date, sha, subject };
  }).filter((b) => b.name !== "HEAD" && b.name !== "origin");
}

// ---------------- Báo nhóm Nhắn tin DNSO ----------------
// Mỗi lượt triển khai (job có deploy) gửi đúng HAI lần, cùng duAn + moiTruong + phienBan: "running" khi bắt đầu, kết quả
// cuối ("success"/"failure") khi rollout xong hoặc hỏng; máy chủ DNSO gộp thành một thẻ. Job chỉ build thì không báo.
// Báo tin là việc phụ: lỗi chỉ ghi cảnh báo vào log job, không bao giờ làm hỏng job; lần đầu hỏng thì không gửi lần cuối.
// Cấu hình: biến môi trường hoặc secrets.json trong WORK_DIR (DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID). Không in khoá.
// Cùng giao thức với deploy/scripts/bao-nhom.sh (chép từ kho DNSO, dùng cho GitHub Actions và thử tay `--ds-nhom`).
const DNSO = {
  url: (E.DNSO_URL ?? secrets.DNSO_URL ?? "https://dmst.dnso.vn").replace(/\/+$/, ""),
  key: E.DNSO_API_KEY ?? secrets.DNSO_API_KEY ?? "",
  thayMat: E.DNSO_THAY_MAT ?? secrets.DNSO_THAY_MAT ?? "",
  nhom: E.DNSO_NHOM_ID ?? secrets.DNSO_NHOM_ID ?? "",
  duAn: E.DNSO_DU_AN ?? "5-san-tmdt",
  moiTruong: "staging",
};
type BaoTin = { phienBan: string; tu: string | null; den: string | null; gui: boolean };
// Mã commit trong thẻ ảnh: stg-<sha7>-pc[-staging] (trang này), sha-<sha7>[-staging] (build-push.yml)
const sha7OfTag = (tag?: string | null) => tag?.match(/^(?:stg|sha)-([0-9a-f]{7})(?:-|$)/)?.[1] ?? null;
const resolveSha = async (rev: string | null) =>
  rev ? (await run(["git", "-C", REPO, "rev-parse", "--verify", "-q", `${rev}^{commit}`])).out.trim() || null : null;
const thoiLuong = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m ? `${m} phút ${s % 60} giây` : `${s} giây`;
};

async function dnsoPost(than: unknown, log: (l: string) => void): Promise<boolean> {
  let cuoi = "";
  for (let lan = 1; lan <= 3; lan++) {
    let ma = 0, text = "";
    try {
      const r = await fetch(`${DNSO.url}/api/v1/nhan-tin/nhom/${encodeURIComponent(DNSO.nhom)}/thong-bao`, {
        method: "POST",
        headers: { Authorization: `Bearer ${DNSO.key}`, "X-Thay-Mat": DNSO.thayMat, "Content-Type": "application/json" },
        body: JSON.stringify(than),
        signal: AbortSignal.timeout(20_000),
      });
      ma = r.status; text = await r.text();
    } catch (e: any) { text = String(e?.message ?? e); }
    if (ma === 200 || ma === 201) { log(`Báo nhóm DNSO: HTTP ${ma}, đã đăng.`); return true; }
    if (ma === 202) { log(`Báo nhóm DNSO: HTTP 202, ứng dụng ở mức "đề xuất", tin chờ người duyệt.`); return true; }
    let loi = text.slice(0, 300);
    try { loi = JSON.parse(text).loi ?? loi; } catch {}
    cuoi = `HTTP ${ma || "lỗi mạng"}: ${loi}`;
    if (ma >= 400 && ma < 500) break; // sai khoá/quyền/nhóm/thân: thử lại vô ích
    if (lan < 3) await Bun.sleep(lan * 3000);
  }
  log(`⚠ Báo nhóm DNSO không thành công (${cuoi}), bỏ qua.`);
  return false;
}

async function dnsoCommits(tu: string | null, den: string | null) {
  if (!den) return {};
  const range = tu ? [`${tu}..${den}`] : ["-1", den];
  const out = (await run(["git", "-C", REPO, "log", "--no-merges", "-n", "50", "--format=%h%x1f%an%x1f%s", ...range])).out;
  const commits = out.split("\n").filter(Boolean).map((l) => { const [ma, tacGia, tieuDe] = l.split("\x1f"); return { ma, tieuDe, tacGia }; });
  const tong = tu ? Number((await run(["git", "-C", REPO, "rev-list", "--count", "--no-merges", `${tu}..${den}`])).out.trim()) || commits.length : commits.length;
  return commits.length ? { commits, tongCommit: tong } : {};
}

function dnsoThan(j: Job, trangThai: string) {
  const b = j.dnso!;
  const repo = `https://github.com/${GH_ORG}/5-san-tmdt`;
  return {
    trangThai, duAn: DNSO.duAn, moiTruong: DNSO.moiTruong, phienBan: b.phienBan, tacGia: j.user,
    lienKet: b.tu && b.den && b.tu !== b.den ? `${repo}/compare/${b.tu.slice(0, 12)}...${b.den.slice(0, 12)}` : b.den ? `${repo}/commit/${b.den}` : `https://${PUBLIC_HOST}/`,
  };
}

// Gọi lúc bắt đầu lượt triển khai. sha: commit được triển khai (null nếu thẻ không mang mã commit); tag: dự phòng làm phienBan;
// truocTag: thẻ đang chạy trên staging của service chính trước lượt này (để lấy danh sách commit mới).
async function baoBatDau(j: Job, sha: string | null, tag: string, truocTag: string | null, log: (l: string) => void) {
  try {
    if (!j.deploy) return;
    if (!DNSO.key || !DNSO.thayMat || !DNSO.nhom) { log("Báo nhóm DNSO: chưa cấu hình DNSO_API_KEY/DNSO_THAY_MAT/DNSO_NHOM_ID, bỏ qua."); return; }
    const tu = await resolveSha(sha7OfTag(truocTag));
    j.dnso = { phienBan: sha ? sha.slice(0, 7) : tag, tu, den: sha, gui: false };
    j.dnso.gui = await dnsoPost({ ...dnsoThan(j, "running"), ...(await dnsoCommits(tu, sha)) }, log);
  } catch (e: any) { log(`⚠ Báo nhóm DNSO lỗi: ${e?.message ?? e}`); }
}
async function baoKetThuc(j: Job, log: (l: string) => void) {
  try {
    const b = j.dnso;
    if (!b?.gui) return;
    const ok = j.status === "ok";
    await dnsoPost({
      ...dnsoThan(j, ok ? "success" : "failure"),
      thoiLuong: thoiLuong(Date.parse(j.ended ?? new Date().toISOString()) - Date.parse(j.started!)),
      ...(ok ? {} : { noiDung: (j.error ?? "Thất bại").slice(0, 600) }),
      ...(await dnsoCommits(b.tu, b.den)),
    }, log);
  } catch (e: any) { log(`⚠ Báo nhóm DNSO lỗi: ${e?.message ?? e}`); }
}

// ---------------- Hàng đợi build ----------------
type Job = {
  id: string; kind: "build" | "deploy"; user: string; ref: string; sha?: string; subject?: string;
  services: string[]; deploy: boolean; status: "queued" | "running" | "ok" | "failed";
  created: string; started?: string; ended?: string; tags: Record<string, string>; commit?: string | null; error?: string;
  dnso?: BaoTin;
  log: string[];
};
const jobs: Job[] = [];
const JOB_KEEP = 30;
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
  jobs.splice(JOB_KEEP);
  queue = queue.then(async () => {
    const log = (l: string) => jobLog(j, l);
    j.status = "running"; j.started = new Date().toISOString();
    try { await work(j, log); j.status = "ok"; log("✔ Xong."); }
    catch (e: any) { j.status = "failed"; j.error = String(e?.message ?? e); log("✘ " + j.error); }
    j.ended = new Date().toISOString();
    await baoKetThuc(j, log); // kết quả cuối vào nhóm DNSO (chỉ khi đã báo "running")
    console.log(`${j.ended} job ${j.id} ${j.kind} ${j.status} (${j.user})`);
    if (restartPending && !busyJobs()) exitForUpdate(); // hàng đợi rỗng: chạy lại bằng mã mới
  });
}
// Xóa log job cũ trên đĩa
try { const fs = readdirSync(join(WORK, "jobs")).sort(); for (const f of fs.slice(0, Math.max(0, fs.length - 200))) rmSync(join(WORK, "jobs", f)); } catch {}

async function buildJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  log(`Lấy mã mới từ GitHub…`);
  await fetchRepo(true);
  const ref = /^[0-9a-f]{7,40}$/.test(j.ref) ? j.ref : `origin/${j.ref}`;
  const sha = (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  j.sha = sha;
  j.subject = (await git(["log", "-1", "--format=%s", sha])).trim();
  log(`Commit ${sha.slice(0, 7)}: ${j.subject}`);
  const svcs = SERVICES.filter((s) => j.services.includes(s.key));
  // BẮT ĐẦU lượt triển khai (build + đổi thẻ + rollout): báo "running"; thẻ đang chạy của service đầu tiên là mốc commit cũ
  await baoBatDau(j, sha, sha.slice(0, 7), (await gitTags().catch(() => ({} as Record<string, string | null>)))[svcs[0].key] ?? null, log);
  await git(["checkout", "-q", "--force", "--detach", sha], { cwd: SRC });
  await git(["clean", "-q", "-ffdx"], { cwd: SRC });
  const root = join(SRC, "ecommerce-monorepo");
  for (const s of svcs) {
    const tag = tagFor(s, sha);
    const ref = `${s.image}:${tag}`;
    log(``);
    log(`══ ${s.label}: ${ref}`);
    if (await tagExists(s.image, tag)) { log(`Ảnh này đã có trên GHCR (cùng commit), bỏ qua build.`); j.tags[s.key] = tag; continue; }
    const b = s.build;
    const cmd = ["docker", "build", "--progress=plain", "-f", join(root, b.file), "-t", ref];
    if (b.target) cmd.push("--target", b.target);
    for (const [k, v] of Object.entries(b.args ?? {})) cmd.push("--build-arg", `${k}=${v}`);
    cmd.push("--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dmst.stg-deploy.by=${j.user}`, join(root, b.context));
    const t0 = Date.now();
    await must(cmd, { onLine: log, env: { DOCKER_BUILDKIT: "1" } });
    log(`Build xong sau ${Math.round((Date.now() - t0) / 1000)} giây. Đẩy lên GHCR…`);
    await must(["docker", "push", ref], { onLine: (l) => { if (!/Waiting|Preparing|Layer already exists/.test(l)) log(l); } });
    j.tags[s.key] = tag;
  }
  // Dọn ảnh cục bộ: ảnh đã nằm trên GHCR; giữ build cache để lần sau nhanh.
  for (const s of svcs) await run(["docker", "image", "rm", `${s.image}:${tagFor(s, sha)}`]);
  await run(["docker", "image", "prune", "-f"]);
  if (!j.deploy) { log(`Chỉ build, không deploy. Thẻ: ${Object.values(j.tags).join(", ")}`); return; }
  log(``);
  j.commit = await commitTags(svcs.map((s) => ({ svc: s, tag: j.tags[s.key] })), j.user, `Build từ ${j.ref} @ ${sha.slice(0, 7)} (${j.subject})`, log);
  await afterCommit(svcs, log);
}

async function deployJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  const s = SERVICES.find((x) => x.key === j.services[0])!;
  const tag = j.tags[s.key];
  await fetchRepo(true);
  await baoBatDau(j, await resolveSha(sha7OfTag(tag)), tag, (await gitTags().catch(() => ({} as Record<string, string | null>)))[s.key] ?? null, log);
  log(`Kiểm tra ${s.image}:${tag} trên GHCR…`);
  if (!(await tagExists(s.image, tag))) throw new Error(`Không có ${s.image}:${tag} trên GHCR`);
  j.commit = await commitTags([{ svc: s, tag }], j.user, `Deploy thẻ có sẵn.`, log);
  await afterCommit([s], log);
}

// Gọi Flux áp ngay rồi theo dõi rollout (tối đa 6 phút).
async function afterCommit(svcs: Service[], log: (l: string) => void) {
  log(`Yêu cầu Flux đồng bộ…`);
  await fluxReconcile();
  const deploysOf = (s: Service) => [s.deploy, ...(s.also ?? [])].map((d) => `${s.ns}/${d}`);
  const deploys = [...new Set(svcs.flatMap(deploysOf))];
  const want = Object.fromEntries(svcs.map((s) => [s.key, null as string | null]));
  const deadline = Date.now() + 6 * 60_000;
  let lastMsg = "";
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const kt = await gitTags().catch(() => null);
    let done = true; const parts: string[] = [];
    for (const key of deploys) {
      const [ns, name] = key.split("/");
      const d: any = await k8s(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`).catch(() => null);
      if (!d) { done = false; continue; }
      const spec = d.spec.template.spec;
      const imgs = [...(spec.initContainers ?? []), ...spec.containers].map((c: any) => c.image as string);
      const tagsOk = svcs.filter((s) => deploysOf(s).includes(key)).every((s) => kt && imgs.includes(`${s.image}:${kt[s.key]}`));
      const st = d.status ?? {};
      const ok = tagsOk && st.observedGeneration >= d.metadata.generation && st.updatedReplicas === d.spec.replicas && st.availableReplicas === d.spec.replicas && (st.replicas ?? 0) === d.spec.replicas;
      parts.push(`${name}: ${tagsOk ? "" : "chờ Flux áp thẻ mới, "}${st.updatedReplicas ?? 0}/${d.spec.replicas} cập nhật, ${st.availableReplicas ?? 0} sẵn sàng`);
      if (!ok) done = false;
    }
    const msg = parts.join(" · ");
    if (msg !== lastMsg) { log(msg); lastMsg = msg; }
    if (done) { log(`Rollout xong.`); return; }
  }
  throw new Error("Hết 6 phút mà rollout chưa xong: xem log pod / trạng thái Flux trên trang");
}

// ---------------- Trạng thái cụm ----------------
const tagOfImage = (img: string) => {
  const at = img.lastIndexOf("@");
  const base = at > 0 ? img.slice(0, at) : img;
  const i = base.lastIndexOf(":");
  return i > base.lastIndexOf("/") ? base.slice(i + 1) : "latest";
};
function podView(p: any) {
  const cs = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  const main = p.status?.containerStatuses ?? [];
  let reason = p.status?.phase ?? "?";
  for (const c of cs) {
    const w = c.state?.waiting?.reason ?? (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason : null);
    if (w) { reason = w; break; }
  }
  if (p.metadata.deletionTimestamp) reason = "Terminating";
  return {
    name: p.metadata.name,
    ready: `${main.filter((c: any) => c.ready).length}/${main.length || (p.spec?.containers?.length ?? 0)}`,
    status: reason,
    restarts: main.reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0),
    started: p.status?.startTime ?? p.metadata.creationTimestamp,
    images: Object.fromEntries([...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])].map((c: any) => [c.name, tagOfImage(c.image)])),
    labels: p.metadata.labels ?? {},
  };
}
async function state() {
  const [git, ks, src, ...nsPods] = await Promise.all([
    (async () => { await ensureRepo(); await fetchRepo(); return gitTags(); })().catch((e) => ({ error: String(e.message ?? e) })),
    k8s(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/kustomizations/${FLUX_KS}`).catch(() => null),
    k8s(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/gitrepositories/${FLUX_SOURCE}`).catch(() => null),
    ...VIEW_NS.map((ns) => k8s(`/api/v1/namespaces/${ns}/pods`).then((l: any) => l.items.map(podView))),
  ].map((p) => (p as Promise<any>).catch(() => null)));
  const clusterOk = nsPods.some((x) => x !== null);
  const pods: Record<string, any[]> = Object.fromEntries(VIEW_NS.map((ns, i) => [ns, nsPods[i] ?? []]));
  const deploys = new Map<string, any>();
  for (const s of SERVICES) {
    const k = `${s.ns}/${s.deploy}`;
    if (!deploys.has(k)) deploys.set(k, await k8s(`/apis/apps/v1/namespaces/${s.ns}/deployments/${s.deploy}`).catch(() => null));
  }
  const gitErr = git && "error" in git ? (git.error as string) : null;
  const services = SERVICES.map((s) => {
    const d = deploys.get(`${s.ns}/${s.deploy}`);
    const spec = d?.spec?.template?.spec;
    const c = (s.init ? spec?.initContainers : spec?.containers)?.find((x: any) => x.name === (s.init ?? s.container));
    const sel = d?.spec?.selector?.matchLabels ?? {};
    const mine = pods[s.ns].filter((p) => Object.entries(sel).every(([k, v]) => p.labels[k] === v));
    const st = d?.status ?? {};
    return {
      key: s.key, label: s.label, note: s.note, image: s.image, ns: s.ns, deploy: s.deploy,
      container: s.init ?? s.container, isInit: !!s.init,
      specTag: c ? tagOfImage(c.image) : null,
      gitTag: gitErr ? null : (git as Record<string, string | null>)[s.key],
      replicas: d?.spec?.replicas ?? 0, ready: st.readyReplicas ?? 0, updated: st.updatedReplicas ?? 0,
      rolloutDone: d ? (st.observedGeneration ?? 0) >= d.metadata.generation && st.updatedReplicas === d.spec.replicas && (st.replicas ?? 0) === d.spec.replicas && st.availableReplicas === d.spec.replicas : false,
      restartedAt: d?.spec?.template?.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"] ?? null,
      pods: mine.map(({ labels, ...p }) => ({ ...p, runningTag: p.images[s.init ?? s.container!] ?? null })),
    };
  });
  const cond = (o: any) => (o?.status?.conditions ?? []).find((x: any) => x.type === "Ready");
  return {
    now: new Date().toISOString(),
    clusterError: clusterOk ? null : "Không gọi được API cụm staging (kubectl proxy / Tailscale trên PC build?)",
    gitError: gitErr,
    repo: { branch: BRANCH, path: KPATH },
    flux: {
      ready: cond(ks)?.status ?? "Unknown", message: cond(ks)?.message ?? "",
      lastApplied: ks?.status?.lastAppliedRevision ?? "", source: src?.status?.artifact?.revision ?? "",
      sourceReady: cond(src)?.status ?? "Unknown", sourceMessage: cond(src)?.message ?? "",
    },
    services,
    jobs: jobs.map(({ log, ...j }) => ({ ...j, lines: log.length })),
  };
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
const TAG_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REF_OK = /^(?!.*\.\.)(?!-)[A-Za-z0-9._\/-]{1,100}$/;
const NAME_OK = /^[\p{L}\p{N} ._-]{2,40}$/u;
const sameOrigin = (req: Request) => {
  try { return new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { return false; }
};
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");

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
    if (p === "/") return html(pageHtml(who ? { user: who } : {}));
    if (!p.startsWith("/api/")) return new Response("Không tìm thấy", { status: 404 });
    if (!who) return json({ error: "Chưa đăng nhập" }, 401);
    if (req.method === "POST" && !sameOrigin(req)) return json({ error: "Origin không hợp lệ" }, 403);

    try {
      if (req.method === "GET") {
        const svc = SERVICES.find((s) => s.key === url.searchParams.get("svc"));
        if (p === "/api/state") return json({ user: who, ...(await state()) });
        if (p === "/api/history") return json(await history());
        if (p === "/api/branches") return json(await branches());
        if (p === "/api/job") {
          const j = jobs.find((x) => x.id === url.searchParams.get("id"));
          if (!j) return json({ error: "Không có job" }, 404);
          const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
          const { log, ...rest } = j;
          return json({ ...rest, from, lines: log.slice(from), total: log.length });
        }
        if (p === "/api/tags") { if (!svc) return json({ error: "Service không hợp lệ" }, 400); return json(await listTags(svc.image)); }
        if (p === "/api/logs") {
          if (!svc) return json({ error: "Service không hợp lệ" }, 400);
          const d: any = await k8s(`/apis/apps/v1/namespaces/${svc.ns}/deployments/${svc.deploy}`);
          const sel = Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",");
          const list: any = await k8s(`/api/v1/namespaces/${svc.ns}/pods?labelSelector=${encodeURIComponent(sel)}`);
          const target = list.items.find((x: any) => x.metadata.name === url.searchParams.get("pod")) ?? list.items[0];
          if (!target) return json({ error: "Không có pod" }, 404);
          const c = svc.init ?? svc.container!;
          const prev = url.searchParams.get("previous") === "1" ? "&previous=true" : "";
          const text = await k8s(`/api/v1/namespaces/${svc.ns}/pods/${target.metadata.name}/log?container=${c}&tailLines=400&timestamps=true${prev}`).catch((e) => String(e.message));
          return json({ pod: target.metadata.name, container: c, text });
        }
        return json({ error: "Không tìm thấy" }, 404);
      }
      if (req.method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
      const body: any = await req.json().catch(() => ({}));
      const busyNow = busyJobs();
      // Build/Deploy luôn chạy bằng mã trang mới nhất trên nhánh staging (biến build, danh sách service...)
      if ((p === "/api/build" || p === "/api/deploy") && (await codeStale())) return json({ error: STALE_MSG }, 503);

      if (p === "/api/build") {
        const ref = String(body.ref ?? BRANCH).trim();
        if (!REF_OK.test(ref)) return json({ error: "Nhánh/commit không hợp lệ" }, 400);
        const keys = (Array.isArray(body.services) ? body.services : []).filter((k: string) => SERVICES.some((s) => s.key === k));
        if (!keys.length) return json({ error: "Chọn ít nhất 1 service" }, 400);
        if (busyNow >= 5) return json({ error: "Hàng đợi đã có 5 việc, đợi bớt" }, 429);
        const j: Job = { id: newId(), kind: "build", user: who, ref, services: keys, deploy: body.deploy !== false, status: "queued", created: new Date().toISOString(), tags: {}, log: [] };
        enqueue(j, buildJob);
        console.log(`${j.created} [${who}] build ${ref} ${keys.join(",")}${j.deploy ? "" : " (chỉ build)"}`);
        return json({ ok: true, id: j.id });
      }
      const s = SERVICES.find((x) => x.key === body.svc);
      if (p === "/api/deploy") {
        if (!s) return json({ error: "Service không hợp lệ" }, 400);
        const tag = String(body.tag ?? "").trim();
        if (!TAG_OK.test(tag)) return json({ error: "Thẻ ảnh không hợp lệ" }, 400);
        const j: Job = { id: newId(), kind: "deploy", user: who, ref: tag, services: [s.key], deploy: true, status: "queued", created: new Date().toISOString(), tags: { [s.key]: tag }, log: [] };
        enqueue(j, deployJob);
        console.log(`${j.created} [${who}] deploy ${s.key}:${tag}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/restart") {
        if (!s) return json({ error: "Service không hợp lệ" }, 400);
        const at = new Date().toISOString();
        for (const d of [s.deploy, ...(s.also ?? [])]) {
          await k8s(`/apis/apps/v1/namespaces/${s.ns}/deployments/${d}`, {
            method: "PATCH", contentType: "application/strategic-merge-patch+json",
            body: JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } } }),
          }).catch((e) => { if (d === s.deploy) throw e; }); // Deployment phụ chưa có (chưa áp manifest) thì bỏ qua
          console.log(`${at} [${who}] restart ${s.ns}/${d}`);
        }
        return json({ ok: true });
      }
      if (p === "/api/reconcile") { await fluxReconcile(); return json({ ok: true }); }
      return json({ error: "Không tìm thấy" }, 404);
    } catch (e: any) {
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});
console.log(`stg-deploy chạy http://127.0.0.1:${server.port} (WORK_DIR ${WORK})`);
ensureRepo((l) => console.log(l)).catch((e) => console.error("Chuẩn bị repo lỗi:", e.message));
// Kiểm tra mã trang mới mỗi 2 phút, khởi động lại lúc rảnh
setInterval(() => { codeStale().catch((e) => console.error("Kiểm tra mã trang lỗi:", e.message)); }, 120_000);
