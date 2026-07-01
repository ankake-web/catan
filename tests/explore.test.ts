// engine/explore.ts のヘルパ検証。
import { describe, it, expect } from 'vitest';
import { mainIslandTileIds } from '../src/engine/explore';
import type { GameState, Tile } from '../src/types';

function tile(q: number, r: number): Tile {
  return { id: `${q},${r}`, coord: { q, r }, type: 'forest', number: 5, hasRobber: false } as Tile;
}
function stateWith(tiles: Tile[]): GameState {
  return { tiles: Object.fromEntries(tiles.map(t => [t.id, t])) } as unknown as GameState;
}

// バグ回帰: 同サイズの最大成分が複数あるとき、mainIslandTileIds はタイブレークが無く
//   tiles の列挙順で本島が変わりえた（大カタンの供給枯渇で本島から数字を抜く先が非決定に）。
describe('mainIslandTileIds: 最大成分のタイブレーク', () => {
  it('同サイズ最大成分が複数でも、列挙順に依らず最小IDの成分を本島に選ぶ（決定論）', () => {
    const A = [tile(0, 0), tile(1, 0)];      // 2タイルの島A（min id "0,0"）
    const B = [tile(10, 10), tile(11, 10)];  // 2タイルの島B（Aから遠い・min id "10,10"）
    // B を先に列挙しても、タイブレーク（最小ID）で A が本島。
    expect(mainIslandTileIds(stateWith([...B, ...A]))).toEqual(new Set(['0,0', '1,0']));
    // 列挙順を入れ替えても結果は不変（決定論）。
    expect(mainIslandTileIds(stateWith([...A, ...B]))).toEqual(new Set(['0,0', '1,0']));
  });

  it('唯一の最大成分はそのまま本島（小島は含めない）', () => {
    const main = [tile(0, 0), tile(1, 0), tile(0, 1)]; // 3タイル本島
    const islet = [tile(20, 0)];                       // 1タイル小島
    expect(mainIslandTileIds(stateWith([...main, ...islet]))).toEqual(new Set(['0,0', '1,0', '0,1']));
  });
});
