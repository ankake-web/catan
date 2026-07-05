// ============================================================
// src/types.ts — カタン全型定義
// ============================================================

// ---- 座標 ----

export type AxialCoord = { readonly q: number; readonly r: number };
export type Point = { readonly x: number; readonly y: number };

// ---- リソース ----

export type ResourceType = 'wood' | 'brick' | 'wool' | 'grain' | 'ore';
export type ResourceHand = Record<ResourceType, number>;

// ---- 騎士と商人(Cities & Knights)拡張: 商品(コモディティ) ----
// 都市が「森→紙 / 牧草→布 / 山→金貨」を1個ずつ追加産出する。都市改善の支払いに使う。
export type CommodityType = 'coin' | 'cloth' | 'paper';
export type CommodityHand = Record<CommodityType, number>;
/** バンク交易の対象（資源または商品）。商品交易は騎士と商人のみ。 */
export type TradeKind = ResourceType | CommodityType;

// ---- タイル ----

// 基本タイル: forest/field/pasture/hill/mountain/desert
// 航海者拡張: sea（海・数字なし・産出なし）, gold（金・任意資源を産出）
export type TileType = 'forest' | 'field' | 'pasture' | 'hill' | 'mountain' | 'desert' | 'sea' | 'gold';
export type TileId = string; // 例: "1,0"（axial q,r）

export interface Tile {
  readonly id: TileId;
  readonly coord: AxialCoord;
  type: TileType;
  number: number | null; // 砂漠は null
  hasRobber: boolean;
  // 航海者 S3「霧の島」: 未探検(霧)ヘックス。霧の間は type='sea' として扱われ（配置/産出/島判定で海）、
  // 船/道/開拓地を隣接マスに置いて探索すると公開され、本来の type/number が確定する。
  // 公開された地形が陸なら、探索したプレイヤーが資源1枚を即獲得。
  fog?: { type: TileType; number: number | null };
  // 航海者「大カタン」: 抜けている数値トークン。小島の地形タイルは最初は数字が無く(number=null)産出
  // しない。プレイヤーが道/船/開拓地でそのタイルの端に到達すると、隠れていた数字(pendingNumber)が
  // 出現して number に確定し、以後は通常どおり産出する。
  pendingNumber?: number;
  // 大カタン: 数値トークンの供給が尽きた後、小島へ数字を出すために本島から「抜かれた」タイル。
  // number=null になり以後は産出しない（公式の「本島の数値トークンを持ち出す」）。
  numberRemoved?: boolean;
}

// ---- 頂点（Vertex） ----
// ID はボード生成時のピクセル座標重複排除で確定（"v0"〜"v53"）

export type VertexId = string;

export interface Vertex {
  readonly id: VertexId;
  readonly pixel: Point;                 // SVGレンダリング用（不変）
  readonly adjacentTileIds: TileId[];
  readonly adjacentEdgeIds: EdgeId[];
  readonly adjacentVertexIds: VertexId[];
  building: Building | null;
  harborType: HarborType | null;
  // 騎士と商人: この頂点の騎士コマ（建物とは排他）。基本/航海者では未設定。
  knight?: Knight | null;
}

// ---- 辺（Edge） ----
// ID は両端 VertexId をソートして "|" 連結

export type EdgeId = string;

export interface Edge {
  readonly id: EdgeId;
  readonly midpoint: Point;              // 道コマのSVG配置位置
  readonly vertexIds: readonly [VertexId, VertexId];
  readonly adjacentEdgeIds: EdgeId[];    // 最長道路DFS用
  road: Road | null;
  // 航海者拡張: 海に面した辺に置く船。1つの辺は road か ship のどちらか一方のみ。
  // 基本ゲームでは常に null（海タイルが無いため）。
  ship?: Ship | null;
}

// ---- 建物・道 ----

export type BuildingType = 'settlement' | 'city';

export interface Building {
  readonly type: BuildingType;
  readonly playerId: PlayerId;
  // 騎士と商人: 都市改善Lv4到達でメトロポリス化した都市（勝利点4・城壁扱い）。
  readonly metropolis?: boolean;
  // 騎士と商人: 城壁付きの都市（7の捨て札上限+2）。
  readonly wall?: boolean;
}

// ---- 騎士と商人(Cities & Knights) ----
export type CkTrack = 'trade' | 'politics' | 'science'; // 交易(布)/政治(金貨)/科学(紙)
export type KnightStrength = 1 | 2 | 3;                  // 基本/強力/最強

// 騎士コマ（頂点に置く。自分の道網に接続。起動すると蛮族防衛に算入）。
export interface Knight {
  readonly playerId: PlayerId;
  readonly strength: KnightStrength;
  readonly active: boolean;
  // 騎士と商人: このターンに起動したか。起動したターンは行動(移動/押出/追払い)不可。END_TURNでクリア。
  readonly activatedThisTurn?: boolean;
}

// 進歩カード（発展カードの置換）。色イベント面で改善レベルに応じて引く。即時効果。
export type ProgressCardType =
  // 科学(緑/紙)
  | 'smith'        // 騎士を最大2体まで無料で1段昇格
  | 'engineer'     // 城壁を1つ無料建設
  | 'irrigation'   // 自分の建物に隣接する畑1つにつき麦2
  | 'mining'       // 自分の建物に隣接する山1つにつき鉱石2
  | 'alchemist'    // 次のダイスの目を自分で決めてから振る（自動で最良の目）
  | 'crane'        // 都市改善を商品1個安く即建設
  | 'inventor'     // 数字トークン2枚を入れ替え（自動で自分に有利に）
  | 'medicine'     // 麦1鉱石2で開拓地を都市化
  | 'printer'      // 即時+1勝利点
  | 'road_building_progress' // 道を2本無料建設
  // 交易(黄/布)
  | 'resource_monopoly' // 各相手から指定資源を2枚（自動で最良資源）
  | 'trade_monopoly'    // 各相手から指定商品を1枚（自動で最良商品）
  | 'master_merchant'   // VP最多の相手から無作為2枚
  | 'commercial_harbor' // 各相手と 自分の資源1⇄相手の商品1 を交換
  | 'merchant'          // 商人コマを資源地形に置く（+1VP・その地形2:1）
  | 'merchant_fleet'    // このターン、指定1種を2:1で交易
  // 政治(青/金貨)
  | 'warlord'      // 自分の騎士を全て無料で起動
  | 'saboteur'     // 自分以上のVPの全員が資源を半数捨てる
  | 'wedding'      // 自分よりVPが高い各相手から2枚もらう
  | 'bishop'       // 盗賊を移動し移動先隣接の全相手から各1枚
  | 'constitution' // 即時+1勝利点
  | 'deserter'     // 相手の騎士を1体消し、自分は同強度の非起動騎士を得る
  | 'diplomat'     // 端の道1本を撤去（自分の道なら再建設）
  | 'intrigue'     // 自分の道に隣接する敵騎士を1体退去
  | 'spy';         // 相手の進歩カードを1枚奪う

export interface ProgressCard {
  readonly id: string;
  readonly type: ProgressCardType;
  readonly deck: CkTrack;
}

export interface Road {
  readonly playerId: PlayerId;
  /** 交易と蛮族イベント「地震」: 横倒し（損傷）状態。修理(REPAIR_ROAD)するまで自分の道の追加建設不可・
   *  隣接交差点への開拓地建設不可。最長交易路には損傷中も算入する（CN3089 p5）。 */
  readonly damaged?: boolean;
}

// 航海者拡張: 船（海上の道）。
export interface Ship {
  readonly playerId: PlayerId;
  /** 航海者 S7 海賊の島々: 騎士カードで軍船化された船（艦隊戦の戦力＝軍船数）。通常船は未設定/false。 */
  readonly warship?: boolean;
}

// ---- 港 ----

export type HarborType = 'generic' | ResourceType; // generic = 3:1、ResourceType = 2:1

export interface Harbor {
  readonly id: string;
  readonly type: HarborType;
  readonly vertexIds: readonly [VertexId, VertexId];
}

// ---- プレイヤー ----

export type PlayerId = 'player1' | 'player2' | 'player3' | 'player4';
export type PlayerColor = 'red' | 'blue' | 'purple' | 'orange';
// 'neutral' = 交易と蛮族「Catan for Two」の中立プレイヤー（盤上のコマだけを持つ想像上のプレイヤー。
// players には実体を持つが playerOrder に入らず、手番・生産・捨て札・勝利判定の対象外）。
export type PlayerType = 'human' | 'ai' | 'neutral';
// AIの強さ。内部4段階だが、UIは「弱い/普通/強い」の3択を normal/strong/elite に割り当てる
//（'weak'=旧ランダム級は現在UI非公開。テスト互換のため型としては残す）。'elite' が最上位。
export type AiDifficulty = 'weak' | 'normal' | 'strong' | 'elite';

export type DevCardType =
  | 'knight'
  | 'road_building'
  | 'year_of_plenty'
  | 'monopoly'
  | 'victory_point';

export interface DevCard {
  readonly id: string;
  readonly type: DevCardType;
  readonly purchasedOnTurn: number; // globalTurnNumber 単位。canPlay: purchasedOnTurn < current
}

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: PlayerColor;
  readonly type: PlayerType;
  readonly aiDifficulty?: AiDifficulty;

  hand: ResourceHand;
  // 騎士と商人: 商品(コモディティ)の手札。基本/航海者では未設定。
  commodities?: CommodityHand;
  // 騎士と商人: 都市改善の各ツリーのレベル(0..5)。
  improvements?: Record<CkTrack, number>;
  // 騎士と商人: 蛮族撃退で得た「カタンの守護者」勝利点。
  defenderVP?: number;
  // 騎士と商人: 進歩カード(印刷/立憲)で得た恒久勝利点。
  progressVP?: number;
  // 騎士と商人: 商船隊(merchant_fleet)で「このターン2:1で交易できる」種別。END_TURN でクリア。
  merchantFleetType?: TradeKind | null;
  // 騎士と商人: 手札の進歩カード（最大4枚）。
  progressCards?: ProgressCard[];
  // LANマスク用: 相手の進歩カード枚数（中身は隠す）。
  progressCardCount?: number;
  // LANマスク用: 相手の商品(コモディティ)枚数（内訳は隠す）。
  commodityCount?: number;

  // - アクションカードは使用後に除去する
  // - 勝利点カードは宣言まで除去しない
  devCards: DevCard[];

  remainingRoads: number;        // 初期 15
  remainingSettlements: number;  // 初期 5
  remainingCities: number;       // 初期 4
  remainingShips?: number;       // 航海者拡張の船コマ（初期 15）。基本ゲームでは未使用。

  knightsPlayed: number;        // 使用済み騎士カード枚数
  longestRoadLength: number;    // 現在の最長道路長

  hasLongestRoad: boolean;
  hasLargestArmy: boolean;

  // ---- LAN対戦の秘匿マスク用（表示専用・単一端末プレイでは常に未設定） ----
  // 他プレイヤー視点へ配信する state では hand / devCards の中身を隠し、
  // 枚数だけをここへ入れて配信する。applyAction はこれらを一切参照しない。
  handCount?: number;
  devCardCount?: number;
}

// ---- フェーズ ----

export type GamePhase =
  | 'SETUP_FORWARD'  // 初期配置 前半（時計回り）
  | 'SETUP_BACKWARD' // 初期配置 後半（逆順）
  | 'MAIN'
  | 'GAME_OVER';

export type TurnPhase =
  | 'PRE_ROLL'    // ダイスロール前（発展カード使用可）
  | 'ROBBER'      // 強盗処理中
  | 'DISCARD'     // 手札8枚以上の捨て処理
  | 'GOLD'        // 航海者: 金タイル産出の資源選択待ち（DISCARD と同様の多人数解決）
  | 'CITY_DOWNGRADE' // 騎士と商人: 蛮族敗北で格下げする都市の選択待ち（DISCARD と同様の多人数解決）
  | 'PROGRESS_DISCARD' // 騎士と商人: 進歩カード上限超過（5枚目）で捨てる1枚の選択待ち（多人数解決）
  | 'EVENT_GIVE'    // 交易と蛮族イベント「良き隣人」: 各自が左隣へ渡す資源1枚の選択待ち（多人数解決）
  | 'EVENT_HELPFUL' // 交易と蛮族イベント「親切な隣人」: 最多VP者が渡す資源と相手の選択待ち（多人数解決）
  | 'EVENT_STEAL'   // 交易と蛮族イベント「衝突/交易優位」: タイル保持者が奪う相手の選択待ち
  | 'EVENT_DAMAGE'  // 交易と蛮族イベント「地震」: 各自が損傷させる自分の道の選択待ち（多人数解決）
  | 'TB_NEUTRAL'  // 交易と蛮族「Catan for Two」: 手番プレイヤーが中立の道/開拓地を無償配置する待ち
  | 'TRADE_BUILD' // 交易・建設
  | 'END';

export type SetupSubPhase = 'PLACE_SETTLEMENT' | 'PLACE_ROAD';

// ---- 交易 ----

export type TradeState =
  | 'TRADE_OFFER'
  | 'TRADE_RESPONSE'
  | 'TRADE_CONFIRM'
  | 'TRADE_EXECUTE'
  | 'TRADE_CANCELLED';

export interface TradeOffer {
  give: Partial<ResourceHand>;
  receive: Partial<ResourceHand>;
}

export interface PlayerResponse {
  readonly playerId: PlayerId;
  readonly status: 'ACCEPT' | 'REJECT' | 'COUNTER';
  readonly counterOffer?: TradeOffer;
  readonly timedOutAt?: number;
}

export interface PendingTrade {
  state: TradeState;
  readonly initiatorId: PlayerId;
  offer: TradeOffer;
  readonly targetPlayerIds: PlayerId[];
  responses: Record<string, PlayerResponse>; // PlayerId → response
  selectedResponderId: PlayerId | null;
}

// ---- シナリオ固有ルール（航海者・公式準拠リビルド計画 §1） ----
// 各シナリオが既定値（基本/航海者共通）から差し替えたいルールを宣言する。
// createInitialGameState がこれを GameState の対応フィールドへ配線する。
// 後続フェーズで onExplore/seaEdgeTokens/clothTrade/pirateFleet/wonders を追加予定。
export interface ScenarioRules {
  /** 初期配置の開拓地数。既定2。S6 カタンの織物=3。 */
  startingSettlements?: number;
  /** 最長交易路タイルを使うか。既定true。S6 織物 / S7 海賊の島々=false。 */
  useLongestRoute?: boolean;
  /** 最大騎士力タイルを使うか。既定true。S7 海賊の島々=false。 */
  useLargestArmy?: boolean;
  /** 7・盗賊・海賊を使うか。既定true。S7 海賊の島々=false（7は手札破棄のみ・騎士は使用不可）。 */
  useRobber?: boolean;
  /** 新しい島への初入植ボーナスVP。既定2。S8 七不思議 / New World=1。0で無効。 */
  newIslandBonusVp?: number;
  /** 初期配置をどの島にも置けるか（既定false=本島=最大陸塊のみ）。S2 4つの島 / New World=true。
   *  trueのとき「自分が初期配置した島」が各プレイヤーのホーム島となり、それ以外への初入植で加点。 */
  setupAnywhere?: boolean;
  /** 開拓地・盗賊を数字ディスクのあるヘクスにしか置けない/動かせないか（既定false）。S5 忘れられた部族=true。 */
  numberHexOnly?: boolean;
  /** 小島（本島以外）に開拓地を建てられないか（既定false）。S6 カタンの織物=true。 */
  noIslandSettlement?: boolean;
  /** 七不思議モードを有効化するか（既定false）。S8 カタンの七不思議=true。 */
  wonders?: boolean;
  /** 海賊の島々モードを有効化するか（既定false）。S7=true（各自の要塞を攻略）。 */
  pirateIslands?: boolean;
  /** 1プレイヤーが建設できる都市の上限（既定なし=コマ数まで）。大カタン=8。 */
  maxCities?: number;
  /** 抜けている数値トークン（既定false）。大カタン=true（小島は到達するまで数字なし＝産出しない）。 */
  missingNumberTokens?: boolean;
  /** 抜けている数値トークンの供給枚数（既定5）。これを使い切ると以後は本島の数字を抜いて配る。 */
  numberTokenSupply?: number;
  /** 特定の「地域」に初めて開拓地を建てたプレイヤーへの特別VP（既定0）。砂漠を越えて＝北西地方に2。 */
  regionBonusVp?: number;
  /** 各プレイヤーの初期の道コマ数（既定15）。オアシス＝30（道で砂漠/霧を探索するため多め）。 */
  startingRoads?: number;
  /** 船を使わない基本ゲーム（既定false）。オアシス＝true（霧/砂漠は道だけで探索する）。 */
  noShips?: boolean;
  /** 交易と蛮族「強き港(Harbors of Catan / Strongest Ports)」変種を有効化（既定false）。
   *  港上の建物のVP合計が最多のプレイヤーに Strongest Ports タイル(+2VP)を与える。勝利目標は+1（例:11）。 */
  strongestPorts?: boolean;
  /** 交易と蛮族「親切な盗賊(The Friendly Robber)」変種を有効化（既定false・CN3089 p3）。
   *  公開VPが2以下のプレイヤーの建物があるヘックスへ盗賊を移動できず、2VP超の相手からしか奪えない。
   *  合法ヘックスが無い場合は盗賊を砂漠へ。 */
  friendlyRobber?: boolean;
  /** 交易と蛮族「イベントカード(Catan Event Cards)」変種を有効化（既定false・CN3089 p4-6）。
   *  生産フェーズで赤黄ダイスの代わりにイベントデッキの一番上をめくり、イベント効果を解決してから
   *  カードの数字ディスク値で「資源生産」または「7の解決」を行う。New Year でデッキ再構築。 */
  eventCards?: boolean;
  /** 交易と蛮族「Catan for Two（2人用）」変種を有効化（既定false・CN3089 p7）。
   *  実プレイヤー2人＋中立プレイヤー2人（残り2色）。生産フェーズ×2回・建設のたび中立の道/開拓地を
   *  無償配置・trade token 経済（Forced Trade / Move Robber）。実プレイヤーは厳密に2人。 */
  catanForTwo?: boolean;
}

// 航海者 S5「忘れられた部族」/「宝島」: 海の辺に事前配置されるトークンの種別。
//   vp=VPトークン(+1点) / dev=開発カード(今ターン購入扱い) / harbor=港(沿岸の自分の建物隣に設置)
//   treasure=財宝（宝島・船で到達すると資源2枚 or 開発カード1枚を獲得）。
export type EdgeTokenKind = 'vp' | 'dev' | 'harbor' | 'treasure';

// ---- 交易と蛮族「イベントカード(Catan Event Cards)」変種（CN3089 p4-6） ----
// 13種のイベント。new_year のみ生産数字なし（デッキ再構築専用）。
export type TbEventType =
  | 'beautiful_day'    // 良き日: 効果なし・通常生産
  | 'calm_seas'        // 穏やかな海: 港上の建物「数」最多者が任意資源1枚
  | 'conflict'         // 衝突: 最大騎士力タイル保持者（無ければ騎士カード最多の単独者）が無作為1枚強奪
  | 'earthquake'       // 地震: 各自 自分の道1本を損傷（修理まで道建設不可等）
  | 'epidemic'         // 疫病: 今回の生産は都市も資源1枚のみ
  | 'good_neighbors'   // 良き隣人: 各自 左隣へ任意資源1枚
  | 'helpful_neighbor' // 親切な隣人: VP最多者が「より少ない者」へ任意資源1枚
  | 'new_year'         // 新年: デッキ再構築→上を1枚めくって通常解決
  | 'plentiful_year'   // 豊作の年: 各自 供給から任意資源1枚
  | 'robber_attacks'   // 盗賊の襲撃: 7として解決（捨て札＋盗賊起動）
  | 'robber_flees'     // 盗賊の逃走: 盗賊を砂漠へ（奪わない）。砂漠が無ければ盤外へ
  | 'tournament'       // 馬上槍試合: 表向き騎士カード最多者が任意資源1枚
  | 'trade_advantage'; // 交易優位: 最長交易路タイル保持者が無作為1枚強奪

export interface TbEventCard {
  readonly event: TbEventType;
  /** 生産数字ディスク(2-12)。new_year のみ null。 */
  readonly number: number | null;
}

// ---- GameState ----

export interface GameState {
  // ボード（Record = JSON シリアライズ可）
  tiles: Record<TileId, Tile>;
  vertices: Record<VertexId, Vertex>;
  edges: Record<EdgeId, Edge>;
  harbors: Harbor[];
  tileToVertices: Record<TileId, VertexId[]>;
  tileToEdges: Record<TileId, EdgeId[]>;

  players: Record<string, Player>; // PlayerId → Player
  playerOrder: PlayerId[];

  bank: ResourceHand;
  // 騎士と商人: 商品(コモディティ)の銀行在庫。バンク交易/産出で増減し枯渇したら配れない。非CKでは未設定。
  commodityBank?: CommodityHand;
  // 騎士と商人(Cities & Knights)拡張が有効か。未設定=基本/航海者ルール。
  expansion?: 'cities_knights';
  // 騎士と商人: 蛮族船の進行度(0..7)。7で襲来して判定後 0 に戻る。
  barbarianPosition?: number;
  // 騎士と商人: これまでの蛮族襲来回数。
  barbarianAttacks?: number;
  // 騎士と商人: 直近のイベントダイスの目（'ship'=蛮族前進 / 色=進歩カード抽選）。
  lastEventDie?: 'ship' | CkTrack;
  // 騎士と商人: 直近に使われた進歩カード（公開情報）。使用した瞬間に種類を全員へ見せる演出に使う。
  // LANでは使用者の手札がマスクされ札種を引けないため、ここに公開で載せて他プレイヤーにも表示できるようにする。
  lastProgressPlay?: { playerId: PlayerId; cardType: ProgressCardType } | null;
  // 騎士と商人: 各メトロポリスの保持者と所在頂点（ツリーごとに最大1人・盤面で一意）。
  // Lv5到達者が Lv4保持者から奪取するために頂点IDを保持する。
  metropolis?: Partial<Record<CkTrack, { playerId: PlayerId; vertexId: VertexId }>>;
  // 騎士と商人: 進歩カードの山札（ツリー別）。
  progressDecks?: Record<CkTrack, ProgressCard[]>;
  // 騎士と商人: 商人(merchant)コマの保持者と所在タイル（盤面で一意・移動式・+1VP/2:1）。
  merchant?: { playerId: PlayerId; tileId: TileId } | null;
  // 騎士と商人: 錬金術師(alchemist)で事前指定した次ROLL_DICEの目。消費したら null。
  alchemistForcedDice?: [number, number] | null;

  devDeck: DevCard[];
  devDiscardPile: DevCard[];

  phase: GamePhase;
  turnPhase: TurnPhase;
  currentPlayerIndex: number;

  // 手番単位のインクリメント（個人ターンごと+1）。
  // purchasedOnTurn < globalTurnNumber なら使用可能。
  globalTurnNumber: number;

  // MAIN / GAME_OVER では null
  setupSubPhase: SetupSubPhase | null;

  // セットアップで直前に置いた開拓地の頂点。直後の道はこの開拓地に接続せねばならない
  // （標準ルール）。PLACE_ROAD 解決後は null に戻す。未設定時は従来の接続判定にフォールバック。
  setupRoadAnchor?: VertexId | null;

  lastDiceRoll: [number, number] | null;
  // このターンにダイスを振ったか（騎士カードをダイス前に使用した場合の判別用）
  diceRolledThisTurn: boolean;
  // 街道建設カードで残り無料配置できる道路数（0=通常モード、1 or 2=無料配置中）
  roadBuildingRoadsRemaining: number;
  // 航海者: このターンに船を移動したか（航海は1ターン1回）。END_TURN でリセット。
  shipMovedThisTurn?: boolean;
  // 航海者: このターンに建設した船の辺ID（建てたばかりの船は移動できない）。END_TURN でリセット。
  shipsBuiltThisTurn?: EdgeId[];
  // 騎士と商人: このターンに騎士を移動したか（移動は1ターン1回）。END_TURN でリセット。
  knightMovedThisTurn?: boolean;
  // 騎士と商人: このターンに騎士で強盗を追い払ったか（1ターン1回）。END_TURN でリセット。
  knightChasedThisTurn?: boolean;
  // 航海者: 海賊コマの現在地（海タイルID）。未配置は undefined。盗賊の海版で、隣接する
  // 自分の船建設を封じ、隣接船の所有者から1枚奪える。基本ゲームでは未使用。
  piratePosition?: TileId;
  // このターンに騎士・進歩カードを使ったか（1ターン1枚制限）
  devCardPlayedThisTurn: boolean;

  longestRoadHolder: PlayerId | null;
  largestArmyHolder: PlayerId | null;
  // 交易と蛮族「強き港」: Strongest Ports タイル(+2VP)の現保持者。港建物VP最多（最低3VP・同点は現保持者優先）。
  // strongestPorts が有効なシナリオのみ設定。null=未取得。
  strongestPortsHolder?: PlayerId | null;

  // 勝利に必要な勝利点。シナリオ別（基本=10／航海者の大きい盤=13）。未設定は VP_TABLE.target。
  victoryTarget?: number;

  // 現在プレイ中のシナリオID（遊び方オーバーレイの「このゲーム固有ルール」表示等に使う）。
  // 値は ScenarioId（engine/scenarios.ts）。循環import回避のため型は string。
  scenarioId?: string;

  // 航海者拡張: 「新しい島への最初の入植」ボーナス。島の代表タイルID → その島で自分の初入植
  // ボーナスを獲得済みのプレイヤー一覧。各プレイヤーが「自分が初めてその島へ建てた」とき +newIslandBonusVp
  // を得る（公式: 他人が先に建てていても各自獲得可。よって1島に複数人が載りうる）。
  // 基本ゲームでは常に空（海タイルが無く発生しない）。
  islandBonus?: Record<string, PlayerId[]>;
  // 航海者拡張: 新島初入植ボーナスのVP値（既定2。七不思議/New World は1）。未設定は VP_TABLE.island。
  newIslandBonusVp?: number;
  // 航海者拡張: シナリオ固有ルールのトグル（既定値は基本/航海者共通）。createInitialGameState が
  // ScenarioRules から配線する。未設定はそれぞれ 2 / true / true の既定で扱う。
  startingSettlements?: number;   // 初期配置の開拓地数（既定2。S6 織物=3）
  setupRound?: number;            // 初期配置スネークドラフトの現ラウンド番号（1始まり。advanceSetupが進行）
  useLongestRoute?: boolean;      // 最長交易路タイルを使うか（既定true。S6/S7=false）
  useLargestArmy?: boolean;       // 最大騎士力タイルを使うか（既定true。S7=false）
  useRobber?: boolean;            // 7/盗賊・海賊を使うか（既定true。S7=false。騎士も使用不可）
  setupAnywhere?: boolean;        // 初期配置をどの島にも置けるか（既定false。S2/New World=true）
  numberHexOnly?: boolean;        // 開拓地・盗賊を数字ヘックスのみに制限（既定false。S5=true）
  noIslandSettlement?: boolean;   // 小島（本島以外）に開拓地を建てられない（既定false。S6=true）
  noShips?: boolean;              // 船を一切使わない盤か（既定false。オアシス=true。海タイルはあるが船UIを出さない）
  strongestPorts?: boolean;       // 交易と蛮族「強き港」変種が有効か（既定false）。ScenarioRules から配線。
  friendlyRobber?: boolean;       // 交易と蛮族「親切な盗賊」変種が有効か（既定false）。ScenarioRules から配線。

  // ---- 交易と蛮族「イベントカード(Catan Event Cards)」変種（CN3089 p4-6） ----
  tbEventCards?: boolean;         // 変種が有効か（既定false）。ScenarioRules.eventCards から配線。
  // イベントデッキ（先頭=一番上）。作成手順: New Year を除く36枚シャッフル→5枚を底に→その上に
  // New Year→残り31枚を上に積む。LAN では中身（並び順）を秘匿し枚数のみ配信（mask.ts）。
  tbEventDeck?: TbEventCard[];
  // 直近の ROLL_DICE でめくったカード（表示・履歴用）。New Year 再構築後にめくった通常カードが入る。
  tbLastEventCard?: TbEventCard | null;
  // 直近の ROLL_DICE で New Year が出てデッキを再構築したか（演出用）。
  tbNewYearRebuilt?: boolean;
  // イベントの選択解決（EVENT_* / GOLD）が全て終わった後に実行する生産の数字。null=保留なし。
  tbPendingEventNumber?: number | null;
  // イベント「疫病(EPIDEMIC)」: このターンの生産で都市も資源1枚のみ（END_TURN でリセット）。
  tbEpidemic?: boolean;
  // イベント「良き隣人(GOOD NEIGHBORS)」: 未解決の giver → 受取人（左隣）。全員解決で生産へ。
  tbPendingEventGive?: Record<string, PlayerId>;
  // イベント「親切な隣人(HELPFUL NEIGHBOR)」: 未解決の giver（公開VP最多者）一覧。
  tbPendingEventHelpful?: PlayerId[];
  // イベント「衝突(CONFLICT)/交易優位(TRADE ADVANTAGE)」: 奪う側と任意性（衝突の騎士カード最多者は may）。
  tbPendingEventSteal?: { playerId: PlayerId; optional: boolean } | null;
  // イベント「地震(EARTHQUAKE)」: 損傷させる道が未選択のプレイヤー一覧。
  tbPendingEventDamage?: PlayerId[];

  // ---- 交易と蛮族「Catan for Two（2人用）」変種（CN3089 p7） ----
  tbCatanForTwo?: boolean;        // 変種が有効か（既定false）。ScenarioRules.catanForTwo から配線。
  // 中立プレイヤー（残り2色）。players に実体（type:'neutral'）を持つが playerOrder には入らない。
  tbNeutralPlayerIds?: PlayerId[];
  // 実プレイヤー別の trade token 保有数（公開情報。マスク不要）。
  tbTradeTokens?: Record<string, number>;
  // trade token の供給残数（総数20 − 初期配布5×2 = 10 から増減）。
  tbTradeTokenBank?: number;
  // TB_NEUTRAL フェーズで配置待ちの中立コマ種別（null=待ちなし）。
  tbNeutralPending?: 'road' | 'settlement' | null;
  // このターンに trade token を消費したか（Forced Trade / Move Robber は合わせて1ターン1回）。
  tbTradeTokenSpentThisTurn?: boolean;
  // このターンに騎士カード捨て→トークン2 を使ったか（1ターン1回）。
  tbKnightTokenThisTurn?: boolean;
  // このターンに解決済みの生産フェーズ数(0..2)。2回終えるまでアクションフェーズへ進まない。
  tbRollsDone?: number;
  // 1回目の生産フェーズの合計出目（2回目はこれと異なる合計まで振り直し）。END_TURN でリセット。
  tbFirstRollTotal?: number | null;
  maxCities?: number;             // 1プレイヤーの都市建設上限（既定なし。大カタン=8）
  // 大カタン「抜けている数値トークン」: 残りの供給枚数。0になると以後は本島の数字を抜いて小島へ配る。
  numberTokenSupply?: number;
  // 砂漠を越えて: 特別VP「地域ボーナス」。北西地方のタイル群＋VP値＋獲得済みプレイヤー。
  bonusRegionTiles?: TileId[];    // この地域に隣接して初入植すると regionBonusVp を得る対象タイル
  regionBonusVp?: number;         // 地域への初入植ボーナスVP（砂漠を越えて=2。既定0）
  regionBonus?: PlayerId[];       // 地域ボーナスを既に得たプレイヤー（重複防止・公開情報）
  // 航海者 S5「忘れられた部族」: 海の辺に事前配置されたトークン（船で到達すると獲得）。辺ID→種別。
  edgeTokens?: Record<string, EdgeTokenKind>;
  // S5: 各プレイヤーが集めたVPトークン数（各+1VP・公開情報）。
  tokenVp?: Record<string, number>;
  // S5: 港トークンを得たが置き場（沿岸の自分の建物）が無く保留中の数。次の沿岸開拓地で設置。
  heldHarbors?: Record<string, number>;
  // 航海者 S6「カタンの織物」: 村（小島の数字ヘックス）の残り織物供給。タイルID→残数（初期5）。
  villages?: Record<string, number>;
  // S6: 各村に航路（船）接続済みのプレイヤー一覧。
  villageConn?: Record<string, string[]>;
  // S6: 各プレイヤーの織物トークン数（2枚で1VP・公開情報）。
  cloth?: Record<string, number>;
  // 航海者 S8「カタンの七不思議」: 各不思議のクレーム者（不思議ID→PlayerId・1人1つ早い者勝ち）。
  wonderOwner?: Record<string, PlayerId>;
  // S8: 各プレイヤーの不思議建設レベル（0..4・レベル4で完成）。存在＝七不思議シナリオ。
  wonderLevel?: Record<string, number>;
  // 航海者 S7「海賊の島々」: 各プレイヤーの要塞（攻略対象の頂点＋ラホHP＋奪取済みフラグ）。存在＝S7。
  fortresses?: Record<string, { vertexId: string; raho: number; captured: boolean }>;
  // S7: 海賊艦隊。固定経路 path（タイルID列）上を pos の位置で巡回し、ダイス後に小さい目の数だけ前進。
  pirateFleet?: { path: string[]; pos: number };
  // 航海者拡張: 各プレイヤーが初期配置した島の代表ID一覧（=自分のホーム島群）。
  // setupAnywhere のシナリオで「未探検島＝自分のホーム以外」をプレイヤー別に判定するために使う。
  // 初期配置中に BUILD_SETTLEMENT が記録する。基本/S1系では全員が本島のみ。
  playerHomeIslands?: Record<string, string[]>;

  // 航海者拡張: 金タイル産出で「任意資源を選ぶ権利」の残数。PlayerId → 選ぶ枚数。
  // turnPhase==='GOLD' の間だけ非空。各プレイヤーが CHOOSE_GOLD で解決し、全員空になると
  // TRADE_BUILD へ進む（DISCARD と同様の多人数解決）。基本ゲームでは常に未使用。
  pendingGoldChoice?: Record<string, number>;

  // 騎士と商人: 蛮族敗北で「都市1つを格下げする」必要があるプレイヤー（最弱・平の都市持ち）。
  // turnPhase==='CITY_DOWNGRADE' の間だけ非空。各自 DOWNGRADE_CITY で解決し、全員空になると
  // 生産/捨て札など本来の続きへ進む（DISCARD と同様の多人数解決）。
  pendingCityDowngrade?: PlayerId[];

  // 騎士と商人: 進歩カードの手札上限(4・VPカード除外)を超えて引いたため、捨てる1枚を選ぶ必要が
  // あるプレイヤー。turnPhase==='PROGRESS_DISCARD' の間だけ非空。各自 DISCARD_PROGRESS で解決。
  pendingProgressDiscard?: PlayerId[];

  pendingTrade: PendingTrade | null;
  winner: PlayerId | null;

  // DISCARD フェーズで既に捨てたプレイヤーを記録（15枚以上所持時の二重捨て防止）
  discardedThisRound: PlayerId[];

  log: LogEntry[];
}

// ---- ログ ----

export type LogEntryType =
  | 'DICE_ROLL' | 'RESOURCE_GAIN' | 'BUILD' | 'TRADE_BANK'
  | 'TRADE_PLAYER' | 'DEV_CARD' | 'ROBBER' | 'BONUS_CHANGE' | 'VICTORY' | 'DISCARD'
  | 'SYSTEM';

export interface LogEntry {
  readonly turn: number;
  readonly playerId: PlayerId;
  readonly type: LogEntryType;
  readonly message: string;
}

// ---- アクション ----

// 進歩カードの「プレイヤーが選ぶ」対象（公式準拠）。
//   資源独占=resource / 交易独占=commodity / 大商人=targetPlayerId。未指定なら自動最善で解決。
export interface ProgressChoice {
  resource?: ResourceType;
  commodity?: CommodityType;
  targetPlayerId?: PlayerId;
  // 錬金術師: 次のダイス目（赤・黄 各1〜6）を自分で指定。
  dice?: readonly [number, number];
  // 発明家: 数字トークンを入れ替える2タイルのID。
  inventorTiles?: readonly [TileId, TileId];
  // 商人: 商人コマを置く資源タイルのID（自分の建物に隣接する陸タイル）。
  merchantTileId?: TileId;
  // クレーン: 1段安く改善するトラック（交易/政治/科学）。
  craneTrack?: CkTrack;
  // クレーン: Lv4到達でメトロポリス化する自分の都市の頂点ID（未指定/不正なら先頭へ自動）。
  //   改善ボタン(BUILD_IMPROVEMENT.metropolisVertexId)と同じ役割を、クレーン経由の改善に与える。
  craneMetropolisVertexId?: VertexId;
  // 僧正(bishop): 盗賊を置くタイルのID（隣接する全相手から1枚ずつ奪う）。
  bishopTileId?: TileId;
  // 外交官(diplomat): 撤去する相手の「端の道」の辺ID。
  diplomatEdgeId?: EdgeId;
  // 脱走兵(deserter): 消す相手の騎士の頂点ID（同強度の騎士を自分が得る）。
  deserterVertexId?: VertexId;
  // 脱走兵(deserter): 獲得した騎士を置く自分の頂点ID（未指定/不正なら自動で最初の合法頂点へ）。
  deserterPlaceVertexId?: VertexId;
  // 医術(medicine): 都市に格上げする自分の開拓地の頂点ID。
  medicineVertexId?: VertexId;
  // 商業港(commercial_harbor): 各相手に渡す自分の資源1種＋各相手から要求する商品1種を指名（全相手共通）。
  commercialGive?: ResourceType;
  commercialTake?: CommodityType;
  // 商船隊(merchant_fleet): このターン 2:1 で交易する1種（資源 or 商品）。
  fleetType?: TradeKind;
  // 鍛冶屋(smith): 1段昇格する自分の騎士の頂点ID（最大2体）。
  smithVertexIds?: readonly VertexId[];
  // 技師(engineer): 城壁を建てる自分の都市の頂点ID。
  engineerVertexId?: VertexId;
  // 陰謀(intrigue): 退去させる「自分の道/船に隣接する敵騎士」の頂点ID。
  intrigueVertexId?: VertexId;
  // スパイ(spy): 進歩カードを盗む相手と、盗む札のID（公式: 相手の手札を見て1枚選ぶ）。
  spyTargetPlayerId?: PlayerId;
  spyCardId?: string;
}

export type Action =
  | { type: 'ROLL_DICE' }
  | { type: 'MOVE_ROBBER';         tileId: TileId; stealFromPlayerId: PlayerId | null }
  | { type: 'MOVE_PIRATE';         tileId: TileId; stealFromPlayerId: PlayerId | null }
  | { type: 'DISCARD_RESOURCES';   playerId: PlayerId; resources: Partial<ResourceHand>; commodities?: Partial<CommodityHand> }
  | { type: 'DOWNGRADE_CITY';      playerId: PlayerId; vertexId: VertexId } // 蛮族敗北で都市を格下げ
  | { type: 'DISCARD_PROGRESS';    playerId: PlayerId; cardId: string }     // 進歩カード上限超過で1枚捨てる
  | { type: 'BUILD_ROAD';          edgeId: EdgeId }
  | { type: 'BUILD_SHIP';          edgeId: EdgeId }
  | { type: 'MOVE_SHIP';           fromEdgeId: EdgeId; toEdgeId: EdgeId }
  | { type: 'CHOOSE_GOLD';         playerId: PlayerId; resources: Partial<ResourceHand> }
  | { type: 'CHOOSE_EVENT_GIVE';   playerId: PlayerId; resource: ResourceType }                       // T&Bイベント「良き隣人」: 左隣へ渡す資源
  | { type: 'CHOOSE_EVENT_HELPFUL'; playerId: PlayerId; resource: ResourceType; toPlayerId: PlayerId } // T&Bイベント「親切な隣人」: 渡す資源と相手
  | { type: 'CHOOSE_EVENT_STEAL';  targetPlayerId: PlayerId | null }                                  // T&Bイベント「衝突/交易優位」: 奪う相手（nullは任意時の見送り）
  | { type: 'CHOOSE_EVENT_DAMAGE'; playerId: PlayerId; edgeId: EdgeId }                               // T&Bイベント「地震」: 損傷させる自分の道
  | { type: 'REPAIR_ROAD';         edgeId: EdgeId }                                                   // T&Bイベント「地震」: 損傷道の修理（レンガ1木1）
  | { type: 'TB_NEUTRAL_ROAD';       owner: PlayerId; edgeId: EdgeId }     // T&B 2人用: 中立の道を無償配置（手番プレイヤーが owner と位置を選ぶ）
  | { type: 'TB_NEUTRAL_SETTLEMENT'; owner: PlayerId; vertexId: VertexId } // T&B 2人用: 中立の開拓地を無償配置
  | { type: 'TB_FORCED_TRADE';       give: Partial<ResourceHand> }         // T&B 2人用: トークン消費・強制交易（相手の無作為2枚⇄自分の任意2枚）
  | { type: 'TB_MOVE_ROBBER' }                                             // T&B 2人用: トークン消費・盗賊を砂漠へ（奪わない）
  | { type: 'TB_DISCARD_KNIGHT' }                                          // T&B 2人用: 表向き騎士カード1枚を捨てて trade token 2
  | { type: 'BUILD_SETTLEMENT';    vertexId: VertexId }
  | { type: 'BUILD_CITY';          vertexId: VertexId }
  | { type: 'BUILD_WONDER';        wonderId: string } // 航海者 S8: 不思議のレベルを1段建設（必要ならクレーム）
  | { type: 'ATTACK_FORTRESS' }                       // 航海者 S7: 隣接する自分の要塞をラホ1つ分攻撃
  | { type: 'BUY_DEV_CARD' }
  | { type: 'PLAY_KNIGHT' }
  | { type: 'PLAY_ROAD_BUILDING' }
  | { type: 'PLAY_YEAR_OF_PLENTY'; resources: [ResourceType, ResourceType] }
  | { type: 'PLAY_MONOPOLY';       resource: ResourceType }
  | { type: 'BANK_TRADE';          give: TradeKind; receive: TradeKind }
  | { type: 'BUILD_KNIGHT';        vertexId: VertexId }
  | { type: 'ACTIVATE_KNIGHT';     vertexId: VertexId }
  | { type: 'UPGRADE_KNIGHT';      vertexId: VertexId }
  | { type: 'BUILD_IMPROVEMENT';   track: CkTrack; metropolisVertexId?: VertexId } // metropolisVertexId: Lv4+到達時にメトロポリス化する都市を手動指定（任意）
  | { type: 'BUILD_CITY_WALL';     vertexId: VertexId }
  | { type: 'MOVE_KNIGHT';         fromVertexId: VertexId; toVertexId: VertexId }
  | { type: 'CHASE_ROBBER';        vertexId: VertexId } // 騎士で強盗を追い払う（ROBBERフェーズへ遷移）
  | { type: 'PLAY_PROGRESS';       cardId: string; choice?: ProgressChoice; cardType?: ProgressCardType } // cardType: 使用札の種類（公開情報）。LANで他プレイヤーが盤面表示するため送信側が付与する。
  | { type: 'OFFER_TRADE';         offer: TradeOffer; targetPlayerIds: PlayerId[] }
  | { type: 'RESPOND_TRADE';       response: PlayerResponse }
  | { type: 'CONFIRM_TRADE';       responderId: PlayerId }
  | { type: 'CANCEL_TRADE' }
  | { type: 'FINISH_ROAD_BUILDING' }
  | { type: 'END_TURN' }
  | { type: 'DECLARE_VICTORY' };
