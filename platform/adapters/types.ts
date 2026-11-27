// Giao diện chung của bộ chuyển đổi triển khai (adapter). Mỗi dự án × môi trường có một adapter; server chỉ gọi qua
// giao diện này nên thêm kiểu triển khai mới (ssh-compose, k8s-direct...) không phải sửa server.
import type { Log } from "../lib";
import type { Job } from "../queue";
import type { Repo } from "../repo";

export type ServiceInfo = { key: string; label: string; defaultBuild?: boolean };
export interface EnvAdapter {
  kind: string;                              // tên kiểu, cũng là tên tệp giao diện web/<kind>.js
  services: ServiceInfo[];
  repo: Repo;
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
}
