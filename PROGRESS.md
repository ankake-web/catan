# PROGRESS — カタン（航海者版＋交易と蛮族 実装中）（最終更新: 2026-07-05）

> Vite + TypeScript のブラウザ版カタン。リポジトリ: `ankake-web/catan`（origin）。
> 本番: https://ankake-web.github.io/catan/ （`.github/workflows/deploy.yml` が main への push で自動デプロイ）。
> 戦国リスキン版「**100万石**」は同一 git の別 worktree `…/game/100man-goku`（ブランチ `art-pass/100man-goku`）。100万石本番=**hyaku リモート**の main。
> **作業ルール（厳守）**: 変更は必ず `tsc`/`vitest`/`build` 緑を保つ。フィーチャーブランチ＋PRで進める。
> **main への直接push／PRのmainマージ／hyaku/main への push（いずれも本番デプロイ）は毎回ユーザの明示許可後**。
> 回答は日本語。完了/入力待ちごとに CLAUDE.md の beep+トースト通知を実行。

## 0. 現在の状態（2026-07-05）
- **いま作業中のテーマ = 交易と蛮族（Traders & Barbarians, T&B）拡張の新規実装**。
- **作業ブランチ `feat/traders-barbarians`（未push・未マージ＝本番未反映）**。ここに全T&B作業がある。
  - `33d1b2f` 確定仕様書追加 ／ `4d22d47` 増分1「強き港(Strongest Ports)」／ 増分2「親切な盗賊(The Friendly Robber)」実装済み。
  - このブランチで **vitest 981緑・typecheck緑・build緑**。
- **catan main**: `3ab026d`（== origin/main・vitest **950**緑）。T&B はまだ入っていない。
- **100万石(fork)**: `art-pass/100man-goku` @ `ccbd159`（==hyaku/main・vitest 917緑）。**今回未変更**。
- 検証コマンド: `npm run typecheck` / `npx vitest run` / `npm run build`。dev=`npm run dev`。

## 1. ゴール
1. （**進行中・最優先**）**交易と蛮族（T&B）を「本家ボードゲームへの完全忠実」で実装**。
   - 最重要方針: **記憶で数値・ルールを書かない**。全数値は公式ルールブックで確認し出典を付け、確認できない物は【要確認】。
   - **一次情報 = catan.com 公式英語ルールブック 第6版 CN3089（2025, rules v6.250701, 24p）**。ユーザ選択で**第6版がターゲット確定**（旧版とは名称・メカが異なる：キャラバン→Merchant Trains 等）。
   - 全数値を**データ定数化**し、**仕様値をテストで固定**。既存（基本/航海者/C&K）を壊さない。
   - **正の仕様書 = [docs/交易と蛮族_仕様書_v6.md](docs/交易と蛮族_仕様書_v6.md)**（4変種＋5シナリオ・出典ページ付き・図版確定済み）。
2. （完了・維持）航海者版を公式準拠で完成＋100万石へ順方向同期（SYNC.md／GLOSSARY.md が正）。

## 2. 完了したこと（新しい順）
- **2026-07-05 T&B セッション2（本ブランチ）**:
  - **増分2「The Friendly Robber（親切な盗賊）」変種**（CN3089 p3・原文をPDFから再確認して実装）: 公開VP2以下のプレイヤーの建物ヘックスへ盗賊移動不可／合法ヘックスなしなら砂漠へ（既に砂漠なら留まる）／強奪は2VP超のみ。`getRobberMoveTargets`/`isFriendlyRobberProtected`（robber.ts）に一元化し、game.ts(MOVE_ROBBER)・ai.ts・lanCpu.ts・main.ts(ハイライト/ウォッチドッグ)・events.ts(クリック/強奪対象) の全経路へ配線。シナリオ `tb_friendly_robber`（基本盤・10点）。テスト20件で仕様固定（計981緑）。実装解釈は仕様書§2-1に追記。ウルトラコード多角レビュー（4視点＋指摘ごとに3人反証・変異実験）で実装バグ0件を確認し、変異に耐えるようテスト3箇所を強化。
- **2026-07-05 T&B セッション1（本ブランチ）**:
  - **フェーズ0（コード把握）**: シナリオはデータ駆動（`scenarios.ts` の `Scenario`＝coords()+build()+`ScenarioRules`+victoryTarget）。base/航海者は `category`＋海タイル有無で区別、C&K だけ `expansion` フラグ。特殊VPは `scoring.ts` `calcVP`/`calcPublicVP` に項追加＋`update*` 関数（最長道路/最大騎士団が雛形）。
  - **フェーズ1（仕様抽出）**: 公式PDFを精読。テキスト抽出で拾えなかった**図版（橋コスト/盤配置/数字ディスク/湖/荷馬車ボード）を、PDFをPNGレンダリングして直接視認し確定**。主要な【要確認】をほぼ全て解決（下記§3）。docs に確定仕様書を作成。
  - **フェーズ2（実装）増分1**: **T&B新カテゴリ `traders_barbarians`＋「強き港(Strongest Ports)」変種**を実装。港上の建物VP合計(開拓地1/都市2)最多(最低3VP)に+2VPタイル、同点は現保持者優先・strictly上回りで移動（最大騎士団と同型）。シナリオ `tb_harbors`（基本盤・11点）。テスト9件で数値固定。全960緑。
- **〜2026-07-04（main 反映済み）**: 航海者版フルリビルド（公式8＋NW＋追加盤＋C&K複合＋オアシス・表示22シナリオ）／脱走兵の設置先選択UI／オセアニア盤再設計。100万石へ全移植。詳細は git log と過去の PROGRESS（`git log -- PROGRESS.md`）、メモリ2件。

## 3. 決定事項とその理由
- **ターゲットは第6版(2025, CN3089)**（ユーザ選択）。catan.com 現行公式＝一次情報。旧版とは以下が違う（記憶で書くと事故る）：
  - キャラバン(The Caravans) → **Merchant Trains of Catan**（荷馬車を投票配置、隊列に挟まれた建物+1VP）。
  - Harbor Master → **Harbors of Catan / Strongest Ports**。表題シナリオもコモディティ拠点＋荷馬車配達に再設計。
- **図版から確定した数値**（公式PDFをPNG視認・出典は仕様書§6）:
  - 橋の建設コスト=**レンガ2＋木1**（0VP・最長交易路算入）。
  - Fishing: **湖=2/3/11/12**・**漁場6枚=4/5/6/8/9/10**（各タイル印刷）。fish 29(1×11/2×10/3×8)＋ぼろ靴1。fish消費 2/3/4/5/7。上限7。勝利10(bootで11)。
  - 荷馬車ボード: レベル1-5で **MP=4/5/6/7/7**・**商品価値=1/2/3/4/5**・**駆逐ダイス範囲=Lv1不可/Lv2:6/Lv3:5-6/Lv4:4-6/Lv5:3-6**・**4段強化で+1VP**・1段目コスト=木1羊毛1鉱石1。
  - Barbarian Attack: 城=左下/砂漠=右上の**固定数字レイアウト**（仕様書§6.4）・11ディスクは1枚・蛮族は2と12のヘックスに開始。専用発展26(Capture4/Knighthood14/SwiftKnight4/Treason4)。
  - Traders&Barbarians: 拠点3(採石場/ガラス工房/城)＋Xマーカー9＋蛮族3を図示配置・数字は2/12省き拠点スキップ。専用発展25(Knight16/RoadBuilding3/SwiftJourney3/VP3)。目標13。
  - Merchant Trains: 水場=盤中央・数字なし。荷馬車22。目標12。
  - 各シナリオ勝利目標: Fishing10 / Rivers10 / MerchantTrains12 / Barbarian12 / T&B13 / Harbors(基本+1=11)。
- **Strongest Ports は「movable bonus」パターンで実装**（最長道路/最大騎士団と同型）＝`updateStrongestPorts`＋`GameState.strongestPortsHolder`＋`calcVP` に+2項。ScenarioRules `strongestPorts` フラグで有効化。
- **実装はデータ駆動＋テストで数値固定**が原則。変種/シナリオは既存 `classic` 盤や `ScenarioRules` トグルへ薄く乗せる。

## 4. 未完了タスク（優先順位順・次セッションはここから）
> すべて [docs/交易と蛮族_仕様書_v6.md](docs/交易と蛮族_仕様書_v6.md) をデータ化＋テスト固定していく。各増分ごとに `tsc`/`vitest`/`build` 緑・区切りコミット。
1. **増分3：残りの変種を実装**。次=**Catan Event Cards**（§2-3・ダイス→イベントデッキ置換。36枚の数字分布が残存【要確認】＝実装時に公式PDF p5-6 のカード面を要読）、次いで **Catan for Two**（§2-4・2人＋中立プレイヤー）。
2. **増分4以降：5シナリオ**（Fishing→Rivers→Merchant Trains→Barbarian Attack→Traders & Barbarians）。
   - **Fishing on Catan**（§3-1）は最初の完全シナリオだが**要設計**: 湖が**4数字**で産出＝現 `Tile.number:number|null`（単一）を拡張要／漁場は盤ヘックスでなく**フレーム上の産出源**＝新しい盤フィーチャー／fishトークン経済（秘匿・上限7・ぼろ靴・消費アクション）。
   - Rivers=川タイル(3+4hex)＋沼＋橋(新建物)＋コイン＋最富豪/極貧。Barbarian/T&B=騎士・蛮族・専用デッキ・荷馬車で最も重い。
3. **残存【要確認】（軽微・データ定数で1行修正可）**: 荷馬車アップグレードの**木の本数(Lv3-5)**（暫定「木2」で実装可）／Event Cards の**36枚の生産数字分布**（Event Cards実装時に §p5-6 を要読）。
4. **完了後**: ユーザ許可を得て feature ブランチを push→PR→（許可後）main マージ→本番。その後 100万石(fork)へ SYNC.md §3 手順で戦国語化移植。

## 5. 詰まっている点・注意点・保留中の判断
- **本ブランチは未push**。T&B作業は `feat/traders-barbarians` にしか無い。新セッションは**必ずこのブランチをチェックアウト**してから作業する。
- **デプロイ権限**: main への push／PRマージ／hyaku/main への push は**毎回ユーザの明示許可**。自作PRの即マージは安全ガードで止まる＝正常。
- **公式PDFと再レンダリング環境**（`scratchpad` はセッション固有で消えうる）:
  - PDF URL: `https://www.catan.com/sites/default/files/2025-04/CN3089%20CATAN%20%E2%80%93%20T&B%20Rulebook.pdf`（ローカルにも `C:\Users\b1242\Downloads\CATAN_交易と蛮族_第6版_CN3089.pdf`）。
  - テキスト抽出=`/mingw64/bin/pdftotext -layout`（散文は raw の方が綺麗）。**画像レンダラは未導入**→ scratchpad で `npm i pdfjs-dist@^4 @napi-rs/canvas` して `render.mjs`/`crop.mjs`（**clip の undefined を吸収するパッチ必須・スケールは≤10**。14はskia確保失敗）。ページ1/19/24はSMaskで描画失敗するが重要図版なし。
  - **PDFのページ番号と印刷ページ番号がズレる箇所あり**（例: PDF8=印刷8だがCatan for Two、Fishingは印刷9-10=PDF9-10）。仕様書の出典は印刷ページ。
- **`scenarios.test.ts` は「表示シナリオ集合」を厳密に固定**＝**可視シナリオを1つ追加するたびにこのテストの配列を更新**する（今回 tb_harbors で更新済み）。
- **網羅Recordが多い**: `SCENARIOS`/`SCENARIO_RULES`（Record<ScenarioId>）、`TILE_COUNTS`/`TILE_RESOURCE_MAP`/`TILE_COMMODITY_MAP`（Record<TileType>）、`category` union（`scenarios.ts`×2＋`scenarioSelect.ts`）。id/tile/category を足すと全部直さないと tsc が通らない（＝抜け漏れ検知になる）。
- **vitest が稀に ESM ローダで一時クラッシュ(exit 134)**: 失敗ではない。再実行で緑。
- 参考メモリ: `seafarers-pr9-known-bugs` / `seafarers-official-rebuild`。フォーク同期は SYNC.md／100万石 `docs/reskin/GLOSSARY.md`。

## 過去ログ（要約）
- 2026-07-05: T&B 仕様確定（公式PDF図版をPNG視認）＋増分1「強き港」＋増分2「親切な盗賊」実装（feat/traders-barbarians・未push）。
- 2026-07-04: 航海者フルリビルドのフォーク全移植／脱走兵UI／オセアニア再設計（catan PR#14-17・fork→hyaku/main）。
- 2026-06-28〜07-03: 公式準拠リビルド（S1〜S8＋NW）→敵対レビュー→ultracode監査→docs整理。
