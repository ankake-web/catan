import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { getScenario, listScenarios } from '../src/engine/scenarios';
import { computeIslandReps } from '../src/engine/islands';
import { getAllTileCoords } from '../src/engine/board';
import { createRng } from '../src/engine/setup';
import type { Tile } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',    type: 'human' },
  { id: 'player2', name: 'B', color: 'blue',   type: 'ai', aiDifficulty: 'normal' },
];

const count = (tiles: Record<string, Tile>, type: string): number =>
  Object.values(tiles).filter(t => t.type === type).length;

describe('scenarios: registry', () => {
  it('lists classic and seafarers', () => {
    const ids = listScenarios().map(s => s.id);
    expect(ids).toContain('classic');
    expect(ids).toContain('seafarers_newshores');
    expect(ids).toContain('seafarers_archipelago');
  });
  it('unknown id falls back to classic', () => {
    // @ts-expect-error 故意に未知ID
    expect(getScenario('nope').id).toBe('classic');
  });
});

describe('scenarios: classic は従来どおり（非破壊）', () => {
  it('既定で19タイル・海/金タイルを含まない', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7));
    expect(Object.keys(s.tiles)).toHaveLength(19);
    expect(count(s.tiles, 'sea')).toBe(0);
    expect(count(s.tiles, 'gold')).toBe(0);
    expect(count(s.tiles, 'desert')).toBe(1);
    // 盗賊は砂漠から開始（従来仕様）
    const robberTile = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(robberTile.type).toBe('desert');
  });
  it('明示的に classic を渡しても同じ盤面（決定論）', () => {
    const a = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(42));
    const b = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(42), 'classic');
    expect(a.tiles).toEqual(b.tiles);
  });
});

describe('scenarios: 航海者「新たな海岸を目指して」(公式S1)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');

  it('大きめ footprint（29ヘックス）で陸21・海8・砂漠1・金2（公式S1は金タイル2枚）', () => {
    expect(Object.keys(s.tiles)).toHaveLength(29);
    expect(count(s.tiles, 'sea')).toBe(8);
    expect(count(s.tiles, 'gold')).toBe(2);
    expect(count(s.tiles, 'desert')).toBe(1);
    expect(29 - 8).toBe(21); // 海以外＝陸21（金タイルも陸に含む）
  });

  it('公式S1: 勝利点は14・新島初入植ボーナスは+2', () => {
    expect(s.victoryTarget).toBe(14);
    expect(s.newIslandBonusVp ?? 2).toBe(2);
  });

  it('本島12＋新島9 の二島に分かれる', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([12, 9]);
  });

  it('海峡(q=0列)が全て海で左右の陸塊を分離（船が必要）', () => {
    for (const r of [-2, -1, 0, 1, 2]) expect(s.tiles[`0,${r}`]?.type).toBe('sea');
    // 左(q=-3..-1)と右(q=1..3)に陸がある
    expect(s.tiles['-1,-1']?.type).toBe('desert'); // 本島の砂漠
    expect(s.tiles['1,-1']?.type).toBe('gold');    // 新島の玄関口＝金
  });

  it('海タイルは数字なし・盗賊なし。陸タイルは砂漠以外に数字あり', () => {
    for (const t of Object.values(s.tiles)) {
      if (t.type === 'sea') {
        expect(t.number).toBeNull();
        expect(t.hasRobber).toBe(false);
      } else if (t.type !== 'desert') {
        expect(t.number).not.toBeNull();
      }
    }
  });

  it('盗賊は本島の砂漠(-1,-1)から開始', () => {
    const robber = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(robber.id).toBe('-1,-1');
    expect(robber.type).toBe('desert');
  });

  it('盤面が viewBox に収まるよう、基本盤より頂点/辺が多い（大きい盤）', () => {
    expect(Object.keys(s.vertices).length).toBeGreaterThan(54);
    expect(Object.keys(s.edges).length).toBeGreaterThan(72);
  });
});

describe('scenarios: 航海者「群島」', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_archipelago');

  it('29ヘックスで陸21・海8・砂漠1・金1', () => {
    expect(Object.keys(s.tiles)).toHaveLength(29);
    expect(count(s.tiles, 'sea')).toBe(8);
    expect(count(s.tiles, 'gold')).toBe(1);
    expect(count(s.tiles, 'desert')).toBe(1);
    expect(29 - 8).toBe(21);
  });

  it('3つの島に分かれる（本島12＋新島A6＋新島B3）', () => {
    const repOf = computeIslandReps(s.tiles);
    const reps = [...new Set(Object.values(repOf))];
    expect(reps).toHaveLength(3);
    const sizes = reps.map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([12, 6, 3]);
  });

  it('海岸線に港が配置され、沿岸の陸頂点に harborType が付く（両航海者マップ）', () => {
    for (const id of ['seafarers_newshores', 'seafarers_archipelago'] as const) {
      const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), id);
      expect(st.harbors.length).toBeGreaterThan(0);
      expect(st.harbors.length).toBeLessThanOrEqual(4);
      for (const h of st.harbors) {
        for (const v of h.vertexIds) {
          expect(st.vertices[v]?.harborType).toBe(h.type);
          const adj = (st.vertices[v]?.adjacentTileIds ?? []).map(t => st.tiles[t]?.type);
          expect(adj.includes('sea')).toBe(true);                       // 海に面する
          expect(adj.some(t => t != null && t !== 'sea')).toBe(true);   // 陸にも面する
        }
      }
    }
  });

  it('新島A・Bは本島と隣接しない（航海でのみ到達）', () => {
    // 本島(左 q≤-1)と右側の間 q=0 列は全て海
    for (const r of [-2, -1, 0, 1, 2]) expect(s.tiles[`0,${r}`]?.type).toBe('sea');
    // A(上)↔B(下) を分ける r=0 の列(1,0)(2,0)(3,0)も海
    expect(s.tiles['1,0']?.type).toBe('sea');
    expect(s.tiles['2,0']?.type).toBe('sea');
    expect(s.tiles['3,0']?.type).toBe('sea');
    // 金は新島Aの玄関口(1,-1)
    expect(s.tiles['1,-1']?.type).toBe('gold');
  });
});
