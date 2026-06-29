import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { collectEdgeToken, placeHeldHarborAt } from '../src/engine/seaTokens';
import { calcVP, calcPublicVP } from '../src/engine/scoring';
import { canBuildSettlement } from '../src/engine/actions';
import { isLandVertex } from '../src/engine/board';
import type { GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const tribe = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_forgottentribe');
const edgeOf = (s: GameState, kind: string): string =>
  Object.keys(s.edgeTokens ?? {}).find(e => s.edgeTokens![e] === kind)!;

describe('S5 忘れられた部族: 海辺トークン', () => {
  it('シナリオ開始時に VP/開発カード/港 のトークンが海辺に配置される', () => {
    const s = tribe();
    const kinds = Object.values(s.edgeTokens ?? {});
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain('vp');
    expect(kinds).toContain('dev');
    expect(kinds).toContain('harbor');
  });

  it('[公式準拠] 金タイル2枚＋海上トークン VP8・開発カード4・港2', () => {
    const s = tribe();
    expect(Object.values(s.tiles).filter(t => t.type === 'gold')).toHaveLength(2);
    const kinds = Object.values(s.edgeTokens ?? {});
    expect(kinds.filter(k => k === 'vp')).toHaveLength(8);
    expect(kinds.filter(k => k === 'dev')).toHaveLength(4);
    expect(kinds.filter(k => k === 'harbor')).toHaveLength(2);
  });

  it('VPトークンを獲得すると +1VP（公開）・盤から除去される', () => {
    const s = tribe();
    const e = edgeOf(s, 'vp');
    const next = collectEdgeToken(s, e, 'player1');
    expect(next.edgeTokens![e]).toBeUndefined();
    expect(next.tokenVp!.player1).toBe(1);
    expect(calcVP(next, 'player1')).toBe(calcVP(s, 'player1') + 1);
    expect(calcPublicVP(next, 'player1')).toBe(calcPublicVP(s, 'player1') + 1);
  });

  it('開発カードトークンを獲得すると今ターン購入扱いの開発カードを1枚引く', () => {
    const s = tribe();
    const e = edgeOf(s, 'dev');
    const before = s.players.player1!.devCards.length;
    const next = collectEdgeToken(s, e, 'player1');
    expect(next.players.player1!.devCards.length).toBe(before + 1);
    expect(next.players.player1!.devCards.at(-1)!.purchasedOnTurn).toBe(s.globalTurnNumber);
  });

  it('港トークンは沿岸の建物が無ければ保留され、沿岸開拓地を建てると設置される', () => {
    const s = tribe();
    const e = edgeOf(s, 'harbor');
    const held = collectEdgeToken(s, e, 'player1');
    expect((held.heldHarbors?.player1 ?? 0)).toBe(1); // 建物が無いので保留

    // 沿岸の本島頂点に開拓地を建てる（MAIN・接続を満たす状態を組む）。
    const v = Object.keys(held.vertices).find(vid => {
      const vx = held.vertices[vid]!;
      return isLandVertex(vx, held.tiles)
        && vx.adjacentTileIds.some(t => held.tiles[t]?.type === 'sea')   // 沿岸
        && vx.adjacentTileIds.some(t => held.tiles[t]?.number != null)   // 数字ヘックス隣接(numberHexOnly)
        && vx.harborType == null;
    })!;
    // [D8] 港同士は1辺以上空ける。機構を決定的に検証するため、v とその隣接頂点の港を外して
    // 配置可能な状況を作る（盤の港密度に依存させない）。
    const clearedVerts = { ...held.vertices };
    for (const av of [v, ...held.vertices[v]!.adjacentVertexIds]) {
      if (clearedVerts[av]) clearedVerts[av] = { ...clearedVerts[av]!, harborType: null };
    }
    const eid = held.vertices[v]!.adjacentEdgeIds[0]!;
    const s2: GameState = {
      ...held, vertices: clearedVerts,
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      edges: { ...held.edges, [eid]: { ...held.edges[eid]!, road: { playerId: 'player1' } } },
      players: { ...held.players, player1: { ...held.players.player1!, hand: { wood: 1, brick: 1, wool: 1, grain: 1, ore: 0 } } },
    };
    const built = applyAction(s2, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(built.vertices[v]!.harborType).toBe('generic');     // 港が設置された
    expect(built.heldHarbors?.player1 ?? 0).toBe(0);           // 保留が消費された
  });

  it('[D8] 港トークンは既存港に隣接する頂点には設置できない（港同士1辺以上空ける）', () => {
    const s0 = tribe();
    const v = Object.keys(s0.vertices).find(vid => {
      const vx = s0.vertices[vid]!;
      return isLandVertex(vx, s0.tiles)
        && vx.adjacentTileIds.some(t => s0.tiles[t]?.type === 'sea')
        && vx.adjacentVertexIds.length > 0;
    })!;
    const av = s0.vertices[v]!.adjacentVertexIds[0]!;
    const s: GameState = {
      ...s0,
      heldHarbors: { player1: 1 },
      vertices: {
        ...s0.vertices,
        [v]: { ...s0.vertices[v]!, building: { type: 'settlement', playerId: 'player1' }, harborType: null },
        [av]: { ...s0.vertices[av]!, harborType: 'wood' }, // 隣接頂点に既存港
      },
    };
    const r = placeHeldHarborAt(s, 'player1', v);
    expect(r.vertices[v]!.harborType).toBeNull(); // 隣接港があるので設置不可
    expect(r.heldHarbors!.player1).toBe(1);       // 保留のまま
  });

  it('[宝島] 開始時に霧と財宝(treasure)トークンが配置され、VP13・島ボーナス+2', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_treasure');
    expect(s.victoryTarget).toBe(13);
    expect(s.newIslandBonusVp).toBe(2);
    // 霧（中央本島を取り囲む）
    expect(Object.values(s.tiles).some(t => t.fog != null)).toBe(true);
    // 財宝トークン
    const kinds = Object.values(s.edgeTokens ?? {});
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every(k => k === 'treasure')).toBe(true);
  });

  it('[宝島] 財宝トークンを船で回収すると資源2枚 or 開発カード1枚を得てトークンが消える', () => {
    const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_treasure');
    const e = Object.keys(s.edgeTokens ?? {}).find(k => s.edgeTokens![k] === 'treasure')!;
    const handTotal = (st: GameState, pid: string): number =>
      (['wood', 'brick', 'wool', 'grain', 'ore'] as const).reduce((sum, r) => sum + st.players[pid]!.hand[r], 0);
    const beforeHand = handTotal(s, 'player1');
    const beforeDev = s.players.player1!.devCards.length;
    const next = collectEdgeToken(s, e, 'player1');
    expect(next.edgeTokens![e]).toBeUndefined(); // トークン除去
    const gainedRes = handTotal(next, 'player1') - beforeHand;
    const gainedDev = next.players.player1!.devCards.length - beforeDev;
    // 資源2枚 または 開発カード1枚のいずれか。
    expect((gainedRes === 2 && gainedDev === 0) || (gainedRes === 0 && gainedDev === 1)).toBe(true);
  });

  it('numberHexOnly: 数字ヘックスに隣接しない陸頂点には開拓地を置けない（あれば）', () => {
    const s = tribe();
    const noNumberV = Object.keys(s.vertices).find(vid => {
      const v = s.vertices[vid]!;
      return isLandVertex(v, s.tiles) && !v.adjacentTileIds.some(t => s.tiles[t]?.number != null);
    });
    if (noNumberV) {
      // SETUP では接続不要なので、唯一の阻害要因は numberHexOnly。
      expect(canBuildSettlement(s, 'player1', noNumberV)).toBe(false);
    }
    expect(s.numberHexOnly).toBe(true); // フラグが配線されていること自体は常に検証
  });
});
