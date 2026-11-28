"use strict";
// Trang chủ: mỗi dự án × môi trường người dùng được xem là một thẻ (trạng thái, lượt build gần nhất, vai trò).
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (t) => {
  if (!t) return "";
  const s = (Date.now() - new Date(t)) / 1000;
  if (s < 45) return "vừa xong";
  if (s < 3600) return Math.round(s / 60) + " phút trước";
  if (s < 86400) return Math.round(s / 3600) + " giờ trước";
  return Math.round(s / 86400) + " ngày trước";
};
const JOB = { queued: ["idle", "Đang chờ"], running: ["run", "Đang chạy"], ok: ["ok", "Thành công"], failed: ["bad", "Lỗi"] };

async function load() {
  try {
    const r = await fetch("/api/envs");
    if (r.status === 401) return location.reload();
    const list = await r.json();
    if (!r.ok) throw new Error(list.error || "Lỗi " + r.status);
    if (!list.length) {
      $("#cards").innerHTML = '<div class="empty">Bạn chưa được gán quyền ở dự án nào. Nhờ quản trị viên hoặc Project Admin gán quyền.</div>';
      return;
    }
    $("#cards").innerHTML = list.map((e) => {
      const s = e.summary || {};
      const cls = s.ok === true ? "ok" : s.ok === false ? "bad" : "warn";
      const j = e.lastJob;
      const jt = j ? JOB[j.status] : null;
      return '<a class="card" href="/p/' + esc(e.project) + "/" + esc(e.env) + '/">'
        + '<div class="card-h"><img src="/s/' + esc(e.logo) + '" alt=""><div><div class="card-t">' + esc(e.name) + "</div>"
        + '<div class="muted">' + esc(e.envLabel) + " · " + esc(e.repo) + '</div></div><span class="pill">' + esc(e.roleLabel) + "</span></div>"
        + '<div class="card-s"><span class="sdot ' + cls + '"></span>' + esc(s.text || "") + "</div>"
        + '<div class="card-f">' + (j
          ? '<span class="pill ' + jt[0] + '">' + jt[1] + "</span> " + (j.kind === "build" ? "Build " : "Đổi bản ") + "<code>" + esc(j.ref) + "</code> · " + esc(j.user) + " · " + ago(j.ended || j.created)
          : '<span class="muted">Chưa có lượt build nào trên trang này</span>') + "</div></a>";
    }).join("");
  } catch (e) {
    $("#cards").innerHTML = '<div class="alert alert-bad">Không tải được danh sách: ' + esc(e.message) + "</div>";
  }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
