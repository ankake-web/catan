// ============================================================
// src/constants.ts — ゲーム定数
// ============================================================

import type { AxialCoord, ResourceType, TileType, DevCardType, ResourceHand, CommodityType, CommodityHand, CkTrack, ProgressCardType } from './types';

// ---- リソース ----

export const RESOURCE_TYPES: ResourceType[] = ['wood', 'brick', 'wool', 'grain', 'ore'];

// ---- 騎士と商人(Cities & Knights): 商品(コモディティ) ----
export const COMMODITY_TYPES: CommodityType[] = ['coin', 'cloth', 'paper'];

/** 全コモディティキーを含む CommodityHand を生成。省略キーは 0。 */
export function makeCommodities(partial: Partial<CommodityHand> = {}): CommodityHand {
  return { coin: 0, cloth: 0, paper: 0, ...partial };
}

/** 騎士と商人: 商品銀行の初期在庫（資源バンクと対称に各19）。実質枯渇しないが供給の有限性を表す。 */
export const COMMODITY_BANK_INITIAL: CommodityHand = { coin: 19, cloth: 19, paper: 19 };

// 都市が追加産出する商品の対応（森→紙 / 牧草→布 / 山→金貨）。他地形は商品なし。
export const TILE_COMMODITY_MAP: Record<TileType, CommodityType | null> = {
  forest:   'paper',
  pasture:  'cloth',
  mountain: 'coin',
  field:    null,
  hill:     null,
  desert:   null,
  sea:      null,
  gold:     null,
};

export const TILE_RESOURCE_MAP: Record<TileType, ResourceType | null> = {
  forest:   'wood',
  field:    'grain',
  pasture:  'wool',
  hill:     'brick',
  mountain: 'ore',
  desert:   null,
  sea:      null, // 海は産出なし
  gold:     null, // 金は任意資源（産出時に選択。固定の対応資源は持たない）
};

export const TILE_COUNTS: Record<TileType, number> = {
  forest: 4, field: 4, pasture: 4, hill: 3, mountain: 3, desert: 1,
  // 基本盤には存在しない（航海者シナリオ側で個別に配置する）
  sea: 0, gold: 0,
};

// ---- 建設コスト ----

/** 全リソースキーを含む ResourceHand を生成。省略キーは 0 として扱う。 */
export function makeHand(partial: Partial<ResourceHand> = {}): ResourceHand {
  return { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0, ...partial };
}

// Partial<ResourceHand> ではなく ResourceHand を使用（undefined − n = NaN を防ぐ）
export const BUILD_COSTS: Record<'road' | 'ship' | 'settlement' | 'city' | 'dev_card', ResourceHand> = {
  road:       makeHand({ wood: 1, brick: 1 }),
  ship:       makeHand({ wood: 1, wool: 1 }), // 航海者: 船＝木＋羊
  settlement: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }),
  city:       makeHand({ grain: 2, ore: 3 }),
  dev_card:   makeHand({ wool: 1, grain: 1, ore: 1 }),
};

export const PIECE_LIMITS = {
  roads: 15,
  ships: 15,
  settlements: 5,
  cities: 4,
  knights: 6, // 騎士と商人: 騎士コマ上限
} as const;

// ---- 騎士と商人(Cities & Knights) ----
export const CK_VICTORY_TARGET = 13;
export const CK_COSTS = {
  knightBuild:    makeHand({ ore: 1, wool: 1 }),  // 騎士1体（基本・非起動）
  knightUpgrade:  makeHand({ ore: 1, wool: 1 }),  // 強さ+1
  knightActivate: makeHand({ grain: 1 }),         // 起動（麦1）
  cityWall:       makeHand({ brick: 2 }),          // 城壁（手札上限+2）
};
export const CK_TRACK_COMMODITY: Record<CkTrack, CommodityType> = {
  trade: 'cloth', politics: 'coin', science: 'paper',
};
export const CK_TRACK_NAME: Record<CkTrack, string> = {
  trade: '交易', politics: '政治', science: '科学',
};
export const CK_MAX_IMPROVEMENT = 5;     // 都市改善の最大レベル
export const CK_METROPOLIS_LEVEL = 4;    // この到達でメトロポリス化
export const CK_BARBARIAN_MAX = 7;       // 蛮族船がこの距離で襲来
export const CK_WALL_DISCARD_BONUS = 2;  // 城壁1つにつき7の捨て札上限+2
export const CK_MAX_WALLS = 3;
/** 都市改善 level→level+1 のコスト（その商品を level+1 個）。 */
export function improvementCost(currentLevel: number): number {
  return currentLevel + 1;
}

// ---- 進歩カード ----
export const PROGRESS_HAND_LIMIT = 4;
// 各ツリーのデッキに含めるカード種別（公式の3デッキ。枚数は PROGRESS_DECK_COUNTS）。
export const PROGRESS_DECK_CARDS: Record<CkTrack, ProgressCardType[]> = {
  science:  ['alchemist', 'crane', 'engineer', 'inventor', 'irrigation', 'medicine', 'mining', 'printer', 'road_building_progress', 'smith'],
  trade:    ['commercial_harbor', 'master_merchant', 'merchant', 'merchant_fleet', 'resource_monopoly', 'trade_monopoly'],
  politics: ['bishop', 'constitution', 'deserter', 'diplomat', 'intrigue', 'saboteur', 'spy', 'warlord', 'wedding'],
};
// 各種別のデッキ内枚数（公式の枚数配分。各デッキ計18枚）。
export const PROGRESS_DECK_COUNTS: Record<ProgressCardType, number> = {
  // science（計18）
  alchemist: 2, crane: 2, engineer: 1, inventor: 2, irrigation: 2,
  medicine: 2, mining: 2, printer: 1, road_building_progress: 2, smith: 2,
  // trade（計18）
  commercial_harbor: 2, master_merchant: 2, merchant: 6,
  merchant_fleet: 2, resource_monopoly: 4, trade_monopoly: 2,
  // politics（計18）
  bishop: 2, constitution: 1, deserter: 2, diplomat: 2, intrigue: 2,
  saboteur: 2, spy: 3, warlord: 2, wedding: 2,
};
export const PROGRESS_CARD_NAME: Record<ProgressCardType, string> = {
  smith: '鍛冶屋', engineer: '技師', irrigation: '灌漑', mining: '採掘',
  alchemist: '錬金術師', crane: 'クレーン', inventor: '発明家', medicine: '医術', printer: '印刷機', road_building_progress: '街道建設',
  resource_monopoly: '資源独占', trade_monopoly: '交易独占', master_merchant: '大商人',
  commercial_harbor: '商業港', merchant: '商人', merchant_fleet: '商船隊',
  warlord: '将軍', saboteur: '破壊工作員', wedding: '婚礼',
  bishop: '僧正', constitution: '憲法', deserter: '脱走兵', diplomat: '外交官', intrigue: '陰謀', spy: 'スパイ',
};
export const PROGRESS_CARD_DESC: Record<ProgressCardType, string> = {
  smith: '騎士を最大2体まで無料で1段昇格',
  engineer: '城壁を1つ無料で建設',
  irrigation: '建物に隣接する畑1つにつき麦2',
  mining: '建物に隣接する山1つにつき鉱石2',
  alchemist: '次のダイスの目を自分で決めてから振る',
  crane: '都市の改善トラック（交易/政治/科学）を1段、必要な商品より1個少なく上げる',
  inventor: '数字トークン2枚を入れ替え（2/6/8/12以外）',
  medicine: '開拓地を都市に格上げ（通常より安い 麦1＋鉱石2 で）',
  printer: '即座に+1勝利点',
  road_building_progress: '道を2本まで無料で建設',
  resource_monopoly: '各相手から最良の資源を2枚ずつ',
  trade_monopoly: '各相手から最良の商品を1枚ずつ',
  master_merchant: 'VP最多の相手から無作為に2枚',
  commercial_harbor: '各相手と 自分の資源1⇄相手の商品1 を交換',
  merchant: '資源地形に商人を置く（+1VP・その資源2:1）',
  merchant_fleet: 'このターン、指定1種を2:1で交易',
  warlord: '自分の騎士を全て無料で起動',
  saboteur: '自分以上のVPを持つ全員が資源を半数捨てる',
  wedding: '自分よりVPが高い各相手から2枚もらう',
  bishop: '盗賊を移動し移動先隣接の全相手から各1枚',
  constitution: '即座に+1勝利点',
  deserter: '相手の騎士を1体消し、自分は同強度の騎士を得る',
  diplomat: '端の道1本を撤去（自分の道なら再建設）',
  intrigue: '自分の道に隣接する敵騎士を1体退去',
  spy: '相手の進歩カードを1枚奪う',
};

// ---- バンク初期値 ----

export const BANK_INITIAL: ResourceHand = makeHand({
  wood: 19, brick: 19, wool: 19, grain: 19, ore: 19,
});

// ---- 発展カード ----

export const DEV_CARD_COUNTS: Record<DevCardType, number> = {
  knight:         14,
  road_building:   2,
  year_of_plenty:  2,
  monopoly:        2,
  victory_point:   5,
};

// ---- 勝利点 ----

export const VP_TABLE = {
  settlement:   1,
  city:         2,
  longestRoad:  2,
  largestArmy:  2,
  victoryPoint: 1,
  island:       2, // 航海者: 新しい島への最初の入植ボーナス
  strongestPorts: 2, // 交易と蛮族「強き港」: Strongest Ports タイルの勝利点
  target:       10,
} as const;

export const LONGEST_ROAD_MIN = 5;
export const LARGEST_ARMY_MIN = 3;
// 交易と蛮族「強き港」: 港上の建物のVP合計がこの値以上で Strongest Ports タイルを獲得できる（公式: 3VP）。
export const STRONGEST_PORTS_MIN = 3;

// ---- 強盗 ----

export const DICE_ROBBER_NUMBER      = 7;
export const ROBBER_HAND_DISCARD_MIN = 8; // 手札がこの枚数以上で半数捨て
// 交易と蛮族「親切な盗賊(The Friendly Robber)」: 公開VPがこの値以下のプレイヤーは保護される
// （公式 CN3089 p3: "a player who only has 2 VPs" の建物ヘックスへ盗賊を動かせず、
//   奪えるのは "more than 2 VPs" のプレイヤーのみ）。
export const FRIENDLY_ROBBER_SAFE_VP = 2;

// ---- 交易タイムアウト ----

export const TRADE_TIMEOUT_HUMAN_MS = 60_000;
export const TRADE_TIMEOUT_AI_MS    =  3_000;

// ---- ボード ----

export const HEX_SIZE = 60; // SVGピクセル単位

// フラットトップ六角形の6方向ベクトル（0°から60°刻み）
// ピクセル上の方向: dir0=SE, dir1=NE, dir2=N, dir3=NW, dir4=SW, dir5=S
export const HEX_DIRECTIONS: readonly AxialCoord[] = [
  { q:  1, r:  0 }, // 0: q+1      → 画面右下 (SE)
  { q:  1, r: -1 }, // 1: q+1, r-1 → 画面右上 (NE)
  { q:  0, r: -1 }, // 2: r-1      → 画面上   (N)
  { q: -1, r:  0 }, // 3: q-1      → 画面左上 (NW)
  { q: -1, r:  1 }, // 4: q-1, r+1 → 画面左下 (SW)
  { q:  0, r:  1 }, // 5: r+1      → 画面下   (S)
] as const;

// 数字トークン配置（アルファベット順：2〜12、7除く）
export const NUMBER_TOKENS: readonly number[] = [
  2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12,
];
