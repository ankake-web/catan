// ============================================================
// tests/tb_catan_for_two.test.ts — 交易と蛮族「Catan for Two（2人用）」変種（CN3089 p7）
// ============================================================
//
// 仕様値（trade token 20/初期5・砂漠2/沿岸1・騎士捨て2・コスト1/2・生産2回・中立2人と
// 図示位置の初期開拓地・中立の無償建設と最長交易路資格）をテストで固定する。
// 出典と実装解釈は docs/交易と蛮族_仕様書_v6.md §2-4。

import { describe, it, expect } from 'vitest';
import { applyAction } from '../src/engine/game';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { canBuildSettlement, canBuildRoad } from '../src/engine/actions';
import { updateLongestRoad } from '../src/engine/scoring';
import { distributeResources } from '../src/engine/dice';
import {
  tbTwoNeutralStartVertices, tbTokensForSettlement, tbGrantTokens, tbSpendCost,
  tbNeutralRoadTargets, tbNeutralSettlementTargets, isTbNeutral,
} from '../src/engine/tbTwo';
import {
  TB2_TRADE_TOKEN_TOTAL, TB2_TRADE_TOKEN_START, TB2_TOKENS_DESERT, TB2_TOKENS_COAST,
  TB2_TOKENS_KNIGHT_DISCARD, TB2_SPEND_COST_BEHIND, TB2_SPEND_COST_AHEAD, makeHand,
  TILE_RESOURCE_MAP,
} from '../src/constants';
import { makeGameState, makePlayer } from './helpers';
import type { GameState, PlayerId, VertexId, EdgeId } from '../src/types';

const SPECS2: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red', type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'ai', aiDifficulty: 'strong' },
];

function newGame(seed = 7): GameState {
  return createInitialGameState(SPECS2, 'fixed', ['player1', 'player2'], createRng(seed), 'tb_catan_for_two');
}

/** ダイス列を固定する rng（rollDice は floor(v*6)+1）。使い切ったら 0 を返す。 */
function diceRng(dice: number[]): () => number {
  const q = dice.map(d => (d - 1) / 6);
  return () => q.shift() ?? 0;
}

/** makeGameState ベースの Catan for Two 状態（中立2人＋図示位置の初期開拓地＋トークン）。 */
function tb2State(partial: Partial<GameState> = {}): GameState {
  const base = makeGameState();
  const [vRight, vLeft] = tbTwoNeutralStartVertices({ tileToVertices: base.tileToVertices }) as [VertexId, VertexId];
  return {
    ...base,
    players: {
      ...base.players,
      player3: makePlayer('player3', { type: 'neutral', color: 'purple', remainingCities: 0, remainingSettlements: 4 }),
      player4: makePlayer('player4', { type: 'neutral', color: 'orange', remainingCities: 0, remainingSettlements: 4 }),
    },
    vertices: {
      ...base.vertices,
      [vRight]: { ...base.vertices[vRight]!, building: { type: 'settlement', playerId: 'player3' } },
      [vLeft]: { ...base.vertices[vLeft]!, building: { type: 'settlement', playerId: 'player4' } },
    },
    tbCatanForTwo: true,
    tbNeutralPlayerIds: ['player3', 'player4'],
    tbTradeTokens: { player1: 5, player2: 5 },
    tbTradeTokenBank: 10,
    tbNeutralPending: null,
    tbRollsDone: 2, // TRADE_BUILD 既定（生産2回済み）
    tbFirstRollTotal: null,
    tbTradeTokenSpentThisTurn: false,
    tbKnightTokenThisTurn: false,
    ...partial,
  };
}

/** 頂点に隣接する自分の道が置ける空き辺（テスト用の最初の1本）。 */
function edgeNextTo(state: GameState, vertexId: VertexId): EdgeId {
  const v = state.vertices[vertexId]!;
  const eid = v.adjacentEdgeIds.find(e => state.edges[e]!.road == null);
  expect(eid).toBeDefined();
  return eid!;
}

describe('Catan for Two: 仕様定数', () => {
  it('trade token 20・初期配布5・砂漠2/沿岸1・騎士捨て2・コスト1/2（CN3089 p7）', () => {
    expect(TB2_TRADE_TOKEN_TOTAL).toBe(20);
    expect(TB2_TRADE_TOKEN_START).toBe(5);
    expect(TB2_TOKENS_DESERT).toBe(2);
    expect(TB2_TOKENS_COAST).toBe(1);
    expect(TB2_TOKENS_KNIGHT_DISCARD).toBe(2);
    expect(TB2_SPEND_COST_BEHIND).toBe(1);
    expect(TB2_SPEND_COST_AHEAD).toBe(2);
  });
});

describe('Catan for Two: セットアップ（createInitialGameState）', () => {
  it('中立2人（残り2色・type=neutral）が players に居て playerOrder には入らない', () => {
    const s = newGame();
    expect(s.tbCatanForTwo).toBe(true);
    expect(s.playerOrder).toEqual(['player1', 'player2']);
    expect(s.tbNeutralPlayerIds).toEqual(['player3', 'player4']);
    expect(s.players.player3!.type).toBe('neutral');
    expect(s.players.player4!.type).toBe('neutral');
    // 残り2色（実プレイヤーが red/blue なので purple/orange）
    expect(new Set([s.players.player3!.color, s.players.player4!.color])).toEqual(new Set(['purple', 'orange']));
    expect(isTbNeutral(s, 'player3')).toBe(true);
    expect(isTbNeutral(s, 'player1')).toBe(false);
  });

  it('中立の初期開拓地は図示位置＝盤中心から水平±2ヘックスの2交点（道なし・各1つ）', () => {
    const s = newGame();
    const verts = tbTwoNeutralStartVertices({ tileToVertices: s.tileToVertices });
    expect(verts).toHaveLength(2);
    // 右={1,0}∩{1,-1}∩{2,-1} ／ 左={-1,0}∩{-1,1}∩{-2,1} の共有頂点（仕様書§2-4 図版確定）
    expect(new Set(s.vertices[verts[0]!]!.adjacentTileIds)).toEqual(new Set(['1,0', '1,-1', '2,-1']));
    expect(new Set(s.vertices[verts[1]!]!.adjacentTileIds)).toEqual(new Set(['-1,0', '-1,1', '-2,1']));
    const owners = verts.map(v => s.vertices[v]!.building?.playerId).sort();
    expect(owners).toEqual(['player3', 'player4']);
    for (const v of verts) expect(s.vertices[v]!.building?.type).toBe('settlement');
    // 道なし＝中立の道は0本・開拓地コマは1つ消費
    for (const nid of ['player3', 'player4'] as PlayerId[]) {
      expect(Object.values(s.edges).some(e => e.road?.playerId === nid)).toBe(false);
      expect(s.players[nid]!.remainingSettlements).toBe(4);
    }
  });

  it('trade token: 各自5・供給10（=20-5×2）', () => {
    const s = newGame();
    expect(s.tbTradeTokens).toEqual({ player1: 5, player2: 5 });
    expect(s.tbTradeTokenBank).toBe(TB2_TRADE_TOKEN_TOTAL - TB2_TRADE_TOKEN_START * 2);
  });

  it('実プレイヤー2人以外はエラー（公式: 2人専用）', () => {
    const specs3: PlayerSpec[] = [...SPECS2, { id: 'player3', name: 'C', color: 'purple', type: 'ai' }];
    expect(() =>
      createInitialGameState(specs3, 'fixed', ['player1', 'player2', 'player3'], createRng(1), 'tb_catan_for_two'),
    ).toThrow(/exactly 2 players/);
  });

  it('中立の初期開拓地は距離ルールで周囲を塞ぐ（隣接頂点に初期配置できない）', () => {
    const s = newGame();
    const [vRight] = tbTwoNeutralStartVertices({ tileToVertices: s.tileToVertices });
    for (const nv of s.vertices[vRight!]!.adjacentVertexIds) {
      expect(canBuildSettlement(s, 'player1', nv)).toBe(false);
    }
  });
});

describe('Catan for Two: trade token の取得（開拓地の位置）', () => {
  it('砂漠に隣接=2・沿岸=1・両方=3・どちらでもない=0', () => {
    let s = tb2State();
    // 盤の任意タイルを砂漠に差し替えて判定を固定する（内陸 0,0 と 角 2,-2）
    s = {
      ...s,
      tiles: {
        ...s.tiles,
        '0,0': { ...s.tiles['0,0']!, type: 'desert', number: null },
        '2,-2': { ...s.tiles['2,-2']!, type: 'desert', number: null },
      },
    };
    // 内陸の砂漠頂点（隣接3タイル）= 2
    const inlandDesertV = Object.values(s.vertices).find(v =>
      v.adjacentTileIds.includes('0,0') && v.adjacentTileIds.length === 3)!;
    expect(tbTokensForSettlement(s, inlandDesertV.id)).toBe(TB2_TOKENS_DESERT);
    // 角の砂漠の外周頂点（隣接タイル<3）= 2+1=3
    const coastalDesertV = Object.values(s.vertices).find(v =>
      v.adjacentTileIds.includes('2,-2') && v.adjacentTileIds.length < 3)!;
    expect(tbTokensForSettlement(s, coastalDesertV.id)).toBe(TB2_TOKENS_DESERT + TB2_TOKENS_COAST);
    // 砂漠に接しない外周頂点 = 1
    const coastV = Object.values(s.vertices).find(v =>
      v.adjacentTileIds.length < 3 && !v.adjacentTileIds.some(t => s.tiles[t]!.type === 'desert'))!;
    expect(tbTokensForSettlement(s, coastV.id)).toBe(TB2_TOKENS_COAST);
    // 内陸・非砂漠 = 0
    const inlandV = Object.values(s.vertices).find(v =>
      v.adjacentTileIds.length === 3 && !v.adjacentTileIds.some(t => s.tiles[t]!.type === 'desert'))!;
    expect(tbTokensForSettlement(s, inlandV.id)).toBe(0);
  });

  it('付与は供給残で頭打ち・供給0なら増えない', () => {
    let s = tb2State({ tbTradeTokenBank: 1 });
    s = tbGrantTokens(s, 'player1', 2);
    expect(s.tbTradeTokens!.player1).toBe(6);
    expect(s.tbTradeTokenBank).toBe(0);
    const s2 = tbGrantTokens(s, 'player1', 2);
    expect(s2.tbTradeTokens!.player1).toBe(6);
  });

  it('初期配置（SETUP）の開拓地でもトークンが付く（沿岸の例）', () => {
    let s = newGame();
    const pid = s.playerOrder[0]!;
    const before = s.tbTradeTokens![pid]!;
    // 沿岸（外周）の合法頂点に1軒目を置く
    const coastal = Object.keys(s.vertices).find(vid =>
      s.vertices[vid]!.adjacentTileIds.length < 3
      && !s.vertices[vid]!.adjacentTileIds.some(t => s.tiles[t]!.type === 'desert')
      && canBuildSettlement(s, pid, vid))!;
    s = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: coastal });
    expect(s.tbTradeTokens![pid]).toBe(before + TB2_TOKENS_COAST);
  });
});

describe('Catan for Two: 生産フェーズ×2回', () => {
  function preRollState(partial: Partial<GameState> = {}): GameState {
    return tb2State({
      turnPhase: 'PRE_ROLL',
      diceRolledThisTurn: false,
      lastDiceRoll: null,
      tbRollsDone: 0,
      tbFirstRollTotal: null,
      ...partial,
    });
  }

  it('1回目のロール後は PRE_ROLL に戻り、2回目の後で TRADE_BUILD へ', () => {
    let s = preRollState();
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([2, 3])); // 合計5
    expect(s.turnPhase).toBe('PRE_ROLL');
    expect(s.tbRollsDone).toBe(1);
    expect(s.tbFirstRollTotal).toBe(5);
    expect(s.diceRolledThisTurn).toBe(true);
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([4, 2])); // 合計6
    expect(s.turnPhase).toBe('TRADE_BUILD');
    expect(s.tbRollsDone).toBe(2);
    // 3回目は振れない（TRADE_BUILD では ROLL_DICE 不可）
    expect(() => applyAction(s, { type: 'ROLL_DICE' }, diceRng([1, 1]))).toThrow();
  });

  it('2回目は1回目と同じ合計が出たら異なる合計まで振り直す', () => {
    let s = preRollState();
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([2, 3])); // 5
    // 2回目: (1,4)=5 → 振り直し → (2,4)=6 が採用される
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([1, 4, 2, 4]));
    expect(s.lastDiceRoll).toEqual([2, 4]);
    expect(s.turnPhase).toBe('TRADE_BUILD');
  });

  it('両方の生産で資源が別々に配られる（1回目=5・2回目=6で各1枚・種別固定）', () => {
    let s = preRollState();
    // 盤上の 5/6 を各1枚に限定（他の 5/6 は 3 に潰す）。こうすると各生産で1タイルだけ産出し、
    // 「1回目の出目だけで手札が増えて2回目が検証されない」偽陽性を排除できる。
    const tiles = { ...s.tiles };
    let t5: string | null = null, t6: string | null = null;
    for (const [id, t] of Object.entries(tiles)) {
      if (t.type === 'desert' || t.type === 'sea') continue;
      if (t.number === 5) { if (t5 === null) t5 = id; else tiles[id] = { ...t, number: 3 }; }
      if (t.number === 6) { if (t6 === null) t6 = id; else tiles[id] = { ...t, number: 3 }; }
    }
    if (!t5 || !t6) throw new Error('fixture: need a 5 and a 6 tile');
    s = { ...s, tiles };
    const r5 = TILE_RESOURCE_MAP[tiles[t5]!.type]!;
    const r6 = TILE_RESOURCE_MAP[tiles[t6]!.type]!;
    // 各開拓地は自分のタイルのみ産出させる（相手タイルに隣接しない頂点を選ぶ＝二重計上を避ける）。
    const v5 = s.tileToVertices[t5]!.find(v => !s.vertices[v]!.building
      && !s.vertices[v]!.adjacentTileIds.includes(t6!))!;
    const v6 = s.tileToVertices[t6]!.find(v => v !== v5 && !s.vertices[v]!.building
      && !s.vertices[v]!.adjacentTileIds.includes(t5!))!;
    s = {
      ...s,
      vertices: {
        ...s.vertices,
        [v5]: { ...s.vertices[v5]!, building: { type: 'settlement', playerId: 'player1' } },
        [v6]: { ...s.vertices[v6]!, building: { type: 'settlement', playerId: 'player1' } },
      },
    };
    const before = { ...s.players.player1!.hand };
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([2, 3])); // 合計5
    expect(s.turnPhase).toBe('PRE_ROLL'); // 1回目の後は2回目の生産へ戻る
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([2, 4])); // 合計6
    expect(s.turnPhase).toBe('TRADE_BUILD'); // 2回終えてアクションフェーズへ
    const after = s.players.player1!.hand;
    // r5 は1回目の5だけで+1、r6 は2回目の6だけで+1（別資源なら独立に確認できる）。
    if (r5 !== r6) {
      expect(after[r5]).toBe(before[r5] + 1);
      expect(after[r6]).toBe(before[r6] + 1);
    } else {
      expect(after[r5]).toBe(before[r5] + 2);
    }
  });

  it('1回目が7なら盗賊解決後に2回目の PRE_ROLL へ戻る（2回目は7以外に振り直し）', () => {
    let s = preRollState();
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([3, 4])); // 7（全員手札7枚以下=捨て札なし）
    expect(s.turnPhase).toBe('ROBBER');
    // 隣接建物の無いタイルへ移動（奪わない）
    const robberTile = Object.values(s.tiles).find(t => t.hasRobber)!;
    const target = Object.values(s.tiles).find(t =>
      t.id !== robberTile.id && t.type !== 'sea'
      && (s.tileToVertices[t.id] ?? []).every(v => !s.vertices[v]!.building))!;
    s = applyAction(s, { type: 'MOVE_ROBBER', tileId: target.id, stealFromPlayerId: null });
    expect(s.turnPhase).toBe('PRE_ROLL'); // 2回目の生産フェーズへ
    expect(s.tbRollsDone).toBe(1);
    // 2回目: 7,7 → 振り直し続け、(2,3)=5 が採用
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([3, 4, 4, 3, 2, 3]));
    expect(s.lastDiceRoll).toEqual([2, 3]);
    expect(s.turnPhase).toBe('TRADE_BUILD');
  });

  it('2つの生産フェーズの間には騎士カードを使えない', () => {
    let s = preRollState({
      players: {
        ...tb2State().players,
        player1: makePlayer('player1', {
          devCards: [{ id: 'k1', type: 'knight', purchasedOnTurn: 0 }],
        }),
      },
      globalTurnNumber: 2,
    });
    s = applyAction(s, { type: 'ROLL_DICE' }, diceRng([2, 3]));
    expect(s.turnPhase).toBe('PRE_ROLL');
    expect(() => applyAction(s, { type: 'PLAY_KNIGHT' })).toThrow(/between the two production phases/);
  });

  it('END_TURN で 2回制・トークンのターン内フラグがリセットされる', () => {
    let s = tb2State({
      tbRollsDone: 2, tbFirstRollTotal: 8,
      tbTradeTokenSpentThisTurn: true, tbKnightTokenThisTurn: true,
    });
    s = applyAction(s, { type: 'END_TURN' });
    expect(s.tbRollsDone).toBe(0);
    expect(s.tbFirstRollTotal).toBeNull();
    expect(s.tbTradeTokenSpentThisTurn).toBe(false);
    expect(s.tbKnightTokenThisTurn).toBe(false);
  });
});

describe('Catan for Two: 中立コマの無償建設', () => {
  /** player1 に道网と資源を与えた TRADE_BUILD 状態。 */
  function buildReady(partial: Partial<GameState> = {}): GameState {
    const s = tb2State(partial);
    return {
      ...s,
      players: {
        ...s.players,
        player1: { ...s.players.player1!, hand: makeHand({ wood: 5, brick: 5, wool: 3, grain: 3 }) },
      },
    };
  }

  it('道を建てると TB_NEUTRAL（road）になり、中立の道を無償で置いて TRADE_BUILD に戻る', () => {
    let s = buildReady();
    // player1 の開拓地＋接続辺を用意
    const v = Object.keys(s.vertices).find(vid => canBuildSettlement({ ...s, phase: 'SETUP_FORWARD' }, 'player1', vid))!;
    s = { ...s, vertices: { ...s.vertices, [v]: { ...s.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } } };
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: edgeNextTo(s, v) });
    expect(s.turnPhase).toBe('TB_NEUTRAL');
    expect(s.tbNeutralPending).toBe('road');
    // 配置待ち中は自分の建設もターン終了もできない
    expect(() => applyAction(s, { type: 'BUILD_ROAD', edgeId: 'x' })).toThrow(/neutral placement/);
    expect(() => applyAction(s, { type: 'END_TURN' })).toThrow();
    // 中立(player3)の初期開拓地に接続する辺へ無償配置
    const targets = tbNeutralRoadTargets(s, 'player3');
    expect(targets.length).toBeGreaterThan(0);
    const bankBefore = { ...s.bank };
    s = applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: targets[0]! });
    expect(s.turnPhase).toBe('TRADE_BUILD');
    expect(s.tbNeutralPending).toBeNull();
    expect(s.edges[targets[0]!]!.road?.playerId).toBe('player3');
    expect(s.players.player3!.remainingRoads).toBe(14);
    expect(s.bank).toEqual(bankBefore); // 無償（バンク不変）
  });

  it('中立の道は中立自身の道網に接続する位置のみ（実プレイヤーの網には置けない）', () => {
    let s = buildReady();
    const v = Object.keys(s.vertices).find(vid => canBuildSettlement({ ...s, phase: 'SETUP_FORWARD' }, 'player1', vid))!;
    s = { ...s, vertices: { ...s.vertices, [v]: { ...s.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } } };
    const myEdge = edgeNextTo(s, v);
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: myEdge });
    // player1 の網にしか接続しない辺は中立の合法手ではない
    const v2 = s.edges[myEdge]!.vertexIds.find(x => x !== v)!;
    const illegal = s.vertices[v2]!.adjacentEdgeIds.find(e => e !== myEdge && s.edges[e]!.road == null)!;
    expect(tbNeutralRoadTargets(s, 'player3')).not.toContain(illegal);
    expect(() => applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: illegal })).toThrow(/invalid/);
    // owner に実プレイヤーは指定できない
    const ok = tbNeutralRoadTargets(s, 'player3')[0]!;
    expect(() => applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player1', edgeId: ok })).toThrow(/not a neutral/);
  });

  it('開拓地を建てると中立の開拓地が優先、合法位置が無ければ中立の道で代替', () => {
    let s = buildReady();
    // player1: 開拓地→道2本で開拓地の合法位置を作る
    const v = Object.keys(s.vertices).find(vid => canBuildSettlement({ ...s, phase: 'SETUP_FORWARD' }, 'player1', vid))!;
    s = { ...s, vertices: { ...s.vertices, [v]: { ...s.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } } };
    const e1 = edgeNextTo(s, v);
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: e1 });
    s = applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: tbNeutralRoadTargets(s, 'player3')[0]! });
    const vMid = s.edges[e1]!.vertexIds.find(x => x !== v)!;
    const e2 = s.vertices[vMid]!.adjacentEdgeIds.find(e => e !== e1 && s.edges[e]!.road == null)!;
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: e2 });
    s = applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: tbNeutralRoadTargets(s, 'player3')[0]! });
    const vFar = s.edges[e2]!.vertexIds.find(x => x !== vMid)!;

    // 中立に開拓地の合法位置は無い（道1本では距離ルール上届かない）→ 自分の開拓地建設で road 代替。
    // ※ 核心アサーションを if で囲むと、フィクスチャがずれて偽になった時に黙ってスキップされ
    //   バグを検知すべき瞬間に検証が消える。前提を expect で固定してから必ず本体を実行する。
    expect(tbNeutralSettlementTargets(s, 'player3')).toHaveLength(0);
    expect(tbNeutralSettlementTargets(s, 'player4')).toHaveLength(0);
    expect(canBuildSettlement(s, 'player1', vFar)).toBe(true);
    const s2 = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: vFar });
    expect(s2.turnPhase).toBe('TB_NEUTRAL');
    expect(s2.tbNeutralPending).toBe('road'); // 開拓地が置けないので道で代替

    // 中立(player3)の道を伸ばして開拓地の合法位置を作ると、settlement が優先される
    let s3 = s;
    for (let i = 0; i < 2 && tbNeutralSettlementTargets(s3, 'player3').length === 0; i++) {
      const t = tbNeutralRoadTargets(s3, 'player3')[0]!;
      s3 = { ...s3, edges: { ...s3.edges, [t]: { ...s3.edges[t]!, road: { playerId: 'player3' } } } };
    }
    const settleTargets = tbNeutralSettlementTargets(s3, 'player3');
    expect(settleTargets.length).toBeGreaterThan(0);
    expect(canBuildSettlement(s3, 'player1', vFar)).toBe(true);
    let s4 = applyAction(s3, { type: 'BUILD_SETTLEMENT', vertexId: vFar });
    expect(s4.turnPhase).toBe('TB_NEUTRAL');
    expect(s4.tbNeutralPending).toBe('settlement');
    // 道で代替はできない（開拓地が置けるため）
    expect(() => applyAction(s4, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: tbNeutralRoadTargets(s4, 'player3')[0]! }))
      .toThrow(/settlement is pending/);
    const beforeS = s4.players.player3!.remainingSettlements;
    s4 = applyAction(s4, { type: 'TB_NEUTRAL_SETTLEMENT', owner: 'player3', vertexId: tbNeutralSettlementTargets(s4, 'player3')[0]! });
    expect(s4.turnPhase).toBe('TRADE_BUILD');
    expect(s4.players.player3!.remainingSettlements).toBe(beforeS - 1);
  });

  it('どちらの中立にも置ける場所が無ければスキップ（TB_NEUTRAL に入らない）', () => {
    let s = buildReady();
    // 中立の道コマを0にする（開拓地は初期1つのみ・道網が無いので開拓地の合法位置も無い）
    s = {
      ...s,
      players: {
        ...s.players,
        player3: { ...s.players.player3!, remainingRoads: 0 },
        player4: { ...s.players.player4!, remainingRoads: 0 },
      },
    };
    const v = Object.keys(s.vertices).find(vid => canBuildSettlement({ ...s, phase: 'SETUP_FORWARD' }, 'player1', vid))!;
    s = { ...s, vertices: { ...s.vertices, [v]: { ...s.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } } };
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: edgeNextTo(s, v) });
    expect(s.turnPhase).toBe('TRADE_BUILD'); // スキップ
    expect(s.tbNeutralPending ?? null).toBeNull();
  });

  it('セットアップ中の道/開拓地では中立建設は発動しない', () => {
    let s = newGame();
    const pid = s.playerOrder[0]!;
    const vid = Object.keys(s.vertices).find(v => canBuildSettlement(s, pid, v))!;
    s = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: vid });
    expect(s.turnPhase).not.toBe('TB_NEUTRAL');
    const eid = s.vertices[vid]!.adjacentEdgeIds[0]!;
    s = applyAction(s, { type: 'BUILD_ROAD', edgeId: eid });
    expect(s.turnPhase).not.toBe('TB_NEUTRAL');
  });
});

describe('Catan for Two: 最長交易路と中立', () => {
  it('中立も最長交易路タイルを獲得できる（5本以上・単独最長）', () => {
    let s = tb2State();
    // player3（中立）の初期開拓地から5本の連続道を直置き
    const start = Object.keys(s.vertices).find(v => s.vertices[v]!.building?.playerId === 'player3')!;
    let cur = start;
    const edges = { ...s.edges };
    const visited = new Set<string>([start]);
    for (let i = 0; i < 5; i++) {
      const v = s.vertices[cur]!;
      const eid = v.adjacentEdgeIds.find(e => {
        const other = edges[e]!.vertexIds.find(x => x !== cur)!;
        return edges[e]!.road == null && !visited.has(other);
      })!;
      edges[eid] = { ...edges[eid]!, road: { playerId: 'player3' } };
      cur = edges[eid]!.vertexIds.find(x => x !== cur)!;
      visited.add(cur);
    }
    s = updateLongestRoad({ ...s, edges });
    expect(s.longestRoadHolder).toBe('player3');
    expect(s.players.player3!.hasLongestRoad).toBe(true);
    expect(s.players.player1!.hasLongestRoad).toBe(false);
  });

  it('TB_NEUTRAL_ROAD 経由で中立の道を5本伸ばすと最長交易路が更新される（統合）', () => {
    // 単体（updateLongestRoad 直呼び）ではなく applyAction(TB_NEUTRAL_ROAD) 経由で検証。
    // ハンドラ内の updateLongestRoad(next) 呼び出しが効いていることを固定する（削除変異を殺す）。
    let s = tb2State({ turnPhase: 'TB_NEUTRAL', tbNeutralPending: 'road' });
    const start = Object.keys(s.vertices).find(v => s.vertices[v]!.building?.playerId === 'player3')!;
    let cur = start;
    const visited = new Set<string>([start]);
    for (let i = 0; i < 5; i++) {
      const v = s.vertices[cur]!;
      const eid = v.adjacentEdgeIds.find(e => {
        const other = s.edges[e]!.vertexIds.find(x => x !== cur)!;
        return s.edges[e]!.road == null && !visited.has(other) && canBuildRoad(s, 'player3', e);
      });
      expect(eid).toBeDefined();
      s = applyAction(s, { type: 'TB_NEUTRAL_ROAD', owner: 'player3', edgeId: eid! });
      cur = s.edges[eid!]!.vertexIds.find(x => x !== cur)!;
      visited.add(cur);
      // 次の中立の道を置くため、本来は自分の道建設が挟まる TB_NEUTRAL フェーズを再現。
      if (i < 4) s = { ...s, turnPhase: 'TB_NEUTRAL', tbNeutralPending: 'road' };
    }
    expect(s.players.player3!.longestRoadLength).toBeGreaterThanOrEqual(5);
    expect(s.longestRoadHolder).toBe('player3');
  });
});

describe('Catan for Two: trade token の消費', () => {
  it('TB_MOVE_ROBBER: 盗賊が砂漠へ移動し誰からも奪わない（VP同点=コスト1）', () => {
    let s = tb2State();
    // 盗賊を砂漠以外に置き直す
    const desert = Object.values(s.tiles).find(t => t.type === 'desert')!;
    const other = Object.values(s.tiles).find(t => t.type !== 'desert' && t.type !== 'sea')!;
    s = {
      ...s,
      tiles: {
        ...s.tiles,
        [desert.id]: { ...desert, hasRobber: false },
        [other.id]: { ...other, hasRobber: true },
      },
    };
    expect(tbSpendCost(s, 'player1')).toBe(TB2_SPEND_COST_BEHIND);
    const next = applyAction(s, { type: 'TB_MOVE_ROBBER' });
    expect(next.tiles[desert.id]!.hasRobber).toBe(true);
    expect(next.tiles[other.id]!.hasRobber).toBe(false);
    expect(next.tbTradeTokens!.player1).toBe(5 - TB2_SPEND_COST_BEHIND);
    expect(next.tbTradeTokenBank).toBe(10 + TB2_SPEND_COST_BEHIND); // 供給へ戻す
    expect(next.tbTradeTokenSpentThisTurn).toBe(true);
    // 1ターン1回
    expect(() => applyAction(next, { type: 'TB_FORCED_TRADE', give: {} })).toThrow(/already spent/);
    // 既に砂漠なら使えない
    expect(() => applyAction({ ...next, tbTradeTokenSpentThisTurn: false }, { type: 'TB_MOVE_ROBBER' }))
      .toThrow(/already on the desert/);
  });

  it('自分の公開VPが相手を上回っていればコスト2・トークン不足なら不可', () => {
    let s = tb2State();
    // player1 に開拓地1（公開VP 1 > 0）
    const v = Object.keys(s.vertices).find(vid => !s.vertices[vid]!.building)!;
    s = { ...s, vertices: { ...s.vertices, [v]: { ...s.vertices[v]!, building: { type: 'settlement', playerId: 'player1' } } } };
    expect(tbSpendCost(s, 'player1')).toBe(TB2_SPEND_COST_AHEAD);
    expect(tbSpendCost(s, 'player2')).toBe(TB2_SPEND_COST_BEHIND); // 負けている側は1
    // トークンを1枚にすると足りない
    const poor = { ...s, tbTradeTokens: { player1: 1, player2: 5 } };
    // 盗賊は初期で砂漠に居るので TB_FORCED_TRADE 側で確認（相手に手札を持たせる）
    const poor2: GameState = {
      ...poor,
      players: { ...poor.players, player2: { ...poor.players.player2!, hand: makeHand({ ore: 2 }) } },
    };
    expect(() => applyAction(poor2, { type: 'TB_FORCED_TRADE', give: {} })).toThrow(/not enough trade tokens/);
  });

  it('TB_FORCED_TRADE: 相手の無作為2枚を取り、自分の2枚を渡す（rng固定）', () => {
    let s = tb2State();
    s = {
      ...s,
      players: {
        ...s.players,
        player1: { ...s.players.player1!, hand: makeHand({ wood: 2, grain: 1 }) },
        player2: { ...s.players.player2!, hand: makeHand({ brick: 2, ore: 1 }) },
      },
    };
    // rng=0 固定 → プール[brick,brick,ore] の先頭から brick, brick を取る
    const next = applyAction(s, { type: 'TB_FORCED_TRADE', give: { wood: 2 } }, () => 0);
    expect(next.players.player1!.hand).toEqual(makeHand({ brick: 2, grain: 1 }));
    expect(next.players.player2!.hand).toEqual(makeHand({ wood: 2, ore: 1 }));
    expect(next.tbTradeTokens!.player1).toBe(5 - TB2_SPEND_COST_BEHIND);
    expect(next.tbTradeTokenBank).toBe(10 + TB2_SPEND_COST_BEHIND);
  });

  it('TB_FORCED_TRADE: 相手が1枚なら1枚だけ取り、それでも2枚渡す。0枚なら不可', () => {
    let s = tb2State();
    s = {
      ...s,
      players: {
        ...s.players,
        player1: { ...s.players.player1!, hand: makeHand({ wood: 1, brick: 1 }) },
        player2: { ...s.players.player2!, hand: makeHand({ ore: 1 }) },
      },
    };
    const next = applyAction(s, { type: 'TB_FORCED_TRADE', give: { wood: 1, brick: 1 } }, () => 0);
    expect(next.players.player1!.hand).toEqual(makeHand({ ore: 1 }));
    expect(next.players.player2!.hand).toEqual(makeHand({ wood: 1, brick: 1 }));
    // 相手0枚は不可
    const empty: GameState = {
      ...s,
      players: { ...s.players, player2: { ...s.players.player2!, hand: makeHand() } },
    };
    expect(() => applyAction(empty, { type: 'TB_FORCED_TRADE', give: { wood: 1, brick: 1 } })).toThrow(/no cards/);
    // 渡す枚数が2枚ちょうどでない・所持超過は不可
    expect(() => applyAction(s, { type: 'TB_FORCED_TRADE', give: { wood: 1 } })).toThrow(/exactly 2/);
    expect(() => applyAction(s, { type: 'TB_FORCED_TRADE', give: { wood: 2 } })).toThrow(/exactly 2/);
  });

  it('消費は「1回目の生産前の PRE_ROLL」または「TRADE_BUILD」のみ（生産の間は不可）', () => {
    const base = {
      players: {
        ...tb2State().players,
        player2: { ...tb2State().players.player2!, hand: makeHand({ ore: 2 }) },
      },
    };
    // 1回目の生産前（PRE_ROLL・rollsDone=0）: OK
    const pre = tb2State({ ...base, turnPhase: 'PRE_ROLL', diceRolledThisTurn: false, tbRollsDone: 0 });
    expect(() => applyAction(pre, { type: 'TB_FORCED_TRADE', give: {} })).toThrow(/exactly 2/); // 窓は通過しgiveで落ちる
    // 生産の間（PRE_ROLL・rollsDone=1）: 不可
    const mid = tb2State({ ...base, turnPhase: 'PRE_ROLL', diceRolledThisTurn: true, tbRollsDone: 1 });
    expect(() => applyAction(mid, { type: 'TB_FORCED_TRADE', give: {} })).toThrow(/only before rolling/);
  });

  it('TB_DISCARD_KNIGHT: 騎士-1でトークン+2・最大騎士力を失いうる（奪取側は3枚以上が必要）', () => {
    // p1=騎士3(保持)・p2=騎士3 → p1が捨てると 2<3 で p2 がタイル獲得
    let s = tb2State({ largestArmyHolder: 'player1' });
    s = {
      ...s,
      players: {
        ...s.players,
        player1: { ...s.players.player1!, knightsPlayed: 3, hasLargestArmy: true },
        player2: { ...s.players.player2!, knightsPlayed: 3 },
      },
    };
    let next = applyAction(s, { type: 'TB_DISCARD_KNIGHT' });
    expect(next.players.player1!.knightsPlayed).toBe(2);
    expect(next.tbTradeTokens!.player1).toBe(5 + TB2_TOKENS_KNIGHT_DISCARD);
    expect(next.tbTradeTokenBank).toBe(10 - TB2_TOKENS_KNIGHT_DISCARD);
    expect(next.largestArmyHolder).toBe('player2');
    expect(next.players.player1!.hasLargestArmy).toBe(false);
    // 1ターン1回
    expect(() => applyAction(next, { type: 'TB_DISCARD_KNIGHT' })).toThrow(/already used/);
    // 相手が2枚(3未満)ならタイルは動かない（保持者が2枚に減っても維持）
    let s2 = tb2State({ largestArmyHolder: 'player1' });
    s2 = {
      ...s2,
      players: {
        ...s2.players,
        player1: { ...s2.players.player1!, knightsPlayed: 3, hasLargestArmy: true },
        player2: { ...s2.players.player2!, knightsPlayed: 2 },
      },
    };
    const next2 = applyAction(s2, { type: 'TB_DISCARD_KNIGHT' });
    expect(next2.largestArmyHolder).toBe('player1');
    // 表向き騎士が無ければ不可
    expect(() => applyAction(tb2State(), { type: 'TB_DISCARD_KNIGHT' })).toThrow(/no faceup knight/);
  });

  it('TB_DISCARD_KNIGHT: 3枚下限が実際に効く（保持者1枚 vs 相手2枚でも奪取されない）', () => {
    // 保持者 p1 が既に2枚（1回捨てた後）→ もう1回捨てて1枚に。相手 p2=2枚。
    // updateLargestArmy は maxKnights を保持者の現枚数で初期化するので「k > maxKnights」だけでは
    // p2(k=2) を弾けない状況（1>2 ではなく 2>1 が真になりうる）を作り、3枚下限が binding になる。
    let s = tb2State({ largestArmyHolder: 'player1' });
    s = {
      ...s,
      players: {
        ...s.players,
        player1: { ...s.players.player1!, knightsPlayed: 2, hasLargestArmy: true },
        player2: { ...s.players.player2!, knightsPlayed: 2 },
      },
    };
    const next = applyAction(s, { type: 'TB_DISCARD_KNIGHT' });
    expect(next.players.player1!.knightsPlayed).toBe(1);
    // 3枚下限（k >= LARGEST_ARMY_MIN）が無ければ p2(k=2 > maxKnights=1) が奪取してしまう。
    expect(next.largestArmyHolder).toBe('player1');
    expect(next.players.player1!.hasLargestArmy).toBe(true);
    expect(next.players.player2!.hasLargestArmy).toBe(false);
  });

  it('TB_DISCARD_KNIGHT: 供給0なら拒否・供給1なら+1しか貰えない（頭打ち）', () => {
    const withKnight = tb2State({
      players: {
        ...tb2State().players,
        player1: { ...tb2State().players.player1!, knightsPlayed: 2 },
      },
    });
    // 供給0 → 拒否（トークンを作れない）
    expect(() => applyAction({ ...withKnight, tbTradeTokenBank: 0 }, { type: 'TB_DISCARD_KNIGHT' }))
      .toThrow(/supply is empty/);
    // 供給1 → 頭打ちで +1 のみ
    const next = applyAction({ ...withKnight, tbTradeTokenBank: 1 }, { type: 'TB_DISCARD_KNIGHT' });
    expect(next.tbTradeTokens!.player1).toBe(6); // +2 ではなく +1
    expect(next.tbTradeTokenBank).toBe(0);
  });

  it('TB_MOVE_ROBBER/TB_DISCARD_KNIGHT も生産2回の間（PRE_ROLL・rollsDone=1）には使えない', () => {
    // 盗賊を砂漠以外へ置いた「生産の間」の状態
    const base = tb2State({
      turnPhase: 'PRE_ROLL', diceRolledThisTurn: true, tbRollsDone: 1,
      players: {
        ...tb2State().players,
        player1: { ...tb2State().players.player1!, knightsPlayed: 2 },
      },
    });
    const desert = Object.values(base.tiles).find(t => t.type === 'desert')!;
    const other = Object.values(base.tiles).find(t => t.type !== 'desert' && t.type !== 'sea')!;
    const s = {
      ...base,
      tiles: { ...base.tiles, [desert.id]: { ...desert, hasRobber: false }, [other.id]: { ...other, hasRobber: true } },
    };
    expect(() => applyAction(s, { type: 'TB_MOVE_ROBBER' })).toThrow(/only before rolling/);
    expect(() => applyAction(s, { type: 'TB_DISCARD_KNIGHT' })).toThrow(/only before rolling/);
  });

  it('TB_MOVE_ROBBER: トークン不足なら拒否（tbTradeTokens が負にならない）', () => {
    const base = tb2State({ tbTradeTokens: { player1: 0, player2: 5 } });
    const desert = Object.values(base.tiles).find(t => t.type === 'desert')!;
    const other = Object.values(base.tiles).find(t => t.type !== 'desert' && t.type !== 'sea')!;
    const s = {
      ...base,
      tiles: { ...base.tiles, [desert.id]: { ...desert, hasRobber: false }, [other.id]: { ...other, hasRobber: true } },
    };
    expect(() => applyAction(s, { type: 'TB_MOVE_ROBBER' })).toThrow(/not enough trade tokens/);
  });
});

describe('Catan for Two: 中立は資源を受け取らない（dice.ts 幻需要バグの回帰）', () => {
  it('中立開拓地は生産で資源を得ず、バンク枯渇判定も汚染しない', () => {
    // 内陸タイル1枚に player1 の都市(需要2)と中立の開拓地(需要1)を同居させ、その資源の銀行を2に絞る。
    // 中立を需要に算入すると totalDemand=3>2 で「複数人不足→誰にも配らない」が誤発動し player1=0枚に
    // なるが、中立は需要外なので実際は player1 が2枚受け取れる（かつ中立の手札は増えない）。
    let s = tb2State();
    const tile = Object.values(s.tiles).find(t => t.number != null && t.type !== 'desert' && t.type !== 'sea'
      && (s.tileToVertices[t.id] ?? []).filter(v => !s.vertices[v]!.building).length >= 2)!;
    const r = TILE_RESOURCE_MAP[tile.type]!;
    const free = s.tileToVertices[tile.id]!.filter(v => !s.vertices[v]!.building);
    const [vCity, vNeutral] = [free[0]!, free[1]!];
    // この生産で他タイルが産出しないよう、同数字の他タイルを別数字に潰す。
    const tiles = { ...s.tiles };
    for (const id of Object.keys(tiles)) {
      if (id !== tile.id && tiles[id]!.number === tile.number) tiles[id] = { ...tiles[id]!, number: 3 };
    }
    s = {
      ...s,
      tiles,
      bank: { ...s.bank, [r]: 2 },
      vertices: {
        ...s.vertices,
        [vCity]: { ...s.vertices[vCity]!, building: { type: 'city', playerId: 'player1' } },
        [vNeutral]: { ...s.vertices[vNeutral]!, building: { type: 'settlement', playerId: 'player3' } },
      },
    };
    const p1Before = s.players.player1!.hand[r];
    const produced = distributeResources(s, tile.number!);
    expect(produced.players.player1!.hand[r]).toBe(p1Before + 2); // 都市は在庫2から2枚受け取れる
    expect(Object.values(produced.players.player3!.hand).every(v => v === 0)).toBe(true); // 中立は増えない
  });
});

describe('Catan for Two: 中立との相互作用の禁止', () => {
  it('盗賊で中立からは奪えない', () => {
    let s = tb2State({ turnPhase: 'ROBBER' });
    // 中立の開拓地があるタイルへ移動して中立から奪おうとする
    const neutralV = Object.keys(s.vertices).find(v => s.vertices[v]!.building?.playerId === 'player3')!;
    const tile = s.vertices[neutralV]!.adjacentTileIds.find(t => !s.tiles[t]!.hasRobber)!;
    expect(() => applyAction(s, { type: 'MOVE_ROBBER', tileId: tile, stealFromPlayerId: 'player3' }))
      .toThrow(/neutral/);
  });

  it('中立へは交易を申し込めない', () => {
    let s = tb2State();
    s = {
      ...s,
      players: { ...s.players, player1: { ...s.players.player1!, hand: makeHand({ wood: 1 }) } },
    };
    expect(() => applyAction(s, {
      type: 'OFFER_TRADE',
      offer: { give: { wood: 1 }, receive: { ore: 1 } },
      targetPlayerIds: ['player3'],
    })).toThrow(/neutral/);
  });
});
