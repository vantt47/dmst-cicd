// Danh sách dự án × môi trường của nền tảng. Cấu hình nằm trong MÃ (sửa qua commit, có review và lịch sử) vì nó chứa lệnh
// chạy trên PC (nơi giữ kubeconfig, khoá SSH, quyền GHCR). Giao diện chỉ quản lý người dùng, quyền, không sửa cấu hình này.
// Phạm vi đã chốt 27/11/2026: chỉ môi trường staging (production giữ trang prod-deploy riêng).
//
// Thêm dự án: thêm một mục PROJECTS (+ ảnh CI trong platform/ci/<id>/Dockerfile). Thêm kiểu triển khai: viết adapter mới
// trong platform/adapters/ và giao diện web/<kind>.js.
import { join } from "node:path";
import { E, PUBLIC_HOST, WORK } from "./lib";
import { Repo } from "./repo";
import type { CiSpec } from "./ci";
import type { DnsoCfg } from "./notify";
import type { EnvAdapter } from "./adapters/types";
import { GitopsAdapter, type GitopsCfg } from "./adapters/gitops";
import { SshComposeAdapter, type SshComposeCfg } from "./adapters/ssh-compose";
import { K8sImageAdapter, type K8sImageCfg } from "./adapters/k8s-image";

export type EnvDef = {
  id: string; label: string;
  branch: string;          // nhánh mặc định trong ô Build
  autoDeploy: boolean;     // commit đầu `branch` qua CI thì tự Build & deploy
  site?: string;           // trang của môi trường (liên kết trên thẻ)
  requireCi?: boolean;     // Build phải có CI đạt (mặc định true; bỏ qua chặn vẫn được nếu có quyền)
  autoOpts?: Record<string, boolean>; // tuỳ chọn (adapter.options) cho lượt Build & deploy tự động
  notify?: DnsoCfg;
  // requireCi do phần khởi tạo điền vào cfg từ EnvDef, cấu hình không ghi lại
  deploy: GitopsCfg | Omit<SshComposeCfg, "requireCi"> | Omit<K8sImageCfg, "requireCi">;
};
export type ProjectDef = {
  id: string; name: string; logo: string;
  repoUrl: string; ghRepo: string;
  reference?: string;                // clone sẵn có trên PC, mượn đối tượng git cho lần clone đầu nhanh
  autoCheck: "all" | string[];       // nhánh tự chạy CI khi có push
  ci: CiSpec;
  legacyChecksDir?: string;          // bản xem trước: đọc kết quả CI của trang cũ
  envs: EnvDef[];
};

const CI_DIR = join(import.meta.dir, "ci");
const REG = "ghcr.io/khcn-thanh-hoa";
const M = "/w/ecommerce-monorepo";
const TVC_NPM_CI = "npm ci --no-audit --no-fund --loglevel=error";
const pkgGroup = (key: string) => ({
  key, label: key, dir: `${M}/${key}`,
  steps: [
    { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", install: true },
    { name: "Typecheck (bun run tsc)", sh: "bun run tsc" },
    { name: "Build (bun run build)", sh: "bun run build" },
  ],
});

export const PROJECTS: ProjectDef[] = [
  {
    id: "san-tmdt", name: "Sàn TMĐT", logo: "logo-thihub.svg",
    repoUrl: E.SAN_REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/5-san-tmdt.git", ghRepo: "KHCN-Thanh-Hoa/5-san-tmdt",
    reference: "D:/DMST/stg-deploy-work/repo",
    autoCheck: "all",
    legacyChecksDir: "D:/DMST/stg-deploy-work/checks",
    // = stg-deploy/checks.ts (chạy lại các job của .github/workflows/ci.yml). Sửa ci.yml thì sửa ở đây cho khớp.
    ci: {
      name: "stgci", dockerDir: join(CI_DIR, "san-tmdt"), workdir: M, cpus: 12, memory: "16g",
      cache: "stgci-bun-cache-u:/home/bun/.bun/install/cache",
      groups: [
        { key: "route-cu", label: "route-cu", dir: M, steps: [{ name: "Giao diện không gọi route cũ", sh: "node scripts/kiem-route-cu.mjs" }] },
        { key: "quet-vitu", label: "quet-vitu", dir: M, steps: [{ name: "Không còn dấu vết Vitu", sh: "node scripts/quet-vitu.mjs" }] },
        {
          key: "backend", label: "backend", dir: `${M}/backend`,
          env: { NODE_ENV: "test", JWT_SECRET: "ci-fake-jwt-secret", JWT_REFRESH_SECRET: "ci-fake-jwt-refresh-secret", DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci" },
          steps: [
            { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", install: true },
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
            { name: "Kiểm thử (jest, chưa chặn)", sh: "bun run test", allowFail: true, timeoutMin: 30 },
          ],
        },
        pkgGroup("phone"), pkgGroup("manage"), pkgGroup("seller-center"),
      ],
    },
    envs: [
      {
        id: "staging", label: "Staging", branch: "staging", autoDeploy: false, site: "https://sangiaodich.dmst.vn/",
        notify: {
          duAn: "5-san-tmdt", moiTruong: "staging", trang: "https://sangiaodich.dmst.vn/",
          ok: "Build thành công: bản thử nghiệm đã cập nhật, mời mọi người vào kiểm tra",
          fail: "Build thất bại: bản thử nghiệm vẫn chạy bản cũ, đội kỹ thuật đang xử lý",
        },
        deploy: {
          kind: "gitops-kustomize", branch: "staging", kpath: "ecommerce-monorepo/deploy/k8s/clusters/staging/kustomization.yaml",
          root: "ecommerce-monorepo", kubeconfig: E.SAN_STG_KUBECONFIG ?? "C:/Users/Admin/.kube/tmdt-staging.yaml",
          proxyPort: Number(E.SAN_STG_PROXY_PORT ?? 8088), flux: { ns: "flux-system", source: "tmdt", ks: "staging" },
          ghOrg: "KHCN-Thanh-Hoa", tagPrefix: "stg", hideTags: /production|^prod-/,
          publicUrl: `https://${PUBLIC_HOST}/p/san-tmdt/staging/`, commitLabel: "Staging (dmst-cicd)",
          services: [
            { key: "backend", label: "Backend API", note: "api-sangiaodich.dmst.vn", image: `${REG}/tmdt-backend`, ns: "tmdt", deploy: "backend", container: "backend", also: ["backend-worker"], defaultBuild: true,
              build: { context: "backend", file: "backend/Dockerfile", target: "runtime", suffix: "", scan: true } },
            { key: "migrate", label: "Migrate CSDL", note: "initContainer của backend: migrate + seed vùng trước khi backend chạy", image: `${REG}/tmdt-migrate`, ns: "tmdt", deploy: "backend", init: "migrate", also: ["backend-worker"], defaultBuild: true,
              build: { context: "backend", file: "backend/Dockerfile.migrate", suffix: "" } },
            { key: "web", label: "Web", note: "sangiaodich, nguoiban-, quantri-sangiaodich.dmst.vn", image: `${REG}/tmdt-web`, ns: "tmdt", deploy: "web", container: "web",
              build: { context: ".", file: "deploy/nginx/Dockerfile", target: "k8s", suffix: "-staging", scan: true, args: {
                VITE_API_URL: "https://sangiaodich.dmst.vn/api",
                VITE_GOOGLE_CLIENT_ID: "764794139184-sn5rdvuqkqevqtrupcl8kkm7p53h5d1g.apps.googleusercontent.com",
                VITE_SELLER_CENTER_URL: "https://nguoiban-sangiaodich.dmst.vn",
                SAN_TEN_MIEN: "", // "" đường dẫn; "{san}-sangiaodich.dmst.vn" tên miền con
              } } },
            { key: "ome-agent", label: "OME agent", note: "sidecar của ome-origin, ns tmdt-live", image: `${REG}/tmdt-ome-agent`, ns: "tmdt-live", deploy: "ome-origin", container: "agent",
              build: { context: "deploy/ome/agent", file: "deploy/ome/agent/Dockerfile", suffix: "" } },
          ],
        },
      },
    ],
  },
  {
    // DNSO: CI = dnso-stg/kiem-tra.ts; staging trên DMST_05. (Staging Senow/HappyFinate không quản lý ở đây, quyết định 28/11/2026.)
    id: "dnso", name: "DNSO", logo: "logo-dnso.svg",
    repoUrl: E.DNSO_REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/doanhnghiepso.git", ghRepo: "KHCN-Thanh-Hoa/doanhnghiepso",
    reference: "D:/DMST/dnso-stg-work/repo",
    autoCheck: ["staging", "main"],
    legacyChecksDir: "D:/DMST/dnso-stg-work/checks",
    ci: {
      name: "dnsoci", dockerDir: join(CI_DIR, "dnso"), workdir: "/w/app", cpus: 10, memory: "12g",
      cache: "dnsoci-bun-cache:/root/.bun/install/cache", firstGroupFirst: true,
      // CSDL kiểm thử trùng postgres-kiem-thu trong app/docker-compose.yml (cổng 5435, tmpfs)
      sidecar: {
        image: "postgres:16-alpine", memory: "2g",
        runArgs: ["-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=cds_kiem_thu_pass", "-e", "POSTGRES_DB=cds_kiem_thu",
          "-e", "TZ=Asia/Ho_Chi_Minh", "-e", "PGTZ=Asia/Ho_Chi_Minh", "--tmpfs", "/var/lib/postgresql/data"],
        cmd: ["-c", "port=5435", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
      },
      groups: [
        { key: "cai-dat", label: "Cài đặt", steps: [
          { name: "bun install --frozen-lockfile", sh: "bun install --frozen-lockfile", retry: 1 },
          { name: "Dựng CSDL kiểm thử (kiem-thu:csdl → scripts/migrate.ts)", sh: "bun run kiem-thu:csdl", timeoutMin: 15 },
        ] },
        { key: "typecheck", label: "Typecheck", steps: [{ name: "bun run typecheck", sh: "bun run typecheck", timeoutMin: 15 }] },
        { key: "kiem-thu", label: "Kiểm thử", steps: [
          { name: "kiem-thu:don-vi (tầng 1 + quét tầng 4 + tự kiểm tầng 5)", sh: "bun run kiem-thu:don-vi", timeoutMin: 20 },
          { name: "kiem-thu:ten-mien (định tuyến tên miền)", sh: "bun run kiem-thu:ten-mien", timeoutMin: 5 },
        ] },
        { key: "build", label: "Build", steps: [{ name: "bun run build", sh: "bun run build", timeoutMin: 15 }] },
      ],
    },
    envs: [
      {
        id: "staging", label: "Staging", branch: "staging", autoDeploy: true, site: "https://stg-dmst-dnso.dmst.vn",
        notify: {
          duAn: "DNSO", moiTruong: "staging", trang: "https://stg-dmst-dnso.dmst.vn",
          ok: "Staging DNSO đã cập nhật bản mới, mời mọi người vào kiểm tra",
          fail: "Cập nhật staging DNSO thất bại: vẫn chạy bản cũ, đội kỹ thuật đang xử lý",
        },
        deploy: {
          kind: "ssh-compose", sshHost: E.DNSO_STG_SSH ?? "DMST_05", remoteDir: "/opt/dnso-staging",
          site: "https://stg-dmst-dnso.dmst.vn", keepTags: 6, legacyJobsDir: "D:/DMST/dnso-stg-work/jobs",
        },
      },
    ],
  },
  {
    id: "thi-vien-chuc", name: "Thi viên chức", logo: "logo-tvc.svg",
    repoUrl: E.TVC_REPO_URL ?? "git@github-tt47:KHCN-Thanh-Hoa/thi-vien-chuc.git", ghRepo: "KHCN-Thanh-Hoa/thi-vien-chuc",
    reference: "D:/DMST/tvc-stg-work/repo",
    autoCheck: ["main"],
    legacyChecksDir: "D:/DMST/tvc-stg-work/checks",
    // = tvc-stg/kiem-tra.ts: schema.sql + seed.sql trên Postgres 16 sạch, build backend, frontend (+ candidate, chỉ cảnh báo)
    ci: {
      name: "tvcci", dockerDir: join(CI_DIR, "tvc"), workdir: "/w", cpus: 6, memory: "8g",
      cache: "tvcci-npm-cache:/root/.npm",
      sidecar: {
        image: "postgres:16-alpine", memory: "2g",
        runArgs: ["-e", "POSTGRES_USER=recruit_ci", "-e", "POSTGRES_PASSWORD=recruit_ci", "-e", "POSTGRES_DB=recruit_exam_ci",
          "-e", "TZ=Asia/Ho_Chi_Minh", "--tmpfs", "/var/lib/postgresql/data"],
        cmd: ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
      },
      groups: [
        { key: "csdl", label: "CSDL", steps: [
          { name: "Chờ CSDL kiểm thử", sh: "for i in $(seq 1 60); do pg_isready -q && exit 0; sleep 1; done; exit 1", timeoutMin: 2 },
          { name: "database/schema.sql", sh: "psql -v ON_ERROR_STOP=1 -q -f database/schema.sql", timeoutMin: 5 },
          { name: "database/seed.sql", sh: "psql -v ON_ERROR_STOP=1 -q -f database/seed.sql", timeoutMin: 5 },
          { name: "seed.sql lần 2 (idempotent)", sh: "psql -v ON_ERROR_STOP=1 -q -1 -f database/seed.sql", timeoutMin: 5, allowFail: true },
        ] },
        { key: "backend", label: "Backend", steps: [
          { name: "npm ci", sh: TVC_NPM_CI, dir: "/w/backend", retry: 1, timeoutMin: 10 },
          { name: "prisma generate", sh: "npx prisma generate", dir: "/w/backend", retry: 1, timeoutMin: 5 },
          { name: "npm run build (nest build)", sh: "npm run build", dir: "/w/backend", timeoutMin: 10 },
        ] },
        { key: "frontend", label: "Frontend", steps: [
          { name: "npm ci", sh: TVC_NPM_CI, dir: "/w/frontend", retry: 1, timeoutMin: 10 },
          { name: "npm run build:uat (tsc + vite)", sh: "npm run build:uat", dir: "/w/frontend", timeoutMin: 10 },
        ] },
        { key: "candidate", label: "Candidate FE", steps: [
          { name: "npm ci", sh: `test ! -d candidate-frontend || (cd candidate-frontend && ${TVC_NPM_CI})`, retry: 1, timeoutMin: 10, allowFail: true },
          { name: "npm run build (tsc + vite)", sh: "test ! -d candidate-frontend || (cd candidate-frontend && npm run build)", timeoutMin: 10, allowFail: true },
        ] },
      ],
    },
    envs: [
      {
        id: "staging", label: "Staging", branch: "main", autoDeploy: true, site: "https://stg-thi-vien-chuc.dmst.vn",
        autoOpts: { resetDb: true }, // = AUTO_RESET_DB=1 của tvc-stg: lượt tự động được làm lại CSDL khi schema.sql đổi
        notify: {
          duAn: "Thi viên chức", moiTruong: "staging", trang: "https://stg-thi-vien-chuc.dmst.vn",
          ok: "Staging Thi viên chức đã cập nhật bản mới, mời mọi người vào kiểm tra",
          fail: "Cập nhật staging Thi viên chức thất bại: vẫn chạy bản cũ, đội kỹ thuật đang xử lý",
        },
        deploy: {
          kind: "k8s-image", kubeconfig: E.TVC_KUBECONFIG ?? "C:/Users/Admin/.kube/tmdt-staging.yaml", proxyPort: Number(E.TVC_PROXY_PORT ?? 8089),
          ns: "stg-thi-vien-chuc", imgApp: `${REG}/thi-vien-chuc-app`, imgDb: `${REG}/thi-vien-chuc-db`,
          dbUser: "recruit_uat", dbName: "recruit_exam_uat", site: "https://stg-thi-vien-chuc.dmst.vn", ghOrg: "KHCN-Thanh-Hoa",
          legacyBuildsFile: "D:/DMST/tvc-stg-work/builds.json", legacyJobsDir: "D:/DMST/tvc-stg-work/jobs",
        },
      },
    ],
  },
];

// ---------------- Khởi tạo ----------------
export type ProjectRt = { def: ProjectDef; repo: Repo; envs: Map<string, { def: EnvDef; adapter: EnvAdapter }> };
export const RT = new Map<string, ProjectRt>();
for (const p of PROJECTS) {
  const root = join(WORK, "projects", p.id);
  const repo = new Repo(p.repoUrl, root, p.ghRepo, p.reference);
  const envs = new Map<string, { def: EnvDef; adapter: EnvAdapter }>();
  for (const e of p.envs) {
    const d = e.deploy, dir = join(root, e.id), requireCi = e.requireCi !== false;
    const adapter: EnvAdapter =
      d.kind === "gitops-kustomize" ? new GitopsAdapter(p.id, d, repo, dir)
      : d.kind === "ssh-compose" ? new SshComposeAdapter(p.id, { ...d, requireCi }, repo, dir)
      : d.kind === "k8s-image" ? new K8sImageAdapter(p.id, { ...d, requireCi }, repo, dir)
      : (() => { throw new Error(`Kiểu triển khai không hỗ trợ: ${(d as any).kind}`); })();
    envs.set(e.id, { def: e, adapter });
  }
  RT.set(p.id, { def: p, repo, envs });
}
