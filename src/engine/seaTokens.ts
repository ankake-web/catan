// ============================================================
// src/engine/seaTokens.ts — 航海者 S5「忘れられた部族」の海辺トークン
// ============================================================
//
// 海の辺に事前配置された VP/開発カード/港 のトークンを、船で到達（建設 or 移動）すると獲得する。
//   vp     → +1勝利点（state.tokenVp に記録・公開VP）
//   dev    → 開発カードを1枚引く（今ターン購入扱い。VPカードなら即加点扱い）
//   harbor → 自分の沿岸の建物の頂点に汎用港(3:1)を設置。置けなければ保留(heldHarbors)し次の沿岸開拓地で設置
//
// 注意: 純粋関数（DOM非依存）。edgeTokens の無い盤では常に no-op。

import type { GameState, PlayerId, EdgeId, VertexId, Harbor, DevCard } from '../types';

/** 頂点が海に面するか（沿岸＝港を置ける）。 */
function isCoastalVertex(state: GameState, vid: VertexId): boolean {
  const v = state.vertices[vid];
  if (!v) return false;
  return v.adjacentTileIds.some(t => state.tiles[t]?.type === 'sea');
}

/** 隣接頂点に既存の港があるか（公式: 港同士は1辺以上空ける）。 */
function adjacentToHarbor(state: GameState, vid: VertexId): boolean {
  const v = state.vertices[vid];
  if (!v) return false;
  return v.adjacentVertexIds.some(av => state.vertices[av]?.harborType != null);
}

/**
 * 港トークンを、指定プレイヤーの「沿岸にあり港未設置の建物頂点」へ1つ設置する。
 * 置けたら新 state を、置けなければ null を返す（呼び出し側で保留にする）。
 */
function placeHarborForPlayer(state: GameState, playerId: PlayerId): GameState | null {
  const cand = Object.keys(state.vertices)
    .filter(vid => {
      const v = state.vertices[vid]!;
      return v.building?.playerId === playerId && v.harborType == null
        && isCoastalVertex(state, vid) && !adjacentToHarbor(state, vid); // 港同士は1辺以上空ける
    })
    .sort();
  const vid = cand[0];
  if (!vid) return null;
  const harbor: Harbor = { id: `harbor_token_${vid}`, type: 'generic', vertexIds: [vid, vid] };
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, harborType: 'generic' } },
    harbors: [...state.harbors, harbor],
  };
}

/** 保留中の港トークンがあり、今置いた頂点が沿岸かつ港未設置なら1つ設置して保留数を減らす。 */
export function placeHeldHarborAt(state: GameState, playerId: PlayerId, vid: VertexId): GameState {
  const held = (state.heldHarbors ?? {})[playerId] ?? 0;
  if (held <= 0) return state;
  const v = state.vertices[vid];
  if (!v || v.harborType != null || !isCoastalVertex(state, vid) || adjacentToHarbor(state, vid)) return state;
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...v, harborType: 'generic' } },
    harbors: [...state.harbors, { id: `harbor_token_${vid}`, type: 'generic', vertexIds: [vid, vid] }],
    heldHarbors: { ...(state.heldHarbors ?? {}), [playerId]: held - 1 },
  };
}

/** 開発カードを1枚引く（今ターン購入扱い）。山札が空なら no-op。 */
function drawDevCard(state: GameState, playerId: PlayerId): GameState {
  if (state.devDeck.length === 0) return state;
  const [drawn, ...remaining] = state.devDeck;
  const card: DevCard = { ...drawn!, purchasedOnTurn: state.globalTurnNumber };
  const player = state.players[playerId]!;
  return {
    ...state,
    devDeck: remaining,
    players: { ...state.players, [playerId]: { ...player, devCards: [...player.devCards, card] } },
  };
}

/**
 * 指定の辺に海辺トークンがあれば、active プレイヤーが獲得する（種別に応じて効果適用）。
 * トークンが無ければ state をそのまま返す（no-op）。
 */
export function collectEdgeToken(state: GameState, edgeId: EdgeId, playerId: PlayerId): GameState {
  const kind = state.edgeTokens?.[edgeId];
  if (!kind) return state;

  // トークンを盤から除去。
  const edgeTokens = { ...state.edgeTokens };
  delete edgeTokens[edgeId];
  let next: GameState = { ...state, edgeTokens };

  if (kind === 'vp') {
    next = { ...next, tokenVp: { ...(next.tokenVp ?? {}), [playerId]: ((next.tokenVp ?? {})[playerId] ?? 0) + 1 } };
  } else if (kind === 'dev') {
    next = drawDevCard(next, playerId);
  } else if (kind === 'treasure') {
    // 宝島の財宝: 公式は「資源・街道/船を作る能力・発展カード」のいずれか。
    // ここでは決定論（edgeId 由来）で「発展カード1枚」か「資源2枚」を付与（簡略）。
    const hash = [...edgeId].reduce((a, c) => a + c.charCodeAt(0), 0);
    if (hash % 3 === 0 && next.devDeck.length > 0) {
      next = drawDevCard(next, playerId);
    } else {
      const RES = ['wood', 'brick', 'wool', 'grain', 'ore'] as const;
      const a = RES[hash % 5]!, b = RES[(hash + 2) % 5]!;
      const player = next.players[playerId]!;
      const hand = { ...player.hand };
      const bank = { ...next.bank };
      // 財宝の資源はバンクから供給する（在庫がある分だけ）。バンク非減算だと総在庫が膨張する。
      for (const r of [a, b]) {
        if (bank[r] > 0) { hand[r] += 1; bank[r] -= 1; }
      }
      next = {
        ...next,
        bank,
        players: { ...next.players, [playerId]: { ...player, hand } },
      };
    }
  } else { // harbor
    const placed = placeHarborForPlayer(next, playerId);
    next = placed ?? { ...next, heldHarbors: { ...(next.heldHarbors ?? {}), [playerId]: ((next.heldHarbors ?? {})[playerId] ?? 0) + 1 } };
  }
  return next;
}
