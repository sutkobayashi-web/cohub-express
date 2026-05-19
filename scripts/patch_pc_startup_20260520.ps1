# =====================================================
# CoWell PC起動通知 スクリプト緊急パッチ (2026-05-20)
# =====================================================
# 既に展開済みの C:\ProgramData\CoWell\pc_startup.ps1 を、
# LastBootUpTime ベース → Get-Date ベースに in-place で書き換える。
# Fast Startup 環境で「電源ON時刻が前日や数日前になる」不具合の修正。
#
# 使い方:
#   PowerShell を「管理者として実行」で開いて
#       .\patch_pc_startup_20260520.ps1
#   を実行するだけ。LoginId/PcId/Secret は既存ファイルから保持される。
#
# 動作確認:
#   Start-ScheduledTask -TaskName "CoWell-PC-Startup"
#   Start-Sleep -Seconds 3
#   notepad C:\ProgramData\CoWell\pc_startup.log  ← 末行が OK で現在時刻に近いこと
# =====================================================

$target = "$env:ProgramData\CoWell\pc_startup.ps1"

if (-not (Test-Path $target)) {
    Write-Host "✗ $target が見つかりません (未インストール)" -ForegroundColor Red
    exit 1
}

# 旧パターンを検出
$content = Get-Content -Raw -Encoding utf8 $target
if ($content -notmatch 'LastBootUpTime') {
    Write-Host "ℹ️ 既にパッチ済みのようです (LastBootUpTime の参照なし)" -ForegroundColor Yellow
    exit 0
}

# バックアップ
$bak = $target + ".bak.20260520"
Copy-Item -Force -Path $target -Destination $bak
Write-Host "✓ バックアップ: $bak" -ForegroundColor Green

# 旧 try/catch ブロック (LastBootUpTime取得) を、シンプルな Get-Date 1行に置換
# 旧ブロック: "# Windows 起動時刻 ... } catch { ... }" の塊
$oldBlock = @'
# Windows 起動時刻 (LastBootUpTime) を取得して送信。スクリプト実行時刻ではなく PC が立ち上がった時刻を使う。
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $bootTime = $os.LastBootUpTime
    $startedAt = $bootTime.ToString('yyyy-MM-dd HH:mm:ss')
} catch {
    # 取得できない場合は現在時刻
    $startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
'@

$newBlock = @'
# ログオン時刻 (= スクリプト実行時刻) を送信。
# 旧版 LastBootUpTime は Fast Startup 環境で更新されず数日前の値が返るため、
# Get-Date ベースに変更 (2026-05-20 緊急パッチ)。
$startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
'@

# CRLF差を無視できるよう改行を正規化してから置換
$normalized = $content -replace "`r`n", "`n"
$oldBlockN  = $oldBlock -replace "`r`n", "`n"
$newBlockN  = $newBlock -replace "`r`n", "`n"

if ($normalized -notmatch [regex]::Escape($oldBlockN)) {
    Write-Host "⚠️ 想定パターンに一致しませんでした。ファイルをカスタマイズしている可能性があります。" -ForegroundColor Yellow
    Write-Host "   手動で当該ブロックを以下に置き換えてください:" -ForegroundColor Yellow
    Write-Host $newBlock
    exit 2
}

$patched = ($normalized -replace [regex]::Escape($oldBlockN), $newBlockN) -replace "`n", "`r`n"
$patched | Out-File -FilePath $target -Encoding utf8 -Force
Write-Host "✓ パッチ適用: $target" -ForegroundColor Green

# 動作確認
Write-Host ""
Write-Host "▶ 動作確認のためタスクを即実行します..." -ForegroundColor Cyan
try {
    Start-ScheduledTask -TaskName "CoWell-PC-Startup" -ErrorAction Stop
    Start-Sleep -Seconds 3
    $logFile = "$env:ProgramData\CoWell\pc_startup.log"
    if (Test-Path $logFile) {
        $last = Get-Content $logFile -Tail 1
        Write-Host "ログ最終行: $last"
        if ($last -match "OK") {
            Write-Host "✓ パッチ適用後の送信に成功しました" -ForegroundColor Green
        } else {
            Write-Host "✗ 送信失敗。ネットワークやSecretを確認してください" -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "タスク実行不可: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  完了。次回ログオン時から正常に記録されます"
Write-Host "==========================================="
