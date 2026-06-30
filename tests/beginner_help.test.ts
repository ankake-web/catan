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

  // バグ回帰: 船UI判定が「海タイルの有無」依存だったため、霧/周縁が sea のオアシス（noShips・
  //   船0）でも船コスト・海と船セクションが誤表示されていた。判定を !noShips に変えた。
  it('オアシス（船なし）では海と船セクション・船コストを出さない', () => {
    const s = state('oasis');
    expect(s.noShips).toBe(true); // 両UIが依拠する判定シグナル
    openBeginnerHelp(s);
    const text = document.querySelector('.beginner-help-overlay')!.textContent || '';
    expect(text).toContain('このゲーム「オアシス」のルール'); // 固有ルールは出る
    expect(text).not.toContain('海と船（航海者の共通ルール）');  // ← バグ時は出てしまう
    expect(text).not.toContain('船：木1＋羊1');                 // 船コスト行も出さない
  });

  it('このゲーム固有のルールセクションを出す（シナリオごとに分かれる）', () => {
    openBeginnerHelp(state('seafarers_newshores'));
    const t1 = document.querySelector('.beginner-help-overlay')!.textContent || '';
    expect(t1).toContain('このゲーム「航海者：新たな海岸を目指して」のルール');
    expect(t1).toContain('牧草地4/森3/畑3/山2/丘2'); // 新たな岸への固有構成
    expect(t1).toContain('海と船（航海者の共通ルール）'); // 海ありの共通セクション
    document.querySelector('.beginner-help-overlay')?.remove();

    openBeginnerHelp(state('seafarers_treasure'));
    const t2 = document.querySelector('.beginner-help-overlay')!.textContent || '';
    expect(t2).toContain('このゲーム「航海者：宝島」のルール');
    expect(t2).toContain('財宝'); // 宝島固有
    document.querySelector('.beginner-help-overlay')?.remove();

    // 海なし（classic）では海共通セクションは出ない。
    openBeginnerHelp(state('classic'));
    const t3 = document.querySelector('.beginner-help-overlay')!.textContent || '';
    expect(t3).toContain('このゲーム「基本」のルール');
    expect(t3).not.toContain('海と船（航海者の共通ルール）');
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
