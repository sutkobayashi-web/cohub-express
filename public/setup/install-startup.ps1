# =====================================================
# CoWell PC起動通知 ワンライナー インストーラ
# =====================================================
# 各PCで「PowerShellを管理者として実行」してから、
# 以下を1行貼り付けて Enter (3か所書き換え):
#
#   $LoginId="t_kobayashi"; $PcId="HQ-01"; $Secret="xxx..."; iex (irm https://cohub.biz-terrace.org/setup/install-startup.ps1)
#
# 何が起きるか:
#   1. C:\ProgramData\CoWell\pc_startup.ps1 を生成 (LoginId/PcId/Secret 埋め込み済)
#   2. タスクスケジューラ "CoWell-PC-Startup" を登録 (ログオン時SYSTEM実行)
#   3. 即1回実行して動作確認 (ログ末尾に OK が出れば成功)
# =====================================================

# 0. 必要変数チェック
if (-not $LoginId -or -not $PcId -or -not $Secret) {
    Write-Host ""
    Write-Host "✗ 変数が不足しています。次の3つを設定してから再実行してください:" -ForegroundColor Red
    Write-Host '  $LoginId="あなたのlogin_id"' -ForegroundColor Yellow
    Write-Host '  $PcId="HQ-01"' -ForegroundColor Yellow
    Write-Host '  $Secret="サーバ.envのPC_STARTUP_SECRET"' -ForegroundColor Yellow
    Write-Host ""
    Write-Host "例 (1行で全部):" -ForegroundColor Cyan
    Write-Host '  $LoginId="t_kobayashi"; $PcId="HQ-01"; $Secret="xxx"; iex (irm https://cohub.biz-terrace.org/setup/install-startup.ps1)' -ForegroundColor Gray
    return
}

# 1. 管理者権限チェック
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($current)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "✗ 管理者権限が必要です。" -ForegroundColor Red
    Write-Host "  PowerShellを「管理者として実行」で起動し直してください。" -ForegroundColor Yellow
    Write-Host "  (スタートメニュー → 'PowerShell' → 右クリック → 管理者として実行)" -ForegroundColor Gray
    return
}

# 2. インストール先準備
$installDir = "$env:ProgramData\CoWell"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

$ApiUrl = "https://cohub.biz-terrace.org/api/timecard/pc-startup"

# 3. pc_startup.ps1 を埋め込み値付きで生成
$body = @"
# CoWell PC起動通知 (自動生成: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
# 編集禁止 — 再生成は install-startup.ps1 を再実行してください
`$LoginId = '$LoginId'
`$PcId    = '$PcId'
`$Secret  = '$Secret'
`$ApiUrl  = '$ApiUrl'
`$logFile = "`$env:ProgramData\CoWell\pc_startup.log"
try {
    `$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    `$startedAt = `$os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss')
} catch {
    `$startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
`$payload = @{ secret=`$Secret; login_id=`$LoginId; pc_id=`$PcId; started_at=`$startedAt } | ConvertTo-Json -Compress
try {
    `$resp = Invoke-RestMethod -Uri `$ApiUrl -Method POST -Body `$payload -ContentType 'application/json' -TimeoutSec 15 -ErrorAction Stop
    "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')``tOK``tboot=`$startedAt``tid=`$(`$resp.id)" | Out-File -FilePath `$logFile -Append -Encoding utf8
} catch {
    "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')``tFAIL``tboot=`$startedAt``t`$(`$_.Exception.Message)" | Out-File -FilePath `$logFile -Append -Encoding utf8
}
try {
    if ((Get-Item `$logFile -ErrorAction SilentlyContinue).Length -gt 1MB) {
        Move-Item -Force -Path `$logFile -Destination "`$logFile.bak"
    }
} catch {}
"@

$dstScript = Join-Path $installDir "pc_startup.ps1"
$body | Out-File -FilePath $dstScript -Encoding utf8 -Force
Write-Host "✓ スクリプト配置: $dstScript" -ForegroundColor Green

# 4. タスクスケジューラ登録 (既存があれば置換)
$taskName = "CoWell-PC-Startup"
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dstScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "CoWell PC起動時刻送信 ($LoginId / $PcId)" | Out-Null
Write-Host "✓ タスク登録: $taskName" -ForegroundColor Green

# 5. 即1回実行して動作確認
Write-Host ""
Write-Host "▶ 動作確認のため今すぐ1回実行..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

$logFile = Join-Path $installDir "pc_startup.log"
if (Test-Path $logFile) {
    $lastLine = Get-Content $logFile -Tail 1
    Write-Host "ログ最終行: $lastLine" -ForegroundColor Gray
    if ($lastLine -match "OK") {
        Write-Host ""
        Write-Host "==========================================="
        Write-Host "  ✓ インストール完了" -ForegroundColor Green
        Write-Host "  社員ID  : $LoginId"
        Write-Host "  端末ID  : $PcId"
        Write-Host "  サーバ  : $ApiUrl"
        Write-Host "==========================================="
        Write-Host ""
        Write-Host "次回PC再起動時から自動でPC起動時刻を送信します。"
    } else {
        Write-Host ""
        Write-Host "✗ サーバへの送信が失敗しています。" -ForegroundColor Red
        Write-Host "  Secret値・LoginId・ネットワーク接続を再確認してください。" -ForegroundColor Yellow
        Write-Host "  ログ全文: notepad $logFile" -ForegroundColor Gray
    }
} else {
    Write-Host "✗ ログファイルが生成されませんでした" -ForegroundColor Red
}
