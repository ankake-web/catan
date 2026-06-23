// ============================================================
// tests/citiesKnights.test.ts — 騎士と商人(Cities & Knights) フェーズ1: 都市産出
// ============================================================

import { describe, it, expect } from 'vitest';
import { computeCkProduction } from '../src/engine/citiesKnights';
import { makeGameState, makePlayer } from './helpers';
import { makeHand } from '../src/constants';
import type { GameState, TileType, BuildingType, PlayerId } from '../src/types';

// 1つのタイルだけ出目8にして（他は number=null）、その頂点に建物を置いた状態を作る。
function oneTile(type: TileType, buildings: Array<[idx: number, b: BuildingType, p: PlayerId]>): GameState {
  const g = makeGameState({
    players: {
      player1: makePlayer('player1'),
      player2: makePlayer('player2'),
    },
    playerOrder: ['player1', 'player2'],
  });
  const tid = Object.keys(g.tileToVertices).find(t => (g.tileToVertices[t]?.length ?? 0) >= 3)!;
  const vids = g.tileToVertices[tid]!;
  const tiles = Object.fromEntries(
    Object.entries(g.tiles).map(([id, t]) =>
      [id, id === tid ? { ...t, type, number: 8, hasRobber: false } : { ...t, number: null }]),
  );
  const vertices = { ...g.vertices };
  for (const [idx, b, p] of buildings) {
    const vid = vids[idx]!;
    vertices[vid] = { ...g.vertices[vid]!, building: { type: b, playerId: p } };
  }
  return { ...g, tiles, vertices } as GameState;
}

describe('C&K 都市産出 computeCkProduction', () => {
  it('都市(森)=木1+紙1、開拓地(森)=木1のみ', () => {
    const s = oneTile('forest', [[0, 'city', 'player1'], [1, 'settlement', 'player2']]);
    const prod = computeCkProduction(s, 8);
    expect(prod.resources.player1).toEqual({ wood: 1 });
    expect(prod.commodities.player1).toEqual({ paper: 1 });
    expect(prod.resources.player2).toEqual({ wood: 1 });
    expect(prod.commodities.player2).toBeUndefined(); // 開拓地は商品を産まない
  });

  it('都市(牧草)=羊1+布1 / 都市(山)=鉱石1+金貨1', () => {
    const pasture = computeCkProduction(oneTile('pasture', [[0, 'city', 'player1']]), 8);
    expect(pasture.resources.player1).toEqual({ wool: 1 });
    expect(pasture.commodities.player1).toEqual({ cloth: 1 });

    const mountain = computeCkProduction(oneTile('mountain', [[0, 'city', 'player1']]), 8);
    expect(mountain.resources.player1).toEqual({ ore: 1 });
    expect(mountain.commodities.player1).toEqual({ coin: 1 });
  });

  it('都市(丘/畑)=資源2で商品なし', () => {
    const hill = computeCkProduction(oneTile('hill', [[0, 'city', 'player1']]), 8);
    expect(hill.resources.player1).toEqual({ brick: 2 });
    expect(hill.commodities.player1).toBeUndefined();

    const field = computeCkProduction(oneTile('field', [[0, 'city', 'player1']]), 8);
    expect(field.resources.player1).toEqual({ grain: 2 });
    expect(field.commodities.player1).toBeUndefined();
  });

  it('7は産出なし', () => {
    const s = oneTile('forest', [[0, 'city', 'player1']]);
    expect(computeCkProduction(s, 7)).toEqual({ resources: {}, commodities: {} });
  });

  it('盗賊のいるタイルは資源も商品も産出しない', () => {
    const s = oneTile('forest', [[0, 'city', 'player1']]);
    const tid = Object.keys(s.tiles).find(t => s.tiles[t]!.number === 8)!;
    const s2 = { ...s, tiles: { ...s.tiles, [tid]: { ...s.tiles[tid]!, hasRobber: true } } };
    expect(computeCkProduction(s2, 8)).toEqual({ resources: {}, commodities: {} });
  });

  it('資源はバンク枯渇ルールを適用（複数需要が在庫超なら配布なし／商品は在庫十分なら配布）', () => {
    // 山タイルに player1/player2 の都市 → 各 鉱石1＋金貨1。ore 需要 1+1=2 を bank.ore=1 にすると
    // 複数需要が在庫超 → ore は誰も貰えない。商品(金貨)は既定の在庫が十分なので両者とも貰える。
    const s0 = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player2']]);
    const s = { ...s0, bank: makeHand({ ore: 1, wood: 9, brick: 9, wool: 9, grain: 9 }) };
    const prod = computeCkProduction(s, 8);
    expect(prod.resources.player1).toBeUndefined();
    expect(prod.resources.player2).toBeUndefined();
    expect(prod.commodities.player1).toEqual({ coin: 1 });
    expect(prod.commodities.player2).toEqual({ coin: 1 });
  });

  it('商品も枯渇ルールを適用（複数需要が商品在庫超なら配布なし）', () => {
    // 金貨(coin)の在庫を1にすると、coin 需要 1+1=2 > 1 で複数需要在庫超 → 誰も金貨を貰えない。
    const s0 = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player2']]);
    const s = { ...s0, commodityBank: { coin: 1, cloth: 19, paper: 19 } };
    const prod = computeCkProduction(s, 8);
    expect(prod.commodities.player1).toBeUndefined();
    expect(prod.commodities.player2).toBeUndefined();
  });
});

describe('C&K 統合: フルCPU対戦が拡張機構を使って完走する', () => {
  it('改善・騎士・蛮族が発生し、勝者が13点に到達して GAME_OVER', async () => {
    const { createInitialGameState } = await import('../src/engine/createState');
    const { chooseAction } = await import('../src/engine/ai');
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const { calcVP } = await import('../src/engine/scoring');
    const { findPendingDiscarder } = await import('../src/engine/robber');
    const specs = [
      { id: 'player1' as const, name: 'A', color: 'red' as const,    type: 'ai' as const, aiDifficulty: 'strong' as const },
      { id: 'player2' as const, name: 'B', color: 'blue' as const,   type: 'ai' as const, aiDifficulty: 'strong' as const },
      { id: 'player3' as const, name: 'C', color: 'purple' as const, type: 'ai' as const, aiDifficulty: 'strong' as const },
    ];
    const rng = createRng(777);
    let s = createInitialGameState(specs, 'fixed', ['player1', 'player2', 'player3'], rng, 'cities_knights');
    let improvements = 0, knights = 0, progress = 0;
    for (let i = 0; i < 200_000 && s.phase !== 'GAME_OVER'; i++) {
      let pid = s.playerOrder[s.currentPlayerIndex]!;
      if (s.phase === 'MAIN' && s.turnPhase === 'DISCARD') {
        pid = findPendingDiscarder(s) ?? pid; // 商品も計上するエンジン判定に委譲
      } else if (s.phase === 'MAIN' && s.turnPhase === 'CITY_DOWNGRADE') {
        pid = (s.pendingCityDowngrade ?? [])[0] ?? pid; // 蛮族敗北の都市格下げは対象が解決
      } else if (s.phase === 'MAIN' && s.turnPhase === 'PROGRESS_DISCARD') {
        pid = (s.pendingProgressDiscard ?? [])[0] ?? pid; // 進歩カード上限超過の捨て札は対象が解決
      }
      const action = chooseAction(s, pid, { rng });
      if (!action) break;
      if (action.type === 'BUILD_IMPROVEMENT') improvements++;
      if (action.type === 'BUILD_KNIGHT') knights++;
      if (action.type === 'PLAY_PROGRESS') progress++;
      s = applyAction(s, action, rng);
    }
    expect(s.phase).toBe('GAME_OVER');
    expect(s.winner).not.toBeNull();
    expect(calcVP(s, s.winner!)).toBeGreaterThanOrEqual(13);
    expect(improvements).toBeGreaterThan(0);   // 都市改善が行われた
    expect(knights).toBeGreaterThan(0);        // 騎士が建設された
    expect(s.barbarianAttacks ?? 0).toBeGreaterThan(0);
    expect(progress).toBeGreaterThan(0); // 進歩カードが使われた
  }, 30000);
});

describe('C&K メトロポリス', () => {
  it('Lv5到達でLv4保持者からメトロポリスを奪取する', async () => {
    const { buildImprovement } = await import('../src/engine/citiesKnights');
    let s = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player2']]);
    const tid = Object.keys(s.tileToVertices).find(t => (s.tileToVertices[t]?.length ?? 0) >= 3)!;
    const vids = s.tileToVertices[tid]!;
    const vidA = vids[0]!, vidB = vids[1]!;
    s = {
      ...s,
      expansion: 'cities_knights',
      metropolis: { science: { playerId: 'player1', vertexId: vidA } },
      vertices: {
        ...s.vertices,
        [vidA]: { ...s.vertices[vidA]!, building: { type: 'city', playerId: 'player1', metropolis: true } },
      },
      players: {
        ...s.players,
        player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 4 } }),
        player2: makePlayer('player2', { improvements: { trade: 0, politics: 0, science: 4 }, commodities: { coin: 0, cloth: 0, paper: 5 } }),
      },
    } as GameState;
    const r = buildImprovement(s, 'player2', 'science');
    expect(r.metropolis!.science!.playerId).toBe('player2');
    expect(r.vertices[vidB]!.building!.metropolis).toBe(true);
    expect(r.vertices[vidA]!.building!.metropolis ?? false).toBe(false); // 旧保持者は平の都市へ
    expect(r.players.player2!.improvements!.science).toBe(5);
  });

  it('同レベル(Lv4同士)では先着保持者が維持し奪取されない', async () => {
    const { buildImprovement } = await import('../src/engine/citiesKnights');
    let s = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player2']]);
    const tid = Object.keys(s.tileToVertices).find(t => (s.tileToVertices[t]?.length ?? 0) >= 3)!;
    const vids = s.tileToVertices[tid]!;
    const vidA = vids[0]!;
    s = {
      ...s,
      expansion: 'cities_knights',
      metropolis: { science: { playerId: 'player1', vertexId: vidA } },
      vertices: {
        ...s.vertices,
        [vidA]: { ...s.vertices[vidA]!, building: { type: 'city', playerId: 'player1', metropolis: true } },
      },
      players: {
        ...s.players,
        player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 4 } }),
        player2: makePlayer('player2', { improvements: { trade: 0, politics: 0, science: 3 }, commodities: { coin: 0, cloth: 0, paper: 4 } }),
      },
    } as GameState;
    // player2 が Lv3→4: 既に player1 が保持しているので奪取できない。
    const r = buildImprovement(s, 'player2', 'science');
    expect(r.metropolis!.science!.playerId).toBe('player1');
    expect(r.players.player2!.improvements!.science).toBe(4);
  });

  it('metropolisVertexId 指定で化ける都市を手動選択できる（候補2つ）', async () => {
    const { buildImprovement, metropolisCityChoices, improvementTakesMetropolis } = await import('../src/engine/citiesKnights');
    let s = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player1']]);
    const tid = Object.keys(s.tileToVertices).find(t => (s.tileToVertices[t]?.length ?? 0) >= 3)!;
    const vids = s.tileToVertices[tid]!;
    const vidA = vids[0]!, vidB = vids[1]!;
    s = {
      ...s,
      expansion: 'cities_knights',
      players: {
        ...s.players,
        player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 3 }, commodities: { coin: 0, cloth: 0, paper: 4 } }),
      },
    } as GameState;
    // 候補が2つ（vidA, vidB）あり、新規取得（Lv3→4）となる。
    expect(improvementTakesMetropolis(s, 'player1', 'science')).toBe(true);
    expect(metropolisCityChoices(s, 'player1').sort()).toEqual([vidA, vidB].sort());
    // 2つ目の都市を明示指定 → そちらがメトロポリスになる。
    const r = buildImprovement(s, 'player1', 'science', 0, vidB);
    expect(r.vertices[vidB]!.building!.metropolis).toBe(true);
    expect(r.vertices[vidA]!.building!.metropolis ?? false).toBe(false);
    expect(r.metropolis!.science!.vertexId).toBe(vidB);
  });

  it('既にそのツリーのメトロポリスを保持中は都市選択不要（improvementTakesMetropolis=false）', async () => {
    const { improvementTakesMetropolis } = await import('../src/engine/citiesKnights');
    let s = oneTile('mountain', [[0, 'city', 'player1']]);
    const tid = Object.keys(s.tileToVertices).find(t => (s.tileToVertices[t]?.length ?? 0) >= 3)!;
    const vidA = s.tileToVertices[tid]![0]!;
    s = {
      ...s,
      expansion: 'cities_knights',
      metropolis: { science: { playerId: 'player1', vertexId: vidA } },
      vertices: { ...s.vertices, [vidA]: { ...s.vertices[vidA]!, building: { type: 'city', playerId: 'player1', metropolis: true } } },
      players: { ...s.players, player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 4 } }) },
    } as GameState;
    // Lv4→5 だが自分が保持中 → 都市の付け替えは不要。
    expect(improvementTakesMetropolis(s, 'player1', 'science')).toBe(false);
  });
});

describe('C&K 蛮族防衛の報酬', () => {
  function barbState(extra: (g: GameState, vs: string[]) => GameState): GameState {
    const g = makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    return extra(g, Object.keys(g.vertices));
  }

  it('単独最大の貢献者は守護者VP+1（カードは引かない）', async () => {
    const { resolveBarbarianAttack, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = barbState((g, vs) => ({
      ...g,
      progressDecks: buildProgressDecks(createRng(1)),
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [vs[2]!]: { ...g.vertices[vs[2]!]!, knight: { playerId: 'player2', strength: 1, active: true } },
      },
    }));
    const r = resolveBarbarianAttack(s);
    expect(r.players.player1!.defenderVP).toBe(1);
    expect(r.players.player2!.defenderVP ?? 0).toBe(0);
    expect((r.players.player1!.progressCards ?? []).length).toBe(0);
  });

  it('同点最大は守護VPなしで各同点者が進歩カードを1枚引く', async () => {
    const { resolveBarbarianAttack, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = barbState((g, vs) => ({
      ...g,
      progressDecks: buildProgressDecks(createRng(2)),
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [vs[2]!]: { ...g.vertices[vs[2]!]!, knight: { playerId: 'player2', strength: 2, active: true } },
      },
    }));
    const r = resolveBarbarianAttack(s);
    expect(r.players.player1!.defenderVP ?? 0).toBe(0);
    expect(r.players.player2!.defenderVP ?? 0).toBe(0);
    expect((r.players.player1!.progressCards ?? []).length).toBe(1);
    expect((r.players.player2!.progressCards ?? []).length).toBe(1);
  });

  // --- フル経路（ROLL_DICE 相当: applyEventDie で蛮族が満タン→襲来）での検証 ---
  it('【フル経路】単独最大で撃退→守護者VP+1 が「勝利点」に加算される', async () => {
    const { applyEventDie, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { calcVP } = await import('../src/engine/scoring');
    const { createRng } = await import('../src/engine/setup');
    const { CK_BARBARIAN_MAX } = await import('../src/constants');
    const s = barbState((g, vs) => ({
      ...g,
      barbarianPosition: CK_BARBARIAN_MAX - 1, // 次の船で襲来
      progressDecks: buildProgressDecks(createRng(1)),
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 3, active: true } },
      },
    }));
    const vpBefore = calcVP(s, 'player1');
    const r = applyEventDie(s, () => 0.1, 4); // 0.1<0.5 → 'ship' → 前進で襲来
    expect(r.barbarianAttacks).toBe(1);                 // 襲来した
    expect(r.players.player1!.defenderVP).toBe(1);      // 守護者VP+1
    expect(calcVP(r, 'player1')).toBe(vpBefore + 1);    // 勝利点に反映
    expect((r.players.player1!.progressCards ?? []).length).toBe(0); // 単独はカードなし
  });

  it('【フル経路】同点撃退→各同点者が実在の進歩カードを1枚もらう（VPは増えない）', async () => {
    const { applyEventDie, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { calcVP } = await import('../src/engine/scoring');
    const { createRng } = await import('../src/engine/setup');
    const { CK_BARBARIAN_MAX } = await import('../src/constants');
    const s = barbState((g, vs) => ({
      ...g,
      barbarianPosition: CK_BARBARIAN_MAX - 1,
      progressDecks: buildProgressDecks(createRng(2)),
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [vs[2]!]: { ...g.vertices[vs[2]!]!, knight: { playerId: 'player2', strength: 2, active: true } },
      },
    }));
    const r = applyEventDie(s, () => 0.1, 4);
    expect(r.barbarianAttacks).toBe(1);
    expect(r.players.player1!.defenderVP ?? 0).toBe(0);
    expect(r.players.player2!.defenderVP ?? 0).toBe(0);
    const c1 = r.players.player1!.progressCards ?? [];
    const c2 = r.players.player2!.progressCards ?? [];
    expect(c1.length).toBe(1);
    expect(c2.length).toBe(1);
    expect(c1[0]!.type).toBeTruthy(); // 実在のカード種別
    expect(calcVP(r, 'player1')).toBe(calcVP(s, 'player1')); // 同点はVPが増えない
  });

  it('【フル経路】守護者VPで勝利点目標に到達したら、その手番(ROLL_DICE)で勝利確定する', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const { CK_BARBARIAN_MAX } = await import('../src/constants');
    const s = barbState((g, vs) => ({
      ...g,
      phase: 'MAIN', turnPhase: 'PRE_ROLL', currentPlayerIndex: 0,
      victoryTarget: 3,                          // 都市2VP + 守護者VP1 = 3 で到達
      barbarianPosition: CK_BARBARIAN_MAX - 1,
      alchemistForcedDice: [3, 4],               // 生産ダイス固定(=7・産出で紛れない)
      progressDecks: buildProgressDecks(createRng(1)),
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 3, active: true } },
      },
    } as Partial<GameState>));
    const r = applyAction(s, { type: 'ROLL_DICE' }, () => 0.1); // 0.1<0.5 → 'ship' で襲来
    expect(r.players.player1!.defenderVP).toBe(1);
    expect(r.phase).toBe('GAME_OVER');
    expect(r.winner).toBe('player1');
  });

  it('engineer: 城壁が上限(3)なら4つ目を建てない（カードは消費される）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const wallsOf = (st: GameState, pid: PlayerId): number =>
      Object.values(st.vertices).filter(v => v.building?.playerId === pid && (v.building as { wall?: boolean }).wall).length;
    const s = barbState((g, vs) => ({
      ...g,
      players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'eng', type: 'engineer', deck: 'science' }] }) },
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1', wall: true } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, building: { type: 'city', playerId: 'player1', wall: true } },
        [vs[2]!]: { ...g.vertices[vs[2]!]!, building: { type: 'city', playerId: 'player1', wall: true } },
        [vs[3]!]: { ...g.vertices[vs[3]!]!, building: { type: 'city', playerId: 'player1' } }, // 未城壁
      },
    }));
    expect(wallsOf(s, 'player1')).toBe(3);
    const r = playProgress(s, 'player1', 'eng', createRng(1));
    expect(wallsOf(r, 'player1')).toBe(3); // 上限のため4つ目は建たない
    expect((r.players.player1!.progressCards ?? []).length).toBe(0); // カードは消費
  });

  it('同点で手札上限4の防衛者も5枚目を引き、捨て札選択（PROGRESS_DISCARD）の対象になる', async () => {
    const { resolveBarbarianAttack, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, type: 'warlord' as const, deck: 'politics' as const }));
    const s = barbState((g, vs) => ({
      ...g,
      progressDecks: buildProgressDecks(createRng(3)),
      players: {
        ...g.players,
        player1: makePlayer('player1', { progressCards: four }),
      },
      vertices: {
        ...g.vertices,
        [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } },
        [vs[1]!]: { ...g.vertices[vs[1]!]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [vs[2]!]: { ...g.vertices[vs[2]!]!, knight: { playerId: 'player2', strength: 2, active: true } },
      },
    }));
    const r = resolveBarbarianAttack(s);
    // 公式: 上限を超えても引いてよく、その後1枚捨てる。player1 は5枚＋捨て札対象。
    expect((r.players.player1!.progressCards ?? []).length).toBe(5);
    expect(r.pendingProgressDiscard).toEqual(['player1']);
    expect((r.players.player2!.progressCards ?? []).length).toBe(1);
  });

  it('防衛失敗: 最弱の都市持ちは pendingCityDowngrade に入り、その場で格下げはしない（選択式）', async () => {
    const { resolveBarbarianAttack } = await import('../src/engine/citiesKnights');
    const s = barbState((g, vs) => ({
      ...g,
      vertices: { ...g.vertices, [vs[0]!]: { ...g.vertices[vs[0]!]!, building: { type: 'city', playerId: 'player1' } } },
    })); // 騎士なし → 防衛失敗
    const r = resolveBarbarianAttack(s);
    expect(r.pendingCityDowngrade).toEqual(['player1']);
    const cityVid = Object.keys(r.vertices).find(v => r.vertices[v]!.building?.type === 'city');
    expect(cityVid).toBeDefined(); // まだ都市のまま（格下げは選択後）
  });

  it('DOWNGRADE_CITY: 選んだ都市を格下げし、保留していた生産へ再開する', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const g0 = makeGameState({ expansion: 'cities_knights', players: { player1: makePlayer('player1'), player2: makePlayer('player2') }, playerOrder: ['player1', 'player2'] } as Partial<GameState>);
    const cityVid = Object.keys(g0.vertices)[0]!;
    const s: GameState = {
      ...g0, phase: 'MAIN', turnPhase: 'CITY_DOWNGRADE', currentPlayerIndex: 0,
      lastDiceRoll: [3, 2], barbarianAttacks: 1, pendingCityDowngrade: ['player1'],
      vertices: { ...g0.vertices, [cityVid]: { ...g0.vertices[cityVid]!, building: { type: 'city', playerId: 'player1' } } },
    };
    const r = applyAction(s, { type: 'DOWNGRADE_CITY', playerId: 'player1', vertexId: cityVid }, createRng(1));
    expect(r.vertices[cityVid]!.building!.type).toBe('settlement'); // 格下げ
    expect(r.turnPhase).toBe('TRADE_BUILD');                        // 生産へ再開（total=5）
    expect(r.pendingCityDowngrade ?? null).toBeNull();             // クリア
  });

  it('CITY_DOWNGRADE: CPU は自動で都市を選んで格下げする（デッドロックしない）', async () => {
    const { chooseAction } = await import('../src/engine/ai');
    const g0 = makeGameState({ expansion: 'cities_knights', players: { player1: makePlayer('player1', { type: 'ai' }), player2: makePlayer('player2') }, playerOrder: ['player1', 'player2'] } as Partial<GameState>);
    const cityVid = Object.keys(g0.vertices)[0]!;
    const s: GameState = {
      ...g0, phase: 'MAIN', turnPhase: 'CITY_DOWNGRADE', pendingCityDowngrade: ['player1'],
      vertices: { ...g0.vertices, [cityVid]: { ...g0.vertices[cityVid]!, building: { type: 'city', playerId: 'player1' } } },
    };
    const action = chooseAction(s, 'player1');
    expect(action?.type).toBe('DOWNGRADE_CITY');
    expect((action as { playerId: string }).playerId).toBe('player1');
  });
});

describe('C&K 進歩カード上限超過（5枚目）の捨て札 PROGRESS_DISCARD', () => {
  function fiveCardState(types?: string[]): { s: GameState; ids: string[] } {
    const g0 = makeGameState({ expansion: 'cities_knights', players: { player1: makePlayer('player1'), player2: makePlayer('player2') }, playerOrder: ['player1', 'player2'] } as Partial<GameState>);
    const ts = types ?? ['warlord', 'warlord', 'warlord', 'warlord', 'warlord'];
    const cards = ts.map((t, i) => ({ id: `c${i}`, type: t as 'warlord', deck: 'politics' as const }));
    const s: GameState = {
      ...g0, phase: 'MAIN', turnPhase: 'PROGRESS_DISCARD', currentPlayerIndex: 0,
      lastDiceRoll: [2, 3], pendingProgressDiscard: ['player1'],
      players: { ...g0.players, player1: makePlayer('player1', { progressCards: cards }) },
    };
    return { s, ids: cards.map(c => c.id) };
  }

  it('DISCARD_PROGRESS: 選んだ1枚を捨てて4枚に戻り、保留していた続き（生産）へ再開', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const { s, ids } = fiveCardState();
    const r = applyAction(s, { type: 'DISCARD_PROGRESS', playerId: 'player1', cardId: ids[2]! }, createRng(1));
    expect((r.players.player1!.progressCards ?? []).length).toBe(4);
    expect((r.players.player1!.progressCards ?? []).some(c => c.id === ids[2])).toBe(false);
    expect(r.turnPhase).toBe('TRADE_BUILD');                  // total=5 → 生産へ再開
    expect(r.pendingProgressDiscard ?? null).toBeNull();      // クリア
  });

  it('VPカード（憲法/印刷機）は捨てられない（候補に出ない・dispatchは例外）', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { progressDiscardCandidates } = await import('../src/engine/citiesKnights');
    // 5枚目が VP カードでないケース: 4枚通常＋1枚 constitution（VPは上限対象外なので非VPが5枚の想定はしない）。
    const { s, ids } = fiveCardState(['warlord', 'warlord', 'warlord', 'warlord', 'constitution']);
    const cands = new Set(progressDiscardCandidates(s, 'player1'));
    expect(cands.has(ids[4]!)).toBe(false); // constitution は候補外
    expect(() => applyAction(s, { type: 'DISCARD_PROGRESS', playerId: 'player1', cardId: ids[4]! })).toThrow();
  });

  it('CPU は上限超過時に自動で1枚捨てる（デッドロックしない）', async () => {
    const { chooseAction } = await import('../src/engine/ai');
    const g0 = makeGameState({ expansion: 'cities_knights', players: { player1: makePlayer('player1', { type: 'ai' }), player2: makePlayer('player2') }, playerOrder: ['player1', 'player2'] } as Partial<GameState>);
    const cards = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, type: 'warlord' as const, deck: 'politics' as const }));
    const s: GameState = {
      ...g0, phase: 'MAIN', turnPhase: 'PROGRESS_DISCARD', pendingProgressDiscard: ['player1'],
      players: { ...g0.players, player1: makePlayer('player1', { type: 'ai', progressCards: cards }) },
    };
    const action = chooseAction(s, 'player1');
    expect(action?.type).toBe('DISCARD_PROGRESS');
    expect((action as { playerId: string }).playerId).toBe('player1');
  });
});

describe('C&K 強盗・海賊', () => {
  it('資源0・商品のみの相手も奪取対象で、商品が奪われる', async () => {
    const { stealResource, robbableCardCount } = await import('../src/engine/robber');
    const { createRng } = await import('../src/engine/setup');
    let s = oneTile('mountain', [[0, 'city', 'player1'], [1, 'city', 'player2']]);
    s = {
      ...s,
      expansion: 'cities_knights',
      players: {
        ...s.players,
        player1: makePlayer('player1', { hand: makeHand(), commodities: { coin: 0, cloth: 0, paper: 0 } }),
        player2: makePlayer('player2', { hand: makeHand(), commodities: { coin: 3, cloth: 0, paper: 0 } }),
      },
    } as GameState;
    expect(robbableCardCount(s, 'player2')).toBe(3); // 商品3枚＝奪取対象
    const r = stealResource(s, 'player1', 'player2', createRng(1));
    expect(r.players.player1!.commodities!.coin).toBe(1);
    expect(r.players.player2!.commodities!.coin).toBe(2);
  });

  it('基本ゲームでは商品を数えない（後方互換）', async () => {
    const { robbableCardCount } = await import('../src/engine/robber');
    const s = makeGameState({
      players: { player1: makePlayer('player1', { hand: makeHand({ wood: 2 }) }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    });
    expect(robbableCardCount(s, 'player1')).toBe(2);
  });
});

describe('C&K 騎士で強盗を追い払う', () => {
  function chaseState(): { s: GameState; robberTid: string; knightVid: string } {
    const g = makeGameState({
      expansion: 'cities_knights',
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', diceRolledThisTurn: true, currentPlayerIndex: 0,
      barbarianAttacks: 1, // 初回襲来後＝盗賊が解凍され追い払い可能
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const tid = Object.keys(g.tileToVertices).find(t => (g.tileToVertices[t]?.length ?? 0) >= 3 && g.tiles[t]!.type !== 'sea')!;
    const kv = g.tileToVertices[tid]![0]!;
    const s: GameState = {
      ...g,
      tiles: Object.fromEntries(Object.entries(g.tiles).map(([id, t]) => [id, { ...t, hasRobber: id === tid }])) as GameState['tiles'],
      vertices: { ...g.vertices, [kv]: { ...g.vertices[kv]!, knight: { playerId: 'player1', strength: 2, active: true } } },
    };
    return { s, robberTid: tid, knightVid: kv };
  }

  it('canChaseRobber: 強盗隣接のアクティブ騎士は true、非起動/敵騎士/追い払い済は false', async () => {
    const { canChaseRobber } = await import('../src/engine/citiesKnights');
    const { s, knightVid } = chaseState();
    expect(canChaseRobber(s, 'player1', knightVid)).toBe(true);
    const inactive = { ...s, vertices: { ...s.vertices, [knightVid]: { ...s.vertices[knightVid]!, knight: { playerId: 'player1' as const, strength: 2 as const, active: false } } } };
    expect(canChaseRobber(inactive, 'player1', knightVid)).toBe(false);
    const enemy = { ...s, vertices: { ...s.vertices, [knightVid]: { ...s.vertices[knightVid]!, knight: { playerId: 'player2' as const, strength: 2 as const, active: true } } } };
    expect(canChaseRobber(enemy, 'player1', knightVid)).toBe(false);
    expect(canChaseRobber({ ...s, knightChasedThisTurn: true }, 'player1', knightVid)).toBe(false);
  });

  it('CHASE_ROBBER→MOVE_ROBBER でROBBER遷移→TRADE_BUILDへ戻り、騎士は非起動になる', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const { s, robberTid, knightVid } = chaseState();
    const rng = createRng(1);
    const a1 = applyAction(s, { type: 'CHASE_ROBBER', vertexId: knightVid }, rng);
    expect(a1.turnPhase).toBe('ROBBER');
    expect(a1.knightChasedThisTurn).toBe(true);
    expect(a1.vertices[knightVid]!.knight!.active).toBe(false);
    const destTid = Object.keys(a1.tiles).find(t => t !== robberTid && a1.tiles[t]!.type !== 'sea')!;
    const a2 = applyAction(a1, { type: 'MOVE_ROBBER', tileId: destTid, stealFromPlayerId: null }, rng);
    expect(a2.turnPhase).toBe('TRADE_BUILD'); // END_TURN/PRE_ROLL ではなく建設へ戻る
    // 同一ターンで再度の追い払いは不可（1ターン1回）。
    const { canChaseRobber } = await import('../src/engine/citiesKnights');
    expect(canChaseRobber(a2, 'player1', knightVid)).toBe(false);
  });

  it('CHASE_ROBBER は TRADE_BUILD 以外では不可', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { s, knightVid } = chaseState();
    const preRoll = { ...s, turnPhase: 'PRE_ROLL' as const, diceRolledThisTurn: false };
    expect(() => applyAction(preRoll, { type: 'CHASE_ROBBER', vertexId: knightVid })).toThrow();
  });
});

describe('C&K 進歩カード', () => {
  it('buildProgressDecks: 3ツリーの山札が生成される', async () => {
    const { buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const decks = buildProgressDecks(createRng(1));
    expect(decks.science.length).toBeGreaterThan(0);
    expect(decks.trade.length).toBeGreaterThan(0);
    expect(decks.politics.length).toBeGreaterThan(0);
  });

  function ckState(extra: Partial<GameState> = {}): GameState {
    return makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
      ...extra,
    } as Partial<GameState>);
  }

  it('warlord: 自分の騎士を全て起動する', async () => {
    const { playProgress, canPlayProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const g = ckState();
    const kv = Object.keys(g.vertices)[0]!;
    const s: GameState = {
      ...g,
      vertices: { ...g.vertices, [kv]: { ...g.vertices[kv]!, knight: { playerId: 'player1', strength: 1, active: false } } },
      players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'w1', type: 'warlord', deck: 'politics' }] }) },
    };
    expect(canPlayProgress(s, 'player1', 'w1')).toBe(true);
    const next = playProgress(s, 'player1', 'w1', createRng(1));
    expect(next.vertices[kv]!.knight!.active).toBe(true);
    expect((next.players.player1!.progressCards ?? []).length).toBe(0); // 使用後は手札から消える
  });

  it('resource_monopoly: 相手が最も多く持つ資源を各相手から2枚奪う', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const { makeHand } = await import('../src/constants');
    const g = ckState();
    const s: GameState = {
      ...g,
      players: {
        player1: makePlayer('player1', { hand: makeHand(), progressCards: [{ id: 'm1', type: 'resource_monopoly', deck: 'trade' }] }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 3 }) }),
      },
    };
    const next = playProgress(s, 'player1', 'm1', createRng(1));
    expect(next.players.player1!.hand.wood).toBe(2); // 2枚奪取
    expect(next.players.player2!.hand.wood).toBe(1); // 残り1
  });

  it('resource_monopoly: choice で指定した資源を奪う（自動最善でなくプレイヤー指名・公式）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const { makeHand } = await import('../src/constants');
    const g = ckState();
    const s: GameState = {
      ...g,
      players: {
        player1: makePlayer('player1', { hand: makeHand(), progressCards: [{ id: 'm1', type: 'resource_monopoly', deck: 'trade' }] }),
        player2: makePlayer('player2', { hand: makeHand({ wood: 1, ore: 3 }) }),
      },
    };
    // 自動なら最多の ore を奪うが、choice=wood を指名したら wood を奪う。
    const next = playProgress(s, 'player1', 'm1', createRng(1), { resource: 'wood' });
    expect(next.players.player1!.hand.wood).toBe(1);
    expect(next.players.player1!.hand.ore).toBe(0);  // ore は奪っていない
    expect(next.players.player2!.hand.ore).toBe(3);  // ore はそのまま
  });
});

describe('C&K 騎士の移動', () => {
  function ckBoard(): GameState {
    return makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
  }
  it('自分の道沿いの隣接空き頂点へ起動騎士を移動でき、行動後は非起動になる（再行動不可）', async () => {
    const { canMoveKnight, moveKnight } = await import('../src/engine/citiesKnights');
    const g = ckBoard();
    const eid = Object.keys(g.edges)[0]!;
    const [v1, v2] = g.edges[eid]!.vertexIds;
    const s: GameState = {
      ...g,
      edges: { ...g.edges, [eid]: { ...g.edges[eid]!, road: { playerId: 'player1' } } },
      vertices: { ...g.vertices, [v1]: { ...g.vertices[v1]!, knight: { playerId: 'player1', strength: 2, active: true } } },
    };
    expect(canMoveKnight(s, 'player1', v1, v2)).toBe(true);
    const next = moveKnight(s, 'player1', v1, v2);
    expect(next.vertices[v1]!.knight).toBeNull();
    expect(next.vertices[v2]!.knight!.playerId).toBe('player1');
    expect(next.vertices[v2]!.knight!.active).toBe(false);       // 行動後は非起動
    expect(canMoveKnight(next, 'player1', v2, v1)).toBe(false);  // 非起動なので再行動不可
  });
  it('弱い敵騎士は押し出せるが、同等以上は不可。非起動・道なしも不可', async () => {
    const { canMoveKnight } = await import('../src/engine/citiesKnights');
    const g = ckBoard();
    const eid = Object.keys(g.edges)[0]!;
    const [v1, v2] = g.edges[eid]!.vertexIds;
    const base: GameState = {
      ...g,
      edges: { ...g.edges, [eid]: { ...g.edges[eid]!, road: { playerId: 'player1' } } },
      vertices: { ...g.vertices, [v1]: { ...g.vertices[v1]!, knight: { playerId: 'player1', strength: 2, active: true } } },
    };
    const weak: GameState = { ...base, vertices: { ...base.vertices, [v2]: { ...base.vertices[v2]!, knight: { playerId: 'player2', strength: 1, active: false } } } };
    expect(canMoveKnight(weak, 'player1', v1, v2)).toBe(true); // 弱い敵→押し出し可
    const strong: GameState = { ...base, vertices: { ...base.vertices, [v2]: { ...base.vertices[v2]!, knight: { playerId: 'player2', strength: 2, active: true } } } };
    expect(canMoveKnight(strong, 'player1', v1, v2)).toBe(false); // 同等以上→不可
    // 非起動は移動不可
    const inactive: GameState = { ...base, vertices: { ...base.vertices, [v1]: { ...base.vertices[v1]!, knight: { playerId: 'player1', strength: 2, active: false } } } };
    expect(canMoveKnight(inactive, 'player1', v1, v2)).toBe(false);
    // 道が無い辺沿いは不可
    const noRoad: GameState = { ...base, edges: { ...base.edges, [eid]: { ...base.edges[eid]!, road: null } } };
    expect(canMoveKnight(noRoad, 'player1', v1, v2)).toBe(false);
  });

  it('押し出された弱い敵騎士は所有者の隣接空き頂点へ再配置され、strength/activeを保持', async () => {
    const { moveKnight } = await import('../src/engine/citiesKnights');
    const g = ckBoard();
    const eid = Object.keys(g.edges)[0]!;
    const [v1, v2] = g.edges[eid]!.vertexIds;
    // v2 に隣接する別頂点 v3 とその間の辺 e23 を探し、player2 の道を置く。
    let v3: string | undefined; let e23: string | undefined;
    for (const e of g.vertices[v2]!.adjacentEdgeIds) {
      const ed = g.edges[e]!;
      const other = ed.vertexIds[0] === v2 ? ed.vertexIds[1] : ed.vertexIds[0];
      if (other !== v1) { v3 = other; e23 = e; break; }
    }
    const s: GameState = {
      ...g,
      edges: {
        ...g.edges,
        [eid]: { ...g.edges[eid]!, road: { playerId: 'player1' } },
        [e23!]: { ...g.edges[e23!]!, road: { playerId: 'player2' } },
      },
      vertices: {
        ...g.vertices,
        [v1]: { ...g.vertices[v1]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [v2]: { ...g.vertices[v2]!, knight: { playerId: 'player2', strength: 1, active: true } },
      },
    };
    const next = moveKnight(s, 'player1', v1, v2);
    expect(next.vertices[v2]!.knight!.playerId).toBe('player1'); // 強い騎士が入る
    expect(next.vertices[v1]!.knight).toBeNull();
    expect(next.vertices[v3!]!.knight).toEqual({ playerId: 'player2', strength: 1, active: true }); // 再配置・状態保持
  });

  it('再配置先が無ければ押し出された騎士は供給へ戻る（盤から消える）', async () => {
    const { moveKnight } = await import('../src/engine/citiesKnights');
    const g = ckBoard();
    const eid = Object.keys(g.edges)[0]!;
    const [v1, v2] = g.edges[eid]!.vertexIds;
    const s: GameState = {
      ...g,
      edges: { ...g.edges, [eid]: { ...g.edges[eid]!, road: { playerId: 'player1' } } }, // player2の道なし
      vertices: {
        ...g.vertices,
        [v1]: { ...g.vertices[v1]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [v2]: { ...g.vertices[v2]!, knight: { playerId: 'player2', strength: 1, active: true } },
      },
    };
    const before = Object.values(s.vertices).filter(v => v.knight?.playerId === 'player2').length;
    const next = moveKnight(s, 'player1', v1, v2);
    const after = Object.values(next.vertices).filter(v => v.knight?.playerId === 'player2').length;
    expect(after).toBe(before - 1); // 供給へ戻る
    expect(next.vertices[v2]!.knight!.playerId).toBe('player1');
  });
});

describe('C&K 追加進歩カード', () => {
  function ck2(p1: Partial<import('../src/types').Player> = {}, p2: Partial<import('../src/types').Player> = {}): GameState {
    return makeGameState({
      expansion: 'cities_knights',
      commodityBank: { coin: 19, cloth: 19, paper: 19 },
      players: { player1: makePlayer('player1', p1), player2: makePlayer('player2', p2) },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
  }

  it('buildProgressDecks: 各デッキ18枚・枚数表どおり（merchantは6枚）', async () => {
    const { buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const d = buildProgressDecks(createRng(1));
    expect(d.science.length).toBe(18);
    expect(d.trade.length).toBe(18);
    expect(d.politics.length).toBe(18);
    expect(d.trade.filter(c => c.type === 'merchant').length).toBe(6);
  });

  it('printer/constitution: 即時+1勝利点（progressVP・calcVP）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { calcVP } = await import('../src/engine/scoring');
    const { createRng } = await import('../src/engine/setup');
    const s = ck2({ progressCards: [{ id: 'pr', type: 'printer', deck: 'science' }] });
    const before = calcVP(s, 'player1');
    const r = playProgress(s, 'player1', 'pr', createRng(1));
    expect(r.players.player1!.progressVP).toBe(1);
    expect(calcVP(r, 'player1')).toBe(before + 1);
  });

  it('merchant: 商人コマで+1VPかつその地形資源を2:1で交易', async () => {
    const { playProgress, canPlayProgress } = await import('../src/engine/citiesKnights');
    const { getEffectiveTradeRate } = await import('../src/engine/trade');
    const { calcVP } = await import('../src/engine/scoring');
    const { createRng } = await import('../src/engine/setup');
    const base = oneTile('forest', [[0, 'settlement', 'player1']]); // forest=木
    const s = { ...base, expansion: 'cities_knights' as const,
      players: { ...base.players, player1: makePlayer('player1', { progressCards: [{ id: 'm', type: 'merchant', deck: 'trade' }] }) } } as GameState;
    expect(canPlayProgress(s, 'player1', 'm')).toBe(true);
    const r = playProgress(s, 'player1', 'm', createRng(1));
    expect(r.merchant?.playerId).toBe('player1');
    expect(calcVP(r, 'player1')).toBe(calcVP(s, 'player1') + 1);
    expect(getEffectiveTradeRate(r, 'player1', 'wood')).toBe(2);
  });

  it('merchant_fleet: 指定種別を2:1で交易できる', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { getEffectiveTradeRate } = await import('../src/engine/trade');
    const { createRng } = await import('../src/engine/setup');
    const { makeHand } = await import('../src/constants');
    const s = ck2({ hand: makeHand({ ore: 5 }), progressCards: [{ id: 'mf', type: 'merchant_fleet', deck: 'trade' }] });
    const r = playProgress(s, 'player1', 'mf', createRng(1));
    expect(r.players.player1!.merchantFleetType).toBe('ore'); // 最多の手札種
    expect(getEffectiveTradeRate(r, 'player1', 'ore')).toBe(2);
  });

  it('spy: 相手の進歩カードを1枚奪う', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck2(
      { progressCards: [{ id: 'sp', type: 'spy', deck: 'politics' }] },
      { progressCards: [{ id: 'v', type: 'warlord', deck: 'politics' }] },
    );
    const r = playProgress(s, 'player1', 'sp', createRng(1));
    expect((r.players.player2!.progressCards ?? []).length).toBe(0);
    expect((r.players.player1!.progressCards ?? []).map(c => c.id)).toContain('v');
  });

  it('road_building_progress: 無料道2本(roadBuildingRoadsRemaining=2)', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck2({ progressCards: [{ id: 'rb', type: 'road_building_progress', deck: 'science' }] });
    const r = playProgress(s, 'player1', 'rb', createRng(1));
    expect(r.roadBuildingRoadsRemaining).toBe(2);
  });

  it('alchemist: PRE_ROLLで使うと次のROLL_DICEの目が固定され消費される', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const g = makeGameState({
      expansion: 'cities_knights', phase: 'MAIN', turnPhase: 'PRE_ROLL', diceRolledThisTurn: false, currentPlayerIndex: 0,
      commodityBank: { coin: 19, cloth: 19, paper: 19 },
      players: { player1: makePlayer('player1', { progressCards: [{ id: 'al', type: 'alchemist', deck: 'science' }] }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const rng = createRng(5);
    const a1 = applyAction(g, { type: 'PLAY_PROGRESS', cardId: 'al' }, rng);
    expect(a1.alchemistForcedDice).not.toBeNull();
    const forced = a1.alchemistForcedDice!;
    const a2 = applyAction(a1, { type: 'ROLL_DICE' }, rng);
    expect(a2.lastDiceRoll).toEqual(forced);            // 指定の目で振られる
    expect(a2.alchemistForcedDice ?? null).toBeNull();  // 消費済み
  });

  it('alchemist: choice.dice で次のダイス目を自分で指定できる（不正値は自動最善）', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const g = makeGameState({
      expansion: 'cities_knights', phase: 'MAIN', turnPhase: 'PRE_ROLL', diceRolledThisTurn: false, currentPlayerIndex: 0,
      players: { player1: makePlayer('player1', { progressCards: [{ id: 'al', type: 'alchemist', deck: 'science' }] }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    // 指定した目で固定される
    const a1 = applyAction(g, { type: 'PLAY_PROGRESS', cardId: 'al', choice: { dice: [6, 5] } }, createRng(5));
    expect(a1.alchemistForcedDice).toEqual([6, 5]);
    // 範囲外（不正）は自動最善にフォールバック（[7,0]にはならない）
    const a2 = applyAction(g, { type: 'PLAY_PROGRESS', cardId: 'al', choice: { dice: [7, 0] as unknown as readonly [number, number] } }, createRng(5));
    expect(a2.alchemistForcedDice).not.toEqual([7, 0]);
    expect(a2.alchemistForcedDice).not.toBeNull();
  });

  it('inventor: choice.inventorTiles で入れ替える2タイルを自分で指定できる', async () => {
    const { playProgress, inventorTiles } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const g = makeGameState({
      expansion: 'cities_knights', phase: 'MAIN', turnPhase: 'TRADE_BUILD', currentPlayerIndex: 0,
      players: { player1: makePlayer('player1', { progressCards: [{ id: 'iv', type: 'inventor', deck: 'science' }] }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const elig = inventorTiles(g);
    const a = elig[0]!;
    const b = elig.find(t => g.tiles[t]!.number !== g.tiles[a]!.number)!;
    const nA = g.tiles[a]!.number, nB = g.tiles[b]!.number;
    const next = playProgress(g, 'player1', 'iv', createRng(1), { inventorTiles: [a, b] });
    expect(next.tiles[a]!.number).toBe(nB); // 数字トークンが入れ替わる
    expect(next.tiles[b]!.number).toBe(nA);
  });

  it('発明家: 2と12のタイルは入替対象に含めない（公式制限・6/8と同様）', async () => {
    const { inventorTiles } = await import('../src/engine/citiesKnights');
    const g = makeGameState({ expansion: 'cities_knights' } as Partial<GameState>);
    for (const t of inventorTiles(g)) expect([2, 12, 6, 8].includes(g.tiles[t]!.number!)).toBe(false);
  });

  it('LAN: 相手参照系の進歩カード使用条件はマスク済みでも count で正しく判定（回帰）', async () => {
    const { canPlayProgress } = await import('../src/engine/citiesKnights');
    const { makeHand } = await import('../src/constants');
    // 相手の中身はマスクで空/0、枚数だけ count に入る状態（LAN視点）。
    const g = makeGameState({
      expansion: 'cities_knights',
      players: {
        player1: makePlayer('player1', { progressCards: [
          { id: 'sp', type: 'spy', deck: 'politics' },
          { id: 'rm', type: 'resource_monopoly', deck: 'trade' },
        ] }),
        player2: makePlayer('player2', { hand: makeHand(), handCount: 5, progressCards: [], progressCardCount: 2 }),
      },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    expect(canPlayProgress(g, 'player1', 'sp')).toBe(true); // 相手 progressCardCount=2
    expect(canPlayProgress(g, 'player1', 'rm')).toBe(true); // 相手 handCount=5
  });

  it('全進歩カード: 効果が空でも例外なく使えてカードが消費される（空撃ち安全性）', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    // 25種すべて。相手は何も持たない＝多くは効果なし。bishopのみ盗賊凍結解除(barb=1)が必要。
    const cards: Array<{ type: string; deck: string; phase: 'TRADE_BUILD' | 'PRE_ROLL'; barb?: number }> = [
      { type: 'bishop', deck: 'politics', phase: 'TRADE_BUILD', barb: 1 },
      { type: 'diplomat', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'intrigue', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'deserter', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'warlord', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'spy', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'saboteur', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'wedding', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'constitution', deck: 'politics', phase: 'TRADE_BUILD' },
      { type: 'alchemist', deck: 'science', phase: 'PRE_ROLL' },
      { type: 'crane', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'engineer', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'inventor', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'irrigation', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'medicine', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'mining', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'road_building_progress', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'smith', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'printer', deck: 'science', phase: 'TRADE_BUILD' },
      { type: 'merchant', deck: 'trade', phase: 'TRADE_BUILD' },
      { type: 'merchant_fleet', deck: 'trade', phase: 'TRADE_BUILD' },
      { type: 'master_merchant', deck: 'trade', phase: 'TRADE_BUILD' },
      { type: 'commercial_harbor', deck: 'trade', phase: 'TRADE_BUILD' },
      { type: 'resource_monopoly', deck: 'trade', phase: 'TRADE_BUILD' },
      { type: 'trade_monopoly', deck: 'trade', phase: 'TRADE_BUILD' },
    ];
    for (const { type, deck, phase, barb } of cards) {
      const g = makeGameState({
        expansion: 'cities_knights', phase: 'MAIN', turnPhase: phase, currentPlayerIndex: 0,
        barbarianAttacks: barb ?? 0, diceRolledThisTurn: phase === 'TRADE_BUILD',
        players: {
          player1: makePlayer('player1', { progressCards: [{ id: 'c', type, deck } as never] }),
          player2: makePlayer('player2'),
        },
        playerOrder: ['player1', 'player2'],
      } as Partial<GameState>);
      const choice = type === 'alchemist' ? { dice: [3, 4] as const } : undefined;
      try {
        const r = applyAction(g, { type: 'PLAY_PROGRESS', cardId: 'c', ...(choice ? { choice } : {}) }, createRng(1));
        expect((r.players.player1!.progressCards ?? []).length).toBe(0); // 消費される
      } catch (e) {
        throw new Error(`progress card "${type}" failed when wasted: ${(e as Error).message}`);
      }
    }
  });

  it('spy: 手札4枚(spy含む)でも使え、使用後はちょうど4枚（5枚にならない）', async () => {
    const { playProgress, canPlayProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const four = [
      { id: 'spy', type: 'spy' as const, deck: 'politics' as const },
      { id: 'a', type: 'warlord' as const, deck: 'politics' as const },
      { id: 'b', type: 'smith' as const, deck: 'science' as const },
      { id: 'c', type: 'mining' as const, deck: 'science' as const },
    ];
    const s = ck2({ progressCards: four }, { progressCards: [{ id: 'v', type: 'irrigation', deck: 'science' }] });
    expect(canPlayProgress(s, 'player1', 'spy')).toBe(true);
    const r = playProgress(s, 'player1', 'spy', createRng(1));
    expect((r.players.player1!.progressCards ?? []).length).toBe(4); // spy除去→3、奪取→4。5にはならない
    expect((r.players.player2!.progressCards ?? []).length).toBe(0);
  });

  it('bishop: 初回襲来前は不可、襲来後は使用可、移動先(現在地以外の陸)が無ければ不可', async () => {
    const { canPlayProgress } = await import('../src/engine/citiesKnights');
    const base = ck2({ progressCards: [{ id: 'bi', type: 'bishop', deck: 'politics' }] });
    expect(canPlayProgress(base, 'player1', 'bi')).toBe(false); // 盗賊凍結中（初回襲来前）
    const s = { ...base, barbarianAttacks: 1 } as GameState;
    expect(canPlayProgress(s, 'player1', 'bi')).toBe(true);
    const tids = Object.keys(s.tiles);
    const land = tids[0]!;
    const tiles = Object.fromEntries(tids.map(t => [t, { ...s.tiles[t]!, type: (t === land ? 'forest' : 'sea') as TileType, hasRobber: t === land }]));
    const s2 = { ...s, tiles } as GameState;
    expect(canPlayProgress(s2, 'player1', 'bi')).toBe(false); // 現在地以外の陸が無い
  });
});

describe('C&K ルール監査の修正', () => {
  function ck(extra: Partial<GameState> = {}): GameState {
    return makeGameState({
      expansion: 'cities_knights',
      commodityBank: { coin: 19, cloth: 19, paper: 19 },
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
      ...extra,
    } as Partial<GameState>);
  }

  it('A: 進歩カード抽選は 赤ダイス ≦ Lv+1（Lv1は赤2でも引ける、Lv0は赤2で引けない）', async () => {
    const { applyEventDie, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    // applyEventDie はイベントダイス自体を rng で振るため、ここでは drawProgressCards を直接検証する。
    const mod = await import('../src/engine/citiesKnights') as { default?: unknown };
    void mod; void applyEventDie;
    const base = ck({ progressDecks: buildProgressDecks(createRng(1)) });
    // drawProgressCards は非公開のため applyEventDie 経由ではなく、改善Lvを変えて挙動確認する代替として
    // canPlayProgress ではなく、公開 API の applyEventDie をイベント面固定で使えないため、ここでは
    // 改善Lv1のプレイヤーが赤2で引け、Lv0は引けないことを「条件式」で確認する近似テスト。
    const lv1 = { ...base, players: { ...base.players, player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 1 } }) } } as GameState;
    // 直接 drawProgressCards は export していないので、applyEventDie を使って色イベントを強制するため rng を仕込む。
    // rng が 'science'(緑) を返し redDie=2 のとき Lv1 は引ける。複数 seed で science 面を探す。
    let drewAtLv1Red2 = false, drewAtLv0Red2 = false;
    for (let seed = 1; seed <= 200 && !(drewAtLv1Red2 && drewAtLv0Red2); seed++) {
      const r1 = applyEventDie(lv1, createRng(seed), 2);
      if (r1.lastEventDie === 'science') {
        const got = ((r1.players.player1!.progressCards ?? []).length) > 0;
        if (got) drewAtLv1Red2 = true;
        const lv0 = { ...base } as GameState; // science Lv0
        const r0 = applyEventDie(lv0, createRng(seed), 2);
        if (r0.lastEventDie === 'science') drewAtLv0Red2 = ((r0.players.player1!.progressCards ?? []).length) > 0;
      }
    }
    expect(drewAtLv1Red2).toBe(true);   // Lv1 は赤2で引ける
    expect(drewAtLv0Red2).toBe(false);  // Lv0 は赤2で引けない
  });

  it('A2: 未改良(Lv0)は赤=1でも引けない（境界）。Lv1は赤=1で引ける', async () => {
    const { applyEventDie, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const base = ck({ progressDecks: buildProgressDecks(createRng(1)) });
    const lv1 = { ...base, players: { ...base.players, player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 1 } }) } } as GameState;
    let lv0Red1Drew: boolean | null = null, lv1Red1Drew = false;
    for (let seed = 1; seed <= 300 && (lv0Red1Drew === null || !lv1Red1Drew); seed++) {
      const r0 = applyEventDie(base, createRng(seed), 1); // Lv0, 赤=1
      if (r0.lastEventDie === 'science') lv0Red1Drew = ((r0.players.player1!.progressCards ?? []).length) > 0;
      const r1 = applyEventDie(lv1, createRng(seed), 1); // Lv1, 赤=1
      if (r1.lastEventDie === 'science' && ((r1.players.player1!.progressCards ?? []).length) > 0) lv1Red1Drew = true;
    }
    expect(lv0Red1Drew).toBe(false); // Lv0 は赤=1でも引けない
    expect(lv1Red1Drew).toBe(true);  // Lv1 は赤=1で引ける
  });

  it('B: 交易所(商業Lv3)は商品のみ2:1、資源は据え置き', async () => {
    const { getEffectiveTradeRate } = await import('../src/engine/trade');
    const s = ck({ players: { ...ck().players, player1: makePlayer('player1', { improvements: { trade: 3, politics: 0, science: 0 }, commodities: { coin: 3, cloth: 0, paper: 0 } }) } }) as GameState;
    expect(getEffectiveTradeRate(s, 'player1', 'coin')).toBe(2); // 商品=2:1
    expect(getEffectiveTradeRate(s, 'player1', 'wood')).toBe(4); // 資源=据え置き4:1
  });

  it('E: 7の手札上限は城壁のみ+2（メトロポリスは加算しない）', async () => {
    const { discardThreshold } = await import('../src/engine/robber');
    const base = ck();
    const vids = Object.keys(base.vertices);
    const wall = { ...base, vertices: { ...base.vertices, [vids[0]!]: { ...base.vertices[vids[0]!]!, building: { type: 'city' as const, playerId: 'player1', wall: true } } } } as GameState;
    expect(discardThreshold(wall, 'player1')).toBe(10); // 8 + 2
    const metro = { ...base, vertices: { ...base.vertices, [vids[1]!]: { ...base.vertices[vids[1]!]!, building: { type: 'city' as const, playerId: 'player1', metropolis: true } } } } as GameState;
    expect(discardThreshold(metro, 'player1')).toBe(8); // メトロポリスは+2しない
  });

  it('C: 7は初回襲来前なら盗賊を動かさず TRADE_BUILD（捨て無し時）', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    // 7を強制するため、forced dice をセット（alchemist）。barbarianAttacks=0 で凍結。
    const base = ck({ phase: 'MAIN', turnPhase: 'PRE_ROLL', diceRolledThisTurn: false, currentPlayerIndex: 0, barbarianAttacks: 0, alchemistForcedDice: [3, 4], barbarianPosition: 0 }) as GameState;
    const r = applyAction(base, { type: 'ROLL_DICE' }, createRng(1));
    expect(r.lastDiceRoll).toEqual([3, 4]);
    // 手札0枚で捨て無し → 盗賊凍結中は TRADE_BUILD（ROBBER にならない）。
    expect(r.turnPhase).toBe('TRADE_BUILD');
  });

  it('D: 別々の起動騎士はそれぞれ1回ずつ移動できる（per-knight）', async () => {
    const { canMoveKnight, moveKnight } = await import('../src/engine/citiesKnights');
    const g = ck();
    // 2本の辺それぞれに player1 の道＋起動騎士を置く。
    const eids = Object.keys(g.edges).slice(0, 2);
    const [e1, e2] = eids;
    const [a1, a2] = g.edges[e1!]!.vertexIds;
    const [b1, b2] = g.edges[e2!]!.vertexIds;
    // a1,b1 が別頂点になるよう、重複しない辺を選ぶ
    if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) return; // まれな重複ケースはスキップ
    const s: GameState = {
      ...g,
      edges: { ...g.edges, [e1!]: { ...g.edges[e1!]!, road: { playerId: 'player1' } }, [e2!]: { ...g.edges[e2!]!, road: { playerId: 'player1' } } },
      vertices: {
        ...g.vertices,
        [a1!]: { ...g.vertices[a1!]!, knight: { playerId: 'player1', strength: 2, active: true } },
        [b1!]: { ...g.vertices[b1!]!, knight: { playerId: 'player1', strength: 2, active: true } },
      },
    };
    const s1 = moveKnight(s, 'player1', a1!, a2!);           // 1体目移動（非起動化）
    expect(s1.vertices[a2!]!.knight!.active).toBe(false);
    expect(canMoveKnight(s1, 'player1', b1!, b2!)).toBe(true); // 2体目はまだ移動できる（per-knight）
  });

  it('D: 起動したターンの騎士は移動できない（activatedThisTurn）', async () => {
    const { canMoveKnight, activateKnight } = await import('../src/engine/citiesKnights');
    const { makeHand } = await import('../src/constants');
    const g = ck({ players: { ...ck().players, player1: makePlayer('player1', { hand: makeHand({ grain: 1 }) }) } });
    const eid = Object.keys(g.edges)[0]!;
    const [v1, v2] = g.edges[eid]!.vertexIds;
    const s: GameState = {
      ...g,
      edges: { ...g.edges, [eid]: { ...g.edges[eid]!, road: { playerId: 'player1' } } },
      vertices: { ...g.vertices, [v1]: { ...g.vertices[v1]!, knight: { playerId: 'player1', strength: 1, active: false } } },
    };
    const act = activateKnight(s, 'player1', v1);            // 起動
    expect(act.vertices[v1]!.knight!.activatedThisTurn).toBe(true);
    expect(canMoveKnight(act, 'player1', v1, v2)).toBe(false); // 起動ターンは行動不可
  });

  it('G: メトロポリス化できる都市が無いとLv4を買えない', async () => {
    const { canBuildImprovement } = await import('../src/engine/citiesKnights');
    const vids = Object.keys(ck().vertices);
    // 都市はあるが、それが既に他ツリーのメトロポリス（平の都市なし）。science Lv3→4 を買えない。
    const s = ck({
      metropolis: { trade: { playerId: 'player1', vertexId: vids[0]! } },
      vertices: { ...ck().vertices, [vids[0]!]: { ...ck().vertices[vids[0]!]!, building: { type: 'city' as const, playerId: 'player1', metropolis: true } } },
      players: { ...ck().players, player1: makePlayer('player1', { improvements: { trade: 4, politics: 0, science: 3 }, commodities: { coin: 0, cloth: 0, paper: 9 } }) },
    }) as GameState;
    expect(canBuildImprovement(s, 'player1', 'science')).toBe(false); // 平の都市が無い
  });

  it('I: 相手の騎士は最長交易路を分断しない（分断するのは相手の建物だけ）', async () => {
    const { calcLongestRoad } = await import('../src/engine/scoring');
    const g = ck();
    // 連続する3頂点 v1-v2-v3 を結ぶ2辺に player1 の道を敷く。
    const e1 = Object.keys(g.edges)[0]!;
    const v2 = g.edges[e1]!.vertexIds[1]!;
    const e2 = g.vertices[v2]!.adjacentEdgeIds.find(e => e !== e1 && (g.edges[e]!.vertexIds.includes(v2)))!;
    const base: GameState = {
      ...g,
      edges: { ...g.edges, [e1]: { ...g.edges[e1]!, road: { playerId: 'player1' } }, [e2]: { ...g.edges[e2]!, road: { playerId: 'player1' } } },
    };
    expect(calcLongestRoad(base, 'player1')).toBe(2); // 2本つながる
    // v2 に相手の騎士 → 公式ルール通り、騎士では分断されず最長2のまま。
    const knightBlocked = { ...base, vertices: { ...base.vertices, [v2]: { ...base.vertices[v2]!, knight: { playerId: 'player2', strength: 1, active: false } } } } as GameState;
    expect(calcLongestRoad(knightBlocked, 'player1')).toBe(2);
    // v2 に相手の建物 → 分断され最長1。
    const bldBlocked = { ...base, vertices: { ...base.vertices, [v2]: { ...base.vertices[v2]!, building: { type: 'settlement', playerId: 'player2' } } } } as GameState;
    expect(calcLongestRoad(bldBlocked, 'player1')).toBe(1);
  });

  it('H: 勝利点カード(印刷機/憲法)は手札上限の対象外で、5枚目を引ける', async () => {
    const { applyEventDie, buildProgressDecks } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    // VPカード4枚＋非VP0枚の手札 → 非VPは0枚なので、上限(4)未満として引ける。
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `vp${i}`, type: 'printer' as const, deck: 'science' as const }));
    let drew = false;
    for (let seed = 1; seed <= 200 && !drew; seed++) {
      const s = ck({
        progressDecks: buildProgressDecks(createRng(seed)),
        players: { ...ck().players, player1: makePlayer('player1', { improvements: { trade: 0, politics: 0, science: 5 }, progressCards: four }) },
      }) as GameState;
      const r = applyEventDie(s, createRng(seed), 1);
      if (r.lastEventDie === 'science') drew = ((r.players.player1!.progressCards ?? []).length) > 4;
    }
    expect(drew).toBe(true); // VPカードは上限に数えないので引ける
  });

  it('F: セットアップ2個目は都市になり、資源+商品を初期産出する', async () => {
    const { createInitialGameState } = await import('../src/engine/createState');
    const { chooseAction } = await import('../src/engine/ai');
    const { applyAction } = await import('../src/engine/game');
    const { createRng } = await import('../src/engine/setup');
    const rng = createRng(42);
    let s = createInitialGameState(
      [{ id: 'player1', name: 'A', color: 'red', type: 'ai', aiDifficulty: 'strong' }, { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'strong' }],
      'fixed', ['player1', 'player2'], rng, 'cities_knights',
    );
    let g = 0;
    while ((s.phase === 'SETUP_FORWARD' || s.phase === 'SETUP_BACKWARD') && g < 60) {
      const pid = s.playerOrder[s.currentPlayerIndex]!;
      const a = chooseAction(s, pid, { rng });
      if (!a) break;
      s = applyAction(s, a, rng);
      g++;
    }
    const cities = Object.values(s.vertices).filter(v => v.building?.type === 'city').length;
    const setts = Object.values(s.vertices).filter(v => v.building?.type === 'settlement').length;
    expect(cities).toBe(2);  // 各自 都市1
    expect(setts).toBe(2);   // 各自 開拓地1
    expect(s.players.player1!.remainingCities).toBe(3);       // 4-1
    expect(s.players.player1!.remainingSettlements).toBe(4);  // 5-1
  });
});

describe('C&K 商人カード: 手動タイル選択', () => {
  // player1 の建物を「2つ以上の資源タイルに隣接する頂点」に置き、商人カードを持たせた状態。
  async function merchantState(): Promise<{ s: GameState; vid: string; resTiles: string[] }> {
    const { TILE_RESOURCE_MAP } = await import('../src/constants');
    const g = makeGameState({ expansion: 'cities_knights' } as Partial<GameState>);
    // 隣接資源タイルが2つ以上ある頂点を探す。
    let vid = '', resTiles: string[] = [];
    for (const v of Object.values(g.vertices)) {
      const rs = v.adjacentTileIds.filter(t => g.tiles[t] && TILE_RESOURCE_MAP[g.tiles[t]!.type] != null);
      if (rs.length >= 2) { vid = v.id; resTiles = rs; break; }
    }
    const s: GameState = {
      ...g,
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', currentPlayerIndex: 0, diceRolledThisTurn: true,
      players: {
        ...g.players,
        player1: makePlayer('player1', { progressCards: [{ id: 'm1', type: 'merchant', deck: 'trade' }] }),
      },
      vertices: { ...g.vertices, [vid]: { ...g.vertices[vid]!, building: { type: 'settlement', playerId: 'player1' } } },
    };
    return { s, vid, resTiles };
  }

  it('merchantTileIds は自分の建物に隣接する資源タイルを返す', async () => {
    const { merchantTileIds } = await import('../src/engine/citiesKnights');
    const { s, resTiles } = await merchantState();
    const ids = new Set(merchantTileIds(s, 'player1'));
    for (const t of resTiles) expect(ids.has(t)).toBe(true);
  });

  it('choice.merchantTileId で指定したタイルに商人を置く（自動選択しない）', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { s, resTiles } = await merchantState();
    // pip最大でない方（resTiles[1]）を敢えて選ぶ → 自動(best)と区別できる。
    const chosen = resTiles[resTiles.length - 1]!;
    const r = applyAction(s, { type: 'PLAY_PROGRESS', cardId: 'm1', choice: { merchantTileId: chosen } });
    expect(r.merchant).toEqual({ playerId: 'player1', tileId: chosen });
    expect((r.players.player1!.progressCards ?? []).length).toBe(0); // カードは消費
  });

  it('候補外の merchantTileId は無効として自動配置にフォールバック', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { merchantTileIds } = await import('../src/engine/citiesKnights');
    const { s } = await merchantState();
    const valid = new Set(merchantTileIds(s, 'player1'));
    const bogus = Object.keys(s.tiles).find(t => !valid.has(t))!; // 隣接でないタイル
    const r = applyAction(s, { type: 'PLAY_PROGRESS', cardId: 'm1', choice: { merchantTileId: bogus } });
    expect(r.merchant).not.toBeNull();
    expect(valid.has(r.merchant!.tileId)).toBe(true); // 候補内に自動配置
  });
});

describe('C&K 進歩カードの手動選択（クレーン/僧正/外交官/脱走兵）', () => {
  function ck(extra: (g: GameState) => GameState): GameState {
    const g = makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1'), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    return extra(g);
  }

  it('crane: choice.craneTrack で指定したトラックを1段上げる', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck(g => {
      const cityVid = Object.keys(g.vertices)[0]!;
      return {
        ...g,
        players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'cr', type: 'crane', deck: 'science' }], commodities: { coin: 9, cloth: 9, paper: 9 }, improvements: { trade: 0, politics: 0, science: 0 } }) },
        vertices: { ...g.vertices, [cityVid]: { ...g.vertices[cityVid]!, building: { type: 'city', playerId: 'player1' } } },
      };
    });
    const r = playProgress(s, 'player1', 'cr', createRng(1), { craneTrack: 'politics' });
    expect(r.players.player1!.improvements!.politics).toBe(1);
    expect(r.players.player1!.improvements!.trade).toBe(0);
  });

  it('deserter: choice.deserterVertexId で指定した相手の騎士を消す', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck(g => {
      const kv = Object.keys(g.vertices)[3]!;
      return {
        ...g,
        players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'de', type: 'deserter', deck: 'politics' }] }) },
        vertices: { ...g.vertices, [kv]: { ...g.vertices[kv]!, knight: { playerId: 'player2', strength: 2, active: false } } },
      };
    });
    const kv = Object.keys(s.vertices).find(v => s.vertices[v]!.knight?.playerId === 'player2')!;
    const r = playProgress(s, 'player1', 'de', createRng(1), { deserterVertexId: kv });
    expect(r.vertices[kv]!.knight ?? null).toBeNull();
  });

  it('diplomat: choice.diplomatEdgeId で指定した相手の端の道を撤去', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck(g => {
      const eid = Object.keys(g.edges)[0]!;
      return {
        ...g,
        players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'dp', type: 'diplomat', deck: 'politics' }] }) },
        edges: { ...g.edges, [eid]: { ...g.edges[eid]!, road: { playerId: 'player2' } } },
      };
    });
    const eid = Object.keys(s.edges).find(e => s.edges[e]!.road?.playerId === 'player2')!;
    const r = playProgress(s, 'player1', 'dp', createRng(1), { diplomatEdgeId: eid });
    expect(r.edges[eid]!.road ?? null).toBeNull();
  });

  it('bishop: choice.bishopTileId で指定したタイルへ盗賊を置く', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ck(g => ({
      ...g,
      players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'bp', type: 'bishop', deck: 'politics' }] }) },
    }));
    const tid = Object.values(s.tiles).find(t => t.type !== 'sea' && !t.hasRobber)!.id;
    const r = playProgress(s, 'player1', 'bp', createRng(1), { bishopTileId: tid });
    expect(r.tiles[tid]!.hasRobber).toBe(true);
  });
});

describe('C&K 医術の手動選択', () => {
  it('medicine: choice.medicineVertexId で指定した開拓地を都市に格上げ（麦1鉱石2）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const { makeHand } = await import('../src/constants');
    const g = makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1', { progressCards: [{ id: 'md', type: 'medicine', deck: 'science' }], hand: makeHand({ grain: 2, ore: 3 }) }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const vids = Object.keys(g.vertices);
    const a = vids[2]!, b = vids[8]!;
    const s: GameState = {
      ...g,
      vertices: {
        ...g.vertices,
        [a]: { ...g.vertices[a]!, building: { type: 'settlement', playerId: 'player1' } },
        [b]: { ...g.vertices[b]!, building: { type: 'settlement', playerId: 'player1' } },
      },
    };
    const r = playProgress(s, 'player1', 'md', createRng(1), { medicineVertexId: b });
    expect(r.vertices[b]!.building!.type).toBe('city');     // 指定した開拓地が都市に
    expect(r.vertices[a]!.building!.type).toBe('settlement'); // もう一方はそのまま
    expect(r.players.player1!.hand.grain).toBe(1);          // 麦1支払い
    expect(r.players.player1!.hand.ore).toBe(1);            // 鉱石2支払い
  });
});

describe('C&K クレーンのコスト割引', () => {
  it('クレーンは通常より商品1個安い（trade Lv2→3: 通常3 → クレーン2）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const g = makeGameState({
      expansion: 'cities_knights',
      players: { player1: makePlayer('player1', { progressCards: [{ id: 'cr', type: 'crane', deck: 'science' }], commodities: { coin: 0, cloth: 5, paper: 0 }, improvements: { trade: 2, politics: 0, science: 0 } }), player2: makePlayer('player2') },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const cityVid = Object.keys(g.vertices)[0]!;
    const s: GameState = { ...g, vertices: { ...g.vertices, [cityVid]: { ...g.vertices[cityVid]!, building: { type: 'city', playerId: 'player1' } } } };
    const r = playProgress(s, 'player1', 'cr', createRng(1), { craneTrack: 'trade' });
    expect(r.players.player1!.improvements!.trade).toBe(3);
    expect(r.players.player1!.commodities!.cloth).toBe(3); // 5 - (improvementCost(2)=3 - 割引1 = 2)
  });
});

describe('C&K 進歩カードの手動選択（追加6種）', () => {
  function ckGame(extra: (g: GameState) => GameState): GameState {
    const g = makeGameState({
      expansion: 'cities_knights',
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', diceRolledThisTurn: true, currentPlayerIndex: 0,
      players: { player1: makePlayer('player1'), player2: makePlayer('player2'), player3: makePlayer('player3') },
      playerOrder: ['player1', 'player2', 'player3'],
    } as Partial<GameState>);
    return extra(g);
  }

  it('商業港: 渡す資源と取る商品を指名（持たない相手とは不成立）', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ckGame(g => ({
      ...g,
      players: {
        ...g.players,
        player1: makePlayer('player1', { progressCards: [{ id: 'ch', type: 'commercial_harbor', deck: 'trade' }], hand: makeHand({ wood: 2, ore: 1 }), commodities: { coin: 0, cloth: 0, paper: 0 } }),
        player2: makePlayer('player2', { commodities: { coin: 0, cloth: 2, paper: 0 } }),
        player3: makePlayer('player3', { commodities: { coin: 0, cloth: 0, paper: 0 } }),
      },
    }));
    const r = playProgress(s, 'player1', 'ch', createRng(1), { commercialGive: 'wood', commercialTake: 'cloth' });
    expect(r.players.player1!.hand.wood).toBe(1);          // 布を持つ player2 にだけ木1を渡す
    expect(r.players.player1!.hand.ore).toBe(1);           // 指名外の資源は減らない
    expect(r.players.player1!.commodities!.cloth).toBe(1);
    expect(r.players.player2!.hand.wood).toBe(1);
    expect(r.players.player2!.commodities!.cloth).toBe(1);
  });

  it('商船隊: 2:1で交易する種類を指名できる', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ckGame(g => ({ ...g, players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'mf', type: 'merchant_fleet', deck: 'trade' }] }) } }));
    const r = playProgress(s, 'player1', 'mf', createRng(1), { fleetType: 'ore' });
    expect(r.players.player1!.merchantFleetType).toBe('ore');
  });

  it('鍛冶屋: 指定した自分の騎士（最大2体）だけ昇格', async () => {
    const { playProgress, smithKnightTargets } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s0 = ckGame(g => ({ ...g, players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'sm', type: 'smith', deck: 'science' }] }) } }));
    const vids = Object.keys(s0.vertices).slice(0, 3);
    const s: GameState = { ...s0, vertices: {
      ...s0.vertices,
      [vids[0]!]: { ...s0.vertices[vids[0]!]!, knight: { playerId: 'player1', strength: 1, active: false } },
      [vids[1]!]: { ...s0.vertices[vids[1]!]!, knight: { playerId: 'player1', strength: 1, active: false } },
      [vids[2]!]: { ...s0.vertices[vids[2]!]!, knight: { playerId: 'player1', strength: 2, active: false } },
    } };
    expect(new Set(smithKnightTargets(s, 'player1'))).toEqual(new Set(vids));
    const r = playProgress(s, 'player1', 'sm', createRng(1), { smithVertexIds: [vids[1]!, vids[2]!] });
    expect(r.vertices[vids[0]!]!.knight!.strength).toBe(1); // 据え置き
    expect(r.vertices[vids[1]!]!.knight!.strength).toBe(2);
    expect(r.vertices[vids[2]!]!.knight!.strength).toBe(3);
  });

  it('技師: 指定した自分の都市にだけ城壁を建てる', async () => {
    const { playProgress, engineerWallCities } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s0 = ckGame(g => ({ ...g, players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'en', type: 'engineer', deck: 'science' }] }) } }));
    const vids = Object.keys(s0.vertices).slice(0, 2);
    const s: GameState = { ...s0, vertices: {
      ...s0.vertices,
      [vids[0]!]: { ...s0.vertices[vids[0]!]!, building: { type: 'city', playerId: 'player1' } },
      [vids[1]!]: { ...s0.vertices[vids[1]!]!, building: { type: 'city', playerId: 'player1' } },
    } };
    expect(new Set(engineerWallCities(s, 'player1'))).toEqual(new Set(vids));
    const r = playProgress(s, 'player1', 'en', createRng(1), { engineerVertexId: vids[1]! });
    expect((r.vertices[vids[1]!]!.building as { wall?: boolean }).wall).toBe(true);
    expect((r.vertices[vids[0]!]!.building as { wall?: boolean }).wall ?? false).toBe(false);
  });

  it('陰謀: 自分の道に隣接する指定した敵騎士を退去', async () => {
    const { playProgress, intrigueKnightTargets } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s0 = ckGame(g => ({ ...g, players: { ...g.players, player1: makePlayer('player1', { progressCards: [{ id: 'in', type: 'intrigue', deck: 'politics' }] }) } }));
    const enemyVids = Object.keys(s0.vertices).filter(vid => (s0.vertices[vid]!.adjacentEdgeIds?.length ?? 0) > 0).slice(0, 2);
    let s: GameState = s0;
    for (const vid of enemyVids) {
      const eid = s.vertices[vid]!.adjacentEdgeIds[0]!;
      s = { ...s,
        vertices: { ...s.vertices, [vid]: { ...s.vertices[vid]!, knight: { playerId: 'player2', strength: 1, active: true } } },
        edges: { ...s.edges, [eid]: { ...s.edges[eid]!, road: { playerId: 'player1' } } },
      };
    }
    expect(new Set(intrigueKnightTargets(s, 'player1'))).toEqual(new Set(enemyVids));
    const r = playProgress(s, 'player1', 'in', createRng(1), { intrigueVertexId: enemyVids[1]! });
    expect(r.vertices[enemyVids[1]!]!.knight).toBeNull();
    expect(r.vertices[enemyVids[0]!]!.knight).not.toBeNull();
  });

  it('外交官: 自分の道も撤去候補。撤去するとコマが戻り無料で建て直せる', async () => {
    const { playProgress, diplomatRemovableRoads } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const g = ckGame(x => ({ ...x, players: { ...x.players, player1: makePlayer('player1', { progressCards: [{ id: 'dp', type: 'diplomat', deck: 'politics' }] }) } }));
    const eids = Object.keys(g.edges);
    const mine = eids[0]!;
    const homeVid = g.edges[mine]!.vertexIds[0]!; // mine の片端に自分の開拓地（再建設の足場）。
    // mine と頂点を共有しない孤立辺を相手の道に（両方とも端の道＝撤去候補）。
    const theirs = eids.find(e => e !== mine && !g.edges[e]!.vertexIds.some(v => g.edges[mine]!.vertexIds.includes(v)))!;
    const s: GameState = { ...g,
      vertices: { ...g.vertices, [homeVid]: { ...g.vertices[homeVid]!, building: { type: 'settlement', playerId: 'player1' } } },
      edges: { ...g.edges,
        [mine]: { ...g.edges[mine]!, road: { playerId: 'player1' } },
        [theirs]: { ...g.edges[theirs]!, road: { playerId: 'player2' } },
      } };
    expect(new Set(diplomatRemovableRoads(s, 'player1'))).toEqual(new Set([mine, theirs])); // 自分の道も候補に含む
    const roadsBefore = s.players.player1!.remainingRoads;
    const r = playProgress(s, 'player1', 'dp', createRng(1), { diplomatEdgeId: mine });
    expect(r.edges[mine]!.road).toBeNull();                          // 自分の道を撤去
    expect(r.players.player1!.remainingRoads).toBe(roadsBefore + 1); // コマが手元に戻る
    expect(r.roadBuildingRoadsRemaining).toBe(1);                    // 別の場所へ無料で1本建て直せる
  });

  it('スパイ: 盗む相手と札を指名できる', async () => {
    const { playProgress } = await import('../src/engine/citiesKnights');
    const { createRng } = await import('../src/engine/setup');
    const s = ckGame(g => ({
      ...g,
      players: {
        ...g.players,
        player1: makePlayer('player1', { progressCards: [{ id: 'sp', type: 'spy', deck: 'politics' }] }),
        player2: makePlayer('player2', { progressCards: [{ id: 'a', type: 'smith', deck: 'science' }, { id: 'b', type: 'crane', deck: 'science' }] }),
        player3: makePlayer('player3', { progressCards: [{ id: 'c', type: 'warlord', deck: 'politics' }] }),
      },
    }));
    const r = playProgress(s, 'player1', 'sp', createRng(1), { spyTargetPlayerId: 'player2', spyCardId: 'b' });
    expect((r.players.player1!.progressCards ?? []).map(c => c.id)).toEqual(['b']);
    expect((r.players.player2!.progressCards ?? []).map(c => c.id)).toEqual(['a']);
    expect((r.players.player3!.progressCards ?? []).length).toBe(1); // 指名外は不変
  });
});

describe('C&K 進歩カード使用の公開（lastProgressPlay）', () => {
  // 進歩カードを使うと「誰が何を使ったか」は公開情報。LANで使用者の手札が秘匿されても
  // 他プレイヤーが盤面演出（showPlayedProgressCard）を出せるよう、state に公開で載る。
  it('PLAY_PROGRESS で lastProgressPlay に使用者と札種が載り、マスクしても残る', async () => {
    const { applyAction } = await import('../src/engine/game');
    const { maskStateFor } = await import('../src/engine/mask');
    const { createRng } = await import('../src/engine/setup');
    const g = makeGameState({
      expansion: 'cities_knights',
      phase: 'MAIN', turnPhase: 'TRADE_BUILD', diceRolledThisTurn: true, currentPlayerIndex: 0,
      players: {
        player1: makePlayer('player1', { progressCards: [{ id: 'pr', type: 'printer', deck: 'science' }] }),
        player2: makePlayer('player2'),
      },
      playerOrder: ['player1', 'player2'],
    } as Partial<GameState>);
    const r = applyAction(g, { type: 'PLAY_PROGRESS', cardId: 'pr' }, createRng(1));
    expect(r.lastProgressPlay).toEqual({ playerId: 'player1', cardType: 'printer' });
    // 相手視点のマスク済み state でも札種は公開のまま（盤面演出に必須）。
    const masked = maskStateFor(r, 'player2');
    expect(masked.lastProgressPlay).toEqual({ playerId: 'player1', cardType: 'printer' });
    // 使用者の手札（進歩カード）は相手視点では秘匿されたまま。
    expect(masked.players.player1!.progressCards).toEqual([]);
  });
});
