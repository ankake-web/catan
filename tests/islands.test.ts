import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { computeIslandReps, newIslandBonusRep, isHomeIslandVertex } from '../src/engine/islands';
import { calcVP, calcPublicVP } from '../src/engine/scoring';
import { canBuildSettlement } from '../src/engine/actions';
import { applyAction } from '../src/engine/game';
import type { GameState, VertexId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];

const seafarers = (seed = 1): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_newshores');
const classic = (seed = 1): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'classic');

// 島代表は連結成分内で文字列順最小の TileId。
// 本島(左 q=-1,-2)の最小は "-1,-1"、新島(右 q=1,2)の最小は "1,-1"。
const HOME_REP = '-1,-1';
const NEW_REP = '1,-1';

// 指定島代表に属する頂点を1つ返す（陸に面した頂点）。
function vertexOnIsland(s: GameState, rep: string, exclude: Set<string> = new Set()): VertexId {
  const repOf = computeIslandReps(s.tiles);
  const vid = Object.keys(s.vertices).find(v => {
    if (exclude.has(v)) return false;
    return s.vertices[v]!.adjacentTileIds.some(t => repOf[t] === rep);
  });
  if (!vid) throw new Error(`no vertex on island ${rep}`);
  return vid;
}

describe('islands: 連結成分（航海者「新たな海岸を求めて」）', () => {
  it('海で分断され、本島(12)と新島(9)の2島に分かれる', () => {
    const repOf = computeIslandReps(seafarers().tiles);
    const reps = new Set(Object.values(repOf));
    expect(reps.size).toBe(2);
    expect(reps.has(HOME_REP)).toBe(true);
    expect(reps.has(NEW_REP)).toBe(true);
    const homeCount = Object.values(repOf).filter(r => r === HOME_REP).length;
    const newCount = Object.values(repOf).filter(r => r === NEW_REP).length;
    expect(homeCount).toBe(15); // 砂漠含む本島15タイル（公式S1級・37ヘックス）
    expect(newCount).toBe(7);   // 新島7タイル
  });

  it('海タイルは島に含まれない', () => {
    const repOf = computeIslandReps(seafarers().tiles);
    for (const id of ['0,0', '0,-1', '0,1', '2,-2']) {
      // q=0列と外周は海 → repが無い
      if (seafarers().tiles[id]?.type === 'sea') expect(repOf[id]).toBeUndefined();
    }
  });

  it('基本ゲーム(classic)は全タイルが1島（海タイル無し）', () => {
    const repOf = computeIslandReps(classic().tiles);
    expect(new Set(Object.values(repOf)).size).toBe(1);
  });
});

describe('初期配置は本島のみ（航海者・新島へは航海で渡る）', () => {
  it('SETUP では本島の頂点は置けるが、新島の頂点は置けない', () => {
    const s = seafarers(); // 既定で SETUP_FORWARD・currentPlayerIndex 0（player1）
    const home = vertexOnIsland(s, HOME_REP);
    const isle = vertexOnIsland(s, NEW_REP);
    expect(isHomeIslandVertex(s, home)).toBe(true);
    expect(isHomeIslandVertex(s, isle)).toBe(false);
    expect(canBuildSettlement(s, 'player1', home)).toBe(true);
    expect(canBuildSettlement(s, 'player1', isle)).toBe(false);
  });

  it('基本ゲームは初期配置の島制限なし（全頂点が本島扱い）', () => {
    const c = classic();
    const v = Object.keys(c.vertices)[0]!;
    expect(isHomeIslandVertex(c, v)).toBe(true);
  });
});

describe('newIslandBonusRep: 新島への最初の入植判定', () => {
  it('新島に建物が1個（=最初の入植）なら新島の代表IDを返す', () => {
    const base = seafarers();
    const v = vertexOnIsland(base, NEW_REP);
    const s: GameState = {
      ...base,
      vertices: { ...base.vertices, [v]: { ...base.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    expect(newIslandBonusRep(s, v)).toBe(NEW_REP);
  });

  it('新島に既に他人の建物があっても、別プレイヤーの初入植は新島の代表IDを返す（公式: 他人が先でも各自獲得可）', () => {
    const base = seafarers();
    const v1 = vertexOnIsland(base, NEW_REP);
    const v2 = vertexOnIsland(base, NEW_REP, new Set([v1]));
    const s: GameState = {
      ...base,
      vertices: {
        ...base.vertices,
        [v1]: { ...base.vertices[v1]!, building: { type: 'settlement', playerId: 'player1' } },
        [v2]: { ...base.vertices[v2]!, building: { type: 'settlement', playerId: 'player2' } },
      },
    };
    // 同定は島単位（本島以外の陸島）。プレイヤーごとの重複排除は呼び出し側(islandBonus)の責務。
    expect(newIslandBonusRep(s, v2)).toBe(NEW_REP);
  });

  it('本島に既存建物（セットアップ相当）があれば、本島へのMAIN入植はボーナス対象外', () => {
    const base = seafarers();
    const h1 = vertexOnIsland(base, HOME_REP);
    const h2 = vertexOnIsland(base, HOME_REP, new Set([h1]));
    const s: GameState = {
      ...base,
      vertices: {
        ...base.vertices,
        [h1]: { ...base.vertices[h1]!, building: { type: 'settlement', playerId: 'player1' } },
        [h2]: { ...base.vertices[h2]!, building: { type: 'settlement', playerId: 'player2' } },
      },
    };
    expect(newIslandBonusRep(s, h2)).toBeNull();
  });

  it('setupAnywhere: プレイヤー別ホーム島以外への初入植のみ対象（自分の出発島は対象外）', () => {
    const base = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newworld');
    const reps = [...new Set(Object.values(computeIslandReps(base.tiles)))];
    expect(reps.length).toBeGreaterThanOrEqual(2);
    const [repA, repB] = reps as string[];
    const vA = vertexOnIsland(base, repA!);
    const vB = vertexOnIsland(base, repB!);
    // player1 のホーム島を repA とする（初期配置で記録される想定）。
    const s: GameState = { ...base, playerHomeIslands: { player1: [repA!] } };
    expect(newIslandBonusRep(s, vA!, 'player1')).toBeNull();   // 自分のホーム島は対象外
    expect(newIslandBonusRep(s, vB!, 'player1')).toBe(repB);   // ホーム外への初入植は対象
  });

  it('基本ゲームでは常に null（海タイルが無いため新島ボーナスは発生しない）', () => {
    const base = classic();
    const v = Object.keys(base.vertices)[0]!;
    const s: GameState = {
      ...base,
      vertices: { ...base.vertices, [v]: { ...base.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    expect(newIslandBonusRep(s, v)).toBeNull();
  });
});

describe('island VP: applyAction(BUILD_SETTLEMENT) で新島入植に +2VP', () => {
  it('船で繋がった新島の頂点へ開拓地を建てると islandBonus が記録され公開VPに+2', () => {
    const base = seafarers();
    const v = vertexOnIsland(base, NEW_REP);
    const edgeId = base.vertices[v]!.adjacentEdgeIds[0]!;

    const s: GameState = {
      ...base,
      phase: 'MAIN',
      turnPhase: 'TRADE_BUILD',
      setupSubPhase: null,
      currentPlayerIndex: 0, // playerOrder[0] = player1
      diceRolledThisTurn: true,
      // 隣接辺に自分の船 → 開拓地の接続要件を満たす
      edges: { ...base.edges, [edgeId]: { ...base.edges[edgeId]!, ship: { playerId: 'player1' } } },
      players: {
        ...base.players,
        player1: { ...base.players.player1!, hand: { wood: 1, brick: 1, wool: 1, grain: 1, ore: 0 } },
      },
    };

    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });

    expect(next.islandBonus).toEqual({ [NEW_REP]: ['player1'] });
    // 開拓地1 + 島ボーナス2 = 3（公開・内部とも）
    expect(calcVP(next, 'player1')).toBe(3);
    expect(calcPublicVP(next, 'player1')).toBe(3);
    expect(calcVP(next, 'player2')).toBe(0);
  });

  it('公式: 同じ新島へ2人目が初入植しても、その2人目にも +2VP が付く（島ごと・他人が先でも可）', () => {
    const base = seafarers();
    const v = vertexOnIsland(base, NEW_REP);
    const edgeId = base.vertices[v]!.adjacentEdgeIds[0]!;

    const s: GameState = {
      ...base,
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null,
      currentPlayerIndex: 1, // player2 の手番
      diceRolledThisTurn: true,
      // 既に player1 がこの新島でボーナス獲得済み（盤面の建物有無に依らず重複排除を確認）
      islandBonus: { [NEW_REP]: ['player1'] },
      edges: { ...base.edges, [edgeId]: { ...base.edges[edgeId]!, ship: { playerId: 'player2' } } },
      players: {
        ...base.players,
        player2: { ...base.players.player2!, hand: { wood: 1, brick: 1, wool: 1, grain: 1, ore: 0 } },
      },
    };

    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.islandBonus?.[NEW_REP]).toEqual(['player1', 'player2']);
    // player2: 開拓地1 + 島ボーナス2 = 3
    expect(calcVP(next, 'player2')).toBe(3);
  });
});
