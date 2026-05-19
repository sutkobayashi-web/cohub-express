# =====================================================
# CoWell ログオン時刻 通知スクリプト
# =====================================================
# 設置: C:\ProgramData\CoWell\pc_startup.ps1
# タスクスケジューラ "CoWell-PC-Startup" にてユーザーログオン時に実行。
# このスクリプトは CoWell サーバの /api/timecard/pc-startup に POST し、
# Windows へのログオン時刻 (= スクリプト実行時刻) を記録する。
# (旧版は LastBootUpTime を使用していたが Fast Startup 環境で不正値が
#  返るため 2026-05-20 に Get-Date ベースへ変更)
#
# 端末固定運用前提: 各PCに以下を設定して配布する。
#   $LoginId  : このPCに紐付く社員のログインID
#   $PcId     : 任意のPC識別子 (例 営業所略号+番号 "HQ-01")
#   $Secret   : サーバ側 PC_STARTUP_SECRET と一致させる
#   $ApiUrl   : 本番サーバの URL
#
# 通信失敗時はサイレントに終了 (ユーザーには通知しない)。
# 1日1回のみ送信したい場合は dedupe ロジックがサーバ側にあるためこのまま実行で OK。
# =====================================================

# === 配布前にここを書き換える ===
$LoginId = "REPLACE_LOGIN_ID"
$PcId    = "REPLACE_PC_ID"
$Secret  = "REPLACE_SECRET"
$ApiUrl  = "https://cohub.biz-terrace.org/api/timecard/pc-startup"
# ===============================

# ログオン時刻 (= スクリプト実行時刻) を送信。
# 旧版は Win32_OperatingSystem.LastBootUpTime を使っていたが、Windows 11/10 の
# 「高速スタートアップ (Fast Startup)」有効環境では、シャットダウン→起動でも
# LastBootUpTime が更新されない (前回フルブート時刻が残る) ため、数日前の値が
# 送られて表示が「不安定」になる事故が発生 (2026-05-20)。
# タスクスケジューラのトリガーが「ユーザーログオン時 + 30秒遅延」なので、
# 実行時刻 ≒ ログオン時刻 ≒ 業務開始時刻 として扱える。
$startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

$body = @{
    secret     = $Secret
    login_id   = $LoginId
    pc_id      = $PcId
    started_at = $startedAt
} | ConvertTo-Json -Compress

# ログ出力 (任意・トラブル時の確認用)
$logDir = "$env:ProgramData\CoWell"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "pc_startup.log"

try {
    $resp = Invoke-RestMethod -Uri $ApiUrl -Method POST `
        -Body $body -ContentType "application/json" `
        -TimeoutSec 15 -ErrorAction Stop
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tOK`tboot=$startedAt`tid=$($resp.id)" |
        Out-File -FilePath $logFile -Append -Encoding utf8
} catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tFAIL`tboot=$startedAt`t$($_.Exception.Message)" |
        Out-File -FilePath $logFile -Append -Encoding utf8
}

# 古いログを 60日でローテーション (簡易)
try {
    if ((Get-Item $logFile -ErrorAction SilentlyContinue).Length -gt 1MB) {
        $bak = Join-Path $logDir "pc_startup.log.bak"
        Move-Item -Force -Path $logFile -Destination $bak
    }
} catch {}
