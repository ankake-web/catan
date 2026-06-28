// ============================================================
// src/engine/pirateIslands.ts — 航海者 S7「海賊の島々」
// ============================================================
//
// 各プレイヤーは本島から自色の海賊要塞へ船で航路を延ばし、要塞（ラホ3）を攻略する。
// 海賊艦隊は固定経路を自動巡回し、隣接する建物の所有者から資源を1枚奪う（脅威）。
// 勝利は「自分の要塞を制圧 かつ 10VP以上」（勝利判定は scoring.checkVictory が担当）。
//
// ※デジタル版簡略: 公式の軍船による艦隊戦解決は省き、艦隊は確定的な脅威（資源喪失）として表現。
//   盗賊/最長交易路は無効（rules）。要塞奪取後はその頂点が自分の開拓地（都市昇格可）になる。
//
// 注意: 純粋関数（DOM非依存）。fortresses の無い盤では各関数 no-op/false。

import type { GameState, PlayerId, EdgeId, VertexId, ResourceType } from '../types';
import { BUILD_COSTS, RESOURCE_TYPES } from '../constants';
import { isSeaEdge } from './board';
import { canBuildShip, hasEnoughResources } from './actions';

/** 自分の要塞に隣接する自分の船があり、まだ未奪取なら攻撃できる。 */
export function canAttackFortress(state: GameState, playerId: PlayerId): boolean {
  const f = state.fortresses?.[playerId];
  if (!f || f.captured) return false;
  const v = state.vertices[f.vertexId];
  if (!v) return false;
  return v.adjacentEdgeIds.some(eid => state.edges[eid]?.ship?.playerId === playerId);
}

/** 自分の要塞をラホ1つ分攻撃する。0で奪取＝その頂点が自分の開拓地になる。バリデーション済み前提。 */
export function attackFortress(state: GameState, playerId: PlayerId): GameState {
  const f = state.fortresses![playerId]!;
  const raho = f.raho - 1;
  if (raho > 0) {
    return { ...state, fortresses: { ...state.fortresses!, [playerId]: { ...f, raho } } };
  }
  // 奪取: 要塞頂点に自分の開拓地を置く（以後 都市昇格可・+1VP）。
  return {
    ...state,
    fortresses: { ...state.fortresses!, [playerId]: { ...f, raho: 0, captured: true } },
    vertices: { ...state.vertices, [f.vertexId]: { ...state.vertices[f.vertexId]!, building: { type: 'settlement', playerId } } },
  };
}

/**
 * 海賊艦隊を固定経路上で steps（=2個のダイスの小さい目）だけ前進させ、停止タイルに隣接する
 * 建物の所有者から資源を1枚奪う（バンクへ）。fleet の無い盤では no-op。
 */
export function moveFleet(state: GameState, steps: number, rng: () => number): GameState {
  const fleet = state.pirateFleet;
  if (!fleet || fleet.path.length === 0) return state;
  const pos = (fleet.pos + Math.max(1, steps)) % fleet.path.length;
  let next: GameState = { ...state, pirateFleet: { ...fleet, pos } };

  const tileId = fleet.path[pos]!;
  const seen = new Set<PlayerId>();
  for (const vid of state.tileToVertices[tileId] ?? []) {
    const owner = state.vertices[vid]?.building?.playerId;
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    // 所有者の手札から無作為に1枚をバンクへ（艦隊の襲撃）。
    const hand = next.players[owner]!.hand;
    const pool: ResourceType[] = [];
    for (const r of RESOURCE_TYPES) for (let i = 0; i < hand[r]; i++) pool.push(r);
    if (pool.length === 0) continue;
    const r = pool[Math.floor(rng() * pool.length)]!;
    next = {
      ...next,
      bank: { ...next.bank, [r]: next.bank[r] + 1 },
      players: { ...next.players, [owner]: { ...next.players[owner]!, hand: { ...hand, [r]: hand[r] - 1 } } },
    };
  }
  return next;
}

/**
 * AI: 自分の要塞へ向けて次に置く船の辺を返す（自分のネットワークから海辺をDijkstraで辿る）。
 * 既に要塞に隣接（攻撃可能）/奪取済み/資源不足 などでは null。
 */
export function bestFortressShip(state: GameState, playerId: PlayerId): EdgeId | null {
  const f = state.fortresses?.[playerId];
  if (!f || f.captured) return null;
  if (canAttackFortress(state, playerId)) return null; // もう隣接している
  const player = state.players[playerId];
  if (!player || (player.remainingShips ?? 0) <= 0 || !hasEnoughResources(player.hand, BUILD_COSTS.ship)) return null;

  // 始点: 自分の建物の頂点＋自分の船の端点。
  const dist: Record<string, number> = {};
  const firstShip: Record<string, EdgeId | null> = {};
  const addStart = (v: VertexId): void => { if (!(v in dist)) { dist[v] = 0; firstShip[v] = null; } };
  for (const v of Object.values(state.vertices)) if (v.building?.playerId === playerId) addStart(v.id);
  for (const e of Object.values(state.edges)) if (e.ship?.playerId === playerId) { addStart(e.vertexIds[0]); addStart(e.vertexIds[1]); }
  if (Object.keys(dist).length === 0) return null;

  const settled = new Set<string>();
  for (;;) {
    let cur: string | null = null, bestD = Infinity;
    for (const v of Object.keys(dist)) { if (!settled.has(v) && dist[v]! < bestD) { bestD = dist[v]!; cur = v; } }
    if (cur == null) break;
    settled.add(cur);
    const vtx = state.vertices[cur];
    if (!vtx) continue;
    for (const eid of vtx.adjacentEdgeIds) {
      const e = state.edges[eid];
      if (!e || !isSeaEdge(e, state.vertices, state.tiles)) continue;
      let step: number;
      if (e.ship?.playerId === playerId) step = 0;
      else if (e.ship == null && e.road == null) step = 1;
      else continue;
      const other = e.vertexIds[0] === cur ? e.vertexIds[1] : e.vertexIds[0];
      const nd = bestD + step;
      if (nd < (dist[other] ?? Infinity)) {
        dist[other] = nd;
        firstShip[other] = firstShip[cur] ?? (step === 1 ? eid : null);
      }
    }
  }

  const fs = firstShip[f.vertexId];
  return fs && canBuildShip(state, playerId, fs) ? fs : null;
}
