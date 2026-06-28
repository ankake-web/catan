// ============================================================
// src/engine/scenarios.ts — 盤面シナリオ登録（基本／航海者）
// ============================================================
//
// 盤面生成を「シナリオ」として抽象化する。各シナリオは
//   - coords(): タイル座標集合（盤面幾何 buildBoardGeometry の入力）
//   - build(geo, rng): タイル種別・数字・港の割り当て
// を返す。既定は 'classic'（基本カタン）で、既存の生成（createRandomBoard）に委譲する
// ため挙動は不変。航海者は 'seafarers_*' として追加する。
//
// 注意: 純粋関数（DOM非依存）。createInitialGameState から使う。

import type { AxialCoord, Tile, TileId, TileType, Harbor, HarborType, ScenarioRules } from '../types';
import { getAllTileCoords, getHexRegion, tileId, parseTileId, edgeTileIds, type BoardGeometry } from './board';
import { createRandomBoard } from './setup';

export type ScenarioId =
  | 'classic'
  | 'seafarers_newshores'
  | 'seafarers_archipelago'
  | 'seafarers_throughdesert'
  | 'seafarers_goldenisles'
  | 'seafarers_chainisles'
  | 'seafarers_greatercatan'
  | 'cities_knights';

export interface ScenarioBoard {
  tiles: Record<TileId, Tile>;
  harbors: Harbor[];
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: string;
  /** UI 用の1行説明。 */
  readonly description: string;
  /** UI のグルーピング用カテゴリ。 */
  readonly category: 'basic' | 'seafarers' | 'cities_knights';
  /** 騎士と商人拡張を有効化する（GameState.expansion に反映）。 */
  readonly expansion?: 'cities_knights';
  /** タイル座標集合（盤面幾何の生成に使う）。航海者の可変盤ではここを差し替える。 */
  coords(): AxialCoord[];
  /** 幾何確定後にタイル種別・数字・港を割り当てる。 */
  build(geo: BoardGeometry, rng: () => number): ScenarioBoard;
  /** 勝利に必要な勝利点。未指定は基本の VP_TABLE.target(10)。航海者は新島活用を促すため高め。 */
  readonly victoryTarget?: number;
  /** シナリオ固有ルールのトグル（公式準拠リビルド計画 §1）。未指定は基本/航海者共通の既定。 */
  readonly rules?: ScenarioRules;
}

// ---- 基本カタン（既定）。挙動は従来どおり createRandomBoard に委譲。 ----
const classic: Scenario = {
  id: 'classic',
  name: '基本',
  description: '標準の19タイル。海・船なしのオリジナルルール（10点で勝利）。',
  category: 'basic',
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
};

// 航海者マップは大きめの footprint（半径3＝29ヘックス）を使う。盤面は自動縮小して収まる。
const SEAFARERS_COORDS = (): ReturnType<typeof getHexRegion> => getHexRegion(3, 2, 3);

// ---- 航海者「新たな海岸を求めて」 ----
// 本島(左 q=-3..-1 = 12タイル)＋海峡(q=0列)＋新しい島(右 q=1..3 = 9タイル)。
//   左右の陸は海峡で隔てられ、新島へは船で渡る。新島の玄関口(1,-1)に金タイル。陸21タイル。
const NEW_SHORES_LAND: Record<string, { type: TileType; number: number | null; robber?: boolean }> = {
  // 本島（左 12）
  '-3,0':  { type: 'forest',   number: 8 },
  '-3,1':  { type: 'field',    number: 5 },
  '-3,2':  { type: 'pasture',  number: 10 },
  '-2,-1': { type: 'hill',     number: 9 },
  '-2,0':  { type: 'mountain', number: 4 },
  '-2,1':  { type: 'forest',   number: 11 },
  '-2,2':  { type: 'field',    number: 3 },
  '-1,-2': { type: 'pasture',  number: 6 },
  '-1,-1': { type: 'desert',   number: null, robber: true }, // 砂漠（盗賊初期位置）
  '-1,0':  { type: 'hill',     number: 2 },
  '-1,1':  { type: 'mountain', number: 9 },
  '-1,2':  { type: 'forest',   number: 10 },
  // 新しい島（右 9）。玄関口(1,-1)に金タイル。残り(0列・1,2・2,1・3,0)は海。
  '1,-2':  { type: 'field',    number: 4 },
  '1,-1':  { type: 'gold',     number: 8 },  // 金（任意資源）。新島の玄関口。
  '1,0':   { type: 'pasture',  number: 10 },
  '1,1':   { type: 'hill',     number: 5 },
  '2,-2':  { type: 'forest',   number: 9 },
  '2,-1':  { type: 'mountain', number: 3 },
  '2,0':   { type: 'field',    number: 11 },
  '3,-2':  { type: 'pasture',  number: 6 },
  '3,-1':  { type: 'gold',     number: 4 },  // 金2枚目（公式S1は金タイル2枚）。新島の奥。
};

// 海岸線（陸1・海1 に面する辺）に港を決定論的に配置する。
// 各辺の2頂点は陸の沿岸頂点なので、そこに港を持たせる。港が密集しないよう
// 使用頂点とその隣接頂点を避けながら最大 max 個まで、種別をプールから順に割り当てる。
const HARBOR_POOL: HarborType[] = ['generic', 'wood', 'brick', 'generic', 'wool', 'grain', 'ore'];
function coastalHarbors(geo: BoardGeometry, tiles: Record<TileId, Tile>, max = 4): Harbor[] {
  const coastEdges = Object.values(geo.edges)
    .filter(e => {
      const tids = edgeTileIds(e, geo.vertices);
      return tids.length === 2 && tids.filter(t => tiles[t]?.type === 'sea').length === 1; // 陸1・海1＝海岸線
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // 決定論的順序

  const harbors: Harbor[] = [];
  const used = new Set<string>();
  for (const e of coastEdges) {
    if (harbors.length >= max) break;
    const [va, vb] = e.vertexIds;
    const vA = geo.vertices[va];
    const vB = geo.vertices[vb];
    if (!vA || !vB) continue;
    // 使用済み頂点・その隣接頂点に被るなら避ける（港の密集を防ぐ）。
    if (used.has(va) || used.has(vb)) continue;
    if (vA.adjacentVertexIds.some(v => used.has(v)) || vB.adjacentVertexIds.some(v => used.has(v))) continue;
    const type = HARBOR_POOL[harbors.length % HARBOR_POOL.length]!;
    vA.harborType = type;
    vB.harborType = type;
    harbors.push({ id: `harbor_${harbors.length}`, type, vertexIds: [va, vb] });
    used.add(va);
    used.add(vb);
  }
  return harbors;
}

// 陸タイル定義表（タイルID→種別/数字/盗賊）から固定盤面を作る共通ビルダ。
// 表に無いタイルは海(sea)。19タイル footprint 内で陸塊を海で分離する航海者マップ用。
// 海岸線には港を自動配置する（沿岸開拓地の交易価値）。
type LandMap = Record<string, { type: TileType; number: number | null; robber?: boolean }>;
function buildFromLandMap(landMap: LandMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo) => {
    const tiles: Record<TileId, Tile> = {};
    // 盤面の全タイル（シナリオの coords() が決めた footprint）を走査。表に無いタイルは海。
    for (const id of Object.keys(geo.tileToVertices)) {
      const coord = parseTileId(id);
      const land = landMap[id];
      tiles[id] = land
        ? { id, coord, type: land.type, number: land.number, hasRobber: !!land.robber }
        : { id, coord, type: 'sea', number: null, hasRobber: false }; // 表に無い＝海
    }
    return { tiles, harbors: coastalHarbors(geo, tiles) };
  };
}

// 公式シナリオ1「新たな海岸を目指して」(Heading for New Shores)。本島＋新島群、
// 新島への初入植ごとに各自+2VP、14点で勝利（公式ルールブック第6版）。
// ※盤面は本島＋新島のデジタル簡略版（ピクセル単位の公式配置は地図画像があれば後で合わせ込み）。
const seafarersNewShores: Scenario = {
  id: 'seafarers_newshores',
  name: '航海者：新たな海岸を目指して',
  description: '本島から海を渡り、対岸の新島へ入植。新しい島への初入植ごとに+2点（14点で勝利）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(NEW_SHORES_LAND),
  victoryTarget: 14,
  rules: { newIslandBonusVp: 2 },
};

// ---- 航海者「群島」（2つ目の盤面） ----
// 本島(左 12)＋海峡(q=0列)で隔てた右側を、r=0 の海列でさらに2つの新島に分割する。
//   新島A(右上 6・玄関口に金) / 新島B(右下 3)。島が3つあるため島ボーナス・金・航海の競争が core。
//   陸21タイル（本島12＋A6＋B3）。
const ARCHIPELAGO_LAND: LandMap = {
  // 本島（左 12）。全5資源が揃う自給島。砂漠=盗賊初期位置。
  '-3,0':  { type: 'pasture',  number: 9 },
  '-3,1':  { type: 'forest',   number: 5 },
  '-3,2':  { type: 'field',    number: 11 },
  '-2,-1': { type: 'mountain', number: 6 },
  '-2,0':  { type: 'hill',     number: 8 },
  '-2,1':  { type: 'forest',   number: 4 },
  '-2,2':  { type: 'pasture',  number: 3 },
  '-1,-2': { type: 'field',    number: 10 },
  '-1,-1': { type: 'desert',   number: null, robber: true },
  '-1,0':  { type: 'mountain', number: 5 },
  '-1,1':  { type: 'hill',     number: 9 },
  '-1,2':  { type: 'forest',   number: 11 },
  // 新島A（右上 6）。玄関口(1,-1)に金タイル。
  '1,-2':  { type: 'field',    number: 4 },
  '1,-1':  { type: 'gold',     number: 8 },  // 金（任意資源）
  '2,-2':  { type: 'forest',   number: 10 },
  '2,-1':  { type: 'mountain', number: 6 },
  '3,-2':  { type: 'pasture',  number: 3 },
  '3,-1':  { type: 'hill',     number: 5 },
  // 新島B（右下 3）。r=0 列(1,0)(2,0)(3,0)の海で A と分離。
  '1,1':   { type: 'hill',     number: 9 },
  '1,2':   { type: 'field',    number: 4 },
  '2,1':   { type: 'pasture',  number: 11 },
};

// ⚠ 非公式オリジナルマップ（群島/黄金諸島/連なる島々/大連邦/金の島）。
// 公式8シナリオには存在しないが、航海者エンジン（船/島ボーナス/金/海賊/最長交易路）で
// 完全にプレイ可能。公式シナリオが揃うまでの追加マップとして残置し、表示名に「(非公式)」を付す。
const seafarersArchipelago: Scenario = {
  id: 'seafarers_archipelago',
  name: '航海者：群島（非公式）',
  description: '【非公式】海で隔てた3つの島。本島＋新島2つを巡る、島ボーナスと金の争奪戦（13点）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(ARCHIPELAGO_LAND),
  victoryTarget: 13,
};

// ============================================================
// 追加シナリオ（航海者）。いずれも「本島＝最大の陸塊」で初期配置し、
// それ以外の島へは航海で渡る（最初の入植で+2点）。陸タイル定義のみ書けば
// 残りは海・港は自動配置（buildFromLandMap / coastalHarbors）。
// ============================================================

// 共通の本島（左 q=-3..-1、12タイル・全5資源＋砂漠）。各追加マップで使い回す。
const MAIN_ISLAND: LandMap = {
  '-3,0':  { type: 'forest',   number: 9 },
  '-3,1':  { type: 'field',    number: 8 },
  '-3,2':  { type: 'pasture',  number: 4 },
  '-2,-1': { type: 'mountain', number: 5 },
  '-2,0':  { type: 'hill',     number: 10 },
  '-2,1':  { type: 'forest',   number: 3 },
  '-2,2':  { type: 'field',    number: 11 },
  '-1,-2': { type: 'pasture',  number: 6 },
  '-1,-1': { type: 'desert',   number: null, robber: true },
  '-1,0':  { type: 'mountain', number: 9 },
  '-1,1':  { type: 'hill',     number: 2 },
  '-1,2':  { type: 'field',    number: 5 },
};

// ---- 砂漠を越えて：広い大洋(q=0,1は海)の先に、遠い金の島（右奥 q=2,3）。長い航路が要る。 ----
const THROUGH_DESERT_LAND: LandMap = {
  ...MAIN_ISLAND,
  '2,-2': { type: 'forest',   number: 5 },
  '3,-2': { type: 'gold',     number: 8 },
  '2,-1': { type: 'field',    number: 4 },
  '3,-1': { type: 'pasture',  number: 10 },
  '3,0':  { type: 'gold',     number: 9 },
  '2,1':  { type: 'hill',     number: 6 },
};

// ---- 黄金諸島：右に2つの新島、合計3つの金タイル。ゴールドラッシュ。 ----
const GOLDEN_ISLES_LAND: LandMap = {
  ...MAIN_ISLAND,
  // 新島A（上 4）：金1
  '1,-2': { type: 'forest',   number: 6 },
  '2,-2': { type: 'gold',     number: 9 },
  '3,-2': { type: 'field',    number: 4 },
  '2,-1': { type: 'hill',     number: 10 },
  // 新島B（下 4）：金2
  '1,1':  { type: 'field',    number: 8 },
  '2,1':  { type: 'gold',     number: 4 },
  '1,2':  { type: 'pasture',  number: 5 },
  '3,0':  { type: 'gold',     number: 11 },
};

// ---- 連なる島々：小さな島が点在（島ボーナスを稼ぐアイランドホッピング）。 ----
const CHAIN_ISLES_LAND: LandMap = {
  ...MAIN_ISLAND,
  // 島1（上）
  '1,-2': { type: 'field',    number: 6 },
  '1,-1': { type: 'gold',     number: 8 },
  // 島2（中）
  '2,0':  { type: 'forest',   number: 5 },
  '3,0':  { type: 'pasture',  number: 9 },
  // 島3（下）
  '2,1':  { type: 'hill',     number: 4 },
  '1,2':  { type: 'mountain', number: 10 },
};

// ---- 大連邦：海を少なくした大きな一枚陸。船は控えめ、人数多めでも遊べる大盤（12点）。 ----
// 本島を右へ拡張して大陸化。沿岸に港、奥に金1。新島ボーナスは発生しない（1つの陸塊）。
const GREATER_CATAN_LAND: LandMap = {
  ...MAIN_ISLAND,
  '0,-2': { type: 'forest',   number: 3 },
  '0,-1': { type: 'field',    number: 11 },
  '0,0':  { type: 'pasture',  number: 6 },
  '0,1':  { type: 'hill',     number: 8 },
  '1,-2': { type: 'mountain', number: 4 },
  '1,-1': { type: 'gold',     number: 10 },
  '1,0':  { type: 'forest',   number: 9 },
  '1,1':  { type: 'field',    number: 3 },
  '2,-1': { type: 'pasture',  number: 5 },
  '2,0':  { type: 'mountain', number: 11 },
  '2,-2': { type: 'hill',     number: 12 },
};

// 非公式（公式S4「砂漠を越えて」とは別物の「遠い金の島」版。誤認を避け名前を変更）。
const seafarersThroughDesert: Scenario = {
  id: 'seafarers_throughdesert',
  name: '航海者：金の島（非公式）',
  description: '【非公式】広い大洋の先に遠い「金の島」。長い航路を繋いで渡れた者が勝つ（13点）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(THROUGH_DESERT_LAND),
  victoryTarget: 13,
};
const seafarersGoldenIsles: Scenario = {
  id: 'seafarers_goldenisles',
  name: '航海者：黄金諸島（非公式）',
  description: '【非公式】金タイルが3つ。好きな資源を産む金を巡るゴールドラッシュ（13点）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(GOLDEN_ISLES_LAND),
  victoryTarget: 13,
};
const seafarersChainIsles: Scenario = {
  id: 'seafarers_chainisles',
  name: '航海者：連なる島々（非公式）',
  description: '【非公式】小さな島が点在。島ボーナスを稼ぐアイランドホッピング（13点）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(CHAIN_ISLES_LAND),
  victoryTarget: 13,
};
const seafarersGreaterCatan: Scenario = {
  id: 'seafarers_greatercatan',
  name: '航海者：大連邦（非公式）',
  description: '【非公式】海を少なくした大きな一枚大陸。船は控えめの拡大版（12点）。',
  category: 'seafarers',
  coords: SEAFARERS_COORDS,
  build: buildFromLandMap(GREATER_CATAN_LAND),
  victoryTarget: 12,
};

// ---- 騎士と商人(Cities & Knights) ----
const citiesKnights: Scenario = {
  id: 'cities_knights',
  name: '都市と騎士',
  description: '商品・都市改善・騎士・蛮族の襲来。最も奥深い拡張ルール（13点）。',
  category: 'cities_knights',
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
  victoryTarget: 13,
  expansion: 'cities_knights',
};

const SCENARIOS: Record<ScenarioId, Scenario> = {
  classic,
  seafarers_newshores: seafarersNewShores,
  seafarers_archipelago: seafarersArchipelago,
  seafarers_throughdesert: seafarersThroughDesert,
  seafarers_goldenisles: seafarersGoldenIsles,
  seafarers_chainisles: seafarersChainIsles,
  seafarers_greatercatan: seafarersGreaterCatan,
  cities_knights: citiesKnights,
};

/** シナリオIDからシナリオ定義を取得（未知IDは基本にフォールバック）。 */
export function getScenario(id: ScenarioId = 'classic'): Scenario {
  return SCENARIOS[id] ?? classic;
}

export interface ScenarioInfo {
  id: ScenarioId;
  name: string;
  description: string;
  category: 'basic' | 'seafarers' | 'cities_knights';
  victoryTarget: number;
}
/** UI/設定で使うシナリオ一覧（id, 表示名, 説明, カテゴリ, 勝利点）。 */
export function listScenarios(): ReadonlyArray<ScenarioInfo> {
  return (Object.keys(SCENARIOS) as ScenarioId[]).map(id => {
    const s = SCENARIOS[id];
    return { id, name: s.name, description: s.description, category: s.category, victoryTarget: s.victoryTarget ?? 10 };
  });
}
