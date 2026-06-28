// ============================================================
// src/engine/robber.ts — L-07: 強盗ロジック
// ============================================================

import type { GameState, PlayerId, TileId, ResourceType, CommodityType } from '../types';
import { RESOURCE_TYPES, COMMODITY_TYPES, ROBBER_HAND_DISCARD_MIN, CK_WALL_DISCARD_BONUS, makeCommodities } from '../constants';

// ============================================================
// 手札合計
// ============================================================

export function handTotal(state: GameState, playerId: PlayerId): number {
  const player = state.players[playerId];
  if (!player) return 0;
  return RESOURCE_TYPES.reduce((sum, r) => sum + player.hand[r], 0);
}

/** 7の捨て札判定に使う手札枚数。騎士と商人では資源＋商品の合計。 */
export function discardHandSize(state: GameState, playerId: PlayerId): number {
  const player = state.players[playerId];
  if (!player) return 0;
  let total = RESOURCE_TYPES.reduce((s, r) => s + player.hand[r], 0);
  if (state.expansion === 'cities_knights' && player.commodities) {
    total += COMMODITY_TYPES.reduce((s, c) => s + player.commodities![c], 0);
  }
  return total;
}

/** 7で捨てが始まる手札枚数。騎士と商人では城壁/メトロポリス1つにつき+2。 */
export function discardThreshold(state: GameState, playerId: PlayerId): number {
  if (state.expansion !== 'cities_knights') return ROBBER_HAND_DISCARD_MIN;
  // 公式: 手札上限+2 は「城壁」のみ（メトロポリスは別。城壁は最大3＝上限13）。
  const walls = Object.values(state.vertices).filter(v =>
    v.building?.playerId === playerId && v.building.wall).length;
  return ROBBER_HAND_DISCARD_MIN + CK_WALL_DISCARD_BONUS * walls;
}

// ============================================================
// 手札捨て（しきい値以上のプレイヤーが半数切り捨てを捨てる）
// ============================================================

/**
 * 強盗/海賊で奪取対象となる札枚数（騎士と商人では資源＋商品）。
 * マスク済みstate(相手視点)でも正しく数えるため handCount/commodityCount を優先する。
 */
export function robbableCardCount(state: GameState, playerId: PlayerId): number {
  const p = state.players[playerId];
  if (!p) return 0;
  const res = p.handCount ?? RESOURCE_TYPES.reduce((s, r) => s + p.hand[r], 0);
  if (state.expansion !== 'cities_knights') return res;
  const com = p.commodityCount ?? (p.commodities ? COMMODITY_TYPES.reduce((s, c) => s + p.commodities![c], 0) : 0);
  return res + com;
}

/** 捨てるべき枚数（しきい値以上なら手札枚数の半数切り捨て、未満は0）。 */
export function discardCount(state: GameState, playerId: PlayerId): number {
  const total = discardHandSize(state, playerId);
  if (total < discardThreshold(state, playerId)) return 0;
  return Math.floor(total / 2);
}

/**
 * 7 の捨て札フェーズで「まだ捨てておらず、捨て対象（しきい値以上）の」次のプレイヤーを返す。
 * 既に捨てたプレイヤー(discardedThisRound)は除外する。該当なしは undefined。
 */
export function findPendingDiscarder(state: GameState): PlayerId | undefined {
  return state.playerOrder.find(
    p => !(state.discardedThisRound ?? []).includes(p) && discardHandSize(state, p) >= discardThreshold(state, p),
  );
}

/**
 * 指定プレイヤーが資源（＋騎士と商人では商品）を捨てる。資源はバンクに返す。
 * 各枚数は捨てる差分（呼び出し側がバリデーション済み前提）。
 */
export function discardResources(
  state: GameState,
  playerId: PlayerId,
  resources: Partial<Record<ResourceType, number>>,
  commodities?: Partial<Record<CommodityType, number>>,
): GameState {
  const player = state.players[playerId]!;
  const newHand = { ...player.hand };
  const newBank = { ...state.bank };

  for (const r of RESOURCE_TYPES) {
    const amount = resources[r] ?? 0;
    newHand[r] -= amount;
    newBank[r] += amount;
  }

  let newCommodities = player.commodities;
  if (commodities && player.commodities) {
    newCommodities = { ...player.commodities };
    for (const c of COMMODITY_TYPES) newCommodities[c] -= commodities[c] ?? 0; // 商品は供給へ戻る（バンク管理なし）
  }

  return {
    ...state,
    bank: newBank,
    players: {
      ...state.players,
      [playerId]: { ...player, hand: newHand, ...(newCommodities ? { commodities: newCommodities } : {}) },
    },
  };
}

// ============================================================
// 強盗移動
// ============================================================

/**
 * 強盗コマを指定タイルへ移動する。
 * 元のタイルの hasRobber を false に、新タイルを true にする。
 */
export function moveRobber(state: GameState, tileId: TileId): GameState {
  const newTiles = { ...state.tiles };

  // 元の強盗タイルをクリア
  for (const [tid, tile] of Object.entries(newTiles)) {
    if (tile.hasRobber) {
      newTiles[tid] = { ...tile, hasRobber: false };
    }
  }

  // 新タイルに強盗を配置
  const target = newTiles[tileId];
  if (target) {
    newTiles[tileId] = { ...target, hasRobber: true };
  }

  return { ...state, tiles: newTiles };
}

// ============================================================
// 海賊（航海者・盗賊の海版）
// ============================================================

/** 海賊コマを指定の海タイルへ移動する（piratePosition を更新）。 */
export function movePirate(state: GameState, tileId: TileId): GameState {
  return { ...state, piratePosition: tileId };
}

/**
 * 海賊タイルに隣接する辺に「船」を持つ他プレイヤーの一覧（重複なし）。
 * 海賊は建物ではなく船から奪う。手札0枚も含む（呼び出し側で選択可否を判断）。
 */
export function getPirateRobbablePlayerIds(
  state: GameState,
  tileId: TileId,
  activePlayerId: PlayerId,
): PlayerId[] {
  const seen = new Set<PlayerId>();
  for (const eid of state.tileToEdges[tileId] ?? []) {
    const pid = state.edges[eid]?.ship?.playerId;
    if (pid && pid !== activePlayerId) seen.add(pid);
  }
  return [...seen];
}

// ============================================================
// 盗み
// ============================================================

/**
 * 強盗移動先タイルの隣接頂点に建物を持つ「他プレイヤー」の一覧を返す。
 * 重複なし。手札0枚のプレイヤーも含む（UI側で選択可否を判断）。
 */
export function getRobbablePlayerIds(
  state: GameState,
  tileId: TileId,
  activePlayerId: PlayerId,
): PlayerId[] {
  const vIds = state.tileToVertices[tileId] ?? [];
  const seen = new Set<PlayerId>();

  for (const vid of vIds) {
    const vertex = state.vertices[vid];
    const pid = vertex?.building?.playerId;
    if (pid && pid !== activePlayerId) {
      seen.add(pid);
    }
  }

  return [...seen];
}

/**
 * 指定プレイヤーからランダムに資源を1枚盗む。
 * 手札が0枚の場合は何もしない（盗みスキップ）。
 * rng は Fisher-Yates と同じ mulberry32 系を想定。
 */
export function stealResource(
  state: GameState,
  activePlayerId: PlayerId,
  targetPlayerId: PlayerId,
  rng: () => number = Math.random,
): GameState {
  const target = state.players[targetPlayerId];
  if (!target) return state;
  const ck = state.expansion === 'cities_knights';

  // 手持ちの全カードを配列に展開（騎士と商人では資源＋商品から1枚を無作為に奪う）。
  const pool: Array<{ kind: 'res'; key: ResourceType } | { kind: 'com'; key: CommodityType }> = [];
  for (const r of RESOURCE_TYPES) for (let i = 0; i < target.hand[r]; i++) pool.push({ kind: 'res', key: r });
  if (ck && target.commodities) {
    for (const c of COMMODITY_TYPES) for (let i = 0; i < target.commodities[c]; i++) pool.push({ kind: 'com', key: c });
  }
  if (pool.length === 0) return state;

  const stolen = pool[Math.floor(rng() * pool.length)]!;
  const active = state.players[activePlayerId]!;

  if (stolen.kind === 'res') {
    const r = stolen.key;
    return {
      ...state,
      players: {
        ...state.players,
        [targetPlayerId]: { ...target, hand: { ...target.hand, [r]: target.hand[r] - 1 } },
        [activePlayerId]: { ...active, hand: { ...active.hand, [r]: active.hand[r] + 1 } },
      },
    };
  }
  // 商品を1枚奪う。
  const c = stolen.key;
  const tCom = target.commodities ?? makeCommodities();
  const aCom = active.commodities ?? makeCommodities();
  return {
    ...state,
    players: {
      ...state.players,
      [targetPlayerId]: { ...target, commodities: { ...tCom, [c]: tCom[c] - 1 } },
      [activePlayerId]: { ...active, commodities: { ...aCom, [c]: aCom[c] + 1 } },
    },
  };
}

/**
 * 海賊の強奪対象として数える札枚数。S6「カタンの織物」（村のある盤）では
 * 公式どおり織物トークンも奪取対象に含む（移動時は資源か織物を強奪）。
 */
export function pirateRobbableCount(state: GameState, playerId: PlayerId): number {
  return robbableCardCount(state, playerId) + (state.villages ? ((state.cloth ?? {})[playerId] ?? 0) : 0);
}

/**
 * S6「カタンの織物」: 海賊の強奪で「資源1枚 or 織物1枚」を無作為に1枚奪う。
 * 対象の資源＋織物の合計プールから等確率で1枚を選ぶ（公式: 海賊移動時は資源か織物を強奪）。
 * 資源も織物も無ければ不変。S6 は CK ではないため商品は扱わない。
 */
export function stealResourceOrCloth(
  state: GameState,
  activePlayerId: PlayerId,
  targetPlayerId: PlayerId,
  rng: () => number = Math.random,
): GameState {
  const target = state.players[targetPlayerId];
  if (!target) return state;

  const pool: Array<{ kind: 'res'; key: ResourceType } | { kind: 'cloth' }> = [];
  for (const r of RESOURCE_TYPES) for (let i = 0; i < target.hand[r]; i++) pool.push({ kind: 'res', key: r });
  const clothCount = (state.cloth ?? {})[targetPlayerId] ?? 0;
  for (let i = 0; i < clothCount; i++) pool.push({ kind: 'cloth' });
  if (pool.length === 0) return state;

  const stolen = pool[Math.floor(rng() * pool.length)]!;
  const active = state.players[activePlayerId]!;
  if (stolen.kind === 'res') {
    const r = stolen.key;
    return {
      ...state,
      players: {
        ...state.players,
        [targetPlayerId]: { ...target, hand: { ...target.hand, [r]: target.hand[r] - 1 } },
        [activePlayerId]: { ...active, hand: { ...active.hand, [r]: active.hand[r] + 1 } },
      },
    };
  }
  // 織物を1枚奪う（2枚=1VP なので VP を動かしうる → 呼び出し側で勝利判定する）。
  const cloth = state.cloth ?? {};
  return {
    ...state,
    cloth: {
      ...cloth,
      [targetPlayerId]: (cloth[targetPlayerId] ?? 0) - 1,
      [activePlayerId]: (cloth[activePlayerId] ?? 0) + 1,
    },
  };
}
