// ============================================================
// src/engine/tbEvents.ts — 交易と蛮族「イベントカード(Catan Event Cards)」変種
// ============================================================
// 公式ルールブック第6版 CN3089 p4-6 準拠。
//   - 生産フェーズで赤黄ダイスの代わりにイベントデッキの一番上をめくる。
//   - イベント効果を解決 → カードの数字ディスク値で「資源生産」または「7の解決」。
//   - New Year でデッキ再構築（36枚シャッフル→5枚を底へ→New Year→残り31枚を上へ）。
// ここには「デッキ構築」と「イベント効果の適用（保留フェーズへの遷移含む）」を置く。
// めくり・生産への接続は game.ts の ROLL_DICE が行う。

import type { GameState, PlayerId, TbEventCard } from '../types';
import { TB_EVENT_DECK_BOTTOM } from '../constants';
import { shuffle } from './setup';
import { capPicksByBank } from './dice';
import { calcPublicVP } from './scoring';
import { moveRobber, robbableCardCount, handTotal } from './robber';

// ============================================================
// デッキ構築
// ============================================================

/**
 * イベントデッキを作成する（先頭=一番上）。
 * 公式手順（CN3089 p5 CHANGES TO SETUP）:
 *   1. New Year を除く36枚をシャッフル → 2. 5枚を裏で底に置く →
 *   3. その上に New Year → 4. 残り31枚をその上に積む。
 * ＝ New Year より下の5枚はそのゲームでは使われない（めくる前に再構築が起きる）。
 */
export function buildTbEventDeck(cards36: readonly TbEventCard[], rng: () => number): TbEventCard[] {
  const shuffled = shuffle(cards36, rng);
  const bottom = shuffled.slice(0, TB_EVENT_DECK_BOTTOM);
  const rest = shuffled.slice(TB_EVENT_DECK_BOTTOM);
  return [...rest, { event: 'new_year', number: null }, ...bottom];
}

// ============================================================
// 参照ヘルパー（UI/AI からも使う）
// ============================================================

/** 左隣のプレイヤー（手番は playerOrder 順=時計回りに進む＝次のプレイヤーが左隣）。 */
export function tbLeftNeighbor(state: GameState, playerId: PlayerId): PlayerId {
  const i = state.playerOrder.indexOf(playerId);
  return state.playerOrder[(i + 1) % state.playerOrder.length]!;
}

/** 港（harborType のある頂点）上の自建物の「個数」（CALM SEAS は VP でなく建物数で判定）。 */
export function tbPortBuildingCount(state: GameState, playerId: PlayerId): number {
  let n = 0;
  for (const v of Object.values(state.vertices)) {
    if (v.harborType != null && v.building?.playerId === playerId) n++;
  }
  return n;
}

/**
 * CONFLICT の奪う側。最大騎士力タイル保持者（必須= optional:false）。
 * 居なければ「表向き騎士カードが全員より多い単独者」（原文 "may steal" ＝任意= optional:true）。
 * 同数最多が複数居る場合や誰も騎士を出していない場合は不成立（null）。
 */
export function tbConflictChooser(state: GameState): { playerId: PlayerId; optional: boolean } | null {
  if (state.largestArmyHolder) return { playerId: state.largestArmyHolder, optional: false };
  let best: PlayerId | null = null;
  let bestN = 0;
  let tie = false;
  for (const pid of state.playerOrder) {
    const n = state.players[pid]!.knightsPlayed;
    if (n > bestN) { best = pid; bestN = n; tie = false; }
    else if (n === bestN && n > 0) tie = true;
  }
  return best != null && !tie && bestN > 0 ? { playerId: best, optional: true } : null;
}

/** EVENT_STEAL で奪える相手（奪う側以外で札を1枚以上持つプレイヤー）。 */
export function tbEventStealTargets(state: GameState): PlayerId[] {
  const chooser = state.tbPendingEventSteal?.playerId;
  if (!chooser) return [];
  return state.playerOrder.filter(p => p !== chooser && robbableCardCount(state, p) > 0);
}

/** いまのイベント選択フェーズで未解決のプレイヤー一覧（フェーズ外・対象なしは空）。UI/CPU 駆動用。 */
export function tbEventPendingIds(state: GameState): PlayerId[] {
  if (state.phase !== 'MAIN') return [];
  if (state.turnPhase === 'EVENT_GIVE') return Object.keys(state.tbPendingEventGive ?? {}) as PlayerId[];
  if (state.turnPhase === 'EVENT_HELPFUL') return state.tbPendingEventHelpful ?? [];
  if (state.turnPhase === 'EVENT_STEAL') return state.tbPendingEventSteal ? [state.tbPendingEventSteal.playerId] : [];
  if (state.turnPhase === 'EVENT_DAMAGE') return state.tbPendingEventDamage ?? [];
  return [];
}

/** EARTHQUAKE で道を損傷させる義務のあるプレイヤー（未損傷の自分の道を1本以上持つ）。 */
export function tbDamageablePlayers(state: GameState): PlayerId[] {
  return state.playerOrder.filter(pid =>
    Object.values(state.edges).some(e => e.road?.playerId === pid && !e.road.damaged));
}

/** 指定プレイヤーの損傷中の道の辺ID一覧（修理対象）。 */
export function tbDamagedRoadEdges(state: GameState, playerId: PlayerId): string[] {
  return Object.values(state.edges)
    .filter(e => e.road?.playerId === playerId && e.road.damaged)
    .map(e => e.id);
}

/** 損傷した道を1本でも持つか（修理するまで自分の道の追加建設不可・CN3089 p5）。 */
export function tbHasDamagedRoad(state: GameState, playerId: PlayerId): boolean {
  return Object.values(state.edges).some(e => e.road?.playerId === playerId && e.road.damaged);
}

/** その頂点が損傷した道（誰のものでも）に隣接しているか（開拓地建設不可・CN3089 p5）。 */
export function tbVertexBlockedByDamagedRoad(state: GameState, vertexId: string): boolean {
  const vertex = state.vertices[vertexId];
  if (!vertex) return false;
  return vertex.adjacentEdgeIds.some(eid => state.edges[eid]?.road?.damaged === true);
}

/** 盗賊を盤外へ（ROBBER FLEES で砂漠が無い盤・CN3089 p6 "move the robber off the board"）。 */
export function tbRemoveRobberFromBoard(state: GameState): GameState {
  const tiles = { ...state.tiles };
  for (const [tid, t] of Object.entries(tiles)) {
    if (t.hasRobber) tiles[tid] = { ...t, hasRobber: false };
  }
  return { ...state, tiles };
}

// ============================================================
// イベント効果の適用
// ============================================================

/** 対象プレイヤー各1枚の「供給から任意資源」選択へ（GOLD フェーズを流用。バンク在庫で頭打ち）。 */
function tbEnterSupplyPick(state: GameState, playerIds: PlayerId[]): GameState {
  const raw: Record<string, number> = {};
  for (const pid of playerIds) raw[pid] = 1;
  const picks = capPicksByBank(state, raw);
  return Object.keys(picks).length > 0
    ? { ...state, turnPhase: 'GOLD', pendingGoldChoice: picks }
    : state;
}

/**
 * めくったイベントカードの効果を適用する（CN3089 p5-6 CARD LIST）。
 * 即時効果はその場で適用し、プレイヤーの選択が要る効果は保留フェーズ
 * （EVENT_GIVE / EVENT_HELPFUL / EVENT_STEAL / EVENT_DAMAGE / GOLD）へ遷移して返す。
 * turnPhase が変わらずに返った場合＝選択不要（呼び出し側がそのまま生産へ進む）。
 * 選択の解決アクションと生産への復帰は game.ts 側（CHOOSE_EVENT_* ハンドラ）。
 */
export function tbApplyEventEffect(state: GameState, card: TbEventCard): GameState {
  switch (card.event) {
    // 良き日: 効果なし。通常生産。
    case 'beautiful_day':
      return state;

    // 新年: デッキ再構築は game.ts のめくり時に処理する（効果としてここへは来ない）。
    case 'new_year':
      return state;

    // 盗賊の襲撃: 「7として解決」＝このカードの数字ディスク(7)の解決そのもの。効果は無し。
    // （全 robber_attacks カードの数字が7であることはデータ側のテストで固定する）
    case 'robber_attacks':
      return state;

    // 疫病: 今回の生産では都市も資源1枚のみ（END_TURN でリセット）。
    case 'epidemic':
      return { ...state, tbEpidemic: true };

    // 盗賊の逃走: 盗賊を砂漠へ（誰からも奪わない）。砂漠が無ければ盤外へ。
    case 'robber_flees': {
      const desert = Object.values(state.tiles).find(t => t.type === 'desert');
      return desert ? moveRobber(state, desert.id) : tbRemoveRobberFromBoard(state);
    }

    // 豊作の年: 各自 供給から任意資源1枚。
    case 'plentiful_year':
      return tbEnterSupplyPick(state, state.playerOrder);

    // 穏やかな海: 港上の建物「数」最多のプレイヤー（同数は全員）が供給から任意資源1枚。
    case 'calm_seas': {
      const counts = state.playerOrder.map(p => tbPortBuildingCount(state, p));
      const max = Math.max(...counts);
      if (max <= 0) return state; // 誰も港上に建物なし＝効果なし
      return tbEnterSupplyPick(state, state.playerOrder.filter((_, i) => counts[i] === max));
    }

    // 馬上槍試合: 表向き騎士カード最多のプレイヤー（同数は全員）が供給から任意資源1枚。
    case 'tournament': {
      const counts = state.playerOrder.map(p => state.players[p]!.knightsPlayed);
      const max = Math.max(...counts);
      if (max <= 0) return state; // 誰も騎士カードを出していない＝効果なし
      return tbEnterSupplyPick(state, state.playerOrder.filter((_, i) => counts[i] === max));
    }

    // 良き隣人: 各自 左隣へ任意資源1枚（資源が無ければ渡さなくてよい）。
    case 'good_neighbors': {
      const give: Record<string, PlayerId> = {};
      for (const pid of state.playerOrder) {
        if (handTotal(state, pid) > 0) give[pid] = tbLeftNeighbor(state, pid);
      }
      return Object.keys(give).length > 0
        ? { ...state, turnPhase: 'EVENT_GIVE', tbPendingEventGive: give }
        : state;
    }

    // 親切な隣人: 公開VP最多のプレイヤー（同点は全員）が「より少ない者」へ任意資源1枚。
    // VPは公開VP（隠し勝利点カード除外）＝親切な盗賊と同じ理由（非公開手札の逆算防止）。
    case 'helpful_neighbor': {
      const vps = state.playerOrder.map(p => calcPublicVP(state, p));
      const max = Math.max(...vps);
      const min = Math.min(...vps);
      if (max === min) return state; // 全員同VP＝「より少ない者」が居ない
      const givers = state.playerOrder.filter((p, i) => vps[i] === max && handTotal(state, p) > 0);
      return givers.length > 0
        ? { ...state, turnPhase: 'EVENT_HELPFUL', tbPendingEventHelpful: givers }
        : state;
    }

    // 衝突: 最大騎士力タイル保持者（無ければ騎士カード最多の単独者・任意）が無作為1枚強奪。
    case 'conflict': {
      const chooser = tbConflictChooser(state);
      if (!chooser) return state;
      const hasTarget = state.playerOrder.some(
        p => p !== chooser.playerId && robbableCardCount(state, p) > 0);
      if (!hasTarget) return state;
      return { ...state, turnPhase: 'EVENT_STEAL', tbPendingEventSteal: chooser };
    }

    // 交易優位: 最長交易路タイル保持者が任意プレイヤーから無作為1枚強奪。
    case 'trade_advantage': {
      const holder = state.longestRoadHolder;
      if (!holder) return state;
      const hasTarget = state.playerOrder.some(p => p !== holder && robbableCardCount(state, p) > 0);
      if (!hasTarget) return state;
      return { ...state, turnPhase: 'EVENT_STEAL', tbPendingEventSteal: { playerId: holder, optional: false } };
    }

    // 地震: 各自 自分の道1本を損傷（可能なら）。どの道かは各自が選ぶ。
    case 'earthquake': {
      const pending = tbDamageablePlayers(state);
      return pending.length > 0
        ? { ...state, turnPhase: 'EVENT_DAMAGE', tbPendingEventDamage: pending }
        : state;
    }
  }
}
