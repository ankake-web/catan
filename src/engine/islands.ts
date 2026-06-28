// ============================================================
// src/engine/islands.ts — 島（陸の連結成分）判定（航海者拡張）
// ============================================================
//
// 海タイルで分断された盤（航海者）で「島」を求める純粋関数群。
// 島 = 海(sea)以外のタイルの連結成分（axial 6方向の隣接で連結）。
// 用途: シナリオ「新たな海岸を求めて」の“新しい島への最初の入植 +2VP”判定。
//
// 基本ゲーム（海タイル無し）は全タイルが 1 つの島になるため、これらの関数は
// 「新島ボーナス」を一切発生させない（呼び出し側で海タイルの有無を gate）。

import type { GameState, Tile, TileId, Vertex, VertexId } from '../types';
import { HEX_DIRECTIONS } from '../constants';
import { tileId } from './board';

/**
 * 各陸タイルを所属する島の「代表ID」（連結成分内で最小の TileId・文字列順）へ写す表を返す。
 * 海タイルは含まれない。連結は axial 6方向の隣接で判定する。
 */
export function computeIslandReps(tiles: Record<TileId, Tile>): Record<TileId, string> {
  const landIds = Object.keys(tiles).filter(id => tiles[id]!.type !== 'sea');
  const landSet = new Set(landIds);
  const visited = new Set<string>();
  const repOf: Record<TileId, string> = {};

  for (const start of landIds) {
    if (visited.has(start)) continue;
    // BFS/DFS で連結成分を収集
    const comp: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      const c = tiles[cur]!.coord;
      for (const d of HEX_DIRECTIONS) {
        const nid = tileId({ q: c.q + d.q, r: c.r + d.r });
        if (landSet.has(nid) && !visited.has(nid)) {
          visited.add(nid);
          stack.push(nid);
        }
      }
    }
    // 代表 = 成分内で文字列順最小の TileId（決定的・安定）
    const rep = comp.reduce((m, x) => (x < m ? x : m), comp[0]!);
    for (const t of comp) repOf[t] = rep;
  }
  return repOf;
}

/** 頂点が属する島の代表ID（隣接する最初の陸タイルの島）。陸に面さない頂点は null。 */
function vertexRep(v: Vertex, repOf: Record<TileId, string>): string | null {
  for (const tid of v.adjacentTileIds) {
    const r = repOf[tid];
    if (r) return r;
  }
  return null;
}

/** 「本島」= 最大の陸の連結成分の代表ID（同数なら文字列順で安定タイブレーク）。陸が無ければ null。 */
function homeIslandRep(repOf: Record<TileId, string>): string | null {
  const counts: Record<string, number> = {};
  for (const rep of Object.values(repOf)) counts[rep] = (counts[rep] ?? 0) + 1;
  let best: string | null = null;
  let bestN = -1;
  for (const [rep, n] of Object.entries(counts)) {
    if (n > bestN || (n === bestN && (best === null || rep < best))) { bestN = n; best = rep; }
  }
  return best;
}

/**
 * 航海者: 初期配置で開拓地を置ける「本島」上の頂点か。
 * 新しい島へは航海（船）でのみ渡れる（New Shores ルール）。本島=最大の陸の島。
 * 基本ゲーム（海タイル無し）は制限しない（常に true）。
 */
export function isHomeIslandVertex(state: GameState, vertexId: VertexId): boolean {
  if (!Object.values(state.tiles).some(t => t.type === 'sea')) return true; // 基本ゲームは無制限
  const v = state.vertices[vertexId];
  if (!v) return false;
  // S2「4つの島」/ New World: 初期配置はどの陸島にも置ける（陸かどうかは canBuildSettlement が別途判定）。
  if (state.setupAnywhere) return true;
  const repOf = computeIslandReps(state.tiles);
  const home = homeIslandRep(repOf);
  if (home == null) return true; // 陸が無い異常時は制限しない
  const rep = vertexRep(v, repOf);
  return rep === home; // 純海上頂点(null)は本島外
}

/** 頂点が属する島の代表ID（純海上頂点は null）。シナリオのホーム島記録に使う。 */
export function islandRepOf(state: GameState, vertexId: VertexId): string | null {
  const v = state.vertices[vertexId];
  if (!v) return null;
  return vertexRep(v, computeIslandReps(state.tiles));
}

/**
 * 航海者: その空き頂点に開拓地を建てると「新島への最初の入植」=+2VP の対象になるか。
 * = 海タイルのある盤で、本島でない島に属し、その島にまだ建物が無い頂点。
 * AI が新島開拓（島ボーナス・金タイル）へ向かう動機づけに使う（基本ゲームでは常に false）。
 */
export function isUnclaimedNewIslandVertex(state: GameState, vertexId: VertexId): boolean {
  if (!Object.values(state.tiles).some(t => t.type === 'sea')) return false;
  const v = state.vertices[vertexId];
  if (!v) return false;
  const repOf = computeIslandReps(state.tiles);
  const home = homeIslandRep(repOf);
  const rep = vertexRep(v, repOf);
  if (rep == null || rep === home) return false; // 純海上 or 本島は対象外
  // その島に既に建物があれば「最初」ではない。
  for (const other of Object.values(state.vertices)) {
    if (other.building && vertexRep(other, repOf) === rep) return false;
  }
  return true;
}

/**
 * MAIN フェーズで開拓地を建てた頂点が「本島でない島」に属するなら、その島の代表IDを返す。
 * 対象外（海タイルの無い基本ゲーム / 本島 / 陸に面さない頂点）の場合は null。
 *
 * 公式ルール（仕様メモ §2 シナリオ1）: 各プレイヤーが自分の初入植ごとに +VP を得る
 * （他人が先に建てていても獲得可）。よって「島で最初の1人だけ」ではなく、
 * 「自分がその島へ初めて建てたか」は呼び出し側が islandBonus[rep] で重複排除する。
 *
 * ホーム島の判定:
 *  - playerId が渡され state.playerHomeIslands[playerId] があれば、その島群（=自分の初期配置島）以外を対象とする
 *    （S2「4つの島」/ New World のプレイヤー別未探検）。
 *  - 無ければ盤面共有の本島（=最大陸塊）以外を対象とする（S1系のフォールバック）。
 */
export function newIslandBonusRep(state: GameState, builtVertexId: VertexId, playerId?: string): string | null {
  // 基本ゲーム（海タイル無し）は新島ボーナス対象外。
  if (!Object.values(state.tiles).some(t => t.type === 'sea')) return null;

  const builtV = state.vertices[builtVertexId];
  if (!builtV) return null;

  const repOf = computeIslandReps(state.tiles);
  const rep = vertexRep(builtV, repOf);
  if (!rep) return null; // 純海上は対象外

  const homeSet = playerId != null ? state.playerHomeIslands?.[playerId] : undefined;
  if (homeSet) return homeSet.includes(rep) ? null : rep; // プレイヤー別ホーム
  return rep === homeIslandRep(repOf) ? null : rep;        // 盤面共有の本島
}
