// ============================================================
// src/engine/mask.ts — 視点別の秘匿マスク（純粋関数）
// ============================================================
//
// LAN対戦では正本 state をサーバが保持し、各クライアントへ配信する前に
// 「その視点プレイヤーが見てよい情報」だけに絞る。これにより DevTools で
// 受信 state を覗いても他人の手札・発展カードの中身は分からない。
//
// マスクするもの（他プレイヤー分のみ）:
//   - hand          … 中身を全0にし、枚数だけ handCount に入れる
//   - devCards      … 中身を空配列にし、枚数だけ devCardCount に入れる
//   - commodities   … 騎士と商人。内訳を全0にし、枚数だけ commodityCount に入れる
//   - progressCards … 騎士と商人。中身を空配列にし、枚数だけ progressCardCount に入れる
// マスクしないもの（公開情報）:
//   - 名前・色・手番順・建物/道の残数・knightsPlayed・最長/最大の保持・公開VP・
//     都市改善レベル・守護者VP 等
//
// 注意: 返す state は表示専用。applyAction には決して渡さない
// （applyAction の正本はサーバが保持する非マスク state）。

import type { GameState, PlayerId } from '../types';
import { RESOURCE_TYPES, COMMODITY_TYPES, makeHand, makeCommodities } from '../constants';

export function maskStateFor(state: GameState, viewerId: PlayerId): GameState {
  const players: GameState['players'] = {};
  const revealWinner = state.phase === 'GAME_OVER' && state.winner != null;
  for (const pid of Object.keys(state.players)) {
    const p = state.players[pid]!;
    // 自分自身、および GAME_OVER 時の勝者は全公開（勝敗内訳の表示用）。
    if (pid === viewerId || (revealWinner && pid === state.winner)) {
      players[pid] = p;
      continue;
    }
    const handCount = RESOURCE_TYPES.reduce((s, r) => s + p.hand[r], 0);
    players[pid] = {
      ...p,
      hand: makeHand(),          // 構成は秘匿
      handCount,                 // 枚数のみ開示
      devCards: [],              // 中身は秘匿
      devCardCount: p.devCards.length,
      // 騎士と商人: 商品・進歩カードも秘匿手札。内訳を隠し枚数だけ開示する。
      ...(p.commodities
        ? { commodities: makeCommodities(), commodityCount: COMMODITY_TYPES.reduce((s, c) => s + p.commodities![c], 0) }
        : {}),
      ...(p.progressCards
        ? { progressCards: [], progressCardCount: p.progressCards.length }
        : {}),
    };
  }
  return {
    ...state,
    players,
    // 山札(devDeck)は「残り枚数」だけが公開情報。各カードの種類・並び順は秘匿する。
    // クライアント/AI は devDeck.length しか参照しないため、枚数を保った不透明スタブに置換し、
    // DevTools から「次に誰が何を引くか」を先読みできないようにする（中身は決して読まれない）。
    devDeck: state.devDeck.map(() => ({ id: '', type: 'knight' as const, purchasedOnTurn: -1 })),
    // 騎士と商人: 錬金術師で事前指定した次のダイス目は秘匿情報（相手に先読みさせない）。
    ...(state.alchemistForcedDice != null ? { alchemistForcedDice: null } : {}),
    // 交易と蛮族「イベントカード」: デッキの並び順は秘匿（次のイベント/数字を先読みさせない）。
    // 枚数だけを保った不透明スタブに置換する（tbLastEventCard＝めくった札は公開のまま）。
    ...(state.tbEventDeck
      ? { tbEventDeck: state.tbEventDeck.map(() => ({ event: 'beautiful_day' as const, number: null })) }
      : {}),
  };
}
