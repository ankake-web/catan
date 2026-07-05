// ============================================================
// src/engine/tbTwo.ts — 交易と蛮族「Catan for Two（2人用）」変種（CN3089 p7）
// ============================================================
//
// 実プレイヤー2人＋中立プレイヤー2人（残り2色・type:'neutral'）。中立は players に
// 実体を持つが playerOrder には入らない（手番・生産・捨て札・勝利判定の対象外）。
// ここには変種固有の純粋ヘルパーだけを置き、applyAction からの状態遷移は game.ts が担う。
// 出典・実装解釈は docs/交易と蛮族_仕様書_v6.md §2-4。

import type { GameState, PlayerId, EdgeId, VertexId, TileId } from '../types';
import {
  TB2_TOKENS_DESERT, TB2_TOKENS_COAST, TB2_SPEND_COST_BEHIND, TB2_SPEND_COST_AHEAD,
} from '../constants';
import { canBuildRoad, canBuildSettlement } from './actions';
import { calcPublicVP } from './scoring';
import type { BoardGeometry } from './board';

/** Catan for Two の中立プレイヤーか。 */
export function isTbNeutral(state: GameState, playerId: PlayerId): boolean {
  return (state.tbNeutralPlayerIds ?? []).includes(playerId);
}

/** 2人戦の相手（playerOrder のもう1人）。変種無効・2人以外は null。 */
export function tbTwoOpponent(state: GameState, pid: PlayerId): PlayerId | null {
  if (!state.tbCatanForTwo) return null;
  const others = state.playerOrder.filter(p => p !== pid);
  return others.length === 1 ? others[0]! : null;
}

/**
 * 中立の初期開拓地を置く2交点（公式 p7 の図示位置・仕様書§2-4 図版確定）。
 * 図（ポインティトップ）の「盤中心の真上・真下 2R」は、本実装のフラットトップ盤では
 * 「盤中心から水平±2ヘックス分」の頂点＝3タイルの共有頂点として一意に決まる:
 *   右 = {1,0} ∩ {1,-1} ∩ {2,-1} ／ 左 = {-1,0} ∩ {-1,1} ∩ {-2,1}
 * 基本19タイル盤以外（該当タイルが無い盤）では空を返す（変種は基本盤専用）。
 */
export function tbTwoNeutralStartVertices(geo: Pick<BoardGeometry, 'tileToVertices'>): VertexId[] {
  const sharedVertex = (tids: TileId[]): VertexId | null => {
    const lists = tids.map(t => geo.tileToVertices[t]);
    if (lists.some(l => l == null)) return null;
    const [a, ...rest] = lists as VertexId[][];
    const v = a!.filter(vid => rest.every(l => l.includes(vid)));
    return v.length === 1 ? v[0]! : null;
  };
  const right = sharedVertex(['1,0', '1,-1', '2,-1']);
  const left = sharedVertex(['-1,0', '-1,1', '-2,1']);
  return [right, left].filter((v): v is VertexId => v != null);
}

/** 指定中立プレイヤーの合法な道配置先（通常配置ルール・無償）。 */
export function tbNeutralRoadTargets(state: GameState, owner: PlayerId): EdgeId[] {
  return Object.keys(state.edges).filter(eid => canBuildRoad(state, owner, eid));
}

/** 指定中立プレイヤーの合法な開拓地配置先（通常配置ルール＝中立自身の道網接続が必要・無償）。 */
export function tbNeutralSettlementTargets(state: GameState, owner: PlayerId): VertexId[] {
  return Object.keys(state.vertices).filter(vid => canBuildSettlement(state, owner, vid));
}

/** どちらかの中立に合法な道配置があるか。 */
export function tbAnyNeutralRoadTarget(state: GameState): boolean {
  return (state.tbNeutralPlayerIds ?? []).some(n => tbNeutralRoadTargets(state, n).length > 0);
}

/** どちらかの中立に合法な開拓地配置があるか。 */
export function tbAnyNeutralSettlementTarget(state: GameState): boolean {
  return (state.tbNeutralPlayerIds ?? []).some(n => tbNeutralSettlementTargets(state, n).length > 0);
}

/**
 * 自分の道を建てた後に発動する中立配置の種別。
 * 道1本につき中立の道1本（合法位置が無ければスキップ＝null）。
 */
export function tbNeutralPendingAfterRoad(state: GameState): 'road' | null {
  return tbAnyNeutralRoadTarget(state) ? 'road' : null;
}

/**
 * 自分の開拓地を建てた後に発動する中立配置の種別。
 * 中立の開拓地1つ（両中立とも合法位置が無ければ道1本で代替、道も無ければスキップ）。
 */
export function tbNeutralPendingAfterSettlement(state: GameState): 'road' | 'settlement' | null {
  if (tbAnyNeutralSettlementTarget(state)) return 'settlement';
  return tbNeutralPendingAfterRoad(state);
}

/** 頂点が「沿岸」か＝盤の外周（隣接タイル数<3）または海タイルに隣接（海のある盤との併用保険）。 */
export function tbIsCoastalVertex(state: GameState, vertexId: VertexId): boolean {
  const v = state.vertices[vertexId];
  if (!v) return false;
  if (v.adjacentTileIds.length < 3) return true;
  return v.adjacentTileIds.some(t => state.tiles[t]?.type === 'sea');
}

/**
 * 開拓地を建てた頂点で得る trade token 数（供給頭打ちは適用前の理論値）。
 * 砂漠に隣接=+2・沿岸=+1（両方満たせば加算＝3。仕様書§2-4 実装解釈）。
 */
export function tbTokensForSettlement(state: GameState, vertexId: VertexId): number {
  const v = state.vertices[vertexId];
  if (!v) return 0;
  let n = 0;
  if (v.adjacentTileIds.some(t => state.tiles[t]?.type === 'desert')) n += TB2_TOKENS_DESERT;
  if (tbIsCoastalVertex(state, vertexId)) n += TB2_TOKENS_COAST;
  return n;
}

/** trade token を供給から付与（供給残で頭打ち）。amount<=0 や変種無効時は no-op。 */
export function tbGrantTokens(state: GameState, pid: PlayerId, amount: number): GameState {
  if (!state.tbCatanForTwo || amount <= 0) return state;
  const bank = state.tbTradeTokenBank ?? 0;
  const actual = Math.min(amount, bank);
  if (actual <= 0) return state;
  return {
    ...state,
    tbTradeTokens: { ...(state.tbTradeTokens ?? {}), [pid]: ((state.tbTradeTokens ?? {})[pid] ?? 0) + actual },
    tbTradeTokenBank: bank - actual,
  };
}

/** トークン消費コスト: 自分の公開VP ≤ 相手なら1、上回っていれば2（隠しVPカードは計算外＝公開VP）。 */
export function tbSpendCost(state: GameState, pid: PlayerId): number {
  const opp = tbTwoOpponent(state, pid);
  if (opp == null) return TB2_SPEND_COST_BEHIND;
  return calcPublicVP(state, pid) <= calcPublicVP(state, opp)
    ? TB2_SPEND_COST_BEHIND
    : TB2_SPEND_COST_AHEAD;
}

/**
 * trade token を消費できるタイミングか（コスト・1ターン1回は別途判定）。
 * 「ダイス前」＝1回目の生産フェーズ開始前の PRE_ROLL のみ（2回の生産の間は不可）、
 * または アクションフェーズ（TRADE_BUILD）。
 */
export function tbCanSpendWindow(state: GameState): boolean {
  if (!state.tbCatanForTwo || state.phase !== 'MAIN') return false;
  if (state.turnPhase === 'PRE_ROLL') return (state.tbRollsDone ?? 0) === 0;
  return state.turnPhase === 'TRADE_BUILD';
}

/**
 * 生産フェーズ2回制: 「出目の解決が完了して TRADE_BUILD に入る」遷移の共通フック。
 * 1回目の解決完了なら 2回目のロールのため PRE_ROLL へ戻す（それ以外は素通し）。
 * ROLL_DICE 直後・MOVE_ROBBER 完了・CHOOSE_GOLD 完了・DISCARD 完了(盗賊凍結時) から呼ばれる。
 */
export function tbTwoAfterRollResolved(state: GameState): GameState {
  if (!state.tbCatanForTwo) return state;
  if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') return state;
  if (!state.diceRolledThisTurn) return state;
  if ((state.tbRollsDone ?? 0) !== 1) return state;
  return { ...state, turnPhase: 'PRE_ROLL' };
}
