# Môi trường chạy kiểm tra (CI) của stg-deploy: giống runner của .github/workflows/ci.yml (Bun 1.3.14, Node 24).
# Mỗi lượt kiểm tra là một container dùng một lần, mã nạp bằng git archive (không mount thư mục của PC, không bí mật).
# Đổi tệp này: server.ts tự build lại ảnh (thẻ theo băm nội dung).
# Chạy bằng user thường "bun" như runner CI: embedded-postgres (kiểm thử hợp đồng) từ chối initdb bằng root, cần libpq5.
FROM node:24-bookworm-slim AS node

FROM oven/bun:1.3.14
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssl procps libpq5 locales \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name ci && git config --system user.email ci@stg-deploy.local \
 && git config --system init.defaultBranch main && git config --system safe.directory '*' \
 && mkdir -p /w /home/bun/.bun/install/cache && chown -R bun:bun /w /home/bun
ENV LANG=C.UTF-8
USER bun
WORKDIR /w
CMD ["sleep", "infinity"]
