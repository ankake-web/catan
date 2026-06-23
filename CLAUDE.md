
## 入力待ちまたはタスク完了時の通知
実行が完了するたびに、以下のコマンドで通知を出すこと（Windows）：
powershell -NoProfile -Command "[console]::beep(880,250); Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle='Claude Code'; $n.BalloonTipText='Waiting for your input'; $n.Visible=$true; $n.ShowBalloonTip(5000); Start-Sleep -Milliseconds 400; $n.Dispose()"
