// ============================================================
// tests/tb_event_cards.test.ts — 交易と蛮族「イベントカード(Catan Event Cards)」変種
// ============================================================
// 公式ルールブック第6版 CN3089 p4-6 のルール＋独語版第6版(Kosmos 685140) p5 の
// 「36枚のイベント×生産数字×枚数」を固定するテスト（docs/交易と蛮族_仕様書_v6.md §2-3）。
//   - デッキ構築: 36枚シャッフル→5枚を底へ→New Year→残り30枚を上へ（NYより下の5枚は使われない）。
//   - ROLL_DICE: ダイスの代わりに山札をめくり、イベント効果→カードの数字で生産 or 7 の解決。
//   - 実装解釈（仕様書§2-3）: 親切な隣人は公開VP判定／左隣=playerOrderの次／供給から取る系はGOLD流用。

import { describe, it, expect } from 'vitest';
import { makeGameState, makePlayer } from './helpers';
import { applyAction } from '../src/engine/game';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { getScenario, listVisibleScenarios, getScenarioRules } from '../src/engine/scenarios';
import {
  buildTbEventDeck, tbApplyEventEffect, tbEventStealTargets, tbLeftNeighbor,
  tbEventPendingIds, tbConflictChooser, tbPortBuildingCount, tbHasDamagedRoad,
  tbVertexBlockedByDamagedRoad,
} from '../src/engine/tbEvents';
import { chooseAction } from '../src/engine/ai';
import { maskStateFor } from '../src/engine/mask';
import { canBuildRoad, canBuildSettlement } from '../src/engine/actions';
import { computeDiceProduction } from '../src/engine/dice';
import { calcLongestRoad } from '../src/engine/scoring';
import {
  TB_EVENT_CARDS_36, TB_EVENT_DECK_BOTTOM, TB_ROAD_REPAIR_COST, makeHand, RESOURCE_TYPES,
} from '../src/constants';
import type { GameState, TbEventCard, TbEventType, PlayerId, TileId, VertexId, EdgeId, BuildingType } from '../src/types';

const rng42 = (): (() => number) => createRng(42);

/** イベントカード変種の PRE_ROLL 状態（デッキ注入可・基本盤 rng42）。 */
function tbState(deck: TbEventCard[], partial: Partial<GameState> = {}): GameState {
  return makeGameState({
    tbEventCards: true,
    tbEventDeck: deck,
    tbLastEventCard: null,
    turnPhase: 'PRE_ROLL',
    diceRolledThisTurn: false,
    ...partial,
  });
}

const card = (event: TbEventType, number: number | null): TbEventCard => ({ event, number });

/** 頂点に建物を直接置く（配置規則は無視。ロジック単体検証用）。 */
function place(state: GameState, vid: VertexId, playerId: PlayerId, type: BuildingType): GameState {
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, building: { type, playerId } } },
  };
}

/** 辺に道を直接置く。 */
function placeRoad(state: GameState, eid: EdgeId, playerId: PlayerId, damaged = false): GameState {
  return {
    ...state,
    edges: { ...state.edges, [eid]: { ...state.edges[eid]!, road: { playerId, ...(damaged ? { damaged: true } : {}) } } },
  };
}

function desertId(state: GameState): TileId {
  return Object.values(state.tiles).find(t => t.type === 'desert')!.id;
}

function handTotalOf(state: GameState, pid: PlayerId): number {
  const h = state.players[pid]!.hand;
  return RESOURCE_TYPES.reduce((s, r) => s + h[r], 0);
}

// ============================================================
// 1. データ定数（仕様書§2-3 の表を固定・出典: 独語版第6版 p5）
// ============================================================

describe('TB_EVENT_CARDS_36: 36枚の数字×イベント分布（公式値）', () => {
  it('合計36枚・数字別の枚数が2d6分布どおり（2:1,3:2,4:3,5:4,6:5,7:6,8:5,9:4,10:3,11:2,12:1）', () => {
    expect(TB_EVENT_CARDS_36).toHaveLength(36);
    const byNumber: Record<number, number> = {};
    for (const c of TB_EVENT_CARDS_36) byNumber[c.number!] = (byNumber[c.number!] ?? 0) + 1;
    expect(byNumber).toEqual({ 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 });
  });
  it('イベント別の枚数と数字割当てが公式値と一致', () => {
    const byEvent: Record<string, number[]> = {};
    for (const c of TB_EVENT_CARDS_36) (byEvent[c.event] ??= []).push(c.number!);
    for (const nums of Object.values(byEvent)) nums.sort((a, b) => a - b);
    expect(byEvent).toEqual({
      beautiful_day:    [3, 4, 5, 5, 6, 6, 8, 8, 8, 8, 9, 9, 9, 10, 10, 11], // 16枚
      robber_attacks:   [7, 7, 7, 7, 7, 7],                                   // 7の6枚すべて
      epidemic:         [6, 8],
      helpful_neighbor: [10, 11],
      calm_seas:        [9, 12],
      robber_flees:     [4, 4],
      plentiful_year:   [2],
      conflict:         [3],
      tournament:       [5],
      trade_advantage:  [5],
      earthquake:       [6],
      good_neighbors:   [6],
    });
  });
  it('new_year はデッキ36枚に含まれない（数字なしの別カード）', () => {
    expect(TB_EVENT_CARDS_36.some(c => c.event === 'new_year')).toBe(false);
    expect(TB_EVENT_CARDS_36.every(c => c.number != null && c.number >= 2 && c.number <= 12)).toBe(true);
  });
});

// ============================================================
// 2. デッキ構築（CN3089 p5 CHANGES TO SETUP）
// ============================================================

describe('buildTbEventDeck: 36枚シャッフル→底5枚→New Year→残り31枚', () => {
  it('37枚・上31枚にNYなし・32枚目がNY・底5枚はNYでない・中身は36枚と一致', () => {
    const deck = buildTbEventDeck(TB_EVENT_CARDS_36, rng42());
    expect(deck).toHaveLength(37);
    expect(deck.slice(0, 31).some(c => c.event === 'new_year')).toBe(false);
    expect(deck[31]!.event).toBe('new_year');
    expect(deck[31]!.number).toBeNull();
    expect(deck.slice(32)).toHaveLength(TB_EVENT_DECK_BOTTOM);
    expect(deck.slice(32).some(c => c.event === 'new_year')).toBe(false);
    // New Year を除いた36枚は元の36枚と同一（multiset比較）。
    const key = (c: TbEventCard): string => `${c.event}:${c.number}`;
    const rest = deck.filter(c => c.event !== 'new_year').map(key).sort();
    expect(rest).toEqual([...TB_EVENT_CARDS_36].map(key).sort());
  });
});

describe('シナリオ登録と初期状態', () => {
  const SPECS: PlayerSpec[] = [
    { id: 'player1', name: 'A', color: 'red', type: 'human' },
    { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'strong' },
  ];
  it('tb_event_cards: カテゴリ/勝利目標10/ルールフラグ/表示リスト', () => {
    const sc = getScenario('tb_event_cards');
    expect(sc.category).toBe('traders_barbarians');
    expect(sc.victoryTarget).toBe(10); // 本体準拠（CN3089: 勝利条件の変更なし）
    expect(sc.rules?.eventCards).toBe(true);
    expect(listVisibleScenarios().map(s => s.id)).toContain('tb_event_cards');
    expect(getScenarioRules('tb_event_cards').length).toBeGreaterThan(0);
  });
  it('createInitialGameState がイベントデッキ(37枚)を配線し、赤黄ダイス経路を置換する', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], rng42(), 'tb_event_cards');
    expect(s.tbEventCards).toBe(true);
    expect(s.tbEventDeck).toHaveLength(37);
    expect(s.victoryTarget).toBe(10);
  });
  it('LANマスク: デッキの並び順は秘匿（枚数のみ保持）・めくった札は公開のまま', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], rng42(), 'tb_event_cards');
    const withLast = { ...s, tbLastEventCard: card('epidemic', 8) };
    const masked = maskStateFor(withLast, 'player2');
    expect(masked.tbEventDeck).toHaveLength(37);
    expect(masked.tbEventDeck!.every(c => c.event === 'beautiful_day' && c.number === null)).toBe(true);
    expect(masked.tbLastEventCard).toEqual(card('epidemic', 8));
  });
});

// ============================================================
// 3. ROLL_DICE のカード置換（めくり→効果→数字で生産 or 7）
// ============================================================

describe('ROLL_DICE: ダイスの代わりにデッキをめくる', () => {
  it('良き日(8): 効果なし→数字8で生産へ（lastDiceRoll は合計8の2分割・デッキが1枚減る）', () => {
    const s0 = tbState([card('beautiful_day', 8), card('conflict', 3)]);
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbLastEventCard).toEqual(card('beautiful_day', 8));
    expect(s1.tbNewYearRebuilt).toBe(false);
    expect(s1.turnPhase).toBe('TRADE_BUILD');
    const [d1, d2] = s1.lastDiceRoll!;
    expect(d1 + d2).toBe(8);
    expect(d1).toBeGreaterThanOrEqual(1); expect(d1).toBeLessThanOrEqual(6);
    expect(d2).toBeGreaterThanOrEqual(1); expect(d2).toBeLessThanOrEqual(6);
    expect(s1.tbEventDeck).toHaveLength(1);
    expect(s1.diceRolledThisTurn).toBe(true);
  });
  it('全数字2-12で lastDiceRoll の2分割が正のダイス面(1-6)になる', () => {
    for (let n = 2; n <= 12; n++) {
      const s1 = applyAction(tbState([card('beautiful_day', n)]), { type: 'ROLL_DICE' }, rng42());
      const [d1, d2] = s1.lastDiceRoll!;
      expect(d1 + d2).toBe(n);
      expect(Math.min(d1, d2)).toBeGreaterThanOrEqual(1);
      expect(Math.max(d1, d2)).toBeLessThanOrEqual(6);
    }
  });
  it('盗賊の襲撃(7): 8枚未満なら捨て札なしで ROBBER へ', () => {
    const s1 = applyAction(tbState([card('robber_attacks', 7)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('ROBBER');
  });
  it('盗賊の襲撃(7): 8枚以上の手札があれば DISCARD へ', () => {
    const s0 = tbState([card('robber_attacks', 7)], {
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }),
        player2: makePlayer('player2'),
      },
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('DISCARD');
  });
  it('New Year が一番上: デッキを作り直してから1枚めくって通常解決（tbNewYearRebuilt）', () => {
    const s1 = applyAction(tbState([card('new_year', null)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbNewYearRebuilt).toBe(true);
    expect(s1.tbLastEventCard!.event).not.toBe('new_year');
    expect(s1.tbEventDeck).toHaveLength(36); // 再構築37 − めくった1
  });
  it('山札が空（保険）: 再構築してめくる', () => {
    const s1 = applyAction(tbState([]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbNewYearRebuilt).toBe(true);
    expect(s1.tbEventDeck).toHaveLength(36);
  });
});

// ============================================================
// 4. 即時効果イベント
// ============================================================

describe('疫病(EPIDEMIC): 今回の生産は都市も資源1枚のみ', () => {
  it('カードで tbEpidemic が立ち、END_TURN でリセットされる', () => {
    const s1 = applyAction(tbState([card('epidemic', 8)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbEpidemic).toBe(true);
    expect(s1.turnPhase).toBe('TRADE_BUILD');
    const s2 = applyAction(s1, { type: 'END_TURN' }, rng42());
    expect(s2.tbEpidemic).toBe(false);
  });
  it('computeDiceProduction: tbEpidemic 中は都市の産出が2→1になる', () => {
    let s = makeGameState();
    const tile = Object.values(s.tiles).find(t => t.number != null && !t.hasRobber)!;
    const vid = s.tileToVertices[tile.id]![0]!;
    s = place(s, vid, 'player1', 'city');
    const normal = computeDiceProduction(s, tile.number!);
    const epidemic = computeDiceProduction({ ...s, tbEpidemic: true }, tile.number!);
    const resOf = (m: ReturnType<typeof computeDiceProduction>): number =>
      RESOURCE_TYPES.reduce((sum, r) => sum + (m['player1']?.[r] ?? 0), 0);
    expect(resOf(normal)).toBe(2);
    expect(resOf(epidemic)).toBe(1);
  });
});

describe('盗賊の逃走(ROBBER FLEES): 盗賊を砂漠へ（奪わない）', () => {
  it('砂漠がある盤: 盗賊が砂漠へ移動し、そのまま生産へ', () => {
    let s0 = tbState([card('robber_flees', 4)]);
    // 盗賊を砂漠以外へ動かしておく
    const other = Object.values(s0.tiles).find(t => t.type !== 'desert' && t.type !== 'sea')!;
    s0 = {
      ...s0,
      tiles: Object.fromEntries(Object.entries(s0.tiles).map(([tid, t]) =>
        [tid, { ...t, hasRobber: tid === other.id }])),
    };
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.tiles[desertId(s1)]!.hasRobber).toBe(true);
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('砂漠が無い盤: 盗賊を盤外へ（全タイル hasRobber=false）', () => {
    let s0 = tbState([card('robber_flees', 4)]);
    // 砂漠を平地に変えて「砂漠なし盤」を作る（盗賊は砂漠に居た＝そのまま乗っている）。
    const did = desertId(s0);
    s0 = { ...s0, tiles: { ...s0.tiles, [did]: { ...s0.tiles[did]!, type: 'field' } } };
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(Object.values(s1.tiles).some(t => t.hasRobber)).toBe(false);
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
});

// ============================================================
// 5. 供給から取る系（GOLD フェーズ流用）: 豊作の年/穏やかな海/馬上槍試合
// ============================================================

describe('豊作の年(PLENTIFUL YEAR): 各自 供給から任意資源1枚', () => {
  it('全員が1枚ずつ選ぶ(GOLD)→全員解決後にカード数字で生産へ', () => {
    const s1 = applyAction(tbState([card('plentiful_year', 2)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('GOLD');
    expect(s1.pendingGoldChoice).toEqual({ player1: 1, player2: 1 });
    expect(s1.tbPendingEventNumber).toBe(2);
    const s2 = applyAction(s1, { type: 'CHOOSE_GOLD', playerId: 'player1', resources: { ore: 1 } }, rng42());
    expect(s2.turnPhase).toBe('GOLD'); // player2 が未解決
    const s3 = applyAction(s2, { type: 'CHOOSE_GOLD', playerId: 'player2', resources: { wool: 1 } }, rng42());
    expect(s3.turnPhase).toBe('TRADE_BUILD');
    expect(s3.tbPendingEventNumber).toBeNull();
    expect(s3.players['player1']!.hand.ore).toBe(1);
    expect(s3.players['player2']!.hand.wool).toBe(1);
  });
  it('バンクが空なら選択なしで直接生産へ（手詰まり防止）', () => {
    const s0 = tbState([card('plentiful_year', 2)], { bank: makeHand() });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
});

describe('穏やかな海(CALM SEAS): 港上の建物「数」最多者が任意資源1枚', () => {
  it('誰も港上に建物なし→効果なしで生産へ', () => {
    const s1 = applyAction(tbState([card('calm_seas', 12)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('港上の建物数が最多のプレイヤーだけが選ぶ（同数なら全員）', () => {
    let s0 = tbState([card('calm_seas', 9)]);
    const portVids = Object.values(s0.vertices).filter(v => v.harborType != null).map(v => v.id);
    s0 = place(s0, portVids[0]!, 'player1', 'settlement');
    s0 = place(s0, portVids[1]!, 'player1', 'city'); // 都市でも「1個」（VPでなく個数）
    s0 = place(s0, portVids[2]!, 'player2', 'settlement');
    expect(tbPortBuildingCount(s0, 'player1')).toBe(2);
    expect(tbPortBuildingCount(s0, 'player2')).toBe(1);
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('GOLD');
    expect(s1.pendingGoldChoice).toEqual({ player1: 1 });
  });
});

describe('馬上槍試合(TOURNAMENT): 表向き騎士カード最多者が任意資源1枚', () => {
  it('誰も騎士カードを出していない→効果なし', () => {
    const s1 = applyAction(tbState([card('tournament', 5)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('最多者のみが選ぶ（同数最多は全員）', () => {
    const s0 = tbState([card('tournament', 5)], {
      players: {
        player1: makePlayer('player1', { knightsPlayed: 2 }),
        player2: makePlayer('player2', { knightsPlayed: 2 }),
      },
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('GOLD');
    expect(s1.pendingGoldChoice).toEqual({ player1: 1, player2: 1 });
  });
});

// ============================================================
// 6. 良き隣人(GOOD NEIGHBORS) / 親切な隣人(HELPFUL NEIGHBOR)
// ============================================================

describe('良き隣人(GOOD NEIGHBORS): 各自 左隣へ任意資源1枚', () => {
  it('左隣= playerOrder の次のプレイヤー', () => {
    const s = makeGameState();
    expect(tbLeftNeighbor(s, 'player1')).toBe('player2');
    expect(tbLeftNeighbor(s, 'player2')).toBe('player1');
  });
  it('手札のある者だけが渡す。解決後に生産へ。中身は選択どおり移動', () => {
    const s0 = tbState([card('good_neighbors', 6)], {
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 2 }) }),
        player2: makePlayer('player2'), // 手札0 → 渡す義務なし
      },
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('EVENT_GIVE');
    expect(s1.tbPendingEventGive).toEqual({ player1: 'player2' });
    expect(s1.tbPendingEventNumber).toBe(6);
    // 持っていない資源は渡せない
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_GIVE', playerId: 'player1', resource: 'ore' }, rng42())).toThrow();
    // 未知の資源名（LANの不正ペイロード想定）は拒否＝ hand に NaN キーを作らせない
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_GIVE', playerId: 'player1', resource: 'gold' as never }, rng42())).toThrow();
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_GIVE', playerId: 'player1', resource: 'wood' }, rng42());
    expect(s2.players['player1']!.hand.wood).toBe(1);
    expect(s2.players['player2']!.hand.wood).toBeGreaterThanOrEqual(1); // 渡した1枚（＋数字6の生産分がありうる）
    expect(s2.turnPhase).toBe('TRADE_BUILD');
    expect(s2.tbPendingEventNumber).toBeNull();
  });
  it('全員手札0→効果なしで生産へ', () => {
    const s1 = applyAction(tbState([card('good_neighbors', 6)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
});

describe('親切な隣人(HELPFUL NEIGHBOR): 公開VP最多者が「より少ない者」へ1枚', () => {
  it('全員同VP→効果なし', () => {
    const s1 = applyAction(tbState([card('helpful_neighbor', 10)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('VP最多者が相手と資源を選んで渡す（VPが少ない相手のみ合法）', () => {
    let s0 = tbState([card('helpful_neighbor', 10)], {
      players: {
        player1: makePlayer('player1', { hand: makeHand({ grain: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    // player1 に開拓地1（公開VP1 vs 0）
    const vid = Object.keys(s0.vertices)[0]!;
    s0 = place(s0, vid, 'player1', 'settlement');
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('EVENT_HELPFUL');
    expect(s1.tbPendingEventHelpful).toEqual(['player1']);
    // 自分自身やVPが同等以上の相手には渡せない
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_HELPFUL', playerId: 'player1', resource: 'grain', toPlayerId: 'player1' }, rng42())).toThrow();
    // 未知の資源名（LANの不正ペイロード想定）は拒否
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_HELPFUL', playerId: 'player1', resource: 'coin' as never, toPlayerId: 'player2' }, rng42())).toThrow();
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_HELPFUL', playerId: 'player1', resource: 'grain', toPlayerId: 'player2' }, rng42());
    expect(s2.players['player1']!.hand.grain).toBe(0);
    expect(s2.players['player2']!.hand.grain).toBeGreaterThanOrEqual(1);
    expect(s2.turnPhase).toBe('TRADE_BUILD');
  });
  it('VP最多でも手札0なら渡す義務なし（対象から外れ、全員手札0なら効果なし）', () => {
    let s0 = tbState([card('helpful_neighbor', 11)]);
    const vid = Object.keys(s0.vertices)[0]!;
    s0 = place(s0, vid, 'player1', 'settlement'); // VP1 vs 0 だが手札0
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
});

// ============================================================
// 7. 衝突(CONFLICT) / 交易優位(TRADE ADVANTAGE)
// ============================================================

describe('衝突(CONFLICT): 最大騎士力（無ければ騎士カード最多の単独者）が無作為1枚強奪', () => {
  it('最大騎士力タイル保持者は必須で奪う（見送り不可）', () => {
    const s0 = tbState([card('conflict', 3)], {
      players: {
        player1: makePlayer('player1', { knightsPlayed: 3, hasLargestArmy: true }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 2 }) }),
      },
      largestArmyHolder: 'player1',
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('EVENT_STEAL');
    expect(s1.tbPendingEventSteal).toEqual({ playerId: 'player1', optional: false });
    expect(tbEventStealTargets(s1)).toEqual(['player2']);
    // 必須なので見送りは違法
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: null }, rng42())).toThrow();
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: 'player2' }, rng42());
    expect(handTotalOf(s2, 'player1')).toBe(1);
    expect(s2.turnPhase).toBe('TRADE_BUILD');
  });
  it('タイル未成立: 騎士カード最多の単独者は任意（見送り可）', () => {
    const s0 = tbState([card('conflict', 3)], {
      players: {
        player1: makePlayer('player1', { knightsPlayed: 2 }),
        player2: makePlayer('player2', { knightsPlayed: 1, hand: makeHand({ wool: 1 }) }),
      },
    });
    expect(tbConflictChooser(s0)).toEqual({ playerId: 'player1', optional: true });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('EVENT_STEAL');
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: null }, rng42());
    expect(s2.turnPhase).toBe('TRADE_BUILD');
    expect(handTotalOf(s2, 'player2')).toBe(1); // 奪われていない
  });
  it('騎士カード最多が同数（単独でない）→効果なし', () => {
    const s0 = tbState([card('conflict', 3)], {
      players: {
        player1: makePlayer('player1', { knightsPlayed: 1 }),
        player2: makePlayer('player2', { knightsPlayed: 1, hand: makeHand({ wool: 1 }) }),
      },
    });
    expect(tbConflictChooser(s0)).toBeNull();
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('奪える相手（札1枚以上）が居ない→効果なし', () => {
    const s0 = tbState([card('conflict', 3)], {
      players: {
        player1: makePlayer('player1', { knightsPlayed: 2 }),
        player2: makePlayer('player2'),
      },
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
});

describe('交易優位(TRADE ADVANTAGE): 最長交易路タイル保持者が無作為1枚強奪', () => {
  it('保持者が居れば必須の強奪へ、居なければ効果なし', () => {
    const noHolder = applyAction(tbState([card('trade_advantage', 5)]), { type: 'ROLL_DICE' }, rng42());
    expect(noHolder.turnPhase).toBe('TRADE_BUILD');

    const s0 = tbState([card('trade_advantage', 5)], {
      players: {
        player1: makePlayer('player1', { hasLongestRoad: true }),
        player2: makePlayer('player2', { hand: makeHand({ grain: 3 }) }),
      },
      longestRoadHolder: 'player1',
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbPendingEventSteal).toEqual({ playerId: 'player1', optional: false });
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_STEAL', targetPlayerId: 'player2' }, rng42());
    expect(handTotalOf(s2, 'player1')).toBe(1);
    expect(handTotalOf(s2, 'player2')).toBe(2);
  });
});

// ============================================================
// 8. 地震(EARTHQUAKE): 道の損傷・建設制限・修理
// ============================================================

describe('地震(EARTHQUAKE): 各自 自分の道1本を損傷', () => {
  /** player1 に道1本を置いた地震直前状態を作る。 */
  function quakeSetup(): { s0: GameState; eid: EdgeId } {
    let s0 = tbState([card('earthquake', 6)]);
    const eid = Object.keys(s0.edges)[0]!;
    s0 = placeRoad(s0, eid, 'player1');
    return { s0, eid };
  }
  it('道を持つプレイヤーだけが対象。選んだ道が損傷し、解決後に生産へ', () => {
    const { s0, eid } = quakeSetup();
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('EVENT_DAMAGE');
    expect(s1.tbPendingEventDamage).toEqual(['player1']); // player2 は道なし＝対象外
    expect(tbEventPendingIds(s1)).toEqual(['player1']);
    // 他人の道・存在しない道は選べない
    expect(() => applyAction(s1, { type: 'CHOOSE_EVENT_DAMAGE', playerId: 'player1', edgeId: 'nope' }, rng42())).toThrow();
    const s2 = applyAction(s1, { type: 'CHOOSE_EVENT_DAMAGE', playerId: 'player1', edgeId: eid }, rng42());
    expect(s2.edges[eid]!.road!.damaged).toBe(true);
    expect(s2.turnPhase).toBe('TRADE_BUILD');
    expect(tbHasDamagedRoad(s2, 'player1')).toBe(true);
  });
  it('誰も道を持たない→効果なしで生産へ', () => {
    const s1 = applyAction(tbState([card('earthquake', 6)]), { type: 'ROLL_DICE' }, rng42());
    expect(s1.turnPhase).toBe('TRADE_BUILD');
  });
  it('損傷中は自分の道を追加建設できない（修理すると再び建設できる）', () => {
    let s = makeGameState({ tbEventCards: true });
    const eid = Object.keys(s.edges)[0]!;
    s = placeRoad(s, eid, 'player1', true); // 損傷道
    s = {
      ...s,
      players: { ...s.players, player1: { ...s.players['player1']!, hand: makeHand({ wood: 5, brick: 5 }) } },
    };
    // 損傷道に隣接する空き辺すら建設不可（全面禁止）
    const adjacent = s.edges[eid]!.adjacentEdgeIds.find(e2 => !s.edges[e2]!.road);
    expect(adjacent).toBeTruthy();
    expect(canBuildRoad(s, 'player1', adjacent!)).toBe(false);
    // 修理（レンガ1木1）
    const before = s.players['player1']!.hand;
    const repaired = applyAction(s, { type: 'REPAIR_ROAD', edgeId: eid }, rng42());
    expect(repaired.edges[eid]!.road!.damaged).toBeUndefined();
    expect(repaired.players['player1']!.hand.wood).toBe(before.wood - TB_ROAD_REPAIR_COST.wood);
    expect(repaired.players['player1']!.hand.brick).toBe(before.brick - TB_ROAD_REPAIR_COST.brick);
    expect(canBuildRoad(repaired, 'player1', adjacent!)).toBe(true);
  });
  it('REPAIR_ROAD の検証: 損傷していない道・他人の道・資源不足は違法', () => {
    let s = makeGameState({ tbEventCards: true });
    const [e1, e2] = Object.keys(s.edges) as [EdgeId, EdgeId];
    s = placeRoad(s, e1, 'player1');        // 無傷
    s = placeRoad(s, e2, 'player2', true);  // 他人の損傷道
    expect(() => applyAction(s, { type: 'REPAIR_ROAD', edgeId: e1 }, rng42())).toThrow();
    expect(() => applyAction(s, { type: 'REPAIR_ROAD', edgeId: e2 }, rng42())).toThrow();
    let s2 = makeGameState({ tbEventCards: true });
    const e3 = Object.keys(s2.edges)[0]!;
    s2 = placeRoad(s2, e3, 'player1', true);
    expect(() => applyAction(s2, { type: 'REPAIR_ROAD', edgeId: e3 }, rng42())).toThrow(); // 手札0
  });
  it('損傷道の隣の交差点には（誰も）開拓地を建てられない', () => {
    let s = makeGameState({ tbEventCards: true });
    const eid = Object.keys(s.edges)[0]!;
    s = placeRoad(s, eid, 'player2', true); // player2 の損傷道
    const vid = s.edges[eid]!.vertexIds[0];
    expect(tbVertexBlockedByDamagedRoad(s, vid)).toBe(true);
    // player1 に接続道＋資源を与えても、損傷道の隣は不可
    const conn = s.vertices[vid]!.adjacentEdgeIds.find(e2 => e2 !== eid)!;
    s = placeRoad(s, conn, 'player1');
    s = {
      ...s,
      players: { ...s.players, player1: { ...s.players['player1']!, hand: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }) } },
    };
    expect(canBuildSettlement(s, 'player1', vid)).toBe(false);
  });
  it('損傷した道も最長交易路に算入される', () => {
    let s = makeGameState();
    // player1 の連続した道5本（最長交易路の成立長）
    let cur = Object.values(s.vertices)[0]!;
    const used: EdgeId[] = [];
    for (let i = 0; i < 5; i++) {
      const nextEid = cur.adjacentEdgeIds.find(e => !used.includes(e))!;
      used.push(nextEid);
      s = placeRoad(s, nextEid, 'player1');
      const [a, b] = s.edges[nextEid]!.vertexIds;
      cur = s.vertices[a === cur.id ? b : a]!;
    }
    const before = calcLongestRoad(s, 'player1');
    // 途中の1本を損傷させても長さは変わらない
    s = { ...s, edges: { ...s.edges, [used[2]!]: { ...s.edges[used[2]!]!, road: { playerId: 'player1', damaged: true } } } };
    expect(calcLongestRoad(s, 'player1')).toBe(before);
  });
});

// ============================================================
// 9. CPU（AI）が全イベント選択を自動解決できる
// ============================================================

describe('AI: イベント選択フェーズの自動解決', () => {
  it('EVENT_GIVE: 一番多い資源を左隣へ渡す', () => {
    const s0 = tbState([card('good_neighbors', 6)], {
      players: {
        player1: makePlayer('player1', { type: 'ai', hand: makeHand({ wood: 1, ore: 3 }) }),
        player2: makePlayer('player2', { type: 'ai' }),
      },
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    const a = chooseAction(s1, 'player1', { rng: rng42() });
    expect(a).toEqual({ type: 'CHOOSE_EVENT_GIVE', playerId: 'player1', resource: 'ore' });
    expect(applyAction(s1, a!, rng42()).turnPhase).toBe('TRADE_BUILD');
  });
  it('EVENT_STEAL: 手札の多い相手を選んで奪う', () => {
    const s0 = tbState([card('trade_advantage', 5)], {
      players: {
        player1: makePlayer('player1', { type: 'ai', hasLongestRoad: true }),
        player2: makePlayer('player2', { type: 'ai', hand: makeHand({ grain: 4 }) }),
      },
      longestRoadHolder: 'player1',
    });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    const a = chooseAction(s1, 'player1', { rng: rng42() });
    expect(a).toEqual({ type: 'CHOOSE_EVENT_STEAL', targetPlayerId: 'player2' });
  });
  it('EVENT_DAMAGE / EVENT_HELPFUL: 対象プレイヤーの合法手を返し、適用で解決する', () => {
    // 地震
    let q0 = tbState([card('earthquake', 6)]);
    const eid = Object.keys(q0.edges)[0]!;
    q0 = placeRoad(q0, eid, 'player1');
    const q1 = applyAction(q0, { type: 'ROLL_DICE' }, rng42());
    const qa = chooseAction(q1, 'player1', { rng: rng42() });
    expect(qa?.type).toBe('CHOOSE_EVENT_DAMAGE');
    expect(applyAction(q1, qa!, rng42()).turnPhase).toBe('TRADE_BUILD');
    // 親切な隣人
    let h0 = tbState([card('helpful_neighbor', 10)], {
      players: {
        player1: makePlayer('player1', { type: 'ai', hand: makeHand({ wool: 2 }) }),
        player2: makePlayer('player2', { type: 'ai' }),
      },
    });
    h0 = place(h0, Object.keys(h0.vertices)[0]!, 'player1', 'settlement');
    const h1 = applyAction(h0, { type: 'ROLL_DICE' }, rng42());
    const ha = chooseAction(h1, 'player1', { rng: rng42() });
    expect(ha?.type).toBe('CHOOSE_EVENT_HELPFUL');
    expect(applyAction(h1, ha!, rng42()).turnPhase).toBe('TRADE_BUILD');
  });
});

// ============================================================
// 10. 既存シナリオへの不干渉
// ============================================================

describe('不干渉: eventCards 無効の盤ではダイス経路のまま', () => {
  it('classic の ROLL_DICE はイベントカード状態を作らない', () => {
    const s0 = makeGameState({ turnPhase: 'PRE_ROLL', diceRolledThisTurn: false });
    const s1 = applyAction(s0, { type: 'ROLL_DICE' }, rng42());
    expect(s1.tbLastEventCard).toBeUndefined();
    expect(s1.tbEventDeck).toBeUndefined();
    expect(s1.lastDiceRoll).not.toBeNull();
  });
  it('tbApplyEventEffect は new_year / beautiful_day で状態を変えない', () => {
    const s = makeGameState();
    expect(tbApplyEventEffect(s, card('beautiful_day', 8))).toBe(s);
    expect(tbApplyEventEffect(s, card('new_year', null))).toBe(s);
  });
});
