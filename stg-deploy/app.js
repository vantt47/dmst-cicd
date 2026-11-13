"use strict";
// Trang Staging Deploy · THiHUB (không framework).
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
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
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
const shortImg = (i) => i.split("/").pop();

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
function svcStatus(s) {
  const bad = s.pods.find((p) => !/Running|Succeeded|Completed|Pending|ContainerCreating|PodInitializing|Init:|Terminating/.test(p.status));
  if (bad) return ["bad", bad.status];
  if (s.gitTag && s.specTag && s.gitTag !== s.specTag) return ["warn", "Chờ áp bản mới"];
  if (!s.rolloutDone) return ["warn", "Đang cập nhật"];
  if (s.ready < s.replicas || !s.pods.length) return ["bad", "Chưa sẵn sàng"];
  return ["ok", "Đang chạy"];
}
function renderTop() {
  const f = S.flux;
  const inSync = f.source && f.lastApplied === f.source;
  const cls = f.ready === "False" || f.sourceReady === "False" ? "bad" : f.ready === "True" && inSync ? "ok" : "warn";
  const chip = $("#flux-chip");
  chip.className = "flux-chip " + cls;
  $(".txt", chip).textContent = cls === "ok" ? "Đã đồng bộ" : cls === "bad" ? "Flux lỗi" : "Đang đồng bộ";
  const alerts = [];
  if (S.clusterError) alerts.push(["bad", S.clusterError]);
  if (S.gitError) alerts.push(["bad", "Git: " + S.gitError]);
  if (f.ready === "False" && f.message) alerts.push(["bad", "Flux không áp được bản mới: " + f.message]);
  if (f.sourceReady === "False" && f.sourceMessage) alerts.push(["bad", "Flux không đọc được Git: " + f.sourceMessage]);
  $("#alerts").innerHTML = alerts.map(([c, m]) => '<div class="alert alert-' + c + '">' + esc(m) + "</div>").join("");
}
function renderServices() {
  $("#services").innerHTML = S.services.map((s) => {
    const [cls, text] = svcStatus(s);
    const started = s.pods.map((p) => p.started).sort().pop();
    const restarts = s.pods.reduce((n, p) => n + p.restarts, 0);
    const pending = s.gitTag && s.specTag && s.gitTag !== s.specTag;
    return '<div class="svc"><div class="svc-l">'
      + '<div class="svc-name"><span class="sdot ' + cls + '" title="' + esc(text) + '"></span>' + esc(s.label) + ' <span class="pill ' + cls + '">' + esc(text) + "</span></div>"
      + '<div class="svc-meta"><code class="tag" title="Thẻ ảnh đang chạy">' + esc(s.specTag || "?") + "</code>"
      + (pending ? '<span>→ <code class="tag">' + esc(s.gitTag) + "</code></span>" : "")
      + (started ? "<span>" + (s.isInit ? "chạy " : "khởi động ") + ago(started) + "</span>" : "")
      + (restarts ? '<span class="t-warn">' + restarts + " lần khởi động lại</span>" : "")
      + "</div></div>"
      + '<div class="svc-act">'
      + '<button class="btn btn-sm" data-log="' + s.key + '">' + ICON.log + "Log</button>"
      + '<button class="btn btn-sm" data-tag="' + s.key + '">' + ICON.swap + "Đổi bản</button>"
      + (s.isInit ? "" : '<button class="btn btn-sm btn-ghost" data-restart="' + s.key + '" title="Khởi động lại">' + ICON.restart + "</button>")
      + "</div></div>";
  }).join("");
  $$("[data-log]").forEach((b) => (b.onclick = () => showLog(b.dataset.log)));
  $$("[data-tag]").forEach((b) => (b.onclick = () => pickTag(b.dataset.tag)));
  $$("[data-restart]").forEach((b) => (b.onclick = () => restart(b.dataset.restart)));
}
const svcLabel = (k) => (S.services.find((s) => s.key === k) || { label: k }).label;
function renderJobs() {
  if (!S.jobs.length) return;
  const IC = { ok: ICON.check, failed: ICON.x, running: ICON.spin, queued: ICON.clock };
  $("#tab-jobs").innerHTML = S.jobs.map((j) => {
    const title = j.kind === "build"
      ? (j.deploy ? "Build & deploy " : "Build ") + "<code>" + esc(j.ref) + "</code>" + (j.sha ? ' <span class="muted mono">@' + esc(j.sha.slice(0, 7)) + "</span>" : "")
      : "Đổi bản <code>" + esc(j.ref) + "</code>";
    const st = j.status === "running" ? "đang chạy " + dur(j.started) : j.status === "queued" ? "đang chờ" : dur(j.started, j.ended);
    return '<button class="job" data-job="' + esc(j.id) + '"><span class="job-ic ' + j.status + '">' + IC[j.status] + "</span><span>"
      + '<div class="job-t">' + title + "</div>"
      + '<div class="job-s">' + esc(j.services.map(svcLabel).join(", ")) + "</div>"
      + '<div class="job-s">' + esc(j.user) + " · " + ago(j.created) + " · " + st + "</div>"
      + (j.error ? '<div class="job-err">' + esc(j.error) + "</div>" : "") + "</span></button>";
  }).join("");
  $$("[data-job]").forEach((b) => (b.onclick = () => showJob(b.dataset.job)));
}
async function refresh() {
  try {
    S = await api("/api/state");
    renderTop(); renderBuildSvcs(); renderServices(); renderJobs();
  } catch (e) {
    $("#alerts").innerHTML = '<div class="alert alert-bad">Không tải được trạng thái: ' + esc(e.message) + "</div>";
  }
}
$("#flux-chip").onclick = async () => {
  try { await api("/api/reconcile", {}); toast("Đã yêu cầu Flux đồng bộ lại"); setTimeout(refresh, 2000); } catch (e) { toast(e.message, true); }
};

// ---------- Tab ----------
$$(".tab").forEach((t) => (t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#tab-jobs").hidden = t.dataset.tab !== "jobs";
  $("#tab-hist").hidden = t.dataset.tab !== "hist";
  if (t.dataset.tab === "hist") loadHistory();
}));
async function loadHistory() {
  try {
    const h = await api("/api/history");
    $("#tab-hist").innerHTML = h.map((c) => {
      const lines = c.message.split("\n").map((x) => x.trim()).filter(Boolean);
      const title = lines[0].replace(/^Staging( \(stg-deploy\))?:\s*/i, "");
      const by = (lines.find((l) => l.startsWith("Thực hiện bởi")) || "").replace(/^Thực hiện bởi (.+?) qua .*/, "$1");
      return '<a class="hist" href="' + esc(c.url) + '" target="_blank" rel="noopener"><div class="hist-t">' + esc(title) + "</div>"
        + '<div class="hist-s"><span class="mono">' + esc(c.sha) + "</span> · " + (by ? esc(by) + " · " : "") + ago(c.date) + "</div></a>";
    }).join("") || '<div class="empty">Chưa có.</div>';
  } catch (e) { $("#tab-hist").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}

// ---------- Build ----------
function renderBuildSvcs() {
  const box = $("#b-svcs");
  if (box.dataset.done) return;
  box.dataset.done = "1";
  box.innerHTML = S.services.map((s) =>
    '<label class="chip"><input type="checkbox" value="' + s.key + '"' + (s.key === "backend" || s.key === "migrate" ? " checked" : "") + '><span class="box">' + ICON.check + "</span>" + esc(s.label) + "</label>").join("");
}
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
$("#b-ref").addEventListener("input", showRefInfo);
$("#b-only").addEventListener("change", () => {
  $("#b-go").lastChild.textContent = $("#b-only").checked ? "Build" : "Build & deploy";
});
$("#b-go").onclick = async () => {
  const ref = $("#b-ref").value.trim();
  const services = $$("#b-svcs input:checked").map((i) => i.value);
  const only = $("#b-only").checked;
  if (!ref) return toast("Nhập nhánh hoặc commit", true);
  if (!services.length) return toast("Chọn ít nhất 1 service", true);
  const ok = await confirmBox(only ? "Build" : "Build & deploy",
    "Build <b>" + esc(services.map(svcLabel).join(", ")) + "</b> từ <code>" + esc(ref) + "</code>" + (only ? ", chỉ đẩy ảnh lên GHCR." : " rồi triển khai lên staging."),
    only ? "Build" : "Build & deploy");
  if (!ok) return;
  $("#b-go").disabled = true;
  try { const r = await api("/api/build", { ref, services, deploy: !only }); await refresh(); showJob(r.id); }
  catch (e) { toast(e.message, true); }
  $("#b-go").disabled = false;
};

// ---------- Log việc build ----------
let jobTimer = null;
function lineCls(l) {
  if (/^══/.test(l)) return "l-h";
  if (/^✔|Rollout xong|^Đã push/.test(l)) return "l-ok";
  if (/^✘|ERROR|error:|failed/i.test(l)) return "l-bad";
  if (/^#\d+ (DONE|CACHED|\d+\.\d+ )|^#\d+ sha256|Pushed$|Already exists$/.test(l)) return "l-dim";
  return "";
}
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
      const what = r.kind === "build" ? (r.deploy ? "Build & deploy " : "Build ") + esc(r.ref) + (r.sha ? " @" + esc(r.sha.slice(0, 7)) : "") : "Đổi bản " + esc(r.ref);
      $("#dlg-title").innerHTML = '<span class="pill ' + c + '">' + t + "</span><span>" + what + '</span><span class="muted light">· ' + esc(r.user) + "</span>";
      if (atEnd) b.scrollTop = b.scrollHeight;
      if (r.status === "queued" || r.status === "running") jobTimer = setTimeout(tick, 1500);
      else { refresh(); if (!$("#tab-hist").hidden) loadHistory(); }
    } catch (e) { $("#jl").insertAdjacentHTML("beforeend", '<span class="l-bad">' + esc(e.message) + "</span>\n"); }
  };
  tick();
}

// ---------- Log pod ----------
async function showLog(key, pod, previous) {
  const s = S.services.find((x) => x.key === key);
  const head = esc(s.label) + ' <span class="muted light">· log</span>';
  openDlg(head, '<pre class="term"><span class="l-dim">Đang tải…</span></pre>', "", { wide: true, term: true });
  try {
    const r = await api("/api/logs?svc=" + encodeURIComponent(key) + (pod ? "&pod=" + encodeURIComponent(pod) : "") + (previous ? "&previous=1" : ""));
    const lines = (r.text || "(trống)").split("\n").map((l) => l.replace(/^(\d{4}-\d\d-\d\dT[\d:]+)\.\d+Z /, "$1 "));
    $("#dlg-body").innerHTML = '<pre class="term">' + lines.map((l) => { const c = /error|exception|fatal/i.test(l) ? "l-bad" : ""; return c ? '<span class="' + c + '">' + esc(l) + "</span>" : esc(l); }).join("\n") + "</pre>";
    const pods = s.pods.map((p) => p.name);
    $("#dlg-foot").innerHTML = (pods.length > 1 ? '<div class="pod-switch push-left">' + pods.map((p) => '<button class="btn btn-sm' + (p === r.pod ? " btn-primary" : "") + '" data-pod="' + esc(p) + '">' + esc(p.split("-").pop()) + "</button>").join("") + "</div>" : "")
      + '<button class="btn btn-sm btn-ghost" data-prev>' + (previous ? "Lần chạy hiện tại" : "Lần chạy trước (sau crash)") + "</button>"
      + '<button class="btn btn-sm" data-reload>' + ICON.restart + "Tải lại</button>";
    $$("#dlg-foot [data-pod]").forEach((b) => (b.onclick = () => showLog(key, b.dataset.pod, previous)));
    $("#dlg-foot [data-prev]").onclick = () => showLog(key, r.pod, !previous);
    $("#dlg-foot [data-reload]").onclick = () => showLog(key, r.pod, previous);
    const b = $("#dlg-body");
    b.scrollTop = b.scrollHeight;
  } catch (e) { $("#dlg-body").innerHTML = '<pre class="term"><span class="l-bad">' + esc(e.message) + "</span></pre>"; }
}

// ---------- Đổi bản (deploy thẻ có sẵn) ----------
async function pickTag(key) {
  const s = S.services.find((x) => x.key === key);
  let sel = "";
  openDlg("Đổi bản · " + esc(s.label),
    '<label class="field"><span>Thẻ ảnh <span class="muted light">(' + esc(shortImg(s.image)) + ")</span></span>"
    + '<input id="tg-in" placeholder="Lọc hoặc nhập thẻ" autocomplete="off" spellcheck="false" class="mono"></label>'
    + '<div class="taglist" id="tg-list"><div class="empty">Đang tải thẻ từ GHCR…</div></div>',
    '<button class="btn" data-a="no">Hủy</button><button class="btn btn-primary" data-a="go" disabled>Deploy</button>');
  const input = $("#tg-in"), go = $('#dlg-foot [data-a="go"]');
  $('#dlg-foot [data-a="no"]').onclick = closeDlg;
  const setSel = (t) => {
    sel = t.trim();
    go.disabled = !sel || sel === s.specTag;
    $$("#tg-list .tagrow").forEach((r) => r.classList.toggle("sel", r.dataset.t === sel));
  };
  let tags = [];
  const draw = () => {
    const q = input.value.trim();
    const list = tags.filter((t) => t.tag.includes(q));
    $("#tg-list").innerHTML = list.map((t) => '<button class="tagrow" data-t="' + esc(t.tag) + '"><code>' + esc(t.tag) + "</code>"
      + '<span class="when">' + (t.tag === s.specTag ? '<span class="pill ok">đang chạy</span>' : t.created ? ago(t.created) : "") + "</span></button>").join("")
      || '<div class="empty">' + (q ? "Không có thẻ khớp. Bấm Deploy để dùng thẻ đã nhập." : "Không có thẻ.") + "</div>";
    $$("#tg-list .tagrow").forEach((r) => (r.onclick = () => { input.value = r.dataset.t; setSel(r.dataset.t); }));
    setSel(input.value);
  };
  input.oninput = draw;
  input.focus();
  try { tags = await api("/api/tags?svc=" + encodeURIComponent(key)); draw(); }
  catch (e) { $("#tg-list").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
  go.onclick = async () => {
    const ok = await confirmBox("Deploy " + s.label, "Đổi <b>" + esc(s.label) + "</b> từ <code>" + esc(s.specTag) + "</code> sang <code>" + esc(sel) + "</code> trên staging?", "Deploy");
    if (!ok) return;
    try { const r = await api("/api/deploy", { svc: key, tag: sel }); await refresh(); showJob(r.id); }
    catch (e) { toast(e.message, true); }
  };
}

async function restart(key) {
  const s = S.services.find((x) => x.key === key);
  const ok = await confirmBox("Khởi động lại " + s.label,
    "Khởi động lại <b>" + esc(s.label) + "</b> với bản đang chạy." + (s.deploy === "backend" ? "<br>API sẽ gián đoạn khoảng 30–60 giây (chạy lại migrate)." : ""), "Khởi động lại", true);
  if (!ok) return;
  try { await api("/api/restart", { svc: key }); toast("Đã khởi động lại " + s.label); setTimeout(refresh, 1000); }
  catch (e) { toast(e.message, true); }
}

refresh();
loadBranches();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden) loadBranches(); }, 60000);
