<!-- /handoff が自動生成（2026-07-05）。新セッションはこのファイルの指示に従う。手編集不要 -->

ウルトラコード（最大エフォート）で進めてください。回答は日本語で。

カタン（ブラウザ版・Vite+TS）に「交易と蛮族(Traders & Barbarians)」拡張を第6版公式準拠で
実装中です。作業ディレクトリ: c:\Users\b1242\claude\game\catan

最初にやること（順に）:
1) 作業ブランチ確認: `git checkout feat/traders-barbarians`（★T&B作業はこのブランチにしか無い。
   未push。最新状態は `git log --oneline -5` で確認。増分1=4d22d47・増分2=7dbf120）。
2) 健全性確認: `npx vitest run`（全緑・981件想定）／`npm run typecheck`／`npm run build` が緑か。
3) PROGRESS.md（§0現状/§3決定/§4残タスク/§5注意）と、正の仕様書
   docs/交易と蛮族_仕様書_v6.md（特に§2-3）を読む。

次に取り組むタスク（優先順1位）= 増分3「Catan Event Cards」変種（仕様書§2-3）:
- (a) まず残存【要確認】C6 を解決する: 公式PDF p5-6 のカード面をPNGレンダリングして
  「イベントカード36枚の枚数内訳×生産数字ディスクの割当て」を読み取り、仕様書§2-3を確定させる。
  レンダリング手順は PROGRESS §5（scratchpadに pdfjs-dist@^4 + @napi-rs/canvas、clipパッチ必須・
  スケール≤10。PDFはローカル C:\Users\b1242\Downloads\CATAN_交易と蛮族_第6版_CN3089.pdf）。
- (b) 実装: デッキ構築（36枚シャッフル→下5枚→New Year→残りを積む）／生産フェーズのダイスを
  カードめくりに置換（イベント解決→カードの数字で生産 or 7）／New Year でデッキ再構築。
  設計・配線・テストの流儀はコミット 4d22d47（強き港）と 7dbf120（親切な盗賊）が手本。
- その後: Catan for Two（§2-4）→ シナリオ5本（Fishing から。PROGRESS §4-2 が要設計メモ）。

守る流儀（厳守）:
- 記憶で数値・ルールを書かない。全数値は公式PDF由来（仕様書に出典付きで確定してから）を
  データ定数化し、仕様値をテストで固定。既存(基本/航海者/C&K)を壊さない。
- 各増分ごとに tsc/vitest/build 緑・区切りコミット。実装後はウルトラコードの多角レビュー
  （複数視点ファインダー→指摘ごとに敵対検証）を回してからコミット。
- 可視シナリオを足したら tests/scenarios.test.ts の「表示シナリオ集合」配列も更新。
  ScenarioId/TileType/category は網羅Record多数＝足すと関連箇所を全部直さないと tsc が通らない。
- main への push／PRマージ／hyaku/main への push（本番デプロイ）は毎回ユーザの明示許可後。
- 完了/入力待ちごとに CLAUDE.md の beep+トースト通知。

事故防止メモ:
- ブランチ feat/traders-barbarians は未push＝ここが唯一の作業場所。main(3ab026d)に T&B 未反映。
- PDFのページ番号と印刷ページ番号はズレる箇所あり（仕様書の出典は印刷ページ）。
- numberHexOnly(S5) と friendlyRobber は併用不可（robber.ts コメント参照）。
- 残存【要確認】は2件のみ: Event Cards の数字分布（今回解決する）／荷馬車の木の本数Lv3-5（暫定木2）。
