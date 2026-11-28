// Trang CI/CD staging của thi-vien-chuc (KHCN-Thanh-Hoa/thi-vien-chuc): https://stg-deploy-thi-vien-chuc.dmst.vn
// Staging: https://stg-thi-vien-chuc.dmst.vn, namespace stg-thi-vien-chuc trên cụm k3s staging chung.
//
// Chạy trên PC quản trị (Windows, Bun, Docker Desktop đã `docker login ghcr.io`, kubectl + kubeconfig cụm staging qua
// Tailscale, cloudflared), KHÔNG chạy trong cụm. Ảnh dựng trên PC rồi đẩy GHCR, cụm chỉ kéo ảnh.
//
//   CI  Mỗi push vào nhánh trong AUTO_CHECK_BRANCHES (mặc định main) tự chạy Kiểm tra (kiem-tra.ts) trong container dùng
//       một lần: schema.sql + seed.sql trên Postgres 16 sạch, build backend, frontend (+ candidate-frontend, chỉ cảnh báo).
//       Dev cũng bấm "Chạy kiểm tra" cho nhánh/commit bất kỳ.
//   CD  Commit đầu nhánh DEPLOY_BRANCH (main) qua kiểm tra thì tự Build & deploy (tắt: AUTO_DEPLOY=0):
//         1. dựng ảnh app (Dockerfile.uat của commit, ngữ cảnh `git archive <sha>`, không lấy tệp chưa commit/bí mật PC)
//            và ảnh db (Dockerfile.db của commit nếu có, không thì ci/Dockerfile.db), thẻ stg-<7 ký tự sha>, push GHCR;
//         2. CSDL: database/schema.sql đổi so với CSDL đang chạy → làm lại CSDL (xoá schema public, chạy schema.sql +
//            seed.sql; MẤT dữ liệu staging, chỉ khi người bấm chọn hoặc AUTO_RESET_DB=1 với lượt tự động). Chỉ seed.sql
//            đổi → nạp lại seed.sql (idempotent) trong một transaction. Băm hai tệp ghi ở annotation của StatefulSet db;
//         3. `kubectl set image` Deployment app → chờ rollout; không lành thì `rollout undo`; kiểm SITE/health.
//       "Đổi bản": chạy lại một thẻ đã dựng (quay lui). Khác schema với CSDL đang chạy thì phải chọn làm lại CSDL.
//   Báo nhóm Nhắn tin DNSO một tin kết quả mỗi lượt triển khai (nếu secrets.json có DNSO_API_KEY/DNSO_THAY_MAT/DNSO_NHOM_ID).
//
// Manifest gốc (namespace, Deployment app, StatefulSet db, Ingress, quota) và cách tạo bí mật: deploy/k8s/ trong kho
// thi-vien-chuc (nhánh deploy/staging-k8s). Trang này chỉ đổi ảnh/annotation trên các đối tượng đã có.
//
// Không có gói phụ thuộc, chỉ API có sẵn của Bun. Cài đặt/khởi động: start.ps1. Mã chạy thẳng từ clone dmst-cicd ở
// WORK_DIR/cicd theo origin/main; khi thư mục tvc-stg trên origin/main đổi, trang tự thoát lúc rảnh để start.ps1 lấy mã
// mới và chạy lại. Sửa trang = commit + push main của dmst-cicd.
//
// Thư mục làm việc WORK_DIR (mặc định D:/DMST/tvc-stg-work, ngoài repo):
//   secrets.json   { DEPLOY_PASSWORD, SESSION_SECRET, TUNNEL_TOKEN, DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID }  (chỉ user Windows đọc)
//   cicd/          clone dmst-cicd theo origin/main (start.ps1 quản lý)
//   repo/          clone trần kho thi-vien-chuc (chỉ fetch + git archive)
//   jobs/, checks/ log từng lượt; builds.json thẻ đã dựng; lich-su-trien-khai.log
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pageHtml } from "./ui";
import { newCheck, runCheck, type CheckRun } from "./kiem-tra";

const asset = (f: string) => readFileSync(join(import.meta.dir, f));
const STATIC: Record<string, [Buffer, string]> = {
  // Giao diện dùng chung bộ CSS với stg-deploy (cùng repo dmst-cicd), thêm vài dòng riêng ở tvc.css.
  "/app.css": [Buffer.concat([readFileSync(join(import.meta.dir, "..", "stg-deploy", "app.css")), Buffer.from("\n"), asset("tvc.css")]), "text/css; charset=utf-8"],
  "/app.js": [asset("app.js"), "text/javascript; charset=utf-8"],
  "/logo.svg": [asset("logo.svg"), "image/svg+xml"],
};

const E = process.env;
const PORT = Number(E.PORT ?? 8102);
const WORK = E.WORK_DIR ?? "D:/DMST/tvc-stg-work";
const REPO_URL = E.REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/thi-vien-chuc.git";
const GH_REPO = "KHCN-Thanh-Hoa/thi-vien-chuc";
const DEPLOY_BRANCH = E.DEPLOY_BRANCH ?? "main";
const AUTO_DEPLOY = (E.AUTO_DEPLOY ?? "1") !== "0";
const AUTO_RESET_DB = (E.AUTO_RESET_DB ?? "1") !== "0"; // lượt tự động được làm lại CSDL khi schema.sql đổi
const AUTO_CHECK_BRANCHES = (E.AUTO_CHECK_BRANCHES ?? DEPLOY_BRANCH).split(",").map((s) => s.trim()).filter(Boolean);
const KUBECONFIG = E.KUBECONFIG_TVC ?? "C:/Users/Admin/.kube/tmdt-staging.yaml";
const NS = E.NAMESPACE ?? "stg-thi-vien-chuc";
const IMG_APP = E.IMG_APP ?? "ghcr.io/khcn-thanh-hoa/thi-vien-chuc-app";
const IMG_DB = E.IMG_DB ?? "ghcr.io/khcn-thanh-hoa/thi-vien-chuc-db";
const DB_USER = E.DB_USER ?? "recruit_uat", DB_NAME = E.DB_NAME ?? "recruit_exam_uat";
const SITE = E.SITE ?? "https://stg-thi-vien-chuc.dmst.vn";
const CLOUDFLARED = E.CLOUDFLARED ?? join(WORK, "bin", "cloudflared.exe");
const PUBLIC_HOST = E.PUBLIC_HOST ?? "stg-deploy-thi-vien-chuc.dmst.vn";
const SESSION_HOURS = 12, COOKIE = "tvcstg";
const ANN = "dmst-cicd"; // tiền tố annotation trên đối tượng k8s

mkdirSync(join(WORK, "jobs"), { recursive: true });
const SECRETS_FILE = join(WORK, "secrets.json");
const secrets: Record<string, string> = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
if (!secrets.DEPLOY_PASSWORD) secrets.DEPLOY_PASSWORD = randomBytes(12).toString("base64url");
if (!secrets.SESSION_SECRET) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
const DEPLOY_PASSWORD = E.DEPLOY_PASSWORD ?? secrets.DEPLOY_PASSWORD;
const SESSION_SECRET = secrets.SESSION_SECRET;

const SERVICES = [
  { key: "app", label: "App", note: "Nginx (SPA) + NestJS /api · Deployment app", restart: true },
  { key: "db", label: "PostgreSQL 16", note: "StatefulSet db, PVC data-db-0", restart: false },
];
const tagFor = (sha: string) => "stg-" + sha.slice(0, 7);

// ---------------- Tiến trình con ----------------
type RunOpts = { cwd?: string; env?: Record<string, string>; onLine?: (l: string) => void; quiet?: boolean; stdin?: ReadableStream<Uint8Array> | Blob | null };
async function run(cmd: string[], o: RunOpts = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...E, KUBECONFIG, ...o.env }, stdin: (o.stdin as any) ?? "ignore", stdout: "pipe", stderr: "pipe" });
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
        if (out.length < 400_000) out += line + "\n";
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
const kc = (args: string[], o: RunOpts = {}) => run(["kubectl", "-n", NS, ...args], o);
const kcMust = (args: string[], o: RunOpts = {}) => must(["kubectl", "-n", NS, ...args], o);

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
    // git archive áp core.autocrlf: Git for Windows mặc định true → entrypoint.sh/SQL ra CRLF. Ghim false trong kho.
    if (existsSync(join(REPO, "HEAD"))) { await git(["config", "core.autocrlf", "false"]); return; }
    log?.(`Clone ${REPO_URL} (lần đầu, không checkout)…`);
    await must(["git", "-c", "core.autocrlf=false", "clone", "--bare", REPO_URL, REPO], { onLine: log });
    await git(["config", "core.autocrlf", "false"]);
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
  const sha = await resolveSha(rev);
  if (!sha) return null;
  return { sha, subject: (await subjectOf(sha)) ?? "" };
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
// Băm git blob của một tệp ở commit (rỗng nếu không có): dùng so schema.sql / seed.sql với CSDL đang chạy.
const blobOf = async (sha: string, path: string) => (await run(["git", "-C", REPO, "rev-parse", "-q", "--verify", `${sha}:${path}`], { quiet: true })).out.trim();
const hasPath = async (sha: string, path: string) => (await run(["git", "-C", REPO, "cat-file", "-e", `${sha}:${path}`], { quiet: true })).code === 0;

// ---------------- Tự cập nhật mã của trang ----------------
const TOOL_BRANCH = E.TOOL_BRANCH ?? "main";
const toolGit = (args: string[]) => run(["git", "-C", import.meta.dir, ...args], { quiet: true })
  .then((r) => (r.code === 0 ? r : { code: r.code, out: "" }), () => ({ code: 1, out: "" }));
const TOOL_PATH = (await toolGit(["rev-parse", "--show-prefix"])).out.trim().replace(/\/$/, "");
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

// ---------------- Thẻ đã dựng, lịch sử triển khai ----------------
type Build = { tag: string; sha: string; subject: string; schema: string; seed: string; luc: string; by: string };
const BUILDS_FILE = join(WORK, "builds.json");
let builds: Build[] = [];
try { builds = JSON.parse(readFileSync(BUILDS_FILE, "utf8")); } catch {}
function saveBuild(b: Build) {
  builds = [b, ...builds.filter((x) => x.tag !== b.tag)].slice(0, 40);
  writeFileSync(BUILDS_FILE, JSON.stringify(builds, null, 1));
}
const HIST_FILE = join(WORK, "lich-su-trien-khai.log"); // mỗi dòng: ISO thẻ người csdl
function readHist() {
  try {
    return readFileSync(HIST_FILE, "utf8").trim().split("\n").filter(Boolean).reverse().slice(0, 30).map((l) => {
      const [luc, the, csdl, ...nguoi] = l.split("\t");
      const b = builds.find((x) => x.tag === the);
      return { luc, the, csdl, nguoi: nguoi.join(" "), subject: b?.subject ?? null, sha: b?.sha ?? null };
    });
  } catch { return []; }
}

// ---------------- Cụm staging ----------------
type Cum = {
  ok: boolean; error: string | null; tag: string | null; sha: string | null; subject: string | null; by: string | null; at: string | null;
  dbTag: string | null; schema: string | null; seed: string | null;
  services: { key: string; label: string; note: string; restart: boolean; pods: { name: string; phase: string; ready: boolean; restarts: number; status: string; image: string; node: string; age: string }[] }[];
  health: { ok: boolean; code: number; text: string } | null; luc: string;
};
const tagOfImage = (img?: string) => (img && img.includes(":") ? img.split(":").pop()! : null);
// Một lượt kubectl lấy toàn bộ trạng thái, đệm 8 giây (trình duyệt hỏi 5 giây/lần)
let cumCache: { at: number; p: Promise<Cum> } | null = null;
function cumStaging(force = false): Promise<Cum> {
  if (!force && cumCache && Date.now() - cumCache.at < 8000) return cumCache.p;
  const p = (async (): Promise<Cum> => {
    const [r, rp, health] = await Promise.all([
      kc(["get", "deploy/app", "sts/db", "-o", "json"], { quiet: true }),
      kc(["get", "pods", "-o", "json"], { quiet: true }),
      fetch(`${SITE}/health`, { signal: AbortSignal.timeout(8000) }).then(async (x) => ({ ok: x.ok, code: x.status, text: (await x.text()).slice(0, 200) }), (e) => ({ ok: false, code: 0, text: String(e?.message ?? e) })),
    ]);
    for (const x of [r, rp]) if (x.code !== 0) throw new Error(`kubectl lỗi (Tailscale/kubeconfig trên PC?): ${x.out.trim().split("\n").slice(-2).join(" ")}`);
    const items: any[] = [...(JSON.parse(r.out).items ?? []), ...(JSON.parse(rp.out).items ?? [])];
    const dep = items.find((x) => x.kind === "Deployment"), sts = items.find((x) => x.kind === "StatefulSet");
    const da = dep?.metadata?.annotations ?? {}, sa = sts?.metadata?.annotations ?? {};
    const appImg = dep?.spec?.template?.spec?.containers?.find((c: any) => c.name === "app")?.image;
    const dbImg = sts?.spec?.template?.spec?.containers?.[0]?.image;
    const tag = tagOfImage(appImg);
    const pods = items.filter((x) => x.kind === "Pod");
    const podInfo = (p: any) => {
      const cs = p.status?.containerStatuses ?? [];
      const waiting = cs.map((c: any) => c.state?.waiting?.reason).find(Boolean) ?? (p.status?.initContainerStatuses ?? []).map((c: any) => c.state?.waiting?.reason || (c.state?.running ? "Init" : "")).find(Boolean);
      const ready = cs.length > 0 && cs.every((c: any) => c.ready);
      const ageS = (Date.now() - Date.parse(p.metadata.creationTimestamp)) / 1000;
      return {
        name: p.metadata.name, phase: p.metadata.deletionTimestamp ? "Terminating" : p.status?.phase ?? "?", ready,
        restarts: cs.reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0),
        status: p.metadata.deletionTimestamp ? "Terminating" : waiting ?? (ready ? "Ready" : p.status?.phase ?? "?"),
        image: tagOfImage(cs[0]?.image ?? p.spec?.containers?.[0]?.image) ?? "", node: p.spec?.nodeName ?? "",
        age: ageS < 3600 ? `${Math.round(ageS / 60)} phút` : ageS < 86400 ? `${Math.round(ageS / 3600)} giờ` : `${Math.round(ageS / 86400)} ngày`,
      };
    };
    const sha = da[`${ANN}/sha`] ?? null;
    return {
      ok: true, error: null, tag, sha, subject: sha ? await subjectOf(sha) : (builds.find((b) => b.tag === tag)?.subject ?? null),
      by: da[`${ANN}/by`] ?? null, at: da[`${ANN}/at`] ?? null,
      dbTag: tagOfImage(dbImg), schema: sa[`${ANN}/schema`] ?? null, seed: sa[`${ANN}/seed`] ?? null,
      services: SERVICES.map((s) => ({ ...s, pods: pods.filter((p) => p.metadata.labels?.app === s.key).map(podInfo) })),
      health, luc: new Date().toISOString(),
    };
  })().catch((e) => ({ ok: false, error: String(e?.message ?? e), tag: null, sha: null, subject: null, by: null, at: null, dbTag: null, schema: null, seed: null, services: [], health: null, luc: new Date().toISOString() }));
  cumCache = { at: Date.now(), p };
  return p;
}

// ---------------- Báo nhóm Nhắn tin DNSO ----------------
const DNSO = {
  url: (E.DNSO_URL ?? secrets.DNSO_URL ?? "https://dmst.dnso.vn").replace(/\/+$/, ""),
  key: E.DNSO_API_KEY ?? secrets.DNSO_API_KEY ?? "",
  thayMat: E.DNSO_THAY_MAT ?? secrets.DNSO_THAY_MAT ?? "",
  nhom: E.DNSO_NHOM_ID ?? secrets.DNSO_NHOM_ID ?? "",
  duAn: "Thi viên chức",
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
async function dnsoCommits(tu: string | null, den: string | null) {
  if (!den) return {};
  const range = tu ? [`${tu}..${den}`] : ["-1", den];
  const out = (await run(["git", "-C", REPO, "log", "--no-merges", "-n", "200", "--format=%an%x1f%s", ...range], { quiet: true })).out;
  const da = new Set<string>();
  const commits = out.split("\n").filter(Boolean)
    .map((l) => { const [tacGia, tieuDe] = l.split("\x1f"); return tieuDe ? { ma: "", tieuDe: tieuDe.trim(), tacGia } : null; })
    .filter((c): c is { ma: string; tieuDe: string; tacGia: string } => !!c && !da.has(c.tieuDe) && !!da.add(c.tieuDe));
  return commits.length ? { commits: commits.slice(0, 15), tongCommit: commits.length } : {};
}
async function baoKetThuc(j: Job, log: (l: string) => void) {
  try {
    if (!j.deploy || !j.bao) return;
    if (!DNSO.key || !DNSO.thayMat || !DNSO.nhom) return;
    const ok = j.status === "ok";
    await dnsoPost({
      trangThai: ok ? "success" : "failure",
      tieuDe: ok ? `Staging ${DNSO.duAn} đã cập nhật bản mới${j.resetDb ? " (CSDL làm lại từ dữ liệu mẫu)" : ""}, mời mọi người vào kiểm tra`
        : `Cập nhật staging ${DNSO.duAn} thất bại: vẫn chạy bản cũ, đội kỹ thuật đang xử lý`,
      tacGia: j.user,
      thoiLuong: thoiLuong(Date.parse(j.ended ?? new Date().toISOString()) - Date.parse(j.started!)),
      khoaGop: `${DNSO.duAn}|${DNSO.moiTruong}|${j.bao.den ?? j.tag}|${j.id}`,
      lienKet: SITE + "/",
      ...(ok ? {} : { noiDung: `Chi tiết cho đội kỹ thuật (phiên bản ${j.tag}): ${(j.error ?? "").slice(0, 400)}` }),
      ...(await dnsoCommits(j.bao.tu, j.bao.den)),
    }, log);
  } catch (e: any) { log(`⚠ Báo nhóm DNSO lỗi: ${e?.message ?? e}`); }
}

// ---------------- Hàng đợi build/deploy ----------------
type Job = {
  id: string; kind: "build" | "deploy"; user: string; ref: string; sha?: string; subject?: string; tag?: string;
  deploy: boolean; resetDb: boolean; bypass?: boolean; auto?: boolean;
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
    cumCache = null;
    await baoKetThuc(j, log);
    console.log(`${j.ended} job ${j.id} ${j.kind} ${j.status} (${j.user})`);
    if (restartPending && !busyJobs()) exitForUpdate();
  });
}
try { const fs = readdirSync(join(WORK, "jobs")).sort(); for (const f of fs.slice(0, Math.max(0, fs.length - 200))) rmSync(join(WORK, "jobs", f)); } catch {}

const quietBuild = (log: (l: string) => void) => (l: string) => { if (!/^#\d+ (sha256|extracting|transferring)|^#\d+ \d+\.\d+ (Downloading|Extracting)/.test(l)) log(l); };
// Ảnh đã có trên GHCR thì không dựng lại (Build lại cùng commit, hoặc commit đã build ở lượt "chỉ build")
const onGhcr = async (ref: string) => (await run(["docker", "manifest", "inspect", ref], { quiet: true })).code === 0;

async function buildImages(sha: string, user: string, log: (l: string) => void) {
  const tag = tagFor(sha);
  const app = `${IMG_APP}:${tag}`, db = `${IMG_DB}:${tag}`;
  const label = ["--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dmst.cicd.by=${user}`];
  if (await onGhcr(app)) log(`GHCR đã có ${app}, bỏ qua dựng.`);
  else {
    log(""); log(`══ Dựng ${app} (Dockerfile.uat)`);
    const t0 = Date.now();
    for (let lan = 1; ; lan++) {
      try {
        await pipe(["git", "-C", REPO, "archive", "--format=tar", sha],
          ["docker", "build", "--progress=plain", "-f", "Dockerfile.uat", "--build-arg", "VITE_API_BASE_URL=/api", "--build-arg", "VITE_APP_ENV=uat", "-t", app, ...label, "-"], quietBuild(log));
        break;
      } catch (e: any) { if (lan === 2) throw e; log(`⚠ Dựng lỗi (${e.message}), thử lại một lần…`); }
    }
    log(`Dựng xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
    const leak = await run(["docker", "run", "--rm", "--entrypoint", "sh", app, "-c", "grep -l 'Program Files' /usr/share/nginx/html/assets/*.js || true"], { quiet: true });
    if (leak.out.trim()) throw new Error(`Bundle web chứa đường dẫn Windows (Program Files): ${leak.out.trim()}`);
    log(`══ Push ${app}`);
    await must(["docker", "push", "-q", app], { onLine: log });
  }
  if (await onGhcr(db)) log(`GHCR đã có ${db}, bỏ qua dựng.`);
  else {
    log(""); log(`══ Dựng ${db}`);
    const ctx = join(WORK, "ctx", tag);
    rmSync(ctx, { recursive: true, force: true });
    mkdirSync(ctx, { recursive: true });
    try {
      const own = await hasPath(sha, "Dockerfile.db");
      const paths = ["database", "docker/init-db.sh", ...(own ? ["Dockerfile.db"] : [])];
      await pipe(["git", "-C", REPO, "archive", "--format=tar", sha, ...paths], ["tar", "-x", "-C", ctx.replace(/\\/g, "/"), "-f", "-"], log);
      const df = own ? join(ctx, "Dockerfile.db") : join(import.meta.dir, "ci", "Dockerfile.db");
      log(own ? "Dùng Dockerfile.db của kho." : "Kho chưa có Dockerfile.db ở commit này, dùng tvc-stg/ci/Dockerfile.db.");
      await must(["docker", "build", "--progress=plain", "-f", df, "-t", db, ...label, ctx], { onLine: quietBuild(log) });
    } finally { rmSync(ctx, { recursive: true, force: true }); }
    log(`══ Push ${db}`);
    await must(["docker", "push", "-q", db], { onLine: log });
  }
  for (const r of [app, db]) await run(["docker", "image", "rm", r], { quiet: true });
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
  await buildImages(sha, j.user, log);
  saveBuild({ tag, sha, subject: j.subject ?? "", schema: await blobOf(sha, "database/schema.sql"), seed: await blobOf(sha, "database/seed.sql"), luc: new Date().toISOString(), by: j.user });
  if (!j.deploy) { log(`Chỉ build, không triển khai. Thẻ ${tag} đã có trên GHCR, dùng "Đổi bản" để chạy.`); return; }
  await trienKhai(j, builds.find((b) => b.tag === tag)!, log);
}

async function deployJob(j: Job, log: (l: string) => void) {
  await ensureRepo(log);
  await fetchRepo(true);
  const b = builds.find((x) => x.tag === j.tag);
  if (!b) throw new Error(`Không có thông tin thẻ ${j.tag}`);
  for (const r of [`${IMG_APP}:${b.tag}`, `${IMG_DB}:${b.tag}`]) if (!(await onGhcr(r))) throw new Error(`GHCR không còn ${r}`);
  await trienKhai(j, b, log);
}

const psql = (sql: string, extra: string[] = []) => ["exec", "-i", "db-0", "--", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", DB_USER, "-d", DB_NAME, ...extra, ...(sql ? ["-c", sql] : [])];
async function napTep(sha: string, path: string, extra: string[], log: (l: string) => void) {
  const body = Bun.spawn(["git", "-C", REPO, "show", `${sha}:${path}`], { stdout: "pipe", stderr: "pipe" });
  const r = await kc(psql("", [...extra, "-f", "-"]), { stdin: body.stdout, onLine: (l) => { if (!/^(INSERT|UPDATE|CREATE|ALTER|COMMENT|DO|SET)\b/.test(l)) log(l); } });
  if ((await body.exited) !== 0) throw new Error(`git show ${path} lỗi`);
  if (r.code !== 0) throw new Error(`Nạp ${path} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
}

async function trienKhai(j: Job, b: Build, log: (l: string) => void) {
  const truoc = await cumStaging(true);
  if (!truoc.ok) throw new Error(truoc.error ?? "Không đọc được trạng thái cụm");
  j.bao = { tu: truoc.sha, den: b.sha };
  const app = `${IMG_APP}:${b.tag}`, db = `${IMG_DB}:${b.tag}`;
  log(""); log(`══ Triển khai ${b.tag} lên ${NS} (đang chạy: ${truoc.tag ?? "?"})`);

  // --- CSDL ---
  const schemaDoi = truoc.schema !== b.schema;
  if (schemaDoi && !j.resetDb)
    throw new Error(`database/schema.sql của ${b.tag} khác CSDL đang chạy${truoc.schema ? "" : " (chưa ghi băm)"}. Dự án không có migration: phải chọn "Làm lại CSDL" (mất dữ liệu staging).`);
  const seedDoi = truoc.seed !== b.seed;
  // Ảnh db chỉ dùng khi volume trống (lần đầu); chỉ đổi khi schema/seed đổi để khỏi khởi động lại Postgres mỗi lượt.
  if (schemaDoi || seedDoi) {
    log(`══ StatefulSet db → ${db}`);
    await kcMust(["set", "image", "sts/db", `postgres=${db}`]);
    await kcMust(["rollout", "status", "sts/db", "--timeout=300s"], { onLine: log });
  }
  await kcMust(["wait", "--for=condition=Ready", "pod/db-0", "--timeout=180s"], { onLine: log });
  if (schemaDoi) {
    log(`══ LÀM LẠI CSDL ${DB_NAME}: xoá schema public, chạy schema.sql + seed.sql của ${b.sha.slice(0, 7)}`);
    await kcMust(["scale", "deploy/app", "--replicas=0"]);
    try {
      await kcMust(psql(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ${DB_USER};`));
      await napTep(b.sha, "database/schema.sql", [], log);
      await napTep(b.sha, "database/seed.sql", [], log);
      log("CSDL đã làm lại từ schema.sql + seed.sql.");
    } finally { await kcMust(["scale", "deploy/app", "--replicas=1"]); }
  } else if (seedDoi) {
    log(`══ seed.sql đổi → nạp lại seed.sql (idempotent, một transaction)`);
    await napTep(b.sha, "database/seed.sql", ["-1"], log);
  } else log("CSDL: schema.sql và seed.sql không đổi.");
  await kcMust(["annotate", "--overwrite", "sts/db", `${ANN}/schema=${b.schema}`, `${ANN}/seed=${b.seed}`]);

  // --- App ---
  log(""); log(`══ Deployment app → ${app}`);
  const now = new Date().toISOString();
  await kcMust(["set", "image", "deploy/app", `app=${app}`, `wait-db=${db}`]);
  await kcMust(["annotate", "--overwrite", "deploy/app", `${ANN}/sha=${b.sha}`, `${ANN}/by=${j.user.replace(/[^\p{L}\p{N} ._()-]/gu, "")}`, `${ANN}/at=${now}`]);
  const ro = await kc(["rollout", "status", "deploy/app", "--timeout=300s"], { onLine: log });
  if (ro.code !== 0) {
    log("⚠ Rollout không lành, quay lui Deployment app về bản trước…");
    await kc(["rollout", "undo", "deploy/app"], { onLine: log });
    if (truoc.sha) await kc(["annotate", "--overwrite", "deploy/app", `${ANN}/sha=${truoc.sha}`]);
    throw new Error(`Rollout ${b.tag} không lành sau 5 phút, đã rollout undo về ${truoc.tag}.${schemaDoi ? " CSDL đã làm lại theo schema mới, bản cũ có thể lỗi." : ""}`);
  }
  let h = { ok: false, code: 0, text: "" };
  for (let lan = 0; lan < 6 && !h.ok; lan++) {
    if (lan) await Bun.sleep(5000);
    h = await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(10_000) }).then(async (x) => ({ ok: x.ok, code: x.status, text: (await x.text()).slice(0, 200) }), (e) => ({ ok: false, code: 0, text: String(e?.message ?? e) }));
  }
  if (!h.ok) throw new Error(`Đã đổi bản nhưng ${SITE}/health không ok: ${h.code} ${h.text}`);
  log(`${SITE}/health: ok.`);
  appendFileSync(HIST_FILE, `${now}\t${b.tag}\t${schemaDoi ? "lam-lai" : seedDoi ? "nap-seed" : "giu"}\t${j.user}\n`);
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
  if ((await resolveSha(`origin/${DEPLOY_BRANCH}`)) !== c.sha) return;
  if (jobs.some((j) => j.sha === c.sha && j.status !== "failed")) return;
  const cum = await cumStaging(true);
  if (cum.tag === tagFor(c.sha)) return;
  const j: Job = { id: newId(), kind: "build", user: AUTO_USER, ref: DEPLOY_BRANCH, sha: c.sha, subject: c.subject, deploy: true, resetDb: AUTO_RESET_DB, auto: true, status: "queued", created: new Date().toISOString(), log: [] };
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
const TAG_OK = /^stg-[0-9a-f]{7}$/;
const REF_OK = /^(?!.*\.\.)(?!-)[A-Za-z0-9._\/-]{1,100}$/;
const NAME_OK = /^[\p{L}\p{N} ._-]{2,40}$/u;
const sameOrigin = (req: Request) => {
  try { return new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { return false; }
};
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");
const AUTO_USER = "Tự động (push)";
const cfg = { deployBranch: DEPLOY_BRANCH, autoDeploy: AUTO_DEPLOY, autoResetDb: AUTO_RESET_DB, autoCheck: AUTO_CHECK_BRANCHES, ns: NS, site: SITE, repo: GH_REPO };

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
          return json({ user: who, now: new Date().toISOString(), ...cfg, cum: await cumStaging(), hist: readHist(),
            jobs: jobs.map(({ log, ...j }) => ({ ...j, lines: log.length })), checks: checks.slice(0, 15).map(checkSummary) });
        }
        if (p === "/api/branches") return json(await branches());
        if (p === "/api/tags") {
          const cum = await cumStaging();
          return json(builds.map((b) => ({ tag: b.tag, sha: b.sha, subject: b.subject, created: b.luc, dangChay: b.tag === cum.tag, khacSchema: b.schema !== cum.schema })));
        }
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
          const cum = await cumStaging();
          return json({ ref, ...r, check: c ? checkSummary(c) : null, schemaDoi: cum.ok ? (await blobOf(r.sha, "database/schema.sql")) !== cum.schema : null });
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
          const target = s.key === "app" ? ["deploy/app", "-c", "app"] : ["pod/db-0"];
          const r = await kc(["logs", ...target, "--timestamps", "--tail=400"], { quiet: true });
          return json({ svc: target[0], text: r.out });
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
        const j: Job = { id: newId(), kind: "build", user: who, ref, sha: r.sha, subject: r.subject, deploy: body.deploy !== false, resetDb: body.resetDb === true, bypass, status: "queued", created: new Date().toISOString(), log: [] };
        enqueue(j, buildJob);
        console.log(`${j.created} [${who}] build ${ref} @ ${r.sha.slice(0, 7)}${j.deploy ? "" : " (chỉ build)"}${j.resetDb ? " (làm lại CSDL)" : ""}${bypass ? " (BỎ QUA CHẶN)" : ""}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/deploy") {
        const tag = String(body.tag ?? "").trim();
        if (!TAG_OK.test(tag)) return json({ error: "Thẻ ảnh không hợp lệ" }, 400);
        const b = builds.find((x) => x.tag === tag);
        if (!b) return json({ error: "Thẻ chưa được trang này dựng" }, 404);
        const j: Job = { id: newId(), kind: "deploy", user: who, ref: tag, tag, sha: b.sha, subject: b.subject, deploy: true, resetDb: body.resetDb === true, status: "queued", created: new Date().toISOString(), log: [] };
        enqueue(j, deployJob);
        console.log(`${j.created} [${who}] đổi bản ${tag}${j.resetDb ? " (làm lại CSDL)" : ""}`);
        return json({ ok: true, id: j.id });
      }
      if (p === "/api/restart") {
        const s = SERVICES.find((x) => x.key === body.svc && x.restart);
        if (!s) return json({ error: "Dịch vụ không khởi động lại được từ trang này" }, 400);
        if (busyJobs()) return json({ error: "Đang có việc build/triển khai, đợi xong rồi khởi động lại" }, 409);
        await kcMust(["rollout", "restart", "deploy/app"], { quiet: true });
        console.log(`${new Date().toISOString()} [${who}] restart ${s.key}`);
        cumCache = null;
        return json({ ok: true });
      }
      return json({ error: "Không tìm thấy" }, 404);
    } catch (e: any) {
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});
console.log(`tvc-stg chạy http://127.0.0.1:${server.port} (WORK_DIR ${WORK}, ns ${NS}, tự triển khai ${AUTO_DEPLOY ? DEPLOY_BRANCH : "TẮT"}${AUTO_RESET_DB ? ", được làm lại CSDL" : ""})`);
ensureRepo((l) => console.log(l)).catch((e) => console.error("Chuẩn bị repo lỗi:", e.message));
setInterval(() => { codeStale().catch((e) => console.error("Kiểm tra mã trang lỗi:", e.message)); }, 120_000);

// ---------------- Tự chạy Kiểm tra (CI) khi có push ----------------
// Mỗi AUTO_CHECK_SEC giây fetch kho; nhánh trong AUTO_CHECK_BRANCHES có commit đầu mới thì xếp một lượt kiểm tra.
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
        if (cur) { if (cur.status === "ok") await tuTrienKhai(cur); continue; }
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
