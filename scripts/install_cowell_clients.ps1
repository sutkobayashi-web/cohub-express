# =====================================================
# CoWell クライアントスクリプト 統合インストーラ
# (PC起動通知 + ハートビート の2タスクを一括登録)
# =====================================================
# 使い方:
#   1. 同じフォルダに pc_startup.ps1 と pc_heartbeat.ps1 を置く
#   2. PowerShell を「管理者として実行」で開く
#   3. PC ごとの値を渡してインストール:
#
#      .\install_cowell_clients.ps1 -LoginId t_kobayashi -PcId HQ-01 `
#         -Secret "本番のPC_STARTUP_SECRET" `
#         -ApiBase "https://cohub.biz-terrace.org/api/timecard"
#
#   4. 動作確認:
#      - タスクスケジューラに "CoWell-PC-Startup" / "CoWell-PC-Heartbeat" が登録される
#      - 手動実行: Start-ScheduledTask -TaskName "CoWell-PC-Startup"
#      - ログ確認: notepad C:\ProgramData\CoWell\pc_startup.log
#                  notepad C:\ProgramData\CoWell\pc_heartbeat.log
# =====================================================

param(
    [Parameter(Mandatory=$true)] [string]$LoginId,
    [Parameter(Mandatory=$true)] [string]$PcId,
    [Parameter(Mandatory=$true)] [string]$Secret,
    [string]$ApiBase = "https://cohub.biz-terrace.org/api/timecard"
)

# 管理者権限チェック
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "管理者権限で実行してください (PowerShell を管理者として実行)" -ForegroundColor Red
    exit 1
}

$installDir = "$env:ProgramData\CoWell"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# ===== ヘルパー: テンプレートからプレースホルダ置換して配置 =====
function Deploy-Script {
    param([string]$SourceName, [string]$DestName, [string]$ApiPath)
    $src = Join-Path $PSScriptRoot $SourceName
    if (-not (Test-Path $src)) {
        Write-Host "✗ $SourceName が見つかりません" -ForegroundColor Red
        return $null
    }
    $content = Get-Content -Raw -Encoding utf8 $src
    $content = $content -replace 'REPLACE_LOGIN_ID', $LoginId
    $content = $content -replace 'REPLACE_PC_ID',    $PcId
    $content = $content -replace 'REPLACE_SECRET',   $Secret
    $content = $content -replace 'https://cohub\.biz-terrace\.org/api/timecard/pc-startup', "$ApiBase/pc-startup"
    $content = $content -replace 'https://cohub\.biz-terrace\.org/api/timecard/heartbeat', "$ApiBase/heartbeat"
    $dst = Join-Path $installDir $DestName
    $content | Out-File -FilePath $dst -Encoding utf8 -Force
    Write-Host "✓ 配置: $dst" -ForegroundColor Green
    return $dst
}

$startupScript   = Deploy-Script "pc_startup.ps1"   "pc_startup.ps1"   "$ApiBase/pc-startup"
$heartbeatScript = Deploy-Script "pc_heartbeat.ps1" "pc_heartbeat.ps1" "$ApiBase/heartbeat"
if (-not $startupScript -or -not $heartbeatScript) { exit 1 }

# ===== 共通設定 =====
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$svcPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# ===== タスク1: PC起動通知 (ログオン時) =====
$startupTaskName = "CoWell-PC-Startup"
$startupAction = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startupScript`""
$startupTrigger = New-ScheduledTaskTrigger -AtLogOn
$startupTrigger.Delay = "PT30S"
$startupTask = New-ScheduledTask -Action $startupAction -Trigger $startupTrigger `
    -Settings $settings -Principal $svcPrincipal `
    -Description "CoWell サーバへログオン時刻を送信 (出勤時刻の自動記録)"
if (Get-ScheduledTask -TaskName $startupTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $startupTaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $startupTaskName -InputObject $startupTask | Out-Null
Write-Host "✓ タスク登録: $startupTaskName" -ForegroundColor Green

# ===== タスク2: ハートビート (5分おき) =====
$hbTaskName = "CoWell-PC-Heartbeat"
$hbAction = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$heartbeatScript`""
$hbTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$hbTask = New-ScheduledTask -Action $hbAction -Trigger $hbTrigger `
    -Settings $settings -Principal $svcPrincipal `
    -Description "CoWell サーバへハートビートを5分おきにPing (退勤時刻の自動推定用)"
if (Get-ScheduledTask -TaskName $hbTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $hbTaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $hbTaskName -InputObject $hbTask | Out-Null
Write-Host "✓ タスク登録: $hbTaskName" -ForegroundColor Green

# ===== 動作確認: 即実行 =====
Write-Host ""
Write-Host "▶ 動作確認のため今すぐ送信します..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $startupTaskName
Start-ScheduledTask -TaskName $hbTaskName
Start-Sleep -Seconds 4

$startupLog = Join-Path $installDir "pc_startup.log"
$hbLog = Join-Path $installDir "pc_heartbeat.log"
if (Test-Path $startupLog) {
    $line = Get-Content $startupLog -Tail 1
    Write-Host "PC起動ログ最終: $line"
    if ($line -match "OK") { Write-Host "  ✓ PC起動通知 OK" -ForegroundColor Green }
    else { Write-Host "  ✗ PC起動通知 失敗 — Secret/ApiBase を確認" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  CoWell クライアント インストール完了"
Write-Host "  LoginId : $LoginId"
Write-Host "  PcId    : $PcId"
Write-Host "  ApiBase : $ApiBase"
Write-Host "==========================================="
Write-Host ""
Write-Host "次のステップ:" -ForegroundColor Cyan
Write-Host "  ・社員に「CoWell → ⏰出退勤打刻 → ⚙設定」で自動打刻ONを案内"
Write-Host "  ・タスクスケジューラで状態確認: Get-ScheduledTask -TaskName CoWell-*"
