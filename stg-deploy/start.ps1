# Trang build/deploy staging (stg-deploy-sangiaodich.dmst.vn) chạy trên PC quản trị.
#
# Mã của trang chạy thẳng từ repo dmst-cicd, KHÔNG có bản sao: clone D:\DMST\stg-deploy-work\cicd luôn đặt về
# origin/main trước mỗi lần chạy server.ts. Sửa trang = commit + push nhánh main của dmst-cicd; server.ts tự thấy mã mới
# (tối đa 2 phút, hoặc ngay khi có người bấm Build/Deploy), thoát lúc rảnh, vòng lặp dưới lấy mã mới rồi chạy lại.
# Đổi chính tệp này cũng tự áp dụng (chạy lại tệp mới).
#
# Cài lần đầu (hoặc sửa Scheduled Task), từ bất kỳ bản checkout nào của dmst-cicd:
#   powershell -ExecutionPolicy Bypass -File stg-deploy\start.ps1 -Install
#   -> clone dmst-cicd nếu chưa có, tạo Scheduled Task "stg-deploy" chạy start.ps1 TRONG clone cicd khi đăng nhập
#      Windows, khởi động lại. Bản cài dùng mã trên origin/main, không dùng mã chưa push của bản checkout.
# Gỡ:  Unregister-ScheduledTask stg-deploy -Confirm:$false
# Log: D:\DMST\stg-deploy-work\server.out.log (lần chạy hiện tại), server.log (các lần trước). Mật khẩu dev: DEPLOY_PASSWORD trong D:\DMST\stg-deploy-work\secrets.json
#
# Cần trên PC: Bun, Git (SSH alias github-tt47: đọc vantt47/dmst-cicd, push nhánh staging của KHCN-Thanh-Hoa/5-san-tmdt),
# Docker Desktop (đã docker login ghcr.io, quyền write:packages), kubectl + C:\Users\Admin\.kube\tmdt-staging.yaml qua
# Tailscale, cloudflared.exe trong D:\DMST\stg-deploy-work\bin. Token tunnel nằm trong secrets.json (TUNNEL_TOKEN,
# tunnel stg-deploy-pc trên account dmst.vn). PC phải luôn bật, không ngủ (Settings > Power: Sleep = Never), Docker
# Desktop tự chạy khi đăng nhập.
#
# Bản production (prod-deploy-sangiaodich.dmst.vn, đăng nhập Google, chỉ ALLOWED_EMAILS, build nhánh main):
#   powershell -ExecutionPolicy Bypass -File stg-deploy\start.ps1 -Install -DeployEnv production
#   -> task "prod-deploy", WORK D:\DMST\prod-deploy-work, cổng 8199 (kubectl proxy 8198, kubeconfig tmdt-production.yaml).
#   Không chạy cloudflared riêng: tunnel stg-deploy-pc (cloudflared của bản staging) chuyển prod-deploy-... tới 127.0.0.1:8199.
param([switch]$Install, [ValidateSet("staging", "production")][string]$DeployEnv = "staging")
$ErrorActionPreference = "Stop"
$Prod = $DeployEnv -eq "production"
$Name = if ($Prod) { "prod-deploy" } else { "stg-deploy" }
$Work = if ($Prod) { "D:\DMST\prod-deploy-work" } else { "D:\DMST\stg-deploy-work" }
$Ports = if ($Prod) { 8199, 8198 } else { 8099, 8098 }
$env:DEPLOY_ENV = $DeployEnv
$Tool = Join-Path $Work "cicd"
$Branch = "main"
$RepoUrl = "git@github-tt47:vantt47/dmst-cicd.git"
$AppDir = Join-Path $Tool "stg-deploy"
$log = Join-Path $Work "server.log"
function Log($m) { Add-Content -Encoding utf8 $log "$(Get-Date -Format s) --- $m" }

# Đặt clone cicd về origin/main. Lỗi mạng: giữ mã đang có (nếu có) và chạy tiếp.
function Update-Tool {
  if (-not (Test-Path (Join-Path $Tool ".git"))) {
    git -c core.autocrlf=false clone -q --branch $Branch $RepoUrl $Tool
    if ($LASTEXITCODE) { throw "git clone $RepoUrl lỗi" }
    git -C $Tool config core.autocrlf false
  }
  git -C $Tool fetch -q --prune origin
  if ($LASTEXITCODE) { Log "git fetch lỗi, dùng mã đang có trong $Tool" }
  git -C $Tool checkout -q --force --detach "origin/$Branch"
  if ($LASTEXITCODE) { Log "git checkout origin/$Branch trong $Tool lỗi, dùng mã đang có" }
  Log "mã trang: $(git -C $Tool log -1 --format='%h %s' -- stg-deploy)"
}

# Dừng tiến trình còn sót của lần chạy trước (bun server, kubectl proxy, cloudflared)
function Stop-Leftovers {
  Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Install) {
  New-Item -ItemType Directory -Force $Work | Out-Null
  Update-Tool
  $self = Join-Path $AppDir "start.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -DeployEnv $DeployEnv"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Description "Trang build/deploy $DeployEnv Sàn TMĐT ($Name-sangiaodich.dmst.vn), mã chạy từ $AppDir (repo dmst-cicd)" -Force | Out-Null
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Stop-Leftovers
  # Chỗ chạy cũ: WORK\app (bản sao, trước 13/11/2026) và WORK\tool (worktree monorepo, trước khi tách sang dmst-cicd)
  $old = Join-Path $Work "app"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  $oldTool = Join-Path $Work "tool"
  if (Test-Path $oldTool) {
    $repo = Join-Path $Work "repo"
    if (Test-Path (Join-Path $repo ".git")) { git -C $repo worktree remove --force $oldTool 2>$null }
    if (Test-Path $oldTool) { Remove-Item -Recurse -Force $oldTool }
    if (Test-Path (Join-Path $repo ".git")) { git -C $repo worktree prune }
  }
  Start-ScheduledTask -TaskName $Name
  Write-Host "Đã cài và khởi động task $Name (mã: $AppDir). Log: $log"
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
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -DeployEnv $DeployEnv
    exit $LASTEXITCODE
  }
  Stop-Leftovers
  Log "khởi động $Name"
  $p = Start-Process -FilePath $bun -ArgumentList "server.ts" -WorkingDirectory $AppDir -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Work\server.out.log" -RedirectStandardError "$Work\server.err.log"
  $p.WaitForExit()
  foreach ($f in "$Work\server.out.log", "$Work\server.err.log") { if (Test-Path $f) { Get-Content -Encoding utf8 $f | Add-Content -Encoding utf8 $log } }
  Log "$Name thoát mã $($p.ExitCode), chạy lại sau 5 giây"
  Start-Sleep -Seconds 5
}
