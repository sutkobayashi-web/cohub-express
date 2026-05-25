# =====================================================
# CoWell ハートビート 5分おきPing
# =====================================================
# 設置: C:\ProgramData\CoWell\pc_heartbeat.ps1
# タスクスケジューラ "CoWell-PC-Heartbeat" にて 5分おきに実行。
# サーバ側で「最終Ping時刻」を保持 → 退勤時刻の自動推定に利用。
# (auto_punch_out=1 のユーザは AUTO_OUT_SILENCE_MIN 分以上Pingが無いと
#  最終Ping時刻でout打刻が自動生成される)
# =====================================================

# === 配布前にここを書き換える ===
$LoginId = "REPLACE_LOGIN_ID"
$PcId    = "REPLACE_PC_ID"
$Secret  = "REPLACE_SECRET"
$ApiUrl  = "https://cohub.biz-terrace.org/api/timecard/heartbeat"
# ===============================

$body = @{
    secret   = $Secret
    login_id = $LoginId
    pc_id    = $PcId
} | ConvertTo-Json -Compress

$logDir = "$env:ProgramData\CoWell"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "pc_heartbeat.log"

try {
    Invoke-RestMethod -Uri $ApiUrl -Method POST `
        -Body $body -ContentType "application/json" `
        -TimeoutSec 10 -ErrorAction Stop | Out-Null
    # 成功ログは100回に1回だけ (ノイズ抑制)
    if ((Get-Random -Maximum 100) -lt 1) {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tOK" | Out-File -FilePath $logFile -Append -Encoding utf8
    }
} catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tFAIL`t$($_.Exception.Message)" |
        Out-File -FilePath $logFile -Append -Encoding utf8
}

# 古いログを 60日でローテーション (簡易)
try {
    if ((Get-Item $logFile -ErrorAction SilentlyContinue).Length -gt 512KB) {
        $bak = Join-Path $logDir "pc_heartbeat.log.bak"
        Move-Item -Force -Path $logFile -Destination $bak
    }
} catch {}
