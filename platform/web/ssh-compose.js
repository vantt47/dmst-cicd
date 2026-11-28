"use strict";
// Trang một dự án × môi trường kiểu ssh-compose (DNSO staging trên máy Docker Compose; chuyển từ dnso-stg/app.js, không
// framework). API ở <base>/api/..., nút hiện theo quyền của người đang đăng nhập (S.perms); server vẫn kiểm quyền mọi API.
// Một lượt Build/Đổi bản luôn áp cho cả bản phát hành (web + worker cùng thẻ), không chọn từng service.
const BASE = document.body.dataset.base;
let ENV = document.body.dataset.env || "staging";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  spin: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  log: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
};
const ago = (t) => {
  if (!t) return "";
  const s = (Date.now() - new Date(t)) / 1000;
  if (s < 45) return "vừa xong";
  if (s < 3600) return Math.round(s / 60) + " phút trước";
  if (s < 86400) return Math.round(s / 3600) + " giờ trước";
  return Math.round(s / 86400) + " ngày trước";
};
const dur = (a, b) => {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? new Date(b) : Date.now()) - new Date(a)) / 1000));
  return s < 60 ? s + " giây" : Math.floor(s / 60) + " phút " + String(s % 60).padStart(2, "0") + " giây";
};

async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.reload(); throw new Error("Hết phiên đăng nhập"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Lỗi " + r.status);
  return j;
}
function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), bad ? 8000 : 4000);
}

// ---------- Khung riêng của kiểu này (khung chung ở platform/ui.ts) ----------
{
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "/s/ssh-compose.css";
  document.head.append(css);
  $("#topbar-extra").innerHTML = '<a class="flux-chip" id="site-chip" target="_blank" rel="noopener" title="Mở staging"><span class="dot"></span><span class="txt">Staging</span></a>';
  // Không chọn service: Build luôn dựng web + worker cùng thẻ
  const svcField = $("#b-svcs").closest(".field");
  $("span", svcField).textContent = "Bản phát hành";
  $("#b-svcs").innerHTML = '<span class="release-note">Web + Worker (cùng thẻ = 8 ký tự đầu sha), migrate CSDL rồi đổi màu web không gián đoạn</span>';
  const bp = $("#b-bypass").closest("label");
  bp.title = "Khẩn cấp: CI chưa đạt vẫn build/triển khai. Bắt buộc ghi lý do, ghi vào nhật ký.";
  bp.lastElementChild.textContent = "Bỏ qua chặn CI (khẩn cấp)";
  $("#b-only").closest("label").lastElementChild.textContent = "Chỉ build, không triển khai";
  const panel = $("#services").closest(".panel");
  const ph = $(".panel-h", panel);
  $("h2", ph).textContent = "Máy staging";
  ph.insertAdjacentHTML("beforeend", '<span class="panel-sub" id="may-sub"></span><button class="btn btn-sm push-right" id="pick-tag" data-perm="deploy" hidden>' + ICON.swap + "Đổi bản</button>");
  $("#services").insertAdjacentHTML("beforebegin", '<div id="may-head" class="may-head"></div>');
}

// ---------- Hộp thoại ----------
const dlg = $("#dlg");
let onDlgClose = null;
function openDlg(title, body, foot = "", opt = {}) {
  dlg.className = opt.wide ? "wide" : "";
  $("#dlg-title").innerHTML = title;
  const b = $("#dlg-body");
  b.className = "dlg-b" + (opt.term ? " term" : "");
  b.innerHTML = body;
  $("#dlg-foot").innerHTML = foot;
  if (!dlg.open) dlg.showModal();
}
function closeDlg() { if (dlg.open) dlg.close(); }
$("#dlg-close").onclick = closeDlg;
dlg.addEventListener("close", () => { const f = onDlgClose; onDlgClose = null; f && f(); });
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDlg(); });
function confirmBox(title, html, okText = "Xác nhận", danger = false) {
  return new Promise((res) => {
    openDlg(esc(title), '<p class="confirm-msg">' + html + "</p>",
      '<button class="btn" data-a="no">Hủy</button><button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" data-a="yes">' + esc(okText) + "</button>");
    let done = false;
    const fin = (v) => { if (done) return; done = true; res(v); };
    $$("#dlg-foot [data-a]").forEach((b) => (b.onclick = () => { fin(b.dataset.a === "yes"); closeDlg(); }));
    onDlgClose = () => fin(false);
    $('#dlg-foot [data-a="yes"]').focus();
  });
}

// ---------- Trạng thái ----------
let S = null;
const can = (p) => !!(S && S.perms.includes(p));
const needCi = () => !S || S.env.requireCi !== false;
function applyPerms() {
  $$("[data-perm]").forEach((el) => (el.hidden = !can(el.dataset.perm)));
  const rp = $("#role-pill");
  rp.textContent = S.roleLabel;
  rp.title = "Vai trò của bạn ở môi trường này";
  ENV = S.env.label.toLowerCase();
}
function ctStatus(c) {
  if (c.state !== "running") return ["bad", c.state === "exited" ? "Đã dừng" : c.state];
  if (c.health === "unhealthy") return ["bad", "Không lành"];
  if (c.health === "starting") return ["warn", "Đang khởi động"];
  return ["ok", "Đang chạy"];
}
function renderTop() {
  const m = S.may;
  const alerts = [];
  if (!m.ok) alerts.push(["bad", m.error]);
  else if (!m.sucKhoe || m.sucKhoe.trangThai !== "ok") alerts.push(["bad", "/suc-khoe qua cổng vào không ok: " + JSON.stringify(m.sucKhoe || "không trả lời").slice(0, 200)]);
  $("#alerts").innerHTML = alerts.map(([c, t]) => '<div class="alert alert-' + c + '">' + esc(t) + "</div>").join("");
  const chip = $("#site-chip");
  const ok = m.ok && m.sucKhoe && m.sucKhoe.trangThai === "ok";
  chip.href = S.site;
  chip.className = "flux-chip " + (ok ? "ok" : "bad");
  $(".txt", chip).textContent = ok ? "Staging đang chạy" : "Staging lỗi";
  $("#may-sub").textContent = S.sshHost + " · " + S.remoteDir;
  $("#may-head").innerHTML = m.ok
    ? '<span>Bản đang chạy <code class="tag">' + esc(m.phienBan || "?") + "</code></span>"
      + (m.subject ? '<span class="subj">' + esc(m.subject) + "</span>" : "")
      + (m.mau ? "<span>web-" + esc(m.mau) + "</span>" : "")
      + (m.sucKhoe && m.sucKhoe.trangThai ? "<span>CSDL " + esc(m.sucKhoe.csdl || "?") + " · Redis " + esc(m.sucKhoe.redis || "?") + "</span>" : "")
    : "";
}
function renderServices() {
  if (!S.may.ok) { $("#services").innerHTML = '<div class="empty">Không đọc được trạng thái máy staging.</div>'; return; }
  $("#services").innerHTML = S.services.map((s) => {
    const cs = s.containers;
    const [cls, text] = cs.length ? cs.map(ctStatus).sort((a, b) => (a[0] === "bad" ? -1 : b[0] === "bad" ? 1 : 0))[0] : ["bad", "Không có container"];
    return '<div class="svc"><div class="svc-l">'
      + '<div class="svc-name"><span class="sdot ' + cls + '" title="' + esc(text) + '"></span>' + esc(s.label) + ' <span class="pill ' + cls + '">' + esc(text) + "</span></div>"
      + '<div class="svc-meta">' + cs.map((c) => "<span>" + esc(c.name) + " · " + esc(c.status) + "</span>").join("")
      + '<span class="note">' + esc(s.note) + "</span></div></div>"
      + '<div class="svc-act">'
      + (can("logs") ? '<button class="btn btn-sm" data-log="' + s.key + '">' + ICON.log + "Log</button>" : "")
      + (s.restart && can("restart") ? '<button class="btn btn-sm btn-ghost" data-restart="' + s.key + '" title="Khởi động lại">' + ICON.restart + "</button>" : "")
      + "</div></div>";
  }).join("");
  $$("[data-log]").forEach((b) => (b.onclick = () => showLog(b.dataset.log)));
  $$("[data-restart]").forEach((b) => (b.onclick = () => restart(b.dataset.restart)));
}
function renderJobs() {
  const items = [...S.jobs, ...(S.checks || []).map((c) => ({ ...c, kind: "check" }))].sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 30);
  if (!items.length) return;
  const IC = { ok: ICON.check, failed: ICON.x, running: ICON.spin, queued: ICON.clock };
  $("#tab-jobs").innerHTML = items.map((j) => {
    const st = j.status === "running" ? "đang chạy " + dur(j.started) : j.status === "queued" ? "đang chờ" : dur(j.started, j.ended);
    let title, attr;
    if (j.kind === "check") { title = "Kiểm tra <code>" + esc(j.ref) + '</code> <span class="muted mono">@' + esc(j.sha.slice(0, 7)) + "</span>"; attr = 'data-check="' + esc(j.id) + '"'; }
    else if (j.kind === "build") { title = (j.deploy ? "Build & deploy " : "Build ") + "<code>" + esc(j.ref) + "</code>" + (j.sha ? ' <span class="muted mono">@' + esc(j.sha.slice(0, 7)) + "</span>" : ""); attr = 'data-job="' + esc(j.id) + '"'; }
    else { title = "Đổi bản <code>" + esc(j.ref) + "</code>" + (j.opts && j.opts.migrate ? "" : ' <span class="muted">(không migrate)</span>'); attr = 'data-job="' + esc(j.id) + '"'; }
    return '<button class="job" ' + attr + '><span class="job-ic ' + j.status + '">' + IC[j.status] + "</span><span>"
      + '<div class="job-t">' + title + "</div>"
      + (j.subject ? '<div class="job-s">' + esc(j.subject) + "</div>" : "")
      + '<div class="job-s">' + esc(j.user) + (j.legacy ? " (trang cũ)" : "") + " · " + ago(j.created) + " · " + st + "</div>"
      + (j.error ? '<div class="job-err">' + esc(j.error) + "</div>" : "") + "</span></button>";
  }).join("");
  $$("[data-job]").forEach((b) => (b.onclick = () => showJob(b.dataset.job)));
  $$("[data-check]").forEach((b) => (b.onclick = () => showCheck(b.dataset.check)));
}
async function loadHistory() {
  try {
    const h = await api("/api/history");
    $("#tab-hist").innerHTML = h.map((x) => "<a class=\"hist\"" + (x.url ? ' href="' + esc(x.url) + '" target="_blank" rel="noopener"' : "") + ">"
      + '<div class="hist-t">' + esc(x.subject || x.the) + "</div>"
      + '<div class="hist-s"><span class="mono">' + esc(x.the) + "</span> · " + esc(x.mau) + " · " + ago(x.luc) + "</div></a>").join("") || '<div class="empty">Chưa có.</div>';
  } catch (e) { $("#tab-hist").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}
async function refresh() {
  try {
    S = await api("/api/state");
    applyPerms(); renderTop(); renderServices(); renderJobs();
    if (!$("#tab-hist").hidden) loadHistory();
    const c = CK && CK.check && (S.checks || []).find((x) => x.id === CK.check.id);
    if (c && (c.status !== CK.check.status || c.status === "running")) loadCheck();
    else renderCheck();
  } catch (e) {
    $("#alerts").innerHTML = '<div class="alert alert-bad">Không tải được trạng thái: ' + esc(e.message) + "</div>";
  }
}

// ---------- Tab ----------
$$(".tab").forEach((t) => (t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#tab-jobs").hidden = t.dataset.tab !== "jobs";
  $("#tab-hist").hidden = t.dataset.tab !== "hist";
  if (t.dataset.tab === "hist") loadHistory();
}));

// ---------- Build ----------
let BR = [];
async function loadBranches() {
  try {
    BR = await api("/api/branches");
    $("#b-branches").innerHTML = BR.map((b) => '<option value="' + esc(b.name) + '">' + esc(b.subject.slice(0, 70)) + "</option>").join("");
    showRefInfo();
  } catch (e) { $("#b-ref-info").textContent = e.message; }
}
function showRefInfo() {
  const b = BR.find((x) => x.name === $("#b-ref").value.trim());
  $("#b-ref-info").innerHTML = b ? "<code>" + esc(b.sha) + '</code><span class="subj">' + esc(b.subject) + "</span><span>· " + ago(b.date) + "</span>" : "";
}
let refTimer = null;
$("#b-ref").addEventListener("input", () => {
  showRefInfo();
  CK = null; renderCheck();
  clearTimeout(refTimer);
  refTimer = setTimeout(loadCheck, 500);
});
$("#b-bypass").addEventListener("change", () => renderCheck());
$("#b-only").addEventListener("change", () => {
  $("#b-go").lastChild.textContent = $("#b-only").checked ? "Build" : "Build & deploy";
});

// ---------- Kiểm tra (CI): Build chỉ mở khi commit đang chọn đã qua kiểm tra ----------
let CK = null, ckSeq = 0, ckErr = "";
const CG_IC = { ok: ICON.check, warn: ICON.check, failed: ICON.x, running: ICON.spin, pending: ICON.clock, skipped: ICON.clock };
async function loadCheck() {
  const ref = $("#b-ref").value.trim();
  const seq = ++ckSeq;
  if (!ref) { CK = null; ckErr = "Nhập nhánh hoặc commit"; return renderCheck(); }
  try {
    const r = await api("/api/check?ref=" + encodeURIComponent(ref));
    if (seq !== ckSeq) return;
    CK = r; ckErr = "";
  } catch (e) {
    if (seq !== ckSeq) return;
    CK = null; ckErr = e.message;
  }
  renderCheck();
}
function groupChips(c) {
  return '<div class="ci-groups">' + c.groups.map((g) => '<span class="cg ' + g.status + '" title="' + esc(g.steps.map((s) => s.name + ": " + s.status).join("\n")) + '">' + CG_IC[g.status] + esc(g.label) + "</span>").join("") + "</div>";
}
function renderCheck() {
  const box = $("#b-ci"), go = $("#b-go");
  const c = CK && CK.check;
  const passed = !!(c && c.status === "ok");
  const bypass = $("#b-bypass").checked;
  go.disabled = !CK || (!passed && !bypass && needCi());
  go.title = passed || !needCi() ? "" : bypass ? "Bỏ qua chặn: build dù CI chưa đạt" : "Commit phải qua kiểm tra (CI) trước khi Build";
  if (!CK) {
    box.className = "ci";
    box.innerHTML = '<div class="ci-head"><span class="ci-msg muted">' + esc(ckErr || "Đang tải…") + "</span></div>";
    return;
  }
  const sha = "<code>" + esc(CK.sha.slice(0, 7)) + "</code>";
  const logBtn = c ? '<button class="btn btn-sm" data-ci="log">' + ICON.log + "Log</button>" : "";
  const runBtn = (label, primary) => '<button class="btn btn-sm' + (primary ? " btn-primary" : "") + '" data-ci="run">' + ICON.restart + label + "</button>";
  let cls = "ci", msg, acts;
  const canRun = can("check");
  if (!c) { msg = ICON.clock + "<span>Commit " + sha + " chưa được kiểm tra.</span>"; acts = canRun ? runBtn("Chạy kiểm tra", true) : ""; }
  else if (c.status === "queued") { cls += " run"; msg = ICON.clock + "<span>Đang chờ kiểm tra " + sha + "…</span>"; acts = logBtn; }
  else if (c.status === "running") { cls += " run"; msg = ICON.spin + "<span>Đang kiểm tra " + sha + " · " + dur(c.started) + "</span>"; acts = logBtn; }
  else if (c.status === "ok") {
    cls += " ok";
    const warn = c.groups.some((g) => g.status === "warn") ? " (có bước cảnh báo không chặn)" : "";
    msg = ICON.check + "<span>Đã qua kiểm tra " + sha + warn + " · " + ago(c.ended) + "</span>"; acts = logBtn;
  } else { cls += " bad"; msg = ICON.x + "<span>" + esc(c.error || "Kiểm tra không qua") + " · " + sha + "</span>"; acts = logBtn + (canRun ? runBtn("Chạy lại") : ""); }
  if (c && c.legacy) msg = msg.replace(/<\/span>$/, " · kết quả của trang cũ</span>");
  box.className = cls;
  box.innerHTML = '<div class="ci-head"><span class="ci-msg">' + msg + '</span><span class="ci-acts">' + acts + "</span></div>" + (c ? groupChips(c) : "");
  const lb = $('[data-ci="log"]', box); if (lb) lb.onclick = () => showCheck(c.id);
  const rb = $('[data-ci="run"]', box); if (rb) rb.onclick = startCheck;
}
async function startCheck() {
  const ref = $("#b-ref").value.trim();
  if (!ref) return toast("Nhập nhánh hoặc commit", true);
  $$("#b-ci button").forEach((b) => (b.disabled = true));
  try { const r = await api("/api/check", { ref }); await loadCheck(); refresh(); showCheck(r.id); }
  catch (e) { toast(e.message, true); renderCheck(); }
}
function lineCls(l) {
  l = l.replace(/^\[[\w-]+\] /, ""); // dòng log kiểm tra có tiền tố [nhóm]
  if (/^▶|^══/.test(l)) return "l-h";
  if (/^⚠|^\[THỬ\]/.test(l)) return "l-dim";
  if (/^✔|^✓|đã lành|\/suc-khoe qua cổng vào: ok/.test(l)) return "l-ok";
  if (/^✘|^✗|ERROR|error:|\(fail\)/i.test(l)) return "l-bad";
  if (/^#\d+ (DONE|CACHED|\d+\.\d+ )|^\(pass\)/.test(l)) return "l-dim";
  return "";
}
let ckTimer = null;
function showCheck(id) {
  const STL = { queued: ["idle", "Đang chờ"], running: ["run", "Đang chạy"], ok: ["ok", "Đạt"], failed: ["bad", "Không qua"] };
  openDlg("Kiểm tra", '<div class="ci-steps" id="ck-steps"></div><pre class="term" id="cl"></pre>', "", { wide: true, term: true });
  let from = 0;
  clearTimeout(ckTimer);
  onDlgClose = () => clearTimeout(ckTimer);
  const tick = async () => {
    if (!dlg.open || !$("#cl")) return;
    try {
      const r = await api("/api/checkrun?id=" + encodeURIComponent(id) + "&from=" + from);
      const b = $("#dlg-body");
      const atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 40;
      if (r.lines.length) {
        $("#cl").insertAdjacentHTML("beforeend", r.lines.map((l) => { const c = lineCls(l); return c ? '<span class="' + c + '">' + esc(l) + "</span>" : esc(l); }).join("\n") + "\n");
        from = r.total;
      }
      $("#ck-steps").innerHTML = r.groups.map((g) => "<div><h4>" + '<span class="cg ' + g.status + '">' + CG_IC[g.status] + esc(g.label) + "</span></h4>"
        + g.steps.map((s) => '<div class="ci-step ' + s.status + '">' + CG_IC[s.status] + "<span>" + esc(s.name) + '</span><span class="t">' + (s.ms ? Math.round(s.ms / 1000) + "s" : "") + "</span></div>").join("") + "</div>").join("");
      const [c, t] = STL[r.status];
      $("#dlg-title").innerHTML = '<span class="pill ' + c + '">' + t + "</span><span>Kiểm tra " + esc(r.ref) + " @" + esc(r.sha.slice(0, 7)) + '</span><span class="muted light">· ' + esc(r.user) + (r.legacy ? " (trang cũ)" : "") + (r.started ? " · " + dur(r.started, r.ended) : "") + "</span>";
      if (atEnd) b.scrollTop = b.scrollHeight;
      if (r.status === "queued" || r.status === "running" || r.lines.length) ckTimer = setTimeout(tick, r.lines.length >= 5000 ? 50 : 2000);
      else loadCheck();
    } catch (e) { $("#cl").insertAdjacentHTML("beforeend", '<span class="l-bad">' + esc(e.message) + "</span>\n"); }
  };
  tick();
}

$("#b-go").onclick = async () => {
  const ref = $("#b-ref").value.trim();
  const only = $("#b-only").checked;
  const bypass = $("#b-bypass").checked;
  if (!ref) return toast("Nhập nhánh hoặc commit", true);
  if (!CK) return toast("Chưa đọc được commit", true);
  const passed = !!(CK.check && CK.check.status === "ok");
  if (!bypass && needCi() && !passed) return toast("Commit chưa qua kiểm tra (CI)", true);
  const sha = CK.sha;
  let reason = "";
  if (bypass) {
    reason = await askReason();
    if (reason === null) return;
  }
  const ok = await confirmBox(only ? "Build" : "Build & deploy",
    "Build web + worker từ <code>" + esc(ref) + "</code> @<code>" + esc(sha.slice(0, 7)) + "</code>" + (passed ? " (đã qua kiểm tra)" : "")
    + (bypass ? ' <b class="txt-bad">BỎ QUA CHẶN CI</b>' : "")
    + (only ? ", chỉ nạp ảnh lên máy staging." : " rồi triển khai lên " + esc(ENV) + " (migrate CSDL staging, đổi màu web không gián đoạn)."),
    only ? "Build" : "Build & deploy");
  if (!ok) return;
  $("#b-go").disabled = true;
  try { const r = await api("/api/build", { ref, sha, deploy: !only, bypass, reason }); await refresh(); showJob(r.id); }
  catch (e) { toast(e.message, true); loadCheck(); }
  renderCheck();
};

// Lý do bỏ qua chặn (bắt buộc, ghi vào nhật ký kiểm toán)
function askReason() {
  return new Promise((res) => {
    openDlg("Lý do bỏ qua chặn CI", '<p class="confirm-msg">Bỏ qua chặn chỉ dùng khi khẩn cấp. Lý do được ghi vào nhật ký.</p>'
      + '<label class="field"><span>Lý do</span><textarea id="rs-in" rows="3" maxlength="300" placeholder="Vd. hotfix lỗi đăng nhập, CI hỏng do mạng"></textarea></label>',
      '<button class="btn" data-a="no">Hủy</button><button class="btn btn-danger" data-a="yes">Tiếp tục</button>');
    let done = false;
    const fin = (v) => { if (done) return; done = true; res(v); };
    $('#dlg-foot [data-a="no"]').onclick = () => { fin(null); closeDlg(); };
    $('#dlg-foot [data-a="yes"]').onclick = () => {
      const v = $("#rs-in").value.trim();
      if (v.length < 5) return toast("Ghi lý do ít nhất 5 ký tự", true);
      fin(v); closeDlg();
    };
    onDlgClose = () => fin(null);
    $("#rs-in").focus();
  });
}

// ---------- Log việc build/triển khai ----------
let jobTimer = null;
function showJob(id) {
  const STL = { queued: ["idle", "Đang chờ"], running: ["run", "Đang chạy"], ok: ["ok", "Thành công"], failed: ["bad", "Lỗi"] };
  openDlg("Log", '<pre class="term" id="jl"></pre>', "", { wide: true, term: true });
  let from = 0;
  clearTimeout(jobTimer);
  onDlgClose = () => clearTimeout(jobTimer);
  const tick = async () => {
    if (!dlg.open || !$("#jl")) return;
    try {
      const r = await api("/api/job?id=" + encodeURIComponent(id) + "&from=" + from);
      const b = $("#dlg-body");
      const atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 40;
      if (r.lines.length) {
        $("#jl").insertAdjacentHTML("beforeend", r.lines.map((l) => { const c = lineCls(l); return c ? '<span class="' + c + '">' + esc(l) + "</span>" : esc(l); }).join("\n") + "\n");
        from = r.total;
      }
      const [c, t] = STL[r.status];
      const what = (r.kind === "build" ? (r.deploy ? "Build & deploy " : "Build ") + esc(r.ref) + (r.sha ? " @" + esc(r.sha.slice(0, 7)) : "") : "Đổi bản " + esc(r.ref)) + (r.bypass ? ' <span class="pill bad">bỏ qua chặn</span>' : "");
      $("#dlg-title").innerHTML = '<span class="pill ' + c + '">' + t + "</span><span>" + what + '</span><span class="muted light">· ' + esc(r.user) + "</span>";
      if (atEnd) b.scrollTop = b.scrollHeight;
      if (r.status === "queued" || r.status === "running") jobTimer = setTimeout(tick, 1500);
      else refresh();
    } catch (e) { $("#jl").insertAdjacentHTML("beforeend", '<span class="l-bad">' + esc(e.message) + "</span>\n"); }
  };
  tick();
}

// ---------- Log dịch vụ ----------
async function showLog(key) {
  const s = S.services.find((x) => x.key === key);
  openDlg(esc(s.label) + ' <span class="muted light">· log</span>', '<pre class="term"><span class="l-dim">Đang tải…</span></pre>', "", { wide: true, term: true });
  try {
    const r = await api("/api/logs?svc=" + encodeURIComponent(key));
    $("#dlg-body").innerHTML = '<pre class="term">' + (r.text || "(trống)").split("\n").map((l) => /error|exception|fatal|✗/i.test(l) ? '<span class="l-bad">' + esc(l) + "</span>" : esc(l)).join("\n") + "</pre>";
    $("#dlg-foot").innerHTML = '<span class="muted push-left">' + esc(r.svc) + '</span><button class="btn btn-sm" data-reload>' + ICON.restart + "Tải lại</button>";
    $("#dlg-foot [data-reload]").onclick = () => showLog(key);
    const b = $("#dlg-body");
    b.scrollTop = b.scrollHeight;
  } catch (e) { $("#dlg-body").innerHTML = '<pre class="term"><span class="l-bad">' + esc(e.message) + "</span></pre>"; }
}

// ---------- Đổi bản (thẻ còn trên máy staging) ----------
$("#pick-tag").onclick = async () => {
  let sel = "";
  openDlg("Đổi bản · ảnh còn trên máy staging",
    '<div class="taglist" id="tg-list"><div class="empty">Đang tải…</div></div>'
    + '<label class="switch mt-12"><input type="checkbox" id="tg-mig"><span class="track"></span><span>Chạy migrate (chỉ khi bản này MỚI hơn lược đồ đang có)</span></label>',
    '<button class="btn" data-a="no">Hủy</button><button class="btn btn-primary" data-a="go" disabled>Triển khai</button>');
  const go = $('#dlg-foot [data-a="go"]');
  $('#dlg-foot [data-a="no"]').onclick = closeDlg;
  let tags = [];
  try {
    tags = await api("/api/tags?svc=web");
    $("#tg-list").innerHTML = tags.map((t) => '<button class="tagrow" data-t="' + esc(t.tag) + '"><code>' + esc(t.tag) + "</code>"
      + '<span class="subj">' + esc(t.subject || "") + "</span>"
      + '<span class="when">' + (t.dangChay ? '<span class="pill ok">đang chạy</span>' : esc(t.created)) + "</span></button>").join("") || '<div class="empty">Không có ảnh nào.</div>';
    $$("#tg-list .tagrow").forEach((r) => (r.onclick = () => {
      sel = r.dataset.t;
      $$("#tg-list .tagrow").forEach((x) => x.classList.toggle("sel", x === r));
      go.disabled = tags.find((t) => t.tag === sel).dangChay;
    }));
  } catch (e) { $("#tg-list").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
  go.onclick = async () => {
    const migrate = $("#tg-mig").checked;
    const ok = await confirmBox("Đổi bản", "Triển khai <code>" + esc(sel) + "</code> lên " + esc(ENV) + (migrate ? " (có migrate)" : " (bỏ qua migrate: quay lui về bản cũ)") + "?", "Triển khai");
    if (!ok) return;
    try { const r = await api("/api/deploy", { tag: sel, opts: { migrate } }); await refresh(); showJob(r.id); }
    catch (e) { toast(e.message, true); }
  };
};

async function restart(key) {
  const s = S.services.find((x) => x.key === key);
  const ok = await confirmBox("Khởi động lại " + s.label, "Khởi động lại <b>" + esc(s.label) + "</b> trên máy staging?", "Khởi động lại", true);
  if (!ok) return;
  try { await api("/api/restart", { svc: key }); toast("Đã khởi động lại " + s.label); setTimeout(refresh, 1000); }
  catch (e) { toast(e.message, true); }
}

refresh();
loadBranches();
loadCheck();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
// Nhánh có commit mới: khung kiểm tra chuyển sang commit mới (Build khóa lại tới khi commit đó qua kiểm tra)
setInterval(() => { if (!document.hidden) { loadBranches(); loadCheck(); } }, 60000);
