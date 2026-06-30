// バグ回帰: C&K×航海者コンボ（ck_seafarers_*）の金タイルが死にメカだった問題。
//   game.ts ROLL_DICE は isCk で早期 return し、金処理(computeGoldPicks→GOLDフェーズ)に
//   到達しなかったため、金タイルの出目を出しても任意資源を一切もらえなかった。
//   resolveCkRollOutcome の生産後に applyGoldChoicePhase を通すよう修正した。
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { RESOURCE_TYPES } from '../src/constants';
import type { GameState, VertexId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];

const ckNewShores = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'ck_seafarers_newshores');

// 金タイルと、合計が金の出目になる固定ダイス目（CKは alchemistForcedDice で出目を強制できる）。
function goldSetup(): { g: GameState; goldId: string; goldNum: number; vid: VertexId } {
  const g = ckNewShores();
  const gold = Object.values(g.tiles).find(t => t.type === 'gold')!;
  const vid = (g.tileToVertices[gold.id] ?? [])[0]! as VertexId;
  return { g, goldId: gold.id, goldNum: gold.number!, vid };
}
function forcedDice(total: number): [number, number] {
  const d1 = Math.max(1, total - 6 > 0 ? total - 6 : Math.floor(total / 2));
  return [d1, total - d1];
}

describe('C&K×航海者: 金タイルがダイスで産出する（回帰）', () => {
  it('コンボ盤に金タイルが存在し expansion=cities_knights', () => {
    const { g, goldNum } = goldSetup();
    expect(g.expansion).toBe('cities_knights');
    expect(typeof goldNum).toBe('number'); // 金タイルが盤にある
  });

  it('金タイルの出目を振ると turnPhase=GOLD・隣接プレイヤーに pendingGoldChoice が立つ', () => {
    const { g, goldNum, vid } = goldSetup();
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'PRE_ROLL', setupSubPhase: null, currentPlayerIndex: 0,
      alchemistForcedDice: forcedDice(goldNum),
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    const next = applyAction(s, { type: 'ROLL_DICE' }, createRng(1));
    expect(next.lastDiceRoll![0] + next.lastDiceRoll![1]).toBe(goldNum);
    // ← バグ時は早期 return で TRADE_BUILD のまま・pendingGoldChoice なし＝ここで落ちる。
    expect(next.turnPhase).toBe('GOLD');
    expect(next.pendingGoldChoice).toEqual({ player1: 1 });
  });

  it('CHOOSE_GOLD で選んだ任意資源が手札に入り、解決後 TRADE_BUILD へ', () => {
    const { g, goldNum, vid } = goldSetup();
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'PRE_ROLL', setupSubPhase: null, currentPlayerIndex: 0,
      alchemistForcedDice: forcedDice(goldNum),
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'city', playerId: 'player1' } } },
    };
    const rolled = applyAction(s, { type: 'ROLL_DICE' }, createRng(1));
    expect(rolled.turnPhase).toBe('GOLD');
    expect(rolled.pendingGoldChoice).toEqual({ player1: 2 }); // 都市=2枚
    const before = RESOURCE_TYPES.reduce((sum, r) => sum + rolled.players.player1!.hand[r], 0);
    const done = applyAction(rolled, { type: 'CHOOSE_GOLD', playerId: 'player1', resources: { ore: 2 } });
    const after = RESOURCE_TYPES.reduce((sum, r) => sum + done.players.player1!.hand[r], 0);
    expect(after).toBe(before + 2);          // 任意資源2枚を獲得
    expect(done.turnPhase).toBe('TRADE_BUILD');
  });
});
