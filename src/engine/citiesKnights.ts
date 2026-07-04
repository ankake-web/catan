// ============================================================
// src/engine/citiesKnights.ts — 騎士と商人(Cities & Knights)拡張のルール（純関数）
// ============================================================
//
// フェーズ1: 都市の産出を拡張する。
//   - 開拓地: 隣接地形の資源を1個（基本どおり）。
//   - 都市（森/牧草/山）: 資源1個 ＋ 対応する商品(紙/布/金貨)1個。
//   - 都市（丘/畑）: 資源2個（商品なし）。
//   - 砂漠/海/金タイルは産出なし。盗賊のいるタイルは産出しない。7は対象外。
//
// 資源はバンク枯渇ルールを基本ゲームと同様に適用する。商品は当面ふんだんにあるものとして
// 枯渇を扱わない（公式でも商品が尽きることは稀）。基本/航海者には一切影響しない純粋関数。

import type {
  GameState, ResourceType, CommodityType, CommodityHand, ResourceHand, PlayerId, VertexId, TileId, CkTrack, Player,
  ProgressCard, ProgressCardType, TileType, Knight, TradeKind, ProgressChoice,
} from '../types';

/** 勝利点の進歩カード（憲法/印刷機）。手札上限の対象外で、即時+1VP。 */
export function isVpProgress(t: ProgressCardType): boolean {
  return t === 'constitution' || t === 'printer';
}
import {
  RESOURCE_TYPES, TILE_RESOURCE_MAP, TILE_COMMODITY_MAP, COMMODITY_TYPES,
  makeCommodities, COMMODITY_BANK_INITIAL, CK_COSTS, CK_TRACK_COMMODITY, CK_MAX_IMPROVEMENT, CK_METROPOLIS_LEVEL,
  CK_BARBARIAN_MAX, CK_MAX_WALLS, PIECE_LIMITS, improvementCost,
  PROGRESS_DECK_CARDS, PROGRESS_DECK_COUNTS, PROGRESS_HAND_LIMIT,
} from '../constants';
import { calcVP, updateLongestRoad } from './scoring';
import { canBuildRoad } from './actions';
import { computeGoldPicks } from './dice';
import { moveRobber, stealResource, robbableCardCount } from './robber';

// ============================================================
// 小ヘルパ（資源・商品の支払い）
// ============================================================

export function isCk(state: GameState): boolean {
  return state.expansion === 'cities_knights';
}
function canPayRes(hand: ResourceHand, cost: ResourceHand): boolean {
  return RESOURCE_TYPES.every(r => hand[r] >= cost[r]);
}
function payRes(hand: ResourceHand, cost: ResourceHand): ResourceHand {
  const h = { ...hand };
  for (const r of RESOURCE_TYPES) h[r] -= cost[r];
  return h;
}
function commodities(p: Player): CommodityHand {
  return p.commodities ?? makeCommodities();
}
function improvements(p: Player): Record<CkTrack, number> {
  return p.improvements ?? { trade: 0, politics: 0, science: 0 };
}

// ============================================================
// 騎士の接続判定・建設
// ============================================================

/** 騎士を置ける頂点か: 空き(建物/騎士なし)で、自分の道/船が接している。 */
export function canPlaceKnightVertex(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  const v = state.vertices[vid];
  if (!v) return false;
  if (v.building || v.knight) return false;
  return v.adjacentEdgeIds.some(eid => {
    const e = state.edges[eid];
    return e?.road?.playerId === pid || e?.ship?.playerId === pid;
  });
}

function knightCount(state: GameState, pid: PlayerId): number {
  return Object.values(state.vertices).filter(v => v.knight?.playerId === pid).length;
}

export function canBuildKnight(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; if (!p) return false;
  if (knightCount(state, pid) >= PIECE_LIMITS.knights) return false;
  if (!canPayRes(p.hand, CK_COSTS.knightBuild)) return false;
  return canPlaceKnightVertex(state, pid, vid);
}
export function buildKnight(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const p = state.players[pid]!;
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, knight: { playerId: pid, strength: 1, active: false } } },
    players: { ...state.players, [pid]: { ...p, hand: payRes(p.hand, CK_COSTS.knightBuild) } },
    bank: addRes(state.bank, CK_COSTS.knightBuild),
  };
}

export function canActivateKnight(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; const k = state.vertices[vid]?.knight;
  if (!p || !k || k.playerId !== pid || k.active) return false;
  return canPayRes(p.hand, CK_COSTS.knightActivate);
}
export function activateKnight(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const p = state.players[pid]!; const k = state.vertices[vid]!.knight!;
  return {
    ...state,
    // 起動したターンは行動不可（activatedThisTurn）。END_TURN でクリア。
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, knight: { ...k, active: true, activatedThisTurn: true } } },
    players: { ...state.players, [pid]: { ...p, hand: payRes(p.hand, CK_COSTS.knightActivate) } },
    bank: addRes(state.bank, CK_COSTS.knightActivate),
  };
}

export function canUpgradeKnight(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; const k = state.vertices[vid]?.knight;
  if (!p || !k || k.playerId !== pid || k.strength >= 3) return false;
  // 最強(3)への昇格は政治Lv3(城塞)が必要。
  if (k.strength === 2 && improvements(p).politics < 3) return false;
  return canPayRes(p.hand, CK_COSTS.knightUpgrade);
}
export function upgradeKnight(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const p = state.players[pid]!; const k = state.vertices[vid]!.knight!;
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, knight: { ...k, strength: (k.strength + 1) as 1 | 2 | 3 } } },
    players: { ...state.players, [pid]: { ...p, hand: payRes(p.hand, CK_COSTS.knightUpgrade) } },
    bank: addRes(state.bank, CK_COSTS.knightUpgrade),
  };
}

// from と to を結ぶ辺ID（隣接時のみ）。
function edgeBetween(state: GameState, fromVid: VertexId, toVid: VertexId): string | null {
  const from = state.vertices[fromVid];
  if (!from) return null;
  for (const eid of from.adjacentEdgeIds) {
    const e = state.edges[eid];
    if (e && (e.vertexIds[0] === toVid || e.vertexIds[1] === toVid)) return eid;
  }
  return null;
}

/**
 * 騎士を fromVid→toVid へ移動できるか。隣接1歩・自分の道沿い・空き or 厳密に弱い敵騎士(押し出し)。
 * 各騎士は1ターン1アクション（行動後は非起動に戻る＝再行動不可）。起動したターンは行動不可。
 */
export function canMoveKnight(state: GameState, pid: PlayerId, fromVid: VertexId, toVid: VertexId): boolean {
  if (!isCk(state)) return false;
  const from = state.vertices[fromVid]; const to = state.vertices[toVid];
  if (!from?.knight || from.knight.playerId !== pid || !from.knight.active) return false;
  if (from.knight.activatedThisTurn) return false;               // 起動したターンは行動不可
  if (!to || fromVid === toVid) return false;
  if (!from.adjacentVertexIds.includes(toVid)) return false;     // 隣接1歩
  const eid = edgeBetween(state, fromVid, toVid);                 // 自分の道/船沿いに進む
  const e = eid ? state.edges[eid] : null;
  if (!(e?.road?.playerId === pid || e?.ship?.playerId === pid)) return false;
  if (to.building) return false;                                 // 建物の上には行けない
  if (to.knight) {
    if (to.knight.playerId === pid) return false;                // 自分の騎士の上は不可
    if (to.knight.strength >= from.knight.strength) return false;// 厳密に弱い敵騎士のみ押し出せる
  }
  return true;
}
export function isKnightMovable(state: GameState, pid: PlayerId, fromVid: VertexId): boolean {
  const from = state.vertices[fromVid];
  if (!from?.knight || from.knight.playerId !== pid || !from.knight.active || from.knight.activatedThisTurn) return false;
  return from.adjacentVertexIds.some(to => canMoveKnight(state, pid, fromVid, to));
}
export function playerHasMovableKnight(state: GameState, pid: PlayerId): boolean {
  if (!isCk(state)) return false;
  return Object.keys(state.vertices).some(v => isKnightMovable(state, pid, v));
}
/**
 * 押し出された騎士 displaced の再配置先頂点を返す（無ければ null=供給へ戻す）。
 * 候補 = occupiedVid(=強い騎士が入った頂点)に隣接し、canPlaceKnightVertex(被押出側,cand) を満たす空き頂点。
 * 決定論のため頂点ID昇順で先頭を選ぶ（rng不使用＝リプレイ安定）。
 */
export function findDisplacementTarget(state: GameState, displaced: Knight, occupiedVid: VertexId): VertexId | null {
  const v = state.vertices[occupiedVid];
  if (!v) return null;
  const cands = v.adjacentVertexIds.filter(cv => canPlaceKnightVertex(state, displaced.playerId, cv));
  cands.sort();
  return cands[0] ?? null;
}

/**
 * 騎士を移動（バリデーション済み前提）。各騎士は1ターン1アクションで、行動後は非起動に戻る。
 * 弱い敵騎士を押し出した場合、公式どおりその騎士を所有者の隣接空き頂点（自網接続）へ再配置する。
 * 合法な再配置先が無いときのみ供給へ戻す（盤から除去）。
 */
export function moveKnight(state: GameState, pid: PlayerId, fromVid: VertexId, toVid: VertexId): GameState {
  const k = state.vertices[fromVid]!.knight!;
  const displaced = state.vertices[toVid]?.knight ?? null;
  let vertices = {
    ...state.vertices,
    [fromVid]: { ...state.vertices[fromVid]!, knight: null },
    // 行動後は非起動に戻る（再行動不可。再び動かすには麦で起動が必要）。
    [toVid]: { ...state.vertices[toVid]!, knight: { playerId: pid, strength: k.strength, active: false } },
  };
  if (displaced && displaced.playerId !== pid) {
    // 強い騎士を据えた後の盤を基準に再配置先を探す（occupiedVid自身は埋まっており候補から外れる）。
    const dest = findDisplacementTarget({ ...state, vertices }, displaced, toVid);
    if (dest) {
      vertices = { ...vertices, [dest]: { ...vertices[dest]!, knight: { playerId: displaced.playerId, strength: displaced.strength, active: displaced.active } } };
    }
    // dest が null → 再配置先なし＝供給へ戻る（knightCount は頂点走査で動的算出のため別途減算不要）。
  }
  return { ...state, vertices };
}

// ============================================================
// 騎士で強盗を追い払う（chase away the robber）
// ============================================================

/**
 * 強盗の現在ヘクスに隣接する、自分のアクティブ騎士がいる頂点の一覧（UI/AI用）。
 * 1ターン1回（knightChasedThisTurn）。本実装は陸の強盗のみ対象（海賊は対象外）。
 */
export function robberAdjacentChasableVertexIds(state: GameState, pid: PlayerId): VertexId[] {
  // 初回の蛮族襲来までは盗賊が凍結＝追い払いも不可。1ターン1回。
  if (!isCk(state) || state.knightChasedThisTurn || state.turnPhase !== 'TRADE_BUILD' || (state.barbarianAttacks ?? 0) < 1) return [];
  const robberTid = Object.keys(state.tiles).find(t => state.tiles[t]!.hasRobber);
  if (!robberTid) return [];
  const out: VertexId[] = [];
  for (const vid of state.tileToVertices[robberTid] ?? []) {
    const k = state.vertices[vid]?.knight;
    if (k && k.playerId === pid && k.active && !k.activatedThisTurn) out.push(vid);
  }
  return out;
}

/** 指定頂点のアクティブ騎士で強盗を追い払えるか（強盗ヘクスに隣接・1ターン1回・初回襲来後）。 */
export function canChaseRobber(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  if (!isCk(state) || state.knightChasedThisTurn || state.turnPhase !== 'TRADE_BUILD' || (state.barbarianAttacks ?? 0) < 1) return false;
  const k = state.vertices[vid]?.knight;
  if (!k || k.playerId !== pid || !k.active || k.activatedThisTurn) return false; // 起動したターンは行動不可
  const adjTiles = state.vertices[vid]?.adjacentTileIds ?? [];
  return adjTiles.some(t => state.tiles[t]?.hasRobber);
}

export function playerHasChasableKnight(state: GameState, pid: PlayerId): boolean {
  return robberAdjacentChasableVertexIds(state, pid).length > 0;
}

/** 騎士で強盗を追い払う（バリデーション済み前提）。当該騎士を非アクティブ化し ROBBER フェーズへ。 */
export function chaseRobber(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const v = state.vertices[vid]!; const k = v.knight!;
  return {
    ...state,
    turnPhase: 'ROBBER',
    knightChasedThisTurn: true,
    vertices: { ...state.vertices, [vid]: { ...v, knight: { ...k, active: false } } }, // 非アクティブ化（再起動は麦1）
  };
}

function addRes(bank: ResourceHand, cost: ResourceHand): ResourceHand {
  const b = { ...bank };
  for (const r of RESOURCE_TYPES) b[r] += cost[r];
  return b;
}

// ============================================================
// 都市改善（3ツリー）＋メトロポリス
// ============================================================

function playerHasPlainCity(state: GameState, pid: PlayerId): boolean {
  return Object.values(state.vertices).some(v => v.building?.playerId === pid && v.building.type === 'city' && !v.building.metropolis);
}

// メトロポリス化できる自分の都市（まだメトロポリスでない平の都市）の頂点ID一覧。
// 手動選択（候補2つ以上で盤面タップ）と自動配置の両方で使う。
export function metropolisCityChoices(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(id =>
    state.vertices[id]!.building?.playerId === pid
    && state.vertices[id]!.building?.type === 'city'
    && !state.vertices[id]!.building?.metropolis);
}

// このツリーを今+1すると「新たにメトロポリスを獲得（先着 or 奪取）」するかを判定する。
// 既にこのツリーのメトロポリスを保持している（=都市選択不要）場合は false。
export function improvementTakesMetropolis(state: GameState, pid: PlayerId, track: CkTrack): boolean {
  const p = state.players[pid]; if (!p) return false;
  const newLvl = improvements(p)[track] + 1;
  const holder = state.metropolis?.[track];
  const holderLvl = holder ? improvements(state.players[holder.playerId]!)[track] : 0;
  return newLvl >= CK_METROPOLIS_LEVEL && (!holder || (holder.playerId !== pid && newLvl > holderLvl));
}

export function canBuildImprovement(state: GameState, pid: PlayerId, track: CkTrack): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; if (!p) return false;
  const lvl = improvements(p)[track];
  if (lvl >= CK_MAX_IMPROVEMENT) return false;
  // 都市改善は都市が1つ以上必要。
  if (!Object.values(state.vertices).some(v => v.building?.playerId === pid && v.building.type === 'city')) return false;
  // Lv4以上(メトロポリス)の購入には、メトロポリス化できる都市が要る（既にこのツリーを保持中なら可）。
  if (lvl + 1 >= CK_METROPOLIS_LEVEL) {
    const holdsThis = state.metropolis?.[track]?.playerId === pid;
    if (!holdsThis && !playerHasPlainCity(state, pid)) return false;
  }
  const c = CK_TRACK_COMMODITY[track];
  return commodities(p)[c] >= improvementCost(lvl);
}
export function buildImprovement(state: GameState, pid: PlayerId, track: CkTrack, discount = 0, metropolisVertexId?: string): GameState {
  const p = state.players[pid]!;
  const lvl = improvements(p)[track];
  const c = CK_TRACK_COMMODITY[track];
  const cost = Math.max(0, improvementCost(lvl) - discount); // crane は商品1個割引
  const newComm = { ...commodities(p), [c]: commodities(p)[c] - cost };
  // 支払った商品は供給(commodityBank)へ戻る（公式どおり。これが無いと供給が単調減少して枯渇する）。
  const commodityBank = { ...(state.commodityBank ?? COMMODITY_BANK_INITIAL), [c]: (state.commodityBank ?? COMMODITY_BANK_INITIAL)[c] + cost };
  const newLvl = lvl + 1;
  let players = { ...state.players, [pid]: { ...p, commodities: newComm, improvements: { ...improvements(p), [track]: newLvl } } };
  let vertices = state.vertices;
  let metropolis = state.metropolis ?? {};

  // メトロポリス: そのツリーで Lv4以上かつ「現保持者より高いレベル」になった者が保持する。
  //   - 未保持 → Lv4到達で獲得（先着）。
  //   - 他者がLv4保持中に自分がLv5へ → 奪取（相手の都市は平の都市に戻る）。
  const holder = metropolis[track];
  const holderLvl = holder ? improvements(state.players[holder.playerId]!)[track] : 0;
  const shouldTake = newLvl >= CK_METROPOLIS_LEVEL
    && (!holder || (holder.playerId !== pid && newLvl > holderLvl));
  if (shouldTake) {
    // 都市が選べる時は手動指定(metropolisVertexId)を優先。未指定/不正なら先頭の都市へ自動配置。
    const candidates = metropolisCityChoices(state, pid);
    const newVid = (metropolisVertexId && candidates.includes(metropolisVertexId)) ? metropolisVertexId : candidates[0];
    if (newVid) {
      // 奪取時は旧保持者のメトロポリスを平の都市へ戻す（勝利点4→2）。
      if (holder && holder.playerId !== pid) {
        const ov = vertices[holder.vertexId];
        if (ov?.building?.metropolis) {
          // メトロポリスを失っても、元々建てていた城壁(wall)は平の都市に残す。
          const keepWall = (ov.building as { wall?: boolean }).wall ? { wall: true } : {};
          vertices = { ...vertices, [holder.vertexId]: { ...ov, building: { type: 'city', playerId: holder.playerId, ...keepWall } } };
        }
      }
      vertices = { ...vertices, [newVid]: { ...vertices[newVid]!, building: { ...vertices[newVid]!.building!, metropolis: true } } };
      metropolis = { ...metropolis, [track]: { playerId: pid, vertexId: newVid } };
    }
  }
  return { ...state, players, vertices, metropolis, commodityBank };
}

// ============================================================
// 城壁（手札上限+2、最大3）
// ============================================================

function wallCount(state: GameState, pid: PlayerId): number {
  // 公式: 城壁は最大3（メトロポリスは別物で城壁には数えない）。
  return Object.values(state.vertices).filter(v =>
    v.building?.playerId === pid && (v.building as { wall?: boolean }).wall).length;
}
export function canBuildCityWall(state: GameState, pid: PlayerId, vid: VertexId): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; const b = state.vertices[vid]?.building;
  if (!p || !b || b.playerId !== pid || b.type !== 'city') return false;
  if (b.metropolis || (b as { wall?: boolean }).wall) return false; // 既に城壁/メトロポリス
  if (wallCount(state, pid) >= CK_MAX_WALLS) return false;
  return canPayRes(p.hand, CK_COSTS.cityWall);
}
export function buildCityWall(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const p = state.players[pid]!; const b = state.vertices[vid]!.building!;
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, building: { ...b, wall: true } as typeof b } },
    players: { ...state.players, [pid]: { ...p, hand: payRes(p.hand, CK_COSTS.cityWall) } },
    bank: addRes(state.bank, CK_COSTS.cityWall),
  };
}

// 7の捨て札しきい値は robber.ts の discardThreshold が一元管理する
// （城壁/メトロポリス1つにつき+2）。ここでは重複定義しない。

// ============================================================
// イベントダイス・蛮族
// ============================================================

/** イベントダイス: 6面中3面が蛮族船、残り3面が交易/政治/科学。 */
export function rollEventDie(rng: () => number): 'ship' | CkTrack {
  const r = Math.floor(rng() * 6);
  if (r < 3) return 'ship';
  return (['trade', 'politics', 'science'] as CkTrack[])[r - 3]!;
}

/** 同点防衛者が引くデッキ（最も枚数の多いデッキ。同数は trade→politics→science の固定順）。rng不使用＝決定的。 */
function chooseBarbarianTieDeck(work: Record<CkTrack, ProgressCard[]>): CkTrack | null {
  const order: CkTrack[] = ['trade', 'politics', 'science'];
  const cand = order.filter(t => work[t].length > 0);
  if (cand.length === 0) return null;
  cand.sort((a, b) => (work[b].length - work[a].length) || (order.indexOf(a) - order.indexOf(b)));
  return cand[0]!;
}

/**
 * 蛮族襲来の判定。騎士の総力 vs 盤面の都市数。
 * 防衛成功: 単独最大貢献者に守護者VP+1。同点最大なら守護VPは無く、同点者が各自 進歩カードを1枚引く（公式）。
 * 防衛失敗: 平の都市を持つ最弱が都市1つを格下げ。終了後 全騎士を非起動・蛮族を0に。
 */
export function resolveBarbarianAttack(state: GameState): GameState {
  let cities = 0;
  const knightStr: Record<string, number> = {};
  for (const v of Object.values(state.vertices)) {
    if (v.building?.type === 'city') cities += 1; // メトロポリスも都市1としてカウント
    if (v.knight?.active) knightStr[v.knight.playerId] = (knightStr[v.knight.playerId] ?? 0) + v.knight.strength;
  }
  const total = Object.values(knightStr).reduce((s, n) => s + n, 0);

  let players = { ...state.players };
  let vertices = { ...state.vertices };
  let progressDecks = state.progressDecks;
  let pendingDowngrade: PlayerId[] = [];
  const tieOverflow: PlayerId[] = []; // 同点撃退で進歩カード5枚目を引き、捨て札選択が要るプレイヤー

  if (total >= cities) {
    // 防衛成功。
    const max = Math.max(0, ...state.playerOrder.map(p => knightStr[p] ?? 0));
    if (max > 0) {
      const winners = state.playerOrder.filter(p => (knightStr[p] ?? 0) === max);
      if (winners.length === 1) {
        // 単独最大: 守護者VP +1。
        const w = winners[0]!;
        players[w] = { ...players[w]!, defenderVP: (players[w]!.defenderVP ?? 0) + 1 };
      } else if (state.progressDecks) {
        // 同点最大: 守護VPなし。各同点者が最も枚数の多いデッキから進歩カードを1枚引く。
        // 公式: 上限(4)を超えても引いてよく、その場合は1枚を選んで捨てる（PROGRESS_DISCARD）。
        const work: Record<CkTrack, ProgressCard[]> = {
          trade: [...state.progressDecks.trade],
          politics: [...state.progressDecks.politics],
          science: [...state.progressDecks.science],
        };
        let touched = false;
        for (const w of winners) {
          const deck = chooseBarbarianTieDeck(work);
          if (!deck) continue;
          const held = players[w]!.progressCards ?? [];
          const card = work[deck].shift()!;
          const newHeld = [...held, card];
          players[w] = { ...players[w]!, progressCards: newHeld };
          touched = true;
          if (newHeld.filter(c => !isVpProgress(c.type)).length > PROGRESS_HAND_LIMIT) tieOverflow.push(w);
        }
        if (touched) progressDecks = work;
      }
    }
    // max===0（貢献0のみ）→ 報酬なし。
  } else {
    // 防衛失敗: 平の都市を持つプレイヤーのうち最弱(同点は全員)が都市1つを開拓地に格下げ。
    // どの都市を格下げするかは各自が選ぶ（CITY_DOWNGRADE フェーズ）。ここでは対象者だけ確定する。
    const owners = state.playerOrder.filter(p => playerHasPlainCity({ ...state, vertices }, p));
    if (owners.length > 0) {
      const minStr = Math.min(...owners.map(p => knightStr[p] ?? 0));
      pendingDowngrade = owners.filter(p => (knightStr[p] ?? 0) === minStr);
    }
  }

  // 全騎士を非起動に戻す（起動フラグもクリア）。
  for (const id of Object.keys(vertices)) {
    const k = vertices[id]!.knight;
    if (k?.active) vertices[id] = { ...vertices[id]!, knight: { ...k, active: false, activatedThisTurn: false } };
  }

  return {
    ...state, players, vertices, barbarianPosition: 0, barbarianAttacks: (state.barbarianAttacks ?? 0) + 1,
    ...(progressDecks !== state.progressDecks ? { progressDecks } : {}),
    ...(pendingDowngrade.length > 0 ? { pendingCityDowngrade: pendingDowngrade } : {}),
    ...(tieOverflow.length > 0 ? { pendingProgressDiscard: tieOverflow } : {}),
  };
}

/** 進歩カード上限超過時、pid が捨てる候補（非VPカード）のID一覧。VPカードは上限対象外なので捨てない。 */
export function progressDiscardCandidates(state: GameState, pid: PlayerId): string[] {
  return (state.players[pid]?.progressCards ?? []).filter(c => !isVpProgress(c.type)).map(c => c.id);
}

/** 進歩カードを1枚捨てる（DISCARD_PROGRESS）。pid本人の非VPカードのみ。違法なら state を返す（無害）。 */
export function discardProgressCard(state: GameState, pid: PlayerId, cardId: string): GameState {
  const p = state.players[pid];
  if (!p) return state;
  const card = (p.progressCards ?? []).find(c => c.id === cardId);
  if (!card || isVpProgress(card.type)) return state; // VPカードは捨てられない
  const decks = state.progressDecks;
  // 捨てたカードは同種デッキの末尾へ戻す（山札枯渇を避ける・公式の捨て札に準拠）。
  const nextDecks = decks ? { ...decks, [card.deck]: [...decks[card.deck], card] } : decks;
  return {
    ...state,
    players: { ...state.players, [pid]: { ...p, progressCards: (p.progressCards ?? []).filter(c => c.id !== cardId) } },
    ...(nextDecks ? { progressDecks: nextDecks } : {}),
  };
}

/** 指定プレイヤーの「格下げ可能な都市」（平の都市＝メトロポリスでない）頂点ID一覧。UI/AIの選択肢。 */
export function plainCityVertexIds(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(id => {
    const b = state.vertices[id]?.building;
    return b?.playerId === pid && b.type === 'city' && !b.metropolis;
  });
}

/** 蛮族敗北での都市格下げ（都市→開拓地）。pid本人の平の都市のみ。違法なら state を返す（無害）。 */
export function downgradeCity(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const v = state.vertices[vid];
  if (!v || v.building?.playerId !== pid || v.building.type !== 'city' || v.building.metropolis) return state;
  const p = state.players[pid]!;
  // 開拓地コマの在庫が無ければ、都市は「格下げ」ではなく撤去する（公式CK）。格下げにすると
  //   remainingSettlements の -1 が max(0,…) でクランプされ、盤上開拓地が保有コマ数(5)を超える
  //   幻のコマになって駒会計(盤上＋在庫=5)が破綻するため。撤去なら都市コマだけ返して整合する。
  if (p.remainingSettlements <= 0) {
    return {
      ...state,
      vertices: { ...state.vertices, [vid]: { ...v, building: null } },
      players: { ...state.players, [pid]: { ...p, remainingCities: p.remainingCities + 1 } },
    };
  }
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...v, building: { type: 'settlement', playerId: pid } } },
    players: { ...state.players, [pid]: { ...p, remainingCities: p.remainingCities + 1, remainingSettlements: p.remainingSettlements - 1 } },
  };
}

// ============================================================
// 進歩カード
// ============================================================

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** ツリー別の進歩カード山札を生成（各カード3枚ずつシャッフル）。 */
export function buildProgressDecks(rng: () => number): Record<CkTrack, ProgressCard[]> {
  const decks = { trade: [], politics: [], science: [] } as Record<CkTrack, ProgressCard[]>;
  for (const track of ['trade', 'politics', 'science'] as CkTrack[]) {
    const cards: ProgressCard[] = [];
    let n = 0;
    for (const type of PROGRESS_DECK_CARDS[track]) {
      const count = PROGRESS_DECK_COUNTS[type];
      for (let i = 0; i < count; i++) cards.push({ id: `${track}_${type}_${n++}`, type, deck: track });
    }
    decks[track] = shuffle(cards, rng);
  }
  return decks;
}

/**
 * 色イベント面で進歩カードを引く。引ける条件＝公式どおり:
 *   そのトラックの改善Lvが1以上 かつ 赤ダイス ≦ (Lv+1)（Lv0=引けない / Lv1=1–2 … Lv5=1–6）。
 * 引くのは条件を満たす全員。現手番プレイヤーから時計回りの順で引く（山札枯渇時の順序を正す）。手札上限4（VPカード除外）。
 */
function drawProgressCards(state: GameState, color: CkTrack, redDie: number): GameState {
  const decks = state.progressDecks;
  if (!decks) return state;
  const deck = [...(decks[color] ?? [])];
  if (deck.length === 0) return state;
  const players = { ...state.players };
  let changed = false;
  const overflow: PlayerId[] = []; // 上限超過（5枚目を引いた）→ 捨て札選択が要るプレイヤー
  const n = state.playerOrder.length;
  const start = state.currentPlayerIndex ?? 0;
  for (let i = 0; i < n; i++) {
    const pid = state.playerOrder[(start + i) % n]!;
    const p = players[pid]!;
    const lvl = p.improvements?.[color] ?? 0;
    if (lvl < 1 || lvl + 1 < redDie) continue;        // Lv0は不可。赤 ≦ Lv+1 のみ。
    if (deck.length === 0) break;
    // 公式: 上限(4・VPカード除外)を超えても引いてよく、その場合は1枚を選んで捨てる。
    const held = p.progressCards ?? [];
    const newHeld = [...held, deck.shift()!];
    players[pid] = { ...p, progressCards: newHeld };
    changed = true;
    if (newHeld.filter(c => !isVpProgress(c.type)).length > PROGRESS_HAND_LIMIT) overflow.push(pid);
  }
  if (!changed) return state;
  return {
    ...state, players, progressDecks: { ...decks, [color]: deck },
    ...(overflow.length > 0 ? { pendingProgressDiscard: overflow } : {}),
  };
}

function handTotalRes(p: Player): number {
  return RESOURCE_TYPES.reduce((s, r) => s + p.hand[r], 0);
}
// LAN(マスク済みstate)では相手の hand/commodities/progressCards の中身は秘匿され 0/空になる。
// 進歩カードの使用可否は「枚数」で決まるので、マスク時は count フィールドを優先して判定する
// （これが無いとオンラインでスパイ/独占/大商人等が常に使えないと誤判定される）。
function oppResCount(p: Player): number { return p.handCount ?? handTotalRes(p); }
function oppComCount(p: Player): number { return p.commodityCount ?? COMMODITY_TYPES.reduce((s, c) => s + commodities(p)[c], 0); }
function oppProgCount(p: Player): number { return p.progressCardCount ?? (p.progressCards?.length ?? 0); }
function adjacentTerrainCount(state: GameState, pid: PlayerId, type: TileType): number {
  const tiles = new Set<string>();
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    for (const tid of v.adjacentTileIds) if (state.tiles[tid]?.type === type) tiles.add(tid);
  }
  return tiles.size;
}
function discardLargest(hand: ResourceHand, n: number): ResourceHand {
  const h = { ...hand };
  for (let i = 0; i < n; i++) {
    const r = [...RESOURCE_TYPES].sort((a, b) => h[b] - h[a])[0]!;
    if (h[r] <= 0) break;
    h[r] -= 1;
  }
  return h;
}
function takeRandom(hand: ResourceHand, n: number, rng: () => number): { hand: ResourceHand; taken: Partial<ResourceHand> } {
  const h = { ...hand };
  const taken: Partial<ResourceHand> = {};
  for (let i = 0; i < n; i++) {
    const pool: ResourceType[] = [];
    for (const r of RESOURCE_TYPES) for (let k = 0; k < h[r]; k++) pool.push(r);
    if (pool.length === 0) break;
    const r = pool[Math.floor(rng() * pool.length)]!;
    h[r] -= 1; taken[r] = (taken[r] ?? 0) + 1;
  }
  return { hand: h, taken };
}
function addHand(hand: ResourceHand, add: Partial<ResourceHand>): ResourceHand {
  const h = { ...hand };
  for (const r of RESOURCE_TYPES) h[r] += add[r] ?? 0;
  return h;
}

// ============================================================
// 進歩カード（追加分）の補助ヘルパ
// ============================================================

const pip = (n: number | null): number => (n == null ? 0 : 6 - Math.abs(7 - n));

/** pid の建物が隣接する資源産出タイルのうち pip 最大のもの（merchant用）。なければ null。 */
function bestResourceTileForPlayer(state: GameState, pid: PlayerId): string | null {
  let best: string | null = null; let bestPip = -1;
  const seen = new Set<string>();
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    for (const tid of v.adjacentTileIds) {
      if (seen.has(tid)) continue; seen.add(tid);
      const t = state.tiles[tid];
      if (!t || TILE_RESOURCE_MAP[t.type] == null) continue;
      if (pip(t.number) > bestPip) { bestPip = pip(t.number); best = tid; }
    }
  }
  return best;
}

/** crane: 改善でき、商品が (cost-1) で足りるトラック（lvl最大優先）。 */
/** crane: 割引(商品1個)後に改善できるトラック一覧（未最大＆割引後コストを払える）。UI/自動選択用。 */
export function craneEligibleTracks(state: GameState, pid: PlayerId): CkTrack[] {
  const p = state.players[pid]; if (!p) return [];
  if (!Object.values(state.vertices).some(v => v.building?.playerId === pid && v.building.type === 'city')) return [];
  const tracks: CkTrack[] = ['trade', 'politics', 'science'];
  return tracks.filter(t => {
    const lvl = improvements(p)[t];
    return lvl < CK_MAX_IMPROVEMENT && commodities(p)[CK_TRACK_COMMODITY[t]] >= Math.max(0, improvementCost(lvl) - 1);
  });
}
function craneTrack(state: GameState, pid: PlayerId): CkTrack | null {
  const ok = [...craneEligibleTracks(state, pid)];
  const p = state.players[pid];
  if (p) ok.sort((a, b) => improvements(p)[b] - improvements(p)[a]);
  return ok[0] ?? null;
}

/** medicine: 都市化できる自分の開拓地頂点ID一覧（盤面選択の候補）。 */
export function medicineSettlements(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(vid => {
    const b = state.vertices[vid]?.building;
    return b?.playerId === pid && b.type === 'settlement';
  });
}
/** medicine: 都市化できる自分の開拓地頂点（隣接pip合計が最大）。 */
function medicineSettlement(state: GameState, pid: PlayerId): string | null {
  let best: string | null = null; let bestPip = -1;
  for (const [vid, v] of Object.entries(state.vertices)) {
    if (v.building?.playerId !== pid || v.building.type !== 'settlement') continue;
    const pp = v.adjacentTileIds.reduce((s, t) => s + pip(state.tiles[t]?.number ?? null), 0);
    if (pp > bestPip) { bestPip = pp; best = vid; }
  }
  return best;
}

/** inventor: 入替可能なタイル（数字あり・2/12/6/8以外＝公式制限）。UIの選択肢にも使う。 */
export function inventorTiles(state: GameState): string[] {
  return Object.keys(state.tiles).filter(t => {
    const n = state.tiles[t]!.number;
    return n != null && n !== 2 && n !== 12 && n !== 6 && n !== 8;
  });
}

function knightCountOf(state: GameState, pid: PlayerId): number {
  return Object.values(state.vertices).filter(v => v.knight?.playerId === pid).length;
}
function knightPlacementVertex(state: GameState, pid: PlayerId): string | null {
  return Object.keys(state.vertices).find(vid => canPlaceKnightVertex(state, pid, vid)) ?? null;
}
/** deserter: 消せる相手の騎士頂点ID一覧（盤面選択の候補・1手目）。 */
export function deserterTargets(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(vid => {
    const k = state.vertices[vid]?.knight;
    return !!k && k.playerId !== pid;
  });
}
/** deserter: 獲得した騎士を置ける自分の頂点ID一覧（盤面選択の候補・2手目）。 */
export function deserterPlacementTargets(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(vid => canPlaceKnightVertex(state, pid, vid));
}
/** smith: 1段昇格できる自分の騎士頂点ID一覧（強度<3。盤面選択の候補・最大2体まで選ぶ）。 */
export function smithKnightTargets(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(vid => {
    const k = state.vertices[vid]?.knight;
    return k?.playerId === pid && k.strength < 3;
  });
}
/** engineer: 城壁を建てられる自分の都市頂点ID一覧（都市・非メトロポリス・城壁なし。盤面選択の候補）。 */
export function engineerWallCities(state: GameState, pid: PlayerId): string[] {
  return Object.keys(state.vertices).filter(vid => {
    const b = state.vertices[vid]?.building;
    return b?.playerId === pid && b.type === 'city' && !b.metropolis && !(b as { wall?: boolean }).wall;
  });
}
/** deserter: 相手の最強の騎士頂点。 */
function strongestOpponentKnight(state: GameState, pid: PlayerId): { vid: string; strength: number } | null {
  let best: { vid: string; strength: number } | null = null;
  for (const [vid, v] of Object.entries(state.vertices)) {
    const k = v.knight;
    if (!k || k.playerId === pid) continue;
    if (!best || k.strength > best.strength) best = { vid, strength: k.strength };
  }
  return best;
}
/** intrigue: 自分の道/船に隣接する敵騎士の頂点（最強優先）。 */
function enemyKnightAdjacentToMyRoad(state: GameState, pid: PlayerId): string | null {
  let best: string | null = null; let bestStr = -1;
  for (const [vid, v] of Object.entries(state.vertices)) {
    const k = v.knight;
    if (!k || k.playerId === pid) continue;
    const adjMine = v.adjacentEdgeIds.some(eid => {
      const e = state.edges[eid];
      return e?.road?.playerId === pid || e?.ship?.playerId === pid;
    });
    if (adjMine && k.strength > bestStr) { bestStr = k.strength; best = vid; }
  }
  return best;
}
/**
 * diplomat: 撤去できる「端の道」一覧（端点の一方に建物無し・同色の他の道が続かない）。盤面選択の候補。
 * 公式: 相手の道だけでなく「自分の道」も対象（自分の道を撤去した場合は別の場所へ無料で1本建て直せる）。
 */
export function diplomatRemovableRoads(state: GameState, pid: PlayerId): string[] {
  const out: string[] = [];
  for (const [eid, e] of Object.entries(state.edges)) {
    const owner = e.road?.playerId;
    if (!owner) continue; // 自分の道も対象に含める（owner===pid を除外しない）
    const isOpen = e.vertexIds.some(vtxId => {
      const vtx = state.vertices[vtxId];
      if (!vtx || vtx.building) return false;
      const continues = vtx.adjacentEdgeIds.some(eid2 =>
        eid2 !== eid && (state.edges[eid2]?.road?.playerId === owner || state.edges[eid2]?.ship?.playerId === owner));
      return !continues;
    });
    if (isOpen) out.push(eid);
  }
  return out;
}
function removableOpponentRoad(state: GameState, pid: PlayerId): string | null {
  return diplomatRemovableRoads(state, pid)[0] ?? null;
}

// ---- 効果適用（追加分。いずれも自動最善選択で即時解決＝保留状態なし＝ソフトロックなし） ----

function chooseAlchemistDice(state: GameState, pid: PlayerId): [number, number] {
  let bestTotal = 8, bestW = -1;
  for (let total = 2; total <= 12; total++) {
    if (total === 7) continue;
    let w = 0;
    for (const t of Object.values(state.tiles)) {
      if (t.number !== total || t.hasRobber || TILE_RESOURCE_MAP[t.type] == null) continue;
      for (const vid of state.tileToVertices[t.id] ?? []) {
        const b = state.vertices[vid]?.building;
        if (b?.playerId === pid) w += b.type === 'city' ? 2 : 1;
      }
    }
    if (w > bestW) { bestW = w; bestTotal = total; }
  }
  const d1 = Math.min(6, bestTotal - 1);
  return [d1, bestTotal - d1];
}

function chooseFleetType(state: GameState, pid: PlayerId): TradeKind {
  const p = state.players[pid]!;
  let best: TradeKind = 'wood'; let bestN = -1;
  for (const r of RESOURCE_TYPES) if (p.hand[r] > bestN) { bestN = p.hand[r]; best = r; }
  for (const c of COMMODITY_TYPES) if (commodities(p)[c] > bestN) { bestN = commodities(p)[c]; best = c; }
  return best;
}

function playInventor(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  const eligible = inventorTiles(state);
  if (eligible.length < 2) return state;
  let tileA: string | undefined;
  let tileB: string | undefined;
  // 公式: 入れ替える2タイルを自分で選ぶ（choice.inventorTiles）。両方が入替可能タイルで別物なら採用。
  const ch = choice?.inventorTiles;
  if (ch && ch.length === 2 && ch[0] !== ch[1] && eligible.includes(ch[0]) && eligible.includes(ch[1])) {
    tileA = ch[0]; tileB = ch[1];
  } else {
    // 未指定/不正なら自動最善（CPU/フォールバック）: 自分に最も隣接し低pipのタイルを、無関係で高pipのタイルと入替。
    const adjCount = (tid: string): number => (state.tileToVertices[tid] ?? []).filter(v => state.vertices[v]?.building?.playerId === pid).length;
    tileA = [...eligible].sort((a, b) => (adjCount(b) - adjCount(a)) || (pip(state.tiles[a]!.number) - pip(state.tiles[b]!.number)))[0]!;
    tileB = [...eligible].filter(t => t !== tileA).sort((a, b) => (adjCount(a) - adjCount(b)) || (pip(state.tiles[b]!.number) - pip(state.tiles[a]!.number)))[0];
  }
  if (!tileA || !tileB || tileA === tileB) return state;
  const nA = state.tiles[tileA]!.number, nB = state.tiles[tileB]!.number;
  return { ...state, tiles: { ...state.tiles, [tileA]: { ...state.tiles[tileA]!, number: nB }, [tileB]: { ...state.tiles[tileB]!, number: nA } } };
}

function playMedicine(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  // 手動で都市化する開拓地を選べる（choice.medicineVertexId）。自分の開拓地なら採用。なければ自動(最大pip)。
  const chosen = choice?.medicineVertexId;
  const cb = chosen ? state.vertices[chosen]?.building : null;
  const vid = (chosen && cb?.playerId === pid && cb.type === 'settlement') ? chosen : medicineSettlement(state, pid);
  const p = state.players[pid]!;
  if (!vid || p.hand.grain < 1 || p.hand.ore < 2 || p.remainingCities <= 0) return state;
  return {
    ...state,
    vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, building: { type: 'city', playerId: pid } } },
    bank: { ...state.bank, grain: state.bank.grain + 1, ore: state.bank.ore + 2 },
    players: { ...state.players, [pid]: { ...p, hand: { ...p.hand, grain: p.hand.grain - 1, ore: p.hand.ore - 2 }, remainingCities: p.remainingCities - 1, remainingSettlements: p.remainingSettlements + 1 } },
  };
}

/** pid の建物に隣接する資源産出タイルID一覧（商人コマを置ける候補・盤面選択用）。 */
export function merchantTileIds(state: GameState, pid: PlayerId): TileId[] {
  const out: TileId[] = [];
  const seen = new Set<string>();
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    for (const tid of v.adjacentTileIds) {
      if (seen.has(tid)) continue; seen.add(tid);
      const t = state.tiles[tid];
      if (!t || TILE_RESOURCE_MAP[t.type] == null) continue;
      out.push(tid as TileId);
    }
  }
  return out;
}

function playMerchant(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  // 手動選択（choice.merchantTileId）が候補に含まれていればそれを優先。なければ自動（pip最大）。
  const valid = new Set(merchantTileIds(state, pid));
  const chosen = choice?.merchantTileId;
  const tid = (chosen && valid.has(chosen)) ? chosen : bestResourceTileForPlayer(state, pid);
  if (!tid) return state;
  return { ...state, merchant: { playerId: pid, tileId: tid } };
}

function playCommercialHarbor(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  const players = { ...state.players };
  const me = players[pid]!;
  let myHand = { ...me.hand };
  let myComm = { ...commodities(me) };
  // 手動（宣言型）: 渡す資源1種＋要求する商品1種を全相手共通で指名（choice）。
  //   未指定なら従来の自動（相手ごとに「自分の最多資源⇄相手の最多商品」）。
  const fixedGive = choice?.commercialGive ?? null;
  const fixedTake = choice?.commercialTake ?? null;
  for (const o of state.playerOrder) {
    if (o === pid) continue;
    const opp = players[o]!;
    const giveRes = fixedGive ?? RESOURCE_TYPES.filter(r => myHand[r] > 0).sort((a, b) => myHand[b] - myHand[a])[0];
    const takeCom = fixedTake ?? COMMODITY_TYPES.filter(c => commodities(opp)[c] > 0).sort((a, b) => commodities(opp)[b] - commodities(opp)[a])[0];
    if (!giveRes || !takeCom) continue;
    // 渡せる資源が手元に無い／要求商品をその相手が持たない場合は、この相手とは交換不成立。
    if (myHand[giveRes] <= 0 || commodities(opp)[takeCom] <= 0) continue;
    myHand = { ...myHand, [giveRes]: myHand[giveRes] - 1 };
    myComm = { ...myComm, [takeCom]: myComm[takeCom] + 1 };
    players[o] = { ...opp, hand: { ...opp.hand, [giveRes]: opp.hand[giveRes] + 1 }, commodities: { ...commodities(opp), [takeCom]: commodities(opp)[takeCom] - 1 } };
  }
  players[pid] = { ...me, hand: myHand, commodities: myComm };
  return { ...state, players };
}

/** bishop: 盗賊を置ける陸タイル（海・現在地以外）。盤面選択の候補。 */
export function bishopTileIds(state: GameState): TileId[] {
  const current = Object.keys(state.tiles).find(t => state.tiles[t]!.hasRobber);
  return Object.keys(state.tiles).filter(t => state.tiles[t]!.type !== 'sea' && t !== current) as TileId[];
}
function playBishop(state: GameState, pid: PlayerId, rng: () => number, choice?: ProgressChoice): GameState {
  const current = Object.keys(state.tiles).find(t => state.tiles[t]!.hasRobber);
  // 手動でタイルを選べる（choice.bishopTileId）。海・現在地でなければ採用。なければ自動最善。
  let bestTid: string | null = null;
  const chosen = choice?.bishopTileId;
  if (chosen && state.tiles[chosen] && state.tiles[chosen]!.type !== 'sea' && chosen !== current) {
    bestTid = chosen;
  } else {
    let bestScore = -1;
    for (const [tid, t] of Object.entries(state.tiles)) {
      if (t.type === 'sea' || tid === current) continue;
      const opps = new Set<PlayerId>();
      for (const vid of state.tileToVertices[tid] ?? []) {
        const o = state.vertices[vid]?.building?.playerId;
        if (o && o !== pid) opps.add(o);
      }
      const score = [...opps].reduce((s, o) => s + robbableCardCount(state, o), 0);
      if (score > bestScore) { bestScore = score; bestTid = tid; }
    }
  }
  if (!bestTid) return state;
  let s = moveRobber(state, bestTid);
  const victims = new Set<PlayerId>();
  for (const vid of s.tileToVertices[bestTid] ?? []) {
    const o = s.vertices[vid]?.building?.playerId;
    if (o && o !== pid && robbableCardCount(s, o) > 0) victims.add(o);
  }
  for (const o of victims) s = stealResource(s, pid, o, rng);
  return s;
}

function playDeserter(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  // 手動で消す相手の騎士を選べる（choice.deserterVertexId）。相手の騎士頂点なら採用。なければ自動(最強)。
  const chosen = choice?.deserterVertexId;
  const ck = chosen ? state.vertices[chosen]?.knight : null;
  const target = (chosen && ck && ck.playerId !== pid)
    ? { vid: chosen, strength: ck.strength }
    : strongestOpponentKnight(state, pid);
  if (!target) return state;
  let vertices = { ...state.vertices, [target.vid]: { ...state.vertices[target.vid]!, knight: null } };
  // 獲得騎士の配置先: 手動指定(deserterPlaceVertexId)が合法ならそこ、なければ自動（最初の合法頂点）。
  const stAfter: GameState = { ...state, vertices };
  const want = choice?.deserterPlaceVertexId;
  const place = (want && canPlaceKnightVertex(stAfter, pid, want)) ? want : knightPlacementVertex(stAfter, pid);
  if (place && knightCountOf(state, pid) < PIECE_LIMITS.knights) {
    vertices = { ...vertices, [place]: { ...vertices[place]!, knight: { playerId: pid, strength: target.strength as 1 | 2 | 3, active: false } } };
  }
  return { ...state, vertices };
}

/** intrigue: 自分の道/船に隣接する敵騎士の頂点ID一覧（盤面選択の候補）。 */
export function intrigueKnightTargets(state: GameState, pid: PlayerId): string[] {
  const out: string[] = [];
  for (const [vid, v] of Object.entries(state.vertices)) {
    const k = v.knight;
    if (!k || k.playerId === pid) continue;
    const adjMine = v.adjacentEdgeIds.some(eid => {
      const e = state.edges[eid];
      return e?.road?.playerId === pid || e?.ship?.playerId === pid;
    });
    if (adjMine) out.push(vid);
  }
  return out;
}
function playIntrigue(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  // 手動で退去させる敵騎士を選べる（choice.intrigueVertexId）。候補内なら採用。なければ自動（最強）。
  const chosen = choice?.intrigueVertexId;
  const vid = (chosen && intrigueKnightTargets(state, pid).includes(chosen)) ? chosen : enemyKnightAdjacentToMyRoad(state, pid);
  if (!vid) return state;
  return { ...state, vertices: { ...state.vertices, [vid]: { ...state.vertices[vid]!, knight: null } } };
}

function playDiplomat(state: GameState, pid: PlayerId, choice?: ProgressChoice): GameState {
  // 手動で撤去する「端の道」を選べる（choice.diplomatEdgeId・自分の道も対象）。候補内なら採用。
  // 未指定（CPU等）は相手の端の道を自動で撤去する。
  const chosen = choice?.diplomatEdgeId;
  const eid = (chosen && diplomatRemovableRoads(state, pid).includes(chosen)) ? chosen : removableOpponentRoad(state, pid);
  if (!eid) return state;
  const owner = state.edges[eid]?.road?.playerId;
  if (!owner) return state;
  // 撤去した道のコマは所有者の手元へ戻す（remainingRoads+1）。
  const ownerP = state.players[owner]!;
  let next: GameState = updateLongestRoad({
    ...state,
    players: { ...state.players, [owner]: { ...ownerP, remainingRoads: ownerP.remainingRoads + 1 } },
    edges: { ...state.edges, [eid]: { ...state.edges[eid]!, road: null } },
  });
  // 自分の道を撤去したら、別の場所へ無料で道を1本だけ建て直せる（公式）。建てられる場所がある時のみ。
  if (owner === pid) {
    const free: GameState = { ...next, roadBuildingRoadsRemaining: 1 };
    const canRebuild = next.players[pid]!.remainingRoads > 0 && Object.keys(next.edges).some(e => canBuildRoad(free, pid, e));
    if (canRebuild) next = free;
  }
  return next;
}

function playSpy(state: GameState, pid: PlayerId, rng: () => number, choice?: ProgressChoice): GameState {
  const opps = state.playerOrder.filter(o => o !== pid && (state.players[o]!.progressCards?.length ?? 0) > 0);
  if (opps.length === 0) return state;
  // 手動: 盗む相手と札を指名できる（公式: 相手の手札を見て1枚選ぶ）。未指定/不正なら自動（最多保持の相手から無作為）。
  const chosenTarget = choice?.spyTargetPlayerId;
  const target = (chosenTarget && opps.includes(chosenTarget))
    ? chosenTarget
    : [...opps].sort((a, b) => (state.players[b]!.progressCards?.length ?? 0) - (state.players[a]!.progressCards?.length ?? 0))[0]!;
  const tc = state.players[target]!.progressCards ?? [];
  const chosenIdx = choice?.spyCardId ? tc.findIndex(c => c.id === choice.spyCardId) : -1;
  const idx = chosenIdx >= 0 ? chosenIdx : Math.floor(rng() * tc.length);
  const stolen = tc[idx]!;
  const me = state.players[pid]!;
  return {
    ...state,
    players: {
      ...state.players,
      [target]: { ...state.players[target]!, progressCards: tc.filter((_, i) => i !== idx) },
      [pid]: { ...me, progressCards: [...(me.progressCards ?? []), stolen] },
    },
  };
}

/** 進歩カードを使用可能か（手札にあり、効果が成立する状況か）。 */
export function canPlayProgress(state: GameState, pid: PlayerId, cardId: string): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; if (!p) return false;
  const card = (p.progressCards ?? []).find(c => c.id === cardId);
  if (!card) return false;
  const opps = state.playerOrder.filter(o => o !== pid);
  const myVp = calcVP(state, pid);
  switch (card.type) {
    case 'smith':    return Object.values(state.vertices).some(v => v.knight?.playerId === pid && v.knight.strength < 3);
    case 'engineer': return wallCount(state, pid) < CK_MAX_WALLS && Object.values(state.vertices).some(v => v.building?.playerId === pid && v.building.type === 'city' && !v.building.metropolis && !(v.building as { wall?: boolean }).wall);
    case 'irrigation': return adjacentTerrainCount(state, pid, 'field') > 0;
    case 'mining':     return adjacentTerrainCount(state, pid, 'mountain') > 0;
    case 'resource_monopoly': return opps.some(o => oppResCount(state.players[o]!) > 0);
    case 'trade_monopoly':    return opps.some(o => oppComCount(state.players[o]!) > 0);
    case 'master_merchant':   return opps.some(o => oppResCount(state.players[o]!) > 0 && calcVP(state, o) > myVp); // 公式: 自分よりVPが高い相手のみ
    case 'warlord':  return Object.values(state.vertices).some(v => v.knight?.playerId === pid && !v.knight.active);
    case 'saboteur': return opps.some(o => calcVP(state, o) >= myVp && oppResCount(state.players[o]!) > 0);
    case 'wedding':  return opps.some(o => calcVP(state, o) > myVp && oppResCount(state.players[o]!) > 0);
    // ---- 追加分 ----
    case 'alchemist': return state.turnPhase === 'PRE_ROLL'; // ダイスを振る前のみ
    case 'crane':     return craneTrack(state, pid) != null;
    case 'inventor':  return inventorTiles(state).length >= 2;
    case 'medicine':  return p.hand.grain >= 1 && p.hand.ore >= 2 && p.remainingCities > 0 && medicineSettlement(state, pid) != null;
    case 'printer': case 'constitution': return true;
    case 'road_building_progress': {
      const free = { ...state, roadBuildingRoadsRemaining: 1 }; // コスト無視で接続性のみ判定
      return p.remainingRoads > 0 && Object.keys(state.edges).some(e => canBuildRoad(free, pid, e));
    }
    case 'commercial_harbor': return RESOURCE_TYPES.some(r => p.hand[r] > 0) && opps.some(o => oppComCount(state.players[o]!) > 0);
    case 'merchant':      return bestResourceTileForPlayer(state, pid) != null;
    case 'merchant_fleet': return RESOURCE_TYPES.some(r => p.hand[r] > 0) || COMMODITY_TYPES.some(c => commodities(p)[c] > 0);
    case 'bishop': { // 盗賊は初回の蛮族襲来まで凍結。移動可能な陸タイル（現在地以外）が必要。
      if ((state.barbarianAttacks ?? 0) < 1) return false;
      const cur = Object.keys(state.tiles).find(t => state.tiles[t]!.hasRobber);
      return Object.keys(state.tiles).some(t => state.tiles[t]!.type !== 'sea' && t !== cur);
    }
    case 'deserter':  return knightCountOf(state, pid) < PIECE_LIMITS.knights && strongestOpponentKnight(state, pid) != null && knightPlacementVertex(state, pid) != null;
    case 'diplomat':  return removableOpponentRoad(state, pid) != null;
    case 'intrigue':  return enemyKnightAdjacentToMyRoad(state, pid) != null;
    case 'spy':       return opps.some(o => oppProgCount(state.players[o]!) > 0);
    default: return false;
  }
}

/**
 * 人間が「効果が空でも進歩カードを使える（消費される）」ための緩い判定。
 * 構造/フェーズ条件のみ（手札にある・正しいフェーズ・盗賊凍結中のbishop不可）。効果の成立は問わない。
 * applyAction の受理と人間UIの有効化に使う。CPUは従来の canPlayProgress（効果が成立する時だけ）で判断する。
 */
export function canPlayProgressLoose(state: GameState, pid: PlayerId, cardId: string): boolean {
  if (!isCk(state)) return false;
  const p = state.players[pid]; if (!p) return false;
  const card = (p.progressCards ?? []).find(c => c.id === cardId);
  if (!card) return false;
  // 通常は TRADE_BUILD、錬金術師(次のダイス指定)のみ PRE_ROLL。
  const okPhase = state.phase === 'MAIN'
    && (state.turnPhase === 'TRADE_BUILD' || (card.type === 'alchemist' && state.turnPhase === 'PRE_ROLL'));
  if (!okPhase) return false;
  // 盗賊は初回の蛮族襲来まで凍結。bishop だけは空撃ち不可（凍結中の盗賊を動かさない）。
  if (card.type === 'bishop' && (state.barbarianAttacks ?? 0) < 1) return false;
  return true;
}

/** 進歩カードを使用して効果を適用（バリデーション済み前提）。カードは手札から除去。 */
export function playProgress(state: GameState, pid: PlayerId, cardId: string, rng: () => number, choice?: ProgressChoice): GameState {
  const p0 = state.players[pid]!;
  const card = (p0.progressCards ?? []).find(c => c.id === cardId)!;
  // カードを手札から除去した基準state。
  const removed: GameState = { ...state, players: { ...state.players, [pid]: { ...p0, progressCards: (p0.progressCards ?? []).filter(c => c.id !== cardId) } } };

  // ---- 追加分: 自動最善で即時解決（保留状態を作らない＝ソフトロックなし） ----
  switch (card.type) {
    case 'printer': case 'constitution':
      return { ...removed, players: { ...removed.players, [pid]: { ...removed.players[pid]!, progressVP: (removed.players[pid]!.progressVP ?? 0) + 1 } } };
    case 'alchemist': {
      // 公式: 次のダイス目を自分で指定（choice.dice）。未指定/不正なら自動最善（CPU/フォールバック）。
      const d = choice?.dice;
      const dice: [number, number] = (d && Number.isInteger(d[0]) && Number.isInteger(d[1]) && d[0] >= 1 && d[0] <= 6 && d[1] >= 1 && d[1] <= 6)
        ? [d[0], d[1]]
        : chooseAlchemistDice(removed, pid);
      return { ...removed, alchemistForcedDice: dice };
    }
    case 'road_building_progress':
      return { ...removed, roadBuildingRoadsRemaining: Math.min(2, removed.players[pid]!.remainingRoads) };
    case 'crane': {
      // 手動でトラックを選べる（choice.craneTrack）。割引後に払える＆未最大なら採用。なければ自動。
      const chosen = choice?.craneTrack;
      const track = (chosen && craneEligibleTracks(removed, pid).includes(chosen)) ? chosen : craneTrack(removed, pid);
      return track ? buildImprovement(removed, pid, track, 1) : removed;
    }
    case 'medicine':         return playMedicine(removed, pid, choice);
    case 'inventor':         return playInventor(removed, pid, choice);
    case 'merchant':         return playMerchant(removed, pid, choice);
    case 'merchant_fleet':   return { ...removed, players: { ...removed.players, [pid]: { ...removed.players[pid]!, merchantFleetType: choice?.fleetType ?? chooseFleetType(removed, pid) } } };
    case 'commercial_harbor': return playCommercialHarbor(removed, pid, choice);
    case 'bishop':           return playBishop(removed, pid, rng, choice);
    case 'deserter':         return playDeserter(removed, pid, choice);
    case 'diplomat':         return playDiplomat(removed, pid, choice);
    case 'intrigue':         return playIntrigue(removed, pid, choice);
    case 'spy':              return playSpy(removed, pid, rng, choice);
  }

  // ---- 既存10種: locals パターン ----
  const players: Record<string, Player> = { ...removed.players };
  let vertices = state.vertices;
  let bank = { ...state.bank };
  const opps = state.playerOrder.filter(o => o !== pid);
  const gainRes = (id: PlayerId, add: Partial<ResourceHand>): void => { players[id] = { ...players[id]!, hand: addHand(players[id]!.hand, add) }; };

  switch (card.type) {
    case 'smith': {
      const v2 = { ...vertices };
      // 手動: 昇格する自分の騎士（最大2体・強度<3）を選べる（choice.smithVertexIds）。未指定/不正なら自動（最弱2体）。
      const valid = new Set(smithKnightTargets(state, pid));
      const picked = (choice?.smithVertexIds ?? []).filter(id => valid.has(id)).slice(0, 2);
      const targets = picked.length > 0 ? picked : Object.keys(v2)
        .filter(id => v2[id]!.knight?.playerId === pid && v2[id]!.knight!.strength < 3)
        .sort((a, b) => v2[a]!.knight!.strength - v2[b]!.knight!.strength).slice(0, 2);
      for (const id of targets) { const k = v2[id]!.knight!; v2[id] = { ...v2[id]!, knight: { ...k, strength: (k.strength + 1) as 1 | 2 | 3 } }; }
      vertices = v2; break;
    }
    case 'engineer': {
      // 公式: 城壁は最大3。上限到達後に技師を使ってもカードは消費するが4つ目は建てない
      //（城壁数は7の捨て札しきい値 8+2×城壁 に直結するため上限超過は不正）。
      if (wallCount(removed, pid) >= CK_MAX_WALLS) break;
      // 手動: 城壁を建てる自分の都市を選べる（choice.engineerVertexId）。候補内なら採用。なければ自動（最初の対象）。
      const chosenCity = choice?.engineerVertexId;
      const id = (chosenCity && engineerWallCities(state, pid).includes(chosenCity)) ? chosenCity
        : Object.keys(vertices).find(v => vertices[v]!.building?.playerId === pid && vertices[v]!.building?.type === 'city' && !vertices[v]!.building?.metropolis && !(vertices[v]!.building as { wall?: boolean }).wall);
      if (id) vertices = { ...vertices, [id]: { ...vertices[id]!, building: { ...vertices[id]!.building!, wall: true } } };
      break;
    }
    case 'irrigation': case 'mining': {
      const isIrr = card.type === 'irrigation';
      const r: ResourceType = isIrr ? 'grain' : 'ore';
      const amt = Math.min(adjacentTerrainCount(state, pid, isIrr ? 'field' : 'mountain') * 2, bank[r]);
      bank[r] -= amt; gainRes(pid, { [r]: amt }); break;
    }
    case 'resource_monopoly': {
      // 公式: 奪う資源は自分で指名（choice）。未指定なら自動で最多の資源（CPU/フォールバック）。
      let best: ResourceType = choice?.resource ?? 'wood';
      if (!choice?.resource) { let bt = -1; for (const r of RESOURCE_TYPES) { const t = opps.reduce((s, o) => s + players[o]!.hand[r], 0); if (t > bt) { bt = t; best = r; } } }
      let gained = 0;
      for (const o of opps) { const take = Math.min(2, players[o]!.hand[best]); if (take > 0) { players[o] = { ...players[o]!, hand: { ...players[o]!.hand, [best]: players[o]!.hand[best] - take } }; gained += take; } }
      gainRes(pid, { [best]: gained }); break;
    }
    case 'trade_monopoly': {
      // 公式: 奪う商品は自分で指名（choice）。未指定なら自動で最多の商品。
      let best: CommodityType = choice?.commodity ?? 'coin';
      if (!choice?.commodity) { let bt = -1; for (const c of COMMODITY_TYPES) { const t = opps.reduce((s, o) => s + commodities(players[o]!)[c], 0); if (t > bt) { bt = t; best = c; } } }
      let gained = 0;
      for (const o of opps) { const take = Math.min(1, commodities(players[o]!)[best]); if (take > 0) { players[o] = { ...players[o]!, commodities: { ...commodities(players[o]!), [best]: commodities(players[o]!)[best] - take } }; gained += take; } }
      players[pid] = { ...players[pid]!, commodities: { ...commodities(players[pid]!), [best]: commodities(players[pid]!)[best] + gained } }; break;
    }
    case 'master_merchant': {
      // 公式: 自分よりVPが高い相手から1人を選ぶ（choice）。未指定なら最高VPの相手（CPU/フォールバック）。
      const myVp = calcVP(state, pid);
      const eligible = opps.filter(o => handTotalRes(players[o]!) > 0 && calcVP(state, o) > myVp);
      const target = (choice?.targetPlayerId && eligible.includes(choice.targetPlayerId))
        ? choice.targetPlayerId
        : [...eligible].sort((a, b) => calcVP(state, b) - calcVP(state, a))[0];
      if (target) { const { hand, taken } = takeRandom(players[target]!.hand, 2, rng); players[target] = { ...players[target]!, hand }; gainRes(pid, taken); }
      break;
    }
    case 'warlord': {
      const v2 = { ...vertices };
      for (const id of Object.keys(v2)) { const k = v2[id]!.knight; if (k?.playerId === pid && !k.active) v2[id] = { ...v2[id]!, knight: { ...k, active: true } }; }
      vertices = v2; break;
    }
    case 'saboteur': {
      const myVp = calcVP(state, pid);
      for (const o of opps) {
        if (calcVP(state, o) < myVp) continue;
        const tot = handTotalRes(players[o]!);
        const n = Math.floor(tot / 2);
        if (n <= 0) continue;
        const before = players[o]!.hand;
        const after = discardLargest(before, n);
        players[o] = { ...players[o]!, hand: after };
        for (const r of RESOURCE_TYPES) bank[r] += before[r] - after[r]; // 捨て札はバンクへ
      }
      break;
    }
    case 'wedding': {
      const myVp = calcVP(state, pid);
      for (const o of opps) {
        if (calcVP(state, o) <= myVp) continue;
        const { hand, taken } = takeRandom(players[o]!.hand, 2, rng);
        players[o] = { ...players[o]!, hand }; gainRes(pid, taken);
      }
      break;
    }
  }
  return { ...state, players, vertices, bank };
}

/**
 * ROLL_DICE後にイベントダイスを処理。
 *  - 蛮族船: 前進し、CK_BARBARIAN_MAX で襲来判定。
 *  - 色(交易/政治/科学): その色の改善レベルが赤ダイス(redDie)以上のプレイヤーが進歩カードを1枚引く。
 */
export function applyEventDie(state: GameState, rng: () => number, redDie: number): GameState {
  const face = rollEventDie(rng);
  const next: GameState = { ...state, lastEventDie: face };
  if (face === 'ship') {
    const pos = (next.barbarianPosition ?? 0) + 1;
    return pos >= CK_BARBARIAN_MAX ? resolveBarbarianAttack({ ...next, barbarianPosition: pos }) : { ...next, barbarianPosition: pos };
  }
  return drawProgressCards(next, face, redDie);
}

/** C&K産出を手札・銀行へ適用（資源＋商品）。computeCkProduction の結果を反映した新stateを返す。 */
export function distributeCkProduction(state: GameState, diceTotal: number): GameState {
  const { resources, commodities: comm } = computeCkProduction(state, diceTotal);
  const players = { ...state.players };
  const bank = { ...state.bank };
  const commodityBank = { ...(state.commodityBank ?? COMMODITY_BANK_INITIAL) };
  // 航海者コンボ盤: 金タイルは computeCkProduction では産出0だが、このロールで金の選択(GOLD)を
  //   受けるプレイヤーは「産出あり」扱い＝水道橋(科学Lv3)を発火させない（金の選択枚と二重取りを防ぐ）。
  const goldPicks = computeGoldPicks(state, diceTotal);
  for (const pid of state.playerOrder) {
    const rGain = resources[pid]; const cGain = comm[pid];
    const p = players[pid]!;
    const hand = { ...p.hand };
    let resGained = 0;
    if (rGain) for (const r of RESOURCE_TYPES) { const n = rGain[r] ?? 0; if (n) { hand[r] += n; bank[r] -= n; resGained += n; } }
    const newComm = { ...commodities(p) };
    if (cGain) for (const c of COMMODITY_TYPES) { const n = cGain[c] ?? 0; if (n) { newComm[c] += n; commodityBank[c] -= n; } }
    // 水道橋(科学Lv3): このロールで資源を1つも得られなかったプレイヤーは、資源を1枚もらえる
    //   （手動選択UIを避けるため、最も少ない資源を自動選択。バンク在庫で頭打ち）。
    //   金タイル産出(GOLD選択)を受ける人は「産出あり」＝水道橋の対象外（金＋水道橋の二重取り防止）。
    if (resGained === 0 && (goldPicks[pid] ?? 0) === 0 && (p.improvements?.science ?? 0) >= 3) {
      const r = [...RESOURCE_TYPES].sort((a, b) => (hand[a] - hand[b]) || (bank[b] - bank[a]))[0]!;
      if (bank[r] > 0) { hand[r] += 1; bank[r] -= 1; resGained = 1; }
    }
    if (resGained > 0 || (cGain && COMMODITY_TYPES.some(c => (cGain[c] ?? 0) > 0))) {
      players[pid] = { ...p, hand, commodities: newComm };
    }
  }
  return { ...state, players, bank, commodityBank };
}

export interface CkProduction {
  resources: Record<string, Partial<Record<ResourceType, number>>>;
  commodities: Record<string, Partial<Record<CommodityType, number>>>;
}

/**
 * 騎士と商人のセットアップ後半: 2個目の配置は「都市」。
 * 直前に置いた開拓地を都市へ昇格し、都市の初期産出（隣接地形ごとに 資源1+商品1 / 資源2）を配る。
 * 純関数。バンク/商品バンク在庫で頭打ち。
 */
export function ckSetupSecondCity(state: GameState, pid: PlayerId, vid: VertexId): GameState {
  const v = state.vertices[vid]!;
  const p = state.players[pid]!;
  const hand = { ...p.hand };
  const newComm = { ...commodities(p) };
  const bank = { ...state.bank };
  const commodityBank = { ...(state.commodityBank ?? COMMODITY_BANK_INITIAL) };
  const seen = new Set<string>();
  for (const tid of v.adjacentTileIds) {
    if (seen.has(tid)) continue; seen.add(tid);
    const t = state.tiles[tid];
    if (!t || t.hasRobber) continue;
    const r = TILE_RESOURCE_MAP[t.type];
    if (r == null) continue; // 砂漠/海/金は産出なし
    const c = TILE_COMMODITY_MAP[t.type];
    if (c) { // 都市(森/牧草/山): 資源1+商品1
      if (bank[r] > 0) { hand[r] += 1; bank[r] -= 1; }
      if (commodityBank[c] > 0) { newComm[c] += 1; commodityBank[c] -= 1; }
    } else {  // 都市(丘/畑): 資源2
      const give = Math.min(2, bank[r]);
      hand[r] += give; bank[r] -= give;
    }
  }
  return {
    ...state,
    bank,
    commodityBank,
    vertices: { ...state.vertices, [vid]: { ...v, building: { type: 'city', playerId: pid } } },
    players: {
      ...state.players,
      // 開拓地→都市の振替（開拓地コマを1つ戻し、都市コマを1つ使う）。
      [pid]: { ...p, hand, commodities: newComm, remainingSettlements: p.remainingSettlements + 1, remainingCities: p.remainingCities - 1 },
    },
  };
}

/**
 * Cities & Knights の出目一致による産出（資源＋商品）をプレイヤー別に計算する純関数。
 * 基本の computeDiceProduction と違い、都市は商品地形では「資源1＋商品1」、丘/畑では「資源2」。
 */
export function computeCkProduction(state: GameState, diceTotal: number): CkProduction {
  const resources: CkProduction['resources'] = {};
  const commodities: CkProduction['commodities'] = {};
  if (diceTotal === 7) return { resources, commodities };

  // resource/commodity → playerId → 総需要量（バンク枯渇判定に使う）
  const resDemand: Record<ResourceType, Record<string, number>> = {
    wood: {}, brick: {}, wool: {}, grain: {}, ore: {},
  };
  const comDemand: Record<CommodityType, Record<string, number>> = {
    coin: {}, cloth: {}, paper: {},
  };

  for (const tile of Object.values(state.tiles)) {
    if (tile.number !== diceTotal) continue;
    if (tile.hasRobber) continue;
    const resource = TILE_RESOURCE_MAP[tile.type];
    if (resource == null) continue; // 砂漠/海/金は産出なし
    const commodity = TILE_COMMODITY_MAP[tile.type]; // 森/牧草/山なら紙/布/金貨

    for (const vid of state.tileToVertices[tile.id] ?? []) {
      const building = state.vertices[vid]?.building;
      if (!building) continue;
      const { playerId, type } = building;
      if (type === 'settlement') {
        resDemand[resource][playerId] = (resDemand[resource][playerId] ?? 0) + 1;
      } else {
        // 都市
        if (commodity) {
          resDemand[resource][playerId] = (resDemand[resource][playerId] ?? 0) + 1;
          comDemand[commodity][playerId] = (comDemand[commodity][playerId] ?? 0) + 1;
        } else {
          resDemand[resource][playerId] = (resDemand[resource][playerId] ?? 0) + 2;
        }
      }
    }
  }

  // 資源にバンク枯渇ルールを適用（基本ゲームと同じ）。
  const bankLeft = { ...state.bank };
  for (const resource of RESOURCE_TYPES) {
    const demand = resDemand[resource];
    const pids = Object.keys(demand);
    if (pids.length === 0) continue;
    const totalDemand = pids.reduce((s, p) => s + (demand[p] ?? 0), 0);
    if (pids.length > 1 && totalDemand > bankLeft[resource]) continue; // 複数需要が在庫超→誰も貰えない
    for (const pid of state.playerOrder) {
      const needed = demand[pid] ?? 0;
      if (needed === 0) continue;
      const actual = Math.min(needed, bankLeft[resource]);
      if (actual <= 0) continue;
      bankLeft[resource] -= actual;
      if (!resources[pid]) resources[pid] = {};
      resources[pid]![resource] = (resources[pid]![resource] ?? 0) + actual;
    }
  }

  // 商品にも同じ枯渇ルールを適用（commodityBank 在庫で頭打ち。複数需要が在庫超なら誰も貰えない）。
  const comBankLeft = { ...(state.commodityBank ?? COMMODITY_BANK_INITIAL) };
  for (const c of COMMODITY_TYPES) {
    const demand = comDemand[c];
    const pids = Object.keys(demand);
    if (pids.length === 0) continue;
    const totalDemand = pids.reduce((s, p) => s + (demand[p] ?? 0), 0);
    if (pids.length > 1 && totalDemand > comBankLeft[c]) continue;
    for (const pid of state.playerOrder) {
      const needed = demand[pid] ?? 0;
      if (needed === 0) continue;
      const actual = Math.min(needed, comBankLeft[c]);
      if (actual <= 0) continue;
      comBankLeft[c] -= actual;
      if (!commodities[pid]) commodities[pid] = {};
      commodities[pid]![c] = (commodities[pid]![c] ?? 0) + actual;
    }
  }

  return { resources, commodities };
}
