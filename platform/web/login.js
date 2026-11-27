// Đăng nhập bằng Google (GIS, popup): nút Google gọi dangNhapGoogle với ID token, gửi về máy chủ kiểm (aud, email đã
// được mời, chưa bị khoá); đúng thì máy chủ đặt cookie phiên, tải lại trang đang mở.
window.dangNhapGoogle = async function (res) {
  const err = document.getElementById("login-err");
  const show = (m) => { err.textContent = m; err.hidden = false; };
  try {
    const r = await fetch("/login/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: res.credential }),
    });
    if (r.ok) { location.reload(); return; }
    const d = await r.json().catch(() => ({}));
    show(d.error || "Đăng nhập không thành công (HTTP " + r.status + ").");
  } catch (e) {
    show("Lỗi mạng khi đăng nhập: " + (e && e.message ? e.message : e));
  }
};
