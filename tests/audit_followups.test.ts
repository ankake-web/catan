// 敵対的バグ監査(ultracode)で確定した PR#10 追随バグ5件の回帰テスト。
import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { applyAction } from '../src/engine/game';
import { distributeCkProduction, downgradeCity } from '../src/engine/citiesKnights';
import { computeGoldPicks } from '../src/engine/dice';
import { canBuildSettlement } from '../src/engine/actions';
import { edgeTileIds, isLandEdge } from '../src/engine/board';
import { makeHand, RESOURCE_TYPES } from '../src/constants';
import type { GameState, VertexId } from '../src/types';

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];
const mk = (sc: string, seed = 1): GameState =>
  createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(seed), sc as never);
const handTotal = (h: Record<string, number>): number => RESOURCE_TYPES.reduce((s, r) => s + h[r], 0);
const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;
const isRed = (n: number | null | undefined): boolean => n === 6 || n === 8;

// #1 本島↔霧境界の赤6/8隣接
describe('監査#1: 赤6/8は本島↔霧の境界も含めて隣接しない（オアシス）', () => {
  it('多シードで、公開後の全タイル(本島+霧の隠し数字)を通じ赤6/8が辺隣接しない', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = mk('oasis', seed);
      // coord→赤数字マップ（本島=t.number / 霧=t.fog.number）。
      const num: Record<string, number | null> = {};
      for (const t of Object.values(g.tiles)) {
        const key = `${t.coord.q},${t.coord.r}`;
        num[key] = t.fog ? t.fog.number : t.number;
      }
      for (const [key, n] of Object.entries(num)) {
        if (!isRed(n)) continue;
        const [q, r] = key.split(',').map(Number) as [number, number];
        for (const [dq, dr] of NB) {
          expect(isRed(num[`${q + dq},${r + dr}`]), `seed ${seed}: 赤6/8が境界で隣接 @${key}`).toBe(false);
        }
      }
    }
  });
});

// #2 SETUP中の霧公開で資源を只取りしない
describe('監査#2: SETUP の霧公開は資源報酬を与えない（只取り・二重取得の防止）', () => {
  it('初期配置(最後でない開拓地)を資源霧に隣接して置くと、霧は晴れるが資源は増えない', () => {
    const g = mk('oasis', 1);
    // 資源(砂漠以外)を隠す霧に隣接し、本島にも面する頂点を選ぶ。
    const v = Object.keys(g.vertices).find(vid => {
      const vx = g.vertices[vid]!;
      const touchesResFog = vx.adjacentTileIds.some(t => g.tiles[t]?.fog && g.tiles[t]!.fog!.type !== 'desert');
      return touchesResFog && canBuildSettlement(g, 'player1', vid);
    })!;
    expect(v).toBeTruthy();
    const fogTid = g.vertices[v]!.adjacentTileIds.find(t => g.tiles[t]?.fog && g.tiles[t]!.fog!.type !== 'desert')!;
    // SETUP_FORWARD の1軒目(最後でない=setupGainForは走らない)なので、増分は純粋に霧公開報酬のみ。
    const s: GameState = { ...g, phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_SETTLEMENT', currentPlayerIndex: 0 };
    const before = handTotal(s.players.player1!.hand);
    const next = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: v });
    expect(next.tiles[fogTid]!.fog).toBeUndefined();            // 霧は晴れる
    expect(next.tiles[fogTid]!.type).not.toBe('sea');
    expect(handTotal(next.players.player1!.hand)).toBe(before); // ← バグ時は +1(只取り)で落ちる
  });

  it('初期の無償道を財宝でない資源霧に隣接して置いても資源は増えない', () => {
    const g = mk('oasis', 1);
    const E = Object.values(g.edges).find(e => {
      const tids = edgeTileIds(e, g.vertices);
      const resFog = tids.find(t => g.tiles[t]?.fog && g.tiles[t]!.fog!.type !== 'desert');
      return resFog != null && isLandEdge(e, g.vertices, g.tiles) && e.road == null
        && !(g.edgeTokens ?? {})[e.id]; // 財宝辺は除外(別ガード)
    })!;
    const v = E.vertexIds[0]!;
    const s: GameState = {
      ...g, phase: 'SETUP_FORWARD', setupSubPhase: 'PLACE_ROAD', setupRoadAnchor: v, currentPlayerIndex: 0,
      vertices: { ...g.vertices, [v]: { ...g.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    const before = handTotal(s.players.player1!.hand);
    const next = applyAction(s, { type: 'BUILD_ROAD', edgeId: E.id });
    expect(handTotal(next.players.player1!.hand)).toBe(before); // 無償報酬なし
  });
});

// #3 海賊コマが霧タイルに乗らない
describe('監査#3: 海賊コマの初期位置は本物の海（霧タイルではない）', () => {
  for (const sc of ['seafarers_treasure', 'seafarers_fogislands', 'seafarers_oceania']) {
    it(`${sc}: piratePosition は fog を持たない海タイル`, () => {
      for (let seed = 1; seed <= 10; seed++) {
        const g = mk(sc, seed);
        if (g.piratePosition == null) continue;
        const t = g.tiles[g.piratePosition]!;
        expect(t.type).toBe('sea');
        expect(t.fog, `${sc} seed ${seed}: 海賊が霧タイル上`).toBeUndefined(); // ← バグ時は fog 付き
      }
    });
  }
});

// #4 downgradeCity は開拓地コマ在庫0なら都市を撤去（幻の開拓地を作らない）
describe('監査#4: 開拓地コマ在庫0での都市格下げは撤去（駒会計を保つ）', () => {
  it('remainingSettlements=0 の平の都市を downgradeCity すると建物撤去・都市コマ返却・開拓地は増えない', () => {
    const g = mk('ck_seafarers_newshores', 1);
    const vid = Object.keys(g.vertices)[0]! as VertexId;
    const s: GameState = {
      ...g,
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'city', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, remainingSettlements: 0, remainingCities: 2 } },
    };
    const next = downgradeCity(s, 'player1', vid);
    expect(next.vertices[vid]!.building).toBeNull();                       // 都市は撤去（幻の開拓地にしない）
    expect(next.players.player1!.remainingCities).toBe(3);                 // 都市コマは返却(+1)
    expect(next.players.player1!.remainingSettlements).toBe(0);            // 開拓地は増やさない(クランプ由来の幻を作らない)
  });

  it('開拓地コマ在庫がある通常時は従来どおり開拓地へ格下げ', () => {
    const g = mk('ck_seafarers_newshores', 1);
    const vid = Object.keys(g.vertices)[0]! as VertexId;
    const s: GameState = {
      ...g,
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'city', playerId: 'player1' } } },
      players: { ...g.players, player1: { ...g.players.player1!, remainingSettlements: 2, remainingCities: 1 } },
    };
    const next = downgradeCity(s, 'player1', vid);
    expect(next.vertices[vid]!.building).toEqual({ type: 'settlement', playerId: 'player1' });
    expect(next.players.player1!.remainingCities).toBe(2);
    expect(next.players.player1!.remainingSettlements).toBe(1);
  });
});

// #5 水道橋(科学Lv3)は金タイル産出者には発火しない
describe('監査#5: CK×航海者の金タイル産出者に水道橋を二重発火させない', () => {
  it('金のみが産出源の科学Lv3プレイヤーは、水道橋の無償資源を得ない（金の選択のみ）', () => {
    const g = mk('ck_seafarers_newshores', 1);
    const gold = Object.values(g.tiles).find(t => t.type === 'gold')!;
    const G = gold.number!;
    const vid = (g.tileToVertices[gold.id] ?? [])[0]! as VertexId;
    // 盤上の建物を全消し→player1 の都市を金タイル頂点のみに置く。金頂点の非金隣接タイルは
    //   その数字が G と一致すると産出してしまうので、number=null にして「金だけが産出源」にする。
    const vertices = { ...g.vertices };
    for (const k of Object.keys(vertices)) vertices[k] = { ...vertices[k]!, building: null };
    vertices[vid] = { ...vertices[vid]!, building: { type: 'city', playerId: 'player1' } };
    const tiles = { ...g.tiles };
    for (const t of g.vertices[vid]!.adjacentTileIds) {
      if (tiles[t] && tiles[t]!.type !== 'gold') tiles[t] = { ...tiles[t]!, number: null };
    }
    const s: GameState = {
      ...g, tiles, vertices,
      players: { ...g.players, player1: { ...g.players.player1!, improvements: { trade: 0, politics: 0, science: 3 }, hand: makeHand() } },
    };
    expect(computeGoldPicks(s, G)).toEqual({ player1: 2 }); // 金の選択(都市=2)を owed
    const before = handTotal(s.players.player1!.hand);
    const next = distributeCkProduction(s, G);
    // 金は GOLD フェーズで別途選択。ここ(産出適用)では水道橋も含め player1 の手札は増えない。
    expect(handTotal(next.players.player1!.hand)).toBe(before); // ← バグ時は水道橋+1で落ちる
  });
});
