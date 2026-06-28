// @vitest-environment jsdom
// シナリオ選択カードに「おすすめプレイヤー数」が表示されることを確認。
import { describe, it, expect } from 'vitest';
import { buildScenarioSelect } from '../src/renderer/scenarioSelect';
import { listScenarios, DEFAULT_RECOMMENDED_PLAYERS } from '../src/engine/scenarios';

describe('シナリオ選択: おすすめプレイヤー数', () => {
  it('各カードに 👥 おすすめ人数が表示される', () => {
    const el = buildScenarioSelect({ current: 'classic' });
    const players = el.querySelectorAll('.scenario-card-players');
    // 全シナリオ分のカードに人数表示がある。
    expect(players.length).toBe(listScenarios().length);
    players.forEach(p => {
      expect(p.textContent).toContain('👥');
      expect(p.textContent).toContain('人');
    });
  });

  it('未指定シナリオは既定（3〜4人）を表示する', () => {
    const el = buildScenarioSelect({ current: 'classic' });
    const first = el.querySelector('.scenario-card-players');
    expect(first!.textContent).toContain(DEFAULT_RECOMMENDED_PLAYERS);
  });
});
