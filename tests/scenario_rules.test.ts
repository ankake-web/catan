// ============================================================
// tests/scenario_rules.test.ts — シナリオ別ルールトグルのエンジン挙動
// ============================================================
// 航海者 S7 海賊の島々 等で使う useRobber / useLargestArmy / useLongestRoute の
// エンジン側消費を直接検証する（シナリオ盤に依存しない単体テスト）。
// ※ S7 シナリオ自体での有効化は盤・軍船整備後（docs/AUDIT_SEAFARERS.md [D2] 参照）。

import { describe, it, expect } from 'vitest';
import { makeGameState, makePlayer } from './helpers';
import { applyAction } from '../src/engine/game';
import { updateLargestArmy } from '../src/engine/scoring';
import type { GameState } from '../src/types';

// 指定した戻り値を順に返し、尽きたら0を返す決定論RNG。
function rngSeq(...vals: number[]): () => number {
  let i = 0;
  return () => (i < vals.length ? vals[i++]! : 0);
}
// rollDice = [floor(rng*6)+1, floor(rng*6)+1]。0.4→3, 0.6→4 ⇒ 合計7。
const SEVEN_RNG = () => rngSeq(0.4, 0.6);

describe('useRobber=false（S7 盗賊不使用）', () => {
  function preRoll(useRobber: boolean | undefined): GameState {
    return makeGameState({
      phase: 'MAIN',
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      currentPlayerIndex: 0,
      ...(useRobber != null ? { useRobber } : {}),
    });
  }

  it('7を出しても盗賊フェーズに入らず TRADE_BUILD へ（手札8未満で捨て無し）', () => {
    const s = preRoll(false);
    const next = applyAction(s, { type: 'ROLL_DICE' }, SEVEN_RNG());
    expect(next.lastDiceRoll).toEqual([3, 4]);
    expect(next.turnPhase).toBe('TRADE_BUILD');
  });

  it('（非回帰）useRobber 既定では7で ROBBER フェーズへ', () => {
    const s = preRoll(undefined);
    const next = applyAction(s, { type: 'ROLL_DICE' }, SEVEN_RNG());
    expect(next.lastDiceRoll).toEqual([3, 4]);
    expect(next.turnPhase).toBe('ROBBER');
  });

  it('騎士カードは使用不可（PLAY_KNIGHT が例外）', () => {
    const s = makeGameState({
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', diceRolledThisTurn: true, useRobber: false,
      players: {
        player1: makePlayer('player1', { devCards: [{ id: 'k1', type: 'knight', purchasedOnTurn: 0 }] }),
        player2: makePlayer('player2'),
      },
    });
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow();
  });
});

describe('useLargestArmy=false（S7 最大騎士力不使用）', () => {
  it('騎士3枚以上でも保持者は付かない（holder=null・hasLargestArmy=false）', () => {
    const s = makeGameState({
      useLargestArmy: false,
      players: {
        player1: makePlayer('player1', { knightsPlayed: 3 }),
        player2: makePlayer('player2', { knightsPlayed: 1 }),
      },
    });
    const next = updateLargestArmy(s);
    expect(next.largestArmyHolder).toBeNull();
    expect(next.players.player1!.hasLargestArmy).toBe(false);
  });

  it('（非回帰）既定では騎士3枚で最大騎士力を獲得', () => {
    const s = makeGameState({
      players: {
        player1: makePlayer('player1', { knightsPlayed: 3 }),
        player2: makePlayer('player2', { knightsPlayed: 1 }),
      },
    });
    const next = updateLargestArmy(s);
    expect(next.largestArmyHolder).toBe('player1');
    expect(next.players.player1!.hasLargestArmy).toBe(true);
  });
});
