// @vitest-environment jsdom
// ============================================================
// tests/opponent_cards_ui.test.ts — 他プレイヤーの「伏せ札の枚数」表示
// ============================================================
//
// 枚数は公開情報（中身だけが秘匿）。スマホでも相手が何枚抱えているか読めないと
// 交渉も盗賊も判断できないため、パネルとミニパネルの双方に必ず出す。
// ここでは DOM に枚数チップが出ること／中身が漏れていないことを検証する。

import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { maskStateFor } from '../src/engine/mask';
import { renderUI } from '../src/renderer/ui';
import type { UIPhase } from '../src/renderer/ui';
import type { GameState, PlayerId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red', type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];

// player2 が発展カード2枚を持つ進行中の局面。
function stateWithDevCards(): GameState {
  const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1));
  return {
    ...g,
    phase: 'MAIN',
    turnPhase: 'TRADE_BUILD',
    setupSubPhase: null,
    currentPlayerIndex: 0,
    players: {
      ...g.players,
      player2: {
        ...g.players.player2!,
        devCards: [
          { id: 'k1', type: 'knight', purchasedOnTurn: 0 },
          { id: 'v1', type: 'victory_point', purchasedOnTurn: 0 },
        ],
      },
    },
  };
}

function render(state: GameState, viewer: PlayerId): HTMLDivElement {
  const container = document.createElement('div');
  // ミニパネルは #board-area へ差し込まれるため、描画先を用意しておく。
  const boardArea = document.createElement('div');
  boardArea.id = 'board-area';
  document.body.appendChild(boardArea);
  renderUI(container, state, 'idle', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {}, viewer);
  return container;
}

function panelText(root: HTMLElement, pid: string): string {
  return root.querySelector(`.player-panel[data-pid="${pid}"] .dev-card-panel`)?.textContent ?? '';
}

describe('他プレイヤーの伏せ札枚数（jsdom）', () => {
  it('相手の発展カード枚数がパネルに出る（中身は出ない）', () => {
    document.body.innerHTML = '';
    const masked = maskStateFor(stateWithDevCards(), 'player1');
    const root = render(masked, 'player1');
    const text = panelText(root, 'player2');
    expect(text).toContain('×2');       // 枚数は見える
    expect(text).not.toContain('騎士');  // 種類は見えない
    expect(text).not.toContain('★');     // VPカードの内訳も見えない
  });

  it('盤面ミニパネルにも相手の伏せ札枚数が出る（スマホ縦持ちで常時見える）', () => {
    document.body.innerHTML = '';
    const masked = maskStateFor(stateWithDevCards(), 'player1');
    render(masked, 'player1');
    const mini = document.querySelector('#board-area .mini-panel[data-pid="player2"]');
    expect(mini?.textContent ?? '').toContain('🃏2');
  });

  it('自分のパネルは従来どおり種類つきで表示される', () => {
    document.body.innerHTML = '';
    const s = stateWithDevCards();
    const masked = maskStateFor(s, 'player2'); // player2 視点＝自分の札は素のまま
    const root = render(masked, 'player2');
    expect(panelText(root, 'player2')).toContain('騎士');
  });
});
