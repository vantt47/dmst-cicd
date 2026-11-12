// Trang deploy thủ công cụm staging: stg-deploy-sangiaodich.dmst.vn
// Dev đăng nhập (mật khẩu chung + tên), xem service đang chạy, chọn thẻ ảnh đã đẩy lên GHCR rồi bấm Deploy.
// Deploy = commit đổi newTag trong deploy/k8s/clusters/staging/kustomization.yaml trên nhánh staging (GitHub API),
// sau đó yêu cầu Flux đồng bộ ngay. Git vẫn là nguồn sự thật; lịch sử deploy là lịch sử commit của tệp đó.
// Không có gói phụ thuộc, chỉ API có sẵn của Bun.
//
// Biến môi trường (secret tmdt-deploy/stg-deploy):
//   DEPLOY_PASSWORD   mật khẩu chung cho dev
//   SESSION_SECRET    chuỗi ngẫu nhiên ký cookie phiên
//   GITHUB_TOKEN      fine-grained token, chỉ repo 5-san-tmdt, Contents: read/write
// Tệp gắn vào: /run/ghcr/.dockerconfigjson (bản chép secret ghcr-pull) để liệt kê/kiểm tra thẻ ảnh trên GHCR.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_CSS, APP_JS, pageHtml } from "./ui";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`Thiếu biến ${k}`);
  return v;
};
const PORT = Number(process.env.PORT ?? 8080);
const DEPLOY_PASSWORD = env("DEPLOY_PASSWORD");
const SESSION_SECRET = env("SESSION_SECRET");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GH_REPO = env("GITHUB_REPO", "KHCN-Thanh-Hoa/5-san-tmdt");
const GH_BRANCH = env("GITHUB_BRANCH", "staging");
const GH_PATH = env("KUSTOMIZATION_PATH", "ecommerce-monorepo/deploy/k8s/clusters/staging/kustomization.yaml");
const GHCR_CONFIG = env("GHCR_CONFIG", "/run/ghcr/.dockerconfigjson");
const GH_ORG = GH_REPO.split("/")[0];
const PUBLIC_HOST = env("PUBLIC_HOST", "stg-deploy-sangiaodich.dmst.vn");
const FLUX_NS = "flux-system";
const FLUX_SOURCE = env("FLUX_SOURCE", "tmdt");
const FLUX_KS = env("FLUX_KUSTOMIZATION", "staging");
const SESSION_HOURS = 12;
const COOKIE = "stgdeploy";

type Service = {
  key: string;
  label: string;
  note: string;
  image: string; // tên ảnh đầy đủ, trùng mục images trong kustomization.yaml
  ns: string;
  deploy: string;
  container?: string;
  init?: string;
};
const REG = "ghcr.io/khcn-thanh-hoa";
const SERVICES: Service[] = [
  { key: "backend", label: "Backend API", note: "api-sangiaodich.dmst.vn", image: `${REG}/tmdt-backend`, ns: "tmdt", deploy: "backend", container: "backend" },
  { key: "migrate", label: "Migrate CSDL", note: "initContainer của backend: prisma migrate deploy trước khi backend chạy", image: `${REG}/tmdt-migrate`, ns: "tmdt", deploy: "backend", init: "migrate" },
  { key: "web", label: "Web (người mua, người bán, quản trị)", note: "sangiaodich, nguoiban-, quantri-sangiaodich.dmst.vn", image: `${REG}/tmdt-web`, ns: "tmdt", deploy: "web", container: "web" },
  { key: "ome-agent", label: "OME agent (livestream)", note: "sidecar của ome-origin, ns tmdt-live", image: `${REG}/tmdt-ome-agent`, ns: "tmdt-live", deploy: "ome-origin", container: "agent" },
];
const VIEW_NS = ["tmdt", "tmdt-live", "tmdt-data", "tmdt-storage", "cloudflared"];

// ---------------- Kubernetes API (trong cụm, bằng ServiceAccount) ----------------
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
// Chạy thử ở máy: K8S_API=http://127.0.0.1:8001 (kubectl proxy), không cần token ServiceAccount.
const K8S = process.env.K8S_API ?? "https://kubernetes.default.svc";
let k8sCa = "";
try { k8sCa = readFileSync(`${SA}/ca.crt`, "utf8"); } catch {}

async function k8s(path: string, init: RequestInit & { contentType?: string } = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!process.env.K8S_API) headers.Authorization = `Bearer ${readFileSync(`${SA}/token`, "utf8").trim()}`; // token xoay vòng
  if (init.contentType) headers["Content-Type"] = init.contentType;
  const r = await fetch(K8S + path, { ...init, headers, tls: { ca: k8sCa } } as RequestInit);
  if (!r.ok) throw new Error(`k8s ${init.method ?? "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return path.includes("/log?") ? r.text() : r.json();
}
const mergePatch = (path: string, body: unknown) =>
  k8s(path, { method: "PATCH", body: JSON.stringify(body), contentType: "application/merge-patch+json" });

// ---------------- GHCR ----------------
function ghcrCreds(): { user: string; pass: string } | null {
  try {
    const cfg = JSON.parse(readFileSync(GHCR_CONFIG, "utf8"));
    const a = cfg.auths?.["ghcr.io"] ?? cfg.auths?.["https://ghcr.io"];
    if (!a) return null;
    if (a.username && a.password) return { user: a.username, pass: a.password };
    const [user, ...rest] = Buffer.from(a.auth, "base64").toString("utf8").split(":");
    return { user, pass: rest.join(":") };
  } catch { return null; }
}
const repoOf = (image: string) => image.replace(/^ghcr\.io\//, "");

async function registryToken(repo: string) {
  const c = ghcrCreds();
  const headers: Record<string, string> = {};
  if (c) headers.Authorization = "Basic " + Buffer.from(`${c.user}:${c.pass}`).toString("base64");
  const r = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`, { headers });
  if (!r.ok) throw new Error(`GHCR token ${r.status}`);
  return (await r.json()).token as string;
}

async function tagExists(image: string, tag: string) {
  const repo = repoOf(image);
  const token = await registryToken(repo);
  const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  return r.ok;
}

type TagInfo = { tag: string; created: string | null };
async function listTags(image: string): Promise<TagInfo[]> {
  const pkg = repoOf(image).split("/").pop()!;
  const c = ghcrCreds();
  // API Packages cho ngày tạo (cần token classic read:packages); không được thì dùng danh sách thẻ của registry.
  if (c) {
    try {
      const r = await fetch(`https://api.github.com/orgs/${GH_ORG}/packages/container/${pkg}/versions?per_page=40`, {
        headers: { Authorization: `Bearer ${c.pass}`, Accept: "application/vnd.github+json" },
      });
      if (r.ok) {
        const versions = (await r.json()) as any[];
        const out: TagInfo[] = [];
        for (const v of versions) for (const t of v.metadata?.container?.tags ?? []) out.push({ tag: t, created: v.created_at });
        out.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
        return out;
      }
    } catch {}
  }
  const repo = repoOf(image);
  const token = await registryToken(repo);
  const r = await fetch(`https://ghcr.io/v2/${repo}/tags/list?n=200`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GHCR tags ${r.status}`);
  const tags = ((await r.json()).tags ?? []) as string[];
  return tags.reverse().map((tag) => ({ tag, created: null }));
}

// ---------------- GitHub (kustomization.yaml trên nhánh staging) ----------------
async function gh(path: string, init: RequestInit = {}) {
  if (!GITHUB_TOKEN) throw new Error("Chưa cấu hình GITHUB_TOKEN");
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: body as any };
}

async function readKustomization() {
  const r = await gh(`/repos/${GH_REPO}/contents/${GH_PATH}?ref=${encodeURIComponent(GH_BRANCH)}`);
  if (!r.ok) throw new Error(`GitHub đọc kustomization: ${r.status} ${r.body?.message ?? ""}`);
  return { text: Buffer.from(r.body.content, "base64").toString("utf8"), sha: r.body.sha as string };
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const tagRe = (image: string) => new RegExp(`(-\\s+name:\\s*${escRe(image)}\\s*\\r?\\n\\s*newTag:\\s*)(\\S+)`);
function gitTagOf(text: string, image: string) {
  return text.match(tagRe(image))?.[2] ?? null;
}

let gitCache: { at: number; text: string } | null = null;
async function gitTags(): Promise<Record<string, string | null> | null> {
  if (!GITHUB_TOKEN) return null;
  if (!gitCache || Date.now() - gitCache.at > 15_000) {
    const { text } = await readKustomization();
    gitCache = { at: Date.now(), text };
  }
  return Object.fromEntries(SERVICES.map((s) => [s.key, gitTagOf(gitCache!.text, s.image)]));
}

let deployLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = deployLock.then(fn, fn);
  deployLock = p.catch(() => {});
  return p;
}

async function commitTag(svc: Service, tag: string, who: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await readKustomization();
    const re = tagRe(svc.image);
    const old = text.match(re)?.[2];
    if (!old) throw new Error(`Không thấy mục images cho ${svc.image} trong kustomization.yaml`);
    if (old === tag) return { unchanged: true, old, commit: null as string | null };
    const next = text.replace(re, `$1${tag}`);
    const message =
      `Staging (stg-deploy): ${repoOf(svc.image).split("/").pop()} ${old} → ${tag}\n\n` +
      `Deploy thủ công bởi ${who} qua https://${PUBLIC_HOST}`;
    const r = await gh(`/repos/${GH_REPO}/contents/${GH_PATH}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: Buffer.from(next, "utf8").toString("base64"), sha, branch: GH_BRANCH }),
    });
    if (r.ok) {
      gitCache = null;
      return { unchanged: false, old, commit: r.body.commit?.html_url as string };
    }
    if (r.status !== 409) throw new Error(`GitHub commit: ${r.status} ${r.body?.message ?? ""}`);
  }
  throw new Error("GitHub commit: xung đột liên tục, thử lại sau");
}

async function fluxReconcile() {
  const at = new Date().toISOString();
  const ann = { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": at } } };
  await mergePatch(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/gitrepositories/${FLUX_SOURCE}`, ann);
  await mergePatch(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/kustomizations/${FLUX_KS}`, ann);
  return at;
}

async function history() {
  const r = await gh(`/repos/${GH_REPO}/commits?sha=${encodeURIComponent(GH_BRANCH)}&path=${encodeURIComponent(GH_PATH)}&per_page=15`);
  if (!r.ok) throw new Error(`GitHub lịch sử: ${r.status}`);
  return (r.body as any[]).map((c) => ({
    sha: c.sha.slice(0, 7),
    url: c.html_url,
    message: c.commit.message as string,
    date: c.commit.author?.date ?? c.commit.committer?.date,
  }));
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
    node: p.spec?.nodeName ?? "",
    // thẻ theo spec của pod (status.image có thể chỉ là digest khi ảnh ghim @sha256)
    images: Object.fromEntries([...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])].map((c: any) => [c.name, tagOfImage(c.image)])),
    labels: p.metadata.labels ?? {},
  };
}

async function state() {
  const [git, ks, src, ...nsPods] = await Promise.all([
    gitTags().catch((e) => ({ error: String(e.message ?? e) })),
    k8s(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/kustomizations/${FLUX_KS}`).catch(() => null),
    k8s(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${FLUX_NS}/gitrepositories/${FLUX_SOURCE}`).catch(() => null),
    ...VIEW_NS.map((ns) => k8s(`/api/v1/namespaces/${ns}/pods`).then((l: any) => l.items.map(podView)).catch(() => [])),
  ]);
  const pods: Record<string, ReturnType<typeof podView>[]> = Object.fromEntries(VIEW_NS.map((ns, i) => [ns, nsPods[i]]));
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
    const mine = (pods[s.ns] ?? []).filter((p) => Object.entries(sel).every(([k, v]) => p.labels[k] === v));
    const st = d?.status ?? {};
    const progressing = (st.conditions ?? []).find((x: any) => x.type === "Progressing");
    return {
      key: s.key, label: s.label, note: s.note, image: s.image, ns: s.ns, deploy: s.deploy,
      container: s.init ?? s.container, isInit: !!s.init,
      specTag: c ? tagOfImage(c.image) : null,
      gitTag: git && !gitErr ? (git as Record<string, string | null>)[s.key] : null,
      replicas: d?.spec?.replicas ?? 0,
      ready: st.readyReplicas ?? 0,
      updated: st.updatedReplicas ?? 0,
      available: st.availableReplicas ?? 0,
      rolloutDone: d ? (st.observedGeneration ?? 0) >= d.metadata.generation && (st.updatedReplicas ?? 0) === d.spec.replicas && (st.replicas ?? 0) === d.spec.replicas && (st.availableReplicas ?? 0) === d.spec.replicas : false,
      progressMessage: progressing?.message ?? "",
      restartedAt: d?.spec?.template?.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"] ?? null,
      pods: mine.map(({ labels, ...p }) => ({ ...p, runningTag: p.images[s.init ?? s.container!] ?? null })),
    };
  });
  const cond = (o: any) => (o?.status?.conditions ?? []).find((x: any) => x.type === "Ready");
  return {
    now: new Date().toISOString(),
    gitError: gitErr ?? (GITHUB_TOKEN ? null : "Chưa cấu hình GITHUB_TOKEN: chỉ xem được, chưa deploy được"),
    repo: { name: GH_REPO, branch: GH_BRANCH, path: GH_PATH },
    flux: {
      ready: cond(ks)?.status ?? "Unknown",
      message: cond(ks)?.message ?? "",
      lastApplied: ks?.status?.lastAppliedRevision ?? "",
      source: src?.status?.artifact?.revision ?? "",
      sourceReady: cond(src)?.status ?? "Unknown",
      sourceMessage: cond(src)?.message ?? "",
      lastHandledReconcileAt: ks?.status?.lastHandledReconcileAt ?? "",
    },
    services,
    namespaces: VIEW_NS.map((ns) => ({ ns, pods: (pods[ns] ?? []).map(({ labels, images, ...p }) => ({ ...p, images })) })),
  };
}

// ---------------- Phiên đăng nhập ----------------
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string) => createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
function makeSession(name: string) {
  const data = b64u(JSON.stringify({ n: name, e: Date.now() + SESSION_HOURS * 3600_000 }));
  return `${data}.${sign(data)}`;
}
function readSession(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [data, sig] = m[1].split(".");
  if (!data || !sig) return null;
  const want = Buffer.from(sign(data));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return s.e > Date.now() && typeof s.n === "string" ? s.n : null;
  } catch { return null; }
}
const sha = (s: string) => createHash("sha256").update(s).digest();
const passwordOk = (p: string) => timingSafeEqual(sha(p), sha(DEPLOY_PASSWORD));

const fails = new Map<string, { n: number; until: number }>();
const clientIp = (req: Request, srv: any) =>
  req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? srv.requestIP(req)?.address ?? "?";

// ---------------- HTTP ----------------
const SEC_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...SEC_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...SEC_HEADERS, "Content-Type": "text/html; charset=utf-8", ...extra } });
const redirect = (to: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { ...SEC_HEADERS, Location: to, ...extra } });
const cookie = (v: string, maxAge: number) =>
  `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const TAG_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const NAME_OK = /^[\p{L}\p{N} ._-]{2,40}$/u;
const log = (who: string, what: string) => console.log(`${new Date().toISOString()} [${who}] ${what}`);

function sameOrigin(req: Request) {
  const o = req.headers.get("origin");
  if (!o) return false;
  try { return new URL(o).host === (req.headers.get("host") ?? ""); } catch { return false; }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/healthz") return new Response("ok");
    if (p === "/app.css") return new Response(APP_CSS, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" } });
    if (p === "/app.js") return new Response(APP_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });

    if (p === "/login" && req.method === "POST") {
      const ip = clientIp(req, srv);
      const f = fails.get(ip);
      if (f && f.n >= 8 && f.until > Date.now()) return html(pageHtml({ error: "Sai quá nhiều lần, thử lại sau 15 phút." }), 429);
      const form = await req.formData();
      const name = String(form.get("name") ?? "").trim();
      const pass = String(form.get("password") ?? "");
      if (!NAME_OK.test(name)) return html(pageHtml({ error: "Tên 2–40 ký tự (chữ, số, khoảng trắng, . _ -).", name }), 400);
      if (!passwordOk(pass)) {
        const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 15 * 60_000 };
        cur.n++;
        fails.set(ip, cur);
        log(name, `đăng nhập SAI từ ${ip}`);
        return html(pageHtml({ error: "Sai mật khẩu.", name }), 401);
      }
      fails.delete(ip);
      log(name, `đăng nhập từ ${ip}`);
      return redirect("/", { "Set-Cookie": cookie(makeSession(name), SESSION_HOURS * 3600) });
    }
    if (p === "/logout" && req.method === "POST") return redirect("/", { "Set-Cookie": cookie("", 0) });

    const who = readSession(req);
    if (p === "/") return html(pageHtml(who ? { user: who } : {}));
    if (!p.startsWith("/api/")) return new Response("Không tìm thấy", { status: 404 });
    if (!who) return json({ error: "Chưa đăng nhập" }, 401);
    if (req.method === "POST" && !sameOrigin(req)) return json({ error: "Origin không hợp lệ" }, 403);

    try {
      if (p === "/api/state" && req.method === "GET") return json({ user: who, ...(await state()) });
      if (p === "/api/history" && req.method === "GET") return json(await history());

      const svc = SERVICES.find((s) => s.key === (url.searchParams.get("svc") ?? ""));
      if (p === "/api/tags" && req.method === "GET") {
        if (!svc) return json({ error: "Service không hợp lệ" }, 400);
        return json(await listTags(svc.image));
      }
      if (p === "/api/logs" && req.method === "GET") {
        if (!svc) return json({ error: "Service không hợp lệ" }, 400);
        const pod = url.searchParams.get("pod") ?? "";
        const previous = url.searchParams.get("previous") === "1";
        const d: any = await k8s(`/apis/apps/v1/namespaces/${svc.ns}/deployments/${svc.deploy}`);
        const sel = Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",");
        const list: any = await k8s(`/api/v1/namespaces/${svc.ns}/pods?labelSelector=${encodeURIComponent(sel)}`);
        const target = list.items.find((x: any) => x.metadata.name === pod) ?? list.items[0];
        if (!target) return json({ error: "Không có pod" }, 404);
        const c = svc.init ?? svc.container!;
        const text = await k8s(`/api/v1/namespaces/${svc.ns}/pods/${target.metadata.name}/log?container=${c}&tailLines=400&timestamps=true${previous ? "&previous=true" : ""}`).catch((e) => String(e.message));
        return json({ pod: target.metadata.name, container: c, text });
      }

      if (req.method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
      const body: any = await req.json().catch(() => ({}));
      const s = SERVICES.find((x) => x.key === body.svc);

      if (p === "/api/deploy") {
        if (!s) return json({ error: "Service không hợp lệ" }, 400);
        const tag = String(body.tag ?? "").trim();
        if (!TAG_OK.test(tag)) return json({ error: "Thẻ ảnh không hợp lệ" }, 400);
        if (!(await tagExists(s.image, tag))) return json({ error: `Không có ${s.image}:${tag} trên GHCR. Đẩy ảnh lên trước (docker push).` }, 400);
        const r = await withLock(() => commitTag(s, tag, who));
        if (!r.unchanged) log(who, `deploy ${s.key} ${r.old} → ${tag} ${r.commit}`);
        await fluxReconcile();
        return json({ ok: true, ...r, tag });
      }
      if (p === "/api/restart") {
        if (!s) return json({ error: "Service không hợp lệ" }, 400);
        const at = new Date().toISOString();
        await k8s(`/apis/apps/v1/namespaces/${s.ns}/deployments/${s.deploy}`, {
          method: "PATCH",
          contentType: "application/strategic-merge-patch+json",
          body: JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } } }),
        });
        log(who, `restart ${s.ns}/${s.deploy}`);
        return json({ ok: true, at });
      }
      if (p === "/api/reconcile") {
        const at = await fluxReconcile();
        log(who, "yêu cầu Flux đồng bộ");
        return json({ ok: true, at });
      }
      return json({ error: "Không tìm thấy" }, 404);
    } catch (e: any) {
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});
console.log(`stg-deploy chạy cổng ${server.port}`);
