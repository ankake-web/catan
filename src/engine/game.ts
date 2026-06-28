// ============================================================
// src/engine/game.ts — L-09: applyAction 統合エンジン
// ============================================================

import type {
  GameState, Action, PlayerId, ResourceType, DevCard, VertexId, ResourceHand,
} from '../types';
import { RESOURCE_TYPES, COMMODITY_TYPES, BUILD_COSTS, DEV_CARD_COUNTS, TILE_RESOURCE_MAP, VP_TABLE } from '../constants';
import type { CommodityType } from '../types';
import { rollDice, distributeResources, computeGoldPicks } from './dice';
import {
  canBuildRoad, buildRoad,
  canBuildShip, buildShip,
  canMoveShip, moveShip,
  canBuildSettlement, buildSettlement,
  canBuildCity, buildCity,
  hasEnoughResources,
} from './actions';
import { moveRobber, movePirate, discardResources, stealResource, getRobbablePlayerIds, getPirateRobbablePlayerIds, discardCount, robbableCardCount, findPendingDiscarder } from './robber';
import {
  isCk, applyEventDie, distributeCkProduction,
  canBuildKnight, buildKnight, canActivateKnight, activateKnight, canUpgradeKnight, upgradeKnight,
  canBuildImprovement, buildImprovement, canBuildCityWall, buildCityWall,
  canPlayProgress, canPlayProgressLoose, playProgress, canMoveKnight, moveKnight, canChaseRobber, chaseRobber, ckSetupSecondCity,
  downgradeCity, discardProgressCard,
} from './citiesKnights';
import { executeBankTrade, canBankTrade, offerTrade, respondTrade, confirmTrade, cancelTrade } from './trade';
import { updateLongestRoad, updateLargestArmy, checkVictory, calcVP, victoryTarget } from './scoring';
import { newIslandBonusRep, islandRepOf } from './islands';
import { edgeTileIds } from './board';
import { revealFogAround } from './explore';

// ============================================================
// 内部ユーティリティ
// ============================================================

function currentPlayer(state: GameState): PlayerId {
  return state.playerOrder[state.currentPlayerIndex]!;
}

// 安全網のターン上限（個人手番のグローバル通し番号）。通常対戦は〜300で終わるため発火しない。
// 病的な引き分け局面で永久ループしないための最終防御（END_TURN で最高VPを勝者に）。
const TURN_CAP = 1000;

/**
 * 初期配置2軒目で配る資源を、配置頂点に隣接するタイルから導出する純粋関数。
 * 付与（applyAction の BUILD_SETTLEMENT）と資源アニメ（renderer 側）の双方が
 * これを共有し、ロジックのドリフト（アニメだけズレる）を防ぐ。
 *
 * - 隣接タイルは tileToVertices の列挙順で走査（付与と同じ順序＝アニメ順も一致）。
 * - 砂漠（resource なし）は除外。
 * - bank 在庫が0の資源は除外。同一資源の隣接が複数あれば在庫が尽きた分から除外。
 * 返り値は獲得した資源の順序付き配列（同じ資源が複数回入りうる）。
 *
 * 注意: bank 在庫の判定は「付与“時点”の bank」でのみ正しい。初期配置ではバンク枯渇は
 *       起きない前提なので、アニメ側が付与“後”の bank（=現在値）を渡しても実害はない。
 *       バンクが絡む他フェーズには流用しないこと（在庫差で結果がズレる）。
 */
export function setupGainFor(state: GameState, vertexId: VertexId, bank: ResourceHand): ResourceType[] {
  const gains: ResourceType[] = [];
  const remaining = { ...bank };
  const tileIds = Object.entries(state.tileToVertices)
    .filter(([, vids]) => vids.includes(vertexId))
    .map(([tid]) => tid);
  for (const tid of tileIds) {
    const tile = state.tiles[tid];
    if (!tile || tile.type === 'desert') continue;
    const r = TILE_RESOURCE_MAP[tile.type];
    if (!r || remaining[r] < 1) continue;
    remaining[r] -= 1;
    gains.push(r);
  }
  return gains;
}

/** 発展カードデッキをシャッフル生成（ゲーム開始時用） */
export function buildDevDeck(rng: () => number = Math.random): DevCard[] {
  const deck: DevCard[] = [];
  let id = 0;
  for (const [type, count] of Object.entries(DEV_CARD_COUNTS) as [DevCard['type'], number][]) {
    for (let i = 0; i < count; i++) {
      deck.push({ id: `dev_${id++}`, type, purchasedOnTurn: -1 });
    }
  }
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

// ============================================================
// applyAction — メインエントリポイント
// ============================================================

/**
 * 騎士と商人: 蛮族解決(applyEventDie)後の「生産 or 7の捨て札/盗賊」への遷移。
 * ROLL_DICE 本体と、都市格下げ(CITY_DOWNGRADE)解決後の再開の両方から呼ぶ（重複排除＋一貫性）。
 */
function resolveCkRollOutcome(next: GameState, total: number): GameState {
  if (total === 7) {
    const needsDiscard = next.playerOrder.some(p => discardCount(next, p) > 0); // 資源＋商品で判定
    // 初回の蛮族襲来までは盗賊が凍結＝7は手札破棄のみ（盗賊移動・盗みなし）。
    const robberActive = (next.barbarianAttacks ?? 0) >= 1;
    const afterDiscard = robberActive ? 'ROBBER' : 'TRADE_BUILD';
    return { ...next, discardedThisRound: [], turnPhase: needsDiscard ? 'DISCARD' : afterDiscard };
  }
  return distributeCkProduction({ ...next, turnPhase: 'TRADE_BUILD' }, total);
}

/**
 * 騎士と商人: イベントダイス解決(applyEventDie / 蛮族)後の保留フェーズ判定。
 * 都市格下げ(CITY_DOWNGRADE) → 進歩カード捨て(PROGRESS_DISCARD) の順に解決し、
 * どちらも無ければ本来の生産/捨て札へ（resolveCkRollOutcome）。
 */
function ckPostEventTransition(next: GameState, total: number): GameState {
  if ((next.pendingCityDowngrade?.length ?? 0) > 0) return { ...next, turnPhase: 'CITY_DOWNGRADE' };
  if ((next.pendingProgressDiscard?.length ?? 0) > 0) return { ...next, turnPhase: 'PROGRESS_DISCARD' };
  return resolveCkRollOutcome(next, total);
}

/**
 * アクションを GameState に適用して新しい GameState を返す純粋関数。
 * バリデーション失敗時は例外を投げる（呼び出し側で can* チェック済み前提）。
 *
 * @param rng テスト用に注入可能な乱数生成器
 */
export function applyAction(
  state: GameState,
  action: Action,
  rng: () => number = Math.random,
): GameState {
  if (state.phase === 'GAME_OVER') throw new Error(`applyAction: game is already over (action=${action.type})`);

  const pid = currentPlayer(state);

  switch (action.type) {

    // ----------------------------------------------------------
    // ROLL_DICE
    // ----------------------------------------------------------
    case 'ROLL_DICE': {
      if (state.phase !== 'MAIN') throw new Error('ROLL_DICE: not MAIN phase');
      if (state.turnPhase !== 'PRE_ROLL') throw new Error('ROLL_DICE: not PRE_ROLL');

      // 騎士と商人: 錬金術師(alchemist)で目を事前指定済みなら、それを使い消費する。
      const forced = isCk(state) ? (state.alchemistForcedDice ?? null) : null;
      const [d1, d2] = forced ?? rollDice(rng);
      const total = d1 + d2;

      let next: GameState = { ...state, lastDiceRoll: [d1, d2], diceRolledThisTurn: true, ...(forced ? { alchemistForcedDice: null } : {}) };

      // ---- 騎士と商人: 毎ターン イベントダイス(蛮族)も振り、産出は資源＋商品。----
      if (isCk(state)) {
        next = applyEventDie(next, rng, d1); // 7でも蛮族は前進。色面は赤ダイス(d1)で進歩カード抽選
        // 蛮族敗北で都市格下げの選択が要る場合は、まず格下げ（CITY_DOWNGRADE）を解決してから
        // 生産/捨て札へ（イベントダイスは生産ダイスより先に解決する公式順序とも一致）。
        // 蛮族撃退の守護者VPで勝利点目標に到達した場合は、その手番でそのまま勝利確定させる。
        return checkVictory(ckPostEventTransition(next, total), pid);
      }

      if (total === 7) {
        const needsDiscard = state.playerOrder.some(p => {
          const h = state.players[p]!.hand;
          return RESOURCE_TYPES.reduce((s, r) => s + h[r], 0) >= 8;
        });
        next = { ...next, discardedThisRound: [], turnPhase: needsDiscard ? 'DISCARD' : 'ROBBER' };
      } else {
        next = distributeResources({ ...next, turnPhase: 'TRADE_BUILD' }, total);
        // 航海者: 金タイル産出があれば、任意資源の選択待ち(GOLD)へ。無ければ通常どおり TRADE_BUILD。
        // 複数人が同時に owed になりうるため、選択枚数は「逐次的に減るバンク総在庫」で頭打ちにする。
        // 全体総和が在庫を超えないよう playerOrder 順に bankLeft から差し引くことで、どの順に
        // CHOOSE_GOLD を解決しても最後の人まで必ず owed 枚を取れる（在庫切れの手詰まり=ソフトロック回避）。
        const rawPicks = computeGoldPicks(next, total);
        let bankLeft = RESOURCE_TYPES.reduce((s, r) => s + next.bank[r], 0);
        const goldPicks: Record<string, number> = {};
        for (const pid of next.playerOrder) {
          const capped = Math.min(rawPicks[pid] ?? 0, bankLeft);
          if (capped > 0) { goldPicks[pid] = capped; bankLeft -= capped; }
        }
        next = Object.keys(goldPicks).length > 0
          ? { ...next, turnPhase: 'GOLD', pendingGoldChoice: goldPicks }
          : { ...next, turnPhase: 'TRADE_BUILD' };
      }

      return next;
    }

    // ----------------------------------------------------------
    // CHOOSE_GOLD（航海者・金タイル産出の任意資源選択）
    // ----------------------------------------------------------
    case 'CHOOSE_GOLD': {
      if (state.turnPhase !== 'GOLD') throw new Error('CHOOSE_GOLD: not in GOLD phase');
      const { playerId, resources } = action;
      const chooser = state.players[playerId];
      if (!chooser) throw new Error('CHOOSE_GOLD: unknown player');
      const owed = (state.pendingGoldChoice ?? {})[playerId] ?? 0;
      if (owed <= 0) throw new Error('CHOOSE_GOLD: no gold pick owed for this player');

      // 「ちょうど owed 枚・各資源はバンク在庫の範囲内」をエンジンが一元検証する。
      const res = resources as Partial<Record<ResourceType, number>>;
      const sum = RESOURCE_TYPES.reduce((s, r) => s + (res[r] ?? 0), 0);
      const withinBank = RESOURCE_TYPES.every(r => (res[r] ?? 0) >= 0 && (res[r] ?? 0) <= state.bank[r]);
      if (sum !== owed || !withinBank)
        throw new Error('CHOOSE_GOLD: must choose exactly the owed number of resources from the bank');

      const newHand = { ...chooser.hand };
      const newBank = { ...state.bank };
      for (const r of RESOURCE_TYPES) {
        const a = res[r] ?? 0;
        newHand[r] += a;
        newBank[r] -= a;
      }
      const nextPending = { ...(state.pendingGoldChoice ?? {}) };
      delete nextPending[playerId];

      let next: GameState = {
        ...state,
        bank: newBank,
        players: { ...state.players, [playerId]: { ...chooser, hand: newHand } },
        pendingGoldChoice: nextPending,
      };
      // 全員の選択が済んだら、手番プレイヤーの交易・建設フェーズへ進む。
      if (Object.keys(nextPending).length === 0) {
        next = { ...next, turnPhase: 'TRADE_BUILD', pendingGoldChoice: {} };
      }
      return next;
    }

    // ----------------------------------------------------------
    // DISCARD_RESOURCES
    // ----------------------------------------------------------
    case 'DISCARD_RESOURCES': {
      if (state.turnPhase !== 'DISCARD') throw new Error('DISCARD_RESOURCES: not in DISCARD phase');
      const { playerId, resources } = action;
      const commodities = action.commodities;
      const discarder = state.players[playerId];
      if (!discarder) throw new Error('DISCARD_RESOURCES: unknown player');
      // 二重捨て防止: 既に今回の7で捨てたプレイヤーは再度捨てさせない。
      if ((state.discardedThisRound ?? []).includes(playerId))
        throw new Error('DISCARD_RESOURCES: already discarded this round');
      // 捨て札は「ちょうど discardCount 枚・所持範囲内」をエンジンが一元検証（騎士と商人は資源＋商品）。
      const required = discardCount(state, playerId);
      const res = resources as Partial<Record<ResourceType, number>>;
      const com = (commodities ?? {}) as Partial<Record<CommodityType, number>>;
      const resSum = RESOURCE_TYPES.reduce((s, r) => s + (res[r] ?? 0), 0);
      const comSum = COMMODITY_TYPES.reduce((s, c) => s + (com[c] ?? 0), 0);
      const withinHand = RESOURCE_TYPES.every(r => (res[r] ?? 0) >= 0 && (res[r] ?? 0) <= discarder.hand[r])
        && COMMODITY_TYPES.every(c => (com[c] ?? 0) >= 0 && (com[c] ?? 0) <= (discarder.commodities?.[c] ?? 0));
      if (required === 0 || resSum + comSum !== required || !withinHand)
        throw new Error('DISCARD_RESOURCES: must discard exactly floor(hand/2) cards you own');

      let next = discardResources(state, playerId, res, com);

      // 今回の7でそのプレイヤーが捨てたことを記録
      const discardedThisRound = [...(next.discardedThisRound ?? []), playerId];
      next = { ...next, discardedThisRound };

      // まだ捨てが必要なプレイヤーがいるか（資源＋商品で判定・既に捨てた人は除外）。
      // 騎士と商人で初回襲来前は盗賊が凍結＝捨て後は ROBBER ではなく TRADE_BUILD へ。
      if (!findPendingDiscarder(next)) {
        const robberFrozen = isCk(next) && (next.barbarianAttacks ?? 0) < 1;
        next = { ...next, turnPhase: robberFrozen ? 'TRADE_BUILD' : 'ROBBER', discardedThisRound: [] };
      }

      return next;
    }

    // ----------------------------------------------------------
    // DOWNGRADE_CITY（騎士と商人: 蛮族敗北で格下げする都市を選ぶ。DISCARDと同様の多人数解決）
    // ----------------------------------------------------------
    case 'DOWNGRADE_CITY': {
      if (state.turnPhase !== 'CITY_DOWNGRADE') throw new Error('DOWNGRADE_CITY: not in CITY_DOWNGRADE phase');
      const { playerId, vertexId } = action;
      const pending = state.pendingCityDowngrade ?? [];
      if (!pending.includes(playerId)) throw new Error('DOWNGRADE_CITY: not a pending player');
      const after = downgradeCity(state, playerId, vertexId);
      if (after === state) throw new Error('DOWNGRADE_CITY: must downgrade your own plain city'); // 違法な頂点
      const newPending = pending.filter(p => p !== playerId);
      if (newPending.length > 0) return { ...after, pendingCityDowngrade: newPending }; // 他の対象者を待つ
      // 全員解決 → 保留していた本来の続き（生産 or 7の捨て札/盗賊）を再開する。pending は除去。
      const total = (state.lastDiceRoll?.[0] ?? 0) + (state.lastDiceRoll?.[1] ?? 0);
      const { pendingCityDowngrade: _done, ...cleared } = after;
      return ckPostEventTransition(cleared, total);
    }

    // ----------------------------------------------------------
    // DISCARD_PROGRESS（騎士と商人: 進歩カード上限超過＝5枚目を引いた時に1枚捨てる。多人数解決）
    // ----------------------------------------------------------
    case 'DISCARD_PROGRESS': {
      if (state.turnPhase !== 'PROGRESS_DISCARD') throw new Error('DISCARD_PROGRESS: not in PROGRESS_DISCARD phase');
      const { playerId, cardId } = action;
      const pending = state.pendingProgressDiscard ?? [];
      if (!pending.includes(playerId)) throw new Error('DISCARD_PROGRESS: not a pending player');
      const after = discardProgressCard(state, playerId, cardId);
      if (after === state) throw new Error('DISCARD_PROGRESS: must discard your own non-VP progress card');
      const newPending = pending.filter(p => p !== playerId);
      if (newPending.length > 0) return { ...after, pendingProgressDiscard: newPending }; // 他の対象者を待つ
      const total = (state.lastDiceRoll?.[0] ?? 0) + (state.lastDiceRoll?.[1] ?? 0);
      const { pendingProgressDiscard: _pdone, ...cleared } = after;
      return resolveCkRollOutcome(cleared, total);
    }

    // ----------------------------------------------------------
    // MOVE_ROBBER
    // ----------------------------------------------------------
    case 'MOVE_ROBBER': {
      // 強盗を動かせるのは ROBBER フェーズ（7 を出した後／騎士カード使用後）のみ。
      // これが無いと PRE_ROLL 中に無料で（しかも繰り返し）盗賊移動＋強奪ができてしまう。
      if (state.turnPhase !== 'ROBBER') throw new Error('MOVE_ROBBER: not in ROBBER phase');
      const { tileId, stealFromPlayerId } = action;

      // 強盗は陸タイルのみ（海は海賊の領分）。これが無いと盗賊が海上で空振りになる。
      if (state.tiles[tileId]?.type === 'sea') throw new Error('MOVE_ROBBER: robber cannot move onto a sea tile (use the pirate)');
      // 強盗は必ず現在地とは別ヘクスへ移動する（標準ルール）。
      const currentRobberTileId = Object.keys(state.tiles).find(tid => state.tiles[tid]!.hasRobber);
      if (currentRobberTileId === tileId) throw new Error('MOVE_ROBBER: must move to a different tile');

      let next = moveRobber(state, tileId);

      // 強奪は必須: 移動先タイルに隣接し手札を持つ相手がいるなら、必ずその中の1人から盗む
      // （『盗まない』選択は不可。標準ルール）。隣接相手が全員0枚 or 不在なら盗まずに済む。
      const robbable = getRobbablePlayerIds(next, tileId, pid).filter(p => robbableCardCount(next, p) > 0);
      if (stealFromPlayerId != null) {
        // 盗む相手は「移動先タイルに隣接する建物を持つ相手」に限る（盤面と無関係な強奪を防ぐ）。
        if (!getRobbablePlayerIds(next, tileId, pid).includes(stealFromPlayerId))
          throw new Error('MOVE_ROBBER: steal target is not adjacent to the robber tile');
        // 手札持ちの相手がいるなら、手札0枚の相手を指定して強奪を踏み倒すことはできない。
        if (robbable.length > 0 && !robbable.includes(stealFromPlayerId))
          throw new Error('MOVE_ROBBER: must steal from an adjacent opponent who holds cards');
        next = stealResource(next, pid, stealFromPlayerId, rng);
      } else if (robbable.length > 0) {
        throw new Error('MOVE_ROBBER: must steal from an adjacent opponent who holds cards');
      }

      // 騎士カードをダイス前に使った場合はPRE_ROLLへ戻る（ダイスをまだ振っていない）
      const nextPhase = state.diceRolledThisTurn ? 'TRADE_BUILD' : 'PRE_ROLL';
      return { ...next, turnPhase: nextPhase };
    }

    // ----------------------------------------------------------
    // MOVE_PIRATE（航海者・海賊＝盗賊の海版）。7/騎士で盗賊の代わりに動かせる。
    // ----------------------------------------------------------
    case 'MOVE_PIRATE': {
      if (state.turnPhase !== 'ROBBER') throw new Error('MOVE_PIRATE: not in ROBBER phase');
      const { tileId, stealFromPlayerId } = action;
      const tile = state.tiles[tileId];
      if (!tile || tile.type !== 'sea') throw new Error('MOVE_PIRATE: must target a sea tile');
      if (state.piratePosition === tileId) throw new Error('MOVE_PIRATE: must move to a different tile');

      let next = movePirate(state, tileId);

      // 強奪は必須（盗賊と同様）: 海賊タイルに隣接して船を持ち手札のある相手がいるなら必ず盗む。
      const pirateRobbable = getPirateRobbablePlayerIds(next, tileId, pid).filter(p => robbableCardCount(next, p) > 0);
      if (stealFromPlayerId != null) {
        // 盗む相手は「海賊タイルに隣接する船を持つ相手」に限る。
        if (!getPirateRobbablePlayerIds(next, tileId, pid).includes(stealFromPlayerId))
          throw new Error('MOVE_PIRATE: steal target has no ship adjacent to the pirate tile');
        if (pirateRobbable.length > 0 && !pirateRobbable.includes(stealFromPlayerId))
          throw new Error('MOVE_PIRATE: must steal from an adjacent ship owner who holds cards');
        next = stealResource(next, pid, stealFromPlayerId, rng);
      } else if (pirateRobbable.length > 0) {
        throw new Error('MOVE_PIRATE: must steal from an adjacent ship owner who holds cards');
      }

      const nextPhase = state.diceRolledThisTurn ? 'TRADE_BUILD' : 'PRE_ROLL';
      return { ...next, turnPhase: nextPhase };
    }

    // ----------------------------------------------------------
    // BUILD_ROAD
    // ----------------------------------------------------------
    case 'BUILD_ROAD': {
      const { edgeId } = action;
      const _isSetup = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
      const _isRoadBuilding = state.roadBuildingRoadsRemaining > 0;
      if (!_isSetup && !_isRoadBuilding && state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_ROAD: must be in TRADE_BUILD, setup, or road building phase');
      if (!canBuildRoad(state, pid, edgeId)) throw new Error('BUILD_ROAD: invalid');

      let next = buildRoad(state, pid, edgeId);
      // S3 霧の島: 道の隣接ヘックスを探索公開（霧の無い盤では no-op）。
      next = revealFogAround(next, edgeTileIds(next.edges[edgeId]!, next.vertices), pid);
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);

      // 街道建設カード使用中: 残り配置数をデクリメント
      if (next.roadBuildingRoadsRemaining > 0) {
        next = { ...next, roadBuildingRoadsRemaining: next.roadBuildingRoadsRemaining - 1 };
      }

      // SETUP フェーズのサブフェーズ進行（道を置いたので anchor は解除）
      if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
        next = advanceSetup({ ...next, setupRoadAnchor: null });
      }

      return next;
    }

    // ----------------------------------------------------------
    // BUILD_SHIP（航海者拡張）。道と同じ進行・最長交易路再計算に乗せる。
    // ----------------------------------------------------------
    case 'BUILD_SHIP': {
      const { edgeId } = action;
      const _isSetupSh = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
      if (!_isSetupSh && state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_SHIP: must be in TRADE_BUILD or setup phase');
      if (!canBuildShip(state, pid, edgeId)) throw new Error('BUILD_SHIP: invalid');

      let next = buildShip(state, pid, edgeId);
      // 建てたばかりの船は同じターンに移動できない（航海者の標準ルール）。建設した辺を記録。
      next = { ...next, shipsBuiltThisTurn: [...(next.shipsBuiltThisTurn ?? []), edgeId] };
      // S3 霧の島: 船の隣接ヘックスを探索公開（霧→陸なら資源1枚）。霧の無い盤では no-op。
      next = revealFogAround(next, edgeTileIds(next.edges[edgeId]!, next.vertices), pid);
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);

      // 街道建設カード使用中: 船も道と同じく無料配置の1本として残数をデクリメント（船2/道1+船1）。
      if (next.roadBuildingRoadsRemaining > 0) {
        next = { ...next, roadBuildingRoadsRemaining: next.roadBuildingRoadsRemaining - 1 };
      }

      // セットアップでは2個目のコマ（道 or 船）として進行。anchor 解除。
      if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
        next = advanceSetup({ ...next, setupRoadAnchor: null });
      }

      return next;
    }

    // ----------------------------------------------------------
    // MOVE_SHIP（航海者・上級ルール）。1ターン1回、開放端の船を別の海辺へ。
    // ----------------------------------------------------------
    case 'MOVE_SHIP': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('MOVE_SHIP: must be in MAIN TRADE_BUILD phase');
      const { fromEdgeId, toEdgeId } = action;
      if (!canMoveShip(state, pid, fromEdgeId, toEdgeId)) throw new Error('MOVE_SHIP: invalid');

      let next = moveShip(state, pid, fromEdgeId, toEdgeId);
      // S3 霧の島: 移動先の隣接ヘックスを探索公開（霧の無い盤では no-op）。
      next = revealFogAround(next, edgeTileIds(next.edges[toEdgeId]!, next.vertices), pid);
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // BUILD_SETTLEMENT
    // ----------------------------------------------------------
    case 'BUILD_SETTLEMENT': {
      const { vertexId } = action;
      const _isSetupS = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
      if (!_isSetupS && state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_SETTLEMENT: must be in TRADE_BUILD or setup phase');
      if (!canBuildSettlement(state, pid, vertexId)) throw new Error('BUILD_SETTLEMENT: invalid');

      let next = buildSettlement(state, pid, vertexId);
      // S3 霧の島: 開拓地の隣接ヘックスを探索公開（霧の無い盤では no-op）。
      next = revealFogAround(next, next.vertices[vertexId]!.adjacentTileIds, pid);

      // SETUP 後半: 2個目の配置。
      const isSecondPlacement = state.phase === 'SETUP_BACKWARD' && state.setupSubPhase === 'PLACE_SETTLEMENT';
      if (isSecondPlacement && isCk(state)) {
        // 騎士と商人: 2個目は「都市」。開拓地→都市へ昇格し、都市の初期産出(資源+商品)を配る。
        next = ckSetupSecondCity(next, pid, vertexId);
      } else if (isSecondPlacement) {
        // 基本/航海者: 2個目開拓地の隣接タイルから初期資源を配布（setupGainFor に一本化）。
        for (const resource of setupGainFor(next, vertexId, next.bank)) {
          next = {
            ...next,
            bank: { ...next.bank, [resource]: next.bank[resource] - 1 },
            players: {
              ...next.players,
              [pid]: {
                ...next.players[pid]!,
                hand: { ...next.players[pid]!.hand, [resource]: next.players[pid]!.hand[resource] + 1 },
              },
            },
          };
        }
      }

      // 航海者: MAIN で「新しい島」へ最初に入植したら +2VP（島ボーナス）。
      // 海タイルの無い基本ゲームでは newIslandBonusRep が常に null を返し no-op。
      // checkVictory より前に付与し、島ボーナスで 10VP に到達したら勝てるようにする。
      if (state.phase === 'MAIN') {
        const rep = newIslandBonusRep(next, vertexId, pid);
        if (rep) {
          const owners = (next.islandBonus ?? {})[rep] ?? [];
          // 公式: 各プレイヤーが「自分の初入植」で +VP（他人が先でも可）。同一プレイヤーの重複のみ排除。
          if (!owners.includes(pid)) {
            next = { ...next, islandBonus: { ...(next.islandBonus ?? {}), [rep]: [...owners, pid] } };
          }
        }
      } else {
        // 初期配置: 置いた島を「自分のホーム島」として記録（S2/New World のプレイヤー別未探検判定に使う）。
        const homeRep = islandRepOf(next, vertexId);
        if (homeRep) {
          const cur = (next.playerHomeIslands ?? {})[pid] ?? [];
          if (!cur.includes(homeRep)) {
            next = { ...next, playerHomeIslands: { ...(next.playerHomeIslands ?? {}), [pid]: [...cur, homeRep] } };
          }
        }
      }

      // 開拓地が相手の道路を分断した場合に最長道路ボーナスを再計算する。
      // SETUP では道が短く no-op、MAIN でのみ意味を持つ（BUILD_ROAD と同順序）。
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);

      if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
        // 直後の道はこの開拓地に接続する必要がある（標準ルール）
        next = { ...next, setupSubPhase: 'PLACE_ROAD', setupRoadAnchor: vertexId };
      }

      return next;
    }

    // ----------------------------------------------------------
    // BUILD_CITY
    // ----------------------------------------------------------
    case 'BUILD_CITY': {
      const { vertexId } = action;
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_CITY: must be in MAIN TRADE_BUILD phase');
      if (!canBuildCity(state, pid, vertexId)) throw new Error('BUILD_CITY: invalid');

      let next = buildCity(state, pid, vertexId);
      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // BUY_DEV_CARD
    // ----------------------------------------------------------
    case 'BUY_DEV_CARD': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUY_DEV_CARD: must be in MAIN TRADE_BUILD phase');
      const player = state.players[pid]!;
      if (!hasEnoughResources(player.hand, BUILD_COSTS.dev_card)) {
        throw new Error('BUY_DEV_CARD: insufficient resources');
      }
      if (state.devDeck.length === 0) throw new Error('BUY_DEV_CARD: deck empty');

      const [drawn, ...remaining] = state.devDeck;
      const card: DevCard = { ...drawn!, purchasedOnTurn: state.globalTurnNumber };

      let next: GameState = {
        ...state,
        devDeck: remaining,
        bank: {
          ...state.bank,
          wool:  state.bank.wool  + BUILD_COSTS.dev_card.wool,
          grain: state.bank.grain + BUILD_COSTS.dev_card.grain,
          ore:   state.bank.ore   + BUILD_COSTS.dev_card.ore,
        },
        players: {
          ...state.players,
          [pid]: {
            ...player,
            hand: {
              ...player.hand,
              wool:  player.hand.wool  - BUILD_COSTS.dev_card.wool,
              grain: player.hand.grain - BUILD_COSTS.dev_card.grain,
              ore:   player.hand.ore   - BUILD_COSTS.dev_card.ore,
            },
            devCards: [...player.devCards, card],
          },
        },
      };

      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // PLAY_KNIGHT
    // ----------------------------------------------------------
    case 'PLAY_KNIGHT': {
      // 騎士はロール前(PRE_ROLL)とロール後(TRADE_BUILD)のみ。DISCARD/ROBBER 中に許すと
      // 「7の捨て札待ちで騎士→ROBBERへ遷移」で全員の捨て札を踏み倒せてしまう（不正クライアント対策）。
      if (state.phase !== 'MAIN' || (state.turnPhase !== 'PRE_ROLL' && state.turnPhase !== 'TRADE_BUILD'))
        throw new Error('PLAY_KNIGHT: must be in MAIN PRE_ROLL or TRADE_BUILD phase');
      if (state.devCardPlayedThisTurn) throw new Error('PLAY_KNIGHT: already played a dev card this turn');
      const player = state.players[pid]!;
      const cardIdx = player.devCards.findIndex(
        c => c.type === 'knight' && c.purchasedOnTurn < state.globalTurnNumber,
      );
      if (cardIdx === -1) throw new Error('PLAY_KNIGHT: no playable knight card');

      const newCards = player.devCards.filter((_, i) => i !== cardIdx);
      const usedCard = player.devCards[cardIdx]!;

      let next: GameState = {
        ...state,
        devCardPlayedThisTurn: true,
        devDiscardPile: [...state.devDiscardPile, usedCard],
        players: {
          ...state.players,
          [pid]: {
            ...player,
            devCards: newCards,
            knightsPlayed: player.knightsPlayed + 1,
          },
        },
        turnPhase: 'ROBBER',
      };

      next = updateLargestArmy(next);
      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // PLAY_YEAR_OF_PLENTY
    // ----------------------------------------------------------
    case 'PLAY_YEAR_OF_PLENTY': {
      if (state.devCardPlayedThisTurn) throw new Error('PLAY_YEAR_OF_PLENTY: already played a dev card this turn');
      // 進歩カードはダイス後のみ（ダイス前に使う実益がなく、収穫/独占はダイス前だと7で自分が
      // 捨て札になる無駄手になる）。ダイス前に意味があるのは盗賊を動かせる騎士だけ。
      if (!state.diceRolledThisTurn) throw new Error('PLAY_YEAR_OF_PLENTY: must roll dice first');
      // 7の捨て札/盗賊フェーズ中などTRADE_BUILD以外では使えない（不正クライアント対策）。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('PLAY_YEAR_OF_PLENTY: must be in MAIN TRADE_BUILD phase');
      const player = state.players[pid]!;
      const [r1, r2] = action.resources;
      const cardIdx = player.devCards.findIndex(
        c => c.type === 'year_of_plenty' && c.purchasedOnTurn < state.globalTurnNumber,
      );
      if (cardIdx === -1) throw new Error('PLAY_YEAR_OF_PLENTY: no playable card');

      const newCards = player.devCards.filter((_, i) => i !== cardIdx);
      const usedCard = player.devCards[cardIdx]!;

      const gained: Partial<Record<ResourceType, number>> = {};
      gained[r1] = (gained[r1] ?? 0) + 1;
      gained[r2] = (gained[r2] ?? 0) + 1;

      const newHand = { ...player.hand };
      const newBank = { ...state.bank };
      for (const [r, amt] of Object.entries(gained) as [ResourceType, number][]) {
        const actual = Math.min(amt, newBank[r]);
        newHand[r] += actual;
        newBank[r] -= actual;
      }

      return {
        ...state,
        devCardPlayedThisTurn: true,
        bank: newBank,
        devDiscardPile: [...state.devDiscardPile, usedCard],
        players: {
          ...state.players,
          [pid]: { ...player, hand: newHand, devCards: newCards },
        },
      };
    }

    // ----------------------------------------------------------
    // PLAY_MONOPOLY
    // ----------------------------------------------------------
    case 'PLAY_MONOPOLY': {
      if (state.devCardPlayedThisTurn) throw new Error('PLAY_MONOPOLY: already played a dev card this turn');
      // 進歩カードはダイス後のみ（ダイス前に意味があるのは盗賊を動かせる騎士だけ）。
      if (!state.diceRolledThisTurn) throw new Error('PLAY_MONOPOLY: must roll dice first');
      // 7の捨て札/盗賊フェーズ中などTRADE_BUILD以外では使えない（不正クライアント対策）。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('PLAY_MONOPOLY: must be in MAIN TRADE_BUILD phase');
      const player = state.players[pid]!;
      const { resource } = action;
      const cardIdx = player.devCards.findIndex(
        c => c.type === 'monopoly' && c.purchasedOnTurn < state.globalTurnNumber,
      );
      if (cardIdx === -1) throw new Error('PLAY_MONOPOLY: no playable card');

      const newCards = player.devCards.filter((_, i) => i !== cardIdx);
      const usedCard = player.devCards[cardIdx]!;

      let totalStolen = 0;
      const newPlayers = { ...state.players };

      for (const otherPid of state.playerOrder) {
        if (otherPid === pid) continue;
        const other = newPlayers[otherPid]!;
        const amt = other.hand[resource];
        if (amt === 0) continue;
        totalStolen += amt;
        newPlayers[otherPid] = { ...other, hand: { ...other.hand, [resource]: 0 } };
      }

      newPlayers[pid] = {
        ...player,
        devCards: newCards,
        hand: { ...player.hand, [resource]: player.hand[resource] + totalStolen },
      };

      return {
        ...state,
        devCardPlayedThisTurn: true,
        devDiscardPile: [...state.devDiscardPile, usedCard],
        players: newPlayers,
      };
    }

    // ----------------------------------------------------------
    // PLAY_ROAD_BUILDING
    // ----------------------------------------------------------
    case 'PLAY_ROAD_BUILDING': {
      if (state.devCardPlayedThisTurn) throw new Error('PLAY_ROAD_BUILDING: already played a dev card this turn');
      // 進歩カードはダイス後のみ（ダイス前に意味があるのは盗賊を動かせる騎士だけ）。
      if (!state.diceRolledThisTurn) throw new Error('PLAY_ROAD_BUILDING: must roll dice first');
      // 7の捨て札/盗賊フェーズ中などTRADE_BUILD以外では使えない（不正クライアント対策）。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('PLAY_ROAD_BUILDING: must be in MAIN TRADE_BUILD phase');
      const player = state.players[pid]!;
      const cardIdx = player.devCards.findIndex(
        c => c.type === 'road_building' && c.purchasedOnTurn < state.globalTurnNumber,
      );
      if (cardIdx === -1) throw new Error('PLAY_ROAD_BUILDING: no playable card');

      const newCards = player.devCards.filter((_, i) => i !== cardIdx);
      const usedCard = player.devCards[cardIdx]!;

      const roadsAvailable = Math.min(2, player.remainingRoads);
      return {
        ...state,
        devCardPlayedThisTurn: true,
        roadBuildingRoadsRemaining: roadsAvailable,
        devDiscardPile: [...state.devDiscardPile, usedCard],
        players: {
          ...state.players,
          [pid]: { ...player, devCards: newCards },
        },
      };
    }

    // ----------------------------------------------------------
    // FINISH_ROAD_BUILDING
    // ----------------------------------------------------------
    case 'FINISH_ROAD_BUILDING': {
      if (state.roadBuildingRoadsRemaining === 0) throw new Error('FINISH_ROAD_BUILDING: no road building in progress');
      return { ...state, roadBuildingRoadsRemaining: 0 };
    }

    // ----------------------------------------------------------
    // 騎士と商人(Cities & Knights) の建設アクション
    // ----------------------------------------------------------
    case 'BUILD_KNIGHT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('BUILD_KNIGHT: must be in TRADE_BUILD');
      if (!canBuildKnight(state, pid, action.vertexId)) throw new Error('BUILD_KNIGHT: invalid');
      return buildKnight(state, pid, action.vertexId);
    }
    case 'ACTIVATE_KNIGHT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('ACTIVATE_KNIGHT: must be in TRADE_BUILD');
      if (!canActivateKnight(state, pid, action.vertexId)) throw new Error('ACTIVATE_KNIGHT: invalid');
      return activateKnight(state, pid, action.vertexId);
    }
    case 'UPGRADE_KNIGHT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('UPGRADE_KNIGHT: must be in TRADE_BUILD');
      if (!canUpgradeKnight(state, pid, action.vertexId)) throw new Error('UPGRADE_KNIGHT: invalid');
      return upgradeKnight(state, pid, action.vertexId);
    }
    case 'BUILD_IMPROVEMENT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('BUILD_IMPROVEMENT: must be in TRADE_BUILD');
      if (!canBuildImprovement(state, pid, action.track)) throw new Error('BUILD_IMPROVEMENT: invalid');
      return checkVictory(buildImprovement(state, pid, action.track, 0, action.metropolisVertexId), pid);
    }
    case 'BUILD_CITY_WALL': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('BUILD_CITY_WALL: must be in TRADE_BUILD');
      if (!canBuildCityWall(state, pid, action.vertexId)) throw new Error('BUILD_CITY_WALL: invalid');
      return buildCityWall(state, pid, action.vertexId);
    }
    case 'PLAY_PROGRESS': {
      // 進歩カードは自分の手番のダイス後(TRADE_BUILD)に使用。
      // 例外: 錬金術師(alchemist)は「振る前」に使うので PRE_ROLL でのみ許可。
      const card = state.players[pid]?.progressCards?.find(c => c.id === action.cardId);
      const isAlchemist = card?.type === 'alchemist';
      const okPhase = state.phase === 'MAIN'
        && (state.turnPhase === 'TRADE_BUILD' || (isAlchemist && state.turnPhase === 'PRE_ROLL'));
      if (!okPhase) throw new Error('PLAY_PROGRESS: wrong phase for this card');
      // 人間は効果が空でも使える（消費される）。受理は緩い判定で。CPUは canPlayProgress で効果成立時のみ選ぶ。
      if (!canPlayProgressLoose(state, pid, action.cardId)) throw new Error('PLAY_PROGRESS: invalid');
      const played = playProgress(state, pid, action.cardId, rng, action.choice);
      // 使った札種を公開情報として記録（LANでも全員が「何を使ったか」を盤面演出できるように）。
      const marked = card ? { ...played, lastProgressPlay: { playerId: pid, cardType: card.type } } : played;
      return checkVictory(marked, pid);
    }
    case 'MOVE_KNIGHT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('MOVE_KNIGHT: must be in TRADE_BUILD');
      if (!canMoveKnight(state, pid, action.fromVertexId, action.toVertexId)) throw new Error('MOVE_KNIGHT: invalid');
      return moveKnight(state, pid, action.fromVertexId, action.toVertexId);
    }
    case 'CHASE_ROBBER': {
      // 騎士で強盗を追い払う。ダイス後(TRADE_BUILD・diceRolledThisTurn=true)のみ。
      // chaseRobber が ROBBER フェーズへ遷移し、続く MOVE_ROBBER で移動・強奪、
      // diceRolledThisTurn=true により自動的に TRADE_BUILD へ戻る（robberSource不要）。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD') throw new Error('CHASE_ROBBER: must be in TRADE_BUILD');
      if (!isCk(state)) throw new Error('CHASE_ROBBER: cities & knights only');
      if (!canChaseRobber(state, pid, action.vertexId)) throw new Error('CHASE_ROBBER: invalid');
      return chaseRobber(state, pid, action.vertexId);
    }

    // ----------------------------------------------------------
    // BANK_TRADE
    // ----------------------------------------------------------
    case 'BANK_TRADE': {
      // 銀行/港交易はダイス後の交易・建設フェーズのみ。これが無いと PRE_ROLL での先行交易や、
      // DISCARD 中に 4:1 で手札を 8 枚未満へ圧縮して捨て札を回避する不正が可能になる。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BANK_TRADE: must be in MAIN TRADE_BUILD phase');
      const { give, receive } = action;
      if (!canBankTrade(state, pid, give, receive)) throw new Error('BANK_TRADE: invalid');
      return executeBankTrade(state, pid, give, receive);
    }

    // ----------------------------------------------------------
    // OFFER_TRADE
    // ----------------------------------------------------------
    case 'OFFER_TRADE': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('OFFER_TRADE: must be in TRADE_BUILD phase');
      if (state.roadBuildingRoadsRemaining > 0)
        throw new Error('OFFER_TRADE: cannot trade during road building');
      const giveTotal = RESOURCE_TYPES.reduce((s, r) => s + (action.offer.give[r] ?? 0), 0);
      const recvTotal = RESOURCE_TYPES.reduce((s, r) => s + (action.offer.receive[r] ?? 0), 0);
      if (giveTotal === 0 || recvTotal === 0)
        throw new Error('OFFER_TRADE: both sides must offer at least 1 resource');
      // 同一資源を渡しつつ受け取る交換は無意味なので禁止（give と receive の品目が重複しない）
      if (RESOURCE_TYPES.some(r => (action.offer.give[r] ?? 0) > 0 && (action.offer.receive[r] ?? 0) > 0))
        throw new Error('OFFER_TRADE: cannot give and receive the same resource');
      if (action.targetPlayerIds.length === 0)
        throw new Error('OFFER_TRADE: targetPlayerIds must not be empty');
      if (action.targetPlayerIds.includes(pid))
        throw new Error('OFFER_TRADE: cannot trade with yourself');
      for (const tid of action.targetPlayerIds) {
        if (!state.players[tid])
          throw new Error(`OFFER_TRADE: player ${tid} does not exist`);
      }
      const initiator = state.players[pid]!;
      const hasEnoughGive = RESOURCE_TYPES.every(r => initiator.hand[r] >= (action.offer.give[r] ?? 0));
      if (!hasEnoughGive)
        throw new Error('OFFER_TRADE: initiator does not have enough resources to give');
      return offerTrade(state, pid, action.offer, action.targetPlayerIds);
    }

    // ----------------------------------------------------------
    // RESPOND_TRADE
    // ----------------------------------------------------------
    case 'RESPOND_TRADE': {
      return respondTrade(state, action.response);
    }

    // ----------------------------------------------------------
    // CONFIRM_TRADE
    // ----------------------------------------------------------
    case 'CONFIRM_TRADE': {
      return confirmTrade(state, action.responderId);
    }

    // ----------------------------------------------------------
    // CANCEL_TRADE
    // ----------------------------------------------------------
    case 'CANCEL_TRADE': {
      return cancelTrade(state);
    }

    // ----------------------------------------------------------
    // END_TURN
    // ----------------------------------------------------------
    case 'END_TURN': {
      // ターン終了は MAIN の TRADE_BUILD（ダイスを振り、強盗/捨て札を解決済み）でのみ。
      // これが無いと PRE_ROLL でダイスを飛ばしたり、SETUP/7処理中に勝手に手番を進められる。
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('END_TURN: must be in MAIN TRADE_BUILD phase');
      const nextGlobalTurn = state.globalTurnNumber + 1;
      // 安全網: 異常に長引いた対戦（AIが勝ち切れない病的局面など）が永久ループしないよう、
      // 上限ターンに達したら最高VPのプレイヤーを勝者として終了する。通常対戦(〜300)では発火しない。
      if (nextGlobalTurn >= TURN_CAP) {
        let best: PlayerId = state.playerOrder[0]!;
        let bestVp = -1;
        for (const p of state.playerOrder) {
          const vp = calcVP(state, p);
          if (vp > bestVp) { bestVp = vp; best = p; }
        }
        return { ...state, winner: best, phase: 'GAME_OVER' };
      }
      const nextIndex = (state.currentPlayerIndex + 1) % state.playerOrder.length;
      // 騎士と商人: 商船隊(merchant_fleet)の「このターン2:1」を手番終了でクリア。
      const endingPlayer = state.players[pid]!;
      const playersAfter = isCk(state) && endingPlayer.merchantFleetType != null
        ? { ...state.players, [pid]: { ...endingPlayer, merchantFleetType: null } }
        : state.players;
      // 騎士と商人: 「起動したターン」フラグを手番終了でクリア（翌手番から行動可能に）。
      let verticesAfter = state.vertices;
      if (isCk(state)) {
        let touched = false;
        const vs = { ...state.vertices };
        for (const id of Object.keys(vs)) {
          const k = vs[id]!.knight;
          if (k?.activatedThisTurn) { vs[id] = { ...vs[id]!, knight: { ...k, activatedThisTurn: false } }; touched = true; }
        }
        if (touched) verticesAfter = vs;
      }
      return {
        ...state,
        players: playersAfter,
        vertices: verticesAfter,
        currentPlayerIndex: nextIndex,
        globalTurnNumber: nextGlobalTurn,
        turnPhase: 'PRE_ROLL',
        lastDiceRoll: null,
        diceRolledThisTurn: false,
        roadBuildingRoadsRemaining: 0,
        devCardPlayedThisTurn: false,
        shipMovedThisTurn: false,
        shipsBuiltThisTurn: [],
        // 騎士と商人専用フラグは CK でのみリセット（非CK状態を汚さない）。
        ...(isCk(state) ? { knightMovedThisTurn: false, knightChasedThisTurn: false } : {}),
        pendingTrade: null,
      };
    }

    // ----------------------------------------------------------
    // DECLARE_VICTORY
    // ----------------------------------------------------------
    case 'DECLARE_VICTORY': {
      // 自分の手番なら PRE_ROLL（ダイス前）でも宣言可。称号移動で手番開始時に目標到達する場合に
      // 「勝利宣言」ボタンが反応しない問題を解消（ダイスを振らずに即勝てる）。
      if (state.phase !== 'MAIN' || (state.turnPhase !== 'TRADE_BUILD' && state.turnPhase !== 'PRE_ROLL'))
        throw new Error('DECLARE_VICTORY: must be in MAIN PRE_ROLL or TRADE_BUILD phase');
      if (calcVP(state, pid) < victoryTarget(state)) throw new Error("DECLARE_VICTORY: insufficient VP");
      return { ...state, winner: pid, phase: 'GAME_OVER' };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ============================================================
// セットアップ進行ヘルパー
// ============================================================

/**
 * SETUP フェーズの道設置後に次の手番・フェーズへ進める。
 *
 * SETUP_FORWARD: 0,1,2,3 順（4人の場合）
 * SETUP_BACKWARD: 3,2,1,0 逆順
 * 後半最後のプレイヤーが道を置いたら MAIN へ移行。
 */
function advanceSetup(state: GameState): GameState {
  const total = state.playerOrder.length;
  const idx = state.currentPlayerIndex;

  if (state.phase === 'SETUP_FORWARD') {
    if (idx < total - 1) {
      // 次のプレイヤーへ
      return {
        ...state,
        currentPlayerIndex: idx + 1,
        setupSubPhase: 'PLACE_SETTLEMENT',
      };
    } else {
      // 後半開始: 最後のプレイヤーが前半を終えたらそのまま後半へ（同プレイヤーが続ける）
      return {
        ...state,
        phase: 'SETUP_BACKWARD',
        setupSubPhase: 'PLACE_SETTLEMENT',
      };
    }
  }

  if (state.phase === 'SETUP_BACKWARD') {
    if (idx > 0) {
      return {
        ...state,
        currentPlayerIndex: idx - 1,
        setupSubPhase: 'PLACE_SETTLEMENT',
      };
    } else {
      // 全員配置完了 → MAIN フェーズへ
      return {
        ...state,
        phase: 'MAIN',
        turnPhase: 'PRE_ROLL',
        currentPlayerIndex: 0,
        setupSubPhase: null,
        diceRolledThisTurn: false,
        devCardPlayedThisTurn: false,
      };
    }
  }

  return state;
}
