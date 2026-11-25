"use strict";
// Trang Staging DNSO · HappyFinate (không framework). Dùng chung lớp CSS với stg-deploy / dnso-stg.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  spin: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  log: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
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
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
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
function ctStatus(c) {
  if (c.state !== "running") return ["bad", c.state === "exited" ? "Đã dừng" : c.state];
  if (c.health === "unhealthy") return ["bad", "Không lành"];
  if (c.health === "starting") return ["warn", "Đang khởi động"];
  return ["ok", "Đang chạy"];
}
const busy = () => !!(S && (S.may.dangBuild || S.jobs.some((j) => j.status === "running" || j.status === "queued")));
function renderTop() {
  const m = S.may;
  const alerts = [];
  if (!m.ok) alerts.push(["bad", m.error]);
  else if (m.dangBuild) alerts.push(["warn", "VPS đang build, chờ lượt này xong."]);
  else if (!m.sucKhoe || m.sucKhoe.trangThai !== "ok") alerts.push(["bad", "/suc-khoe qua Traefik không ok: " + JSON.stringify(m.sucKhoe || "không trả lời").slice(0, 200)]);
  $("#alerts").innerHTML = alerts.map(([c, t]) => '<div class="alert alert-' + c + '">' + esc(t) + "</div>").join("");
  const chip = $("#site-chip");
  const ok = m.ok && m.sucKhoe && m.sucKhoe.trangThai === "ok";
  chip.className = "flux-chip " + (ok ? "ok" : "bad");
  $(".txt", chip).textContent = ok ? "Staging đang chạy" : "Staging lỗi";
  const n = m.nhanh;
  const cham = !n ? "" : n.cham === 0 ? '<span class="pill ok">khớp ' + esc(S.deployBranch) + "</span>"
    : n.cham > 0 ? '<span class="pill warn">chậm ' + n.cham + " commit so với " + esc(S.deployBranch) + "</span>" : "";
  $("#may-head").innerHTML = m.ok
    ? "<span>Bản đang chạy <code class=\"tag\">" + esc(m.phienBan || "?") + "</code></span>" + cham
      + (m.subject ? '<span class="subj">' + esc(m.subject) + "</span>" : "")
      + (m.sucKhoe && m.sucKhoe.trangThai ? "<span>CSDL " + esc(m.sucKhoe.csdl || "?") + " · Redis " + esc(m.sucKhoe.redis || "?") + "</span>" : "")
    : "";
  renderGo();
}
function renderServices() {
  const m = S.may;
  if (!m.ok) { $("#services").innerHTML = '<div class="empty">Không đọc được trạng thái VPS.</div>'; return; }
  $("#services").innerHTML = m.services.map((s) => {
    const cs = s.containers;
    const [cls, text] = cs.length ? cs.map(ctStatus).sort((a, b) => (a[0] === "bad" ? -1 : b[0] === "bad" ? 1 : 0))[0] : ["bad", "Không có container"];
    return '<div class="svc"><div class="svc-l">'
      + '<div class="svc-name"><span class="sdot ' + cls + '" title="' + esc(text) + '"></span>' + esc(s.label) + ' <span class="pill ' + cls + '">' + esc(text) + "</span></div>"
      + '<div class="svc-meta">' + cs.map((c) => "<span>" + esc(c.name) + " · " + esc(c.status) + "</span>").join("")
      + '<span class="note">' + esc(s.note) + "</span></div></div>"
      + '<div class="svc-act"><button class="btn btn-sm" data-log="' + s.key + '">' + ICON.log + "Log</button>"
      + (s.restart ? '<button class="btn btn-sm btn-ghost" data-restart="' + s.key + '" title="Khởi động lại">' + ICON.restart + "</button>" : "")
      + "</div></div>";
  }).join("");
  $$("[data-log]").forEach((b) => (b.onclick = () => showLog(b.dataset.log)));
  $$("[data-restart]").forEach((b) => (b.onclick = () => restart(b.dataset.restart)));
}
function renderJobs() {
  if (!S.jobs.length) return;
  const IC = { ok: ICON.check, failed: ICON.x, running: ICON.spin, queued: ICON.clock };
  $("#tab-jobs").innerHTML = S.jobs.map((j) => {
    const st = j.status === "running" ? "đang chạy " + dur(j.started) : j.status === "queued" ? "đang chờ" : dur(j.started, j.ended);
    return '<button class="job" data-job="' + esc(j.id) + '"><span class="job-ic ' + j.status + '">' + IC[j.status] + "</span><span>"
      + '<div class="job-t">Build &amp; deploy <code>' + esc(j.ref) + "</code>" + (j.sha ? ' <span class="muted mono">@' + esc(j.sha.slice(0, 8)) + "</span>" : "") + "</div>"
      + (j.subject ? '<div class="job-s">' + esc(j.subject) + "</div>" : "")
      + '<div class="job-s">' + esc(j.user) + " · " + ago(j.created) + " · " + st + "</div>"
      + (j.error ? '<div class="job-err">' + esc(j.error) + "</div>" : "") + "</span></button>";
  }).join("");
  $$("[data-job]").forEach((b) => (b.onclick = () => showJob(b.dataset.job)));
}
function renderHistory() {
  const h = (S.may && S.may.lichSu) || [];
  $("#tab-hist").innerHTML = h.map((x) => '<a class="hist"' + (/^[0-9a-f]{7,40}$/.test(x.the) ? ' href="https://github.com/' + esc(S.repo) + "/commit/" + esc(x.the) + '" target="_blank" rel="noopener"' : "") + ">"
    + '<div class="hist-t">' + esc(x.subject || x.the) + "</div>"
    + '<div class="hist-s"><span class="mono">' + esc(x.the) + "</span> · " + esc(x.ai || "") + " · " + ago(x.luc) + "</div></a>").join("") || '<div class="empty">Chưa có.</div>';
}
async function refresh() {
  try {
    S = await api("/api/state");
    renderTop(); renderServices(); renderJobs(); renderHistory();
  } catch (e) {
    $("#alerts").innerHTML = '<div class="alert alert-bad">Không tải được trạng thái: ' + esc(e.message) + "</div>";
  }
}

// ---------- Tab ----------
$$(".tab").forEach((t) => (t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#tab-jobs").hidden = t.dataset.tab !== "jobs";
  $("#tab-hist").hidden = t.dataset.tab !== "hist";
}));

// ---------- Build ----------
let REF = null, refErr = "", refSeq = 0;
async function loadBranches() {
  try {
    const br = await api("/api/branches");
    $("#b-branches").innerHTML = br.map((b) => '<option value="' + esc(b.name) + '">' + esc(b.subject.slice(0, 70)) + "</option>").join("");
  } catch {}
}
async function loadRef() {
  const ref = $("#b-ref").value.trim();
  const seq = ++refSeq;
  if (!ref) { REF = null; refErr = "Nhập nhánh hoặc commit"; return renderRef(); }
  try { const r = await api("/api/ref?ref=" + encodeURIComponent(ref)); if (seq !== refSeq) return; REF = r; refErr = ""; }
  catch (e) { if (seq !== refSeq) return; REF = null; refErr = e.message; }
  renderRef();
}
function renderRef() {
  $("#b-ref-info").innerHTML = REF
    ? "<code>" + esc(REF.sha.slice(0, 8)) + '</code><span class="subj">' + esc(REF.subject) + "</span><span>· " + ago(REF.date) + "</span>"
      + (S && S.may.phienBan && REF.sha.startsWith(S.may.phienBan) ? ' <span class="pill ok">đang chạy trên staging</span>' : "")
    : '<span class="muted">' + esc(refErr || "Đang tải…") + "</span>";
  renderGo();
}
function renderGo() {
  const go = $("#b-go");
  go.disabled = !REF || busy();
  go.title = !REF ? "Chưa đọc được commit" : busy() ? "Đang có lượt build" : "";
}
let refTimer = null;
$("#b-ref").addEventListener("input", () => { REF = null; refErr = ""; renderRef(); clearTimeout(refTimer); refTimer = setTimeout(loadRef, 500); });

$("#b-go").onclick = async () => {
  const ref = $("#b-ref").value.trim();
  if (!REF) return toast("Chưa đọc được commit", true);
  const ok = await confirmBox("Build & deploy",
    "Build <code>" + esc(ref) + "</code> @<code>" + esc(REF.sha.slice(0, 8)) + "</code> trên VPS HappyFinate rồi triển khai lên staging"
    + " (migrate CSDL staging, khởi động lại web/worker, gián đoạn vài giây). Build mất khoảng 5–10 phút.", "Build & deploy");
  if (!ok) return;
  $("#b-go").disabled = true;
  try { const r = await api("/api/build", { ref, sha: REF.sha }); await refresh(); showJob(r.id); }
  catch (e) { toast(e.message, true); loadRef(); }
};

// ---------- Log lượt build ----------
function lineCls(l) {
  if (/^══/.test(l)) return "l-h";
  if (/^⚠|^↩/.test(l)) return "l-dim";
  if (/^✔|^✓/.test(l)) return "l-ok";
  if (/^✘|^✗|ERROR|error:/i.test(l)) return "l-bad";
  return "";
}
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
      $("#dlg-title").innerHTML = '<span class="pill ' + c + '">' + t + "</span><span>Build &amp; deploy " + esc(r.ref) + (r.sha ? " @" + esc(r.sha.slice(0, 8)) : "")
        + '</span><span class="muted light">· ' + esc(r.user) + (r.started ? " · " + dur(r.started, r.ended) : "") + "</span>";
      if (atEnd) b.scrollTop = b.scrollHeight;
      if (r.status === "queued" || r.status === "running") jobTimer = setTimeout(tick, 1500);
      else refresh();
    } catch (e) { $("#jl").insertAdjacentHTML("beforeend", '<span class="l-bad">' + esc(e.message) + "</span>\n"); }
  };
  tick();
}

// ---------- Log dịch vụ ----------
async function showLog(key) {
  const s = S.may.services.find((x) => x.key === key);
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

async function restart(key) {
  const s = S.may.services.find((x) => x.key === key);
  const ok = await confirmBox("Khởi động lại " + s.label, "Khởi động lại <b>" + esc(s.label) + "</b> trên VPS staging?", "Khởi động lại", true);
  if (!ok) return;
  try { await api("/api/restart", { svc: key }); toast("Đã khởi động lại " + s.label); setTimeout(refresh, 1000); }
  catch (e) { toast(e.message, true); }
}

refresh().then(renderRef);
loadBranches();
loadRef();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden) { loadBranches(); loadRef(); } }, 60000);
