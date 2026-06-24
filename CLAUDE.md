
## 入力待ちまたはタスク完了時の通知
実行が完了するたびに、以下のコマンドで通知を出すこと（Windows）：
powershell -NoProfile -Command "[console]::beep(880,250); Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle='Claude Code'; $n.BalloonTipText='Waiting for your input'; $n.Visible=$true; $n.ShowBalloonTip(5000); Start-Sleep -Milliseconds 400; $n.Dispose()"

## フォーク同期（catan ⇆ 100万石）
catan（このリポジトリ）と 100万石（戦国リスキン版 / `art-pass/100man-goku`）は同一リポジトリの worktree。
catan のバグ修正を 100万石へ取り込む／100万石の汎用改善を catan へ還元する手順・
用語対応表・同期ログは **[SYNC.md](SYNC.md)** を参照。
