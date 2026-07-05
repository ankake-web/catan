<!-- /handoff が自動生成（2026-07-05 その4）。新セッションはこのファイルの指示に従う。手編集不要 -->

ウルトラコード（最大エフォート）で進めてください。回答は日本語で。

カタン（ブラウザ版・Vite+TS）に「交易と蛮族(Traders & Barbarians)」拡張を第6版公式準拠で
実装中です。作業ディレクトリ: c:\Users\b1242\claude\game\catan

最初にやること（順に）:
1) 作業ブランチ確認: `git checkout feat/traders-barbarians`（★T&B作業はこのブランチにしか無い。
   未push。最新は `bae493e`（増分4 Catan for Two）。`git log --oneline -6` で確認。作業ツリーはクリーン）。
2) 健全性確認: `npx vitest run`（全緑・1075件想定）／`npm run typecheck`／`npm run build` が緑か。
3) PROGRESS.md（§0現状/§2完了/§3決定/§4残タスク/§5注意）と、正の仕様書
   docs/交易と蛮族_仕様書_v6.md を読む。

次に取り組むタスク（優先順1位）= 増分5「シナリオ」の1本目 = **Fishing on Catan（漁師）**（仕様書§3-1）:
- 要点/要設計（PROGRESS §4-2 も参照）:
  - 湖(lake)が**4つの数字**で産出＝現 `Tile.number:number|null`（単一）を拡張要（複数数字を持てるように）。
  - 漁場(fishing ground)は盤ヘックスでなく**フレーム上の産出源**＝新しい盤フィーチャー。
  - fish token 経済（秘匿・上限7・ぼろ靴(old boot)・複数の消費アクション）。fish 29枚（魚1×11/魚2×10/魚3×8）。
  - 盗賊を湖に置くと湖の4数字すべての生産を封鎖／漁場には置けない。勝利10（old boot 保持時11）。
- 変種3本＋Catan for Two（増分1〜4）が手本。設計・配線・テストの流儀はコミット
  4d22d47（強き港）・7dbf120（親切な盗賊）・c411a96（イベントカード）・bae493e（Catan for Two）を参照。
- シナリオ順: Fishing→Rivers→Merchant Trains→Barbarian Attack→Traders & Barbarians（最後の2つが最重）。

守る流儀（厳守）:
- 記憶で数値・ルールを書かない。全数値は公式PDF由来（仕様書に出典付きで確定してから）を
  データ定数化し、仕様値をテストで固定。既存(基本/航海者/C&K/T&B変種4本)を壊さない。
- 各増分ごとに tsc/vitest/build 緑・区切りコミット。実装後はウルトラコードの多角レビュー
  （複数視点ファインダー→指摘ごとに敵対検証）を回し、確定指摘を修正＋変異注入で実証してからコミット。
- 可視シナリオを足したら tests/scenarios.test.ts の「表示シナリオ集合」配列を更新。
  ScenarioId/TileType/category は網羅Record多数＝足すと関連箇所を全部直さないと tsc が通らない。
- Catan for Two は実プレイヤー2人専用（3人以上を回すテストは SPECS を2人に）。
  scenarios_smoke は `specsFor()` でシナリオ別に人数を切替済み。
- main への push／PRマージ／hyaku/main への push（本番デプロイ）は毎回ユーザの明示許可後。
- 完了/入力待ちごとに CLAUDE.md の beep+トースト通知。

事故防止メモ:
- ブランチ feat/traders-barbarians は未push＝ここが唯一の作業場所。main(3ab026d)に T&B 未反映。
- 公式PDF: ローカル C:\Users\b1242\Downloads\CATAN_交易と蛮族_第6版_CN3089.pdf。PDFページ番号と
  印刷ページ番号はズレる箇所あり（仕様書の出典は印刷ページ）。図版はPNGレンダリング→格子フィットで視認
  （scratchpad で pdfjs-dist+@napi-rs/canvas。render.mjs/crop.mjs。増分4で使った手順が scratchpad/pdf に残るが
   セッション固有で消えうる＝再セットアップ手順は PROGRESS §5）。
- numberHexOnly(S5) と friendlyRobber は併用不可（robber.ts コメント参照）。
- Catan for Two の中立は `type:'neutral'`・playerOrder 外。生産は中立を除外する（dice.ts）。詳細 PROGRESS §5。
- Event Cards は非C&K専用（ROLL_DICE の tbEventCards 分岐が isCk より前で早期return）。
- 残存【要確認】は1件のみ: 荷馬車アップグレードの木の本数Lv3-5（暫定木2で実装可）。
