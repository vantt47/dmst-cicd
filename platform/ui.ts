// Khung HTML các trang. CSS/JS/logo là tệp tĩnh trong web/ (phục vụ ở /s/...). Không có mã nội tuyến (CSP script-src 'self').
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Page = { user: string; picture?: string | null; sysAdmin: boolean; canManage: boolean; preview: boolean; error?: string };

const head = (title: string, gis = false) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · DMST CI/CD</title><link rel="icon" href="/s/logo-thihub.svg"><link rel="stylesheet" href="/s/app.css"><link rel="stylesheet" href="/s/platform.css"><meta name="robots" content="noindex,nofollow">${gis ? `
<script src="https://accounts.google.com/gsi/client" async></script><script src="/s/login.js" defer></script>` : ""}</head>`;

const previewBar = (o: { preview: boolean }) => o.preview
  ? `<div class="preview-bar">Bản xem trước: chỉ đọc trạng thái thật; chạy kiểm tra, build, deploy, restart chỉ giả lập (ghi lệnh ra log). Trang cũ vẫn là nơi thao tác thật.</div>` : "";

function topbar(o: Page, active: "home" | "admin" | "env", extra = "") {
  const initial = esc(o.user.trim().split(/\s+/).pop()!.charAt(0).toUpperCase());
  const av = o.picture ? `<img class="avatar" src="${esc(o.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${initial}</span>`;
  return `${previewBar(o)}<header class="topbar">
  <div class="brand"><a href="/" class="brand-link"><img src="/s/logo-thihub.svg" alt=""><span class="brand-app">DMST CI/CD</span></a>${extra}</div>
  <nav class="nav"><a href="/"${active === "home" ? ' class="on"' : ""}>Dự án</a><a href="/admin"${active === "admin" ? ' class="on"' : ""}>${o.canManage ? "Quản trị" : "Token API"}</a></nav>
  <div class="topbar-r">
    <span id="topbar-extra"></span>
    <div class="user">${av}<span class="user-name">${esc(o.user)}</span></div>
    <form method="post" action="/logout"><button class="btn btn-ghost btn-sm">Đăng xuất</button></form>
  </div>
</header>`;
}
const dialog = `<dialog id="dlg"><div class="dlg-h"><div class="dlg-title" id="dlg-title"></div><button class="icon-btn" id="dlg-close" aria-label="Đóng"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="dlg-b" id="dlg-body"></div><div class="dlg-f" id="dlg-foot"></div></dialog>
<div id="toasts"></div>`;

export function loginHtml(o: { clientId: string; preview: boolean; error?: string }) {
  return `${head("Đăng nhập", true)}<body class="login-page">${previewBar(o)}
<main class="login">
  <img class="login-logo" src="/s/logo-thihub.svg" alt="">
  <div class="login-card">
    <h1>DMST CI/CD</h1>
    <p class="muted">Kiểm tra, build và triển khai staging các dự án DMST. Đăng nhập bằng tài khoản Google đã được mời.</p>
    <div class="alert alert-bad" id="login-err"${o.error ? "" : " hidden"}>${esc(o.error ?? "")}</div>
    <div id="g_id_onload" data-client_id="${esc(o.clientId)}" data-callback="dangNhapGoogle" data-auto_prompt="false" data-ux_mode="popup"></div>
    <div class="g_id_signin" data-type="standard" data-theme="outline" data-size="large" data-text="signin_with" data-shape="rectangular" data-logo_alignment="left" data-locale="vi"></div>
  </div>
  <p class="login-foot">Chưa có quyền? Nhờ quản trị viên mời email Google của bạn.</p>
</main></body></html>`;
}

export function homeHtml(o: Page) {
  return `${head("Dự án")}<body>${topbar(o, "home")}
<main class="wrap">
  ${o.error ? `<div class="alert alert-bad">${esc(o.error)}</div>` : ""}
  <div class="page-h"><h1>Dự án</h1><span class="muted">Các môi trường bạn được xem</span></div>
  <div id="cards" class="cards"><div class="empty">Đang tải…</div></div>
</main>${dialog}<script src="/s/home.js"></script></body></html>`;
}

export function adminHtml(o: Page) {
  const tabs = [
    ...(o.canManage ? [["users", "Người dùng & quyền"], ["audit", "Nhật ký"]] : []),
    ["tokens", "Token API của tôi"],
  ];
  return `${head("Quản trị")}<body data-manage="${o.canManage ? 1 : 0}" data-sysadmin="${o.sysAdmin ? 1 : 0}">${topbar(o, "admin")}
<main class="wrap">
  <div class="page-h tabs">${tabs.map(([k, t], i) => `<button class="tab${i ? "" : " active"}" data-tab="${k}">${t}</button>`).join("")}</div>
  ${tabs.map(([k], i) => `<section id="tab-${k}" class="panel"${i ? " hidden" : ""}><div class="empty">Đang tải…</div></section>`).join("")}
</main>${dialog}<script src="/s/admin.js"></script></body></html>`;
}

// Trang một dự án × môi trường. Kiểu gitops: giao diện như stg-deploy (web/gitops.js).
export function envHtml(o: Page & { kind: string; project: string; projectId: string; env: string; envLabel: string; branch: string; logo: string; services: { key: string; label: string }[] }) {
  const base = `/p/${o.projectId}/${o.env}`;
  const crumb = `<span class="brand-sep"></span><img src="/s/${esc(o.logo)}" alt="" class="proj-logo"><span class="brand-app">${esc(o.project)} · ${esc(o.envLabel)}</span><span class="pill" id="role-pill"></span>`;
  return `${head(`${o.project} ${o.envLabel}`)}<body data-base="${esc(base)}" data-env="${esc(o.env)}">
${topbar(o, "env", crumb)}
<main class="layout">
  <div class="col-main">
    <div id="alerts"></div>
    <section class="panel" id="build-panel">
      <div class="panel-h"><h2>Build mới</h2><span class="panel-sub">Từ code đã push lên GitHub</span></div>
      <div class="panel-b build">
        <label class="field"><span>Nhánh hoặc commit</span>
          <div class="input-icon"><svg viewBox="0 0 24 24"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9"/></svg>
          <input id="b-ref" value="${esc(o.branch)}" list="b-branches" autocomplete="off" spellcheck="false"></div>
          <datalist id="b-branches"></datalist>
        </label>
        <div class="commit-line" id="b-ref-info"></div>
        <div class="field"><span>Kiểm tra (CI) <span class="muted light">· bắt buộc trước khi Build</span></span>
          <div class="ci" id="b-ci"><div class="ci-head"><span class="muted">Đang tải…</span></div></div></div>
        <div class="field" data-perm="build"><span>Service</span><div class="chips" id="b-svcs"></div></div>
        <div class="build-foot" data-perm="build">
          <label class="switch"><input type="checkbox" id="b-only"><span class="track"></span><span>Chỉ build, không deploy</span></label>
          <label class="switch" data-perm="bypass" title="Khẩn cấp: CI chưa đạt và Trivy có lỗ hổng vẫn build/deploy. Bắt buộc ghi lý do, ghi vào nhật ký."><input type="checkbox" id="b-bypass"><span class="track"></span><span>Bỏ qua chặn CI/Trivy (khẩn cấp)</span></label>
          <button class="btn btn-primary" id="b-go" disabled title="Commit phải qua kiểm tra (CI) trước"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>Build &amp; deploy</button>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Service trên ${esc(o.envLabel.toLowerCase())}</h2></div>
      <div id="services" class="svc-list"><div class="empty">Đang tải…</div></div>
    </section>
  </div>
  <aside class="col-side">
    <section class="panel">
      <div class="panel-h tabs"><button class="tab active" data-tab="jobs">Hoạt động</button><button class="tab" data-tab="hist">Lịch sử deploy</button></div>
      <div id="tab-jobs" class="feed"><div class="empty">Chưa có lượt build nào.</div></div>
      <div id="tab-hist" class="feed" hidden><div class="empty">Đang tải…</div></div>
    </section>
  </aside>
</main>${dialog}<script src="/s/${esc(o.kind)}.js"></script></body></html>`;
}
