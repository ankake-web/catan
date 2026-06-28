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

/**
 * 指定タイル群のうち霧のものを公開する。陸が出たら active プレイヤーへ資源1枚をバンクから付与。
 * 公開が無ければ state をそのまま返す（参照不変・no-op）。
 */
export function revealFogAround(
  state: GameState, tileIds: readonly TileId[], activePlayerId: PlayerId,
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
    // 陸（海以外）なら資源1枚を即獲得（バンク在庫の範囲内）。砂漠/金/海は付与なし。
    const res = TILE_RESOURCE_MAP[fog.type];
    if (res && hand && bank[res] > 0) {
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
