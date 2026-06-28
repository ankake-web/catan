// ============================================================
// tests/board_red.test.ts — 航海者 全シナリオの赤数字(6/8)配置ルール
// ============================================================
// 公式カタンの盤面ルール: 赤数字(6/8)同士は辺で隣接させない。金タイルに赤数字を置かない。
// 航海者の手組み盤がこれらを満たすことを担保する（開始時の表向き盤面で検証）。

import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { listScenarios } from '../src/engine/scenarios';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red', type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const isRed = (n: number | null | undefined): boolean => n === 6 || n === 8;

const SEAFARERS = listScenarios().filter(s => s.category === 'seafarers').map(s => s.id);

describe('航海者 盤面ルール: 赤数字(6/8)', () => {
  for (const id of SEAFARERS) {
    it(`${id}: 6/8が辺で隣接しない・金に赤数字を置かない`, () => {
      const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), id);
      const at = (q: number, r: number) => s.tiles[`${q},${r}`];
      for (const t of Object.values(s.tiles)) {
        if (t.type === 'sea') continue;
        // 金タイルに赤数字を置かない
        if (t.type === 'gold') expect(isRed(t.number)).toBe(false);
        if (!isRed(t.number)) continue;
        // 赤数字タイルの隣接に別の赤数字タイルが無い
        for (const [dq, dr] of NB) {
          const n = at(t.coord.q + dq, t.coord.r + dr);
          if (n && n.type !== 'sea' && isRed(n.number)) {
            expect(`${id}: ${t.id}(${t.number}) <-> ${n.id}(${n.number}) が赤数字隣接`).toBe('隣接なし');
          }
        }
      }
    });
  }
});
