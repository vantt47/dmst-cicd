// Kiểm tra (CI) một commit của thi-vien-chuc (KHCN-Thanh-Hoa/thi-vien-chuc) trước khi cho Build/triển khai lên staging.
//
// Chạy trong container Docker dùng một lần (ảnh ci/Dockerfile: node:20 như Dockerfile.uat + git, openssl, psql), KHÔNG
// chạy trên PC: mã của nhánh bất kỳ không đọc được secrets.json, kubeconfig, đăng nhập GHCR. Mã nạp bằng
// `git archive <sha>` cả kho, không mount thư mục của PC. Volume tvcci-npm-cache giữ bộ nhớ đệm npm.
//
// CSDL kiểm thử: container postgres:16-alpine (cùng bản với Dockerfile.db) chung mạng với container kiểm tra, chạy trên
// tmpfs. Staging dựng CSDL bằng chính database/schema.sql + seed.sql, nên hai tệp này phải chạy sạch (ON_ERROR_STOP).
// seed.sql được chạy lần hai để xác nhận idempotent: khi chỉ seed.sql đổi, tvc-stg nạp lại seed.sql lên CSDL staging đang
// chạy thay vì làm lại CSDL.
//
// Các nhóm chạy song song. Bước theo AGENTS.md của kho: `npm run build` của backend (sau `npx prisma generate`) và frontend.
// candidate-frontend chưa được đóng gói vào ảnh staging nên chỉ cảnh báo, không chặn. Thêm/bớt bước thì sửa GROUPS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type StepStatus = "pending" | "running" | "ok" | "warn" | "failed" | "skipped";
type StepDef = { name: string; sh: string; cwd?: string; allowFail?: boolean; timeoutMin?: number; retry?: number };
type GroupDef = { key: string; label: string; steps: StepDef[] };

const NPM_CI = "npm ci --no-audit --no-fund --loglevel=error";
export const GROUPS: GroupDef[] = [
  { key: "csdl", label: "CSDL", steps: [
    { name: "Chờ CSDL kiểm thử", sh: "for i in $(seq 1 60); do pg_isready -q && exit 0; sleep 1; done; exit 1", timeoutMin: 2 },
    { name: "database/schema.sql", sh: "psql -v ON_ERROR_STOP=1 -q -f database/schema.sql", timeoutMin: 5 },
    { name: "database/seed.sql", sh: "psql -v ON_ERROR_STOP=1 -q -f database/seed.sql", timeoutMin: 5 },
    { name: "seed.sql lần 2 (idempotent)", sh: "psql -v ON_ERROR_STOP=1 -q -1 -f database/seed.sql", timeoutMin: 5, allowFail: true },
  ] },
  { key: "backend", label: "Backend", steps: [
    { name: "npm ci", sh: NPM_CI, cwd: "backend", retry: 1, timeoutMin: 10 },
    { name: "prisma generate", sh: "npx prisma generate", cwd: "backend", retry: 1, timeoutMin: 5 },
    { name: "npm run build (nest build)", sh: "npm run build", cwd: "backend", timeoutMin: 10 },
  ] },
  { key: "frontend", label: "Frontend", steps: [
    { name: "npm ci", sh: NPM_CI, cwd: "frontend", retry: 1, timeoutMin: 10 },
    { name: "npm run build:uat (tsc + vite)", sh: "npm run build:uat", cwd: "frontend", timeoutMin: 10 },
  ] },
  { key: "candidate", label: "Candidate FE", steps: [
    { name: "npm ci", sh: NPM_CI, cwd: "candidate-frontend", retry: 1, timeoutMin: 10, allowFail: true },
    { name: "npm run build (tsc + vite)", sh: "test ! -d candidate-frontend || (cd candidate-frontend && npm run build)", cwd: ".", timeoutMin: 10, allowFail: true },
  ] },
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
const PG_IMAGE = "postgres:16-alpine"; // trùng Dockerfile.db
const IMAGE = "tvcci:" + createHash("sha256").update(readFileSync(join(DOCKER_DIR, "Dockerfile"))).digest("hex").slice(0, 12);

export async function runCheck(c: CheckRun, d: Deps) {
  const { run, log } = d;
  const must = async (cmd: string[], what: string, quiet = false) => {
    const r = await run(cmd, quiet ? { quiet: true } : { onLine: log });
    if (r.code !== 0) throw new Error(`${what} lỗi (mã ${r.code})${quiet ? ": " + r.out.trim().split("\n").slice(-3).join(" ") : ""}`);
  };
  if ((await run(["docker", "image", "inspect", IMAGE], { quiet: true })).code !== 0) {
    log(`══ Build ảnh môi trường kiểm tra ${IMAGE} (lần đầu hoặc ci/Dockerfile đổi)…`);
    await must(["docker", "build", "--progress=plain", "-t", IMAGE, "-f", join(DOCKER_DIR, "Dockerfile"), DOCKER_DIR], "Build ảnh kiểm tra");
  }
  const name = `tvcci-${c.id}`;
  log(`══ Tạo container ${name} (${IMAGE}), nạp mã commit ${c.sha.slice(0, 7)}`);
  await must(["docker", "run", "-d", "--rm", "--name", name, "--cpus", "6", "--memory", "8g",
    "-v", "tvcci-npm-cache:/root/.npm", IMAGE], "docker run", true);
  const pg = `${name}-pg`;
  try {
    await must(["docker", "run", "-d", "--rm", "--name", pg, "--network", `container:${name}`, "--memory", "1g",
      "-e", "POSTGRES_USER=recruit_ci", "-e", "POSTGRES_PASSWORD=recruit_ci", "-e", "POSTGRES_DB=recruit_exam_ci",
      "-e", "TZ=Asia/Ho_Chi_Minh", "--tmpfs", "/var/lib/postgresql/data",
      PG_IMAGE, "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"], "Chạy CSDL kiểm thử", true);
    const ga = Bun.spawn(["git", "-C", d.repo, "archive", "--format=tar", c.sha], { stdout: "pipe", stderr: "pipe" });
    const tx = Bun.spawn(["docker", "exec", "-i", name, "tar", "-x", "-C", "/w"], { stdin: ga.stdout, stdout: "pipe", stderr: "pipe" });
    const [gaCode, txCode] = await Promise.all([ga.exited, tx.exited]);
    if (gaCode || txCode) throw new Error(`Nạp mã vào container lỗi: ${(await new Response(ga.stderr).text()) + (await new Response(tx.stderr).text())}`.trim());

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
          r = await run(["docker", "exec", "-w", `/w/${s.cwd ?? ""}`.replace(/\/\.?$/, ""), name, "timeout", String((s.timeoutMin ?? 20) * 60), "sh", "-c", s.sh], { onLine: lg });
          if (r.code === 0) break;
        }
        st.ms = Date.now() - t0;
        if (r.code === 0) { st.status = "ok"; lg(`✔ ${s.name} (${Math.round(st.ms / 1000)} giây)`); }
        else if (s.allowFail) { st.status = "warn"; warned = true; lg(`⚠ ${s.name} lỗi (mã ${r.code}), không chặn`); if (i === 0 && g.key === "candidate") failed = true; }
        else { st.status = "failed"; failed = true; lg(`✘ ${s.name} lỗi (mã ${r.code}${r.code === 124 ? ", quá thời gian" : ""})`); }
        d.changed();
      }
      gs.status = gs.steps.some((s) => s.status === "failed") ? "failed" : warned ? "warn" : "ok"; d.changed();
    };
    await Promise.all(GROUPS.map((g, i) => runGroup(g, c.groups[i])));
    const bad = c.groups.filter((g) => g.status === "failed").map((g) => g.label);
    if (bad.length) throw new Error(`Kiểm tra không qua: ${bad.join(", ")}`);
  } finally {
    await run(["docker", "rm", "-f", pg], { quiet: true });
    await run(["docker", "rm", "-f", name], { quiet: true });
  }
}
