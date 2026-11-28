// Adapter `k8s-image` (thi-vien-chuc staging trên cụm k3s staging chung, chuyển từ tvc-stg/server.ts):
//   Build: dựng ảnh app (Dockerfile.uat của commit, ngữ cảnh `git archive <sha>`) và ảnh db (Dockerfile.db của commit nếu
//          có, không thì platform/ci/tvc/Dockerfile.db), thẻ stg-<sha7>, push GHCR (đã có trên GHCR thì bỏ qua dựng).
//   Triển khai: CSDL trước, app sau.
//     - database/schema.sql khác CSDL đang chạy → LÀM LẠI CSDL (xoá schema public, chạy schema.sql + seed.sql; mất dữ liệu
//       staging), chỉ khi job có opts.resetDb. Chỉ seed.sql đổi → nạp lại seed.sql (idempotent) trong một transaction.
//       Băm git blob của hai tệp ghi ở annotation dmst-cicd/schema, dmst-cicd/seed của StatefulSet db.
//     - `kubectl set image` Deployment app → chờ rollout; không lành thì `rollout undo`; kiểm <site>/health.
//   Đổi bản: chạy lại một thẻ đã dựng (quay lui). Khác schema với CSDL đang chạy thì phải chọn làm lại CSDL.
// Manifest gốc (namespace, Deployment app, StatefulSet db, Ingress) nằm ở deploy/k8s/ của kho thi-vien-chuc (nhánh
// deploy/staging-k8s); adapter chỉ đổi ảnh/annotation trên các đối tượng đã có.
// Đọc trạng thái qua kubectl proxy (127.0.0.1:<proxyPort>); thao tác ghi dùng kubectl CLI và luôn đi qua act() nên bản xem
// trước (PREVIEW) chỉ ghi lệnh ra log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { act, keepAlive, must, pipe, run, PREVIEW, type Log, type RunOpts } from "../lib";
import type { Repo } from "../repo";
import { busyJobs, checkOf, type Job } from "../queue";
import type { EnvAdapter, JobOption } from "./types";

export type K8sImageCfg = {
  kind: "k8s-image";
  kubeconfig: string;
  proxyPort: number;      // cổng kubectl proxy riêng của adapter (127.0.0.1)
  ns: string;             // stg-thi-vien-chuc
  imgApp: string; imgDb: string;   // ghcr.io/khcn-thanh-hoa/thi-vien-chuc-app|db
  dbUser: string; dbName: string;
  site: string;
  ghOrg: string;          // org chứa package GHCR
  requireCi: boolean;
  legacyBuildsFile?: string; // builds.json của trang cũ tvc-stg (đọc thêm, không ghi) để Đổi bản về thẻ trang cũ đã dựng
  legacyJobsDir?: string;    // WORK cũ/jobs; lịch sử trang cũ đọc ở <thư mục cha>/lich-su-trien-khai.log
  legacyHistFile?: string;   // mặc định suy từ legacyJobsDir
  buildArgs?: Record<string, string>; // build-arg của ảnh app (mặc định như tvc-stg)
  annPrefix?: string;        // tiền tố annotation (mặc định dmst-cicd, trùng trang cũ)
};

type Build = { tag: string; sha: string; subject: string; schema: string; seed: string; luc: string; by: string };
type Pod = { name: string; phase: string; ready: boolean; restarts: number; status: string; image: string; node: string; age: string };
type Cum = {
  ok: boolean; error: string | null; tag: string | null; sha: string | null; subject: string | null; by: string | null; at: string | null;
  dbTag: string | null; schema: string | null; seed: string | null;
  services: { key: string; label: string; note: string; restart: boolean; pods: Pod[] }[];
  health: { ok: boolean; code: number; text: string } | null; luc: string;
};
const SERVICES = [
  { key: "app", label: "App", note: "Nginx (SPA) + NestJS /api · Deployment app", restart: true },
  { key: "db", label: "PostgreSQL 16", note: "StatefulSet db, PVC data-db-0", restart: false },
];
const tagOfImage = (img?: string) => (img && img.includes(":") ? img.split(":").pop()! : null);
const quietBuild = (log: Log) => (l: string) => { if (!/^#\d+ (sha256|extracting|transferring)|^#\d+ \d+\.\d+ (Downloading|Extracting)/.test(l)) log(l); };
const CI_DB_DOCKERFILE = join(import.meta.dir, "..", "ci", "tvc", "Dockerfile.db");

export class K8sImageAdapter implements EnvAdapter {
  kind = "k8s-image";
  services = SERVICES.map((s) => ({ key: s.key, label: s.label, defaultBuild: true }));
  wholeRelease = true;
  options: JobOption[] = [{ key: "resetDb", on: "both" }];
  private K8S: string;
  private ANN: string;
  private envId: string;
  private BUILDS: string;
  private HIST: string;
  private CTX: string;
  private builds: Build[] = [];
  private cumCache: { at: number; p: Promise<Cum> } | null = null;

  constructor(public project: string, public cfg: K8sImageCfg, public repo: Repo, root: string) {
    this.K8S = `http://127.0.0.1:${cfg.proxyPort}`;
    this.ANN = cfg.annPrefix ?? "dmst-cicd";
    this.envId = basename(root);
    mkdirSync(root, { recursive: true });
    this.BUILDS = join(root, "builds.json");
    this.HIST = join(root, "lich-su-trien-khai.log");
    this.CTX = join(root, "ctx");
    try { this.builds = JSON.parse(readFileSync(this.BUILDS, "utf8")); } catch {}
  }
  start() {
    keepAlive(`kubectl-proxy:${this.project}/${this.envId}`, () => ["kubectl", "--kubeconfig", this.cfg.kubeconfig, "proxy", "--address", "127.0.0.1", "--port", String(this.cfg.proxyPort)]);
  }
  private tagFor = (sha: string) => "stg-" + sha.slice(0, 7);

  // ---------------- Kubernetes ----------------
  private async k8s(path: string) {
    const r = await fetch(this.K8S + path, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`k8s GET ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return path.includes("/log?") ? r.text() : r.json();
  }
  private kc = (args: string[], o: RunOpts = {}) => run(["kubectl", "--kubeconfig", this.cfg.kubeconfig, "-n", this.cfg.ns, ...args], o);
  private kcMust = (args: string[], o: RunOpts = {}) => must(["kubectl", "--kubeconfig", this.cfg.kubeconfig, "-n", this.cfg.ns, ...args], o);
  // Thao tác ghi lên cụm: bản xem trước chỉ ghi lệnh
  private kw = (log: Log, what: string, args: string[], o: RunOpts = {}) =>
    act(log, what, () => this.kcMust(args, o), [["kubectl", "-n", this.cfg.ns, ...args]]);

  // ---------------- Thẻ đã dựng (của nền tảng + của trang cũ) ----------------
  private allBuilds(): Build[] {
    let legacy: Build[] = [];
    if (this.cfg.legacyBuildsFile) { try { legacy = JSON.parse(readFileSync(this.cfg.legacyBuildsFile, "utf8")); } catch {} }
    const seen = new Set<string>();
    return [...this.builds, ...legacy].filter((b) => !seen.has(b.tag) && !!seen.add(b.tag)).sort((a, b) => b.luc.localeCompare(a.luc));
  }
  private saveBuild(b: Build) {
    this.builds = [b, ...this.builds.filter((x) => x.tag !== b.tag)].slice(0, 40);
    writeFileSync(this.BUILDS, JSON.stringify(this.builds, null, 1));
  }
  private blobOf = async (sha: string, path: string) => (await run(["git", "-C", this.repo.dir, "rev-parse", "-q", "--verify", `${sha}:${path}`], { quiet: true })).out.trim();
  private subjectOf = async (sha: string) => {
    const r = await run(["git", "-C", this.repo.dir, "log", "-1", "--format=%s", sha], { quiet: true });
    return r.code === 0 ? r.out.trim() || null : null;
  };
  private hasPath = async (sha: string, path: string) => (await run(["git", "-C", this.repo.dir, "cat-file", "-e", `${sha}:${path}`], { quiet: true })).code === 0;
  // Thẻ chưa có trong builds (vd. dựng nơi khác): suy commit từ thẻ stg-<sha7> rồi tính băm schema/seed từ kho
  private async buildOf(tag: string): Promise<Build | null> {
    const b = this.allBuilds().find((x) => x.tag === tag);
    if (b) return b;
    const m = tag.match(/^stg-([0-9a-f]{7})$/);
    if (!m) return null;
    await this.repo.fetch();
    const sha = await this.repo.resolveSha(m[1]);
    if (!sha) return null;
    return { tag, sha, subject: (await this.subjectOf(sha)) ?? "", schema: await this.blobOf(sha, "database/schema.sql"), seed: await this.blobOf(sha, "database/seed.sql"), luc: "", by: "" };
  }

  // ---------------- Trạng thái cụm (đệm 8 giây) ----------------
  private cum(force = false): Promise<Cum> {
    if (!force && this.cumCache && Date.now() - this.cumCache.at < 8000) return this.cumCache.p;
    const { ns, site } = this.cfg, A = this.ANN;
    const p = (async (): Promise<Cum> => {
      const [dep, sts, pods, health] = await Promise.all([
        this.k8s(`/apis/apps/v1/namespaces/${ns}/deployments/app`),
        this.k8s(`/apis/apps/v1/namespaces/${ns}/statefulsets/db`),
        this.k8s(`/api/v1/namespaces/${ns}/pods`).then((l: any) => l.items as any[]),
        fetch(`${site}/health`, { signal: AbortSignal.timeout(8000) }).then(async (x) => ({ ok: x.ok, code: x.status, text: (await x.text()).slice(0, 200) }), (e) => ({ ok: false, code: 0, text: String(e?.message ?? e) })),
      ]).catch((e) => { throw new Error(`Không gọi được API cụm (kubectl proxy / Tailscale trên PC?): ${e?.message ?? e}`); });
      const da = dep?.metadata?.annotations ?? {}, sa = sts?.metadata?.annotations ?? {};
      const appImg = dep?.spec?.template?.spec?.containers?.find((c: any) => c.name === "app")?.image;
      const dbImg = sts?.spec?.template?.spec?.containers?.[0]?.image;
      const tag = tagOfImage(appImg);
      const podInfo = (p: any): Pod => {
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
      const sha = da[`${A}/sha`] ?? null;
      return {
        ok: true, error: null, tag, sha, subject: (sha ? await this.subjectOf(sha) : null) ?? this.allBuilds().find((b) => b.tag === tag)?.subject ?? null,
        by: da[`${A}/by`] ?? null, at: da[`${A}/at`] ?? null,
        dbTag: tagOfImage(dbImg), schema: sa[`${A}/schema`] ?? null, seed: sa[`${A}/seed`] ?? null,
        services: SERVICES.map((s) => ({ ...s, pods: pods.filter((p) => p.metadata.labels?.app === s.key).map(podInfo) })),
        health, luc: new Date().toISOString(),
      };
    })().catch((e) => ({ ok: false, error: String(e?.message ?? e), tag: null, sha: null, subject: null, by: null, at: null, dbTag: null, schema: null, seed: null, services: [], health: null, luc: new Date().toISOString() }));
    this.cumCache = { at: Date.now(), p };
    return p;
  }

  // ---------------- Lịch sử triển khai (mỗi dòng: ISO \t thẻ \t csdl \t người) ----------------
  private readHist() {
    const files = [this.HIST];
    const legacy = this.cfg.legacyHistFile ?? (this.cfg.legacyJobsDir ? join(dirname(this.cfg.legacyJobsDir), "lich-su-trien-khai.log") : null);
    if (legacy) files.push(legacy);
    const builds = this.allBuilds();
    const rows: { luc: string; the: string; csdl: string; nguoi: string; subject: string | null; sha: string | null }[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      for (const l of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
        const [luc, the, csdl, ...nguoi] = l.split("\t");
        const b = builds.find((x) => x.tag === the);
        rows.push({ luc, the, csdl, nguoi: nguoi.join(" ") + (f === legacy ? " (trang cũ)" : ""), subject: b?.subject ?? null, sha: b?.sha ?? null });
      }
    }
    return rows.sort((a, b) => b.luc.localeCompare(a.luc)).slice(0, 30);
  }

  // ---------------- EnvAdapter ----------------
  async state() {
    return { cum: await this.cum(), hist: this.readHist(), ns: this.cfg.ns, site: this.cfg.site };
  }
  async currentSha() { const m = await this.cum(); return m.ok ? (m.tag?.match(/^stg-([0-9a-f]{7})$/)?.[1] ?? null) : null; }
  async summary() {
    const m = await this.cum();
    if (!m.ok) return { ok: false, text: m.error ?? "Không đọc được cụm" };
    if (!m.health?.ok) return { ok: false, text: `${this.cfg.site}/health không ok (${m.health?.code ?? 0})` };
    const bad = m.services.filter((s) => !s.pods.length || s.pods.some((p) => /CrashLoop|Err|BackOff|Failed/i.test(p.status)));
    if (bad.length) return { ok: false, text: `Lỗi: ${bad.map((s) => s.label).join(", ")}` };
    return { ok: true, text: `Đang chạy ${m.tag ?? "?"}${m.by ? ` · ${m.by}` : ""}` };
  }
  async history() { return this.readHist(); }
  // Thẻ đã dựng (Đổi bản). `schema@<sha>`: hỏi schema.sql của commit có khác CSDL đang chạy không (giao diện cảnh báo
  // trước khi Build) — tạm đi qua API tags vì server chưa có API thông tin riêng của adapter.
  async tags(svc: string) {
    const m = await this.cum();
    const q = svc.match(/^schema@([0-9a-f]{40})$/);
    if (q) return [{ schemaDoi: m.ok ? (await this.blobOf(q[1], "database/schema.sql")) !== m.schema : null }];
    return this.allBuilds().map((b) => ({ tag: b.tag, sha: b.sha, subject: b.subject, created: b.luc, by: b.by, dangChay: b.tag === m.tag, khacSchema: b.schema !== m.schema }));
  }
  async logs(q: URLSearchParams) {
    const key = q.get("svc");
    if (!SERVICES.some((s) => s.key === key)) throw new Error("Service không hợp lệ");
    const { ns } = this.cfg;
    const list: any = await this.k8s(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`app=${key}`)}`);
    const pods = (list.items as any[]).filter((p) => !p.metadata.deletionTimestamp);
    const target = pods.find((p) => p.metadata.name === q.get("pod")) ?? pods[0];
    if (!target) throw new Error("Không có pod");
    const c = key === "app" ? "app" : target.spec.containers[0].name;
    const prev = q.get("previous") === "1" ? "&previous=true" : "";
    const text = await this.k8s(`/api/v1/namespaces/${ns}/pods/${target.metadata.name}/log?container=${c}&tailLines=400&timestamps=true${prev}`).catch((e) => String(e.message));
    return { pod: target.metadata.name, container: c, svc: `${target.metadata.name}/${c}`, text };
  }
  async restart(key: string, who: string) {
    if (key !== "app") throw new Error("Service này không khởi động lại được từ trang");
    if (busyJobs(this.project, this.envId)) throw new Error("Đang có việc build/triển khai, đợi xong rồi khởi động lại");
    await this.kw(() => {}, "rollout restart deploy/app", ["rollout", "restart", "deploy/app"], { quiet: true });
    console.log(`${new Date().toISOString()} [${who}] ${PREVIEW ? "[THỬ] " : ""}restart ${this.project}/${this.envId} app`);
    this.cumCache = null;
  }

  // ---------------- Build ----------------
  private onGhcr = async (ref: string) => (await run(["docker", "manifest", "inspect", ref], { quiet: true })).code === 0;
  private async buildImages(sha: string, user: string, log: Log) {
    const tag = this.tagFor(sha);
    const app = `${this.cfg.imgApp}:${tag}`, db = `${this.cfg.imgDb}:${tag}`;
    const label = ["--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dmst.cicd.by=${user}`];
    if (await this.onGhcr(app)) log(`GHCR đã có ${app}, bỏ qua dựng.`);
    else {
      log(""); log(`══ Dựng ${app} (Dockerfile.uat)`);
      const args = Object.entries(this.cfg.buildArgs ?? { VITE_API_BASE_URL: "/api", VITE_APP_ENV: "uat" }).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
      const archive = ["git", "-C", this.repo.dir, "archive", "--format=tar", sha];
      const cmd = ["docker", "build", "--progress=plain", "-f", "Dockerfile.uat", ...args, "-t", app, ...label, "-"];
      const t0 = Date.now();
      await act(log, `Build ${app}`, async () => {
        for (let lan = 1; ; lan++) {
          try { await pipe(archive, cmd, quietBuild(log)); break; }
          catch (e: any) { if (lan === 2) throw e; log(`⚠ Dựng lỗi (${e.message}), thử lại một lần…`); }
        }
        log(`Dựng xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
        // Git Bash đổi /api thành C:/Program Files/Git/api: chặn bundle hỏng
        const leak = await run(["docker", "run", "--rm", "--entrypoint", "sh", app, "-c", "grep -l 'Program Files' /usr/share/nginx/html/assets/*.js || true"], { quiet: true });
        if (leak.out.trim()) throw new Error(`Bundle web chứa đường dẫn Windows (Program Files): ${leak.out.trim()}`);
      }, [archive, cmd]);
      log(`══ Push ${app}`);
      await act(log, `docker push ${app}`, () => must(["docker", "push", "-q", app], { onLine: log }));
    }
    if (await this.onGhcr(db)) log(`GHCR đã có ${db}, bỏ qua dựng.`);
    else {
      log(""); log(`══ Dựng ${db}`);
      const own = await this.hasPath(sha, "Dockerfile.db");
      log(own ? "Dùng Dockerfile.db của kho." : "Kho chưa có Dockerfile.db ở commit này, dùng platform/ci/tvc/Dockerfile.db.");
      const ctx = join(this.CTX, tag);
      const paths = ["database", "docker/init-db.sh", ...(own ? ["Dockerfile.db"] : [])];
      const archive = ["git", "-C", this.repo.dir, "archive", "--format=tar", sha, ...paths];
      const df = own ? join(ctx, "Dockerfile.db") : CI_DB_DOCKERFILE;
      const cmd = ["docker", "build", "--progress=plain", "-f", df, "-t", db, ...label, ctx];
      await act(log, `Build ${db}`, async () => {
        rmSync(ctx, { recursive: true, force: true });
        mkdirSync(ctx, { recursive: true });
        try {
          await pipe(archive, ["tar", "-x", "-C", ctx.replace(/\\/g, "/"), "-f", "-"], log);
          await must(cmd, { onLine: quietBuild(log) });
        } finally { rmSync(ctx, { recursive: true, force: true }); }
      }, [archive, cmd]);
      log(`══ Push ${db}`);
      await act(log, `docker push ${db}`, () => must(["docker", "push", "-q", db], { onLine: log }));
    }
    if (!PREVIEW) for (const r of [app, db]) await run(["docker", "image", "rm", r], { quiet: true });
  }

  async build(j: Job, log: Log) {
    await this.repo.ensure(log);
    log("Lấy mã mới từ GitHub…");
    await this.repo.fetch(true);
    const sha = j.sha!;
    const ck = checkOf(j.project, sha);
    if (j.bypass) log(`⚠ BỎ QUA CHẶN (khẩn cấp, ${j.user}, lý do: ${j.reason ?? "?"}): CI ${ck?.status === "ok" ? "đã đạt" : "chưa đạt/chưa chạy"}.`);
    else if (this.cfg.requireCi && ck?.status !== "ok") throw new Error(`Commit ${sha.slice(0, 7)} chưa qua kiểm tra (CI)`);
    if (ck?.status === "ok") log(`Kiểm tra (CI) đạt lúc ${ck.ended} (lượt ${ck.id}).`);
    const tag = this.tagFor(sha);
    log(`Commit ${sha.slice(0, 7)}: ${j.subject}`);
    await this.buildImages(sha, j.user, log);
    j.tags = { app: tag, db: tag };
    const b: Build = { tag, sha, subject: j.subject ?? "", schema: await this.blobOf(sha, "database/schema.sql"), seed: await this.blobOf(sha, "database/seed.sql"), luc: new Date().toISOString(), by: j.user };
    if (!PREVIEW) this.saveBuild(b);
    if (!j.deploy) { log(`Chỉ build, không triển khai. Thẻ ${tag} đã có trên GHCR, dùng "Đổi bản" để chạy.`); return; }
    await this.trienKhai(j, b, log);
  }

  async deploy(j: Job, log: Log) {
    await this.repo.ensure(log);
    await this.repo.fetch(true);
    const tag = j.ref;
    const b = await this.buildOf(tag);
    if (!b) throw new Error(`Không có thông tin thẻ ${tag} (không do trang dựng, không suy được commit)`);
    for (const r of [`${this.cfg.imgApp}:${b.tag}`, `${this.cfg.imgDb}:${b.tag}`]) if (!(await this.onGhcr(r))) throw new Error(`GHCR không còn ${r}`);
    j.sha = b.sha; j.subject = b.subject;
    await this.trienKhai(j, b, log);
  }

  // Nạp một tệp SQL của commit vào CSDL đang chạy (git show | kubectl exec psql)
  private async napTep(sha: string, path: string, extra: string[], log: Log) {
    const cmd = this.psql("", [...extra, "-f", "-"]);
    await act(log, `nạp ${path} @${sha.slice(0, 7)} vào CSDL`, async () => {
      const body = Bun.spawn(["git", "-C", this.repo.dir, "show", `${sha}:${path}`], { stdout: "pipe", stderr: "pipe" });
      const r = await this.kc(cmd, { stdin: body.stdout, onLine: (l) => { if (!/^(INSERT|UPDATE|CREATE|ALTER|COMMENT|DO|SET)\b/.test(l)) log(l); } });
      if ((await body.exited) !== 0) throw new Error(`git show ${path} lỗi`);
      if (r.code !== 0) throw new Error(`Nạp ${path} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
    }, [["git", "show", `${sha}:${path}`], ["kubectl", "-n", this.cfg.ns, ...cmd]]);
  }
  private psql = (sql: string, extra: string[] = []) =>
    ["exec", "-i", "db-0", "--", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", this.cfg.dbUser, "-d", this.cfg.dbName, ...extra, ...(sql ? ["-c", sql] : [])];

  private async trienKhai(j: Job, b: Build, log: Log) {
    const { ns, site, dbUser, dbName } = this.cfg, A = this.ANN;
    const truoc = await this.cum(true);
    if (!truoc.ok) throw new Error(truoc.error ?? "Không đọc được trạng thái cụm");
    j.notify = { phienBan: b.tag, tu: truoc.sha, den: b.sha };
    const app = `${this.cfg.imgApp}:${b.tag}`, db = `${this.cfg.imgDb}:${b.tag}`;
    const resetDb = j.opts?.resetDb === true;
    log(""); log(`══ Triển khai ${b.tag} lên ${ns} (đang chạy: ${truoc.tag ?? "?"})`);

    // --- CSDL ---
    const schemaDoi = truoc.schema !== b.schema;
    if (schemaDoi && !resetDb)
      throw new Error(`database/schema.sql của ${b.tag} khác CSDL đang chạy${truoc.schema ? "" : " (chưa ghi băm)"}. Dự án không có migration: phải chọn "Làm lại CSDL" (mất dữ liệu staging).`);
    const seedDoi = truoc.seed !== b.seed;
    // Ảnh db chỉ dùng khi volume trống (lần đầu); chỉ đổi khi schema/seed đổi để khỏi khởi động lại Postgres mỗi lượt.
    if (schemaDoi || seedDoi) {
      log(`══ StatefulSet db → ${db}`);
      await this.kw(log, `set image sts/db ${db}`, ["set", "image", "sts/db", `postgres=${db}`]);
      if (!PREVIEW) await this.kcMust(["rollout", "status", "sts/db", "--timeout=300s"], { onLine: log });
    }
    if (!PREVIEW) await this.kcMust(["wait", "--for=condition=Ready", "pod/db-0", "--timeout=180s"], { onLine: log });
    if (schemaDoi) {
      log(`══ LÀM LẠI CSDL ${dbName}: xoá schema public, chạy schema.sql + seed.sql của ${b.sha.slice(0, 7)}`);
      await this.kw(log, "scale deploy/app về 0", ["scale", "deploy/app", "--replicas=0"]);
      try {
        await this.kw(log, "xoá schema public", this.psql(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ${dbUser};`));
        await this.napTep(b.sha, "database/schema.sql", [], log);
        await this.napTep(b.sha, "database/seed.sql", [], log);
        log("CSDL đã làm lại từ schema.sql + seed.sql.");
      } finally { await this.kw(log, "scale deploy/app về 1", ["scale", "deploy/app", "--replicas=1"]); }
    } else if (seedDoi) {
      log(`══ seed.sql đổi → nạp lại seed.sql (idempotent, một transaction)`);
      await this.napTep(b.sha, "database/seed.sql", ["-1"], log);
    } else log("CSDL: schema.sql và seed.sql không đổi.");
    await this.kw(log, "ghi băm schema/seed", ["annotate", "--overwrite", "sts/db", `${A}/schema=${b.schema}`, `${A}/seed=${b.seed}`]);

    // --- App ---
    log(""); log(`══ Deployment app → ${app}`);
    const now = new Date().toISOString();
    await this.kw(log, `set image deploy/app ${app}`, ["set", "image", "deploy/app", `app=${app}`, `wait-db=${db}`]);
    await this.kw(log, "ghi người/commit triển khai", ["annotate", "--overwrite", "deploy/app", `${A}/sha=${b.sha}`, `${A}/by=${j.user.replace(/[^\p{L}\p{N} ._()-]/gu, "")}`, `${A}/at=${now}`]);
    this.cumCache = null;
    if (PREVIEW) { log("[THỬ] bỏ qua theo dõi rollout và kiểm /health."); return; }
    const ro = await this.kc(["rollout", "status", "deploy/app", "--timeout=300s"], { onLine: log });
    if (ro.code !== 0) {
      log("⚠ Rollout không lành, quay lui Deployment app về bản trước…");
      await act(log, "rollout undo deploy/app", () => this.kc(["rollout", "undo", "deploy/app"], { onLine: log }));
      if (truoc.sha) await this.kc(["annotate", "--overwrite", "deploy/app", `${A}/sha=${truoc.sha}`]);
      throw new Error(`Rollout ${b.tag} không lành sau 5 phút, đã rollout undo về ${truoc.tag}.${schemaDoi ? " CSDL đã làm lại theo schema mới, bản cũ có thể lỗi." : ""}`);
    }
    let h = { ok: false, code: 0, text: "" };
    for (let lan = 0; lan < 6 && !h.ok; lan++) {
      if (lan) await Bun.sleep(5000);
      h = await fetch(`${site}/health`, { signal: AbortSignal.timeout(10_000) }).then(async (x) => ({ ok: x.ok, code: x.status, text: (await x.text()).slice(0, 200) }), (e) => ({ ok: false, code: 0, text: String(e?.message ?? e) }));
    }
    if (!h.ok) throw new Error(`Đã đổi bản nhưng ${site}/health không ok: ${h.code} ${h.text}`);
    log(`${site}/health: ok.`);
    appendFileSync(this.HIST, `${now}\t${b.tag}\t${schemaDoi ? "lam-lai" : seedDoi ? "nap-seed" : "giu"}\t${j.user}\n`);
    this.cumCache = null;
  }
}
