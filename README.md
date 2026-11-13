# dmst-cicd

Công cụ CI/CD của các dự án DMST, tách khỏi repo ứng dụng.

## stg-deploy

Trang build/deploy staging cho Sàn TMĐT: https://stg-deploy-sangiaodich.dmst.vn

- Chạy trên PC quản trị (Windows, Bun, Docker Desktop, kubectl qua Tailscale, cloudflared), không chạy trong cụm.
- Dev bấm **Build**: PC lấy mã từ repo `KHCN-Thanh-Hoa/5-san-tmdt`, build và push ảnh lên GHCR, commit đổi `newTag` trong
  `ecommerce-monorepo/deploy/k8s/clusters/staging/kustomization.yaml` vào nhánh `staging`, rồi gọi Flux áp ngay.
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
