// ============================================================
// src/engine/pirateIslands.ts — 航海者 S7「海賊の島々」
// ============================================================
//
// 各プレイヤーは本島から自色の海賊要塞へ船で航路を延ばし、要塞（ラホ3）を攻略する。
// 海賊艦隊は固定経路を自動巡回し、停止タイルに隣接する建物の所有者と艦隊戦を解決する。
// 勝利は「自分の要塞を制圧 かつ 10VP以上」（勝利判定は scoring.checkVictory が担当）。
//
// 公式準拠の艦隊戦: 海賊の強さ=移動に使った目（小さい方の目）／自分の強さ=軍船(warship)数。
//   海賊が強い → ランダム資源1枚＋都市ごと1枚を破棄／自分が強い → 任意資源1枚を獲得／同点 → なし。
//   軍船は騎士カードで「起点に最も近い通常船」を1隻軍船化（playWarship）。盗賊/最長交易路/最大騎士力は無効（rules）。
//   要塞奪取後はその頂点が自分の開拓地（都市昇格可）になる。
//
// 注意: 純粋関数（DOM非依存）。fortresses の無い盤では各関数 no-op/false。

import type { GameState, PlayerId, EdgeId, VertexId, ResourceType } from '../types';
import { BUILD_COSTS, RESOURCE_TYPES } from '../constants';
import { isSeaEdge } from './board';
import { canBuildShip, hasEnoughResources } from './actions';

/** S7: プレイヤーの軍船(warship)数＝艦隊戦の戦力。 */
export function countWarships(state: GameState, playerId: PlayerId): number {
  return Object.values(state.edges).filter(e => e.ship?.playerId === playerId && e.ship.warship).length;
}

/** S7: 軍船化できる「通常船」が（建物に繋がる範囲に）あるか。 */
export function canPlayWarship(state: GameState, playerId: PlayerId): boolean {
  return closestNormalShip(state, playerId) != null;
}

/**
 * S7: 起点（自分の建物）に最も近い通常船を1隻探す（軍船化の対象）。
 * 自分の建物頂点から自分の船ネットワークを BFS し、最初に見つかる通常船の辺を返す。無ければ null。
 */
function closestNormalShip(state: GameState, playerId: PlayerId): EdgeId | null {
  const startV: VertexId[] = [];
  for (const v of Object.values(state.vertices)) if (v.building?.playerId === playerId) startV.push(v.id);
  if (startV.length === 0) return null;

  const seen = new Set<string>(startV);
  let frontier = [...startV];
  while (frontier.length > 0) {
    const next: VertexId[] = [];
    // この距離の頂点に隣接する自分の船を調べ、通常船があれば即返す（軍船は通過のみ）。
    const warshipEdges: EdgeId[] = [];
    for (const vid of frontier) {
      const v = state.vertices[vid];
      if (!v) continue;
      for (const eid of v.adjacentEdgeIds) {
        const sh = state.edges[eid]?.ship;
        if (sh?.playerId !== playerId) continue;
        if (!sh.warship) return eid;       // 最も近い通常船
        warshipEdges.push(eid);            // 軍船はネットワーク延長として通過
      }
    }
    // 通常船が無ければ、自分の船（軍船含む）の先の頂点へ BFS を広げる。
    for (const vid of frontier) {
      const v = state.vertices[vid];
      if (!v) continue;
      for (const eid of v.adjacentEdgeIds) {
        if (state.edges[eid]?.ship?.playerId !== playerId) continue;
        for (const ov of state.edges[eid]!.vertexIds) if (!seen.has(ov)) { seen.add(ov); next.push(ov); }
      }
    }
    void warshipEdges;
    frontier = next;
  }
  return null;
}

/** S7: 起点に最も近い通常船を1隻軍船化する。対象が無ければ null（バリデーションは canPlayWarship）。 */
export function playWarship(state: GameState, playerId: PlayerId): GameState | null {
  const eid = closestNormalShip(state, playerId);
  if (!eid) return null;
  const e = state.edges[eid]!;
  return { ...state, edges: { ...state.edges, [eid]: { ...e, ship: { ...e.ship!, warship: true } } } };
}

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

/** 手札から無作為に1枚を取り出してバンクへ戻す（艦隊戦の被害）。空なら不変。 */
function discardRandomToBank(state: GameState, owner: PlayerId, rng: () => number): GameState {
  const hand = state.players[owner]!.hand;
  const pool: ResourceType[] = [];
  for (const r of RESOURCE_TYPES) for (let i = 0; i < hand[r]; i++) pool.push(r);
  if (pool.length === 0) return state;
  const r = pool[Math.floor(rng() * pool.length)]!;
  return {
    ...state,
    bank: { ...state.bank, [r]: state.bank[r] + 1 },
    players: { ...state.players, [owner]: { ...state.players[owner]!, hand: { ...hand, [r]: hand[r] - 1 } } },
  };
}

/** 艦隊戦の勝利報酬「任意資源1枚」を自動選択して付与（手札が最も少ない・バンク在庫ありの資源）。 */
function grantBestResource(state: GameState, owner: PlayerId): GameState {
  const hand = state.players[owner]!.hand;
  let pick: ResourceType | null = null;
  for (const r of RESOURCE_TYPES) {
    if (state.bank[r] <= 0) continue;
    if (pick == null || hand[r] < hand[pick]) pick = r;
  }
  if (pick == null) return state; // バンク枯渇
  return {
    ...state,
    bank: { ...state.bank, [pick]: state.bank[pick] - 1 },
    players: { ...state.players, [owner]: { ...state.players[owner]!, hand: { ...hand, [pick]: hand[pick] + 1 } } },
  };
}

/**
 * 海賊艦隊を固定経路上で steps（=2個のダイスの小さい目）だけ前進させ、停止タイルに隣接する
 * 建物の所有者と艦隊戦を解決する（公式）。海賊の強さ=steps／自分の強さ=軍船数:
 *   海賊が強い → ランダム1枚＋都市ごと1枚を破棄／自分が強い → 任意1枚獲得／同点 → なし。
 * fleet の無い盤では no-op。
 */
export function moveFleet(state: GameState, steps: number, rng: () => number): GameState {
  const fleet = state.pirateFleet;
  if (!fleet || fleet.path.length === 0) return state;
  const pos = (fleet.pos + Math.max(1, steps)) % fleet.path.length;
  let next: GameState = { ...state, pirateFleet: { ...fleet, pos } };

  const pirateStrength = Math.max(1, steps);
  const tileId = fleet.path[pos]!;
  const seen = new Set<PlayerId>();
  for (const vid of state.tileToVertices[tileId] ?? []) {
    const owner = state.vertices[vid]?.building?.playerId;
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);

    const myStrength = countWarships(next, owner);
    if (pirateStrength > myStrength) {
      // 海賊が強い: ランダム1枚＋（その所有者の）都市ごと1枚を破棄。
      const cities = Object.values(next.vertices)
        .filter(v => v.building?.playerId === owner && v.building.type === 'city').length;
      for (let k = 0; k < 1 + cities; k++) next = discardRandomToBank(next, owner, rng);
    } else if (myStrength > pirateStrength) {
      // 自分が強い: 任意資源1枚を獲得（自動選択）。
      next = grantBestResource(next, owner);
    }
    // 同点: 何も起きない。
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
