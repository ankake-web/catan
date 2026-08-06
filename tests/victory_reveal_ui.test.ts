// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { renderUI } from '../src/renderer/ui';
import type { UIPhase } from '../src/renderer/ui';
import type { GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];

// GAME_OVER 状態。player2(CPU)は開拓地1つ（公開VP=1）＋隠しVPカード1枚（内部VP=2）を持つ。
function gameOverState(winner: 'player1' | 'player2'): GameState {
  const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1));
  const vid = Object.keys(g.vertices)[0]!;
  return {
    ...g,
    phase: 'GAME_OVER',
    winner,
    turnPhase: 'TRADE_BUILD',
    setupSubPhase: null,
    currentPlayerIndex: winner === 'player1' ? 0 : 1,
    vertices: {
      ...g.vertices,
      [vid]: { ...g.vertices[vid]!, building: { type: 'settlement', playerId: 'player2' } },
    },
    players: {
      ...g.players,
      player2: {
        ...g.players.player2!,
        devCards: [{ id: 'vp1', type: 'victory_point', purchasedOnTurn: 0 }],
      },
    },
  };
}

function vpTextFor(root: HTMLElement, pid: string): string | undefined {
  const panel = root.querySelector(`.player-panel[data-pid="${pid}"] .panel-vp`);
  return panel?.textContent ?? undefined;
}

describe('ゲーム終了時のVP表示（jsdom）', () => {
  it('自分(player1)が勝者のとき、CPU(player2)の隠しVPカードも合算して表示する', () => {
    const container = document.createElement('div');
    renderUI(container, gameOverState('player1'), 'idle', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {}, 'player1' as any);
    // player2: 開拓地1(公開1点) + 隠しVPカード1枚 = 内部VP 2点。修正前は公開VPの1点のみだった。
    expect(vpTextFor(container, 'player2')).toBe('★2');
  });

  it('CPU(player2)が勝者のとき、自分(player1)の視点でも player2 の隠しVPカードが合算される', () => {
    const container = document.createElement('div');
    renderUI(container, gameOverState('player2'), 'idle', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {}, 'player1' as any);
    expect(vpTextFor(container, 'player2')).toBe('★2');
  });

  it('ゲーム中（GAME_OVER以前）は相手のVPカードは非公開のまま公開VPのみ表示する', () => {
    const container = document.createElement('div');
    const mid = { ...gameOverState('player1'), phase: 'MAIN' as const, winner: null, diceRolledThisTurn: true };
    renderUI(container, mid, 'idle', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {}, 'player1' as any);
    // まだゲーム中なので player2 の隠しVPカードは数えない（公開VP=開拓地1点のみ）。
    expect(vpTextFor(container, 'player2')).toBe('★1');
  });
});
