# syntax=docker/dockerfile:1
# Ảnh tmdt-stg-deploy: trang deploy thủ công cụm staging (stg-deploy-sangiaodich.dmst.vn).
# Ngữ cảnh build: thư mục deploy/stg-deploy/. Không có gói phụ thuộc (chỉ API có sẵn của Bun).
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-alpine
ENV TZ=Asia/Ho_Chi_Minh NODE_ENV=production
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server.ts ui.ts ./
USER 1000:1000
EXPOSE 8080
CMD ["bun", "server.ts"]
