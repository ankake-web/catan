// 公式アプリ「オアシス」: 基本ゲーム＋道で砂漠/霧を探索＋財宝。船は使わない。
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { canBuildShip } from '../src/engine/actions';
import { edgeTileIds, isLandEdge } from '../src/engine/board';
import { makeHand, RESOURCE_TYPES } from '../src/constants';
import type { GameState, ResourceHand } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const oasis = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'oasis');
const total = (h: ResourceHand): number => RESOURCE_TYPES.reduce((s, r) => s + h[r], 0);

describe('オアシス: 盤構造（基本ゲーム＋砂漠探索）', () => {
  const s = oasis();
  it('37ヘックス・出発の陸13(全5資源＋砂漠)＋霧12・財宝あり・10点', () => {
    expect(Object.keys(s.tiles)).toHaveLength(37);
    const land = Object.values(s.tiles).filter(t => t.type !== 'sea');
    expect(land).toHaveLength(13);
    const types = new Set(land.map(t => t.type));
    for (const t of ['forest', 'hill', 'pasture', 'field', 'mountain', 'desert']) expect(types.has(t as never)).toBe(true);
    expect(Object.values(s.tiles).filter(t => t.fog != null)).toHaveLength(12);
    expect(Object.values(s.edgeTokens ?? {}).filter(k => k === 'treasure').length).toBeGreaterThan(0);
    expect(s.victoryTarget).toBe(10);
  });
  it('船は使わない: 各自30本の道・船0・海賊コマなし。盗賊は砂漠から開始', () => {
    expect(s.players.player1!.remainingRoads).toBe(30);
    expect(s.players.player1!.remainingShips).toBe(0);
    expect(s.piratePosition).toBeUndefined();
    expect(Object.values(s.tiles).find(t => t.hasRobber)!.type).toBe('desert');
  });
  it('霧は砂漠か資源地のみを隠す（海は隠さない＝必ず砂漠か資源が出る）', () => {
    for (const t of Object.values(s.tiles)) {
      if (t.fog) expect(t.fog.type).not.toBe('sea');
    }
  });
});

describe('オアシス: 道で探索（霧→砂漠/オアシス）と財宝', () => {
  it('海辺(霧)に面した辺にも道は置ける＝船不要で探索できる', () => {
    const g = oasis();
    // 霧タイルに面し、かつ出発の陸にも面する辺（フロンティア）は陸辺＝道が置ける。
    const E = Object.values(g.edges).find(e => {
      const tids = edgeTileIds(e, g.vertices);
      return tids.some(t => g.tiles[t]?.fog != null) && isLandEdge(e, g.vertices, g.tiles);
    })!;
    expect(E).toBeTruthy();
    // 船は建てられない（基本ゲーム・残船0）。
    expect(canBuildShip(g, 'player1', E.id)).toBe(false);
  });

  it('道で霧の横に到達すると晴れて、資源地なら資源1枚を得る（エンドツーエンド）', () => {
    const g = oasis();
    // 霧が「資源地」を隠していて、出発の陸にも面する辺を選ぶ。
    const E = Object.values(g.edges).find(e => {
      const tids = edgeTileIds(e, g.vertices);
      const fogLand = tids.find(t => g.tiles[t]?.fog && g.tiles[t]!.fog!.type !== 'desert');
      return fogLand != null && isLandEdge(e, g.vertices, g.tiles) && e.road == null;
    });
    expect(E).toBeTruthy();
    const fogTid = edgeTileIds(E!, g.vertices).find(t => g.tiles[t]?.fog)!;
    const v = E!.vertexIds[0]!;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 1, brick: 1 }) } },
    };
    const before = total(s.players.player1!.hand);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: E!.id });
    expect(next.tiles[fogTid]!.fog).toBeUndefined();           // 霧が晴れた
    expect(next.tiles[fogTid]!.type).not.toBe('sea');          // 砂漠か資源地に
    // 資源地（砂漠以外）を発見したので資源が1枚増える（道コスト2を引いた後で +1）。
    expect(total(next.players.player1!.hand)).toBe(before - 2 + 1);
  });

  it('財宝の辺に道を置くと獲得（盤から除去され、資源か発展カードを得る）', () => {
    const g = oasis();
    // 財宝の辺のうち、陸に面する（=道が置ける）ものを選ぶ。
    const tEdgeId = Object.keys(g.edgeTokens ?? {}).find(eid => {
      const e = g.edges[eid]!;
      return g.edgeTokens![eid] === 'treasure' && isLandEdge(e, g.vertices, g.tiles) && e.road == null;
    });
    expect(tEdgeId).toBeTruthy();
    const E = g.edges[tEdgeId!]!;
    const v = E.vertexIds[0]!;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 2, brick: 2 }) } },
    };
    const handBefore = total(s.players.player1!.hand);
    const devBefore = s.players.player1!.devCards.length;
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: tEdgeId! });
    expect(next.edgeTokens?.[tEdgeId!]).toBeUndefined(); // 財宝は盤から除去
    // 道コスト2を引いた後、財宝で資源2枚 か 発展カード1枚を得る（どちらか）。
    const gainedRes = total(next.players.player1!.hand) - (handBefore - 2);
    const gainedDev = next.players.player1!.devCards.length - devBefore;
    expect(gainedRes > 0 || gainedDev > 0).toBe(true);
  });
});
