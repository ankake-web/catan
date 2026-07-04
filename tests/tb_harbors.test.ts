// ============================================================
// tests/tb_harbors.test.ts — 交易と蛮族「強き港(Strongest Ports)」変種
// ============================================================
// 公式ルールブック第6版 CN3089 p3-4 の数値・ルールを固定するテスト。
//   - 港上の建物のVP合計（開拓地1・都市2）が最多（最低3VP）のプレイヤーが Strongest Ports タイル(+2VP)を保持。
//   - 同点では移動しない（現保持者優先）。他者が strictly 上回れば即移動。
//   - 「基本＋強き港」シナリオ tb_harbors は 11点で勝利。

import { describe, it, expect } from 'vitest';
import { makeGameState } from './helpers';
import { calcPortBuildingVp, updateStrongestPorts, calcVP } from '../src/engine/scoring';
import { getScenario, listVisibleScenarios, getScenarioRules } from '../src/engine/scenarios';
import { createInitialGameState } from '../src/engine/createState';
import { createRng } from '../src/engine/setup';
import type { GameState, VertexId, PlayerId, BuildingType } from '../src/types';

/** 盤上の「港に面した頂点」（harborType が付いている頂点）ID 一覧。 */
function harborVertexIds(state: GameState): VertexId[] {
  return (Object.keys(state.vertices) as VertexId[])
    .filter(vid => state.vertices[vid]!.harborType != null);
}

/** 頂点に建物を直接置く（採点ロジック単体検証用。配置規則は無視）。 */
function place(state: GameState, vid: VertexId, playerId: PlayerId, type: BuildingType): GameState {
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, building: { type, playerId } } },
  };
}

describe('交易と蛮族「強き港」: シナリオ登録と数値の固定', () => {
  it('tb_harbors は traders_barbarians カテゴリ・勝利目標11点・strongestPorts 有効', () => {
    const sc = getScenario('tb_harbors');
    expect(sc.category).toBe('traders_barbarians');
    expect(sc.victoryTarget).toBe(11);           // 公式: 基本+1
    expect(sc.rules?.strongestPorts).toBe(true);
  });

  it('盤面選択UIに表示され、遊び方ルールが用意されている', () => {
    expect(listVisibleScenarios().some(s => s.id === 'tb_harbors')).toBe(true);
    expect(getScenarioRules('tb_harbors').length).toBeGreaterThan(0);
  });

  it('createInitialGameState は strongestPorts と保持者null・目標11を配線する', () => {
    const st = createInitialGameState(
      [
        { id: 'player1', name: 'P1', color: 'red', type: 'human' },
        { id: 'player2', name: 'P2', color: 'blue', type: 'human' },
      ],
      'fixed', ['player1', 'player2'], createRng(1), 'tb_harbors',
    );
    expect(st.strongestPorts).toBe(true);
    expect(st.strongestPortsHolder).toBeNull();
    expect(st.victoryTarget).toBe(11);
  });
});

describe('交易と蛮族「強き港」: 港建物VPの計算', () => {
  it('港上の開拓地=1VP・都市=2VP、港でない建物は数えない', () => {
    let st = makeGameState({ strongestPorts: true, strongestPortsHolder: null });
    const ports = harborVertexIds(st);
    expect(ports.length).toBeGreaterThanOrEqual(4); // 基本盤は9港（頂点は複数）

    // 港頂点に開拓地1・都市1、非港頂点に開拓地1を置く。
    const nonPort = (Object.keys(st.vertices) as VertexId[])
      .find(vid => st.vertices[vid]!.harborType == null)!;
    st = place(st, ports[0]!, 'player1', 'settlement'); // +1
    st = place(st, ports[1]!, 'player1', 'city');       // +2
    st = place(st, nonPort, 'player1', 'city');         // 港でない→数えない

    expect(calcPortBuildingVp(st, 'player1')).toBe(3);
    expect(calcPortBuildingVp(st, 'player2')).toBe(0);
  });
});

describe('交易と蛮族「強き港」: タイル保持者の遷移(+2VP)', () => {
  it('3VP以上で単独最多なら獲得、保持者は calcVP に +2', () => {
    let st = makeGameState({ strongestPorts: true, strongestPortsHolder: null });
    const ports = harborVertexIds(st);
    // player1 が港建物VP=3、player2=0
    st = place(st, ports[0]!, 'player1', 'settlement');
    st = place(st, ports[1]!, 'player1', 'settlement');
    st = place(st, ports[2]!, 'player1', 'settlement');
    const vpBefore = calcVP(st, 'player1');
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBe('player1');
    expect(calcVP(st, 'player1')).toBe(vpBefore + 2); // タイルは+2VP
  });

  it('3VP未満では誰も獲得しない', () => {
    let st = makeGameState({ strongestPorts: true, strongestPortsHolder: null });
    const ports = harborVertexIds(st);
    st = place(st, ports[0]!, 'player1', 'settlement'); // 1VP
    st = place(st, ports[1]!, 'player1', 'settlement'); // 2VP（<3）
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBeNull();
  });

  it('同点では移動しない（現保持者優先）／strictly 上回ったら移動', () => {
    let st = makeGameState({ strongestPorts: true, strongestPortsHolder: null });
    const ports = harborVertexIds(st);
    // player1=3VP で獲得
    st = place(st, ports[0]!, 'player1', 'settlement');
    st = place(st, ports[1]!, 'player1', 'settlement');
    st = place(st, ports[2]!, 'player1', 'settlement');
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBe('player1');

    // player2 が同じ3VP（都市1＋開拓1）→ 同点なので移動しない
    st = place(st, ports[3]!, 'player2', 'city');       // 2
    st = place(st, ports[4]!, 'player2', 'settlement'); // +1 = 3（tie）
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBe('player1');

    // player2 が4VPで上回る → 移動
    st = place(st, ports[5]!, 'player2', 'settlement'); // = 4
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBe('player2');
  });

  it('初回獲得が同点(2人とも3VP)なら誰も取らない', () => {
    let st = makeGameState({ strongestPorts: true, strongestPortsHolder: null });
    const ports = harborVertexIds(st);
    st = place(st, ports[0]!, 'player1', 'settlement');
    st = place(st, ports[1]!, 'player1', 'settlement');
    st = place(st, ports[2]!, 'player1', 'settlement'); // p1=3
    st = place(st, ports[3]!, 'player2', 'settlement');
    st = place(st, ports[4]!, 'player2', 'settlement');
    st = place(st, ports[5]!, 'player2', 'settlement'); // p2=3（tie・保持者なし）
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBeNull();
  });

  it('strongestPorts 無効なら no-op（保持者は付かず・VP加算なし）', () => {
    let st = makeGameState(); // strongestPorts 未設定
    const ports = harborVertexIds(st);
    st = place(st, ports[0]!, 'player1', 'settlement');
    st = place(st, ports[1]!, 'player1', 'settlement');
    st = place(st, ports[2]!, 'player1', 'settlement');
    const before = calcVP(st, 'player1');
    st = updateStrongestPorts(st);
    expect(st.strongestPortsHolder).toBeUndefined();
    expect(calcVP(st, 'player1')).toBe(before);
  });
});
