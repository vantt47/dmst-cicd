// Khung HTML trang CI/CD staging thi-vien-chuc. CSS dùng chung với stg-deploy (../stg-deploy/app.css) + tvc.css; JS ở app.js.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const HEAD = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staging Thi viên chức · CI/CD</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/app.css"><meta name="robots" content="noindex,nofollow"></head>`;

type Cfg = { deployBranch: string; autoDeploy: boolean; autoResetDb: boolean; autoCheck: string[]; ns: string; site: string; repo: string };

export function pageHtml(o: { user?: string; error?: string; name?: string } & Partial<Cfg>) {
  if (!o.user) {
    return `${HEAD}<body class="login-page">
<main class="login">
  <img class="login-logo" src="/logo.svg" alt="Thi viên chức">
  <form method="post" action="/login" class="login-card">
    <h1>Staging Thi viên chức</h1>
    <p class="muted">Kiểm tra, build và triển khai lên stg-thi-vien-chuc.dmst.vn</p>
    ${o.error ? `<div class="alert alert-bad">${esc(o.error)}</div>` : ""}
    <label class="field"><span>Tên của bạn</span>
      <input name="name" required minlength="2" maxlength="40" autocomplete="nickname" value="${esc(o.name ?? "")}" placeholder="Nguyễn Văn An" autofocus></label>
    <label class="field"><span>Mật khẩu</span>
      <input name="password" type="password" required autocomplete="current-password" placeholder="••••••••"></label>
    <button type="submit" class="btn btn-primary btn-block">Đăng nhập</button>
  </form>
  <p class="login-foot">Thi tuyển viên chức · staging</p>
</main></body></html>`;
  }
  const initial = esc(o.user.trim().split(/\s+/).pop()!.charAt(0).toUpperCase());
  const auto = o.autoDeploy
    ? `Push vào <code>${esc(o.deployBranch!)}</code> → tự kiểm tra → đạt thì tự build &amp; triển khai${o.autoResetDb ? " (schema.sql đổi thì tự làm lại CSDL staging từ dữ liệu mẫu)" : " (schema.sql đổi thì dừng, chờ người chọn làm lại CSDL)"}`
    : `Tự triển khai đang TẮT (AUTO_DEPLOY=0): push chỉ tự kiểm tra`;
  return `${HEAD}<body>
<header class="topbar">
  <div class="brand"><img src="/logo.svg" alt="Thi viên chức"><span class="brand-sep"></span><span class="brand-app">Staging Thi viên chức · CI/CD</span></div>
  <div class="topbar-r">
    <a class="flux-chip" id="site-chip" href="${esc(o.site!)}" target="_blank" rel="noopener" title="Mở staging"><span class="dot"></span><span class="txt">Staging</span></a>
    <div class="user"><span class="avatar">${initial}</span><span class="user-name">${esc(o.user)}</span></div>
    <form method="post" action="/logout"><button class="btn btn-ghost btn-sm">Đăng xuất</button></form>
  </div>
</header>
<main class="layout">
  <div class="col-main">
    <div id="alerts"></div>
    <div class="auto-note">${auto}. Tự kiểm tra các nhánh: ${o.autoCheck!.map((b) => `<code>${esc(b)}</code>`).join(", ")}.</div>
    <section class="panel">
      <div class="panel-h"><h2>Build mới</h2><span class="panel-sub">Từ code đã push lên GitHub (${esc(o.repo!)})</span></div>
      <div class="panel-b build">
        <label class="field"><span>Nhánh hoặc commit</span>
          <div class="input-icon"><svg viewBox="0 0 24 24"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9"/></svg>
          <input id="b-ref" value="${esc(o.deployBranch!)}" list="b-branches" autocomplete="off" spellcheck="false"></div>
          <datalist id="b-branches"></datalist>
        </label>
        <div class="commit-line" id="b-ref-info"></div>
        <div class="field"><span>Kiểm tra (CI) <span class="muted light">· schema.sql + seed.sql trên Postgres sạch, build backend + frontend — bắt buộc trước khi Build</span></span>
          <div class="ci" id="b-ci"><div class="ci-head"><span class="muted">Đang tải…</span></div></div></div>
        <div class="build-foot">
          <label class="switch"><input type="checkbox" id="b-only"><span class="track"></span><span>Chỉ build, không triển khai</span></label>
          <label class="switch" title="Xoá toàn bộ dữ liệu staging, chạy lại schema.sql + seed.sql. Bắt buộc khi schema.sql đổi (dự án không có migration)."><input type="checkbox" id="b-reset"><span class="track"></span><span>Làm lại CSDL</span></label>
          <label class="switch" title="Khẩn cấp: CI chưa đạt vẫn build/triển khai. Được ghi vào log."><input type="checkbox" id="b-bypass"><span class="track"></span><span>Bỏ qua chặn CI (khẩn cấp)</span></label>
          <button class="btn btn-primary" id="b-go" disabled title="Commit phải qua kiểm tra (CI) trước"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>Build &amp; deploy</button>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Cụm staging</h2><span class="panel-sub">k3s · namespace ${esc(o.ns!)}</span>
        <button class="btn btn-sm push-right" id="pick-tag"><svg viewBox="0 0 24 24"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>Đổi bản</button></div>
      <div id="may-head" class="may-head"></div>
      <div id="services" class="svc-list"><div class="empty">Đang tải…</div></div>
    </section>
  </div>
  <aside class="col-side">
    <section class="panel">
      <div class="panel-h tabs"><button class="tab active" data-tab="jobs">Hoạt động</button><button class="tab" data-tab="hist">Lịch sử triển khai</button></div>
      <div id="tab-jobs" class="feed"><div class="empty">Chưa có lượt nào.</div></div>
      <div id="tab-hist" class="feed" hidden><div class="empty">Đang tải…</div></div>
    </section>
  </aside>
</main>
<dialog id="dlg"><div class="dlg-h"><div class="dlg-title" id="dlg-title"></div><button class="icon-btn" id="dlg-close" aria-label="Đóng"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="dlg-b" id="dlg-body"></div><div class="dlg-f" id="dlg-foot"></div></dialog>
<div id="toasts"></div>
<script src="/app.js"></script></body></html>`;
}
