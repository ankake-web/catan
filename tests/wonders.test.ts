import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { canBuildWonder, buildWonder, bestWonderAction, ownedWonder, WONDER_MAX_LEVEL } from '../src/engine/wonders';
import { checkVictory } from '../src/engine/scoring';
import { isLandVertex } from '../src/engine/board';
import { makeHand } from '../src/constants';
import type { GameState, VertexId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const wonders = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_wonders');

// 本島の陸頂点を2つ取り、player1 の都市にした MAIN 状態（不思議の資源付き）を作る。
function withTwoCities(g: GameState): { s: GameState; cities: VertexId[] } {
  const land = Object.keys(g.vertices).filter(v => isLandVertex(g.vertices[v]!, g.tiles));
  const cities = [land[0]!, land[Math.floor(land.length / 2)]!];
  const verts = { ...g.vertices };
  for (const v of cities) verts[v] = { ...g.vertices[v]!, building: { type: 'city', playerId: 'player1' } };
  const s: GameState = {
    ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
    vertices: verts,
    players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ ore: 2, grain: 2, wool: 1 }) } },
  };
  return { s, cities };
}

describe('S8 カタンの七不思議', () => {
  it('開始時に不思議の状態が初期化される（クレーム0・レベル0）', () => {
    const g = wonders();
    expect(g.wonderOwner).toEqual({});
    expect(g.wonderLevel).toEqual({});
    expect(g.victoryTarget).toBe(10);
  });

  it('要件未達/資源不足では不思議を建設できない', () => {
    const g = wonders();
    // 初期状態（都市0・資源0）ではピラミッド(要件:2都市)を建設できない。
    expect(canBuildWonder(g, 'player1', 'pyramid')).toBe(false);
  });

  it('2都市＋資源があればクレームしてレベル1を建設（資源消費）', () => {
    const { s } = withTwoCities(wonders());
    expect(canBuildWonder(s, 'player1', 'pyramid')).toBe(true);
    const next = applyAction(s, { type: 'BUILD_WONDER', wonderId: 'pyramid' });
    expect(next.wonderOwner!.pyramid).toBe('player1');
    expect(next.wonderLevel!.player1).toBe(1);
    expect(ownedWonder(next, 'player1')).toBe('pyramid');
    expect(next.players.player1!.hand).toEqual(makeHand()); // ore2+grain2+wool1 を消費
    // 既にクレーム済みなので別の不思議は建てられない
    expect(canBuildWonder({ ...next, players: { ...next.players, player1: { ...next.players.player1!, hand: makeHand({ ore: 2, grain: 2, wool: 1 }) } } }, 'player1', 'colossus')).toBe(false);
  });

  it('レベル4で完成＝勝利', () => {
    const g = wonders();
    const s: GameState = { ...g, wonderOwner: { pyramid: 'player1' }, wonderLevel: { player1: 3 },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ ore: 2, grain: 2, wool: 1 }) } } };
    const next = buildWonder(s, 'player1', 'pyramid');
    expect(next.wonderLevel!.player1).toBe(WONDER_MAX_LEVEL);
    const won = checkVictory(next, 'player1');
    expect(won.phase).toBe('GAME_OVER');
    expect(won.winner).toBe('player1');
  });

  it('10点以上でも、単独最高レベルでなければ勝てない（同レベルは不可）', () => {
    const g = wonders();
    // tokenVp で 10VP を付与（calcVP に算入）。
    const base: GameState = { ...g, tokenVp: { player1: 10 } };
    // player1 と player2 が同じレベル1 → 単独最高でないので勝てない。
    const tie: GameState = { ...base, wonderLevel: { player1: 1, player2: 1 } };
    expect(checkVictory(tie, 'player1').phase).not.toBe('GAME_OVER');
    // player1 だけレベル1（他0）→ 10VP＋単独最高で勝利。
    const lead: GameState = { ...base, wonderLevel: { player1: 1, player2: 0 } };
    expect(checkVictory(lead, 'player1').winner).toBe('player1');
  });

  it('bestWonderAction: 要件を満たすと建設アクションを返す', () => {
    const { s } = withTwoCities(wonders());
    const a = bestWonderAction(s, 'player1');
    expect(a?.type).toBe('BUILD_WONDER');
  });
});
