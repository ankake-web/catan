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

// 航海者盤・自分の手番・ダイス後（TRADE_BUILD）の状態。
function seafarersBuildState(over: Partial<GameState> = {}): GameState {
  const g = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_newshores');
  return { ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true, ...over };
}

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')] as HTMLButtonElement[];
}
function findByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return buttons(root).find(b => (b.textContent ?? '').includes(text));
}
// 建設ボタンは costLabel で span.btn-name（名前）＋コストアイコンを持つ。名前一致で建設ボタンを特定。
function findBuildBtn(root: HTMLElement, name: string): HTMLButtonElement | undefined {
  return buttons(root).find(b => [...b.querySelectorAll('.btn-name')].some(s => s.textContent === name));
}

describe('船の建設ボタン（航海者・jsdom）', () => {
  it('船ボタンに必要素材（木・羊）のコストアイコンが表示される', () => {
    const container = document.createElement('div');
    renderUI(container, seafarersBuildState(), 'idle', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {});
    const shipBtn = findBuildBtn(container, '船');
    expect(shipBtn, '「船」建設ボタンが存在する').toBeTruthy();
    // 木＋羊の2種ぶんのコストアイコンが入っている（従来はテキストのみでコスト非表示だった）。
    expect(shipBtn!.querySelectorAll('img.cost-ic').length).toBe(2);
  });

  it('街道建設カード使用中は道と船どちらのボタンも出る（海のある盤）', () => {
    const container = document.createElement('div');
    renderUI(container, seafarersBuildState({ roadBuildingRoadsRemaining: 2 }), 'road', () => {}, { type: 'idle' } as UIPhase, () => {}, () => {});
    expect(findByText(container, '道を置く'), '道を置くボタン').toBeTruthy();
    expect(findByText(container, '船を置く'), '船を置くボタン').toBeTruthy();
  });
});
