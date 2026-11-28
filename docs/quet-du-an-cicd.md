# Quét D:\DMST: dự án nào đã có staging / CI/CD (28/11/2026)

Mục đích: tìm các dự án đã từng build lên server staging hoặc đã có CI/CD, đưa vào `cicd.dmst.vn` để quản lý tập trung.
Phạm vi nền tảng đã chốt 27/11: **chỉ môi trường staging** (production giữ trang riêng).

Cách quét: mọi thư mục cấp 1 trong `D:\DMST` (bỏ các thư mục làm việc `*-work`, `wt-*`, sao lưu, bí mật); tìm
`.github/workflows`, Dockerfile, compose, kustomization, script triển khai, nhánh staging; đối chiếu với những gì đang
chạy thật trên `DMST_05`, `DMST_06`, VPS `HappyFinate` và cụm k3s staging; và các Scheduled Task trên PC.

## Kết quả

### Đã đưa vào cicd.dmst.vn

| Dự án | Kho | Môi trường | Trang cũ (vẫn chạy) | Kiểu triển khai trên nền tảng | Trang mới |
|---|---|---|---|---|---|
| Sàn TMĐT | KHCN-Thanh-Hoa/5-san-tmdt | staging (k3s, Flux) | stg-deploy-sangiaodich.dmst.vn | `gitops-kustomize` (có từ 27/11) | `/p/san-tmdt/staging/` |
| DNSO | KHCN-Thanh-Hoa/doanhnghiepso | staging DMST_05 (compose, xanh/lục) | stg-deploy-dnso.senow.tech | `ssh-compose` (mới) | `/p/dnso/staging/` |
| Thi viên chức | KHCN-Thanh-Hoa/thi-vien-chuc | staging (k3s, ns `stg-thi-vien-chuc`) | stg-deploy-thi-vien-chuc.dmst.vn | `k8s-image` (mới) | `/p/thi-vien-chuc/staging/` |

DNSO dùng CI của `dnso-stg/kiem-tra.ts`. Thi viên chức: lượt tự động khi push `main` được làm lại CSDL khi `schema.sql` đổi (như
`AUTO_RESET_DB=1` của trang cũ).

### Không quản lý trên nền tảng (quyết định 28/11/2026)

| Dự án | Môi trường | Trang riêng |
|---|---|---|
| DNSO | staging VPS Senow/HappyFinate (VPS tự build) | hf-deploy-dnso.senow.tech (`dnso-hf`), giữ nguyên |

### Có triển khai nhưng KHÔNG phải staging (chưa đưa vào, chờ anh quyết)

| Dự án | Thư mục | Đang chạy ở đâu | Cách triển khai hiện tại | Ghi chú |
|---|---|---|---|---|
| HemoNet (huyethoc) | `D:\DMST\huyethoc` | VPS HappyFinate `/opt/hamonet-iot` (ảnh `hemonet/*:e8ecbcd-hm61`, web `1c6e583-hm62`) | `.github/workflows/ci.yml` + `trien-khai.yml` (pilot, SSH, có duyệt); thực tế build tay | Môi trường **pilot** (gần production). GitHub Actions của org đang bị khoá thanh toán nên workflow không chạy. |
| sanpham | `D:\DMST\sanpham` | `DMST_06` `/data/sanpham` (ảnh `sanpham-*:thu`) | `deploy/trien-khai.sh` chạy tay từ PC (build local, `docker save \| ssh`) | Commit ghi "Triển khai **production**". Hợp kiểu `ssh-compose` nếu muốn thêm staging. |
| THVC web | `D:\DMST\THVC_web` (không phải git) | VPS HappyFinate `/opt/thvc` (`api-thvc.dmst.vn`) | `deploy/deploy.sh` chạy tay | Không có kho git nên chưa đưa vào được (nền tảng build từ commit trên GitHub). |
| Thuyết trình huyết học | `D:\DMST\thuyet-trinh-huyet-hoc` | VPS HappyFinate `/opt/hemonet-thuyet-trinh` | `deploy/deploy.sh` (trang tĩnh) | Trang trình bày, không có staging. |
| devsync | `D:\DMST\devsync` | VPS HappyFinate `/opt/devsync` | `server/deploy.sh` | Công cụ cá nhân (kho NguyenDuyVan/devsync). |

### Không có dấu hiệu triển khai

`Data4Life` (chỉ compose OTA thử), `PhanMemBVTinh` (compose dev, không git), `MCP`, `dnso-vscode`, `phan-tich-co-phieu`,
`tai-nhan-su-web` (chạy trên chính PC qua tunnel `nhansu-dmst`), `env-server-happyfinate`.

### Chạy trên server nhưng mã nguồn không nằm trong D:\DMST

Trên VPS HappyFinate còn các stack: `vcf-staging`, `vln-staging`, `thihub`, `sqtt`, `hocluat`, `happyfinate`,
`zalo-gateway`, `demo-gpm-pay`. Hai stack tên `*-staging` (vcf, vln) là staging thật nhưng mã ở chỗ khác nên không nằm
trong lần quét này. Nếu muốn đưa vào, cho em đường dẫn kho.

## Trạng thái và việc còn lại

- Nền tảng vẫn ở **bản xem trước** (`PREVIEW=1`): đọc trạng thái thật của cả 3 môi trường; chạy kiểm tra, build,
  deploy, restart chỉ ghi lệnh ra log. Các trang cũ vẫn là nơi thao tác thật.
- Để chạy thật (`PREVIEW=0`): thêm `https://cicd.dmst.vn` vào Authorized JavaScript origins của OAuth client Google;
  chép khoá báo nhóm DNSO của từng dự án vào `secrets.json` của nền tảng (`dnso/DNSO_API_KEY`, `thi-vien-chuc/DNSO_API_KEY`...);
  chạy song song trang cũ ít nhất một lượt deploy mỗi môi trường rồi mới tắt trang cũ.
