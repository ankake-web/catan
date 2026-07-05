// ============================================================
// src/engine/ai.ts — AIプレイヤー（難易度対応）
// ============================================================

import type { GameState, Action, PlayerId, ResourceType, AiDifficulty, ResourceHand, DevCardType, CkTrack } from '../types';
import { RESOURCE_TYPES, COMMODITY_TYPES, BUILD_COSTS, VP_TABLE, TILE_RESOURCE_MAP, LONGEST_ROAD_MIN, TB_ROAD_REPAIR_COST } from '../constants';
import { discardCount, robbableCardCount, getRobberMoveTargets, isFriendlyRobberProtected } from './robber';
import { canBuildRoad, canBuildShip, canBuildSettlement, canBuildCity, hasEnoughResources } from './actions';
import {
  isCk, canBuildImprovement, canActivateKnight, canBuildKnight, canUpgradeKnight, canPlayProgress,
  robberAdjacentChasableVertexIds, plainCityVertexIds, progressDiscardCandidates,
} from './citiesKnights';
import { isSeaEdge, isLandVertex, isDistanceRuleOk } from './board';
import { isUnclaimedNewIslandVertex } from './islands';
import { bestWonderAction } from './wonders';
import { canAttackFortress, bestFortressShip, canPlayWarship } from './pirateIslands';
import { canBankTrade, getEffectiveTradeRate } from './trade';
import { calcVP, calcPublicVP, victoryTarget, calcLongestRoad } from './scoring';
import { applyAction } from './game';
import { tbEventStealTargets } from './tbEvents';

// ============================================================
// 確率テーブル（数字トークンの出目確率 /36）
// ============================================================

const NUMBER_PROB: Record<number, number> = {
  2: 1, 3: 2, 4: 3, 5: 4, 6: 5,
  8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
};

// CPU→人間 交易提案を「試みる」確率（建設不能ターンに1回だけ判定）。
// 実際に提案が出るのは findCpuTradeOpportunity が機会を返したときのみ。
// テンポ悪化を避けるため控えめに設定。弱CPUは提案しない（0扱い）。
const CPU_TRADE_OFFER_CHANCE = {
  normal: 0.22,
  strong: 0.28,
} as const;

// ============================================================
// ユーティリティ
// ============================================================

function vertexProductionScore(state: GameState, vertexId: string): number {
  return (state.vertices[vertexId]?.adjacentTileIds ?? []).reduce((sum, tid) => {
    const n = state.tiles[tid]?.number;
    return sum + (n ? (NUMBER_PROB[n] ?? 0) : 0);
  }, 0);
}

// 頂点に隣接するタイルの産出資源（砂漠は除外）。
function adjacentResources(state: GameState, vertexId: string): ResourceType[] {
  const out: ResourceType[] = [];
  for (const tid of state.vertices[vertexId]?.adjacentTileIds ?? []) {
    const t = state.tiles[tid];
    const r = t ? TILE_RESOURCE_MAP[t.type] : null;
    if (r) out.push(r);
  }
  return out;
}

// 頂点に隣接するタイルの数字（砂漠/未設定は除外）。
function adjacentNumbers(state: GameState, vertexId: string): number[] {
  const out: number[] = [];
  for (const tid of state.vertices[vertexId]?.adjacentTileIds ?? []) {
    const n = state.tiles[tid]?.number;
    if (n != null) out.push(n);
  }
  return out;
}

// 初期配置ヒューリスティックの重み（チューニングはここ1か所に集約）。
const SETUP_WEIGHTS = {
  pip: 1.0,          // 隣接3ヘックスの pip(出目確率) 合計の基礎重み
  diversity: 1.5,    // 異なる資源1種ごとの加点（資源の多様性）
  oreWheat: 2.0,     // ore と wheat(grain) の両方に触れる（都市化に重要）
  woodBrick: 1.5,    // wood と brick の両方に触れる（序盤拡張に重要）
  harbor: 1.0,       // 港に接する小加点
  numberSpread: 1.0, // 隣接数字が全て異なるときの加点（同じ数字への偏りを避ける）
  newResource: 2.0,  // (2軒目) 1軒目に無い資源1種ごとの加点
  newNumber: 0.5,    // (2軒目) 1軒目と異なる数字1個ごとの加点
} as const;

/**
 * 初期配置（開拓地）の頂点評価。高いほど良い。純粋関数。
 * 基礎 = 隣接 pip 合計。補正 = 資源多様性 / ore+wheat / wood+brick / 港 / 数字分散。
 * ownFirstSettlement を渡すと（2軒目想定）1軒目に無い資源・別数字を補完するほど加点する。
 */
export function evaluateVertexForSetup(
  state: GameState,
  vertexId: string,
  ownFirstSettlement?: string,
): number {
  if (!state.vertices[vertexId]) return -Infinity;
  const resources = adjacentResources(state, vertexId);
  const uniqueRes = new Set(resources);
  const numbers = adjacentNumbers(state, vertexId);
  const uniqueNums = new Set(numbers);

  let score = vertexProductionScore(state, vertexId) * SETUP_WEIGHTS.pip;
  score += uniqueRes.size * SETUP_WEIGHTS.diversity;
  if (uniqueRes.has('ore') && uniqueRes.has('grain')) score += SETUP_WEIGHTS.oreWheat;
  if (uniqueRes.has('wood') && uniqueRes.has('brick')) score += SETUP_WEIGHTS.woodBrick;
  if (state.vertices[vertexId]?.harborType) score += SETUP_WEIGHTS.harbor;
  if (numbers.length > 0 && uniqueNums.size === numbers.length) score += SETUP_WEIGHTS.numberSpread;

  if (ownFirstSettlement) {
    const firstRes = new Set(adjacentResources(state, ownFirstSettlement));
    const firstNums = new Set(adjacentNumbers(state, ownFirstSettlement));
    for (const r of uniqueRes) if (!firstRes.has(r)) score += SETUP_WEIGHTS.newResource;
    for (const n of uniqueNums) if (!firstNums.has(n)) score += SETUP_WEIGHTS.newNumber;
  }
  return score;
}

// スコア最大の要素を選ぶ。最大が拮抗（eps以内）する場合のみ seed RNG でタイブレーク。
function pickByScore<T>(items: T[], scoreFn: (t: T) => number, rng: () => number, eps = 0.01): T {
  const scored = items.map(it => ({ it, s: scoreFn(it) }));
  const best = scored.reduce((m, x) => Math.max(m, x.s), -Infinity);
  const top = scored.filter(x => x.s >= best - eps).map(x => x.it);
  return top.length === 1 ? top[0]! : top[Math.floor(rng() * top.length)]!;
}

// ============================================================
// 手番方策（A-3）の評価ヘルパー
// ============================================================

// 資源の戦略的重み。都市化で生産が倍になる ore/wheat(grain) を重視する。
const RESOURCE_WEIGHT: Record<ResourceType, number> = {
  ore: 1.3, grain: 1.3, wool: 1.0, wood: 1.0, brick: 1.0,
};

// 頂点の重み付き生産価値 = Σ pip(隣接タイル) × 資源重み。都市化先・開拓地先の良し悪し。
// 金タイル(gold)はどの資源にもなれる万能産出なので、ore/grain と同等の高めの重みで評価する。
const GOLD_WEIGHT = 1.3;
export function weightedProduction(state: GameState, vertexId: string): number {
  let v = 0;
  for (const tid of state.vertices[vertexId]?.adjacentTileIds ?? []) {
    const t = state.tiles[tid];
    if (!t) continue;
    if (t.type === 'gold') { v += (t.number ? (NUMBER_PROB[t.number] ?? 0) : 0) * GOLD_WEIGHT; continue; }
    const r = TILE_RESOURCE_MAP[t.type];
    if (!r) continue;
    v += (t.number ? (NUMBER_PROB[t.number] ?? 0) : 0) * RESOURCE_WEIGHT[r];
  }
  return v;
}

// pid が既に産出している資源の集合（建物の隣接タイルから導出）。
function playerResourceCoverage(state: GameState, pid: PlayerId): Set<ResourceType> {
  const cov = new Set<ResourceType>();
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    for (const r of adjacentResources(state, v.id)) cov.add(r);
  }
  return cov;
}

// MAIN フェーズの開拓地先評価 = 重み付き生産 + 未保有資源の補完 + 港小加点。
const EXPANSION_NEW_RESOURCE = 2.0;
const EXPANSION_HARBOR = 1.0;
// 航海者: 新しい島へ最初に入植すると +2VP（島ボーナス）＋金タイルへの足場。
// AI が新島開拓へ向かう動機づけ（基本ゲームでは isUnclaimedNewIslandVertex が常に false）。
const EXPANSION_ISLAND_PIONEER = 4.0;
export function evaluateExpansionVertex(state: GameState, pid: PlayerId, vertexId: string): number {
  let score = weightedProduction(state, vertexId);
  const cov = playerResourceCoverage(state, pid);
  for (const r of new Set(adjacentResources(state, vertexId))) if (!cov.has(r)) score += EXPANSION_NEW_RESOURCE;
  if (state.vertices[vertexId]?.harborType) score += EXPANSION_HARBOR;
  if (isUnclaimedNewIslandVertex(state, vertexId)) score += EXPANSION_ISLAND_PIONEER;
  return score;
}

// 建設可能な都市化先のうち最良（重み付き生産最大、ore/wheat重視）。無ければ null。
function bestCityVertex(state: GameState, pid: PlayerId, rng: () => number): string | null {
  const verts = Object.keys(state.vertices).filter(v => canBuildCity(state, pid, v));
  return verts.length > 0 ? pickByScore(verts, v => weightedProduction(state, v), rng) : null;
}

// 建設可能な開拓地先のうち最良（生産＋資源補完）。無ければ null。
function bestSettlementVertex(state: GameState, pid: PlayerId, rng: () => number): string | null {
  const verts = Object.keys(state.vertices).filter(v => canBuildSettlement(state, pid, v));
  return verts.length > 0 ? pickByScore(verts, v => evaluateExpansionVertex(state, pid, v), rng) : null;
}

// 道の価値 = その辺が開く（空き）頂点の最良 evaluateExpansionVertex。
// 良い拡張先へ向かう道を優先する（行き止まりの道を避ける）。
function roadEdgeValue(state: GameState, pid: PlayerId, edgeId: string): number {
  const e = state.edges[edgeId];
  if (!e) return 0;
  let best = 0;
  for (const vid of e.vertexIds) {
    if (state.vertices[vid]?.building) continue; // 既に建物がある頂点は開かない
    best = Math.max(best, evaluateExpansionVertex(state, pid, vid));
  }
  return best;
}

// 建設可能な道のうち最良の拡張先へ向かう辺。無ければ null。
function bestRoadEdge(state: GameState, pid: PlayerId, rng: () => number): string | null {
  const edges = Object.keys(state.edges).filter(eid => canBuildRoad(state, pid, eid));
  return edges.length > 0 ? pickByScore(edges, eid => roadEdgeValue(state, pid, eid), rng) : null;
}

// ============================================================
// 航海者: 船による島拡張（Phase 5・基本AI）
// ============================================================

// 海タイルを含む盤か（航海者シナリオの判定）。基本ゲームでは常に false なので、
// 以下の船ロジックは classic では一切起動しない（非破壊）。
function hasSeaTiles(state: GameState): boolean {
  return Object.values(state.tiles).some(t => t.type === 'sea');
}

// 接続要件を除き、距離ルール上その空き陸頂点に開拓地を置けるか（船で到達後の建設先候補）。
function isOpenLandSpot(state: GameState, vid: string): boolean {
  const v = state.vertices[vid];
  if (!v || v.building) return false;
  if (!isLandVertex(v, state.tiles)) return false;
  return isDistanceRuleOk(v, state.vertices);
}

// 1隻あたりのコスト換算（遠い島ほど割引）と、渡るに値する目的地の最低価値。
const SHIP_STEP_PENALTY = 2.0;
const SHIP_MIN_TARGET = 4.0;

/**
 * 海を渡って良い新規開拓地へ向かう「次に置く1隻」を返す（基本AIの船活用）。
 *
 * 自分のネットワーク（建物の頂点・既存の船の端点）を始点に、海辺(sea-edge)を
 * Dijkstra で辿り（自分の既存船=コスト0／空きの海辺=コスト1＝新規に1隻）、
 * 新規に船を要して到達できる空き陸頂点のうち
 *   価値 evaluateExpansionVertex - SHIP_STEP_PENALTY×必要隻数
 * が最大の経路の「最初の新規船」を返す。良い目的地が無い/launch不能/資源不足なら null。
 *
 * 1ターンに複数回呼ばれると、既設の船はコスト0で辿られるため同じ目的地へ船を継ぎ足し、
 * 資源が尽きると null（→ END_TURN へ）。新島の沿岸頂点に船が届けば、次以降の手番で
 * bestSettlementVertex が canBuildSettlement(船接続) によりそこへ開拓地を建てる。
 */
function bestExpansionShip(state: GameState, pid: PlayerId): string | null {
  if (!hasSeaTiles(state)) return null;
  const player = state.players[pid];
  if (!player || (player.remainingShips ?? 0) <= 0) return null;
  if (!hasEnoughResources(player.hand, BUILD_COSTS.ship)) return null;

  // 始点: 自分の建物がある頂点 + 自分の船の端点。
  const dist: Record<string, number> = {};
  const firstShip: Record<string, string | null> = {};
  const addStart = (v: string): void => { if (!(v in dist)) { dist[v] = 0; firstShip[v] = null; } };
  for (const v of Object.values(state.vertices)) if (v.building?.playerId === pid) addStart(v.id);
  for (const e of Object.values(state.edges)) {
    if (e.ship?.playerId === pid) { addStart(e.vertexIds[0]); addStart(e.vertexIds[1]); }
  }
  if (Object.keys(dist).length === 0) return null;

  // Dijkstra（コスト = 新規に置く船の数）。海辺のみ辿る。
  const settled = new Set<string>();
  for (;;) {
    let cur: string | null = null;
    let bestD = Infinity;
    for (const v of Object.keys(dist)) {
      if (settled.has(v)) continue;
      if (dist[v]! < bestD) { bestD = dist[v]!; cur = v; }
    }
    if (cur == null) break;
    settled.add(cur);
    const vtx = state.vertices[cur];
    if (!vtx) continue;
    for (const eid of vtx.adjacentEdgeIds) {
      const e = state.edges[eid];
      if (!e || !isSeaEdge(e, state.vertices, state.tiles)) continue; // 船は海辺のみ
      let stepCost: number;
      if (e.ship?.playerId === pid) stepCost = 0;            // 自分の既存船は無料で辿る
      else if (e.ship == null && e.road == null) stepCost = 1; // 空きの海辺＝新規1隻
      else continue;                                          // 他人の船 or 道で塞がっている
      const other = e.vertexIds[0] === cur ? e.vertexIds[1] : e.vertexIds[0];
      const nd = bestD + stepCost;
      if (nd < (dist[other] ?? Infinity)) {
        dist[other] = nd;
        // 経路上で最初に新規に置く船を引き継ぐ。
        firstShip[other] = firstShip[cur] ?? (stepCost === 1 ? eid : null);
      }
    }
  }

  // 目的地評価: 新規船>=1 で到達する空き陸頂点のうち価値最大の経路の最初の船を選ぶ。
  let bestScore = 0;
  let chosen: string | null = null;
  for (const [vid, c] of Object.entries(dist)) {
    if (c < 1) continue;                 // 新規船が不要（既存船で到達 or 始点）
    const fs = firstShip[vid];
    if (!fs || !isOpenLandSpot(state, vid)) continue;
    const val = evaluateExpansionVertex(state, pid, vid);
    if (val < SHIP_MIN_TARGET) continue;
    const score = val - SHIP_STEP_PENALTY * c;
    if (score > bestScore) { bestScore = score; chosen = fs; }
  }
  // 最初の1隻が今すぐ合法であることを最終確認（防御）。
  return chosen && canBuildShip(state, pid, chosen) ? chosen : null;
}

function getDifficulty(state: GameState, pid: PlayerId): AiDifficulty {
  return state.players[pid]?.aiDifficulty ?? 'normal';
}

/** 強盗の現在地以外の最初の陸タイルIDを返す（フォールバック用）。海タイルは除外（陸のみ）。 */
function fallbackTileId(state: GameState, excludeId: string | undefined): string {
  const land = Object.keys(state.tiles).filter(tid => state.tiles[tid]?.type !== 'sea');
  return land.find(tid => tid !== excludeId) ?? land[0] ?? Object.keys(state.tiles)[0]!;
}

// ============================================================
// CPU→人間 交易機会検出
// ============================================================

/**
 * CPUが人間プレイヤーに1:1交易を提案できる機会を探す。
 * CPUが建設目標（都市 > 開拓地 > 発展カード）に対して 1 枚だけ不足しており、
 * 自分の余剰資源を1枚渡せる場合に提案内容を返す。条件を満たさない場合は null。
 *
 * 重要: CPUは**自分の手札のみ**を参照する。人間（相手）の手札内容は一切見ない。
 * 「相手が持っているかは分からないが、欲しいので提案する」という挙動とする。
 * 人間が要求資源を持っているかの判定は UI 側（人間本人の手札）と
 * confirmTrade の最終バリデーションに委ねる。
 */
export function findCpuTradeOpportunity(
  state: GameState,
  cpuPid: PlayerId,
): { give: ResourceType; receive: ResourceType; humanPid: PlayerId } | null {
  const cpu = state.players[cpuPid];
  if (!cpu || cpu.type !== 'ai') return null; // 提案を出すのは AI プレイヤーのみ

  const humanPid = state.playerOrder.find(
    p => p !== cpuPid && state.players[p]?.type === 'human',
  ) as PlayerId | undefined;
  if (!humanPid) return null;

  for (const cost of [BUILD_COSTS.city, BUILD_COSTS.settlement, BUILD_COSTS.dev_card] as ResourceHand[]) {
    if (hasEnoughResources(cpu.hand, cost)) continue; // 既に建設可能

    for (const receive of RESOURCE_TYPES) {
      const deficit = (cost[receive] ?? 0) - cpu.hand[receive];
      if (deficit !== 1) continue;           // ちょうど 1 枚不足のみ
      // 人間の手札は参照しない（CPUは相手が持っているか知らない）

      for (const give of RESOURCE_TYPES) {
        if (give === receive) continue;
        // 建設コスト分を残しても give が 1 枚以上余る（自分の手札のみ参照）
        const surplus = cpu.hand[give] - (cost[give] ?? 0);
        if (surplus < 1) continue;
        return { give, receive, humanPid };
      }
    }
  }
  return null;
}

// 単独首位のプレイヤー（同点なら null）。利敵回避の判定に使う。
function soleVpLeader(state: GameState): PlayerId | null {
  let best = -1;
  let leader: PlayerId | null = null;
  let tie = false;
  for (const pid of state.playerOrder) {
    const vp = calcVP(state, pid);
    if (vp > best) { best = vp; leader = pid; tie = false; }
    else if (vp === best) tie = true;
  }
  return tie ? null : leader;
}

/**
 * 相手(initiator)からの交易提案を responder(CPU)が受けるべきか判断する純粋関数。
 * offer は initiator 視点（initiator が give を渡し receive を受け取る）。
 * よって responder は offer.give を受け取り、offer.receive を渡す。
 * 受諾条件:
 *  - 渡す資源を支払える。
 *  - 受け取る資源が自分の建設目標(goalCosts)の不足を埋める（局面が前進する）。
 *  - 渡す資源が目標必要数を割らない（目標に必要な資源は手放さない）。
 *  - 起案者が単独首位かつ勝利間近(VP>=target-3)なら、過度に利敵しないよう拒否。
 */
export function evaluateTradeOffer(
  state: GameState,
  responderId: PlayerId,
  offer: { give: Partial<ResourceHand>; receive: Partial<ResourceHand> },
  initiatorId: PlayerId,
): boolean {
  const me = state.players[responderId];
  if (!me) return false;
  const gain = offer.give;     // responder が受け取る
  const cost = offer.receive;  // responder が渡す

  // 渡す資源を支払えること
  for (const r of RESOURCE_TYPES) if ((me.hand[r] ?? 0) < (cost[r] ?? 0)) return false;

  const goals = goalCosts(state, responderId);
  const needed = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) needed[r] = goals.reduce((m, g) => Math.max(m, g[r] ?? 0), 0);

  // 受け取りが目標の不足を埋めるか（前進しない交易は受けない）
  const helps = RESOURCE_TYPES.some(r => (gain[r] ?? 0) > 0 && me.hand[r] < needed[r]);
  if (!helps) return false;

  // ---- 損得検査（搾取防止）----
  // これが無いと「羊1↔鉄6」のような極端に不利な提案でも、目標の不足を埋めさえすれば
  // 受けてしまい、人間が安資源1枚で CPU の手札を大量に抜ける。
  const totalGain = RESOURCE_TYPES.reduce((s, r) => s + (gain[r] ?? 0), 0);
  const totalCost = RESOURCE_TYPES.reduce((s, r) => s + (cost[r] ?? 0), 0);

  // 銀行レートガード: 自分の銀行/港レートで同等以上の交換ができるなら相手に利だけ渡す提案。
  // 複数資源を渡す場合は最も有利な（小さい）レートで保守的に判定する。
  const minRate = RESOURCE_TYPES.reduce(
    (m, r) => (cost[r] ?? 0) > 0 ? Math.min(m, getEffectiveTradeRate(state, responderId, r)) : m,
    4,
  );
  if (totalCost >= minRate * totalGain) return false;

  // 枚数で損する交易は、超過1枚まで・かつ「交換後に建設目標が即達成できるようになる」
  // 場合のみ受ける（焦点の建設を完成させるための小さな上乗せだけ許容）。
  if (totalCost > totalGain) {
    if (totalCost > totalGain + 1) return false;
    const afterHand = { ...me.hand };
    for (const r of RESOURCE_TYPES) afterHand[r] += (gain[r] ?? 0) - (cost[r] ?? 0);
    const canBuildAfter = goals.some(g => hasEnoughResources(afterHand, g));
    const canBuildBefore = goals.some(g => hasEnoughResources(me.hand, g));
    if (!canBuildAfter || canBuildBefore) return false;
  }

  // 渡す資源が目標必要数を割らないか（必要資源は温存）
  for (const r of RESOURCE_TYPES) {
    if ((cost[r] ?? 0) === 0) continue;
    const after = me.hand[r] - (cost[r] ?? 0) + (gain[r] ?? 0);
    if (after < needed[r]) return false;
  }

  // 利敵回避: 起案者が単独首位かつ勝利間近なら見送る
  const leader = soleVpLeader(state);
  if (leader === initiatorId && initiatorId !== responderId
      && calcVP(state, initiatorId) >= victoryTarget(state) - 3) {
    return false;
  }
  return true;
}

// ============================================================
// メインエントリポイント
// ============================================================

export interface AiOpts {
  /** true の場合、このターンのプレイヤー間交易提案をスキップ */
  skipPlayerTrade?: boolean;
  /** 乱数生成器（テスト/LAN で注入可能。未指定は Math.random）。CPU判断を再現可能にする。 */
  rng?: () => number;
}

export function chooseAction(state: GameState, pid: PlayerId, opts?: AiOpts): Action | null {
  if (state.phase === 'GAME_OVER') return null;
  const rng = opts?.rng ?? Math.random;

  if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
    if (state.playerOrder[state.currentPlayerIndex] !== pid) return null;
    return chooseSetupAction(state, pid, rng);
  }

  if (state.phase !== 'MAIN') return null;

  if (state.turnPhase === 'DISCARD') {
    return chooseDiscard(state, pid, rng);
  }

  // 金タイル産出の選択（DISCARD 同様、手番に関わらず owed なプレイヤーが解決する）。
  if (state.turnPhase === 'GOLD') {
    return chooseGold(state, pid);
  }

  // 騎士と商人: 蛮族敗北での都市格下げ（手番に関わらず対象プレイヤーが解決する）。
  if (state.turnPhase === 'CITY_DOWNGRADE') {
    return chooseCityDowngrade(state, pid);
  }

  // 騎士と商人: 進歩カード上限超過（5枚目を引いた）→ 1枚捨てる（対象プレイヤーが解決する）。
  if (state.turnPhase === 'PROGRESS_DISCARD') {
    return chooseProgressDiscard(state, pid);
  }

  // 交易と蛮族「イベントカード」: イベント選択の解決（手番に関わらず対象プレイヤーが解決する）。
  if (state.turnPhase === 'EVENT_GIVE')    return chooseEventGive(state, pid);
  if (state.turnPhase === 'EVENT_HELPFUL') return chooseEventHelpful(state, pid);
  if (state.turnPhase === 'EVENT_STEAL')   return chooseEventSteal(state, pid);
  if (state.turnPhase === 'EVENT_DAMAGE')  return chooseEventDamage(state, pid);

  if (state.playerOrder[state.currentPlayerIndex] !== pid) return null;

  const player = state.players[pid];
  if (!player) return null;

  switch (state.turnPhase) {
    case 'PRE_ROLL':    return choosePreRollAction(state, pid);
    case 'ROBBER':      return chooseRobberAction(state, pid, rng);
    case 'TRADE_BUILD': return chooseTradeBuildAction(state, pid, opts?.skipPlayerTrade ?? false, rng);
    default:            return null;
  }
}

// ============================================================
// セットアップフェーズ
// ============================================================

function chooseSetupAction(state: GameState, pid: PlayerId, rng: () => number): Action | null {
  const difficulty = getDifficulty(state, pid);

  if (state.setupSubPhase === 'PLACE_SETTLEMENT') {
    const valid = Object.keys(state.vertices).filter(vid =>
      canBuildSettlement(state, pid, vid),
    );
    if (valid.length === 0) return null;

    if (difficulty === 'weak') {
      return { type: 'BUILD_SETTLEMENT', vertexId: valid[Math.floor(rng() * valid.length)]! };
    }

    // 2軒目(SETUP_BACKWARD)は自分の1軒目を踏まえ、不足資源・別数字を補完する評価にする。
    const firstSettlement = state.phase === 'SETUP_BACKWARD'
      ? Object.keys(state.vertices).find(vid => {
          const b = state.vertices[vid]?.building;
          return b?.type === 'settlement' && b.playerId === pid;
        })
      : undefined;
    // elite は基本ゲームで生産重視の配置を使う（CKは商品地形も要るため標準評価）。
    const evalFn = (difficulty === 'elite' && !isCk(state))
      ? (vid: string): number => evaluateVertexForSetupElite(state, vid, firstSettlement)
      : (vid: string): number => evaluateVertexForSetup(state, vid, firstSettlement);
    const chosen = pickByScore(valid, evalFn, rng);
    return { type: 'BUILD_SETTLEMENT', vertexId: chosen };
  }

  if (state.setupSubPhase === 'PLACE_ROAD') {
    const valid = Object.keys(state.edges).filter(eid =>
      canBuildRoad(state, pid, eid),
    );
    if (valid.length === 0) return null;

    if (difficulty === 'weak') {
      return { type: 'BUILD_ROAD', edgeId: valid[Math.floor(rng() * valid.length)]! };
    }
    // 直前に置いた開拓地から、良い拡張先（新資源・高pip）へ向かう辺を選ぶ。
    return { type: 'BUILD_ROAD', edgeId: pickByScore(valid, eid => roadEdgeValue(state, pid, eid), rng) };
  }

  return null;
}

// ============================================================
// PRE_ROLL フェーズ
// ============================================================

function choosePreRollAction(state: GameState, pid: PlayerId): Action {
  const player = state.players[pid]!;
  const difficulty = getDifficulty(state, pid);

  // 騎士と商人: 錬金術師(alchemist)は振る前に使う。使える状況なら振る前に使用。
  if (difficulty !== 'weak' && isCk(state)) {
    const alch = (player.progressCards ?? []).find(c => c.type === 'alchemist' && canPlayProgress(state, pid, c.id));
    if (alch) return { type: 'PLAY_PROGRESS', cardId: alch.id };
  }

  // 1ターン1枚制限を尊重（devCardPlayedThisTurn を見ないと2枚目で例外→停止する）。
  if (difficulty !== 'weak' && !state.devCardPlayedThisTurn) {
    const knight = player.devCards.find(
      c => c.type === 'knight' && c.purchasedOnTurn < state.globalTurnNumber,
    );
    if (knight) {
      if (state.fortresses !== undefined) {
        // S7 海賊の島々: 騎士＝軍船化。軍船化できる通常船がある時だけ使う（艦隊戦の戦力強化）。
        if (canPlayWarship(state, pid)) return { type: 'PLAY_KNIGHT' };
      } else if (state.useRobber !== false) {
        return { type: 'PLAY_KNIGHT' };
      }
    }
  }

  return { type: 'ROLL_DICE' };
}

// ============================================================
// DISCARD フェーズ（難易度に関わらず正確に捨てる）
// ============================================================

function chooseDiscard(state: GameState, pid: PlayerId, rng: () => number = Math.random): Action | null {
  const player = state.players[pid];
  if (!player) return null;

  // 既にこの7で捨て済みなら何もしない（エンジンの二重捨てガードと整合）。
  if ((state.discardedThisRound ?? []).includes(pid)) return null;

  const required = discardCount(state, pid); // 騎士と商人は資源＋商品で判定
  if (required === 0) return null;

  if (isCk(state)) {
    // まず余剰資源を捨て、不足分は商品を多い順に捨てる。
    const resTotal = RESOURCE_TYPES.reduce((s, r) => s + player.hand[r], 0);
    const resCount = Math.min(required, resTotal);
    const resDiscards = chooseDiscards(state, pid, resCount, rng);
    let need = required - resCount;
    const rem = { ...(player.commodities ?? { coin: 0, cloth: 0, paper: 0 }) };
    const commDiscards: Partial<Record<typeof COMMODITY_TYPES[number], number>> = {};
    while (need > 0) {
      const c = COMMODITY_TYPES.filter(x => rem[x] > 0).sort((a, b) => rem[b] - rem[a])[0];
      if (!c) break;
      rem[c] -= 1; commDiscards[c] = (commDiscards[c] ?? 0) + 1; need -= 1;
    }
    return { type: 'DISCARD_RESOURCES', playerId: pid, resources: resDiscards, commodities: commDiscards };
  }
  return { type: 'DISCARD_RESOURCES', playerId: pid, resources: chooseDiscards(state, pid, required, rng) };
}

/**
 * 破棄する資源を選ぶ純粋関数。次の建設目標(goalCosts)に必要な資源を温存し、
 * 余剰(手札 - 目標必要数)が大きい資源から1枚ずつ count 枚捨てる。
 * 余剰が拮抗するときのみ seed RNG でタイブレーク（決定的）。
 */
export function chooseDiscards(
  state: GameState, pid: PlayerId, count: number, rng: () => number = Math.random,
): Partial<Record<ResourceType, number>> {
  const player = state.players[pid];
  if (!player) return {};
  const goals = goalCosts(state, pid);
  // 各資源の必要数 = 目標コストに含まれる枚数の最大（最優先目標を含む全目標で温存）。
  const needed = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) needed[r] = goals.reduce((m, g) => Math.max(m, g[r] ?? 0), 0);

  const remaining = { ...player.hand };
  const discards: Partial<Record<ResourceType, number>> = {};
  for (let i = 0; i < count; i++) {
    const avail = RESOURCE_TYPES.filter(r => remaining[r] > 0);
    if (avail.length === 0) break;
    // 余剰度（remaining - needed）が最大の資源を捨てる。必要資源は最後まで温存される。
    const pick = pickByScore(avail, r => remaining[r] - needed[r], rng);
    remaining[pick] -= 1;
    discards[pick] = (discards[pick] ?? 0) + 1;
  }
  return discards;
}

// ============================================================
// GOLD フェーズ（航海者・金タイル産出の任意資源選択）
// ============================================================

/**
 * 金タイル産出で得る任意資源を選ぶ純粋関数。次の建設目標(goalCosts)に不足する資源を
 * 優先し、残りは戦略重み(ore/grain 重視)の高い資源で埋める。バンク在庫の範囲内で選ぶ。
 * 相手の手札は覗かない（自分の手札と目標のみ参照）。
 */
export function chooseGoldResources(
  state: GameState, pid: PlayerId, owed: number,
): Partial<Record<ResourceType, number>> {
  const player = state.players[pid];
  if (!player) return {};
  const goals = goalCosts(state, pid);
  const needed = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) needed[r] = goals.reduce((m, g) => Math.max(m, g[r] ?? 0), 0);

  const out: Partial<Record<ResourceType, number>> = {};
  const bankLeft = { ...state.bank };
  const handAfter = { ...player.hand };
  for (let i = 0; i < owed; i++) {
    const avail = RESOURCE_TYPES.filter(r => bankLeft[r] > 0);
    if (avail.length === 0) break; // バンク在庫切れ（owed は在庫で頭打ち済みのため通常起きない）
    // 不足(needed-hand)が大きい資源を優先。同点は戦略重みでタイブレーク（決定的）。
    const pick = avail.reduce((best, r) => {
      const deficit = (needed[r] - handAfter[r]);
      const bd = (needed[best] - handAfter[best]);
      if (deficit !== bd) return deficit > bd ? r : best;
      return RESOURCE_WEIGHT[r] > RESOURCE_WEIGHT[best] ? r : best;
    }, avail[0]!);
    out[pick] = (out[pick] ?? 0) + 1;
    bankLeft[pick] -= 1;
    handAfter[pick] += 1;
  }
  return out;
}

function chooseGold(state: GameState, pid: PlayerId): Action | null {
  const owed = (state.pendingGoldChoice ?? {})[pid] ?? 0;
  if (owed <= 0) return null;
  return { type: 'CHOOSE_GOLD', playerId: pid, resources: chooseGoldResources(state, pid, owed) };
}

// 蛮族敗北での都市格下げ（対象 CPU）。最も価値の低い都市（隣接タイルのpip合計が最小）を選ぶ。
function chooseCityDowngrade(state: GameState, pid: PlayerId): Action | null {
  if (!(state.pendingCityDowngrade ?? []).includes(pid)) return null;
  const cities = plainCityVertexIds(state, pid);
  if (cities.length === 0) return null;
  const cityPips = (vid: string): number => {
    let s = 0;
    for (const [tid, vids] of Object.entries(state.tileToVertices)) {
      if (!vids.includes(vid)) continue;
      const n = state.tiles[tid]?.number;
      if (n != null) s += 6 - Math.abs(7 - n); // 6/8=5pip … 2/12=1pip
    }
    return s;
  };
  const vid = [...cities].sort((a, b) => cityPips(a) - cityPips(b))[0]!;
  return { type: 'DOWNGRADE_CITY', playerId: pid, vertexId: vid };
}

// 進歩カード上限超過（対象 CPU）。今は使えない/価値の低いカードを優先して1枚捨てる。
function chooseProgressDiscard(state: GameState, pid: PlayerId): Action | null {
  if (!(state.pendingProgressDiscard ?? []).includes(pid)) return null;
  const candidates = progressDiscardCandidates(state, pid);
  if (candidates.length === 0) return null;
  // いま使えない（canPlayProgress=false）カードを優先的に捨てる。なければ先頭。
  const unplayable = candidates.find(id => !canPlayProgress(state, pid, id));
  const cardId = unplayable ?? candidates[0]!;
  return { type: 'DISCARD_PROGRESS', playerId: pid, cardId };
}

// ============================================================
// 交易と蛮族「イベントカード」: イベント選択の解決（対象 CPU）
// ============================================================

/** 手札のうち一番多く持っている資源（渡す用。同数は RESOURCE_TYPES 順で決定的）。無ければ null。 */
function mostHeldResource(state: GameState, pid: PlayerId): ResourceType | null {
  const hand = state.players[pid]!.hand;
  let best: ResourceType | null = null;
  for (const r of RESOURCE_TYPES) {
    if (hand[r] > 0 && (best == null || hand[r] > hand[best])) best = r;
  }
  return best;
}

// 良き隣人: 左隣へ渡す資源 = 一番多く持っている資源（自分の計画への影響が最小になりやすい）。
function chooseEventGive(state: GameState, pid: PlayerId): Action | null {
  if (!(state.tbPendingEventGive ?? {})[pid]) return null;
  const give = mostHeldResource(state, pid);
  if (!give) return null; // 手札0はエンジン側で pending に入らない（保険）
  return { type: 'CHOOSE_EVENT_GIVE', playerId: pid, resource: give };
}

// 親切な隣人: 渡す相手 = 公開VP最少のプレイヤー（勝者に近い相手を利さない）・資源は最多所持。
function chooseEventHelpful(state: GameState, pid: PlayerId): Action | null {
  if (!(state.tbPendingEventHelpful ?? []).includes(pid)) return null;
  const myVp = calcPublicVP(state, pid);
  const targets = state.playerOrder.filter(p => p !== pid && calcPublicVP(state, p) < myVp);
  const give = mostHeldResource(state, pid);
  if (targets.length === 0 || !give) return null;
  const to = targets.reduce((best, p) => calcPublicVP(state, p) < calcPublicVP(state, best) ? p : best, targets[0]!);
  return { type: 'CHOOSE_EVENT_HELPFUL', playerId: pid, resource: give, toPlayerId: to };
}

// 衝突/交易優位: 奪う相手 = 札が最も多い相手（chooseStealTarget と同方針）。奪って損は無いので常に実行。
function chooseEventSteal(state: GameState, pid: PlayerId): Action | null {
  if (state.tbPendingEventSteal?.playerId !== pid) return null;
  const targets = tbEventStealTargets(state);
  if (targets.length === 0)
    return state.tbPendingEventSteal.optional ? { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: null } : null;
  const target = targets.reduce((b, p) => robbableCardCount(state, p) > robbableCardCount(state, b) ? p : b, targets[0]!);
  return { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: target };
}

// 地震: 損傷させる自分の道 = 隣接の空き頂点が最少の道（開拓地候補地を自分で塞ぎにくい）。
function chooseEventDamage(state: GameState, pid: PlayerId): Action | null {
  if (!(state.tbPendingEventDamage ?? []).includes(pid)) return null;
  const mine = Object.values(state.edges).filter(e => e.road?.playerId === pid && !e.road.damaged);
  if (mine.length === 0) return null;
  const freeVerts = (eid: string): number =>
    (state.edges[eid]?.vertexIds ?? []).filter(v => !state.vertices[v]?.building).length;
  const edgeId = mine.map(e => e.id).sort((a, b) => freeVerts(a) - freeVerts(b) || (a < b ? -1 : 1))[0]!;
  return { type: 'CHOOSE_EVENT_DAMAGE', playerId: pid, edgeId };
}

// ============================================================
// ROBBER フェーズ
// ============================================================

// タイルに建物を持つ相手プレイヤー（自分は除く・重複なし）。
function opponentsOnTile(state: GameState, tileId: string, pid: PlayerId): PlayerId[] {
  const vids = state.tileToVertices[tileId] ?? [];
  return [...new Set(
    vids.map(v => state.vertices[v]?.building?.playerId)
      .filter((p): p is PlayerId => p != null && p !== pid),
  )];
}

// 自分がそのタイルに建物を持つか（盗賊で自分の生産を止めないため）。
function selfOnTile(state: GameState, tileId: string, pid: PlayerId): boolean {
  return (state.tileToVertices[tileId] ?? []).some(v => state.vertices[v]?.building?.playerId === pid);
}

function tilePip(state: GameState, tileId: string): number {
  const n = state.tiles[tileId]?.number;
  return n ? (NUMBER_PROB[n] ?? 0) : 0;
}

// 盗賊配置スコア: 相手がいない/自分の生産/砂漠/現在地 は対象外(-Infinity)。
// それ以外は pip ×「最も勝っている相手の脅威度(VP)」。VP0でも pip で比較できるよう +1。
function robberHexScore(state: GameState, tileId: string, pid: PlayerId): number {
  const tile = state.tiles[tileId];
  if (!tile || tile.type === 'desert' || tile.hasRobber) return -Infinity;
  if (selfOnTile(state, tileId, pid)) return -Infinity;
  const opps = opponentsOnTile(state, tileId, pid);
  if (opps.length === 0) return -Infinity;
  const maxThreat = opps.reduce((m, o) => Math.max(m, calcVP(state, o)), 0);
  return tilePip(state, tileId) * (1 + maxThreat);
}

/**
 * 盗賊を置くヘックスを選ぶ純粋関数。
 * 「最も勝っている相手の生産を最も削る（pip × 相手VP）」ヘックスを選び、自分の生産は避ける。
 * 相手のいる有効ヘックスが無い場合は自分を避けた非砂漠、それも無ければ任意へフォールバック。
 */
export function chooseRobberHex(state: GameState, pid: PlayerId, rng: () => number = Math.random): string {
  const current = Object.values(state.tiles).find(t => t.hasRobber)?.id;
  // 合法な移動先のみ（陸のみ・現在地除外・S5の数字限定・T&B親切な盗賊の保護/砂漠フォールバックを一元化）。
  const legal = getRobberMoveTargets(state);
  // AI選好: 砂漠は誰の生産も止めないので避ける（親切な盗賊の砂漠フォールバック時は砂漠しか無いのでそのまま）。
  const nonDesert = legal.filter(tid => state.tiles[tid]?.type !== 'desert');
  const candidates = nonDesert.length > 0 ? nonDesert : legal;
  const scored = candidates.filter(tid => robberHexScore(state, tid, pid) > -Infinity);
  if (scored.length > 0) {
    return pickByScore(scored, tid => robberHexScore(state, tid, pid), rng);
  }
  // フォールバック: 自分の生産を避けたヘックス → 無ければ任意の候補 → 最後に fallbackTileId。
  const noSelf = candidates.filter(tid => !selfOnTile(state, tid, pid));
  const pool = noSelf.length > 0 ? noSelf : candidates;
  return pool.length > 0 ? pool[Math.floor(rng() * pool.length)]! : fallbackTileId(state, current);
}

/**
 * 盗賊を置いたヘックスに隣接する相手から略奪先を選ぶ純粋関数。
 * 手札が多い／勝利に近い(VP高)相手を優先。手札0の相手は除外（奪えないため）。該当なしは null。
 */
export function chooseStealTarget(
  state: GameState, tileId: string, pid: PlayerId, rng: () => number = Math.random,
): PlayerId | null {
  const opps = opponentsOnTile(state, tileId, pid)
    .filter(o => robbableCardCount(state, o) > 0)
    // 交易と蛮族「親切な盗賊」: 公開VP2以下の相手からは奪えない（砂漠フォールバック時に効く）。
    .filter(o => !state.friendlyRobber || !isFriendlyRobberProtected(state, o));
  if (opps.length === 0) return null;
  return pickByScore(opps, o => robbableCardCount(state, o) + calcVP(state, o) * 2, rng);
}

function chooseRobberAction(state: GameState, pid: PlayerId, rng: () => number): Action {
  const difficulty = getDifficulty(state, pid);

  if (difficulty === 'weak') {
    // 弱: 合法な移動先（親切な盗賊等の制限込み）から砂漠を避けてランダム。
    const current = Object.values(state.tiles).find(t => t.hasRobber)?.id;
    const legal = getRobberMoveTargets(state);
    const nonDesert = legal.filter(tid => state.tiles[tid]?.type !== 'desert');
    const candidates = nonDesert.length > 0 ? nonDesert : legal;
    const tileId = candidates.length > 0
      ? candidates[Math.floor(rng() * candidates.length)]!
      : fallbackTileId(state, current);
    // 強奪は必須ルール: 移動先に手札持ちの相手がいれば必ず1人選ぶ（いなければ null）。
    return { type: 'MOVE_ROBBER', tileId, stealFromPlayerId: chooseStealTarget(state, tileId, pid, rng) };
  }

  const tileId = chooseRobberHex(state, pid, rng);
  return { type: 'MOVE_ROBBER', tileId, stealFromPlayerId: chooseStealTarget(state, tileId, pid, rng) };
}

// ============================================================
// TRADE_BUILD フェーズ
// ============================================================

function chooseTradeBuildAction(state: GameState, pid: PlayerId, skipPlayerTrade = false, rng: () => number = Math.random): Action {
  // 交易と蛮族イベント「地震」: 損傷した道があれば最優先で修理（レンガ1木1）。
  // 修理しないと道を1本も建てられず、拡張が事実上止まる。
  if (state.tbEventCards) {
    const damaged = Object.values(state.edges).find(e => e.road?.playerId === pid && e.road.damaged);
    if (damaged && hasEnoughResources(state.players[pid]!.hand, TB_ROAD_REPAIR_COST)) {
      return { type: 'REPAIR_ROAD', edgeId: damaged.id };
    }
  }

  // 街道建設カード使用中: 無料道を拡張先評価(bestRoadEdge)で置く（置けなければ効果完了）。
  // 「盤面順で最初の合法辺」では自陣の内側など無価値な辺に置かれ、カードがほぼ無駄になる。
  if (state.roadBuildingRoadsRemaining > 0) {
    const roadEdge = bestRoadEdge(state, pid, rng);
    if (roadEdge) return { type: 'BUILD_ROAD', edgeId: roadEdge };
    return { type: 'FINISH_ROAD_BUILDING' };
  }

  // 騎士と商人: 拡張固有の手（都市改善・騎士）を最優先で検討。無ければ通常建設へ。
  if (isCk(state)) {
    const ckAction = chooseCkBuildAction(state, pid, rng);
    if (ckAction) return ckAction;
  }

  const difficulty = getDifficulty(state, pid);

  // 航海者 S8 七不思議: 建設可能なら不思議を最優先（クレーム→レベル建設で完成＝勝利へ直行）。
  // 要件未達のうちは bestWonderAction が null を返すため、通常の都市/開拓地建設で要件(2都市/6VP等)を満たす。
  if (state.wonderLevel !== undefined && difficulty !== 'weak') {
    const w = bestWonderAction(state, pid);
    if (w) return w;
  }

  // 航海者 S7 海賊の島々: 自色の要塞攻略を優先（隣接で攻撃→未到達なら船を延ばす）。奪取後は通常建設で10点へ。
  if (state.fortresses !== undefined && difficulty !== 'weak') {
    if (canAttackFortress(state, pid)) return { type: 'ATTACK_FORTRESS' };
    const ship = bestFortressShip(state, pid);
    if (ship) return { type: 'BUILD_SHIP', edgeId: ship };
  }

  if (difficulty === 'weak') return chooseTradeBuildWeak(state, pid, rng);
  if (difficulty === 'elite') return chooseTradeBuildElite(state, pid, skipPlayerTrade, rng);
  if (difficulty === 'strong') return chooseTradeBuildStrong(state, pid, skipPlayerTrade, rng);
  return chooseTradeBuildNormal(state, pid, skipPlayerTrade, rng);
}

// ---- 騎士と商人・'strong' 専用: 余剰資源で騎士を整備する（守護VP/都市防衛） ----
// 都市が無いうちは拡張優先で何もしない。麦/鉄に厚みがある時だけ起動・建設・昇格する
// （cities/settlements 等の VP 建設を全て検討した後に呼ばれるため、拡張資源を奪わない）。
function strongKnightDevelopment(state: GameState, pid: PlayerId): Action | null {
  const p = state.players[pid]!;
  const myCities = Object.values(state.vertices).filter(v => v.building?.playerId === pid && v.building.type === 'city').length;
  if (myCities === 0) return null;
  const knightCount = Object.values(state.vertices).filter(v => v.knight?.playerId === pid).length;
  // 1) 非起動騎士を起動（麦に厚みがある時。守備力を実効化して蛮族防衛に備える）。
  const inactive = Object.keys(state.vertices).find(vid => canActivateKnight(state, pid, vid));
  if (inactive && p.hand.grain >= 3) return { type: 'ACTIVATE_KNIGHT', vertexId: inactive };
  // 2) 騎士を増やす（都市数+1まで。木材・羊毛に余裕がある時）。
  if (knightCount <= myCities && p.hand.wood >= 1 && p.hand.wool >= 1) {
    const build = Object.keys(state.vertices).find(v => canBuildKnight(state, pid, v));
    if (build) return { type: 'BUILD_KNIGHT', vertexId: build };
  }
  // 3) 既存騎士を昇格（政治レベル到達＋鉄/麦に厚みがある時）。強い騎士で守護VPを独占する。
  const up = Object.keys(state.vertices).find(vid => canUpgradeKnight(state, pid, vid));
  if (up && p.hand.ore >= 2 && p.hand.grain >= 2) return { type: 'UPGRADE_KNIGHT', vertexId: up };
  return null;
}

// ---- 騎士と商人: 拡張固有の建設判断（都市改善＋騎士による防衛） ----
function chooseCkBuildAction(state: GameState, pid: PlayerId, rng: () => number): Action | null {
  const p = state.players[pid]!;
  const imp = p.improvements ?? { trade: 0, politics: 0, science: 0 };
  const tracks: CkTrack[] = ['trade', 'politics', 'science'];

  // 0) 使える進歩カードがあれば使う（canPlayProgress が効果の成立を保証）。
  const card = (p.progressCards ?? []).find(c => canPlayProgress(state, pid, c.id));
  if (card) return { type: 'PLAY_PROGRESS', cardId: card.id };

  // 1) 都市改善: 買えるなら買う（勝利点エンジン）。メトロポリス到達(Lv3→4・未保持)を最優先、
  //    次にレベルの低いツリー（安い）から進める。
  const buyable = tracks.filter(t => canBuildImprovement(state, pid, t));
  if (buyable.length > 0) {
    // メトロポリス絡みを最優先: 未保持を Lv3→4 で先取り、または他者保持を Lv4→5 で奪取。
    const metro = buyable.find(t => {
      const h = state.metropolis?.[t];
      return (imp[t] === 3 && !h) || (imp[t] === 4 && !!h && h.playerId !== pid);
    });
    // 通常: 安い低レベル側から均等に伸ばす。'strong': 高レベル側を一点集中で伸ばし
    //   メトロポリス(+2VP)へ一直線に到達する（13点ゲームで非常に効く）。
    const difficulty = getDifficulty(state, pid);
    const rushMetro = difficulty === 'strong' || difficulty === 'elite';
    const pick = metro ?? (rushMetro
      ? [...buyable].sort((a, b) => imp[b] - imp[a])[0]!
      : [...buyable].sort((a, b) => imp[a] - imp[b])[0]!);
    return { type: 'BUILD_IMPROVEMENT', track: pick };
  }

  const myCities = Object.values(state.vertices).filter(v => v.building?.playerId === pid && v.building.type === 'city').length;
  const myKnightStr = Object.values(state.vertices)
    .filter(v => v.knight?.playerId === pid && v.knight.active)
    .reduce((s, v) => s + v.knight!.strength, 0);
  const barb = state.barbarianPosition ?? 0;

  // 1.5) 騎士で強盗を追い払う: 強盗が自分の生産を止めていて、騎士1体を非アクティブ化しても
  //      防衛余力がある（or 蛮族が遠い）なら追い払う。続く ROBBER フェーズは chooseRobberAction が解決。
  const chasable = robberAdjacentChasableVertexIds(state, pid);
  if (chasable.length > 0) {
    const robberTid = Object.keys(state.tiles).find(t => state.tiles[t]!.hasRobber);
    const robberHurtsMe = robberTid != null
      && (state.tileToVertices[robberTid] ?? []).some(v => state.vertices[v]?.building?.playerId === pid);
    const chaserStr = state.vertices[chasable[0]!]?.knight?.strength ?? 1;
    const defenseSlack = myKnightStr - chaserStr >= myCities; // その騎士が抜けても都市数を守れる
    if (robberHurtsMe && (defenseSlack || barb <= 2)) {
      return { type: 'CHASE_ROBBER', vertexId: chasable[0]! };
    }
  }

  // 2) 防衛: 蛮族が近い or 都市数に対し騎士力が足りないなら騎士を用意。
  if (myCities > 0 && (barb >= 3 || myKnightStr < myCities)) {
    // 既存の非起動騎士を起動（麦1で防衛力UP）。
    const toActivate = Object.keys(state.vertices).find(vid => canActivateKnight(state, pid, vid));
    if (toActivate) return { type: 'ACTIVATE_KNIGHT', vertexId: toActivate };
    // 騎士を建てる（防衛力が都市数に満たないうちは増やす）。
    if (myKnightStr <= myCities) {
      const vid = Object.keys(state.vertices).find(v => canBuildKnight(state, pid, v));
      if (vid) return { type: 'BUILD_KNIGHT', vertexId: vid };
    }
    // 政治Lv3があり余裕があれば昇格。
    const up = Object.keys(state.vertices).find(vid => canUpgradeKnight(state, pid, vid));
    if (up && RESOURCE_TYPES.reduce((s, r) => s + p.hand[r], 0) >= 6) return { type: 'UPGRADE_KNIGHT', vertexId: up };
  }
  return null;
}

// ---- 弱: 可能なアクションからランダム ----

function chooseTradeBuildWeak(state: GameState, pid: PlayerId, rng: () => number): Action {
  const player = state.players[pid]!;
  const possible: Action[] = [];

  Object.keys(state.vertices)
    .filter(vid => canBuildCity(state, pid, vid))
    .forEach(vid => possible.push({ type: 'BUILD_CITY', vertexId: vid }));

  Object.keys(state.vertices)
    .filter(vid => canBuildSettlement(state, pid, vid))
    .forEach(vid => possible.push({ type: 'BUILD_SETTLEMENT', vertexId: vid }));

  if (state.devDeck.length > 0 && hasEnoughResources(player.hand, BUILD_COSTS.dev_card)) {
    possible.push({ type: 'BUY_DEV_CARD' });
  }

  if (player.remainingRoads > 0) {
    // 候補を1辺に絞る（全辺追加すると道が圧倒的多数になりVP建設確率が激減するため）
    const roadEdge = Object.keys(state.edges).find(eid => canBuildRoad(state, pid, eid));
    if (roadEdge) possible.push({ type: 'BUILD_ROAD', edgeId: roadEdge });
  }

  if (possible.length > 0) {
    return possible[Math.floor(rng() * possible.length)]!;
  }

  // 資源不足で建設不可の場合: バンク交易を試みる（ゲームの収束を保証）
  const bankTrade = tryBankTrade(state, pid);
  if (bankTrade) return bankTrade;

  return { type: 'END_TURN' };
}

// ---- 普通: 優先度に従って確実な選択 ----

// cost を支払うのに不足している資源を、余剰資源のバンク交易で1枚補う手を返す。
// 1手ずつなので、複数回呼ばれて徐々に必要資源を揃える（次ステップで建設）。
function bankTradeToward(state: GameState, pid: PlayerId, cost: ResourceHand): Action | null {
  const player = state.players[pid]!;
  const need = RESOURCE_TYPES.find(r => player.hand[r] < (cost[r] ?? 0));
  if (!need) return null; // 既に足りている
  const giveCandidates = [...RESOURCE_TYPES].sort((a, b) =>
    (player.hand[b] - (cost[b] ?? 0)) - (player.hand[a] - (cost[a] ?? 0)),
  );
  for (const give of giveCandidates) {
    if (give === need) continue;
    if (!canBankTrade(state, pid, give, need)) continue;
    const rate = getEffectiveTradeRate(state, pid, give);
    // cost に必要な give の枚数を割らない範囲でのみ放出する
    if (player.hand[give] - rate < (cost[give] ?? 0)) continue;
    return { type: 'BANK_TRADE', give, receive: need };
  }
  return null;
}

// 勝利まであと1点以上なら、勝利に直結する建設を最優先で実行する。
// 建設できなければ、不足資源をバンク交易で1手ずつ補い、次ステップでの建設→勝利を狙う。
// 資源を無視し、接続済み（自分の道/船）で距離ルールOKの空き陸頂点があるか。
// 「実際に置ける開拓地」がある時だけバンク交易で資源を狙う（置けない先への無限交易を防ぐ）。
function hasReachableSettlementSpot(state: GameState, pid: PlayerId): boolean {
  return Object.values(state.vertices).some(v => {
    if (v.building || !isLandVertex(v, state.tiles) || !isDistanceRuleOk(v, state.vertices)) return false;
    return v.adjacentEdgeIds.some(eid => {
      const e = state.edges[eid];
      return e?.road?.playerId === pid || e?.ship?.playerId === pid;
    });
  });
}

function victoryPush(state: GameState, pid: PlayerId, rng: () => number = Math.random): Action | null {
  if (calcVP(state, pid) < victoryTarget(state) - 1) return null;
  const player = state.players[pid]!;

  const city = bestCityVertex(state, pid, rng);
  if (city) return { type: 'BUILD_CITY', vertexId: city };
  const settl = bestSettlementVertex(state, pid, rng);
  if (settl) return { type: 'BUILD_SETTLEMENT', vertexId: settl };
  // 航海者: 本島で詰みなら新島へ船を継ぐ。島ボーナス(+2)＋新島の開拓地(+1)で勝ち切る経路。
  // これが無いと target-1(12/13) から抜けられず、群島で CPU 対戦が永久ループしうる（監査指摘）。
  const ship = bestExpansionShip(state, pid);
  if (ship) return { type: 'BUILD_SHIP', edgeId: ship };
  // バンク交易は「実際に置ける建設」に限る。置けない開拓地へ延々と交易して詰まないように。
  const hasUpgradable = Object.values(state.vertices).some(
    v => v.building?.type === 'settlement' && v.building.playerId === pid,
  );
  const targets: ResourceHand[] = [];
  if (hasUpgradable && player.remainingCities > 0) targets.push(BUILD_COSTS.city as ResourceHand);
  if (player.remainingSettlements > 0 && hasReachableSettlementSpot(state, pid)) targets.push(BUILD_COSTS.settlement as ResourceHand);
  for (const cost of targets) {
    const bt = bankTradeToward(state, pid, cost);
    if (bt) return bt;
  }
  return null; // 詰まったら通常方策（発展カード/道/船拡張/交易）へ委ねる
}

// ---- 進歩カード（豊作/独占/街道建設）の使用判断 ----
// 1ターン1枚制限・購入ターン制限を守る。建設で手詰まりのとき局面を進めるために使う。

function playableDev(state: GameState, pid: PlayerId, type: DevCardType): boolean {
  if (state.devCardPlayedThisTurn) return false;
  const p = state.players[pid];
  return !!p?.devCards.some(c => c.type === type && c.purchasedOnTurn < state.globalTurnNumber);
}

// pid が次に狙う建設目標のコスト一覧（都市→開拓地→発展カードの優先順）。
function goalCosts(state: GameState, pid: PlayerId): ResourceHand[] {
  const p = state.players[pid]!;
  const goals: ResourceHand[] = [];
  const hasUpgradable = Object.values(state.vertices).some(
    v => v.building?.type === 'settlement' && v.building.playerId === pid,
  );
  if (hasUpgradable && p.remainingCities > 0) goals.push(BUILD_COSTS.city as ResourceHand);
  if (p.remainingSettlements > 0) goals.push(BUILD_COSTS.settlement as ResourceHand);
  goals.push(BUILD_COSTS.dev_card as ResourceHand);
  return goals;
}

// 手持ちの進歩カードのうち局面を前進させられる一手を返す（無ければ null）。
// 相手の手札は覗かず、自分の建設目標に基づいて判断する（findCpuTradeOpportunity と同方針）。
function chooseProgressCardAction(state: GameState, pid: PlayerId): Action | null {
  if (state.devCardPlayedThisTurn) return null;
  const player = state.players[pid]!;

  // 街道建設: 道駒が残り、無料で置ける辺があるなら使う（無料2本・最長交易路狙い）。
  // 判定は「無料モードを模した state」で行う（通常の canBuildRoad は資源コストを要求し、
  // 手詰まり時に false になってしまうため）。
  if (playableDev(state, pid, 'road_building') && player.remainingRoads > 0) {
    const freeState: GameState = { ...state, roadBuildingRoadsRemaining: 1 };
    if (Object.keys(state.edges).some(eid => canBuildRoad(freeState, pid, eid))) {
      return { type: 'PLAY_ROAD_BUILDING' };
    }
  }

  // 豊作: あと2枚以内で目標(都市/開拓地/発展)に届くなら不足分を取得する。
  if (playableDev(state, pid, 'year_of_plenty')) {
    for (const cost of goalCosts(state, pid)) {
      const need: ResourceType[] = [];
      for (const r of RESOURCE_TYPES) {
        const miss = (cost[r] ?? 0) - player.hand[r];
        for (let i = 0; i < miss; i++) need.push(r);
      }
      if (need.length >= 1 && need.length <= 2) {
        const pick: [ResourceType, ResourceType] = need.length === 2 ? [need[0]!, need[1]!] : [need[0]!, need[0]!];
        return { type: 'PLAY_YEAR_OF_PLENTY', resources: pick };
      }
    }
  }

  // 独占: 目標に最も不足している資源を集める（相手手札は覗かない）。
  if (playableDev(state, pid, 'monopoly')) {
    for (const cost of goalCosts(state, pid)) {
      let bestR: ResourceType | null = null;
      let bestMiss = 0;
      for (const r of RESOURCE_TYPES) {
        const miss = (cost[r] ?? 0) - player.hand[r];
        if (miss > bestMiss) { bestMiss = miss; bestR = r; }
      }
      if (bestR) return { type: 'PLAY_MONOPOLY', resource: bestR };
    }
  }

  return null;
}

// ----------------------------------------------------------------
// 手番方策（明文化したヒューリスティック・探索/ミニマックスはしない）
//   1. このターンに勝てる（建設/カードで10点）なら勝ち手を実行（victoryPush）。
//   2. 最良の都市化（重み付き生産・特に ore/wheat を倍化）。
//   3. 道で繋がった最良の空き頂点へ開拓地（生産＋資源補完を評価）。
//   4. ore+wheat+sheep が揃うなら発展カード購入。
//   5. 最良の拡張先へ向けて道（行き止まりの道は避ける）。
//   6. 手詰まりなら進歩カードで局面を進める／人間へ交易提案／余剰をバンク交易で変換。
//   タイブレークのみ seed RNG。状態変更はエンジン経由（ルールはエンジンが権威）。
// ----------------------------------------------------------------
function chooseTradeBuildNormal(state: GameState, pid: PlayerId, skipPlayerTrade = false, rng: () => number = Math.random): Action {
  const player = state.players[pid]!;

  // 1. 勝利が近いなら勝利に直結する手を最優先
  const win = victoryPush(state, pid, rng);
  if (win) return win;

  // 2. 最良の都市化
  const city = bestCityVertex(state, pid, rng);
  if (city) return { type: 'BUILD_CITY', vertexId: city };

  // 3. 最良の開拓地（生産＋資源補完）
  const settl = bestSettlementVertex(state, pid, rng);
  if (settl) return { type: 'BUILD_SETTLEMENT', vertexId: settl };

  // 3.5 航海者: 海を渡って良い新島の開拓地候補へ向け船を継ぐ（基本ゲームでは null で no-op）。
  const ship = bestExpansionShip(state, pid);
  if (ship) return { type: 'BUILD_SHIP', edgeId: ship };

  // 4. 発展カード購入（ore+wheat+sheep が揃うとき）
  if (state.devDeck.length > 0 && hasEnoughResources(player.hand, BUILD_COSTS.dev_card)) {
    return { type: 'BUY_DEV_CARD' };
  }

  // 5. 最良の拡張先へ向けて道
  if (player.remainingRoads > 0) {
    const road = bestRoadEdge(state, pid, rng);
    if (road) return { type: 'BUILD_ROAD', edgeId: road };
  }

  // 6. 建設で手詰まりのとき、手持ちの進歩カードで局面を進める（豊作/独占/街道建設）。
  const progress = chooseProgressCardAction(state, pid);
  if (progress) return progress;

  // バンク交易より先に人間への交易提案を試みる（テンポ重視で控えめな頻度）
  if (!skipPlayerTrade && rng() < CPU_TRADE_OFFER_CHANCE.normal) {
    const opp = findCpuTradeOpportunity(state, pid);
    if (opp) {
      const giveHand: Partial<ResourceHand> = { [opp.give]: 1 };
      const receiveHand: Partial<ResourceHand> = { [opp.receive]: 1 };
      return { type: 'OFFER_TRADE', offer: { give: giveHand, receive: receiveHand }, targetPlayerIds: [opp.humanPid] };
    }
  }

  const bankTrade = tryBankTrade(state, pid);
  if (bankTrade) return bankTrade;

  return { type: 'END_TURN' };
}

// ---- 強: VP効率最大化 ----

function chooseTradeBuildStrong(state: GameState, pid: PlayerId, skipPlayerTrade = false, rng: () => number = Math.random): Action {
  const player = state.players[pid]!;

  // 0. 勝利が近いなら勝利に直結する手を最優先（建設 or バンク交易で資源補充）
  const win = victoryPush(state, pid, rng);
  if (win) return win;

  // 1. 都市（VP効率最高・重み付き生産で ore/wheat を倍化）
  const city = bestCityVertex(state, pid, rng);
  if (city) return { type: 'BUILD_CITY', vertexId: city };

  // 2. 開拓地（生産＋資源補完）
  const settl = bestSettlementVertex(state, pid, rng);
  if (settl) return { type: 'BUILD_SETTLEMENT', vertexId: settl };

  // 2.5 航海者: 海を渡って新島の良い開拓地候補へ向け船を継ぐ（基本ゲームでは no-op）。
  const ship = bestExpansionShip(state, pid);
  if (ship) return { type: 'BUILD_SHIP', edgeId: ship };

  // 3. 人間への交易提案（バンク交易より優先・テンポ重視で控えめ）
  if (!skipPlayerTrade && rng() < CPU_TRADE_OFFER_CHANCE.strong) {
    const opp = findCpuTradeOpportunity(state, pid);
    if (opp) {
      const giveHand: Partial<ResourceHand> = { [opp.give]: 1 };
      const receiveHand: Partial<ResourceHand> = { [opp.receive]: 1 };
      return { type: 'OFFER_TRADE', offer: { give: giveHand, receive: receiveHand }, targetPlayerIds: [opp.humanPid] };
    }
  }

  // 4. バンク交易で都市・開拓地が建設可能になる場合
  const bankTradeStrategic = tryBankTradeStrong(state, pid);
  if (bankTradeStrategic) return bankTradeStrategic;

  // 5. 道（最良の拡張先へ向けて）
  if (player.remainingRoads > 0) {
    const road = bestRoadEdge(state, pid, rng);
    if (road) return { type: 'BUILD_ROAD', edgeId: road };
  }

  // 6. 発展カード
  if (state.devDeck.length > 0 && hasEnoughResources(player.hand, BUILD_COSTS.dev_card)) {
    return { type: 'BUY_DEV_CARD' };
  }

  // 7. 手詰まりなら手持ちの進歩カードで局面を進める（豊作/独占/街道建設）。
  const progress = chooseProgressCardAction(state, pid);
  if (progress) return progress;

  // 7.5 騎士と商人・'strong' 専用: 余剰資源を守備力（騎士）へ変換する。
  //   都市/開拓地/船/道/発展/進歩カードを全て検討した「後」なので拡張を阻害しない。
  //   騎士は蛮族防衛を勝ち切って守護VPを稼ぎ、都市の格下げ（VP喪失）も防ぐ＝CKで強くなる。
  if (isCk(state)) {
    const knightDev = strongKnightDevelopment(state, pid);
    if (knightDev) return knightDev;
  }

  // 8. 余剰を貯め込まない: 余った資源をバンク交易で発展カード等に変換（建設可能化）
  const useSurplus = tryBankTrade(state, pid);
  if (useSurplus) return useSurplus;

  return { type: 'END_TURN' };
}

// ---- elite（最上位／UIの「強い」） ----
// strong を土台に、strong が明示的に狙わない「ボーナス点(+2VP)」を確実に取りに行く。
// 初期配置も生産重視（evaluateVertexForSetupElite, 基本ゲーム）。

// 最長交易路(+2VP)を「道1本」で奪取/獲得できるなら、その道を返す。無ければ null。
function eliteLongestRoadGrab(state: GameState, pid: PlayerId): Action | null {
  if (state.longestRoadHolder === pid) return null;           // 既に保持
  const p = state.players[pid]!;
  if (p.remainingRoads <= 0 || !hasEnoughResources(p.hand, BUILD_COSTS.road)) return null;
  // 1本で届かない（現在長+1が必要長未満）なら無駄打ちしない。
  const holderLen = state.longestRoadHolder ? state.players[state.longestRoadHolder]!.longestRoadLength : 0;
  const need = Math.max(LONGEST_ROAD_MIN, holderLen + 1);
  if (calcLongestRoad(state, pid) + 1 < need) return null;
  const DRNG = (): number => 0.5;
  for (const eid of Object.keys(state.edges)) {
    if (!canBuildRoad(state, pid, eid)) continue;
    let next: GameState;
    try { next = applyAction(state, { type: 'BUILD_ROAD', edgeId: eid }, DRNG); } catch { continue; }
    if (next.longestRoadHolder === pid) return { type: 'BUILD_ROAD', edgeId: eid }; // この1本でボーナス獲得
  }
  return null;
}

function chooseTradeBuildElite(state: GameState, pid: PlayerId, skipPlayerTrade = false, rng: () => number = Math.random): Action {
  const win = victoryPush(state, pid, rng);
  if (win) return win;
  // 最長交易路(+2VP)を1本で取れるなら最優先で取りに行く（strong は明示的に狙わない）。
  const grab = eliteLongestRoadGrab(state, pid);
  if (grab) return grab;
  return chooseTradeBuildStrong(state, pid, skipPlayerTrade, rng);
}

// elite の初期配置スコア（基本ゲーム用）: 生産(pip)を重く、都市エンジン(ore+grain)を厚く取る。
// 序盤の資源量を底上げして拡張テンポを上げる。CKでは商品地形の比重が変わるため適用しない。
function evaluateVertexForSetupElite(state: GameState, vertexId: string, ownFirstSettlement?: string): number {
  const base = evaluateVertexForSetup(state, vertexId, ownFirstSettlement);
  const prod = vertexProductionScore(state, vertexId);
  const res = new Set(adjacentResources(state, vertexId));
  let bonus = prod * 0.8;
  if (res.has('ore') && res.has('grain')) bonus += 1.5;
  return base + bonus;
}

// ============================================================
// バンク交易ロジック
// ============================================================

function tryBankTrade(state: GameState, pid: PlayerId): Action | null {
  const player = state.players[pid]!;
  const costs = [BUILD_COSTS.city, BUILD_COSTS.settlement, BUILD_COSTS.dev_card];

  for (const cost of costs) {
    if (hasEnoughResources(player.hand, cost)) continue;

    for (const give of RESOURCE_TYPES) {
      for (const receive of RESOURCE_TYPES) {
        if (give === receive) continue;
        if (!canBankTrade(state, pid, give, receive)) continue;

        const rate = getEffectiveTradeRate(state, pid, give);
        const simHand = { ...player.hand };
        simHand[give] -= rate;
        simHand[receive] += 1;

        if (hasEnoughResources(simHand, cost)) {
          return { type: 'BANK_TRADE', give, receive };
        }
      }
    }
  }

  return null;
}

// 強AI用: 余剰リソース優先・都市・開拓地のみを目標とした交易
function tryBankTradeStrong(state: GameState, pid: PlayerId): Action | null {
  const player = state.players[pid]!;
  const costs = [BUILD_COSTS.city, BUILD_COSTS.settlement];

  for (const cost of costs) {
    if (hasEnoughResources(player.hand, cost)) continue;

    const surplusFirst = [...RESOURCE_TYPES].sort((a, b) => {
      return (player.hand[b] - (cost[b] ?? 0)) - (player.hand[a] - (cost[a] ?? 0));
    });

    for (const give of surplusFirst) {
      for (const receive of RESOURCE_TYPES) {
        if (give === receive) continue;
        if (!canBankTrade(state, pid, give, receive)) continue;

        const rate = getEffectiveTradeRate(state, pid, give);
        const simHand = { ...player.hand };
        simHand[give] -= rate;
        simHand[receive] += 1;

        if (hasEnoughResources(simHand, cost)) {
          return { type: 'BANK_TRADE', give, receive };
        }
      }
    }
  }

  return null;
}
