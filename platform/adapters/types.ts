// Giao diện chung của bộ chuyển đổi triển khai (adapter). Mỗi dự án × môi trường có một adapter; server chỉ gọi qua
// giao diện này nên thêm kiểu triển khai mới (ssh-compose, k8s-direct...) không phải sửa server.
import type { Log } from "../lib";
import type { Job } from "../queue";
import type { Repo } from "../repo";

export type ServiceInfo = { key: string; label: string; defaultBuild?: boolean };
// Tuỳ chọn bật/tắt người bấm gửi kèm Build hoặc Đổi bản (vd. migrate, làm lại CSDL). Server chỉ nhận đúng các khoá khai ở
// đây (giá trị boolean), ghi vào job.opts; adapter tự đọc. Giao diện web/<kind>.js tự vẽ ô chọn.
export type JobOption = { key: string; on: "build" | "deploy" | "both"; perm?: "build" | "deploy" | "bypass" };
export interface EnvAdapter {
  kind: string;                              // tên kiểu, cũng là tên tệp giao diện web/<kind>.js
  services: ServiceInfo[];
  repo: Repo;
  // true: một lượt Build/Đổi bản luôn áp cho CẢ bản phát hành (mọi service cùng thẻ), không chọn từng service.
  // Server bỏ qua `services`/`svc` người bấm gửi, ghi job.services = các service defaultBuild.
  wholeRelease?: boolean;
  options?: JobOption[];
  start(): void;                             // tiến trình phụ (kubectl proxy...)
  state(): Promise<Record<string, unknown>>; // trạng thái môi trường cho trang (service, pod, Flux...)
  summary(): Promise<{ ok: boolean | null; text: string }>; // một dòng cho thẻ ở trang chủ
  history(): Promise<unknown[]>;
  tags(svc: string): Promise<unknown[]>;
  logs(q: URLSearchParams): Promise<unknown>;
  build(j: Job, log: Log): Promise<void>;
  deploy(j: Job, log: Log): Promise<void>;
  restart(svc: string, who: string): Promise<void>;
  reconcile?(): Promise<void>;
  // Phiên bản đang chạy (sha hoặc tiền tố sha). CD tự động bỏ qua commit đang chạy rồi.
  currentSha?(): Promise<string | null>;
}
