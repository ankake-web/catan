import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { canBuildShip } from '../src/engine/actions';
import { getPirateRobbablePlayerIds } from '../src/engine/robber';
import { chooseRobberHex } from '../src/engine/ai';
import { makeHand } from '../src/constants';
import type { GameState, EdgeId, TileId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const base = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');

// 海タイル T と、その隣接辺 E に player2 の船を置いた ROBBER 状態を返す。
function pirateSetup(): { s: GameState; seaTile: TileId; shipEdge: EdgeId } {
  const g = base();
  // 初期海賊位置（最も遠い海）とは別の海タイルを選ぶ（MOVE_PIRATE は別タイルへの移動が必須）。
  const seaTile = Object.values(g.tiles).find(t => t.type === 'sea' && t.id !== g.piratePosition && (g.tileToEdges[t.id] ?? []).length > 0)!.id;
  const shipEdge = (g.tileToEdges[seaTile] ?? [])[0]! as EdgeId;
  const s: GameState = {
    ...g,
    phase: 'MAIN', turnPhase: 'ROBBER', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
    edges: { ...g.edges, [shipEdge]: { ...g.edges[shipEdge]!, ship: { playerId: 'player2' } } },
    players: {
      ...g.players,
      player2: { ...g.players.player2!, hand: makeHand({ wood: 3 }) },
    },
  };
  return { s, seaTile, shipEdge };
}

describe('海賊（航海者・盗賊の海版）', () => {
  it('海賊タイルに隣接する船の所有者を奪取対象に挙げる', () => {
    const { s, seaTile } = pirateSetup();
    expect(getPirateRobbablePlayerIds(s, seaTile, 'player1')).toEqual(['player2']);
    // 自分の船は対象外
    expect(getPirateRobbablePlayerIds(s, seaTile, 'player2')).toEqual([]);
  });

  it('MOVE_PIRATE で海賊が配置され、隣接船の所有者から1枚奪える', () => {
    const { s, seaTile } = pirateSetup();
    const before2 = s.players.player2!.hand.wood;
    const next = applyAction(s, { type: 'MOVE_PIRATE', tileId: seaTile, stealFromPlayerId: 'player2' }, () => 0.1);
    expect(next.piratePosition).toBe(seaTile);
    expect(next.turnPhase).toBe('TRADE_BUILD');
    // player2 は1枚失い、player1 は1枚得る（合計保存）
    const after2 = next.players.player2!.hand.wood;
    expect(after2).toBe(before2 - 1);
    expect(next.players.player1!.hand.wood).toBe(s.players.player1!.hand.wood + 1);
  });

  it('海賊のいる海タイルに面した辺には船を建てられない（建設封鎖）', () => {
    const { s, seaTile, shipEdge } = pirateSetup();
    const withPirate: GameState = { ...s, phase: 'MAIN', turnPhase: 'TRADE_BUILD', piratePosition: seaTile };
    // shipEdge は seaTile に面する → たとえ接続が合っても建設不可
    expect(canBuildShip(withPirate, 'player1', shipEdge)).toBe(false);
    // seaTile に面さない海辺は封鎖されない
    const far = Object.keys(s.edges).find(eid =>
      !(s.tileToEdges[seaTile] ?? []).includes(eid));
    expect(far).toBeTruthy();
  });

  it('MOVE_PIRATE の検証: 陸タイル/同じ場所/非隣接の奪取は弾く', () => {
    const { s, seaTile } = pirateSetup();
    const land = Object.values(s.tiles).find(t => t.type !== 'sea')!.id;
    expect(() => applyAction(s, { type: 'MOVE_PIRATE', tileId: land, stealFromPlayerId: null })).toThrow();
    const onPirate: GameState = { ...s, piratePosition: seaTile };
    expect(() => applyAction(onPirate, { type: 'MOVE_PIRATE', tileId: seaTile, stealFromPlayerId: null })).toThrow();
    // 船を持たない player2 からは海賊で奪えない（隣接船なし）
    const noShip: GameState = { ...s, edges: { ...s.edges } };
    // shipEdge の船を消す
    const se = (s.tileToEdges[seaTile] ?? [])[0]!;
    noShip.edges[se] = { ...noShip.edges[se]!, ship: null };
    expect(() => applyAction(noShip, { type: 'MOVE_PIRATE', tileId: seaTile, stealFromPlayerId: 'player2' })).toThrow();
  });

  it('盗賊（MOVE_ROBBER）は海タイルへ移動できない（海は海賊の領分）', () => {
    const { s, seaTile } = pirateSetup();
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: seaTile, stealFromPlayerId: null })).toThrow();
  });

  it('AI: chooseRobberHex は海タイルを選ばない（陸のみ）', () => {
    const g = base();
    // player2 の建物を本島の陸タイルに置く（盗賊の有効対象を作る）。
    const landVid = Object.values(g.vertices).find(v =>
      v.adjacentTileIds.some(t => { const ty = g.tiles[t]?.type; return ty != null && ty !== 'sea' && ty !== 'desert'; }))!.id;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'ROBBER', setupSubPhase: null, currentPlayerIndex: 0,
      vertices: { ...g.vertices, [landVid]: { ...g.vertices[landVid]!, building: { type: 'settlement', playerId: 'player2' } } },
    };
    for (let i = 0; i < 20; i++) {
      const tid = chooseRobberHex(s, 'player1', createRng(i + 1));
      expect(s.tiles[tid]?.type).not.toBe('sea');
    }
  });
});
