// Báo nhóm Nhắn tin DNSO: mỗi lượt triển khai (job có deploy) gửi đúng MỘT tin kết quả khi xong, viết cho thành viên không
// làm kỹ thuật (định dạng đã chốt 14/11/2026, giữ nguyên từ stg-deploy): tiêu đề nói rõ chuyện gì xảy ra, chỉ liệt kê thay
// đổi người dùng thấy được (feat/fix/perf dịch sang tiếng Việt), liên kết mở thẳng trang staging. Báo tin là việc phụ: lỗi
// chỉ ghi cảnh báo vào log job. Khoá/nhóm của từng dự án nằm trong secrets.json của nền tảng (`<dự án>/DNSO_API_KEY`...).
import { act, run, secret, type Log } from "./lib";
import type { Job } from "./queue";

export type DnsoCfg = {
  duAn: string; moiTruong: string; trang: string; // trang: liên kết mở khi bấm vào thẻ
  ok: string; fail: string;                       // tiêu đề tin thành công / thất bại
};
const URL_DNSO = () => (secret("DNSO_URL") || "https://dmst.dnso.vn").replace(/\/+$/, "");
const keys = (project: string) => ({
  key: secret(`${project}/DNSO_API_KEY`), thayMat: secret(`${project}/DNSO_THAY_MAT`), nhom: secret(`${project}/DNSO_NHOM_ID`),
});

export const thoiLuong = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m ? `${m} phút ${s % 60} giây` : `${s} giây`;
};

// Tiêu đề commit → câu cho người không làm kỹ thuật. null = thay đổi kỹ thuật, không đưa lên thẻ.
export function dichCommit(tieuDe: string): string | null {
  const t = tieuDe.trim();
  if (/^(staging|production)\s*\((stg|prod)-deploy|dmst-cicd\)|^merge\b/i.test(t)) return null;
  const m = t.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
  if (!m) return t;
  const noi = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  const loai = m[1].toLowerCase();
  if (loai === "feat") return `Mới: ${noi}`;
  if (loai === "fix" || loai === "hotfix" || loai === "fixbug") return `Sửa lỗi: ${noi}`;
  if (loai === "perf") return `Nhanh hơn: ${noi}`;
  return null;
}

async function commits(repo: string, tu: string | null, den: string | null) {
  if (!den) return {};
  const range = tu ? [`${tu}..${den}`] : ["-1", den];
  const out = (await run(["git", "-C", repo, "log", "--no-merges", "-n", "200", "--format=%an%x1f%s", ...range], { quiet: true })).out;
  const da = new Set<string>();
  const list = out.split("\n").filter(Boolean)
    .map((l) => { const [tacGia, s] = l.split("\x1f"); const tieuDe = dichCommit(s ?? ""); return tieuDe ? { ma: "", tieuDe, tacGia } : null; })
    .filter((c): c is { ma: string; tieuDe: string; tacGia: string } => !!c && !da.has(c.tieuDe) && !!da.add(c.tieuDe));
  return list.length ? { commits: list.slice(0, 15), tongCommit: list.length } : {};
}

async function post(project: string, than: unknown, log: Log) {
  const k = keys(project);
  let cuoi = "";
  for (let lan = 1; lan <= 3; lan++) {
    let ma = 0, text = "";
    try {
      const r = await fetch(`${URL_DNSO()}/api/v1/nhan-tin/nhom/${encodeURIComponent(k.nhom)}/thong-bao`, {
        method: "POST",
        headers: { Authorization: `Bearer ${k.key}`, "X-Thay-Mat": k.thayMat, "Content-Type": "application/json" },
        body: JSON.stringify(than), signal: AbortSignal.timeout(20_000),
      });
      ma = r.status; text = await r.text();
    } catch (e: any) { text = String(e?.message ?? e); }
    if (ma === 202) { log(`Báo nhóm DNSO: HTTP 202, tin chờ người duyệt.`); return; }
    if (ma >= 200 && ma < 300) { log(`Báo nhóm DNSO: HTTP ${ma}, đã đăng.`); return; }
    let loi = text.slice(0, 300);
    try { loi = JSON.parse(text).loi ?? loi; } catch {}
    cuoi = `HTTP ${ma || "lỗi mạng"}: ${loi}`;
    if (ma >= 400 && ma < 500) break; // sai khoá/quyền/nhóm: thử lại vô ích
    if (lan < 3) await Bun.sleep(lan * 3000);
  }
  log(`⚠ Báo nhóm DNSO không thành công (${cuoi}), bỏ qua.`);
}

// Gọi khi job xong (hook `after` của hàng đợi). j.notify do adapter ghi lúc bắt đầu triển khai.
export async function notifyDone(cfg: DnsoCfg | undefined, repo: string, j: Job, log: Log) {
  if (!cfg || !j.deploy || !j.notify) return;
  const k = keys(j.project);
  if (!k.key || !k.thayMat || !k.nhom) { log(`Báo nhóm DNSO: chưa cấu hình ${j.project}/DNSO_API_KEY, DNSO_THAY_MAT, DNSO_NHOM_ID, bỏ qua.`); return; }
  const b = j.notify;
  const ok = j.status === "ok";
  const than = {
    trangThai: ok ? "success" : "failure",
    tieuDe: ok ? cfg.ok : cfg.fail,
    tacGia: j.user,
    thoiLuong: thoiLuong(Date.parse(j.ended ?? new Date().toISOString()) - Date.parse(j.started!)),
    khoaGop: `${cfg.duAn}|${cfg.moiTruong}|${b.den ?? b.phienBan}|${j.id}`,
    lienKet: cfg.trang,
    ...(ok ? {} : { noiDung: `Mọi người vẫn dùng bản cũ bình thường.\nChi tiết cho đội kỹ thuật (phiên bản ${b.phienBan}): ${(j.error ?? "Không rõ nguyên nhân").slice(0, 400)}` }),
    ...(await commits(repo, b.tu, b.den)),
  };
  await act(log, `Báo nhóm DNSO: "${than.tieuDe}" (${(than as any).tongCommit ?? 0} thay đổi)`, () => post(j.project, than, log));
}
