// ============================================================
// src/engine/wonders.ts — 航海者 S8「カタンの七不思議」
// ============================================================
//
// 5種の不思議タイル。建設要件を満たすとクレーム（1人1つ・早い者勝ち）。4レベル制で、各レベルとも
// 同じ資源（ore2+grain2+wool1=5枚）。レベル4で完成。勝利は「不思議を完成」または
// 「10VP以上 かつ 他の誰より高いレベルまで建設」（勝利判定は scoring.checkVictory が担当）。
//
// 注意: 純粋関数（DOM非依存）。state.wonderLevel の無い盤（S8以外）では canBuildWonder=false。

import type { GameState, PlayerId, ResourceHand, Action } from '../types';
import { makeHand, RESOURCE_TYPES } from '../constants';
import { calcVP } from './scoring';

export const WONDER_MAX_LEVEL = 4;
/** 各レベルの建設コスト（同一・5枚）。 */
export const WONDER_LEVEL_COST: ResourceHand = makeHand({ ore: 2, grain: 2, wool: 1 });

function cityCount(state: GameState, pid: PlayerId): number {
  return Object.values(state.vertices).filter(v => v.building?.playerId === pid && v.building.type === 'city').length;
}
function settlementCount(state: GameState, pid: PlayerId): number {
  return Object.values(state.vertices).filter(v => v.building?.playerId === pid).length;
}
function hasPortCity(state: GameState, pid: PlayerId): boolean {
  return Object.values(state.vertices).some(v =>
    v.building?.playerId === pid && v.building.type === 'city' && v.harborType != null);
}

export interface WonderDef {
  readonly id: string;
  readonly name: string;
  /** クレーム要件（満たすと建設開始できる）。 */
  readonly requires: (state: GameState, pid: PlayerId) => boolean;
}

// 5種の不思議（要件は公式の例に倣いつつ、通常プレイで到達可能な水準に設定）。
export const WONDERS: readonly WonderDef[] = [
  { id: 'pyramid',    name: 'ピラミッド',   requires: (s, p) => cityCount(s, p) >= 2 },
  { id: 'colossus',   name: '巨像',         requires: (s, p) => cityCount(s, p) >= 2 },
  { id: 'cathedral',  name: '大聖堂',       requires: (s, p) => calcVP(s, p) >= 6 },
  { id: 'lighthouse', name: '灯台',         requires: (s, p) => hasPortCity(s, p) },
  { id: 'gardens',    name: '空中庭園',     requires: (s, p) => settlementCount(s, p) >= 3 },
];

function hasEnough(hand: ResourceHand): boolean {
  return RESOURCE_TYPES.every(r => hand[r] >= WONDER_LEVEL_COST[r]);
}
/** このプレイヤーが既にクレーム済みの不思議ID（無ければ null）。 */
export function ownedWonder(state: GameState, pid: PlayerId): string | null {
  for (const [wid, owner] of Object.entries(state.wonderOwner ?? {})) if (owner === pid) return wid;
  return null;
}

/** 指定の不思議のレベルを今すぐ建設できるか（クレーム or 次レベル）。 */
export function canBuildWonder(state: GameState, pid: PlayerId, wonderId: string): boolean {
  if (state.wonderLevel === undefined) return false;            // S8以外
  const def = WONDERS.find(w => w.id === wonderId);
  if (!def) return false;
  const player = state.players[pid];
  if (!player || !hasEnough(player.hand)) return false;
  const owned = ownedWonder(state, pid);
  if (owned) {
    // 既にクレーム済み: 自分の不思議のみ・レベル4未満なら次レベル建設可。
    return owned === wonderId && (state.wonderLevel[pid] ?? 0) < WONDER_MAX_LEVEL;
  }
  // 未クレーム: その不思議が空いていて、要件を満たすならクレームして1レベル目を建設可。
  if ((state.wonderOwner ?? {})[wonderId]) return false;       // 既に他人が取得済み
  return def.requires(state, pid);
}

/** 不思議のレベルを1段建設する（必要ならクレーム）。バリデーション済み前提。 */
export function buildWonder(state: GameState, pid: PlayerId, wonderId: string): GameState {
  const player = state.players[pid]!;
  const newHand = { ...player.hand };
  const newBank = { ...state.bank };
  for (const r of RESOURCE_TYPES) { newHand[r] -= WONDER_LEVEL_COST[r]; newBank[r] += WONDER_LEVEL_COST[r]; }
  const level = (state.wonderLevel ?? {})[pid] ?? 0;
  return {
    ...state,
    bank: newBank,
    players: { ...state.players, [pid]: { ...player, hand: newHand } },
    wonderOwner: { ...(state.wonderOwner ?? {}), [wonderId]: pid },
    wonderLevel: { ...(state.wonderLevel ?? {}), [pid]: level + 1 },
  };
}

/** AI: 建設すべき不思議アクションを返す（クレーム済みなら次レベル、未なら要件を満たす最初の空き）。無ければ null。 */
export function bestWonderAction(state: GameState, pid: PlayerId): Action | null {
  if (state.wonderLevel === undefined) return null;
  const owned = ownedWonder(state, pid);
  if (owned) {
    return canBuildWonder(state, pid, owned) ? { type: 'BUILD_WONDER', wonderId: owned } : null;
  }
  for (const w of WONDERS) {
    if (canBuildWonder(state, pid, w.id)) return { type: 'BUILD_WONDER', wonderId: w.id };
  }
  return null;
}
