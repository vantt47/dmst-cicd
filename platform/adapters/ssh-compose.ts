// Adapter `ssh-compose` (DNSO staging trên DMST_05, chuyển từ dnso-stg/server.ts). Máy staging chỉ nhận ảnh dựng sẵn
// (quy ước: máy chủ không dựng ảnh):
//   Build: dựng hai đích `web`, `worker` của app/Dockerfile từ `git archive <sha>:app` (không lấy tệp chưa commit, không
//          lấy bí mật của PC), thẻ = 8 ký tự đầu sha → `docker save | ssh <máy> docker load` → chép bộ `trien-khai/` của
//          CHÍNH commit đó vào remoteDir (tệp `.env*` không nằm trong git nên không bị đè), dựng ảnh cổng vào nếu
//          Dockerfile.caddy đổi → `trien-khai.sh <thẻ>`: migrate → dựng màu web đang tắt → chờ lành → dừng êm màu cũ →
//          dựng lại worker. Sau đó kiểm /suc-khoe qua cổng vào và dọn ảnh cũ (giữ keepTags thẻ để quay lui).
//   Đổi bản: chạy lại một thẻ còn trên máy staging (quay lui; migrate chỉ khi người bấm chọn, tuỳ chọn `migrate`).
// Bản xem trước (PREVIEW): chỉ đọc trạng thái thật qua SSH; dựng ảnh, chuyển ảnh, chép tệp, triển khai, restart chỉ ghi
// lệnh ra log.
import { createHash } from "node:crypto";
import { act, must, pipe, run, shq, PREVIEW, type Log, type RunOpts } from "../lib";
import type { Repo } from "../repo";
import { busyJobs, checkOf, type Job } from "../queue";
import type { EnvAdapter, JobOption } from "./types";

export type SshComposeCfg = {
  kind: "ssh-compose";
  sshHost: string;        // alias trong ~/.ssh/config của user Windows (DMST_05)
  remoteDir: string;      // /opt/dnso-staging
  site: string;           // trang staging, cũng là host kiểm /suc-khoe sau triển khai
  keepTags: number;       // số thẻ ảnh giữ trên máy staging để quay lui
  requireCi: boolean;     // Build phải có CI đạt (trừ khi bỏ qua chặn)
  legacyJobsDir?: string; // trang cũ chỉ lưu log .log (không có siêu dữ liệu job) nên không đọc; lịch sử lấy từ máy staging
  imagePrefix?: string;   // tên ảnh <prefix>-web, <prefix>-worker, <prefix>-cong-vao (mặc định "dnso")
};

// Dịch vụ compose trên máy staging. Web có hai màu, chỉ một màu chạy (trien-khai/compose.yml).
const SERVICES = [
  { key: "web", label: "Web", note: "web-xanh / web-luc, đổi màu khi triển khai", restart: false, defaultBuild: true },
  { key: "worker", label: "Worker", note: "tác vụ nền + lịch định kỳ (một bản duy nhất)", restart: true, defaultBuild: true },
  { key: "postgres", label: "PostgreSQL 18", note: "CSDL staging, vai trò erp / cds_app như prod", restart: false },
  { key: "redis", label: "Valkey", note: "hàng đợi BullMQ", restart: false },
  { key: "cong-vao", label: "Cổng vào (Caddy)", note: "cân tải hai màu web", restart: true },
  { key: "cloudflared", label: "Cloudflare Tunnel", note: "stg-dmst-dnso.dmst.vn (+ dmst / az / nen-tang.senow.tech)", restart: true },
  { key: "autoheal", label: "Autoheal", note: "khởi động lại container unhealthy", restart: false },
];
const TAG_HEX = /^[0-9a-f]{7,40}$/;
const tagFor = (sha: string) => sha.slice(0, 8);

type Container = { name: string; state: string; health: string; status: string; image: string };
type May = {
  ok: boolean; error: string | null; phienBan: string | null; subject: string | null; mau: string | null;
  services: (typeof SERVICES[number] & { containers: Container[] })[];
  sucKhoe: any; lichSu: { luc: string; the: string; mau: string; subject: string | null }[]; luc: string;
};

export class SshComposeAdapter implements EnvAdapter {
  kind = "ssh-compose";
  services = SERVICES.map((s) => ({ key: s.key, label: s.label, defaultBuild: (s as any).defaultBuild }));
  wholeRelease = true;
  options: JobOption[] = [{ key: "migrate", on: "deploy" }];
  private SSH: string[];
  private RD: string;
  private siteHost: string;
  private img: string;
  private cache: { at: number; p: Promise<May> } | null = null;
  constructor(public project: string, public cfg: SshComposeCfg, public repo: Repo, _root: string) {
    // BatchMode: không bao giờ treo chờ nhập mật khẩu
    this.SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", cfg.sshHost];
    this.RD = shq(cfg.remoteDir);
    this.siteHost = new URL(cfg.site).host;
    this.img = cfg.imagePrefix ?? "dnso";
  }
  start() {}
  private ssh = (script: string, o: RunOpts = {}) => run([...this.SSH, script], o);
  private sshMust = (script: string, o: RunOpts = {}) => must([...this.SSH, script], o);
  private sshCmd = (script: string) => [...this.SSH, script];

  // ---------------- Máy staging ----------------
  // Một lệnh SSH lấy toàn bộ trạng thái, đệm 8 giây (trình duyệt hỏi 5 giây/lần)
  private may(force = false): Promise<May> {
    if (!force && this.cache && Date.now() - this.cache.at < 8000) return this.cache.p;
    const empty = () => ({ phienBan: null, subject: null, mau: null, services: [], sucKhoe: null, lichSu: [], luc: new Date().toISOString() });
    const p = (async (): Promise<May> => {
      const r = await this.ssh(`cd ${this.RD} && echo "@@ENV" && grep -E '^PHIEN_BAN(_XANH|_LUC)?=' .env; echo "@@PS" && docker compose ps -a --format json; echo "@@LS" && tail -n 30 lich-su-trien-khai.log 2>/dev/null; echo "@@SK" && curl -sk -m 8 --resolve ${this.siteHost}:443:127.0.0.1 https://${this.siteHost}/suc-khoe; echo`, { quiet: true });
      if (r.code !== 0) return { ok: false, error: `Không SSH được tới ${this.cfg.sshHost} (Tailscale trên PC?): ${r.out.trim().split("\n").slice(-2).join(" ")}`, ...empty() };
      const part = (k: string) => (r.out.split(`@@${k}\n`)[1] ?? "").split(/\n@@[A-Z]+\n/)[0];
      const env = Object.fromEntries(part("ENV").trim().split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
      const ps = part("PS").trim().split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const running = ps.filter((c: any) => c.State === "running").map((c: any) => c.Service as string);
      const mau = running.includes("web-xanh") ? "xanh" : running.includes("web-luc") ? "luc" : null;
      const phienBan = env.PHIEN_BAN ?? null;
      let sucKhoe: any = null;
      const sk = part("SK").trim();
      try { sucKhoe = JSON.parse(sk); } catch { sucKhoe = sk ? { trangThai: "loi", raw: sk.slice(0, 200) } : null; }
      const services = SERVICES.map((s) => ({
        ...s,
        // Web: màu đang chạy; không màu nào chạy thì hiện cả hai
        containers: ps.filter((c: any) => (s.key === "web" ? /^web-(xanh|luc)$/.test(c.Service) : c.Service === s.key))
          .filter((c: any) => s.key !== "web" || c.State === "running" || ps.every((x: any) => !/^web-/.test(x.Service) || x.State !== "running"))
          .map((c: any) => ({ name: c.Service, state: c.State, health: c.Health ?? "", status: c.Status, image: c.Image })),
      }));
      const lichSu = [];
      for (const l of part("LS").trim().split("\n").filter(Boolean).reverse()) {
        const [d, t, the, mauX] = l.split(/\s+/);
        lichSu.push({ luc: `${d}T${t}+07:00`, the, mau: mauX, subject: TAG_HEX.test(the) ? await this.repo.subject(the) : null });
      }
      return { ok: true, error: null, phienBan, subject: phienBan ? await this.repo.subject(phienBan) : null, mau, services, sucKhoe, lichSu, luc: new Date().toISOString() };
    })().catch((e) => ({ ok: false, error: String(e?.message ?? e), ...empty() }));
    this.cache = { at: Date.now(), p };
    return p;
  }

  async state() {
    const m = await this.may();
    const { services, ...may } = m;
    return { sshHost: this.cfg.sshHost, remoteDir: this.cfg.remoteDir, site: this.cfg.site, may, services, requireCi: this.cfg.requireCi };
  }
  async currentSha() { return (await this.may(true)).phienBan; }
  async summary() {
    const m = await this.may();
    if (!m.ok) return { ok: false, text: m.error ?? "Không đọc được máy staging" };
    const bad = m.services.filter((s) => !s.containers.length || s.containers.some((c) => c.state !== "running" || c.health === "unhealthy"));
    if (m.sucKhoe?.trangThai !== "ok") return { ok: false, text: "/suc-khoe qua cổng vào không ok" };
    if (bad.length) return { ok: false, text: `Lỗi: ${bad.map((s) => s.label).join(", ")}` };
    return { ok: true, text: `Bản ${m.phienBan ?? "?"}${m.mau ? ` · web-${m.mau}` : ""} · ${this.cfg.sshHost}` };
  }
  async history() {
    const m = await this.may();
    return m.lichSu.map((x) => ({ ...x, url: TAG_HEX.test(x.the) ? this.repo.commitUrl(x.the) : null }));
  }
  // Thẻ còn trên máy staging (có đủ web + worker)
  async tags(_svc: string) {
    const r = await this.sshMust(`docker image ls ${this.img}-web --format '{{.Tag}}|{{.CreatedAt}}'; echo @@; docker image ls ${this.img}-worker --format '{{.Tag}}'; echo @@; grep -E '^PHIEN_BAN=' ${this.RD}/.env | cut -d= -f2`, { quiet: true });
    const [web = "", worker = "", cur = ""] = r.split("@@\n");
    const coWorker = new Set(worker.trim().split("\n"));
    const out = [];
    for (const l of web.trim().split("\n").filter(Boolean)) {
      const [tag, created = ""] = l.split("|");
      if (!coWorker.has(tag) || tag === "<none>" || tag === "moi-nhat") continue;
      out.push({ tag, created: created.replace(/ \+\d{4} \+\d+$| [A-Z]+$/, ""), subject: TAG_HEX.test(tag) ? await this.repo.subject(tag) : null, dangChay: tag === cur.trim() });
    }
    return out;
  }
  async logs(q: URLSearchParams) {
    const s = SERVICES.find((x) => x.key === q.get("svc"));
    if (!s) throw new Error("Dịch vụ không hợp lệ");
    const m = await this.may();
    const svc = s.key === "web" ? (m.mau ? `web-${m.mau}` : "web-xanh web-luc") : s.key;
    const r = await this.ssh(`cd ${this.RD} && docker compose logs --no-color --timestamps --tail 400 ${svc} 2>&1`, { quiet: true });
    return { svc, text: r.out };
  }
  async restart(key: string, who: string) {
    const s = SERVICES.find((x) => x.key === key && x.restart);
    if (!s) throw new Error("Dịch vụ này không khởi động lại được từ trang này");
    if (busyJobs(this.project)) throw new Error("Đang có việc build/triển khai, đợi xong rồi khởi động lại");
    await act(() => {}, `restart ${s.key}`, () => this.sshMust(`cd ${this.RD} && docker compose restart ${s.key}`, { quiet: true }));
    console.log(`${new Date().toISOString()} [${who}] ${PREVIEW ? "[THỬ] " : ""}restart ${this.project} ${s.key}`);
    this.cache = null;
  }

  // ---------------- Job ----------------
  // Dựng ảnh từ git archive (ngữ cảnh qua stdin). Mạng chập chờn làm `bun install` trong Dockerfile lỗi: thử lại một lần.
  private async dockerBuild(ctx: string, target: string | null, ref: string, sha: string, user: string, log: Log, file?: string) {
    const cmd = ["docker", "build", "--progress=plain", "-t", ref, "--label", `org.opencontainers.image.revision=${sha}`, "--label", `vn.dmst.cicd.by=${user}`];
    if (target) cmd.push("--target", target);
    if (file) cmd.push("-f", file);
    cmd.push("-");
    const archive = ["git", "-C", this.repo.dir, "archive", "--format=tar", `${sha}:${ctx}`];
    await act(log, `Dựng ${ref}`, async () => {
      for (let lan = 1; lan <= 2; lan++) {
        const t0 = Date.now();
        try {
          await pipe(archive, cmd, (l) => { if (!/^#\d+ (sha256|extracting|transferring)|^#\d+ \d+\.\d+ (Downloading|Extracting)/.test(l)) log(l); });
          log(`Dựng ${ref} xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
          return;
        } catch (e: any) {
          if (lan === 2) throw e;
          log(`⚠ Dựng ${ref} lỗi (${e.message}), thử lại một lần…`);
        }
      }
    }, [archive, cmd]);
  }
  private hasRelease = async (tag: string) =>
    (await this.ssh(`docker image inspect ${this.img}-web:${tag} ${this.img}-worker:${tag} >/dev/null 2>&1`, { quiet: true })).code === 0;

  async build(j: Job, log: Log) {
    await this.repo.ensure(log);
    log("Lấy mã mới từ GitHub…");
    await this.repo.fetch(true);
    const sha = j.sha!;
    const ck = checkOf(j.project, sha);
    if (j.bypass) log(`⚠ BỎ QUA CHẶN (khẩn cấp, ${j.user}, lý do: ${j.reason ?? "?"}): CI ${ck?.status === "ok" ? "đã đạt" : "chưa đạt/chưa chạy"}.`);
    else if (this.cfg.requireCi && ck?.status !== "ok") throw new Error(`Commit ${sha.slice(0, 7)} chưa qua kiểm tra (CI)`);
    if (ck?.status === "ok") log(`Kiểm tra (CI) đạt lúc ${ck.ended} (lượt ${ck.id}).`);
    const tag = tagFor(sha);
    for (const s of this.services.filter((x) => x.defaultBuild)) j.tags[s.key] = tag;
    log(`Commit ${sha.slice(0, 7)}: ${j.subject}`);
    if (j.deploy) {
      const truoc = (await this.may(true)).phienBan;
      j.notify = { phienBan: tag, tu: await this.repo.resolveSha(truoc), den: sha };
    }

    if (await this.hasRelease(tag)) log(`Máy staging đã có ${this.img}-web:${tag} và ${this.img}-worker:${tag}, bỏ qua dựng ảnh.`);
    else {
      for (const target of ["web", "worker"]) {
        log(""); log(`══ Dựng ${this.img}-${target}:${tag}`);
        await this.dockerBuild("app", target, `${this.img}-${target}:${tag}`, sha, j.user, log);
      }
      log(""); log(`══ Chuyển ảnh sang ${this.cfg.sshHost} (docker save | ssh docker load)…`);
      const save = ["docker", "save", `${this.img}-web:${tag}`, `${this.img}-worker:${tag}`];
      const load = [...this.SSH.slice(0, -1), "-C", this.cfg.sshHost, "docker load"];
      const t0 = Date.now();
      await act(log, "Chuyển ảnh", () => pipe(save, load, log), [save, load]);
      log(`Chuyển xong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
      if (!PREVIEW) for (const t of ["web", "worker"]) await run(["docker", "image", "rm", `${this.img}-${t}:${tag}`], { quiet: true });
    }
    if (!j.deploy) { log(`Chỉ build, không triển khai. Thẻ ${tag} đã có trên ${this.cfg.sshHost}, dùng "Đổi bản" để chạy.`); return; }
    await this.syncDeployKit(sha, j.user, log);
    await this.trienKhai(tag, true, log);
  }

  async deploy(j: Job, log: Log) {
    await this.repo.ensure(log);
    await this.repo.fetch(true);
    const tag = Object.values(j.tags)[0] ?? j.ref;
    if (!TAG_HEX.test(tag)) throw new Error(`Thẻ ${tag} không hợp lệ (thẻ DNSO = 8 ký tự đầu của sha)`);
    if (!(await this.hasRelease(tag))) throw new Error(`Máy staging không còn ảnh ${this.img}-web:${tag} / ${this.img}-worker:${tag}`);
    j.subject ??= (await this.repo.subject(tag)) ?? undefined;
    const truoc = (await this.may(true)).phienBan;
    j.notify = { phienBan: tag, tu: await this.repo.resolveSha(truoc), den: await this.repo.resolveSha(tag) };
    await this.trienKhai(tag, j.opts?.migrate === true, log);
  }

  // Bộ triển khai trien-khai/ của commit được triển khai → remoteDir. Commit cũ chưa có thư mục này thì giữ bản trên máy.
  private async syncDeployKit(sha: string, user: string, log: Log) {
    log(""); log("══ Đồng bộ bộ triển khai (trien-khai/)");
    if ((await run(["git", "-C", this.repo.dir, "cat-file", "-e", `${sha}:trien-khai/compose.yml`], { quiet: true })).code !== 0) {
      log("Commit này chưa có trien-khai/compose.yml, giữ bộ triển khai đang có trên máy.");
      return;
    }
    // Chỉ tệp đã commit; .env* nằm trong .gitignore nên không bao giờ bị đè.
    const archive = ["git", "-C", this.repo.dir, "archive", "--format=tar", `${sha}:trien-khai`];
    const untar = this.sshCmd(`cd ${this.RD} && tar -x --no-same-owner -f - && chmod +x trien-khai.sh && echo "Đã chép: $(ls -1 | tr '\\n' ' ')"`);
    await act(log, `Chép trien-khai/ của ${sha.slice(0, 7)} vào ${this.cfg.remoteDir}`, () => pipe(archive, untar, log), [archive, untar]);
    // Ảnh cổng vào: thẻ theo băm Dockerfile.caddy, dựng khi máy chưa có.
    const dockerfile = await this.repo.git(["show", `${sha}:trien-khai/Dockerfile.caddy`], { quiet: true });
    const cv = createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
    if ((await this.ssh(`docker image inspect ${this.img}-cong-vao:${cv} >/dev/null 2>&1`, { quiet: true })).code !== 0) {
      log(`Dockerfile.caddy đổi → dựng ${this.img}-cong-vao:${cv}`);
      await this.dockerBuild("trien-khai", null, `${this.img}-cong-vao:${cv}`, sha, user, log, "Dockerfile.caddy");
      const save = ["docker", "save", `${this.img}-cong-vao:${cv}`], load = this.sshCmd("docker load");
      await act(log, "Chuyển ảnh cổng vào", () => pipe(save, load, log), [save, load]);
      if (!PREVIEW) await run(["docker", "image", "rm", `${this.img}-cong-vao:${cv}`], { quiet: true });
    }
    const setEnv = `cd ${this.RD} && if grep -q '^PHIEN_BAN_CONG_VAO=' .env; then sed -i 's|^PHIEN_BAN_CONG_VAO=.*|PHIEN_BAN_CONG_VAO=${cv}|' .env; else echo PHIEN_BAN_CONG_VAO=${cv} >> .env; fi`;
    await act(log, `Ghi PHIEN_BAN_CONG_VAO=${cv} vào .env`, () => this.sshMust(setEnv), [this.sshCmd(setEnv)]);
  }

  private async trienKhai(tag: string, migrate: boolean, log: Log) {
    log(""); log(`══ Triển khai ${tag} trên ${this.cfg.sshHost} (${migrate ? "có migrate" : "bỏ qua migrate"})`);
    const cmd = this.sshCmd(`cd ${this.RD} && ./trien-khai.sh ${tag}${migrate ? "" : " --bo-qua-migrate"} </dev/null 2>&1`);
    this.cache = null;
    if (PREVIEW) {
      await act(log, `trien-khai.sh ${tag}`, async () => {}, [cmd]);
      log("[THỬ] bỏ qua kiểm /suc-khoe và dọn ảnh cũ.");
      return;
    }
    const r = await run(cmd, { onLine: (l) => { if (!/^\s*(Container|[0-9a-f]{12} (Pull|Download|Extract|Verif|Waiting))/.test(l)) log(l); } });
    this.cache = null;
    if (r.code !== 0) throw new Error(`trien-khai.sh lỗi (mã ${r.code}), xem log phía trên. Màu web cũ vẫn phục vụ nếu màu mới không lành.`);
    // Kiểm qua cổng vào thật (Caddy) như người dùng, không qua tunnel để khỏi phụ thuộc DNS
    const sk = await this.ssh(`curl -sk -m 15 --resolve ${this.siteHost}:443:127.0.0.1 https://${this.siteHost}/suc-khoe`, { quiet: true });
    let tt = "";
    try { tt = JSON.parse(sk.out).trangThai; } catch {}
    if (tt !== "ok") throw new Error(`Đã đổi bản nhưng /suc-khoe qua cổng vào không "ok": ${sk.out.trim().slice(0, 300)}`);
    log(`/suc-khoe qua cổng vào: ok.`);
    // Dọn thẻ cũ, giữ keepTags thẻ gần nhất (theo lịch sử triển khai) để quay lui
    await this.ssh(`cd ${this.RD} && giu=$( (grep -E '^PHIEN_BAN(_XANH|_LUC)?=' .env | cut -d= -f2; awk '{print $3}' lich-su-trien-khai.log | tac | awk '!a[$0]++' | head -n ${this.cfg.keepTags}) | sort -u); for r in ${this.img}-web ${this.img}-worker; do docker image ls $r --format '{{.Tag}}' | while read t; do echo "$giu" | grep -qx "$t" || docker image rm -f "$r:$t" >/dev/null 2>&1; done; done; docker image prune -f >/dev/null 2>&1; true`, { quiet: true });
  }
}
