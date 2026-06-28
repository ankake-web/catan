// ============================================================
// src/engine/log.ts — アクションログ生成（公開情報のみ）
// ============================================================
//
// このモジュールは「観戦者・人間プレイヤーに見せてよい公開情報」だけから
// ログ項目を生成する。秘匿すべき情報は文字列に含めない：
//   - CPUの手札内訳・VPカード・VPカード込みの内部VP・内部評価
//   - 盗み取り／捨て札の「資源の種類」（枚数のみ公開）
//   - CPUの資源獲得の内訳（人間プレイヤー自身の分のみ内訳を出す）
// ============================================================

import type { GameState, Action, PlayerId, LogEntry, ResourceType, TradeKind } from '../types';
import { RESOURCE_TYPES, PROGRESS_CARD_NAME, CK_TRACK_NAME } from '../constants';

export const RES_EMOJI: Record<ResourceType, string> = {
  wood: '🌲', brick: '🧱', wool: '🐑', grain: '🌾', ore: '⛰',
};

const COMMODITY_EMOJI: Record<string, string> = { coin: '🪙', cloth: '🧵', paper: '📜' };
/** 資源/商品どちらの絵文字も解決する（騎士と商人の銀行交易ログ用）。 */
const kindEmoji = (k: TradeKind): string => RES_EMOJI[k as ResourceType] ?? COMMODITY_EMOJI[k] ?? '?';

const DEV_PLAY_LABEL: Record<string, string> = {
  PLAY_KNIGHT:         '⚔ 騎士',
  PLAY_ROAD_BUILDING:  '🛤 街道建設',
  PLAY_YEAR_OF_PLENTY: '🌾 年の豊穣',
  PLAY_MONOPOLY:       '🏛 独占',
};

export const MAX_LOG_ENTRIES = 60;

/**
 * 1アクション分のログ項目を生成する（公開情報のみ）。
 * - CPUの手札内訳・VPカード込み内部VP・内部評価・非公開の捨て札内容は出さない。
 * - 資源獲得の内訳は人間プレイヤー自身の分のみ（自分の情報）。
 * - 捨て札・盗み取りは「枚数」のみ（種類は秘匿）。
 */
export function buildActionLog(
  prev: GameState,
  action: Action,
  next: GameState,
  // LAN対戦: この視点プレイヤー基準で「あなた」表記・自分の獲得内訳を出す。
  // 省略時（単一端末プレイ）は唯一の human を基準にする（従来挙動）。
  viewerId?: PlayerId,
): LogEntry[] {
  const turn = next.globalTurnNumber;
  const nm = (pid: string): string => next.players[pid]?.name ?? prev.players[pid]?.name ?? pid;
  const actor = prev.playerOrder[prev.currentPlayerIndex] ?? next.playerOrder[next.currentPlayerIndex] ?? '';
  // 「自分」判定: viewerId 指定時はそのID、未指定時は human プレイヤー。
  const selfPid = viewerId ?? next.playerOrder.find(p => next.players[p]?.type === 'human');
  const isMe = (pid: string): boolean => pid === selfPid;
  const entries: LogEntry[] = [];
  const push = (playerId: string, type: LogEntry['type'], message: string) =>
    entries.push({ turn, playerId: playerId as PlayerId, type, message });

  switch (action.type) {
    case 'ROLL_DICE': {
      const [d1, d2] = next.lastDiceRoll ?? [0, 0];
      const evMsg = next.lastEventDie === 'ship' ? '🛶蛮族前進'
        : next.lastEventDie === 'trade' ? '🟡商業' : next.lastEventDie === 'politics' ? '🔵政治'
        : next.lastEventDie === 'science' ? '🟢科学' : '';
      push(actor, 'DICE_ROLL', `🎲 ${nm(actor)} がダイス ${d1}+${d2}=${d1 + d2}${evMsg ? `（${evMsg}）` : ''}`);
      // 騎士と商人: 蛮族襲来が起きたら結果を記録（撃退/敗北・誰が守護VP/誰が都市格下げ予定か）。
      if ((next.barbarianAttacks ?? 0) > (prev.barbarianAttacks ?? 0)) {
        const defenders = next.playerOrder
          .filter(pid => (next.players[pid]?.defenderVP ?? 0) > (prev.players[pid]?.defenderVP ?? 0))
          .map(nm);
        const willDowngrade = next.pendingCityDowngrade ?? [];
        if (willDowngrade.length > 0) {
          push(actor, 'ROBBER', `⚔ 蛮族に敗北！ ${willDowngrade.map(nm).join('・')} が都市を1つ開拓地に格下げします`);
        } else if (defenders.length > 0) {
          push(actor, 'DEV_CARD', `🛡 蛮族を撃退！ ${defenders.join('・')} が「カタンの守護者」VP+1`);
        } else {
          push(actor, 'DEV_CARD', '🛡 蛮族を撃退！（最大貢献が同点）');
        }
      }
      // 進歩カードの獲得（色イベント／撃退同点など。種類は秘匿、獲得の事実だけ公開）。
      {
        const drew: string[] = [];
        for (const pid of next.playerOrder) {
          const before = prev.players[pid]?.progressCardCount ?? prev.players[pid]?.progressCards?.length ?? 0;
          const after = next.players[pid]?.progressCardCount ?? next.players[pid]?.progressCards?.length ?? 0;
          if (after > before) drew.push(`${isMe(pid) ? 'あなた' : nm(pid)}×${after - before}`);
        }
        if (drew.length > 0) push(actor, 'DEV_CARD', `📜 進歩カード獲得: ${drew.join('　')}`);
      }
      // ダイス生産は「盤面＋出目」から誰でも導出できる公開情報。全プレイヤーの
      // 「このロールで得た分」を1行にまとめて出す（自分は「あなた」表記）。
      // ※ 公開するのは“このロールの増加分”だけ。手札の既存ストックや内訳、
      //   盗み取り/交易/捨て札による増減は対象外（秘匿）。
      const gainParts: string[] = [];
      for (const pid of next.playerOrder) {
        const gains = RESOURCE_TYPES
          .map(r => ({ r, n: (next.players[pid]?.hand[r] ?? 0) - (prev.players[pid]?.hand[r] ?? 0) }))
          .filter(g => g.n > 0);
        if (gains.length === 0) continue;
        const who = isMe(pid) ? 'あなた' : nm(pid);
        gainParts.push(`${who} ${gains.map(g => `${RES_EMOJI[g.r]}×${g.n}`).join('')}`);
      }
      if (gainParts.length > 0) {
        push(actor, 'RESOURCE_GAIN', `📥 ${gainParts.join('　')}`);
      } else if (d1 + d2 !== 7) {
        // 7（盗賊）以外で誰も得られなかった場合のみ明示（7は盗賊フローで案内）。
        push(actor, 'RESOURCE_GAIN', '📥 誰も資源を得られなかった');
      }
      break;
    }
    case 'BUILD_ROAD':       push(actor, 'BUILD', `🛤 ${nm(actor)} が道を建設`); break;
    case 'MOVE_SHIP':        push(actor, 'BUILD', `⛵ ${nm(actor)} が船を移動`); break;
    case 'BUILD_SETTLEMENT': push(actor, 'BUILD', `🏠 ${nm(actor)} が開拓地を建設`); break;
    case 'BUILD_CITY':       push(actor, 'BUILD', `🏙 ${nm(actor)} が都市を建設`); break;
    case 'BUILD_KNIGHT':     push(actor, 'BUILD', `🛡 ${nm(actor)} が騎士を配置`); break;
    case 'ACTIVATE_KNIGHT':  push(actor, 'BUILD', `⚔ ${nm(actor)} が騎士を起動`); break;
    case 'UPGRADE_KNIGHT':   push(actor, 'BUILD', `⏫ ${nm(actor)} が騎士を昇格`); break;
    case 'MOVE_KNIGHT':      push(actor, 'BUILD', `🐎 ${nm(actor)} が騎士を移動`); break;
    case 'BUILD_CITY_WALL':  push(actor, 'BUILD', `🧱 ${nm(actor)} が城壁を建設`); break;
    case 'CHASE_ROBBER':     push(actor, 'ROBBER', `🐎 ${nm(actor)} が騎士で盗賊を追い払った`); break;
    case 'BUILD_IMPROVEMENT': {
      const lv = next.players[actor]?.improvements?.[action.track] ?? 0;
      push(actor, 'BUILD', `📈 ${nm(actor)} が${CK_TRACK_NAME[action.track]}を Lv${lv} に改善`);
      // メトロポリス到達（Lv4で建設・公開情報）。
      const newMetro = next.metropolis?.[action.track];
      const oldMetro = prev.metropolis?.[action.track];
      if (newMetro && newMetro.playerId === actor && (!oldMetro || oldMetro.playerId !== actor)) {
        push(actor, 'BONUS_CHANGE', `🏛 ${nm(actor)} が${CK_TRACK_NAME[action.track]}のメトロポリスを獲得（+2勝利点）`);
      }
      break;
    }
    case 'DOWNGRADE_CITY':   push(action.playerId, 'ROBBER', `🏚 ${nm(action.playerId)} が都市を1つ開拓地に格下げ`); break;
    case 'DISCARD_PROGRESS': push(action.playerId, 'DISCARD', `📜 ${nm(action.playerId)} が進歩カードを1枚捨てた（上限4枚）`); break;
    case 'BUY_DEV_CARD':     push(actor, 'DEV_CARD', `🃏 ${nm(actor)} が発展カードを購入`); break;
    case 'PLAY_KNIGHT':
    case 'PLAY_ROAD_BUILDING':
    case 'PLAY_YEAR_OF_PLENTY':
      push(actor, 'DEV_CARD', `${DEV_PLAY_LABEL[action.type]} を ${nm(actor)} が使用`); break;
    case 'PLAY_MONOPOLY':
      // 独占は宣言した資源が公開情報
      push(actor, 'DEV_CARD', `🏛 ${nm(actor)} が独占を使用（${RES_EMOJI[action.resource]}）`); break;
    case 'BANK_TRADE':
      push(actor, 'TRADE_BANK', `💱 ${nm(actor)} が銀行交易（${kindEmoji(action.give)}→${kindEmoji(action.receive)}）`); break;
    case 'PLAY_PROGRESS': {
      // 進歩カードは使用すると効果が公開される（相手にも何を使ったか分かる）。
      const card = prev.players[actor]?.progressCards?.find(c => c.id === action.cardId);
      push(actor, 'DEV_CARD', `📜 ${nm(actor)} が進歩カード「${card ? PROGRESS_CARD_NAME[card.type] : '進歩'}」を使用`); break;
    }
    case 'MOVE_ROBBER': {
      let msg = `🦹 ${nm(actor)} が盗賊を移動`;
      if (action.stealFromPlayerId) msg += `し ${nm(action.stealFromPlayerId)} から1枚奪った`; // 種類は秘匿
      push(actor, 'ROBBER', msg);
      break;
    }
    case 'MOVE_PIRATE': {
      let msg = `🏴‍☠️ ${nm(actor)} が海賊を移動`;
      if (action.stealFromPlayerId) msg += `し ${nm(action.stealFromPlayerId)} から1枚奪った`; // 種類は秘匿
      push(actor, 'ROBBER', msg);
      break;
    }
    case 'DISCARD_RESOURCES': {
      // 捨てた枚数のみ（内容は秘匿）
      const count = RESOURCE_TYPES.reduce((s, r) => s + (action.resources[r] ?? 0), 0);
      if (count > 0) push(action.playerId, 'DISCARD', `🗑 ${nm(action.playerId)} が ${count}枚 捨てた`);
      break;
    }
    case 'CHOOSE_GOLD': {
      // 金タイルで選んだ枚数のみ（種類は秘匿・捨て札/盗みと同方針）
      const count = RESOURCE_TYPES.reduce((s, r) => s + (action.resources[r] ?? 0), 0);
      if (count > 0) push(action.playerId, 'RESOURCE_GAIN', `✨ ${nm(action.playerId)} が金タイルから ${count}枚 獲得`);
      break;
    }
    case 'OFFER_TRADE': {
      push(actor, 'TRADE_PLAYER', isMe(actor) ? `🤝 あなたが交易を提案` : `🤝 ${nm(actor)} が交易を提案`);
      break;
    }
    case 'CONFIRM_TRADE': {
      const trade = prev.pendingTrade;
      if (trade) push(trade.initiatorId, 'TRADE_PLAYER', `🤝 交易成立（${nm(trade.initiatorId)} ⇄ ${nm(action.responderId)}）`);
      break;
    }
    case 'CANCEL_TRADE': {
      const trade = prev.pendingTrade;
      if (trade && prev.players[trade.initiatorId]?.type === 'ai' && trade.state === 'TRADE_RESPONSE') {
        push(trade.initiatorId, 'TRADE_PLAYER', `🤝 あなたは ${nm(trade.initiatorId)} の交易提案を拒否`);
      } else if (trade) {
        push(trade.initiatorId, 'TRADE_PLAYER', `🤝 交易は不成立`);
      }
      break;
    }
    default: break;
  }

  // ボーナス称号の移動（公開情報）
  if (prev.longestRoadHolder !== next.longestRoadHolder && next.longestRoadHolder) {
    push(next.longestRoadHolder, 'BONUS_CHANGE', `🛤 ${nm(next.longestRoadHolder)} が最長交易路を獲得`);
  }
  if (prev.largestArmyHolder !== next.largestArmyHolder && next.largestArmyHolder) {
    push(next.largestArmyHolder, 'BONUS_CHANGE', `⚔ ${nm(next.largestArmyHolder)} が最大騎士力を獲得`);
  }
  // 航海者: 新しい島への最初の入植（公開情報・+VP）。各プレイヤーが自分の初入植で獲得（島ごと）。
  {
    const per = next.newIslandBonusVp ?? 2;
    const prevBonus = prev.islandBonus ?? {};
    const nextBonus = next.islandBonus ?? {};
    for (const [rep, owners] of Object.entries(nextBonus)) {
      const before = new Set(prevBonus[rep] ?? []);
      for (const owner of owners) {
        if (!before.has(owner)) {
          push(owner, 'BONUS_CHANGE', `🚢 ${nm(owner)} が新しい島に入植（+${per}勝利点）`);
        }
      }
    }
  }
  // 勝利
  if (next.phase === 'GAME_OVER' && prev.phase !== 'GAME_OVER' && next.winner) {
    push(next.winner, 'VICTORY', `🏆 ${nm(next.winner)} の勝利！`);
  }

  return entries;
}
