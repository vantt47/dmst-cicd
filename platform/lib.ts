// Tiện ích chung: chạy tiến trình con, ống dẫn, giữ sống tiến trình phụ, cấu hình chung của nền tảng.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const E = process.env;
// PREVIEW=1 (mặc định): bản xem trước. Chỉ ĐỌC trạng thái thật (cụm, máy staging, GHCR, git, kết quả CI của trang cũ);
// mọi thao tác ghi (chạy CI, build, push ảnh, commit đổi thẻ, deploy, restart, báo nhóm) chỉ giả lập và ghi ra log.
export const PREVIEW = (E.PREVIEW ?? "1") !== "0";
export const PORT = Number(E.PORT ?? 8090);
export const WORK = E.WORK_DIR ?? (PREVIEW ? "D:/DMST/cicd-preview-work" : "D:/DMST/cicd-work");
export const PUBLIC_HOST = E.PUBLIC_HOST ?? "cicd.dmst.vn";
mkdirSync(WORK, { recursive: true });

// Bí mật của nền tảng: WORK/secrets.json (chỉ user Windows đọc). Không bao giờ in ra log hay trả qua API.
const SECRETS_FILE = join(WORK, "secrets.json");
export const secrets: Record<string, string> = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
if (!secrets.SESSION_SECRET) { secrets.SESSION_SECRET = randomBytes(32).toString("hex"); writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2)); }
export const secret = (k: string) => E[k] ?? secrets[k] ?? "";

export type Log = (l: string) => void;
export type RunOpts = { cwd?: string; env?: Record<string, string>; onLine?: Log; quiet?: boolean; stdin?: ReadableStream<Uint8Array> | null };
export async function run(cmd: string[], o: RunOpts = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...E, ...o.env }, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of s) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === "\r" ? i + 2 : i + 1);
        if (out.length < 200_000) out += line + "\n";
        o.onLine?.(line);
      }
    }
    if (buf) { out += buf; o.onLine?.(buf); }
  };
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  return { code: await p.exited, out };
}
export async function must(cmd: string[], o: RunOpts = {}) {
  const r = await run(cmd, o);
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
  return r.out;
}
// Ống dẫn a | b, báo lỗi của bên hỏng
export async function pipe(a: string[], b: string[], log: Log) {
  const pa = Bun.spawn(a, { stdout: "pipe", stderr: "pipe" });
  const r = await run(b, { stdin: pa.stdout, onLine: log });
  const ca = await pa.exited;
  if (ca !== 0) throw new Error(`${a.slice(0, 2).join(" ")} lỗi (mã ${ca}): ${(await new Response(pa.stderr).text()).trim().slice(-300)}`);
  if (r.code !== 0) throw new Error(`${b.slice(0, 2).join(" ")} lỗi (mã ${r.code}): ${r.out.trim().split("\n").slice(-3).join(" | ")}`);
}

// Thao tác GHI: bản xem trước chỉ ghi lệnh ra log, không chạy.
export const show = (cmd: string[]) => cmd.map((x) => (/[\s'"|&;<>$]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(" ");
export async function act(log: Log, what: string, real: () => Promise<unknown>, cmds: string[][] = []) {
  if (!PREVIEW) return real();
  log(`[THỬ] ${what}`);
  for (const c of cmds) log(`[THỬ]   $ ${show(c)}`);
  await Bun.sleep(400);
  return undefined;
}

// Giữ sống tiến trình phụ (kubectl proxy, cloudflared), chạy lại sau 5 giây nếu thoát.
export const children = new Set<ReturnType<typeof Bun.spawn>>();
export const lifecycle = { exiting: false };
export function keepAlive(name: string, cmd: () => string[] | null, env: Record<string, string> = {}) {
  const start = () => {
    if (lifecycle.exiting) return;
    const c = cmd();
    if (!c) return console.log(`[${name}] bỏ qua (thiếu cấu hình)`);
    const p = Bun.spawn(c, { env: { ...E, ...env }, stdout: "ignore", stderr: "pipe" });
    children.add(p);
    console.log(`[${name}] chạy pid ${p.pid}`);
    (async () => { let n = 0; for await (const ch of p.stderr) { if (n++ < 50) process.stdout.write(`[${name}] ${new TextDecoder().decode(ch)}`); } })();
    p.exited.then((code) => {
      children.delete(p);
      if (lifecycle.exiting) return;
      console.log(`[${name}] thoát mã ${code}, chạy lại sau 5 giây`); setTimeout(start, 5000);
    });
  };
  start();
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");
export const now = () => new Date().toISOString();
export const thoiLuong = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m ? `${m} phút ${s % 60} giây` : `${s} giây`;
};
export const REF_OK = /^(?!.*\.\.)(?!-)[A-Za-z0-9._\/-]{1,100}$/;
export const TAG_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
