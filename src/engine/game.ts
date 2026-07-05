// ============================================================
// src/engine/game.ts — L-09: applyAction 統合エンジン
// ============================================================

import type {
  GameState, Action, PlayerId, ResourceType, DevCard, VertexId, ResourceHand,
} from '../types';
import { RESOURCE_TYPES, COMMODITY_TYPES, BUILD_COSTS, DEV_CARD_COUNTS, TILE_RESOURCE_MAP, VP_TABLE, TB_ROAD_REPAIR_COST, TB_EVENT_CARDS_36, TB2_TOKENS_KNIGHT_DISCARD, TB2_FORCED_TRADE_GIVE, TB2_FORCED_TRADE_TAKE } from '../constants';
import type { CommodityType } from '../types';
import { rollDice, distributeResources, computeGoldPicks, capPicksByBank } from './dice';
import { buildTbEventDeck, tbApplyEventEffect, tbEventStealTargets } from './tbEvents';
import {
  isTbNeutral, tbTwoOpponent, tbSpendCost, tbCanSpendWindow, tbGrantTokens,
  tbTokensForSettlement, tbNeutralPendingAfterRoad, tbNeutralPendingAfterSettlement,
  tbTwoAfterRollResolved,
} from './tbTwo';
import {
  canBuildRoad, buildRoad,
  canBuildShip, buildShip,
  canMoveShip, moveShip,
  canBuildSettlement, buildSettlement,
  canBuildCity, buildCity,
  hasEnoughResources,
} from './actions';
import { moveRobber, movePirate, discardResources, stealResource, stealResourceOrCloth, getRobbablePlayerIds, getPirateRobbablePlayerIds, discardCount, robbableCardCount, pirateRobbableCount, findPendingDiscarder, getRobberMoveTargets, isFriendlyRobberProtected } from './robber';
import {
  isCk, applyEventDie, distributeCkProduction,
  canBuildKnight, buildKnight, canActivateKnight, activateKnight, canUpgradeKnight, upgradeKnight,
  canBuildImprovement, buildImprovement, canBuildCityWall, buildCityWall,
  canPlayProgress, canPlayProgressLoose, playProgress, canMoveKnight, moveKnight, canChaseRobber, chaseRobber, ckSetupSecondCity,
  downgradeCity, discardProgressCard,
} from './citiesKnights';
import { executeBankTrade, canBankTrade, offerTrade, respondTrade, confirmTrade, cancelTrade } from './trade';
import { updateLongestRoad, updateLargestArmy, updateStrongestPorts, checkVictory, calcVP, calcPublicVP, victoryTarget } from './scoring';
import { newIslandBonusRep, islandRepOf } from './islands';
import { edgeTileIds } from './board';
import { revealFogAround, revealPendingNumbers } from './explore';
import { collectEdgeToken, placeHeldHarborAt } from './seaTokens';
import { connectVillagesAround, produceCloth, checkClothEnd } from './cloth';
import { canBuildWonder, buildWonder } from './wonders';
import { canAttackFortress, attackFortress, moveFleet, playWarship } from './pirateIslands';

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
/**
 * 航海者・金タイル産出: その数字で金タイルから産出を受けるプレイヤーへ任意資源の選択(GOLD)を
 * 要求する。全体の選択枚数がバンク総在庫を超えないよう playerOrder 順に頭打ちして手詰まりを防ぐ。
 * 金産出が無ければ TRADE_BUILD のまま返す。基本ゲーム・騎士と商人の双方の生産後に通すことで、
 * C&K×航海者コンボ（金タイル入りの盤）でも金が産出するようにする。
 */
function applyGoldChoicePhase(next: GameState, total: number): GameState {
  const goldPicks = capPicksByBank(next, computeGoldPicks(next, total));
  return Object.keys(goldPicks).length > 0
    ? { ...next, turnPhase: 'GOLD', pendingGoldChoice: goldPicks }
    : { ...next, turnPhase: 'TRADE_BUILD' };
}

/**
 * 基本/航海者: 出目（または交易と蛮族イベントカードの数字ディスク値）の解決。
 * 7＝捨て札/盗賊、それ以外＝生産→織物→金タイル。ROLL_DICE 本体と、イベントカードの
 * 選択解決後の再開（tbContinueAfterEvent）の両方から呼ぶ（重複排除＋一貫性）。
 */
function resolveBaseRollOutcome(next: GameState, total: number): GameState {
  if (total === 7) {
    // S7 海賊の島々では moveFleet が「資源収集前」に略奪して手札を減らしうるため、
    // 捨て札要否は現在の手札(next)で判定する（詳細は ROLL_DICE 内コメント参照）。
    const needsDiscard = next.playerOrder.some(p => {
      const h = next.players[p]!.hand;
      return RESOURCE_TYPES.reduce((s, r) => s + h[r], 0) >= 8;
    });
    // S7 海賊の島々（useRobber=false）: 盗賊不使用。7は手札破棄のみで盗賊移動・盗みは無し。
    const afterDiscard = next.useRobber === false ? 'TRADE_BUILD' : 'ROBBER';
    next = { ...next, discardedThisRound: [], turnPhase: needsDiscard ? 'DISCARD' : afterDiscard };
  } else {
    next = distributeResources({ ...next, turnPhase: 'TRADE_BUILD' }, total);
    // S6 カタンの織物: 村の数字が出たら接続済みプレイヤーへ織物を配る（無い盤では no-op）。
    next = produceCloth(next, total);
    // 航海者: 金タイル産出があれば、任意資源の選択待ち(GOLD)へ。無ければ通常どおり TRADE_BUILD。
    next = applyGoldChoicePhase(next, total);
  }
  return checkClothEnd(next); // S6: 織物生産後、5村供給切れなら終了（無い盤では no-op）
}

/**
 * 交易と蛮族「イベントカード」: イベント効果の選択解決（EVENT_* / GOLD）が全て終わったら、
 * 保留しておいたカードの数字ディスク値で生産（または7の解決）へ進む。
 */
function tbContinueAfterEvent(next: GameState): GameState {
  const total = next.tbPendingEventNumber;
  if (total == null) return { ...next, turnPhase: 'TRADE_BUILD' }; // 保険（通常は必ず数字が保留されている）
  return resolveBaseRollOutcome({ ...next, tbPendingEventNumber: null }, total);
}

function resolveCkRollOutcome(next: GameState, total: number): GameState {
  if (total === 7) {
    const needsDiscard = next.playerOrder.some(p => discardCount(next, p) > 0); // 資源＋商品で判定
    // 初回の蛮族襲来までは盗賊が凍結＝7は手札破棄のみ（盗賊移動・盗みなし）。
    const robberActive = (next.barbarianAttacks ?? 0) >= 1;
    const afterDiscard = robberActive ? 'ROBBER' : 'TRADE_BUILD';
    return { ...next, discardedThisRound: [], turnPhase: needsDiscard ? 'DISCARD' : afterDiscard };
  }
  // C&K×航海者: 資源＋商品の生産後に金タイル産出（任意資源の選択）も流す。isCk の早期 return で
  // 金処理(GOLD)へ到達しなかったため、コンボ盤の金タイルが死にメカになっていたバグを修正。
  const produced = distributeCkProduction({ ...next, turnPhase: 'TRADE_BUILD' }, total);
  return applyGoldChoicePhase(produced, total);
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

      // ---- 交易と蛮族「イベントカード」: 赤黄ダイスの代わりにデッキの一番上をめくる ----
      if (state.tbEventCards) {
        let deck = state.tbEventDeck ?? [];
        let rebuilt = false;
        // New Year（または山札切れ＝保険）→ デッキを作り直してから一番上をめくって通常解決。
        // New Year はデッキ再構築後の一番上には来ない（底から6枚目に埋まる）ため再帰しない。
        if (deck.length === 0 || deck[0]!.event === 'new_year') {
          deck = buildTbEventDeck(TB_EVENT_CARDS_36, rng);
          rebuilt = true;
        }
        const card = deck[0]!;
        deck = deck.slice(1);
        const total = card.number!;
        // lastDiceRoll にはカード数字の2分割を入れ、既存の生産演出/履歴/統計と互換にする
        // （UI 側は tbLastEventCard を見てダイスの代わりにカードを表示する）。
        const d1 = Math.min(6, Math.ceil(total / 2));
        const d2 = total - d1;
        let next: GameState = {
          ...state,
          tbEventDeck: deck,
          tbLastEventCard: card,
          tbNewYearRebuilt: rebuilt,
          lastDiceRoll: [d1, d2],
          diceRolledThisTurn: true,
        };
        // イベント効果を解決（CN3089 p5: 効果 → 数字ディスク値で生産 or 7 の順）。
        next = tbApplyEventEffect(next, card);
        // プレイヤーの選択が要る効果は保留フェーズ(EVENT_*/GOLD)へ遷移済み
        // → 数字の解決は全選択の解決後（CHOOSE_* ハンドラの tbContinueAfterEvent）。
        if (next.turnPhase !== 'PRE_ROLL') return { ...next, tbPendingEventNumber: total };
        return resolveBaseRollOutcome(next, total);
      }

      // ---- 交易と蛮族「Catan for Two」: 生産フェーズを続けて2回行う（CN3089 p7） ----
      // 1回目の出目解決（7の捨て札/盗賊まで）が完全に終わると tbTwoAfterRollResolved が
      // turnPhase を PRE_ROLL へ戻し、2回目の ROLL_DICE を受ける。2回目は合計値が1回目と
      // 異なるまでエンジン内で振り直す（公式: "re-roll until you have a different result"）。
      // ※イベントカード/C&K との併用時の生産2回制は未実装（本変種は基本盤の単独シナリオのみ）。
      if (state.tbCatanForTwo && !isCk(state)) {
        const rollsDone = state.tbRollsDone ?? 0;
        let [d1, d2] = rollDice(rng);
        if (rollsDone >= 1 && state.tbFirstRollTotal != null) {
          while (d1 + d2 === state.tbFirstRollTotal) [d1, d2] = rollDice(rng);
        }
        const total = d1 + d2;
        const next: GameState = {
          ...state,
          lastDiceRoll: [d1, d2],
          diceRolledThisTurn: true,
          tbRollsDone: rollsDone + 1,
          ...(rollsDone === 0 ? { tbFirstRollTotal: total } : {}),
        };
        return tbTwoAfterRollResolved(resolveBaseRollOutcome(next, total));
      }

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

      // S7 海賊の島々: ダイス後・資源収集前に海賊艦隊が「小さい目」の数だけ前進し、隣接建物から略奪。
      // （捨て札要否は略奪後の手札で判定する必要があるため、moveFleet は resolveBaseRollOutcome より前）
      if (state.pirateFleet) next = moveFleet(next, Math.min(d1, d2), rng);

      // 7の捨て札/盗賊 or 生産→織物→金タイル（T&Bイベントカード経路と共通の resolveBaseRollOutcome へ集約）。
      return resolveBaseRollOutcome(next, total);
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
      // T&B イベントカードのイベント効果（豊作の年/穏やかな海/馬上槍試合）で GOLD に入っていた
      // 場合は、保留中のカード数字の生産へ進む（tbContinueAfterEvent。通常の金タイルGOLDは
      // tbPendingEventNumber が null なので従来どおり TRADE_BUILD）。
      if (Object.keys(nextPending).length === 0) {
        next = { ...next, pendingGoldChoice: {} };
        // Catan for Two: 金の選択で1回目の出目解決が完結するなら2回目の生産へ（フックは no-op 安全）。
        next = next.tbPendingEventNumber != null
          ? tbContinueAfterEvent(next)
          : tbTwoAfterRollResolved({ ...next, turnPhase: 'TRADE_BUILD' });
      }
      return next;
    }

    // ----------------------------------------------------------
    // 交易と蛮族「イベントカード」: イベント効果の選択解決
    // ----------------------------------------------------------

    // 良き隣人(GOOD NEIGHBORS): 各自が左隣へ渡す任意資源1枚を選ぶ（多人数解決）。
    case 'CHOOSE_EVENT_GIVE': {
      if (state.turnPhase !== 'EVENT_GIVE') throw new Error('CHOOSE_EVENT_GIVE: not in EVENT_GIVE phase');
      const { playerId, resource } = action;
      const toId = (state.tbPendingEventGive ?? {})[playerId];
      if (!toId) throw new Error('CHOOSE_EVENT_GIVE: no pending give for this player');
      const giver = state.players[playerId];
      const receiver = state.players[toId];
      if (!giver || !receiver) throw new Error('CHOOSE_EVENT_GIVE: unknown player');
      // resource は必ず既知の資源種別（LANの不正ペイロードで hand[bogus]=NaN を作らせない）。
      if (!RESOURCE_TYPES.includes(resource)) throw new Error('CHOOSE_EVENT_GIVE: unknown resource');
      if (giver.hand[resource] < 1) throw new Error('CHOOSE_EVENT_GIVE: resource not in hand');

      const pending = { ...(state.tbPendingEventGive ?? {}) };
      delete pending[playerId];
      let next: GameState = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...giver, hand: { ...giver.hand, [resource]: giver.hand[resource] - 1 } },
          [toId]: { ...receiver, hand: { ...receiver.hand, [resource]: receiver.hand[resource] + 1 } },
        },
        tbPendingEventGive: pending,
      };
      if (Object.keys(pending).length === 0) next = tbContinueAfterEvent({ ...next, tbPendingEventGive: {} });
      return next;
    }

    // 親切な隣人(HELPFUL NEIGHBOR): 公開VP最多者が「より少ない者」へ渡す資源と相手を選ぶ。
    case 'CHOOSE_EVENT_HELPFUL': {
      if (state.turnPhase !== 'EVENT_HELPFUL') throw new Error('CHOOSE_EVENT_HELPFUL: not in EVENT_HELPFUL phase');
      const { playerId, resource, toPlayerId } = action;
      if (!(state.tbPendingEventHelpful ?? []).includes(playerId))
        throw new Error('CHOOSE_EVENT_HELPFUL: no pending give for this player');
      const giver = state.players[playerId];
      const receiver = state.players[toPlayerId];
      if (!giver || !receiver || playerId === toPlayerId) throw new Error('CHOOSE_EVENT_HELPFUL: invalid players');
      // resource は必ず既知の資源種別（LANの不正ペイロードで hand[bogus]=NaN を作らせない）。
      if (!RESOURCE_TYPES.includes(resource)) throw new Error('CHOOSE_EVENT_HELPFUL: unknown resource');
      if (giver.hand[resource] < 1) throw new Error('CHOOSE_EVENT_HELPFUL: resource not in hand');
      // 受け取れるのは「渡す側よりVPの少ない」プレイヤーのみ（公開VPで判定・CN3089 p6）。
      if (calcPublicVP(state, toPlayerId) >= calcPublicVP(state, playerId))
        throw new Error('CHOOSE_EVENT_HELPFUL: recipient must have fewer VPs');

      const pending = (state.tbPendingEventHelpful ?? []).filter(p => p !== playerId);
      let next: GameState = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...giver, hand: { ...giver.hand, [resource]: giver.hand[resource] - 1 } },
          [toPlayerId]: { ...receiver, hand: { ...receiver.hand, [resource]: receiver.hand[resource] + 1 } },
        },
        tbPendingEventHelpful: pending,
      };
      if (pending.length === 0) next = tbContinueAfterEvent({ ...next, tbPendingEventHelpful: [] });
      return next;
    }

    // 衝突(CONFLICT)/交易優位(TRADE ADVANTAGE): タイル保持者が奪う相手を選ぶ（無作為1枚）。
    case 'CHOOSE_EVENT_STEAL': {
      if (state.turnPhase !== 'EVENT_STEAL') throw new Error('CHOOSE_EVENT_STEAL: not in EVENT_STEAL phase');
      const pending = state.tbPendingEventSteal;
      if (!pending) throw new Error('CHOOSE_EVENT_STEAL: no pending steal');
      const { targetPlayerId } = action;
      if (targetPlayerId == null) {
        // 見送りは「騎士カード最多の単独者」（原文 "may steal"）のときだけ許す。タイル保持者は必須。
        if (!pending.optional) throw new Error('CHOOSE_EVENT_STEAL: stealing is mandatory for the tile holder');
        return tbContinueAfterEvent({ ...state, tbPendingEventSteal: null });
      }
      if (!tbEventStealTargets(state).includes(targetPlayerId))
        throw new Error('CHOOSE_EVENT_STEAL: invalid steal target');
      let next = stealResource(state, pending.playerId, targetPlayerId, rng);
      next = { ...next, tbPendingEventSteal: null };
      return tbContinueAfterEvent(next);
    }

    // 地震(EARTHQUAKE): 各自が損傷させる自分の道1本を選ぶ（多人数解決）。
    case 'CHOOSE_EVENT_DAMAGE': {
      if (state.turnPhase !== 'EVENT_DAMAGE') throw new Error('CHOOSE_EVENT_DAMAGE: not in EVENT_DAMAGE phase');
      const { playerId, edgeId } = action;
      if (!(state.tbPendingEventDamage ?? []).includes(playerId))
        throw new Error('CHOOSE_EVENT_DAMAGE: no pending damage for this player');
      const edge = state.edges[edgeId];
      if (!edge?.road || edge.road.playerId !== playerId)
        throw new Error('CHOOSE_EVENT_DAMAGE: not your road');
      if (edge.road.damaged) throw new Error('CHOOSE_EVENT_DAMAGE: road already damaged');

      const pending = (state.tbPendingEventDamage ?? []).filter(p => p !== playerId);
      let next: GameState = {
        ...state,
        edges: { ...state.edges, [edgeId]: { ...edge, road: { ...edge.road, damaged: true } } },
        tbPendingEventDamage: pending,
      };
      if (pending.length === 0) next = tbContinueAfterEvent({ ...next, tbPendingEventDamage: [] });
      return next;
    }

    // 損傷した道の修理（レンガ1木1・自分のターンの交易/建設フェーズ・CN3089 p5）。
    case 'REPAIR_ROAD': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('REPAIR_ROAD: not in TRADE_BUILD phase');
      const { edgeId } = action;
      const edge = state.edges[edgeId];
      if (!edge?.road || edge.road.playerId !== pid) throw new Error('REPAIR_ROAD: not your road');
      if (!edge.road.damaged) throw new Error('REPAIR_ROAD: road is not damaged');
      const player = state.players[pid]!;
      if (!hasEnoughResources(player.hand, TB_ROAD_REPAIR_COST))
        throw new Error('REPAIR_ROAD: not enough resources');

      const newHand = { ...player.hand };
      const newBank = { ...state.bank };
      for (const r of RESOURCE_TYPES) {
        newHand[r] -= TB_ROAD_REPAIR_COST[r];
        newBank[r] += TB_ROAD_REPAIR_COST[r];
      }
      return {
        ...state,
        bank: newBank,
        players: { ...state.players, [pid]: { ...player, hand: newHand } },
        edges: { ...state.edges, [edgeId]: { ...edge, road: { playerId: pid } } },
      };
    }

    // ----------------------------------------------------------
    // 交易と蛮族「Catan for Two（2人用）」: 中立コマの無償配置＋trade token 経済（CN3089 p7）
    // ----------------------------------------------------------

    // 中立の道を無償配置（手番プレイヤーが「どちらの中立か＋位置」を選ぶ。自分の道1本につき1本）。
    case 'TB_NEUTRAL_ROAD': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TB_NEUTRAL')
        throw new Error('TB_NEUTRAL_ROAD: not in TB_NEUTRAL phase');
      if (state.tbNeutralPending !== 'road')
        throw new Error('TB_NEUTRAL_ROAD: a neutral settlement is pending, not a road');
      const { owner, edgeId } = action;
      if (!isTbNeutral(state, owner)) throw new Error('TB_NEUTRAL_ROAD: owner is not a neutral player');
      if (!canBuildRoad(state, owner, edgeId)) throw new Error('TB_NEUTRAL_ROAD: invalid placement');

      let next = buildRoad(state, owner, edgeId);
      next = { ...next, turnPhase: 'TRADE_BUILD', tbNeutralPending: null };
      next = updateLongestRoad(next); // 中立も最長交易路タイルの保持候補（CN3089 p7）
      // タイル移動で手番プレイヤーが目標到達する可能性に備える（自分の手番中のみ勝利が確定する）。
      return checkVictory(next, pid);
    }

    // 中立の開拓地を無償配置（自分の開拓地1つにつき1つ。通常配置ルール＝中立自身の道網接続が必要）。
    case 'TB_NEUTRAL_SETTLEMENT': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TB_NEUTRAL')
        throw new Error('TB_NEUTRAL_SETTLEMENT: not in TB_NEUTRAL phase');
      if (state.tbNeutralPending !== 'settlement')
        throw new Error('TB_NEUTRAL_SETTLEMENT: a neutral road is pending, not a settlement');
      const { owner, vertexId } = action;
      if (!isTbNeutral(state, owner)) throw new Error('TB_NEUTRAL_SETTLEMENT: owner is not a neutral player');
      if (!canBuildSettlement(state, owner, vertexId)) throw new Error('TB_NEUTRAL_SETTLEMENT: invalid placement');

      let next = buildSettlement(state, owner, vertexId);
      next = { ...next, turnPhase: 'TRADE_BUILD', tbNeutralPending: null };
      // 中立の開拓地は相手の交易路を分断しうる → 分断の結果、手番プレイヤーが最長交易路タイルを
      // 得て目標到達する可能性がある（相手が得た場合は相手の手番開始時に勝利宣言される）。
      next = updateLongestRoad(next);
      return checkVictory(next, pid);
    }

    // 表向き騎士カード1枚を捨てて trade token 2（1ターン1回・最大騎士力タイルを失いうる）。
    case 'TB_DISCARD_KNIGHT': {
      if (!state.tbCatanForTwo) throw new Error('TB_DISCARD_KNIGHT: not a Catan for Two game');
      if (!tbCanSpendWindow(state))
        throw new Error('TB_DISCARD_KNIGHT: only before rolling or during the action phase');
      if (state.tbKnightTokenThisTurn) throw new Error('TB_DISCARD_KNIGHT: already used this turn');
      const player = state.players[pid]!;
      if (player.knightsPlayed < 1) throw new Error('TB_DISCARD_KNIGHT: no faceup knight card');
      if ((state.tbTradeTokenBank ?? 0) < 1) throw new Error('TB_DISCARD_KNIGHT: trade token supply is empty');

      let next: GameState = {
        ...state,
        players: { ...state.players, [pid]: { ...player, knightsPlayed: player.knightsPlayed - 1 } },
        tbKnightTokenThisTurn: true,
      };
      next = tbGrantTokens(next, pid, TB2_TOKENS_KNIGHT_DISCARD);
      // 捨てた結果、最大騎士力タイルを失いうる（CN3089 p7）。奪取側の3枚下限は updateLargestArmy が担保。
      return updateLargestArmy(next);
    }

    // trade token 消費: 強制交易（相手の手札から無作為2枚⇄自分の任意2枚。1ターン1回）。
    case 'TB_FORCED_TRADE': {
      if (!state.tbCatanForTwo) throw new Error('TB_FORCED_TRADE: not a Catan for Two game');
      if (!tbCanSpendWindow(state))
        throw new Error('TB_FORCED_TRADE: only before rolling or during the action phase');
      if (state.tbTradeTokenSpentThisTurn) throw new Error('TB_FORCED_TRADE: already spent tokens this turn');
      const opp = tbTwoOpponent(state, pid);
      if (!opp) throw new Error('TB_FORCED_TRADE: no opponent');
      const me = state.players[pid]!;
      const other = state.players[opp]!;
      const cost = tbSpendCost(state, pid);
      if (((state.tbTradeTokens ?? {})[pid] ?? 0) < cost)
        throw new Error('TB_FORCED_TRADE: not enough trade tokens');
      // 渡す2枚の検証（既知資源のみ集計＝LAN不正ペイロードで NaN を作らせない）。
      const give = action.give as Partial<Record<ResourceType, number>>;
      const giveSum = RESOURCE_TYPES.reduce((s, r) => s + (give[r] ?? 0), 0);
      const withinHand = RESOURCE_TYPES.every(r => (give[r] ?? 0) >= 0 && (give[r] ?? 0) <= me.hand[r]);
      if (giveSum !== TB2_FORCED_TRADE_GIVE || !withinHand)
        throw new Error('TB_FORCED_TRADE: must give exactly 2 cards from your hand');
      const oppTotal = RESOURCE_TYPES.reduce((s, r) => s + other.hand[r], 0);
      // 相手の手札が0枚なら使用不可（"take" の対象が無い。仕様書§2-4 実装解釈）。
      if (oppTotal < 1) throw new Error('TB_FORCED_TRADE: opponent has no cards to take');

      // 無作為に取る枚数は2（相手が1枚なら1）。交換前の相手の手札から非復元抽選する。
      const takeCount = Math.min(TB2_FORCED_TRADE_TAKE, oppTotal);
      const pool: ResourceType[] = [];
      for (const r of RESOURCE_TYPES) for (let i = 0; i < other.hand[r]; i++) pool.push(r);
      const taken: ResourceType[] = [];
      for (let i = 0; i < takeCount; i++) {
        const idx = Math.floor(rng() * pool.length);
        taken.push(pool[idx]!);
        pool.splice(idx, 1);
      }

      const myHand = { ...me.hand };
      const oppHand = { ...other.hand };
      for (const r of RESOURCE_TYPES) {
        myHand[r] -= give[r] ?? 0;
        oppHand[r] += give[r] ?? 0;
      }
      for (const r of taken) {
        myHand[r] += 1;
        oppHand[r] -= 1;
      }
      return {
        ...state,
        players: {
          ...state.players,
          [pid]: { ...me, hand: myHand },
          [opp]: { ...other, hand: oppHand },
        },
        tbTradeTokens: { ...(state.tbTradeTokens ?? {}), [pid]: ((state.tbTradeTokens ?? {})[pid] ?? 0) - cost },
        tbTradeTokenBank: (state.tbTradeTokenBank ?? 0) + cost, // 消費トークンは供給へ戻す
        tbTradeTokenSpentThisTurn: true,
      };
    }

    // trade token 消費: 盗賊を砂漠へ（誰からも奪わない。1ターン1回）。
    case 'TB_MOVE_ROBBER': {
      if (!state.tbCatanForTwo) throw new Error('TB_MOVE_ROBBER: not a Catan for Two game');
      if (!tbCanSpendWindow(state))
        throw new Error('TB_MOVE_ROBBER: only before rolling or during the action phase');
      if (state.tbTradeTokenSpentThisTurn) throw new Error('TB_MOVE_ROBBER: already spent tokens this turn');
      if (state.useRobber === false) throw new Error('TB_MOVE_ROBBER: robber is not used in this scenario');
      const cost = tbSpendCost(state, pid);
      if (((state.tbTradeTokens ?? {})[pid] ?? 0) < cost)
        throw new Error('TB_MOVE_ROBBER: not enough trade tokens');
      const deserts = Object.values(state.tiles).filter(t => t.type === 'desert');
      if (deserts.length === 0) throw new Error('TB_MOVE_ROBBER: no desert on this board');
      // 盗賊が既にいずれかの砂漠に居るなら移動先が無い＝使用不可（仕様書§2-4 実装解釈）。
      if (deserts.some(d => d.hasRobber)) throw new Error('TB_MOVE_ROBBER: robber is already on the desert');

      const next = moveRobber(state, deserts[0]!.id);
      return {
        ...next,
        tbTradeTokens: { ...(next.tbTradeTokens ?? {}), [pid]: ((next.tbTradeTokens ?? {})[pid] ?? 0) - cost },
        tbTradeTokenBank: (next.tbTradeTokenBank ?? 0) + cost, // 消費トークンは供給へ戻す
        tbTradeTokenSpentThisTurn: true,
      };
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
        // 盗賊凍結: CKは初回襲来前、S7（useRobber=false）は常に盗賊不使用 → 捨て後は TRADE_BUILD。
        const robberFrozen = (isCk(next) && (next.barbarianAttacks ?? 0) < 1) || next.useRobber === false;
        next = { ...next, turnPhase: robberFrozen ? 'TRADE_BUILD' : 'ROBBER', discardedThisRound: [] };
        // Catan for Two × 盗賊不使用の保険: 捨て札で出目の解決が完結するなら2回目の生産へ
        // （通常は ROBBER → MOVE_ROBBER 側のフックが担う。TRADE_BUILD 以外では no-op）。
        next = tbTwoAfterRollResolved(next);
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

      // 交易と蛮族「Catan for Two」: 中立プレイヤーからは奪えない（手札を持たない盤上だけの存在）。
      if (stealFromPlayerId != null && state.players[stealFromPlayerId]?.type === 'neutral')
        throw new Error('MOVE_ROBBER: cannot steal from a neutral player');

      // 強盗は陸タイルのみ（海は海賊の領分）。これが無いと盗賊が海上で空振りになる。
      if (state.tiles[tileId]?.type === 'sea') throw new Error('MOVE_ROBBER: robber cannot move onto a sea tile (use the pirate)');
      // S5 忘れられた部族: 盗賊は数字ディスクのあるヘクスにしか動かせない（砂漠等の無数字ヘックス不可）。
      if (state.numberHexOnly && state.tiles[tileId]?.number == null) throw new Error('MOVE_ROBBER: robber can only move to a numbered hex in this scenario');
      const currentRobberTileId = Object.keys(state.tiles).find(tid => state.tiles[tid]!.hasRobber);
      // 交易と蛮族「親切な盗賊」(CN3089 p3): 公開VP2以下のプレイヤーの建物があるヘックスへは移動不可。
      // 合法ヘックスが無ければ砂漠のみ許可（getRobberMoveTargets が砂漠フォールバックまで解決する）。
      const friendlyTargets = state.friendlyRobber ? getRobberMoveTargets(state) : null;
      if (friendlyTargets && !friendlyTargets.includes(tileId))
        throw new Error('MOVE_ROBBER: the friendly robber cannot move to a hex with a building of a player with only 2 VP');
      // 強盗は必ず現在地とは別ヘクスへ移動する（標準ルール）。
      // 例外: 親切な盗賊の砂漠フォールバックで盗賊が既に砂漠に居る場合のみ「その場に留まる」を許す。
      if (currentRobberTileId === tileId && !friendlyTargets?.includes(tileId))
        throw new Error('MOVE_ROBBER: must move to a different tile');

      let next = moveRobber(state, tileId);

      // 強奪は必須: 移動先タイルに隣接し手札を持つ相手がいるなら、必ずその中の1人から盗む
      // （『盗まない』選択は不可。標準ルール）。隣接相手が全員0枚 or 不在なら盗まずに済む。
      // 親切な盗賊: 公開VP2以下の相手は強奪対象外（公式: "more than 2 VPs" からのみ。砂漠フォールバック時に効く）。
      const robbable = getRobbablePlayerIds(next, tileId, pid)
        .filter(p => robbableCardCount(next, p) > 0)
        .filter(p => !state.friendlyRobber || !isFriendlyRobberProtected(next, p));
      if (stealFromPlayerId != null) {
        // 盗む相手は「移動先タイルに隣接する建物を持つ相手」に限る（盤面と無関係な強奪を防ぐ）。
        if (!getRobbablePlayerIds(next, tileId, pid).includes(stealFromPlayerId))
          throw new Error('MOVE_ROBBER: steal target is not adjacent to the robber tile');
        // 親切な盗賊: 保護対象（公開VP2以下）を指定した強奪は不可。
        if (state.friendlyRobber && isFriendlyRobberProtected(next, stealFromPlayerId))
          throw new Error('MOVE_ROBBER: the friendly robber does not steal from a player with only 2 VP');
        // 手札持ちの相手がいるなら、手札0枚の相手を指定して強奪を踏み倒すことはできない。
        if (robbable.length > 0 && !robbable.includes(stealFromPlayerId))
          throw new Error('MOVE_ROBBER: must steal from an adjacent opponent who holds cards');
        next = stealResource(next, pid, stealFromPlayerId, rng);
      } else if (robbable.length > 0) {
        throw new Error('MOVE_ROBBER: must steal from an adjacent opponent who holds cards');
      }

      // 騎士カードをダイス前に使った場合はPRE_ROLLへ戻る（ダイスをまだ振っていない）
      // Catan for Two: 1回目の7の解決がここで完結したら、2回目の生産フェーズ（PRE_ROLL）へ。
      const nextPhase = state.diceRolledThisTurn ? 'TRADE_BUILD' : 'PRE_ROLL';
      return tbTwoAfterRollResolved({ ...next, turnPhase: nextPhase });
    }

    // ----------------------------------------------------------
    // MOVE_PIRATE（航海者・海賊＝盗賊の海版）。7/騎士で盗賊の代わりに動かせる。
    // ----------------------------------------------------------
    case 'MOVE_PIRATE': {
      if (state.turnPhase !== 'ROBBER') throw new Error('MOVE_PIRATE: not in ROBBER phase');
      // S6 カタンの織物: 海賊は「最初の村接続」が出来るまで動かせない（公式）。それまでは盗賊(陸)のみ。
      if (state.villages && !Object.values(state.villageConn ?? {}).some(arr => arr.length > 0))
        throw new Error('MOVE_PIRATE: pirate is frozen until the first village connection (S6)');
      const { tileId, stealFromPlayerId } = action;
      const tile = state.tiles[tileId];
      if (!tile || tile.type !== 'sea') throw new Error('MOVE_PIRATE: must target a sea tile');
      if (state.piratePosition === tileId) throw new Error('MOVE_PIRATE: must move to a different tile');

      let next = movePirate(state, tileId);

      // S6 カタンの織物: 海賊移動時は「資源か織物」を強奪（公式）。村のある盤でのみ織物を含める。
      const stealsCloth = !!state.villages;
      const countFn = stealsCloth ? pirateRobbableCount : robbableCardCount;
      // 強奪は必須（盗賊と同様）: 海賊タイルに隣接して船を持ち手札のある相手がいるなら必ず盗む。
      const pirateRobbable = getPirateRobbablePlayerIds(next, tileId, pid).filter(p => countFn(next, p) > 0);
      if (stealFromPlayerId != null) {
        // 盗む相手は「海賊タイルに隣接する船を持つ相手」に限る。
        if (!getPirateRobbablePlayerIds(next, tileId, pid).includes(stealFromPlayerId))
          throw new Error('MOVE_PIRATE: steal target has no ship adjacent to the pirate tile');
        if (pirateRobbable.length > 0 && !pirateRobbable.includes(stealFromPlayerId))
          throw new Error('MOVE_PIRATE: must steal from an adjacent ship owner who holds cards');
        next = stealsCloth
          ? stealResourceOrCloth(next, pid, stealFromPlayerId, rng)
          : stealResource(next, pid, stealFromPlayerId, rng);
      } else if (pirateRobbable.length > 0) {
        throw new Error('MOVE_PIRATE: must steal from an adjacent ship owner who holds cards');
      }

      // 織物強奪は VP を動かしうる（2枚=1VP）ため勝利判定（資源のみなら no-op 相当）。
      if (stealsCloth) {
        next = checkVictory(next, pid);
        if (next.phase === 'GAME_OVER') return next;
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
      // Catan for Two: 中立コマの配置待ち中は自分の建設を差し込めない（街道建設カードの
      // 無料道が残っていても、先に TB_NEUTRAL_ROAD/SETTLEMENT で中立の配置を解決する）。
      if (state.turnPhase === 'TB_NEUTRAL')
        throw new Error('BUILD_ROAD: resolve the pending neutral placement first');
      if (!_isSetup && !_isRoadBuilding && state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_ROAD: must be in TRADE_BUILD, setup, or road building phase');
      if (!canBuildRoad(state, pid, edgeId)) throw new Error('BUILD_ROAD: invalid');

      let next = buildRoad(state, pid, edgeId);
      // S3 霧の島: 道の隣接ヘックスを探索公開（霧の無い盤では no-op）。SETUP は無償報酬なし（只取り防止）。
      next = revealFogAround(next, edgeTileIds(next.edges[edgeId]!, next.vertices), pid, !_isSetup);
      // 大カタン: 道で小島タイルの端に到達したら数値トークン出現（無い盤では no-op）。
      next = revealPendingNumbers(next, edgeTileIds(next.edges[edgeId]!, next.vertices));
      // オアシス: 道で財宝の辺に到達したら獲得（資源＋発展カード等）。財宝の無い盤では no-op。
      // セットアップの無償の初期道で財宝/開発カードを只取りできないよう、SETUP 中は獲得しない。
      if (!_isSetup) next = collectEdgeToken(next, edgeId, pid);
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

      // 交易と蛮族「Catan for Two」: MAIN で道を建てるたび、中立の道1本を無償配置（CN3089 p7）。
      // どちらの中立にも合法位置が無ければスキップ。勝利確定（GAME_OVER）後は発動しない。
      if (state.phase === 'MAIN' && next.phase === 'MAIN' && next.tbCatanForTwo) {
        const pendingNeutral = tbNeutralPendingAfterRoad(next);
        if (pendingNeutral) next = { ...next, turnPhase: 'TB_NEUTRAL', tbNeutralPending: pendingNeutral };
      }

      return next;
    }

    // ----------------------------------------------------------
    // BUILD_SHIP（航海者拡張）。道と同じ進行・最長交易路再計算に乗せる。
    // ----------------------------------------------------------
    case 'BUILD_SHIP': {
      const { edgeId } = action;
      const _isSetupSh = state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD';
      // Catan for Two: 中立コマの配置待ち中は自分の建設を差し込めない（防御的。基本盤に船は無い）。
      if (state.turnPhase === 'TB_NEUTRAL')
        throw new Error('BUILD_SHIP: resolve the pending neutral placement first');
      if (!_isSetupSh && state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_SHIP: must be in TRADE_BUILD or setup phase');
      if (!canBuildShip(state, pid, edgeId)) throw new Error('BUILD_SHIP: invalid');

      let next = buildShip(state, pid, edgeId);
      // 建てたばかりの船は同じターンに移動できない（航海者の標準ルール）。建設した辺を記録。
      next = { ...next, shipsBuiltThisTurn: [...(next.shipsBuiltThisTurn ?? []), edgeId] };
      // S3 霧の島: 船の隣接ヘックスを探索公開（霧→陸なら資源1枚）。霧の無い盤では no-op。SETUP は無償報酬なし。
      next = revealFogAround(next, edgeTileIds(next.edges[edgeId]!, next.vertices), pid, !_isSetupSh);
      // 大カタン: 船で小島タイルの端に到達したら数値トークン出現（無い盤では no-op）。
      next = revealPendingNumbers(next, edgeTileIds(next.edges[edgeId]!, next.vertices));
      // S5 忘れられた部族: この辺に海辺トークンがあれば獲得（VP/開発カード/港）。無い盤では no-op。
      // セットアップの無償の初期船で財宝/トークンを只取りできないよう、SETUP 中は獲得しない。
      if (!_isSetupSh) next = collectEdgeToken(next, edgeId, pid);
      // S6 カタンの織物: この辺が村に隣接していれば航路接続（接続成立で即織物1枚）。無い盤では no-op。
      next = connectVillagesAround(next, edgeId, pid);
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);
      next = checkClothEnd(next); // S6: 5村供給切れで終了（無い盤では no-op）

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
      // 大カタン: 船の移動先で小島タイルの端に到達したら数値トークン出現（無い盤では no-op）。
      next = revealPendingNumbers(next, edgeTileIds(next.edges[toEdgeId]!, next.vertices));
      // S5 忘れられた部族: 移動先の辺に海辺トークンがあれば獲得。無い盤では no-op。
      next = collectEdgeToken(next, toEdgeId, pid);
      // S6 カタンの織物: 移動先が村に隣接していれば航路接続（無い盤では no-op）。
      next = connectVillagesAround(next, toEdgeId, pid);
      next = updateLongestRoad(next);
      next = checkVictory(next, pid);
      next = checkClothEnd(next);
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
      // S3 霧の島: 開拓地の隣接ヘックスを探索公開（霧の無い盤では no-op）。SETUP は無償報酬なし
      // （只取り防止＋最後の初期開拓地で reveal報酬と setupGainFor の二重取得を防ぐ）。
      next = revealFogAround(next, next.vertices[vertexId]!.adjacentTileIds, pid, !_isSetupS);
      // 大カタン: 開拓地が小島タイルに隣接したら数値トークン出現（無い盤では no-op）。
      next = revealPendingNumbers(next, next.vertices[vertexId]!.adjacentTileIds);
      // S5 忘れられた部族: 港トークンを保留していれば、この沿岸開拓地に設置（無ければ no-op）。
      next = placeHeldHarborAt(next, pid, vertexId);

      // 交易と蛮族「Catan for Two」: 砂漠に隣接する開拓地=trade token 2・沿岸=1（両方なら3）。
      // 初期配置の開拓地も対象（CN3089 p7 CHANGES TO SETUP）。供給残で頭打ち。
      // 中立の開拓地は TB_NEUTRAL_SETTLEMENT 経由でここを通らない（トークンは実プレイヤーのみ）。
      if (next.tbCatanForTwo) next = tbGrantTokens(next, pid, tbTokensForSettlement(next, vertexId));

      // SETUP の「最後の開拓地」で初期資源を配る。標準/航海者は2軒目、S6 織物は3軒目。
      // 公式: 最後の1軒の隣接タイルから資源を取得（それ以前の軒は資源なし）。
      // 配置数は全建物で数える（CK は2軒目を都市へ昇格させるため）。
      const setupTarget = state.startingSettlements ?? 2;
      const placedNow = Object.values(next.vertices).filter(v => v.building?.playerId === pid).length;
      const isLastSetupPlacement = _isSetupS && placedNow >= setupTarget;
      if (isLastSetupPlacement && isCk(state)) {
        // 騎士と商人: 2個目は「都市」。開拓地→都市へ昇格し、都市の初期産出(資源+商品)を配る。
        next = ckSetupSecondCity(next, pid, vertexId);
      } else if (isLastSetupPlacement) {
        // 基本/航海者: 最後の開拓地の隣接タイルから初期資源を配布（setupGainFor に一本化）。
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

      // 砂漠を越えて: 「北西地方」（地域ボーナス対象タイル）へ初入植したら +regionBonusVp（各自1回）。
      // 北西地方は砂漠帯で本島と陸続き＝SETUP でも初期配置しうるため、付与は phase 非依存にする
      //（MAIN 限定だと SETUP で北西に初期配置した人がボーナスを取り逃す）。checkVictory より前に付与。
      if (next.bonusRegionTiles && (next.regionBonusVp ?? 0) > 0) {
        const claimed = next.regionBonus ?? [];
        const touchesRegion = next.vertices[vertexId]!.adjacentTileIds.some(t => next.bonusRegionTiles!.includes(t));
        if (touchesRegion && !claimed.includes(pid)) {
          next = { ...next, regionBonus: [...claimed, pid] };
        }
      }

      // 開拓地が相手の道路を分断した場合に最長道路ボーナスを再計算する。
      // SETUP では道が短く no-op、MAIN でのみ意味を持つ（BUILD_ROAD と同順序）。
      next = updateLongestRoad(next);
      next = updateStrongestPorts(next); // 交易と蛮族「強き港」: 港上の建物が増えたので再計算（無効シナリオでは no-op）
      next = checkVictory(next, pid);

      // 交易と蛮族「Catan for Two」: MAIN で開拓地を建てるたび、中立の開拓地1つを無償配置。
      // 両中立とも合法位置が無ければ中立の道1本で代替、それも無ければスキップ（CN3089 p7）。
      if (state.phase === 'MAIN' && next.phase === 'MAIN' && next.tbCatanForTwo) {
        const pendingNeutral = tbNeutralPendingAfterSettlement(next);
        if (pendingNeutral) next = { ...next, turnPhase: 'TB_NEUTRAL', tbNeutralPending: pendingNeutral };
      }

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
      next = updateStrongestPorts(next); // 交易と蛮族「強き港」: 港上の開拓地→都市で港VPが増えるので再計算（無効シナリオでは no-op）
      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // BUILD_WONDER（航海者 S8 七不思議）。不思議のレベルを1段建設（必要ならクレーム）。
    // ----------------------------------------------------------
    case 'BUILD_WONDER': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('BUILD_WONDER: must be in MAIN TRADE_BUILD phase');
      const { wonderId } = action;
      if (!canBuildWonder(state, pid, wonderId)) throw new Error('BUILD_WONDER: invalid');
      let next = buildWonder(state, pid, wonderId);
      next = checkVictory(next, pid);
      return next;
    }

    // ----------------------------------------------------------
    // ATTACK_FORTRESS（航海者 S7 海賊の島々）。隣接する自分の要塞をラホ1つ分攻撃。
    // ----------------------------------------------------------
    case 'ATTACK_FORTRESS': {
      if (state.phase !== 'MAIN' || state.turnPhase !== 'TRADE_BUILD')
        throw new Error('ATTACK_FORTRESS: must be in MAIN TRADE_BUILD phase');
      if (!canAttackFortress(state, pid)) throw new Error('ATTACK_FORTRESS: invalid');
      let next = attackFortress(state, pid);
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
      // 交易と蛮族「Catan for Two」: 2つの生産フェーズの間（1回目解決後の PRE_ROLL）では
      // 騎士カードを使えない（公式: 生産フェーズは "one after the other" で続けて行う）。
      if (state.tbCatanForTwo && state.turnPhase === 'PRE_ROLL' && (state.tbRollsDone ?? 0) > 0)
        throw new Error('PLAY_KNIGHT: cannot play between the two production phases');
      if (state.devCardPlayedThisTurn) throw new Error('PLAY_KNIGHT: already played a dev card this turn');
      const player = state.players[pid]!;
      const cardIdx = player.devCards.findIndex(
        c => c.type === 'knight' && c.purchasedOnTurn < state.globalTurnNumber,
      );
      if (cardIdx === -1) throw new Error('PLAY_KNIGHT: no playable knight card');

      const newCards = player.devCards.filter((_, i) => i !== cardIdx);
      const usedCard = player.devCards[cardIdx]!;

      // S7 海賊の島々: 騎士＝軍船化。起点に最も近い通常船を1隻軍船化する（盗賊・最大騎士力は無効）。
      if (state.fortresses !== undefined) {
        const warshipped = playWarship(state, pid);
        if (!warshipped) throw new Error('PLAY_KNIGHT: no normal ship to convert into a warship');
        return {
          ...warshipped,
          devCardPlayedThisTurn: true,
          devDiscardPile: [...state.devDiscardPile, usedCard],
          players: { ...warshipped.players, [pid]: { ...warshipped.players[pid]!, devCards: newCards } },
        };
      }

      // それ以外で盗賊不使用のシナリオでは騎士は使用不可（現状 S7 以外に該当なし・防御的）。
      if (state.useRobber === false) throw new Error('PLAY_KNIGHT: knights are disabled in this scenario');

      // 通常（盗賊版）: 「盗賊か海賊を動かす」フェーズへ。最大騎士力を再計算。
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

      // 航海者: 街道建設カードは「道2／船2／道1+船1」のいずれか。無料配置できる本数は
      // 道コマ在庫だけでなく船コマ在庫も加味する（海のある盤のみ。基本ゲームは海辺が無く
      // 船を置けないので船在庫は数えない＝従来挙動を維持）。各配置時の在庫は
      // canBuildRoad/canBuildShip がそれぞれ remainingRoads/remainingShips で担保する。
      const hasSeaForRb = Object.values(state.tiles).some(t => t.type === 'sea');
      const freePieces = player.remainingRoads + (hasSeaForRb ? (player.remainingShips ?? 0) : 0);
      const roadsAvailable = Math.min(2, freePieces);
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
        // Catan for Two: 中立プレイヤーとは交易できない（手札も応答手段も持たない）。
        if (state.players[tid]!.type === 'neutral')
          throw new Error('OFFER_TRADE: cannot trade with a neutral player');
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
        // T&B イベントカード「疫病」はそのターンの生産のみ（非対象シナリオの状態を汚さない）。
        ...(state.tbEpidemic ? { tbEpidemic: false } : {}),
        // T&B「Catan for Two」: 生産2回制・トークン1ターン1回のフラグをリセット（非対象シナリオを汚さない）。
        ...(state.tbCatanForTwo
          ? { tbRollsDone: 0, tbFirstRollTotal: null, tbTradeTokenSpentThisTurn: false, tbKnightTokenThisTurn: false }
          : {}),
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
  // 初期配置の開拓地数（既定2。S6 織物=3）。スネークドラフトを target ラウンド繰り返す。
  const target = state.startingSettlements ?? 2;
  const round = state.setupRound ?? 1; // 現在のラウンド番号（1始まり）。

  const toMain: GameState = {
    ...state,
    phase: 'MAIN',
    turnPhase: 'PRE_ROLL',
    currentPlayerIndex: 0,
    setupSubPhase: null,
    diceRolledThisTurn: false,
    devCardPlayedThisTurn: false,
  };

  if (state.phase === 'SETUP_FORWARD') {
    if (idx < total - 1) {
      // 同一ラウンド内: 次のプレイヤーへ
      return { ...state, currentPlayerIndex: idx + 1, setupSubPhase: 'PLACE_SETTLEMENT' };
    }
    // 順方向ラウンドの最後のプレイヤー。目標ラウンドに達していたら終了、未達なら逆方向へ折り返す（同プレイヤー続行）。
    if (round >= target) return toMain;
    return { ...state, phase: 'SETUP_BACKWARD', setupRound: round + 1, setupSubPhase: 'PLACE_SETTLEMENT' };
  }

  if (state.phase === 'SETUP_BACKWARD') {
    if (idx > 0) {
      return { ...state, currentPlayerIndex: idx - 1, setupSubPhase: 'PLACE_SETTLEMENT' };
    }
    // 逆方向ラウンドの先頭プレイヤー。目標ラウンドに達したら MAIN、未達なら3軒目以降の順方向ラウンドへ（同プレイヤー続行）。
    if (round >= target) return toMain;
    return { ...state, phase: 'SETUP_FORWARD', setupRound: round + 1, setupSubPhase: 'PLACE_SETTLEMENT' };
  }

  return state;
}
