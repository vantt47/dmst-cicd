# Trang build/deploy staging (stg-deploy-sangiaodich.dmst.vn) chạy trên PC quản trị.
#
# Cài/cập nhật (chạy lại mỗi khi sửa server.ts, ui.ts):
#   powershell -ExecutionPolicy Bypass -File deploy\stg-deploy\start.ps1 -Install
#   -> chép mã vào D:\DMST\stg-deploy-work\app, tạo Scheduled Task "stg-deploy" chạy khi đăng nhập Windows, khởi động lại.
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
$App = Join-Path $Work "app"

if ($Install) {
  New-Item -ItemType Directory -Force $App | Out-Null
  Copy-Item -Force (Join-Path $PSScriptRoot "server.ts"), (Join-Path $PSScriptRoot "ui.ts"), (Join-Path $PSScriptRoot "start.ps1") $App
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$App\start.ps1`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "stg-deploy" -Action $action -Trigger $trigger -Settings $settings -Description "Trang build/deploy staging Sàn TMĐT (stg-deploy-sangiaodich.dmst.vn)" -Force | Out-Null
  Stop-ScheduledTask -TaskName "stg-deploy" -ErrorAction SilentlyContinue
  Get-NetTCPConnection -LocalPort 8099, 8098 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" } | Stop-Process -Force
  Start-ScheduledTask -TaskName "stg-deploy"
  Write-Host "Đã cài và khởi động task stg-deploy. Log: $Work\server.log"
  exit 0
}

# Chạy (do Scheduled Task gọi): giữ sống tiến trình bun, ghi log, tự chạy lại khi thoát.
$env:GITHUB_CLASSIC_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_CLASSIC_TOKEN", "User")
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun*\bun-windows-x64\bun.exe" | Select-Object -First 1 -ExpandProperty FullName }
$log = Join-Path $Work "server.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.1" }
  Add-Content -Encoding utf8 $log "$(Get-Date -Format s) --- khởi động stg-deploy"
  $p = Start-Process -FilePath $bun -ArgumentList "server.ts" -WorkingDirectory $App -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Work\server.out.log" -RedirectStandardError "$Work\server.err.log"
  $p.WaitForExit()
  foreach ($f in "$Work\server.out.log", "$Work\server.err.log") { if (Test-Path $f) { Get-Content -Encoding utf8 $f | Add-Content -Encoding utf8 $log } }
  Add-Content -Encoding utf8 $log "$(Get-Date -Format s) --- stg-deploy thoát mã $($p.ExitCode), chạy lại sau 5 giây"
  Start-Sleep -Seconds 5
}
