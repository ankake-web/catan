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
  | 'seafarers_fourislands'    // 公式S2 4つの島
  | 'seafarers_fogislands'     // 公式S3 霧の島
  | 'seafarers_throughdesert'  // 公式S4 砂漠を越えて
  | 'seafarers_forgottentribe' // 公式S5 忘れられた部族
  | 'seafarers_cloth'          // 公式S6 カタンの織物
  | 'seafarers_pirateislands'  // 公式S7 海賊の島々
  | 'seafarers_wonders'        // 公式S8 カタンの七不思議
  | 'seafarers_newworld'       // 公式 New World（自由構築）
  | 'seafarers_archipelago'    // 非公式
  | 'seafarers_goldenisles'    // 非公式
  | 'seafarers_chainisles'     // 非公式
  | 'seafarers_greatercatan'   // 非公式
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
const FOUR_ISLANDS_COORDS = BIG_COORDS; // S2 は 37ヘックス（4島）

// ---- 航海者「新たな海岸を目指して」（公式S1・37ヘックス級） ----
// 本島(左 q=-3..-1 = 15タイル・全5資源＋砂漠)＋海峡(q=0列＝海)＋新しい島(右 7タイル・金2)。
//   公式コンポ目安(35)に寄せた拡張版。本島が一意最大・新島へは船で渡り初入植+2点。
const NEW_SHORES_LAND: Record<string, { type: TileType; number: number | null; robber?: boolean }> = {
  // 本島（左 15・全5資源＋砂漠=盗賊初期）
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
  // 公式S1は砂漠なし。盗賊初期はこの牧草(数字3・非赤)に置く＝盤上のヘックス数を公式(牧草5/砂漠0)に一致。
  '-1,-1': { type: 'pasture',  number: 3, robber: true },
  '-1,0':  { type: 'mountain', number: 2 },
  '-1,1':  { type: 'pasture',  number: 9 },
  '-1,2':  { type: 'forest',   number: 10 },
  '-1,3':  { type: 'mountain', number: 5 },
  // 新しい島（右 7・連続・金2）。残りの q>=1 と q=0 列は海。
  '1,-2':  { type: 'field',    number: 4 },
  '1,-1':  { type: 'gold',     number: 5 },  // 金（任意資源）
  '1,0':   { type: 'pasture',  number: 11 },
  '2,-2':  { type: 'hill',     number: 9 },  // 公式の丘4/森3に合わせ森→丘
  '2,-1':  { type: 'hill',     number: 3 },
  '3,-2':  { type: 'gold',     number: 4 },  // 金2枚目
  '3,-1':  { type: 'mountain', number: 6 },
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

// 公式構成（資源/数字の枚数）を維持して中身を毎ゲームランダム化し、港もランダム配置して盤を組む共通ビルダ。
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
    const home = randomizeLandMap(landMap, rng);
    const fog = randomizeFogMap(fogMap, rng);
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
  coords: BIG_COORDS,
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

// ---- 公式S4「砂漠を越えて」：本島(左12)から広い大洋を渡った先に、砂漠を含む新天地（右奥 q=2,3）。
//   長い航路で渡り、新天地への初入植ごとに各自+2VP。金タイル2枚。14点。
//   ※公式の「砂漠帯で陸を分断」は、デジタル版では大洋＋砂漠を含む別島として表現（地図画像があれば作り込む）。
const THROUGH_DESERT_LAND: LandMap = {
  ...BIG_MAIN_ISLAND,                         // 本島15（全5資源＋砂漠 -1,-1=盗賊初期）
  // 海を渡った新天地（右 10・連続）。砂漠帯を含み、金2。初入植+2点。
  // 公式3人用の陸構成（砂漠3/森5/山4/丘3/牧草4/畑4/金2＝陸25・数字22）に一致させるため、
  // 新天地を 7→10 へ拡張（海3枚を砂漠/森/山に。本島には触れない）。
  '1,-2': { type: 'field',    number: 4 },
  '1,-1': { type: 'gold',     number: 5 },    // 金1
  '1,0':  { type: 'pasture',  number: 11 },
  '2,-2': { type: 'desert',   number: null }, // 砂漠帯（盗賊なし）
  '2,-1': { type: 'forest',   number: 9 },
  '3,-2': { type: 'gold',     number: 4 },    // 金2
  '3,-1': { type: 'hill',     number: 3 },
  '1,-3': { type: 'forest',   number: 3 },    // 拡張: 森（公式森5へ）
  '2,-3': { type: 'mountain', number: 11 },   // 拡張: 山（公式山4へ）
  '3,-3': { type: 'desert',   number: null }, // 拡張: 砂漠帯（公式砂漠3へ）
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

// ---- 大連邦：海を少なくした大きな一枚陸。船は控えめ、人数多めでも遊べる大盤（12点）。 ----
// 本島を右へ拡張して大陸化。沿岸に港、奥に金1。新島ボーナスは発生しない（1つの陸塊）。
const GREATER_CATAN_LAND: LandMap = {
  ...MAIN_ISLAND,
  '0,-2': { type: 'forest',   number: 3 },
  '0,-1': { type: 'field',    number: 11 },
  '0,0':  { type: 'pasture',  number: 6 },
  '0,1':  { type: 'hill',     number: 9 },   // 赤6/8隣接回避（0,0=6と隣接のため非赤9に）
  '1,-2': { type: 'mountain', number: 4 },
  '1,-1': { type: 'gold',     number: 10 },
  '1,0':  { type: 'forest',   number: 9 },
  '1,1':  { type: 'field',    number: 3 },
  '2,-1': { type: 'pasture',  number: 5 },
  '2,0':  { type: 'mountain', number: 11 },
  '2,-2': { type: 'hill',     number: 12 },
};

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

function randomizeLandMap(landMap: LandMap, rng: () => number): LandMap {
  const cells = Object.keys(landMap);
  const typePool: TileType[] = cells.map(c => landMap[c]!.type);
  const numberPool: number[] = cells
    .filter(c => landMap[c]!.type !== 'desert')
    .map(c => landMap[c]!.number)
    .filter((n): n is number => n != null);
  const goldCount = typePool.filter(t => t === 'gold').length;
  const nonGoldTypes = typePool.filter(t => t !== 'gold');
  // 本島=最大連結成分、離れ小島=その他のセル。
  const comps = landComponents(cells).sort((a, b) => b.length - a.length);
  const main = comps[0] ?? cells;
  const mainSet = new Set(main);
  const outlying = cells.filter(c => !mainSet.has(c));

  for (let attempt = 0; attempt < 400; attempt++) {
    // 1) 金を離れ小島のランダムなセルへ（不足時のみ任意セルで補う）。
    const goldCells = shuffleWithRng(outlying, rng).slice(0, goldCount);
    if (goldCells.length < goldCount) {
      const more = shuffleWithRng(cells.filter(c => !goldCells.includes(c)), rng)
        .slice(0, goldCount - goldCells.length);
      goldCells.push(...more);
    }
    const goldSet = new Set(goldCells);
    // 2) 残りセルへ非金種別をシャッフル配置。
    const rest = cells.filter(c => !goldSet.has(c));
    const shuffledTypes = shuffleWithRng(nonGoldTypes, rng);
    const tType: Record<string, TileType> = {};
    for (const c of goldCells) tType[c] = 'gold';
    rest.forEach((c, i) => { tType[c] = shuffledTypes[i]!; });
    // 3) 数字を非砂漠セルへシャッフル配置。
    const numbered = cells.filter(c => tType[c] !== 'desert');
    const nums = shuffleWithRng(numberPool, rng);
    const tNum: Record<string, number> = {};
    numbered.forEach((c, i) => { tNum[c] = nums[i]!; });
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
    // 盗賊: 砂漠（あれば最初の1枚）。無ければ本島の非赤タイル。
    let robberCell = cells.find(c => tType[c] === 'desert');
    if (!robberCell) {
      robberCell = shuffleWithRng(main, rng).find(c => !isRedNum(tNum[c])) ?? main[0];
    }
    const map: LandMap = {};
    for (const c of cells) {
      map[c] = tType[c] === 'desert'
        ? { type: 'desert', number: null, robber: c === robberCell }
        : { type: tType[c]!, number: tNum[c]!, robber: c === robberCell };
    }
    return map;
  }
  return landMap; // フォールバック（元マップ・制約充足済みの“正”）
}

// 霧マップ（fogMap）の中身を毎ゲームランダム化（どのセルが陸/海か・地形・数字をシャッフル。枚数不変）。
function randomizeFogMap(fogMap: FogMap, rng: () => number): FogMap {
  const cells = Object.keys(fogMap);
  const landTypes = cells.filter(c => fogMap[c]!.type !== 'sea').map(c => fogMap[c]!.type);
  const numbers = cells
    .filter(c => fogMap[c]!.type !== 'sea')
    .map(c => fogMap[c]!.number)
    .filter((n): n is number => n != null);
  const seaCount = cells.length - landTypes.length;
  const shuffled = shuffleWithRng(cells, rng);
  const seaCells = new Set(shuffled.slice(0, seaCount));
  const landCells = shuffled.slice(seaCount);
  const types = shuffleWithRng(landTypes, rng);
  const nums = shuffleWithRng(numbers, rng);
  const out: FogMap = {};
  for (const c of seaCells) out[c] = { type: 'sea', number: null };
  landCells.forEach((c, i) => { out[c] = { type: types[i]!, number: nums[i]! }; });
  return out;
}

const seafarersThroughDesert: Scenario = {
  id: 'seafarers_throughdesert',
  name: '航海者：砂漠を越えて',
  description: '本島から広い大洋を渡り、砂漠を含む新天地へ。新天地への初入植ごとに+2点（14点で勝利）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildFromLandMap(THROUGH_DESERT_LAND),
  victoryTarget: 14,
  rules: { newIslandBonusVp: 2 },
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

// ---- 公式S3「霧の島」: 本島(左12)の周りに霧の海域。船/道/開拓地で進むと霧が晴れ、
//   陸なら数字＋資源1枚が出現（探索の報酬）。12点。 ----
// 霧（右側 q>=1 の全15セル）。表向きは海、探索で公開＝陸9/海6。
const FOG_HIDDEN: FogMap = {
  '1,-3': { type: 'sea',     number: null },
  '1,-2': { type: 'forest',  number: 5 },
  '1,-1': { type: 'field',   number: 4 },
  '1,0':  { type: 'pasture', number: 9 },
  '1,1':  { type: 'sea',     number: null },
  '1,2':  { type: 'hill',    number: 3 },
  '2,-3': { type: 'sea',     number: null },
  '2,-2': { type: 'mountain',number: 6 },
  '2,-1': { type: 'field',   number: 5 },
  '2,0':  { type: 'sea',     number: null },
  '2,1':  { type: 'forest',  number: 8 },
  '3,-3': { type: 'sea',     number: null },
  '3,-2': { type: 'pasture', number: 4 },
  '3,-1': { type: 'hill',    number: 9 },
  '3,0':  { type: 'sea',     number: null },
};
const seafarersFogIslands: Scenario = {
  id: 'seafarers_fogislands',
  name: '航海者：霧の島',
  description: '霧に包まれた海域。船・道・開拓地で進むたびに霧が晴れ、島や資源が現れる（12点）。',
  category: 'seafarers',
  coords: BIG_COORDS,
  build: buildFromLandFogMap(BIG_MAIN_ISLAND, FOG_HIDDEN),
  victoryTarget: 12,
  rules: { newIslandBonusVp: 0 }, // 探索の報酬は資源（島ボーナスVPは無し）
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
// 37ヘックス footprint に、互いに海で隔てた4島を配置。公式3人用の陸構成（各資源4ずつ＝陸20・
// 砂漠0・金0・数字20）に一致させる: 島Aを6タイルへ拡張（'-3,0'牧草・島Aのみに隣接）し、
// 島Bの砂漠を山に置換（盗賊初期は維持）。島サイズ A6/B5/C4/D5（公式『大きさの近い4島』）。
const FOUR_ISLANDS_LAND: LandMap = {
  // 島A（西・6）
  '-3,0': { type: 'pasture',  number: 11 }, // 拡張: 島Aのみに隣接する海→牧草（公式 牧草4へ）
  '-3,1': { type: 'forest',   number: 8 },
  '-3,2': { type: 'field',    number: 5 },
  '-2,1': { type: 'hill',     number: 9 },
  '-2,2': { type: 'mountain', number: 4 },
  '-3,3': { type: 'pasture',  number: 10 },
  // 島B（北・5・盗賊初期）。公式S2は砂漠なし＝山に置換（盗賊はこの山に置く）。
  '0,-3': { type: 'forest',   number: 6 },
  '1,-3': { type: 'field',    number: 3 },
  '0,-2': { type: 'mountain', number: 2, robber: true }, // 砂漠→山（公式 山4へ・盗賊初期）
  '1,-2': { type: 'hill',     number: 5 },
  '2,-3': { type: 'mountain', number: 9 },
  // 島C（東）
  '2,-1': { type: 'forest',   number: 4 },
  '3,-2': { type: 'field',    number: 10 },
  '3,-1': { type: 'pasture',  number: 8 },
  '3,0':  { type: 'hill',     number: 4 },   // 赤数字6/8の隣接回避（3,-1=8と隣接のため非赤4に）
  // 島D（南）
  '0,1':  { type: 'forest',   number: 9 },
  '0,2':  { type: 'field',    number: 5 },
  '0,3':  { type: 'mountain', number: 4 },
  '1,1':  { type: 'pasture',  number: 3 },
  '1,2':  { type: 'hill',     number: 11 },
};
const seafarersFourIslands: Scenario = {
  id: 'seafarers_fourislands',
  name: '航海者：4つの島',
  description: '海で隔てた4つの島。どの島から始めてもよく、出発島以外への初入植ごとに+2点（13点）。',
  category: 'seafarers',
  coords: FOUR_ISLANDS_COORDS,
  build: buildFromLandMap(FOUR_ISLANDS_LAND),
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
  recommendedPlayers: '4人', // 標準19タイルはフル対戦の4人がおすすめ
  coords: () => getAllTileCoords(),
  build: (geo, rng) => createRandomBoard(geo, rng),
  victoryTarget: 13,
  expansion: 'cities_knights',
};

const SCENARIOS: Record<ScenarioId, Scenario> = {
  classic,
  // 公式航海者シナリオ
  seafarers_newshores: seafarersNewShores,
  seafarers_fourislands: seafarersFourIslands,
  seafarers_fogislands: seafarersFogIslands,
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
