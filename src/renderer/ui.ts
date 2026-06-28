// ============================================================
// src/renderer/ui.ts — F-03: 手番UIパネル
// ============================================================

import type { GameState, Action, PlayerId, ResourceType, Player, ResourceHand } from '../types';
import { RESOURCE_TYPES, BUILD_COSTS, CK_COSTS, VP_TABLE } from '../constants';
import { calcVP, calcPublicVP, victoryTarget } from '../engine/scoring';
import { LONGEST_ROAD_MIN, LARGEST_ARMY_MIN } from '../constants';
import { hasEnoughResources, playerHasMovableShip } from '../engine/actions';
import { canBankTrade, getEffectiveTradeRate, isCommodity } from '../engine/trade';
import { findPendingDiscarder, discardCount, robbableCardCount } from '../engine/robber';
import {
  isCk, canBuildImprovement, canBuildKnight, canActivateKnight, canUpgradeKnight, canBuildCityWall, canPlayProgressLoose,
  playerHasMovableKnight, playerHasChasableKnight, robberAdjacentChasableVertexIds, inventorTiles, progressDiscardCandidates, craneEligibleTracks,
} from '../engine/citiesKnights';
import { CK_TRACK_NAME, CK_TRACK_COMMODITY, CK_BARBARIAN_MAX, COMMODITY_TYPES, improvementCost, PROGRESS_CARD_NAME, PROGRESS_CARD_DESC, PROGRESS_DECK_CARDS, TILE_RESOURCE_MAP } from '../constants';
import type { CkTrack, CommodityType, CommodityHand, TradeKind, ProgressCard, ProgressChoice } from '../types';
import type { BuildMode } from './events';

// 画像参照は中央マニフェスト経由（単一の真実）。
import { ASSETS, assetImg, houseImg, cityImg, metropolisImg, type ColorKey } from '../assets/manifest';

const knightImg = ASSETS.knight.basic;
// 騎士と商人: 商品アイコン画像（手札チップ等）。テキスト埋め込み箇所は絵文字のまま。
const COMMODITY_IMG: Record<CommodityType, string> = ASSETS.commodity;
// 騎士と商人: 都市改善トラックのアイコン画像。
const IMP_IMG: Record<CkTrack, string> = ASSETS.trackIcon;
// 各トラックの段階で得られる恩恵（Lv3=特殊建築の効果 / Lv4=メトロポリス / Lv5=最大）。
// 「Lv3で何が起きるか」を建設ボタンに表示するために使う（エンジンの実装と一致）。
const CK_TRACK_BENEFIT: Record<CkTrack, Record<number, string>> = {
  trade:    { 3: '商品を銀行と2:1で交易', 4: 'メトロポリス（+2点）', 5: '他のメトロポリスを奪取可' },
  politics: { 3: '騎士を最強(Lv3)に昇格可', 4: 'メトロポリス（+2点）', 5: '他のメトロポリスを奪取可' },
  science:  { 3: '無産出のターンに資源1枚', 4: 'メトロポリス（+2点）', 5: '他のメトロポリスを奪取可' },
};
// 商品アイコンの <img>。
function commIconImg(c: CommodityType, cls: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls; img.src = COMMODITY_IMG[c]; img.alt = c; img.draggable = false;
  return img;
}
// 小さなインラインアイコン画像（テキスト/ラベル/ログ等に混ぜる）。欠損(null)はプレースホルダへ。
function inlineIc(src: string | null | undefined, cls = 'inline-ic'): HTMLImageElement {
  return assetImg(src ?? null, cls, '', '');
}
// 資源/商品の「アイコン画像＋テキスト」を span へ詰める（交易・捨て札UI等で絵文字を画像へ置換）。
function setIconText(target: HTMLElement, imgSrc: string, text: string): void {
  target.textContent = '';
  target.append(inlineIc(imgSrc, 'inline-ic'), document.createTextNode(text));
}
// 「選択中：◯ ・ ◯ ・ ？」を絵文字でなく素材画像で描く（金タイル/年の豊穣の選択状況）。
function appendChosenIcons(target: HTMLElement, slots: (ResourceType | null)[]): void {
  target.textContent = '選択中：';
  slots.forEach((s, i) => {
    if (i > 0) target.append(' ・ ');
    target.append(s ? inlineIc(RESOURCE_IMG[s], 'inline-ic') : document.createTextNode('？'));
  });
}
// CSSグリフ（道など素材画像が無いもの）。glyphCls 自身が em ベースの形状/サイズを持つ。
function glyph(glyphCls: string, extra = ''): HTMLSpanElement {
  return el('span', `stat-glyph ${glyphCls}${extra ? ' ' + extra : ''}`);
}
// アイコン（画像URL or 要素＝CSSグリフ）＋ラベルのボタン。label に文字列 or ノード配列。
function makeImgBtn(icon: string | HTMLElement, label: string | (string | HTMLElement)[], cls: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const btn = el('button', `action-btn has-icon ${cls}`);
  let iconEl: HTMLElement;
  if (typeof icon === 'string') { const im = document.createElement('img'); im.className = 'btn-icon-img'; im.src = icon; im.alt = ''; im.draggable = false; iconEl = im; }
  else { icon.classList.add('btn-icon-img'); iconEl = icon; }
  const span = el('span', 'btn-icon-label');
  if (typeof label === 'string') span.textContent = label;
  else for (const part of label) span.append(typeof part === 'string' ? document.createTextNode(part) : part);
  btn.appendChild(iconEl); btn.appendChild(span);
  btn.disabled = disabled;
  if (!disabled) btn.addEventListener('click', onClick);
  return btn;
}
// ログ中の絵文字（資源/商品/コマ/称号…）を素材アイコン/CSSグリフに置換する。
// RESOURCE_IMG 等は後方定義のため、参照は呼び出し時(実行時)に解決する（遅延構築）。
let _logEmojiMap: Record<string, string | (() => HTMLElement)> | null = null;
function logEmojiMap(): Record<string, string | (() => HTMLElement)> {
  if (_logEmojiMap) return _logEmojiMap;
  _logEmojiMap = {
    // 資源
    '🌲': RESOURCE_IMG.wood, '🧱': RESOURCE_IMG.brick, '🐑': RESOURCE_IMG.wool, '🌾': RESOURCE_IMG.grain, '⛰': RESOURCE_IMG.ore,
    // 商品
    '🪙': COMMODITY_IMG.coin, '🧵': COMMODITY_IMG.cloth, '📜': COMMODITY_IMG.paper,
    // コマ/建物/称号
    '🏠': ASSETS.piece.settlement ?? '', '🏙': ASSETS.piece.city ?? '',
    '🦹': ASSETS.piece.robber ?? '', '🏴‍☠️': ASSETS.piece.pirate ?? '',
    '⛵': ASSETS.piece.barbarianShip ?? '', '🛶': ASSETS.piece.barbarianShip ?? '',
    '💱': ASSETS.commodity.coin, '⚔': ASSETS.knight.basic, '🛡': ASSETS.knight.basic,
    '🛤': ASSETS.action.road, '🃏': () => glyph('ic-cards'),
  };
  return _logEmojiMap;
}
const LOG_EMOJI_DROP = ['📥', '✨']; // 画像の無い装飾的な先頭マークは省く
// メッセージを走査し、既知の絵文字を素材画像へ、装飾は省略、残りはテキストとして parent へ。
function renderLogMessage(parent: HTMLElement, message: string): void {
  const map = logEmojiMap();
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  let i = 0, buf = '';
  const flush = (): void => { if (buf) { parent.append(document.createTextNode(buf)); buf = ''; } };
  while (i < message.length) {
    const drop = LOG_EMOJI_DROP.find(d => message.startsWith(d, i));
    if (drop) { flush(); i += drop.length; continue; }
    const k = keys.find(key => message.startsWith(key, i));
    if (k) {
      flush();
      const src = map[k]!;
      const icon = typeof src === 'function' ? src() : inlineIc(src, 'log-ic');
      icon.classList.add('log-icon');
      parent.append(icon);
      i += k.length;
      continue;
    }
    buf += message[i]; i++;
  }
  flush();
}
// modeBtn のアイコン版（道/開拓地/都市などの建設トグル）。
function modeImgBtn(icon: string | HTMLElement, label: string | (string | HTMLElement)[], mode: Exclude<BuildMode, 'idle'>, canAfford: boolean, current: BuildMode, setBuildMode: (m: BuildMode) => void): HTMLButtonElement {
  const isActive = current === mode;
  const disabled = !canAfford && !isActive;
  const cls = isActive ? 'btn-active' : canAfford ? 'btn-build' : 'btn-disabled';
  return makeImgBtn(icon, label, cls, disabled, () => setBuildMode(isActive ? 'idle' : mode));
}

// 建設コストの素材アイコン列。各ボタンに「何の素材で作れるか」を常時表示して覚えなくて済むように。
function costIcons(parts: Array<[string, number]>): HTMLElement {
  const row = el('span', 'btn-cost');
  for (const [img, n] of parts) {
    if (n <= 0) continue;
    row.append(inlineIc(img, 'cost-ic'));
    if (n > 1) row.append(Object.assign(el('span', 'cost-n'), { textContent: `×${n}` }));
  }
  return row;
}
function resCostParts(cost: Partial<ResourceHand>): Array<[string, number]> {
  return RESOURCE_TYPES.filter(r => (cost[r] ?? 0) > 0).map(r => [RESOURCE_IMG[r], cost[r]!] as [string, number]);
}
// 名前（1行目）＋コストアイコン（2行目）を縦に積んだボタンラベル。
function costLabel(name: string, parts: Array<[string, number]>): HTMLElement {
  const wrap = el('span', 'btn-stacked');
  wrap.append(Object.assign(el('span', 'btn-name'), { textContent: name }), costIcons(parts));
  return wrap;
}

// ============================================================
// 型定義（main.ts・events.ts 共有）
// ============================================================

export type UIPhase =
  | { type: 'idle' }
  | { type: 'discard'; playerId: PlayerId; selected: ResourceHand; selectedCommodities?: Partial<CommodityHand> }
  | { type: 'bankTrade'; give: TradeKind | null; receive: TradeKind | null }
  | { type: 'yearOfPlenty'; slots: (ResourceType | null)[] }
  | { type: 'goldChoice'; playerId: PlayerId; slots: (ResourceType | null)[] }
  | { type: 'monopoly'; resource: ResourceType | null }
  | { type: 'robberTarget'; tileId: string; opponents: PlayerId[]; kind?: 'robber' | 'pirate' }
  | { type: 'placePreview'; kind: 'settlement' | 'city' | 'road' | 'ship' | 'activateKnight' | 'upgradeKnight' | 'placeMerchant'; targetId: string }
  | { type: 'playerTradeOffer'; give: ResourceHand; receive: ResourceHand; targetPids: PlayerId[] };

// ============================================================
// 定数
// ============================================================

const PLAYER_COLORS: Record<string, string> = {
  player1: '#e03030',
  player2: '#3060e0',
  player3: '#a855f7',
  player4: '#f0a020',
};
// プレイヤーID→コマ画像の色キー（開拓地/都市の色つき画像用）。
const PLAYER_COLOR_KEY: Record<string, ColorKey> = {
  player1: 'red', player2: 'blue', player3: 'purple', player4: 'orange',
};
// パネルの統計チップ: 小アイコン画像（任意）＋数値。絵文字を素材/CSSアイコンに置換するための共通部品。
function statChip(iconUrl: string | null, n: number | string, extra = '', glyphCls = ''): HTMLElement {
  const c = el('span', `stat-count${extra ? ' ' + extra : ''}`);
  if (iconUrl) {
    const im = document.createElement('img');
    im.className = 'stat-ic'; im.src = iconUrl; im.alt = ''; im.draggable = false;
    c.appendChild(im);
  } else if (glyphCls) {
    c.appendChild(el('span', `stat-glyph ${glyphCls}`));
  }
  const t = el('span', 'stat-n'); t.textContent = String(n);
  c.appendChild(t);
  return c;
}

// この幅以上でプレイヤーパネルを盤面の四隅に配置する（未満は盤面下に縦並び）
const CORNER_LAYOUT_MIN_WIDTH = 1200;

// 横持ちスマホ（横長かつ低い高さ）か。表示テキストを短縮するために使う。
function isLandscapeCompact(): boolean {
  return window.innerWidth > window.innerHeight && window.innerHeight <= 600;
}

// 資源アイコン画像（手札カード・交易チップ用）。テキスト埋め込み箇所は絵文字のまま。
const RESOURCE_IMG: Record<ResourceType, string> = {
  wood: ASSETS.resource.lumber, brick: ASSETS.resource.brick, wool: ASSETS.resource.wool, grain: ASSETS.resource.grain, ore: ASSETS.resource.ore,
};

// 資源アイコンの <img> 要素を生成。
function resIconImg(r: ResourceType, cls: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.src = RESOURCE_IMG[r];
  img.alt = RESOURCE_NAMES[r];
  img.draggable = false;
  return img;
}

const RESOURCE_NAMES: Record<ResourceType, string> = {
  wood: '木材', brick: 'レンガ', wool: '羊毛', grain: '麦', ore: '鉄鉱',
};
const COMMODITY_NAMES: Record<CommodityType, string> = { coin: '金貨', cloth: '布', paper: '紙' };

const DEV_CARD_NAMES: Record<string, string> = {
  knight:          '⚔ 騎士',
  road_building:   '🛤 道路建設',
  year_of_plenty:  '🌾 年の豊穣',
  monopoly:        '🏛 独占',
};

// F-06: カードパネル用コンパクト名
const DEV_CARD_CHIP_NAMES: Record<string, string> = {
  knight:          '⚔騎士',
  road_building:   '🛤道路建設',
  year_of_plenty:  '🌾年の豊穣',
  monopoly:        '🏛独占',
  victory_point:   '★',
};

// ============================================================
// フェーズ説明テキスト
// ============================================================

function phaseText(state: GameState): string {
  if (state.phase === 'GAME_OVER') {
    const w = state.players[state.winner ?? ''];
    return w ? `🎉 ゲーム終了！${w.name} の勝利！` : 'ゲーム終了！';
  }

  // 現在手番のプレイヤーが CPU かどうかで文言を切り替える
  // （CPU手番中は人間向けの「クリックしてください」を出さない）
  const currentPid = state.playerOrder[state.currentPlayerIndex] ?? '';
  const current = state.players[currentPid];
  const isCpuTurn = current?.type === 'ai';

  // CPU手番では誰の番かはバナー/手番順バーに既出のため、フェーズ説明では名前を繰り返さず
  // 「何をしているか」だけを出す（縦持ちで固定情報が嵩むのを避ける）。
  if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
    const half = state.phase === 'SETUP_FORWARD' ? '前半' : '後半';
    if (isCpuTurn) return `セットアップ${half}：配置中…`;
    return state.setupSubPhase === 'PLACE_SETTLEMENT'
      ? `セットアップ${half}：開拓地を置く`
      : `セットアップ${half}：道を置く`;
  }

  switch (state.turnPhase) {
    case 'PRE_ROLL':
      return isCpuTurn ? '手番中…' : 'ダイスを振る';
    case 'ROBBER':
      return isCpuTurn ? '盗賊を移動中…' : '盗賊を動かすタイルをクリック';
    case 'DISCARD': {
      // 捨て札は手番者とは限らない（手札8枚以上の全員が対象）ので、対象者名は出す。
      const discardPid = findPendingDiscarder(state);
      const dp = discardPid ? state.players[discardPid] : null;
      if (dp?.type === 'ai') return `${dp.name} が手札を捨てています…`;
      return '半数を捨ててください';
    }
    case 'TRADE_BUILD':
      return isCpuTurn ? '交易・建設中…' : '交易・建設';
    case 'END':
      return 'ターン終了処理中';
    default:
      return '';
  }
}

// ============================================================
// DOM ヘルパー
// ============================================================

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function makeBtn(
  label: string,
  cls: string,
  disabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const btn = el('button', `action-btn ${cls}`);
  btn.textContent = label;
  btn.disabled = disabled;
  if (!disabled) btn.addEventListener('click', onClick);
  return btn;
}

function modeBtn(
  label: string,
  mode: Exclude<BuildMode, 'idle'>,
  canAfford: boolean,
  current: BuildMode,
  setBuildMode: (m: BuildMode) => void,
): HTMLButtonElement {
  const isActive = current === mode;
  const disabled = !canAfford && !isActive;
  const cls = isActive ? 'btn-active' : canAfford ? 'btn-build' : 'btn-disabled';
  return makeBtn(label, cls, disabled, () => setBuildMode(isActive ? 'idle' : mode));
}

// ============================================================
// 発展カード：使用可能カード一覧
// ============================================================

function getPlayableDevCards(
  player: Player,
  globalTurn: number,
): { type: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const card of player.devCards) {
    if (card.type === 'victory_point') continue;
    if (card.purchasedOnTurn >= globalTurn) continue;
    counts[card.type] = (counts[card.type] ?? 0) + 1;
  }
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

// ============================================================
// DISCARD UI（手札捨て）
// ============================================================

function buildDiscardUI(
  state: GameState,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');

  const discardPid = findPendingDiscarder(state);
  if (!discardPid) return div;

  const player = state.players[discardPid]!;
  const ck = state.expansion === 'cities_knights' && !!player.commodities;
  const target = discardCount(state, discardPid);

  const selected: ResourceHand =
    uiPhase.type === 'discard' && uiPhase.playerId === discardPid
      ? uiPhase.selected
      : { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  const selectedComm: Partial<CommodityHand> =
    (uiPhase.type === 'discard' && uiPhase.playerId === discardPid && uiPhase.selectedCommodities) || {};

  const chosenRes = RESOURCE_TYPES.reduce((s, r) => s + selected[r], 0);
  const chosenComm = COMMODITY_TYPES.reduce((s, c) => s + (selectedComm[c] ?? 0), 0);
  const chosen = chosenRes + chosenComm;

  const color = PLAYER_COLORS[discardPid] ?? '#aaa';
  const header = el('div', 'modal-header');
  const dot = el('span', 'color-dot');
  dot.style.background = color;
  header.appendChild(dot);
  const remaining = Math.max(0, target - chosen);
  header.append(` ${player.name}：${target}枚を捨てる（あと ${remaining}枚 ・ ${chosen}/${target}）`);
  div.appendChild(header);

  // 騎士と商人では資源と商品の両方が捨て対象なので、見出しと背景色で区別する。
  if (ck) div.appendChild(Object.assign(el('div', 'modal-section-label'), { textContent: '捨てる資源：' }));
  const resRow = el('div', 'modal-res-row');
  resRow.setAttribute('data-kind', 'resource');
  for (const r of RESOURCE_TYPES) {
    if (player.hand[r] === 0) continue;

    const cell = el('div', 'modal-res-cell');
    const minus = makeBtn('−', 'btn-small', selected[r] <= 0, () => {
      setUIPhase({ type: 'discard', playerId: discardPid, selected: { ...selected, [r]: selected[r] - 1 }, selectedCommodities: selectedComm });
    });
    const info = el('span', 'modal-res-info');
    setIconText(info, RESOURCE_IMG[r], ` ${player.hand[r]}枚 → 捨:${selected[r]}`);
    const plus = makeBtn('+', 'btn-small', selected[r] >= player.hand[r] || chosen >= target, () => {
      setUIPhase({ type: 'discard', playerId: discardPid, selected: { ...selected, [r]: selected[r] + 1 }, selectedCommodities: selectedComm });
    });

    cell.appendChild(minus);
    cell.appendChild(info);
    cell.appendChild(plus);
    resRow.appendChild(cell);
  }
  div.appendChild(resRow);

  // 騎士と商人: 商品も捨て対象。
  if (ck) {
    div.appendChild(Object.assign(el('div', 'modal-section-label'), { textContent: '捨てる商品：' }));
    const comm = player.commodities!;
    const commRow = el('div', 'modal-res-row');
    commRow.setAttribute('data-kind', 'commodity');
    for (const c of COMMODITY_TYPES) {
      if (comm[c] === 0) continue;
      const cur = selectedComm[c] ?? 0;
      const cell = el('div', 'modal-res-cell');
      const minus = makeBtn('−', 'btn-small', cur <= 0, () => {
        setUIPhase({ type: 'discard', playerId: discardPid, selected, selectedCommodities: { ...selectedComm, [c]: cur - 1 } });
      });
      const info = el('span', 'modal-res-info');
      setIconText(info, COMMODITY_IMG[c], ` ${comm[c]}枚 → 捨:${cur}`);
      const plus = makeBtn('+', 'btn-small', cur >= comm[c] || chosen >= target, () => {
        setUIPhase({ type: 'discard', playerId: discardPid, selected, selectedCommodities: { ...selectedComm, [c]: cur + 1 } });
      });
      cell.appendChild(minus);
      cell.appendChild(info);
      cell.appendChild(plus);
      commRow.appendChild(cell);
    }
    div.appendChild(commRow);
  }

  div.appendChild(makeBtn(
    `✓ 捨てる（${chosen}/${target}枚）`,
    chosen === target ? 'btn-primary' : 'btn-disabled',
    chosen !== target,
    () => dispatch({ type: 'DISCARD_RESOURCES', playerId: discardPid, resources: selected, commodities: selectedComm }),
  ));

  return div;
}

// ============================================================
// Robber Target Selection UI（複数ターゲット選択）
// ============================================================

function buildRobberTargetUI(
  state: GameState,
  uiPhase: UIPhase,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');
  if (uiPhase.type !== 'robberTarget') return div;
  const isPirate = uiPhase.kind === 'pirate';
  const header = el('div', 'modal-header');
  header.append(inlineIc(isPirate ? ASSETS.piece.pirate : ASSETS.piece.robber, 'inline-ic'),
    document.createTextNode(isPirate ? ' 海賊：奪う相手を選んでください' : ' 強盗：盗む相手を選んでください'));
  div.appendChild(header);

  const row = el('div', 'modal-res-row');
  for (const opponentPid of uiPhase.opponents) {
    const opponent = state.players[opponentPid];
    if (!opponent) continue;
    const color = PLAYER_COLORS[opponentPid] ?? '#aaa';
    // 他プレイヤーの手札はLANではマスクされ枚数のみ開示される。騎士と商人では
    // 商品も奪取対象なので合算した「奪える枚数」を表示する（エンジン判定と一致）。
    const totalCards = robbableCardCount(state, opponentPid);
    const btn = makeBtn(
      `${opponent.name}（手札${totalCards}枚）`,
      'btn-build',
      false,
      () => dispatch(isPirate
        ? { type: 'MOVE_PIRATE', tileId: uiPhase.tileId, stealFromPlayerId: opponentPid }
        : { type: 'MOVE_ROBBER', tileId: uiPhase.tileId, stealFromPlayerId: opponentPid }),
    );
    btn.style.borderLeft = `4px solid ${color}`;
    row.appendChild(btn);
  }
  div.appendChild(row);

  return div;
}

// ============================================================
// Bank Trade UI（バンク交易）
// ============================================================

function buildBankTradeUI(
  state: GameState,
  pid: PlayerId,
  player: Player,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');

  const give    = uiPhase.type === 'bankTrade' ? uiPhase.give : null;
  const receive = uiPhase.type === 'bankTrade' ? uiPhase.receive : null;
  const ck = isCk(state);
  const heldOf = (k: TradeKind): number => isCommodity(k) ? (player.commodities ?? { coin: 0, cloth: 0, paper: 0 })[k] : player.hand[k as ResourceType];
  const bankOf = (k: TradeKind): number => isCommodity(k) ? (state.commodityBank ?? { coin: 0, cloth: 0, paper: 0 })[k] : state.bank[k as ResourceType];

  const header = el('div', 'modal-header');
  header.append(inlineIc(ASSETS.action.bankTrade, 'inline-ic'), document.createTextNode(' バンク交易'));
  div.appendChild(header);

  const kindIcon = (k: TradeKind): string => isCommodity(k) ? COMMODITY_IMG[k] : RESOURCE_IMG[k as ResourceType];
  const kindName = (k: TradeKind): string => isCommodity(k) ? COMMODITY_NAMES[k] : RESOURCE_NAMES[k as ResourceType];
  // 渡す/受け取るの1ボタンを生成（give=渡す, receive=受け取る）。アイコンは絵文字でなく素材画像。
  const kindButton = (k: TradeKind, isReceive: boolean): HTMLButtonElement => {
    if (!isReceive) {
      const rate = getEffectiveTradeRate(state, pid, k);
      const canAfford = heldOf(k) >= rate;
      return makeImgBtn(kindIcon(k), `${kindName(k)} ×${heldOf(k)}（${rate}:1）`, give === k ? 'btn-active' : canAfford ? 'btn-build' : 'btn-disabled', !canAfford,
        () => setUIPhase({ type: 'bankTrade', give: give === k ? null : k, receive }));
    }
    const inBank = bankOf(k) > 0;
    return makeImgBtn(kindIcon(k), kindName(k), receive === k ? 'btn-active' : inBank ? 'btn-build' : 'btn-disabled', !inBank,
      () => setUIPhase({ type: 'bankTrade', give, receive: receive === k ? null : k }));
  };
  // 資源・商品を別々の見出し＋行（背景色で区別）で描画する。
  const appendKindSection = (isReceive: boolean): void => {
    const verb = isReceive ? '受け取る' : '渡す';
    div.appendChild(Object.assign(el('div', 'modal-section-label'), { textContent: `${verb}資源：` }));
    const resRow = el('div', 'modal-res-row'); resRow.setAttribute('data-kind', 'resource');
    for (const k of RESOURCE_TYPES) { if (isReceive && k === give) continue; resRow.appendChild(kindButton(k, isReceive)); }
    div.appendChild(resRow);
    if (ck) {
      div.appendChild(Object.assign(el('div', 'modal-section-label'), { textContent: `${verb}商品：` }));
      const comRow = el('div', 'modal-res-row'); comRow.setAttribute('data-kind', 'commodity');
      for (const k of COMMODITY_TYPES) { if (isReceive && k === give) continue; comRow.appendChild(kindButton(k, isReceive)); }
      div.appendChild(comRow);
    }
  };

  appendKindSection(false);

  if (give !== null) {
    appendKindSection(true);

    if (receive !== null) {
      const rate = getEffectiveTradeRate(state, pid, give);
      const valid = canBankTrade(state, pid, give, receive);
      // 実行ボタンのアイコンも絵文字でなく素材画像にする。
      const execBtn = el('button', `action-btn ${valid ? 'btn-primary' : 'btn-disabled'}`);
      execBtn.disabled = !valid;
      execBtn.append('✓ ', `${rate}枚の`, inlineIc(kindIcon(give), 'inline-ic'), ' → 1枚の', inlineIc(kindIcon(receive), 'inline-ic'));
      if (valid) execBtn.addEventListener('click', () => dispatch({ type: 'BANK_TRADE', give, receive }));
      div.appendChild(execBtn);
    }
  }

  div.appendChild(makeBtn('✕ キャンセル', 'btn-end', false, () => setUIPhase({ type: 'idle' })));
  return div;
}

// ============================================================
// 騎士と商人: 蛮族敗北での都市格下げ選択
// ============================================================
// （蛮族敗北の都市格下げは盤面の都市タップで選ぶ方式に変更。専用モーダルは廃止。）

// 騎士と商人: 進歩カード上限超過（5枚目を引いた）→ 捨てる1枚を選ぶモーダル。
// 勝利点カード(憲法/印刷機)は上限対象外なので候補に出さない。
function buildProgressDiscardUI(state: GameState, pid: PlayerId, dispatch: (a: Action) => void): HTMLDivElement {
  const div = el('div', 'modal-panel');
  const header = el('div', 'modal-header');
  header.append(glyph('ic-cards'), document.createTextNode(' 進歩カードが5枚：捨てる1枚を選ぶ'));
  div.appendChild(header);
  div.appendChild(Object.assign(el('div', 'modal-section-label'),
    { textContent: 'カードをタップして効果を確認し、捨てるか決めてください（手札上限4枚）' }));
  const candidates = new Set(progressDiscardCandidates(state, pid));
  const row = el('div', 'ck-pc-row');
  for (const c of state.players[pid]?.progressCards ?? []) {
    if (!candidates.has(c.id)) continue; // VPカードは捨てられない
    const icon = ASSETS.progressCard[c.type] ?? ASSETS.cardBack[c.deck];
    // タップで即捨てず、効果確認画面（捨てる/やめる）を開く（誤って捨てるのを防ぐ）。
    const btn = makeImgBtn(icon, PROGRESS_CARD_NAME[c.type], 'btn-build', false,
      () => showProgressCardInfo(c, false, dispatch, state, pid, 'discard'));
    btn.title = PROGRESS_CARD_DESC[c.type];
    row.appendChild(btn);
  }
  div.appendChild(row);
  return div;
}

// ============================================================
// 金タイル産出の任意資源選択（航海者）
// ============================================================
// owed 枚をバンクから選ぶ。ルール上「選ばない」は不可（必須）なのでキャンセルは無し。
export function buildGoldChoiceUI(
  state: GameState,
  gpid: PlayerId,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');
  const owed = (state.pendingGoldChoice ?? {})[gpid] ?? 0;
  const slots: (ResourceType | null)[] =
    uiPhase.type === 'goldChoice' && uiPhase.playerId === gpid && uiPhase.slots.length === owed
      ? uiPhase.slots
      : Array.from({ length: owed }, () => null);

  const header = el('div', 'modal-header');
  header.textContent = `✨ 金タイル：資源${owed}枚を選んで受け取る`;
  div.appendChild(header);

  const status = el('div', 'modal-section-label');
  appendChosenIcons(status, slots);
  div.appendChild(status);

  const resRow = el('div', 'modal-res-row');
  for (const r of RESOURCE_TYPES) {
    const chosen = slots.filter(s => s === r).length;
    // バンク在庫を超えて同一資源は選べない（金もバンクからの受け取り）。
    const canAdd = chosen < state.bank[r] && slots.some(s => s === null);
    const btn = makeImgBtn(
      RESOURCE_IMG[r],
      `${RESOURCE_NAMES[r]}${chosen > 0 ? ` ×${chosen}` : ''}`,
      chosen > 0 ? 'btn-active' : canAdd ? 'btn-build' : 'btn-disabled',
      !canAdd,
      () => {
        const next = [...slots] as (ResourceType | null)[];
        const empty = next.findIndex(s => s === null);
        if (empty !== -1) next[empty] = r;
        setUIPhase({ type: 'goldChoice', playerId: gpid, slots: next });
      },
    );
    resRow.appendChild(btn);
  }
  div.appendChild(resRow);

  // 選び直し（全クリア）。誤タップのリカバリ用。「選ばない」はルール上不可。
  div.appendChild(makeBtn('↺ 選び直す', 'btn-end', owed === 0, () =>
    setUIPhase({ type: 'goldChoice', playerId: gpid, slots: Array.from({ length: owed }, () => null) })));

  const allFilled = slots.length > 0 && slots.every(s => s !== null);
  div.appendChild(makeBtn(
    '✓ 受け取る',
    allFilled ? 'btn-primary' : 'btn-disabled',
    !allFilled,
    () => {
      const resources: Partial<ResourceHand> = {};
      for (const s of slots) if (s) resources[s] = (resources[s] ?? 0) + 1;
      dispatch({ type: 'CHOOSE_GOLD', playerId: gpid, resources });
    },
  ));
  return div;
}

// ============================================================
// Year of Plenty UI（年の豊穣）
// ============================================================

function buildYearOfPlentyUI(
  state: GameState,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');

  const slots: (ResourceType | null)[] =
    uiPhase.type === 'yearOfPlenty' ? uiPhase.slots : [null, null];

  const header = el('div', 'modal-header');
  header.append(inlineIc(RESOURCE_IMG.grain, 'inline-ic'), document.createTextNode(' 年の豊穣：資源2枚を受け取る'));
  div.appendChild(header);

  const status = el('div', 'modal-section-label');
  appendChosenIcons(status, slots);
  div.appendChild(status);

  const resRow = el('div', 'modal-res-row');
  for (const r of RESOURCE_TYPES) {
    const inBank = state.bank[r] > 0;
    const count = slots.filter(s => s === r).length;
    const btn = makeImgBtn(
      RESOURCE_IMG[r],
      `${RESOURCE_NAMES[r]}${count > 0 ? ` ×${count}` : ''}`,
      count > 0 ? 'btn-active' : inBank ? 'btn-build' : 'btn-disabled',
      !inBank,
      () => {
        const next = [...slots] as (ResourceType | null)[];
        const empty = next.findIndex(s => s === null);
        if (empty !== -1) {
          next[empty] = r;
        } else {
          // 両スロット埋まっている場合：1つシフトして追加
          next[0] = next[1] ?? null;
          next[1] = r;
        }
        setUIPhase({ type: 'yearOfPlenty', slots: next });
      },
    );
    resRow.appendChild(btn);
  }
  div.appendChild(resRow);

  const bothFilled = slots[0] !== null && slots[1] !== null;
  div.appendChild(makeBtn(
    '✓ 受け取る',
    bothFilled ? 'btn-primary' : 'btn-disabled',
    !bothFilled,
    () => {
      if (slots[0] && slots[1]) dispatch({ type: 'PLAY_YEAR_OF_PLENTY', resources: [slots[0], slots[1]] });
    },
  ));
  div.appendChild(makeBtn('✕ キャンセル', 'btn-end', false, () => setUIPhase({ type: 'idle' })));
  return div;
}

// ============================================================
// Monopoly UI（独占）
// ============================================================

function buildMonopolyUI(
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');

  const resource = uiPhase.type === 'monopoly' ? uiPhase.resource : null;

  const header = el('div', 'modal-header');
  header.textContent = '🏛 独占：資源1種を宣言';
  div.appendChild(header);

  const resRow = el('div', 'modal-res-row');
  for (const r of RESOURCE_TYPES) {
    const btn = makeImgBtn(
      RESOURCE_IMG[r],
      RESOURCE_NAMES[r],
      resource === r ? 'btn-active' : 'btn-build',
      false,
      () => setUIPhase({ type: 'monopoly', resource: r }),
    );
    resRow.appendChild(btn);
  }
  div.appendChild(resRow);

  div.appendChild(makeBtn(
    '✓ 独占実行',
    resource !== null ? 'btn-primary' : 'btn-disabled',
    resource === null,
    () => { if (resource) dispatch({ type: 'PLAY_MONOPOLY', resource }); },
  ));
  div.appendChild(makeBtn('✕ キャンセル', 'btn-end', false, () => setUIPhase({ type: 'idle' })));
  return div;
}

// ============================================================
// ============================================================
// F-07: VP 内訳ヘルパー
// ============================================================

interface VPBreakdown {
  settlements: number;
  cities: number;
  lr: boolean;
  la: boolean;
  vpCards: number;
  islandBonus: number; // 航海者: 獲得した新島入植ボーナスの件数（各 +2VP）
  tokenVp: number;     // 航海者 S5: 海辺VPトークン数（各 +1VP）
  cloth: number;       // 航海者 S6: 織物トークン数（2枚で +1VP）
  wonderLevel: number; // 航海者 S8: 不思議の建設レベル（0..4・勝利進捗）
}

function calcVPBreakdown(state: GameState, pid: PlayerId): VPBreakdown {
  const player = state.players[pid];
  let settlements = 0, cities = 0;
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    if (v.building.type === 'settlement') settlements++;
    else cities++;
  }
  return {
    settlements,
    cities,
    lr: player?.hasLongestRoad ?? false,
    la: player?.hasLargestArmy ?? false,
    vpCards: player?.devCards.filter(c => c.type === 'victory_point').length ?? 0,
    islandBonus: Object.values(state.islandBonus ?? {}).flat().filter(o => o === pid).length,
    tokenVp: (state.tokenVp ?? {})[pid] ?? 0,
    cloth: (state.cloth ?? {})[pid] ?? 0,
    wonderLevel: (state.wonderLevel ?? {})[pid] ?? 0,
  };
}

// ============================================================
// F-05: プレイヤー間交易ヘルパー
// ============================================================

function makeZeroHand(): ResourceHand {
  return { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
}

// 資源を見やすいチップ列で表示（交易UIの「一目で分かる」用）
function resChips(partial: Partial<ResourceHand>): HTMLDivElement {
  const wrap = el('div', 'res-chips');
  let any = false;
  for (const r of RESOURCE_TYPES) {
    const n = partial[r] ?? 0;
    if (n <= 0) continue;
    any = true;
    const chip = el('span', `res-chip res-chip-${r}`);
    const icon = resIconImg(r, 'res-chip-img');
    const ct = el('span', 'res-chip-count'); ct.textContent = `×${n}`;
    chip.append(icon, ct);
    wrap.appendChild(chip);
  }
  if (!any) { const none = el('span', 'res-chip res-chip-none'); none.textContent = '—'; wrap.appendChild(none); }
  return wrap;
}

// 「提案者が渡す → 提案者が欲しい」を視覚的に表示する交換ビュー
function buildExchangeView(give: Partial<ResourceHand>, receive: Partial<ResourceHand>, initiatorName: string, initiatorColor: string): HTMLDivElement {
  const box = el('div', 'trade-exchange');
  const row1 = el('div', 'trade-ex-row');
  const lbl1 = el('span', 'trade-ex-label');
  const dot = el('span', 'color-dot'); dot.style.background = initiatorColor;
  lbl1.append(dot, document.createTextNode(`${initiatorName} が渡す`));
  row1.append(lbl1, resChips(give));
  const arrow = el('div', 'trade-ex-arrow'); arrow.textContent = '⇅';
  const row2 = el('div', 'trade-ex-row');
  const lbl2 = el('span', 'trade-ex-label'); lbl2.textContent = `${initiatorName} が欲しい`;
  row2.append(lbl2, resChips(receive));
  box.append(row1, arrow, row2);
  return box;
}

// ============================================================
// F-05: 交易オファー作成UI
// ============================================================

function buildPlayerTradeOfferUI(
  player: Player,
  pid: PlayerId,
  state: GameState,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');

  const give       = uiPhase.type === 'playerTradeOffer' ? uiPhase.give       : makeZeroHand();
  const receive    = uiPhase.type === 'playerTradeOffer' ? uiPhase.receive    : makeZeroHand();
  const opponents  = state.playerOrder.filter(p => p !== pid) as PlayerId[];
  const targetPids = uiPhase.type === 'playerTradeOffer'
    ? uiPhase.targetPids
    : opponents; // デフォルト全員

  const lc = isLandscapeCompact(); // 横持ちは短ラベルで圧縮
  const header = el('div', 'modal-header');
  header.append(inlineIc(ASSETS.action.playerTrade, 'inline-ic'),
    document.createTextNode(lc ? ' 交易を提案' : ' プレイヤー間交易：オファー作成'));
  div.appendChild(header);

  // ---- 現在の交換内容サマリ（一目で分かるように）----
  const summary = el('div', 'trade-you-view');
  summary.append('あなたが渡す ');
  summary.appendChild(resChips(give));
  summary.append(' → もらう ');
  summary.appendChild(resChips(receive));
  div.appendChild(summary);

  // ---- 交易相手選択 ----
  const targetLabel = el('div', 'modal-section-label');
  targetLabel.textContent = lc ? '相手' : '交易相手：';
  div.appendChild(targetLabel);
  const targetRow = el('div', 'trade-target-row');
  for (const opp of opponents) {
    const oppPlayer = state.players[opp];
    if (!oppPlayer) continue;
    const btn = el('button', `trade-target-btn${targetPids.includes(opp) ? ' selected' : ''}`);
    btn.textContent = oppPlayer.name;
    btn.addEventListener('click', () => {
      const next = targetPids.includes(opp)
        ? targetPids.filter(p => p !== opp)
        : [...targetPids, opp];
      setUIPhase({ type: 'playerTradeOffer', give, receive, targetPids: next });
    });
    targetRow.appendChild(btn);
  }
  div.appendChild(targetRow);

  // 渡す資源
  const giveLabel = el('div', 'modal-section-label');
  giveLabel.textContent = lc ? '出す' : '渡す資源：';
  div.appendChild(giveLabel);

  const giveRow = el('div', 'modal-res-row');
  for (const r of RESOURCE_TYPES) {
    const cell = el('div', 'modal-res-cell');
    cell.appendChild(makeBtn('−', 'btn-small', give[r] <= 0, () =>
      setUIPhase({ type: 'playerTradeOffer', give: { ...give, [r]: give[r] - 1 }, receive, targetPids }),
    ));
    const info = el('span', 'modal-res-info');
    setIconText(info, RESOURCE_IMG[r], ` 手${player.hand[r]} 渡${give[r]}`);
    cell.appendChild(info);
    cell.appendChild(makeBtn('+', 'btn-small', give[r] >= player.hand[r], () =>
      setUIPhase({ type: 'playerTradeOffer', give: { ...give, [r]: give[r] + 1 }, receive, targetPids }),
    ));
    giveRow.appendChild(cell);
  }
  div.appendChild(giveRow);

  // 受け取る資源
  const recvLabel = el('div', 'modal-section-label');
  recvLabel.textContent = lc ? 'もらう' : '受け取る資源：';
  div.appendChild(recvLabel);

  const recvRow = el('div', 'modal-res-row');
  for (const r of RESOURCE_TYPES) {
    const cell = el('div', 'modal-res-cell');
    cell.appendChild(makeBtn('−', 'btn-small', receive[r] <= 0, () =>
      setUIPhase({ type: 'playerTradeOffer', give, receive: { ...receive, [r]: receive[r] - 1 }, targetPids }),
    ));
    const info = el('span', 'modal-res-info');
    setIconText(info, RESOURCE_IMG[r], ` 要求${receive[r]}`);
    cell.appendChild(info);
    cell.appendChild(makeBtn('+', 'btn-small', false, () =>
      setUIPhase({ type: 'playerTradeOffer', give, receive: { ...receive, [r]: receive[r] + 1 }, targetPids }),
    ));
    recvRow.appendChild(cell);
  }
  div.appendChild(recvRow);

  const giveTotal = RESOURCE_TYPES.reduce((s, r) => s + give[r], 0);
  const recvTotal = RESOURCE_TYPES.reduce((s, r) => s + receive[r], 0);
  // 同一資源を渡しつつ受け取る交換は無意味なので送信不可にする
  const hasOverlap = RESOURCE_TYPES.some(r => give[r] > 0 && receive[r] > 0);
  const canSend = giveTotal > 0 && recvTotal > 0 && !hasOverlap;

  const canSendWithTarget = canSend && targetPids.length > 0;
  if (hasOverlap) {
    const warn = el('div', 'modal-section-label');
    warn.textContent = '⚠ 同じ資源を渡して受け取ることはできません';
    warn.style.color = '#ffb060';
    div.appendChild(warn);
  }
  div.appendChild(makeBtn(lc ? '📤 提案' : '📤 オファー送信', canSendWithTarget ? 'btn-primary' : 'btn-disabled', !canSendWithTarget, () => {
    const giveP: Partial<ResourceHand> = {};
    const recvP: Partial<ResourceHand> = {};
    for (const r of RESOURCE_TYPES) {
      if (give[r] > 0) giveP[r] = give[r];
      if (receive[r] > 0) recvP[r] = receive[r];
    }
    dispatch({ type: 'OFFER_TRADE', offer: { give: giveP, receive: recvP }, targetPlayerIds: targetPids });
  }));
  div.appendChild(makeBtn(lc ? '✕' : '✕ キャンセル', 'btn-end', false, () => setUIPhase({ type: 'idle' })));
  return div;
}

// ============================================================
// F-05: ペンディング交易UI（応答・確認）
// ============================================================

// LAN対戦用のペンディング交易UI（視点 viewerId 基準で操作を出し分ける）。
// 提案者: 応答状況の一覧＋（全員応答後）成立相手選択 or 取り消し。
// 対象者: 自分が未応答なら承認/拒否。第三者: 状況の閲覧のみ。
function buildLanPendingTradeUI(
  state: GameState,
  viewerId: PlayerId,
  dispatch: (a: Action) => void,
): HTMLDivElement {
  const div = el('div', 'modal-panel');
  const trade = state.pendingTrade!;
  const initiator = state.players[trade.initiatorId];
  const initColor = PLAYER_COLORS[trade.initiatorId] ?? '#aaa';

  const lc = isLandscapeCompact();
  const header = el('div', 'modal-header');
  header.append(inlineIc(ASSETS.action.playerTrade, 'inline-ic'),
    document.createTextNode(lc ? ' 交易' : ' プレイヤー間交易'));
  div.appendChild(header);

  // 交換内容（提案者が渡す ⇅ 提案者が欲しい）— 公開情報
  div.appendChild(buildExchangeView(trade.offer.give, trade.offer.receive, initiator?.name ?? trade.initiatorId, initColor));

  const isInitiator = viewerId === trade.initiatorId;
  const isTarget = trade.targetPlayerIds.includes(viewerId);
  const myResp = trade.responses[viewerId];

  // 応答状況の一覧（公開情報）
  const statusLbl = el('div', 'modal-section-label');
  statusLbl.textContent = lc ? '返答' : '提案先の返答：';
  div.appendChild(statusLbl);
  const list = el('div', 'trade-status-list');
  for (const t of trade.targetPlayerIds) {
    const name = state.players[t]?.name ?? t;
    const resp = trade.responses[t];
    const row = el('div', 'trade-status-row');
    if (!resp) { row.textContent = `⏳ ${name}：検討中…`; row.style.color = 'rgba(255,255,255,0.7)'; }
    else if (resp.status === 'ACCEPT') { row.textContent = `✓ ${name}：承認`; row.style.color = '#7aee40'; }
    else { row.textContent = `✗ ${name}：拒否`; row.style.color = '#ff6060'; }
    list.appendChild(row);
  }
  div.appendChild(list);

  // ---- 対象プレイヤー: 自分が未応答なら承認/拒否 ----
  if (isTarget && !myResp && (trade.state === 'TRADE_OFFER' || trade.state === 'TRADE_RESPONSE')) {
    const me = state.players[viewerId]!;
    // 「自分が渡す = 提案者が受け取る(receive)」を支払えるか
    const canAfford = RESOURCE_TYPES.every(r => (me.hand[r] ?? 0) >= (trade.offer.receive[r] ?? 0));
    const you = el('div', 'trade-you-view');
    you.append('👉 あなたは ');
    you.appendChild(resChips(trade.offer.receive));
    you.append(' を渡して ');
    you.appendChild(resChips(trade.offer.give));
    you.append(' をもらう');
    div.appendChild(you);
    if (!canAfford) {
      const lacking = RESOURCE_TYPES.filter(r => (me.hand[r] ?? 0) < (trade.offer.receive[r] ?? 0));
      const lackMsg = el('div', 'trade-lack-msg');
      lackMsg.textContent = `⚠ ${lacking.map(r => RESOURCE_NAMES[r]).join('・')}が不足しています`;
      div.appendChild(lackMsg);
    }
    const btnRow = el('div', 'trade-response-btns');
    btnRow.appendChild(makeBtn(lc ? '✓ OK' : '✓ 承認', canAfford ? 'btn-primary' : 'btn-disabled', !canAfford, () =>
      dispatch({ type: 'RESPOND_TRADE', response: { playerId: viewerId, status: 'ACCEPT' } }),
    ));
    btnRow.appendChild(makeBtn('✗ 拒否', 'btn-end', false, () =>
      dispatch({ type: 'RESPOND_TRADE', response: { playerId: viewerId, status: 'REJECT' } }),
    ));
    div.appendChild(btnRow);
  } else if (isTarget && myResp) {
    const done = el('div', 'modal-section-label');
    done.textContent = myResp.status === 'ACCEPT' ? '✓ あなたは承認しました' : '✗ あなたは拒否しました';
    div.appendChild(done);
  }

  // ---- 提案者: 取り消し / 成立相手の選択 ----
  if (isInitiator) {
    if (trade.state === 'TRADE_OFFER') {
      div.appendChild(makeBtn(lc ? '取消' : '↩ 取り消す', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
    } else if (trade.state === 'TRADE_RESPONSE') {
      const acceptors = trade.targetPlayerIds.filter(t => trade.responses[t]?.status === 'ACCEPT') as PlayerId[];
      if (acceptors.length === 0) {
        const msg = el('div', 'modal-section-label');
        msg.textContent = lc ? '😕 全員拒否' : '😕 全員が拒否（不成立）';
        msg.style.color = '#ff8060';
        div.appendChild(msg);
        div.appendChild(makeBtn('閉じる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
      } else {
        const lbl = el('div', 'modal-section-label');
        lbl.textContent = lc ? '成立相手:' : (acceptors.length === 1 ? '✅ 成立させる：' : '✅ 成立相手を1人選択：');
        div.appendChild(lbl);
        const row = el('div', 'trade-response-btns');
        for (const a of acceptors) {
          row.appendChild(makeBtn(lc ? `${state.players[a]?.name}` : `${state.players[a]?.name} と成立`, 'btn-primary', false,
            () => dispatch({ type: 'CONFIRM_TRADE', responderId: a })));
        }
        div.appendChild(row);
        div.appendChild(makeBtn(lc ? 'やめる' : '↩ やめる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
      }
    }
  }

  // 第三者（提案者でも対象でもない）は閲覧のみ。
  if (!isInitiator && !isTarget) {
    const note = el('div', 'modal-section-label');
    note.textContent = '他プレイヤーが交易中です…';
    div.appendChild(note);
  }

  if (trade.state === 'TRADE_CANCELLED') {
    const err = el('div', 'modal-section-label');
    err.textContent = '取引失敗：実行前に手持ちが変化しました';
    err.style.color = '#ff8060';
    div.appendChild(err);
    if (isInitiator) div.appendChild(makeBtn('閉じる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
  }

  return div;
}

function buildPendingTradeUI(
  state: GameState,
  pid: PlayerId,
  dispatch: (a: Action) => void,
  viewerId?: PlayerId,
  lanMode = false,
): HTMLDivElement {
  // LAN対戦は「視点(viewerId)」基準で承認/拒否・成立操作を出し分ける。
  // （pid は手番=提案者なので全端末で同じになり、視点判定には使えない）
  if (lanMode && viewerId != null) {
    return buildLanPendingTradeUI(state, viewerId, dispatch);
  }

  const div = el('div', 'modal-panel');
  const trade = state.pendingTrade!;
  const initiator = state.players[trade.initiatorId];
  const isCpuInitiated = initiator?.type === 'ai';

  const header = el('div', 'modal-header');
  if (isCpuInitiated) {
    header.append(inlineIc(ASSETS.action.playerTrade, 'inline-ic'),
      document.createTextNode(` ${initiator?.name ?? trade.initiatorId} から交易提案`));
  } else {
    header.append(inlineIc(ASSETS.action.playerTrade, 'inline-ic'), document.createTextNode(' プレイヤー間交易'));
  }
  div.appendChild(header);

  // 交換内容を視覚的に表示（提案者が渡す ⇅ 提案者が欲しい）
  const initColor = PLAYER_COLORS[trade.initiatorId] ?? '#aaa';
  div.appendChild(buildExchangeView(trade.offer.give, trade.offer.receive, initiator?.name ?? trade.initiatorId, initColor));

  // CPU起案で人間が応答する場合は「あなた視点」を明示（一目で分かるように）
  if (isCpuInitiated) {
    const youPid = trade.targetPlayerIds.find(t => state.players[t]?.type === 'human');
    if (youPid) {
      const you = el('div', 'trade-you-view');
      you.append('👉 あなたは ');
      you.appendChild(resChips(trade.offer.receive)); // あなたが渡す = 提案者が欲しい
      you.append(' を渡して ');
      you.appendChild(resChips(trade.offer.give));     // あなたがもらう = 提案者が渡す
      you.append(' をもらう');
      div.appendChild(you);
    }
  }

  if (isCpuInitiated) {
    // ---- CPU起案：人間（=ターゲット）が承認/拒否する ----
    if (trade.state === 'TRADE_OFFER') {
      const pending = trade.targetPlayerIds.find(t => !trade.responses[t]);
      const humanPlayer = pending ? state.players[pending] : null;
      if (pending && humanPlayer?.type === 'human') {
        const canAfford = RESOURCE_TYPES.every(r =>
          (humanPlayer.hand[r] ?? 0) >= (trade.offer.receive[r] ?? 0),
        );
        if (!canAfford) {
          const lacking = RESOURCE_TYPES.filter(r => (humanPlayer.hand[r] ?? 0) < (trade.offer.receive[r] ?? 0));
          const lackMsg = el('div', 'trade-lack-msg');
          lackMsg.textContent = `⚠ ${lacking.map(r => RESOURCE_NAMES[r]).join('・')}が不足しています`;
          div.appendChild(lackMsg);
        }
        const btnRow = el('div', 'trade-response-btns');
        btnRow.appendChild(makeBtn('✓ 承認', canAfford ? 'btn-primary' : 'btn-disabled', !canAfford, () =>
          dispatch({ type: 'RESPOND_TRADE', response: { playerId: pending, status: 'ACCEPT' } }),
        ));
        btnRow.appendChild(makeBtn('✗ 拒否', 'btn-end', false, () =>
          dispatch({ type: 'RESPOND_TRADE', response: { playerId: pending, status: 'REJECT' } }),
        ));
        div.appendChild(btnRow);
      }
    } else if (trade.state === 'TRADE_RESPONSE') {
      const waiting = el('div', 'modal-section-label');
      waiting.textContent = '⏳ 処理中...';
      div.appendChild(waiting);
    }
  } else if (trade.state === 'TRADE_OFFER' || trade.state === 'TRADE_RESPONSE') {
    // ---- 人間起案：提案先(複数CPU)の応答状況を常に一覧表示（公開情報のみ） ----
    const statusLbl = el('div', 'modal-section-label');
    statusLbl.textContent = '提案先の返答：';
    div.appendChild(statusLbl);
    const list = el('div', 'trade-status-list');
    for (const t of trade.targetPlayerIds) {
      const name = state.players[t]?.name ?? t;
      const resp = trade.responses[t];
      const row = el('div', 'trade-status-row');
      if (!resp) { row.textContent = `⏳ ${name}：検討中…`; row.style.color = 'rgba(255,255,255,0.7)'; }
      else if (resp.status === 'ACCEPT') { row.textContent = `✓ ${name}：OK`; row.style.color = '#7aee40'; }
      else { row.textContent = `✗ ${name}：拒否`; row.style.color = '#ff6060'; }
      list.appendChild(row);
    }
    div.appendChild(list);

    if (pid === trade.initiatorId) {
      if (trade.state === 'TRADE_OFFER') {
        // まだ収集中 → 取り消し可
        div.appendChild(makeBtn('↩ 取り消す', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
      } else {
        // 全員応答済み → 成立相手の選択 or 不成立
        const acceptors = trade.targetPlayerIds.filter(t => trade.responses[t]?.status === 'ACCEPT') as PlayerId[];
        if (acceptors.length === 0) {
          const msg = el('div', 'modal-section-label');
          msg.textContent = '😕 全員が拒否（不成立）';
          msg.style.color = '#ff8060';
          div.appendChild(msg);
          div.appendChild(makeBtn('閉じる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
        } else {
          const lbl = el('div', 'modal-section-label');
          lbl.textContent = acceptors.length === 1 ? '✅ 成立させる：' : '✅ 成立相手を1人選択：';
          div.appendChild(lbl);
          const row = el('div', 'trade-response-btns');
          for (const a of acceptors) {
            row.appendChild(makeBtn(
              `${state.players[a]?.name} と成立`, 'btn-primary', false,
              () => dispatch({ type: 'CONFIRM_TRADE', responderId: a }),
            ));
          }
          div.appendChild(row);
          div.appendChild(makeBtn('↩ やめる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
        }
      }
    }
  }

  // TRADE_CANCELLED: 失敗
  if (trade.state === 'TRADE_CANCELLED') {
    const err = el('div', 'modal-section-label');
    err.textContent = '取引失敗：実行前に手持ちが変化しました';
    err.style.color = '#ff8060';
    div.appendChild(err);
    div.appendChild(makeBtn('閉じる', 'btn-end', false, () => dispatch({ type: 'CANCEL_TRADE' })));
  }

  return div;
}

// ============================================================
// 発展カードボタン共通ヘルパー（PRE_ROLL / TRADE_BUILD 両方で使用）
// ============================================================

function appendDevCardButtons(
  div: HTMLElement,
  state: GameState,
  player: Player,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
): void {
  // 街道建設カード処理中は表示しない
  if (state.roadBuildingRoadsRemaining > 0) return;

  let playable = getPlayableDevCards(player, state.globalTurnNumber);
  // ダイス前（PRE_ROLL）は騎士カードのみ使用可。他はダイス後の交易・建設フェーズで。
  if (!state.diceRolledThisTurn) {
    playable = playable.filter(c => c.type === 'knight');
  }
  if (playable.length === 0) return;

  const devAlreadyPlayed = state.devCardPlayedThisTurn;
  for (const { type, count } of playable) {
    const label = `${DEV_CARD_NAMES[type] ?? type}${count > 1 ? ` ×${count}` : ''}`;
    const btn = makeBtn(
      label,
      devAlreadyPlayed ? 'btn-disabled' : 'btn-build',
      devAlreadyPlayed,
      () => {
        if (type === 'knight')         dispatch({ type: 'PLAY_KNIGHT' });
        if (type === 'road_building')  dispatch({ type: 'PLAY_ROAD_BUILDING' });
        if (type === 'year_of_plenty') setUIPhase({ type: 'yearOfPlenty', slots: [null, null] });
        if (type === 'monopoly')       setUIPhase({ type: 'monopoly', resource: null });
      },
    );
    // 騎士は ⚔ 絵文字の代わりに騎士フィギュア画像をアイコンとして先頭に表示。
    if (type === 'knight') {
      btn.textContent = label.replace('⚔ ', '');
      const ic = document.createElement('img');
      ic.className = 'dev-knight-icon';
      ic.src = knightImg; ic.alt = '騎士'; ic.draggable = false;
      btn.prepend(ic);
    }
    div.appendChild(btn);
  }
}

// 船ルールの説明ポップアップ（航海者）。「船は作れるが動かせない」等の疑問に答える。
function showShipRulesHelp(state: GameState, pid: PlayerId): void {
  document.getElementById('ship-help')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ship-help';
  overlay.className = 'help-overlay';
  const card = document.createElement('div');
  card.className = 'help-modal';

  const h = document.createElement('div');
  h.className = 'help-title';
  h.textContent = '⛵ 船のルール';
  card.appendChild(h);

  // 今動かせない理由を一言（分かる範囲で）。
  const reason = document.createElement('p');
  reason.className = 'help-reason';
  const hasOwnShip = Object.values(state.edges).some(e => e.ship?.playerId === pid);
  if (playerHasMovableShip(state, pid)) {
    reason.textContent = '「⛵ 船を移動」で、行き止まりの船を1隻だけ別の海辺へ動かせます。';
  } else if (state.shipMovedThisTurn) {
    reason.textContent = 'このターンはもう船を1隻動かしました（移動は1ターンに1隻まで）。';
  } else if (hasOwnShip) {
    reason.textContent = '今は「行き止まりの船」がないため動かせません。経路の途中の船は動かせません。';
  } else {
    reason.textContent = 'まだ動かせる船がありません。';
  }
  card.appendChild(reason);

  const ul = document.createElement('ul');
  ul.className = 'help-list';
  for (const r of [
    '船は「木材＋羊毛」。海に面した辺に置けます。',
    '船は自分の船か建物から、道は自分の道か建物からのみ伸ばせます（道と船は直接つながらず、建物でのみ切り替わります）。',
    '動かせるのは「行き止まり（片端が他とつながっていない）の船」だけ。',
    '船の移動は1ターンに1隻まで。',
    '新しい島に開拓地を建てると、そこから先へさらに船を伸ばせます。',
  ]) {
    const li = document.createElement('li');
    li.textContent = r;
    ul.appendChild(li);
  }
  card.appendChild(ul);

  const close = document.createElement('button');
  close.className = 'help-close';
  close.textContent = '閉じる';
  close.addEventListener('click', () => overlay.remove());
  card.appendChild(close);

  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// 騎士と商人: 進歩カードの「効果説明＋使う/やめる」モーダル（使用前に効果が分かるように）。
// 公式準拠の選択UI: 資源独占=資源を指名 / 交易独占=商品を指名 / 大商人=相手を選ぶ。
function buildProgressChoicePicker(card: ProgressCard, state: GameState, pid: PlayerId | undefined, play: (c: ProgressChoice) => void, cancel: () => void): HTMLElement {
  const wrap = el('div', 'pc-choice');
  const label = el('div', 'pc-choice-label');
  const row = el('div', 'pc-choice-row');
  if (card.type === 'alchemist') {
    // 錬金術師: 次のダイス目（赤・黄 各1〜6）を自分で指定する数字パネル。
    label.textContent = '次のダイス目を指定（赤＋黄）';
    let red = 3, yellow = 4;
    const sumEl = el('div', 'pc-dice-sum');
    const redRow = el('div', 'pc-dice-row');
    const yellowRow = el('div', 'pc-dice-row');
    const render = (): void => {
      sumEl.textContent = `赤 ${red} ＋ 黄 ${yellow} ＝ ${red + yellow}`;
      redRow.textContent = ''; yellowRow.textContent = '';
      for (let n = 1; n <= 6; n++) redRow.appendChild(makeBtn(String(n), red === n ? 'btn-active pc-die red' : 'btn-build pc-die', false, () => { red = n; render(); }));
      for (let n = 1; n <= 6; n++) yellowRow.appendChild(makeBtn(String(n), yellow === n ? 'btn-active pc-die yellow' : 'btn-build pc-die', false, () => { yellow = n; render(); }));
    };
    render();
    wrap.append(
      label, sumEl,
      Object.assign(el('div', 'pc-choice-sub'), { textContent: '赤ダイス' }), redRow,
      Object.assign(el('div', 'pc-choice-sub'), { textContent: '黄ダイス' }), yellowRow,
      makeBtn('▶ この目で確定', 'btn-primary', false, () => play({ dice: [red, yellow] })),
      makeBtn('やめる', 'btn-end', false, cancel),
    );
    return wrap;
  }
  if (card.type === 'inventor') {
    // 発明家: 入れ替える2つの数字タイルを選ぶ（同じ数字でも別タイル）。
    label.textContent = '入れ替える2つのタイルを選ぶ';
    const eligible = inventorTiles(state);
    const sel: string[] = [];
    const grid = el('div', 'pc-tile-row');
    // disabled=false で生成して onClick を確実に束縛（有効/無効は render で切替）。クリックは sel.length===2 を内部ガード。
    const confirm = makeBtn('▶ 入れ替える', 'btn-disabled', false, () => { if (sel.length === 2) play({ inventorTiles: [sel[0]!, sel[1]!] }); });
    const render = (): void => {
      grid.textContent = '';
      for (const tid of eligible) {
        const tile = state.tiles[tid]!;
        const res = TILE_RESOURCE_MAP[tile.type];
        const isSel = sel.includes(tid);
        const btn = makeImgBtn(res ? RESOURCE_IMG[res] : glyph('ic-cards'), String(tile.number ?? ''), isSel ? 'btn-active pc-tile' : 'btn-build pc-tile', false, () => {
          const i = sel.indexOf(tid);
          if (i >= 0) sel.splice(i, 1); else if (sel.length < 2) sel.push(tid);
          render();
        });
        grid.appendChild(btn);
      }
      confirm.disabled = sel.length !== 2;
      confirm.className = `action-btn ${sel.length === 2 ? 'btn-primary' : 'btn-disabled'}`;
    };
    render();
    wrap.append(label, Object.assign(el('div', 'pc-choice-sub'), { textContent: '同じ数字でも別のタイルです（2つ選ぶ）' }), grid, confirm, makeBtn('やめる', 'btn-end', false, cancel));
    return wrap;
  }
  if (card.type === 'crane') {
    // クレーン: 商品1個分安く1段上げるトラックを選ぶ（払えるトラックのみ・割引後コストを表示）。
    label.textContent = '改善するトラックを選ぶ（通常より商品1個分安い）';
    const tracks = pid ? craneEligibleTracks(state, pid) : [];
    if (tracks.length === 0) {
      row.appendChild(Object.assign(el('div', 'pc-choice-empty'), { textContent: '改善できるトラックがありません（都市と商品が必要）' }));
      row.appendChild(makeBtn('効果なしで使う（カードを消費）', 'btn-end', false, () => play({})));
    } else {
      const lvOf = (t: CkTrack): number => state.players[pid!]?.improvements?.[t] ?? 0;
      for (const t of tracks) {
        const lvl = lvOf(t);
        const cost = Math.max(0, improvementCost(lvl) - 1); // クレーンの割引後コスト
        const btnLabel: (string | HTMLElement)[] = [`${CK_TRACK_NAME[t]} Lv${lvl}→${lvl + 1}（`, inlineIc(COMMODITY_IMG[CK_TRACK_COMMODITY[t]], 'inline-ic'), `×${cost}）`];
        row.appendChild(makeImgBtn(IMP_IMG[t], btnLabel, 'btn-build', false, () => play({ craneTrack: t })));
      }
    }
    wrap.append(label, row, makeBtn('やめる', 'btn-end', false, cancel));
    return wrap;
  }
  if (card.type === 'merchant_fleet') {
    // 商船隊: このターン 2:1 で交易する1種（資源5＋商品3）を選ぶ。
    label.textContent = '2:1で交易する種類を選ぶ（このターン中）';
    for (const r of RESOURCE_TYPES) row.appendChild(makeImgBtn(RESOURCE_IMG[r], RESOURCE_NAMES[r], 'btn-build', false, () => play({ fleetType: r })));
    for (const c of COMMODITY_TYPES) row.appendChild(makeImgBtn(COMMODITY_IMG[c], COMMODITY_NAMES[c], 'btn-build', false, () => play({ fleetType: c })));
    wrap.append(label, row, makeBtn('やめる', 'btn-end', false, cancel));
    return wrap;
  }
  if (card.type === 'commercial_harbor') {
    // 商業港: 各相手に渡す資源1種＋もらう商品1種を指名（全相手共通の宣言型）。
    label.textContent = '渡す資源と もらう商品を選ぶ（各相手と交換）';
    const me = pid ? state.players[pid] : null;
    let give: ResourceType | null = null;
    let take: CommodityType | null = null;
    const giveRow = el('div', 'pc-choice-row');
    const takeRow = el('div', 'pc-choice-row');
    const confirm = makeBtn('▶ 交換する', 'btn-disabled', false, () => { if (give && take) play({ commercialGive: give, commercialTake: take }); });
    const render = (): void => {
      giveRow.textContent = ''; takeRow.textContent = '';
      for (const r of RESOURCE_TYPES) {
        const held = me?.hand[r] ?? 0;
        const cls = held <= 0 ? 'btn-disabled' : (give === r ? 'btn-active' : 'btn-build');
        giveRow.appendChild(makeImgBtn(RESOURCE_IMG[r], `${RESOURCE_NAMES[r]} ×${held}`, cls, held <= 0, () => { give = r; render(); }));
      }
      for (const c of COMMODITY_TYPES) {
        takeRow.appendChild(makeImgBtn(COMMODITY_IMG[c], COMMODITY_NAMES[c], take === c ? 'btn-active' : 'btn-build', false, () => { take = c; render(); }));
      }
      confirm.disabled = !(give && take);
      confirm.className = `action-btn ${give && take ? 'btn-primary' : 'btn-disabled'}`;
    };
    render();
    wrap.append(label,
      Object.assign(el('div', 'pc-choice-sub'), { textContent: '渡す資源（自分の手札から1種）' }), giveRow,
      Object.assign(el('div', 'pc-choice-sub'), { textContent: 'もらう商品（各相手から1枚ずつ）' }), takeRow,
      confirm, makeBtn('やめる', 'btn-end', false, cancel));
    return wrap;
  }
  if (card.type === 'spy') {
    // スパイ: 盗む相手を選ぶ。相手の進歩カードが見える（単一端末＝非マスク）なら盗む札も選ばせる。
    // LANでは相手の札が秘匿（progressCards=[]）のため、相手だけ選び札は無作為。
    label.textContent = 'カードを盗む相手を選ぶ';
    const cntOf = (o: PlayerId): number => state.players[o]?.progressCardCount ?? state.players[o]?.progressCards?.length ?? 0;
    const opps = state.playerOrder.filter(o => o !== pid && cntOf(o as PlayerId) > 0) as PlayerId[];
    if (opps.length === 0) {
      row.appendChild(Object.assign(el('div', 'pc-choice-empty'), { textContent: '進歩カードを持つ相手がいません' }));
      row.appendChild(makeBtn('効果なしで使う（カードを消費）', 'btn-end', false, () => play({})));
      wrap.append(label, row, makeBtn('やめる', 'btn-end', false, cancel));
      return wrap;
    }
    const chooseTarget = (o: PlayerId): void => {
      const cards = state.players[o]?.progressCards ?? [];
      if (cards.length > 0) {
        // 相手の札が見えている: 盗む1枚を選ばせる（公式: 相手の手札を見て選ぶ）。
        label.textContent = `${state.players[o]!.name} から盗む札を選ぶ`;
        row.textContent = '';
        for (const c of cards) row.appendChild(makeImgBtn(ASSETS.progressCard[c.type] ?? ASSETS.cardBack[c.deck], PROGRESS_CARD_NAME[c.type], 'btn-build', false, () => play({ spyTargetPlayerId: o, spyCardId: c.id })));
      } else {
        play({ spyTargetPlayerId: o }); // 秘匿: 相手だけ指定し札は無作為
      }
    };
    for (const o of opps) {
      const b = makeBtn(`${state.players[o]!.name}（📜${cntOf(o)}）`, 'btn-build', false, () => chooseTarget(o));
      b.style.borderLeft = `5px solid ${PLAYER_COLORS[o] ?? '#888'}`;
      row.appendChild(b);
    }
    wrap.append(label, row, makeBtn('やめる', 'btn-end', false, cancel));
    return wrap;
  }
  if (card.type === 'resource_monopoly') {
    label.textContent = '奪う資源を選ぶ';
    for (const r of RESOURCE_TYPES) row.appendChild(makeImgBtn(RESOURCE_IMG[r], RESOURCE_NAMES[r], 'btn-build', false, () => play({ resource: r })));
  } else if (card.type === 'trade_monopoly') {
    label.textContent = '奪う商品を選ぶ';
    for (const c of COMMODITY_TYPES) row.appendChild(makeImgBtn(COMMODITY_IMG[c], COMMODITY_NAMES[c], 'btn-build', false, () => play({ commodity: c })));
  } else { // master_merchant
    label.textContent = '相手を選ぶ（自分よりVPが高い相手）';
    const myVp = pid ? calcVP(state, pid) : 0;
    const cardsOf = (o: PlayerId): number => robbableCardCount(state, o); // 資源＋商品（大商人は商品も奪える）
    const eligible = state.playerOrder.filter(o => o !== pid && calcVP(state, o) > myVp && cardsOf(o as PlayerId) > 0) as PlayerId[];
    for (const o of eligible) {
      const b = makeBtn(`${state.players[o]!.name}（★${calcVP(state, o)}）`, 'btn-build', false, () => play({ targetPlayerId: o }));
      b.style.borderLeft = `5px solid ${PLAYER_COLORS[o] ?? '#888'}`;
      row.appendChild(b);
    }
    if (eligible.length === 0) {
      row.appendChild(Object.assign(el('div', 'pc-choice-empty'), { textContent: '対象がいません' }));
      // 効果が空でもカードを消費して使える（手札整理）。
      row.appendChild(makeBtn('効果なしで使う（カードを消費）', 'btn-end', false, () => play({})));
    }
  }
  wrap.append(label, row, makeBtn('やめる', 'btn-end', false, cancel));
  return wrap;
}

function showProgressCardInfo(card: ProgressCard, canPlay: boolean, dispatch: (a: Action) => void, state?: GameState, pid?: PlayerId, mode: 'play' | 'discard' = 'play'): void {
  document.querySelector('.help-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'help-overlay';
  const box = document.createElement('div');
  box.className = 'help-card pc-info-card';

  // カード絵を装飾フレームで囲み「カード」らしく見せる（フレーム＋名前＋効果が分かるUI）。
  const frameWrap = el('div', 'pc-info-frame');
  const art = assetImg(ASSETS.progressCard[card.type] ?? ASSETS.cardBack[card.deck], 'pc-info-art', PROGRESS_CARD_NAME[card.type], PROGRESS_CARD_NAME[card.type]);
  frameWrap.appendChild(art);
  const frameBorder = document.createElement('img');
  frameBorder.className = 'pc-info-frame-border'; frameBorder.src = ASSETS.frame; frameBorder.alt = ''; frameBorder.draggable = false;
  frameWrap.appendChild(frameBorder);
  box.appendChild(frameWrap);

  const title = el('div', 'pc-info-title');
  title.textContent = `📜 ${PROGRESS_CARD_NAME[card.type]}`;
  box.appendChild(title);
  const deck = el('div', `pc-info-deck pc-deck-${card.deck}`);
  deck.textContent = `${CK_TRACK_NAME[card.deck]}デッキ`;
  box.appendChild(deck);
  const desc = el('div', 'pc-info-desc');
  desc.textContent = PROGRESS_CARD_DESC[card.type];
  box.appendChild(desc);

  // 公式: 資源独占/交易独占=奪う種類を指名、大商人=相手を選ぶ。これらは「使う」で選択UIへ。
  // 商人・発明家は「使う」後に盤面でタイルを選ぶ（dispatch 側で placeMerchant/inventorSwap へ）ため
  // モーダルの選択UIは出さない（needsChoice から除外）。
  const needsChoice = card.type === 'resource_monopoly' || card.type === 'trade_monopoly' || card.type === 'master_merchant' || card.type === 'alchemist' || card.type === 'crane'
    || card.type === 'merchant_fleet' || card.type === 'commercial_harbor' || card.type === 'spy';
  const play = (choice?: ProgressChoice): void => { overlay.remove(); dispatch({ type: 'PLAY_PROGRESS', cardId: card.id, ...(choice ? { choice } : {}) }); };

  const actions = el('div', 'pc-info-actions');
  if (mode === 'discard') {
    // 進歩カード上限超過: ここで効果を確認してから「捨てる/やめる」を選べる（誤って即捨てを防ぐ）。
    const discardBtn = document.createElement('button');
    discardBtn.className = 'action-btn btn-danger';
    discardBtn.textContent = '🗑 捨てる';
    discardBtn.addEventListener('click', () => {
      overlay.remove();
      if (pid) dispatch({ type: 'DISCARD_PROGRESS', playerId: pid, cardId: card.id });
    });
    actions.appendChild(discardBtn);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn btn-end';
    cancelBtn.textContent = 'やめる';
    cancelBtn.addEventListener('click', () => overlay.remove());
    actions.appendChild(cancelBtn);
  } else {
    const useBtn = document.createElement('button');
    useBtn.className = `action-btn ${canPlay ? 'btn-primary' : 'btn-disabled'}`;
    useBtn.textContent = canPlay ? (needsChoice ? '▶ 使う（選ぶ）' : '▶ 使う') : '今は使えません';
    useBtn.disabled = !canPlay;
    if (canPlay) useBtn.addEventListener('click', () => {
      if (needsChoice && state) { actions.remove(); box.appendChild(buildProgressChoicePicker(card, state, pid, play, () => overlay.remove())); }
      else play();
    });
    actions.appendChild(useBtn);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'action-btn btn-end';
    closeBtn.textContent = canPlay ? 'やめる' : '閉じる';
    closeBtn.addEventListener('click', () => overlay.remove());
    actions.appendChild(closeBtn);
  }
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// コマ・カードの図鑑（全画像を名前・説明つきで一覧）。TOP/ゲーム中から開ける。
export function showAssetGallery(): void {
  document.querySelector('.gallery-overlay')?.remove();
  const overlay = el('div', 'gallery-overlay');
  const modal = el('div', 'gallery-modal');
  const header = el('div', 'gallery-header');
  header.textContent = '🖼 コマ・カード図鑑（都市と騎士）';
  modal.appendChild(header);
  const body = el('div', 'gallery-body');

  const section = (titleTxt: string): HTMLDivElement => {
    const s = el('div', 'gallery-section-title'); s.textContent = titleTxt; body.appendChild(s);
    const grid = el('div', 'gallery-grid'); body.appendChild(grid); return grid;
  };
  const item = (grid: HTMLElement, src: string | null, name: string, desc?: string, imgCls?: string): void => {
    const cell = el('div', 'gallery-cell');
    cell.appendChild(assetImg(src, imgCls ? `gallery-img ${imgCls}` : 'gallery-img', name, name));
    const n = el('div', 'gallery-name'); n.textContent = name; cell.appendChild(n);
    if (desc) { const d = el('div', 'gallery-desc'); d.textContent = desc; cell.appendChild(d); }
    grid.appendChild(cell);
  };
  // 進歩カード用: 装飾フレームで囲んだカード絵＋名前＋効果説明。
  const cardSection = (titleTxt: string): HTMLDivElement => {
    const s = el('div', 'gallery-section-title'); s.textContent = titleTxt; body.appendChild(s);
    const grid = el('div', 'gallery-grid gallery-grid-cards'); body.appendChild(grid); return grid;
  };
  const cardItem = (grid: HTMLElement, src: string | null, name: string, desc: string): void => {
    const cell = el('div', 'gallery-cell gallery-card-cell');
    const fr = el('div', 'gallery-card-frame');
    fr.appendChild(assetImg(src, 'gallery-card-art', name, name));
    const fb = document.createElement('img');
    fb.className = 'gallery-card-frame-border'; fb.src = ASSETS.frame; fb.alt = ''; fb.draggable = false;
    fr.appendChild(fb);
    cell.appendChild(fr);
    const n = el('div', 'gallery-name'); n.textContent = name; cell.appendChild(n);
    const d = el('div', 'gallery-desc'); d.textContent = desc; cell.appendChild(d);
    grid.appendChild(cell);
  };

  let g = section('🧩 コマ');
  item(g, ASSETS.piece.settlement, '開拓地', '1点。資源を1個産む');
  item(g, ASSETS.piece.city, '都市', '2点。資源2 か 資源1+商品1 を産む');
  item(g, ASSETS.knight.basic, '騎士（基本）', '強さ1。建設→麦で起動して防衛・行動');
  item(g, ASSETS.knight.strong, '騎士（強い）', '強さ2。鉱石+羊で昇格');
  item(g, ASSETS.knight.mighty, '騎士（最強）', '強さ3。要塞(政治Lv3)で昇格可');
  item(g, metropolisImg('red'), 'メトロポリス', '改善Lv4で都市から昇格。4点・略奪されない', 'gallery-img-neutral');
  item(g, ASSETS.piece.cityWall, '城壁', 'レンガ2。7の手札上限+2（最大3）');
  item(g, ASSETS.piece.merchant, '商人コマ', '隣接地形を2:1で交易・保持中+1点');
  item(g, ASSETS.piece.defenderBadge, '守護者VP', '蛮族撃退の最大貢献者が+1点');
  item(g, ASSETS.piece.robber, '盗賊', '7で移動し隣接から1枚奪う（初回襲来後）');
  item(g, ASSETS.piece.barbarianShip, '蛮族船', '船イベントで前進。満タンで襲来');

  g = section('🌲 資源（5種）');
  item(g, ASSETS.resource.lumber, '木材', '森から産出');
  item(g, ASSETS.resource.brick, 'レンガ', '丘から産出');
  item(g, ASSETS.resource.wool, '羊毛', '牧草地から産出');
  item(g, ASSETS.resource.grain, '小麦', '畑から産出');
  item(g, ASSETS.resource.ore, '鉱石', '山から産出');

  g = section('💰 商品（3種・都市が産出）');
  item(g, ASSETS.commodity.paper, '紙', '森の都市から（科学トラック）');
  item(g, ASSETS.commodity.cloth, '布', '牧草地の都市から（商業トラック）');
  item(g, ASSETS.commodity.coin, '金貨', '山の都市から（政治トラック）');

  g = section('🏛 都市の発展（建築）');
  item(g, ASSETS.building.trade[3], '交易所（商業Lv3）', '商品を銀行と2:1で交易');
  item(g, ASSETS.building.trade[4], '銀行（商業Lv4）', 'メトロポリス（商業）');
  item(g, ASSETS.building.politics[3], '要塞（政治Lv3）', '最強騎士への昇格を解禁');
  item(g, ASSETS.building.politics[4], '大聖堂（政治Lv4）', 'メトロポリス（政治）');
  item(g, ASSETS.building.science[3], '水道橋（科学Lv3）', '無産出のターンに資源1枚');
  item(g, ASSETS.building.science[4], '劇場（科学Lv4）', 'メトロポリス（科学）');

  for (const [deck, label] of [['politics', '政治'], ['science', '科学'], ['trade', '商業']] as [CkTrack, string][]) {
    const cg = cardSection(`📜 進歩カード（${label}デッキ）`);
    for (const type of PROGRESS_DECK_CARDS[deck]) {
      const art = ASSETS.progressCard[type] ?? ASSETS.cardBack[deck];
      cardItem(cg, art, PROGRESS_CARD_NAME[type], PROGRESS_CARD_DESC[type]);
    }
  }

  modal.appendChild(body);
  const close = el('button', 'gallery-close');
  close.textContent = '閉じる';
  close.addEventListener('click', () => overlay.remove());
  modal.appendChild(close);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// 騎士と商人: 都市改善・騎士・城壁の操作セクション（騎士の建設は最初の有効頂点へ自動配置・移動は盤面で選択）。
function appendCkBuildSection(
  div: HTMLElement, state: GameState, pid: PlayerId, dispatch: (a: Action) => void,
  buildMode: BuildMode, setBuildMode: (m: BuildMode) => void,
): void {
  const player = state.players[pid]!;
  const sec = el('div', 'ck-build');
  const title = el('div', 'ck-build-title');
  title.append(inlineIc(knightImg, 'inline-ic'), document.createTextNode(' 都市と騎士 アクション'));
  sec.appendChild(title);

  // 都市改善（3ツリー）
  const impLabel = el('div', 'ck-sub-label');
  impLabel.append(inlineIc(ASSETS.piece.metropolisGate, 'inline-ic'), document.createTextNode(' 都市の発展（商品で強化・Lv4でメトロポリス+4点）'));
  sec.appendChild(impLabel);
  const imp = player.improvements ?? { trade: 0, politics: 0, science: 0 };
  const impRow = el('div', 'ck-imp-row');
  for (const track of ['trade', 'politics', 'science'] as CkTrack[]) {
    const lvl = imp[track];
    const can = canBuildImprovement(state, pid, track);
    const c = CK_TRACK_COMMODITY[track];
    const nextLvl = lvl + 1;
    // コストの商品は絵文字ではなく素材画像で表示。
    const label: (string | HTMLElement)[] = lvl >= 5
      ? [`${CK_TRACK_NAME[track]} Lv5（最大）`]
      : [`${CK_TRACK_NAME[track]} Lv${lvl}→${nextLvl}（`, inlineIc(COMMODITY_IMG[c], 'inline-ic'), `×${improvementCost(lvl)}）`];
    // その段で得られる恩恵（科学Lv3=水道橋 等）を2行目に出して「Lv3で何が起きるか」を分かるようにする。
    const benefit = lvl >= 5 ? CK_TRACK_BENEFIT[track][5] : CK_TRACK_BENEFIT[track][nextLvl];
    if (benefit) label.push(Object.assign(el('div', 'imp-benefit'), { textContent: benefit }));
    // 改良建築: Lv3/Lv4 へ進む時はその建築画像（交易所/銀行/要塞/大聖堂/水道橋/劇場）、他はトラックアイコン。
    const icon = (nextLvl === 3 || nextLvl === 4) ? ASSETS.building[track][nextLvl as 3 | 4] : IMP_IMG[track];
    const btn = makeImgBtn(icon, label, can ? 'btn-build' : 'btn-disabled', !can,
      () => dispatch({ type: 'BUILD_IMPROVEMENT', track }));
    if (benefit) btn.title = benefit;
    impRow.appendChild(btn);
  }
  sec.appendChild(impRow);

  // 騎士・城壁
  const knLabel = el('div', 'ck-sub-label');
  knLabel.append(inlineIc(knightImg, 'inline-ic'), document.createTextNode(' 騎士・防衛（建設→麦で起動して使える）'));
  sec.appendChild(knLabel);
  const knightRow = el('div', 'ck-knight-row');
  const firstV = (pred: (vid: string) => boolean): string | undefined => Object.keys(state.vertices).find(pred);
  // 騎士の配置は盤面で頂点を選ぶ（自動配置をやめ、置く場所を自分で選べるように）。
  const canBuildKn = !!firstV(v => canBuildKnight(state, pid, v));
  knightRow.appendChild(modeImgBtn(knightImg, [costLabel('騎士を建てる', resCostParts(CK_COSTS.knightBuild))], 'buildKnight', canBuildKn, buildMode, setBuildMode));
  // 起動・昇格も対象の騎士を盤面で選ぶ（騎士が複数いるとき自分で選べるように）。
  // 起動(雷)・昇格(矢印)のアイコンはやや大きく見切れるため、専用クラスで一回り小さく表示する。
  const canActKn = !!firstV(v => canActivateKnight(state, pid, v));
  const actKnBtn = modeImgBtn(ASSETS.action.knightActivate, [costLabel('騎士を起動', resCostParts(CK_COSTS.knightActivate))], 'activateKnight', canActKn, buildMode, setBuildMode);
  actKnBtn.classList.add('btn-knight-op');
  knightRow.appendChild(actKnBtn);
  const canUpKn = !!firstV(v => canUpgradeKnight(state, pid, v));
  const upKnBtn = modeImgBtn(ASSETS.action.knightUpgrade, [costLabel('騎士を昇格', resCostParts(CK_COSTS.knightUpgrade))], 'upgradeKnight', canUpKn, buildMode, setBuildMode);
  upKnBtn.classList.add('btn-knight-op');
  knightRow.appendChild(upKnBtn);
  // 騎士の移動（盤面で 騎士→移動先 を選択。起動済みの騎士のみ・1ターン1回）。
  if (playerHasMovableKnight(state, pid)) {
    knightRow.appendChild(modeBtn('🏇 騎士を移動', 'moveKnight', true, buildMode, setBuildMode));
  }
  // 盗賊を追い払う（盗賊に隣接した自分のアクティブ騎士で。1ターン1回・騎士は非起動になる）。
  // 候補騎士が1つだけなら1タップで即追い払う（盤面選択を挟まない＝「ボタンが無反応」を解消）。
  // 複数いる時だけ盤面で騎士を選ばせる。
  if (playerHasChasableKnight(state, pid)) {
    const chasable = robberAdjacentChasableVertexIds(state, pid);
    if (chasable.length === 1) {
      knightRow.appendChild(makeBtn('🦹 盗賊を追い払う', 'btn-build', false,
        () => dispatch({ type: 'CHASE_ROBBER', vertexId: chasable[0]! })));
    } else {
      knightRow.appendChild(modeBtn('🦹 盗賊を追い払う', 'chaseRobber', true, buildMode, setBuildMode));
    }
  }
  // 城壁: 建てられる都市が2つ以上なら盤面でどの都市に建てるか選ばせる（selectWallCity）。
  // 1つだけなら従来どおり1タップで即建設。0なら無効。
  const wallCands = Object.keys(state.vertices).filter(v => canBuildCityWall(state, pid, v));
  if (wallCands.length >= 2) {
    knightRow.appendChild(modeImgBtn(ASSETS.piece.cityWall ?? RESOURCE_IMG.brick, [costLabel('城壁', resCostParts(CK_COSTS.cityWall))], 'selectWallCity', true, buildMode, setBuildMode));
  } else {
    const wallVid = wallCands[0];
    knightRow.appendChild(makeImgBtn(ASSETS.piece.cityWall ?? RESOURCE_IMG.brick, [costLabel('城壁', resCostParts(CK_COSTS.cityWall))], wallVid ? 'btn-build' : 'btn-disabled', !wallVid,
      () => wallVid && dispatch({ type: 'BUILD_CITY_WALL', vertexId: wallVid })));
  }
  sec.appendChild(knightRow);

  // 進歩カード（手札）。使えるものだけ有効。
  const cards = player.progressCards ?? [];
  if (cards.length > 0) {
    const pcTitle = el('div', 'ck-pc-title');
    pcTitle.textContent = `📜 進歩カード（${cards.length}/4）`;
    sec.appendChild(pcTitle);
    const pcRow = el('div', 'ck-pc-row');
    for (const c of cards) {
      const can = canPlayProgressLoose(state, pid, c.id); // 効果が空でも使える（消費される）
      // 進歩カードは25種すべて専用アート。未登録のみトラック色のカード裏（科学=緑/商業=黄/政治=青）。
      const icon = ASSETS.progressCard[c.type] ?? ASSETS.cardBack[c.deck];
      // タップで「効果説明＋使う/やめる」のカード詳細を表示（使用前に効果が分かるように）。
      // 使えないカードも閲覧可能（disabled=false）。実際の使用可否はモーダルの「使う」で制御。
      const btn = makeImgBtn(icon, PROGRESS_CARD_NAME[c.type], can ? 'btn-build' : 'btn-disabled', false,
        () => showProgressCardInfo(c, can, dispatch, state, pid));
      btn.title = PROGRESS_CARD_DESC[c.type];
      pcRow.appendChild(btn);
    }
    sec.appendChild(pcRow);
  }

  div.appendChild(sec);
}

// ============================================================
// アクションボタン群
// ============================================================

function buildActionButtons(
  state: GameState,
  player: Player,
  pid: PlayerId,
  buildMode: BuildMode,
  setBuildMode: (m: BuildMode) => void,
  uiPhase: UIPhase,
  setUIPhase: (p: UIPhase) => void,
  dispatch: (a: Action) => void,
  viewerId?: PlayerId,   // LAN: 自分のID
  lanMode = false,       // LAN: 手番gating＋未対応操作を隠す
): HTMLDivElement | null {
  if (state.phase !== 'MAIN') return null;
  const div = el('div', 'action-buttons');

  // 進歩カードの盤面選択中は「何をタップするか」を操作パネルに常駐表示する
  // （board-notice は2.2秒で消えてしまい、迷っている間に指示が無くなるため）。
  const selectHint: Partial<Record<BuildMode, string>> = {
    placeMerchant: '🏪 盤面で光った資源タイルをタップして商人を置く',
    inventorSwap: '🔄 盤面で光ったタイルを2つ選んで数字を入れ替える',
    placeBishop: '⛪ 盤面で光ったタイルをタップして盗賊を置く（隣接の全相手から1枚ずつ奪う）',
    selectDiplomatRoad: '📜 盤面で光った相手の端の道をタップして撤去',
    selectDeserterKnight: '🏃 盤面で光った相手の騎士をタップして消す（同じ強さの騎士を得る）',
    selectMedicineSettlement: '💊 盤面で光った自分の開拓地をタップして都市化（麦1＋鉱石2）',
    selectMetropolis: '🏛 盤面で光った自分の都市をタップしてメトロポリス化（+2点）',
  };
  if (selectHint[buildMode]) {
    const hint = el('div', 'board-select-hint');
    hint.textContent = selectHint[buildMode]!;
    div.appendChild(hint);
  }

  // ---- DISCARD ----
  if (state.turnPhase === 'DISCARD') {
    // 捨て札UIは「人間が捨てる対象のとき」だけ表示する。
    // CPUが対象の場合に出すと、CPUの手札内訳が漏れ・人間がCPU分を操作できてしまう。
    // LAN ではマスク済み state により discardPid は「自分」に解決する。
    const discardPid = findPendingDiscarder(state);
    if (!discardPid || state.players[discardPid]?.type !== 'human') return null;
    div.appendChild(buildDiscardUI(state, uiPhase, setUIPhase, dispatch));
    return div;
  }

  // ---- 航海者: 金タイル産出の任意資源選択 ----
  // 対象が人間のときだけ表示。CPU分は scheduleAiTurn が自動解決し、解決後に
  // 次の owed（人間含む）へ進む（DISCARD と同じ多人数解決）。
  if (state.turnPhase === 'GOLD') {
    const gpid = state.playerOrder.find(p => ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
    if (!gpid || state.players[gpid]?.type !== 'human') return null;
    if (lanMode && viewerId != null && viewerId !== gpid) return null; // LANは自分の分のみ
    div.appendChild(buildGoldChoiceUI(state, gpid, uiPhase, setUIPhase, dispatch));
    return div;
  }

  // ---- 騎士と商人: 蛮族敗北での都市格下げ（ボタンは出さず、盤面で自分の都市をタップして選ぶ）----
  if (state.turnPhase === 'CITY_DOWNGRADE') {
    const pending = state.pendingCityDowngrade ?? [];
    const me = lanMode && viewerId != null ? viewerId : pending.find(p => state.players[p]?.type === 'human');
    if (!me || !pending.includes(me)) return null;
    // ボタンは廃止し、盤面の光った都市をタップする案内だけ出す（駒で選択する方式）。
    const panel = el('div', 'modal-panel');
    const header = el('div', 'modal-header');
    header.textContent = '⚔ 蛮族に敗北';
    panel.appendChild(header);
    panel.appendChild(Object.assign(el('div', 'modal-section-label'),
      { textContent: '盤面で光っている自分の都市をタップして、1つを開拓地に格下げしてください' }));
    div.appendChild(panel);
    return div;
  }

  // ---- 騎士と商人: 進歩カード上限超過（5枚目）の捨て札選択（多人数解決）----
  if (state.turnPhase === 'PROGRESS_DISCARD') {
    const pending = state.pendingProgressDiscard ?? [];
    const me = lanMode && viewerId != null ? viewerId : pending.find(p => state.players[p]?.type === 'human');
    if (!me || !pending.includes(me)) return null;
    div.appendChild(buildProgressDiscardUI(state, me, dispatch));
    return div;
  }

  // ---- F-05: ペンディング交易 ----
  if (state.pendingTrade !== null) {
    div.appendChild(buildPendingTradeUI(state, pid, dispatch, viewerId, lanMode));
    return div;
  }

  // ---- セカンダリUI（オーバーレイ）----
  if (uiPhase.type === 'robberTarget') {
    div.appendChild(buildRobberTargetUI(state, uiPhase, dispatch));
    return div;
  }
  if (uiPhase.type === 'bankTrade') {
    div.appendChild(buildBankTradeUI(state, pid, player, uiPhase, setUIPhase, dispatch));
    return div;
  }
  if (uiPhase.type === 'yearOfPlenty') {
    div.appendChild(buildYearOfPlentyUI(state, uiPhase, setUIPhase, dispatch));
    return div;
  }
  if (uiPhase.type === 'monopoly') {
    div.appendChild(buildMonopolyUI(uiPhase, setUIPhase, dispatch));
    return div;
  }
  if (uiPhase.type === 'playerTradeOffer') {
    div.appendChild(buildPlayerTradeOfferUI(player, pid, state, uiPhase, setUIPhase, dispatch));
    return div;
  }

  // ここから先は「現在の手番プレイヤー自身」の操作ボタン。
  // CPUの手番ではダイス/建設/交易/ターン終了などを人間に出さない
  // （CPUは内部ロジックで自動進行する）。
  if (player.type !== 'human') return null;
  // LAN: 自分の手番でない端末には操作ボタンを出さない（サーバでも検証）。
  if (lanMode && viewerId != null && viewerId !== pid) return null;

  // ---- PRE_ROLL ----
  if (state.turnPhase === 'PRE_ROLL') {
    div.appendChild(makeBtn('🎲 ダイスを振る', 'btn-primary', false, () => dispatch({ type: 'ROLL_DICE' })));
    // ダイス前は騎士のみ使用可（appendDevCardButtons 内で制御）。LANも対応。
    appendDevCardButtons(div, state, player, setUIPhase, dispatch);
    if (calcVP(state, pid) >= victoryTarget(state)) {
      div.appendChild(makeBtn('🏆 勝利宣言！', 'btn-primary', false, () => dispatch({ type: 'DECLARE_VICTORY' })));
    }
    return div;
  }

  if (state.turnPhase !== 'TRADE_BUILD') return null;

  // ---- 街道建設カード使用中 ----
  if (state.roadBuildingRoadsRemaining > 0) {
    const info = el('div', 'turn-phase-text');
    info.textContent = `🛤 街道建設カード使用中（残り ${state.roadBuildingRoadsRemaining} 本）`;
    div.appendChild(info);
    div.appendChild(modeBtn('🛤 道を置く', 'road', player.remainingRoads > 0, buildMode, setBuildMode));
    div.appendChild(makeBtn('✓ 道路建設を完了', 'btn-end', false, () => dispatch({ type: 'FINISH_ROAD_BUILDING' })));
    return div;
  }

  // ---- TRADE_BUILD ----
  const canRoad  = player.remainingRoads > 0 && hasEnoughResources(player.hand, BUILD_COSTS.road);
  const canSettl = player.remainingSettlements > 0 && hasEnoughResources(player.hand, BUILD_COSTS.settlement);
  const canCity  = player.remainingCities > 0 && hasEnoughResources(player.hand, BUILD_COSTS.city);
  const canDev   = state.devDeck.length > 0 && hasEnoughResources(player.hand, BUILD_COSTS.dev_card);
  // 航海者: 盤面に海タイルがあるときだけ船ボタンを出す（基本盤では非表示）。
  const hasSea   = Object.values(state.tiles).some(t => t.type === 'sea');
  const canShip  = (player.remainingShips ?? 0) > 0 && hasEnoughResources(player.hand, BUILD_COSTS.ship);

  // 建設モード選択中のヒント文（「選択中：光っている場所をタップ」）は操作パネルの
  // レイアウトを崩すため表示しない。配置可能な頂点/辺は盤面側のハイライトで示す。

  // 建設ボタンは絵文字でなくコマ画像/CSSアイコンで（道=CSSバー・開拓地/都市=色つきコマ画像）。
  const ckey = PLAYER_COLOR_KEY[pid] ?? 'red';
  div.appendChild(modeImgBtn(ASSETS.action.road, [costLabel('道', resCostParts(BUILD_COSTS.road))], 'road', canRoad, buildMode, setBuildMode));
  if (hasSea) {
    div.appendChild(modeBtn('🚢 船', 'ship', canShip, buildMode, setBuildMode));
    // 航海者: 動かせる船があるときだけ「船を移動」モードを出す（1ターン1回）。
    if (playerHasMovableShip(state, pid)) {
      div.appendChild(modeBtn('⛵ 船を移動', 'moveShip', true, buildMode, setBuildMode));
    }
    // 船ルールはいつでも見られるよう常時ヘルプを置く（作れても動かせない等の疑問対策）。
    div.appendChild(makeBtn('⛵ 船のルール', 'btn-ship-help', false, () => showShipRulesHelp(state, pid)));
  }
  div.appendChild(modeImgBtn(houseImg(ckey), [costLabel('開拓地', resCostParts(BUILD_COSTS.settlement))], 'settlement', canSettl, buildMode, setBuildMode));
  div.appendChild(modeImgBtn(cityImg(ckey), [costLabel('都市', resCostParts(BUILD_COSTS.city))], 'city', canCity, buildMode, setBuildMode));
  // 発展カードは騎士と商人では使わない（進歩カードに置換）。基本/航海者のみ表示。
  if (!isCk(state)) {
    div.appendChild(makeImgBtn(glyph('ic-cards'), [costLabel('発展カード', resCostParts(BUILD_COSTS.dev_card))], canDev ? 'btn-build' : 'btn-disabled', !canDev,
      () => dispatch({ type: 'BUY_DEV_CARD' })));
  }

  // 騎士と商人: 都市改善・騎士・城壁。
  if (isCk(state)) appendCkBuildSection(div, state, pid, dispatch, buildMode, setBuildMode);

  div.appendChild(makeImgBtn(ASSETS.action.bankTrade, 'バンク交易', 'btn-build', false,
    () => setUIPhase({ type: 'bankTrade', give: null, receive: null })));

  // F-05: プレイヤー間交易（相手が2人以上いる場合のみ）
  if (state.playerOrder.length > 1) {
    // ラベルは「プレイヤー」で改行して2行に（プレイヤー / 間交易）。
    div.appendChild(makeImgBtn(ASSETS.action.playerTrade, ['プレイヤー', document.createElement('br'), '間交易'], 'btn-build', false,
      () => setUIPhase({ type: 'playerTradeOffer', give: makeZeroHand(), receive: makeZeroHand(), targetPids: state.playerOrder.filter(p => p !== pid) as PlayerId[] })));
  }

  // TRADE_BUILD でも発展カードを使用できる（1ターン1枚制限あり）
  appendDevCardButtons(div, state, player, setUIPhase, dispatch);

  if (calcVP(state, pid) >= victoryTarget(state)) {
    div.appendChild(makeBtn('🏆 勝利宣言！', 'btn-primary', false, () => dispatch({ type: 'DECLARE_VICTORY' })));
  }

  // ターン終了は「手番を進める／戻れない操作」なので、建設ボタン群から区切り線＋余白で離して
  // 全幅の独立行にし、まだ建設したいのに誤って押す事故を防ぐ。
  div.appendChild(el('div', 'action-sep'));
  div.appendChild(makeBtn('ターン終了', 'btn-end btn-end-turn', false, () => dispatch({ type: 'END_TURN' })));
  return div;
}

// ============================================================
// メイン描画
// ============================================================

export function renderUI(
  container: HTMLDivElement,
  state: GameState,
  buildMode: BuildMode,
  setBuildMode: (mode: BuildMode) => void,
  uiPhase: UIPhase,
  setUIPhase: (phase: UIPhase) => void,
  dispatch: (action: Action) => void,
  viewerId?: PlayerId,      // LAN対戦: 自分のID（単一端末プレイでは未指定）
  lanMode = false,          // LAN対戦: 操作UIを viewer の手番のみ有効化＋未対応操作を隠す
): void {
  while (container.firstChild) container.removeChild(container.firstChild);

  const pid = state.playerOrder[state.currentPlayerIndex]!;
  const player = state.players[pid]!;
  const color = PLAYER_COLORS[pid] ?? '#aaa';

  // 自分の手番か（LAN=viewerId、単一端末=human）。手番の所在を大きく明示する。
  const selfPid: PlayerId | undefined = viewerId ?? state.playerOrder.find(p => state.players[p]?.type === 'human');
  const isMyTurn = state.phase !== 'GAME_OVER' && selfPid != null && pid === selfPid;
  const isCpuTurn = player.type === 'ai';

  const turnPanel = el('div', `turn-panel${isMyTurn ? ' mine-turn' : ''}`);

  // 手番バナー: 「あなたのターン」/「○○のターン（CPU）」を最上部に大きく表示。
  // 横持ちでも高さを取りすぎないよう CSS 側で1行・コンパクトにする。
  if (state.phase !== 'GAME_OVER') {
    const banner = el('div', `turn-banner ${isMyTurn ? 'mine' : isCpuTurn ? 'cpu' : 'other'}`);
    banner.style.setProperty('--turn-color', color);
    const bdot = el('span', 'turn-banner-dot');
    bdot.style.background = color;
    const btxt = el('span', 'turn-banner-text');
    btxt.textContent = isMyTurn ? 'あなたのターン'
      : isCpuTurn ? `${player.name} のターン（CPU）`
      : `${player.name} のターン`;
    banner.append(bdot, btxt);
    turnPanel.appendChild(banner);
  }

  const infoRow = el('div', 'turn-info-row');
  const dot = el('span', 'color-dot');
  dot.style.background = color;
  infoRow.appendChild(dot);
  const nameEl = el('span', 'turn-player-name');
  nameEl.textContent = player.name;
  infoRow.appendChild(nameEl);
  const vpEl = el('span', 'turn-vp');
  // CPU の内部VP（VPカード込み）は他プレイヤーには非公開
  vpEl.textContent = `★${player.type === 'human' ? calcVP(state, pid) : calcPublicVP(state, pid)}`;
  infoRow.appendChild(vpEl);
  turnPanel.appendChild(infoRow);

  // 手番順表示（現在の手番を強調）。プレイヤーの手札内容は出さない。
  const orderBar = el('div', 'turn-order-bar');
  const orderLbl = el('span', 'turn-order-label');
  orderLbl.textContent = '手番順';
  orderBar.appendChild(orderLbl);
  state.playerOrder.forEach((opId, i) => {
    const op = state.players[opId];
    if (!op) return;
    const chip = el('span', `turn-order-chip${opId === pid ? ' current' : ''}`);
    const cdot = el('span', 'turn-order-dot');
    cdot.style.background = PLAYER_COLORS[opId] ?? '#aaa';
    chip.appendChild(cdot);
    const cname = el('span', 'turn-order-name');
    cname.textContent = op.name;
    chip.appendChild(cname);
    orderBar.appendChild(chip);
    if (i < state.playerOrder.length - 1) {
      const sep = el('span', 'turn-order-sep');
      sep.textContent = '→';
      orderBar.appendChild(sep);
    }
  });
  turnPanel.appendChild(orderBar);

  const phaseEl = el('div', 'turn-phase-text');
  phaseEl.textContent = phaseText(state);
  turnPanel.appendChild(phaseEl);

  if (state.lastDiceRoll) {
    const [d1, d2] = state.lastDiceRoll;
    const diceEl = el('div', 'dice-result');
    const die = (cls: string, n: number): HTMLSpanElement => Object.assign(el('span', `dice-rd ${cls}`), { textContent: String(n) });
    const ev = isCk(state) ? state.lastEventDie : null;
    // 色ゲートのターンは「赤単体＝進歩カード抽選のしきい値」を強調表示する。
    const gateTurn = ev != null && ev !== 'ship';
    // 赤・黄の目を色バッジで → 合計（漢字や「生産8」のチープな表記をやめる）。
    diceEl.append(
      die(`red${gateTurn ? ' emph' : ''}`, d1),
      die('yellow', d2),
      Object.assign(el('span', 'dice-rd-eq'), { textContent: '=' }),
      Object.assign(el('span', 'dice-rd-total'), { textContent: String(d1 + d2) }),
    );
    if (ev === 'ship') {
      diceEl.append(inlineIc(ASSETS.piece.barbarianShip, 'dice-rd-ev'));
    } else if (ev) {
      // 色ゲート: 変な言い回しをやめ「トラックのマーク＋しきい値(=赤の目)」だけを示す（例: [政治]5）。
      diceEl.append(inlineIc(IMP_IMG[ev], 'dice-rd-ev'), Object.assign(el('span', 'dice-rd-thresh'), { textContent: String(d1) }));
    }
    turnPanel.appendChild(diceEl);
  }

  // 称号状況（保持者名＋現在値）＋発展カード山札残数（すべて公開情報）
  const titles = el('div', 'turn-titles');
  const lrHolder = state.longestRoadHolder ? state.players[state.longestRoadHolder] : null;
  const laHolder = state.largestArmyHolder ? state.players[state.largestArmyHolder] : null;
  // 最長交易路: 道の画像アイコン＋保持者（道建設ボタンと同じ絵柄に統一）。
  const t1 = el('span', 'turn-title-item');
  t1.append(inlineIc(ASSETS.action.road, 'inline-ic'), document.createTextNode(lrHolder ? ` 最長 ${lrHolder.name}(${lrHolder.longestRoadLength})` : ' 最長 未獲得'));
  const t3 = el('span', 'turn-title-item');
  if (isCk(state)) {
    // 騎士と商人: 蛮族トラックを 蛮族船画像＋ピップ＋残数 で表示（漢字/絵文字なし）。
    const pos = state.barbarianPosition ?? 0;
    const danger = pos >= CK_BARBARIAN_MAX - 2;
    const t2 = el('span', `turn-title-item barb-track${danger ? ' ck-barb-danger' : ''}`);
    t2.append(inlineIc(ASSETS.piece.barbarianShip, 'barb-ship-ic'));
    const trackEl = el('span', 'barb-pips');
    for (let i = 1; i <= CK_BARBARIAN_MAX; i++) {
      trackEl.append(el('span', `barb-pip${i <= pos ? (danger ? ' on danger' : ' on') : ''}`));
    }
    t2.append(trackEl, Object.assign(el('span', 'barb-count'), { textContent: `${pos}/${CK_BARBARIAN_MAX}` }));
    if ((state.barbarianAttacks ?? 0) > 0) t2.append(Object.assign(el('span', 'barb-atk'), { textContent: `襲来${state.barbarianAttacks}` }));
    if (danger) t2.append(Object.assign(el('span', 'barb-warn'), { textContent: 'まもなく襲来！' }));
    titles.append(t1, t2);
  } else {
    // 最大騎士: 騎士画像＋保持者 / 山札: カードCSSアイコン＋残数。
    const t2 = el('span', 'turn-title-item');
    t2.append(inlineIc(knightImg, 'inline-ic'), document.createTextNode(laHolder ? ` 最大騎士 ${laHolder.name}(${laHolder.knightsPlayed})` : ' 最大騎士 未獲得'));
    t3.append(glyph('ic-cards'), document.createTextNode(` 山札 ${state.devDeck.length}`));
    titles.append(t1, t2, t3);
  }
  turnPanel.appendChild(titles);

  // 直近に起きた公開イベントだけを1行で表示（履歴一覧は出さない）。
  // state.log は視点別マスク済み（buildActionLog が公開情報のみ生成）なので秘匿安全。
  const lastLog = state.log.length > 0 ? state.log[state.log.length - 1] : null;
  if (lastLog) {
    const ev = el('div', 'last-event');
    // ログ中の絵文字（資源/商品/コマ…）を素材画像に置換して表示。
    renderLogMessage(ev, lastLog.message);
    turnPanel.appendChild(ev);
  }

  const btns = buildActionButtons(
    state, player, pid, buildMode, setBuildMode, uiPhase, setUIPhase, dispatch, viewerId, lanMode,
  );
  if (btns) turnPanel.appendChild(btns);

  // LAN対戦で自分の手番でないときは、誰の手番かを明示する。
  // CPU の手番は「操作中」と分かるように表示する（サーバ側で自動進行）。
  if (lanMode && viewerId != null && viewerId !== pid && state.phase !== 'GAME_OVER') {
    const waitEl = el('div', 'lan-turn-wait');
    const compact = isLandscapeCompact();
    // CPU/人間を問わず控えめに「○○ の番」とだけ（操作パネル側の小表示。CPUを強調しない）。
    waitEl.textContent = compact ? `⏳ ${player.name} の番` : `⏳ ${player.name} の番です`;
    turnPanel.appendChild(waitEl);
  }

  // CPU起案交易がある場合はターンパネルに pending trade を表示
  // （buildActionButtons の pendingTrade チェックは pid=CPU で動くが念のため明示）

  container.appendChild(turnPanel);

  // ログ履歴パネルは画面表示しない（スマホ実プレイで邪魔なため UI から削除）。
  // 公開情報ログの生成（buildActionLog）と state.log・視点別配信は従来どおり維持する。

  const allPanels = el('div', 'player-panels');
  for (const pId of state.playerOrder) {
    const p = state.players[pId];
    if (!p) continue;
    allPanels.appendChild(buildPlayerPanel(p, pId as PlayerId, state, pId === pid, dispatch, viewerId));
  }

  // 広い画面・横持ちスマホでは盤面ラッパー(#board-area)の四隅にパネルを配置し、
  // 盤面を大きく見せる。狭い縦画面では従来どおり #ui 内（盤面下の縦並び）にする。
  const boardArea = document.getElementById('board-area');
  // 前回描画でラッパーに残ったパネルを除去（モード切替・再描画対策）
  boardArea?.querySelector('.player-panels')?.remove();
  if (boardArea && useCornerLayout()) {
    boardArea.classList.add('corner-panels');
    boardArea.classList.remove('mini-mode');
    boardArea.appendChild(allPanels);
  } else {
    boardArea?.classList.remove('corner-panels');
    // 四隅レイアウトでない＝パネルが盤面下に回り込む。スマホ縦持ちと同様に
    // 盤面内ミニパネルを表示し（mini-mode）、資源アニメもそこへ着地させる。
    boardArea?.classList.add('mini-mode');
    container.appendChild(allPanels);
  }

  // 盤面四隅のミニプレイヤーパネルを重ねる（資源アニメの着地先）。
  // 実際の表示/非表示は #board-area.mini-mode（=盤面下回り込みレイアウト）で CSS が制御する。
  renderMiniPanels(state, viewerId);

  // ミニパネルの中央寄せ幅を、盤面の実描画幅(px)に同期させる。
  syncBoardDrawWidth();
}

// 盤面の実描画幅(px)を #board-area の CSS 変数 --board-draw-width へ書き出す。
// ミニパネル(mini-mode)の中央寄せ幅はこの変数を参照する（盤面幅の単一の真実）。
// CSS 側に既定値 min(100%, calc(78vh*800/700)) があるため、未設定でも崩れない。
// resize/orientationchange でも呼び、リロードなしで追従させる。
export function syncBoardDrawWidth(): void {
  const boardArea = document.getElementById('board-area');
  const boardEl = document.getElementById('board');
  if (!boardArea || !boardEl) return;
  const w = boardEl.getBoundingClientRect().width;
  if (w > 0) boardArea.style.setProperty('--board-draw-width', `${Math.round(w)}px`);
}

// 四隅レイアウトを使うか: 広い画面 or 横持ちスマホ（横長かつ低い高さ）。
function useCornerLayout(): boolean {
  const w = window.innerWidth, h = window.innerHeight;
  if (w >= CORNER_LAYOUT_MIN_WIDTH) return true;
  return w > h && h <= 600; // landscape phone
}

// 表示幅で文字列を切り詰める（盤上ミニパネル用）。全角=幅2 / 半角英数記号・半角カナ=幅1、
// 合計が maxWidth(=全角4相当=8) を超える直前で停止。省略記号は付けない。
export function clipByWidth(s: string, maxWidth = 8): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const cw = ((code >= 0x20 && code <= 0x7e) || (code >= 0xff61 && code <= 0xff9f)) ? 1 : 2;
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out;
}

// スマホ縦持ち用ミニパネルの四隅割り当て（人数別にバランスよく配置）。
const MINI_CORNERS: Record<number, string[]> = {
  1: ['corner-tl'],
  2: ['corner-tl', 'corner-tr'],
  3: ['corner-tl', 'corner-tr', 'corner-bl'],
  4: ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'],
};

// 盤面四隅のミニプレイヤーパネルを #board-area に重ねて描画する（縦持ちスマホ専用）。
// 「自分=大・他=小」の並びは盤面下の大きい .player-panel 側で表現するため、ミニは四隅に戻す。
// 表示する公開情報のみ: 名前 / VP / 手札枚数 / 現手番 / 最長・最大の小アイコン。
// 他プレイヤーの手札内訳・発展カード内容は出さない（手札は枚数のみ＝公開情報）。
function renderMiniPanels(state: GameState, viewerId?: PlayerId): void {
  const boardArea = document.getElementById('board-area');
  if (!boardArea) return;
  boardArea.querySelector('.mini-panels')?.remove();

  const order = state.playerOrder;
  const corners = MINI_CORNERS[order.length] ?? MINI_CORNERS[4]!;
  const currentPid = state.playerOrder[state.currentPlayerIndex];
  const selfPid = viewerId ?? state.playerOrder.find(p => state.players[p]?.type === 'human');

  const wrap = el('div', 'mini-panels');
  order.forEach((pid, i) => {
    const p = state.players[pid];
    if (!p) return;
    const isSelf = viewerId != null ? pid === viewerId : p.type === 'human';
    const isWinner = state.phase === 'GAME_OVER' && pid === state.winner;
    // 自分・勝者は内部VP（VPカード込み）、他プレイヤーは公開VPのみ（秘匿維持）。
    const vp = (isSelf || isWinner) ? calcVP(state, pid as PlayerId) : calcPublicVP(state, pid as PlayerId);
    // 手札枚数は資源＋商品（騎士と商人）。7の捨て札・強盗の対象枚数と一致させる。
    const handTotal = robbableCardCount(state, pid as PlayerId);
    const isCurrent = pid === currentPid && state.phase !== 'GAME_OVER';
    const mine = pid === selfPid;
    const color = PLAYER_COLORS[pid] ?? '#aaa';

    const panel = el('div', `mini-panel ${corners[i] ?? 'corner-tl'}${isCurrent ? ' current' : ''}${isCurrent && mine ? ' mine' : ''}`);
    panel.dataset.pid = pid;
    panel.style.setProperty('--mini-color', color);

    // 1行目: カラードット + 名前（長い場合は省略表示）
    const row1 = el('div', 'mini-row1');
    const dot = el('span', 'mini-dot');
    dot.style.background = color;
    const name = el('span', 'mini-name');
    name.textContent = clipByWidth(p.name, 8);   // 全角4文字相当で単純切り捨て（省略記号なし）
    row1.append(dot, name);

    // 2行目: ★点数 手札枚数（カードアイコン）＋ 称号アイコン（道=CSS / 騎士=画像）
    const row2 = el('div', 'mini-row2');
    const stat = el('span', 'mini-stat');
    stat.append(
      Object.assign(el('span', 'mini-vp'), { textContent: `★${vp}` }),
      el('span', 'stat-glyph ic-cards'),
      Object.assign(el('span'), { textContent: String(handTotal) }),
    );
    row2.appendChild(stat);
    if (p.hasLongestRoad || p.hasLargestArmy) {
      const badges = el('span', 'mini-badges');
      if (p.hasLongestRoad) { const bdg = el('span', 'mini-badge'); bdg.appendChild(inlineIc(ASSETS.action.road, 'stat-ic')); badges.appendChild(bdg); }
      if (p.hasLargestArmy) { const bdg = el('span', 'mini-badge'); const kn = document.createElement('img'); kn.className = 'stat-ic'; kn.src = ASSETS.knight.basic; kn.alt = ''; kn.draggable = false; bdg.appendChild(kn); badges.appendChild(bdg); }
      row2.appendChild(badges);
    }

    panel.append(row1, row2);
    wrap.appendChild(panel);
  });
  boardArea.appendChild(wrap);
}

// ============================================================
// プレイヤーパネル
// ============================================================

function buildPlayerPanel(
  player: Player,
  pId: PlayerId,
  state: GameState,
  isActive: boolean,
  dispatch: (a: Action) => void,
  viewerId?: PlayerId,
): HTMLDivElement {
  // GAME_OVER時の勝者はVPカード・内訳のみ開示。資源・他発展カードは非公開のまま。
  const isWinner = state.phase === 'GAME_OVER' && pId === state.winner;
  // LAN対戦では viewerId（自分のID）基準で自分のみ全公開。
  // 単一端末プレイ（viewerId 未指定）では従来どおり human=自分。
  const isSelf = viewerId != null ? (pId === viewerId) : (player.type === 'human');

  // スマホ縦持ちでは自分のパネルを大きく上段・他を小さく下段横並びにするため自他を区別する。
  const div = el('div', `player-panel${isSelf ? ' panel-self' : ' panel-opp'}${isActive ? ' active' : ''}${isActive && isSelf && state.phase !== 'GAME_OVER' ? ' your-turn' : ''}${isWinner ? ' winner-glow' : ''}`);
  div.dataset.pid = pId;  // リソースアニメーション用
  const color = PLAYER_COLORS[pId] ?? '#aaa';
  // プレイヤーカラーを反映（控えめ）：暖色寄りの暗いベースに淡い着色＋濃い枠線。
  // 文字可読性を優先するため背景は約82%暗色で、色は淡く乗せる程度。
  div.style.background = `linear-gradient(rgba(18,26,28,0.84), rgba(13,20,23,0.88)), ${color}`;
  div.style.borderColor = `${color}aa`;
  div.style.borderLeftWidth = '4px';
  div.style.boxShadow = '0 6px 18px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,238,206,0.05)';
  if (isActive) {
    // 現在手番は枠を濃く＋発光で明確に区別
    div.style.borderColor = color;
    div.style.boxShadow = `0 6px 20px rgba(0,0,0,0.45), 0 0 14px ${color}66, inset 0 1px 0 rgba(255,238,206,0.07)`;
  }

  // 順位バッジ: 公開VPを基準にする（VP カードは非公開のため）
  const vpByPlayer = state.playerOrder.map(p => ({ pid: p, vp: calcPublicVP(state, p as PlayerId) }));
  vpByPlayer.sort((a, b) => b.vp - a.vp);
  const rank = vpByPlayer.findIndex(x => x.pid === pId) + 1;
  const rankLabel = rank === 1 ? '👑' : `${rank}位`;

  const h3 = el('h3');
  h3.style.borderBottomColor = `${color}88`;  // 見出し下線もプレイヤーカラー
  // 1行目: カラードット + プレイヤー名
  const nameRow = el('span', 'panel-name-row');
  const dot = el('span', 'color-dot');
  dot.style.background = color;
  nameRow.appendChild(dot);
  const nameSpan = el('span', 'panel-name');
  nameSpan.textContent = player.name;
  nameRow.appendChild(nameSpan);
  h3.appendChild(nameRow);
  // 2行目: VP + 順位 + コンパクト統計（開拓地/都市/手札枚数）。1行固定で折り返さない。
  const bd = calcVPBreakdown(state, pId);
  // 手札枚数は資源＋商品（騎士と商人）。7の捨て札・強盗の対象枚数と一致させる。
  const handTotal = robbableCardCount(state, pId);
  const statRow = el('span', 'panel-stat-row');
  const vpSpan = el('span', 'panel-vp');
  // 自分: 内部VP（VPカード込み）、他プレイヤー: 公開VPのみ
  vpSpan.textContent = `★${isSelf ? calcVP(state, pId) : calcPublicVP(state, pId)}`;
  statRow.appendChild(vpSpan);
  const rankEl = el('span', `rank-badge${rank === 1 ? ' rank-1' : ''}`);
  rankEl.textContent = rankLabel;
  statRow.appendChild(rankEl);
  // 開拓地数・都市数・手札枚数（コマは色つき画像・手札はカードCSSアイコン＝絵文字を排除）。
  const ckey = PLAYER_COLOR_KEY[pId] ?? 'red';
  const counts = el('span', 'stat-counts');
  const sChip = statChip(houseImg(ckey), bd.settlements); sChip.title = '開拓地';
  const cChip = statChip(cityImg(ckey), bd.cities); cChip.title = '都市';
  const hChip = statChip(null, handTotal, 'stat-hand', 'ic-cards'); hChip.title = isCk(state) ? '手札（資源＋商品の枚数）' : '手札（枚数）';
  counts.append(sChip, cChip, hChip);
  statRow.appendChild(counts);
  h3.appendChild(statRow);
  div.appendChild(h3);

  // ボーナスVP内訳（最長/最大/VPカード）。開拓地・都市数は stat-row に集約済み。
  // GAME_OVER時は勝者のVPカード枚数も開示する（他プレイヤーは非公開のまま）。
  const showVpCards = (isSelf || isWinner) && bd.vpCards > 0;
  if (bd.lr || bd.la || bd.islandBonus > 0 || showVpCards || bd.tokenVp > 0 || bd.cloth > 0 || bd.wonderLevel > 0) {
    const vpRow = el('div', 'vp-breakdown');
    if (bd.islandBonus > 0) {
      const item = el('span', 'vp-item bonus');
      item.textContent = `🏝+${bd.islandBonus * (state.newIslandBonusVp ?? 2)}`;
      item.title = `新しい島への入植 ${bd.islandBonus}件（+${bd.islandBonus * (state.newIslandBonusVp ?? 2)}点）`;
      vpRow.appendChild(item);
    }
    if (bd.tokenVp > 0) {
      const item = el('span', 'vp-item bonus');
      item.textContent = `🗿+${bd.tokenVp}`;
      item.title = `海辺VPトークン ${bd.tokenVp}個（+${bd.tokenVp}点）`;
      vpRow.appendChild(item);
    }
    if (bd.cloth > 0) {
      const item = el('span', 'vp-item bonus');
      item.textContent = `🧵${bd.cloth}（+${Math.floor(bd.cloth / 2)}）`;
      item.title = `織物 ${bd.cloth}枚（2枚=1点 → +${Math.floor(bd.cloth / 2)}点）`;
      vpRow.appendChild(item);
    }
    if (bd.wonderLevel > 0) {
      const item = el('span', 'vp-item bonus');
      item.textContent = `🏛Lv${bd.wonderLevel}`;
      item.title = `不思議の建設レベル ${bd.wonderLevel}/4`;
      vpRow.appendChild(item);
    }
    if (bd.lr) {
      const item = el('span', 'vp-item bonus');
      item.append(inlineIc(ASSETS.action.road, 'stat-ic'), Object.assign(el('span'), { textContent: '最長+2' }));
      vpRow.appendChild(item);
    }
    if (bd.la) {
      const item = el('span', 'vp-item bonus');
      const kn = document.createElement('img'); kn.className = 'stat-ic'; kn.src = ASSETS.knight.basic; kn.alt = ''; kn.draggable = false;
      item.append(kn, Object.assign(el('span'), { textContent: '最大+2' }));
      vpRow.appendChild(item);
    }
    if (showVpCards) {
      const item = el('span', 'vp-item');
      item.textContent = `★×${bd.vpCards}`;
      item.title = `★カード ${bd.vpCards}点`;
      vpRow.appendChild(item);
    }
    div.appendChild(vpRow);
  }

  // 称号の現在値＋残コマ数（公開情報。未使用発展カードや手札内訳は出さない）
  const meta = el('div', 'panel-meta');
  const lrLen = player.longestRoadLength; // エンジン維持のキャッシュ（calcLongestRoad の再計算は不要）
  const lrItem = el('span', `panel-meta-item${player.hasLongestRoad ? ' held' : ''}`);
  lrItem.append(inlineIc(ASSETS.action.road, 'stat-ic'), Object.assign(el('span'), { textContent: String(lrLen) }));
  lrItem.title = player.hasLongestRoad
    ? `最長交易路 保持中（${lrLen}本）`
    : `最長道路 ${lrLen}本（獲得は${LONGEST_ROAD_MIN}本以上）`;
  meta.appendChild(lrItem);
  // 最大騎士力（Largest Army）は基本ルールのみ。騎士と商人には存在しない（基本の騎士発展カードが
  // 廃され、騎士は盤上コマ＋蛮族防衛になるため）。C&K では誤解を招くので騎士アイコンを出さない。
  if (!isCk(state)) {
    const knItem = el('span', `panel-meta-item${player.hasLargestArmy ? ' held' : ''}`);
    { const kn = document.createElement('img'); kn.className = 'stat-ic'; kn.src = ASSETS.knight.basic; kn.alt = ''; kn.draggable = false; knItem.append(kn, Object.assign(el('span'), { textContent: String(player.knightsPlayed) })); }
    knItem.title = player.hasLargestArmy
      ? `最大騎士力 保持中（騎士${player.knightsPlayed}回）`
      : `騎士使用 ${player.knightsPlayed}回（獲得は${LARGEST_ARMY_MIN}回以上）`;
    meta.appendChild(knItem);
  }
  // 区切りの「·」は分かりにくいとの指摘により廃止（flexのgapで間隔を確保）。
  const pieces = el('span', 'panel-meta-item');
  pieces.textContent = `道${player.remainingRoads} 家${player.remainingSettlements} 都${player.remainingCities}`;
  pieces.title = '残り 道 / 開拓地 / 都市';
  meta.appendChild(pieces);
  div.appendChild(meta);

  // 資源手札UI（自分のみ種別カードを表示。枚数合計は stat-row の 🃏 に集約済み）。
  // 他プレイヤーは秘匿マスクで hand が全0・handCount に枚数が入るため種別は出さない。
  if (isSelf) {
    const resRow = el('div', 'res-card-row');
    for (const r of RESOURCE_TYPES) {
      const count = player.hand[r];
      const card = el('div', `res-card res-${r}${count === 0 ? ' zero' : ''}`);
      const icon = resIconImg(r, 'res-card-img');
      const cnt = el('span', 'res-card-count');
      cnt.textContent = String(count);
      card.appendChild(icon);
      card.appendChild(cnt);
      resRow.appendChild(card);
    }
    div.appendChild(resRow);

    // 騎士と商人: 商品の手札（自分のみ）。
    if (isCk(state)) {
      const comm = player.commodities ?? { coin: 0, cloth: 0, paper: 0 };
      const cRow = el('div', 'ck-comm-row');
      for (const c of COMMODITY_TYPES) {
        const chip = el('span', `ck-comm ck-comm-${c}${comm[c] === 0 ? ' zero' : ''}`);
        chip.appendChild(commIconImg(c, 'ck-comm-img'));
        const n = el('span', 'ck-comm-n'); n.textContent = String(comm[c]);
        chip.appendChild(n);
        cRow.appendChild(chip);
      }
      div.appendChild(cRow);
    }
  }

  // 騎士と商人: 都市改善レベルと騎士・城壁（全員・公開情報）。
  // 「改善」ラベルは省き、騎士は「起動済みの数」だけ表示する（テストプレイ要望）。
  if (isCk(state)) {
    const imp = player.improvements ?? { trade: 0, politics: 0, science: 0 };
    const kActive = Object.values(state.vertices)
      .filter(v => v.knight?.playerId === pId && v.knight.active).length;
    const walls = Object.values(state.vertices)
      .filter(v => v.building?.playerId === pId && (v.building as { wall?: boolean }).wall).length;
    // 改善トラックは短ラベル(交/政/科)を維持。騎士・城壁は絵文字をやめ素材アイコンで表記統一。
    const ck = el('div', 'ck-status');
    const impEl = el('span', 'ck-imp');
    impEl.textContent = `交${imp.trade}/政${imp.politics}/科${imp.science}`;
    impEl.title = '都市改善 交易/政治/科学';
    ck.appendChild(impEl);
    const knEl = el('span', 'ck-stat');
    knEl.title = '起動済みの騎士';
    knEl.append(inlineIc(knightImg, 'stat-ic'), Object.assign(el('span'), { textContent: String(kActive) }));
    ck.appendChild(knEl);
    if (walls > 0) {
      const wlEl = el('span', 'ck-stat');
      wlEl.title = '城壁';
      wlEl.append(inlineIc(ASSETS.piece.cityWall, 'stat-ic'), Object.assign(el('span'), { textContent: String(walls) }));
      ck.appendChild(wlEl);
    }
    div.appendChild(ck);
  }

  // 発展カードUI
  // 他プレイヤーは秘匿マスクで devCards が空・devCardCount に枚数が入る場合がある。
  const devCount = isSelf ? player.devCards.length : (player.devCardCount ?? player.devCards.length);
  if (devCount > 0) {
    const devPanel = el('div', 'dev-card-panel');
    if (isSelf) {
      // 自分: 種別・使用可否を表示
      const groups: Record<string, { total: number; playable: number }> = {};
      for (const card of player.devCards) {
        if (!groups[card.type]) groups[card.type] = { total: 0, playable: 0 };
        groups[card.type]!.total++;
        if (card.purchasedOnTurn < state.globalTurnNumber) groups[card.type]!.playable++;
      }
      for (const [type, { total, playable }] of Object.entries(groups)) {
        const isVP = type === 'victory_point';
        const chipCls = isVP ? 'vp' : playable > 0 ? 'playable' : 'new-card';
        const chip = el('span', `dev-card-chip ${chipCls}`);
        chip.textContent = `${DEV_CARD_CHIP_NAMES[type] ?? type}${total > 1 ? ` ×${total}` : ''}`;
        chip.title = isVP ? '勝利点カード（常時効果）'
          : playable > 0 ? '使用可能（PRE_ROLLに使用）'
          : '今ターン購入（次ターンから使用可）';
        devPanel.appendChild(chip);
      }
    } else {
      // 他プレイヤー: 枚数のみ（種類・VPカード枚数は非表示）
      const chip = el('span', 'dev-card-chip hidden');
      chip.textContent = `🃏 ×${devCount}`;
      devPanel.appendChild(chip);
    }
    div.appendChild(devPanel);
  }

  // 騎士と商人: 自分の進歩カードはパネルにも常時表示（他プレイヤーのターン中でも確認できるように）。
  // タップで効果説明＝詳細を開く。使用は自分のターン(TRADE_BUILD等)のみ有効、他人のターンは閲覧のみ。
  if (isSelf && isCk(state)) {
    const pcards = player.progressCards ?? [];
    if (pcards.length > 0) {
      const myTurn = state.playerOrder[state.currentPlayerIndex] === pId;
      const pcWrap = el('div', 'panel-pc-row');
      const lbl = el('span', 'panel-pc-label'); lbl.textContent = `📜${pcards.length}`;
      pcWrap.appendChild(lbl);
      for (const c of pcards) {
        const can = myTurn && canPlayProgressLoose(state, pId, c.id);
        const icon = ASSETS.progressCard[c.type] ?? ASSETS.cardBack[c.deck];
        const btn = makeImgBtn(icon, '', 'panel-pc-card', false,
          () => showProgressCardInfo(c, can, dispatch, state, pId));
        btn.title = `${PROGRESS_CARD_NAME[c.type]}：${PROGRESS_CARD_DESC[c.type]}`;
        pcWrap.appendChild(btn);
      }
      div.appendChild(pcWrap);
    }
  }

  return div;
}
