import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { revealFogAround, hasFog } from '../src/engine/explore';
import { edgeTileIds, isSeaEdge } from '../src/engine/board';
import { makeHand, TILE_RESOURCE_MAP, RESOURCE_TYPES } from '../src/constants';
import type { GameState, ResourceHand } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const fog = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_fogislands');
const total = (h: ResourceHand): number => RESOURCE_TYPES.reduce((s, r) => s + h[r], 0);

describe('S3 霧の島: 霧ヘックスは海として扱われ、探索で公開される', () => {
  it('開始時は霧ヘックスが存在し、表向きは海（産出・配置で海扱い）', () => {
    const s = fog();
    expect(hasFog(s)).toBe(true);
    const fogged = Object.values(s.tiles).filter(t => t.fog != null);
    expect(fogged.length).toBeGreaterThan(0);
    for (const t of fogged) {
      expect(t.type).toBe('sea');   // 表向きは海
      expect(t.number).toBeNull();  // 数字も伏せられている
    }
  });

  it('基本ゲームには霧が無く revealFogAround は no-op', () => {
    const c = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'classic');
    expect(hasFog(c)).toBe(false);
    expect(revealFogAround(c, Object.keys(c.tiles), 'player1')).toBe(c); // 参照不変
  });

  it('霧の陸ヘックスを公開すると本来の地形になり、探索者が資源1枚を得る', () => {
    const s = fog();
    const fogLand = Object.values(s.tiles).find(t => t.fog && t.fog.type !== 'sea')!;
    const res = TILE_RESOURCE_MAP[fogLand.fog!.type]!;
    const before = s.players.player1!.hand[res];
    const next = revealFogAround(s, [fogLand.id], 'player1');
    const revealed = next.tiles[fogLand.id]!;
    expect(revealed.fog).toBeUndefined();
    expect(revealed.type).toBe(fogLand.fog!.type);
    expect(revealed.number).toBe(fogLand.fog!.number);
    expect(next.players.player1!.hand[res]).toBe(before + 1); // その地形の資源を1枚
  });

  it('霧の海ヘックスを公開しても資源は得られない', () => {
    const s = fog();
    const fogSea = Object.values(s.tiles).find(t => t.fog && t.fog.type === 'sea')!;
    const next = revealFogAround(s, [fogSea.id], 'player1');
    expect(next.tiles[fogSea.id]!.type).toBe('sea');
    expect(next.tiles[fogSea.id]!.fog).toBeUndefined();
    expect(total(next.players.player1!.hand)).toBe(total(s.players.player1!.hand));
  });

  it('BUILD_SHIP で隣接する霧ヘックスが公開される（探索のエンドツーエンド）', () => {
    const g = fog();
    const fogLand = Object.values(g.tiles).find(t => t.fog && t.fog.type !== 'sea')!;
    // fogLand に面する空きの海辺 E を選ぶ
    const E = Object.values(g.edges).find(e =>
      edgeTileIds(e, g.vertices).includes(fogLand.id) && isSeaEdge(e, g.vertices, g.tiles)
      && e.ship == null && e.road == null)!;
    // E の片端に player1 の建物を置いて接続を満たす（テスト用の直接配置）
    const v = E.vertexIds[0];
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 1, wool: 1 }) } },
    };
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: E.id });
    expect(next.edges[E.id]!.ship?.playerId).toBe('player1');
    expect(next.tiles[fogLand.id]!.fog).toBeUndefined();          // 霧が晴れた
    expect(next.tiles[fogLand.id]!.type).toBe(fogLand.fog!.type); // 本来の地形に
  });
});
