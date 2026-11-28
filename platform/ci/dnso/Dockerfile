# Môi trường chạy Kiểm tra (CI) của dnso-stg: đúng bản Bun của app/Dockerfile trong kho DNSO (ARG BUN_VERSION), cộng
# Node THẬT (scripts/migrate.ts gọi drizzle-kit bằng `node --import …`, cần module.registerHooks của Node ≥ 22.15) để
# `bun run kiem-thu:csdl` dựng được lược đồ CSDL kiểm thử.
# Mỗi lượt kiểm tra là một container dùng một lần, mã nạp bằng git archive (không mount thư mục của PC, không bí mật).
# Đổi tệp này: kiem-tra.ts tự build lại ảnh (thẻ theo băm nội dung).
FROM node:22-bookworm-slim AS node

FROM oven/bun:1.3.14
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name ci && git config --system user.email ci@dnso-stg.local \
 && git config --system init.defaultBranch main && git config --system safe.directory '*' \
 && mkdir -p /w
# Giờ VN như máy chủ thật: nhiều phép kiểm ngày tháng giả định Asia/Ho_Chi_Minh.
ENV LANG=C.UTF-8 TZ=Asia/Ho_Chi_Minh
WORKDIR /w
CMD ["sleep", "infinity"]
