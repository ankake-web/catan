// ============================================================
// src/engine/cloth.ts — 航海者 S6「カタンの織物」の織物交易
// ============================================================
//
// 小島の「村」（数字ヘックス）に自分の建物から航路（船）をつなぐと織物トークンを得る。
//   - 接続成立時に即1枚（供給があれば）
//   - 生産フェイズで村の数字が出たら、接続済みの各プレイヤーが1枚ずつ（供給の範囲で）
//   - 各村の供給は5枚。尽きたらその村は生産停止
//   - 織物2枚で1VP（端数は0VP）
//   - 5村（村が少なければ全村）が供給切れになった時点で最多VP（同点は織物が多い方）→ 終了
//
// 注意: 純粋関数（DOM非依存）。state.villages の無い盤では常に no-op。

import type { GameState, PlayerId, EdgeId } from '../types';
import { edgeTileIds } from './board';
import { calcVP } from './scoring';

function grantCloth(state: GameState, playerId: PlayerId, n: number): GameState {
  return { ...state, cloth: { ...(state.cloth ?? {}), [playerId]: ((state.cloth ?? {})[playerId] ?? 0) + n } };
}

/** 織物トークン数からVPを算出（2枚=1VP・端数0）。 */
export function clothVp(state: GameState, playerId: PlayerId): number {
  return Math.floor(((state.cloth ?? {})[playerId] ?? 0) / 2);
}

/**
 * 指定の辺に隣接する村へ、まだ未接続なら接続する（接続成立で即1枚・供給があれば）。
 * 村の無い盤では no-op。
 */
export function connectVillagesAround(state: GameState, edgeId: EdgeId, playerId: PlayerId): GameState {
  if (!state.villages) return state;
  const edge = state.edges[edgeId];
  if (!edge) return state;
  let next = state;
  for (const tid of edgeTileIds(edge, next.vertices)) {
    if (!(tid in (next.villages ?? {}))) continue;
    const conn = (next.villageConn ?? {})[tid] ?? [];
    if (conn.includes(playerId)) continue;
    next = { ...next, villageConn: { ...(next.villageConn ?? {}), [tid]: [...conn, playerId] } };
    const supply = (next.villages ?? {})[tid] ?? 0;
    if (supply > 0) {
      next = grantCloth(next, playerId, 1);
      next = { ...next, villages: { ...next.villages!, [tid]: supply - 1 } };
    }
  }
  return next;
}

/** 生産: 出目 total に一致する村ごとに、接続済みプレイヤーへ供給の範囲で1枚ずつ配る。 */
export function produceCloth(state: GameState, total: number): GameState {
  if (!state.villages) return state;
  let next = state;
  for (const [tid, supply] of Object.entries(next.villages ?? {})) {
    if (supply <= 0) continue;
    if (state.tiles[tid]?.number !== total) continue;
    const conn = (next.villageConn ?? {})[tid] ?? [];
    let left = supply;
    for (const pid of state.playerOrder) {
      if (left <= 0) break;
      if (!conn.includes(pid)) continue;
      next = grantCloth(next, pid, 1);
      left -= 1;
    }
    if (left !== supply) next = { ...next, villages: { ...next.villages!, [tid]: left } };
  }
  return next;
}

/**
 * 終了条件（S6 第2系統）: 5村（村が少なければ全村）が供給切れになったら、最多VPで終了。
 * 同点は織物が多い方、さらに同点は手番順で先のプレイヤー。14VP 到達は通常の checkVictory が処理する。
 */
export function checkClothEnd(state: GameState): GameState {
  if (!state.villages || state.phase === 'GAME_OVER') return state;
  const supplies = Object.values(state.villages);
  if (supplies.length === 0) return state;
  const depleted = supplies.filter(s => s <= 0).length;
  const threshold = Math.min(5, supplies.length);
  if (depleted < threshold) return state;

  let winner: PlayerId = state.playerOrder[0]!;
  let bestVp = -1;
  let bestCloth = -1;
  for (const pid of state.playerOrder) {
    const vp = calcVP(state, pid);
    const cl = (state.cloth ?? {})[pid] ?? 0;
    if (vp > bestVp || (vp === bestVp && cl > bestCloth)) { bestVp = vp; bestCloth = cl; winner = pid; }
  }
  return { ...state, winner, phase: 'GAME_OVER' };
}
