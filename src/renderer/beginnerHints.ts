// ============================================================
// src/renderer/beginnerHints.ts — 初心者モードの局面ガイド
// ============================================================
//
// 現在の局面（フェーズ・手番・手札）から「今すべきこと」を平易な日本語で1つ返す。
// 純粋関数（DOM非依存）でテスト可能。DOM への描画は main.ts 側が担当する。

import type { GameState, PlayerId, PendingTrade, ResourceHand } from '../types';
import { BUILD_COSTS, TILE_RESOURCE_MAP, RESOURCE_TYPES } from '../constants';
import { hasEnoughResources } from '../engine/actions';
import { findPendingDiscarder, discardCount } from '../engine/robber';

// 交易バナー用の短い資源名（コンパクト表示）。
const RES_SHORT: Record<string, string> = { wood: '木', brick: 'レンガ', wool: '羊', grain: '麦', ore: '鉄' };
function formatRes(h: Partial<ResourceHand>): string {
  const parts: string[] = [];
  for (const r of RESOURCE_TYPES) { const n = h[r] ?? 0; if (n > 0) parts.push(`${RES_SHORT[r]}${n}`); }
  return parts.length > 0 ? parts.join('・') : 'なし';
}

/**
 * 自分（responder）宛ての交易提案を「得/損/同等」で評価する助言。
 * offer は発案者視点（発案者が give を渡し receive を受け取る）＝自分は give を受け取り receive を渡す。
 */
function tradeOfferHint(state: GameState, selfId: PlayerId, tr: PendingTrade): BeginnerHint {
  const me = state.players[selfId];
  const gain = tr.offer.give;     // 自分が受け取る
  const cost = tr.offer.receive;  // 自分が渡す
  const initiator = state.players[tr.initiatorId]?.name ?? '相手';
  const giveStr = formatRes(cost);
  const getStr = formatRes(gain);
  const title = `🤝 ${initiator} から交易の提案`;

  if (!me) return { icon: '🤝', title, body: `${giveStr} を渡して ${getStr} をもらう提案です。` };

  // 渡す資源が手札にあるか。
  const canPay = RESOURCE_TYPES.every(r => (me.hand[r] ?? 0) >= (cost[r] ?? 0));
  if (!canPay) {
    return { icon: '🤝', title, body: `${giveStr} を渡す提案ですが、その資源が足りません。「断る」でOK。` };
  }

  // 交易後に建設が解禁されるか（一番うれしいケース）。
  const after = { ...me.hand };
  for (const r of RESOURCE_TYPES) after[r] += (gain[r] ?? 0) - (cost[r] ?? 0);
  const unlocks = (c: ResourceHand): boolean => hasEnoughResources(after, c) && !hasEnoughResources(me.hand, c);
  let unlock = '';
  if (unlocks(BUILD_COSTS.city)) unlock = 'これで都市(+1点)が作れます！';
  else if (unlocks(BUILD_COSTS.settlement)) unlock = 'これで開拓地(+1点)が作れます！';
  else if (unlocks(BUILD_COSTS.dev_card)) unlock = 'これで発展カードが買えます！';

  const totalGain = RESOURCE_TYPES.reduce((s, r) => s + (gain[r] ?? 0), 0);
  const totalCost = RESOURCE_TYPES.reduce((s, r) => s + (cost[r] ?? 0), 0);
  let verdict: string;
  if (totalCost > totalGain) verdict = '枚数では損（渡す方が多い）';
  else if (totalGain > totalCost) verdict = '枚数では得（もらう方が多い）';
  else verdict = '枚数は同じ（1対1）';

  const tail = unlock !== '' ? unlock : 'ほしい資源なら「応じる」、いらなければ「断る」。';
  return { icon: '🤝', title, body: `${giveStr} → ${getStr}。${verdict}。${tail}` };
}

// 2個のサイコロで各数字が出る「組み合わせ数」（=出やすさ）。
const WAYS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

/**
 * 初期配置のおすすめ頂点を上位 topN 個返す（初心者モードで⭐表示）。
 * 評価: 隣接する数字タイルの出やすさ合計（pip）を主、資源の種類数を従（同点の決め手）。
 * 数字タイルに接しない頂点（pip=0）は候補から外す。純粋関数（DOM非依存・テスト可）。
 */
export function recommendedSetupVertices(state: GameState, validIds: Iterable<string>, topN = 3): Set<string> {
  const scored: Array<{ id: string; pip: number; div: number }> = [];
  for (const vid of validIds) {
    const v = state.vertices[vid];
    if (!v) continue;
    let pip = 0;
    const res = new Set<string>();
    for (const tid of v.adjacentTileIds) {
      const t = state.tiles[tid];
      if (!t || t.number == null) continue;
      pip += WAYS[t.number] ?? 0;
      const r = TILE_RESOURCE_MAP[t.type];
      if (r) res.add(r);
    }
    if (pip > 0) scored.push({ id: vid, pip, div: res.size });
  }
  scored.sort((a, b) => b.pip - a.pip || b.div - a.div);
  return new Set(scored.slice(0, topN).map(s => s.id));
}

export interface BeginnerHint {
  icon: string;
  title: string;
  body: string;
}

/** この盤が航海者（海あり）かどうか＝船・海賊の案内を出すかの判定に使う。 */
function hasSea(state: GameState): boolean {
  return Object.values(state.tiles).some(t => t.type === 'sea');
}

/**
 * 初心者向けの局面ガイドを1つ返す（無ければ null）。selfId は人間（LANはviewer）。
 */
export function beginnerHint(state: GameState, selfId: PlayerId | null | undefined): BeginnerHint | null {
  if (!state || !selfId || state.phase === 'GAME_OVER') return null;

  const cur = state.playerOrder[state.currentPlayerIndex];
  const isMyTurn = cur === selfId;
  const sea = hasSea(state);

  // ---- 初期配置 ----
  if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
    if (!isMyTurn) {
      return { icon: '⏳', title: '他のプレイヤーが配置中', body: '順番が来たら開拓地と道（船）を置きます。少し待ちましょう。' };
    }
    if (state.setupSubPhase === 'PLACE_SETTLEMENT') {
      return {
        icon: '🏠',
        title: '開拓地を置きましょう',
        body: '緑に光る角が置ける場所。数字が6・8（●が多い）に接する角や、ちがう資源が3種そろう場所が有利です。',
      };
    }
    if (state.setupSubPhase === 'PLACE_ROAD') {
      return {
        icon: '🛣',
        title: '道を1本のばしましょう',
        body: sea
          ? '海ぞいの開拓地なら、道の代わりに船も置けます。次に広げたい方向へ。'
          : '次に開拓地を建てたい方向へ道を伸ばすと、あとで広げやすくなります。',
      };
    }
    return null;
  }

  if (state.phase !== 'MAIN') return null;

  // ---- 交易の提案が自分宛て（相手の手番でも割り込んで助言する）----
  const tr = state.pendingTrade;
  if (tr && tr.targetPlayerIds.includes(selfId) && !tr.responses[selfId]
      && (tr.state === 'TRADE_OFFER' || tr.state === 'TRADE_RESPONSE')) {
    return tradeOfferHint(state, selfId, tr);
  }

  // ---- 7 の手札捨て ----
  if (state.turnPhase === 'DISCARD') {
    if (findPendingDiscarder(state) === selfId) {
      return { icon: '🃏', title: '手札を捨てます（7が出た）', body: `手札が多いので、半分（${discardCount(state, selfId)}枚）を選んで捨てましょう。` };
    }
    return { icon: '🎲', title: '7が出ました', body: '手札が8枚以上の人が半分を捨てています。終わるまで待ちましょう。' };
  }

  // ---- 金タイル（任意資源の選択） ----
  if (state.turnPhase === 'GOLD') {
    const owed = (state.pendingGoldChoice ?? {})[selfId] ?? 0;
    if (owed > 0) {
      return { icon: '✨', title: '好きな資源を選べます', body: `金タイルの出目！ ${owed}枚ぶん、ほしい資源を選びましょう。` };
    }
    return null;
  }

  // ---- 相手の手番 ----
  if (!isMyTurn) {
    return { icon: '⏳', title: '相手の手番です', body: '交易を申し込まれたら「応じる／断る」を選べます。それ以外は待ちましょう。' };
  }

  // ---- 自分の手番 ----
  if (state.turnPhase === 'PRE_ROLL') {
    return { icon: '🎲', title: 'サイコロを振りましょう', body: '出た数字に接する自分の建物が資源をもらえます（都市は2倍）。' };
  }

  if (state.turnPhase === 'ROBBER') {
    return { icon: '🦹', title: '盗賊を動かします', body: '相手の資源マスに置くと1枚奪えます。自分が使っているマスは避けましょう。' };
  }

  if (state.turnPhase === 'TRADE_BUILD') {
    const hand = state.players[selfId]?.hand;
    const total = hand ? Object.values(hand).reduce((a, b) => a + b, 0) : 0;
    const can: string[] = [];
    if (hand) {
      if (hasEnoughResources(hand, BUILD_COSTS.settlement)) can.push('開拓地(+1点)');
      if (hasEnoughResources(hand, BUILD_COSTS.city)) can.push('都市(+1点)');
      if (hasEnoughResources(hand, BUILD_COSTS.road)) can.push('道');
      if (sea && hasEnoughResources(hand, BUILD_COSTS.ship)) can.push('船');
      if (hasEnoughResources(hand, BUILD_COSTS.dev_card)) can.push('発展カード');
    }
    // 手札が8枚以上＝次に誰かが7を出すと半分捨て。使い切る/交易するよう先に促す。
    if (total >= 8) {
      const tail = can.length > 0 ? `今のうちに ${can.join('・')} を作るか交易を。` : '交易で資源を使うのがおすすめ。';
      return { icon: '⚠', title: `手札が多い（${total}枚）`, body: `誰かが7を出すと半分（${Math.floor(total / 2)}枚）捨てます。${tail}` };
    }
    const body = can.length > 0
      ? `いま作れる：${can.join('・')}。資源が足りなければ交易（銀行は同じ資源4枚→1枚）。終わったら「手番終了」。`
      : '資源が足りません。交易（銀行は同じ資源4枚→好きな1枚／相手とも交換可）で揃えるか「手番終了」を。';
    return { icon: '🏗', title: '建設・交易ができます', body };
  }

  return null;
}
