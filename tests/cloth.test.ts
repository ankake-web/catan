import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { chooseAction } from '../src/engine/ai';
import { connectVillagesAround, produceCloth, checkClothEnd, clothVp } from '../src/engine/cloth';
import { calcVP } from '../src/engine/scoring';
import { canBuildSettlement, isVillageLockedShip, isShipMovable } from '../src/engine/actions';
import { isLandVertex } from '../src/engine/board';
import type { GameState } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];
const cloth = (): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(1), 'seafarers_cloth');

describe('S6 カタンの織物', () => {
  it('開始時に村が8つ・各供給5・最長交易路は無効', () => {
    const s = cloth();
    expect(Object.keys(s.villages ?? {})).toHaveLength(8); // 公式コンポ: 村8
    for (const v of Object.values(s.villages ?? {})) expect(v).toBe(5);
    expect(s.useLongestRoute).toBe(false);
    expect(s.noIslandSettlement).toBe(true);
  });

  it('村への航路接続で織物を即1枚得る（供給が1減る）', () => {
    const s = cloth();
    const villageId = Object.keys(s.villages!)[0]!;
    const e = s.tileToEdges[villageId]![0]!; // 村に面する辺
    const next = connectVillagesAround(s, e, 'player1');
    expect(next.villageConn![villageId]).toContain('player1');
    expect(next.cloth!.player1).toBe(1);
    expect(next.villages![villageId]).toBe(4);
    // 同じ辺で再接続しても増えない（接続済み村はスキップ）
    const again = connectVillagesAround(next, e, 'player1');
    expect(again.cloth!.player1).toBe(1);
  });

  it('織物2枚で1VP（端数は0）', () => {
    const s = cloth();
    expect(clothVp({ ...s, cloth: { player1: 3 } }, 'player1')).toBe(1);
    expect(clothVp({ ...s, cloth: { player1: 4 } }, 'player1')).toBe(2);
    expect(calcVP({ ...s, cloth: { player1: 4 } }, 'player1')).toBe(2); // 建物0+織物2VP
  });

  it('村の数字が出ると接続済みプレイヤーへ織物1枚（供給の範囲で）', () => {
    const s0 = cloth();
    const villageId = Object.keys(s0.villages!)[0]!;
    const num = s0.tiles[villageId]!.number!;
    const s: GameState = { ...s0, villageConn: { [villageId]: ['player1', 'player2'] } };
    const next = produceCloth(s, num);
    expect(next.cloth!.player1).toBe(1);
    expect(next.cloth!.player2).toBe(1);
    expect(next.villages![villageId]).toBe(3); // 5 - 2
    // 別の出目では何も起きない
    const other = produceCloth(s, num === 12 ? 11 : num + 1);
    expect(other).toBe(s);
  });

  it('小島（村）には開拓地を建てられない（noIslandSettlement）', () => {
    const s = cloth();
    const villageId = Object.keys(s.villages!)[0]!;
    const v = (s.tileToVertices[villageId] ?? []).find(vid => isLandVertex(s.vertices[vid]!, s.tiles));
    if (v) expect(canBuildSettlement(s, 'player1', v)).toBe(false);
  });

  it('5村が供給切れになると最多VPで終了（同点は織物多い方）', () => {
    const s0 = cloth();
    const depleted: Record<string, number> = {};
    for (const id of Object.keys(s0.villages!)) depleted[id] = 0;
    const s: GameState = { ...s0, villages: depleted, cloth: { player1: 1, player2: 5 } };
    const end = checkClothEnd(s);
    expect(end.phase).toBe('GAME_OVER');
    // 建物が無い状態では VP は織物のみ → player2(5枚=2VP) が player1(1枚=0VP) に勝つ
    expect(end.winner).toBe('player2');
  });

  it('BUILD_SHIP で村に隣接すると織物接続が成立する（エンドツーエンド）', () => {
    const g = cloth();
    const villageId = Object.keys(g.villages!)[0]!;
    const e = g.tileToEdges[villageId]![0]!;
    const v = g.edges[e]!.vertexIds[0];
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: { wood: 1, brick: 0, wool: 1, grain: 0, ore: 0 } } },
    };
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: e });
    expect(next.edges[e]!.ship?.playerId).toBe('player1');
    expect(next.cloth?.player1).toBe(1);
    expect(next.villages![villageId]).toBe(4);
  });

  it('[D6] 海賊は最初の村接続まで動かせない（村接続後は解除）', () => {
    const g = cloth();
    const seaTile = Object.keys(g.tiles).find(id => g.tiles[id]!.type === 'sea' && id !== g.piratePosition)!;
    const base: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'ROBBER', setupSubPhase: null,
      currentPlayerIndex: 0, diceRolledThisTurn: true, villageConn: {},
    };
    // 村未接続: 海賊は凍結（移動不可）
    expect(() => applyAction(base, { type: 'MOVE_PIRATE', tileId: seaTile })).toThrow(/frozen/);
    // 村接続後: 凍結エラーは出ない
    const villageId = Object.keys(g.villages!)[0]!;
    const connected: GameState = { ...base, villageConn: { [villageId]: ['player1'] } };
    let frozen = false;
    try { applyAction(connected, { type: 'MOVE_PIRATE', tileId: seaTile }); }
    catch (e) { if (String(e).includes('frozen')) frozen = true; }
    expect(frozen).toBe(false);
  });

  it('[D7] 村につないだ航路は closed（移動できない）', () => {
    const g = cloth();
    const villageId = Object.keys(g.villages!)[0]!;
    const e = g.tileToEdges[villageId]![0]!;
    const v = g.edges[e]!.vertexIds[0];
    const s: GameState = {
      ...g, phase: 'MAIN', turnPhase: 'TRADE_BUILD', setupSubPhase: null, currentPlayerIndex: 0, diceRolledThisTurn: true,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, hand: { wood: 1, brick: 0, wool: 1, grain: 0, ore: 0 } } },
    };
    const next = applyAction(s, { type: 'BUILD_SHIP', edgeId: e });
    expect(next.cloth?.player1).toBe(1); // 村に接続成立
    expect(isVillageLockedShip(next, 'player1', e)).toBe(true);
    // このターン建設という理由を外しても、村ロックで移動不可のまま。
    const later: GameState = { ...next, shipsBuiltThisTurn: [], shipMovedThisTurn: false };
    expect(isShipMovable(later, 'player1', e)).toBe(false);
  });
});

describe('S6 カタンの織物: 初期配置3軒（[D3]）', () => {
  const SPECS3: PlayerSpec[] = [
    { id: 'player1', name: 'A', color: 'red',    type: 'ai', aiDifficulty: 'normal' },
    { id: 'player2', name: 'B', color: 'blue',   type: 'ai', aiDifficulty: 'normal' },
    { id: 'player3', name: 'C', color: 'purple', type: 'ai', aiDifficulty: 'normal' },
  ];
  const totalHand = (p: { hand: Record<string, number> }) => Object.values(p.hand).reduce((a, b) => a + b, 0);
  const countBuildings = (s: GameState, pid: string) =>
    Object.values(s.vertices).filter(v => v.building?.playerId === pid).length;

  it('startingSettlements が 3 に設定されている', () => {
    expect(cloth().startingSettlements).toBe(3);
  });

  it('AI で初期配置を完走すると各プレイヤーが3軒・資源は3軒目でのみ付与', () => {
    const rng = createRng(7);
    let s = createInitialGameState(SPECS3, 'fixed', ['player1', 'player2', 'player3'], rng, 'seafarers_cloth');
    let guard = 0;
    while (s.phase !== 'MAIN' && guard++ < 3000) {
      const pid = s.playerOrder[s.currentPlayerIndex]!;
      const handBefore = totalHand(s.players[pid]!);
      const buildingsBefore = countBuildings(s, pid);
      const a = chooseAction(s, pid, { rng });
      if (!a) break;
      s = applyAction(s, a, rng);
      if (a.type === 'BUILD_SETTLEMENT' && buildingsBefore + 1 < 3) {
        // 1軒目・2軒目では資源を得ない（公式: 最初の2軒は資源なし）
        expect(totalHand(s.players[pid]!)).toBe(handBefore);
      }
    }
    expect(s.phase).toBe('MAIN');
    for (const pid of s.playerOrder) expect(countBuildings(s, pid)).toBe(3);
    // 3軒目の隣接タイルから資源が配られている（盤は数字付きの本島なので全体で>0）
    const handsTotal = s.playerOrder.reduce((acc, pid) => acc + totalHand(s.players[pid]!), 0);
    expect(handsTotal).toBeGreaterThan(0);
  });

  it('標準の2軒シナリオ（新たな海岸）は従来どおり各2軒で完走する（非回帰）', () => {
    const rng = createRng(7);
    let s = createInitialGameState(SPECS3, 'fixed', ['player1', 'player2', 'player3'], rng, 'seafarers_newshores');
    expect(s.startingSettlements ?? 2).toBe(2);
    let guard = 0;
    while (s.phase !== 'MAIN' && guard++ < 3000) {
      const pid = s.playerOrder[s.currentPlayerIndex]!;
      const a = chooseAction(s, pid, { rng });
      if (!a) break;
      s = applyAction(s, a, rng);
    }
    expect(s.phase).toBe('MAIN');
    for (const pid of s.playerOrder) expect(countBuildings(s, pid)).toBe(2);
  });
});
