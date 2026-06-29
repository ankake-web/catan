import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { canBuildShip, canBuildRoad, canBuildSettlement } from '../src/engine/actions';
import { isSeaEdge, isLandEdge, isLandVertex } from '../src/engine/board';
import { makeHand } from '../src/constants';
import type { GameState, VertexId, EdgeId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];

function seafarersMain(): GameState {
  const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
  // 沿岸の頂点（陸と海の両方に接する）を見つけ、player1 の開拓地を置く。
  const coastVid = Object.values(g.vertices).find(v => {
    const land = isLandVertex(v, g.tiles);
    const hasSeaEdge = v.adjacentEdgeIds.some(eid => isSeaEdge(g.edges[eid]!, g.vertices, g.tiles));
    return land && hasSeaEdge;
  })!.id as VertexId;

  const state: GameState = {
    ...g,
    phase: 'MAIN',
    turnPhase: 'TRADE_BUILD',
    setupSubPhase: null,
    diceRolledThisTurn: true,
    currentPlayerIndex: 0,
    vertices: {
      ...g.vertices,
      [coastVid]: { ...g.vertices[coastVid]!, building: { type: 'settlement', playerId: 'player1' } },
    },
    players: {
      ...g.players,
      player1: { ...g.players.player1!, hand: makeHand({ wood: 5, wool: 5, brick: 5, grain: 5, ore: 5 }) },
    },
  };
  return state;
}

describe('航海者: 船の建設', () => {
  it('沿岸の開拓地から、海に面した辺に船を建設できる', () => {
    const s = seafarersMain();
    const coastVid = Object.entries(s.vertices).find(([, v]) => v.building?.playerId === 'player1')![0] as VertexId;
    const seaEdge = s.vertices[coastVid]!.adjacentEdgeIds.find(eid => isSeaEdge(s.edges[eid]!, s.vertices, s.tiles)) as EdgeId;
    expect(seaEdge).toBeTruthy();
    expect(canBuildShip(s, 'player1', seaEdge)).toBe(true);
  });

  it('純粋な海上の辺（陸に面しない）には道を建てられない', () => {
    const s = seafarersMain();
    const pureSea = Object.values(s.edges).find(e =>
      isSeaEdge(e, s.vertices, s.tiles) && !isLandEdge(e, s.vertices, s.tiles))!;
    expect(canBuildRoad(s, 'player1', pureSea.id)).toBe(false);
  });

  it('外洋だけに接する頂点には開拓地を建てられない', () => {
    const s = seafarersMain();
    const seaOnlyV = Object.values(s.vertices).find(v => !isLandVertex(v, s.tiles));
    // 二島マップでは外洋のみの頂点が存在する
    expect(seaOnlyV).toBeTruthy();
    expect(canBuildSettlement(s, 'player1', seaOnlyV!.id)).toBe(false);
  });

  it('BUILD_SHIP で船が置かれ、コマ数と手札・銀行が更新される', () => {
    const s = seafarersMain();
    const coastVid = Object.entries(s.vertices).find(([, v]) => v.building?.playerId === 'player1')![0] as VertexId;
    const seaEdge = s.vertices[coastVid]!.adjacentEdgeIds.find(eid => isSeaEdge(s.edges[eid]!, s.vertices, s.tiles)) as EdgeId;
    const before = s.players.player1!;
    const woodBefore = before.hand.wood, woolBefore = before.hand.wool;
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: seaEdge });
    expect(next.edges[seaEdge]!.ship?.playerId).toBe('player1');
    expect(next.players.player1!.remainingShips).toBe((before.remainingShips ?? 15) - 1);
    expect(next.players.player1!.hand.wood).toBe(woodBefore - 1);
    expect(next.players.player1!.hand.wool).toBe(woolBefore - 1);
    expect(next.bank.wood).toBe(s.bank.wood + 1);
  });

  it('資源不足では船を建てられない', () => {
    const s = seafarersMain();
    const coastVid = Object.entries(s.vertices).find(([, v]) => v.building?.playerId === 'player1')![0] as VertexId;
    const seaEdge = s.vertices[coastVid]!.adjacentEdgeIds.find(eid => isSeaEdge(s.edges[eid]!, s.vertices, s.tiles)) as EdgeId;
    const poor: GameState = { ...s, players: { ...s.players, player1: { ...s.players.player1!, hand: makeHand() } } };
    expect(canBuildShip(poor, 'player1', seaEdge)).toBe(false);
  });

  it('船から連続して船を伸ばせる（同種は建物無しでも接続）', () => {
    const s = seafarersMain();
    const coastVid = Object.entries(s.vertices).find(([, v]) => v.building?.playerId === 'player1')![0] as VertexId;
    const seaEdge = s.vertices[coastVid]!.adjacentEdgeIds.find(eid => isSeaEdge(s.edges[eid]!, s.vertices, s.tiles)) as EdgeId;
    const s1 = applyAction(s, { type: 'BUILD_SHIP', edgeId: seaEdge });
    // seaEdge の反対側頂点に隣接する別の海上辺へ伸ばせるはず
    const e = s1.edges[seaEdge]!;
    const farV = e.vertexIds.find(v => v !== coastVid)!;
    const nextSea = s1.vertices[farV]!.adjacentEdgeIds.find(eid =>
      eid !== seaEdge && isSeaEdge(s1.edges[eid]!, s1.vertices, s1.tiles) && !s1.edges[eid]!.ship && !s1.edges[eid]!.road);
    if (nextSea) {
      expect(canBuildShip(s1, 'player1', nextSea)).toBe(true);
    }
  });
});

describe('航海者: 基本ゲーム（classic）は船の影響を受けない', () => {
  it('classic では海辺が無く canBuildShip は常に false', () => {
    const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(3), 'classic');
    const anyEdge = Object.keys(g.edges)[0] as EdgeId;
    expect(canBuildShip({ ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD' }, 'player1', anyEdge)).toBe(false);
  });
});

describe('航海者: 街道建設カード（道2／船2／道1+船1）', () => {
  // [B1] 監査: 無料配置の本数が「残り道コマ数」だけでキャップされ、船2/道1+船1 を配れなかった不具合の回帰防止。
  function withRoadBuildingCard(s: GameState, roads: number, ships: number): GameState {
    return {
      ...s,
      globalTurnNumber: 5,
      devCardPlayedThisTurn: false,
      players: {
        ...s.players,
        player1: {
          ...s.players.player1!,
          remainingRoads: roads,
          remainingShips: ships,
          devCards: [{ id: 'rb1', type: 'road_building', purchasedOnTurn: 0 }],
        },
      },
    };
  }

  it('道コマ0でも船在庫があれば2本配置できる（船2・海のある盤）', () => {
    const s = withRoadBuildingCard(seafarersMain(), 0, 15);
    const next = applyAction(s, { type: 'PLAY_ROAD_BUILDING' });
    expect(next.roadBuildingRoadsRemaining).toBe(2);
  });

  it('道コマ1＋船在庫ありなら2本配置できる（道1+船1）', () => {
    const s = withRoadBuildingCard(seafarersMain(), 1, 15);
    const next = applyAction(s, { type: 'PLAY_ROAD_BUILDING' });
    expect(next.roadBuildingRoadsRemaining).toBe(2);
  });

  it('街道建設中は資源を消費せず船を無料配置でき、残数が減る', () => {
    const s = applyAction(withRoadBuildingCard(seafarersMain(), 0, 15), { type: 'PLAY_ROAD_BUILDING' });
    expect(s.roadBuildingRoadsRemaining).toBe(2);
    const coastVid = Object.entries(s.vertices).find(([, v]) => v.building?.playerId === 'player1')![0] as VertexId;
    const seaEdge = s.vertices[coastVid]!.adjacentEdgeIds.find(eid => isSeaEdge(s.edges[eid]!, s.vertices, s.tiles)) as EdgeId;
    const handBefore = { ...s.players.player1!.hand };
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: seaEdge });
    expect(next.edges[seaEdge]!.ship?.playerId).toBe('player1');
    expect(next.roadBuildingRoadsRemaining).toBe(1);
    expect(next.players.player1!.hand).toEqual(handBefore); // 無料配置（資源不変）
  });

  it('classic（海なし）では船在庫を数えず、残り道コマ数でキャップ', () => {
    const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(3), 'classic');
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null,
      diceRolledThisTurn: true, currentPlayerIndex: 0, globalTurnNumber: 5, devCardPlayedThisTurn: false,
      players: {
        ...g.players,
        player1: {
          ...g.players.player1!, remainingRoads: 1, remainingShips: 15,
          devCards: [{ id: 'rb1', type: 'road_building', purchasedOnTurn: 0 }],
        },
      },
    };
    const next = applyAction(s, { type: 'PLAY_ROAD_BUILDING' });
    expect(next.roadBuildingRoadsRemaining).toBe(1);
  });
});
