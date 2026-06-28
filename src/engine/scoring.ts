// ============================================================
// src/engine/scoring.ts — L-08: VP・最長道路・最大騎士団
// ============================================================

import type { GameState, PlayerId, EdgeId, VertexId } from '../types';
import {
  VP_TABLE, LONGEST_ROAD_MIN, LARGEST_ARMY_MIN,
} from '../constants';

// ============================================================
// VP 計算
// ============================================================

/**
 * 指定プレイヤーの現在の勝利点を計算して返す（勝利点カード込み）。
 * エンジン内部の勝利判定・プレイヤー自身の表示に使用する。
 */
export function calcVP(state: GameState, playerId: PlayerId): number {
  const player = state.players[playerId];
  if (!player) return 0;

  let vp = 0;
  for (const vertex of Object.values(state.vertices)) {
    if (vertex.building?.playerId !== playerId) continue;
    vp += buildingVp(vertex.building);
  }
  if (player.hasLongestRoad) vp += VP_TABLE.longestRoad;
  if (player.hasLargestArmy) vp += VP_TABLE.largestArmy;
  vp += player.devCards.filter(c => c.type === 'victory_point').length * VP_TABLE.victoryPoint;
  vp += islandBonusVP(state, playerId);
  vp += (state.tokenVp ?? {})[playerId] ?? 0; // 航海者 S5: 海辺VPトークン（各+1・公開）
  vp += Math.floor(((state.cloth ?? {})[playerId] ?? 0) / 2); // 航海者 S6: 織物2枚=1VP（公開）
  vp += player.defenderVP ?? 0; // 騎士と商人: 蛮族撃退の守護者VP
  vp += ckProgressVP(state, playerId); // 進歩カード(印刷/立憲)＋商人コマ

  return vp;
}

/** 騎士と商人の公開VP: 進歩カード恒久VP(印刷/立憲)＋商人(merchant)コマ保持で+1。 */
function ckProgressVP(state: GameState, playerId: PlayerId): number {
  const player = state.players[playerId];
  let vp = player?.progressVP ?? 0;
  if (state.merchant?.playerId === playerId) vp += 1;
  return vp;
}

/** 建物の勝利点。メトロポリス(騎士と商人)は4、都市2、開拓地1。 */
function buildingVp(b: { type: 'settlement' | 'city'; metropolis?: boolean }): number {
  if (b.metropolis) return 4;
  return b.type === 'city' ? VP_TABLE.city : VP_TABLE.settlement;
}

/** 航海者: このプレイヤーが獲得した新島入植ボーナスの合計VP（公開情報）。基本ゲームは常に0。 */
function islandBonusVP(state: GameState, playerId: PlayerId): number {
  const per = state.newIslandBonusVp ?? VP_TABLE.island;
  let n = 0;
  for (const owners of Object.values(state.islandBonus ?? {})) {
    if (owners.includes(playerId)) n += per;
  }
  return n;
}

/**
 * 他プレイヤーから見える「公開勝利点」を計算して返す。
 * 勝利点カードは非公開なので合算しない。
 */
export function calcPublicVP(state: GameState, playerId: PlayerId): number {
  const player = state.players[playerId];
  if (!player) return 0;

  let vp = 0;
  for (const vertex of Object.values(state.vertices)) {
    if (vertex.building?.playerId !== playerId) continue;
    vp += buildingVp(vertex.building);
  }
  if (player.hasLongestRoad) vp += VP_TABLE.longestRoad;
  if (player.hasLargestArmy) vp += VP_TABLE.largestArmy;
  // 新島入植ボーナスは盤面で見える公開情報なので公開VPにも算入する。
  vp += islandBonusVP(state, playerId);
  vp += (state.tokenVp ?? {})[playerId] ?? 0; // 航海者 S5: 海辺VPトークンも公開情報
  vp += Math.floor(((state.cloth ?? {})[playerId] ?? 0) / 2); // 航海者 S6: 織物2枚=1VPも公開
  vp += player.defenderVP ?? 0; // 守護者VPも公開情報
  vp += ckProgressVP(state, playerId); // 進歩カード恒久VP・商人コマも公開

  return vp;
}

// ============================================================
// 最長道路（Longest Road）
// ============================================================

/**
 * 指定プレイヤーの最長連続「交易路」長を DFS で計算する（道＋船・航海者対応）。
 *
 * 切断ルール（rules.md §7-2）:
 *   - 相手プレイヤーの建物がある頂点は通過不可（交易路が切断される）。
 *   - 自分の建物がある頂点は通過可能。
 * 道↔船の切替（航海者 §船）:
 *   - 道と船は種別が異なるため、連続させるには切替点に自分の建物が必要。
 *     建物の無い頂点では同種（道→道 / 船→船）のみ繋がる。基本ゲームは船が無く常に道のみ。
 *
 * アルゴリズム:
 *   各自分の道/船 Edge を起点に DFS し、使用済み辺を visited に入れて
 *   到達可能な最長パスを求める。全起点の最大値を返す。
 */
export function calcLongestRoad(state: GameState, playerId: PlayerId): number {
  // 自分の道・船を種別付きで収集（船は航海者拡張）。
  const myEdges = new Map<EdgeId, 'road' | 'ship'>();
  for (const [eid, edge] of Object.entries(state.edges)) {
    if (edge.road?.playerId === playerId) myEdges.set(eid, 'road');
    else if (edge.ship?.playerId === playerId) myEdges.set(eid, 'ship');
  }
  if (myEdges.size === 0) return 0;

  // 相手の建物（開拓地/都市）がある頂点は通過不可（交易路が切断される）。自分の建物は通過可＆道↔船の切替点。
  // 騎士と商人: 公式ルールでは交易路を分断するのは相手の「建物」だけ。相手の騎士コマは分断しない
  //（騎士のいる頂点も道はそのまま通過＝全分岐を探索して最大長を採用）。
  const isBlocked = (vid: VertexId): boolean => {
    const v = state.vertices[vid];
    if (v?.building != null && v.building.playerId !== playerId) return true;
    return false;
  };
  const isOwnBuilding = (vid: VertexId): boolean =>
    state.vertices[vid]?.building?.playerId === playerId;

  let longest = 0;

  // 「方向付き」DFS。tipVid（フロンティア頂点）から1本ずつ前方にだけ伸ばす。
  // fromType は tipVid へ来た辺の種別。種別が変わる接続は自分の建物のある頂点でのみ許す。
  const extend = (tipVid: VertexId, fromType: 'road' | 'ship', visited: Set<EdgeId>, lengthSoFar: number): number => {
    let best = lengthSoFar;
    if (isBlocked(tipVid)) return best;
    const tip = state.vertices[tipVid];
    if (!tip) return best;
    const canSwitch = isOwnBuilding(tipVid);
    for (const nextEid of tip.adjacentEdgeIds) {
      const nextType = myEdges.get(nextEid);
      if (!nextType) continue;
      if (visited.has(nextEid)) continue;
      // 道↔船の切替は自分の建物のある頂点でのみ。同種はどこでも繋がる。
      if (nextType !== fromType && !canSwitch) continue;
      const nextEdge = state.edges[nextEid]!;
      const otherVid = nextEdge.vertexIds[0] === tipVid
        ? nextEdge.vertexIds[1] : nextEdge.vertexIds[0];
      visited.add(nextEid);
      const count = extend(otherVid!, nextType, visited, lengthSoFar + 1);
      if (count > best) best = count;
      visited.delete(nextEid);
    }
    return best;
  };

  // 各辺をどちらの端からも起点として、前方へ伸ばした最長を取る
  for (const [eid, type] of myEdges) {
    const edge = state.edges[eid]!;
    for (const startVid of edge.vertexIds) {
      const otherVid = edge.vertexIds[0] === startVid ? edge.vertexIds[1] : edge.vertexIds[0];
      const visited = new Set<EdgeId>([eid]);
      const count = extend(otherVid!, type, visited, 1);
      if (count > longest) longest = count;
    }
  }

  return longest;
}

/**
 * 最長道路ボーナス保持者を更新した GameState を返す。
 *
 * 遷移ルール（仕様書 §7-2）:
 *   A) 現保持者が最長を維持している場合（holderLen === maxLen）: 保持継続。
 *   B) 現保持者が最長を失った場合（holderLen < maxLen）:
 *      - 新しい最長を持つプレイヤーが1人だけ → そのプレイヤーが獲得。
 *      - 複数同点 → カードは場外（null）。
 *   C) 現保持者がいない場合:
 *      - 最長が1人だけで MIN 以上 → そのプレイヤーが獲得。
 *      - 複数同点またはMIN未満 → 場外のまま（null）。
 *   D) maxLen < LONGEST_ROAD_MIN → 場外（null）。
 */
export function updateLongestRoad(state: GameState): GameState {
  // 航海者: 最長交易路タイルを使わないシナリオ（S6 織物 / S7 海賊の島々）では誰も保持しない。
  // 長さ自体は表示用に保持しつつ、ボーナス保持者は常に null・全員 hasLongestRoad=false。
  if (state.useLongestRoute === false) {
    let ns = state;
    for (const pid of state.playerOrder) {
      ns = {
        ...ns,
        players: { ...ns.players, [pid]: { ...ns.players[pid]!, longestRoadLength: calcLongestRoad(state, pid as PlayerId), hasLongestRoad: false } },
      };
    }
    return { ...ns, longestRoadHolder: null };
  }

  // 全プレイヤーの実際の最長道路長を計算
  const lengths: Record<string, number> = {};
  let newState = state;

  for (const pid of state.playerOrder) {
    const length = calcLongestRoad(state, pid as PlayerId);
    lengths[pid] = length;
    newState = {
      ...newState,
      players: {
        ...newState.players,
        [pid]: { ...newState.players[pid]!, longestRoadLength: length },
      },
    };
  }

  const currentHolder = state.longestRoadHolder;
  const maxLen = state.playerOrder.reduce((m, pid) => Math.max(m, lengths[pid] ?? 0), 0);

  let newHolder: PlayerId | null;

  if (maxLen < LONGEST_ROAD_MIN) {
    // 誰も MIN 本以上ない → 場外
    newHolder = null;
  } else if (currentHolder !== null && (lengths[currentHolder] ?? 0) === maxLen) {
    // 保持者が最長を維持 → 保持継続
    newHolder = currentHolder;
  } else {
    // 最長者を特定: maxLen を持つプレイヤー一覧
    const topPlayers = state.playerOrder.filter(pid => (lengths[pid] ?? 0) === maxLen);
    if (topPlayers.length === 1) {
      // 単独最長 → 獲得（保持者が更新されるか保持者がいなかった場合）
      newHolder = topPlayers[0] as PlayerId;
    } else {
      // 複数同点 → 場外
      newHolder = null;
    }
  }

  // ボーナスフラグを更新
  for (const pid of state.playerOrder) {
    newState = {
      ...newState,
      players: {
        ...newState.players,
        [pid]: { ...newState.players[pid]!, hasLongestRoad: pid === newHolder },
      },
    };
  }

  return { ...newState, longestRoadHolder: newHolder };
}

// ============================================================
// 最大騎士団（Largest Army）
// ============================================================

/**
 * 最大騎士団ボーナス保持者を更新した GameState を返す。
 *
 * 遷移ルール（rules.md §7-3）:
 *   - 現保持者がいない場合: LARGEST_ARMY_MIN(3) 以上の最多者が取得。
 *   - 現保持者がいる場合: 他プレイヤーが現保持者を「上回った」場合のみ移動。
 *     同数では移動しない（現保持者優先）。
 */
export function updateLargestArmy(state: GameState): GameState {
  const currentHolder = state.largestArmyHolder;
  let newHolder = currentHolder;

  if (currentHolder === null) {
    let maxKnights = LARGEST_ARMY_MIN - 1;
    for (const pid of state.playerOrder) {
      const k = state.players[pid]?.knightsPlayed ?? 0;
      if (k > maxKnights) { maxKnights = k; newHolder = pid as PlayerId; }
    }
  } else {
    const holderKnights = state.players[currentHolder]?.knightsPlayed ?? 0;
    let maxKnights = holderKnights;
    for (const pid of state.playerOrder) {
      if (pid === currentHolder) continue;
      const k = state.players[pid]?.knightsPlayed ?? 0;
      if (k > maxKnights) { maxKnights = k; newHolder = pid as PlayerId; }
    }
  }

  // ボーナスフラグを更新
  let newState = state;
  for (const pid of state.playerOrder) {
    const has = pid === newHolder;
    newState = {
      ...newState,
      players: {
        ...newState.players,
        [pid]: { ...newState.players[pid]!, hasLargestArmy: has },
      },
    };
  }

  return { ...newState, largestArmyHolder: newHolder };
}

// ============================================================
// 勝利チェック
// ============================================================

/** このゲームの勝利に必要な勝利点。シナリオ別（基本=10／航海者=13）。未設定は VP_TABLE.target。 */
export function victoryTarget(state: GameState): number {
  return state.victoryTarget ?? VP_TABLE.target;
}

/**
 * アクティブプレイヤーが勝利条件（victoryTarget）を満たしているか確認し、
 * 満たしていれば winner と phase を更新した GameState を返す。
 */
export function checkVictory(state: GameState, playerId: PlayerId): GameState {
  // 航海者 S8「カタンの七不思議」: 不思議完成（Lv4）or 10VP以上かつ単独で最高レベル。
  if (state.wonderLevel !== undefined) {
    const myLevel = state.wonderLevel[playerId] ?? 0;
    if (myLevel >= 4) return { ...state, winner: playerId, phase: 'GAME_OVER' };
    if (calcVP(state, playerId) >= victoryTarget(state)) {
      const maxOther = state.playerOrder
        .filter(p => p !== playerId)
        .reduce((m, p) => Math.max(m, state.wonderLevel![p] ?? 0), 0);
      if (myLevel > maxOther) return { ...state, winner: playerId, phase: 'GAME_OVER' };
    }
    return state;
  }

  const vp = calcVP(state, playerId);
  if (vp < victoryTarget(state)) return state;

  return { ...state, winner: playerId, phase: 'GAME_OVER' };
}
