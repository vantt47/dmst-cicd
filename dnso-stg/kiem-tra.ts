// Kiểm tra (CI) một commit của DNSO (KHCN-Thanh-Hoa/doanhnghiepso) trước khi cho Build/triển khai lên staging DMST_05.
//
// Chạy trong container Docker dùng một lần (ảnh ci/Dockerfile: đúng bản Bun của app/Dockerfile + Node thật), KHÔNG chạy
// trên PC: mã của nhánh bất kỳ không đọc được secrets.json, khóa SSH. Mã nạp bằng `git archive <sha>` CẢ KHO (kiểm thử
// đọc ke-hoach/, trien-khai/, .do/), không mount thư mục của PC. Volume dnsoci-bun-cache giữ bộ nhớ đệm bun.
//
// CSDL kiểm thử: một container postgres:16 dùng CHUNG mạng với container kiểm tra, nghe 127.0.0.1:5435 với đúng tài
// khoản của dịch vụ `postgres-kiem-thu` trong app/docker-compose.yml (kiem-thu/chung/nap-moi-truong.ts trỏ vào đó),
// chạy trên tmpfs. `bun run kiem-thu:csdl` dựng lược đồ bằng chính scripts/migrate.ts.
//
// Các bước lấy từ CLAUDE.md của kho DNSO: `bun run typecheck`, `bun run kiem-thu:don-vi` (tầng 1 + quét tầng 4 + tự kiểm
// tầng 5), `bun run kiem-thu:ten-mien` (định tuyến tên miền) và `bun run build` (bước duy nhất bắt được mã máy chủ lọt
// vào bundle client). Thêm/bớt bước thì sửa GROUPS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type StepStatus = "pending" | "running" | "ok" | "warn" | "failed" | "skipped";
type StepDef = { name: string; sh: string; allowFail?: boolean; timeoutMin?: number; retry?: number };
type GroupDef = { key: string; label: string; steps: StepDef[] };

const APP = "/w/app";
// Nhóm đầu chạy trước (cài đặt); các nhóm sau chạy song song trên cùng node_modules.
export const GROUPS: GroupDef[] = [
  { key: "cai-dat", label: "Cài đặt", steps: [
    // Mạng chập chờn làm bun install lỗi giữa chừng (đã gặp khi dựng ảnh): thử lại một lần.
    { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", retry: 1 },
    { name: "Dựng CSDL kiểm thử (kiem-thu:csdl → scripts/migrate.ts)", sh: "bun run kiem-thu:csdl", timeoutMin: 15 },
  ] },
  { key: "typecheck", label: "Typecheck", steps: [{ name: "bun run typecheck", sh: "bun run typecheck", timeoutMin: 15 }] },
  { key: "kiem-thu", label: "Kiểm thử", steps: [
    { name: "kiem-thu:don-vi (tầng 1 + quét tầng 4 + tự kiểm tầng 5)", sh: "bun run kiem-thu:don-vi", timeoutMin: 20 },
    { name: "kiem-thu:ten-mien (định tuyến tên miền)", sh: "bun run kiem-thu:ten-mien", timeoutMin: 5 },
  ] },
  { key: "build", label: "Build", steps: [{ name: "bun run build", sh: "bun run build", timeoutMin: 15 }] },
];

export type CheckRun = {
  id: string; sha: string; ref: string; subject: string; user: string;
  status: "queued" | "running" | "ok" | "failed";
  created: string; started?: string; ended?: string; error?: string;
  groups: { key: string; label: string; status: StepStatus; steps: { name: string; status: StepStatus; ms?: number }[] }[];
  log: string[];
  auto?: boolean; superseded?: boolean; // auto: tự chạy khi có push; superseded: nhánh có commit mới trước khi tới lượt
};
export const newCheck = (o: { id: string; sha: string; ref: string; subject: string; user: string }): CheckRun => ({
  ...o, status: "queued", created: new Date().toISOString(), log: [],
  groups: GROUPS.map((g) => ({ key: g.key, label: g.label, status: "pending", steps: g.steps.map((s) => ({ name: s.name, status: "pending" })) })),
});

type Run = (cmd: string[], o?: { onLine?: (l: string) => void; quiet?: boolean }) => Promise<{ code: number; out: string }>;
type Deps = { run: Run; repo: string; log: (l: string) => void; changed: () => void };

const DOCKER_DIR = join(import.meta.dir, "ci");
const PG_IMAGE = "postgres:16-alpine"; // trùng postgres-kiem-thu trong app/docker-compose.yml
const IMAGE = "dnsoci:" + createHash("sha256").update(readFileSync(join(DOCKER_DIR, "Dockerfile"))).digest("hex").slice(0, 12);

export async function runCheck(c: CheckRun, d: Deps) {
  const { run, log } = d;
  const must = async (cmd: string[], what: string, quiet = false) => {
    const r = await run(cmd, quiet ? { quiet: true } : { onLine: log });
    if (r.code !== 0) throw new Error(`${what} lỗi (mã ${r.code})${quiet ? ": " + r.out.trim().split("\n").slice(-3).join(" ") : ""}`);
  };
  if ((await run(["docker", "image", "inspect", IMAGE], { quiet: true })).code !== 0) {
    log(`══ Build ảnh môi trường kiểm tra ${IMAGE} (lần đầu hoặc ci/Dockerfile đổi)…`);
    await must(["docker", "build", "--progress=plain", "-t", IMAGE, DOCKER_DIR], "Build ảnh kiểm tra");
  }
  const name = `dnsoci-${c.id}`;
  log(`══ Tạo container ${name} (${IMAGE}), nạp mã commit ${c.sha.slice(0, 7)}`);
  await must(["docker", "run", "-d", "--rm", "--name", name, "--cpus", "10", "--memory", "12g",
    "-v", "dnsoci-bun-cache:/root/.bun/install/cache", IMAGE], "docker run", true);
  const pg = `${name}-pg`;
  try {
    await must(["docker", "run", "-d", "--rm", "--name", pg, "--network", `container:${name}`, "--memory", "2g",
      "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=cds_kiem_thu_pass", "-e", "POSTGRES_DB=cds_kiem_thu",
      "-e", "TZ=Asia/Ho_Chi_Minh", "-e", "PGTZ=Asia/Ho_Chi_Minh", "--tmpfs", "/var/lib/postgresql/data",
      PG_IMAGE, "-c", "port=5435", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"], "Chạy CSDL kiểm thử", true);
    const ga = Bun.spawn(["git", "-C", d.repo, "archive", "--format=tar", c.sha], { stdout: "pipe", stderr: "pipe" });
    const tx = Bun.spawn(["docker", "exec", "-i", name, "tar", "-x", "-C", "/w"], { stdin: ga.stdout, stdout: "pipe", stderr: "pipe" });
    const [gaCode, txCode] = await Promise.all([ga.exited, tx.exited]);
    if (gaCode || txCode) throw new Error(`Nạp mã vào container lỗi: ${(await new Response(ga.stderr).text()) + (await new Response(tx.stderr).text())}`.trim());
    // Một số phép quét đọc lịch sử/trạng thái git
    await must(["docker", "exec", "-w", "/w", name, "sh", "-c", "git init -q && git add -A && git commit -q -m src"], "git init trong container", true);

    const runGroup = async (g: GroupDef, gs: CheckRun["groups"][number]) => {
      gs.status = "running"; d.changed();
      let failed = false, warned = false;
      for (const [i, s] of g.steps.entries()) {
        const st = gs.steps[i];
        if (failed) { st.status = "skipped"; continue; }
        st.status = "running"; d.changed();
        const t0 = Date.now();
        const lg = (l: string) => log(`[${g.key}] ${l}`);
        let r = { code: 1, out: "" };
        for (let lan = 0; lan <= (s.retry ?? 0); lan++) {
          lg(`▶ ${s.name}${lan ? ` (thử lại lần ${lan})` : ""}`);
          r = await run(["docker", "exec", "-w", APP, "-e", "CI=true", name, "timeout", String((s.timeoutMin ?? 20) * 60), "sh", "-c", s.sh], { onLine: lg });
          if (r.code === 0) break;
        }
        st.ms = Date.now() - t0;
        if (r.code === 0) { st.status = "ok"; lg(`✔ ${s.name} (${Math.round(st.ms / 1000)} giây)`); }
        else if (s.allowFail) { st.status = "warn"; warned = true; lg(`⚠ ${s.name} lỗi (mã ${r.code}), không chặn`); }
        else { st.status = "failed"; failed = true; lg(`✘ ${s.name} lỗi (mã ${r.code}${r.code === 124 ? ", quá thời gian" : ""})`); }
        d.changed();
      }
      gs.status = failed ? "failed" : warned ? "warn" : "ok"; d.changed();
    };
    await runGroup(GROUPS[0], c.groups[0]);
    if (c.groups[0].status === "failed") {
      for (const gs of c.groups.slice(1)) { gs.status = "skipped"; for (const s of gs.steps) s.status = "skipped"; }
    } else {
      await Promise.all(GROUPS.slice(1).map((g, i) => runGroup(g, c.groups[i + 1])));
    }
    const bad = c.groups.filter((g) => g.status === "failed").map((g) => g.label);
    if (bad.length) throw new Error(`Kiểm tra không qua: ${bad.join(", ")}`);
  } finally {
    await run(["docker", "rm", "-f", pg], { quiet: true });
    await run(["docker", "rm", "-f", name], { quiet: true });
  }
}
