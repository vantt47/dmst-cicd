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

export type EnvDef = {
  id: string; label: string;
  branch: string;          // nhánh mặc định trong ô Build
  autoDeploy: boolean;     // commit đầu `branch` qua CI thì tự Build & deploy
  site?: string;           // trang của môi trường (liên kết trên thẻ)
  notify?: DnsoCfg;
  deploy: GitopsCfg;
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
];

// ---------------- Khởi tạo ----------------
export type ProjectRt = { def: ProjectDef; repo: Repo; envs: Map<string, { def: EnvDef; adapter: EnvAdapter }> };
export const RT = new Map<string, ProjectRt>();
for (const p of PROJECTS) {
  const root = join(WORK, "projects", p.id);
  const repo = new Repo(p.repoUrl, root, p.ghRepo, p.reference);
  const envs = new Map<string, { def: EnvDef; adapter: EnvAdapter }>();
  for (const e of p.envs) {
    const adapter = e.deploy.kind === "gitops-kustomize" ? new GitopsAdapter(p.id, e.deploy, repo, join(root, e.id)) : null;
    if (!adapter) throw new Error(`Kiểu triển khai không hỗ trợ: ${(e.deploy as any).kind}`);
    envs.set(e.id, { def: e, adapter });
  }
  RT.set(p.id, { def: p, repo, envs });
}
