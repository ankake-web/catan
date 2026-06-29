// @vitest-environment jsdom
// シナリオ選択カードに「おすすめプレイヤー数」が表示されることを確認。
import { describe, it, expect } from 'vitest';
import { buildScenarioSelect } from '../src/renderer/scenarioSelect';
import { listScenarios, DEFAULT_RECOMMENDED_PLAYERS } from '../src/engine/scenarios';

describe('シナリオ選択: おすすめプレイヤー数', () => {
  it('各カードに 👥 おすすめ人数が表示され、範囲（〜）ではなく言い切る', () => {
    const el = buildScenarioSelect({ current: 'classic' });
    const players = el.querySelectorAll('.scenario-card-players');
    // 全シナリオ分のカードに人数表示がある。
    expect(players.length).toBe(listScenarios().length);
    players.forEach(p => {
      expect(p.textContent).toContain('👥');
      expect(p.textContent).toContain('人');
      expect(p.textContent).not.toContain('〜'); // 「3〜4人」のような曖昧表記は出さない
    });
  });

  it('既定は「3人」。基本/都市と騎士/海賊の島々は「4人」と言い切る', () => {
    expect(DEFAULT_RECOMMENDED_PLAYERS).toBe('3人');
    const list = listScenarios();
    const rec = (id: string) => list.find(s => s.id === id)!.recommendedPlayers;
    expect(rec('classic')).toBe('4人');
    expect(rec('cities_knights')).toBe('4人');
    expect(rec('seafarers_pirateislands')).toBe('4人');
    // 航海者の他シナリオは既定の3人。
    expect(rec('seafarers_newshores')).toBe('3人');
    expect(rec('seafarers_cloth')).toBe('3人');
  });
});
