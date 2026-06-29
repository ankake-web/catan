// ============================================================
// src/renderer/hexTooltip.ts — ヘックスのホバー説明（取れる資源・出やすさ）
// ============================================================
//
// 盤面のヘックスにマウスを乗せると「地形・産出する資源・数字の出やすさ」を
// ツールチップで表示する。初心者がどのマスから何が取れるかを把握しやすくする。
// 委譲リスナー（#board 1箇所）で実装するため、盤の再描画に強い。タッチ端末は
// ホバーが無いので発火しない（配置タップとの誤爆を避ける）。

import type { GameState, Tile, TileType, ResourceType } from '../types';
import { TILE_RESOURCE_MAP } from '../constants';
import { ASSETS } from '../assets/manifest';

// 資源アイコン画像（ツールチップの「産出：」行に添える）。
const RES_IMG: Record<string, string> = {
  wood: ASSETS.resource.lumber, brick: ASSETS.resource.brick, wool: ASSETS.resource.wool,
  grain: ASSETS.resource.grain, ore: ASSETS.resource.ore,
};

/** このタイルが産出する資源（アイコン表示用）。村/霧/砂漠/海/金は null。 */
function tileResource(tile: Tile, opts?: { isVillage?: boolean }): ResourceType | null {
  if (opts?.isVillage || tile.fog) return null;
  return TILE_RESOURCE_MAP[tile.type]; // 砂漠/海/金 → null
}

const RES_JP: Record<string, string> = {
  wood: '木材', brick: 'レンガ', wool: '羊毛', grain: '麦', ore: '鉄鉱',
};
const TERRAIN_JP: Record<TileType, string> = {
  forest: '森', field: '畑', pasture: '牧草地', hill: '丘', mountain: '山',
  desert: '砂漠', sea: '海', gold: '金タイル',
};
// 2個のサイコロで各数字が出る「組み合わせ数」（=出やすさ）。
const WAYS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const FREQ_LABEL: Record<number, string> = { 5: 'とても出やすい', 4: 'よく出る', 3: 'ふつう', 2: 'やや出にくい', 1: 'まれ' };

/**
 * ヘックスの説明テキスト（行の配列）。純粋関数（DOM非依存）でテスト可能。
 * 1行目=見出し、以降=補足。
 */
export function hexTooltipLines(tile: Tile, opts?: { isVillage?: boolean }): string[] {
  const lines: string[] = [];

  if (opts?.isVillage) {
    lines.push('🏘 村');
    lines.push('航路（船）でつなぐと織物がもらえる');
  } else if (tile.fog) {
    lines.push('❓ 霧（未探検）');
    lines.push('船・道・開拓地で隣に届くと正体が分かる');
  } else if (tile.type === 'gold') {
    lines.push('✨ 金タイル');
    lines.push('数字が出ると好きな資源を1つ選べる');
  } else if (tile.type === 'sea') {
    lines.push('🌊 海');
    lines.push('海に面した辺に船を置ける');
  } else if (tile.type === 'desert') {
    lines.push('🏜 砂漠');
    lines.push('資源は出ない');
  } else {
    const res = TILE_RESOURCE_MAP[tile.type];
    lines.push(`${TERRAIN_JP[tile.type] ?? tile.type}`);
    if (res) lines.push(`産出：${RES_JP[res] ?? res}`);
  }

  // 数字（出やすさ）。村・資源タイルなど数字を持つマスで表示。
  if (tile.number != null && !tile.fog) {
    const ways = WAYS[tile.number] ?? 0;
    const dots = ways > 0 ? '●'.repeat(ways) : '';
    const hot = tile.number === 6 || tile.number === 8 ? ' ⚠' : '';
    lines.push(`数字 ${tile.number}・${FREQ_LABEL[ways] ?? ''}${hot}　${dots}`);
  }

  // 盗賊がいると資源が出ない（人間に分かりやすく）。
  if (tile.hasRobber) lines.push('🦹 盗賊がいる間は資源が出ない');

  return lines;
}

// --- DOM 層（ホバー表示） ---

let tipEl: HTMLDivElement | null = null;

function ensureTip(): HTMLDivElement {
  if (tipEl) return tipEl;
  const el = document.createElement('div');
  el.className = 'hex-tooltip';
  el.setAttribute('role', 'tooltip');
  el.style.display = 'none';
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function positionTip(tip: HTMLDivElement, clientX: number, clientY: number): void {
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + rect.width + 4 > window.innerWidth) x = clientX - rect.width - pad;
  if (y + rect.height + 4 > window.innerHeight) y = clientY - rect.height - pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

/** ツールチップの中身を tileId から組み立てて表示する。タイルが無ければ false。 */
function renderTip(
  tip: HTMLDivElement, getState: () => GameState | null | undefined, id: string | null, clientX: number, clientY: number,
): boolean {
  const st = getState();
  const tile = id ? st?.tiles?.[id] : null;
  if (!tile) { tip.style.display = 'none'; return false; }
  const isVillage = !!(st?.villages && id != null && id in st.villages);
  const lines = hexTooltipLines(tile, { isVillage });
  const res = tileResource(tile, { isVillage });
  tip.innerHTML = '';
  lines.forEach((ln, i) => {
    const d = document.createElement('div');
    d.className = i === 0 ? 'hex-tooltip-title' : 'hex-tooltip-line';
    // 「産出：◯◯」の行には資源アイコンを名称の前に添える。
    if (res && ln.startsWith('産出：')) {
      d.classList.add('hex-tooltip-resline');
      const icon = document.createElement('img');
      icon.className = 'hex-tooltip-resicon';
      icon.src = RES_IMG[res] ?? '';
      icon.alt = '';
      icon.draggable = false;
      const span = document.createElement('span');
      span.textContent = ln;
      d.append(icon, span);
    } else {
      d.textContent = ln;
    }
    tip.appendChild(d);
  });
  tip.style.display = 'block';
  positionTip(tip, clientX, clientY);
  return true;
}

const tileIdAt = (target: EventTarget | null): string | null =>
  (target as Element | null)?.closest?.('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;

const LONG_PRESS_MS = 500;     // タッチ: これ以上の長押しで説明を表示（通常タップ＝配置は妨げない）
const MOVE_CANCEL_PX = 12;     // 押下後この距離動いたらパン扱いで長押し中止
const TOUCH_TIP_MS = 2600;     // タッチで出した説明の自動消去

/**
 * #board にヘックス説明を設置（一度だけ呼ぶ）。state は最新を返す getter で渡す。
 * マウス=ホバーで表示／タッチ=長押しで表示（長押し成立時は直後のタップを握りつぶし誤配置を防ぐ）。
 */
export function installHexTooltip(board: SVGSVGElement, getState: () => GameState | null | undefined): void {
  const tip = ensureTip();
  const hide = (): void => { tip.style.display = 'none'; };

  // タッチ長押しの状態。
  let lpTimer: number | null = null;
  let lpStart: { x: number; y: number } | null = null;
  let lpPointerId: number | null = null;
  let swallowNextClick = false;
  let autoHide: number | null = null;
  const clearLP = (): void => {
    if (lpTimer != null) { clearTimeout(lpTimer); lpTimer = null; }
    lpStart = null; lpPointerId = null;
  };

  board.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      // 長押し待機中に指が動いたら（パン/誤操作）長押しを中止。
      if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > MOVE_CANCEL_PX) clearLP();
      return;
    }
    renderTip(tip, getState, tileIdAt(e.target), e.clientX, e.clientY);
  });

  board.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType !== 'touch') { hide(); return; }   // マウス押下＝ホバー説明を消す
    if (autoHide != null) { clearTimeout(autoHide); autoHide = null; }
    hide();
    if (lpPointerId != null) { clearLP(); return; }       // 2本目の指＝ピンチ/パン → 長押し中止
    const id = tileIdAt(e.target);
    if (!id) return;
    lpStart = { x: e.clientX, y: e.clientY };
    lpPointerId = e.pointerId;
    lpTimer = window.setTimeout(() => {
      lpTimer = null;
      const ok = lpStart != null && renderTip(tip, getState, id, lpStart.x, lpStart.y);
      if (ok) {
        swallowNextClick = true;                          // 長押し成立 → 直後のタップで配置しない
        autoHide = window.setTimeout(hide, TOUCH_TIP_MS);
      }
    }, LONG_PRESS_MS);
  });

  const endTouch = (e: PointerEvent): void => { if (e.pointerType === 'touch') clearLP(); };
  board.addEventListener('pointerup', endTouch);
  board.addEventListener('pointercancel', endTouch);
  board.addEventListener('pointerleave', (e: PointerEvent) => { if (e.pointerType !== 'touch') hide(); });

  // 長押しで説明を出したときの「離した瞬間のクリック」を握りつぶす（配置イベントより先＝キャプチャ）。
  board.addEventListener('click', (e) => {
    if (swallowNextClick) { swallowNextClick = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}
