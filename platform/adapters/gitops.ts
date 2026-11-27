// Adapter `gitops-kustomize` (Sàn TMĐT staging, chuyển từ stg-deploy/server.ts):
//   Build: ảnh dựng từ `git archive <sha>:<context>` (không checkout, không lấy tệp chưa commit), quét Trivy (service có
//          scan), push GHCR; rồi commit đổi `newTag` trong kustomization.yaml của nhánh GitOps (SSH key của PC) và gọi
//          Flux áp ngay, theo dõi rollout tối đa 6 phút.
//   Deploy: đổi `newTag` sang một thẻ đã có trên GHCR.
// Bản xem trước (PREVIEW): chỉ đọc trạng thái thật (cụm qua kubectl proxy, git, GHCR); build/push/commit/Flux/restart chỉ
// ghi ra log.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, keepAlive, must, pipe, run, secret, PREVIEW, type Log } from "../lib";
import { Repo } from "../repo";
import { checkOf, type Job } from "../queue";
import type { EnvAdapter } from "./types";

export type GitopsService = {
  key: string; label: string; note: string; image: string;
  ns: string; deploy: string; container?: string; init?: string;
  also?: string[];  // Deployment khác cùng ảnh (backend-worker): đổi thẻ là rollout cả nó, Restart cũng khởi động lại nó
  defaultBuild?: boolean;
  build: { context: string; file: string; target?: string; args?: Record<string, string>; suffix: string; scan?: boolean };
};
export type GitopsCfg = {
  kind: "gitops-kustomize";
  branch: string;            // nhánh GitOps chứa kustomization (commit đổi thẻ vào đây)
  kpath: string;             // đường dẫn kustomization.yaml trong repo
  root: string;              // thư mục gốc của build context trong repo ("" = gốc repo)
  kubeconfig: string; proxyPort: number;
  flux: { ns: string; source: string; ks: string };
  ghOrg: string;             // org chứa package GHCR (liệt kê thẻ)
  tagPrefix: string;         // thẻ = <tagPrefix>-<sha7>-pc<suffix>
  hideTags?: RegExp;         // ẩn thẻ khi liệt kê (vd. thẻ production)
  services: GitopsService[];
  publicUrl: string;         // ghi vào commit đổi thẻ
  commitLabel: string;       // tiền tố commit, vd. "Staging (dmst-cicd)"
};
const TRIVY_IMAGE = "aquasec/trivy:0.76.1"; // trùng build-push.yml

const tagOfImage = (img: string) => {
  const at = img.lastIndexOf("@");
  const base = at > 0 ? img.slice(0, at) : img;
  const i = base.lastIndexOf(":");
  return i > base.lastIndexOf("/") ? base.slice(i + 1) : "latest";
};
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const tagRe = (image: string) => new RegExp(`(-\\s+name:\\s*${escRe(image)}\\s*\\r?\\n\\s*newTag:\\s*)(\\S+)`);
// Mã commit trong thẻ ảnh: stg-<sha7>-pc[-staging] (trang này/stg-deploy), sha-<sha7>[-staging] (build-push.yml)
const sha7OfTag = (tag?: string | null) => tag?.match(/^(?:stg|prod|sha)-([0-9a-f]{7})(?:-|$)/)?.[1] ?? null;

export class GitopsAdapter implements EnvAdapter {
  kind = "gitops";
  services;
  private K8S: string;
  private WT: string; // worktree nhánh GitOps để commit đổi thẻ
  constructor(public project: string, public cfg: GitopsCfg, public repo: Repo, root: string) {
    this.services = cfg.services.map((s) => ({ key: s.key, label: s.label, defaultBuild: s.defaultBuild }));
    this.K8S = `http://127.0.0.1:${cfg.proxyPort}`;
    this.WT = join(root, "gitops");
  }
  start() {
    keepAlive(`kubectl-proxy:${this.project}`, () => ["kubectl", "--kubeconfig", this.cfg.kubeconfig, "proxy", "--address", "127.0.0.1", "--port", String(this.cfg.proxyPort)]);
  }
  private svc = (key: string) => this.cfg.services.find((s) => s.key === key);
  private tagFor = (s: GitopsService, sha: string) => `${this.cfg.tagPrefix}-${sha.slice(0, 7)}-pc${s.build.suffix}`;

  // ---------------- Kubernetes (qua kubectl proxy, chỉ 127.0.0.1) ----------------
  private async k8s(path: string, init: RequestInit & { contentType?: string } = {}) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.contentType) headers["Content-Type"] = init.contentType;
    const r = await fetch(this.K8S + path, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`k8s ${init.method ?? "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return path.includes("/log?") ? r.text() : r.json();
  }
  private mergePatch = (path: string, body: unknown) => this.k8s(path, { method: "PATCH", body: JSON.stringify(body), contentType: "application/merge-patch+json" });
  async reconcile() {
    const { ns, source, ks } = this.cfg.flux;
    const ann = { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": new Date().toISOString() } } };
    await act(() => {}, "Flux reconcile", async () => {
      await this.mergePatch(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${ns}/gitrepositories/${source}`, ann);
      await this.mergePatch(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${ns}/kustomizations/${ks}`, ann);
    });
  }

  // ---------------- Git ----------------
  private async gitTags() {
    await this.repo.fetch();
    const text = await this.repo.git(["show", `origin/${this.cfg.branch}:${this.cfg.kpath}`], { quiet: true });
    return Object.fromEntries(this.cfg.services.map((s) => [s.key, text.match(tagRe(s.image))?.[2] ?? null])) as Record<string, string | null>;
  }
  async history() {
    await this.repo.fetch();
    const out = await this.repo.git(["log", "-20", "--format=%H%x1f%cI%x1f%B%x1e", `origin/${this.cfg.branch}`, "--", this.cfg.kpath], { quiet: true });
    return out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
      const [sha, date, message] = x.split("\x1f");
      return { sha: sha.slice(0, 7), url: this.repo.commitUrl(sha), date, message: message.trim() };
    });
  }
  // Commit đổi thẻ ảnh vào nhánh GitOps rồi push (thử lại khi bị từ chối do có commit mới).
  private async commitTags(changes: { svc: GitopsService; tag: string }[], who: string, note: string, log: Log) {
    const { branch, kpath } = this.cfg;
    const wt = this.WT;
    if (!existsSync(join(wt, ".git"))) await this.repo.git(["worktree", "add", "-f", "--detach", wt, `origin/${branch}`]);
    const g = (args: string[], o: { onLine?: Log } = {}) => must(["git", "-C", wt, ...args], { quiet: true, ...o });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.repo.fetch(true);
      await g(["checkout", "-q", "--force", "-B", branch, `origin/${branch}`]);
      const file = join(wt, kpath);
      let text = readFileSync(file, "utf8");
      const diffs: string[] = [];
      for (const { svc, tag } of changes) {
        const old = text.match(tagRe(svc.image))?.[2];
        if (!old) throw new Error(`Không thấy mục images cho ${svc.image} trong ${kpath}`);
        if (old !== tag) { text = text.replace(tagRe(svc.image), `$1${tag}`); diffs.push(`${svc.image.split("/").pop()} ${old} → ${tag}`); }
      }
      if (!diffs.length) { log("Thẻ ảnh trong Git đã đúng, không cần commit."); return null; }
      const msg = `${this.cfg.commitLabel}: ${diffs.join(", ")}\n\n${note}\nThực hiện bởi ${who} qua ${this.cfg.publicUrl}`;
      if (PREVIEW) { log(`[THỬ] commit + push nhánh ${branch}: ${diffs.join(", ")}`); return null; }
      writeFileSync(file, text);
      await g(["-c", `user.name=${E_GIT.name}`, "-c", `user.email=${E_GIT.email}`, "commit", "-q", "-m", msg, "--", kpath]);
      const r = await run(["git", "-C", wt, "push", "origin", `HEAD:${branch}`], { onLine: log });
      if (r.code === 0) {
        const sha = (await g(["rev-parse", "HEAD"])).trim();
        log(`Đã push commit ${sha.slice(0, 7)} lên nhánh ${branch}: ${diffs.join(", ")}`);
        await this.repo.fetch(true);
        return sha;
      }
      log(`Push bị từ chối (lần ${attempt}), lấy bản mới rồi thử lại…`);
    }
    throw new Error(`Không push được vào nhánh ${branch} sau 3 lần`);
  }

  // ---------------- GHCR ----------------
  private tagExists = async (image: string, tag: string) => (await run(["docker", "manifest", "inspect", `${image}:${tag}`], { quiet: true })).code === 0;
  async tags(key: string) {
    const s = this.svc(key);
    if (!s) throw new Error("Service không hợp lệ");
    const token = secret("GITHUB_CLASSIC_TOKEN");
    if (!token) throw new Error("Thiếu GITHUB_CLASSIC_TOKEN (read:packages) để liệt kê thẻ; vẫn nhập tay thẻ được");
    const r = await fetch(`https://api.github.com/orgs/${this.cfg.ghOrg}/packages/container/${s.image.split("/").pop()}/versions?per_page=40`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`GitHub Packages ${r.status}`);
    const out: { tag: string; created: string | null }[] = [];
    for (const v of (await r.json()) as any[]) for (const t of v.metadata?.container?.tags ?? []) out.push({ tag: t, created: v.created_at });
    return out.filter((t) => !this.cfg.hideTags?.test(t.tag)).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  }

  // ---------------- Job ----------------
  private async startNotify(j: Job, sha: string | null, tag: string, firstSvc: string) {
    const truoc = (await this.gitTags().catch(() => ({} as Record<string, string | null>)))[firstSvc] ?? null;
    j.notify = { phienBan: sha ? sha.slice(0, 7) : tag, tu: await this.repo.resolveSha(sha7OfTag(truoc)), den: sha };
  }
  async build(j: Job, log: Log) {
    log("Lấy mã mới từ GitHub…");
    await this.repo.fetch(true);
    const sha = j.sha!;
    const ck = checkOf(j.project, sha);
    if (j.bypass) log(`⚠ BỎ QUA CHẶN (khẩn cấp, ${j.user}, lý do: ${j.reason ?? "?"}): CI ${ck?.status === "ok" ? "đã đạt" : "chưa đạt/chưa chạy"}, Trivy chỉ cảnh báo.`);
    else if (ck?.status !== "ok") throw new Error(`Commit ${sha.slice(0, 7)} chưa qua kiểm tra (CI)`);
    if (ck?.status === "ok") log(`Kiểm tra (CI) đạt lúc ${ck.ended} (lượt ${ck.id}).`);
    log(`Commit ${sha.slice(0, 7)}: ${j.subject}`);
    const svcs = this.cfg.services.filter((s) => j.services.includes(s.key));
    if (j.deploy) await this.startNotify(j, sha, sha.slice(0, 7), svcs[0].key);
    const rootOf = (ctx: string) => [this.cfg.root, ctx].filter((x) => x && x !== ".").join("/") || ".";
    for (const s of svcs) {
      const tag = this.tagFor(s, sha);
      const ref = `${s.image}:${tag}`;
      log(""); log(`══ ${s.label}: ${ref}`);
      if (await this.tagExists(s.image, tag)) { log("Ảnh này đã có trên GHCR (cùng commit), bỏ qua build."); j.tags[s.key] = tag; continue; }
      const b = s.build;
      // Dockerfile nằm trong context: đường dẫn -f tương đối với context (git archive chỉ chứa context)
      const ctx = rootOf(b.context);
      const fileInCtx = b.context === "." ? b.file : b.file.slice(b.context.length + 1);
      const cmd = ["docker", "build", "--progress=plain", "-f", fileInCtx, "-t", ref];
      if (b.target) cmd.push("--target", b.target);
      for (const [k, v] of Object.entries(b.args ?? {})) cmd.push("--build-arg", `${k}=${v}`);
      cmd.push("--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dmst.cicd.by=${j.user}`, "-");
      const archive = ["git", "-C", this.repo.dir, "archive", "--format=tar", ctx === "." ? sha : `${sha}:${ctx}`];
      const t0 = Date.now();
      await act(log, `Build ${ref}`, () => pipe(archive, cmd, log), [archive, cmd]);
      log(`Build xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
      if (b.scan) {
        log("Quét lỗ hổng (Trivy, CRITICAL đã có bản vá)…");
        const scan = ["docker", "run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", "trivy-cache:/root/.cache",
          TRIVY_IMAGE, "image", "--quiet", "--severity", "CRITICAL", "--ignore-unfixed", "--exit-code", "1", ref];
        const code = PREVIEW ? (log(`[THỬ] $ ${scan.join(" ")}`), 0) : (await run(scan, { onLine: log })).code;
        if (code !== 0 && j.bypass) log(`⚠ Trivy: ${s.label} có lỗ hổng CRITICAL đã có bản vá (hoặc quét lỗi), BỎ QUA CHẶN nên vẫn đẩy ảnh. Cần vá sớm.`);
        else if (code !== 0) { await run(["docker", "image", "rm", ref], { quiet: true }); throw new Error(`Trivy: ${s.label} có lỗ hổng CRITICAL đã có bản vá (hoặc quét lỗi), không đẩy ảnh`); }
        else log("Trivy: không có lỗ hổng CRITICAL đã có bản vá.");
      }
      log("Đẩy lên GHCR…");
      await act(log, `docker push ${ref}`, () => must(["docker", "push", ref], { onLine: (l) => { if (!/Waiting|Preparing|Layer already exists/.test(l)) log(l); } }));
      j.tags[s.key] = tag;
    }
    if (!PREVIEW) {
      for (const s of svcs) await run(["docker", "image", "rm", `${s.image}:${this.tagFor(s, sha)}`], { quiet: true });
      await run(["docker", "image", "prune", "-f"], { quiet: true });
    }
    if (!j.deploy) { log(`Chỉ build, không deploy. Thẻ: ${Object.values(j.tags).join(", ")}`); return; }
    log("");
    j.commit = await this.commitTags(svcs.map((s) => ({ svc: s, tag: j.tags[s.key] })), j.user,
      `Build từ ${j.ref} @ ${sha.slice(0, 7)} (${j.subject})${j.bypass ? ` [bỏ qua chặn CI/Trivy: ${j.reason ?? ""}]` : ""}`, log);
    await this.afterCommit(svcs, log);
  }
  async deploy(j: Job, log: Log) {
    const s = this.svc(j.services[0])!;
    const tag = j.tags[s.key];
    await this.repo.fetch(true);
    await this.startNotify(j, await this.repo.resolveSha(sha7OfTag(tag)), tag, s.key);
    log(`Kiểm tra ${s.image}:${tag} trên GHCR…`);
    if (!(await this.tagExists(s.image, tag))) throw new Error(`Không có ${s.image}:${tag} trên GHCR`);
    j.commit = await this.commitTags([{ svc: s, tag }], j.user, "Deploy thẻ có sẵn.", log);
    await this.afterCommit([s], log);
  }
  // Gọi Flux áp ngay rồi theo dõi rollout (tối đa 6 phút).
  private async afterCommit(svcs: GitopsService[], log: Log) {
    log("Yêu cầu Flux đồng bộ…");
    await this.reconcile();
    if (PREVIEW) { log("[THỬ] bỏ qua theo dõi rollout."); return; }
    const deploysOf = (s: GitopsService) => [s.deploy, ...(s.also ?? [])].map((d) => `${s.ns}/${d}`);
    const deploys = [...new Set(svcs.flatMap(deploysOf))];
    const deadline = Date.now() + 6 * 60_000;
    let lastMsg = "";
    while (Date.now() < deadline) {
      await Bun.sleep(5000);
      const kt = await this.gitTags().catch(() => null);
      let done = true; const parts: string[] = [];
      for (const key of deploys) {
        const [ns, name] = key.split("/");
        const d: any = await this.k8s(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`).catch(() => null);
        if (!d) { done = false; continue; }
        const spec = d.spec.template.spec;
        const imgs = [...(spec.initContainers ?? []), ...spec.containers].map((c: any) => c.image as string);
        const tagsOk = svcs.filter((s) => deploysOf(s).includes(key)).every((s) => kt && imgs.includes(`${s.image}:${kt[s.key]}`));
        const st = d.status ?? {};
        const want = d.spec.replicas ?? 1; // 0 bản sao: không chờ pod nào (bản sửa b9c1d07)
        const ok = tagsOk && st.observedGeneration >= d.metadata.generation && (st.updatedReplicas ?? 0) === want && (st.availableReplicas ?? 0) === want && (st.replicas ?? 0) === want;
        parts.push(`${name}: ${tagsOk ? "" : "chờ Flux áp thẻ mới, "}${st.updatedReplicas ?? 0}/${want} cập nhật, ${st.availableReplicas ?? 0} sẵn sàng`);
        if (!ok) done = false;
      }
      const msg = parts.join(" · ");
      if (msg !== lastMsg) { log(msg); lastMsg = msg; }
      if (done) { log("Rollout xong."); return; }
    }
    throw new Error("Hết 6 phút mà rollout chưa xong: xem log pod / trạng thái Flux trên trang");
  }
  async restart(key: string, who: string) {
    const s = this.svc(key);
    if (!s || s.init) throw new Error("Service không khởi động lại được");
    const at = new Date().toISOString();
    for (const d of [s.deploy, ...(s.also ?? [])]) {
      await act(() => {}, `restart ${s.ns}/${d}`, () => this.k8s(`/apis/apps/v1/namespaces/${s.ns}/deployments/${d}`, {
        method: "PATCH", contentType: "application/strategic-merge-patch+json",
        body: JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } } }),
      }).catch((e) => { if (d === s.deploy) throw e; })); // Deployment phụ chưa có thì bỏ qua
      console.log(`${at} [${who}] ${PREVIEW ? "[THỬ] " : ""}restart ${s.ns}/${d}`);
    }
  }
  async logs(q: URLSearchParams) {
    const s = this.svc(q.get("svc") ?? "");
    if (!s) throw new Error("Service không hợp lệ");
    const d: any = await this.k8s(`/apis/apps/v1/namespaces/${s.ns}/deployments/${s.deploy}`);
    const sel = Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",");
    const list: any = await this.k8s(`/api/v1/namespaces/${s.ns}/pods?labelSelector=${encodeURIComponent(sel)}`);
    const target = list.items.find((x: any) => x.metadata.name === q.get("pod")) ?? list.items[0];
    if (!target) throw new Error("Không có pod");
    const c = s.init ?? s.container!;
    const prev = q.get("previous") === "1" ? "&previous=true" : "";
    const text = await this.k8s(`/api/v1/namespaces/${s.ns}/pods/${target.metadata.name}/log?container=${c}&tailLines=400&timestamps=true${prev}`).catch((e) => String(e.message));
    return { pod: target.metadata.name, container: c, text };
  }

  // ---------------- Trạng thái ----------------
  private podView(p: any) {
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
  async state() {
    const S = this.cfg.services, { ns: fns, source, ks: fks } = this.cfg.flux;
    const VIEW_NS = [...new Set(S.map((s) => s.ns))];
    const [git, ks, src, ...nsPods] = await Promise.all([
      this.gitTags().catch((e) => ({ error: String(e.message ?? e) })),
      this.k8s(`/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${fns}/kustomizations/${fks}`).catch(() => null),
      this.k8s(`/apis/source.toolkit.fluxcd.io/v1/namespaces/${fns}/gitrepositories/${source}`).catch(() => null),
      ...VIEW_NS.map((ns) => this.k8s(`/api/v1/namespaces/${ns}/pods`).then((l: any) => l.items.map((p: any) => this.podView(p))).catch(() => null)),
    ] as Promise<any>[]);
    const clusterOk = nsPods.some((x) => x !== null);
    const pods: Record<string, any[]> = Object.fromEntries(VIEW_NS.map((ns, i) => [ns, nsPods[i] ?? []]));
    const deploys = new Map<string, any>();
    await Promise.all([...new Set(S.map((s) => `${s.ns}/${s.deploy}`))].map(async (k) => {
      const [ns, d] = k.split("/");
      deploys.set(k, await this.k8s(`/apis/apps/v1/namespaces/${ns}/deployments/${d}`).catch(() => null));
    }));
    const gitErr = git && "error" in git ? (git.error as string) : null;
    const services = S.map((s) => {
      const d = deploys.get(`${s.ns}/${s.deploy}`);
      const spec = d?.spec?.template?.spec;
      const c = (s.init ? spec?.initContainers : spec?.containers)?.find((x: any) => x.name === (s.init ?? s.container));
      const sel = d?.spec?.selector?.matchLabels ?? {};
      const mine = pods[s.ns].filter((p) => Object.entries(sel).every(([k, v]) => p.labels[k] === v));
      const st = d?.status ?? {};
      const want = d?.spec?.replicas ?? 1;
      return {
        key: s.key, label: s.label, note: s.note, image: s.image, ns: s.ns, deploy: s.deploy,
        container: s.init ?? s.container, isInit: !!s.init,
        specTag: c ? tagOfImage(c.image) : null,
        gitTag: gitErr ? null : (git as Record<string, string | null>)[s.key],
        replicas: want, ready: st.readyReplicas ?? 0, updated: st.updatedReplicas ?? 0,
        rolloutDone: d ? (st.observedGeneration ?? 0) >= d.metadata.generation && (st.updatedReplicas ?? 0) === want && (st.replicas ?? 0) === want && (st.availableReplicas ?? 0) === want : false,
        restartedAt: d?.spec?.template?.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"] ?? null,
        pods: mine.map(({ labels, ...p }) => ({ ...p, runningTag: p.images[s.init ?? s.container!] ?? null })),
      };
    });
    const cond = (o: any) => (o?.status?.conditions ?? []).find((x: any) => x.type === "Ready");
    return {
      clusterError: clusterOk ? null : "Không gọi được API cụm (kubectl proxy / Tailscale trên PC?)",
      gitError: gitErr,
      repo: { branch: this.cfg.branch, path: this.cfg.kpath },
      flux: {
        ready: cond(ks)?.status ?? "Unknown", message: cond(ks)?.message ?? "",
        lastApplied: ks?.status?.lastAppliedRevision ?? "", source: src?.status?.artifact?.revision ?? "",
        sourceReady: cond(src)?.status ?? "Unknown", sourceMessage: cond(src)?.message ?? "",
      },
      services,
    };
  }
  async summary() {
    try {
      const s: any = await this.state();
      if (s.clusterError) return { ok: false, text: s.clusterError };
      const bad = s.services.filter((x: any) => x.pods.some((p: any) => !/Running|Succeeded|Completed|Pending|ContainerCreating|PodInitializing|Init:|Terminating/.test(p.status)));
      if (bad.length) return { ok: false, text: `Lỗi: ${bad.map((x: any) => x.label).join(", ")}` };
      if (s.flux.ready === "False") return { ok: false, text: "Flux không áp được bản mới" };
      const be = s.services[0];
      return { ok: true, text: `${s.services.length} service đang chạy · ${be.label} ${be.specTag ?? "?"}` };
    } catch (e: any) { return { ok: null, text: String(e?.message ?? e) }; }
  }
}

const E_GIT = { name: process.env.GIT_USER_NAME ?? "vantt47", email: process.env.GIT_USER_EMAIL ?? "89087529+vantt47@users.noreply.github.com" };
