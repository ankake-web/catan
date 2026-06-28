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

  it('公式S1の陸構成（丘4/森3/牧草5/畑4/山4/金2/砂漠0＝陸22）に一致・数字22', () => {
    expect(Object.keys(s.tiles)).toHaveLength(37);
    expect(count(s.tiles, 'sea')).toBe(15);
    expect(count(s.tiles, 'gold')).toBe(2);
    expect(count(s.tiles, 'desert')).toBe(0);   // 公式S1は砂漠なし
    expect(count(s.tiles, 'hill')).toBe(4);
    expect(count(s.tiles, 'forest')).toBe(3);
    expect(count(s.tiles, 'pasture')).toBe(5);
    expect(count(s.tiles, 'field')).toBe(4);
    expect(count(s.tiles, 'mountain')).toBe(4);
    // 陸22（金2含む）・数字トークン22（砂漠が無く全陸に数字）
    expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(22);
    expect(Object.values(s.tiles).filter(t => t.number != null)).toHaveLength(22);
  });

  it('公式S1: 勝利点は14・新島初入植ボーナスは+2', () => {
    expect(s.victoryTarget).toBe(14);
    expect(s.newIslandBonusVp ?? 2).toBe(2);
  });

  it('本島15＋新島7 の二島に分かれる', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([15, 7]);
  });

  it('海峡(q=0列)が全て海で左右の陸塊を分離（船が必要）', () => {
    for (const r of [-3, -2, -1, 0, 1, 2, 3]) expect(s.tiles[`0,${r}`]?.type).toBe('sea');
    expect(s.tiles['-1,-1']?.type).toBe('pasture'); // 公式S1は砂漠なし＝盗賊初期は牧草に置く
    expect(s.tiles['1,-1']?.type).toBe('gold');    // 新島の金
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

  it('盗賊は本島(-1,-1)から開始（公式S1は砂漠なしのため牧草上に置く）', () => {
    const robber = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(robber.id).toBe('-1,-1');
    expect(robber.type).toBe('pasture');
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
      // [D1] 港は公式に寄せて複数配置（旧実装の4個固定をやめた）。
      expect(st.harbors.length).toBeGreaterThanOrEqual(5);
      expect(st.harbors.length).toBeLessThanOrEqual(9);
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

  it('[D1] 大きな航海者盤では5種の専門港(2:1)と3:1港の両方が配置される', () => {
    const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
    const types = st.harbors.map(h => h.type);
    const specific = new Set(types.filter(t => t !== 'generic'));
    // 旧実装は木/レンガの2:1のみだった。5資源すべての2:1港が出ること。
    for (const r of ['wood', 'brick', 'wool', 'grain', 'ore']) {
      expect(specific.has(r as never)).toBe(true);
    }
    // 3:1（generic）港も少なくとも1つ。
    expect(types.includes('generic')).toBe(true);
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

describe('scenarios: 航海者「砂漠を越えて」(公式S4)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_throughdesert');
  it('公式S4の陸構成（砂漠3/森5/山4/丘3/牧草4/畑4/金2＝陸25）に一致・数字22', () => {
    expect(s.victoryTarget).toBe(14);
    expect(count(s.tiles, 'gold')).toBe(2);
    expect(count(s.tiles, 'desert')).toBe(3);   // 大きな砂漠帯（本島1＋新天地2）
    expect(count(s.tiles, 'forest')).toBe(5);
    expect(count(s.tiles, 'mountain')).toBe(4);
    expect(count(s.tiles, 'hill')).toBe(3);
    expect(count(s.tiles, 'pasture')).toBe(4);
    expect(count(s.tiles, 'field')).toBe(4);
    expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(25);
    expect(Object.values(s.tiles).filter(t => t.number != null)).toHaveLength(22);
  });
  it('本島(最大15)と新天地(10)が海で分かれる2島', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([15, 10]);
  });
});

describe('航海者: 海賊コマは開始時から海ヘクスに居る（盗賊＋海賊が1体ずつ）', () => {
  it('新たな海岸: 開始時に piratePosition が海ヘクス、盗賊は砂漠', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
    expect(s.piratePosition).toBeTruthy();
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
    expect(Object.values(s.tiles).some(t => t.hasRobber)).toBe(true); // 盗賊も盤上
  });
  it('基本ゲームには海賊コマはいない（海が無い）', () => {
    const c = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'classic');
    expect(c.piratePosition).toBeUndefined();
  });
  it('海賊の島々(S7)・七不思議(S8)では通常の海賊コマを置かない', () => {
    const s7 = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_pirateislands');
    expect(s7.piratePosition).toBeUndefined(); // 海賊艦隊が別途いる
    const s8 = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_wonders');
    expect(s8.piratePosition).toBeUndefined(); // 海賊不使用
  });
});

describe('scenarios: 航海者「4つの島」(公式S2)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_fourislands');
  it('37ヘックス footprint で、海に隔てた4島に分かれる', () => {
    expect(Object.keys(s.tiles)).toHaveLength(37);
    const repOf = computeIslandReps(s.tiles);
    const islands = [...new Set(Object.values(repOf))];
    expect(islands).toHaveLength(4);
    // 各島がプレイ可能なサイズ（4タイル以上）
    for (const r of islands) {
      expect(Object.values(repOf).filter(x => x === r).length).toBeGreaterThanOrEqual(4);
    }
  });
  it('公式S2: 勝利点13・新島ボーナス+2・どの島にも初期配置可(setupAnywhere)', () => {
    expect(s.victoryTarget).toBe(13);
    expect(s.newIslandBonusVp).toBe(2);
    expect(s.setupAnywhere).toBe(true);
  });
  it('盤全体で全5資源が存在する（各自どこかの島から始められる）', () => {
    const types = new Set(Object.values(s.tiles).map(t => t.type));
    for (const t of ['forest', 'hill', 'pasture', 'field', 'mountain'] as const) {
      expect(types.has(t)).toBe(true);
    }
  });
});

describe('scenarios: 航海者「新世界」(New World)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newworld');
  it('公式: 勝利点12・新島ボーナス+1・どの島にも初期配置可(setupAnywhere)', () => {
    expect(s.victoryTarget).toBe(12);
    expect(s.newIslandBonusVp).toBe(1);
    expect(s.setupAnywhere).toBe(true);
  });
  it('3島に分かれ、本島が一意に最大（公式級37ヘックス）', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([15, 3, 3]);
  });
});
