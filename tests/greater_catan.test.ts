// 航海者「大カタン」の新メカ: 抜けている数値トークン（到達で出現）と 都市制限8。
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { revealPendingNumbers, hasPendingNumbers } from '../src/engine/explore';
import { canBuildCity, canBuildSettlement } from '../src/engine/actions';
import { calcVP } from '../src/engine/scoring';
import { applyAction } from '../src/engine/game';
import { edgeTileIds, isSeaEdge } from '../src/engine/board';
import { makeHand } from '../src/constants';
import type { GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const greater = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_greatercatan');
const throughDesert = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_throughdesert');

describe('大カタン: 抜けている数値トークン', () => {
  it('開始時、小島タイルは pendingNumber を持ち number は null（産出しない）', () => {
    const s = greater();
    expect(hasPendingNumbers(s)).toBe(true);
    const pending = Object.values(s.tiles).filter(t => t.pendingNumber != null);
    expect(pending.length).toBe(10); // 小島5つ×2タイル
    for (const t of pending) expect(t.number).toBeNull();
  });

  it('revealPendingNumbers: 到達したタイルだけ数字が出現し、以後は通常の数字タイルになる', () => {
    const s = greater();
    const target = Object.values(s.tiles).find(t => t.pendingNumber != null)!;
    const hidden = target.pendingNumber!;
    const next = revealPendingNumbers(s, [target.id]);
    const revealed = next.tiles[target.id]!;
    expect(revealed.number).toBe(hidden);
    expect(revealed.pendingNumber).toBeUndefined();
    // 他の小島は手つかず（指定タイルのみ公開）。
    const stillPending = Object.values(next.tiles).filter(t => t.pendingNumber != null);
    expect(stillPending.length).toBe(9);
  });

  it('該当タイルが無ければ参照不変（no-op）', () => {
    const s = greater();
    const mainNumbered = Object.values(s.tiles).find(t => t.type !== 'sea' && t.number != null)!;
    expect(revealPendingNumbers(s, [mainNumbered.id])).toBe(s);
  });

  it('供給は5枚から始まり、出現するたびに1減る', () => {
    const s = greater();
    expect(s.numberTokenSupply).toBe(5);
    const first = Object.values(s.tiles).find(t => t.pendingNumber != null)!;
    const next = revealPendingNumbers(s, [first.id]);
    expect(next.numberTokenSupply).toBe(4);
  });

  it('供給が尽きると本島の数字を1枚抜いて小島へ移す（本島タイルは産出停止）', () => {
    const base = greater();
    const s: GameState = { ...base, numberTokenSupply: 0 };
    const island = Object.values(s.tiles).find(t => t.pendingNumber != null)!;
    const next = revealPendingNumbers(s, [island.id]);
    // 小島には数字が出現。
    expect(next.tiles[island.id]!.number).not.toBeNull();
    expect(next.tiles[island.id]!.pendingNumber).toBeUndefined();
    // ちょうど1枚の本島タイルが「抜かれた」＝ number=null かつ numberRemoved（産出停止）。
    const removed = Object.values(next.tiles).filter(t => t.numberRemoved);
    expect(removed.length).toBe(1);
    expect(removed[0]!.number).toBeNull();
    expect(removed[0]!.type).not.toBe('sea');
    // 抜かれた数字が小島の数字として現れている（保存）。
    expect(base.tiles[removed[0]!.id]!.number).toBe(next.tiles[island.id]!.number);
  });

  // テストの穴埋め: 複数タイルの同時公開と、供給境界（残り＜同時公開数）またぎが未検証だった。
  it('複数の小島タイルを同時公開すると全て数字が出て供給がその分だけ減る', () => {
    const s = greater(); // 供給5
    const pend = Object.values(s.tiles).filter(t => t.pendingNumber != null).slice(0, 3);
    const next = revealPendingNumbers(s, pend.map(t => t.id));
    for (const t of pend) {
      expect(next.tiles[t.id]!.number).toBe(t.pendingNumber);
      expect(next.tiles[t.id]!.pendingNumber).toBeUndefined();
    }
    expect(next.numberTokenSupply).toBe(2); // 5 - 3
    expect(Object.values(next.tiles).some(t => t.numberRemoved)).toBe(false); // 供給内なので本島は抜かれない
  });

  it('供給境界をまたぐ同時公開: 供給内は供給から・超過分だけ本島から抜いて配る', () => {
    const base = greater();
    const s: GameState = { ...base, numberTokenSupply: 1 }; // 残り1枚だけ
    const pend = Object.values(s.tiles).filter(t => t.pendingNumber != null).slice(0, 2);
    const next = revealPendingNumbers(s, pend.map(t => t.id));
    for (const t of pend) { // 2島とも数字が出る
      expect(next.tiles[t.id]!.number).not.toBeNull();
      expect(next.tiles[t.id]!.pendingNumber).toBeUndefined();
    }
    expect(next.numberTokenSupply).toBe(0);
    // 供給を超えた1枚分だけ本島タイルが抜かれる（ちょうど1枚）。
    const removed = Object.values(next.tiles).filter(t => t.numberRemoved);
    expect(removed.length).toBe(1);
    expect(removed[0]!.number).toBeNull();
  });

  it('船で小島タイルの端に到達すると、その小島の数字が出現する（エンドツーエンド）', () => {
    const g = greater();
    // 小島タイルに面する空きの海辺 E を選び、その片端に player1 の建物を置いて接続を満たす。
    const island = Object.values(g.tiles).find(t => t.pendingNumber != null)!;
    const E = Object.values(g.edges).find(e =>
      edgeTileIds(e, g.vertices).includes(island.id) && isSeaEdge(e, g.vertices, g.tiles)
      && e.ship == null && e.road == null)!;
    const v = E.vertexIds[0]!;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 1, wool: 1 }) } },
    };
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: E.id });
    expect(next.tiles[island.id]!.number).not.toBeNull();        // 数字が出現
    expect(next.tiles[island.id]!.pendingNumber).toBeUndefined();
  });
});

describe('大カタン: 都市制限8', () => {
  it('createInitialGameState: 大カタンは都市8コマを用意する（既定4・回帰）', () => {
    // バグ: remainingCities を全シナリオ4にハードコードしていたため、maxCities=8 でも
    //   コマ(remainingCities)が先に0になり5個目以降を建てられず「都市8まで」が死にルールだった。
    for (const id of ['seafarers_greatercatan', 'ck_seafarers_greatercatan'] as const) {
      const s = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), id);
      expect(s.maxCities).toBe(8);
      for (const pid of s.playerOrder) expect(s.players[pid]!.remainingCities).toBe(8);
    }
    // 上限を上げないシナリオは既定どおり4コマ。
    const classic = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'classic');
    for (const pid of classic.playerOrder) expect(classic.players[pid]!.remainingCities).toBe(4);
  });

  it('都市が8つ未満なら昇格でき、8つに達したら不可', () => {
    const g = greater();
    // player1 の開拓地を1つ用意し、都市資源を持たせる。
    const settV = Object.values(g.vertices).find(v =>
      v.adjacentTileIds.some(t => { const ty = g.tiles[t]?.type; return ty != null && ty !== 'sea'; }))!.id;
    const base: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0,
      vertices: { ...g.vertices, [settV]: { ...g.vertices[settV]!, building: { type: 'settlement', playerId: 'player1' } } },
      // remainingCities は上書きしない＝createInitialGameState が大カタンで8コマを用意することに依存。
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ grain: 2, ore: 3 }) } },
    };
    expect(base.maxCities).toBe(8);
    expect(base.players.player1!.remainingCities).toBe(8);
    expect(canBuildCity(base, 'player1', settV)).toBe(true);
    // すでに8都市保有なら、たとえコマが残っていても昇格不可。
    const verts = { ...base.vertices };
    const ids = Object.keys(verts).slice(0, 8);
    for (const id of ids) verts[id] = { ...verts[id]!, building: { type: 'city', playerId: 'player1' } };
    // 昇格対象の settV は開拓地のまま別頂点にしておく。
    const sv = Object.keys(verts).find(id => verts[id]!.building == null
      && g.vertices[id]!.adjacentTileIds.some(t => { const ty = g.tiles[t]?.type; return ty != null && ty !== 'sea'; }))!;
    verts[sv] = { ...verts[sv]!, building: { type: 'settlement', playerId: 'player1' } };
    const full: GameState = { ...base, vertices: verts };
    expect(canBuildCity(full, 'player1', sv)).toBe(false); // 都市8で打ち止め
  });
});

describe('砂漠を越えて: 北西地方の地域ボーナス(+2VP)', () => {
  it('北西地方タイルに隣接して初入植すると regionBonus が付き、VPが+2される', () => {
    const g = throughDesert();
    expect(g.regionBonusVp).toBe(2);
    // 北西地方タイルに隣接する頂点を1つ選び、接続のため隣接辺に player1 の道を置く。
    const regionTile = g.bonusRegionTiles![0]!;
    const v = Object.values(g.vertices).find(vx => vx.adjacentTileIds.includes(regionTile))!.id;
    const e = g.vertices[v]!.adjacentEdgeIds[0]!;
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      edges: { ...g.edges, [e]: { ...g.edges[e]!, road: { playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: makeHand({ wood: 1, brick: 1, wool: 1, grain: 1 }) } },
    };
    const vpBefore = calcVP(s, 'player1');
    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.regionBonus).toContain('player1');
    // 開拓地1点 + 地域ボーナス2点 = +3。
    expect(calcVP(next, 'player1')).toBe(vpBefore + 1 + 2);
  });

  // バグ回帰: 地域ボーナス付与が MAIN 限定だったため、北西地方（砂漠帯で本島と陸続き）に
  //   SETUP で初期配置した人はボーナスを取り逃していた。付与を phase 非依存にした。
  it('SETUP で北西地方に初期配置しても地域ボーナス(+2VP)が付く（回帰）', () => {
    const g = throughDesert();
    const regionTile = g.bonusRegionTiles![0]!;
    const base: GameState = {
      ...g, phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT', currentPlayerIndex: 0,
    };
    // 北西地方タイルに隣接し、初期配置できる頂点を選ぶ。
    const v = Object.keys(base.vertices).find(vid =>
      base.vertices[vid]!.adjacentTileIds.includes(regionTile) && canBuildSettlement(base, 'player1', vid))!;
    expect(v).toBeTruthy();
    const vpBefore = calcVP(base, 'player1');
    const next = applyAction(base, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.regionBonus).toContain('player1');       // ← バグ時は SETUP で付与されず落ちる
    expect(calcVP(next, 'player1')).toBe(vpBefore + 1 + 2); // 開拓地1点 + 地域ボーナス2点
  });

  it('地域ボーナスは各プレイヤー1回まで（2軒目の北西入植では重複加点しない）', () => {
    // 旧テストは同一 state を2つ作って比較するトートロジーだった。実際に「獲得済みの状態で
    // もう1軒 北西に置く」経路を通し、regionBonus が重複せず VP も再加算されないことを検証。
    const g = throughDesert();
    const regionTile = g.bonusRegionTiles![0]!;
    const base: GameState = {
      ...g, phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT', currentPlayerIndex: 0,
      regionBonus: ['player1'], // すでに1回獲得済み
    };
    const v = Object.keys(base.vertices).find(vid =>
      base.vertices[vid]!.adjacentTileIds.includes(regionTile) && canBuildSettlement(base, 'player1', vid))!;
    expect(v).toBeTruthy();
    const vpBefore = calcVP(base, 'player1');
    const next = applyAction(base, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.regionBonus).toEqual(['player1']);      // 重複追加されない（各自1回）
    expect(calcVP(next, 'player1')).toBe(vpBefore + 1);  // 開拓地1点のみ（+2は再加算されない）
  });
});
