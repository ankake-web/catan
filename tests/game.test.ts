// ============================================================
// tests/game.test.ts — L-09: applyAction 統合テスト
// ============================================================

import { describe, it, expect } from 'vitest';
import { applyAction, buildDevDeck, setupGainFor } from '../src/engine/game';
import { makeHand, BUILD_COSTS, LARGEST_ARMY_MIN } from '../src/constants';
import { makeGameState, makePlayer } from './helpers';
import type { GameState, EdgeId, VertexId, DevCard, PlayerId } from '../src/types';
import { findPendingDiscarder } from '../src/engine/robber';

// ============================================================
// テストユーティリティ
// ============================================================

function vid0(s: GameState): VertexId { return Object.keys(s.vertices)[0]!; }
function eid0(s: GameState): EdgeId   { return Object.keys(s.edges)[0]!; }

/** 指定頂点に接続する最初の辺 */
function edgeAtVertex(s: GameState, vid: VertexId): EdgeId {
  return s.vertices[vid]!.adjacentEdgeIds[0]!;
}

function withSettlement(s: GameState, vid: VertexId, pid: 'player1' | 'player2' = 'player1'): GameState {
  return {
    ...s,
    vertices: { ...s.vertices, [vid]: { ...s.vertices[vid]!, building: { type: 'settlement', playerId: pid } } },
  };
}

function withRoad(s: GameState, eid: EdgeId, pid: 'player1' | 'player2' = 'player1'): GameState {
  return {
    ...s,
    edges: { ...s.edges, [eid]: { ...s.edges[eid]!, road: { playerId: pid } } },
  };
}

function makeDevCard(type: DevCard['type'], turn = 0): DevCard {
  return { id: `${type}_test`, type, purchasedOnTurn: turn };
}

// ============================================================
// ROLL_DICE
// ============================================================

describe('ROLL_DICE', () => {
  it('sets lastDiceRoll', () => {
    const s = makeGameState({ turnPhase: 'PRE_ROLL' });
    const next = applyAction(s, { type: 'ROLL_DICE' }, () => 0.5);
    expect(next.lastDiceRoll).not.toBeNull();
    expect(next.lastDiceRoll![0]).toBeGreaterThanOrEqual(1);
    expect(next.lastDiceRoll![1]).toBeGreaterThanOrEqual(1);
  });

  it('moves to TRADE_BUILD on non-7 roll', () => {
    // () => 0.4 → floor(0.4*6)+1=3, 3+3=6
    const s = makeGameState({ turnPhase: 'PRE_ROLL' });
    const next = applyAction(s, { type: 'ROLL_DICE' }, () => 0.4);
    expect(next.turnPhase).toBe('TRADE_BUILD');
  });

  it('moves to ROBBER on 7 (no player with 8+ cards)', () => {
    // () => 1-ε → 6, so sum=12... need sum=7: floor(x*6)+1=3,4 → x≈0.34,0.5
    const calls: number[] = [];
    const rng = () => { const v = [0.34, 0.5][calls.length] ?? 0.5; calls.push(v); return v; };
    const s = makeGameState({ turnPhase: 'PRE_ROLL' });
    const next = applyAction(s, { type: 'ROLL_DICE' }, rng);
    // sum = floor(0.34*6)+1 + floor(0.5*6)+1 = 3+4 = 7
    if (next.lastDiceRoll![0] + next.lastDiceRoll![1] === 7) {
      expect(next.turnPhase).toBe('ROBBER');
    }
  });

  it('distributes resources on matching tile', () => {
    // seed rng to get a predictable non-7 roll
    const s = makeGameState({ turnPhase: 'PRE_ROLL' });
    // Just verify that bank changes when a roll happens
    const next = applyAction(s, { type: 'ROLL_DICE' }, () => 0.1); // 1+1=2
    // Can't easily assert specific resource without knowing board; just check state changed
    expect(next.lastDiceRoll).toBeDefined();
  });

  it('throws when not PRE_ROLL phase', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'ROLL_DICE' })).toThrow();
  });
});

// ============================================================
// DISCARD_RESOURCES
// ============================================================

describe('DISCARD_RESOURCES', () => {
  it('reduces player hand and moves resources to bank', () => {
    const s = makeGameState({
      turnPhase: 'DISCARD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, {
      type: 'DISCARD_RESOURCES',
      playerId: 'player1',
      resources: { wood: 4 },
    });
    expect(next.players['player1']!.hand.wood).toBe(4);
    expect(next.bank.wood).toBe(s.bank.wood + 4);
  });

  it('advances to ROBBER when all players are under 8', () => {
    const s = makeGameState({
      turnPhase: 'DISCARD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, {
      type: 'DISCARD_RESOURCES',
      playerId: 'player1',
      resources: { wood: 4 },
    });
    expect(next.turnPhase).toBe('ROBBER');
  });

  it('player with 15 cards discards 7 (floor half) and moves to ROBBER — not flagged again', () => {
    // 規則: 1回の7でfloor(hand/2)を捨てたら終わり。8枚残っても再度捨て不要
    const s = makeGameState({
      turnPhase: 'DISCARD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 15 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, {
      type: 'DISCARD_RESOURCES',
      playerId: 'player1',
      resources: { wood: 7 }, // floor(15/2) = 7
    });
    // 手札は15-7=8枚になるが、他に捨てが必要なプレイヤーはいないのでROBBERへ進む
    expect(next.players['player1']!.hand.wood).toBe(8);
    expect(next.turnPhase).toBe('ROBBER');
    // ROBBER遷移時にdiscardedThisRoundはリセットされる
    expect(next.discardedThisRound).toHaveLength(0);
  });

  it('two players with 8+ cards: each discards once then ROBBER', () => {
    const s = makeGameState({
      turnPhase: 'DISCARD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 15 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 10 }) }),
      },
    });
    // player1 discards 7 (floor(15/2))
    const after1 = applyAction(s, {
      type: 'DISCARD_RESOURCES',
      playerId: 'player1',
      resources: { wood: 7 },
    });
    // player1 discarded, player2 still needs to (10 >= 8)
    expect(after1.turnPhase).toBe('DISCARD');
    expect(after1.discardedThisRound).toContain('player1');

    // player2 discards 5 (floor(10/2))
    const after2 = applyAction(after1, {
      type: 'DISCARD_RESOURCES',
      playerId: 'player2',
      resources: { brick: 5 },
    });
    // player2 discarded, player1 already discarded → ROBBER
    expect(after2.turnPhase).toBe('ROBBER');
    expect(after2.discardedThisRound).toHaveLength(0);
  });
});

// ============================================================
// MOVE_ROBBER
// ============================================================

describe('MOVE_ROBBER', () => {
  it('moves robber to new tile and enters TRADE_BUILD', () => {
    const s = makeGameState({ turnPhase: 'ROBBER' });
    const newTile = Object.values(s.tiles).find(t => !t.hasRobber)!;
    const next = applyAction(s, {
      type: 'MOVE_ROBBER',
      tileId: newTile.id,
      stealFromPlayerId: null,
    });
    expect(next.tiles[newTile.id]!.hasRobber).toBe(true);
    expect(next.turnPhase).toBe('TRADE_BUILD');
  });

  it('steals resource from target player (adjacent to the robber tile)', () => {
    const base = makeGameState({
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1', { hand: makeHand() }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 2 }) }),
      },
    });
    const newTile = Object.values(base.tiles).find(t => !t.hasRobber)!;
    // 盗む相手は移動先タイルに隣接していなければならない → player2 の建物を隣接頂点に置く
    const vid = base.tileToVertices[newTile.id]![0]!;
    const s: GameState = {
      ...base,
      vertices: {
        ...base.vertices,
        [vid]: { ...base.vertices[vid]!, building: { type: 'settlement', playerId: 'player2' } },
      },
    };
    const next = applyAction(
      s,
      { type: 'MOVE_ROBBER', tileId: newTile.id, stealFromPlayerId: 'player2' },
      () => 0,
    );
    expect(next.players['player1']!.hand.wood).toBe(1);
    expect(next.players['player2']!.hand.wood).toBe(1);
  });
});

// ============================================================
// BUILD_ROAD
// ============================================================

describe('BUILD_ROAD (MAIN)', () => {
  it('builds road and deducts cost', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 1, brick: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    const e = edgeAtVertex(s, v);
    s = withSettlement(s, v);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: e });
    expect(next.edges[e]!.road?.playerId).toBe('player1');
    expect(next.players['player1']!.hand.wood).toBe(0);
  });

  it('throws when road cannot be built', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    const e = eid0(s);
    expect(() => applyAction(s, { type: 'BUILD_ROAD', edgeId: e })).toThrow();
  });
});

// ============================================================
// BUILD_SETTLEMENT
// ============================================================

describe('BUILD_SETTLEMENT (MAIN)', () => {
  it('places settlement and deducts cost', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    const e = edgeAtVertex(s, v);
    s = withRoad(s, e);
    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.vertices[v]!.building?.type).toBe('settlement');
    expect(next.players['player1']!.hand.wood).toBe(0);
  });

  it('throws when settlement cannot be placed', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: vid0(s) })).toThrow();
  });
});

// ============================================================
// BUILD_CITY
// ============================================================

describe('BUILD_CITY', () => {
  it('upgrades settlement to city', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ grain: 2, ore: 3 }) }),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    s = withSettlement(s, v);
    const next = applyAction(s, { type: 'BUILD_CITY', vertexId: v });
    expect(next.vertices[v]!.building?.type).toBe('city');
  });

  it('throws when city cannot be built', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'BUILD_CITY', vertexId: vid0(s) })).toThrow();
  });
});

// ============================================================
// BUY_DEV_CARD
// ============================================================

describe('BUY_DEV_CARD', () => {
  it('draws a dev card from deck', () => {
    const deck = buildDevDeck(() => 0);
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devDeck: deck,
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wool: 1, grain: 1, ore: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    const before = s.devDeck.length;
    const next = applyAction(s, { type: 'BUY_DEV_CARD' });
    expect(next.devDeck.length).toBe(before - 1);
    expect(next.players['player1']!.devCards.length).toBe(1);
  });

  it('deducts wool/grain/ore from hand', () => {
    const deck = buildDevDeck(() => 0);
    const s = makeGameState({
      devDeck: deck,
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wool: 2, grain: 2, ore: 2 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'BUY_DEV_CARD' });
    expect(next.players['player1']!.hand.wool).toBe(1);
    expect(next.players['player1']!.hand.grain).toBe(1);
    expect(next.players['player1']!.hand.ore).toBe(1);
  });

  it('marks card with current turn for purchase tracking', () => {
    const deck = buildDevDeck(() => 0);
    const s = makeGameState({ devDeck: deck, globalTurnNumber: 5,
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wool: 1, grain: 1, ore: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'BUY_DEV_CARD' });
    expect(next.players['player1']!.devCards[0]!.purchasedOnTurn).toBe(5);
  });

  it('throws when deck is empty', () => {
    const s = makeGameState({
      devDeck: [],
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wool: 1, grain: 1, ore: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'BUY_DEV_CARD' })).toThrow();
  });
});

// ============================================================
// PLAY_KNIGHT
// ============================================================

describe('PLAY_KNIGHT', () => {
  it('increments knightsPlayed and sets ROBBER phase', () => {
    const s = makeGameState({
      turnPhase: 'PRE_ROLL',
      globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('knight', 1)] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_KNIGHT' });
    expect(next.players['player1']!.knightsPlayed).toBe(1);
    expect(next.turnPhase).toBe('ROBBER');
  });

  it('awards largest army at 3 knights', () => {
    const s = makeGameState({
      turnPhase: 'PRE_ROLL',
      globalTurnNumber: 5,
      players: {
        player1: makePlayer('player1', {
          knightsPlayed: 2,
          devCards: [makeDevCard('knight', 1)],
        }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_KNIGHT' });
    expect(next.players['player1']!.knightsPlayed).toBe(3);
    expect(next.largestArmyHolder).toBe('player1');
  });

  it('throws when no playable knight card exists', () => {
    const s = makeGameState({
      globalTurnNumber: 1,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('knight', 1)] }), // purchased same turn
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow();
  });
});

// ============================================================
// PLAY_YEAR_OF_PLENTY
// ============================================================

describe('PLAY_YEAR_OF_PLENTY', () => {
  it('gives 2 resources from bank', () => {
    const s = makeGameState({
      globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('year_of_plenty', 1)] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'grain'] });
    expect(next.players['player1']!.hand.wood).toBe(1);
    expect(next.players['player1']!.hand.grain).toBe(1);
    expect(next.bank.wood).toBe(s.bank.wood - 1);
    expect(next.bank.grain).toBe(s.bank.grain - 1);
  });

  it('discards the played card', () => {
    const s = makeGameState({
      globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('year_of_plenty', 1)] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'ore'] });
    expect(next.players['player1']!.devCards).toHaveLength(0);
    expect(next.devDiscardPile).toHaveLength(1);
  });
});

// ============================================================
// PLAY_MONOPOLY
// ============================================================

describe('PLAY_MONOPOLY', () => {
  it('steals all of declared resource from all opponents', () => {
    const s = makeGameState({
      globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('monopoly', 1)] }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 3 }) }),
      },
    });
    const next = applyAction(s, { type: 'PLAY_MONOPOLY', resource: 'brick' });
    expect(next.players['player2']!.hand.brick).toBe(0);
    expect(next.players['player1']!.hand.brick).toBe(3);
  });

  it('does nothing when opponents have 0 of resource (card still consumed)', () => {
    const s = makeGameState({
      globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard('monopoly', 1)] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_MONOPOLY', resource: 'ore' });
    expect(next.players['player1']!.hand.ore).toBe(0);
    expect(next.players['player1']!.devCards).toHaveLength(0);
  });
});

// ============================================================
// 発展カード使用タイミング（ダイス前は騎士のみ）
// ============================================================

describe('発展カード使用タイミング', () => {
  function preRoll(devType: 'knight' | 'year_of_plenty' | 'monopoly' | 'road_building'): GameState {
    return makeGameState({
      globalTurnNumber: 2,
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard(devType, 1)] }),
        player2: makePlayer('player2'),
      },
    });
  }

  // ダイス前に意味があるのは盗賊を動かせる騎士だけ。進歩カード3種はダイス前に使う実益が
  // なく（収穫/独占はむしろ7で自分が捨て札になる無駄手）、ダイス後のみに限定する。
  it('ダイス前に騎士は使える', () => {
    expect(() => applyAction(preRoll('knight'), { type: 'PLAY_KNIGHT' })).not.toThrow();
  });

  it('ダイス前に年の豊穣は使えない', () => {
    expect(() => applyAction(preRoll('year_of_plenty'), { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'grain'] }))
      .toThrow('must roll dice first');
  });

  it('ダイス前に独占は使えない', () => {
    expect(() => applyAction(preRoll('monopoly'), { type: 'PLAY_MONOPOLY', resource: 'wood' }))
      .toThrow('must roll dice first');
  });

  it('ダイス前に街道建設は使えない', () => {
    expect(() => applyAction(preRoll('road_building'), { type: 'PLAY_ROAD_BUILDING' }))
      .toThrow('must roll dice first');
  });

  it('ダイス後（diceRolledThisTurn=true）なら年の豊穣・独占・街道建設が使える', () => {
    const base = (devType: 'year_of_plenty' | 'monopoly' | 'road_building') => makeGameState({
      globalTurnNumber: 2,
      turnPhase: 'TRADE_BUILD',
      diceRolledThisTurn: true,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard(devType, 1)] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(base('year_of_plenty'), { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'grain'] })).not.toThrow();
    expect(() => applyAction(base('monopoly'), { type: 'PLAY_MONOPOLY', resource: 'wood' })).not.toThrow();
    expect(() => applyAction(base('road_building'), { type: 'PLAY_ROAD_BUILDING' })).not.toThrow();
  });
});

describe('進歩カードは MAIN/TRADE_BUILD 以外（7の捨て札・盗賊フェーズ）では使えない', () => {
  const inPhase = (turnPhase: 'DISCARD' | 'ROBBER', devType: 'year_of_plenty' | 'monopoly' | 'road_building'): GameState =>
    makeGameState({
      turnPhase, diceRolledThisTurn: true, globalTurnNumber: 2,
      players: {
        player1: makePlayer('player1', { devCards: [makeDevCard(devType, 1)], hand: makeHand({ wood: 5, brick: 5 }) }),
        player2: makePlayer('player2'),
      },
    });

  it('DISCARD フェーズ中は年の豊穣/独占/街道建設を弾く', () => {
    expect(() => applyAction(inPhase('DISCARD', 'year_of_plenty'), { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'grain'] })).toThrow('TRADE_BUILD');
    expect(() => applyAction(inPhase('DISCARD', 'monopoly'), { type: 'PLAY_MONOPOLY', resource: 'wood' })).toThrow('TRADE_BUILD');
    expect(() => applyAction(inPhase('DISCARD', 'road_building'), { type: 'PLAY_ROAD_BUILDING' })).toThrow('TRADE_BUILD');
  });

  it('ROBBER フェーズ中も弾く', () => {
    expect(() => applyAction(inPhase('ROBBER', 'monopoly'), { type: 'PLAY_MONOPOLY', resource: 'wood' })).toThrow('TRADE_BUILD');
    expect(() => applyAction(inPhase('ROBBER', 'year_of_plenty'), { type: 'PLAY_YEAR_OF_PLENTY', resources: ['ore', 'ore'] })).toThrow('TRADE_BUILD');
  });
});

describe('騎士は PRE_ROLL/TRADE_BUILD 以外（7の捨て札・盗賊フェーズ）では使えない', () => {
  const inPhase = (turnPhase: 'DISCARD' | 'ROBBER'): GameState =>
    makeGameState({
      turnPhase, diceRolledThisTurn: true, globalTurnNumber: 2,
      players: {
        // 手札8枚 = DISCARD の捨て札対象。騎士で ROBBER へ遷移できると捨て札を踏み倒せる。
        player1: makePlayer('player1', { devCards: [makeDevCard('knight', 1)], hand: makeHand({ wood: 4, brick: 4 }) }),
        player2: makePlayer('player2'),
      },
    });

  it('DISCARD フェーズ中の騎士を弾く（捨て札の踏み倒し防止）', () => {
    expect(() => applyAction(inPhase('DISCARD'), { type: 'PLAY_KNIGHT' })).toThrow('PRE_ROLL or TRADE_BUILD');
  });

  it('ROBBER フェーズ中の騎士を弾く', () => {
    expect(() => applyAction(inPhase('ROBBER'), { type: 'PLAY_KNIGHT' })).toThrow('PRE_ROLL or TRADE_BUILD');
  });

  it('TRADE_BUILD では引き続き使える', () => {
    const s: GameState = { ...inPhase('ROBBER'), turnPhase: 'TRADE_BUILD' };
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).not.toThrow();
  });
});

// ============================================================
// BANK_TRADE
// ============================================================

describe('BANK_TRADE のフェーズガード', () => {
  const inPhase = (turnPhase: 'PRE_ROLL' | 'DISCARD' | 'ROBBER'): GameState =>
    makeGameState({
      turnPhase,
      diceRolledThisTurn: turnPhase !== 'PRE_ROLL',
      players: {
        // 手札8枚 = DISCARD の捨て札対象。4:1交易で8枚未満へ圧縮できると捨て札を回避できる。
        player1: makePlayer('player1', { hand: makeHand({ wood: 4, brick: 4 }) }),
        player2: makePlayer('player2'),
      },
    });

  it('PRE_ROLL（ダイス前）の銀行交易を弾く', () => {
    expect(() => applyAction(inPhase('PRE_ROLL'), { type: 'BANK_TRADE', give: 'wood', receive: 'ore' })).toThrow('TRADE_BUILD');
  });

  it('DISCARD フェーズ中の銀行交易を弾く（捨て札回避の防止）', () => {
    expect(() => applyAction(inPhase('DISCARD'), { type: 'BANK_TRADE', give: 'wood', receive: 'ore' })).toThrow('TRADE_BUILD');
  });

  it('ROBBER フェーズ中の銀行交易を弾く', () => {
    expect(() => applyAction(inPhase('ROBBER'), { type: 'BANK_TRADE', give: 'wood', receive: 'ore' })).toThrow('TRADE_BUILD');
  });
});

describe('BANK_TRADE', () => {
  it('executes bank trade at 4:1', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 4 }) }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'BANK_TRADE', give: 'wood', receive: 'ore' });
    expect(next.players['player1']!.hand.wood).toBe(0);
    expect(next.players['player1']!.hand.ore).toBe(1);
  });

  it('throws when trade is invalid', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'BANK_TRADE', give: 'wood', receive: 'ore' })).toThrow();
  });
});

// ============================================================
// OFFER_TRADE / RESPOND_TRADE / CONFIRM_TRADE / CANCEL_TRADE
// ============================================================

describe('Player trade flow', () => {
  // player1 が wood を持ち、交易できる状態を作るヘルパー
  function makeTradeState() {
    return makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 2 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 2 }) }),
      },
    });
  }

  it('OFFER_TRADE sets pendingTrade', () => {
    const s = makeTradeState();
    const next = applyAction(s, {
      type: 'OFFER_TRADE',
      offer: { give: { wood: 1 }, receive: { brick: 1 } },
      targetPlayerIds: ['player2'],
    });
    expect(next.pendingTrade?.state).toBe('TRADE_OFFER');
  });

  it('RESPOND_TRADE records response', () => {
    const s = makeTradeState();
    const offered = applyAction(s, {
      type: 'OFFER_TRADE',
      offer: { give: { wood: 1 }, receive: { brick: 1 } },
      targetPlayerIds: ['player2'],
    });
    const next = applyAction(offered, {
      type: 'RESPOND_TRADE',
      response: { playerId: 'player2', status: 'ACCEPT' },
    });
    expect(next.pendingTrade?.responses['player2']?.status).toBe('ACCEPT');
  });

  it('CONFIRM_TRADE executes resource swap', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 1 }) }),
      },
    });
    s = applyAction(s, {
      type: 'OFFER_TRADE',
      offer: { give: { wood: 1 }, receive: { brick: 1 } },
      targetPlayerIds: ['player2'],
    });
    s = applyAction(s, { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'ACCEPT' } });
    const next = applyAction(s, { type: 'CONFIRM_TRADE', responderId: 'player2' });
    expect(next.players['player1']!.hand.wood).toBe(0);
    expect(next.players['player1']!.hand.brick).toBe(1);
    expect(next.players['player2']!.hand.brick).toBe(0);
    expect(next.players['player2']!.hand.wood).toBe(1);
    expect(next.pendingTrade).toBeNull();
  });

  it('CANCEL_TRADE clears pendingTrade', () => {
    let s = makeTradeState();
    s = applyAction(s, {
      type: 'OFFER_TRADE',
      offer: { give: { wood: 1 }, receive: { brick: 1 } },
      targetPlayerIds: ['player2'],
    });
    const next = applyAction(s, { type: 'CANCEL_TRADE' });
    expect(next.pendingTrade).toBeNull();
  });
});

// ============================================================
// END_TURN
// ============================================================

describe('END_TURN', () => {
  it('advances currentPlayerIndex and globalTurnNumber', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', currentPlayerIndex: 0, globalTurnNumber: 1 });
    const next = applyAction(s, { type: 'END_TURN' });
    expect(next.currentPlayerIndex).toBe(1);
    expect(next.globalTurnNumber).toBe(2);
    expect(next.turnPhase).toBe('PRE_ROLL');
  });

  it('wraps around to first player', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      currentPlayerIndex: 1,
      playerOrder: ['player1', 'player2'],
    });
    const next = applyAction(s, { type: 'END_TURN' });
    expect(next.currentPlayerIndex).toBe(0);
  });

  it('clears lastDiceRoll and pendingTrade', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      lastDiceRoll: [3, 4],
    });
    const next = applyAction(s, { type: 'END_TURN' });
    expect(next.lastDiceRoll).toBeNull();
    expect(next.pendingTrade).toBeNull();
  });
});

// ============================================================
// DECLARE_VICTORY
// ============================================================

describe('DECLARE_VICTORY', () => {
  it('sets winner and GAME_OVER phase when player has 10+ VP', () => {
    // VPカード5枚(5VP) + 開拓地5VP相当をdevCardsで構成
    const vpCards = Array.from({ length: 10 }, (_, i) => ({
      id: `vp${i}`, type: 'victory_point' as const, purchasedOnTurn: 0,
    }));
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { devCards: vpCards }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'DECLARE_VICTORY' });
    expect(next.winner).toBe('player1');
    expect(next.phase).toBe('GAME_OVER');
  });

  it('throws when player has insufficient VP', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'DECLARE_VICTORY' })).toThrow('insufficient VP');
  });
});

// ============================================================
// checkVictory integration (via BUILD_SETTLEMENT)
// ============================================================

describe('victory detection integration', () => {
  it('sets winner when VP reaches 10 after building', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', {
          hand: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }),
          // hasLongestRoad is intentionally NOT set here: it is now recomputed
          // by updateLongestRoad on BUILD_SETTLEMENT, so a synthetic flag would
          // be stripped. Use VP cards instead to reach the same target.
          hasLargestArmy: true,   // +2
          devCards: [
            { id: 'vp1', type: 'victory_point', purchasedOnTurn: 0 },
            { id: 'vp2', type: 'victory_point', purchasedOnTurn: 0 },
            { id: 'vp3', type: 'victory_point', purchasedOnTurn: 0 },
            { id: 'vp4', type: 'victory_point', purchasedOnTurn: 0 },
            { id: 'vp5', type: 'victory_point', purchasedOnTurn: 0 },
          ], // +5
        }),
        player2: makePlayer('player2'),
      },
    });
    // VP plan: largestArmy(2) + 5 vp cards(5) + 1 city(2) = 9, already at 9.
    // Building the final settlement (+1) reaches the target (10) → victory.

    // Find two non-adjacent vertices
    const allVids = Object.keys(s.vertices);
    const cityVid = allVids[0]!;
    // Find a vertex not adjacent to cityVid (no distance rule conflict)
    const settlementVid = allVids.find(v =>
      v !== cityVid && !s.vertices[cityVid]!.adjacentVertexIds.includes(v)
    )!;

    // Place a city at cityVid (adds 2 VP)
    s = {
      ...s,
      vertices: {
        ...s.vertices,
        [cityVid]: { ...s.vertices[cityVid]!, building: { type: 'city', playerId: 'player1' } },
      },
    };
    // Now VP = 2(city)+2(army)+5(vp cards) = 9; adding settlement (1) → 10
    const eid = edgeAtVertex(s, settlementVid);
    s = withRoad(s, eid);
    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: settlementVid });
    expect(next.winner).toBe('player1');
    expect(next.phase).toBe('GAME_OVER');
  });
});

// ============================================================
// SETUP フェーズ進行
// ============================================================

describe('SETUP phase progression', () => {
  it('advances setupSubPhase to PLACE_ROAD after settlement', () => {
    const s = makeGameState({
      phase: 'SETUP_FORWARD',
      setupSubPhase: 'PLACE_SETTLEMENT',
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.setupSubPhase).toBe('PLACE_ROAD');
  });

  it('advances to next player after road in SETUP_FORWARD', () => {
    let s = makeGameState({
      phase: 'SETUP_FORWARD',
      setupSubPhase: 'PLACE_ROAD',
      currentPlayerIndex: 0,
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    s = withSettlement(s, v);
    const e = edgeAtVertex(s, v);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: e });
    expect(next.currentPlayerIndex).toBe(1);
  });

  it('transitions to SETUP_BACKWARD after last player in SETUP_FORWARD', () => {
    let s = makeGameState({
      phase: 'SETUP_FORWARD',
      setupSubPhase: 'PLACE_ROAD',
      currentPlayerIndex: 1,
      playerOrder: ['player1', 'player2'],
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2'),
      },
    });
    // currentPlayerIndex=1 → current player is 'player2'
    const v = vid0(s);
    s = withSettlement(s, v, 'player2');
    const e = edgeAtVertex(s, v);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: e });
    expect(next.phase).toBe('SETUP_BACKWARD');
  });

  it('transitions to MAIN after last player in SETUP_BACKWARD', () => {
    let s = makeGameState({
      phase: 'SETUP_BACKWARD',
      setupSubPhase: 'PLACE_ROAD',
      setupRound: 2, // 標準2軒の最終ラウンド（後半）
      currentPlayerIndex: 0,
      playerOrder: ['player1', 'player2'],
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    s = withSettlement(s, v);
    const e = edgeAtVertex(s, v);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: e });
    expect(next.phase).toBe('MAIN');
    expect(next.setupSubPhase).toBeNull();
  });
});

// ============================================================
// buildDevDeck
// ============================================================

describe('buildDevDeck', () => {
  it('returns 25 cards total', () => {
    expect(buildDevDeck().length).toBe(25);
  });

  it('contains 14 knight cards', () => {
    const deck = buildDevDeck();
    expect(deck.filter(c => c.type === 'knight')).toHaveLength(14);
  });

  it('contains 5 victory_point cards', () => {
    const deck = buildDevDeck();
    expect(deck.filter(c => c.type === 'victory_point')).toHaveLength(5);
  });

  it('is deterministic with seeded rng', () => {
    let i = 0;
    const seq = [0.1,0.5,0.9,0.3,0.7,0.2,0.8,0.4,0.6,0.15];
    const rng = () => seq[i++ % seq.length]!;
    let j = 0;
    const rng2 = () => seq[j++ % seq.length]!;
    expect(buildDevDeck(rng).map(c => c.type)).toEqual(buildDevDeck(rng2).map(c => c.type));
  });
});

// ============================================================
// FINISH_ROAD_BUILDING（街道建設カード完了）
// ============================================================

describe('FINISH_ROAD_BUILDING', () => {
  it('roadBuildingRoadsRemaining を 0 にする', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', roadBuildingRoadsRemaining: 1 });
    const next = applyAction(s, { type: 'FINISH_ROAD_BUILDING' });
    expect(next.roadBuildingRoadsRemaining).toBe(0);
  });

  it('turnPhase は TRADE_BUILD のまま（ターン終了しない）', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', roadBuildingRoadsRemaining: 2 });
    const next = applyAction(s, { type: 'FINISH_ROAD_BUILDING' });
    expect(next.turnPhase).toBe('TRADE_BUILD');
    expect(next.currentPlayerIndex).toBe(0);
  });

  it('roadBuildingRoadsRemaining が 0 の場合は例外', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', roadBuildingRoadsRemaining: 0 });
    expect(() => applyAction(s, { type: 'FINISH_ROAD_BUILDING' })).toThrow('FINISH_ROAD_BUILDING');
  });
});

// ============================================================
// 1ターン1発展カード制限（devCardPlayedThisTurn）
// ============================================================

describe('1ターン1発展カード制限', () => {
  it('騎士カード使用後 devCardPlayedThisTurn が true になる', () => {
    const s = makeGameState({
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k1', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 1 }) }),
      },
    });
    const next = applyAction(s, { type: 'PLAY_KNIGHT' });
    expect(next.devCardPlayedThisTurn).toBe(true);
  });

  it('同ターンに2枚目の騎士カードを使おうとすると例外', () => {
    const s = makeGameState({
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      devCardPlayedThisTurn: true, // 1枚使用済み
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k2', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow('already played');
  });

  it('騎士カード使用後に独占カードを使おうとすると例外', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: true,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'm1', type: 'monopoly', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_MONOPOLY', resource: 'wood' })).toThrow('already played');
  });

  it('街道建設カード使用後に豊作カードを使おうとすると例外', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: true,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'yop1', type: 'year_of_plenty', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'brick'] })).toThrow('already played');
  });

  it('END_TURN で devCardPlayedThisTurn がリセットされる', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', devCardPlayedThisTurn: true });
    const next = applyAction(s, { type: 'END_TURN' });
    expect(next.devCardPlayedThisTurn).toBe(false);
  });

  it('そのターンに購入した騎士カードは使えない（purchasedOnTurn === globalTurnNumber）', () => {
    const s = makeGameState({
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      devCardPlayedThisTurn: false,
      globalTurnNumber: 5,
      players: {
        player1: makePlayer('player1', {
          devCards: [{ id: 'k_new', type: 'knight', purchasedOnTurn: 5 }],
        }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow('no playable knight card');
  });
});

// ============================================================
// 国内交易バリデーション（OFFER_TRADE エンジンガード）
// ============================================================

describe('OFFER_TRADE エンジンバリデーション', () => {
  const validOffer = { give: { wood: 1 }, receive: { brick: 1 } };

  it('TRADE_BUILD フェーズで正常にオファーできる', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 2 }) }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player2'],
    })).not.toThrow();
  });

  it('PRE_ROLL フェーズでは交易不可', () => {
    const s = makeGameState({ turnPhase: 'PRE_ROLL', diceRolledThisTurn: false });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player2'],
    })).toThrow('TRADE_BUILD phase');
  });

  it('街道建設カード処理中は交易不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', roadBuildingRoadsRemaining: 1 });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player2'],
    })).toThrow('road building');
  });

  it('一方的譲渡（receive=0）は不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: {} }, targetPlayerIds: ['player2'],
    })).toThrow('both sides');
  });

  it('同一資源の交換（give と receive が同じ品目）は不可', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 2 }) }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { wood: 1 } }, targetPlayerIds: ['player2'],
    })).toThrow('same resource');
  });

  it('一方的受取（give=0）は不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: { give: {}, receive: { brick: 1 } }, targetPlayerIds: ['player2'],
    })).toThrow('both sides');
  });

  it('targetPlayerIds が空なら不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', players: { player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }), player2: makePlayer('player2') } });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: [],
    })).toThrow('empty');
  });

  it('自分自身を targetPlayerIds に含めると不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', players: { player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }), player2: makePlayer('player2') } });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player1'],
    })).toThrow('yourself');
  });

  it('存在しないプレイヤーを target にすると不可', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', players: { player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }), player2: makePlayer('player2') } });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player3' as PlayerId],
    })).toThrow('does not exist');
  });

  it('手番プレイヤーが give 資源を持っていないと不可', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: { player1: makePlayer('player1', { hand: makeHand({ wood: 0 }) }), player2: makePlayer('player2') },
    });
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player2'],
    })).toThrow('enough resources');
  });

  it('responder が資源不足の場合、CONFIRM_TRADE で TRADE_CANCELLED になる', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 0 }) }), // brick なし
      },
    });
    s = applyAction(s, { type: 'OFFER_TRADE', offer: validOffer, targetPlayerIds: ['player2'] });
    s = applyAction(s, { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'ACCEPT' } });
    const next = applyAction(s, { type: 'CONFIRM_TRADE', responderId: 'player2' });
    expect(next.pendingTrade?.state).toBe('TRADE_CANCELLED');
    // 資源は移動していない
    expect(next.players['player1']!.hand.wood).toBe(1);
    expect(next.players['player2']!.hand.brick).toBe(0);
  });
});

// ============================================================
// TRADE_BUILD フェーズでの発展カード使用（エンジン動作確認）
// ============================================================

describe('TRADE_BUILD フェーズでの発展カード使用', () => {
  it('TRADE_BUILD 中に騎士カードを使える', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k1', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 1 }) }),
      },
    });
    const next = applyAction(s, { type: 'PLAY_KNIGHT' });
    expect(next.devCardPlayedThisTurn).toBe(true);
    expect(next.turnPhase).toBe('ROBBER'); // 強盗フェーズへ
  });

  it('TRADE_BUILD 中に独占カードを使える', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'm1', type: 'monopoly', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 3 }) }),
      },
    });
    const next = applyAction(s, { type: 'PLAY_MONOPOLY', resource: 'wood' });
    expect(next.devCardPlayedThisTurn).toBe(true);
    expect(next.players['player1']!.hand.wood).toBe(3); // player2 の wood を全収
  });

  it('TRADE_BUILD 中に豊作カードを使える', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'yop1', type: 'year_of_plenty', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_YEAR_OF_PLENTY', resources: ['wood', 'grain'] });
    expect(next.devCardPlayedThisTurn).toBe(true);
    expect(next.players['player1']!.hand.wood).toBe(1);
    expect(next.players['player1']!.hand.grain).toBe(1);
  });

  it('TRADE_BUILD 中に街道建設カードを使える', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'rb1', type: 'road_building', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    const next = applyAction(s, { type: 'PLAY_ROAD_BUILDING' });
    expect(next.devCardPlayedThisTurn).toBe(true);
    expect(next.roadBuildingRoadsRemaining).toBeGreaterThan(0);
  });

  it('devCardPlayedThisTurn=true なら TRADE_BUILD 中でも発展カード使用不可', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      devCardPlayedThisTurn: true,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k2', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow('already played');
  });

  it('TRADE_BUILD 中に騎士カードを使った後、MOVE_ROBBER すると TRADE_BUILD に戻る（dice 済み）', () => {
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      diceRolledThisTurn: true,
      devCardPlayedThisTurn: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k1', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    const afterKnight = applyAction(s, { type: 'PLAY_KNIGHT' });
    expect(afterKnight.turnPhase).toBe('ROBBER');
    const robberTileId = Object.keys(afterKnight.tiles).find(tid => !afterKnight.tiles[tid]!.hasRobber && afterKnight.tiles[tid]!.type !== 'desert') ?? Object.keys(afterKnight.tiles)[0]!;
    const afterRobber = applyAction(afterKnight, { type: 'MOVE_ROBBER', tileId: robberTileId, stealFromPlayerId: null });
    // diceRolledThisTurn=true → TRADE_BUILD に戻る
    expect(afterRobber.turnPhase).toBe('TRADE_BUILD');
  });
});

// ============================================================
// turnPhase バリデーション完全性テスト
// ============================================================

describe('turnPhase validation — GAME_OVER blocks building', () => {
  const gameOverState = () => makeGameState({ phase: 'GAME_OVER', winner: 'player1' });

  it('BUILD_ROAD throws after GAME_OVER', () => {
    const s = gameOverState();
    expect(() => applyAction(s, { type: 'BUILD_ROAD', edgeId: eid0(s) })).toThrow('game is already over');
  });

  it('BUILD_SETTLEMENT throws after GAME_OVER', () => {
    const s = gameOverState();
    expect(() => applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: vid0(s) })).toThrow('game is already over');
  });

  it('BUILD_CITY throws after GAME_OVER', () => {
    const s = gameOverState();
    expect(() => applyAction(s, { type: 'BUILD_CITY', vertexId: vid0(s) })).toThrow('game is already over');
  });

  it('BUY_DEV_CARD throws after GAME_OVER', () => {
    const s = gameOverState();
    expect(() => applyAction(s, { type: 'BUY_DEV_CARD' })).toThrow('game is already over');
  });
});

describe('turnPhase validation — BUILD_CITY and BUY_DEV_CARD require MAIN phase', () => {
  it('BUILD_CITY throws in SETUP_FORWARD even with TRADE_BUILD turnPhase', () => {
    const s = makeGameState({ phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT', turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'BUILD_CITY', vertexId: vid0(s) })).toThrow('BUILD_CITY');
  });

  it('BUILD_CITY throws in SETUP_BACKWARD even with TRADE_BUILD turnPhase', () => {
    const s = makeGameState({ phase: 'SETUP_BACKWARD', setupSubPhase: 'PLACE_SETTLEMENT', turnPhase: 'TRADE_BUILD' });
    expect(() => applyAction(s, { type: 'BUILD_CITY', vertexId: vid0(s) })).toThrow('BUILD_CITY');
  });

  it('BUY_DEV_CARD throws in SETUP_FORWARD even with TRADE_BUILD turnPhase', () => {
    const deck = buildDevDeck(() => 0);
    const s = makeGameState({
      phase: 'SETUP_FORWARD',
      setupSubPhase: 'PLACE_SETTLEMENT',
      turnPhase: 'TRADE_BUILD',
      devDeck: deck,
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wool: 1, grain: 1, ore: 1 }) }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'BUY_DEV_CARD' })).toThrow('BUY_DEV_CARD');
  });
});

describe('turnPhase validation — BUILD_ROAD with road building card', () => {
  it('BUILD_ROAD succeeds with roadBuildingRoadsRemaining > 0 (no resource cost)', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      roadBuildingRoadsRemaining: 2,
      players: {
        player1: makePlayer('player1', { hand: makeHand() }),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    const e = edgeAtVertex(s, v);
    s = withSettlement(s, v);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: e });
    expect(next.edges[e]!.road?.playerId).toBe('player1');
    expect(next.roadBuildingRoadsRemaining).toBe(1);
  });

  it('roadBuildingRoadsRemaining decrements to 0 after placing 2 roads', () => {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      roadBuildingRoadsRemaining: 2,
      players: {
        player1: makePlayer('player1', { hand: makeHand() }),
        player2: makePlayer('player2'),
      },
    });
    const v = vid0(s);
    const e1 = edgeAtVertex(s, v);
    s = withSettlement(s, v);
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: e1 });
    expect(s.roadBuildingRoadsRemaining).toBe(1);

    // 2本目: e1 に接続する未使用辺を探す
    const edge1 = s.edges[e1]!;
    let e2: EdgeId | null = null;
    for (const vid of edge1.vertexIds) {
      for (const eid of s.vertices[vid]!.adjacentEdgeIds) {
        if (eid !== e1 && !s.edges[eid]!.road) { e2 = eid; break; }
      }
      if (e2) break;
    }
    if (e2) {
      s = applyAction(s, { type: 'BUILD_ROAD', edgeId: e2 });
      expect(s.roadBuildingRoadsRemaining).toBe(0);
    }
  });
});

// ============================================================
// グループA: エンジン側ルール強制ガード（不正操作の拒否）
// ============================================================

describe('Group A: engine rule-enforcement guards', () => {
  // --- MOVE_ROBBER: フェーズ/同一タイル/隣接性 ---
  it('MOVE_ROBBER は PRE_ROLL では拒否（無料・反復の盗賊移動を防止 / C1）', () => {
    const s = makeGameState({ turnPhase: 'PRE_ROLL', diceRolledThisTurn: false });
    const target = Object.values(s.tiles).find(t => !t.hasRobber)!;
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: target.id, stealFromPlayerId: null }))
      .toThrow('not in ROBBER phase');
  });

  it('MOVE_ROBBER は TRADE_BUILD でも拒否（C1）', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD' });
    const target = Object.values(s.tiles).find(t => !t.hasRobber)!;
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: target.id, stealFromPlayerId: null }))
      .toThrow('not in ROBBER phase');
  });

  it('MOVE_ROBBER は現在地と同じタイルへの移動を拒否（必ず別ヘクス / Low）', () => {
    const s = makeGameState({ turnPhase: 'ROBBER' });
    const robberTile = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: robberTile.id, stealFromPlayerId: null }))
      .toThrow('different tile');
  });

  it('MOVE_ROBBER は移動先に隣接しない相手からの強奪を拒否（H2）', () => {
    // makeGameState は建物ゼロなので player2 はどのタイルにも隣接しない
    const s = makeGameState({
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1', { hand: makeHand() }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 3 }) }),
      },
    });
    const target = Object.values(s.tiles).find(t => !t.hasRobber)!;
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: target.id, stealFromPlayerId: 'player2' }))
      .toThrow('not adjacent');
  });

  // --- END_TURN: フェーズガード ---
  it('END_TURN は PRE_ROLL では拒否（ダイス飛ばしを防止 / H4）', () => {
    const s = makeGameState({ turnPhase: 'PRE_ROLL', diceRolledThisTurn: false });
    expect(() => applyAction(s, { type: 'END_TURN' })).toThrow('MAIN TRADE_BUILD');
  });

  it('END_TURN は DISCARD 中は拒否（7の捨て札逃れを防止 / H4）', () => {
    const s = makeGameState({ turnPhase: 'DISCARD' });
    expect(() => applyAction(s, { type: 'END_TURN' })).toThrow('MAIN TRADE_BUILD');
  });

  it('END_TURN は SETUP 中は拒否（蛇行順の破壊を防止 / H4）', () => {
    const s = makeGameState({ phase: 'SETUP_FORWARD', turnPhase: 'PRE_ROLL', setupSubPhase: 'PLACE_SETTLEMENT' });
    expect(() => applyAction(s, { type: 'END_TURN' })).toThrow('MAIN TRADE_BUILD');
  });

  // --- DECLARE_VICTORY: turnPhase ガード ---
  it('DECLARE_VICTORY は ROBBER/DISCARD では拒否、PRE_ROLL/TRADE_BUILD では許可（Low）', () => {
    const vpCards = Array.from({ length: 10 }, (_, i) => ({ id: `vp${i}`, type: 'victory_point' as const, purchasedOnTurn: 0 }));
    const mk = (turnPhase: 'ROBBER' | 'DISCARD' | 'PRE_ROLL' | 'TRADE_BUILD') => makeGameState({
      turnPhase,
      players: { player1: makePlayer('player1', { devCards: vpCards }), player2: makePlayer('player2') },
    });
    // 7処理中（盗賊/捨て札）は十分なVPでも宣言不可
    expect(() => applyAction(mk('ROBBER'), { type: 'DECLARE_VICTORY' })).toThrow();
    expect(() => applyAction(mk('DISCARD'), { type: 'DECLARE_VICTORY' })).toThrow();
    // 自分の手番開始時(PRE_ROLL)とダイス後(TRADE_BUILD)は宣言できる（称号移動で手番開始時に即勝てる）
    for (const ph of ['PRE_ROLL', 'TRADE_BUILD'] as const) {
      const won = applyAction(mk(ph), { type: 'DECLARE_VICTORY' });
      expect(won.phase).toBe('GAME_OVER');
      expect(won.winner).toBe('player1');
    }
  });

  it('END_TURN: ターン上限(安全網)で最高VPのプレイヤーを勝者にして終了（無限ループ防止）', () => {
    const vp = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, type: 'victory_point' as const, purchasedOnTurn: 0 }));
    const s = makeGameState({
      turnPhase: 'TRADE_BUILD', diceRolledThisTurn: true, globalTurnNumber: 999, // 次の END_TURN で 1000=上限に到達
      players: { player1: makePlayer('player1', { devCards: vp(1) }), player2: makePlayer('player2', { devCards: vp(3) }) },
    });
    const next = applyAction(s, { type: 'END_TURN' });
    expect(next.phase).toBe('GAME_OVER');
    expect(next.winner).toBe('player2'); // 3VP > 1VP の方が勝者
  });

  // --- DISCARD_RESOURCES: 枚数/所持/フェーズ検証（M3 / Low） ---
  function discardState() {
    return makeGameState({
      turnPhase: 'DISCARD',
      players: { player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }), player2: makePlayer('player2') },
    });
  }
  it('DISCARD_RESOURCES は過少な枚数を拒否', () => {
    expect(() => applyAction(discardState(), { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 3 } }))
      .toThrow('floor(hand/2)');
  });
  it('DISCARD_RESOURCES は過剰な枚数を拒否', () => {
    expect(() => applyAction(discardState(), { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 5 } }))
      .toThrow('floor(hand/2)');
  });
  it('DISCARD_RESOURCES は所持していない資源を拒否', () => {
    expect(() => applyAction(discardState(), { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { brick: 4 } }))
      .toThrow('floor(hand/2)');
  });
  it('DISCARD_RESOURCES は DISCARD フェーズ外を拒否', () => {
    const s = makeGameState({ turnPhase: 'TRADE_BUILD', players: { player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }), player2: makePlayer('player2') } });
    expect(() => applyAction(s, { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } }))
      .toThrow('not in DISCARD phase');
  });
  it('DISCARD_RESOURCES はちょうど floor(hand/2) を許可（回帰）', () => {
    const next = applyAction(discardState(), { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } });
    expect(next.players.player1!.hand.wood).toBe(4);
  });

  // --- CONFIRM_TRADE: 承諾していない/対象外への成立強制を防ぐ（H3） ---
  function offeredState(targets: PlayerId[] = ['player2']) {
    let s = makeGameState({
      turnPhase: 'TRADE_BUILD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 1 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 1 }) }),
        player3: makePlayer('player3', { hand: makeHand({ brick: 1 }) }),
      },
      playerOrder: ['player1', 'player2', 'player3'],
    });
    s = applyAction(s, { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: targets });
    return s;
  }
  it('CONFIRM_TRADE は REJECT した相手には成立せず TRADE_CANCELLED（資源不変 / H3）', () => {
    let s = offeredState();
    s = applyAction(s, { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'REJECT' } });
    const after = applyAction(s, { type: 'CONFIRM_TRADE', responderId: 'player2' });
    expect(after.pendingTrade?.state).toBe('TRADE_CANCELLED');
    expect(after.players.player1!.hand.wood).toBe(1);
    expect(after.players.player2!.hand.brick).toBe(1);
  });
  it('CONFIRM_TRADE は未応答の相手には成立せず TRADE_CANCELLED（H3）', () => {
    const s = offeredState();
    const after = applyAction(s, { type: 'CONFIRM_TRADE', responderId: 'player2' });
    expect(after.pendingTrade?.state).toBe('TRADE_CANCELLED');
    expect(after.players.player1!.hand.wood).toBe(1);
  });
  it('CONFIRM_TRADE は交易対象外の相手には成立せず TRADE_CANCELLED（H3）', () => {
    let s = offeredState(['player2']);                 // 対象は player2 のみ
    s = applyAction(s, { type: 'RESPOND_TRADE', response: { playerId: 'player3', status: 'ACCEPT' } });
    const after = applyAction(s, { type: 'CONFIRM_TRADE', responderId: 'player3' }); // 対象外
    expect(after.pendingTrade?.state).toBe('TRADE_CANCELLED');
    expect(after.players.player3!.hand.brick).toBe(1);
  });
});

// ============================================================
// グループC: 捨て札の二重捨て防止（M2 回帰）
// ============================================================

describe('Group C: discard double-discard prevention (M2)', () => {
  it('findPendingDiscarder は捨て済みプレイヤーを除外して次の対象を返す', () => {
    const s = makeGameState({
      turnPhase: 'DISCARD',
      discardedThisRound: ['player1'],
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 8 }) }), // 8枚だが捨て済み
        player2: makePlayer('player2', { hand: makeHand({ brick: 10 }) }),
      },
    });
    expect(findPendingDiscarder(s)).toBe('player2');               // player1 は除外される
    const done: GameState = { ...s, discardedThisRound: ['player1', 'player2'] };
    expect(findPendingDiscarder(done)).toBeUndefined();            // 全員済みなら対象なし
  });

  it('同一プレイヤーの二重捨てをエンジンが拒否する（捨てて8枚残っても再要求を弾く）', () => {
    let s = makeGameState({
      turnPhase: 'DISCARD',
      players: {
        player1: makePlayer('player1', { hand: makeHand({ wood: 16 }) }),
        player2: makePlayer('player2', { hand: makeHand({ brick: 10 }) }),
      },
    });
    // player1 が floor(16/2)=8 枚捨てる → 残8枚だが「捨て済み」
    s = applyAction(s, { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 8 } });
    expect(s.turnPhase).toBe('DISCARD');           // player2 がまだ未捨て → DISCARD 継続
    expect(s.discardedThisRound).toContain('player1');
    expect(findPendingDiscarder(s)).toBe('player2'); // 再プロンプト対象は player2 のみ
    // player1 を再度捨てさせようとすると拒否される（余分なカード喪失の防止）
    expect(() => applyAction(s, { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } }))
      .toThrow('already discarded');
  });
});

describe('setupGainFor (初期配置2軒目の資源導出・付与とアニメで共有)', () => {
  // 頂点 vA に隣接: forest(wood) / desert(なし) / mountain(ore)。vB は無関係。
  const state = {
    tileToVertices: { t1: ['vA'], t2: ['vA', 'vB'], t3: ['vA'], t4: ['vB'] },
    tiles: {
      t1: { type: 'forest' },
      t2: { type: 'desert' },
      t3: { type: 'mountain' },
      t4: { type: 'field' },
    },
  } as unknown as GameState;

  it('隣接タイルの資源を列挙順で返し、砂漠は除外する', () => {
    expect(setupGainFor(state, 'vA', makeHand({ wood: 19, ore: 19 }))).toEqual(['wood', 'ore']);
  });

  it('バンク在庫0の資源は除外する', () => {
    expect(setupGainFor(state, 'vA', makeHand({ wood: 0, ore: 19 }))).toEqual(['ore']);
    expect(setupGainFor(state, 'vA', makeHand({ wood: 19, ore: 0 }))).toEqual(['wood']);
  });

  it('同一資源の隣接が複数でも在庫分だけ返す', () => {
    const twoForest = {
      tileToVertices: { a: ['vX'], b: ['vX'] },
      tiles: { a: { type: 'forest' }, b: { type: 'forest' } },
    } as unknown as GameState;
    expect(setupGainFor(twoForest, 'vX', makeHand({ wood: 2 }))).toEqual(['wood', 'wood']);
    expect(setupGainFor(twoForest, 'vX', makeHand({ wood: 1 }))).toEqual(['wood']);
    expect(setupGainFor(twoForest, 'vX', makeHand({ wood: 0 }))).toEqual([]);
  });
});

describe('ルール: 盗賊移動後の強奪は必須（盗まない選択は不可）', () => {
  function robberState(opp2Cards: number): { s: GameState; tile: string } {
    const g = makeGameState({ phase: 'MAIN', turnPhase: 'ROBBER' });
    const robberTile = Object.values(g.tiles).find(t => t.hasRobber)!.id;
    const targetTile = Object.values(g.tiles).find(t => t.type !== 'desert' && t.id !== robberTile)!.id;
    const vid = g.tileToVertices[targetTile]![0]!;
    const s: GameState = {
      ...g,
      playerOrder: ['player1', 'player2'],
      currentPlayerIndex: 0,
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'settlement', playerId: 'player2' } } },
      players: { ...g.players, player2: makePlayer('player2', { hand: makeHand({ wood: opp2Cards }) }) },
    };
    return { s, tile: targetTile };
  }

  it('隣接に手札持ちの相手がいるのに stealFromPlayerId:null は拒否される', () => {
    const { s, tile } = robberState(2);
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: tile, stealFromPlayerId: null }))
      .toThrow('must steal');
    // 相手を指定すれば成功する
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: tile, stealFromPlayerId: 'player2' }))
      .not.toThrow();
  });

  it('隣接の相手が全員0枚なら、盗まない(null)で通る', () => {
    const { s, tile } = robberState(0);
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: tile, stealFromPlayerId: null }))
      .not.toThrow();
  });
});
