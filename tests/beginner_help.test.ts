// @vitest-environment jsdom
// 「🔰 遊び方」ヘルプ overlay が主要セクション（用語集を含む）を表示することを確認。
import { describe, it, expect, afterEach } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { openBeginnerHelp } from '../src/renderer/beginnerHelp';
import type { ScenarioId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const state = (sc: ScenarioId) =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), sc);

afterEach(() => { document.querySelector('.beginner-help-overlay')?.remove(); });

describe('openBeginnerHelp（遊び方ヘルプ）', () => {
  it('主要セクションと用語集を表示する', () => {
    openBeginnerHelp(state('classic'));
    const ov = document.querySelector('.beginner-help-overlay');
    expect(ov).not.toBeNull();
    const text = (ov as HTMLElement).innerText || ov!.textContent || '';
    expect(text).toContain('ゴール');
    expect(text).toContain('手番の流れ');
    expect(text).toContain('建設コスト');
    expect(text).toContain('よく出る用語');
    expect(text).toContain('最長交易路'); // 用語が含まれる
    expect(text).toContain('盗賊');
  });

  it('海ありシナリオでは船・金タイルの用語/コストも出る', () => {
    openBeginnerHelp(state('seafarers_newshores'));
    const text = document.querySelector('.beginner-help-overlay')!.textContent || '';
    expect(text).toContain('船');
    expect(text).toContain('金タイル');
  });

  it('多重に開いても overlay は1つ', () => {
    openBeginnerHelp(state('classic'));
    openBeginnerHelp(state('classic'));
    expect(document.querySelectorAll('.beginner-help-overlay').length).toBe(1);
  });

  it('「閉じる」で overlay が消える', () => {
    openBeginnerHelp(state('classic'));
    const close = document.querySelector('.beginner-help-overlay .gallery-close') as HTMLButtonElement;
    close.click();
    expect(document.querySelector('.beginner-help-overlay')).toBeNull();
  });
});
