// Job (build/deploy) và lượt kiểm tra (CI): lưu trong SQLite (bảng jobs, checks, cột data = JSON), log từng lượt ở
// WORK/logs/<id>.log. Hàng đợi job riêng cho từng dự án × môi trường (lỗi/chậm của dự án này không chặn dự án khác);
// kiểm tra dùng MỘT hàng đợi chung vì mỗi lượt chiếm nhiều CPU/RAM của PC.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import { PREVIEW, WORK, now, type Log } from "./lib";
import type { CheckRun } from "./ci";

const LOGS = join(WORK, "logs");
mkdirSync(LOGS, { recursive: true });
const logFile = (id: string) => join(LOGS, `${id}.log`);
const clean = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");

export type Status = "queued" | "running" | "ok" | "failed";
export type Job = {
  id: string; project: string; env: string; kind: "build" | "deploy"; user: string; userId?: number | null;
  ref: string; sha?: string; subject?: string; services: string[]; deploy: boolean; bypass?: boolean; reason?: string; auto?: boolean;
  status: Status; created: string; started?: string; ended?: string; error?: string;
  tags: Record<string, string>; commit?: string | null;
  opts?: Record<string, boolean>;  // tuỳ chọn adapter khai ở `options` (migrate, làm lại CSDL...)
  notify?: { phienBan: string; tu: string | null; den: string | null };
};

// Log đang chạy giữ trong RAM (đọc nhanh khi trình duyệt hỏi 1,5 giây/lần), xong thì đọc lại từ tệp.
const live = new Map<string, string[]>();
export function appendLog(id: string, line: string) {
  const l = clean(line);
  let a = live.get(id);
  if (!a) live.set(id, (a = []));
  a.push(l);
  if (a.length > 40_000) a.splice(0, 10_000);
  try { appendFileSync(logFile(id), l + "\n"); } catch {}
}
export function logLines(id: string): string[] {
  const a = live.get(id);
  if (a) return a;
  try { return readFileSync(logFile(id), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

// ---------------- Job ----------------
const saveJob = (j: Job) =>
  db.query("INSERT INTO jobs (id, project, env, kind, status, created, data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
    .run(j.id, j.project, j.env, j.kind, j.status, j.created, JSON.stringify(j));
const jobsMem = new Map<string, Job>(); // job chưa xong (đang chờ/chạy)
export function getJob(id: string): Job | null {
  const m = jobsMem.get(id);
  if (m) return m;
  const r = db.query("SELECT data FROM jobs WHERE id = ?").get(id) as { data: string } | null;
  return r ? JSON.parse(r.data) : null;
}
export function listJobs(project: string, env: string, limit = 30): Job[] {
  const rows = db.query("SELECT id, data FROM jobs WHERE project = ? AND env = ? ORDER BY created DESC LIMIT ?").all(project, env, limit) as { id: string; data: string }[];
  return rows.map((r) => jobsMem.get(r.id) ?? JSON.parse(r.data));
}
export const lastJob = (project: string, env: string) => listJobs(project, env, 1)[0] ?? null;
export const busyJobs = (project?: string, env?: string) =>
  [...jobsMem.values()].filter((j) => (!project || j.project === project) && (!env || j.env === env)).length;

const queues = new Map<string, Promise<void>>();
export type Hooks = { after?: (j: Job, log: Log) => Promise<void>; idle?: () => void };
export function enqueue(j: Job, work: (j: Job, log: Log) => Promise<void>, hooks: Hooks = {}) {
  jobsMem.set(j.id, j);
  saveJob(j);
  const key = `${j.project}/${j.env}`;
  const q = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const log = (l: string) => appendLog(j.id, l);
    j.status = "running"; j.started = now(); saveJob(j);
    try { await work(j, log); j.status = "ok"; log("✔ Xong."); }
    catch (e: any) { j.status = "failed"; j.error = String(e?.message ?? e); log("✘ " + j.error); }
    j.ended = now();
    try { await hooks.after?.(j, log); } catch (e: any) { log(`⚠ ${e?.message ?? e}`); }
    saveJob(j);
    jobsMem.delete(j.id);
    live.delete(j.id);
    console.log(`${j.ended} job ${j.id} ${j.project}/${j.env} ${j.kind} ${j.status} (${j.user})`);
    hooks.idle?.();
  });
  queues.set(key, q);
}

// ---------------- Kiểm tra ----------------
const saveCheck = (c: CheckRun) =>
  db.query("INSERT INTO checks (id, project, sha, status, created, data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
    .run(c.id, c.project, c.sha, c.status, c.created, JSON.stringify(c));
const checksMem = new Map<string, CheckRun>();
export function getCheck(id: string): CheckRun | null {
  const m = checksMem.get(id);
  if (m) return m;
  const r = db.query("SELECT data FROM checks WHERE id = ?").get(id) as { data: string } | null;
  if (r) return JSON.parse(r.data);
  for (const p of legacyDirs.keys()) { const x = legacyChecks(p).find((c) => c.id === id); if (x) return x; }
  return null;
}
// Log lượt kiểm tra (cả lượt của trang cũ)
export function checkLogLines(c: CheckRun): string[] {
  if (!c.legacy) return logLines(c.id);
  try { return readFileSync(join(legacyDirs.get(c.project)!, `${c.id}.log`), "utf8").split("\n").filter(Boolean); } catch { return []; }
}
// Bản xem trước: kết quả CI của trang cũ (WORK cũ/checks/*.json), đọc lại tối đa 30 giây/lần.
const legacyDirs = new Map<string, string>();
const legacyCache = new Map<string, { at: number; list: CheckRun[] }>();
export const setLegacyChecks = (project: string, dir: string) => legacyDirs.set(project, dir);
function legacyChecks(project: string): CheckRun[] {
  const dir = legacyDirs.get(project);
  if (!PREVIEW || !dir) return [];
  const c = legacyCache.get(project);
  if (c && Date.now() - c.at < 30_000) return c.list;
  const list: CheckRun[] = [];
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-200)) {
      try { const x = JSON.parse(readFileSync(join(dir, f), "utf8")); delete x.log; list.push({ ...x, project, legacy: true }); } catch {}
    }
  } catch {}
  list.sort((a, b) => b.created.localeCompare(a.created));
  legacyCache.set(project, { at: Date.now(), list });
  return list;
}
// Lượt kiểm tra mới nhất của commit
export function checkOf(project: string, sha: string): CheckRun | null {
  const mem = [...checksMem.values()].filter((c) => c.project === project && c.sha === sha).sort((a, b) => b.created.localeCompare(a.created))[0];
  if (mem) return mem;
  const r = db.query("SELECT data FROM checks WHERE project = ? AND sha = ? ORDER BY created DESC LIMIT 1").get(project, sha) as { data: string } | null;
  if (r) return JSON.parse(r.data);
  return legacyChecks(project).find((c) => c.sha === sha) ?? null;
}
export function listChecks(project: string, limit = 15): CheckRun[] {
  const rows = db.query("SELECT id, data FROM checks WHERE project = ? ORDER BY created DESC LIMIT ?").all(project, limit) as { id: string; data: string }[];
  const mine = rows.map((r) => checksMem.get(r.id) ?? JSON.parse(r.data));
  return [...mine, ...legacyChecks(project).slice(0, limit)].sort((a, b) => b.created.localeCompare(a.created)).slice(0, limit);
}
export const activeChecks = () => [...checksMem.values()];

let checkQueue: Promise<void> = Promise.resolve();
export function enqueueCheck(c: CheckRun, work: (c: CheckRun, log: Log, changed: () => void) => Promise<void>, hooks: { after?: (c: CheckRun) => Promise<void>; idle?: () => void } = {}) {
  checksMem.set(c.id, c);
  saveCheck(c);
  checkQueue = checkQueue.then(async () => {
    if (c.superseded) { // lượt tự động bị thay bởi commit mới hơn của cùng nhánh khi còn đang chờ: bỏ hẳn
      checksMem.delete(c.id);
      db.query("DELETE FROM checks WHERE id = ?").run(c.id);
      hooks.idle?.();
      return;
    }
    const log = (l: string) => appendLog(c.id, l);
    c.status = "running"; c.started = now(); saveCheck(c);
    let t: Timer | null = null;
    const changed = () => { t ??= setTimeout(() => { t = null; saveCheck(c); }, 1000); };
    try { await work(c, log, changed); c.status = "ok"; log("✔ Kiểm tra đạt, có thể Build commit này."); }
    catch (e: any) { c.status = "failed"; c.error = String(e?.message ?? e); log("✘ " + c.error); }
    if (t) clearTimeout(t);
    c.ended = now();
    saveCheck(c);
    checksMem.delete(c.id);
    live.delete(c.id);
    console.log(`${c.ended} kiểm tra ${c.id} ${c.project} ${c.sha.slice(0, 7)} ${c.status} (${c.user})`);
    try { await hooks.after?.(c); } catch (e: any) { console.error("Sau kiểm tra lỗi:", e?.message ?? e); }
    hooks.idle?.();
  });
}

// Khởi động: job/lượt kiểm tra còn dở của lần chạy trước coi như bị ngắt; dọn log quá 1000 lượt.
for (const table of ["jobs", "checks"]) {
  for (const r of db.query(`SELECT id, data FROM ${table} WHERE status IN ('queued','running')`).all() as { id: string; data: string }[]) {
    const x = JSON.parse(r.data);
    x.status = "failed"; x.error = "Bị ngắt do trang khởi động lại, chạy lại"; x.ended ??= now();
    db.query(`UPDATE ${table} SET status = 'failed', data = ? WHERE id = ?`).run(JSON.stringify(x), r.id);
  }
}
try { const fs = readdirSync(LOGS).sort(); for (const f of fs.slice(0, Math.max(0, fs.length - 1000))) rmSync(join(LOGS, f)); } catch {}
