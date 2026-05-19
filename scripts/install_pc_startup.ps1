# =====================================================
# CoWell PC起動通知 インストーラ (各PCで管理者権限で1回実行)
# =====================================================
# 使い方:
#   1. 同じフォルダに pc_startup.ps1 を置く
#   2. PowerShell を「管理者として実行」で開く
#   3. 以下のコマンドで PC ごとの値を渡してインストール:
#
#      .\install_pc_startup.ps1 -LoginId t_kobayashi -PcId HQ-01 `
#         -Secret "本番のPC_STARTUP_SECRET" `
#         -ApiUrl "https://cohub.biz-terrace.org/api/timecard/pc-startup"
#
#   4. 動作確認: タスクスケジューラに "CoWell-PC-Startup" が登録される。
#      手動実行: Start-ScheduledTask -TaskName "CoWell-PC-Startup"
#      ログ確認: notepad C:\ProgramData\CoWell\pc_startup.log
# =====================================================

param(
    [Parameter(Mandatory=$true)] [string]$LoginId,
    [Parameter(Mandatory=$true)] [string]$PcId,
    [Parameter(Mandatory=$true)] [string]$Secret,
    [string]$ApiUrl = "https://cohub.biz-terrace.org/api/timecard/pc-startup"
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

$srcScript = Join-Path $PSScriptRoot "pc_startup.ps1"
if (-not (Test-Path $srcScript)) {
    Write-Host "pc_startup.ps1 が見つかりません: $srcScript" -ForegroundColor Red
    exit 1
}

# テンプレートのプレースホルダを置換して配置
$content = Get-Content -Raw -Encoding utf8 $srcScript
$content = $content -replace 'REPLACE_LOGIN_ID', $LoginId
$content = $content -replace 'REPLACE_PC_ID',    $PcId
$content = $content -replace 'REPLACE_SECRET',   $Secret
$content = $content -replace 'https://cohub\.biz-terrace\.org/api/timecard/pc-startup', $ApiUrl

$dstScript = Join-Path $installDir "pc_startup.ps1"
$content | Out-File -FilePath $dstScript -Encoding utf8 -Force
Write-Host "✓ スクリプト配置: $dstScript" -ForegroundColor Green

# タスクスケジューラ登録 (ログオン時実行、ネットワーク利用可能まで遅延)
$taskName = "CoWell-PC-Startup"
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dstScript`""

# ログオン時 + ネットワーク接続後 30秒 (ネットワーク用意できる前にPOSTしないように)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# SYSTEMで実行 (ユーザー権限不要、ネットワーク経路を使う)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "CoWell サーバへログオン時刻を送信。打刻前作業の自動検出用。"

# 既存があれば置き換え
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
Write-Host "✓ タスク登録: $taskName" -ForegroundColor Green

# 動作確認: 即実行
Write-Host ""
Write-Host "▶ 動作確認のため今すぐ1回実行します..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$logFile = Join-Path $installDir "pc_startup.log"
if (Test-Path $logFile) {
    $lastLine = Get-Content $logFile -Tail 1
    Write-Host "ログ最終行: $lastLine"
    if ($lastLine -match "OK") {
        Write-Host "✓ サーバへの送信に成功しました" -ForegroundColor Green
    } else {
        Write-Host "✗ サーバへの送信が失敗しています。$ApiUrl と Secret を再確認してください。" -ForegroundColor Yellow
    }
} else {
    Write-Host "ログファイルが生成されませんでした: $logFile" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  インストール完了"
Write-Host "  LoginId: $LoginId"
Write-Host "  PcId:    $PcId"
Write-Host "  ApiUrl:  $ApiUrl"
Write-Host "==========================================="
