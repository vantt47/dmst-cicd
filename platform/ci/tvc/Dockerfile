# Môi trường chạy Kiểm tra (CI) của tvc-stg: cùng bản Node với Dockerfile.uat của kho thi-vien-chuc (node:20-bookworm-slim),
# thêm git, openssl (Prisma), psql (nạp database/schema.sql + seed.sql vào CSDL kiểm thử).
# Mỗi lượt kiểm tra là một container dùng một lần, mã nạp bằng git archive (không mount thư mục của PC, không bí mật).
# Đổi tệp này: kiem-tra.ts tự build lại ảnh (thẻ theo băm nội dung).
FROM node:20-bookworm-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates openssl postgresql-client tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /w
ENV LANG=C.UTF-8 TZ=Asia/Ho_Chi_Minh CI=true \
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=recruit_ci PGPASSWORD=recruit_ci PGDATABASE=recruit_exam_ci
WORKDIR /w
CMD ["sleep", "infinity"]
