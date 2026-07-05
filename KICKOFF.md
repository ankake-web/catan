<!-- /handoff が自動生成（2026-07-05）。新セッションはこのファイルの指示に従う。手編集不要 -->

ウルトラコード（最大エフォート）で進めてください。回答は日本語で。

カタン（ブラウザ版・Vite+TS）に「交易と蛮族(Traders & Barbarians)」拡張を第6版公式準拠で
実装中です。作業ディレクトリ: c:\Users\b1242\claude\game\catan

最初にやること（順に）:
1) 作業ブランチ確認: `git checkout feat/traders-barbarians`（★T&B作業はこのブランチにしか無い。
   未push。最新状態は `git log --oneline -5` で確認。変種3本=増分1〜3コミット済み・作業ツリーはクリーン）。
2) 健全性確認: `npx vitest run`（全緑・1039件想定）／`npm run typecheck`／`npm run build` が緑か。
3) PROGRESS.md（§0現状/§3決定/§4残タスク/§5注意）と、正の仕様書
   docs/交易と蛮族_仕様書_v6.md（特に§2-4）を読む。

次に取り組むタスク（優先順1位）= 増分4「Catan for Two（2人用）」（仕様書§2-4）:
- 要点: trade token 20＋中立プレイヤー2人／可変セットアップで各中立に開拓地1（図示位置）／
  生産フェーズ×2回（2回目は1回目と別出目まで振り直し）／建設のたび中立の道・開拓地も無償配置／
  trade token 経済（Forced Trade / Move Robber）。Event Cards と併用可（CONFLICT等に中立特則）。
- 要設計: 中立プレイヤーの扱い（playerOrderに入れるか別枠か）・2人戦専用の状態。詳細は PROGRESS §4-1。
- 設計・配線・テストの流儀はコミット 4d22d47（強き港）・7dbf120（親切な盗賊）・c411a96（イベントカード）が手本。
- その後: シナリオ5本（Fishing から。PROGRESS §4-2 が要設計メモ）。

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
- 公式PDF: ローカル C:\Users\b1242\Downloads\CATAN_交易と蛮族_第6版_CN3089.pdf。ページ番号と
  印刷ページ番号はズレる箇所あり（仕様書の出典は印刷ページ）。図版再確認の手順は PROGRESS §5。
- numberHexOnly(S5) と friendlyRobber は併用不可（robber.ts コメント参照）。
- Event Cards は非C&K専用実装（ROLL_DICE の tbEventCards 分岐が isCk より前で早期return。C&K併用特則は未実装）。
- 残存【要確認】は1件のみ: 荷馬車アップグレードの木の本数Lv3-5（暫定木2で実装可）。
- 増分3のウルトラコードレビューは verify がセッション上限で走らず自己裁定済み（詳細 PROGRESS §5）。
