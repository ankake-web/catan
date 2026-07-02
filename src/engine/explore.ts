// ============================================================
// src/engine/explore.ts — 航海者 S3「霧の島」の探索公開
// ============================================================
//
// 霧(fog)ヘックスは type='sea' として扱われ（ship配置・産出・島判定で海）、本来の地形は
// tile.fog に隠されている。船/道/開拓地を隣接マスへ置くと公開され、本来の type/number が確定する。
// 公開された地形が陸（海以外）なら、探索したプレイヤーが「その地形の資源1枚」を即獲得する
// （仕様メモ §シナリオ3 / 公式準拠リビルド計画 S3）。
//
// 注意: 純粋関数（DOM非依存）。盤に霧ヘックスが無い基本/他シナリオでは常に no-op。

import type { GameState, PlayerId, TileId } from '../types';
import { TILE_RESOURCE_MAP } from '../constants';

// タイルの軸座標の隣接オフセット（盤の NW_NB と同一）。
const TILE_NB: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const isRed = (n: number | null | undefined): boolean => n === 6 || n === 8;

// 陸タイル（海/砂漠以外＝産出地形）を辺隣接で連結成分に分け、最大成分（本島）のタイルIDを返す。
// 同サイズの最大成分が複数ある場合は「最小タイルIDが小さい成分」を選ぶ（タイル順序に依存しない
// 決定論的タイブレーク。無いと本島の選択が tiles の列挙順で変わる潜在バグになる）。
export function mainIslandTileIds(state: GameState): Set<TileId> {
  const land = Object.values(state.tiles).filter(t => t.type !== 'sea');
  const set = new Set(land.map(t => t.id));
  const keyOf = (q: number, r: number) => `${q},${r}`;
  const byKey = new Map<string, TileId>();
  for (const t of land) byKey.set(keyOf(t.coord.q, t.coord.r), t.id);
  const minId = (ids: TileId[]): TileId => ids.reduce((m, id) => (id < m ? id : m));
  const seen = new Set<TileId>();
  let best: TileId[] = [];
  for (const t of land) {
    if (seen.has(t.id)) continue;
    const stack = [t.id]; seen.add(t.id); const comp: TileId[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      const c = state.tiles[cur]!.coord;
      for (const [dq, dr] of TILE_NB) {
        const nid = byKey.get(keyOf(c.q + dq, c.r + dr));
        if (nid && set.has(nid) && !seen.has(nid)) { seen.add(nid); stack.push(nid); }
      }
    }
    if (comp.length > best.length
      || (comp.length === best.length && best.length > 0 && minId(comp) < minId(best))) {
      best = comp;
    }
  }
  return new Set(best);
}

/**
 * 指定タイル群のうち霧のものを公開する。陸が出たら active プレイヤーへ資源1枚をバンクから付与。
 * 公開が無ければ state をそのまま返す（参照不変・no-op）。
 *
 * grantReward=false のときは霧を晴らすだけで資源報酬を与えない。SETUP 用: 無償の初期道/開拓地で
 * 資源を只取りさせない（財宝ガードと同じ方針）＋最後の初期開拓地で「公開報酬＋setup 産出」を同一
 * タイルから二重取得するのを防ぐ（BUILD_SETTLEMENT では reveal→setupGainFor の順に走るため）。
 */
export function revealFogAround(
  state: GameState, tileIds: readonly TileId[], activePlayerId: PlayerId,
  grantReward = true,
): GameState {
  let changed = false;
  let tiles = state.tiles;
  let bank = state.bank;
  let hand = state.players[activePlayerId]?.hand;

  for (const tid of tileIds) {
    const tile = tiles[tid];
    if (!tile?.fog) continue;
    if (!changed) { tiles = { ...state.tiles }; changed = true; }
    const { fog, ...rest } = tile;
    tiles[tid] = { ...rest, type: fog.type, number: fog.number };
    // 陸（海以外）なら資源1枚を即獲得（バンク在庫の範囲内）。砂漠/金/海は付与なし。SETUP は報酬なし。
    const res = TILE_RESOURCE_MAP[fog.type];
    if (grantReward && res && hand && bank[res] > 0) {
      bank = { ...bank, [res]: bank[res] - 1 };
      hand = { ...hand, [res]: hand[res] + 1 };
    }
  }

  if (!changed) return state;
  let next: GameState = { ...state, tiles, bank };
  if (hand && hand !== state.players[activePlayerId]?.hand) {
    next = {
      ...next,
      players: { ...next.players, [activePlayerId]: { ...next.players[activePlayerId]!, hand } },
    };
  }
  return next;
}

/** 盤に霧ヘックスが1つでもあるか（探索シナリオ判定・呼び出し側の早期 return 用）。 */
export function hasFog(state: GameState): boolean {
  return Object.values(state.tiles).some(t => t.fog != null);
}

// この小島タイルの同島（陸）隣接に赤数字(6/8)が既にあるか（条件1: 6/8は小島で隣接させない）。
function hasAdjacentRed(tiles: GameState['tiles'], tileId: TileId): boolean {
  const t = tiles[tileId]; if (!t) return false;
  const byKey = new Map<string, GameState['tiles'][string]>();
  for (const x of Object.values(tiles)) if (x.type !== 'sea') byKey.set(`${x.coord.q},${x.coord.r}`, x);
  for (const [dq, dr] of TILE_NB) {
    const n = byKey.get(`${t.coord.q + dq},${t.coord.r + dr}`);
    if (n && isRed(n.number)) return true;
  }
  return false;
}

// 供給枯渇時に本島から抜く数字タイルを1つ選ぶ。条件（公式）を順守:
//   1) 6/8は小島で隣接させない（その小島に赤隣接があるなら赤は避ける）
//   3) 本島の建物の産出を奪わない（建物に隣接するタイルは避ける）
// すべて満たせない場合は順に破る（=スコアの低い順で最善を選ぶ）。
function pickMainNumberToPull(
  state: GameState, tiles: GameState['tiles'], mainIds: Set<TileId>, islandTileId: TileId,
): { id: TileId; number: number } | null {
  const cands = [...mainIds]
    .map(id => tiles[id]!)
    .filter(t => t.number != null && t.type !== 'desert');
  if (!cands.length) return null;
  const islandHasRed = hasAdjacentRed(tiles, islandTileId);
  const hasBuilding = (id: TileId) => (state.tileToVertices[id] ?? []).some(v => state.vertices[v]?.building != null);
  const score = (t: typeof cands[number]) =>
    (isRed(t.number) && islandHasRed ? 100 : 0) + (hasBuilding(t.id) ? 10 : 0);
  cands.sort((a, b) => score(a) - score(b) || (a.id < b.id ? -1 : 1));
  const chosen = cands[0]!;
  return { id: chosen.id, number: chosen.number! };
}

/**
 * 航海者「大カタン」: 抜けている数値トークンの出現。指定タイル群のうち pendingNumber を持つ
 * （まだ数字が出ていない小島の）タイルを公開し、number を確定させる。道/船/開拓地でタイルの端へ
 * 到達したときに呼ぶ。該当が無ければ state をそのまま返す（参照不変・no-op）。
 *
 * 供給(numberTokenSupply)がある盤（大カタン）では公式どおり:
 *   - 供給が残っていれば供給から1枚（=仕込んだ pendingNumber）を配り、供給を1減らす。
 *   - 供給が尽きたら、本島の数字タイルから1枚「抜いて」その小島へ移す（本島タイルは産出停止）。
 */
export function revealPendingNumbers(state: GameState, tileIds: readonly TileId[]): GameState {
  const targets = tileIds.filter(tid => state.tiles[tid]?.pendingNumber != null);
  if (targets.length === 0) return state;

  const tiles = { ...state.tiles };
  let supply = state.numberTokenSupply; // undefined=供給機構なし
  let mainIds: Set<TileId> | null = null;

  for (const tid of targets) {
    const tile = tiles[tid]!;
    const { pendingNumber, ...rest } = tile;
    if (supply == null || supply > 0) {
      // 供給から（または通常）pendingNumber をそのまま出す。
      tiles[tid] = { ...rest, number: pendingNumber! };
      if (supply != null) supply -= 1;
    } else {
      // 供給枯渇: 本島から数字を抜いてこの小島へ移す。
      if (!mainIds) mainIds = mainIslandTileIds(state);
      const pulled = pickMainNumberToPull(state, tiles, mainIds, tid);
      if (pulled) {
        tiles[tid] = { ...rest, number: pulled.number };
        tiles[pulled.id] = { ...tiles[pulled.id]!, number: null, numberRemoved: true };
      } else {
        tiles[tid] = { ...rest, number: pendingNumber! }; // 抜ける本島タイルが無い場合の保険
      }
    }
  }
  return { ...state, tiles, ...(supply != null ? { numberTokenSupply: supply } : {}) };
}

/** 盤に「抜けている数値トークン（未出現の小島）」が1つでもあるか。 */
export function hasPendingNumbers(state: GameState): boolean {
  return Object.values(state.tiles).some(t => t.pendingNumber != null);
}
