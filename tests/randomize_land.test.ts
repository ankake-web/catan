// engine/scenarios.ts の陸マップランダム化（制約リトライ＋フォールバック）検証。
import { describe, it, expect } from 'vitest';
import { randomizeLandMap } from '../src/engine/scenarios';
import { createRng } from '../src/engine/setup';

type LandMap = Parameters<typeof randomizeLandMap>[0];
const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;
const isRed = (n: number | null | undefined): boolean => n === 6 || n === 8;

describe('randomizeLandMap: 制約リトライとフォールバック', () => {
  it('実現可能な盤では赤6/8を辺で隣接させない配置を選ぶ', () => {
    const feasible: LandMap = {
      '0,0':  { type: 'forest',   number: 6 },
      '1,0':  { type: 'field',    number: 5 },
      '0,1':  { type: 'hill',     number: 9 },
      '-1,1': { type: 'mountain', number: 8 },
    };
    const m = randomizeLandMap(feasible, createRng(3));
    for (const [c, cell] of Object.entries(m)) {
      if (!isRed(cell.number)) continue;
      const [q, r] = c.split(',').map(Number) as [number, number];
      for (const [dq, dr] of NB) expect(isRed(m[`${q + dq},${r + dr}`]?.number)).toBe(false);
    }
  });

  // バグ回帰: 制約充足不能なとき、旧フォールバックは入力の静的マップ（赤6/8隣接を含みうる）を
  //   そのまま返し、コメントは「制約充足済みの正」と虚偽だった。best-effort の新盤を返すよう修正。
  it('制約充足不能な盤でもフォールバックは構造的に妥当な新盤を返す（到達不能パスの防御）', () => {
    // 3タイルが相互隣接で全て赤6 → どう並べても赤が隣接＝制約充足不能（400回失敗）。
    const infeasible: LandMap = {
      '0,0': { type: 'forest', number: 6 },
      '1,0': { type: 'forest', number: 6 },
      '0,1': { type: 'forest', number: 6 },
    };
    const m = randomizeLandMap(infeasible, createRng(1));
    expect(m).not.toBe(infeasible);                         // ← 入力の静的マップをそのまま返さない
    expect(Object.keys(m).sort()).toEqual(['0,0', '0,1', '1,0']); // 全セル存在（undefined を返さない）
    for (const c of Object.keys(m)) {                       // 種別・数字は保存
      expect(m[c]!.type).toBe('forest');
      expect(m[c]!.number).toBe(6);
    }
  });
});
