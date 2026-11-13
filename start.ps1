# Trang build/deploy staging (stg-deploy-sangiaodich.dmst.vn) chạy trên PC quản trị.
#
# Mã của trang chạy thẳng từ repo, KHÔNG có bản sao: worktree D:\DMST\stg-deploy-work\tool (tách rời, của clone
# D:\DMST\stg-deploy-work\repo) luôn đặt về origin/staging trước mỗi lần chạy server.ts. Sửa trang = commit + push nhánh
# staging; server.ts tự thấy mã mới (tối đa 2 phút, hoặc ngay khi có người bấm Build/Deploy), thoát lúc rảnh, vòng lặp
# dưới lấy mã mới rồi chạy lại. Đổi chính tệp này cũng tự áp dụng (chạy lại tệp mới).
#
# Cài lần đầu (hoặc sửa Scheduled Task), từ bất kỳ bản checkout nào của repo:
#   powershell -ExecutionPolicy Bypass -File ecommerce-monorepo\deploy\stg-deploy\start.ps1 -Install
#   -> clone repo nếu chưa có, tạo worktree tool, tạo Scheduled Task "stg-deploy" chạy start.ps1 TRONG worktree tool khi
#      đăng nhập Windows, khởi động lại. Bản cài dùng mã trên origin/staging, không dùng mã chưa push của bản checkout.
# Gỡ:  Unregister-ScheduledTask stg-deploy -Confirm:$false
# Log: D:\DMST\stg-deploy-work\server.out.log (lần chạy hiện tại), server.log (các lần trước). Mật khẩu dev: DEPLOY_PASSWORD trong D:\DMST\stg-deploy-work\secrets.json
#
# Cần trên PC: Bun, Git (SSH alias github-tt47 có quyền push nhánh staging), Docker Desktop (đã docker login ghcr.io,
# quyền write:packages), kubectl + C:\Users\Admin\.kube\tmdt-staging.yaml qua Tailscale, cloudflared.exe trong
# D:\DMST\stg-deploy-work\bin. Token tunnel nằm trong secrets.json (TUNNEL_TOKEN, tunnel stg-deploy-pc trên account dmst.vn).
# PC phải luôn bật, không ngủ (Settings > Power: Sleep = Never), Docker Desktop tự chạy khi đăng nhập.
param([switch]$Install)
$ErrorActionPreference = "Stop"
$Work = "D:\DMST\stg-deploy-work"
$Repo = Join-Path $Work "repo"
$Tool = Join-Path $Work "tool"
$Branch = "staging"
$RepoUrl = "git@github-tt47:KHCN-Thanh-Hoa/5-san-tmdt.git"
$AppDir = Join-Path $Tool "ecommerce-monorepo\deploy\stg-deploy"
$log = Join-Path $Work "server.log"
function Log($m) { Add-Content -Encoding utf8 $log "$(Get-Date -Format s) --- $m" }

# Đặt worktree tool về origin/staging. Lỗi mạng: giữ mã đang có (nếu có) và chạy tiếp.
function Update-Tool {
  if (-not (Test-Path (Join-Path $Repo ".git"))) {
    git -c core.autocrlf=false clone -q --branch $Branch $RepoUrl $Repo
    if ($LASTEXITCODE) { throw "git clone $RepoUrl lỗi" }
    git -C $Repo config core.autocrlf false
    git -C $Repo config user.name "vantt47"
    git -C $Repo config user.email "89087529+vantt47@users.noreply.github.com"
  }
  git -C $Repo fetch -q --prune origin
  if ($LASTEXITCODE) { Log "git fetch lỗi, dùng mã đang có trong $Tool" }
  if (-not (Test-Path (Join-Path $Tool ".git"))) {
    git -C $Repo worktree prune
    git -C $Repo worktree add -q --detach $Tool "origin/$Branch"
    if ($LASTEXITCODE) { throw "git worktree add $Tool lỗi" }
  } else {
    git -C $Tool checkout -q --force --detach "origin/$Branch"
    if ($LASTEXITCODE) { Log "git checkout origin/$Branch trong $Tool lỗi, dùng mã đang có" }
  }
  Log "mã trang: $(git -C $Tool log -1 --format='%h %s' -- ecommerce-monorepo/deploy/stg-deploy)"
}

# Dừng tiến trình còn sót của lần chạy trước (bun server, kubectl proxy, cloudflared)
function Stop-Leftovers {
  Get-NetTCPConnection -LocalPort 8099, 8098 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Install) {
  New-Item -ItemType Directory -Force $Work | Out-Null
  Update-Tool
  $self = Join-Path $AppDir "start.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "stg-deploy" -Action $action -Trigger $trigger -Settings $settings -Description "Trang build/deploy staging Sàn TMĐT (stg-deploy-sangiaodich.dmst.vn), mã chạy từ worktree $Tool" -Force | Out-Null
  Stop-ScheduledTask -TaskName "stg-deploy" -ErrorAction SilentlyContinue
  Stop-Leftovers
  # Bản sao cũ (trước 13/11/2026 trang chạy từ WORK\app, chép tay khi cài): bỏ để không ai chạy nhầm
  $old = Join-Path $Work "app"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  Start-ScheduledTask -TaskName "stg-deploy"
  Write-Host "Đã cài và khởi động task stg-deploy (mã: $AppDir). Log: $log"
  exit 0
}

# Chạy (do Scheduled Task gọi): lấy mã mới, giữ sống tiến trình bun, ghi log, chạy lại khi thoát.
$env:GITHUB_CLASSIC_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_CLASSIC_TOKEN", "User")
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun*\bun-windows-x64\bun.exe" | Select-Object -First 1 -ExpandProperty FullName }
$selfHash = (Get-FileHash $PSCommandPath).Hash
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.1" }
  try { Update-Tool } catch { Log "cập nhật mã lỗi: $($_.Exception.Message)" }
  # Chính tệp này vừa đổi: chạy tệp mới thay cho vòng lặp cũ
  if ((Test-Path $PSCommandPath) -and (Get-FileHash $PSCommandPath).Hash -ne $selfHash) {
    Log "start.ps1 có bản mới, chạy lại start.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
  }
  Stop-Leftovers
  Log "khởi động stg-deploy"
  $p = Start-Process -FilePath $bun -ArgumentList "server.ts" -WorkingDirectory $AppDir -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Work\server.out.log" -RedirectStandardError "$Work\server.err.log"
  $p.WaitForExit()
  foreach ($f in "$Work\server.out.log", "$Work\server.err.log") { if (Test-Path $f) { Get-Content -Encoding utf8 $f | Add-Content -Encoding utf8 $log } }
  Log "stg-deploy thoát mã $($p.ExitCode), chạy lại sau 5 giây"
  Start-Sleep -Seconds 5
}
