# フォーク同期ガイド（catan ⇆ 100万石）

catan（オリジナル）と 100万石（戦国リスキン版）の間で、バグ修正・改善を双方向に
反映するための手順と記録。**catan を直す → 100万石へ持ってくる**（順方向）と、
**100万石の汎用改善 → catan へ還元する**（逆方向）の両方をここで管理する。

---

## 1. 関係（前提）

| | 上流 / オリジナル | 戦国リスキン版 |
|---|---|---|
| 通称 | catan（このリポジトリ） | 100万石 / 100man-goku |
| ブランチ | `main` | `art-pass/100man-goku` |
| worktree | `…/game/catan` | `…/game/100man-goku` |

- 両者は**同一 git リポジトリの worktree**（`.git` を共有）。100万石は catan を戦国テーマに
  リスキンしたもの。**分岐点 (merge-base) = `d156695`**（`feat(ai): elite…最長交易路ボーナス`）。
- リスキンで変えるのは**ユーザーに見える表示文字列のみ**。内部キー・enum・関数名・
  アセットのファイル名・テストのロジックは**両者で同一**。用語の唯一の正典は
  100万石側の `docs/reskin/GLOSSARY.md`（`art-pass/100man-goku` ブランチ /
  `…/game/100man-goku/docs/reskin/GLOSSARY.md`）。

---

## 2. なぜ `git cherry-pick` を使わないか

catan のコミットをそのまま cherry-pick すると、100万石側でリスキンした日本語の表示文字列を
**catan の語へ巻き戻して**しまう恐れがある（例: `石垣`→`城壁`、`天守`→`メトロポリス`）。
そのため同期は次の原則で**手作業**で行う:

> **ロジック・構造・数値はそのまま忠実に。表示文字列とコメントだけ §4 の対応表で変換。**

純粋なロジック修正（エンジン・スコアリング等）で表示文字列に触れないコミットは、ほぼ
そのまま適用できる。

---

## 3. 同期の手順

### 3a. 順方向（catan → 100万石）— バグ修正を取り込む
100万石の worktree で作業する。
```bash
cd …/game/100man-goku
# まだ取り込んでいない catan のコミット一覧（前回同期点以降だけ見るのが楽）
git log --oneline $(git merge-base main HEAD)..main
git log --oneline e4ac157..main          # ← §5 の「前回同期点」以降
git show <commit>                          # 各差分を確認
# → ロジックは忠実に、表示文字列は §4 で変換して手で反映（Edit）
npm run typecheck && npm test && npm run build   # 検証
```
- **cherry-pick は使わない。**
- コミットがリスキン済み文字列に触れていなければ、ほぼそのまま入る。

### 3b. 逆方向（100万石 → catan）— 汎用改善を還元
この catan の worktree で作業する。
```bash
cd …/game/100man-goku
git log --oneline $(git merge-base main HEAD)..HEAD   # 100万石独自コミット一覧
git show <commit>
```
- **対象外**: reskin（用語）・art（画像/アセット生成）・docs（リスキン文書）。catan に持ち込まない。
- **対象**: テーマ非依存の汎用バグ修正・レイアウト修正・エンジン修正のみ。
- catan へ移す際は逆に**戦国語 → catan 標準語**へ戻す（§4 を逆引き）。
- 候補が出たら §6 の表に追記しておくと、まとめて還元しやすい。

---

## 4. 用語対応表（catan ↔ 100万石・抜粋）

完全版は 100万石側の `docs/reskin/GLOSSARY.md`。下記はロジック移植で頻出のゲーム用語。

| 概念 | catan | 100万石（戦国） |
|---|---|---|
| 都市（建物） | 都市 | 城 |
| 開拓地 | 開拓地 | 砦 |
| メトロポリス | メトロポリス / メトロポリス門 | 天守 / 天守門 |
| 城壁 | 城壁 | 石垣 |
| 騎士 | 騎士 | 武将 |
| 拡張「騎士と商人」(C&K) | 騎士と商人 | 武将と商い |
| 交易路 / 最長交易路 | 交易路 / 最長交易路 | 街道 / 最長街道 |
| 蛮族 | 蛮族 | 一揆勢 |
| 盗賊 | 盗賊 | 野盗 |
| 商品 | 商品 | 物産 |
| 港 / 港辺 | 港 / 港辺 | 湊 / 湊辺 |
| 発展カード | 発展カード | 軍略カード |
| 資源: レンガ/羊毛/麦/鉱石 | レンガ/羊毛/麦/鉱石 | 石材/馬/米/鉄 |

> 内部識別子（`metropolis`, `selectWallCity`, `BUILD_CITY_WALL`, `'wood'` 等）・
> アセットキー（`ASSETS.*`）・enum は**両者で同一**。変換するのは表示文字列とコメントだけ。

---

## 5. 順方向同期ログ（catan → 100万石）

**前回同期点 = catan `main` @ `fdb88e7`**（航海者フルリビルド一式を 2026-07-03 に全面移植済み。次回は `fdb88e7..main` を見る）

| 日付 | catan 範囲 | 内容 | 状態 |
|---|---|---|---|
| 2026-06-25 | `d156695..e4ac157` | 演出同期・最長街道・湊表示・石垣の盤面選択・天守の城壁維持/可視化・図鑑/得点チップ・CPU速度「最速」・湊点線・通知コマンドWin化・アニメ表記簡素化 | ✅ 反映・検証済（typecheck / test 736/736 / build すべてpass） |
| 2026-07-01 | `e4ac157..main`（PR#7/#8/#9・航海者リビルド） | 航海者版フルリビルド（公式8シナリオ＋New World・37ヘックス）と**汎用エンジン新メカ**: 抜けている数値トークン（`Tile.pendingNumber`/`numberRemoved`/`numberTokenSupply`/`revealPendingNumbers`）・都市上限（`ScenarioRules.maxCities`）・地域ボーナス（`bonusRegionTiles`/`regionBonusVp`/`regionBonus`）・オアシスの道探索（`revealFogAround` を BUILD_ROAD へ・`startingRoads`/`noShips`）・霧探索（`explore.ts`）・海辺/財宝トークン（`seaTokens.ts`・`edgeTokens`/`treasure`）。表示文字列非依存の汎用ロジック。 | ⏳ **未反映**（リビルド一式とセットでのみ移植可＝下記注記） |
| 2026-07-01/02 | PR#10 `fix/seafarers-pr9-bugs`＋PR#11 `fix/seafarers-audit-followups`（いずれも main マージ済み） | 航海者リビルドのバグ修正群（全て汎用ロジック・表示文字列非依存）。PR#10=12件: 霧の資源地産出・CK金タイル産出（`applyGoldChoicePhase` 共通化）・`remainingCities=maxCities`・霧の数字制約・setup 中の財宝只取りガード・`noShips` 配線・地域ボーナス phase 非依存・財宝資源のバンク減算・`mainIslandTileIds` タイブレーク・フォールバック防御ほか。PR#11=監査5件: 本島↔霧境界の赤6/8隣接（`randomizeHomeAndFog`）・SETUP霧公開の只取り/二重取得（`grantReward`）・海賊コマの霧タイル初期配置（`!t.fog`）・`downgradeCity` の幻の開拓地・水道橋×金の二重付与。 | ⏳ **未反映**（対象コードがフォークに無いものが大半。船まわり2件のみ下記で先行反映済み） |
| 2026-07-02 | `e4ac157..main` の一部（船まわりバグ2件のみ先行） | **船移動の海賊封鎖ガード**（canMoveShip、canBuildShip と対称）＋**開放端判定を「自分の船のみ」に是正**（isOpenShipEnd。道↔船は建物経由でのみ連結）。フォークの現行コードに今すぐ当たるテーマ非依存バグのみ移植（コメント変更のみ・表示文字列不変）。テスト2件追加。 | ✅ 反映・検証済（typecheck / test **738**/738 / build pass）・**hyaku/main へ push＝100万石 本番デプロイ済み** |
| 2026-07-03 | `e4ac157..main` の一部（小粒3件・先行反映） | **①新島入植ボーナスをプレイヤー別配列化**（`islandBonus` を `Record<rep,PlayerId[]>` 化＝各プレイヤーが自分の初入植ごとに +2VP・他人が先でも可。catan `5de23f7`／game・islands・scoring・log・recap・ui・types 一括）／**②普請カード（＝街道建設カード）で船も無料配置**（道2/船2/道1+船1。catan `5de23f7`+`2e2f2aa`／actions・game・main・events。`citiesKnights` の `road_building_progress` は catan と同一で据え置き）／**③資源アニメの stagger 上限**（`MAX_STAGGER_TOTAL=2400`）**＋ウォッチドッグ固着解除**（大量産出時のCPU長時間停止を解消。catan `1bde138`／main.ts）。いずれもテーマ非依存・表示文字列不変（普請/城/砦 等のリスキン語は保持）。①②は修正前RED→修正後GREEN実証、③は catan 同様テスト無し（UI演出タイミング）。 | ✅ 反映・検証済（typecheck / test **744**/744 / build pass）・**hyaku/main へ push＝100万石 本番デプロイ済み**。fork commit `7983b5f`/`a312058`/`261fbba` |
| 2026-07-03 | `e4ac157..main`（PR#7〜#11・航海者フルリビルド一式） | **航海者フルリビルドを全面移植（水軍テーマ）**。engine5本追加（explore=霧探索/cloth=絹/wonders=名城/pirateIslands=海賊要塞・軍船/seaTokens=海辺トークン・財宝）＋`scenarios.ts` 全面刷新（公式8+New World+干ばつ/宝島/オセアニア/大いなる国/オアシス+C&K×水軍コンボ3本・表示名を「水軍：X」「武将と商い：X」「城と武将」へreskin）＋types拡張（ScenarioRules/fog/pendingNumber/numberTokenSupply/regionBonus/edgeTokens/wonder/fortress/playerHomeIslands/EdgeTokenKind/BUILD_WONDER/ATTACK_FORTRESS等）＋配線（createState/game/actions/ai/citiesKnights/robber/scoring/log/board/ui/main）＋テスト13本追加。**戦国名**: 航海者→水軍・七不思議→七名城・織物→絹・砂漠→荒野。内部ID/enum/座標/数値/ロジックは不変・既存の戦国アート/図鑑は保持。 | ✅ 反映・検証済（typecheck / **vitest 915**/915・46ファイル / build pass ＋**実機ブラウザ全22シナリオ描画エラー0**）・**hyaku/main へ push＝100万石 本番デプロイ済み**。fork commit（squash）`cf492f5`。※コメント/テストdescriptionの一部に catan 用語が残るが dev 向け・任意reskin（GLOSSARY §6） |

> **2026-07-03: 航海者フルリビルド一式（PR#7〜#11）を全面移植・本番反映済み**（上表最終行）。フォークは
> engine5本（explore/cloth/wonders/pirateIslands/seaTokens）を取得し、scenarios/types/配線/テストを catan 準拠へ。
> 戦国名（航海者→水軍・七不思議→七名城・織物→絹）を確定。**これでフォークは catan `fdb88e7` 時点のコードに追随済み**。
> 残タスク（任意・低優先）: コメント/テストdescription に残る catan 用語の戦国reskin（dev 向けのみ・ユーザー非表示）。

取り込んだコミット内訳:
- `ee5fa15` アニメON/OFF設定化 → 100万石は独自実装 `e12541e` が同一内容のため**既に反映済**。
  今回はラベル簡素化（`ON（常に表示）`→`ON`）のみ追従。
- `6f97ed1` 演出同期(CPU演出スキップ解消) / 最長街道は相手の建物のみで分断・武将では分断しない /
  湊のレート表示を海側へオフセット＋リーダー線 / 石垣は対象が2つ以上なら盤面で選択 /
  天守の石垣を可視化＆天守降格時も石垣維持 / 図鑑の天守画像・得点チップ統一 / アニメ表記簡素化。
- `2feaeba` 完了通知コマンドを Windows PowerShell 化。
- `e4ac157` CPU速度に「最速」追加（4段階）＋湊の点線を細く。

---

## 6. 逆方向同期候補（100万石 → catan）

分岐点 `d156695` 以降の 100万石独自コミット（15件）を精査した結果、
**catan へ還元すべき汎用修正は現時点で無し**（すべてリスキン / アート / 専用文書）。

| コミット | 種別 | catanへ | 備考 |
|---|---|:---:|---|
| `411552d` UIアイコン画像化 | art | no | 戦国PNG依存 |
| `ff513df` 図鑑表示/分国法背景/ダイス色 | art | no | 図鑑は100万石専用機能・色は戦国パレット |
| `de0c4f1` 透明化/濃色/湊アイコン/漢字題 | art | no | |
| `e12541e` アニメON/OFF | — | no | **catanに既存**（`ee5fa15`） |
| `e8cdbca` 戦国アート全差し替え | art | no | |
| `f6282a9` / `f16936a` アート仕様書 | docs | no | |
| `b3ef465` / `a6d3f5e` 軍略カード名 | reskin | no | |
| `59bd4fa` 検証記録 | docs | no | |
| `6e5033a` 用語クリーンアップ | reskin | no | |
| `f4b0072` / `48506b5` 用語リスキン | reskin | no | |
| `491f1dc` ゲーム名変更 | reskin | no | |
| `13e3f36` ベースライン/用語集 | docs | no | |

> 今後 100万石側で**テーマ非依存の修正**を入れたら、commit を分けてこの表に `yes`/`maybe` で
> 追記する。まとめて catan へ還元しやすくなる。

---

## 7. 運用メモ

- 100万石で汎用バグを直すときは、リスキン作業と commit を分ける（還元しやすくする）。
- catan 側を更新したら §5 の「前回同期点」を更新する。
- 用語で迷ったら必ず 100万石側の `docs/reskin/GLOSSARY.md` を正典とする。
- このファイルは catan / 100万石 の両 worktree に同じ内容で置いてある（どちらから見ても同じ）。
