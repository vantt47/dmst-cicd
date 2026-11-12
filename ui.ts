// Giao diện trang deploy staging: HTML khung, CSS, JS (không framework). CSP chỉ cho script/style cùng nguồn.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function pageHtml(o: { user?: string; error?: string; name?: string }) {
  const head = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy staging · Sàn TMĐT</title><link rel="stylesheet" href="/app.css"><meta name="robots" content="noindex,nofollow"></head>`;
  if (!o.user) {
    return `${head}<body class="login"><form method="post" action="/login" class="card login-card">
<h1>Deploy staging</h1><p class="muted">Sàn TMĐT Thanh Hóa · cụm staging (TT-DMST-03)</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<label>Tên của bạn<input name="name" required minlength="2" maxlength="40" autocomplete="nickname" value="${esc(o.name ?? "")}" placeholder="vd: Nguyễn An"></label>
<label>Mật khẩu deploy<input name="password" type="password" required autocomplete="current-password"></label>
<button type="submit">Đăng nhập</button>
<p class="muted small">Tên được ghi vào commit deploy trên nhánh staging.</p></form></body></html>`;
  }
  return `${head}<body>
<header><div><h1>Deploy staging</h1><span class="muted">Sàn TMĐT · cụm staging</span></div>
<div class="who">${esc(o.user)} <form method="post" action="/logout"><button class="ghost">Đăng xuất</button></form></div></header>
<main>
<section id="banner"></section>
<section class="card" id="flux"></section>
<h2>Service triển khai được</h2>
<p class="muted small">Quy trình: build ảnh ở máy bạn → <code>docker push ghcr.io/khcn-thanh-hoa/&lt;ảnh&gt;:&lt;thẻ&gt;</code> → chọn thẻ ở đây → Deploy. Trang commit đổi <code>newTag</code> vào nhánh <b>staging</b>, Flux áp trong ~1 phút.</p>
<section id="services" class="grid"></section>
<h2>Lịch sử deploy <span class="muted small">(commit của kustomization.yaml)</span></h2>
<section class="card" id="history"><p class="muted">Đang tải…</p></section>
<h2>Pod đang chạy</h2>
<section id="pods"></section>
</main>
<dialog id="dlg"><div class="dlg-head"><b id="dlg-title"></b><button class="ghost" id="dlg-close">Đóng</button></div><div id="dlg-body"></div></dialog>
<script src="/app.js"></script></body></html>`;
}

export const APP_CSS = `
:root{--bg:#f5f6f8;--card:#fff;--fg:#1d2330;--muted:#6b7280;--line:#e3e6eb;--acc:#0b6bcb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e6e9ef;--muted:#9aa3b2;--line:#2a303b;--acc:#4ea1ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--code:#222835}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--card);gap:12px;flex-wrap:wrap}
header h1{display:inline;font-size:18px;margin:0 10px 0 0}.who{display:flex;gap:10px;align-items:center}.who form{margin:0}
main{max-width:1200px;margin:0 auto;padding:16px}h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.muted{color:var(--muted)}.small{font-size:12px}code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:12px;word-break:break-all}
.err{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid currentColor}
button,.btn{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--acc)}button:disabled{opacity:.5;cursor:progress}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
.svc h3{margin:0;font-size:15px}.svc .row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.kv{display:grid;grid-template-columns:110px 1fr;gap:2px 8px;margin-top:8px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
.deploy-row{display:flex;gap:6px;margin-top:10px}.deploy-row input{flex:1}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.ns{margin-bottom:12px;overflow-x:auto}.ns h3{margin:0 0 6px;font-size:14px}
#banner .card{border-color:var(--warn);margin-bottom:12px}
.hist li{margin:6px 0;list-style:none}.hist{padding:0;margin:0}.hist a{color:var(--acc)}
dialog{width:min(1100px,96vw);max-height:90vh;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:0}
dialog::backdrop{background:#0008}.dlg-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);gap:8px}
#dlg-body{padding:10px 14px;overflow:auto;max-height:calc(90vh - 60px)}pre{margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all}
.taglist{max-height:50vh;overflow:auto}.taglist button{display:flex;justify-content:space-between;width:100%;background:transparent;color:var(--fg);border:1px solid var(--line);margin:3px 0;text-align:left}
.taglist button.cur{border-color:var(--ok)}
.login{display:grid;place-items:center;min-height:100vh;padding:16px}.login-card{width:min(380px,100%)}.login-card h1{margin:0 0 4px;font-size:20px}
.login-card label{display:block;margin:12px 0;font-size:13px;color:var(--muted)}.login-card input{margin-top:4px}.login-card button{width:100%;margin-top:6px}
`;

export const APP_JS = `
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const ago = (t) => { if (!t) return ""; const s = (Date.now() - new Date(t)) / 1000;
  if (s < 60) return Math.floor(s) + " giây"; if (s < 3600) return Math.floor(s/60) + " phút"; if (s < 86400) return Math.floor(s/3600) + " giờ"; return Math.floor(s/86400) + " ngày"; };
const fmt = (t) => t ? new Date(t).toLocaleString("vi-VN", {hour12:false}) : "";
async function api(path, body) {
  const r = await fetch(path, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
  if (r.status === 401) { location.reload(); throw new Error("Hết phiên"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("Lỗi " + r.status));
  return j;
}
let S = null; const busy = new Set();
function statusCls(s) { return /Running|Succeeded|Completed/.test(s) ? "ok" : /Pending|ContainerCreating|PodInitializing|Init:|Terminating/.test(s) ? "warn" : "bad"; }

function renderFlux() {
  const f = S.flux; const rev = (x) => esc((x||"").replace(/^.*@sha1:/, "").slice(0, 7));
  const inSync = f.source && f.lastApplied === f.source;
  $("#flux").innerHTML = '<div class="row" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">'
   + '<div><b>Flux</b> <span class="badge ' + (f.ready === "True" ? "ok" : f.ready === "False" ? "bad" : "warn") + '">' + (f.ready === "True" ? "Ready" : f.ready === "False" ? "Lỗi" : "Đang áp") + '</span> '
   + '<span class="muted">nhánh <code>' + esc(S.repo.branch) + '</code> · Git <code>' + rev(f.source) + '</code> · đã áp <code>' + rev(f.lastApplied) + '</code></span> '
   + (inSync ? '<span class="ok small">đồng bộ</span>' : '<span class="warn small">chưa áp bản mới nhất</span>') + '</div>'
   + '<button class="ghost" id="btn-rec">Đồng bộ ngay</button></div>'
   + (f.ready !== "True" && f.message ? '<p class="small bad" style="margin:6px 0 0">' + esc(f.message) + '</p>' : '')
   + (f.sourceReady === "False" ? '<p class="small bad" style="margin:6px 0 0">Git: ' + esc(f.sourceMessage) + '</p>' : '');
  $("#btn-rec").onclick = async (e) => { e.target.disabled = true; try { await api("/api/reconcile", {}); toast("Đã yêu cầu Flux đồng bộ"); } catch (x) { alert(x.message); } setTimeout(refresh, 1500); };
}

function svcState(s) {
  const running = [...new Set(s.pods.map((p) => p.runningTag).filter(Boolean))];
  if (s.gitTag && s.specTag && s.gitTag !== s.specTag) return ["warn", "Chờ Flux áp " + s.gitTag];
  if (!s.rolloutDone) return ["warn", "Đang triển khai " + s.updated + "/" + s.replicas];
  if (s.ready < s.replicas) return ["bad", "Chưa sẵn sàng " + s.ready + "/" + s.replicas];
  if (running.length > 1) return ["warn", "Đang thay bản"];
  return ["ok", "Chạy " + s.ready + "/" + s.replicas];
}

function renderServices() {
  const box = $("#services"); const canDeploy = !S.gitError;
  // giữ nguyên ô nhập đang gõ khi làm mới
  const typed = {}; box.querySelectorAll("input[data-svc]").forEach((i) => typed[i.dataset.svc] = i.value);
  box.innerHTML = S.services.map((s) => {
    const [cls, text] = svcState(s);
    const pods = s.pods.map((p) => '<tr><td><code>' + esc(p.name) + '</code></td><td class="' + statusCls(p.status) + '">' + esc(p.status) + '</td><td>' + esc(p.ready) + '</td><td>' + p.restarts + '</td><td>' + ago(p.started) + '</td><td><button class="ghost small" data-log="' + esc(s.key) + '" data-pod="' + esc(p.name) + '">Log</button></td></tr>').join("");
    return '<div class="card svc"><div style="display:flex;justify-content:space-between;gap:8px"><h3>' + esc(s.label) + '</h3><span class="badge ' + cls + '">' + esc(text) + '</span></div>'
     + '<div class="muted small">' + esc(s.note) + '</div>'
     + '<dl class="kv"><dt>Ảnh</dt><dd><code>' + esc(s.image.replace("ghcr.io/khcn-thanh-hoa/", "")) + '</code></dd>'
     + '<dt>Thẻ trong Git</dt><dd><code>' + esc(s.gitTag ?? "?") + '</code></dd>'
     + '<dt>Thẻ đang chạy</dt><dd><code>' + esc(s.specTag ?? "?") + '</code>' + (s.gitTag && s.specTag && s.gitTag !== s.specTag ? ' <span class="warn small">≠ Git</span>' : '') + '</dd>'
     + '<dt>Deployment</dt><dd>' + esc(s.ns + "/" + s.deploy) + (s.isInit ? ' <span class="muted">(init ' + esc(s.container) + ')</span>' : '') + '</dd>'
     + (s.restartedAt ? '<dt>Restart lần cuối</dt><dd>' + fmt(s.restartedAt) + '</dd>' : '') + '</dl>'
     + (pods ? '<table style="margin-top:8px"><tr><th>Pod</th><th>Trạng thái</th><th>Ready</th><th>Restart</th><th>Tuổi</th><th></th></tr>' + pods + '</table>' : '<p class="bad small">Không có pod</p>')
     + '<div class="deploy-row"><input data-svc="' + esc(s.key) + '" placeholder="thẻ ảnh, vd stg-abc1234" ' + (canDeploy ? '' : 'disabled') + '>'
     + '<button class="ghost" data-tags="' + esc(s.key) + '">Chọn…</button><button data-deploy="' + esc(s.key) + '" ' + (canDeploy && !busy.has(s.key) ? '' : 'disabled') + '>Deploy</button></div>'
     + '<div class="row"><button class="ghost" data-restart="' + esc(s.key) + '" ' + (busy.has(s.key) ? 'disabled' : '') + '>Restart ' + esc(s.deploy) + '</button></div></div>';
  }).join("");
  box.querySelectorAll("input[data-svc]").forEach((i) => { if (typed[i.dataset.svc]) i.value = typed[i.dataset.svc]; });
  box.querySelectorAll("[data-deploy]").forEach((b) => b.onclick = () => deploy(b.dataset.deploy));
  box.querySelectorAll("[data-tags]").forEach((b) => b.onclick = () => pickTag(b.dataset.tags));
  box.querySelectorAll("[data-restart]").forEach((b) => b.onclick = () => restart(b.dataset.restart));
  box.querySelectorAll("[data-log]").forEach((b) => b.onclick = () => showLog(b.dataset.log, b.dataset.pod));
}

function renderPods() {
  $("#pods").innerHTML = S.namespaces.map((n) => '<div class="card ns"><h3>' + esc(n.ns) + '</h3>' + (n.pods.length ? '<table><tr><th>Pod</th><th>Trạng thái</th><th>Ready</th><th>Restart</th><th>Tuổi</th><th>Thẻ ảnh</th></tr>'
    + n.pods.map((p) => '<tr><td><code>' + esc(p.name) + '</code></td><td class="' + statusCls(p.status) + '">' + esc(p.status) + '</td><td>' + esc(p.ready) + '</td><td>' + p.restarts + '</td><td>' + ago(p.started) + '</td><td class="small">'
      + Object.entries(p.images).map(([c, t]) => esc(c) + ': <code>' + esc(t) + '</code>').join("<br>") + '</td></tr>').join("") + '</table>' : '<p class="muted">Không có pod</p>') + '</div>').join("");
}

function render() {
  $("#banner").innerHTML = S.gitError ? '<div class="card"><b class="warn">Chế độ chỉ xem.</b> ' + esc(S.gitError) + '</div>' : "";
  renderFlux(); renderServices(); renderPods();
}

async function refresh() {
  try { S = await api("/api/state"); render(); } catch (e) { $("#banner").innerHTML = '<div class="card"><b class="bad">Không tải được trạng thái:</b> ' + esc(e.message) + '</div>'; }
}
async function loadHistory() {
  try {
    const h = await api("/api/history");
    $("#history").innerHTML = '<ul class="hist">' + h.map((c) => { const [title, , ...rest] = c.message.split("\\n");
      return '<li><a href="' + esc(c.url) + '" target="_blank" rel="noopener"><code>' + esc(c.sha) + '</code></a> ' + esc(title) + ' <span class="muted small">· ' + fmt(c.date) + (rest.join(" ").trim() ? ' · ' + esc(rest.join(" ").trim().slice(0, 120)) : '') + '</span></li>'; }).join("") + '</ul>';
  } catch (e) { $("#history").innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}

function openDlg(title, html) { $("#dlg-title").textContent = title; $("#dlg-body").innerHTML = html; $("#dlg").showModal(); }
$("#dlg-close").onclick = () => $("#dlg").close();
function toast(m) { const t = document.createElement("div"); t.textContent = m; t.className = "card"; t.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9;max-width:420px"; document.body.append(t); setTimeout(() => t.remove(), 5000); }

async function pickTag(key) {
  const s = S.services.find((x) => x.key === key);
  openDlg("Thẻ ảnh " + s.image.replace("ghcr.io/khcn-thanh-hoa/", ""), '<p class="muted">Đang tải từ GHCR…</p>');
  try {
    const tags = await api("/api/tags?svc=" + encodeURIComponent(key));
    $("#dlg-body").innerHTML = '<input id="tag-filter" placeholder="Lọc…" style="margin-bottom:8px"><div class="taglist">' + tags.map((t) =>
      '<button data-t="' + esc(t.tag) + '" class="' + (t.tag === s.specTag ? "cur" : "") + '"><code>' + esc(t.tag) + '</code><span class="muted small">' + (t.tag === s.specTag ? "đang chạy · " : "") + (t.created ? fmt(t.created) : "") + '</span></button>').join("") + '</div>';
    const f = $("#tag-filter"); f.focus();
    f.oninput = () => $("#dlg-body").querySelectorAll("[data-t]").forEach((b) => b.style.display = b.dataset.t.includes(f.value) ? "" : "none");
    $("#dlg-body").querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { document.querySelector('input[data-svc="' + key + '"]').value = b.dataset.t; $("#dlg").close(); });
  } catch (e) { $("#dlg-body").innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

async function deploy(key) {
  const s = S.services.find((x) => x.key === key);
  const tag = document.querySelector('input[data-svc="' + key + '"]').value.trim();
  if (!tag) return alert("Nhập hoặc chọn thẻ ảnh");
  if (!confirm("Deploy " + s.label + "\\n" + (s.gitTag ?? "?") + "  →  " + tag + "\\n\\nCommit vào nhánh staging và Flux áp ngay.")) return;
  busy.add(key); renderServices();
  try {
    const r = await api("/api/deploy", { svc: key, tag });
    toast(r.unchanged ? "Thẻ " + tag + " đã có trong Git, đã yêu cầu Flux đồng bộ" : "Đã commit " + r.old + " → " + tag);
    document.querySelector('input[data-svc="' + key + '"]').value = "";
    loadHistory();
  } catch (e) { alert("Deploy lỗi: " + e.message); }
  busy.delete(key); setTimeout(refresh, 1500);
}

async function restart(key) {
  const s = S.services.find((x) => x.key === key);
  if (!confirm("Restart deployment " + s.ns + "/" + s.deploy + "?" + (s.deploy === "backend" ? "\\nBackend dùng Recreate: API gián đoạn ~30–60 giây (chạy lại migrate)." : ""))) return;
  busy.add(key); renderServices();
  try { await api("/api/restart", { svc: key }); toast("Đã restart " + s.deploy); } catch (e) { alert(e.message); }
  busy.delete(key); setTimeout(refresh, 1000);
}

async function showLog(key, pod, previous) {
  const s = S.services.find((x) => x.key === key);
  openDlg("Log " + s.container + " · " + pod, '<p class="muted">Đang tải…</p>');
  try {
    const r = await api("/api/logs?svc=" + encodeURIComponent(key) + "&pod=" + encodeURIComponent(pod) + (previous ? "&previous=1" : ""));
    $("#dlg-body").innerHTML = '<div style="display:flex;gap:6px;margin-bottom:8px"><button class="ghost" id="lg-r">Tải lại</button><button class="ghost" id="lg-p">' + (previous ? "Lần chạy hiện tại" : "Lần chạy trước (sau crash)") + '</button></div><pre id="lg"></pre>';
    $("#lg").textContent = r.text || "(trống)";
    $("#lg-r").onclick = () => showLog(key, pod, previous); $("#lg-p").onclick = () => showLog(key, pod, !previous);
    const b = $("#dlg-body"); b.scrollTop = b.scrollHeight;
  } catch (e) { $("#dlg-body").innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

refresh(); loadHistory();
setInterval(() => { if (!document.hidden && !$("#dlg").open) refresh(); }, 5000);
`;
