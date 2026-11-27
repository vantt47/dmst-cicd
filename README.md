# dmst-cicd

Công cụ CI/CD của các dự án DMST, tách khỏi repo ứng dụng.

## dnso-stg

Trang CI/CD staging cho DNSO (KHCN-Thanh-Hoa/doanhnghiepso): https://stg-deploy-dnso.senow.tech

- Chạy trên PC quản trị (Windows, Bun, Docker Desktop, SSH tới `DMST_05` qua Tailscale, cloudflared), cổng 8097,
  thư mục làm việc `D:\DMST\dnso-stg-work`, Scheduled Task `dnso-stg`. Độc lập với stg-deploy (chỉ dùng chung `app.css`).
- **CI**: mỗi push vào `staging` hoặc `main` (`AUTO_CHECK_BRANCHES`) tự chạy Kiểm tra trong container dùng một lần
  ([dnso-stg/kiem-tra.ts](dnso-stg/kiem-tra.ts)): `bun install`, dựng CSDL kiểm thử (Postgres phụ, `kiem-thu:csdl`),
  `typecheck`, `kiem-thu:don-vi`, `kiem-thu:ten-mien`, `build`. Mã nạp bằng `git archive` cả kho, không chạm bí mật của PC.
- **CD**: commit đầu `staging` qua kiểm tra thì tự Build & deploy (`AUTO_DEPLOY=0` để tắt): PC dựng ảnh `dnso-web`,
  `dnso-worker` (thẻ = 8 ký tự sha) từ `git archive <sha>:app`, `docker save | ssh DMST_05 docker load`, chép
  `trien-khai/` của chính commit đó vào `/opt/dnso-staging` (tệp `.env*` không nằm trong git nên không bị đè), rồi chạy
  `trien-khai.sh <thẻ>`: migrate → dựng màu web đang tắt → chờ lành → dừng êm màu cũ → dựng lại worker. Sau đó kiểm
  `/suc-khoe` qua cổng vào và dọn ảnh cũ (giữ `KEEP_TAGS` = 6 thẻ để quay lui).
- **Đổi bản**: chạy lại một thẻ còn trên máy staging (quay lui, mặc định không migrate).
- Báo nhóm Nhắn tin DNSO một tin kết quả mỗi lượt triển khai khi `secrets.json` có `DNSO_API_KEY`, `DNSO_THAY_MAT`,
  `DNSO_NHOM_ID`.

Cài (hoặc cài lại Scheduled Task):

```powershell
powershell -ExecutionPolicy Bypass -File dnso-stg\start.ps1 -Install
```

Máy staging `DMST_05` (`/opt/dnso-staging`): bộ `trien-khai/` của kho DNSO với `COMPOSE_PROFILES=csdl-tu-chay,worker,cloudflare-tunnel`,
Postgres 18 tự chạy (vai trò `postgres`/`erp`/`cds_app` như prod), Cloudflare Tunnel `dnso-staging` cho `dmst`, `az`,
`nen-tang.senow.tech`. Miền staging chính: `stg-dmst-dnso.dmst.vn`, khai là tên miền riêng `hoat_dong` của doanh nghiệp `dmst` trong `platform.ten_mien_rieng` của CSDL staging. Mật khẩu vai trò CSDL ở `/opt/dnso-staging/.mat-khau-vai-tro`.

## dnso-hf

Trang build staging DNSO lên VPS HappyFinate: https://hf-deploy-dnso.senow.tech (staging chạy ở `dmst`, `az`,
`nen-tang.senow.tech`, thư mục `/opt/dnso-staging` trên VPS). Độc lập với dnso-stg (DMST_05).

- Chạy trên PC quản trị (Windows, Bun, Git, SSH alias `HappyFinate`, cloudflared), cổng 8100, thư mục làm việc
  `D:\DMST\dnso-hf-work`, Scheduled Task `dnso-hf`, tunnel `dnso-hf-deploy` (tài khoản senow.tech).
- Dev chọn nhánh/commit (mặc định `staging`) rồi bấm **Build & deploy**. PC fetch kho DNSO từ GitHub và `git push`
  đúng commit đó vào kho trần `/opt/dnso-staging/repo.git` trên VPS (VPS không có quyền đọc kho trên GitHub). Sau đó
  **VPS tự build** bằng [dnso-hf/vps/build-tu-git.sh](dnso-hf/vps/build-tu-git.sh) (PC chép đè mỗi lượt): `git archive`
  → `bun install` + `bun run build` trong container giới hạn 1.5 CPU / 4 GB → đổi `src` → migrate → dựng lại web +
  worker → chờ `/suc-khoe` qua Traefik. Migrate lỗi hoặc bản mới không lành thì tự trả mã cũ về.
- Script chạy tách khỏi phiên SSH (`setsid nohup`, log ở `/opt/dnso-staging/nhat-ky-build/`) và giữ khoá
  `.build.lock`, nên PC rớt mạng giữa chừng không làm hỏng lượt build và hai lượt không chạy chồng nhau.
- Bản đang chạy: `/opt/dnso-staging/PHIEN_BAN`; lịch sử: `lich-su-trien-khai.log`. Một lượt khoảng 7–8 phút
  (build ~2,5 phút, migrate ~4,5 phút).
- Báo nhóm Nhắn tin DNSO khi `secrets.json` có `DNSO_API_KEY`, `DNSO_THAY_MAT`, `DNSO_NHOM_ID` (mặc định chưa bật).

```powershell
powershell -ExecutionPolicy Bypass -File dnso-hf\start.ps1 -Install
```

## tvc-stg

Trang CI/CD staging cho thi-vien-chuc (KHCN-Thanh-Hoa/thi-vien-chuc): https://stg-deploy-thi-vien-chuc.dmst.vn
→ staging https://stg-thi-vien-chuc.dmst.vn (namespace `stg-thi-vien-chuc` trên cụm k3s staging chung).

- Chạy trên PC quản trị (Windows, Bun, Docker Desktop đã đăng nhập GHCR, kubectl + `C:\Users\Admin\.kube\tmdt-staging.yaml`
  qua Tailscale, cloudflared), cổng 8102, thư mục làm việc `D:\DMST\tvc-stg-work`, Scheduled Task `tvc-stg`,
  tunnel `tvc-stg-deploy` (tài khoản dmst.vn). Đăng nhập: tên + mật khẩu chung `DEPLOY_PASSWORD` trong `secrets.json`.
- **CI**: mỗi push vào `main` (`AUTO_CHECK_BRANCHES`) tự chạy Kiểm tra trong container dùng một lần
  ([tvc-stg/kiem-tra.ts](tvc-stg/kiem-tra.ts), ảnh [tvc-stg/ci/Dockerfile](tvc-stg/ci/Dockerfile)), các nhóm song song:
  CSDL (`schema.sql` + `seed.sql` trên Postgres 16 sạch, `seed.sql` lần hai để kiểm idempotent: chỉ cảnh báo),
  Backend (`npm ci`, `prisma generate`, `npm run build`), Frontend (`npm ci`, `npm run build:uat`),
  Candidate FE (chưa đóng gói vào staging: chỉ cảnh báo).
- **CD**: commit đầu `main` qua kiểm tra thì tự Build & deploy (`AUTO_DEPLOY=0` để tắt): dựng ảnh
  `thi-vien-chuc-app:stg-<sha7>` (Dockerfile.uat) và `thi-vien-chuc-db:stg-<sha7>` (Dockerfile.db của kho, không có thì
  [tvc-stg/ci/Dockerfile.db](tvc-stg/ci/Dockerfile.db)), push GHCR, rồi `kubectl set image` + chờ rollout (không lành thì
  `rollout undo`) + kiểm `/health`.
- **CSDL** (dự án không có migration, `schema.sql` là DDL đầy đủ): băm git của `schema.sql`/`seed.sql` đang chạy ghi ở
  annotation `dmst-cicd/schema`, `dmst-cicd/seed` của StatefulSet `db`.
  - `schema.sql` đổi → **làm lại CSDL**: dừng app, `DROP SCHEMA public CASCADE`, chạy `schema.sql` + `seed.sql`
    (mất dữ liệu staging). Bấm tay phải bật "Làm lại CSDL"; lượt tự động được phép khi `AUTO_RESET_DB=1` (mặc định),
    `AUTO_RESET_DB=0` thì lượt tự động dừng lại chờ người quyết.
  - chỉ `seed.sql` đổi → nạp lại `seed.sql` trong một transaction (seed phải idempotent).
- **Đổi bản**: chạy lại một thẻ đã dựng (danh sách `builds.json`), khác schema thì phải chọn làm lại CSDL.
- Manifest gốc (namespace, Deployment `app`, StatefulSet `db`, Ingress, quota, bí mật tạo tay) nằm ở `deploy/k8s/` của
  kho thi-vien-chuc; trang chỉ đổi ảnh/annotation trên các đối tượng đã có.
- Báo nhóm Nhắn tin DNSO khi `secrets.json` có `DNSO_API_KEY`, `DNSO_THAY_MAT`, `DNSO_NHOM_ID` (mặc định chưa bật).

```powershell
powershell -ExecutionPolicy Bypass -File tvc-stg\start.ps1 -Install
```

## stg-deploy

Trang build/deploy staging cho Sàn TMĐT: https://stg-deploy-sangiaodich.dmst.vn

- Chạy trên PC quản trị (Windows, Bun, Docker Desktop, kubectl qua Tailscale, cloudflared), không chạy trong cụm.
- Dev chọn nhánh/commit rồi bấm **Chạy kiểm tra** (CI): chạy lại đúng các job của `.github/workflows/ci.yml`
  (route-cu, quet-vitu; backend: tsc, OpenAPI, api-client, kiểm thử hợp đồng v1, jest; phone, manage, seller-center:
  tsc + build) trong container Docker dùng một lần ([stg-deploy/checks.ts](stg-deploy/checks.ts),
  [stg-deploy/ci/Dockerfile](stg-deploy/ci/Dockerfile)). Mã nạp bằng `git archive`, không chạm bí mật của PC.
- Mỗi lần push (bất kỳ nhánh nào của 5-san-tmdt) trang tự chạy kiểm tra cho commit đầu nhánh, người chạy
  "Tự động (push)". Trang dò GitHub mỗi 60 giây (`AUTO_CHECK_SEC`, 0 = tắt), mốc đầu nhánh lưu ở
  `D:\DMST\stg-deploy-work\auto-check.json`. Push liên tiếp vào một nhánh thì chỉ commit mới nhất được kiểm tra.
- Nút **Build** chỉ mở khi commit đang chọn đã qua kiểm tra (server cũng chặn). Build: PC build ảnh từ đúng commit đã
  kiểm, quét Trivy (backend, web: chặn lỗ hổng CRITICAL đã có bản vá), push GHCR, commit đổi `newTag` trong
  `ecommerce-monorepo/deploy/k8s/clusters/staging/kustomization.yaml` vào nhánh `staging`, rồi gọi Flux áp ngay.
- Sửa `ci.yml` bên repo ứng dụng thì sửa `GROUPS` trong `checks.ts` cho khớp.
- Hoặc **Deploy** một thẻ ảnh đã có trên GHCR.

Mã chạy thẳng từ clone `D:\DMST\stg-deploy-work\cicd` theo `origin/main`. Sửa trang = commit + push `main`; trang tự
khởi động lại với mã mới trong khoảng 2 phút, hoặc ngay khi có người bấm Build/Deploy.

Cài (hoặc cài lại Scheduled Task):

```powershell
powershell -ExecutionPolicy Bypass -File stg-deploy\start.ps1 -Install
```

Chi tiết cấu hình, thư mục làm việc và bí mật: phần đầu [stg-deploy/start.ps1](stg-deploy/start.ps1) và
[stg-deploy/server.ts](stg-deploy/server.ts).

Lịch sử trước khi tách nằm ở `ecommerce-monorepo/deploy/stg-deploy` của repo 5-san-tmdt (đã giữ lại khi tách).
