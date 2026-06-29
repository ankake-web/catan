import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { chooseAction } from '../src/engine/ai';
import { applyAction } from '../src/engine/game';
import { computeIslandReps } from '../src/engine/islands';
import { isSeaEdge, isLandVertex } from '../src/engine/board';
import { RESOURCE_TYPES, makeHand } from '../src/constants';
import type { GameState, VertexId } from '../src/types';

const AI_SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'ai', aiDifficulty: 'strong' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'strong' },
];

const seafarers = (seed = 1): GameState =>
  createInitialGameState(AI_SPECS, 'fixed', ['player1', 'player2'], createRng(seed), 'seafarers_newshores');

// 島代表（島の骨格は固定なので中身ランダム化に依らず一定）。本島=最大成分、新島=本島以外のひとつ。
function mainRepOf(s: GameState): string {
  const repOf = computeIslandReps(s.tiles);
  const size: Record<string, number> = {};
  for (const r of Object.values(repOf)) size[r] = (size[r] ?? 0) + 1;
  return Object.entries(size).sort((a, b) => b[1] - a[1])[0]![0];
}
function anyOutlyingRepOf(s: GameState): string {
  const repOf = computeIslandReps(s.tiles);
  const m = mainRepOf(s);
  return [...new Set(Object.values(repOf))].find(r => r !== m)!;
}
const HOME_REP = mainRepOf(seafarers());
const NEW_REP = anyOutlyingRepOf(seafarers());

const handTotal = (s: GameState, pid: string): number =>
  RESOURCE_TYPES.reduce((sum, r) => sum + s.players[pid]!.hand[r], 0);

describe('AI 航海者: 海峡を渡る船の建設（Phase 5・基本AI）', () => {
  it('海峡に面した本島の沿岸開拓地から、CPU は新島へ向け船を建てる', () => {
    const g = seafarers();
    const repOf = computeIslandReps(g.tiles);
    // 本島の沿岸（海に面した陸）頂点を launch 点に（=新島へ向け船を出す起点）。
    const straitVid = Object.values(g.vertices).find(v =>
      v.adjacentTileIds.some(t => repOf[t] === HOME_REP)
      && v.adjacentEdgeIds.some(eid => isSeaEdge(g.edges[eid]!, g.vertices, g.tiles)),
    )!.id as VertexId;

    const s: GameState = {
      ...g,
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null,
      currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [straitVid]: { ...g.vertices[straitVid]!, building: { type: 'settlement', playerId: 'player1' } } },
      // 船コスト(木+羊)だけ持たせる。都市(鉱+麦)・接続のある開拓地は作れない状況。
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 2, wool: 2 }) } },
    };

    const action = chooseAction(s, 'player1', { rng: createRng(3) });
    expect(action?.type).toBe('BUILD_SHIP');
    if (action?.type === 'BUILD_SHIP') {
      expect(isSeaEdge(s.edges[action.edgeId]!, s.vertices, s.tiles)).toBe(true);
    }
  });

  it('新島の沿岸頂点に船が届いていれば、CPU はそこへ入植し +2VP を得る', () => {
    const g = seafarers();
    const repOf = computeIslandReps(g.tiles);
    // 新島の沿岸（海に面した陸）頂点と、その隣接の海辺を選ぶ。
    const newCoastVid = Object.values(g.vertices).find(v =>
      v.adjacentTileIds.some(t => repOf[t] === NEW_REP)
      && isLandVertex(v, g.tiles)
      && v.adjacentEdgeIds.some(eid => isSeaEdge(g.edges[eid]!, g.vertices, g.tiles)),
    )!.id as VertexId;
    const shipEdge = g.vertices[newCoastVid]!.adjacentEdgeIds
      .find(eid => isSeaEdge(g.edges[eid]!, g.vertices, g.tiles))!;

    const s: GameState = {
      ...g,
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null,
      currentPlayerIndex: 0, diceRolledThisTurn: true,
      edges: { ...g.edges, [shipEdge]: { ...g.edges[shipEdge]!, ship: { playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }) } },
    };

    const action = chooseAction(s, 'player1', { rng: createRng(3) });
    expect(action?.type).toBe('BUILD_SETTLEMENT');
    if (action?.type === 'BUILD_SETTLEMENT') {
      // 建設先は新島の頂点であること。
      const v = s.vertices[action.vertexId]!;
      expect(v.adjacentTileIds.some(t => repOf[t] === NEW_REP)).toBe(true);
      const next = applyAction(s, action);
      expect(next.islandBonus?.[NEW_REP]).toContain('player1');
    }
  });
});

describe('AI 航海者: フルCPU対戦が船を使い完走する（決定論スモーク）', () => {
  it('強CPU同士の対戦が GAME_OVER まで進み、少なくとも1隻の船が建設される', () => {
    // 3人の強CPU。大きい盤面＋勝利点13により、本島だけでは勝てず新島へ航海する必要が出る。
    const specs3: PlayerSpec[] = [
      { id: 'player1', name: 'A', color: 'red',    type: 'ai', aiDifficulty: 'strong' },
      { id: 'player2', name: 'B', color: 'blue',   type: 'ai', aiDifficulty: 'strong' },
      { id: 'player3', name: 'C', color: 'purple', type: 'ai', aiDifficulty: 'strong' },
    ];
    // 決定論だが盤面シードに依存しすぎないよう複数シードで検証（各ゲーム完走＋通算で船が建つ）。
    let totalShips = 0;
    for (const seed of [12345, 1, 7, 2024]) {
      const rng = createRng(seed);
      let s = createInitialGameState(specs3, 'fixed', ['player1', 'player2', 'player3'], rng, 'seafarers_newshores');
      let settlements = 0;
      for (let i = 0; i < 80_000 && s.phase !== 'GAME_OVER'; i++) {
        let pid = s.playerOrder[s.currentPlayerIndex]!;
        if (s.phase === 'MAIN' && s.turnPhase === 'DISCARD') {
          pid = s.playerOrder.find(p => !(s.discardedThisRound ?? []).includes(p) && handTotal(s, p) >= 8) ?? pid;
        } else if (s.phase === 'MAIN' && s.turnPhase === 'GOLD') {
          pid = s.playerOrder.find(p => ((s.pendingGoldChoice ?? {})[p] ?? 0) > 0) ?? pid;
        }
        const action = chooseAction(s, pid, { rng });
        if (!action) break;
        if (action.type === 'BUILD_SHIP') totalShips++;
        if (action.type === 'BUILD_SETTLEMENT') settlements++;
        s = applyAction(s, action, rng);
      }
      expect(s.phase).toBe('GAME_OVER'); // 各シードで完走
      expect(s.winner).not.toBeNull();
      expect(settlements).toBeGreaterThanOrEqual(1);
    }
    expect(totalShips).toBeGreaterThanOrEqual(1); // 通常対戦で船が建設される（新島へ航海）
  });
});
