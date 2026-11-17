# Trang CI/CD staging DNSO (stg-deploy-dnso.senow.tech) chạy trên PC quản trị. Cùng cách vận hành với stg-deploy:
#
# Mã của trang chạy thẳng từ repo dmst-cicd, KHÔNG có bản sao: clone D:\DMST\dnso-stg-work\cicd luôn đặt về origin/main
# trước mỗi lần chạy server.ts. Sửa trang = commit + push nhánh main của dmst-cicd; server.ts tự thấy mã mới (tối đa
# 2 phút, hoặc ngay khi có người bấm Build/Deploy), thoát lúc rảnh, vòng lặp dưới lấy mã mới rồi chạy lại.
#
# Cài lần đầu (hoặc sửa Scheduled Task), từ bất kỳ bản checkout nào của dmst-cicd:
#   powershell -ExecutionPolicy Bypass -File dnso-stg\start.ps1 -Install
#   -> clone dmst-cicd nếu chưa có, chép cloudflared.exe từ stg-deploy-work nếu thiếu, tạo Scheduled Task "dnso-stg"
#      chạy start.ps1 TRONG clone cicd khi đăng nhập Windows, khởi động lại.
# Gỡ:  Unregister-ScheduledTask dnso-stg -Confirm:$false
# Log: D:\DMST\dnso-stg-work\server.out.log (lần chạy hiện tại), server.log (các lần trước).
# Mật khẩu dev: DEPLOY_PASSWORD trong D:\DMST\dnso-stg-work\secrets.json (tự sinh lần chạy đầu).
#
# Cần trên PC: Bun, Git (SSH alias github-tt47 đọc được vantt47/dmst-cicd và KHCN-Thanh-Hoa/doanhnghiepso), Docker
# Desktop, OpenSSH với alias DMST_05 trong ~/.ssh/config (khoá không mật khẩu, Tailscale bật), cloudflared.exe trong
# D:\DMST\dnso-stg-work\bin. TUNNEL_TOKEN (tunnel dnso-stg-deploy, tài khoản senow.tech) nằm trong secrets.json.
param([switch]$Install)
$ErrorActionPreference = "Stop"
$Work = "D:\DMST\dnso-stg-work"
$Tool = Join-Path $Work "cicd"
$Branch = "main"
$RepoUrl = "git@github-tt47:vantt47/dmst-cicd.git"
$AppDir = Join-Path $Tool "dnso-stg"
$Port = 8097
$log = Join-Path $Work "server.log"
function Log($m) { Add-Content -Encoding utf8 $log "$(Get-Date -Format s) --- $m" }

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
  Log "mã trang: $(git -C $Tool log -1 --format='%h %s' -- dnso-stg)"
}

function Stop-Leftovers {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Install) {
  New-Item -ItemType Directory -Force $Work, (Join-Path $Work "bin") | Out-Null
  $cf = Join-Path $Work "bin\cloudflared.exe"
  $cfSrc = "D:\DMST\stg-deploy-work\bin\cloudflared.exe"
  if (-not (Test-Path $cf) -and (Test-Path $cfSrc)) { Copy-Item $cfSrc $cf }
  Update-Tool
  $self = Join-Path $AppDir "start.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "dnso-stg" -Action $action -Trigger $trigger -Settings $settings -Description "Trang CI/CD staging DNSO (stg-deploy-dnso.senow.tech), mã chạy từ $AppDir (repo dmst-cicd)" -Force | Out-Null
  Stop-ScheduledTask -TaskName "dnso-stg" -ErrorAction SilentlyContinue
  Stop-Leftovers
  Start-ScheduledTask -TaskName "dnso-stg"
  Write-Host "Đã cài và khởi động task dnso-stg (mã: $AppDir). Log: $log"
  exit 0
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun*\bun-windows-x64\bun.exe" | Select-Object -First 1 -ExpandProperty FullName }
$selfHash = (Get-FileHash $PSCommandPath).Hash
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.1" }
  try { Update-Tool } catch { Log "cập nhật mã lỗi: $($_.Exception.Message)" }
  if ((Test-Path $PSCommandPath) -and (Get-FileHash $PSCommandPath).Hash -ne $selfHash) {
    Log "start.ps1 có bản mới, chạy lại start.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
  }
  Stop-Leftovers
  Log "khởi động dnso-stg"
  $p = Start-Process -FilePath $bun -ArgumentList "server.ts" -WorkingDirectory $AppDir -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Work\server.out.log" -RedirectStandardError "$Work\server.err.log"
  $p.WaitForExit()
  foreach ($f in "$Work\server.out.log", "$Work\server.err.log") { if (Test-Path $f) { Get-Content -Encoding utf8 $f | Add-Content -Encoding utf8 $log } }
  Log "dnso-stg thoát mã $($p.ExitCode), chạy lại sau 5 giây"
  Start-Sleep -Seconds 5
}
