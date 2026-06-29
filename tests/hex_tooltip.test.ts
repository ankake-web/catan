import { describe, it, expect } from 'vitest';
import { hexTooltipLines } from '../src/renderer/hexTooltip';
import type { Tile } from '../src/types';

const tile = (over: Partial<Tile>): Tile =>
  ({ id: 't', type: 'forest', coord: { q: 0, r: 0 }, ...over } as Tile);

describe('hexTooltipLines（ヘックスのホバー説明）', () => {
  it('資源タイルは地形名・産出資源・数字の出やすさを示す', () => {
    const lines = hexTooltipLines(tile({ type: 'forest', number: 8 }));
    expect(lines[0]).toBe('森');
    expect(lines.some(l => l.includes('木材'))).toBe(true);
    const numLine = lines.find(l => l.startsWith('数字 8'))!;
    expect(numLine).toContain('とても出やすい');
    expect(numLine).toContain('●●●●●'); // 8 は5通り
    expect(numLine).toContain('⚠');     // 6/8 は警告マーク
  });

  it('鉱石/麦など各地形が正しい資源を出す', () => {
    expect(hexTooltipLines(tile({ type: 'mountain', number: 5 })).some(l => l.includes('鉄鉱'))).toBe(true);
    expect(hexTooltipLines(tile({ type: 'field', number: 9 })).some(l => l.includes('麦'))).toBe(true);
    expect(hexTooltipLines(tile({ type: 'hill', number: 4 })).some(l => l.includes('レンガ'))).toBe(true);
    expect(hexTooltipLines(tile({ type: 'pasture', number: 11 })).some(l => l.includes('羊毛'))).toBe(true);
  });

  it('砂漠・海・金タイルは専用表記（産出資源は出さない）', () => {
    expect(hexTooltipLines(tile({ type: 'desert' }))[0]).toContain('砂漠');
    expect(hexTooltipLines(tile({ type: 'desert' })).some(l => l.includes('出ない'))).toBe(true);
    expect(hexTooltipLines(tile({ type: 'sea' }))[0]).toContain('海');
    expect(hexTooltipLines(tile({ type: 'gold', number: 4 }))[0]).toContain('金');
    expect(hexTooltipLines(tile({ type: 'gold', number: 4 })).some(l => l.includes('好きな資源'))).toBe(true);
  });

  it('盗賊がいると注意書きが付く', () => {
    expect(hexTooltipLines(tile({ type: 'forest', number: 6, hasRobber: true })).some(l => l.includes('盗賊'))).toBe(true);
  });

  it('霧（未探検）は数字を見せない', () => {
    const lines = hexTooltipLines(tile({ type: 'sea', fog: true, number: 8 }));
    expect(lines[0]).toContain('霧');
    expect(lines.some(l => l.startsWith('数字'))).toBe(false);
  });

  it('村は織物の案内を出す', () => {
    const lines = hexTooltipLines(tile({ type: 'field', number: 5 }), { isVillage: true });
    expect(lines[0]).toContain('村');
    expect(lines.some(l => l.includes('織物'))).toBe(true);
  });
});
