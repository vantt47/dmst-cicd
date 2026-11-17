# dmst-cicd

Công cụ CI/CD của các dự án DMST, tách khỏi repo ứng dụng.

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
