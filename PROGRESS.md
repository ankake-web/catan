# PROGRESS — カタン（航海者版＋交易と蛮族 実装中）（最終更新: 2026-07-05 その3）

> Vite + TypeScript のブラウザ版カタン。リポジトリ: `ankake-web/catan`（origin）。
> 本番: https://ankake-web.github.io/catan/ （`.github/workflows/deploy.yml` が main への push で自動デプロイ）。
> 戦国リスキン版「**100万石**」は同一 git の別 worktree `…/game/100man-goku`（ブランチ `art-pass/100man-goku`）。100万石本番=**hyaku リモート**の main。
> **作業ルール（厳守）**: 変更は必ず `tsc`/`vitest`/`build` 緑を保つ。フィーチャーブランチ＋PRで進める。
> **main への直接push／PRのmainマージ／hyaku/main への push（いずれも本番デプロイ）は毎回ユーザの明示許可後**。
> 回答は日本語。完了/入力待ちごとに CLAUDE.md の beep+トースト通知を実行。

## 0. 現在の状態（2026-07-05 その3）
- **いま作業中のテーマ = 交易と蛮族（Traders & Barbarians, T&B）拡張の新規実装**。
- **作業ブランチ `feat/traders-barbarians`（未push・未マージ＝本番未反映）**。ここに全T&B作業がある。
  - `33d1b2f` 確定仕様書 ／ `4d22d47` 増分1「強き港(Strongest Ports)」 ／ `7dbf120` 増分2「親切な盗賊(The Friendly Robber)」 ／ `c411a96` 増分3「イベントカード(Catan Event Cards)」＝**変種3本コミット済み**。
  - その後同ブランチに: `0b02810` オアシス/オセアニア盤の写真準拠リビルド ／ `e28c533`+`886e176` UI/UX改善（船コスト表示・道/船と盗賊/海賊の選択UI・進歩カード獲得通知 等）／ `ba940c2` クレーンのメトロポリス都市手動選択。
  - このブランチで **vitest 1039緑・typecheck緑・build緑**・作業ツリーはクリーン（全部コミット済み）。
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
- **2026-07-05 UI/UXセッション（ユーザのテストプレイ指摘・`e28c533`/`886e176`/`ba940c2`）**:
  - **船の建設ボタン**を道と同形式（コマ画像＋🌲🐑コストアイコン）に統一（コスト非表示は船だけだった）。
  - **街道建設カード使用中に「🚢船を置く」ボタン**（航海者: 道2/船2/道1+船1。エンジン/盤面は対応済みでUIボタンだけ欠落していた）。案内文も「道でも船でもOK」に。
  - **海岸の辺（道も船も置ける）はタップ時にその場で[🛤道][🚢船]を選ばせる**（UIPhase `edgePieceChoice`＋`placeEdgeSmart`。従来はタップ位置の近い方で自動決定＝意図しない方が置かれた）。片方しか置けない辺・船モード明示時は従来どおり即配置。
  - **盗賊も海賊も動かせる盤では、先に[🦹盗賊][🏴‍☠️海賊]を選ぶバー**（main.ts `robberPiece`/`updateRobberPieceBar`・選ぶまで盤面を光らせずタップ無視・切替可・ROBBERフェーズ外で自動リセット。片方しか動かせない盤は従来どおり）。
  - **進歩カード獲得の全体通知**「🎴○○がカードを手に入れた」（種類は秘匿・全経路＝色イベント/撃退同点/スパイ対応・蛮族全画面演出が消えてから表示。従来は最新ログ1行が資源ログで即上書きされ見えなかった）。
  - **クレーン（進歩カード）でLv4到達時、メトロポリス化する都市を手動選択**できるように（`ba940c2`）。
  - テスト: `place_choice_ui.test.ts`(5件)・`ship_build_ui.test.ts`(2件) 追加。全**1039緑**・実機スモーク（Playwright: 起動→CPU戦開始→盤面描画）エラー0。
- **2026-07-05 オアシス/オセアニア盤の写真準拠リビルド（ユーザのテストプレイ指摘）**:
  - **オアシス全面再構築**（photo/オアシス IMG_6410 を格子フィットで実測。赤トークン4個をアンカーに dx=73.6/dy=84 を厳密フィット→六角形輪郭オーバーレイで全セル転記）: 右上の島（資源10＋連なる砂漠6・案山子=盗賊初期位置 '4,-1' 固定）＋左下の島（資源7＋砂漠5）＋霧24（左上10＋中央帯14）＝52セル＋海リング（`coordsWithSeaRing`）。財宝は写真の交差点7箇所→最寄りの辺トークンで固定配置。港=本物の海岸線のみ最大9（霧の岸は除外＝晴れると内陸になるため randomHarbors に恒久ガード追加）。資源は島内シャッフル・砂漠帯は固定（`randomizeLandMapCore` にグループ指定）。初期配置は両島OK（setupAnywhere）。
  - **宝箱アイコン**: 辺トークンの財宝を「財」テキスト→SVG宝箱（蓋・金帯・錠前・辺の向きに傾く）に差し替え（board.ts `drawTreasureChest`）。
  - **オセアニア初期島の形を写真準拠に修正**（IMG_6409 実測・ヘックス数は従来どおり10/7・資源/数字構成も不変）: 北東の島=上段ジグザグ4＋中段4＋南東張り出し2の「いびつな形」、南西の島=3-2-2。霧は16（北西ブロック8＋中央〜南の帯8・陸7/海9・金2は霧内）。61ヘックス六角リージョン→`coordsWithSeaRing`（73タイル）へ。ck_seafarers_oceania も同データ共有で自動追随。
  - テスト: oasis.test.ts を実測値で再固定（13件）・scenarios.test.ts のオセアニア構造を島セルID固定で回帰防止。全**1031緑**・tsc/build緑・実機スクリーンショットで両盤の描画確認（エラー0）。
- **2026-07-05 T&B セッション3（本ブランチ・増分3）**:
  - **増分3「Catan Event Cards（イベントカード）」変種**（CN3089 p4-6）: 生産フェーズの赤黄ダイスをイベントデッキ（37枚）に置換。毎ターン山札の一番上をめくり、13種のイベント効果を解決してからカードの数字ディスク値で「生産」または「7の解決」。New Year でデッキ再構築。
    - **残存【要確認】C6 を解決**: 36枚の「イベント×生産数字×枚数」を**公式ドイツ語版第6版ルールブック p.5**（catan.de 685140）の明文列挙で確定（英語版CN3089には内訳記載なし）。BGG実カード写真・旧版Mayfairルール・CatanFusion の**4系統一致**＋2d6分布と厳密一致で裏取り。`TB_EVENT_CARDS_36` にデータ定数化し仕様書§2-3の表で固定。**残る【要確認】は荷馬車の木の本数(Lv3-5)のみ**。
    - 実装: 型（TbEventType/TbEventCard/Road.damaged/EVENT_*フェーズ/CHOOSE_EVENT_*・REPAIR_ROADアクション）／`engine/tbEvents.ts`（デッキ構築・13効果の適用・保留フェーズ遷移・ヘルパー）／`game.ts`（ROLL_DICE のカード置換・`resolveBaseRollOutcome` 抽出でダイス経路と共通化・`tbContinueAfterEvent`・各CHOOSE_EVENTハンドラ・REPAIR_ROAD・END_TURNの tbEpidemic リセット）。供給から取る系（豊作の年/穏やかな海/馬上槍試合）は **GOLD フェーズを流用**（`capPicksByBank` を dice.ts へ抽出）。疫病は `computeDiceProduction` の都市産出を2→1。地震は `Road.damaged`＋`canBuildRoad`/`canBuildSettlement` の制限＋修理（レンガ1木1）。
    - 配線: mask（デッキ順を秘匿）・createState・scenarios（`tb_event_cards`・基本盤・10点）・log・ai（4選択フェーズ＋修理優先）・lanCpu・protocol（LAN_SYNCED_ACTIONS）・lanServer（requiredActor＋フォールバックactor）。UI: main.ts（EVENT_DAMAGEの盤面タップ／カードめくり演出 `playTbEventCardReveal`／生産アニメ保留 `tbPendingEventNumber`／CPU駆動・ウォッチドッグ・fallback・シート案内）・ui.ts（EVENT_GIVE/HELPFUL/STEALモーダル＋地震修理ヒント＋ホットシート用の操作者名）・events.ts（損傷選択/修理タップ）・board.ts（損傷道の回転描画＋selectable）。
    - テスト `tb_event_cards.test.ts`（45件・データ分布/デッキ構築/13効果/AI自動解決/LANマスク/不干渉/不正入力）＋ `scenarios.test.ts`・`scenarios_smoke.test.ts` 更新。全**1027緑**・tsc/build緑。実機（Playwright）で tb_event_cards をセットアップ→カードめくり→7解決まで通しエラー0を確認。
    - **ウルトラコード多角レビュー**（4視点ファインダー→敵対検証はセッション上限で走らず自己裁定）: 指摘7件のうち**実バグ2件**（CHOOSE_EVENT_GIVE/HELPFUL の資源名未検証＝LAN不正ペイロードでNaN混入／lanServer フォールバックactorにイベント選択未追加）を修正＋テスト追加、**UX改善4件**（金タイル見出し流用・地震の修理案内・ホットシートの操作者名×2）を反映、**1件**（地震の盤面タップが他者の道も受理）は CITY_DOWNGRADE と同一の既存パターン（ハイライト1人分＋netDispatch/requiredActorで拒否）で既存踏襲＝不要と裁定。
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
- **Friendly Robber の実装解釈**（原文と根拠は仕様書§2-1に記載。テストで固定済み）:
  - 「2VPしか持たない」は**公開VP**（`calcPublicVP`）で判定＝隠しVPカードが盗賊の合法手から逆算されるのを防ぐ。原文どおり**手番プレイヤー自身の2VP建物も区別しない**。奪えるのは「2VP超（公開3VP以上）」のみ。
  - 砂漠フォールバックで盗賊が既に砂漠なら**その場に留まる**（同一タイル移動を例外許可）。砂漠が無い盤は原文想定外→通常候補へ（進行を止めない保険）。
  - **盗賊の合法移動先は `getRobberMoveTargets`（robber.ts）に一元化**（現在地除外・S5数字限定・保護・砂漠フォールバック）。エンジン/AI/LAN CPU/ウォッチドッグ/盤ハイライト/クリックの全経路がこれを使う。今後の変種もここに足す。
- **Event Cards の実装解釈**（原文と根拠は仕様書§2-3・テストで固定済み）:
  - 36枚の数字分布は**公式独語版第6版 p.5**が正（2d6分布どおり・7の6枚=ROBBER ATTACKS・A BEAUTIFUL DAY 16枚）。`TB_EVENT_CARDS_36` にデータ化。
  - 効果→（選択が要るなら保留フェーズ）→カード数字で生産or7 の順（公式記載順）。カード数字は `lastDiceRoll` に2分割で格納し既存の生産/演出/統計と互換。
  - 供給から取る系（豊作の年/穏やかな海/馬上槍試合）は **GOLD フェーズを流用**（新フェーズ数を抑える）。渡す/奪う系は EVENT_GIVE/HELPFUL/STEAL、地震は EVENT_DAMAGE（盤面タップ・都市格下げと同型）。
  - HELPFUL NEIGHBOR/親切な盗賊と同様 **公開VP** で判定（隠しVP逆算防止）。CALM SEAS は港上の**建物数**（VPでなく個数）。CONFLICT はタイル保持者=必須/騎士最多単独=任意。
  - デッキ秘匿は mask.ts（並び順を不透明化・めくった `tbLastEventCard` は公開）。LAN不正入力対策で CHOOSE_EVENT_GIVE/HELPFUL は資源名を `RESOURCE_TYPES.includes` で検証。
- **実装はデータ駆動＋テストで数値固定**が原則。変種/シナリオは既存 `classic` 盤や `ScenarioRules` トグルへ薄く乗せる。

## 4. 未完了タスク（優先順位順・次セッションはここから）
> すべて [docs/交易と蛮族_仕様書_v6.md](docs/交易と蛮族_仕様書_v6.md) をデータ化＋テスト固定していく。各増分ごとに `tsc`/`vitest`/`build` 緑・区切りコミット。
1. **増分4＝Catan for Two（2人用・§2-4）**: trade token 20＋中立プレイヤー2人。可変セットアップで各中立に開拓地1（図示位置）。生産フェーズ×2回（2回目は1回目と別出目まで振り直し）・建設のたび中立の道/開拓地も無償配置・trade token 経済（Forced Trade / Move Robber）。要設計（中立プレイヤーの扱い・2人戦専用の状態）。**Event Cards と併用可**（イベントカードのCONFLICT等は中立に特則あり）。
2. **増分5以降：5シナリオ**（Fishing→Rivers→Merchant Trains→Barbarian Attack→Traders & Barbarians）。
   - **Fishing on Catan**（§3-1）は最初の完全シナリオだが**要設計**: 湖が**4数字**で産出＝現 `Tile.number:number|null`（単一）を拡張要／漁場は盤ヘックスでなく**フレーム上の産出源**＝新しい盤フィーチャー／fishトークン経済（秘匿・上限7・ぼろ靴・消費アクション）。
   - Rivers=川タイル(3+4hex)＋沼＋橋(新建物)＋コイン＋最富豪/極貧。Barbarian/T&B=騎士・蛮族・専用デッキ・荷馬車で最も重い。
3. **残存【要確認】（軽微・データ定数で1行修正可）**: 荷馬車アップグレードの**木の本数(Lv3-5)**（暫定「木2」で実装可）。※Event Cards の数字分布(C6)は**解決済み**（§2-3）。
4. **完了後**: ユーザ許可を得て feature ブランチを push→PR→（許可後）main マージ→本番。その後 100万石(fork)へ SYNC.md §3 手順で戦国語化移植。

## 5. 詰まっている点・注意点・保留中の判断
- **本ブランチは未push**。T&B作業は `feat/traders-barbarians` にしか無い。新セッションは**必ずこのブランチをチェックアウト**してから作業する。
- **デプロイ権限**: main への push／PRマージ／hyaku/main への push は**毎回ユーザの明示許可**。自作PRの即マージは安全ガードで止まる＝正常。
- **公式PDFと再レンダリング環境**（`scratchpad` はセッション固有で消えうる）:
  - PDF URL: `https://www.catan.com/sites/default/files/2025-04/CN3089%20CATAN%20%E2%80%93%20T&B%20Rulebook.pdf`（ローカルにも `C:\Users\b1242\Downloads\CATAN_交易と蛮族_第6版_CN3089.pdf`）。
  - テキスト抽出=`/mingw64/bin/pdftotext -layout`（散文は raw の方が綺麗）。**画像レンダラは未導入**→ scratchpad で `npm i pdfjs-dist@^4 @napi-rs/canvas` して `render.mjs`/`crop.mjs`（**clip の undefined を吸収するパッチ必須・スケールは≤10**。14はskia確保失敗）。ページ1/19/24はSMaskで描画失敗するが重要図版なし。
  - **PDFのページ番号と印刷ページ番号がズレる箇所あり**（例: PDF8=印刷8だがCatan for Two、Fishingは印刷9-10=PDF9-10）。仕様書の出典は印刷ページ。
- **`scenarios.test.ts` は「表示シナリオ集合」を厳密に固定**＝**可視シナリオを1つ追加するたびにこのテストの配列を更新**する（tb_harbors / tb_friendly_robber / tb_event_cards で更新済み）。`scenarios_smoke` は表示シナリオを自動で拾い「3人CPUフルゲーム完走」まで回す（新シナリオ追加で自動的に+1件）。**イベントカード等で新しい多人数解決フェーズを足したら `scenarios_smoke` の駆動ループにも対象pid解決を追加する**（EVENT_* は `tbEventPendingIds` で解決済み）。
- **numberHexOnly(S5) と friendlyRobber は併用不可**（砂漠フォールバックと数字限定が矛盾。現行シナリオに併用なし・robber.ts にコメント済み）。将来変種を合成する時は要再設計。
- **Event Cards は基本盤のみで実装**（scenarios: `tb_event_cards`）。仕様上は Seafarers/C&K とも併用可だが未対応。C&K併用時は「イベントダイス＋赤ダイスをカードと同時に振り赤ダイスで進歩カード抽選」の特則があり、`isCk` 経路との統合は未実装（`ROLL_DICE` の tbEventCards 分岐は isCk より前で早期returnするため現状は非CK専用）。
- **増分3のウルトラコード多角レビュー**: 4視点ファインダーは完走したが**敵対検証(verify)フェーズはセッション上限で全滅**→指摘7件を**自己裁定**して反映（実バグ2件修正＋テスト・UX4件改善・1件は既存踏襲で不要）。次セッションでverifyを再実行したい場合は Workflow の resumeFromRunId=`wf_3570e023-8ff` でファインダー結果はキャッシュ再利用できる。
- **New Year は36枚に含まれない別カード**。デッキは37枚（36+NY）で作り、下5枚→NY→残り31枚を上に積む＝NYより下の5枚はそのゲームで使われない（`buildTbEventDeck`）。`TB_EVENT_DECK_BOTTOM=5`。
- **網羅Recordが多い**: `SCENARIOS`/`SCENARIO_RULES`（Record<ScenarioId>）、`TILE_COUNTS`/`TILE_RESOURCE_MAP`/`TILE_COMMODITY_MAP`（Record<TileType>）、`category` union（`scenarios.ts`×2＋`scenarioSelect.ts`）。id/tile/category を足すと全部直さないと tsc が通らない（＝抜け漏れ検知になる）。
- **vitest が稀に ESM ローダで一時クラッシュ(exit 134)**: 失敗ではない。再実行で緑。
- 参考メモリ: `seafarers-pr9-known-bugs` / `seafarers-official-rebuild`。フォーク同期は SYNC.md／100万石 `docs/reskin/GLOSSARY.md`。

## 過去ログ（要約）
- 2026-07-05(3): UI/UX改善（船コスト表示・道/船と盗賊/海賊の選択UI・進歩カード獲得通知・クレーン都市選択）＋オアシス/オセアニア写真準拠リビルド（全1039緑・作業ツリークリーン）。
- 2026-07-05(2): T&B 増分3「イベントカード」実装＋C6（数字分布）を公式独語版で確定（feat/traders-barbarians・未push・全1027緑）。
- 2026-07-05: T&B 仕様確定（公式PDF図版をPNG視認）＋増分1「強き港」＋増分2「親切な盗賊」実装（feat/traders-barbarians・未push）。
- 2026-07-04: 航海者フルリビルドのフォーク全移植／脱走兵UI／オセアニア再設計（catan PR#14-17・fork→hyaku/main）。
- 2026-06-28〜07-03: 公式準拠リビルド（S1〜S8＋NW）→敵対レビュー→ultracode監査→docs整理。
