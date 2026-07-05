// ============================================================
// src/engine/dice.ts — L-04: ダイスロール・資源配布エンジン
// ============================================================

import type { GameState, ResourceType } from '../types';
import { TILE_RESOURCE_MAP, RESOURCE_TYPES } from '../constants';

/**
 * 2つのダイスを振り [die1, die2] を返す。
 * rng を注入することでテストで再現可能。
 */
export function rollDice(rng: () => number = Math.random): [number, number] {
  return [
    Math.floor(rng() * 6) + 1,
    Math.floor(rng() * 6) + 1,
  ];
}

/**
 * ダイス合計値で「各プレイヤーが実際に得る資源（種類×枚数）」だけを計算して返す。
 * GameState は変更しない純粋関数。バンク枯渇ルールも適用済みの“実配布量”を返す。
 *
 * 計算に使うのはすべて公開情報（タイル種別/数字/強盗位置/盤面の建物/バンク在庫）のみ。
 * そのため LAN のマスク済み state（自分以外の手札は隠れている）でも、各端末で
 * 同じ「誰が何を得たか」を導出できる（手札の中身は一切参照しない）。
 *
 * 配布ルール:
 *   - diceTotal === 7 → 配布なし（空オブジェクト）。
 *   - 強盗コマがあるタイル・砂漠は配布しない。開拓地=1枚、都市=2枚。
 *   - バンク枯渇: 複数人需要が在庫超なら配布なし。単独なら在庫分だけ配布。
 */
export function computeDiceProduction(
  state: GameState,
  diceTotal: number,
): Record<string, Partial<Record<ResourceType, number>>> {
  const handUpdates: Record<string, Partial<Record<ResourceType, number>>> = {};
  if (diceTotal === 7) return handUpdates;

  // resource → playerId → 総需要量
  const demand: Record<ResourceType, Record<string, number>> = {
    wood: {}, brick: {}, wool: {}, grain: {}, ore: {},
  };

  for (const tile of Object.values(state.tiles)) {
    if (tile.number !== diceTotal) continue;
    if (tile.hasRobber) continue;

    const resource = TILE_RESOURCE_MAP[tile.type];
    if (resource == null) continue;

    const vertexIds = state.tileToVertices[tile.id] ?? [];
    for (const vid of vertexIds) {
      const vertex = state.vertices[vid];
      if (!vertex?.building) continue;
      const { playerId, type } = vertex.building;
      // 交易と蛮族「Catan for Two」: 中立プレイヤーの開拓地は資源を受け取らない（CN3089 p7）。
      // 需要にも算入しない——算入すると affectedPids/totalDemand が中立の「幻の需要」で膨らみ、
      // バンク枯渇判定（複数人不足で全没収／単独例外の消失）が誤発動して実プレイヤーの配布がズレる。
      if (state.players[playerId]?.type === 'neutral') continue;
      // 交易と蛮族イベント「疫病(EPIDEMIC)」: このターンの生産は都市も資源1枚のみ（CN3089 p5）。
      const amount = type === 'city' && !state.tbEpidemic ? 2 : 1;
      demand[resource][playerId] = (demand[resource][playerId] ?? 0) + amount;
    }
  }

  // バンク枯渇ルールを適用して“実配布量”を求める（在庫のコピー上で計算）。
  const bankLeft = { ...state.bank };
  for (const resource of RESOURCE_TYPES) {
    const resourceDemand = demand[resource];
    const affectedPids = Object.keys(resourceDemand);
    if (affectedPids.length === 0) continue;

    // Catan公式ルール: 複数プレイヤーへの配布合計がバンク在庫を超える場合、
    // その資源は誰にも配布しない（単一プレイヤーの場合は在庫分だけ配布）
    const totalDemand = affectedPids.reduce((s, pid) => s + (resourceDemand[pid] ?? 0), 0);
    if (affectedPids.length > 1 && totalDemand > bankLeft[resource]) {
      continue;
    }

    for (const pid of state.playerOrder) {
      const needed = resourceDemand[pid] ?? 0;
      if (needed === 0) continue;
      const actual = Math.min(needed, bankLeft[resource]);
      if (actual <= 0) continue;
      bankLeft[resource] -= actual;
      if (!handUpdates[pid]) handUpdates[pid] = {};
      handUpdates[pid]![resource] = (handUpdates[pid]![resource] ?? 0) + actual;
    }
  }

  return handUpdates;
}

/**
 * 航海者: 金タイル(gold)の出目一致による「任意資源を選ぶ枚数」をプレイヤー別に計算する純粋関数。
 * 開拓地=1・都市=2。強盗のあるタイルは産出しない。7 は対象外。
 *
 * 金は固定の対応資源を持たないため computeDiceProduction では配布されず、ここで「選択権の枚数」
 * だけを公開情報（タイル/数字/強盗/盤面の建物）から導出する（手札は一切参照しない＝LAN安全）。
 * 返り値は picks>0 のプレイヤーのみを含む（基本ゲームは金タイルが無く常に空）。
 */
export function computeGoldPicks(
  state: GameState,
  diceTotal: number,
): Record<string, number> {
  const picks: Record<string, number> = {};
  if (diceTotal === 7) return picks;

  for (const tile of Object.values(state.tiles)) {
    if (tile.type !== 'gold') continue;
    if (tile.number !== diceTotal) continue;
    if (tile.hasRobber) continue;

    for (const vid of state.tileToVertices[tile.id] ?? []) {
      const building = state.vertices[vid]?.building;
      if (!building) continue;
      const amount = building.type === 'city' ? 2 : 1;
      picks[building.playerId] = (picks[building.playerId] ?? 0) + amount;
    }
  }
  return picks;
}

/**
 * 「供給から任意資源を選ぶ枚数」(rawPicks) をバンク総在庫で頭打ちする（playerOrder 順に配分）。
 * 全体の選択枚数がバンクを超えて手詰まりになるのを防ぐ。GOLD フェーズ（金タイル産出）と
 * 交易と蛮族イベント（豊作の年/穏やかな海/馬上槍試合）で共用。
 */
export function capPicksByBank(
  state: GameState,
  rawPicks: Record<string, number>,
): Record<string, number> {
  let bankLeft = RESOURCE_TYPES.reduce((s, r) => s + state.bank[r], 0);
  const picks: Record<string, number> = {};
  for (const pid of state.playerOrder) {
    const capped = Math.min(rawPicks[pid] ?? 0, bankLeft);
    if (capped > 0) { picks[pid] = capped; bankLeft -= capped; }
  }
  return picks;
}

/**
 * ダイス合計値に基づいて資源を配布し、新しい GameState を返す。
 * 実配布量は computeDiceProduction に委譲し、ここではその分を手札とバンクへ反映する。
 */
export function distributeResources(state: GameState, diceTotal: number): GameState {
  if (diceTotal === 7) return state;

  const handUpdates = computeDiceProduction(state, diceTotal);
  if (Object.keys(handUpdates).length === 0) {
    return { ...state, bank: { ...state.bank } };
  }

  const newBank = { ...state.bank };
  const newPlayers = { ...state.players };
  for (const [pid, updates] of Object.entries(handUpdates)) {
    const player = newPlayers[pid]!;
    const newHand = { ...player.hand };
    for (const [r, amount] of Object.entries(updates) as [ResourceType, number][]) {
      newHand[r] += amount;
      newBank[r] -= amount;
    }
    newPlayers[pid] = { ...player, hand: newHand };
  }

  return { ...state, bank: newBank, players: newPlayers };
}
