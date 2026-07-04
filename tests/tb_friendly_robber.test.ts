// ============================================================
// tests/tb_friendly_robber.test.ts — 交易と蛮族「親切な盗賊(The Friendly Robber)」変種
// ============================================================
// 公式ルールブック第6版 CN3089 p3 のルールを固定するテスト。
//   原文: "You may not move the robber to a hex with the building of a player who only has 2 VPs.
//          If there is no valid hex, move the robber to the desert. In this case, steal 1 random card
//          from a player with an adjacent building as long as they have more than 2 VPs."
//   実装解釈（docs/交易と蛮族_仕様書_v6.md §2-1）:
//   - 「2VPしか持たない」は公開VP（隠し勝利点カード除外）で判定。原文どおり手番プレイヤー自身も区別しない。
//   - 奪える相手は「2VP超」（＝公開VP3以上）のみ。

import { describe, it, expect } from 'vitest';
import { makeGameState, makePlayer } from './helpers';
import { applyAction } from '../src/engine/game';
import { getRobberMoveTargets, isFriendlyRobberProtected, moveRobber } from '../src/engine/robber';
import { chooseRobberHex, chooseStealTarget } from '../src/engine/ai';
import { cpuFallbackAction } from '../src/engine/lanCpu';
import { getScenario, listVisibleScenarios, getScenarioRules } from '../src/engine/scenarios';
import { createInitialGameState } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import { FRIENDLY_ROBBER_SAFE_VP, makeHand } from '../src/constants';
import type { GameState, Tile, TileId, VertexId, PlayerId, BuildingType } from '../src/types';

/** 頂点に建物を直接置く（ロジック単体検証用。距離ルール等の配置規則は無視）。 */
function place(state: GameState, vid: VertexId, playerId: PlayerId, type: BuildingType): GameState {
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, building: { type, playerId } } },
  };
}

/** 指定頂点のどれかに面するタイルID集合。 */
function tilesTouching(state: GameState, vids: VertexId[]): Set<TileId> {
  const out = new Set<TileId>();
  for (const [tid, tvids] of Object.entries(state.tileToVertices)) {
    if (tvids.some(v => vids.includes(v))) out.add(tid);
  }
  return out;
}

/** 盤を指定タイルだけに縮める（砂漠フォールバックの「合法ヘックスなし」を作るため）。 */
function keepTiles(state: GameState, keep: TileId[]): GameState {
  const tiles: Record<TileId, Tile> = {};
  for (const tid of keep) tiles[tid] = state.tiles[tid]!;
  return { ...state, tiles };
}

/** rng42盤の砂漠タイルID（強盗の初期位置）。 */
function desertId(state: GameState): TileId {
  return Object.values(state.tiles).find(t => t.type === 'desert')!.id;
}

/** どの指定頂点にも面しない陸タイルを1つ返す（盗賊の現在地用）。 */
function tileAwayFrom(state: GameState, avoidVids: VertexId[], excludeIds: TileId[]): TileId {
  const touched = tilesTouching(state, avoidVids);
  return (Object.keys(state.tiles) as TileId[]).find(
    tid => !touched.has(tid) && !excludeIds.includes(tid) && state.tiles[tid]!.type !== 'sea',
  )!;
}

describe('親切な盗賊: シナリオ登録と数値の固定', () => {
  it('tb_friendly_robber は traders_barbarians カテゴリ・勝利目標10点（本体準拠）・friendlyRobber 有効', () => {
    const sc = getScenario('tb_friendly_robber');
    expect(sc.category).toBe('traders_barbarians');
    expect(sc.victoryTarget).toBe(10);          // 公式: 勝利条件の変更なし
    expect(sc.rules?.friendlyRobber).toBe(true);
  });

  it('盤面選択UIに表示され、遊び方ルールが用意されている', () => {
    expect(listVisibleScenarios().some(s => s.id === 'tb_friendly_robber')).toBe(true);
    expect(getScenarioRules('tb_friendly_robber').length).toBeGreaterThan(0);
  });

  it('createInitialGameState は friendlyRobber を配線する（classic は配線しない）', () => {
    const players = [
      { id: 'player1' as const, name: 'P1', color: 'red' as const, type: 'human' as const },
      { id: 'player2' as const, name: 'P2', color: 'blue' as const, type: 'human' as const },
    ];
    const st = createInitialGameState(players, 'fixed', ['player1', 'player2'], createRng(1), 'tb_friendly_robber');
    expect(st.friendlyRobber).toBe(true);
    expect(st.victoryTarget).toBe(10);
    const classic = createInitialGameState(players, 'fixed', ['player1', 'player2'], createRng(1), 'classic');
    expect(classic.friendlyRobber).toBeUndefined();
  });

  it('保護しきい値は公式の2VP（"only has 2 VPs" / "more than 2 VPs"）', () => {
    expect(FRIENDLY_ROBBER_SAFE_VP).toBe(2);
  });
});

describe('親切な盗賊: 保護判定（公開VPが2以下）', () => {
  it('開拓地2つ(公開2VP)は保護・3つ(3VP)は保護されない', () => {
    let st = makeGameState({ friendlyRobber: true });
    const vids = Object.keys(st.vertices) as VertexId[];
    st = place(st, vids[0]!, 'player2', 'settlement');
    st = place(st, vids[5]!, 'player2', 'settlement');
    expect(isFriendlyRobberProtected(st, 'player2')).toBe(true);
    st = place(st, vids[10]!, 'player2', 'settlement');
    expect(isFriendlyRobberProtected(st, 'player2')).toBe(false);
  });

  it('隠し勝利点カードは数えない（公開2VP＋VPカード1枚でも保護＝物理卓と同じ運用）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const vids = Object.keys(st.vertices) as VertexId[];
    st = place(st, vids[0]!, 'player2', 'settlement');
    st = place(st, vids[5]!, 'player2', 'settlement');
    st = {
      ...st,
      players: {
        ...st.players,
        player2: { ...st.players.player2!, devCards: [{ id: 'v1', type: 'victory_point', purchasedOnTurn: 0 }] },
      },
    };
    expect(isFriendlyRobberProtected(st, 'player2')).toBe(true); // 総VPは3だが公開VPは2
  });
});

describe('親切な盗賊: 盗賊の移動先フィルタ', () => {
  it('無効時（基本ゲーム等）は制限なし＝現在地以外の全陸タイル', () => {
    let st = makeGameState(); // friendlyRobber なし
    const vids = st.tileToVertices[desertId(st)]!;
    st = place(st, vids[0]!, 'player2', 'settlement'); // 2VPプレイヤーの建物があっても
    const targets = getRobberMoveTargets(st);
    expect(targets.length).toBe(Object.keys(st.tiles).length - 1); // 19-1（現在地=砂漠のみ除外）
    expect(targets).not.toContain(desertId(st)); // 現在地は除外
  });

  it('公開2VPのプレイヤーの建物ヘックスへは動かせない（3VPになると解禁）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    const vids = st.tileToVertices[target]!;
    st = place(st, vids[0]!, 'player2', 'settlement');
    const far = (Object.keys(st.vertices) as VertexId[])
      .find(v => !st.tileToVertices[target]!.includes(v) && st.vertices[v]!.building == null)!;
    st = place(st, far, 'player2', 'settlement'); // player2=公開2VP → 保護
    expect(getRobberMoveTargets(st)).not.toContain(target);

    // 3つ目の開拓地で公開3VP → 保護解除＝そのヘックスへ動かせる
    const far2 = (Object.keys(st.vertices) as VertexId[])
      .find(v => !st.tileToVertices[target]!.includes(v) && st.vertices[v]!.building == null)!;
    const st3 = place(st, far2, 'player2', 'settlement');
    expect(getRobberMoveTargets(st3)).toContain(target);
  });

  it('2VPの建物と3VP超の建物が同居するヘックスも不可（原文: 保護対象の建物が1つでもあれば不可）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    const vids = st.tileToVertices[target]!;
    // player2: 開拓地2つ（保護）。うち1つが target 上。
    st = place(st, vids[0]!, 'player2', 'settlement');
    const far = (Object.keys(st.vertices) as VertexId[])
      .find(v => !vids.includes(v) && st.vertices[v]!.building == null)!;
    st = place(st, far, 'player2', 'settlement');
    // player1: 開拓地3つ（非保護）。うち1つが同じ target 上。
    st = place(st, vids[2]!, 'player1', 'settlement');
    const others = (Object.keys(st.vertices) as VertexId[])
      .filter(v => !vids.includes(v) && st.vertices[v]!.building == null);
    st = place(st, others[0]!, 'player1', 'settlement');
    st = place(st, others[1]!, 'player1', 'settlement');
    expect(isFriendlyRobberProtected(st, 'player1')).toBe(false);
    expect(getRobberMoveTargets(st)).not.toContain(target);
  });

  it('手番プレイヤー自身の2VP建物ヘックスも同様に不可（原文は自他を区別しない）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    const vids = st.tileToVertices[target]!;
    st = place(st, vids[0]!, 'player1', 'settlement'); // 手番者 player1 自身の建物
    const far = (Object.keys(st.vertices) as VertexId[])
      .find(v => !vids.includes(v) && st.vertices[v]!.building == null)!;
    st = place(st, far, 'player1', 'settlement'); // player1=公開2VP
    expect(getRobberMoveTargets(st)).not.toContain(target);
  });

  it('合法ヘックスが無ければ砂漠のみ（盗賊が砂漠に居るなら「その場に留まる」も合法）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    // player2(2VP・保護)の開拓地で砂漠と別タイルYを塞ぐ。
    st = place(st, dVids[0]!, 'player2', 'settlement');
    const yTile = tileAwayFrom(st, dVids, [desert]);
    st = place(st, st.tileToVertices[yTile]![0]!, 'player2', 'settlement');
    // 盗賊を第3のタイルXへ動かし、盤を {砂漠, X, Y} に縮める → 合法ヘックスなし。
    const placed = [dVids[0]!, st.tileToVertices[yTile]![0]!];
    const xTile = tileAwayFrom(st, placed, [desert, yTile]);
    st = keepTiles(moveRobber(st, xTile), [desert, xTile, yTile]);
    expect(getRobberMoveTargets(st)).toEqual([desert]); // 砂漠フォールバック

    // 盗賊が既に砂漠に居る場合も砂漠（=現在地）が返る。
    let st2 = makeGameState({ friendlyRobber: true }); // 盗賊は砂漠スタート
    st2 = place(st2, st2.tileToVertices[yTile]![0]!, 'player2', 'settlement');
    const far = (Object.keys(st2.vertices) as VertexId[])
      .find(v => v !== st2.tileToVertices[yTile]![0]! && st2.vertices[v]!.building == null)!;
    st2 = place(st2, far, 'player2', 'settlement');
    st2 = keepTiles(st2, [desert, yTile]);
    expect(getRobberMoveTargets(st2)).toEqual([desert]);
  });

  it('盤に砂漠が無い場合は通常の候補へフォールバック（原文の想定外・進行を止めない保険）', () => {
    let st = makeGameState({ friendlyRobber: true });
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    st = place(st, dVids[0]!, 'player2', 'settlement');
    const yTile = tileAwayFrom(st, dVids, [desert]);
    st = place(st, st.tileToVertices[yTile]![0]!, 'player2', 'settlement');
    const placed = [dVids[0]!, st.tileToVertices[yTile]![0]!];
    const xTile = tileAwayFrom(st, placed, [desert, yTile]);
    st = keepTiles(moveRobber(st, xTile), [xTile, yTile]); // 砂漠なし・Yは保護
    expect(getRobberMoveTargets(st)).toEqual([yTile]);
  });
});

describe('親切な盗賊: MOVE_ROBBER（エンジン統合）', () => {
  /** player2=開拓地3つ(3VP・非保護・羊毛2枚) / player1=手番（建物なし）。盗賊は砂漠スタート。 */
  function robberState(): { st: GameState; target: TileId } {
    let st = makeGameState({
      friendlyRobber: true,
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2', { hand: { ...makeHand(), wool: 2 } }),
      },
    });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    const vids = st.tileToVertices[target]!;
    st = place(st, vids[0]!, 'player2', 'settlement');
    const others = (Object.keys(st.vertices) as VertexId[])
      .filter(v => !vids.includes(v) && st.vertices[v]!.building == null);
    st = place(st, others[0]!, 'player2', 'settlement');
    st = place(st, others[1]!, 'player2', 'settlement'); // player2=3VP
    return { st, target };
  }

  it('非保護(3VP)の相手のヘックスへ移動し、その相手から奪える', () => {
    const { st, target } = robberState();
    const next = applyAction(st, { type: 'MOVE_ROBBER', tileId: target, stealFromPlayerId: 'player2' }, createRng(1));
    expect(next.tiles[target]!.hasRobber).toBe(true);
    expect(next.players.player2!.hand.wool).toBe(1); // 1枚奪われた
    expect(next.players.player1!.hand.wool).toBe(1);
  });

  it('保護(2VP)の相手のヘックスへは移動できない', () => {
    let { st, target } = robberState();
    // player2 の開拓地を2つに減らして保護状態にする（target 上の1つ＋他1つ）。
    const extra = (Object.keys(st.vertices) as VertexId[])
      .filter(v => st.vertices[v]!.building?.playerId === 'player2')
      .filter(v => !st.tileToVertices[target]!.includes(v))[1]!;
    const { building: _removed, ...bare } = st.vertices[extra]!;
    st = { ...st, vertices: { ...st.vertices, [extra]: bare } };
    expect(isFriendlyRobberProtected(st, 'player2')).toBe(true);
    expect(() => applyAction(st, { type: 'MOVE_ROBBER', tileId: target, stealFromPlayerId: 'player2' }, createRng(1)))
      .toThrow(/friendly robber cannot move/);
  });

  it('friendlyRobber 無効（基本ゲーム）なら 2VP の相手からも従来どおり奪える（回帰）', () => {
    let st = makeGameState({
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2', { hand: { ...makeHand(), wool: 2 } }),
      },
    });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    st = place(st, st.tileToVertices[target]![0]!, 'player2', 'settlement'); // player2=1VP
    const next = applyAction(st, { type: 'MOVE_ROBBER', tileId: target, stealFromPlayerId: 'player2' }, createRng(1));
    expect(next.players.player2!.hand.wool).toBe(1);
  });

  it('砂漠フォールバック: 砂漠へ移動し、隣接の2VP超からのみ奪う（2VP以下の指定は拒否）', () => {
    // player1=手番(建物なし) / player2=2VP保護・砂漠隣接・羊毛5 / player3=3VP・砂漠隣接・羊毛2。
    let st = makeGameState({
      friendlyRobber: true,
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2', { hand: { ...makeHand(), wool: 5 } }),
        player3: makePlayer('player3', { hand: { ...makeHand(), wool: 2 } }),
      },
      playerOrder: ['player1', 'player2', 'player3'],
    });
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    st = place(st, dVids[0]!, 'player2', 'settlement'); // 砂漠を塞ぐ（2VP側）
    st = place(st, dVids[2]!, 'player3', 'settlement'); // 砂漠隣接の3VPプレイヤー
    // player2 の2つ目は砂漠から離れたタイルYの頂点へ（Yも保護ヘックスになる）。
    const yTile = tileAwayFrom(st, dVids, [desert]);
    const yVid = st.tileToVertices[yTile]![0]!;
    st = place(st, yVid, 'player2', 'settlement');
    // player3 の残り2つはさらに離れた頂点に（Y・砂漠のどちらにも触れない）。
    const others = (Object.keys(st.vertices) as VertexId[])
      .filter(v => !dVids.includes(v) && !st.tileToVertices[yTile]!.includes(v) && st.vertices[v]!.building == null);
    st = place(st, others[0]!, 'player3', 'settlement');
    st = place(st, others[1]!, 'player3', 'settlement');
    expect(isFriendlyRobberProtected(st, 'player2')).toBe(true);
    expect(isFriendlyRobberProtected(st, 'player3')).toBe(false);
    // 盗賊を離れたタイルXへ置き、盤を {砂漠, X, Y} に縮める → 砂漠もYも保護 → 合法ヘックスなし → 砂漠のみ。
    const placedVids = [dVids[0]!, dVids[2]!, yVid, others[0]!, others[1]!];
    const xTile = tileAwayFrom(st, placedVids, [desert, yTile]);
    st = keepTiles(moveRobber(st, xTile), [desert, xTile, yTile]);
    expect(getRobberMoveTargets(st)).toEqual([desert]);

    // 保護ヘックスYへは移動不可（フォールバック中も「親切な盗賊」の移動制限そのものが効くことを固定。
    // 現在地Xへの移動不可は基本ルールでも落ちて空虚な断言になるため、Yで検証する）。
    expect(() => applyAction(st, { type: 'MOVE_ROBBER', tileId: yTile, stealFromPlayerId: null }, createRng(1)))
      .toThrow(/friendly robber cannot move/);
    // 保護対象 player2 からは奪えない。
    expect(() => applyAction(st, { type: 'MOVE_ROBBER', tileId: desert, stealFromPlayerId: 'player2' }, createRng(1)))
      .toThrow(/does not steal/);
    // 2VP超の player3 がいる以上、強奪はスキップできない（強奪必須ルール）。
    expect(() => applyAction(st, { type: 'MOVE_ROBBER', tileId: desert, stealFromPlayerId: null }, createRng(1)))
      .toThrow(/must steal/);
    // player3 からは奪える。
    const next = applyAction(st, { type: 'MOVE_ROBBER', tileId: desert, stealFromPlayerId: 'player3' }, createRng(1));
    expect(next.tiles[desert]!.hasRobber).toBe(true);
    expect(next.players.player3!.hand.wool).toBe(1);
    expect(next.players.player1!.hand.wool).toBe(1);
    expect(next.players.player2!.hand.wool).toBe(5); // 保護対象は無傷
  });

  it('砂漠フォールバック: 盗賊が既に砂漠なら留まれ、隣接が「手札を持つ保護対象のみ」なら奪わずに済む', () => {
    // player2(公開2VP・保護)が手札5枚で砂漠に隣接＝保護フィルタが無ければ「強奪必須」で手番が詰む局面。
    let st = makeGameState({
      friendlyRobber: true,
      turnPhase: 'ROBBER',
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2', { hand: { ...makeHand(), wool: 5 } }),
      },
    }); // 盗賊は砂漠スタート
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    const yTile = tileAwayFrom(st, dVids, [desert]);
    st = place(st, dVids[0]!, 'player2', 'settlement');                      // 砂漠隣接（手札あり・保護）
    st = place(st, st.tileToVertices[yTile]![0]!, 'player2', 'settlement');  // player2=2VP・Yも塞ぐ
    st = keepTiles(st, [desert, yTile]);
    expect(getRobberMoveTargets(st)).toEqual([desert]);
    // 公式: 奪えるのは「2VP超」のみ → 手札持ちでも保護対象しか隣接しないなら奪わない(null)が合法。
    const next = applyAction(st, { type: 'MOVE_ROBBER', tileId: desert, stealFromPlayerId: null }, createRng(1));
    expect(next.tiles[desert]!.hasRobber).toBe(true);  // 留まる
    expect(next.players.player2!.hand.wool).toBe(5);   // 保護対象は無傷
    expect(next.players.player1!.hand.wool).toBe(0);
    expect(next.turnPhase).toBe('TRADE_BUILD');
  });
});

describe('親切な盗賊: AI・CPU の候補選択', () => {
  it('chooseRobberHex は保護ヘックスを選ばない（常に合法移動先の中から選ぶ）', () => {
    let st = makeGameState({ friendlyRobber: true, turnPhase: 'ROBBER' });
    const desert = desertId(st);
    const target = (Object.keys(st.tiles) as TileId[]).find(t => t !== desert)!;
    const vids = st.tileToVertices[target]!;
    st = place(st, vids[0]!, 'player2', 'settlement');
    const far = (Object.keys(st.vertices) as VertexId[])
      .find(v => !vids.includes(v) && st.vertices[v]!.building == null)!;
    st = place(st, far, 'player2', 'settlement'); // player2=2VP・target が保護される
    const legal = new Set(getRobberMoveTargets(st));
    for (let seed = 1; seed <= 8; seed++) {
      const hex = chooseRobberHex(st, 'player1', createRng(seed));
      expect(hex).not.toBe(target);
      expect(legal.has(hex)).toBe(true);
    }
  });

  it('chooseStealTarget は保護対象(公開VP2以下)を選ばない', () => {
    // 砂漠に player2(2VP・手札あり) と player3(3VP・手札あり) が隣接。
    let st = makeGameState({
      friendlyRobber: true,
      players: {
        player1: makePlayer('player1'),
        player2: makePlayer('player2', { hand: { ...makeHand(), wool: 5 } }),
        player3: makePlayer('player3', { hand: { ...makeHand(), wool: 2 } }),
      },
      playerOrder: ['player1', 'player2', 'player3'],
    });
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    st = place(st, dVids[0]!, 'player2', 'settlement');
    st = place(st, dVids[2]!, 'player3', 'settlement');
    const others = (Object.keys(st.vertices) as VertexId[])
      .filter(v => !dVids.includes(v) && st.vertices[v]!.building == null);
    st = place(st, others[0]!, 'player2', 'settlement');
    st = place(st, others[1]!, 'player3', 'settlement');
    st = place(st, others[2]!, 'player3', 'settlement');
    for (let seed = 1; seed <= 8; seed++) {
      expect(chooseStealTarget(st, desert, 'player1', createRng(seed))).toBe('player3');
    }
    // 3VP側の手札が無ければ、保護対象しか残らないので null（奪わない）。
    const drained = {
      ...st,
      players: { ...st.players, player3: { ...st.players.player3!, hand: makeHand() } },
    };
    expect(chooseStealTarget(drained, desert, 'player1', createRng(1))).toBeNull();
  });

  it('LAN CPU の最終手段(cpuFallbackAction)も合法な移動先から盗賊タイルを選ぶ', () => {
    let st = makeGameState({ friendlyRobber: true, turnPhase: 'ROBBER' }); // 盗賊は砂漠スタート
    const desert = desertId(st);
    const dVids = st.tileToVertices[desert]!;
    // 盤の「先頭」に保護タイルYを置く（旧実装『先頭の陸タイル』ならYを選んでエンジンに弾かれる並び）。
    const yTile = tileAwayFrom(st, dVids, [desert]);
    const yVid = st.tileToVertices[yTile]![0]!;
    st = place(st, yVid, 'player2', 'settlement');
    const far = (Object.keys(st.vertices) as VertexId[])
      .find(v => !st.tileToVertices[yTile]!.includes(v) && !dVids.includes(v) && st.vertices[v]!.building == null)!;
    st = place(st, far, 'player2', 'settlement'); // player2=2VP → Yは保護ヘックス
    const zTile = tileAwayFrom(st, [yVid, far], [desert, yTile]); // どの建物にも触れない合法タイル
    st = keepTiles(st, [yTile, zTile, desert]);
    const act = cpuFallbackAction(st, 'player1');
    expect(act.type).toBe('MOVE_ROBBER');
    if (act.type === 'MOVE_ROBBER') {
      expect(act.tileId).toBe(zTile); // 先頭の保護タイルYではなく合法なZ
      expect(getRobberMoveTargets(st)).toContain(act.tileId);
    }
  });
});
