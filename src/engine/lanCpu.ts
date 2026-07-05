// ============================================================
// src/engine/lanCpu.ts — LAN混合対戦のサーバ側CPUオーケストレーション（純粋）
// ============================================================
//
// サーバ権威モデルで CPU を動かすための「次に CPU が打つ一手」を決める純粋関数。
// 既存の純粋AI（chooseAction / evaluateTradeOffer）を再利用する。
// 乱数は rng 注入（サーバ=Math.random、テスト=seed）。
//
// 方針:
//   - CPU は自分からはプレイヤー間交易を提案しない（skipPlayerTrade=true）。
//     → 人間応答待ちでのスタールを避ける（CPU→人間提案は残課題）。
//   - 人間が CPU をターゲットにした交易には CPU が承認/拒否で応答する。
//   - 捨て札・盗賊・初期配置・通常ターンは chooseAction に委譲。
//
// 単一端末のローカルCPU経路（main.ts）には一切触れない（CPU戦は無傷）。

import type { GameState, Action, PlayerId } from '../types';
import { chooseAction, evaluateTradeOffer, chooseStealTarget } from './ai';
import { discardCount, getRobberMoveTargets } from './robber';
import { canBuildSettlement, canBuildRoad } from './actions';
import { tbEventStealTargets } from './tbEvents';

export interface CpuStep {
  readonly pid: PlayerId;
  readonly action: Action;
}

const isCpu = (state: GameState, pid: PlayerId): boolean =>
  state.players[pid]?.type === 'ai';

/**
 * 現在の state で「次に動くべき CPU の一手」を返す。CPU が動く必要が無い
 * （人間の手番・人間の入力待ち・GAME_OVER）なら null。
 *
 * @param rng CPU判断のタイブレーク等に使う乱数（0..1）。
 */
export function nextCpuAction(state: GameState, rng: () => number = Math.random): CpuStep | null {
  if (state.phase === 'GAME_OVER') return null;

  // ---- 交易の応答（人間起案 → CPU ターゲット / CPU起案 → 確定）----
  const trade = state.pendingTrade;
  if (trade) {
    if (trade.state === 'TRADE_OFFER') {
      // 未応答の対象のうち先頭が CPU なら応答する。人間が先頭なら待つ。
      const pending = trade.targetPlayerIds.find(t => !trade.responses[t]);
      if (pending && isCpu(state, pending)) {
        // 受諾判断は AI の交易方策に委ねる（ローカルCPUと共通）。
        const accepts = evaluateTradeOffer(state, pending, trade.offer, trade.initiatorId);
        return { pid: pending, action: { type: 'RESPOND_TRADE', response: { playerId: pending, status: accepts ? 'ACCEPT' : 'REJECT' } } };
      }
      return null; // 人間ターゲットの応答待ち
    }
    if (trade.state === 'TRADE_RESPONSE' && isCpu(state, trade.initiatorId)) {
      // CPU起案（通常は発生しない）。承諾者がいれば成立、いなければ取消。
      const acceptor = trade.targetPlayerIds.find(t => trade.responses[t]?.status === 'ACCEPT') as PlayerId | undefined;
      return { pid: trade.initiatorId, action: acceptor ? { type: 'CONFIRM_TRADE', responderId: acceptor } : { type: 'CANCEL_TRADE' } };
    }
    return null; // 人間起案の応答収集中 / 人間の確定待ち
  }

  // ---- 捨て札（手番に関わらず 上限超の CPU を1人ずつ処理）----
  if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    // 捨て札済み(discardedThisRound)の CPU は除外する。16枚以上から半分捨てても8枚以上
    // 残るため、これが無いと同じ CPU を再選択し続け、エンジンの二重捨てガードで
    // 全アクションが拒否されてサーバの CPU 駆動が恒久停止する（デッドロック）。
    // 判定はエンジンの discardCount（騎士と商人は資源＋商品で数える）で行う。資源のみで
    // 数えると、商品込みで上限超の CPU が選ばれず捨て札フェーズが永久に終わらない（盗賊へ進めない）。
    const dpid = state.playerOrder.find(p =>
      isCpu(state, p)
      && !(state.discardedThisRound ?? []).includes(p)
      && discardCount(state, p) > 0,
    );
    if (dpid) {
      const action = chooseAction(state, dpid, { rng });
      if (action) return { pid: dpid, action };
    }
    return null; // 人間の捨て札待ち
  }

  // ---- 金タイル産出の選択（手番に関わらず owed な CPU を1人ずつ処理）----
  if (state.phase === 'MAIN' && state.turnPhase === 'GOLD') {
    const gpid = state.playerOrder.find(p => isCpu(state, p) && ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
    if (gpid) {
      const action = chooseAction(state, gpid, { rng });
      if (action) return { pid: gpid, action };
    }
    return null; // 人間の選択待ち
  }

  // ---- 騎士と商人: 蛮族敗北での都市格下げ（手番に関わらず対象 CPU を1人ずつ処理）----
  if (state.phase === 'MAIN' && state.turnPhase === 'CITY_DOWNGRADE') {
    const dpid = (state.pendingCityDowngrade ?? []).find(p => isCpu(state, p));
    if (dpid) {
      const action = chooseAction(state, dpid, { rng });
      if (action) return { pid: dpid, action };
    }
    return null; // 人間の選択待ち
  }

  // ---- 騎士と商人: 進歩カード上限超過（5枚目）→ 捨てる対象 CPU を1人ずつ処理 ----
  if (state.phase === 'MAIN' && state.turnPhase === 'PROGRESS_DISCARD') {
    const dpid = (state.pendingProgressDiscard ?? []).find(p => isCpu(state, p));
    if (dpid) {
      const action = chooseAction(state, dpid, { rng });
      if (action) return { pid: dpid, action };
    }
    return null; // 人間の選択待ち
  }

  // ---- 交易と蛮族「イベントカード」: イベント選択（手番に関わらず対象 CPU を1人ずつ処理）----
  if (state.phase === 'MAIN'
    && (state.turnPhase === 'EVENT_GIVE' || state.turnPhase === 'EVENT_HELPFUL'
      || state.turnPhase === 'EVENT_STEAL' || state.turnPhase === 'EVENT_DAMAGE')) {
    const pendingIds: PlayerId[] =
      state.turnPhase === 'EVENT_GIVE' ? Object.keys(state.tbPendingEventGive ?? {}) as PlayerId[]
      : state.turnPhase === 'EVENT_HELPFUL' ? (state.tbPendingEventHelpful ?? [])
      : state.turnPhase === 'EVENT_STEAL' ? (state.tbPendingEventSteal ? [state.tbPendingEventSteal.playerId] : [])
      : (state.tbPendingEventDamage ?? []);
    const epid = pendingIds.find(p => isCpu(state, p));
    if (epid) {
      const action = chooseAction(state, epid, { rng });
      if (action) return { pid: epid, action };
    }
    return null; // 人間の選択待ち
  }

  // ---- 手番が CPU なら通常の一手（初期配置 / ダイス / 盗賊 / 建設等）----
  const cur = state.playerOrder[state.currentPlayerIndex];
  if (cur && isCpu(state, cur)) {
    // CPU は自分からプレイヤー間交易を提案しない（スタール回避）
    const action = chooseAction(state, cur, { skipPlayerTrade: true, rng });
    if (action) return { pid: cur, action };
    // フォールバック: 何も選べない場合でも進行させる
    return { pid: cur, action: cpuFallbackAction(state, cur) };
  }

  return null; // 人間の手番
}

/**
 * どのフェーズでも「合法で進行する」安全な行動を1つ返す（最終手段）。
 * CPU の選択 or 適用が失敗した時に、サーバがゲームを止めないために使う。
 */
export function cpuFallbackAction(state: GameState, pid: PlayerId): Action {
  // セットアップ: 最初の合法な配置（これが無いことは通常起こらない）。
  if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
    if (state.setupSubPhase === 'PLACE_ROAD') {
      const e = Object.keys(state.edges).find(eid => canBuildRoad(state, pid, eid));
      if (e) return { type: 'BUILD_ROAD', edgeId: e };
    }
    const v = Object.keys(state.vertices).find(vid => canBuildSettlement(state, pid, vid));
    if (v) return { type: 'BUILD_SETTLEMENT', vertexId: v };
  }
  // ペンディング交易: 取り消し（CPU起案時のみ実質有効）。
  if (state.pendingTrade) return { type: 'CANCEL_TRADE' };
  if (state.turnPhase === 'PRE_ROLL') return { type: 'ROLL_DICE' };
  if (state.turnPhase === 'ROBBER') {
    const robberTile = Object.values(state.tiles).find(t => t.hasRobber)?.id;
    // 合法な移動先（陸のみ・数字限定・親切な盗賊の保護/砂漠フォールバック込み）から先頭を選ぶ。
    const tileId = getRobberMoveTargets(state)[0] ?? robberTile!;
    // 強奪は必須: 移動先に手札持ちの相手がいれば選ぶ（chooseStealTarget が 0枚・保護対象を除外・不在なら null）。
    return { type: 'MOVE_ROBBER', tileId, stealFromPlayerId: chooseStealTarget(state, tileId, pid) };
  }
  if (state.turnPhase === 'DISCARD') {
    return chooseAction(state, pid) ?? { type: 'END_TURN' };
  }
  if (state.turnPhase === 'GOLD') {
    // owed な対象本人の選択を生成（chooseAction が GOLD を処理）。最終手段として銀1枚。
    return chooseAction(state, pid) ?? { type: 'CHOOSE_GOLD', playerId: pid, resources: { wool: 1 } };
  }
  // 交易と蛮族「イベントカード」: イベント選択（chooseAction が各フェーズを処理）。
  if (state.turnPhase === 'EVENT_GIVE' || state.turnPhase === 'EVENT_HELPFUL'
    || state.turnPhase === 'EVENT_DAMAGE') {
    const a = chooseAction(state, pid);
    if (a) return a;
  }
  if (state.turnPhase === 'EVENT_STEAL') {
    const a = chooseAction(state, pid);
    if (a) return a;
    // 保険: 必須（タイル保持者）の場合でも合法になるよう、対象がいれば先頭を奪う。
    const targets = tbEventStealTargets(state);
    return targets.length > 0
      ? { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: targets[0]! }
      : { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: null };
  }
  // 交易と蛮族「Catan for Two」: 中立コマの配置待ち（エンジンは合法手がある時だけこのフェーズに入る）。
  if (state.turnPhase === 'TB_NEUTRAL') {
    const a = chooseAction(state, pid);
    if (a) return a;
    for (const n of state.tbNeutralPlayerIds ?? []) {
      if (state.tbNeutralPending === 'settlement') {
        const v = Object.keys(state.vertices).find(vid => canBuildSettlement(state, n, vid));
        if (v) return { type: 'TB_NEUTRAL_SETTLEMENT', owner: n, vertexId: v };
      } else {
        const e = Object.keys(state.edges).find(eid => canBuildRoad(state, n, eid));
        if (e) return { type: 'TB_NEUTRAL_ROAD', owner: n, edgeId: e };
      }
    }
  }
  return { type: 'END_TURN' };
}
