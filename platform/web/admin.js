"use strict";
// Quản trị: người dùng & quyền (admin hệ thống: mời, khoá, vai trò; Project Admin: quyền trong dự án mình quản lý),
// nhật ký kiểm toán, token API cá nhân. Server kiểm quyền cho mọi thao tác; giao diện chỉ ẩn bớt nút.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (t) => (t ? new Date(t).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "");
const SYS = { owner: "Super admin", admin: "Admin", member: "Thành viên" };

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
const dlg = $("#dlg");
function openDlg(title, body, foot) {
  dlg.className = "";
  $("#dlg-title").innerHTML = title; $("#dlg-body").className = "dlg-b"; $("#dlg-body").innerHTML = body; $("#dlg-foot").innerHTML = foot || "";
  if (!dlg.open) dlg.showModal();
}
const closeDlg = () => dlg.open && dlg.close();
$("#dlg-close").onclick = closeDlg;

// ---------- Tab ----------
const loaders = { users: loadUsers, audit: loadAudit, tokens: loadTokens };
$$(".tab").forEach((t) => (t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$("main > section").forEach((s) => (s.hidden = s.id !== "tab-" + t.dataset.tab));
  loaders[t.dataset.tab]();
}));

// ---------- Người dùng & quyền ----------
let U = null;
async function loadUsers() {
  const box = $("#tab-users");
  try { U = await api("/api/users"); } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; return; }
  const envs = U.envs;
  const roleOpts = (cur) => '<option value="">—</option>' + U.roles.map((r) => '<option value="' + r.id + '"' + (r.id === cur ? " selected" : "") + ">" + esc(r.label) + "</option>").join("");
  box.innerHTML = '<div class="panel-h"><h2>Người dùng & quyền</h2><span class="panel-sub">Chỉ người có trong danh sách mới đăng nhập được (Google). Admin hệ thống có toàn quyền mọi dự án.</span>'
    + (U.sysAdmin ? '<button class="btn btn-primary btn-sm push-right" id="u-invite">Mời người dùng</button>' : "") + "</div>"
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Người dùng</th><th>Vai trò hệ thống</th>'
    + envs.map((e) => "<th>" + esc(e.name) + "<br><span class=\"muted light\">" + esc(e.label) + "</span></th>").join("")
    + "<th>Đăng nhập gần nhất</th><th></th></tr></thead><tbody>"
    + U.users.map((x) => {
      const sys = x.role === "owner" || x.role === "admin";
      const sysCell = x.owner ? '<span class="pill ok">Super admin</span>'
        : U.owner ? '<select data-sys="' + x.id + '"><option value="member"' + (x.role === "member" ? " selected" : "") + '>Thành viên</option><option value="admin"' + (x.role === "admin" ? " selected" : "") + ">Admin</option></select>"
        : esc(SYS[x.role]);
      const cells = envs.map((e) => {
        if (sys) return '<td class="muted">toàn quyền</td>';
        const m = x.memberships.find((m) => m.project === e.project && m.env === e.env);
        if (!e.manage) return "<td>" + esc(m ? (U.roles.find((r) => r.id === m.role) || {}).label : "—") + "</td>";
        return '<td><select data-m="' + x.id + '" data-p="' + esc(e.project) + '" data-e="' + esc(e.env) + '">' + roleOpts(m && m.role) + "</select></td>";
      }).join("");
      const act = !x.owner && U.sysAdmin && (U.owner || x.role === "member")
        ? '<button class="btn btn-sm ' + (x.active ? "btn-ghost" : "") + '" data-lock="' + x.id + '" data-v="' + (x.active ? 0 : 1) + '">' + (x.active ? "Khoá" : "Mở khoá") + "</button>" : "";
      return '<tr class="' + (x.active ? "" : "locked") + '"><td><div class="u-cell">' + (x.picture ? '<img class="avatar" src="' + esc(x.picture) + '" alt="" referrerpolicy="no-referrer">' : '<span class="avatar">' + esc((x.name || x.email).charAt(0).toUpperCase()) + "</span>")
        + "<div><div>" + esc(x.name) + (x.active ? "" : ' <span class="pill bad">đã khoá</span>') + '</div><div class="muted light">' + esc(x.email) + "</div></div></div></td>"
        + "<td>" + sysCell + "</td>" + cells + '<td class="muted">' + (x.lastLogin ? when(x.lastLogin) : "chưa đăng nhập") + "</td><td>" + act + "</td></tr>";
    }).join("") + "</tbody></table></div>"
    + '<details class="perm-help"><summary>Vai trò dự án × môi trường được làm gì?</summary><ul>'
    + U.roles.map((r) => "<li><b>" + esc(r.label) + "</b>: " + esc(r.perms.join(", ")) + "</li>").join("") + "</ul></details>";
  $$("[data-m]", box).forEach((s) => (s.onchange = async () => {
    try { await api("/api/members", { userId: Number(s.dataset.m), project: s.dataset.p, env: s.dataset.e, role: s.value || null }); toast("Đã lưu quyền"); }
    catch (e) { toast(e.message, true); loadUsers(); }
  }));
  $$("[data-sys]", box).forEach((s) => (s.onchange = async () => {
    try { await api("/api/users/update", { id: Number(s.dataset.sys), role: s.value }); toast("Đã đổi vai trò hệ thống"); loadUsers(); }
    catch (e) { toast(e.message, true); loadUsers(); }
  }));
  $$("[data-lock]", box).forEach((b) => (b.onclick = async () => {
    const lock = b.dataset.v === "0";
    if (lock && !confirm("Khoá tài khoản này? Người đó bị đăng xuất khỏi mọi nơi ngay.")) return;
    try { await api("/api/users/update", { id: Number(b.dataset.lock), active: !lock }); toast(lock ? "Đã khoá" : "Đã mở khoá"); loadUsers(); }
    catch (e) { toast(e.message, true); }
  }));
  const inv = $("#u-invite");
  if (inv) inv.onclick = () => {
    openDlg("Mời người dùng",
      '<label class="field"><span>Email Google</span><input id="iv-email" type="email" placeholder="ten@gmail.com" autocomplete="off"></label>'
      + (U.owner ? '<label class="field"><span>Vai trò hệ thống</span><select id="iv-role"><option value="member">Thành viên (gán quyền theo dự án sau)</option><option value="admin">Admin (toàn quyền mọi dự án)</option></select></label>' : "")
      + '<p class="muted">Người được mời đăng nhập bằng Google với đúng email này. Sau khi mời, gán quyền dự án × môi trường trong bảng.</p>',
      '<button class="btn" data-a="no">Hủy</button><button class="btn btn-primary" data-a="go">Mời</button>');
    $('#dlg-foot [data-a="no"]').onclick = closeDlg;
    $('#dlg-foot [data-a="go"]').onclick = async () => {
      try {
        await api("/api/users", { email: $("#iv-email").value.trim(), role: $("#iv-role") ? $("#iv-role").value : "member" });
        closeDlg(); toast("Đã mời"); loadUsers();
      } catch (e) { toast(e.message, true); }
    };
    $("#iv-email").focus();
  };
}

// ---------- Nhật ký ----------
const ACT = {
  login: "Đăng nhập", "login.denied": "Đăng nhập bị từ chối", logout: "Đăng xuất", check: "Chạy kiểm tra", build: "Build", "build.bypass": "Build BỎ QUA CHẶN",
  "build.done": "Build xong", deploy: "Đổi bản", "deploy.done": "Đổi bản xong", restart: "Khởi động lại", denied: "Bị chặn (thiếu quyền)",
  "user.invite": "Mời người dùng", "user.update": "Sửa người dùng", "member.set": "Gán quyền", "member.remove": "Gỡ quyền",
  "token.create": "Tạo token", "token.revoke": "Thu hồi token",
};
async function loadAudit() {
  const box = $("#tab-audit");
  try {
    const rows = await api("/api/audit?limit=300");
    box.innerHTML = '<div class="panel-h"><h2>Nhật ký kiểm toán</h2><span class="panel-sub">Chỉ ghi thêm, không sửa/xoá được</span></div>'
      + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Lúc</th><th>Người</th><th>Việc</th><th>Đối tượng</th><th>Chi tiết</th><th>IP</th></tr></thead><tbody>'
      + rows.map((r) => '<tr class="' + (r.ok ? "" : "t-bad") + '"><td class="nowrap">' + when(r.at) + "</td><td>" + esc(r.actor) + "</td><td>" + esc(ACT[r.action] || r.action) + "</td><td>" + esc(r.target || "")
        + '</td><td class="mono small">' + esc((r.detail || "").slice(0, 200)) + '</td><td class="muted">' + esc(r.ip || "") + "</td></tr>").join("")
      + "</tbody></table></div>";
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}

// ---------- Token API ----------
async function loadTokens() {
  const box = $("#tab-tokens");
  try {
    const rows = await api("/api/tokens");
    box.innerHTML = '<div class="panel-h"><h2>Token API của tôi</h2><span class="panel-sub">Cho script/AI gọi API thay bạn (header <code>Authorization: Bearer dmst_…</code>), cùng quyền với bạn</span>'
      + '<button class="btn btn-primary btn-sm push-right" id="t-new">Tạo token</button></div>'
      + (rows.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tên</th><th>Mã đầu</th><th>Tạo lúc</th><th>Hết hạn</th><th>Dùng gần nhất</th><th></th></tr></thead><tbody>'
        + rows.map((t) => '<tr class="' + (t.revoked ? "locked" : "") + "\"><td>" + esc(t.name) + '</td><td class="mono">' + esc(t.prefix) + "…</td><td>" + when(t.created) + "</td><td>" + (t.expires ? when(t.expires) : "không") + "</td><td>" + (t.last_used ? when(t.last_used) : "—")
          + "</td><td>" + (t.revoked ? '<span class="pill bad">đã thu hồi</span>' : '<button class="btn btn-sm btn-ghost" data-rv="' + t.id + '">Thu hồi</button>') + "</td></tr>").join("")
        + "</tbody></table></div>" : '<div class="empty">Chưa có token.</div>');
    $$("[data-rv]", box).forEach((b) => (b.onclick = async () => {
      if (!confirm("Thu hồi token này? Script đang dùng nó sẽ hết gọi được.")) return;
      try { await api("/api/tokens/revoke", { id: Number(b.dataset.rv) }); loadTokens(); } catch (e) { toast(e.message, true); }
    }));
    $("#t-new").onclick = () => {
      openDlg("Tạo token API",
        '<label class="field"><span>Tên (để nhớ dùng ở đâu)</span><input id="tk-name" placeholder="Vd. script build đêm" maxlength="60"></label>'
        + '<label class="field"><span>Hạn dùng</span><select id="tk-days"><option value="30">30 ngày</option><option value="90" selected>90 ngày</option><option value="365">1 năm</option></select></label>',
        '<button class="btn" data-a="no">Hủy</button><button class="btn btn-primary" data-a="go">Tạo</button>');
      $('#dlg-foot [data-a="no"]').onclick = closeDlg;
      $('#dlg-foot [data-a="go"]').onclick = async () => {
        try {
          const r = await api("/api/tokens", { name: $("#tk-name").value.trim(), days: Number($("#tk-days").value) });
          openDlg("Token đã tạo", '<p>Chép token ngay, trang sẽ không hiện lại:</p><pre class="term" id="tk-val"></pre>', '<button class="btn btn-primary" data-a="ok">Đã chép</button>');
          $("#tk-val").textContent = r.token;
          $('#dlg-foot [data-a="ok"]').onclick = () => { closeDlg(); loadTokens(); };
        } catch (e) { toast(e.message, true); }
      };
      $("#tk-name").focus();
    };
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}

loaders[$(".tab.active").dataset.tab]();
