// ============================================================
// src/engine/actions.ts — L-05: 建設バリデーション・実行エンジン
// ============================================================

import type {
  GameState, PlayerId, EdgeId, VertexId, ResourceHand,
} from '../types';
import { BUILD_COSTS, RESOURCE_TYPES } from '../constants';
import {
  isDistanceRuleOk, isEdgeConnectedForPiece,
  isSeaEdge, isLandEdge, isLandVertex, edgeTileIds,
} from './board';
import { isHomeIslandVertex } from './islands';

// ============================================================
// リソース操作ユーティリティ
// ============================================================

export function hasEnoughResources(hand: ResourceHand, cost: ResourceHand): boolean {
  return RESOURCE_TYPES.every(r => hand[r] >= cost[r]);
}

function deductCost(hand: ResourceHand, cost: ResourceHand): ResourceHand {
  const next = { ...hand };
  for (const r of RESOURCE_TYPES) next[r] -= cost[r];
  return next;
}

function returnToBank(bank: ResourceHand, cost: ResourceHand): ResourceHand {
  const next = { ...bank };
  for (const r of RESOURCE_TYPES) next[r] += cost[r];
  return next;
}

function isSetupPhase(state: GameState): boolean {
  return state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
}

// ============================================================
// 道（Road）
// ============================================================

/**
 * 指定辺に道を建設できるか検証する。
 *
 * MAIN フェーズ: 資源コスト + 残コマ + 辺未使用 + ネットワーク接続
 * SETUP フェーズ: 資源不要。残コマ + 辺未使用 + 接続
 */
export function canBuildRoad(state: GameState, playerId: PlayerId, edgeId: EdgeId): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  if (player.remainingRoads <= 0) return false;

  const edge = state.edges[edgeId];
  if (!edge) return false;
  if (edge.road != null) return false;
  if (edge.ship != null) return false; // 既に船がある辺には道を置けない
  // 道は陸に面した辺のみ（航海者: 純粋な海上の辺には置けない）。基本ゲームは常に true。
  if (!isLandEdge(edge, state.vertices, state.tiles)) return false;

  // セットアップ or 街道建設カード使用中は資源コスト不要
  const freeRoad = isSetupPhase(state) || state.roadBuildingRoadsRemaining > 0;
  if (!freeRoad && !hasEnoughResources(player.hand, BUILD_COSTS.road)) return false;

  // セットアップ中は「直前に置いた開拓地」に接続する道のみ許可（標準ルール）。
  // anchor 未設定（手組みの state 等）の場合は従来の接続判定にフォールバック。
  if (isSetupPhase(state) && state.setupRoadAnchor) {
    return edge.vertexIds.includes(state.setupRoadAnchor);
  }

  return isEdgeConnectedForPiece(edge, playerId, state.vertices, state.edges, 'road');
}

// ============================================================
// 船（Ship・航海者拡張）
// ============================================================

/**
 * 指定辺に船を建設できるか検証する。
 *   - 海に面した辺（sea-edge）のみ。
 *   - 道/船が未設置。残コマあり。
 *   - 接続: 自分の船 or 建物に連結（道とは建物経由でのみ切替）。
 *   - MAIN は資源コスト（木+羊）。セットアップは無料＋直前の開拓地に接続。
 */
export function canBuildShip(state: GameState, playerId: PlayerId, edgeId: EdgeId): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  if ((player.remainingShips ?? 0) <= 0) return false;

  const edge = state.edges[edgeId];
  if (!edge) return false;
  if (edge.road != null || edge.ship != null) return false;
  // 船は海に面した辺のみ。
  if (!isSeaEdge(edge, state.vertices, state.tiles)) return false;
  // 航海者: 海賊コマのいる海タイルに面した辺には船を建設できない（建設封鎖）。
  if (state.piratePosition != null && edgeTileIds(edge, state.vertices).includes(state.piratePosition)) return false;

  // セットアップ or 街道建設カード使用中は資源コスト不要（航海者: 街道建設は道2/船2/道1+船1）。
  const free = isSetupPhase(state) || state.roadBuildingRoadsRemaining > 0;
  if (!free && !hasEnoughResources(player.hand, BUILD_COSTS.ship)) return false;

  if (isSetupPhase(state) && state.setupRoadAnchor) {
    return edge.vertexIds.includes(state.setupRoadAnchor);
  }

  return isEdgeConnectedForPiece(edge, playerId, state.vertices, state.edges, 'ship');
}

/** 船を建設して新しい GameState を返す（バリデーション済み前提）。 */
export function buildShip(state: GameState, playerId: PlayerId, edgeId: EdgeId): GameState {
  const player = state.players[playerId]!;
  const free = isSetupPhase(state) || state.roadBuildingRoadsRemaining > 0;
  const newHand = free ? player.hand : deductCost(player.hand, BUILD_COSTS.ship);
  const newBank = free ? state.bank : returnToBank(state.bank, BUILD_COSTS.ship);

  return {
    ...state,
    bank: newBank,
    edges: {
      ...state.edges,
      [edgeId]: { ...state.edges[edgeId]!, ship: { playerId } },
    },
    players: {
      ...state.players,
      [playerId]: { ...player, hand: newHand, remainingShips: (player.remainingShips ?? 0) - 1 },
    },
  };
}

// ============================================================
// 船の移動（航海者・上級ルール / Phase 4）
// ============================================================

/**
 * 頂点 v が「自分の交易路の開放端」か（船を持ち上げてよい端）。
 * = その頂点に建物が無く、fromEdge 以外に自分の道/船が接続していない（行き止まり）。
 */
function isOpenShipEnd(
  state: GameState, playerId: PlayerId, vertexId: VertexId, fromEdgeId: EdgeId,
): boolean {
  const v = state.vertices[vertexId];
  if (!v) return false;
  if (v.building != null) return false; // 建物がある端は開放端ではない
  return !v.adjacentEdgeIds.some(eid => {
    if (eid === fromEdgeId) return false;
    // 建物の無い頂点では道は船の連続性に寄与しない（道↔船は自分の建物経由でのみ連結）。
    // よって開放端を塞ぐのは「自分の船」のみ（仕様: オープン=その端が自分の船/建物に隣接していない）。
    return state.edges[eid]?.ship?.playerId === playerId;
  });
}

/**
 * 自分の船を別の海辺へ1ターン1回だけ移動できるか検証する（航海）。
 *   - MAIN/TRADE_BUILD・このターンまだ船を動かしていない。
 *   - from は自分の船。to は空きの海辺で from と異なる。
 *   - from は「開放端を持つ」船（行き止まりの船）だけ動かせる。
 *   - 移動先は from の船を取り除いた状態で自分のネットワークに接続する。
 */
/**
 * S6 カタンの織物: 「村につないだ航路は closed（移動不可）」。
 * その辺が、playerId が接続済みの村タイルに面しているなら locked とみなす。
 * villages の無い盤では常に false。
 */
export function isVillageLockedShip(state: GameState, playerId: PlayerId, edgeId: EdgeId): boolean {
  if (!state.villages) return false;
  const e = state.edges[edgeId];
  if (!e || e.ship?.playerId !== playerId) return false;
  for (const tid of edgeTileIds(e, state.vertices)) {
    if (tid in state.villages && (state.villageConn?.[tid]?.includes(playerId))) return true;
  }
  return false;
}

export function canMoveShip(
  state: GameState, playerId: PlayerId, fromEdgeId: EdgeId, toEdgeId: EdgeId,
): boolean {
  if (state.shipMovedThisTurn) return false;
  // 建てたばかりの船（このターン建設）は移動できない（航海者の標準ルール）。
  if (state.shipsBuiltThisTurn?.includes(fromEdgeId)) return false;
  if (fromEdgeId === toEdgeId) return false;
  // S6 カタンの織物: 村につないだ航路（村タイルに面する自分の船）は closed＝移動できない（延長/分岐は可）。
  if (isVillageLockedShip(state, playerId, fromEdgeId)) return false;

  const from = state.edges[fromEdgeId];
  const to = state.edges[toEdgeId];
  if (!from || !to) return false;
  if (from.ship?.playerId !== playerId) return false;
  if (to.road != null || to.ship != null) return false;
  if (!isSeaEdge(to, state.vertices, state.tiles)) return false;

  // 海賊のいる海ヘクスに面した辺へ/から船は移動できない（建設の封鎖 canBuildShip:96 と対称）。
  if (state.piratePosition != null) {
    if (edgeTileIds(from, state.vertices).includes(state.piratePosition)) return false;
    if (edgeTileIds(to, state.vertices).includes(state.piratePosition)) return false;
  }

  // 行き止まり（開放端）の船だけ動かせる。
  if (!from.vertexIds.some(v => isOpenShipEnd(state, playerId, v, fromEdgeId))) return false;

  // from の船を取り除いた状態で、移動先が自分のネットワークに接続するか。
  const without: GameState = {
    ...state,
    edges: { ...state.edges, [fromEdgeId]: { ...from, ship: null } },
  };
  return isEdgeConnectedForPiece(to, playerId, without.vertices, without.edges, 'ship');
}

/** その船（自分の船）を今ターン動かせるか（開放端があり、合法な移動先が1つ以上ある）。 */
export function isShipMovable(state: GameState, playerId: PlayerId, fromEdgeId: EdgeId): boolean {
  if (state.shipMovedThisTurn) return false;
  const from = state.edges[fromEdgeId];
  if (from?.ship?.playerId !== playerId) return false;
  // 高コストな移動先探索の前に cheap-fail（描画毎の playerHasMovableShip 連打を軽くする）。
  if (state.shipsBuiltThisTurn?.includes(fromEdgeId)) return false;          // 今ターン建設は不可
  if (isVillageLockedShip(state, playerId, fromEdgeId)) return false;        // S6 村航路は closed
  if (state.piratePosition != null && edgeTileIds(from, state.vertices).includes(state.piratePosition)) return false; // 海賊封鎖
  if (!from.vertexIds.some(v => isOpenShipEnd(state, playerId, v, fromEdgeId))) return false; // 開放端なし
  return Object.keys(state.edges).some(to => canMoveShip(state, playerId, fromEdgeId, to));
}

/** 自分の船のうち、今ターン動かせるものが1つでもあるか（UIの「船を移動」ボタン表示判定）。 */
export function playerHasMovableShip(state: GameState, playerId: PlayerId): boolean {
  if (state.shipMovedThisTurn) return false;
  return Object.keys(state.edges).some(
    e => state.edges[e]!.ship?.playerId === playerId && isShipMovable(state, playerId, e),
  );
}

/** 船を移動して新しい GameState を返す（バリデーション済み前提）。コマ数は不変・1ターン1回。 */
export function moveShip(
  state: GameState, playerId: PlayerId, fromEdgeId: EdgeId, toEdgeId: EdgeId,
): GameState {
  const from = state.edges[fromEdgeId]!;
  const to = state.edges[toEdgeId]!;
  return {
    ...state,
    shipMovedThisTurn: true,
    edges: {
      ...state.edges,
      [fromEdgeId]: { ...from, ship: null },
      [toEdgeId]:   { ...to, ship: { playerId } },
    },
  };
}

/** 道を建設して新しい GameState を返す（バリデーション済み前提）。 */
export function buildRoad(state: GameState, playerId: PlayerId, edgeId: EdgeId): GameState {
  const player = state.players[playerId]!;
  const freeRoad = isSetupPhase(state) || state.roadBuildingRoadsRemaining > 0;
  const newHand = freeRoad ? player.hand : deductCost(player.hand, BUILD_COSTS.road);
  const newBank = freeRoad ? state.bank : returnToBank(state.bank, BUILD_COSTS.road);

  return {
    ...state,
    bank: newBank,
    edges: {
      ...state.edges,
      [edgeId]: { ...state.edges[edgeId]!, road: { playerId } },
    },
    players: {
      ...state.players,
      [playerId]: { ...player, hand: newHand, remainingRoads: player.remainingRoads - 1 },
    },
  };
}

// ============================================================
// 開拓地（Settlement）
// ============================================================

/**
 * 指定頂点に開拓地を建設できるか検証する。
 *
 * MAIN フェーズ: 資源コスト + 残コマ + 頂点未使用 + 距離ルール + 道への接続
 * SETUP フェーズ: 資源不要・道接続不要。残コマ + 頂点未使用 + 距離ルール
 */
export function canBuildSettlement(
  state: GameState, playerId: PlayerId, vertexId: VertexId,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  if (player.remainingSettlements <= 0) return false;

  const vertex = state.vertices[vertexId];
  if (!vertex) return false;
  if (vertex.building != null) return false;
  // 騎士と商人: 騎士が立つ頂点には開拓地を建てられない（建てると騎士コマが描画上消える＝盤面不整合）。
  if (vertex.knight != null) return false;
  // 開拓地は陸に面した頂点のみ（航海者: 外洋だけに接する頂点には置けない）。基本ゲームは常に true。
  if (!isLandVertex(vertex, state.tiles)) return false;
  // S5「忘れられた部族」: 数字ディスクのあるヘクスに隣接した頂点にしか開拓地を置けない。
  if (state.numberHexOnly && !vertex.adjacentTileIds.some(t => state.tiles[t]?.number != null)) return false;
  // S6「カタンの織物」: 小島（本島以外）には開拓地を建てられない（村は航路で接続する）。
  if (state.noIslandSettlement && !isHomeIslandVertex(state, vertexId)) return false;
  // S7「海賊の島々」: 海賊要塞の頂点には（奪取前は）開拓地を建てられない（攻撃で奪取する）。
  if (state.fortresses && Object.values(state.fortresses).some(f => !f.captured && f.vertexId === vertexId)) return false;

  if (!isDistanceRuleOk(vertex, state.vertices)) return false;

  const setup = isSetupPhase(state);
  // 航海者: 初期配置は本島のみ（新島へは航海で渡る）。基本ゲームは無制限。
  if (setup && !isHomeIslandVertex(state, vertexId)) return false;
  if (!setup && !hasEnoughResources(player.hand, BUILD_COSTS.settlement)) return false;

  // MAIN フェーズ: 自分の道 or 船への接続が必要（航海者: 船でも開拓地を建てられる）。
  if (!setup) {
    const connected = vertex.adjacentEdgeIds.some(eid => {
      const e = state.edges[eid];
      return e?.road?.playerId === playerId || e?.ship?.playerId === playerId;
    });
    if (!connected) return false;
  }

  return true;
}

/** 開拓地を建設して新しい GameState を返す（バリデーション済み前提）。 */
export function buildSettlement(
  state: GameState, playerId: PlayerId, vertexId: VertexId,
): GameState {
  const player = state.players[playerId]!;
  const setup = isSetupPhase(state);
  const newHand = setup ? player.hand : deductCost(player.hand, BUILD_COSTS.settlement);
  const newBank = setup ? state.bank : returnToBank(state.bank, BUILD_COSTS.settlement);

  return {
    ...state,
    bank: newBank,
    vertices: {
      ...state.vertices,
      [vertexId]: {
        ...state.vertices[vertexId]!,
        building: { type: 'settlement', playerId },
      },
    },
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        hand: newHand,
        remainingSettlements: player.remainingSettlements - 1,
      },
    },
  };
}

// ============================================================
// 都市（City）
// ============================================================

/**
 * 指定頂点を都市に昇格できるか検証する。
 * 昇格元となる自分の開拓地がその頂点に必要。
 */
export function canBuildCity(state: GameState, playerId: PlayerId, vertexId: VertexId): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  if (player.remainingCities <= 0) return false;
  if (!hasEnoughResources(player.hand, BUILD_COSTS.city)) return false;

  const vertex = state.vertices[vertexId];
  if (!vertex) return false;
  if (vertex.building?.type !== 'settlement') return false;
  if (vertex.building.playerId !== playerId) return false;

  return true;
}

/**
 * 開拓地を都市に昇格させて新しい GameState を返す（バリデーション済み前提）。
 * 都市昇格した開拓地コマは手元に戻るため remainingSettlements +1。
 */
export function buildCity(state: GameState, playerId: PlayerId, vertexId: VertexId): GameState {
  const player = state.players[playerId]!;

  return {
    ...state,
    bank: returnToBank(state.bank, BUILD_COSTS.city),
    vertices: {
      ...state.vertices,
      [vertexId]: {
        ...state.vertices[vertexId]!,
        building: { type: 'city', playerId },
      },
    },
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        hand: deductCost(player.hand, BUILD_COSTS.city),
        remainingSettlements: player.remainingSettlements + 1, // 開拓地コマ返却
        remainingCities: player.remainingCities - 1,
      },
    },
  };
}
