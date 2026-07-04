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

import type { AxialCoord, Tile, TileId, TileType, Harbor, HarborType, ScenarioRules, EdgeTokenKind } from '../types';
import { getAllTileCoords, getHexRegion, tileId, parseTileId, edgeTileIds, type BoardGeometry } from './board';
import { createRandomBoard } from './setup';

export type ScenarioId =
  | 'classic'
  | 'seafarers_newshores'      // 公式S1 新たな海岸を目指して
  | 'seafarers_drought'        // 公式アプリ「干ばつ」（本島は砂漠の痩せ地・小島が豊か）
  | 'seafarers_fourislands'    // 公式S2 4つの島
  | 'seafarers_fogislands'     // 公式S3 霧の島
  | 'seafarers_treasure'       // 公式アプリ「宝島」（霧＋海辺の財宝トークン）
  | 'seafarers_oceania'        // 公式アプリ「オセアニア(4)」（霧に隠れた2つの始発島＋探索）
  | 'seafarers_throughdesert'  // 公式S4 砂漠を越えて
  | 'seafarers_forgottentribe' // 公式S5 忘れられた部族
  | 'seafarers_cloth'          // 公式S6 カタンの織物
  | 'seafarers_pirateislands'  // 公式S7 海賊の島々
  | 'seafarers_wonders'        // 公式S8 カタンの七不思議
  | 'seafarers_newworld'       // 公式 New World（自由構築）
  | 'seafarers_archipelago'    // 非公式
  | 'seafarers_goldenisles'    // 非公式
  | 'seafarers_chainisles'     // 非公式
  | 'seafarers_greatercatan'   // 公式アプリ「大カタン」（中央本島＋数字なし小島・抜けている数値トークン・都市8制限）
  | 'ck_seafarers_newshores'   // 公式アプリ「都市と騎士—新たな岸へ」（航海者盤＋C&K・17点）
  | 'ck_seafarers_oceania'     // 公式アプリ「都市と騎士—オセアニア」（霧の2島＋C&K・15点）
  | 'ck_seafarers_greatercatan'// 公式アプリ「都市と騎士—大カタン」（数値トークン欠＋C&K・20点）
  | 'oasis'                    // 公式アプリ「オアシス」（基本ゲーム＋道で砂漠/霧を探索＋財宝・10点）
  | 'tb_harbors'               // 交易と蛮族「強き港(Harbors of Catan / Strongest Ports)」変種（基本盤＋2VPタイル・11点）
  | 'cities_knights';

export interface ScenarioBoard {
  tiles: Record<TileId, Tile>;
  harbors: Harbor[];
  /** S5 忘れられた部族: 海の辺に事前配置するトークン（辺ID→種別）。 */
  edgeTokens?: Record<string, EdgeTokenKind>;
  /** S6 カタンの織物: 村タイル（タイルID→初期織物供給5）。 */
  villages?: Record<string, number>;
  /** S7 海賊の島々: 要塞の頂点ID（要塞島ごとに1つ・プレイヤーへ手番順で割当）。 */
  fortressVertices?: string[];
  /** S7 海賊の島々: 海賊艦隊の固定経路（タイルID列）。 */
  fleetPath?: string[];
  /** 砂漠を越えて: 特別VPの対象「地域」（北西地方）のタイルID。隣接初入植で +regionBonusVp。 */
  bonusRegionTiles?: string[];
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: string;
  /** UI 用の1行説明。 */
  readonly description: string;
  /** UI のグルーピング用カテゴリ。 */
  readonly category: 'basic' | 'seafarers' | 'cities_knights' | 'traders_barbarians';
  /** 騎士と商人拡張を有効化する（GameState.expansion に反映）。 */
  readonly expansion?: 'cities_knights';
  /** タイル座標集合（盤面幾何の生成に使う）。航海者の可変盤ではここを差し替える。 */
  coords(): AxialCoord[];
  /** 幾何確定後にタイル種別・数字・港を割り当てる。 */
  build(geo: BoardGeometry, rng: () => number): ScenarioBoard;
  /** 勝利に必要な勝利点。未指定は基本の VP_TABLE.target(10)。航海者は新島活用を促すため高め。 */
  readonly victoryTarget?: number;
  /** おすすめプレイヤー数の表示用ラベル（例 '3〜4人'）。未指定はUI既定 '3〜4人'（公式カタンの推奨）。 */
  readonly recommendedPlayers?: string;
  /** シナリオ固有ルールのトグル（公式準拠リビルド計画 §1）。未指定は基本/航海者共通の既定。 */
  readonly rules?: ScenarioRules;
}

/** おすすめプレイヤー数の既定表示（公式カタン/航海者は3〜4人推奨）。 */
// 既定は「3人」。航海者の各盤は公式3人用コンポに合わせて作ってあるため。
// 基本/都市と騎士（標準19タイル）と S7（要塞4）は個別に「4人」を指定する。
export const DEFAULT_RECOMMENDED_PLAYERS = '3人';

// ---- 基本カタン（既定）。挙動は従来どおり createRandomBoard に委譲。 ----
const classic: Scenario = {
  id: 'classic',
  name: '基本',
  description: '標準の19タイル。海・船なしのオリジナルルール（10点で勝利）。',
  category: 'basic',
  recommendedPlayers: '4人', // 標準19タイルはフル対戦の4人がおすすめ
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
};

// 航海者マップの footprint。盤面は自動縮小して収まる。
//   SEAFARERS_COORDS=29（小盤）/ BIG_COORDS=37（公式35級）/ HUGE_COORDS=51（公式49級）。
// 公式コンポ数に近づけるため、各シナリオは規模に応じて footprint を選ぶ。
const SEAFARERS_COORDS = (): ReturnType<typeof getHexRegion> => getHexRegion(3, 2, 3);
const BIG_COORDS = (): ReturnType<typeof getHexRegion> => getHexRegion(3, 3, 3);   // 37ヘックス
const HUGE_COORDS = (): ReturnType<typeof getHexRegion> => getHexRegion(4, 3, 4);  // 51ヘックス
const FOUR_ISLANDS_COORDS = HUGE_COORDS; // S2 は 51ヘックス（公式アプリ4人盤・大きさの異なる4島）
// オセアニア専用: 霧を始発島から必ず海で隔てるため、他盤(51)より広い 61ヘックス(半径4)を使う。
// 盤は自動縮小して収まる（タイルは小さくなるが操作性は問題なし）。
const OCEANIA_COORDS = (): ReturnType<typeof getHexRegion> => getHexRegion(4, 4, 4); // 61ヘックス

// ---- 航海者「新たな海岸を目指して」（公式S1・51ヘックス＝公式アプリ4人盤に準拠） ----
// 公式アプリ(photo/IMG_6399)の「中央に本島＋四方に離れた小島」を51マス盤で再現。
//   中央本島14＋四隅の小島4つ(各2タイル)＝陸22。公式アプリは「島ごとの資源の組み合わせは毎回固定・
//   配置だけランダム」なので、randomizeLandMap は本島の資源集合・小島の資源集合を“島内だけで”
//   シャッフルする（本島↔小島は混ざらない）。金は小島側にあるため必ず小島へ出る。
//   公式構成（photo/IMG_6399 実読）＝
//     本島(14): 牧草地4・森3・畑3・山2・丘2
//     小島(8) : 金2・丘2・森1・山2・畑1
const NEW_SHORES_LAND: Record<string, { type: TileType; number: number | null; robber?: boolean }> = {
  // 中央本島（14・牧草地4/森3/畑3/山2/丘2。砂漠なし＝盗賊は小島のどこかへ）
  '-2,1':  { type: 'pasture',  number: 5 },
  '-1,-1': { type: 'forest',   number: 10 },
  '-1,0':  { type: 'field',    number: 4 },
  '-1,1':  { type: 'mountain', number: 9 },
  '-1,2':  { type: 'pasture',  number: 6 },
  '0,-1':  { type: 'forest',   number: 3 },
  '0,0':   { type: 'field',    number: 11 },
  '0,1':   { type: 'hill',     number: 4 },
  '1,-2':  { type: 'pasture',  number: 8 },
  '1,-1':  { type: 'forest',   number: 5 },
  '1,0':   { type: 'field',    number: 9 },
  '1,1':   { type: 'mountain', number: 2 },
  '2,-1':  { type: 'pasture',  number: 10 },
  '2,0':   { type: 'hill',     number: 3 },
  // 離れ小島（四隅・各2タイル）。金2/丘2/森1/山2/畑1。金は非赤数字の小島セルに置く。
  '-4,0':  { type: 'gold',     number: 5 },   // 北西
  '-4,1':  { type: 'hill',     number: 6 },
  '-4,3':  { type: 'forest',   number: 11 },  // 南西
  '-3,3':  { type: 'mountain', number: 4 },
  '3,-3':  { type: 'hill',     number: 12 },  // 北東
  '4,-3':  { type: 'field',    number: 9 },
  '4,-1':  { type: 'mountain', number: 10 },  // 南東
  '4,0':   { type: 'gold',     number: 4 },
};

// 海岸線（陸1・海1 に面する辺）に港を毎ゲームランダム配置する。
// 公式アプリ同様、港の「位置」も「種別」も起動ごとにランダム。ただし密集を防ぐため
// 使用頂点とその隣接頂点を避ける（[D8] 港同士1辺以上空ける）。種別は5資源の2:1港(シャッフル)を
// 先頭に積むので、placed が5以上なら必ず全資源の専門港が出る（docs/AUDIT_SEAFARERS.md [D1]）。
// 残りは3:1(generic)。海岸線の辺順自体もシャッフルして位置をランダム化する。
const HARBOR_SPECIALTY: HarborType[] = ['wood', 'brick', 'wool', 'grain', 'ore'];
function randomHarbors(geo: BoardGeometry, tiles: Record<TileId, Tile>, rng: () => number, max = 8): Harbor[] {
  const coastEdges = shuffleWithRng(
    Object.values(geo.edges).filter(e => {
      const tids = edgeTileIds(e, geo.vertices);
      return tids.length === 2 && tids.filter(t => tiles[t]?.type === 'sea').length === 1; // 陸1・海1＝海岸線
    }),
    rng,
  );
  // 種別プール: 5資源の2:1港(シャッフル)→全資源の専門港が必ず出る。残りは3:1(generic)。
  const pool: HarborType[] = [...shuffleWithRng(HARBOR_SPECIALTY, rng), 'generic', 'generic', 'generic', 'generic'];

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
    const type = pool[harbors.length] ?? 'generic';
    vA.harborType = type;
    vB.harborType = type;
    harbors.push({ id: `harbor_${harbors.length}`, type, vertexIds: [va, vb] });
    used.add(va);
    used.add(vb);
  }
  return harbors;
}

// 陸タイル定義表（タイルID→種別/数字/盗賊）。表は「島の骨格（どこが陸か）＋公式準拠の
// 資源/数字の構成（多重集合）」を表す“正”。中身の配置は randomizeLandMap で毎ゲームシャッフルする。
type LandMap = Record<string, { type: TileType; number: number | null; robber?: boolean }>;

// 固定の landMap から tiles を組む（ランダム化なし・内部用）。表に無いタイルは海。
function buildTilesFromLandMap(geo: BoardGeometry, landMap: LandMap): Record<TileId, Tile> {
  const tiles: Record<TileId, Tile> = {};
  for (const id of Object.keys(geo.tileToVertices)) {
    const coord = parseTileId(id);
    const land = landMap[id];
    tiles[id] = land
      ? { id, coord, type: land.type, number: land.number, hasRobber: !!land.robber }
      : { id, coord, type: 'sea', number: null, hasRobber: false }; // 表に無い＝海
  }
  return tiles;
}

// 公式構成（島ごとの資源の組み合わせ＝多重集合）を維持して配置だけ毎ゲームランダム化し、
// 港もランダム配置して盤を組む共通ビルダ。砂漠（干ばつ＝本島側に定義）や金（小島側に定義）は
// randomizeLandMap の「島内シャッフル」によって元の島に残るので、特別なオプションは不要。
function buildFromLandMap(landMap: LandMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const tiles = buildTilesFromLandMap(geo, randomizeLandMap(landMap, rng));
    return { tiles, harbors: randomHarbors(geo, tiles, rng) };
  };
}

// 霧(fog)ヘックス定義: 表向きは海として扱い、探索で公開すると本来の地形/数字になる（S3 霧の島）。
type FogMap = Record<string, { type: TileType; number: number | null }>;
// landMap（確定の陸/海）＋ fogMap（霧）から盤を作る。霧は type='sea'＋tile.fog に本来値を隠す。
// 本島・霧の中身は毎ゲームランダム化（霧はどのセルが陸/海か・地形・数字をシャッフル。枚数は不変）。
function buildFromLandFogMap(landMap: LandMap, fogMap: FogMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const { home, fog } = randomizeHomeAndFog(landMap, fogMap, rng);
    const tiles: Record<TileId, Tile> = {};
    for (const id of Object.keys(geo.tileToVertices)) {
      const coord = parseTileId(id);
      const land = home[id];
      const f = fog[id];
      if (land) {
        tiles[id] = { id, coord, type: land.type, number: land.number, hasRobber: !!land.robber };
      } else if (f) {
        tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false, fog: { type: f.type, number: f.number } };
      } else {
        tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false };
      }
    }
    return { tiles, harbors: randomHarbors(geo, tiles, rng) };
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
  coords: HUGE_COORDS, // 51ヘックス（公式アプリ4人盤＝中央本島＋四方の小島）
  build: buildFromLandMap(NEW_SHORES_LAND),
  victoryTarget: 14,
  rules: { newIslandBonusVp: 2 },
};

// ---- 公式アプリ「干ばつ」（51ヘックス・公式アプリ4人盤に準拠／photo/IMG_6400） ----
// 本島(中央15)は砂漠が広がる痩せ地（砂漠3・山多め・麦少なめ）。周囲の小島(四隅・各2)が豊か。
//   砂漠は本島側に定義、金は小島側に定義 → randomizeLandMap の島内シャッフルで砂漠は必ず本島・
//   金は必ず小島に残る。盗賊は砂漠の1枚。小島ごとに初入植+2点。14点で勝利。
//   下記は構成（枚数）の“正”＝陸23（本島15: 砂漠3/山4/森3/牧草2/丘2/畑1、小島8: 金2/畑3/牧草3）。
const DROUGHT_LAND: LandMap = {
  // 中央本島（15・砂漠3を含む痩せ地。砂漠は本島内でシャッフルされ、その1枚に盗賊）
  '-2,0':  { type: 'desert',   number: null, robber: true },
  '-2,1':  { type: 'mountain', number: 8 },
  '-1,-1': { type: 'mountain', number: 5 },
  '-1,0':  { type: 'forest',   number: 10 },
  '-1,1':  { type: 'desert',   number: null },
  '-1,2':  { type: 'pasture',  number: 9 },
  '0,-1':  { type: 'mountain', number: 4 },
  '0,0':   { type: 'forest',   number: 11 },
  '0,1':   { type: 'hill',     number: 3 },
  '1,-2':  { type: 'mountain', number: 6 },
  '1,-1':  { type: 'desert',   number: null },
  '1,0':   { type: 'forest',   number: 2 },
  '1,1':   { type: 'hill',     number: 9 },
  '2,-1':  { type: 'field',    number: 10 },
  '2,0':   { type: 'pasture',  number: 5 },
  // 豊かな離れ小島（四隅・各2タイル）。金2はここにランダム配置。
  '-4,0':  { type: 'gold',     number: 4 },   // 北西
  '-4,1':  { type: 'field',    number: 5 },
  '-4,3':  { type: 'pasture',  number: 6 },   // 南西
  '-3,3':  { type: 'field',    number: 11 },
  '3,-3':  { type: 'pasture',  number: 8 },   // 北東
  '4,-3':  { type: 'field',    number: 9 },
  '4,-1':  { type: 'pasture',  number: 3 },   // 南東
  '4,0':   { type: 'gold',     number: 12 },
};
const seafarersDrought: Scenario = {
  id: 'seafarers_drought',
  name: '航海者：干ばつ',
  description: '砂漠が広がる本島は痩せ地。豊かな周囲の小島へ船で渡り、入植した小島ごとに+2点（14点で勝利）。',
  category: 'seafarers',
  coords: HUGE_COORDS, // 51ヘックス（公式アプリ4人盤＝中央本島＋四方の小島）
  build: buildFromLandMap(DROUGHT_LAND),
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
  '-2,0':  { type: 'hill',     number: 9 },  // 赤6/8隣接回避（-2,-1=6と隣接のため非赤9に）
  '-2,1':  { type: 'forest',   number: 4 },
  '-2,2':  { type: 'pasture',  number: 3 },
  '-1,-2': { type: 'field',    number: 10 },
  '-1,-1': { type: 'desert',   number: null, robber: true },
  '-1,0':  { type: 'mountain', number: 5 },
  '-1,1':  { type: 'hill',     number: 9 },
  '-1,2':  { type: 'forest',   number: 11 },
  // 新島A（右上 6）。玄関口(1,-1)に金タイル（金に赤数字は置かない）。
  '1,-2':  { type: 'field',    number: 4 },
  '1,-1':  { type: 'gold',     number: 5 },  // 金（任意資源・非赤。2,-1=6隣接の赤回避も兼ねる）
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

// 公式級(37ヘックス)の共通本島＝BIG_COORDS の q<=-1 領域15タイル（全5資源＋砂漠=盗賊初期）。
// q=0列は海、q>=1 が新天地（各シナリオが島/霧/トークン/村/要塞を配置）。本島が常に一意最大。
const BIG_MAIN_ISLAND: LandMap = {
  '-3,0':  { type: 'forest',   number: 8 },
  '-3,1':  { type: 'field',    number: 5 },
  '-3,2':  { type: 'pasture',  number: 10 },
  '-3,3':  { type: 'hill',     number: 4 },
  '-2,-1': { type: 'mountain', number: 9 },
  '-2,0':  { type: 'field',    number: 4 },  // 赤数字6/8の隣接回避（-3,0=8と隣接のため非赤4に）
  '-2,1':  { type: 'forest',   number: 11 },
  '-2,2':  { type: 'pasture',  number: 3 },
  '-2,3':  { type: 'hill',     number: 6 },
  '-1,-2': { type: 'field',    number: 4 },
  '-1,-1': { type: 'desert',   number: null, robber: true },
  '-1,0':  { type: 'mountain', number: 2 },
  '-1,1':  { type: 'pasture',  number: 9 },
  '-1,2':  { type: 'forest',   number: 10 },
  '-1,3':  { type: 'mountain', number: 5 },
};

// ---- 公式S4「砂漠を越えて(4)」(公式アプリ4人盤 photo/IMG_6412 実読): 本土の北西に砂漠帯が伸び、
//   その向こうに陸続きの「北西地方」（岩山の豊かな地）がある。海には小島3つ。
//   特別VP＝小島へ初入植するたび各+2点／北西地方へ初入植したら各+2点。14点。
//   → 北西地方は砂漠帯(D)でしか本土とつながらない＝「砂漠を陸路で越えて」到達する（地域ボーナス
//      regionBonusVp で +2）。小島は海で隔たれ島ボーナス(+2)。地形は固定し数字のみ毎ゲームrandom。
//   構成: 北西の岩山3＋砂漠帯2(盗賊)＋本土10(森2/牧草2/丘2/畑2/山2)＋小島3つ(各2)＝陸21。
const THROUGH_DESERT_LAND: LandMap = {
  // 北西地方（岩山3＝豊かなオレの地。砂漠帯を越えた先・陸続き）
  '-4,0': { type: 'mountain', number: 6 },
  '-4,1': { type: 'mountain', number: 9 },
  '-3,0': { type: 'mountain', number: 5 },
  // 砂漠帯（2・本土と北西地方をつなぐ唯一の陸橋。盗賊はここから開始）
  '-2,0': { type: 'desert',   number: null, robber: true },
  '-2,1': { type: 'desert',   number: null },
  // 本土（中央10・出発地。全5資源）
  '-1,0': { type: 'forest',   number: 8 },
  '-1,1': { type: 'pasture',  number: 5 },
  '-1,2': { type: 'hill',     number: 11 },
  '0,-1': { type: 'mountain', number: 9 },
  '0,0':  { type: 'field',    number: 4 },
  '0,1':  { type: 'forest',   number: 6 },
  '0,2':  { type: 'field',    number: 3 },
  '1,-1': { type: 'pasture',  number: 10 },
  '1,0':  { type: 'hill',     number: 5 },
  '1,1':  { type: 'mountain', number: 11 },
  // 小島1（北・畑/牧草）
  '0,-3':  { type: 'field',    number: 10 },
  '1,-3':  { type: 'pasture',  number: 8 },
  // 小島2（北東・丘/畑）
  '3,-3':  { type: 'hill',     number: 4 },
  '4,-3':  { type: 'field',    number: 3 },
  // 小島3（東・山/森）
  '4,-1':  { type: 'mountain', number: 11 },
  '4,0':   { type: 'forest',   number: 2 },
};
// 北西地方（地域ボーナス対象）のタイル。
const THROUGH_DESERT_NW: string[] = ['-4,0', '-4,1', '-3,0'];

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
  // 島1（上）。金に赤数字は置かない・6/8隣接回避。
  '1,-2': { type: 'field',    number: 6 },
  '1,-1': { type: 'gold',     number: 5 },
  // 島2（中）
  '2,0':  { type: 'forest',   number: 5 },
  '3,0':  { type: 'pasture',  number: 9 },
  // 島3（下）
  '2,1':  { type: 'hill',     number: 4 },
  '1,2':  { type: 'mountain', number: 10 },
};

// ---- 公式「大カタン(4)」(航海者・photo/騎士と都市 大カタン IMG_6419/6420 実読): 中央の数字付き
//   本島を、数字の無い小島群が取り囲む。小島は「抜けている数値トークン」で、道/船/開拓地で端に
//   到達するまで数字が出ず産出しない。都市は各自8つまで。18点。 ----
// 本島(中央16・砂漠1=盗賊初期)＋小島5つ(各2)。小島の数字は buildGreaterCatan が pendingNumber へ
//   退避（到達で出現）。島ごとに資源構成を固定（randomizeLandMapPerIsland）。
const GREATER_CATAN_LAND: LandMap = {
  // 中央の本島（16・全5資源＋砂漠1。数字は最初から見える）
  '0,0':   { type: 'desert',   number: null, robber: true },
  '1,0':   { type: 'forest',   number: 8 },
  '1,-1':  { type: 'field',    number: 5 },
  '0,-1':  { type: 'pasture',  number: 9 },
  '-1,0':  { type: 'mountain', number: 4 },
  '-1,1':  { type: 'hill',     number: 6 },
  '0,1':   { type: 'forest',   number: 11 },
  '2,0':   { type: 'field',    number: 3 },
  '2,-1':  { type: 'pasture',  number: 10 },
  '1,1':   { type: 'mountain', number: 5 },
  '0,2':   { type: 'hill',     number: 9 },
  '-1,2':  { type: 'forest',   number: 4 },
  '-2,1':  { type: 'field',    number: 11 },
  '-2,0':  { type: 'pasture',  number: 12 },
  '1,-2':  { type: 'mountain', number: 12 },
  '-1,-1': { type: 'hill',     number: 3 },
  // 小島5つ（各2・数字なしで開始＝buildGreaterCatan が pendingNumber へ）。
  '-4,0':  { type: 'forest',   number: 10 }, // 北西
  '-4,1':  { type: 'mountain', number: 2 },
  '-1,-3': { type: 'field',    number: 8 },  // 北
  '0,-3':  { type: 'pasture',  number: 9 },
  '3,-3':  { type: 'hill',     number: 4 },  // 北東
  '4,-3':  { type: 'field',    number: 5 },
  '4,-1':  { type: 'pasture',  number: 6 },  // 東
  '4,0':   { type: 'forest',   number: 11 },
  '-4,3':  { type: 'mountain', number: 10 }, // 南西
  '-3,3':  { type: 'hill',     number: 3 },
};
// 大カタンの盤を組む: per-island シャッフル後、本島以外（小島）の数字を pendingNumber へ退避する。
function buildGreaterCatan(landMap: LandMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const rand = randomizeLandMapPerIsland(landMap, rng);
    const tiles = buildTilesFromLandMap(geo, rand);
    // 本島＝最大の陸連結成分。小島タイルの数字を pendingNumber へ退避（到達するまで産出しない）。
    const landCells = Object.keys(rand);
    const comps = landComponents(landCells).sort((a, b) => b.length - a.length);
    const mainSet = new Set(comps[0] ?? landCells);
    for (const id of landCells) {
      if (mainSet.has(id)) continue;
      const t = tiles[id];
      if (t && t.number != null) tiles[id] = { ...t, number: null, pendingNumber: t.number };
    }
    return { tiles, harbors: randomHarbors(geo, tiles, rng) };
  };
}

// 非公式（公式S4「砂漠を越えて」とは別物の「遠い金の島」版。誤認を避け名前を変更）。
// ---- 公式 New World（自由構築）: 本島＋複数の小島。どの島にも初期配置でき(setupAnywhere)、
//   自分が初期配置した島以外への初入植ごとに各自+1VP。12点。 ----
const NEW_WORLD_LAND: LandMap = {
  ...BIG_MAIN_ISLAND,                          // 本島15（出発島の1つ・全5資源＋砂漠）
  // 新島A（右上 3・金1）。どの島にも初期配置でき、出発島以外への初入植で+1点。
  '1,-2':  { type: 'field',    number: 4 },
  '1,-1':  { type: 'gold',     number: 5 },
  '1,0':   { type: 'pasture',  number: 11 },
  // 新島B（右下 3・金1）
  '3,-2':  { type: 'forest',   number: 9 },
  '3,-1':  { type: 'gold',     number: 4 },
  '3,0':   { type: 'hill',     number: 3 },
};

// ============================================================
// 中身ランダム化エンジン（島の骨格は固定・公式の資源/数字構成は維持）
// ============================================================
// landMap（“正”＝どこが陸か＋資源/数字の枚数）を受け取り、毎ゲーム:
//   - 資源種別をシャッフル（枚数は不変＝公式構成を保つ）
//   - 金は「離れ小島（本島以外の連結成分）」のランダムなセルへ（本島には出さない）
//   - 数字をシャッフル（赤6/8を辺で隣接させない・金に赤数字を置かない＝公式の盤面ルール）
//   - 砂漠=盗賊初期。砂漠が無い盤は本島の非赤タイルに盗賊を置く。
//   制約を満たすまでリトライ。失敗時は元の landMap を返す。
const NW_NB: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const isRedNum = (n: number | null | undefined): boolean => n === 6 || n === 8;
function shuffleWithRng<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// 陸セル集合を辺隣接で連結成分に分割する（最大成分＝本島）。
function landComponents(cells: readonly string[]): string[][] {
  const set = new Set(cells);
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const comp: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      const [q, r] = cur.split(',').map(Number) as [number, number];
      for (const [dq, dr] of NW_NB) {
        const n = `${q + dq},${r + dr}`;
        if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// 島ごとに「資源の組み合わせ（多重集合）」を固定したまま配置だけ毎ゲームシャッフルする。
//   公式アプリ準拠: 本島／小島それぞれの資源セットは毎回同じで、配置（とどの島のどこに金/砂漠が
//   出るか）だけがランダム。本島の資源は本島内だけ・小島の資源は小島内だけでシャッフルするため、
//   金（小島側に定義）は必ず小島へ、砂漠（干ばつ＝本島側に定義）は必ず本島に残る。
//   数字は全島共通プールから配る（数字バランスは盤全体で取る）。
// 種別を「グループ内だけ」でシャッフルする共通コア。groups は“一緒くたにシャッフルしてよい
// セル集合”の配列（島内シャッフルの単位）。数字は全島共通プールから配る。制約（赤6/8非隣接・
// 金に赤数字なし）を満たすまでリトライ。失敗時は元 landMap を返す。
function randomizeLandMapCore(landMap: LandMap, rng: () => number, groups: string[][]): LandMap {
  const cells = Object.keys(landMap);
  // 数字プール（非砂漠セルの数字を全島共通で配る）。
  const numberPool: number[] = cells
    .filter(c => landMap[c]!.type !== 'desert')
    .map(c => landMap[c]!.number)
    .filter((n): n is number => n != null);

  let lastMap: LandMap | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    // 1) 種別をグループ内だけでシャッフル（グループ間は混ざらない＝組み合わせ固定）。
    const tType: Record<string, TileType> = {};
    for (const group of groups) {
      const types: TileType[] = group.map(c => landMap[c]!.type);
      shuffleWithRng(types, rng).forEach((t, i) => { tType[group[i]!] = t; });
    }
    // 2) 数字を非砂漠セルへシャッフル配置。
    const numbered = cells.filter(c => tType[c] !== 'desert');
    const nums = shuffleWithRng(numberPool, rng);
    const tNum: Record<string, number> = {};
    numbered.forEach((c, i) => { tNum[c] = nums[i]!; });
    // 盗賊: 砂漠があればその1枚に置く。砂漠なしマップは盗賊を初期は盤外に置く（公式準拠＝
    //   最初の7が出るまで盗賊は登場せず、7で「盗賊か海賊」を選び盗賊なら任意タイルへ初登場）。
    const robberCell = cells.find(c => tType[c] === 'desert');
    const map: LandMap = {};
    for (const c of cells) {
      map[c] = tType[c] === 'desert'
        ? { type: 'desert', number: null, robber: c === robberCell }
        : { type: tType[c]!, number: tNum[c]!, robber: false };
    }
    lastMap = map; // 制約を満たせなかった場合のフォールバック用に保持（best-effort）。
    // 制約(b) 金に赤数字を置かない。
    if (numbered.some(c => tType[c] === 'gold' && isRedNum(tNum[c]))) continue;
    // 制約(a) 赤6/8が辺で隣接しない（陸同士のみ＝別島は海で隔つため非隣接）。
    let ok = true;
    for (const c of cells) {
      if (!isRedNum(tNum[c])) continue;
      const [q, r] = c.split(',').map(Number) as [number, number];
      for (const [dq, dr] of NW_NB) {
        if (isRedNum(tNum[`${q + dq},${r + dr}`])) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    return map;
  }
  // フォールバック: 400回で制約を満たせなかった最後のシャッフル盤を返す（元の静的マップは赤6/8
  //   隣接を含みうるため返さない。実運用の全シナリオは制約充足可能でここには到達しない）。
  return lastMap ?? landMap;
}

// グループ分け＝「本島(最大連結成分)」と「離れ小島(残り全部を1プール)」。小島同士は資源を
// 共有してよい盤（新たな岸へ/干ばつ/宝島など。小島構成は“合計”で固定）。
function mainOutlyingGroups(cells: string[]): string[][] {
  const comps = landComponents(cells).sort((a, b) => b.length - a.length);
  const main = comps[0] ?? cells;
  const mainSet = new Set(main);
  const outlying = cells.filter(c => !mainSet.has(c));
  return outlying.length ? [main, outlying] : [main];
}
export function randomizeLandMap(landMap: LandMap, rng: () => number): LandMap {
  return randomizeLandMapCore(landMap, rng, mainOutlyingGroups(Object.keys(landMap)));
}
// グループ分け＝「各連結成分（=各島）を独立に」。島ごとに資源の組み合わせを固定したい盤用
// （4つの島など。島Aの資源は島A内だけ・島Bの資源は島B内だけでシャッフル）。
function randomizeLandMapPerIsland(landMap: LandMap, rng: () => number): LandMap {
  return randomizeLandMapCore(landMap, rng, landComponents(Object.keys(landMap)));
}
// 島ごとに資源構成を固定する盤を組む共通ビルダ（buildFromLandMap の per-island 版）。
function buildPerIslandFromLandMap(landMap: LandMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const tiles = buildTilesFromLandMap(geo, randomizeLandMapPerIsland(landMap, rng));
    return { tiles, harbors: randomHarbors(geo, tiles, rng) };
  };
}

// 地形は固定したまま「数字だけ」毎ゲームシャッフルする（砂漠帯/岩山の位置を保ちたい盤用）。
// 砂漠・盗賊位置は元 landMap のまま。赤6/8は辺で隣接させない制約は維持。
function randomizeNumbersOnly(landMap: LandMap, rng: () => number): LandMap {
  const cells = Object.keys(landMap);
  const numberPool: number[] = cells
    .filter(c => landMap[c]!.type !== 'desert')
    .map(c => landMap[c]!.number)
    .filter((n): n is number => n != null);
  for (let attempt = 0; attempt < 400; attempt++) {
    const numbered = cells.filter(c => landMap[c]!.type !== 'desert');
    const nums = shuffleWithRng(numberPool, rng);
    const tNum: Record<string, number> = {};
    numbered.forEach((c, i) => { tNum[c] = nums[i]!; });
    let ok = true;
    for (const c of cells) {
      if (!isRedNum(tNum[c])) continue;
      const [q, r] = c.split(',').map(Number) as [number, number];
      for (const [dq, dr] of NW_NB) {
        if (isRedNum(tNum[`${q + dq},${r + dr}`])) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const map: LandMap = {};
    for (const c of cells) {
      const t = landMap[c]!;
      map[c] = t.type === 'desert'
        ? { type: 'desert', number: null, robber: !!t.robber }
        : { type: t.type, number: tNum[c]!, robber: false };
    }
    return map;
  }
  return landMap;
}

// 砂漠を越えて: 地形固定（砂漠帯/北西の岩山/小島の位置を保つ）＋数字シャッフル。北西地方タイルを
//   bonusRegionTiles として返し、そこへ初入植したプレイヤーへ特別VP（regionBonusVp）を与える。
function buildThroughDesert(landMap: LandMap, bonusRegionTiles: string[]): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const tiles = buildTilesFromLandMap(geo, randomizeNumbersOnly(landMap, rng));
    return { tiles, harbors: randomHarbors(geo, tiles, rng), bonusRegionTiles };
  };
}

// 霧マップ（fogMap）の中身を毎ゲームランダム化（どのセルが陸/海か・地形・数字をシャッフル。枚数不変）。
// randomizeLandMapCore と同じ制約をリトライで満たす: (a) 赤6/8 を辺で隣接させない（霧セル内で判定）、
// (b) 金タイルに赤数字を置かない。霧の金が約44%で赤数字になる無検査バグへの対処。
function randomizeFogMap(fogMap: FogMap, rng: () => number): FogMap {
  const cells = Object.keys(fogMap);
  const landTypes = cells.filter(c => fogMap[c]!.type !== 'sea').map(c => fogMap[c]!.type);
  const numbers = cells
    .filter(c => fogMap[c]!.type !== 'sea')
    .map(c => fogMap[c]!.number)
    .filter((n): n is number => n != null);
  const seaCount = cells.length - landTypes.length;

  let last: FogMap | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shuffled = shuffleWithRng(cells, rng);
    const seaCells = new Set(shuffled.slice(0, seaCount));
    const landCells = shuffled.slice(seaCount);
    const types = shuffleWithRng(landTypes, rng);
    const nums = shuffleWithRng(numbers, rng);
    const out: FogMap = {};
    for (const c of seaCells) out[c] = { type: 'sea', number: null };
    // 数字は「海でも砂漠でもない陸セル（=資源地）」にだけ順番に配る。地形と数字を別シャッフル
    // した結果、砂漠を含む霧（オアシス）で個数がズレ、資源地が number=undefined＝永久に産出しない
    // バグを防ぐ（砂漠は number:null を維持し、幽霊数字も付けない）。
    let ni = 0;
    landCells.forEach((c, i) => {
      const type = types[i]!;
      const number = type === 'desert' ? null : (nums[ni++] ?? null);
      out[c] = { type, number };
    });
    last = out;
    // 制約(b) 金タイルに赤数字(6/8)を置かない。
    if (landCells.some(c => out[c]!.type === 'gold' && isRedNum(out[c]!.number))) continue;
    // 制約(a) 赤6/8 が辺で隣接しない（霧セル同士で判定。海/砂漠は数字なしで非対象）。
    let ok = true;
    for (const c of cells) {
      if (!isRedNum(out[c]?.number)) continue;
      const [q, r] = c.split(',').map(Number) as [number, number];
      for (const [dq, dr] of NW_NB) {
        if (isRedNum(out[`${q + dq},${r + dr}`]?.number)) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    return out;
  }
  return last!; // フォールバック（400回で制約を満たせなかった最後の配置）
}

// 本島(home)と霧(fog)を「赤6/8が本島↔霧の境界を跨いで辺隣接しない」よう協調生成する。
// randomizeLandMap と randomizeFogMap は各々のマップ内でしか赤隣接を判定しないため、オアシスの
// ように本島と霧が同一 geo 上で直接辺隣接する盤では境界の赤-赤隣接が素通りしていた。ここで
// 両マップの数字を突き合わせ、境界も含めて赤隣接が無くなるまでリトライする（best-effort）。
// 本島と霧が海で隔たり物理隣接しない盤（霧の島/オセアニア/宝島）では初回で ok になり挙動不変。
function hasCrossRedAdjacency(home: LandMap, fog: FogMap): boolean {
  const num: Record<string, number | null> = {};
  for (const c of Object.keys(home)) num[c] = home[c]!.number;
  for (const c of Object.keys(fog)) num[c] = fog[c]!.number; // home と fog は座標が互いに素
  for (const c of Object.keys(num)) {
    if (!isRedNum(num[c])) continue;
    const [q, r] = c.split(',').map(Number) as [number, number];
    for (const [dq, dr] of NW_NB) {
      if (isRedNum(num[`${q + dq},${r + dr}`])) return true;
    }
  }
  return false;
}
function randomizeHomeAndFog(landMap: LandMap, fogMap: FogMap, rng: () => number): { home: LandMap; fog: FogMap } {
  let home = randomizeLandMap(landMap, rng);
  let fog = randomizeFogMap(fogMap, rng);
  for (let i = 0; i < 200 && hasCrossRedAdjacency(home, fog); i++) {
    home = randomizeLandMap(landMap, rng);
    fog = randomizeFogMap(fogMap, rng);
  }
  return { home, fog };
}

const seafarersThroughDesert: Scenario = {
  id: 'seafarers_throughdesert',
  name: '航海者：砂漠を越えて',
  description: '本土の北西に砂漠帯。砂漠を陸路で越えた先の北西地方や、海の小島へ。北西地方/小島への初入植で各+2点（14点）。',
  category: 'seafarers',
  coords: HUGE_COORDS, // 51ヘックス（本土＋砂漠帯＋陸続きの北西地方＋小島3つ）
  build: buildThroughDesert(THROUGH_DESERT_LAND, THROUGH_DESERT_NW),
  victoryTarget: 14,
  recommendedPlayers: '4人', // 公式アプリ「砂漠を越えて(4)」＝4人用
  rules: { newIslandBonusVp: 2, regionBonusVp: 2 }, // 小島=島ボーナス / 北西地方=地域ボーナス
};
const seafarersNewWorld: Scenario = {
  id: 'seafarers_newworld',
  name: '航海者：新世界（New World）',
  description: 'どの島にも入植でき、自分の出発島以外への初入植ごとに+1点。毎回ランダムな自由構築（12点）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  // 制約付きランダム生成（島座標は固定・種別/数字/港/金位置を毎回ランダム）。公式New Worldの「自由構築」を再現。
  build: buildFromLandMap(NEW_WORLD_LAND),
  victoryTarget: 12,
  rules: { newIslandBonusVp: 1, setupAnywhere: true },
};

// ---- 公式S3「霧の島」(公式アプリ photo/IMG_6407 実読): 左の縦長の本島(15・砂漠なし)を
//   右の霧の海域が取り囲む。船/道/開拓地で霧に近づくと晴れ、陸なら資源1枚を獲得（探索の報酬）。
//   霧の中に「金鉱の眠る島（金タイル）」が隠れているのが核。12点。 ----
// 本島（左 q<=-1 の15セル・砂漠なし＝盗賊は7まで盤外）。実読の構成＝牧草4/森4/丘3/畑2/山2。
const FOG_HOME_LAND: LandMap = {
  '-3,0':  { type: 'pasture',  number: 5 },
  '-3,1':  { type: 'pasture',  number: 3 },
  '-3,2':  { type: 'pasture',  number: 9 },
  '-3,3':  { type: 'pasture',  number: 4 },
  '-2,-1': { type: 'forest',   number: 8 },
  '-2,0':  { type: 'forest',   number: 6 },
  '-2,1':  { type: 'forest',   number: 12 },
  '-2,2':  { type: 'forest',   number: 9 },
  '-2,3':  { type: 'hill',     number: 10 },
  '-1,-2': { type: 'hill',     number: 5 },
  '-1,-1': { type: 'mountain', number: 3 },
  '-1,0':  { type: 'hill',     number: 11 },
  '-1,1':  { type: 'field',    number: 8 },
  '-1,2':  { type: 'field',    number: 4 },
  '-1,3':  { type: 'mountain', number: 6 },
};
// 霧（右側 q>=1 の全15セル）。表向きは海、探索で公開＝陸9（うち金鉱2）/海6。
// randomizeFogMap がどのセルが陸/海か・地形・数字を毎ゲームシャッフル（金2は必ず霧の中に残る）。
const FOG_HIDDEN: FogMap = {
  '1,-3': { type: 'sea',     number: null },
  '1,-2': { type: 'gold',    number: 5 },   // 金鉱の島1
  '1,-1': { type: 'field',   number: 4 },
  '1,0':  { type: 'pasture', number: 9 },
  '1,1':  { type: 'sea',     number: null },
  '1,2':  { type: 'hill',    number: 3 },
  '2,-3': { type: 'sea',     number: null },
  '2,-2': { type: 'mountain',number: 6 },
  '2,-1': { type: 'forest',  number: 5 },
  '2,0':  { type: 'sea',     number: null },
  '2,1':  { type: 'forest',  number: 8 },
  '3,-3': { type: 'sea',     number: null },
  '3,-2': { type: 'gold',    number: 4 },   // 金鉱の島2
  '3,-1': { type: 'pasture', number: 9 },
  '3,0':  { type: 'sea',     number: null },
};
const seafarersFogIslands: Scenario = {
  id: 'seafarers_fogislands',
  name: '航海者：霧の島',
  description: '霧に包まれた海域を探索。船・道・開拓地で霧が晴れ、島や資源が現れる。霧の中に金鉱の島が眠る（12点）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildFromLandFogMap(FOG_HOME_LAND, FOG_HIDDEN),
  victoryTarget: 12,
  rules: { newIslandBonusVp: 0 }, // 探索の報酬は資源（島ボーナスVPは無し）
};

// ---- 公式アプリ「オセアニア(4)」: 霧に覆われた海に2つの始発島。どの島からでも始められ
//   (setupAnywhere)、霧を晴らして未知の海域を探索する。発見した陸からは資源1枚（島ボーナスVPは無し）。
//   霧の中には金鉱の島も眠る。12点。
//   盤=61ヘックス(OCEANIA_COORDS)。始発島(西10/東7)と霧(中央帯15)は必ず海で隔て、霧は始発島に
//   直接接触しない＝船で海を渡ってのみ探索できる（公式のオセアニア挙動）。 ----
// 始発の2島（buildFromLandFogMap の landMap）。西10＋東7＝陸17。randomizeLandMap が島内で毎ゲーム
//   地形/数字をシャッフル（赤6/8非隣接）。西(10):森2/畑2/牧草3/山2/丘1  東(7):森2/山1/丘2/畑1/牧草1
const OCEANIA_HOME_LAND: LandMap = {
  // 西の始発島（10）
  '-4,0':  { type: 'forest',   number: 9 },
  '-4,1':  { type: 'forest',   number: 3 },
  '-4,2':  { type: 'field',    number: 12 },
  '-3,-1': { type: 'mountain', number: 10 },
  '-3,0':  { type: 'pasture',  number: 5 },
  '-3,1':  { type: 'pasture',  number: 4 },
  '-3,2':  { type: 'hill',     number: 6 },
  '-2,-1': { type: 'field',    number: 6 },
  '-2,0':  { type: 'pasture',  number: 5 },
  '-2,1':  { type: 'mountain', number: 2 },
  // 東の始発島（7）
  '2,-1':  { type: 'forest',   number: 9 },
  '2,0':   { type: 'forest',   number: 10 },
  '3,-2':  { type: 'mountain', number: 3 },
  '3,-1':  { type: 'hill',     number: 8 },
  '3,0':   { type: 'hill',     number: 4 },
  '4,-2':  { type: 'field',    number: 8 },
  '4,-1':  { type: 'pasture',  number: 11 },
};
// 霧（中央帯15セル・陸7（うち金鉱2）/海8）。両始発島から海を越えて探索する未知の海域。
//   randomizeFogMap がどのセルが陸/海か・地形・数字を毎ゲームシャッフル（金2は必ず霧の中に残る）。
const OCEANIA_FOG: FogMap = {
  '0,-4':  { type: 'sea',      number: null },
  '0,-3':  { type: 'gold',     number: 5 },   // 金鉱の島1
  '0,-2':  { type: 'forest',   number: 9 },
  '0,-1':  { type: 'sea',      number: null },
  '0,0':   { type: 'field',    number: 4 },
  '0,1':   { type: 'sea',      number: null },
  '0,2':   { type: 'mountain', number: 10 },
  '0,3':   { type: 'sea',      number: null },
  '0,4':   { type: 'gold',     number: 11 },  // 金鉱の島2
  '1,-3':  { type: 'sea',      number: null },
  '1,-2':  { type: 'pasture',  number: 6 },
  '1,2':   { type: 'sea',      number: null },
  '-1,-3': { type: 'hill',     number: 3 },
  '-1,2':  { type: 'sea',      number: null },
  '-1,3':  { type: 'sea',      number: null },
};
const seafarersOceania: Scenario = {
  id: 'seafarers_oceania',
  name: '航海者：オセアニア',
  description: '霧に覆われた海に2つの始発島。どの島からでも始め、霧を晴らして島を発見（資源1枚）。金鉱の島も眠る（12点）。',
  category: 'seafarers',
  coords: OCEANIA_COORDS, // 61ヘックス（2始発島＋中央の霧帯・海で確実に隔てる）
  build: buildFromLandFogMap(OCEANIA_HOME_LAND, OCEANIA_FOG),
  victoryTarget: 12,
  recommendedPlayers: '4人', // 公式アプリ「オセアニア(4)」＝4人用
  rules: { newIslandBonusVp: 0, setupAnywhere: true }, // 報酬は資源・2島から自由に開始
};

// ---- 公式アプリ「宝島」（51ヘックス・公式アプリ4人盤に準拠／photo/IMG_6401） ----
// 中央の本島(15・本拠)を霧の海域が取り囲む。四方の小島は霧に隠れており、船で近づくと晴れて
//   島(=初入植+2点)か海が現れる。海辺には財宝トークン（船で到達＝資源2枚 or 開発カード1枚）。13点。
const TREASURE_LAND: LandMap = {
  // 中央本島（15・本拠＝出発島。全5資源・金は霧の小島側に出す）
  '-2,0':  { type: 'forest',   number: 8 },
  '-2,1':  { type: 'field',    number: 5 },
  '-1,-1': { type: 'pasture',  number: 10 },
  '-1,0':  { type: 'hill',     number: 4 },
  '-1,1':  { type: 'mountain', number: 9 },
  '-1,2':  { type: 'field',    number: 6 },
  '0,-1':  { type: 'pasture',  number: 3 },
  '0,0':   { type: 'forest',   number: 11 },
  '0,1':   { type: 'hill',     number: 4 },
  '1,-2':  { type: 'field',    number: 8 },
  '1,-1':  { type: 'pasture',  number: 5 },
  '1,0':   { type: 'forest',   number: 9 },
  '1,1':   { type: 'mountain', number: 2 },
  '2,-1':  { type: 'pasture',  number: 10 },
  '2,0':   { type: 'hill',     number: 3 },
};
// 霧（四隅の小島8セル・5陸/3海）。randomizeFogMap がどのセルが陸/海か・地形・数字をランダム化。
const TREASURE_FOG: FogMap = {
  '-4,0':  { type: 'gold',     number: 5 },
  '-4,1':  { type: 'sea',      number: null },
  '-4,3':  { type: 'field',    number: 9 },
  '-3,3':  { type: 'forest',   number: 4 },
  '3,-3':  { type: 'pasture',  number: 8 },
  '4,-3':  { type: 'sea',      number: null },
  '4,-1':  { type: 'mountain', number: 10 },
  '4,0':   { type: 'sea',      number: null },
};
function buildTreasureIslands(landMap: LandMap, fogMap: FogMap, treasureCount: number): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const { home, fog } = randomizeHomeAndFog(landMap, fogMap, rng);
    const tiles: Record<TileId, Tile> = {};
    for (const id of Object.keys(geo.tileToVertices)) {
      const coord = parseTileId(id);
      const land = home[id];
      const f = fog[id];
      if (land) tiles[id] = { id, coord, type: land.type, number: land.number, hasRobber: !!land.robber };
      else if (f) tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false, fog: { type: f.type, number: f.number } };
      else tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false };
    }
    // 財宝トークンを「沿岸の外洋辺（両側が海・片端が陸に面する）」へ決定論的に等間隔配置。到達しやすい位置。
    const seaEdges = Object.values(geo.edges).filter(e => {
      const tids = edgeTileIds(e, geo.vertices);
      const bothSea = tids.length > 0 && tids.every(t => tiles[t]?.type === 'sea');
      if (!bothSea) return false;
      return e.vertexIds.some(vid => (geo.vertices[vid]?.adjacentTileIds ?? []).some(t => tiles[t] && tiles[t]!.type !== 'sea'));
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    const edgeTokens: Record<string, EdgeTokenKind> = {};
    const step = Math.max(1, Math.floor(seaEdges.length / treasureCount));
    for (let i = 0; i < treasureCount && i * step < seaEdges.length; i++) {
      edgeTokens[seaEdges[i * step]!.id] = 'treasure';
    }
    return { tiles, harbors: randomHarbors(geo, tiles, rng), edgeTokens };
  };
}
const seafarersTreasure: Scenario = {
  id: 'seafarers_treasure',
  name: '航海者：宝島',
  description: '本島を霧が取り囲む。船で霧を晴らして島を発見（初入植+2点）、海辺の財宝で資源や発展カードを得る（13点）。',
  category: 'seafarers',
  coords: HUGE_COORDS, // 51ヘックス（中央本島＋四方の霧の小島）
  build: buildTreasureIslands(TREASURE_LAND, TREASURE_FOG, 6),
  victoryTarget: 13,
  rules: { newIslandBonusVp: 2 },
};

// ---- 公式S5「忘れられた部族」: 本島(左15・全数字)＋右の海域に VP/開発カード/港 トークン。
//   船で到達して獲得。開拓地・盗賊は数字ヘックスのみ。金2。13点。 ----
// 本島(BIG_MAIN_ISLAND)＋海域に金2(小島)。公式『金2』を満たす（船で到達・数字ヘックス=入植可）。
const FORGOTTEN_TRIBE_LAND: LandMap = {
  ...BIG_MAIN_ISLAND,
  '1,-1': { type: 'gold', number: 5 }, // 金の小島1
  '3,-1': { type: 'gold', number: 4 }, // 金の小島2
};
// 右の海域（q>=1）の開放海辺へトークンを散らす（決定論・等間隔サンプリング）。公式は VPトークン8・開発カード4・港ランダム。
function buildForgottenTribe(landMap: LandMap): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  const base = buildFromLandMap(landMap);
  return (geo, rng) => {
    const board = base(geo, rng);
    // 開放海辺（両側が海）かつ右側(q>=1のタイルに面する)を決定論順に集める。
    const seaEdges = Object.values(geo.edges)
      .filter(e => {
        const tids = edgeTileIds(e, geo.vertices);
        return tids.length > 0
          && tids.every(t => board.tiles[t]?.type === 'sea')
          && tids.some(t => parseTileId(t).q >= 1);
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // 公式コンポ: VPトークン8・開発カード4・港2（港は「ランダム枚数」のため2枚で代表）。計14。
    const kinds: EdgeTokenKind[] = ['vp', 'dev', 'vp', 'harbor', 'vp', 'dev', 'vp', 'dev', 'vp', 'harbor', 'vp', 'dev', 'vp', 'vp'];
    const edgeTokens: Record<string, EdgeTokenKind> = {};
    const step = Math.max(1, Math.floor(seaEdges.length / kinds.length));
    for (let i = 0; i < kinds.length && i * step < seaEdges.length; i++) {
      edgeTokens[seaEdges[i * step]!.id] = kinds[i]!;
    }
    return { ...board, edgeTokens };
  };
}
const seafarersForgottenTribe: Scenario = {
  id: 'seafarers_forgottentribe',
  name: '航海者：忘れられた部族',
  description: '海に眠るVP・開発カード・港のトークンを船で回収。開拓地は数字ヘックスのみ（13点）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildForgottenTribe(FORGOTTEN_TRIBE_LAND),
  victoryTarget: 13,
  rules: { numberHexOnly: true, newIslandBonusVp: 0 },
};

// ---- 公式S2「4つの島」: 海で隔てた4つの島。どの島にも初期配置でき(setupAnywhere)、
//   自分の出発島以外への初入植ごとに+2点。各自にとって未探検の島が異なる。13点。 ----
// 51ヘックス footprint（公式アプリ4人盤・photo/4つの島/IMG_6406 実読）に、互いに海で隔てた
// 大きさの異なる4島を配置。砂漠なし＝盗賊は7まで盤外・海賊は最遠の海から。各島は資源の
// 組み合わせを固定（randomizeLandMapPerIsland＝島内だけシャッフル）。陸23・全23マスに数字。
//   島A 北西(4): 丘1/山1/畑2    島B 北東(8): 森4/牧草2/山1/畑1
//   島D 南西(7): 山2/畑2/牧草1/丘1/森1   島C 南東(4): 丘2/牧草2
//   合計 丘4/山4/畑5/森5/牧草5＝陸23。数字の多重集合も実読どおり（配置のみ毎ゲームランダム）。
const FOUR_ISLANDS_LAND: LandMap = {
  // 島A（北西・4）丘1/山1/畑2
  '-3,-1': { type: 'hill',     number: 4 },
  '-4,0':  { type: 'mountain', number: 11 },
  '-3,0':  { type: 'field',    number: 11 },
  '-4,1':  { type: 'field',    number: 5 },
  // 島B（北東・8）森4/牧草2/山1/畑1
  '2,-3':  { type: 'forest',   number: 8 },
  '3,-3':  { type: 'pasture',  number: 4 },
  '1,-2':  { type: 'mountain', number: 3 },
  '2,-2':  { type: 'forest',   number: 2 },
  '3,-2':  { type: 'forest',   number: 11 },
  '1,-1':  { type: 'forest',   number: 8 },
  '2,-1':  { type: 'field',    number: 9 },
  '3,-1':  { type: 'pasture',  number: 9 },
  // 島D（南西・7）山2/畑2/牧草1/丘1/森1
  '-4,3':  { type: 'mountain', number: 3 },
  '-3,2':  { type: 'field',    number: 10 },
  '-3,3':  { type: 'pasture',  number: 9 },
  '-2,1':  { type: 'field',    number: 10 },
  '-2,2':  { type: 'mountain', number: 10 },
  '-2,3':  { type: 'forest',   number: 12 },
  '-1,1':  { type: 'hill',     number: 6 },
  // 島C（南東・4）丘2/牧草2
  '1,1':   { type: 'hill',     number: 5 },
  '2,1':   { type: 'hill',     number: 5 },
  '1,2':   { type: 'pasture',  number: 4 },
  '2,2':   { type: 'pasture',  number: 6 },
};
const seafarersFourIslands: Scenario = {
  id: 'seafarers_fourislands',
  name: '航海者：4つの島',
  description: '海で隔てた4つの島。どの島から始めてもよく、出発島以外への初入植ごとに+2点（13点）。',
  category: 'seafarers',
  coords: FOUR_ISLANDS_COORDS,
  build: buildPerIslandFromLandMap(FOUR_ISLANDS_LAND),
  victoryTarget: 13,
  rules: { newIslandBonusVp: 2, setupAnywhere: true },
};

// ---- 公式S6「カタンの織物」: 本島(左15)＋小島の「村」8つ。自分の建物から航路（船）を村へ
//   つなぐと織物トークン（接続で1枚＋村の数字が出るたび接続者へ1枚、各村5枚）。織物2枚=1VP。
//   小島には開拓地建設不可・最長交易路タイル不使用。14点、または5村供給切れで最多VP。 ----
// 初期配置は公式どおり開拓地3軒（最初の2軒は資源なし・3軒目で資源取得）。
// 村（右の海域 q>=1 の小島・各村に数字ディスク）。公式コンポは村8。赤数字は互いに隣接しないよう配置。
const CLOTH_VILLAGE_NUMBERS: Record<string, number> = {
  '1,-3': 5, '1,-2': 9, '1,0': 8, '1,2': 6, '3,-2': 4, '3,-1': 10, '3,0': 8, '2,1': 11,
};
function buildClothScenario(landMap: LandMap, villageNumbers: Record<string, number>): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  const villageTids = Object.keys(villageNumbers);
  return (geo, rng) => {
    // 本島の中身は毎ゲームランダム化。村は位置固定（機構上）・数字だけシャッフルする。
    const fullLand: LandMap = { ...randomizeLandMap(landMap, rng) };
    const vnums = shuffleWithRng(Object.values(villageNumbers), rng);
    villageTids.forEach((tid, i) => { fullLand[tid] = { type: 'pasture', number: vnums[i]! }; });
    const tiles = buildTilesFromLandMap(geo, fullLand);
    const villages: Record<string, number> = {};
    for (const tid of villageTids) villages[tid] = 5; // 各村の織物供給5
    return { tiles, harbors: randomHarbors(geo, tiles, rng), villages };
  };
}
const seafarersCloth: Scenario = {
  id: 'seafarers_cloth',
  name: '航海者：カタンの織物',
  description: '小島の村へ航路をつなぎ織物を集める（2枚で1点）。小島は入植不可・最長交易路なし（14点）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildClothScenario(BIG_MAIN_ISLAND, CLOTH_VILLAGE_NUMBERS),
  victoryTarget: 14,
  rules: { useLongestRoute: false, noIslandSettlement: true, newIslandBonusVp: 0, startingSettlements: 3 },
};

// ---- 公式S8「カタンの七不思議」: 本島(資源豊富・特に鉄/麦)＋小島2つ。要件を満たして不思議を
//   クレームし4レベル建設→完成で勝利。または10点以上かつ単独最高レベル。小島初入植+1点。 ----
const WONDERS_LAND: LandMap = {
  // 本島（15・全5資源／鉄・麦多めで不思議建設向き）
  '-3,0':  { type: 'mountain', number: 8 },
  '-3,1':  { type: 'field',    number: 5 },
  '-3,2':  { type: 'pasture',  number: 10 },
  '-3,3':  { type: 'mountain', number: 4 },
  '-2,-1': { type: 'mountain', number: 9 },
  '-2,0':  { type: 'field',    number: 4 },  // 赤数字6/8の隣接回避（-3,0=8と隣接のため非赤4に）
  '-2,1':  { type: 'forest',   number: 11 },
  '-2,2':  { type: 'hill',     number: 3 },
  '-2,3':  { type: 'field',    number: 6 },
  '-1,-2': { type: 'field',    number: 4 },
  '-1,-1': { type: 'desert',   number: null, robber: true },
  '-1,0':  { type: 'mountain', number: 2 },
  '-1,1':  { type: 'pasture',  number: 9 },
  '-1,2':  { type: 'forest',   number: 10 },
  '-1,3':  { type: 'field',    number: 5 },
  // 小島A（右上 2）・小島B（右下 2）。初入植で+1点。鉄/麦を補強。
  '1,-1':  { type: 'field',    number: 4 },
  '1,0':   { type: 'mountain', number: 5 },
  '3,-1':  { type: 'field',    number: 9 },
  '3,0':   { type: 'mountain', number: 6 },
};
const seafarersWonders: Scenario = {
  id: 'seafarers_wonders',
  name: '航海者：カタンの七不思議',
  description: '要件を満たして不思議をクレームし、4レベル建設して完成を競う（完成 or 10点＋最高レベル）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildFromLandMap(WONDERS_LAND),
  victoryTarget: 10,
  rules: { wonders: true, newIslandBonusVp: 1 },
};

// ---- 公式S7「海賊の島々」: 本島(資源豊富)＋各自の海賊要塞(小島)。本島から船で要塞へ航路を延ばし
//   3回攻撃して奪取（=自分の開拓地に）。海賊艦隊が中央の海を巡回し隣接建物から略奪。
//   勝利: 自分の要塞を制圧 かつ 10点以上。 ----
// 公式準拠: 盗賊・最長交易路・最大騎士力は不使用（rules）。7は手札破棄のみ。騎士＝軍船化。
//   海賊艦隊との戦闘は軍船数で解決（pirateIslands.moveFleet）。要塞奪取後はその頂点が自分の開拓地。
// 要塞タイル（1タイルの小島・互いに海で隔離）。地形は多様化（奪取後に各色が別資源を産む）。番号は産出用。
const PIRATE_FORTRESS_TILES: Record<string, { type: TileType; number: number }> = {
  '1,-2': { type: 'field',   number: 4 },
  '1,2':  { type: 'pasture', number: 5 },
  '3,-2': { type: 'forest',  number: 9 },
  '3,0':  { type: 'hill',    number: 10 },
};
const PIRATE_FLEET_PATH: string[] = ['0,-2', '0,-1', '0,0', '0,1', '0,2']; // 中央の海を縦に巡回
function buildPirateIslands(homeMap: LandMap, fortressTiles: Record<string, { type: TileType; number: number }>, fleetPath: string[]): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    // 本島の中身は毎ゲームランダム化。要塞タイルは位置・地形固定（機構上＝奪取後に各色が別資源を産む）。
    const fullLand: LandMap = { ...randomizeLandMap(homeMap, rng) };
    for (const [tid, ft] of Object.entries(fortressTiles)) fullLand[tid] = { type: ft.type, number: ft.number };
    const tiles = buildTilesFromLandMap(geo, fullLand);
    // 各要塞タイルの代表頂点（攻略対象）。タイルの最初の頂点を採用。
    const fortressVertices = Object.keys(fortressTiles)
      .map(tid => (geo.tileToVertices[tid] ?? [])[0])
      .filter((v): v is string => !!v);
    return { tiles, harbors: randomHarbors(geo, tiles, rng), fortressVertices, fleetPath };
  };
}
const seafarersPirateIslands: Scenario = {
  id: 'seafarers_pirateislands',
  name: '航海者：海賊の島々',
  description: '本島から船で自色の海賊要塞へ。3回攻撃して奪取し、10点以上で勝利。海賊艦隊が略奪する。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildPirateIslands(BIG_MAIN_ISLAND, PIRATE_FORTRESS_TILES, PIRATE_FLEET_PATH),
  victoryTarget: 10,
  recommendedPlayers: '4人', // 要塞4＝4人で全員が要塞を攻略（3人時は3要塞割当・余りは小島）
  rules: { pirateIslands: true, newIslandBonusVp: 0, useRobber: false, useLongestRoute: false, useLargestArmy: false },
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
  name: '航海者：大カタン',
  description: '中央の本島を、数字の無い小島群が取り囲む。小島は到達するまで産出しない（抜けている数値トークン）。都市は8つまで（18点）。',
  category: 'seafarers',
  coords: HUGE_COORDS, // 51ヘックス（中央本島＋周囲の小島群）
  build: buildGreaterCatan(GREATER_CATAN_LAND),
  victoryTarget: 18,
  recommendedPlayers: '4人', // 公式アプリ「大カタン(4)」＝4人用
  rules: { newIslandBonusVp: 0, maxCities: 8, missingNumberTokens: true },
};

// ---- 騎士と商人(Cities & Knights) ----
const citiesKnights: Scenario = {
  id: 'cities_knights',
  name: '都市と騎士',
  description: '商品・都市改善・騎士・蛮族の襲来。最も奥深い拡張ルール（13点）。',
  category: 'cities_knights',
  recommendedPlayers: '4人', // 標準19タイルはフル対戦の4人がおすすめ
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
  victoryTarget: 13,
  expansion: 'cities_knights',
};

// ============================================================
// C&K × 航海者 コンボ（公式アプリ）。航海者の盤＋「都市と騎士」拡張＋高めのVP。
// 盤は対応する航海者シナリオを再利用し、expansion を有効化して勝利点を引き上げる。
// ============================================================
const ckSeafarersNewShores: Scenario = {
  id: 'ck_seafarers_newshores',
  name: '都市と騎士：新たな海岸を目指して',
  description: '新たな岸への航海に「都市と騎士」拡張を追加。新島への初入植ごとに+2点（17点で勝利）。',
  category: 'cities_knights',
  expansion: 'cities_knights',
  coords: HUGE_COORDS,
  build: buildFromLandMap(NEW_SHORES_LAND),
  victoryTarget: 17,
  recommendedPlayers: '4人',
  rules: { newIslandBonusVp: 2 },
};
const ckSeafarersOceania: Scenario = {
  id: 'ck_seafarers_oceania',
  name: '都市と騎士：オセアニア',
  description: '霧の海の2始発島に「都市と騎士」拡張を追加。霧を晴らして島を発見（資源1枚）。15点で勝利。',
  category: 'cities_knights',
  expansion: 'cities_knights',
  coords: OCEANIA_COORDS, // 61ヘックス（2始発島＋中央の霧帯・海で確実に隔てる）
  build: buildFromLandFogMap(OCEANIA_HOME_LAND, OCEANIA_FOG),
  victoryTarget: 15,
  recommendedPlayers: '4人',
  rules: { newIslandBonusVp: 0, setupAnywhere: true },
};
const ckSeafarersGreaterCatan: Scenario = {
  id: 'ck_seafarers_greatercatan',
  name: '都市と騎士：大カタン',
  description: '大カタン（抜けている数値トークン・都市8制限）に「都市と騎士」拡張を追加。20点で勝利。',
  category: 'cities_knights',
  expansion: 'cities_knights',
  coords: HUGE_COORDS,
  build: buildGreaterCatan(GREATER_CATAN_LAND),
  victoryTarget: 20,
  recommendedPlayers: '4人',
  rules: { newIslandBonusVp: 0, maxCities: 8, missingNumberTokens: true },
};

// ============================================================
// 公式アプリ「オアシス」(photo/オアシス IMG_6410 実読): 「カタンの開拓者たち」基本ゲーム＋
//   砂漠/オアシスを“道”で探索する新メカ。船は使わず、各自30本の道で霧(=砂漠/資源)を切り開く。
//   霧の横に道を置くと晴れて砂漠か資源地が現れ、資源地なら資源1枚。財宝の辺に道を置くと獲得。10点。
// ============================================================
// 出発の陸（中央13・全5資源＋砂漠1=盗賊初期。ここで初期配置する）。
const OASIS_LAND: LandMap = {
  '0,0':   { type: 'desert',   number: null, robber: true },
  '1,0':   { type: 'forest',   number: 8 },
  '1,-1':  { type: 'field',    number: 5 },
  '0,-1':  { type: 'pasture',  number: 9 },
  '-1,0':  { type: 'mountain', number: 4 },
  '-1,1':  { type: 'hill',     number: 6 },
  '0,1':   { type: 'forest',   number: 11 },
  '2,-1':  { type: 'field',    number: 3 },
  '1,-2':  { type: 'pasture',  number: 10 },
  '0,-2':  { type: 'mountain', number: 5 },
  '-1,-1': { type: 'hill',     number: 9 },
  '-2,0':  { type: 'field',    number: 11 },
  '-2,1':  { type: 'mountain', number: 8 },
};
// 霧（砂漠/オアシス・12セル）。道で隣に到達すると晴れる。砂漠は産出なし、資源地（=オアシス）は
//   発見時に資源1枚。海(sea)は入れない＝必ず砂漠か資源が出る（公式「砂漠か資源のある土地が現れる」）。
const OASIS_FOG: FogMap = {
  '2,0':  { type: 'desert',   number: null },
  '1,1':  { type: 'pasture',  number: 4 },
  '0,2':  { type: 'desert',   number: null },
  '-1,2': { type: 'forest',   number: 9 },
  '-2,2': { type: 'desert',   number: null },
  '2,-2': { type: 'hill',     number: 10 },
  '0,-3': { type: 'desert',   number: null },
  '1,-3': { type: 'field',    number: 6 },
  '-3,2': { type: 'mountain', number: 3 },
  '-3,1': { type: 'desert',   number: null },
  '3,-2': { type: 'field',    number: 5 },
  '3,-3': { type: 'desert',   number: null },
};
// オアシスの盤を組む: 出発の陸＋霧＋財宝の辺。財宝は「霧（砂漠/オアシス）に面する辺」へ決定論配置
//   （道で到達して取れる位置）。船は使わないので harbors は無し。
function buildOasis(landMap: LandMap, fogMap: FogMap, treasureCount: number): (geo: BoardGeometry, rng: () => number) => ScenarioBoard {
  return (geo, rng) => {
    const { home, fog } = randomizeHomeAndFog(landMap, fogMap, rng);
    const tiles: Record<TileId, Tile> = {};
    for (const id of Object.keys(geo.tileToVertices)) {
      const coord = parseTileId(id);
      const land = home[id];
      const f = fog[id];
      if (land) tiles[id] = { id, coord, type: land.type, number: land.number, hasRobber: !!land.robber };
      else if (f) tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false, fog: { type: f.type, number: f.number } };
      else tiles[id] = { id, coord, type: 'sea', number: null, hasRobber: false };
    }
    // 財宝: 霧（砂漠/オアシス）に面する辺へ等間隔配置。道で到達して獲得する。
    const fogEdges = Object.values(geo.edges).filter(e => {
      const tids = edgeTileIds(e, geo.vertices);
      return tids.some(t => tiles[t]?.fog != null);
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    const edgeTokens: Record<string, EdgeTokenKind> = {};
    const step = Math.max(1, Math.floor(fogEdges.length / treasureCount));
    for (let i = 0; i < treasureCount && i * step < fogEdges.length; i++) {
      edgeTokens[fogEdges[i * step]!.id] = 'treasure';
    }
    return { tiles, harbors: [], edgeTokens };
  };
}
const seafarersOasis: Scenario = {
  id: 'oasis',
  name: 'オアシス',
  description: '基本ゲーム＋砂漠探索。各自30本の道で霧を切り開き、砂漠の奥のオアシス（資源地）や財宝を見つける（10点）。',
  category: 'basic',
  coords: BIG_COORDS, // 37ヘックス（出発の陸＋霧の砂漠）
  build: buildOasis(OASIS_LAND, OASIS_FOG, 6),
  victoryTarget: 10,
  recommendedPlayers: '4人',
  rules: { startingRoads: 30, noShips: true, newIslandBonusVp: 0 },
};

// ---- 交易と蛮族「強き港（Harbors of Catan / Strongest Ports）」変種（第6版 CN3089 p3-4） ----
// 基本19タイル盤（classic と同じ生成）に「Strongest Ports」ボーナスVPタイル(+2VP)を加えた変種。
// 港上の建物のVP合計（開拓地1・都市2）が最多（最低3VP）のプレイヤーがタイルを保持し、他者が上回れば即移動。
// タイルは2VP。勝利目標は公式どおり基本+1の11点（タイルが2点入るため実質+1の難度）。
const tbHarbors: Scenario = {
  id: 'tb_harbors',
  name: '交易と蛮族：強き港',
  description: '基本19タイル。港上の建物のVP合計が最多の人が「強き港」タイル(+2点)を得る（11点で勝利）。',
  category: 'traders_barbarians',
  recommendedPlayers: '4人',
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
  victoryTarget: 11,
  rules: { strongestPorts: true },
};

const SCENARIOS: Record<ScenarioId, Scenario> = {
  classic,
  // 公式航海者シナリオ
  seafarers_newshores: seafarersNewShores,
  seafarers_drought: seafarersDrought,
  seafarers_fourislands: seafarersFourIslands,
  seafarers_fogislands: seafarersFogIslands,
  seafarers_treasure: seafarersTreasure,
  seafarers_oceania: seafarersOceania,
  seafarers_throughdesert: seafarersThroughDesert,
  seafarers_forgottentribe: seafarersForgottenTribe,
  seafarers_cloth: seafarersCloth,
  seafarers_pirateislands: seafarersPirateIslands,
  seafarers_wonders: seafarersWonders,
  seafarers_newworld: seafarersNewWorld,
  // 非公式オリジナルマップ
  seafarers_archipelago: seafarersArchipelago,
  seafarers_goldenisles: seafarersGoldenIsles,
  seafarers_chainisles: seafarersChainIsles,
  seafarers_greatercatan: seafarersGreaterCatan,
  // C&K × 航海者 コンボ
  ck_seafarers_newshores: ckSeafarersNewShores,
  ck_seafarers_oceania: ckSeafarersOceania,
  ck_seafarers_greatercatan: ckSeafarersGreaterCatan,
  oasis: seafarersOasis,
  // 交易と蛮族（Traders & Barbarians）
  tb_harbors: tbHarbors,
  cities_knights: citiesKnights,
};

/** シナリオIDからシナリオ定義を取得（未知IDは基本にフォールバック）。 */
export function getScenario(id: ScenarioId = 'classic'): Scenario {
  return SCENARIOS[id] ?? classic;
}

// このゲーム固有の詳細ルール（遊び方オーバーレイで「いま遊んでいる盤」専用に表示する）。
// 共通ルール（手番・コスト・交易・船の基本）は別セクションに任せ、ここは“そのシナリオ特有”に絞る。
const SCENARIO_RULES: Record<ScenarioId, string[]> = {
  classic: [
    '標準の19タイル・海なし。先に10点で勝ち。',
    '盗賊は中央の砂漠から開始。7か騎士で動かし、止めたマスは資源が出ない。',
  ],
  seafarers_newshores: [
    '14点で勝ち。中央の本島から船で四方の小島へ渡って広げる。',
    '新しい島に自分が初めて開拓地を建てるたびに +2点（島ボーナス）。',
    '島ごとの資源の組み合わせは毎回固定：本島=牧草地4/森3/畑3/山2/丘2、小島=金2/丘2/森1/山2/畑1（配置だけ毎回ランダム）。',
    '金タイル（滝の絵）は数字が出ると好きな資源を選べる。必ず小島側に出る。',
  ],
  seafarers_drought: [
    '14点で勝ち。本島は砂漠だらけの痩せ地。豊かな四方の小島へ船で渡るのが鍵。',
    '新しい小島へ初入植するたびに +2点（島ボーナス）。',
    '本島に砂漠が3つ。盗賊は砂漠から開始。金2と豊かな資源は小島側にある。',
    '島ごとの資源の組み合わせは毎回固定（配置だけランダム）。',
  ],
  seafarers_treasure: [
    '13点で勝ち。中央の本島を「霧」が取り囲む。',
    '船・道・開拓地を霧に近づけると晴れて、島（=初入植+2点）か海が現れる。',
    '海辺の財宝トークン（宝箱）に船で到達すると、資源2枚 か 発展カード1枚がもらえる。',
    '霧で隠れているので、何が出るかは近づくまで分からない。',
  ],
  seafarers_fourislands: [
    '13点で勝ち。海で隔てた4つの島。どの島から始めてもよい。',
    '自分の出発島以外の島へ初入植するたびに +2点（島ボーナス）。',
  ],
  seafarers_fogislands: [
    '12点で勝ち。霧に包まれた海域を探索する盤。',
    '船・道・開拓地を霧へ伸ばすと晴れて、陸（資源1枚がもらえる）や海が現れる。',
    '霧の中に金鉱の島（金タイル）が2つ眠っている。最初に見つけた人が有利。',
    '探索の報酬は資源。この盤では島ボーナスVPは無い。',
  ],
  seafarers_oceania: [
    '12点で勝ち。霧に覆われた海に始発の島が2つ。どちらの島からでも始められる。',
    '船・道・開拓地を霧へ伸ばすと晴れて、新しい島（資源1枚がもらえる）や海が現れる。',
    '霧の中に金鉱の島も眠る。探索の報酬は資源で、この盤では島ボーナスVPは無い。',
  ],
  seafarers_throughdesert: [
    '14点で勝ち。中央の本土に砂漠帯（盗賊はそこから開始）。',
    '広い砂漠が隔てる「北西地方」（岩山の豊かな地）や、海に点在する小島3つへ船で渡る。',
    '北西地方や小島に初めて開拓地を建てるたびに +2点（島ボーナス）。',
  ],
  seafarers_forgottentribe: [
    '13点で勝ち。海に「勝利点・発展カード・港」のトークンが眠っている。',
    '船をトークンのある辺へ伸ばす（到達する）と回収。VPは即+1点、港は沿岸の開拓地に設置される。',
    '金タイルが2枚。開拓地は数字ヘックスに隣接する角にしか建てられない。',
  ],
  seafarers_cloth: [
    '14点で勝ち。小島の村へ航路（船）をつなぐと織物がもらえる（2枚で1点）。',
    '小島には入植できない。最長交易路ボーナスは無い。',
    '初期配置は開拓地3軒。海賊は最初に村へ航路をつなぐまで動かない。',
  ],
  seafarers_pirateislands: [
    '10点以上で勝ち。本島から船で自分の色の海賊要塞へ向かう。',
    '要塞に隣接して3回攻撃すると奪取できる。海賊艦隊が海を移動して略奪してくる。',
    '騎士は「軍船化」に使い、船を強化して海賊艦隊と戦う。',
  ],
  seafarers_wonders: [
    '不思議を完成させる、または10点＋最高レベルで勝ち。',
    '要件（都市数やVP）を満たして不思議をクレームし、4レベルまで建設して競う。',
    '新島ボーナスは+1点。この盤では海賊コマは使わない。',
  ],
  seafarers_newworld: [
    '12点で勝ち。毎回ランダムに作られる自由構築の盤。',
    'どの島にも入植でき、自分の出発島以外への初入植ごとに +1点。',
  ],
  seafarers_archipelago: [
    '【非公式】13点で勝ち。本島＋新島2つ。島ボーナスと金の争奪が核。',
    '新しい島への初入植ごとに +2点（島ボーナス）。',
  ],
  seafarers_goldenisles: [
    '【非公式】13点で勝ち。金タイルが3つ。好きな資源を産む金を巡るゴールドラッシュ。',
  ],
  seafarers_chainisles: [
    '【非公式】13点で勝ち。小島が点在。島ボーナスを稼ぐアイランドホッピング。',
    '新しい島への初入植ごとに +2点（島ボーナス）。',
  ],
  seafarers_greatercatan: [
    '18点で勝ち。中央の本島を、数字の無い小島群が取り囲む大きな盤。',
    '小島は「抜けている数値トークン」。道・船・開拓地で小島タイルの端に到達すると、隠れていた数字が出現して産出を始める。',
    '到達するまで小島は産出しない（早く船で渡って数字を出すのが鍵）。',
    '都市は各プレイヤー8つまで建設できる（都市制限）。',
  ],
  cities_knights: [
    '13点で勝ち。商品・都市の発展・騎士・蛮族の襲来が加わる最も奥深い拡張。',
    '都市は森=紙・牧草=布・山=金貨の商品を産む。商品で都市改善（交易/政治/科学）をレベルアップ。',
    'レベル4で都市が「メトロポリス」になり +4点。蛮族が攻めてきたら、起動した騎士の合計で守る。',
  ],
  ck_seafarers_newshores: [
    '17点で勝ち。「新たな海岸を目指して」の航海に「都市と騎士」拡張を足した複合シナリオ。',
    '中央の本島から船で四方の小島へ。新しい島への初入植ごとに +2点（島ボーナス）。',
    '都市と騎士の要素（商品・都市改善・騎士・蛮族の襲来）もすべて適用される。',
  ],
  ck_seafarers_oceania: [
    '15点で勝ち。「オセアニア」の霧の探索に「都市と騎士」拡張を足した複合シナリオ。',
    '2つの始発島から、霧を晴らして島を発見（資源1枚）。金鉱の島も眠る。',
    '都市と騎士の要素（商品・都市改善・騎士・蛮族の襲来）もすべて適用される。',
  ],
  ck_seafarers_greatercatan: [
    '20点で勝ち。「大カタン」に「都市と騎士」拡張を足した最大級の複合シナリオ。',
    '小島は到達するまで数字が出ず産出しない（抜けている数値トークン）。都市は8つまで。',
    '都市と騎士の要素（商品・都市改善・騎士・蛮族の襲来）もすべて適用される。',
  ],
  oasis: [
    '10点で勝ち。基本ゲームのルールで、目の前の広大な砂漠を探索する盤（船は使わない）。',
    '各プレイヤーに道が30本。砂漠（霧）の横に道を置くと晴れて、砂漠か資源地（オアシス）が現れる。',
    'オアシス（資源地）を発見すると資源1枚。砂漠の奥に道を伸ばして探索を進める。',
    '財宝が砂漠やオアシスに眠る。財宝の辺に道を置くと、資源や発展カードがもらえる。',
  ],
  tb_harbors: [
    '11点で勝ち。基本19タイルに「強き港（Strongest Ports）」タイルが加わる。',
    '港（2:1/3:1）の上に建てた建物のVP合計（開拓地1・都市2）が最も多い人が「強き港」タイル（+2点）を得る。',
    '最初に港建物の合計3点に達した人が獲得。以後は他の人がそれを上回ると即その人へ移る。',
  ],
};

/** このゲーム固有の詳細ルール（遊び方表示用）。未知IDは基本のルールにフォールバック。 */
export function getScenarioRules(id: string): string[] {
  return SCENARIO_RULES[id as ScenarioId] ?? SCENARIO_RULES.classic;
}

export interface ScenarioInfo {
  id: ScenarioId;
  name: string;
  description: string;
  category: 'basic' | 'seafarers' | 'cities_knights' | 'traders_barbarians';
  victoryTarget: number;
  recommendedPlayers: string;
}
/** UI/設定で使うシナリオ一覧（id, 表示名, 説明, カテゴリ, 勝利点, おすすめ人数）。 */
export function listScenarios(): ReadonlyArray<ScenarioInfo> {
  return (Object.keys(SCENARIOS) as ScenarioId[]).map(id => {
    const s = SCENARIOS[id];
    return {
      id, name: s.name, description: s.description, category: s.category,
      victoryTarget: s.victoryTarget ?? 10,
      recommendedPlayers: s.recommendedPlayers ?? DEFAULT_RECOMMENDED_PLAYERS,
    };
  });
}

// 選択UIに出すシナリオ（ユーザー選定）。他のシナリオは実装・テストは残すが、盤面選択カードには出さない。
const VISIBLE_SCENARIO_IDS: ReadonlySet<ScenarioId> = new Set<ScenarioId>([
  'classic',
  'cities_knights',
  // 航海者（公式アプリ準拠で画像から再構築済み）
  'seafarers_newshores',
  'seafarers_drought',
  'seafarers_treasure',
  'seafarers_fourislands',
  'seafarers_fogislands',
  'seafarers_oceania',
  'seafarers_throughdesert',
  'seafarers_greatercatan',
  // 都市と騎士 × 航海者 コンボ
  'ck_seafarers_newshores',
  'ck_seafarers_oceania',
  'ck_seafarers_greatercatan',
  // 基本ゲーム＋砂漠探索
  'oasis',
  // 交易と蛮族
  'tb_harbors',
]);
/** 盤面選択UIに表示するシナリオ一覧（listScenarios のうち VISIBLE のみ）。 */
export function listVisibleScenarios(): ReadonlyArray<ScenarioInfo> {
  return listScenarios().filter(s => VISIBLE_SCENARIO_IDS.has(s.id));
}
