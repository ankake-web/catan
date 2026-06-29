# 航海者版（Seafarers）ルール監査レポート

> 出典（唯一の正）: カタン公式ルールブック 第6版（CATAN Studio, 2025）／本リポジトリの
> 「カタン航海者版_ルール仕様メモ.md」「航海者版_公式準拠リビルド計画.md」。
> 監査日: 2026-06-28。基準テスト: vitest 796 passed / tsc --noEmit 緑（監査時点）。
> 凡例: ✅実装済 / ⚠️一部・簡略・要確認 / ❌未実装。各判定はコード根拠(file:line)付き。

本レポートは「公式準拠リビルド」完了後の **現コードを公式と1項目ずつ突き合わせた結果** である。
リビルド以前の旧乖離（29ヘックス固定・非公式マップのみ 等）は概ね解消済み。本書は **残っている乖離・バグ・簡略化** を記録する。

---

## 0. サマリ（先に結論）

- **コア（船・船移動・黄金の海・海賊・最長交易路＝道+船・開発カード変更・海フレームセットアップ）は概ね公式準拠。** 大きな破綻なし。
- **要修正の実バグ（少数・明確）**:
  - [B1] 街道建設カードの無料配置枚数が「残り道コマ数」だけでキャップされ、**船2本／道1+船1 を配れない**（全航海者シナリオ）。
- **公式ルール未実装（うち一部はコードコメントで簡略を明言）**:
  - [D1] **全航海者シナリオで港が4個固定**・しかも2:1港は木/レンガのみ（羊毛/麦/鉱の2:1港が永久に生成されない）。公式は計8〜9。
  - [D2] **S7 海賊の島々**で 盗賊・最長交易路・最大騎士力 が無効化されていない（公式は3つとも不使用）。軍船・艦隊戦闘も未実装（簡略を明言）。→ **フェーズBで✅実装済み（§5）**。
  - [D3] **S6 カタンの織物**の「初期配置3軒」未実装（簡略を明言）。「最初の村接続まで海賊凍結」「織物強奪」「村航路closed」も未実装。
  - [D4] `useRobber` / `startingSettlements` は **配線のみで消費コードが無い死フラグ**（types.ts/createState.ts にあるが誰も読まない）。
- **データ上の軽微な乖離**: 各シナリオのヘックス枚数が公式目安から±数枚（座標厳密一致は§1鉄則により不問。要地図画像）。S3霧の数字が固定（公式はランダム）。S4が砂漠分断でなく別島型の簡略。New Worldが固定マップ（制約付きランダム生成は未実装）。

---

## 1. 共通ルール（§4.3）

### 船 (Ship)
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| コスト=木1+羊1 | ✅ | constants.ts:61 `ship: { wood:1, wool:1 }`、検証 actions.ts:100 |
| 片側が海ヘクスの辺に配置 | ✅ | actions.ts:94 `isSeaEdge`、board.ts:320-324 |
| 接続=自分の船/建物（道とは直結しない） | ✅ | actions.ts:106 → board.ts:343-366 `isEdgeConnectedForPiece(...,'ship')` |
| 相手の建物を越えられない | ✅ | board.ts:355 相手建物は接続点にならない |
| 海賊ヘクスの辺に新規配置不可 | ✅ | actions.ts:96、tests/pirate.test.ts:56-65 |
| 分岐自由 | ✅ | 端点単位の接続判定（actions.ts:106） |
| 船は15隻 | ✅ | createState.ts:77 / constants.ts:69、残数チェック actions.ts:88 |
| 初期: 海岸開拓地は道の代わりに隣接空き海辺へ船1 | ✅ | actions.ts:102-104、game.ts:444-446 |

### 船の移動 (Move a Ship)
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 1ターン1隻 | ✅ | actions.ts:163、moveShip で `shipMovedThisTurn`（actions.ts:219） |
| そのターン建てた船は不可 | ✅ | actions.ts:164 `shipsBuiltThisTurn`、tests/ship_move.test.ts:188-205 |
| オープン端の船のみ可 | ✅ | actions.ts:181 / `isOpenShipEnd` actions.ts:138-150 |
| 両建物を結ぶclosed船列は不可（相手分断後も） | ✅ | 両端が建物なら開放端なし。相手建物も `v.building!=null` で開放端を塞ぐ |
| 海賊ヘクスの辺へ/から不可 | ✅ | actions.ts:175-178、tests/ship_move.test.ts:120-136 |
| 移動=除去して通常配置で再判定 | ✅ | actions.ts:184-188 |

### 黄金の海 (Gold Field)
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 開拓地ごと任意1／都市ごと任意2 | ✅ | dice.ts:97-117 `computeGoldPicks`、game.ts:186-195 GOLDフェーズ |
| 任意資源を自由組合せ | ✅ | game.ts:205-241 CHOOSE_GOLD（owed枚ちょうど・バンク在庫内） |
| 「金」という資源カードは無い | ✅ | constants.ts:31,42 `gold:null`、dice.ts:48 通常産出からは出ない |
| 盗賊のある金/7は産出しない | ✅ | dice.ts:103,106、tests/gold.test.ts:55-61 |
| 赤数字(6/8)を金に置かない（原則） | ✅ | **公式3シナリオは順守**: S1=5,4／S4=5,4／New World=5,4（全て白数字）。番号8の金は非公式の群島(scenarios.ts:222)・連なる島々(scenarios.ts:323)のみ |

### 海賊 (Pirate)
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 7/騎士で盗賊か海賊の「どちらか」 | ✅ | game.ts:320-383（MOVE_ROBBER/MOVE_PIRATE）、PLAY_KNIGHT も ROBBERへ game.ts:659 |
| 海賊は海ヘクスへ | ✅ | game.ts:363（陸を弾く）／盗賊は海を弾く game.ts:327 |
| 海ヘクスで船所有相手1人からランダム強奪 | ✅ | game.ts:369-379、robber.ts:148-159 |
| 海賊隣接辺は船 新規配置・移動 不可 | ✅ | 配置 actions.ts:96 / 移動 actions.ts:175-178 |
| 港・開拓地建設には干渉しない | ✅ | canBuildSettlement は piratePosition を見ない（actions.ts:259-297） |
| 開始時から海ヘクスに海賊配置（盗賊＋海賊1体ずつ） | ✅ | createState.ts:50-62 |

### 最長交易路 (Longest Route)
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 道+船の連続5本以上で2VP | ✅ | scoring.ts:106-165 `calcLongestRoad`（道・船を両方収集） |
| 道↔船は自分の建物頂点でのみ連続 | ✅ | scoring.ts:135,141 `canSwitch=isOwnBuilding`、tests/longest_route.test.ts:28-58 |
| 空き交差点では道↔船はつながらない | ✅ | scoring.ts:141、tests/longest_route.test.ts:44-58 |
| 相手建物で分断 | ✅ | scoring.ts:118-122 `isBlocked` |

### 開発カードの変更
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 街道建設=道2/船2/道1+船1 | ⚠️**バグ** | BUILD_ROAD/BUILD_SHIP 両方が `roadBuildingRoadsRemaining` を消費（game.ts:403,439）＝船も無料置きは可。**ただし付与枚数が `Math.min(2, remainingRoads)`（game.ts:774）で道コマ数のみキャップ**→[B1]参照 |
| 無料配置（資源不要） | ✅ | actions.ts:99、tests/ship_move.test.ts:171-186 |
| 騎士=盗賊か海賊を動かす | ✅ | game.ts:632-665（ROBBERへ→MOVE_ROBBER/MOVE_PIRATE） |

### セットアップ共通
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 海フレームを組む | ✅ | 各シナリオ盤に sea を含む、createState.ts:47-48 |
| 海岸開拓地は道の代わりに隣接空き海辺へ船1 | ✅ | game.ts:539-542、actions.ts:102-104 / 67-69 |
| 2軒目開拓地で初期資源配布 | ✅ | game.ts:494-509 `setupGainFor` |

---

## 2. シナリオ（§4.4）

> コンポ「実測」は footprint `BIG_COORDS=getHexRegion(3,3,3)=37`（board.ts:64）でクリップした実数。
> 公式目安は3人用。座標厳密一致は§1鉄則により不問（要地図画像）。

### S1 新たな海岸を目指して（seafarers_newshores, scenarios.ts:191）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 14（scenarios.ts:198）公式14 |
| 盤面コンポ | ⚠️ | 実測 総37／海15・金2・丘3・森4・牧草4・畑4・山4・砂漠1／数字21。公式目安(総35:海13/丘4/森3/牧草5/畑4/山4・数字22)から各±1。軽微 |
| 金タイル数 | ✅ | 2（scenarios.ts:106,110）公式2 |
| 港数 | ❌ | 実測4（3:1×2＋2:1×2）。公式8（2:1×5＋3:1×3）→[D1] |
| 固有: 新島初入植+2 | ✅ | `newIslandBonusVp:2`（scenarios.ts:199）、判定 islands.ts:130-144、付与 game.ts:514-522、他人が先でも各自獲得 tests/islands.test.ts:178-201 |
| 初期配置=本島のみ | ✅ | `isHomeIslandVertex` islands.ts:77-88、tests/islands.test.ts:64-73 |

### S2 4つの島（seafarers_fourislands, scenarios.ts:480）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 13（scenarios.ts:487） |
| 盤面コンポ | ⚠️ | 実測 総37／海18・金0・森4・畑4・牧草3・丘4・山3・砂漠1／数字18。公式(総35:海15/各資源4・数字20)から牧草/山-1・海+3・数字-2 |
| 金タイル数 | ✅ | 0（公式0） |
| 港数 | ❌ | 実測4。公式9 →[D1] |
| 固有: 未探検＝プレイヤー別state・初入植+2 | ✅ | `setupAnywhere:true`＋`newIslandBonusVp:2`、出発島記録 game.ts:524-531、ホーム以外のみ加点 islands.ts:141-142、tests/islands.test.ts:124-135 |
| 初期配置=どの島でも可 | ✅ | `setupAnywhere`（islands.ts:82） |

### S3 霧の島（seafarers_fogislands, scenarios.ts:405）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 12（scenarios.ts:412） |
| 盤面コンポ | ⚠️ | 実測 表向き陸15＋海22(うち霧15)、表数字14。霧公開で陸9＋海6が出現（裏12相当）。公式(表30＋裏12/表数字14＋裏10)に対し裏の数字は9・表の海が多め |
| 探索公開 | ⚠️ | 船/道/開拓地隣接で公開、陸→その地形資源1枚／海→なし（explore.ts:27-39、game.ts:398/429/462/485、tests/fog.test.ts:37-57）。**数字は事前定義の固定値**（FOG_HIDDEN scenarios.ts:388-404）で公式の「ランダム数字」ではない |
| 港数 | ❌ | 実測4 →[D1] |
| 初期配置=本島のみ | ✅ | 霧は海扱いで配置不可（buildFromLandFogMap scenarios.ts:169-186） |

### S4 砂漠を越えて（seafarers_throughdesert, scenarios.ts:364）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 14（scenarios.ts:371） |
| 盤面コンポ | ⚠️ | 実測 総37／海15・金2・砂漠2・丘3・森4・牧草4・畑4・山3／数字20。公式(総35:海10/砂漠3/森5/山4・数字22)から砂漠-1・森-1・山-1・海+5 |
| 金タイル数 | ✅ | 2（scenarios.ts:295,299） |
| 港数 | ❌ | 実測4 →[D1] |
| 固有: 未探検地域初入植+2 | ⚠️ | `newIslandBonusVp:2`は実装。**ただし「大砂漠で本島分断」でなく、本島15＋海越えの別島(砂漠含む)型の簡略**（scenarios.ts:288-301 コメント明記）。砂漠は盗賊なし |
| 初期配置=本島のみ | ✅ | `setupAnywhere`無し、tests/scenarios.test.ts:148-161 |

### S5 忘れられた部族（seafarers_forgottentribe, scenarios.ts:441）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 13（scenarios.ts:448） |
| 辺トークン回収（vp/dev/harbor） | ✅ | `collectEdgeToken` seaTokens.ts:60（vp→+1／dev→今ターン購入扱い seaTokens.ts:74／harbor→沿岸建物へ設置or保留 seaTokens.ts:82-84） |
| 港トークン保留→沿岸開拓地で設置 | ✅ | `placeHeldHarborAt` seaTokens.ts:43、BUILD_SETTLEMENTから game.ts:487 |
| 開拓地=数字ヘクスのみ | ✅ | `numberHexOnly` actions.ts:274、`rules.numberHexOnly:true` scenarios.ts:449→createState.ts:136 |
| 盗賊=数字ヘクスのみ | ✅ | game.ts:329 |
| フック接続 | ✅ | 建設 game.ts:431／移動 game.ts:464／設置 game.ts:487 |
| 港同士1辺以上空ける | ⚠️ | placeHarborForPlayer は間隔制約を見ない（seaTokens.ts:25-39） |
| コンポ枚数 | ⚠️ | 辺トークン `['vp','dev','vp','harbor','vp','dev','harbor','vp']`＝VP4・dev2・harbor2（scenarios.ts:432）。公式目安「VP8・開発4」より少ない |

### S6 カタンの織物（seafarers_cloth, scenarios.ts:512）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP=14 | ✅ | scenarios.ts:519 |
| 5村供給切れ→最多VP・同点は織物多い方 | ✅ | `checkClothEnd` cloth.ts:74-91（閾値 min(5,村数)・同点織物比較） |
| 接続成立で即1枚 | ✅ | `connectVillagesAround` cloth.ts:31-48 |
| 村の数字で接続者全員に1枚 | ✅ | `produceCloth` cloth.ts:51-68、distributeResources後 game.ts:181 |
| 各村5枚／織物2枚=1VP | ✅ | 供給5 scenarios.ts:508、`clothVp`=floor(/2) cloth.ts:23-25、scoring.ts:32 |
| 小島に開拓地不可 | ✅ | `noIslandSettlement` actions.ts:276、scenarios.ts:520 |
| 最長交易路タイル不使用 | ✅ | `useLongestRoute:false` scenarios.ts:520→scoring.ts:183-192 |
| **開始時 開拓地3軒（3軒目で資源）** | ❌ | **未実装**。advanceSetup は2軒固定（game.ts:1003-1047）で `startingSettlements` を読まない。S6 も `startingSettlements:3` を未設定（scenarios.ts:520）。コメントで簡略明記（scenarios.ts:494） |
| 村航路は closed（移動・延長不可） | ❌ | canMoveShip は `isOpenShipEnd` のみ（actions.ts:180-181）。村頂点に建物が無く開放端扱い→村接続後の船を動かせる恐れ |
| 海賊=最初の村接続まで凍結／移動時 資源or織物強奪 | ✅ | §6[D6]で実装: MOVE_PIRATE 凍結＋強奪を「資源か織物」の無作為プールに（`stealResourceOrCloth`/`pirateRobbableCount`） |
| フック接続 | ✅ | game.ts:181/198/433/436/466/469 |

### S7 海賊の島々（seafarers_pirateislands, scenarios.ts:579）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利=要塞制圧＋10VP | ✅ | checkVictory fortresses分岐 scoring.ts:310-315、`victoryTarget:10` scenarios.ts:586 |
| 要塞HP=ラホ3・全除去で奪取（自開拓地化） | ✅ | createState.ts:100 `raho:3`、`attackFortress` pirateIslands.ts:29-41 |
| 艦隊移動=小さい目だけ前進（ゾロ目どちらでも） | ✅ | `moveFleet(next, Math.min(d1,d2), rng)` game.ts:170（ダイス後・資源前・7判定前） |
| 建物隣接停止で攻撃 | ✅ | 停止頂点の建物所有者と艦隊戦を解決（pirateIslands.ts moveFleet）。 |
| **戦闘判定（海賊強さ=目／自分強さ=軍船数）** | ✅ | 海賊強さ>軍船→ランダム1枚+都市ごと1枚破棄／軍船>海賊→任意1枚獲得／同点→なし（moveFleet）。 |
| **軍船化（騎士で通常船を軍船化）** | ✅ | PLAY_KNIGHT が起点最近の通常船を軍船化（`Ship.warship`／`playWarship`）。盗賊フェーズに入らない。 |
| **盗賊 不使用** | ✅ | S7 rules `useRobber:false`。7は手札破棄のみ（game.ts）／騎士は軍船化に転用。 |
| **最長交易路 不使用** | ✅ | S7 rules `useLongestRoute:false`（scoring.ts で保持者null）。 |
| **最大騎士力 不使用** | ✅ | S7 rules `useLargestArmy:false`（updateLargestArmy が保持者null）。 |
| フック接続 | ✅ | moveFleet game.ts:170／ATTACK_FORTRESS game.ts:580-581／AI ai.ts:820-821 |

### S8 カタンの七不思議（seafarers_wonders, scenarios.ts:548）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利=不思議完成 or 10VP＋単独最高レベル | ✅ | checkVictory wonderLevel分岐 scoring.ts:318-327（Lv4即勝利／10VPかつ myLevel>maxOther） |
| 5種・1人1つ早い者勝ち | ✅ | `WONDERS` 5種 wonders.ts:38-44、canBuildWonder wonders.ts:63-68 |
| 4レベル制・各レベル資源5 | ✅ | `WONDER_MAX_LEVEL=4`／`WONDER_LEVEL_COST`=鉱2麦2羊1=5（wonders.ts:15-17） |
| 1ターンに払える分だけ複数レベル | ✅ | TRADE_BUILD中に反復可（canBuildWonder wonders.ts:65） |
| 建設要件（不思議ごと） | ⚠️ | **公式と異なる代替値**（2都市/2都市/6VP/港都市/3開拓地、wonders.ts:39-43。コメント自認 wonders.ts:37） |
| 小島初入植+1点 | ✅ | `newIslandBonusVp:1` scenarios.ts:556→scoring.ts:54-61、付与 game.ts:514-522 |
| 海賊 不使用 | ✅ | `usesPirate`が wonders で false（createState.ts:53） |
| フック接続 | ✅ | BUILD_WONDER game.ts:568-569／AI ai.ts:814 |

### New World（seafarers_newworld, scenarios.ts:374）
| 項目 | 状況 | 差分・備考(file:line) |
|---|---|---|
| 勝利VP | ✅ | 12（scenarios.ts:381） |
| 盤面コンポ | ⚠️ | 実測 総37／海16・金2・各資源ほぼ均等／数字20。3島(15/3/3)。自由構築のため枚数規定は緩い |
| 未探検島初入植+1 | ✅ | `newIslandBonusVp:1`＋`setupAnywhere:true` scenarios.ts:382、tests/islands.test.ts:124-135 |
| 港数 | ❌ | 実測4 →[D1] |
| **制約付きランダム生成（赤6/8隣接回避・金に赤数字を置かない）** | ❌ | 未実装。固定マップ NEW_WORLD_LAND を使用（scenarios.ts:352-362）。乱数生成・隣接制約コードは存在せず |

---

## 3. 優先度つき 乖離・バグリスト

凡例: [B]=実バグ（明確な不具合） / [D]=公式ルール乖離（未実装・簡略） / [N]=軽微・データ。

### 高
- **[B1] 街道建設カードが船/混在を正しく配れない**（game.ts:774）。`Math.min(2, player.remainingRoads)` が道コマ数だけでキャップ。残り道0でも船在庫があれば「船2」を、残り道1なら「道1+船1」「船2」を配れない。正: 付与枚数を `min(2, 道在庫+船在庫)` 等にし、各配置時に実コマ種別の在庫を尊重。**全航海者シナリオに影響**（発生条件は道コマ枯渇付近のエッジだが明確なバグ）。
- **[D1] 全航海者シナリオで港が4個固定**（scenarios.ts:118 `max=4`、buildFromLandMap/FogMap が既定で呼ぶ scenarios.ts:162,184）。生成は `HARBOR_POOL[0..3]`＝3:1×2＋2:1(木)＋2:1(レンガ)のみ。**羊毛/麦/鉱の2:1港は永久に出現しない**（プール index 4-6 に到達しない）。公式は計8〜9（2:1×5＋3:1×3/4）。沿岸交易の戦略性が大幅不足。要: max引き上げ＋プール網羅（最終配置は要地図画像）。
- **[D2] S7 で 盗賊・最長交易路・最大騎士力 が無効化されていない** → **✅実装済み（§5参照）**。S7 rules にフラグ付与＋軍船・艦隊戦([D5])を実装し公式準拠化。

### 中
- **[D3] S6「初期配置3軒」未実装**（advanceSetup 2軒固定 game.ts:1003-1047）。公式は2軒は資源なし・3軒目で資源。要: advanceSetup を `startingSettlements` 対応に。
- **[D4] 死フラグ `useRobber` / `startingSettlements`**（types.ts:281,285／createState.ts:132,134 にあるが消費コード皆無）。配線済みなのに効かない＝[D2][D3]の温床。消費実装するか、誤解を招くので一旦削るか判断要。
- **[D5] S7 軍船・戦闘解決** → **✅実装済み（§5参照）**。騎士＝軍船化、艦隊戦は軍船数 vs 海賊の目で解決。
- **[D6] S6 海賊「最初の村接続まで凍結」「織物強奪」** → **✅実装済み（§6）**。凍結ガード＋強奪を「資源か織物」の無作為プールに。
- **[N1] S3 霧の数字が固定・公式はランダム**（FOG_HIDDEN scenarios.ts:388-404、explore.ts:31-32）。陸公開時の地形資源1枚付与は公式準拠。
- **[N2] S4 が「大砂漠で本島分断」でなく別島型の簡略**（scenarios.ts:288-301）。砂漠枚数も公式3に対し2。
- **[N3] New World に制約付きランダム生成が未実装**（固定マップ scenarios.ts:352-362）。

### 低
- **[D7] S6 村航路の closed（移動・延長不可）未実装**（canMoveShip actions.ts:180-181）。
- **[D8] S5 港トークンの「1辺以上空ける」間隔制約 未実装**（seaTokens.ts:25-39）。辺トークン構成も公式目安(VP8/開発4)より少ない(VP4/dev2/harbor2)。
- **[D9] S8 不思議の建設要件が公式と異なる代替値**（wonders.ts:39-43、コメント自認）。挙動・勝利判定は正しい。
- **[N4] 各シナリオのヘックス枚数が公式目安から±数枚**（S1〜S4・New World）。海タイル過多で陸/数字がやや少ない傾向（数字総じて公式22→20前後）。座標厳密一致は§1鉄則により不問（要地図画像）。

---

## 4. 残TODO（特に「要地図画像」）

- **要地図画像**: 各公式シナリオの厳密なヘックス座標・数字配置・港位置/種別。現状はコンポ枚数とルールを正に簡略配置。公式ルールブックの地図が手に入れば [D1]（港）と [N4]（枚数）を一気に詰められる。
  - **2026-06-29 追記**: `photo/`（公式アプリ Catan Universe のシナリオ解説15枚）を評価したが、**プレビューは緑=陸/青=海/白=霧の塊のみで、資源種別・数字ディスク・港が一切写っておらず [D1]/[N4] の精緻化には不十分**と確定。座標/港の合わせ込みには**実物盤の高解像度写真**が必要。
  - 同画像から**未実装の公式シナリオ4本**（干ばつ=砂漠本島+豊かな小島14点／宝島=霧+交差点の財宝13点／オセアニア=2つの霧島12点／オアシス=基本盤+道で砂漠を開拓）と**C&K×航海者コンボ**（新たな岸へ17点／オセアニア15点）の存在を確認。VP値・特別VPルールの公式文言は読み取れる。**追加実装はユーザ判断で保留**（2026-06-29）。
- **要判断（ユーザー）**: [D2]（S7 をどこまで公式化するか・下記参照）。
- 非公式シナリオ（群島/黄金諸島/連なる島々/大連邦）は menu で「(非公式)」明示済み（scenarios.ts:589-617 系）。公式置換は完了済みのため、非公式は据え置きでよい。

---

## 5. 対応状況（2026-06-28 フェーズB 修正セッション）

監査後、ブランチ `seafarers-audit-and-fixes` で以下を修正（各コミットでテスト緑を維持）。

| 項目 | 状況 | 対応 |
|---|---|---|
| **[B1]** 街道建設カードの船キャップ | ✅修正 | `min(2, 道在庫+船在庫)`（海のある盤のみ船を加味）。tests/ships.test.ts +4 |
| **[D1]** 港が4個固定・2:1港が木/レンガのみ | ✅修正 | `coastalHarbors` max 4→9・プールを「5資源の2:1港を先頭＋3:1複数」に。大盤で全資源2:1＋3:1が出る。tests/scenarios.test.ts 更新+追加 |
| **[D3]** S6 初期配置3軒 | ✅修正 | advanceSetup を `setupRound` カウンタで startingSettlements 回に。資源は最後の軒で配布。実機アニメも対応。tests/cloth.test.ts +3 |
| **[D4]** 死フラグ `useRobber`/`startingSettlements` | ✅解消 | startingSettlements=LIVE（S6で使用）。useRobber/useLargestArmy=消費コード実装済み（7→破棄のみ／騎士使用不可／最大騎士力null）。tests/scenario_rules.test.ts +5 |
| 海賊艦隊の略奪→7の捨て札 ソフトロック | ✅修正（新規発見） | needsDiscard を略奪後の手札で判定。S7をseed2024等で完走確認。tests/pirate_islands.test.ts +5 |
| **[D2]** S7 で盗賊・最長交易路・最大騎士力 を不使用に | ✅実装 | S7 rules に `useRobber/useLongestRoute/useLargestArmy:false` を付与。7は手札破棄のみ。|
| **[D5]** S7 軍船・艦隊戦闘 | ✅実装 | 騎士＝軍船化（起点に最も近い通常船を1隻）。艦隊戦は 海賊強さ(=小さい目) vs 軍船数で解決（勝=任意1枚獲得／負=ランダム1枚+都市ごと1枚破棄／同点=なし）。pirateIslands.ts。tests/pirate_islands.test.ts +5 |

### [D2][D5] S7 公式化（オプションA で実装）
公式 S7 は 盗賊・最長交易路・最大騎士力 を外す代わりに **軍船による艦隊戦** で点を取らせる設計。これを実装した:
- `Ship.warship` を追加。S7 では PLAY_KNIGHT が「起点に最も近い通常船」を軍船化（`playWarship`）。盗賊フェーズに入らず、最大騎士力も無効。
- `moveFleet` を艦隊戦闘解決に変更。軍船数 > 海賊の目 なら資源を1枚獲得でき、軍船を整えると艦隊が経済エンジンになる。
- これにより最長交易路・最大騎士力が無くても 10VP＋要塞制圧へ到達可能になり、**スモークは seed 2024/1/2/3/7 で完走**（tests/pirate_islands.test.ts）。
- 残る簡略: 軍船化の対象選択UI／戦闘勝利時の「任意1枚」は自動選択（手札最少・バンク在庫ありを付与）。盤の厳密な公式座標は要地図画像。

## 6. 盤面忠実度＋固有ルールの追加対応（同セッション後半）

監査ワークフロー（9シナリオ並列・各結果を別エージェントが再カウント検証）に基づき盤面構成を是正:

| 項目 | 状況 | 対応 |
|---|---|---|
| **[N4]** 各盤の資源ヘックス枚数 | ✅(S1/S2/S4) 完全一致 | 島の位置は保ちタイル種別/数字を調整。S1=丘4/森3/牧草5/畑4/山4/金2/砂漠0、S2=各資源4/砂漠0/金0、S4=砂漠3/森5/山4/丘3/牧草4/畑4/金2。数字も公式数に。 |
| S5 金欠落・トークン半減 | ✅修正 | 公式『金2』が無かった→海域に金小島2を追加。海上トークンを VP4/dev2→**VP8/dev4**/harbor2 へ。 |
| 赤数字(6/8)隣接・金の赤数字 | ✅修正 | 公式盤ルール「6/8非隣接・金に赤数字なし」を全13シナリオで是正。tests/board_red.test.ts で恒久ガード。 |
| **[N3]** New World 制約付きランダム生成 | ✅実装 | 固定マップ→毎ゲーム種別/数字をランダム化（島座標固定）。赤6/8非隣接・金に赤数字なしを満たすまでリトライ。 |
| **[D6]** S6 海賊を初回村接続まで凍結＋織物強奪 | ✅実装 | MOVE_PIRATE を凍結。移動時の強奪を「資源か織物」の無作為プールに（`stealResourceOrCloth`／`pirateRobbableCount` を robber.ts に追加・game.ts/events.ts で配線）。織物=VP のため奪取後に勝利判定。tests/cloth.test.ts +3 |
| **[D7]** S6 村航路 closed | ✅実装 | 村タイルに面する自分の船は移動不可（isVillageLockedShip）。 |
| **[D8]** S5 港トークン間隔 | ✅実装 | 港同士1辺以上空ける。 |
| S6 村数・S7 要塞地形 | ✅改善 | S6 村5→**8**（公式コンポ）。S7 要塞4島の地形を多様化（牧草偏り解消）・recommendedPlayers 明示。 |
| S7 騎士ボタン UI | ✅改善 | S7 では「🚢 軍船化」表記＋軍船化不可時は無効化。 |
| シナリオ選択 UI | ✅追加 | 「👥 おすすめプレイヤー数」を表示。 |

### 公式データが無く「現状維持＋明記」とした項目（捏造回避）
監査の検証エージェントが「公式リファレンスに該当の固定値が無く、特定値への矯正は捏造になる」と判断:
- **[D9] S8 不思議の建設要件**: 公式の各不思議の正式要件が手元資料に無い。現状は到達可能な代替値（2都市/6VP 等）。挙動・勝利判定は公式どおり。**鉄/麦多めという公式の質的要件は満たす**。
- **[N1] S3 霧の数字・金**: 霧の枚数/裏向き数字の公式値が曖昧、金導入の根拠もタスク内に無い（検証エージェントが提案を editsValid=false と判定）。探索公開の機構（陸→地形資源1枚）は実装済み・公式準拠。
- **S8 本島の陸種別枚数 / footprint総数**: いずれも公式が固定値を規定せず。footprint は共通37（公式3人用35比で外周の海が+2＝フレーム差・ゲーム性に無影響）。
- **[N2] S4「砂漠帯による陸続きの分断」**: デジタル版は大洋＋砂漠を含む別島で近似（陸25・砂漠3は公式一致）。陸続き分断そのものの再現は要地図画像。

### 残TODO（要地図画像）
各公式シナリオの**厳密なタイル座標・数字配置・港位置/種別**。本セッションで資源ヘックスの「枚数」と
「島構造・赤数字ルール」は公式準拠にしたが、ピクセル単位の座標一致は公式ルールブックの地図画像が必要。
