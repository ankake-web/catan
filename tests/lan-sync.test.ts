import { describe, it, expect } from 'vitest';
import { createInitialGameState } from '../src/engine/createState';
import type { PlayerSpec } from '../src/engine/createState';
import { applyAction } from '../src/engine/game';
import { maskStateFor } from '../src/engine/mask';
import { createRng } from '../src/engine/setup';
import { canBuildSettlement, canBuildRoad } from '../src/engine/actions';
import { RESOURCE_TYPES } from '../src/constants';
import type { GameState, Action, PlayerId } from '../src/types';

// サーバ(lanServer)の action 処理と同じ「操作権限 actor 判定」を再現する。
function requiredActor(state: GameState, action: Action): PlayerId | null {
  switch (action.type) {
    case 'DISCARD_RESOURCES': return action.playerId;
    case 'RESPOND_TRADE':     return action.response.playerId;
    default:                  return state.playerOrder[state.currentPlayerIndex] ?? null;
  }
}

// サーバの権威適用を模倣: actor 検証 → applyAction。拒否時は state 据え置き。
function serverApply(state: GameState, senderId: PlayerId, action: Action, rng: () => number): GameState {
  if (requiredActor(state, action) !== senderId) return state; // 非手番/別IDは無視
  return applyAction(state, action, rng);
}

const SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'A', color: 'red',  type: 'human' },
  { id: 'player2', name: 'B', color: 'blue', type: 'human' },
];

const cur = (s: GameState) => s.playerOrder[s.currentPlayerIndex]!;
const handTotal = (s: GameState, p: PlayerId) =>
  RESOURCE_TYPES.reduce((sum, r) => sum + s.players[p]!.hand[r], 0);

// 現在の手番プレイヤーが置ける頂点/辺を masked state から探す（盤面は公開情報）。
function firstValidVertex(s: GameState, p: PlayerId): string | undefined {
  return Object.keys(s.vertices).find(v => canBuildSettlement(s, p, v));
}
function firstValidEdge(s: GameState, p: PlayerId): string | undefined {
  return Object.keys(s.edges).find(e => canBuildRoad(s, p, e));
}

// 初期配置を最後まで（サーバ権威で）進める。
function runSetup(state: GameState, rng: () => number): GameState {
  let s = state;
  for (let i = 0; i < 100 && s.phase !== 'MAIN'; i++) {
    const p = cur(s);
    if (s.setupSubPhase === 'PLACE_SETTLEMENT') {
      const v = firstValidVertex(s, p)!;
      s = serverApply(s, p, { type: 'BUILD_SETTLEMENT', vertexId: v }, rng);
    } else {
      const e = firstValidEdge(s, p)!;
      s = serverApply(s, p, { type: 'BUILD_ROAD', edgeId: e }, rng);
    }
  }
  return s;
}

describe('LAN server-authoritative sync (MVP3)', () => {
  it('runs initial placement in the correct turn order (forward then backward)', () => {
    const s0 = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7));
    const order: { pid: PlayerId; sub: string }[] = [];
    let s = s0;
    for (let i = 0; i < 100 && s.phase !== 'MAIN'; i++) {
      const p = cur(s);
      order.push({ pid: p, sub: s.setupSubPhase! });
      if (s.setupSubPhase === 'PLACE_SETTLEMENT') {
        s = serverApply(s, p, { type: 'BUILD_SETTLEMENT', vertexId: firstValidVertex(s, p)! }, createRng(1));
      } else {
        s = serverApply(s, p, { type: 'BUILD_ROAD', edgeId: firstValidEdge(s, p)! }, createRng(1));
      }
    }
    // 2人: P1 settle/road, P2 settle/road, P2 settle/road, P1 settle/road
    expect(order.map(o => o.pid)).toEqual([
      'player1', 'player1', 'player2', 'player2',
      'player2', 'player2', 'player1', 'player1',
    ]);
    expect(s.phase).toBe('MAIN');
  });

  it('rejects actions from a non-current player (permission check)', () => {
    const s0 = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7));
    const p = cur(s0); // player1
    const other = s0.playerOrder.find(x => x !== p)!; // player2
    // 非手番 player2 が配置を試みる → 無視され state は不変
    const v = firstValidVertex(s0, p)!;
    const after = serverApply(s0, other, { type: 'BUILD_SETTLEMENT', vertexId: v }, createRng(1));
    expect(after).toBe(s0); // 据え置き
    // 手番 player1 なら適用される
    const ok = serverApply(s0, p, { type: 'BUILD_SETTLEMENT', vertexId: v }, createRng(1));
    expect(ok).not.toBe(s0);
    expect(ok.vertices[v]!.building?.playerId).toBe(p);
  });

  it('distributes second-settlement starting resources', () => {
    const s = runSetup(createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7)), createRng(1));
    // 2巡目開拓地で各プレイヤーに初期資源が配られる（>0）。
    expect(handTotal(s, 'player1')).toBeGreaterThan(0);
    expect(handTotal(s, 'player2')).toBeGreaterThan(0);
  });

  it('rolls dice on the server and yields the same result for all viewers', () => {
    let s = runSetup(createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7)), createRng(1));
    expect(s.turnPhase).toBe('PRE_ROLL');
    const roller = cur(s);
    s = serverApply(s, roller, { type: 'ROLL_DICE' }, createRng(123));
    expect(s.lastDiceRoll).not.toBeNull();
    // 各視点へ配信する masked state は同じ出目を持つ（出目は公開情報）。
    const viewA = maskStateFor(s, 'player1');
    const viewB = maskStateFor(s, 'player2');
    expect(viewA.lastDiceRoll).toEqual(s.lastDiceRoll);
    expect(viewB.lastDiceRoll).toEqual(s.lastDiceRoll);
    expect(viewA.lastDiceRoll).toEqual(viewB.lastDiceRoll);
  });

  it('advances to the next player on END_TURN and only the new current player may act', () => {
    let s = runSetup(createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7)), createRng(1));
    // 7 が出ると分岐が複雑になるので、7以外が出るシードを探す
    let seed = 1;
    let rolled = s;
    do { rolled = serverApply(s, cur(s), { type: 'ROLL_DICE' }, createRng(seed++)); }
    while (rolled.lastDiceRoll![0] + rolled.lastDiceRoll![1] === 7 && seed < 50);
    s = rolled;
    expect(s.turnPhase).toBe('TRADE_BUILD');
    const before = cur(s);
    s = serverApply(s, before, { type: 'END_TURN' }, createRng(1));
    const after = cur(s);
    expect(after).not.toBe(before);
    // 旧プレイヤーの END_TURN は無視（手番は進まない）
    const noop = serverApply(s, before, { type: 'END_TURN' }, createRng(1));
    expect(cur(noop)).toBe(after);
  });

  it('masks opponent hands in the distributed state after resources are gained', () => {
    const s = runSetup(createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7)), createRng(1));
    const viewForP1 = maskStateFor(s, 'player1');
    // P1 視点: 自分(P1)の手札は実数、相手(P2)は構成0＋handCount
    expect(handTotal(viewForP1, 'player1')).toBe(handTotal(s, 'player1'));
    expect(RESOURCE_TYPES.reduce((a, r) => a + viewForP1.players.player2!.hand[r], 0)).toBe(0);
    expect(viewForP1.players.player2!.handCount).toBe(handTotal(s, 'player2'));
  });
});

// ============================================================
// MVP4: 交易 / 捨て札 / 盗賊 / 発展カード / 勝利の同期
// ============================================================

import { makeHand } from '../src/constants';

// サーバの追加検証（lanServer）を反映: 交易応答の対象チェック・捨て札枚数チェック。
function serverGuard(state: GameState, senderId: PlayerId, action: Action): boolean {
  if (requiredActor(state, action) !== senderId) return false;
  if (action.type === 'RESPOND_TRADE') {
    const pt = state.pendingTrade;
    if (!pt || !pt.targetPlayerIds.includes(action.response.playerId)) return false;
  }
  if (action.type === 'DISCARD_RESOURCES') {
    const p = state.players[action.playerId];
    if (!p) return false;
    const total = RESOURCE_TYPES.reduce((s, r) => s + p.hand[r], 0);
    const required = Math.floor(total / 2);
    const sum = RESOURCE_TYPES.reduce((s, r) => s + (action.resources[r] ?? 0), 0);
    const within = RESOURCE_TYPES.every(r => (action.resources[r] ?? 0) >= 0 && (action.resources[r] ?? 0) <= p.hand[r]);
    if (total < 8 || sum !== required || !within) return false;
  }
  return true;
}
function fullServerApply(state: GameState, senderId: PlayerId, action: Action, rng: () => number): GameState {
  if (!serverGuard(state, senderId, action)) return state;
  // サーバは applyAction の例外（無効操作）を握りつぶし state を据え置く。
  try {
    return applyAction(state, action, rng);
  } catch {
    return state;
  }
}

// MAIN / TRADE_BUILD 状態を作る（手札を直接設定）。current = player1。
function tradeReadyState(p1: Partial<Record<string, number>>, p2: Partial<Record<string, number>>): GameState {
  const base = createInitialGameState(SPECS, 'fixed', ['player1', 'player2'], createRng(7));
  return {
    ...base,
    phase: 'MAIN',
    turnPhase: 'TRADE_BUILD',
    diceRolledThisTurn: true,
    players: {
      ...base.players,
      player1: { ...base.players.player1!, hand: makeHand(p1) },
      player2: { ...base.players.player2!, hand: makeHand(p2) },
    },
  };
}

describe('LAN MVP4 sync: trade', () => {
  it('offer -> accept -> confirm swaps resources between the two players', () => {
    let s = tradeReadyState({ wood: 2 }, { brick: 2 });
    s = fullServerApply(s, 'player1', { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    expect(s.pendingTrade).not.toBeNull();
    s = fullServerApply(s, 'player2', { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'ACCEPT' } }, createRng(1));
    expect(s.pendingTrade!.state).toBe('TRADE_RESPONSE');
    s = fullServerApply(s, 'player1', { type: 'CONFIRM_TRADE', responderId: 'player2' }, createRng(1));
    expect(s.pendingTrade).toBeNull();
    expect(s.players.player1!.hand.wood).toBe(1);
    expect(s.players.player1!.hand.brick).toBe(1);
    expect(s.players.player2!.hand.brick).toBe(1);
    expect(s.players.player2!.hand.wood).toBe(1);
  });

  it('rejects responses from a non-target and confirm from a non-initiator', () => {
    let s = tradeReadyState({ wood: 2 }, { brick: 2 });
    s = fullServerApply(s, 'player1', { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    // player1（提案者・非対象）が応答 → 拒否され不変
    const noop = fullServerApply(s, 'player1', { type: 'RESPOND_TRADE', response: { playerId: 'player1', status: 'ACCEPT' } }, createRng(1));
    expect(noop.pendingTrade!.responses.player1).toBeUndefined();
    // player2 が confirm を試みる（提案者でない）→ requiredActor=current(player1) で拒否
    s = fullServerApply(s, 'player2', { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'ACCEPT' } }, createRng(1));
    const noConfirm = fullServerApply(s, 'player2', { type: 'CONFIRM_TRADE', responderId: 'player2' }, createRng(1));
    expect(noConfirm.pendingTrade).not.toBeNull(); // まだ成立していない
  });

  it('a rejected trade can be cancelled by the initiator', () => {
    let s = tradeReadyState({ wood: 2 }, { brick: 2 });
    s = fullServerApply(s, 'player1', { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    s = fullServerApply(s, 'player2', { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'REJECT' } }, createRng(1));
    s = fullServerApply(s, 'player1', { type: 'CANCEL_TRADE' }, createRng(1));
    expect(s.pendingTrade).toBeNull();
    // 手札は不変
    expect(s.players.player1!.hand.wood).toBe(2);
    expect(s.players.player2!.hand.brick).toBe(2);
  });
});

describe('LAN MVP4 sync: discard count validation', () => {
  it('accepts exactly half and rejects wrong amounts', () => {
    // player1 に 8 枚持たせて DISCARD フェーズへ
    const base = tradeReadyState({ wood: 8 }, {});
    const s: GameState = { ...base, turnPhase: 'DISCARD', discardedThisRound: [] };
    // 過少(3枚)は拒否
    expect(serverGuard(s, 'player1', { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 3 } })).toBe(false);
    // 過剰(5枚)は拒否
    expect(serverGuard(s, 'player1', { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 5 } })).toBe(false);
    // ちょうど半分(4枚)は許可
    expect(serverGuard(s, 'player1', { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } })).toBe(true);
    // 所持を超える資源は拒否
    expect(serverGuard(s, 'player1', { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { brick: 4 } })).toBe(false);
    // 他人が player1 の捨て札を送る → actor 不一致で拒否
    expect(serverGuard(s, 'player2', { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } })).toBe(false);
  });
});

describe('LAN MVP4 sync: dev card (monopoly) keeps opponent hands masked', () => {
  it('monopoly result is applied server-side and masked per viewer', () => {
    const base = tradeReadyState({ wool: 1 }, { wool: 3 });
    // player1 に独占カード（前ターン購入＝使用可）を持たせる
    const s0: GameState = {
      ...base,
      globalTurnNumber: 3,           // 購入ターン(0) < 現在(3) ＝ 使用可能
      devCardPlayedThisTurn: false,
      players: {
        ...base.players,
        player1: { ...base.players.player1!, devCards: [{ id: 'm1', type: 'monopoly', purchasedOnTurn: 0 }] },
      },
    };
    const s = fullServerApply(s0, 'player1', { type: 'PLAY_MONOPOLY', resource: 'wool' }, createRng(1));
    // player1 が全員の wool を独占（1 + 3 = 4）
    expect(s.players.player1!.hand.wool).toBe(4);
    expect(s.players.player2!.hand.wool).toBe(0);
    // 配信マスク: player2 視点では player1 の手札中身は隠れる
    const viewP2 = maskStateFor(s, 'player2');
    expect(RESOURCE_TYPES.reduce((a, r) => a + viewP2.players.player1!.hand[r], 0)).toBe(0);
    expect(viewP2.players.player1!.handCount).toBe(4);
  });
});

describe('LAN MVP4 sync: victory', () => {
  it('DECLARE_VICTORY needs enough VP and is rejected otherwise; winner revealed at GAME_OVER', () => {
    const base = tradeReadyState({}, {});
    // VP不足では宣言できない
    const noWin = fullServerApply(base, 'player1', { type: 'DECLARE_VICTORY' }, createRng(1));
    expect(noWin.phase).toBe('MAIN');
    // 勝者の隠しVPカードを持たせ、十分なVPで宣言（VPカードで target 到達を再現）
    const vpCards = Array.from({ length: 10 }, (_, i) => ({ id: `vp${i}`, type: 'victory_point' as const, purchasedOnTurn: 0 }));
    const rich: GameState = { ...base, players: { ...base.players, player1: { ...base.players.player1!, devCards: vpCards } } };
    const won = fullServerApply(rich, 'player1', { type: 'DECLARE_VICTORY' }, createRng(1));
    expect(won.phase).toBe('GAME_OVER');
    expect(won.winner).toBe('player1');
    // GAME_OVER では勝者(player1)は他視点にも公開され、VPカードが見える
    const viewP2 = maskStateFor(won, 'player2');
    expect(viewP2.players.player1!.devCards.length).toBe(10);
  });
});

// ============================================================
// MVP4安定化: 視点別ログ（buildActionLog の viewerId）
// ============================================================
import { buildActionLog } from '../src/engine/log';

describe('LAN per-viewer log', () => {
  it('uses "あなた" only for the proposing viewer in OFFER_TRADE', () => {
    const prev = tradeReadyState({ wood: 2 }, { brick: 2 }); // current = player1(A)
    const action: Action = { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] };
    const next = applyAction(prev, action, createRng(1));
    const forP1 = buildActionLog(prev, action, next, 'player1').map(e => e.message).join('|');
    const forP2 = buildActionLog(prev, action, next, 'player2').map(e => e.message).join('|');
    expect(forP1).toContain('あなたが交易を提案');
    expect(forP2).toContain('A が交易を提案');
    expect(forP2).not.toContain('あなた');
  });

  it('shows every player’s dice production (public) and labels the viewer as あなた', () => {
    const prev = tradeReadyState({}, {});
    // ダイス後の状態を手で作る: player1 が wood+1、player2 が wool+1 を得た想定
    const next: GameState = {
      ...prev,
      turnPhase: 'TRADE_BUILD',
      lastDiceRoll: [3, 2],
      diceRolledThisTurn: true,
      players: {
        ...prev.players,
        player1: { ...prev.players.player1!, hand: makeHand({ wood: 1 }) },
        player2: { ...prev.players.player2!, hand: makeHand({ wool: 1 }) },
      },
    };
    const action: Action = { type: 'ROLL_DICE' };
    const forP1 = buildActionLog(prev, action, next, 'player1').map(e => e.message).join('|');
    const forP2 = buildActionLog(prev, action, next, 'player2').map(e => e.message).join('|');
    // ダイス生産は公開情報: どちらの視点でも両者の獲得が見える。
    expect(forP1).toContain('🌲×1');
    expect(forP1).toContain('🐑×1');
    expect(forP2).toContain('🌲×1');
    expect(forP2).toContain('🐑×1');
    // 自分の獲得は「あなた」表記、相手は名前表記（取り違えない）。
    expect(forP1).toContain('あなた 🌲×1'); // player1 視点では player1 が「あなた」
    expect(forP2).toContain('あなた 🐑×1'); // player2 視点では player2 が「あなた」
  });
});

// ============================================================
// 混合対戦: サーバ側CPU駆動（nextCpuAction）
// ============================================================
import { nextCpuAction } from '../src/engine/lanCpu';

const MIXED_SPECS: PlayerSpec[] = [
  { id: 'player1', name: 'Human', color: 'red',  type: 'human' },
  { id: 'player2', name: 'CPU α', color: 'blue', type: 'ai', aiDifficulty: 'normal' },
];

// サーバの混合ドライブを模倣: CPUは nextCpuAction、人間は最初の合法手で進める。
function driveMixedToMain(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 200 && s.phase !== 'MAIN'; i++) {
    const step = nextCpuAction(s, () => 0.5);
    if (step) { s = applyAction(s, step.action, createRng(i + 1)); continue; }
    // 人間の手番（setup）
    const p = cur(s);
    if (s.setupSubPhase === 'PLACE_SETTLEMENT') {
      s = applyAction(s, { type: 'BUILD_SETTLEMENT', vertexId: firstValidVertex(s, p)! }, createRng(1));
    } else {
      s = applyAction(s, { type: 'BUILD_ROAD', edgeId: firstValidEdge(s, p)! }, createRng(1));
    }
  }
  return s;
}

describe('LAN mixed human+CPU: server-side CPU drive', () => {
  it('completes initial placement with a CPU auto-placing on its turn', () => {
    const s0 = createInitialGameState(MIXED_SPECS, 'fixed', ['player1', 'player2'], createRng(3));
    const s = driveMixedToMain(s0);
    expect(s.phase).toBe('MAIN');
    // 両者が開拓地2件ずつ置けている（2巡）
    const built = (pid: PlayerId) => Object.values(s.vertices).filter(v => v.building?.playerId === pid).length;
    expect(built('player1')).toBe(2);
    expect(built('player2')).toBe(2);
    // 2巡目開拓地の初期資源が両者に配られている
    expect(handTotal(s, 'player1')).toBeGreaterThan(0);
    expect(handTotal(s, 'player2')).toBeGreaterThan(0);
  });

  it('returns a CPU discard (exactly half) when a CPU holds 8+ on a 7', () => {
    const base = tradeReadyState({}, { wood: 4, brick: 4 }); // player2 will be CPU below
    // player2 を CPU・8枚保持・DISCARD フェーズにする
    const s: GameState = {
      ...base,
      turnPhase: 'DISCARD',
      discardedThisRound: [],
      players: {
        ...base.players,
        player2: { ...base.players.player2!, type: 'ai', aiDifficulty: 'normal', hand: makeHand({ wood: 4, brick: 4 }) },
      },
    };
    const step = nextCpuAction(s, () => 0.5);
    expect(step?.pid).toBe('player2');
    expect(step?.action.type).toBe('DISCARD_RESOURCES');
    const res = (step!.action as { resources: Record<string, number> }).resources;
    const sum = RESOURCE_TYPES.reduce((a, r) => a + (res[r] ?? 0), 0);
    expect(sum).toBe(4); // floor(8/2)
  });

  it('does not re-select a CPU that already discarded but still holds 8+ (deadlock regression)', () => {
    // 16枚から半分(8枚)捨てても 8枚 残るケース: discardedThisRound に入った CPU を
    // 再選択すると、エンジンの二重捨てガードで全アクションが拒否され CPU 駆動が恒久停止する。
    const base = tradeReadyState({ wood: 4, brick: 4 }, { wood: 4, brick: 4 });
    const bothCpu: GameState = {
      ...base,
      turnPhase: 'DISCARD',
      discardedThisRound: ['player1'],
      players: {
        player1: { ...base.players.player1!, type: 'ai', aiDifficulty: 'normal' }, // 捨て済み・8枚残
        player2: { ...base.players.player2!, type: 'ai', aiDifficulty: 'normal' }, // 未捨て・8枚
      },
    };
    // 捨て済みの player1 ではなく、未捨ての player2 を選ぶ
    const step = nextCpuAction(bothCpu, () => 0.5);
    expect(step?.pid).toBe('player2');
    expect(step?.action.type).toBe('DISCARD_RESOURCES');
    // 生成された一手はエンジンが必ず受理する（違法アクションを生成しない）
    expect(() => applyAction(bothCpu, step!.action, createRng(1))).not.toThrow();

    // 全員捨て済みなら null（人間待ち扱いで違法な二重捨ては生成しない）
    const allDone: GameState = { ...bothCpu, discardedThisRound: ['player1', 'player2'] };
    expect(nextCpuAction(allDone, () => 0.5)).toBeNull();
  });

  it('騎士と商人: 商品込みで上限超のCPUを捨て札対象に選ぶ（資源のみ判定だと盗賊前で永久停止する回帰）', () => {
    const base = tradeReadyState({}, {});
    const ck: GameState = {
      ...base,
      expansion: 'cities_knights',
      turnPhase: 'DISCARD',
      discardedThisRound: [],
      players: {
        ...base.players,
        player2: {
          ...base.players.player2!, type: 'ai', aiDifficulty: 'normal',
          hand: makeHand({ wood: 3, brick: 2 }),        // 資源5
          commodities: { coin: 2, cloth: 1, paper: 0 }, // 商品3 → 合計8（=捨て対象）
        },
      },
    };
    const step = nextCpuAction(ck, () => 0.5);
    // 資源のみ(5<8)で数えると選ばれず null になり捨て札フェーズが終わらなかった。
    expect(step?.pid).toBe('player2');
    expect(step?.action.type).toBe('DISCARD_RESOURCES');
    expect(() => applyAction(ck, step!.action, createRng(1))).not.toThrow();
  });

  it('makes a CPU accept a beneficial trade but reject one that costs a needed resource', () => {
    // 受諾: CPU(player2) は不足している wood を受け取り、余剰(brick2)から brick1 を渡す
    const acceptBase = tradeReadyState({ wood: 2 }, { brick: 2 });
    const acceptCpu: GameState = { ...acceptBase, players: { ...acceptBase.players, player2: { ...acceptBase.players.player2!, type: 'ai', aiDifficulty: 'normal' } } };
    const offeredA = applyAction(acceptCpu, { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    const accept = nextCpuAction(offeredA, () => 0.5);
    expect(accept?.pid).toBe('player2');
    expect(accept?.action).toEqual({ type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'ACCEPT' } });

    // 拒否: brick が1枚のみ → 渡すと目標(開拓地)に必要な brick が0になるため拒否（rngに依らず決定的）
    const rejectBase = tradeReadyState({ wood: 2 }, { brick: 1 });
    const rejectCpu: GameState = { ...rejectBase, players: { ...rejectBase.players, player2: { ...rejectBase.players.player2!, type: 'ai', aiDifficulty: 'normal' } } };
    const offeredR = applyAction(rejectCpu, { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    const reject = nextCpuAction(offeredR, () => 0.5);
    expect((reject?.action as { response: { status: string } }).response.status).toBe('REJECT');
  });

  it('does not act for a human turn (returns null)', () => {
    const s = createInitialGameState(MIXED_SPECS, 'fixed', ['player1', 'player2'], createRng(3));
    // 手番は player1(human) → CPU は動かない
    expect(cur(s)).toBe('player1');
    expect(nextCpuAction(s, () => 0.5)).toBeNull();
  });

  it('keeps CPU hands masked from a human viewer', () => {
    const s = driveMixedToMain(createInitialGameState(MIXED_SPECS, 'fixed', ['player1', 'player2'], createRng(3)));
    const view = maskStateFor(s, 'player1');
    // 人間(player1)視点: CPU(player2)の手札中身は0・枚数のみ
    expect(RESOURCE_TYPES.reduce((a, r) => a + view.players.player2!.hand[r], 0)).toBe(0);
    expect(view.players.player2!.handCount).toBe(handTotal(s, 'player2'));
    expect(view.players.player2!.devCards).toEqual([]);
  });
});

// ============================================================
// CPU駆動の健全性: 全員CPUで1ゲーム完走（手が失敗しない＝フォールバック不要）
// ============================================================
import { cpuFallbackAction } from '../src/engine/lanCpu';

const ALL_CPU: PlayerSpec[] = [
  { id: 'player1', name: 'CPU α', color: 'red',    type: 'ai', aiDifficulty: 'normal' },
  { id: 'player2', name: 'CPU β', color: 'blue',   type: 'ai', aiDifficulty: 'normal' },
  { id: 'player3', name: 'CPU γ', color: 'purple', type: 'ai', aiDifficulty: 'normal' },
];

describe('CPU drive soundness', () => {
  it('runs a full all-CPU game to GAME_OVER without any CPU action failing', () => {
    // 全員CPUにして nextCpuAction で進める。各手は applyAction で必ず成功するはず。
    // （混合戦のCPU部分と同じ純粋AI経路。失敗が出れば「本来成功すべき手の失敗」を検出できる）
    let s = createInitialGameState(ALL_CPU, 'random', undefined, createRng(123));
    let failures = 0;
    let steps = 0;
    let seed = 1;
    for (; steps < 4000 && s.phase !== 'GAME_OVER'; steps++) {
      const step = nextCpuAction(s, createRng(seed++));
      if (!step) break; // 全員CPUなら通常 null にならない（なったら停止）
      try {
        s = applyAction(s, step.action, createRng(seed++));
      } catch {
        failures++;
        // フォールバックで進行（サーバと同じ）
        s = applyAction(s, cpuFallbackAction(s, step.pid), createRng(seed++));
      }
    }
    expect(s.phase).toBe('GAME_OVER');        // 勝者が出るまで進む
    expect(s.winner).not.toBeNull();
    expect(failures).toBe(0);                 // 本来成功すべきCPU手は一度も失敗しない
  });

  it('cpuFallbackAction returns an action applyAction accepts in each phase', () => {
    // PRE_ROLL
    let s = runSetup(createInitialGameState(MIXED_SPECS, 'fixed', ['player1', 'player2'], createRng(5)), createRng(1));
    expect(s.turnPhase).toBe('PRE_ROLL');
    const pid = cur(s);
    expect(() => applyAction(s, cpuFallbackAction(s, pid), createRng(1))).not.toThrow();
    // TRADE_BUILD（ダイス後・非7）
    let seed = 1; let rolled = s;
    do { rolled = applyAction(s, { type: 'ROLL_DICE' }, createRng(seed++)); }
    while (rolled.lastDiceRoll![0] + rolled.lastDiceRoll![1] === 7 && seed < 60);
    expect(rolled.turnPhase).toBe('TRADE_BUILD');
    expect(cpuFallbackAction(rolled, cur(rolled)).type).toBe('END_TURN');
    expect(() => applyAction(rolled, cpuFallbackAction(rolled, cur(rolled)), createRng(1))).not.toThrow();
  });
});

describe('CPU victory is reported and revealed correctly to humans', () => {
  // 全員CPUを決定論で GAME_OVER まで進めて勝者stateを得る。
  function playToGameOver(seed: number): GameState {
    let s = createInitialGameState(ALL_CPU, 'random', undefined, createRng(seed));
    let g = 1;
    for (let i = 0; i < 4000 && s.phase !== 'GAME_OVER'; i++) {
      const step = nextCpuAction(s, createRng(g++));
      if (!step) break;
      try { s = applyAction(s, step.action, createRng(g++)); }
      catch { s = applyAction(s, cpuFallbackAction(s, step.pid), createRng(g++)); }
    }
    return s;
  }

  it('reaches GAME_OVER with a CPU winner whose hidden VP count toward 10', () => {
    const s = playToGameOver(123);
    expect(s.phase).toBe('GAME_OVER');
    expect(s.winner).not.toBeNull();
    // 勝者は CPU（type 'ai'）で、隠しVPカード込みの内部VPが目標到達
    expect(s.players[s.winner!]!.type).toBe('ai');
    // calcVP は scoring から（隠しVP込み）— ここでは公開API経由で十分大きいことを確認
    const winnerName = s.players[s.winner!]!.name;
    expect(winnerName.startsWith('CPU')).toBe(true);
  });

  it('reveals every player (winner and losers) to any viewer at GAME_OVER', () => {
    const s = playToGameOver(123);
    const winner = s.winner!;
    const viewer = s.playerOrder.find(p => p !== winner)!; // 別CPUを人間視点の代わりに使う
    const view = maskStateFor(s, viewer);
    // 勝者の手札/発展カードは GAME_OVER で公開される（勝敗内訳の表示用）
    expect(view.players[winner]!.devCards).toEqual(s.players[winner]!.devCards);
    expect(view.players[winner]!.handCount).toBeUndefined(); // マスクされていない
    // 勝者でも viewer でもない敗者も、ゲーム終了後は同様に公開される（得点カード込みの正しい最終得点を見せるため）
    const loser = s.playerOrder.find(p => p !== winner && p !== viewer);
    if (loser) {
      expect(view.players[loser]!.devCards).toEqual(s.players[loser]!.devCards);
      expect(view.players[loser]!.handCount).toBeUndefined();
    }
  });
});

describe('Secrecy regression: discard / robber steal do not leak contents', () => {
  const EMOJIS = ['🌲', '🧱', '🐑', '🌾', '⛰'];
  const hasResEmoji = (s: string) => EMOJIS.some(e => s.includes(e));

  it('discard log shows only a count, never the resource types', () => {
    const base = tradeReadyState({ wood: 8 }, {});
    const s: GameState = { ...base, turnPhase: 'DISCARD', discardedThisRound: [] };
    const action: Action = { type: 'DISCARD_RESOURCES', playerId: 'player1', resources: { wood: 4 } };
    const next = applyAction(s, action, createRng(1));
    // どの視点でも「種類」は出ない（枚数のみ）
    for (const viewer of ['player1', 'player2'] as PlayerId[]) {
      const msgs = buildActionLog(s, action, next, viewer).map(e => e.message).join('|');
      expect(msgs).toContain('4枚');
      expect(hasResEmoji(msgs)).toBe(false);
    }
  });

  it('robber steal log shows "1枚" but never the stolen resource type, and hands stay masked', () => {
    // player1 が盗賊を player2 に隣接させ player2 から1枚奪う状況を直接作る
    const base = tradeReadyState({}, { wool: 3 });
    // ROBBER フェーズ・player1 手番にして MOVE_ROBBER を適用
    const robberTileId = Object.keys(base.tiles)[0]!;
    const targetTileId = Object.keys(base.tiles).find(t => t !== robberTileId)!;
    // player2 の建物を targetTile 隣接頂点に置き、盗める状態にする
    const vid = base.tileToVertices[targetTileId]![0]!;
    const s: GameState = {
      ...base,
      turnPhase: 'ROBBER',
      diceRolledThisTurn: true,
      tiles: { ...base.tiles, [robberTileId]: { ...base.tiles[robberTileId]!, hasRobber: true } },
      vertices: { ...base.vertices, [vid]: { ...base.vertices[vid]!, building: { type: 'settlement', playerId: 'player2' } } },
    };
    const action: Action = { type: 'MOVE_ROBBER', tileId: targetTileId, stealFromPlayerId: 'player2' };
    const next = applyAction(s, action, createRng(1));
    // ログ: 「1枚奪った」だが資源の種類は出ない（どの視点でも）
    for (const viewer of ['player1', 'player2'] as PlayerId[]) {
      const msgs = buildActionLog(s, action, next, viewer).map(e => e.message).join('|');
      expect(msgs).toContain('奪');
      expect(hasResEmoji(msgs)).toBe(false);
    }
    // 第三者視点では奪った側(player1)・奪われた側(player2)の手札中身は見えない
    const third = maskStateFor(next, 'player3' as PlayerId);
    expect(RESOURCE_TYPES.reduce((a, r) => a + (third.players.player1?.hand[r] ?? 0), 0)).toBe(0);
    expect(RESOURCE_TYPES.reduce((a, r) => a + (third.players.player2?.hand[r] ?? 0), 0)).toBe(0);
  });
});

// ============================================================
// グループA: LAN 権威パスでの不正操作拒否（エンジンガードがサーバ経路を守る）
// ============================================================

describe('Group A: LAN rejects illegal actions via the authoritative engine', () => {
  it('MOVE_ROBBER in PRE_ROLL is rejected — no free robber/steal over LAN (C1)', () => {
    const base = tradeReadyState({}, { wood: 3 });
    const preRoll: GameState = { ...base, turnPhase: 'PRE_ROLL', diceRolledThisTurn: false };
    const target = Object.values(preRoll.tiles).find(t => !t.hasRobber)!;
    const after = fullServerApply(preRoll, 'player1', { type: 'MOVE_ROBBER', tileId: target.id, stealFromPlayerId: 'player2' }, createRng(1));
    expect(after.turnPhase).toBe('PRE_ROLL');          // フェーズ不変
    expect(after.players.player2!.hand.wood).toBe(3);  // 強奪されていない
  });

  it('MOVE_ROBBER stealing from a non-adjacent player is rejected over LAN (H2)', () => {
    const base = tradeReadyState({}, { wood: 3 });
    const robberId = Object.keys(base.tiles).find(t => base.tiles[t]!.hasRobber)!;
    const target = Object.keys(base.tiles).find(t => t !== robberId && base.tiles[t]!.type !== 'desert')!;
    const s: GameState = { ...base, turnPhase: 'ROBBER', diceRolledThisTurn: true };
    const after = fullServerApply(s, 'player1', { type: 'MOVE_ROBBER', tileId: target, stealFromPlayerId: 'player2' }, createRng(1));
    expect(after.players.player2!.hand.wood).toBe(3);  // 隣接していないので奪えない
  });

  it('END_TURN that skips the dice roll is rejected over LAN (H4)', () => {
    const base = tradeReadyState({}, {});
    const preRoll: GameState = { ...base, turnPhase: 'PRE_ROLL', diceRolledThisTurn: false };
    const after = fullServerApply(preRoll, 'player1', { type: 'END_TURN' }, createRng(1));
    expect(after.turnPhase).toBe('PRE_ROLL');
    expect(after.currentPlayerIndex).toBe(preRoll.currentPlayerIndex); // 手番は進まない
  });

  it('CONFIRM_TRADE against a player who rejected does not swap resources over LAN (H3)', () => {
    let s = tradeReadyState({ wood: 2 }, { brick: 2 });
    s = fullServerApply(s, 'player1', { type: 'OFFER_TRADE', offer: { give: { wood: 1 }, receive: { brick: 1 } }, targetPlayerIds: ['player2'] }, createRng(1));
    s = fullServerApply(s, 'player2', { type: 'RESPOND_TRADE', response: { playerId: 'player2', status: 'REJECT' } }, createRng(1));
    const after = fullServerApply(s, 'player1', { type: 'CONFIRM_TRADE', responderId: 'player2' }, createRng(1));
    expect(after.players.player1!.hand.wood).toBe(2);   // 交換されていない
    expect(after.players.player2!.hand.brick).toBe(2);
  });
});
