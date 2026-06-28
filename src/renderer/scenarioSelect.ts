// ============================================================
// src/renderer/scenarioSelect.ts — 盤面シナリオ選択UI（ホーム/ロビー共通）
// ============================================================
//
// 各シナリオを「ミニ盤面プレビュー＋名前＋勝利点」のカードで見せるピッカー。
// 盤面の形（島の数・海・金）が一目で分かる。listScenarios() 由来なので追加シナリオは自動で並ぶ。

import { listScenarios, getScenario, DEFAULT_RECOMMENDED_PLAYERS, type ScenarioId } from '../engine/scenarios';
import { buildBoardGeometry, axialToPixel } from '../engine/board';
import { createRng } from '../engine/setup';

const CATEGORY_LABEL: Record<'basic' | 'seafarers' | 'cities_knights', string> = {
  basic: '基本',
  seafarers: '航海者（船で島へ）',
  cities_knights: '都市と騎士（拡張）',
};
const CATEGORY_ORDER = ['basic', 'seafarers', 'cities_knights'] as const;

// 盤面の実色に合わせたミニプレビュー用タイル色。
const TYPE_COLOR: Record<string, string> = {
  forest: '#2d6a2d', field: '#c8a830', pasture: '#6dbf4a', hill: '#b85c2a',
  mountain: '#888888', desert: '#d4b870', sea: '#1f6f8b', gold: '#ffd11a',
};
const PV = 10; // ミニ六角の中心→頂点

function hexPoints(cx: number, cy: number, s: number): string {
  let p = '';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    p += `${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)} `;
  }
  return p.trim();
}

// 同一シナリオのプレビューは再計算せずクローンを返す（ロビーの再描画で都度作らない）。
const previewCache = new Map<ScenarioId, SVGSVGElement>();

/** シナリオの盤面レイアウトを小さなSVGで描く（タイル色のみ・数字/港なし）。 */
export function renderScenarioPreview(id: ScenarioId): SVGSVGElement {
  const cached = previewCache.get(id);
  if (cached) return cached.cloneNode(true) as SVGSVGElement;

  const sc = getScenario(id);
  const geo = buildBoardGeometry(sc.coords());
  const { tiles } = sc.build(geo, createRng(7)); // classic は乱数だが固定シードで安定
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'scenario-preview');
  svg.setAttribute('aria-hidden', 'true');

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const cells: { cx: number; cy: number; type: string }[] = [];
  for (const t of Object.values(tiles)) {
    const { x, y } = axialToPixel(t.coord, PV);
    cells.push({ cx: x, cy: y, type: t.type });
    minX = Math.min(minX, x - PV); maxX = Math.max(maxX, x + PV);
    minY = Math.min(minY, y - PV * 0.9); maxY = Math.max(maxY, y + PV * 0.9);
  }
  const pad = 2;
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
  for (const c of cells) {
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', hexPoints(c.cx, c.cy, PV * 0.95));
    poly.setAttribute('fill', TYPE_COLOR[c.type] ?? '#555');
    if (c.type === 'sea') { poly.setAttribute('stroke', '#3f93ad'); poly.setAttribute('stroke-width', '0.5'); }
    else { poly.setAttribute('stroke', 'rgba(0,0,0,0.4)'); poly.setAttribute('stroke-width', '0.7'); }
    svg.appendChild(poly);
  }
  previewCache.set(id, svg);
  return svg.cloneNode(true) as SVGSVGElement;
}

export interface ScenarioSelectOptions {
  current: ScenarioId;
  onChange?: (id: ScenarioId) => void;
  /** 参加者ビューなど、表示のみで変更不可にする。 */
  disabled?: boolean;
}

/** シナリオ選択ウィジェット（カードグリッド＋選択中の説明）。要素を返す。 */
export function buildScenarioSelect(opts: ScenarioSelectOptions): HTMLElement {
  const scenarios = listScenarios();
  const wrap = document.createElement('div');
  wrap.className = 'scenario-picker' + (opts.disabled ? ' disabled' : '');
  wrap.dataset.scenario = opts.current;

  const desc = document.createElement('div');
  desc.className = 'scenario-pdesc';
  const setDesc = (id: ScenarioId): void => {
    const s = scenarios.find(x => x.id === id);
    desc.textContent = s ? s.description : '';
  };

  const cardEls = new Map<ScenarioId, HTMLButtonElement>();
  const select = (id: ScenarioId): void => {
    wrap.dataset.scenario = id;
    for (const [cid, el] of cardEls) el.classList.toggle('selected', cid === id);
    setDesc(id);
    opts.onChange?.(id);
  };

  for (const cat of CATEGORY_ORDER) {
    const inCat = scenarios.filter(s => s.category === cat);
    if (inCat.length === 0) continue;
    const head = document.createElement('div');
    head.className = 'scenario-cat';
    head.textContent = CATEGORY_LABEL[cat];
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'scenario-grid';
    for (const s of inCat) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'scenario-card' + (s.id === opts.current ? ' selected' : '');
      card.title = s.description;
      const players = s.recommendedPlayers ?? DEFAULT_RECOMMENDED_PLAYERS;
      card.setAttribute('aria-label', `${s.name}（${s.victoryTarget}点・おすすめ${players}）`);
      card.appendChild(renderScenarioPreview(s.id));

      const main = document.createElement('div');
      main.className = 'scenario-card-main';
      const nm = document.createElement('div');
      nm.className = 'scenario-card-name';
      nm.textContent = s.name.replace('航海者：', '');
      const meta = document.createElement('div');
      meta.className = 'scenario-card-meta';
      const vp = document.createElement('div');
      vp.className = 'scenario-card-vp';
      vp.textContent = `🏆 ${s.victoryTarget}点`;
      const pl = document.createElement('div');
      pl.className = 'scenario-card-players';
      pl.textContent = `👥 ${players}`;
      meta.append(vp, pl);
      main.append(nm, meta);
      card.appendChild(main);

      if (opts.disabled) card.disabled = true;
      else card.addEventListener('click', () => select(s.id));
      cardEls.set(s.id, card);
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
  }

  setDesc(opts.current);
  wrap.appendChild(desc);
  return wrap;
}

/** ウィジェットの現在値を取得。 */
export function getScenarioSelectValue(wrap: HTMLElement): ScenarioId {
  return (wrap.dataset.scenario ?? 'classic') as ScenarioId;
}
