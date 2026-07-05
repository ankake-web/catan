import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { getScenario, listScenarios, listVisibleScenarios, getScenarioRules } from '../src/engine/scenarios';
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
  it('表示シナリオは基本/都市と騎士＋航海者7つ＋C&K複合3つ＋オアシス＋交易と蛮族（他は実装は残すが非表示）', () => {
    const visible = listVisibleScenarios().map(s => s.id).sort();
    expect(visible).toEqual(
      [
        'classic', 'cities_knights',
        'seafarers_newshores', 'seafarers_drought', 'seafarers_treasure',
        'seafarers_fourislands', 'seafarers_fogislands', 'seafarers_oceania',
        'seafarers_throughdesert', 'seafarers_greatercatan',
        'ck_seafarers_newshores', 'ck_seafarers_oceania', 'ck_seafarers_greatercatan',
        'oasis',
        // 交易と蛮族（Traders & Barbarians）
        'tb_friendly_robber',
        'tb_harbors',
        'tb_event_cards',
      ].sort(),
    );
    // 非表示シナリオも実装（getScenario）とフル一覧（listScenarios）には残る。
    expect(listScenarios().length).toBeGreaterThan(visible.length);
    expect(getScenario('seafarers_cloth').id).toBe('seafarers_cloth');
  });
  it('全シナリオに「このゲーム固有ルール」テキストがある／state に scenarioId が入る', () => {
    for (const { id } of listScenarios()) {
      const rules = getScenarioRules(id);
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    }
    // 未知IDは基本ルールへフォールバック。
    expect(getScenarioRules('nope')).toEqual(getScenarioRules('classic'));
    // createInitialGameState が scenarioId を state に乗せる（遊び方の固有ルール表示に使う）。
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
    expect(s.scenarioId).toBe('seafarers_newshores');
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

  it('公式アプリ4人盤(51ヘックス)の陸構成（丘4/森4/牧草4/畑4/山4/金2/砂漠0＝陸22）に一致・数字22', () => {
    expect(Object.keys(s.tiles)).toHaveLength(51);
    expect(count(s.tiles, 'sea')).toBe(29);
    expect(count(s.tiles, 'gold')).toBe(2);
    expect(count(s.tiles, 'desert')).toBe(0);   // 公式S1は砂漠なし
    expect(count(s.tiles, 'hill')).toBe(4);
    expect(count(s.tiles, 'forest')).toBe(4);
    expect(count(s.tiles, 'pasture')).toBe(4);
    expect(count(s.tiles, 'field')).toBe(4);
    expect(count(s.tiles, 'mountain')).toBe(4);
    // 陸22（金2含む）・数字トークン22（砂漠が無く全陸に数字）
    expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(22);
    expect(Object.values(s.tiles).filter(t => t.number != null)).toHaveLength(22);
  });

  it('[島ごと固定構成] 本島(14)=牧草4/森3/畑3/山2/丘2、小島(8)=金2/丘2/森1/山2/畑1（配置のみ毎ゲームランダム）', () => {
    for (const seed of [1, 2, 7, 13]) {
      const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_newshores');
      const repOf = computeIslandReps(st.tiles);
      const sizeOf: Record<string, number> = {};
      for (const r of Object.values(repOf)) sizeOf[r] = (sizeOf[r] ?? 0) + 1;
      const mainRep = Object.entries(sizeOf).sort((a, b) => b[1] - a[1])[0]![0];
      const tally = (pred: (id: string) => boolean) => {
        const c: Record<string, number> = {};
        for (const t of Object.values(st.tiles)) {
          if (t.type === 'sea' || !pred(t.id)) continue;
          c[t.type] = (c[t.type] ?? 0) + 1;
        }
        return c;
      };
      const main = tally(id => repOf[id] === mainRep);
      const small = tally(id => repOf[id] != null && repOf[id] !== mainRep);
      expect(main).toEqual({ pasture: 4, forest: 3, field: 3, mountain: 2, hill: 2 });
      expect(small).toEqual({ gold: 2, hill: 2, forest: 1, mountain: 2, field: 1 });
    }
  });

  it('公式S1: 勝利点は14・新島初入植ボーナスは+2', () => {
    expect(s.victoryTarget).toBe(14);
    expect(s.newIslandBonusVp ?? 2).toBe(2);
  });

  it('中央本島14＋四方の小島4つ(各2)に分かれる（公式アプリ4人盤のトポロジ）', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([14, 2, 2, 2, 2]);
  });

  it('金は離れ小島（本島以外の小島）にのみ出る（本島には置かない＝毎ゲームランダム配置）', () => {
    const repOf = computeIslandReps(s.tiles);
    // 最大連結成分＝本島
    const sizeOf: Record<string, number> = {};
    for (const r of Object.values(repOf)) sizeOf[r] = (sizeOf[r] ?? 0) + 1;
    const mainRep = Object.entries(sizeOf).sort((a, b) => b[1] - a[1])[0]![0];
    const gold = Object.values(s.tiles).filter(t => t.type === 'gold');
    expect(gold).toHaveLength(2);
    // 金タイルはどれも本島(最大成分)に属さない＝離れ小島の上
    expect(gold.every(t => repOf[t.id] !== mainRep)).toBe(true);
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

  it('[公式準拠] 砂漠なし盤は盗賊を初期に置かない（7が出るまで盤外）。海賊は最も遠い海から開始', () => {
    // 盗賊は盤上に存在しない（どのタイルにも hasRobber が無い）。
    expect(Object.values(s.tiles).some(t => t.hasRobber)).toBe(false);
    // 海賊は海タイルに居る。
    expect(s.piratePosition).toBeDefined();
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
    // 海賊の初期位置は「最も中央から遠い海ヘクス」（決定論）。
    const seas = Object.values(s.tiles).filter(t => t.type === 'sea');
    const dist = (t: typeof seas[number]) => t.coord.q * t.coord.q + t.coord.r * t.coord.r;
    const maxDist = Math.max(...seas.map(dist));
    expect(dist(s.tiles[s.piratePosition!]!)).toBe(maxDist);
  });

  it('盤面が viewBox に収まるよう、基本盤より頂点/辺が多い（大きい盤）', () => {
    expect(Object.keys(s.vertices).length).toBeGreaterThan(54);
    expect(Object.keys(s.edges).length).toBeGreaterThan(72);
  });
});

describe('scenarios: 航海者「干ばつ」(公式アプリ・本島は砂漠の痩せ地)', () => {
  // 中身ランダムだが「砂漠は本島・金は離れ小島」「構成枚数」「島構造」は不変。複数シードで検証。
  for (const seed of [1, 2, 7]) {
    it(`seed${seed}: 51ヘックス・陸23(砂漠3/金2)・本島15＋小島4・砂漠は本島・金は離れ小島・14点`, () => {
      const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_drought');
      expect(Object.keys(s.tiles)).toHaveLength(51);
      expect(count(s.tiles, 'sea')).toBe(28);
      expect(count(s.tiles, 'desert')).toBe(3);
      expect(count(s.tiles, 'gold')).toBe(2);
      expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(23);
      expect(s.victoryTarget).toBe(14);
      expect(s.newIslandBonusVp).toBe(2);
      // 島構造: 中央本島15＋四方の小島4つ(各2)
      const repOf = computeIslandReps(s.tiles);
      const sizeOf: Record<string, number> = {};
      for (const r of Object.values(repOf)) sizeOf[r] = (sizeOf[r] ?? 0) + 1;
      const sizes = Object.values(sizeOf).sort((a, b) => b - a);
      expect(sizes).toEqual([15, 2, 2, 2, 2]);
      const mainRep = Object.entries(sizeOf).sort((a, b) => b[1] - a[1])[0]![0];
      // 砂漠はすべて本島(最大成分)に、金はすべて離れ小島に。
      for (const t of Object.values(s.tiles)) {
        if (t.type === 'desert') expect(repOf[t.id]).toBe(mainRep);
        if (t.type === 'gold') expect(repOf[t.id]).not.toBe(mainRep);
      }
      // 盗賊は砂漠（=本島）の上。
      const robber = Object.values(s.tiles).find(t => t.hasRobber)!;
      expect(robber.type).toBe('desert');
      expect(repOf[robber.id]).toBe(mainRep);
    });
  }
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
    // 金は離れ小島（右 q>=1）にのみ出る（本島には置かない＝毎ゲームランダム配置）。
    const gold = Object.values(s.tiles).filter(t => t.type === 'gold');
    expect(gold).toHaveLength(1);
    expect(gold.every(t => t.coord.q >= 1)).toBe(true);
  });
});

describe('scenarios: 航海者「砂漠を越えて」(公式S4・公式アプリ4人盤 photo/IMG_6412 実読)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_throughdesert');
  it('陸構成（山6/森3/牧草3/丘3/畑4/砂漠2・金なし＝陸21）に一致・数字19', () => {
    expect(s.victoryTarget).toBe(14);
    expect(count(s.tiles, 'gold')).toBe(0);
    expect(count(s.tiles, 'desert')).toBe(2);   // 砂漠帯
    expect(count(s.tiles, 'forest')).toBe(3);
    expect(count(s.tiles, 'mountain')).toBe(6);
    expect(count(s.tiles, 'hill')).toBe(3);
    expect(count(s.tiles, 'pasture')).toBe(3);
    expect(count(s.tiles, 'field')).toBe(4);
    expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(21);
    expect(Object.values(s.tiles).filter(t => t.number != null)).toHaveLength(19);
  });
  it('大陸(本土＋砂漠帯＋陸続きの北西地方=15)＋海の小島3つ(各2)。砂漠帯が陸橋＝北西は本島扱い', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([15, 2, 2, 2]); // 北西地方は砂漠帯で本土と陸続き＝最大成分に含まれる
    expect(s.newIslandBonusVp).toBe(2);    // 小島は島ボーナス
    expect(s.regionBonusVp).toBe(2);       // 北西地方は地域ボーナス
    expect(s.bonusRegionTiles).toHaveLength(3);
  });
  it('北西地方(地域ボーナス対象)は最大成分(本島)に属する＝島ボーナスとは二重取りにならない', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizeOf: Record<string, number> = {};
    for (const r of Object.values(repOf)) sizeOf[r] = (sizeOf[r] ?? 0) + 1;
    const mainRep = Object.entries(sizeOf).sort((a, b) => b[1] - a[1])[0]![0];
    for (const tid of s.bonusRegionTiles!) expect(repOf[tid]).toBe(mainRep);
    // 砂漠は陸橋として大陸に属し、盗賊はそこから開始。
    const robber = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(robber.type).toBe('desert');
    expect(repOf[robber.id]).toBe(mainRep);
  });
});

describe('scenarios: 航海者「新世界」(公式New World・制約付きランダム生成)', () => {
  it('陸構成は固定(森4/畑4/牧草4/丘3/山3/砂漠1/金2)・島15/3/3・シードで盤が変わる', () => {
    const a = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newworld');
    const b = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(2), 'seafarers_newworld');
    for (const s of [a, b]) {
      expect(count(s.tiles, 'forest')).toBe(4);
      expect(count(s.tiles, 'field')).toBe(4);
      expect(count(s.tiles, 'pasture')).toBe(4);
      expect(count(s.tiles, 'hill')).toBe(3);
      expect(count(s.tiles, 'mountain')).toBe(3);
      expect(count(s.tiles, 'desert')).toBe(1);
      expect(count(s.tiles, 'gold')).toBe(2);
      const repOf = computeIslandReps(s.tiles);
      const sizes = [...new Set(Object.values(repOf))]
        .map(r => Object.values(repOf).filter(x => x === r).length).sort((x, y) => y - x);
      expect(sizes).toEqual([15, 3, 3]); // 島構造は固定（本島15＋小島3+3）
    }
    // 異なるシードでタイル配置が変わる（＝ランダム生成）。
    const sig = (s: typeof a) => Object.entries(s.tiles).map(([id, t]) => `${id}:${t.type}:${t.number}`).join('|');
    expect(sig(a)).not.toBe(sig(b));
  });
});

describe('scenarios: 都市と騎士 × 航海者 コンボ（公式アプリ）', () => {
  it('新たな岸へCK=17点/オセアニアCK=15点/大カタンCK=20点・いずれも expansion=cities_knights', () => {
    const cases: Array<[string, number]> = [
      ['ck_seafarers_newshores', 17], ['ck_seafarers_oceania', 15], ['ck_seafarers_greatercatan', 20],
    ];
    for (const [id, vp] of cases) {
      const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), id);
      expect(s.victoryTarget).toBe(vp);
      expect(s.expansion).toBe('cities_knights');
      // 航海者の盤（海タイルがある＝船で渡る）であること。
      expect(Object.values(s.tiles).some(t => t.type === 'sea')).toBe(true);
    }
  });
  it('大カタンCK は抜けている数値トークン＋都市制限8、オセアニアCK は霧あり', () => {
    const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'ck_seafarers_greatercatan');
    expect(g.maxCities).toBe(8);
    expect(Object.values(g.tiles).some(t => t.pendingNumber != null)).toBe(true);
    const o = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'ck_seafarers_oceania');
    expect(Object.values(o.tiles).some(t => t.fog != null)).toBe(true);
    expect(o.setupAnywhere).toBe(true);
  });
});

describe('scenarios: 航海者「大カタン」(公式アプリ4人盤 photo/IMG_6420 実読・抜けている数値トークン)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_greatercatan');
  it('51ヘックス・中央本島16＋数字なし小島5つ(各2)・18点・都市制限8', () => {
    expect(Object.keys(s.tiles)).toHaveLength(51);
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([16, 2, 2, 2, 2, 2]);
    expect(s.victoryTarget).toBe(18);
    expect(s.maxCities).toBe(8);
    expect(s.newIslandBonusVp).toBe(0);
  });
  it('小島タイルは最初は数字なし(産出しない)＝pendingNumber を持つ。本島タイルは数字あり', () => {
    const repOf = computeIslandReps(s.tiles);
    const sizeOf: Record<string, number> = {};
    for (const r of Object.values(repOf)) sizeOf[r] = (sizeOf[r] ?? 0) + 1;
    const mainRep = Object.entries(sizeOf).sort((a, b) => b[1] - a[1])[0]![0];
    for (const t of Object.values(s.tiles)) {
      if (t.type === 'sea') continue;
      if (repOf[t.id] === mainRep) {
        // 本島: 砂漠以外は数字あり・pending なし
        if (t.type !== 'desert') expect(t.number).not.toBeNull();
        expect(t.pendingNumber).toBeUndefined();
      } else {
        // 小島: 数字なし・pendingNumber を保持（到達で出現）
        expect(t.number).toBeNull();
        expect(t.pendingNumber).toBeTypeOf('number');
      }
    }
  });
  it('砂漠は本島・盗賊は砂漠から開始。海賊は最も遠い海から', () => {
    const robber = Object.values(s.tiles).find(t => t.hasRobber)!;
    expect(robber.type).toBe('desert');
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
  });
});

describe('航海者: 海賊コマは開始時から海ヘクスに居る（盗賊＋海賊が1体ずつ）', () => {
  it('新たな海岸(砂漠なし): piratePosition が海ヘクス、盗賊は7まで盤外', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
    expect(s.piratePosition).toBeTruthy();
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
    expect(Object.values(s.tiles).some(t => t.hasRobber)).toBe(false); // 砂漠なし＝盗賊は初期は盤外
  });
  it('干ばつ(砂漠あり): 開始時に盗賊は砂漠タイルに居る', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_drought');
    const robber = Object.values(s.tiles).find(t => t.hasRobber);
    expect(robber).toBeTruthy();
    expect(robber!.type).toBe('desert');
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

describe('scenarios: 航海者「4つの島」(公式S2・公式アプリ4人盤 photo/IMG_6406 実読)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_fourislands');
  it('51ヘックス footprint で、海に隔てた大きさの異なる4島(8/7/4/4)に分かれる', () => {
    expect(Object.keys(s.tiles)).toHaveLength(51);
    const repOf = computeIslandReps(s.tiles);
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([8, 7, 4, 4]);
  });
  it('砂漠なし・金なし・陸23（全マスに数字）。全体構成は丘4/山4/畑5/森5/牧草5', () => {
    expect(count(s.tiles, 'desert')).toBe(0);
    expect(count(s.tiles, 'gold')).toBe(0);
    expect(Object.values(s.tiles).filter(t => t.type !== 'sea')).toHaveLength(23);
    expect(Object.values(s.tiles).filter(t => t.number != null)).toHaveLength(23);
    expect(count(s.tiles, 'hill')).toBe(4);
    expect(count(s.tiles, 'mountain')).toBe(4);
    expect(count(s.tiles, 'field')).toBe(5);
    expect(count(s.tiles, 'forest')).toBe(5);
    expect(count(s.tiles, 'pasture')).toBe(5);
  });
  it('[島ごと固定構成] 各島の資源の組み合わせは毎ゲーム固定（配置のみランダム）', () => {
    // 各島の資源多重集合を「種別:枚数」を並べた署名にして、4島の署名集合が実読どおりか検証。
    const sig = (c: Record<string, number>) =>
      Object.entries(c).sort().map(([k, v]) => `${k}${v}`).join('/');
    const expected = new Set([
      sig({ hill: 1, mountain: 1, field: 2 }),                          // 島A(4)
      sig({ forest: 4, pasture: 2, mountain: 1, field: 1 }),            // 島B(8)
      sig({ mountain: 2, field: 2, pasture: 1, hill: 1, forest: 1 }),   // 島D(7)
      sig({ hill: 2, pasture: 2 }),                                     // 島C(4)
    ]);
    for (const seed of [1, 2, 7, 13]) {
      const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_fourislands');
      const repOf = computeIslandReps(st.tiles);
      const byIsland: Record<string, Record<string, number>> = {};
      for (const t of Object.values(st.tiles)) {
        if (t.type === 'sea') continue;
        const rep = repOf[t.id]!;
        (byIsland[rep] ??= {})[t.type] = (byIsland[rep]![t.type] ?? 0) + 1;
      }
      const got = new Set(Object.values(byIsland).map(sig));
      expect(got).toEqual(expected);
    }
  });
  it('公式S2: 勝利点13・新島ボーナス+2・どの島にも初期配置可(setupAnywhere)', () => {
    expect(s.victoryTarget).toBe(13);
    expect(s.newIslandBonusVp).toBe(2);
    expect(s.setupAnywhere).toBe(true);
  });
  it('[公式準拠] 砂漠なし＝盗賊は初期盤外（7まで）・海賊は最遠の海から開始', () => {
    expect(Object.values(s.tiles).some(t => t.hasRobber)).toBe(false);
    expect(s.piratePosition).toBeDefined();
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
  });
});

describe('scenarios: 航海者「オセアニア」(公式アプリ4人盤 photo/IMG_6409 実読)', () => {
  const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_oceania');
  it('始発の2島(10/7・写真どおりのいびつな形)＋霧16＋海リング。砂漠なし＝盗賊は盤外・海賊は海', () => {
    // フットプリント: 島17＋霧16＝33セル＋周囲1リングの海（coordsWithSeaRing）。
    expect(Object.keys(s.tiles)).toHaveLength(73);
    expect(Object.values(s.tiles).filter(t => t.fog != null)).toHaveLength(16);
    const repOf = computeIslandReps(s.tiles); // 霧は海扱い＝島に数えない
    const sizes = [...new Set(Object.values(repOf))]
      .map(r => Object.values(repOf).filter(x => x === r).length).sort((a, b) => b - a);
    expect(sizes).toEqual([10, 7]);
    // 島の形は写真の実測位置に固定（いびつな形の回帰防止。中身の資源/数字は島内シャッフル）。
    const landIds = Object.values(s.tiles).filter(t => t.type !== 'sea').map(t => t.id).sort();
    expect(landIds).toEqual([
      '0,4', '0,5', '0,6', '1,4', '1,5', '2,4', '2,5',                       // 南西の島7
      '4,-1', '4,0', '5,-1', '5,0', '6,-1', '6,-2', '6,0', '7,-1', '7,-2', '7,0', // 北東の島10
    ].sort());
    expect(Object.values(s.tiles).some(t => t.type === 'desert')).toBe(false);
    expect(Object.values(s.tiles).some(t => t.hasRobber)).toBe(false);
    expect(s.tiles[s.piratePosition!]!.type).toBe('sea');
  });
  it('[海バッファ] 霧マスは始発島に直接接触せず必ず海を挟む（船で海を渡ってのみ探索）', () => {
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    for (const seed of [1, 3, 9]) {
      const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_oceania');
      for (const t of Object.values(st.tiles)) {
        if (t.fog == null) continue; // 霧マス（?タイル）だけ検査
        for (const [dq, dr] of DIRS) {
          const nid = `${t.coord.q + dq},${t.coord.r + dr}`;
          const nt = st.tiles[nid];
          const nHome = !!nt && nt.type !== 'sea' && nt.fog == null;
          expect(nHome).toBe(false); // 霧の隣が始発島の陸であってはならない
        }
      }
    }
  });
  it('霧があり、霧の中に金鉱の島が2つ隠れている（公開まで見えない）', () => {
    expect(Object.values(s.tiles).some(t => t.fog != null)).toBe(true);
    expect(Object.values(s.tiles).filter(t => t.fog?.type === 'gold').length).toBe(2);
    expect(Object.values(s.tiles).some(t => t.type === 'gold')).toBe(false);
  });
  it('公式: 勝利点12・島ボーナス無し(報酬は資源)・どの始発島にも初期配置可', () => {
    expect(s.victoryTarget).toBe(12);
    expect(s.newIslandBonusVp).toBe(0);
    expect(s.setupAnywhere).toBe(true);
  });
  it('[島ごと固定構成] 2始発島の資源の組み合わせは毎ゲーム固定', () => {
    const sig = (c: Record<string, number>) =>
      Object.entries(c).sort().map(([k, v]) => `${k}${v}`).join('/');
    const expected = new Set([
      sig({ forest: 2, field: 2, pasture: 3, mountain: 2, hill: 1 }), // 西(10)
      sig({ forest: 2, mountain: 1, hill: 2, field: 1, pasture: 1 }), // 東(7)
    ]);
    for (const seed of [1, 3, 9]) {
      const st = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_oceania');
      const repOf = computeIslandReps(st.tiles);
      const byIsland: Record<string, Record<string, number>> = {};
      for (const t of Object.values(st.tiles)) {
        if (t.type === 'sea' || repOf[t.id] == null) continue;
        (byIsland[repOf[t.id]!] ??= {})[t.type] = (byIsland[repOf[t.id]!]![t.type] ?? 0) + 1;
      }
      expect(new Set(Object.values(byIsland).map(sig))).toEqual(expected);
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
