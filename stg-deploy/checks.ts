// Kiểm tra (CI) một commit trước khi cho Build: chạy lại đúng các job của .github/workflows/ci.yml trong repo 5-san-tmdt
// (route-cu, quet-vitu, backend, phone, manage, seller-center). Sửa ci.yml thì sửa GROUPS dưới đây cho khớp.
//
// Chạy trong container Docker dùng một lần (ảnh ci/Dockerfile: Bun 1.3.14 + Node 24 như runner CI), KHÔNG chạy trên PC:
// mã của nhánh bất kỳ không được đọc secrets.json, khóa SSH, kubeconfig. Mã nạp vào container bằng `git archive`
// (không mount thư mục của PC), chỉ có biến môi trường giả như ci.yml. Volume stgci-bun-cache-u giữ bộ nhớ đệm bun
// (giống actions/cache trong CI), node_modules cài mới mỗi lượt. Các nhóm chạy song song, bước trong nhóm chạy lần lượt.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type StepStatus = "pending" | "running" | "ok" | "warn" | "failed" | "skipped";
type StepDef = { name: string; dir?: string; sh: string; allowFail?: boolean; install?: boolean; timeoutMin?: number };
type GroupDef = { key: string; label: string; dir: string; env?: Record<string, string>; steps: StepDef[] };

const M = "/w/ecommerce-monorepo";
const pkg = (key: string): GroupDef => ({
  key, label: key, dir: `${M}/${key}`,
  steps: [
    { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", install: true },
    { name: "Typecheck (bun run tsc)", sh: "bun run tsc" },
    { name: "Build (bun run build)", sh: "bun run build" },
  ],
});
export const GROUPS: GroupDef[] = [
  { key: "route-cu", label: "route-cu", dir: M, steps: [{ name: "Giao diện không gọi route cũ", sh: "node scripts/kiem-route-cu.mjs" }] },
  { key: "quet-vitu", label: "quet-vitu", dir: M, steps: [{ name: "Không còn dấu vết Vitu", sh: "node scripts/quet-vitu.mjs" }] },
  {
    key: "backend", label: "backend", dir: `${M}/backend`,
    // Giá trị giả như ci.yml, không kết nối CSDL hay Redis thật.
    env: { NODE_ENV: "test", JWT_SECRET: "ci-fake-jwt-secret", JWT_REFRESH_SECRET: "ci-fake-jwt-refresh-secret", DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci" },
    steps: [
      { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", install: true },
      // Môi trường (không có trong ci.yml): bun chặn postinstall của @embedded-postgres/linux-x64 nên thiếu symlink
      // thư viện (libicuuc.so.60...), initdb của kiểm thử hợp đồng (test/livestream) hỏng trên Linux. Tạo lại symlink.
      { name: "Chuẩn bị embedded-postgres (symlink thư viện)", sh: "cd node_modules/@embedded-postgres/linux-x64 && node scripts/hydrate-symlinks.js" },
      { name: "prisma generate", sh: "bun x prisma generate" },
      { name: "Typecheck (tsc --noEmit)", sh: "bun x tsc --noEmit -p tsconfig.json" },
      { name: "Sinh OpenAPI v1 và kiểu api-client", sh: "bun run api:generate" },
      { name: "So sánh OpenAPI v1 với mốc route cũ", sh: "bun run api:compare" },
      { name: "Kiểm thử packages/api-client", dir: `${M}/packages/api-client`, sh: "bun test" },
      {
        name: "Hợp đồng API v1 đã sinh lại", dir: `${M}/packages/api-client`,
        sh: 'if [ -n "$(git status --porcelain -- openapi src/generated)" ]; then echo "Hợp đồng API v1 đổi nhưng chưa sinh lại. Chạy: cd ecommerce-monorepo/backend && bun run api:generate, rồi commit."; git status --short -- openapi src/generated; git diff --stat -- openapi src/generated; exit 1; fi',
      },
      { name: "Kiểm thử hợp đồng API v1", sh: "bun x jest test/v1 test/livestream test/support/contract-v1 --maxWorkers=4", timeoutMin: 30 },
      // ci.yml: continue-on-error (lỗi có sẵn, G0-04): lỗi chỉ cảnh báo, không chặn Build
      { name: "Kiểm thử (jest, chưa chặn)", sh: "bun run test", allowFail: true, timeoutMin: 30 },
    ],
  },
  pkg("phone"),
  pkg("manage"),
  pkg("seller-center"),
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
const IMAGE = "stgci:" + createHash("sha256").update(readFileSync(join(DOCKER_DIR, "Dockerfile"))).digest("hex").slice(0, 12);

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
  const name = `stgci-${c.id}`;
  log(`══ Tạo container ${name} (${IMAGE}), nạp mã commit ${c.sha.slice(0, 7)}`);
  await must(["docker", "run", "-d", "--rm", "--name", name, "--cpus", "12", "--memory", "16g",
    "-v", "stgci-bun-cache-u:/home/bun/.bun/install/cache", IMAGE], "docker run", true);
  try {
    // git archive (trên PC) | tar -x (trong container); rồi git init để bước kiểm "đã sinh lại" so được
    const ga = Bun.spawn(["git", "-C", d.repo, "archive", "--format=tar", c.sha], { stdout: "pipe", stderr: "pipe" });
    const tx = Bun.spawn(["docker", "exec", "-i", name, "tar", "-x", "-C", "/w"], { stdin: ga.stdout, stdout: "pipe", stderr: "pipe" });
    const [gaCode, txCode] = await Promise.all([ga.exited, tx.exited]);
    if (gaCode || txCode) throw new Error(`Nạp mã vào container lỗi: ${(await new Response(ga.stderr).text()) + (await new Response(tx.stderr).text())}`.trim());
    await must(["docker", "exec", "-w", "/w", name, "sh", "-c", "git init -q && git add -A && git commit -q -m src"], "git init trong container", true);

    let installLock: Promise<unknown> = Promise.resolve(); // bun install lần lượt (chung bộ nhớ đệm)
    const runGroup = async (g: GroupDef, gs: CheckRun["groups"][number]) => {
      gs.status = "running"; d.changed();
      let failed = false, warned = false;
      for (const [i, s] of g.steps.entries()) {
        const st = gs.steps[i];
        if (failed) { st.status = "skipped"; continue; }
        const go = async () => {
          st.status = "running"; d.changed();
          const t0 = Date.now();
          const lg = (l: string) => log(`[${g.key}] ${l}`);
          lg(`▶ ${s.name}`);
          const cmd = ["docker", "exec", "-w", s.dir ?? g.dir];
          for (const [k, v] of Object.entries(g.env ?? {})) cmd.push("-e", `${k}=${v}`);
          cmd.push("-e", "CI=true", name, "timeout", String((s.timeoutMin ?? 20) * 60), "sh", "-c", s.sh);
          const r = await run(cmd, { onLine: lg });
          st.ms = Date.now() - t0;
          if (r.code === 0) { st.status = "ok"; lg(`✔ ${s.name} (${Math.round(st.ms / 1000)} giây)`); }
          else if (s.allowFail) { st.status = "warn"; warned = true; lg(`⚠ ${s.name} lỗi (mã ${r.code}), không chặn (giống ci.yml)`); }
          else { st.status = "failed"; failed = true; lg(`✘ ${s.name} lỗi (mã ${r.code}${r.code === 124 ? ", quá thời gian" : ""})`); }
          d.changed();
        };
        if (s.install) { const p = installLock.then(go); installLock = p.catch(() => {}); await p; }
        else await go();
      }
      gs.status = failed ? "failed" : warned ? "warn" : "ok"; d.changed();
    };
    await Promise.all(GROUPS.map((g, i) => runGroup(g, c.groups[i])));
    const bad = c.groups.filter((g) => g.status === "failed").map((g) => g.label);
    if (bad.length) throw new Error(`Kiểm tra không qua: ${bad.join(", ")}`);
  } finally {
    await run(["docker", "rm", "-f", name], { quiet: true });
  }
}
