import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { beginnerHint, recommendedSetupVertices } from '../src/renderer/beginnerHints';
import { canBuildSettlement } from '../src/engine/actions';
import type { GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const base = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'classic');

const withState = (over: Partial<GameState>): GameState =>
  ({ ...base(), currentPlayerIndex: 0, playerOrder: ['player1', 'player2'], ...over });

const setHand = (s: GameState, pid: 'player1' | 'player2', hand: Partial<Record<string, number>>): GameState =>
  ({ ...s, players: { ...s.players, [pid]: { ...s.players[pid]!, hand: { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0, ...hand } } } });

describe('beginnerHint（初心者の局面ガイド）', () => {
  it('selfId 無し / GAME_OVER は null', () => {
    expect(beginnerHint(base(), null)).toBeNull();
    expect(beginnerHint(withState({ phase: 'GAME_OVER' }), 'player1')).toBeNull();
  });

  it('初期配置: 開拓地→道の案内（自分の番）', () => {
    const s = withState({ phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT' });
    expect(beginnerHint(s, 'player1')!.title).toContain('開拓地');
    const r = withState({ phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_ROAD' });
    expect(beginnerHint(r, 'player1')!.title).toContain('道');
  });

  it('他人の手番（初期配置・MAIN）は待ちの案内', () => {
    const setup = withState({ phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT', currentPlayerIndex: 1 });
    expect(beginnerHint(setup, 'player1')!.title).toContain('他のプレイヤー');
    const main = withState({ phase: 'MAIN', turnPhase: 'TRADE_BUILD', currentPlayerIndex: 1 });
    expect(beginnerHint(main, 'player1')!.title).toContain('相手の手番');
  });

  it('自分の手番: PRE_ROLL=サイコロ / ROBBER=盗賊', () => {
    expect(beginnerHint(withState({ phase: 'MAIN', turnPhase: 'PRE_ROLL' }), 'player1')!.title).toContain('サイコロ');
    expect(beginnerHint(withState({ phase: 'MAIN', turnPhase: 'ROBBER' }), 'player1')!.body).toContain('奪え');
  });

  it('TRADE_BUILD: 作れるものを示す / 資源不足なら交易を促す', () => {
    const rich = setHand(withState({ phase: 'MAIN', turnPhase: 'TRADE_BUILD' }), 'player1', { wood: 1, brick: 1, wool: 1, grain: 1 });
    const h1 = beginnerHint(rich, 'player1')!;
    expect(h1.title).toContain('建設');
    expect(h1.body).toContain('開拓地');
    const poor = setHand(withState({ phase: 'MAIN', turnPhase: 'TRADE_BUILD' }), 'player1', {});
    expect(beginnerHint(poor, 'player1')!.body).toContain('足りません');
  });

  it('TRADE_BUILD: 手札8枚以上なら7の捨て札を警告', () => {
    const big = setHand(withState({ phase: 'MAIN', turnPhase: 'TRADE_BUILD' }), 'player1', { wood: 8, ore: 1 });
    const h = beginnerHint(big, 'player1')!;
    expect(h.title).toContain('手札が多い');
    expect(h.body).toContain('7'); // 7で捨てる警告
    expect(h.body).toContain('4枚'); // 9枚→半分=4
  });

  it('DISCARD: 自分が捨てる番なら枚数を案内', () => {
    let s = withState({ phase: 'MAIN', turnPhase: 'DISCARD' });
    s = setHand(s, 'player1', { wood: 9 });
    const h = beginnerHint(s, 'player1')!;
    expect(h.title).toContain('捨て');
    expect(h.body).toContain('4枚'); // 9枚→半分切り捨て=4
  });

  it('GOLD: owed があれば資源選択を案内', () => {
    const s = withState({ phase: 'MAIN', turnPhase: 'GOLD', pendingGoldChoice: { player1: 2 } });
    expect(beginnerHint(s, 'player1')!.body).toContain('2枚');
  });
});

describe('recommendedSetupVertices（初期配置のおすすめ地点）', () => {
  it('置ける頂点の中から上位N件を返し、すべて配置可能な頂点である', () => {
    const s = base();
    const valid = Object.keys(s.vertices).filter(vid => canBuildSettlement(s, 'player1', vid));
    expect(valid.length).toBeGreaterThan(0);
    const rec = recommendedSetupVertices(s, valid, 3);
    expect(rec.size).toBeGreaterThan(0);
    expect(rec.size).toBeLessThanOrEqual(3);
    for (const vid of rec) expect(valid).toContain(vid);
  });

  it('出やすさ（pip）の高い頂点を優先する', () => {
    const s = base();
    const valid = Object.keys(s.vertices).filter(vid => canBuildSettlement(s, 'player1', vid));
    const WAYS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
    const pip = (vid: string): number => (s.vertices[vid]!.adjacentTileIds
      .reduce((sum, tid) => sum + (s.tiles[tid]?.number != null ? (WAYS[s.tiles[tid]!.number!] ?? 0) : 0), 0));
    const rec = [...recommendedSetupVertices(s, valid, 3)];
    const bestPip = Math.max(...valid.map(pip));
    // 推奨の最上位は全候補中の最大 pip と一致する。
    expect(Math.max(...rec.map(pip))).toBe(bestPip);
  });

  it('数字タイルに接しない頂点（pip=0）は推奨しない', () => {
    const s = base();
    // 全頂点を渡しても、海/砂漠のみ隣接の頂点は除外される（pip>0 のみ）。
    const rec = recommendedSetupVertices(s, Object.keys(s.vertices), 5);
    for (const vid of rec) {
      const hasNumbered = s.vertices[vid]!.adjacentTileIds.some(tid => s.tiles[tid]?.number != null);
      expect(hasNumbered).toBe(true);
    }
  });
});
