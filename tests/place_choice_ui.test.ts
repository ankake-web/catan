// @vitest-environment jsdom
// 航海者: (1) 海岸の辺で道も船も置ける時は「道/船」を選ばせる（edgePieceChoice）。
//         (2) 盗賊フェーズで盗賊(陸)も海賊(海)も動かせる時は、先に選んだコマ以外のタップを無視する。
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { isLandEdge, isSeaEdge, isLandVertex } from '../src/engine/board';
import { canBuildRoad, canBuildShip } from '../src/engine/actions';
import { getRobberMoveTargets } from '../src/engine/robber';
import { placeEdgeSmart, handleTileClick } from '../src/renderer/events';
import type { UIPhase } from '../src/renderer/ui';
import type { Action, GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const seafarers = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');

// 道も船も置ける「海岸の辺」と、その陸側の頂点（開拓地を置く場所）を探す。
function findCoastalEdge(state: GameState): { edge: string; vertex: string } | null {
  for (const e of Object.values(state.edges)) {
    if (e.road || e.ship) continue;
    if (!(isLandEdge(e, state.vertices, state.tiles) && isSeaEdge(e, state.vertices, state.tiles))) continue;
    for (const vid of e.vertexIds) {
      const v = state.vertices[vid];
      if (v && isLandVertex(v, state.tiles) && !v.building) return { edge: e.id, vertex: vid };
    }
  }
  return null;
}

describe('航海者: 海岸の辺は道/船を選ばせる', () => {
  it('街道建設中・道モードで海岸の辺をタップ → edgePieceChoice（配置は保留）', () => {
    const g = seafarers();
    const found = findCoastalEdge(g)!;
    expect(found, '海岸の辺が見つかる').toBeTruthy();
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0,
      roadBuildingRoadsRemaining: 2,
      vertices: { ...g.vertices, [found.vertex]: { ...g.vertices[found.vertex]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    // 開拓地に接する海岸の辺は、街道建設中なら道も船も置ける。
    expect(canBuildRoad(s, 'player1', found.edge)).toBe(true);
    expect(canBuildShip(s, 'player1', found.edge)).toBe(true);

    let phase: UIPhase = { type: 'idle' };
    const dispatched: Action[] = [];
    placeEdgeSmart(found.edge, s, 'player1', 'road', p => { phase = p; }, a => dispatched.push(a));
    expect(phase).toEqual({ type: 'edgePieceChoice', edgeId: found.edge });
    expect(dispatched).toHaveLength(0); // まだ置かない（選ばせる）
  });

  it('船モードを明示していれば海岸の辺は即・船（選択は出さない）', () => {
    const g = seafarers();
    const found = findCoastalEdge(g)!;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0,
      roadBuildingRoadsRemaining: 2,
      vertices: { ...g.vertices, [found.vertex]: { ...g.vertices[found.vertex]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    let phase: UIPhase = { type: 'idle' };
    const dispatched: Action[] = [];
    placeEdgeSmart(found.edge, s, 'player1', 'ship', p => { phase = p; }, a => dispatched.push(a));
    expect(phase.type).not.toBe('edgePieceChoice');
    expect(dispatched).toEqual([{ type: 'BUILD_SHIP', edgeId: found.edge }]);
  });
});

describe('航海者: 盗賊/海賊は先に選んだコマだけ動かせる', () => {
  function robberState(): { s: GameState; land: string; sea: string } {
    const g = seafarers();
    const seaTiles = Object.values(g.tiles).filter(t => t.type === 'sea');
    const piratePos = seaTiles[0]!.id;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'ROBBER', setupSubPhase: null, currentPlayerIndex: 0,
      piratePosition: piratePos,
    };
    const land = getRobberMoveTargets(s)[0]!;               // 盗賊の合法移動先（陸）
    const sea = seaTiles.find(t => t.id !== piratePos)!.id; // 海賊の移動先（海・現在地以外）
    return { s, land, sea };
  }

  it('両方動かせる盤: コマ未選択(null)ではタップを無視する', () => {
    const { s, land, sea } = robberState();
    expect(getRobberMoveTargets(s).length).toBeGreaterThan(0);
    const disp: Action[] = [];
    handleTileClick(land, s, 'player1', () => {}, a => disp.push(a), null);
    handleTileClick(sea,  s, 'player1', () => {}, a => disp.push(a), null);
    expect(disp).toHaveLength(0);
  });

  it('盗賊を選択中は海タイル(海賊)を無視し、陸タイルで MOVE_ROBBER', () => {
    const { s, land, sea } = robberState();
    const disp: Action[] = [];
    handleTileClick(sea,  s, 'player1', () => {}, a => disp.push(a), 'robber'); // 無視
    expect(disp).toHaveLength(0);
    handleTileClick(land, s, 'player1', () => {}, a => disp.push(a), 'robber'); // 実行
    expect(disp).toHaveLength(1);
    expect(disp[0]!.type).toBe('MOVE_ROBBER');
  });

  it('海賊を選択中は陸タイル(盗賊)を無視し、海タイルで MOVE_PIRATE', () => {
    const { s, land, sea } = robberState();
    const disp: Action[] = [];
    handleTileClick(land, s, 'player1', () => {}, a => disp.push(a), 'pirate'); // 無視
    expect(disp).toHaveLength(0);
    handleTileClick(sea,  s, 'player1', () => {}, a => disp.push(a), 'pirate'); // 実行
    expect(disp).toHaveLength(1);
    expect(disp[0]!.type).toBe('MOVE_PIRATE');
  });
});
