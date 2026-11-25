#!/usr/bin/env bash
# Build & triển khai staging DNSO trên VPS HappyFinate từ một commit trong kho git trần /opt/dnso-staging/repo.git.
# Trang dnso-hf trên PC đẩy commit vào repo.git (git push qua SSH) rồi chạy script này tách khỏi phiên SSH
# (setsid nohup), nên PC rớt mạng giữa chừng thì lượt build vẫn chạy hết. Script do PC chép đè mỗi lượt build:
# sửa ở repo dmst-cicd (dnso-hf/vps/build-tu-git.sh), đừng sửa tay trên VPS.
#
#   build-tu-git.sh <sha 40 ký tự> [người bấm]
#
# Các bước (giống cap-nhat.sh cũ, nhưng lấy mã từ git thay vì tar qua stdin):
#   1. git archive <sha>:app → src.moi/app, chép node_modules đang dùng sang cho bun install gần như không phải tải;
#   2. bun install + bun run build trong container giới hạn 1.5 CPU / 4 GB (VPS còn chạy nhiều dự án khác);
#   3. đổi src ↔ src.moi, migrate CSDL staging (Node thật ở /opt/dnso-staging/node, xem cap-nhat.sh);
#      migrate lỗi → trả mã cũ về chỗ, web/worker không bị đụng;
#   4. dựng lại web + worker, chờ /suc-khoe qua Traefik "ok"; không lành sau 120 giây → trả mã cũ, dựng lại;
#   5. ghi PHIEN_BAN và một dòng lich-su-trien-khai.log "<ngày> <giờ> <thẻ> <người>".
# Dòng cuối luôn là "@@MA_THOAT <mã>" để trang trên PC biết kết quả.
set -euo pipefail
trap 'echo "@@MA_THOAT $?"' EXIT

SHA="${1:-}"
AI="${2:-?}"
DIR=/opt/dnso-staging
HOST_KIEM=dmst.senow.tech
cd "$DIR"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "✘ sha không hợp lệ: $SHA"; exit 2; }
exec 9>"$DIR/.build.lock"
flock -n 9 || { echo "✘ Đang có lượt build khác trên VPS, đợi xong rồi bấm lại."; exit 3; }
git -C repo.git cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "✘ repo.git trên VPS chưa có commit $SHA"; exit 2; }
THE="${SHA:0:8}"
t0=$(date +%s)
buoc() { echo; echo "══ $* ($(( $(date +%s) - t0 ))s)"; }

buoc "Lấy mã $THE từ repo.git ($(git -C repo.git log -1 --format=%s "$SHA"))"
rm -rf src.moi src.loi
mkdir -p src.moi/app
git -C repo.git archive --format=tar "$SHA:app" | tar -x -C src.moi/app
if [ -d src/app/node_modules ]; then cp -a src/app/node_modules src.moi/app/; fi
echo "Đã giải mã nguồn vào src.moi/app."

buoc "bun install + bun run build (1.5 CPU / 4 GB)"
docker rm -f dnso-staging-build >/dev/null 2>&1 || true
nice -n 10 docker run --rm --name dnso-staging-build --cpus=1.5 --memory=4g -e PUPPETEER_SKIP_DOWNLOAD=1 \
  -v "$DIR/src.moi/app:/app" -w /app oven/bun:1.4.2 sh -c "bun install --frozen-lockfile && bun run build"

# Container đang chạy giữ inode thư mục cũ nên đổi tên src không làm web/worker hiện tại hỏng.
tra_ma_cu() {
  echo "↩ Trả mã cũ về chỗ (mã lỗi để ở src.loi)."
  rm -rf src.loi && mv src src.loi && mv src.cu src
}
buoc "Đổi mã + migrate CSDL staging"
rm -rf src.cu && mv src src.cu && mv src.moi src
if ! docker compose run --rm --no-deps -T -v "$DIR/node:/opt/node:ro" \
    -e PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin web bun run db:migrate </dev/null; then
  echo "✘ Migrate lỗi: web/worker vẫn chạy bản cũ."
  tra_ma_cu
  exit 4
fi

buoc "Dựng lại web + worker"
docker compose up -d --force-recreate web worker </dev/null
kiem() { curl -sk -m 8 --resolve "$HOST_KIEM:443:127.0.0.1" "https://$HOST_KIEM/suc-khoe" 2>/dev/null || true; }
lanh=""
for i in $(seq 1 40); do
  sleep 3
  r="$(kiem)"
  if echo "$r" | grep -q '"trangThai":"ok"'; then lanh=1; break; fi
done
if [ -z "$lanh" ]; then
  echo "✘ /suc-khoe không ok sau 120 giây: ${r:0:300}"
  docker compose logs --no-color --tail 40 web </dev/null || true
  tra_ma_cu
  docker compose up -d --force-recreate web worker </dev/null
  echo "Đã dựng lại web/worker với mã cũ (CSDL đã migrate theo bản mới, thường vẫn tương thích ngược)."
  exit 5
fi
echo "✓ /suc-khoe qua Traefik: ok."

rm -rf src.cu
echo "$THE" > PHIEN_BAN
echo "$(TZ=Asia/Ho_Chi_Minh date '+%F %T') $THE $AI" >> lich-su-trien-khai.log
# Giữ 60 log build gần nhất
ls -1t nhat-ky-build/*.log 2>/dev/null | tail -n +61 | xargs -r rm -f
buoc "✔ Staging đang chạy $THE"
