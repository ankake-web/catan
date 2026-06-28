// ============================================================
// src/renderer/events.ts — F-02: ボードクリックイベント処理
// ============================================================

import type { GameState, Action, PlayerId, CkTrack } from '../types';
import { canBuildRoad, canBuildShip, canBuildSettlement, canBuildCity, canMoveShip, isShipMovable } from '../engine/actions';
import { canMoveKnight, isKnightMovable, robberAdjacentChasableVertexIds, canBuildKnight, canActivateKnight, canUpgradeKnight, merchantTileIds, inventorTiles, bishopTileIds, diplomatRemovableRoads, deserterTargets, medicineSettlements, metropolisCityChoices, smithKnightTargets, engineerWallCities, intrigueKnightTargets } from '../engine/citiesKnights';
import { getPirateRobbablePlayerIds, robbableCardCount, pirateRobbableCount } from '../engine/robber';

// 公開情報での奪取可能枚数（LANではマスクされ handCount/commodityCount に枚数が入る。
// 騎士と商人では商品も奪取対象なので合算する）。エンジンの判定と一致させる。
function publicCardCount(state: GameState, p: PlayerId): number {
  return robbableCardCount(state, p);
}
// 海賊の奪取可能枚数（S6「カタンの織物」では織物トークンも対象）。エンジンの MOVE_PIRATE と一致させる。
function piratePublicCardCount(state: GameState, p: PlayerId): number {
  return pirateRobbableCount(state, p);
}
import type { UIPhase } from './ui';
import type { BoardViewport } from './board';

// ============================================================
// 型定義
// ============================================================

export type BuildMode = 'idle' | 'road' | 'ship' | 'settlement' | 'city' | 'moveShip' | 'moveKnight' | 'chaseRobber' | 'buildKnight' | 'activateKnight' | 'upgradeKnight' | 'placeMerchant' | 'inventorSwap' | 'placeBishop' | 'selectDiplomatRoad' | 'selectDeserterKnight' | 'selectMedicineSettlement' | 'selectMetropolis' | 'selectSmithKnight' | 'selectEngineerCity' | 'selectIntrigueKnight' | 'selectWallCity';

// タップ命中の許容半径（盤面ピクセル単位。頂点間隔は HEX_SIZE=60）。
// 見た目の点/線より広く取り、指でも外れにくくする。最近傍の合法ターゲットを選ぶため、
// 多少広めでも誤爆しない（より近い候補が優先される）。
const VERTEX_TAP_RADIUS = 38;
const EDGE_TAP_RADIUS = 26;

// ============================================================
// 配置フェーズ判定（純粋）
// ============================================================

function wantsSettlement(state: GameState, mode: BuildMode): boolean {
  const isSetup = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
  if (isSetup) return state.setupSubPhase === 'PLACE_SETTLEMENT';
  return state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'settlement';
}
function wantsCity(state: GameState, mode: BuildMode): boolean {
  return state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'city';
}
function wantsRoad(state: GameState, mode: BuildMode): boolean {
  const isSetup = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
  if (isSetup) return state.setupSubPhase === 'PLACE_ROAD';
  return state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD'
    && (mode === 'road' || state.roadBuildingRoadsRemaining > 0);
}
// 航海者: 船の配置を受け付けるか（MAIN の船モード、または街道建設カード使用中＝道2/船2/道1+船1）。
function wantsShip(state: GameState, mode: BuildMode): boolean {
  return state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD'
    && (mode === 'ship' || state.roadBuildingRoadsRemaining > 0);
}

// ============================================================
// 最近傍の合法ターゲット探索（純粋・盤面ピクセル座標で判定）
// ============================================================

/** 点(x,y)に最も近い合法な開拓地/都市の頂点IDを maxDist 内で返す。なければ null。 */
export function nearestValidVertexId(
  state: GameState, pid: PlayerId, mode: BuildMode, x: number, y: number, maxDist = VERTEX_TAP_RADIUS,
): string | null {
  const city = wantsCity(state, mode);
  if (!city && !wantsSettlement(state, mode)) return null;
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const v of Object.values(state.vertices)) {
    const ok = city ? canBuildCity(state, pid, v.id) : canBuildSettlement(state, pid, v.id);
    if (!ok) continue;
    const dx = v.pixel.x - x, dy = v.pixel.y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = v.id; }
  }
  return best;
}

// 点(px,py)と線分(ax,ay)-(bx,by)の距離の二乗。
function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** 点(x,y)に最も近い合法な道の辺IDを maxDist 内で返す。なければ null。 */
export function nearestValidEdgeId(
  state: GameState, pid: PlayerId, mode: BuildMode, x: number, y: number, maxDist = EDGE_TAP_RADIUS,
): string | null {
  if (!wantsRoad(state, mode)) return null;
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const e of Object.values(state.edges)) {
    if (!canBuildRoad(state, pid, e.id)) continue;
    const a = state.vertices[e.vertexIds[0]];
    const b = state.vertices[e.vertexIds[1]];
    if (!a || !b) continue;
    const d = distToSegmentSq(x, y, a.pixel.x, a.pixel.y, b.pixel.x, b.pixel.y);
    if (d <= bestD) { bestD = d; best = e.id; }
  }
  return best;
}

/**
 * 船移動モードで、点(x,y)に最も近い「操作対象の辺」を返す（航海者・Phase 4）。
 *   from 未選択: 自分の動かせる船の辺（isShipMovable）。
 *   from 選択済: その船の合法な移動先の海辺（canMoveShip）。さらに from 自身も返す（再タップで解除）。
 */
export function nearestMoveShipEdgeId(
  state: GameState, pid: PlayerId, from: string | null, x: number, y: number, maxDist = EDGE_TAP_RADIUS,
): string | null {
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const e of Object.values(state.edges)) {
    const ok = from == null
      ? (e.ship?.playerId === pid && isShipMovable(state, pid, e.id))
      : (e.id === from || canMoveShip(state, pid, from, e.id));
    if (!ok) continue;
    const a = state.vertices[e.vertexIds[0]];
    const b = state.vertices[e.vertexIds[1]];
    if (!a || !b) continue;
    const d = distToSegmentSq(x, y, a.pixel.x, a.pixel.y, b.pixel.x, b.pixel.y);
    if (d <= bestD) { bestD = d; best = e.id; }
  }
  return best;
}

/**
 * 騎士移動モードで、点(x,y)に最も近い「操作対象の頂点」を返す（騎士と商人）。
 *   from 未選択: 自分の動かせる起動騎士の頂点。
 *   from 選択済: その騎士の合法な移動先頂点（canMoveKnight）。from 自身も返す（再タップで解除）。
 */
export function nearestMoveKnightVertexId(
  state: GameState, pid: PlayerId, from: string | null, x: number, y: number, maxDist = VERTEX_TAP_RADIUS,
): string | null {
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const v of Object.values(state.vertices)) {
    const ok = from == null ? isKnightMovable(state, pid, v.id) : (v.id === from || canMoveKnight(state, pid, from, v.id));
    if (!ok) continue;
    const dx = v.pixel.x - x, dy = v.pixel.y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = v.id; }
  }
  return best;
}

/** 点(x,y)に最も近い「述語を満たす頂点」を返す。なければ null（騎士の配置/起動/昇格で共用）。 */
function nearestVertexMatching(
  state: GameState, pred: (vid: string) => boolean, x: number, y: number, maxDist = VERTEX_TAP_RADIUS,
): string | null {
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const v of Object.values(state.vertices)) {
    if (!pred(v.id)) continue;
    const dx = v.pixel.x - x, dy = v.pixel.y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = v.id; }
  }
  return best;
}
/** 点(x,y)に最も近い「騎士を建てられる合法頂点」を返す（騎士と商人・手動配置）。 */
export function nearestBuildKnightVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  return nearestVertexMatching(state, vid => canBuildKnight(state, pid, vid), x, y, maxDist);
}
/** 点(x,y)に最も近い「起動できる自分の騎士頂点」を返す（騎士と商人・手動起動）。 */
export function nearestActivateKnightVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  return nearestVertexMatching(state, vid => canActivateKnight(state, pid, vid), x, y, maxDist);
}
/** 点(x,y)に最も近い「昇格できる自分の騎士頂点」を返す（騎士と商人・手動昇格）。 */
export function nearestUpgradeKnightVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  return nearestVertexMatching(state, vid => canUpgradeKnight(state, pid, vid), x, y, maxDist);
}
/** 点(x,y)に最も近い「格下げ対象の平の都市」頂点を返す（蛮族敗北・対象プレイヤーの都市のみ）。 */
export function nearestDowngradableCityId(state: GameState, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const pending = new Set(state.pendingCityDowngrade ?? []);
  return nearestVertexMatching(state, vid => {
    const b = state.vertices[vid]?.building;
    return !!b && b.type === 'city' && !b.metropolis && pending.has(b.playerId);
  }, x, y, maxDist);
}

/** 点(x,y)に最も近いタイル（中心=頂点平均）のIDを maxDist 内で返す。盗賊のタイル選択スナップ用。 */
export function nearestTileId(
  state: GameState, x: number, y: number, maxDist = 70,
): string | null {
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const tid of Object.keys(state.tiles)) {
    const vids = state.tileToVertices[tid] ?? [];
    let cx = 0, cy = 0, n = 0;
    for (const vid of vids) { const v = state.vertices[vid]; if (v) { cx += v.pixel.x; cy += v.pixel.y; n++; } }
    if (n === 0) continue;
    cx /= n; cy /= n;
    const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d <= bestD) { bestD = d; best = tid; }
  }
  return best;
}

/** 点(x,y)に最も近い「商人を置ける自分の隣接資源タイル」を返す（騎士と商人・進歩カード商人）。なければ null。 */
export function nearestMerchantTileId(
  state: GameState, pid: PlayerId, x: number, y: number, maxDist = 70,
): string | null {
  const valid = new Set(merchantTileIds(state, pid));
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const tid of valid) {
    const vids = state.tileToVertices[tid] ?? [];
    let cx = 0, cy = 0, n = 0;
    for (const vid of vids) { const v = state.vertices[vid]; if (v) { cx += v.pixel.x; cy += v.pixel.y; n++; } }
    if (n === 0) continue;
    cx /= n; cy /= n;
    const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d <= bestD) { bestD = d; best = tid; }
  }
  return best;
}

/** 点(x,y)に最も近い「発明家で入替可能なタイル」を返す（数字あり・2/12/6/8以外）。なければ null。 */
export function nearestInventorTileId(
  state: GameState, x: number, y: number, maxDist = 70,
): string | null {
  const valid = new Set(inventorTiles(state));
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const tid of valid) {
    const vids = state.tileToVertices[tid] ?? [];
    let cx = 0, cy = 0, n = 0;
    for (const vid of vids) { const v = state.vertices[vid]; if (v) { cx += v.pixel.x; cy += v.pixel.y; n++; } }
    if (n === 0) continue;
    cx /= n; cy /= n;
    const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d <= bestD) { bestD = d; best = tid; }
  }
  return best;
}

/** 僧正(bishop): 点(x,y)に最も近い「盗賊を置ける陸タイル」を返す。なければ null。 */
export function nearestBishopTileId(state: GameState, x: number, y: number, maxDist = 70): string | null {
  const valid = new Set(bishopTileIds(state));
  let best: string | null = null; let bestD = maxDist * maxDist;
  for (const tid of valid) {
    const vids = state.tileToVertices[tid] ?? [];
    let cx = 0, cy = 0, n = 0;
    for (const vid of vids) { const v = state.vertices[vid]; if (v) { cx += v.pixel.x; cy += v.pixel.y; n++; } }
    if (n === 0) continue;
    cx /= n; cy /= n;
    const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d <= bestD) { bestD = d; best = tid; }
  }
  return best;
}

/** 外交官(diplomat): 点(x,y)に最も近い「撤去できる相手の端の道」辺IDを返す。なければ null。 */
export function nearestDiplomatEdgeId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = EDGE_TAP_RADIUS): string | null {
  const valid = new Set(diplomatRemovableRoads(state, pid));
  let best: string | null = null; let bestD = maxDist * maxDist;
  for (const eid of valid) {
    const e = state.edges[eid]; if (!e) continue;
    const a = state.vertices[e.vertexIds[0]]; const b = state.vertices[e.vertexIds[1]];
    if (!a || !b) continue;
    const d = distToSegmentSq(x, y, a.pixel.x, a.pixel.y, b.pixel.x, b.pixel.y);
    if (d <= bestD) { bestD = d; best = eid; }
  }
  return best;
}

/** 脱走兵(deserter): 点(x,y)に最も近い「消せる相手の騎士頂点」を返す。なければ null。 */
export function nearestDeserterVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(deserterTargets(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** 医術(medicine): 点(x,y)に最も近い「都市化できる自分の開拓地頂点」を返す。なければ null。 */
export function nearestMedicineVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(medicineSettlements(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** メトロポリス: 点(x,y)に最も近い「メトロポリス化できる自分の都市頂点」を返す。なければ null。 */
export function nearestMetropolisVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(metropolisCityChoices(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** 鍛冶屋(smith): 点(x,y)に最も近い「1段昇格できる自分の騎士頂点」を返す。なければ null。 */
export function nearestSmithKnightVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(smithKnightTargets(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** 技師(engineer): 点(x,y)に最も近い「城壁を建てられる自分の都市頂点」を返す。なければ null。 */
export function nearestEngineerCityVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(engineerWallCities(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** 陰謀(intrigue): 点(x,y)に最も近い「自分の道/船に隣接する敵騎士頂点」を返す。なければ null。 */
export function nearestIntrigueKnightVertexId(state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS): string | null {
  const valid = new Set(intrigueKnightTargets(state, pid));
  return nearestVertexMatching(state, vid => valid.has(vid), x, y, maxDist);
}

/** 点(x,y)に最も近い「強盗を追い払える自分のアクティブ騎士頂点」を返す（騎士と商人）。なければ null。 */
export function nearestChaseRobberVertexId(
  state: GameState, pid: PlayerId, x: number, y: number, maxDist = VERTEX_TAP_RADIUS,
): string | null {
  const chasable = new Set(robberAdjacentChasableVertexIds(state, pid));
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const vid of chasable) {
    const v = state.vertices[vid];
    if (!v) continue;
    const dx = v.pixel.x - x, dy = v.pixel.y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = vid; }
  }
  return best;
}

/** 点(x,y)に最も近い合法な船の辺IDを maxDist 内で返す（航海者）。なければ null。 */
export function nearestValidShipEdgeId(
  state: GameState, pid: PlayerId, mode: BuildMode, x: number, y: number, maxDist = EDGE_TAP_RADIUS,
): string | null {
  if (!wantsShip(state, mode)) return null;
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const e of Object.values(state.edges)) {
    if (!canBuildShip(state, pid, e.id)) continue;
    const a = state.vertices[e.vertexIds[0]];
    const b = state.vertices[e.vertexIds[1]];
    if (!a || !b) continue;
    const d = distToSegmentSq(x, y, a.pixel.x, a.pixel.y, b.pixel.x, b.pixel.y);
    if (d <= bestD) { bestD = d; best = e.id; }
  }
  return best;
}

// 画面座標(clientX/Y)を盤面ピクセル座標（vertex.pixel と同じ系）へ変換する。
// content グループの CTM 逆行列で content ローカル座標(=pixel+offset)に直し、offset を引く。
function clickToBoardPixel(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const content = svg.querySelector('.board-content') as SVGGElement | null;
  const ctm = content?.getScreenCTM();
  if (!content || !ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  const ox = Number(content.dataset.ox ?? 0);
  const oy = Number(content.dataset.oy ?? 0);
  return { x: local.x - ox, y: local.y - oy };
}

// ============================================================
// イベント登録（一度だけ呼ぶ）
// ============================================================

export function attachBoardEvents(
  svg: SVGSVGElement,
  getState: () => GameState,
  getBuildMode: () => BuildMode,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (action: Action) => void,
  canAct: () => boolean = () => true,
  // 航海者・船移動モード: 選択中の移動元の取得/設定（未指定＝船移動UI無効）。
  getMoveShipFrom: () => string | null = () => null,
  setMoveShipFrom: (eid: string | null) => void = () => {},
  // 騎士と商人・騎士移動モード: 選択中の移動元頂点。
  getMoveKnightFrom: () => string | null = () => null,
  setMoveKnightFrom: (vid: string | null) => void = () => {},
  // 騎士と商人・発明家(inventorSwap)モード: 1枚目に選んだタイルID。
  getInventorFirst: () => string | null = () => null,
  setInventorFirst: (tid: string | null) => void = () => {},
  // 騎士と商人・メトロポリス手動選択(selectMetropolis)モード: 今+1する都市改善ツリー。
  getMetropolisTrack: () => CkTrack | null = () => null,
  // 騎士と商人・鍛冶屋(selectSmithKnight)モード: 1体目に選んだ騎士頂点ID（2体目のタップで昇格）。
  getSmithFirst: () => string | null = () => null,
  setSmithFirst: (vid: string | null) => void = () => {},
): void {
  svg.addEventListener('click', (e) => {
    // 直前のパン/ピンチで動いた指のクリックは配置に使わない（誤配置防止）。
    if (consumeSuppressClick()) return;
    // 手番の操作権が無い（ローカルでCPUの手番 / LANで他人の手番）なら盤面操作を無視する。
    // これが無いとCPUの盗賊待ち時間に人間がタイルをタップして盗賊移動・盗み相手選択・
    // 初期配置・街道建設の道を代行でき、エンジンは手番プレイヤーの合法手として受理してしまう。
    if (!canAct()) return;
    const target = e.target as SVGElement;
    const state = getState();
    const pid = state.playerOrder[state.currentPlayerIndex]!;
    const mode = getBuildMode();

    // ---- 盗賊フェーズ: タイル。直接ヒット優先、外したら最近傍タイルへスナップ（光ったタイルを選びやすく）----
    if (state.phase === 'MAIN' && state.turnPhase === 'ROBBER') {
      let tileId = target.closest('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;
      if (!tileId) {
        const pt = clickToBoardPixel(svg, e.clientX, e.clientY);
        if (pt) tileId = nearestTileId(state, pt.x, pt.y);
      }
      if (tileId) handleTileClick(tileId, state, pid, setUIPhase, dispatch);
      return;
    }

    // ---- 騎士と商人: 蛮族敗北の都市格下げ。盤面で（格下げ対象の）光った都市をタップ → DOWNGRADE_CITY ----
    // 駒（都市画像）を直接タップした場合を最優先。外しても広めの距離でスナップして取りこぼさない。
    if (state.phase === 'MAIN' && state.turnPhase === 'CITY_DOWNGRADE') {
      const pendingSet = new Set(state.pendingCityDowngrade ?? []);
      const isDowngradable = (vid: string | null): boolean => {
        const b = vid ? state.vertices[vid]?.building : null;
        return !!b && b.type === 'city' && !b.metropolis && pendingSet.has(b.playerId);
      };
      // 1) 直接ヒット（建物/頂点要素）。
      let vid = (e.target as SVGElement).closest('[data-vertex-id]')?.getAttribute('data-vertex-id') ?? null;
      if (!isDowngradable(vid)) vid = null;
      // 2) 近傍スナップ（広め=60px。都市は疎なので誤爆しにくい）。
      if (!vid) {
        const ptd = clickToBoardPixel(svg, e.clientX, e.clientY);
        vid = ptd ? nearestDowngradableCityId(state, ptd.x, ptd.y, 60) : null;
      }
      const owner = vid ? state.vertices[vid]?.building?.playerId : null;
      if (vid && owner) dispatch({ type: 'DOWNGRADE_CITY', playerId: owner, vertexId: vid });
      return;
    }

    // ---- 航海者: 船の移動モード（2段階: 船を選択 → 移動先をタップ）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'moveShip') {
      const from = getMoveShipFrom();
      const ptm = clickToBoardPixel(svg, e.clientX, e.clientY);
      const eid = ptm ? nearestMoveShipEdgeId(state, pid, from, ptm.x, ptm.y) : null;
      if (!eid) { if (from) setMoveShipFrom(null); return; } // 空タップで選択解除
      if (!from) {
        // 移動元の船を選択（動かせる自分の船のみ nearestMoveShipEdgeId が返す）
        setMoveShipFrom(eid);
      } else if (eid === from) {
        setMoveShipFrom(null); // 同じ船を再タップ → 解除
      } else if (canMoveShip(state, pid, from, eid)) {
        dispatch({ type: 'MOVE_SHIP', fromEdgeId: from, toEdgeId: eid });
        setMoveShipFrom(null);
      }
      return;
    }

    // ---- 騎士と商人: 騎士の移動モード（騎士を選択 → 移動先頂点をタップ）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'moveKnight') {
      const from = getMoveKnightFrom();
      const ptm = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptm ? nearestMoveKnightVertexId(state, pid, from, ptm.x, ptm.y) : null;
      if (!vid) { if (from) setMoveKnightFrom(null); return; }
      if (!from) setMoveKnightFrom(vid);
      else if (vid === from) setMoveKnightFrom(null);
      else if (canMoveKnight(state, pid, from, vid)) {
        dispatch({ type: 'MOVE_KNIGHT', fromVertexId: from, toVertexId: vid });
        setMoveKnightFrom(null);
      }
      return;
    }

    // ---- 騎士と商人: 騎士を建てるモード（合法頂点をタップ → BUILD_KNIGHT。モードは維持して連続配置可）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'buildKnight') {
      const ptk = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptk ? nearestBuildKnightVertexId(state, pid, ptk.x, ptk.y) : null;
      if (vid) dispatch({ type: 'BUILD_KNIGHT', vertexId: vid });
      return;
    }

    // ---- 騎士と商人: 騎士を起動するモード（起動できる自分の騎士をタップ → ACTIVATE_KNIGHT）----
    // タッチ時は誤起動防止に確認バーを挟む（建物配置と同じ流儀）。マウスは即実行。
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'activateKnight') {
      const pta = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = pta ? nearestActivateKnightVertexId(state, pid, pta.x, pta.y) : null;
      if (vid) {
        if (requireConfirm()) setUIPhase({ type: 'placePreview', kind: 'activateKnight', targetId: vid });
        else dispatch({ type: 'ACTIVATE_KNIGHT', vertexId: vid });
      }
      return;
    }

    // ---- 騎士と商人: 騎士を昇格するモード（昇格できる自分の騎士をタップ → UPGRADE_KNIGHT）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'upgradeKnight') {
      const ptu = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptu ? nearestUpgradeKnightVertexId(state, pid, ptu.x, ptu.y) : null;
      if (vid) {
        if (requireConfirm()) setUIPhase({ type: 'placePreview', kind: 'upgradeKnight', targetId: vid });
        else dispatch({ type: 'UPGRADE_KNIGHT', vertexId: vid });
      }
      return;
    }

    // ---- 騎士と商人: 強盗を追い払うモード（追い払える騎士頂点をタップ → 即 CHASE_ROBBER）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'chaseRobber') {
      const ptc = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptc ? nearestChaseRobberVertexId(state, pid, ptc.x, ptc.y) : null;
      if (vid) dispatch({ type: 'CHASE_ROBBER', vertexId: vid });
      return;
    }

    // ---- 騎士と商人: 商人カードのタイル配置（光った自分の隣接資源タイルをタップ → PLAY_PROGRESS）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'placeMerchant') {
      const ptm = clickToBoardPixel(svg, e.clientX, e.clientY);
      let tid = (e.target as SVGElement).closest('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;
      if (!tid && ptm) tid = nearestMerchantTileId(state, pid, ptm.x, ptm.y);
      else if (tid && !new Set(merchantTileIds(state, pid)).has(tid)) tid = null; // 候補外の直接ヒットは無効
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'merchant');
      if (tid && card) {
        // 商人はカードを消費するため、タッチ時は確認バーを挟んで誤配置を防ぐ。
        if (requireConfirm()) setUIPhase({ type: 'placePreview', kind: 'placeMerchant', targetId: tid });
        else dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { merchantTileId: tid } });
      }
      return;
    }

    // ---- 騎士と商人: 発明家カードの数字入替（光った2タイルを順にタップ → PLAY_PROGRESS）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'inventorSwap') {
      const pti = clickToBoardPixel(svg, e.clientX, e.clientY);
      let tid = (e.target as SVGElement).closest('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;
      if (!tid && pti) tid = nearestInventorTileId(state, pti.x, pti.y);
      else if (tid && !new Set(inventorTiles(state)).has(tid)) tid = null; // 入替不可タイルの直接ヒットは無効
      if (!tid) { if (getInventorFirst()) setInventorFirst(null); return; } // 空タップで選択解除
      const first = getInventorFirst();
      if (!first) { setInventorFirst(tid); return; }       // 1枚目を選択
      if (tid === first) { setInventorFirst(null); return; } // 同じタイル再タップ＝解除
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'inventor');
      if (card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { inventorTiles: [first, tid] } });
      setInventorFirst(null);
      return;
    }

    // ---- 騎士と商人: 僧正カードの盗賊配置（光ったタイルをタップ → PLAY_PROGRESS bishopTileId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'placeBishop') {
      const ptb = clickToBoardPixel(svg, e.clientX, e.clientY);
      let tid = (e.target as SVGElement).closest('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;
      if (!tid && ptb) tid = nearestBishopTileId(state, ptb.x, ptb.y);
      else if (tid && !new Set(bishopTileIds(state)).has(tid)) tid = null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'bishop');
      if (tid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { bishopTileId: tid } });
      return;
    }

    // ---- 騎士と商人: 外交官カードの道撤去（光った相手の端の道をタップ → PLAY_PROGRESS diplomatEdgeId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectDiplomatRoad') {
      const ptd = clickToBoardPixel(svg, e.clientX, e.clientY);
      let eid = (e.target as SVGElement).closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? null;
      if (!eid && ptd) eid = nearestDiplomatEdgeId(state, pid, ptd.x, ptd.y);
      else if (eid && !new Set(diplomatRemovableRoads(state, pid)).has(eid)) eid = null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'diplomat');
      if (eid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { diplomatEdgeId: eid } });
      return;
    }

    // ---- 騎士と商人: 脱走兵カードの騎士除去（光った相手の騎士をタップ → PLAY_PROGRESS deserterVertexId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectDeserterKnight') {
      const ptk = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptk ? nearestDeserterVertexId(state, pid, ptk.x, ptk.y) : null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'deserter');
      if (vid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { deserterVertexId: vid } });
      return;
    }

    // ---- 騎士と商人: 医術カードの都市化（光った自分の開拓地をタップ → PLAY_PROGRESS medicineVertexId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectMedicineSettlement') {
      const ptm = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptm ? nearestMedicineVertexId(state, pid, ptm.x, ptm.y) : null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'medicine');
      if (vid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { medicineVertexId: vid } });
      return;
    }

    // ---- 騎士と商人: メトロポリス化する都市の手動選択（光った自分の都市をタップ → BUILD_IMPROVEMENT metropolisVertexId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectMetropolis') {
      const ptp = clickToBoardPixel(svg, e.clientX, e.clientY);
      let vid = (e.target as SVGElement).closest('[data-vertex-id]')?.getAttribute('data-vertex-id') ?? null;
      if (!vid && ptp) vid = nearestMetropolisVertexId(state, pid, ptp.x, ptp.y);
      else if (vid && !new Set(metropolisCityChoices(state, pid)).has(vid)) vid = null; // 候補外の直接ヒットは無効
      const track = getMetropolisTrack();
      if (vid && track) dispatch({ type: 'BUILD_IMPROVEMENT', track, metropolisVertexId: vid });
      return;
    }

    // ---- 騎士と商人: 鍛冶屋の騎士昇格（最大2体）。1体目タップで選択、2体目で昇格。候補1体なら即実行。----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectSmithKnight') {
      const pts = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = pts ? nearestSmithKnightVertexId(state, pid, pts.x, pts.y) : null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'smith');
      if (!vid || !card) { if (getSmithFirst()) setSmithFirst(null); return; } // 空タップで選択解除
      const first = getSmithFirst();
      if (!first) {
        // 候補が1体しかいないなら2体目を待たず即昇格。2体以上なら1体目を選択。
        if (smithKnightTargets(state, pid).length <= 1) { dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { smithVertexIds: [vid] } }); return; }
        setSmithFirst(vid); return;
      }
      if (vid === first) { setSmithFirst(null); return; } // 同じ騎士の再タップ＝解除
      dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { smithVertexIds: [first, vid] } });
      setSmithFirst(null);
      return;
    }

    // ---- 騎士と商人: 技師の城壁建設（光った自分の都市をタップ → PLAY_PROGRESS engineerVertexId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectEngineerCity') {
      const pte = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = pte ? nearestEngineerCityVertexId(state, pid, pte.x, pte.y) : null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'engineer');
      if (vid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { engineerVertexId: vid } });
      return;
    }

    // ---- 騎士と商人: 城壁建設（都市が2つ以上の時、光った自分の都市をタップ → BUILD_CITY_WALL）----
    // 候補集合は技師と同じ（都市・非メトロポリス・城壁なし）。reducer 側で資源/上限を最終検証する。
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectWallCity') {
      const ptw = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = ptw ? nearestEngineerCityVertexId(state, pid, ptw.x, ptw.y) : null;
      if (vid) dispatch({ type: 'BUILD_CITY_WALL', vertexId: vid });
      return;
    }

    // ---- 騎士と商人: 陰謀の敵騎士退去（光った敵騎士をタップ → PLAY_PROGRESS intrigueVertexId）----
    if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD' && mode === 'selectIntrigueKnight') {
      const pti2 = clickToBoardPixel(svg, e.clientX, e.clientY);
      const vid = pti2 ? nearestIntrigueKnightVertexId(state, pid, pti2.x, pti2.y) : null;
      const card = state.players[pid]?.progressCards?.find(c => c.type === 'intrigue');
      if (vid && card) dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, choice: { intrigueVertexId: vid } });
      return;
    }

    // ---- 配置: タップ座標から最近傍の合法ターゲットへスナップ（指で外れにくく）----
    const pt = clickToBoardPixel(svg, e.clientX, e.clientY);
    if (pt) {
      const vid = nearestValidVertexId(state, pid, mode, pt.x, pt.y);
      if (vid) { placeVertex(vid, state, pid, mode, setUIPhase, dispatch); return; }
      const eid = nearestValidEdgeId(state, pid, mode, pt.x, pt.y);
      if (eid) { placeEdge(eid, state, pid, mode, setUIPhase, dispatch); return; }
      const sid = nearestValidShipEdgeId(state, pid, mode, pt.x, pt.y);
      if (sid) { placeShipEdge(sid, state, pid, setUIPhase, dispatch); return; }
    }

    // ---- フォールバック: 直接ヒットした要素（マウスの精密クリック等）----
    const vertexEl = target.closest('[data-vertex-id]');
    if (vertexEl) {
      const vertexId = vertexEl.getAttribute('data-vertex-id');
      if (vertexId) placeVertex(vertexId, state, pid, mode, setUIPhase, dispatch);
      return;
    }
    const shipEl = target.closest('[data-ship-edge-id]');
    if (shipEl) {
      const sid = shipEl.getAttribute('data-ship-edge-id');
      if (sid) placeShipEdge(sid, state, pid, setUIPhase, dispatch);
      return;
    }
    const edgeEl = target.closest('[data-edge-id]');
    if (edgeEl) {
      const edgeId = edgeEl.getAttribute('data-edge-id');
      if (edgeId) placeEdge(edgeId, state, pid, mode, setUIPhase, dispatch);
    }
  });
}

// 配置タップで確認ステップを挟むか（誤配置防止）。タッチ端末のみ。マウスは即配置。
function requireConfirm(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

// 頂点への配置: タッチなら仮置きプレビュー（確定待ち）、マウスなら即配置。
function placeVertex(
  vid: string, state: GameState, pid: PlayerId, mode: BuildMode,
  setUIPhase: (p: UIPhase) => void, dispatch: (a: Action) => void,
): void {
  const action = resolveVertexAction(state, pid, mode, vid);
  if (!action) return;
  if (requireConfirm()) {
    setUIPhase({ type: 'placePreview', kind: action.type === 'BUILD_CITY' ? 'city' : 'settlement', targetId: vid });
  } else {
    dispatch(action);
  }
}

// 辺への配置: タッチなら仮置きプレビュー、マウスなら即配置。
function placeEdge(
  eid: string, state: GameState, pid: PlayerId, mode: BuildMode,
  setUIPhase: (p: UIPhase) => void, dispatch: (a: Action) => void,
): void {
  const action = resolveEdgeAction(state, pid, mode, eid);
  if (!action) return;
  if (requireConfirm()) {
    setUIPhase({ type: 'placePreview', kind: 'road', targetId: eid });
  } else {
    dispatch(action);
  }
}

// 船への配置: タッチなら仮置きプレビュー、マウスなら即配置。
function placeShipEdge(
  eid: string, state: GameState, pid: PlayerId,
  setUIPhase: (p: UIPhase) => void, dispatch: (a: Action) => void,
): void {
  if (!canBuildShip(state, pid, eid)) return;
  if (requireConfirm()) {
    setUIPhase({ type: 'placePreview', kind: 'ship', targetId: eid });
  } else {
    dispatch({ type: 'BUILD_SHIP', edgeId: eid });
  }
}

// 仮置きプレビューを確定して実アクションへ変換する（main.ts の確認バーから呼ぶ）。
export function resolvePlacePreviewAction(
  state: GameState, pid: PlayerId,
  kind: 'settlement' | 'city' | 'road' | 'ship' | 'activateKnight' | 'upgradeKnight' | 'placeMerchant',
  targetId: string,
): Action | null {
  if (kind === 'road') return resolveEdgeAction(state, pid, 'road', targetId);
  if (kind === 'ship') return canBuildShip(state, pid, targetId) ? { type: 'BUILD_SHIP', edgeId: targetId } : null;
  // 騎士と商人: 即時1タップ系（起動/昇格/商人）もタッチ時は確認バーを挟む。
  if (kind === 'activateKnight') return canActivateKnight(state, pid, targetId) ? { type: 'ACTIVATE_KNIGHT', vertexId: targetId } : null;
  if (kind === 'upgradeKnight') return canUpgradeKnight(state, pid, targetId) ? { type: 'UPGRADE_KNIGHT', vertexId: targetId } : null;
  if (kind === 'placeMerchant') {
    const card = state.players[pid]?.progressCards?.find(c => c.type === 'merchant');
    return card ? { type: 'PLAY_PROGRESS', cardId: card.id, choice: { merchantTileId: targetId } } : null;
  }
  return resolveVertexAction(state, pid, kind, targetId);
}

// ============================================================
// ピンチズーム＆パン（B-3）
// ============================================================

// パン/ピンチ直後の合成 click(配置) を時間窓で抑止する。
// boolフラグだとジェスチャ後に click が発火しない端末でフラグが残り、次の本物のタップを
// 誤って飲み込むため、自動失効するタイムスタンプ方式にする。
let suppressClickUntil = 0;
const SUPPRESS_CLICK_MS = 350;
function markGestureMoved(): void { suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS; }
function consumeSuppressClick(): boolean { return Date.now() < suppressClickUntil; }

// 盤面ズームの倍率レンジ。min<1=全体縮小（大きい盤面で四隅のパネルと被らないよう小さく表示）。
export const ZOOM_LIMITS = { min: 0.5, max: 3 };
const MIN_SCALE = ZOOM_LIMITS.min;
const MAX_SCALE = ZOOM_LIMITS.max;
const PAN_THRESHOLD = 8; // screen px。これ未満の1本指移動はタップ(配置)扱い。

/**
 * ビューポートを範囲内に収める純粋関数。
 * 盤面コンテンツ中心(cx,cy)を基準に拡縮するため、scale に応じた中央維持の基準
 * 平行移動 base=(cx,cy)*(1-scale) を計算し、拡大時(scale>1)のみその周囲をパン可能にする。
 * cx,cy 省略時は viewBox 中心(vbW/2,vbH/2)を使用。
 */
export function clampViewport(
  vp: BoardViewport, vbW: number, vbH: number,
  cx: number = vbW / 2, cy: number = vbH / 2,
): BoardViewport {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, vp.scale));
  const baseX = cx * (1 - scale);
  const baseY = cy * (1 - scale);
  if (scale <= 1) return { scale, tx: baseX, ty: baseY }; // 縮小/等倍は中央固定
  const maxX = (vbW * (scale - 1)) / 2;
  const maxY = (vbH * (scale - 1)) / 2;
  return {
    scale,
    tx: Math.max(baseX - maxX, Math.min(baseX + maxX, vp.tx)),
    ty: Math.max(baseY - maxY, Math.min(baseY + maxY, vp.ty)),
  };
}

/** 盤面中心(cx,cy)を固定したまま指定倍率へ拡縮したビューポート（ボタン操作用）。 */
export function centeredZoom(scale: number, cx: number, cy: number): BoardViewport {
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  return { scale: s, tx: cx * (1 - s), ty: cy * (1 - s) };
}

/**
 * 盤面のピンチズーム/パンを有効化する。viewport は main 側が永続保持する。
 * - 2本指: ピンチで拡縮（中心固定）＋midpoint移動でパン。
 * - 1本指: 拡大時(scale>1)のみパン。等倍ではタップ(配置)を優先。
 * - ホイール: PCの拡縮（任意）。
 * getScreenCTM 経由のヒット判定(events)は viewport 変換に自動追従する。
 */
export function attachBoardGestures(
  svg: SVGSVGElement,
  getViewport: () => BoardViewport,
  setViewport: (vp: BoardViewport) => void,
): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: 'none' | 'pan' | 'pinch' = 'none';
  let start = { x: 0, y: 0 };
  let last = { x: 0, y: 0 };
  let movedTotal = 0;
  let lastDist = 0;
  let lastMid = { x: 0, y: 0 };

  const screenScale = (): number => {
    const ctm = svg.getScreenCTM();
    return ctm && ctm.a ? ctm.a : 1;
  };
  const toVb = (x: number, y: number): { x: number; y: number } => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x, y };
    const p = svg.createSVGPoint(); p.x = x; p.y = y;
    const r = p.matrixTransform(ctm.inverse());
    return { x: r.x, y: r.y };
  };
  const applyLive = (vp: BoardViewport): void => {
    const g = svg.querySelector('.board-viewport') as SVGGElement | null;
    if (g) g.setAttribute('transform', `translate(${vp.tx} ${vp.ty}) scale(${vp.scale})`);
  };
  const commit = (vp: BoardViewport): void => {
    const b = svg.viewBox?.baseVal;
    const w = b?.width || 800, h = b?.height || 700;
    const cx = (b?.x || 0) + w / 2, cy = (b?.y || 0) + h / 2;
    const c = clampViewport(vp, w, h, cx, cy);
    setViewport(c);
    applyLive(c);
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // ピンチ中心(vbPoint)を固定したまま newScale へ拡縮した tx,ty を返す。
  const zoomAround = (vp: BoardViewport, newScale: number, vbPoint: { x: number; y: number }): BoardViewport => ({
    scale: newScale,
    tx: vbPoint.x - (vbPoint.x - vp.tx) * (newScale / vp.scale),
    ty: vbPoint.y - (vbPoint.y - vp.ty) * (newScale / vp.scale),
  });

  svg.addEventListener('pointerdown', (e) => {
    // 指がSVG外へ出てもイベントを受け取り続ける（パン/ピンチがフリーズしない）。
    try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      mode = 'none';
      start = last = { x: e.clientX, y: e.clientY };
      movedTotal = 0;
    } else if (pointers.size === 2) {
      mode = 'pinch';
      const pts = [...pointers.values()];
      lastDist = dist(pts[0]!, pts[1]!);
      lastMid = mid(pts[0]!, pts[1]!);
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === 'pinch' && pointers.size >= 2) {
      e.preventDefault();
      const pts = [...pointers.values()];
      const d = dist(pts[0]!, pts[1]!);
      const m = mid(pts[0]!, pts[1]!);
      if (lastDist > 0) {
        const vp = getViewport();
        let next = zoomAround(vp, vp.scale * (d / lastDist), toVb(m.x, m.y));
        const sc = screenScale();
        next = { scale: next.scale, tx: next.tx + (m.x - lastMid.x) / sc, ty: next.ty + (m.y - lastMid.y) / sc };
        commit(next);
        markGestureMoved();
      }
      lastDist = d; lastMid = m;
      return;
    }

    if (pointers.size === 1 && mode !== 'pinch') {
      movedTotal = Math.max(movedTotal, Math.hypot(e.clientX - start.x, e.clientY - start.y));
      const vp = getViewport();
      if (vp.scale > 1 && (mode === 'pan' || movedTotal > PAN_THRESHOLD)) {
        e.preventDefault();
        mode = 'pan';
        const sc = screenScale();
        commit({ scale: vp.scale, tx: vp.tx + (e.clientX - last.x) / sc, ty: vp.ty + (e.clientY - last.y) / sc });
        markGestureMoved();
      }
      last = { x: e.clientX, y: e.clientY };
    }
  }, { passive: false });

  const endPointer = (e: PointerEvent): void => {
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.delete(e.pointerId);
    if (mode === 'pan' || mode === 'pinch') markGestureMoved();
    if (pointers.size === 0) {
      mode = 'none';
    } else if (pointers.size === 1) {
      // ピンチ→1本指: 残り指でパン継続できるよう基準を更新。
      const only = [...pointers.values()][0]!;
      start = last = { x: only.x, y: only.y };
      movedTotal = 0;
      mode = 'none';
    }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  // PC: トラックパッドのピンチ（ctrlKey付き wheel）/ Ctrl+ホイール のみ拡縮。
  // 通常のホイールはページスクロールに任せる（盤面上でスクロールが奪われない）。
  svg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const vp = getViewport();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    commit(zoomAround(vp, vp.scale * factor, toVb(e.clientX, e.clientY)));
  }, { passive: false });
}

// ============================================================
// 個別ハンドラ
// ============================================================

function handleTileClick(
  tileId: string,
  state: GameState,
  pid: PlayerId,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): void {
  if (state.phase !== 'MAIN' || state.turnPhase !== 'ROBBER') return;
  const tile = state.tiles[tileId];
  if (!tile) return;

  // ---- 海タイル: 海賊を移動（隣接船の所有者から奪う）----
  if (tile.type === 'sea') {
    if (state.piratePosition === tileId) return; // 同じ場所へは動かせない
    // 奪えるのは手札（S6では織物も）を持つ相手だけ（強奪は必須・0枚相手は対象外）。
    const opponents = getPirateRobbablePlayerIds(state, tileId, pid).filter(p => piratePublicCardCount(state, p) > 0);
    if (opponents.length <= 1) {
      dispatch({ type: 'MOVE_PIRATE', tileId, stealFromPlayerId: opponents[0] ?? null });
    } else {
      setUIPhase({ type: 'robberTarget', tileId, opponents, kind: 'pirate' });
    }
    return;
  }

  // ---- 陸タイル: 盗賊を移動（隣接建物の所有者から盗む）----
  const currentRobberTile = Object.values(state.tiles).find(t => t.hasRobber);
  if (currentRobberTile?.id === tileId) return;

  const vertexIds = state.tileToVertices[tileId] ?? [];
  const opponents = [...new Set(
    vertexIds
      .map(vid => state.vertices[vid]?.building?.playerId)
      .filter((p): p is PlayerId => p != null && p !== pid),
  )].filter(p => publicCardCount(state, p) > 0); // 手札を持つ相手だけ（強奪は必須・0枚は対象外）

  if (opponents.length <= 1) {
    // 0人または1人：即座にディスパッチ
    dispatch({
      type: 'MOVE_ROBBER',
      tileId,
      stealFromPlayerId: opponents[0] ?? null,
    });
  } else {
    // 複数の相手がいる場合：UIで選択させる
    setUIPhase({ type: 'robberTarget', tileId, opponents, kind: 'robber' });
  }
}

// 頂点タップに対応する建設アクション（合法なら）を返す。なければ null。
function resolveVertexAction(state: GameState, pid: PlayerId, mode: BuildMode, vertexId: string): Action | null {
  const isSetup = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
  if (isSetup && state.setupSubPhase === 'PLACE_SETTLEMENT') {
    return canBuildSettlement(state, pid, vertexId) ? { type: 'BUILD_SETTLEMENT', vertexId } : null;
  }
  if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD') {
    if (mode === 'settlement' && canBuildSettlement(state, pid, vertexId)) return { type: 'BUILD_SETTLEMENT', vertexId };
    if (mode === 'city' && canBuildCity(state, pid, vertexId)) return { type: 'BUILD_CITY', vertexId };
  }
  return null;
}

// 辺タップに対応する道アクション（合法なら）を返す。なければ null。
function resolveEdgeAction(state: GameState, pid: PlayerId, mode: BuildMode, edgeId: string): Action | null {
  const isSetup = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
  if (isSetup && state.setupSubPhase === 'PLACE_ROAD') {
    return canBuildRoad(state, pid, edgeId) ? { type: 'BUILD_ROAD', edgeId } : null;
  }
  if (state.phase === 'MAIN' && state.turnPhase === 'TRADE_BUILD') {
    if ((mode === 'road' || state.roadBuildingRoadsRemaining > 0) && canBuildRoad(state, pid, edgeId)) {
      return { type: 'BUILD_ROAD', edgeId };
    }
  }
  return null;
}
