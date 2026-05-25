# =====================================================
# CoHub ログイン時自動オープン インストーラ
# =====================================================
# 各PCで PowerShell (管理者権限不要) で実行:
#   iex (irm https://cohub.biz-terrace.org/setup/install-autoopen.ps1)
#
# 何が起きるか:
#   1. Windowsスタートアップフォルダに CoHub.url を作成
#   2. 次回ログオンから既定ブラウザで https://cohub.biz-terrace.org/ が自動オープン
#   3. 即時動作確認のためログインユーザーで1回開く
# 解除したい場合:
#   shell:startup を開いて CoHub.url を削除
# =====================================================

$Url = "https://cohub.biz-terrace.org/"
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir "CoHub.url"

# .url ファイルは [InternetShortcut] セクション + URL= 行のテキスト形式
@"
[InternetShortcut]
URL=$Url
IconIndex=0
"@ | Out-File -FilePath $shortcutPath -Encoding ASCII -Force

if (Test-Path $shortcutPath) {
    Write-Host "✓ スタートアップに登録: $shortcutPath" -ForegroundColor Green
} else {
    Write-Host "✗ ショートカット作成失敗" -ForegroundColor Red
    return
}

# 即時動作確認 (デフォルトブラウザで開く)
Write-Host "▶ 動作確認のため今ブラウザを開きます..." -ForegroundColor Cyan
Start-Process $Url

Write-Host ""
Write-Host "==========================================="
Write-Host "  ✓ 自動オープン設定完了"
Write-Host "  次回PCログオン時から CoHub が自動的に開きます"
Write-Host ""
Write-Host "  解除したい場合:"
Write-Host "    [Win+R] → shell:startup → CoHub.url を削除"
Write-Host "==========================================="
