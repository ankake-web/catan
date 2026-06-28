// ============================================================
// src/engine/createState.ts — 初期 GameState 生成（純粋関数）
// ============================================================
//
// main.ts の initGameState とサーバ（LAN対戦）の双方から使う、DOM 非依存の
// 純粋な初期状態生成。プレイヤーの実体（人間/CPU・名前・色）は呼び出し側が
// PlayerSpec で渡し、ここでは盤面生成・手番順決定・初期 state 組み立てだけを行う。

import type {
  GameState, Player, PlayerId, PlayerColor, PlayerType, AiDifficulty,
} from '../types';
import { buildBoardGeometry } from './board';
import { resolvePlayerOrder } from './setup';
import type { PlayerOrderMode } from './setup';
import { getScenario } from './scenarios';
import type { ScenarioId } from './scenarios';
import { buildDevDeck } from './game';
import { makeHand, makeCommodities, BANK_INITIAL, COMMODITY_BANK_INITIAL } from '../constants';
import { buildProgressDecks } from './citiesKnights';

export interface PlayerSpec {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: PlayerColor;
  readonly type: PlayerType;
  readonly aiDifficulty?: AiDifficulty;
}

/**
 * 初期 GameState を生成する純粋関数。
 *
 * @param specs     参加プレイヤー（実体）。ID 固定・手番順とは独立。
 * @param orderMode 手番順の決め方（'random' は毎回シャッフル / 'fixed' は orderSpec 採用）。
 * @param orderSpec orderMode==='fixed' のときの手番順。参加者と不整合なら元順にフォールバック。
 * @param rng       乱数生成器。省略時 Math.random（テスト/サーバで注入可能）。
 * @param scenarioId 盤面シナリオ。既定 'classic'（基本カタン・従来と同一）。
 */
export function createInitialGameState(
  specs: readonly PlayerSpec[],
  orderMode: PlayerOrderMode,
  orderSpec: PlayerId[] | undefined,
  rng: () => number = Math.random,
  scenarioId: ScenarioId = 'classic',
): GameState {
  // シナリオ駆動の盤面生成。既定 'classic' は従来と同一（非破壊）。
  const scenario = getScenario(scenarioId);
  const geo = buildBoardGeometry(scenario.coords());
  const { tiles, harbors, edgeTokens, villages } = scenario.build(geo, rng);

  const ck = scenario.expansion === 'cities_knights';
  const players: GameState['players'] = {};
  const allIds: PlayerId[] = [];

  for (const spec of specs) {
    const base: Player = {
      id: spec.id,
      color: spec.color,
      name: spec.name,
      type: spec.type,
      hand: makeHand(),
      devCards: [],
      remainingRoads: 15,
      remainingShips: 15,
      remainingSettlements: 5,
      remainingCities: 4,
      knightsPlayed: 0,
      longestRoadLength: 0,
      hasLongestRoad: false,
      hasLargestArmy: false,
      // 騎士と商人: 商品手札・都市改善レベル・守護者VP・進歩カード（拡張時のみ）。
      ...(ck ? { commodities: makeCommodities(), improvements: { trade: 0, politics: 0, science: 0 }, defenderVP: 0, progressCards: [] } : {}),
    };
    // exactOptionalPropertyTypes 対策: aiDifficulty は値があるときだけ付与。
    players[spec.id] = spec.aiDifficulty != null
      ? { ...base, aiDifficulty: spec.aiDifficulty }
      : base;
    allIds.push(spec.id);
  }

  const playerOrder = resolvePlayerOrder(allIds, orderMode, orderSpec, rng);

  return {
    tiles,
    vertices: geo.vertices,
    edges:    geo.edges,
    harbors,
    tileToVertices: geo.tileToVertices,
    tileToEdges:    geo.tileToEdges,
    players,
    playerOrder,
    bank: { ...BANK_INITIAL },
    // 騎士と商人は発展カードを使わない（進歩カードに置換。本実装では未導入のため空デッキ）。
    devDeck:        ck ? [] : buildDevDeck(rng),
    devDiscardPile: [],
    phase: 'SETUP_FORWARD',
    turnPhase: 'PRE_ROLL',
    currentPlayerIndex: 0,
    globalTurnNumber: 0,
    setupSubPhase: 'PLACE_SETTLEMENT',
    lastDiceRoll: null,
    diceRolledThisTurn: false,
    roadBuildingRoadsRemaining: 0,
    devCardPlayedThisTurn: false,
    shipsBuiltThisTurn: [],
    longestRoadHolder: null,
    largestArmyHolder: null,
    ...(scenario.victoryTarget != null ? { victoryTarget: scenario.victoryTarget } : {}),
    // 航海者: シナリオ固有ルールを配線（未指定フィールドは GameState 既定にフォールバック）。
    ...(scenario.rules?.newIslandBonusVp != null ? { newIslandBonusVp: scenario.rules.newIslandBonusVp } : {}),
    ...(scenario.rules?.startingSettlements != null ? { startingSettlements: scenario.rules.startingSettlements } : {}),
    ...(scenario.rules?.useLongestRoute != null ? { useLongestRoute: scenario.rules.useLongestRoute } : {}),
    ...(scenario.rules?.useRobber != null ? { useRobber: scenario.rules.useRobber } : {}),
    ...(scenario.rules?.setupAnywhere != null ? { setupAnywhere: scenario.rules.setupAnywhere } : {}),
    ...(scenario.rules?.numberHexOnly != null ? { numberHexOnly: scenario.rules.numberHexOnly } : {}),
    ...(scenario.rules?.noIslandSettlement != null ? { noIslandSettlement: scenario.rules.noIslandSettlement } : {}),
    ...(edgeTokens != null ? { edgeTokens } : {}),
    ...(villages != null ? { villages, villageConn: {}, cloth: {} } : {}),
    ...(ck ? { expansion: 'cities_knights' as const, commodityBank: { ...COMMODITY_BANK_INITIAL }, barbarianPosition: 0, barbarianAttacks: 0, metropolis: {}, progressDecks: buildProgressDecks(rng), knightMovedThisTurn: false, knightChasedThisTurn: false } : {}),
    islandBonus: {},
    pendingTrade: null,
    winner: null,
    discardedThisRound: [],
    log: [],
  };
}
