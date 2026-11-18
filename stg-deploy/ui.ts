// Khung HTML trang deploy (staging hoặc production). CSS, JS, logo là tệp riêng cùng thư mục (app.css, app.js, login.js,
// logo-thihub.svg). Production đăng nhập bằng nút Google (GIS), staging bằng tên + mật khẩu chung.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Page = { user?: string; error?: string; name?: string; prod?: boolean; title?: string; branch?: string; clientId?: string };

const head = (title: string, gis = false) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · THiHUB</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/app.css"><meta name="robots" content="noindex,nofollow">${gis ? `
<script src="https://accounts.google.com/gsi/client" async></script><script src="/login.js" defer></script>` : ""}</head>`;

export function pageHtml(o: Page) {
  const prod = !!o.prod;
  const title = o.title ?? (prod ? "Production Deploy" : "Staging Deploy");
  const envName = prod ? "production" : "staging";
  if (!o.user) {
    if (prod) {
      return `${head(title, true)}<body class="login-page">
<main class="login">
  <img class="login-logo" src="/logo.svg" alt="THiHUB">
  <div class="login-card">
    <h1>${esc(title)}</h1>
    <p class="muted">Build và triển khai lên production (sangiaodich.thanhhoa.gov.vn). Chỉ tài khoản super admin.</p>
    <div class="alert alert-bad" id="login-err"${o.error ? "" : " hidden"}>${esc(o.error ?? "")}</div>
    <div id="g_id_onload" data-client_id="${esc(o.clientId ?? "")}" data-callback="dangNhapGoogle" data-auto_prompt="false" data-ux_mode="popup"></div>
    <div class="g_id_signin" data-type="standard" data-theme="outline" data-size="large" data-text="signin_with" data-shape="rectangular" data-logo_alignment="left" data-locale="vi"></div>
  </div>
  <p class="login-foot">Sàn TMĐT Thanh Hóa · production</p>
</main></body></html>`;
    }
    return `${head(title)}<body class="login-page">
<main class="login">
  <img class="login-logo" src="/logo.svg" alt="THiHUB">
  <form method="post" action="/login" class="login-card">
    <h1>${esc(title)}</h1>
    <p class="muted">Build và triển khai lên môi trường staging</p>
    ${o.error ? `<div class="alert alert-bad">${esc(o.error)}</div>` : ""}
    <label class="field"><span>Tên của bạn</span>
      <input name="name" required minlength="2" maxlength="40" autocomplete="nickname" value="${esc(o.name ?? "")}" placeholder="Nguyễn Văn An" autofocus></label>
    <label class="field"><span>Mật khẩu</span>
      <input name="password" type="password" required autocomplete="current-password" placeholder="••••••••"></label>
    <button type="submit" class="btn btn-primary btn-block">Đăng nhập</button>
  </form>
  <p class="login-foot">Sàn TMĐT Thanh Hóa · staging</p>
</main></body></html>`;
  }
  const initial = esc(o.user.trim().split(/\s+/).pop()!.charAt(0).toUpperCase());
  return `${head(title)}<body data-env="${envName}">
<header class="topbar">
  <div class="brand"><img src="/logo.svg" alt="THiHUB"><span class="brand-sep"></span><span class="brand-app">${esc(title)}</span></div>
  <div class="topbar-r">
    <button class="flux-chip" id="flux-chip" title="Trạng thái đồng bộ Flux · bấm để đồng bộ lại"><span class="dot"></span><span class="txt">Flux</span></button>
    <div class="user"><span class="avatar">${initial}</span><span class="user-name">${esc(o.user)}</span></div>
    <form method="post" action="/logout"><button class="btn btn-ghost btn-sm">Đăng xuất</button></form>
  </div>
</header>
<main class="layout">
  <div class="col-main">
    <div id="alerts"></div>
    <section class="panel">
      <div class="panel-h"><h2>Build mới</h2><span class="panel-sub">${prod ? "Chỉ mã đã merge vào main" : "Từ code đã push lên GitHub"}</span></div>
      <div class="panel-b build">
        <label class="field"><span>Nhánh hoặc commit</span>
          <div class="input-icon"><svg viewBox="0 0 24 24"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9"/></svg>
          <input id="b-ref" value="${esc(o.branch ?? envName)}" list="b-branches" autocomplete="off" spellcheck="false"></div>
          <datalist id="b-branches"></datalist>
        </label>
        <div class="commit-line" id="b-ref-info"></div>
        <div class="field"><span>Kiểm tra (CI) <span class="muted light">· typecheck, test, build như ci.yml, bắt buộc trước khi Build</span></span>
          <div class="ci" id="b-ci"><div class="ci-head"><span class="muted">Đang tải…</span></div></div></div>
        <div class="field"><span>Service</span><div class="chips" id="b-svcs"></div></div>
        <div class="build-foot">
          <label class="switch"><input type="checkbox" id="b-only"><span class="track"></span><span>Chỉ build, không deploy</span></label>
          <label class="switch" title="Khẩn cấp: CI chưa đạt và Trivy có lỗ hổng vẫn build/deploy. Được ghi vào log và commit đổi thẻ."><input type="checkbox" id="b-bypass"><span class="track"></span><span>Bỏ qua chặn CI/Trivy (khẩn cấp)</span></label>
          <button class="btn btn-primary" id="b-go" disabled title="Commit phải qua kiểm tra (CI) trước"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>Build &amp; deploy</button>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Service trên ${envName}</h2></div>
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
</main>
<dialog id="dlg"><div class="dlg-h"><div class="dlg-title" id="dlg-title"></div><button class="icon-btn" id="dlg-close" aria-label="Đóng"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="dlg-b" id="dlg-body"></div><div class="dlg-f" id="dlg-foot"></div></dialog>
<div id="toasts"></div>
<script src="/app.js"></script></body></html>`;
}
