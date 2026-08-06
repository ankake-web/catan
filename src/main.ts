// ============================================================
// src/main.ts — エントリポイント
// ============================================================

import './style.css';
import type { GameState, Action, PlayerId, AiDifficulty, ResourceType, TradeOffer, ResourceHand, TbEventCard } from './types';
import type { PlayerOrderMode } from './engine/setup';
import { makeHand, RESOURCE_TYPES, COMMODITY_TYPES, VP_TABLE, TILE_RESOURCE_MAP, TILE_COMMODITY_MAP, CK_BARBARIAN_MAX, CK_TRACK_NAME, PROGRESS_CARD_NAME, TB_EVENT_NAME, TB_ROAD_REPAIR_COST } from './constants';
import { createInitialGameState } from './engine/createState';
import { getScenario } from './engine/scenarios';
import type { ScenarioId } from './engine/scenarios';
import type { PlayerSpec } from './engine/createState';
import { applyAction, setupGainFor } from './engine/game';
import { findPendingDiscarder, discardCount, getRobberMoveTargets } from './engine/robber';
import { tbEventPendingIds, tbHasDamagedRoad, tbDamagedRoadEdges } from './engine/tbEvents';
import { tbNeutralRoadTargets, tbNeutralSettlementTargets, tbSpendCost, tbCanSpendWindow } from './engine/tbTwo';
import {
  playSE, bgmStart, bgmStop, bgmSetVolume, setBgmTrack, BGM_TRACKS,
  isBgmEnabled, setBgmEnabled, getBgmVolume, getBgmTrack, isSeEnabled, setSeEnabled,
  getSeVolume, setSeVolume,
} from './audio';
import { renderLanLobby } from './net/lanLobby';
import { LanClient } from './net/lanClient';
import { LAN_SYNCED_ACTIONS } from './net/protocol';
import { generateRandomPlayerName, pickCpuNames } from './net/names';
import { attachNameField, savePlayerName } from './net/nameField';
import { saveResume, loadResume, clearResume, saveSnapshot, loadSnapshot } from './net/resume';
import type { ResumeInfo } from './net/resume';
import { canBuildRoad, canBuildShip, canBuildSettlement, canBuildCity, canMoveShip, isShipMovable } from './engine/actions';
import { isKnightMovable, canMoveKnight, robberAdjacentChasableVertexIds, isCk, computeCkProduction, canBuildKnight, canActivateKnight, canUpgradeKnight, plainCityVertexIds, merchantTileIds, inventorTiles, bishopTileIds, diplomatRemovableRoads, deserterTargets, deserterPlacementTargets, medicineSettlements, metropolisCityChoices, improvementTakesMetropolis, craneEligibleTracks, craneTrack, smithKnightTargets, engineerWallCities, intrigueKnightTargets } from './engine/citiesKnights';
import type { CkTrack, CommodityType } from './types';
import type { RollSpec, DiceGLController } from './renderer/diceGL';
import { renderBoard } from './renderer/board';
import type { BoardRenderOptions, BoardViewport } from './renderer/board';
import { installHexTooltip } from './renderer/hexTooltip';
import { beginnerHint, recommendedSetupVertices } from './renderer/beginnerHints';
import { openBeginnerHelp } from './renderer/beginnerHelp';
import { renderUI, syncBoardDrawWidth, showAssetGallery } from './renderer/ui';
import type { UIPhase } from './renderer/ui';
import { attachBoardEvents, attachBoardGestures, resolvePlacePreviewAction, centeredZoom, ZOOM_LIMITS } from './renderer/events';
import { buildScenarioSelect, getScenarioSelectValue } from './renderer/scenarioSelect';
import type { BuildMode } from './renderer/events';
import { chooseAction, evaluateTradeOffer, chooseStealTarget } from './engine/ai';
import type { AiOpts } from './engine/ai';
import { buildActionLog, MAX_LOG_ENTRIES } from './engine/log';
import { calcVP, calcPublicVP, victoryTarget } from './engine/scoring';
import { buildPlayerRecap } from './engine/recap';
import { computeDiceProduction } from './engine/dice';
import { ASSETS, metropolisImg } from './assets/manifest'; // 画像参照は中央マニフェスト経由

// 資源取得アニメ用の画像（手札カードと同じ。既に読込済み＝追加負荷なし）。
const RES_FLY_IMG: Record<ResourceType, string> = {
  wood: ASSETS.resource.lumber, brick: ASSETS.resource.brick, wool: ASSETS.resource.wool, grain: ASSETS.resource.grain, ore: ASSETS.resource.ore,
};
// 商品(紙/布/金貨)取得アニメ用の画像。資源と同じく取得時に飛ばす。
const COM_FLY_IMG: Record<CommodityType, string> = {
  paper: ASSETS.commodity.paper, cloth: ASSETS.commodity.cloth, coin: ASSETS.commodity.coin,
};

// ============================================================
// ホーム画面設定
// ============================================================

type CpuSpeed = 'slow' | 'normal' | 'fast' | 'instant';

interface HomeConfig {
  mode: 'cpu' | 'online';
  playerName: string;
  cpuCount: 1 | 2 | 3;
  cpuDifficulty: AiDifficulty;
  cpuSpeed: CpuSpeed;
  orderMode: PlayerOrderMode;
  // orderMode==='fixed' のときの手番順（参加プレイヤーIDの順列）。
  // 'random' のときは未使用（開始時に毎回シャッフル）。
  playerOrderSpec?: PlayerId[];
  // 盤面シナリオ（未指定＝'classic'）。航海者拡張の段階導入用。
  scenario?: ScenarioId;
}

const PLAYER_IDS: PlayerId[]   = ['player1', 'player2', 'player3', 'player4'];
const PLAYER_COLORS            = ['red', 'blue', 'purple', 'orange'] as const;

// ============================================================
// ホーム画面レンダリング
// ============================================================

function renderHome(
  container: HTMLElement,
  onStart: (cfg: HomeConfig) => void,
  onLanStart: (state: GameState, viewerId: PlayerId, client: LanClient) => void,
  resume?: ResumeInfo,
): void {
  container.innerHTML = '';

  const screen = document.createElement('div');
  screen.className = 'home-screen';
  // タイトル全面背景（島のパノラマ）＋可読性スクリム。cover/中央で縦横どの画面でも歪まず敷く。
  if (ASSETS.bg.title) {
    screen.style.background =
      `linear-gradient(180deg, rgba(8,12,20,0.42), rgba(8,12,20,0.74)), url("${ASSETS.bg.title}") center/cover no-repeat`;
  }

  const title = document.createElement('h1');
  title.className = 'home-title';
  // 絵文字は通常描画のまま、文字「カタン」だけ金グラデにする（background-clip:text が
  // 絵文字を塗りつぶしてしまうのを避けるため span で分離）。
  title.append('🎲 ');
  const titleText = document.createElement('span');
  titleText.className = 'home-title-text';
  titleText.textContent = 'カタン';
  title.appendChild(titleText);
  screen.appendChild(title);

  const card = document.createElement('div');
  card.className = 'home-card';

  // ---- タブ ----
  const tabs = document.createElement('div');
  tabs.className = 'home-tabs';

  // 既定はオンライン（LAN）対戦タブ。並びはオンラインを先頭(左)、CPU対戦を後ろ(右)にする。
  const tabCpu    = createTab('CPU 対戦',      false);
  const tabOnline = createTab('オンライン対戦', true);
  tabs.appendChild(tabOnline);
  tabs.appendChild(tabCpu);
  card.appendChild(tabs);

  // ---- CPU 対戦フォーム ----（既定はオンラインタブなので初期は非表示）
  const cpuForm = document.createElement('div');
  cpuForm.className = 'home-form';
  cpuForm.style.display = 'none';

  const nameField = document.createElement('div');
  nameField.className = 'home-field';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'home-label';
  nameLabel.textContent = 'プレイヤー名';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'home-input';
  const nameRow = document.createElement('div');
  nameRow.className = 'name-input-row';
  // 初期値=保存名 or ランダムなカタカナ名、横に 🎲 再生成ボタン。
  const nameDice = attachNameField(nameInput);
  if (lastConfig?.playerName) nameInput.value = lastConfig.playerName; // 同セッションの再戦は前回名を優先
  nameRow.appendChild(nameInput);
  nameRow.appendChild(nameDice);
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameRow);
  cpuForm.appendChild(nameField);

  const countField = document.createElement('div');
  countField.className = 'home-field';
  const countLabel = document.createElement('label');
  countLabel.className = 'home-label';
  countLabel.textContent = 'CPU 数';
  const countGroup = document.createElement('div');
  countGroup.className = 'home-radio-group';
  const defaultCount = String(lastConfig?.cpuCount ?? 1);
  countGroup.appendChild(createRadioGroup('cpuCount', ['1', '2', '3'], defaultCount));
  countField.appendChild(countLabel);
  countField.appendChild(countGroup);
  cpuForm.appendChild(countField);

  // ---- 初心者モード（操作ヒント＋初期配置のおすすめ表示）。即 localStorage 永続。----
  const begField = document.createElement('div');
  begField.className = 'home-field home-beginner-field';
  const begRow = document.createElement('label');
  begRow.className = 'home-beginner-row';
  const begInput = document.createElement('input');
  begInput.type = 'checkbox';
  begInput.id = 'beginnerToggle';
  begInput.checked = beginnerMode;
  begInput.addEventListener('change', () => setBeginnerMode(begInput.checked));
  const begLabelEl = document.createElement('span');
  begLabelEl.className = 'home-beginner-label';
  begLabelEl.textContent = '🔰 初心者モード';
  begRow.appendChild(begInput);
  begRow.appendChild(begLabelEl);
  const begDesc = document.createElement('div');
  begDesc.className = 'home-beginner-desc';
  begDesc.textContent = '今やることのヒントを表示し、初期配置のおすすめ場所を光らせます。';
  begField.appendChild(begRow);
  begField.appendChild(begDesc);
  cpuForm.appendChild(begField);

  const diffField = document.createElement('div');
  diffField.className = 'home-field';
  const diffLabel = document.createElement('label');
  diffLabel.className = 'home-label';
  diffLabel.textContent = 'CPU の強さ';
  const diffGroup = document.createElement('div');
  diffGroup.className = 'home-radio-group';
  // UIの3択「弱/普通/強」を内部の normal/strong/elite に割り当てる（強さを1段引き上げた）。
  const diffLabelMap: Record<AiDifficulty, string> = { weak: '弱', normal: '弱', strong: '普通', elite: '強' };
  const defaultDiff = diffLabelMap[lastConfig?.cpuDifficulty ?? 'strong'];
  diffGroup.appendChild(createRadioGroup('cpuDiff', ['弱', '普通', '強'], defaultDiff));
  diffField.appendChild(diffLabel);
  diffField.appendChild(diffGroup);
  cpuForm.appendChild(diffField);

  // ---- CPU 速度 ----
  const speedField = document.createElement('div');
  speedField.className = 'home-field';
  const speedLabel = document.createElement('label');
  speedLabel.className = 'home-label';
  speedLabel.textContent = 'CPU の速度';
  const speedGroup = document.createElement('div');
  speedGroup.className = 'home-radio-group';
  // 速度は4段階（ゆっくり/普通/速い/最速）。最速(instant)は演出を大幅に省いてテンポ最優先。
  const speedLabelMap: Record<CpuSpeed, string> = { slow: 'ゆっくり', normal: '普通', fast: '速い', instant: '最速' };
  const defaultSpeed = speedLabelMap[lastConfig?.cpuSpeed ?? 'normal'];
  speedGroup.appendChild(createRadioGroup('cpuSpeed', ['ゆっくり', '普通', '速い', '最速'], defaultSpeed));
  speedField.appendChild(speedLabel);
  speedField.appendChild(speedGroup);
  cpuForm.appendChild(speedField);

  // ---- 盤面（ルール）: 基本 or 航海者の各シナリオ（ドロップダウン＋説明） ----
  const scenarioField = document.createElement('div');
  scenarioField.className = 'home-field';
  const scenarioLabel = document.createElement('label');
  scenarioLabel.className = 'home-label';
  scenarioLabel.textContent = '盤面（ルール）';
  const scenarioSelect = buildScenarioSelect({
    current: lastConfig?.scenario ?? 'classic',
    onChange: (id) => applyScenarioPlayerLimit(id),
  });
  scenarioField.appendChild(scenarioLabel);
  scenarioField.appendChild(scenarioSelect);
  cpuForm.appendChild(scenarioField);

  // ---- プレイヤー順 ----
  const orderField = document.createElement('div');
  orderField.className = 'home-field';
  const orderLabel = document.createElement('label');
  orderLabel.className = 'home-label';
  orderLabel.textContent = 'プレイヤー順';
  const orderGroup = document.createElement('div');
  orderGroup.className = 'home-radio-group';
  const orderDefault = (lastConfig?.orderMode ?? 'random') === 'fixed' ? '指定' : 'ランダム';
  orderGroup.appendChild(createRadioGroup('orderMode', ['ランダム', '指定'], orderDefault));
  orderField.appendChild(orderLabel);
  orderField.appendChild(orderGroup);

  // 指定順 UI（セレクトボックス群）。orderMode==='指定' のときだけ表示。
  const specWrap = document.createElement('div');
  specWrap.className = 'home-order-spec';
  orderField.appendChild(specWrap);
  cpuForm.appendChild(orderField);

  // 指定順の現在状態（常に参加プレイヤーの順列を保つ）
  let specState: PlayerId[] = [];

  const playerDisplayLabel = (id: PlayerId): string => {
    const idx = PLAYER_IDS.indexOf(id);
    // 開始前プレビュー用の汎用ラベル（実際のCPU名はゲーム作成時にランダム決定）。
    return idx === 0 ? 'あなた' : `CPU${idx}`;
  };

  const readCpuCount = (): number => {
    const v = (countGroup.querySelector('input[name="cpuCount"]:checked') as HTMLInputElement | null)?.value ?? '1';
    return parseInt(v, 10) || 1;
  };

  const readOrderMode = (): PlayerOrderMode => {
    const v = (orderGroup.querySelector('input[name="orderMode"]:checked') as HTMLInputElement | null)?.value ?? 'ランダム';
    return v === '指定' ? 'fixed' : 'random';
  };

  // specState からセレクト群を描画（変更時はスワップで重複を防ぐ）
  const renderSpecSelects = (): void => {
    specWrap.innerHTML = '';
    const ids = PLAYER_IDS.slice(0, specState.length);
    specState.forEach((cur, slot) => {
      const row = document.createElement('div');
      row.className = 'home-order-row';
      const slotLbl = document.createElement('span');
      slotLbl.className = 'home-order-slot';
      slotLbl.textContent = `${slot + 1}番手`;
      const sel = document.createElement('select');
      sel.className = 'home-order-select';
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = playerDisplayLabel(id);
        sel.appendChild(opt);
      }
      sel.value = cur;
      sel.addEventListener('change', () => {
        const picked = sel.value as PlayerId;
        const old = specState[slot]!;
        const conflict = specState.indexOf(picked);
        if (conflict !== -1 && conflict !== slot) {
          specState[conflict] = old; // 衝突相手に旧値を渡してスワップ（順列を維持）
        }
        specState[slot] = picked;
        renderSpecSelects();
      });
      row.appendChild(slotLbl);
      row.appendChild(sel);
      specWrap.appendChild(row);
    });
  };

  // CPU 人数に合わせて specState を初期化（前回 spec が人数一致なら流用）
  const rebuildSpec = (): void => {
    const total = readCpuCount() + 1;
    const ids = PLAYER_IDS.slice(0, total);
    let initial: PlayerId[] = [...ids];
    const last = lastConfig?.playerOrderSpec;
    if (last && last.length === total && last.every(p => ids.includes(p))
        && new Set(last).size === total) {
      initial = [...last];
    }
    specState = initial;
    renderSpecSelects();
  };

  const updateSpecVisibility = (): void => {
    specWrap.style.display = readOrderMode() === 'fixed' ? '' : 'none';
  };

  rebuildSpec();
  updateSpecVisibility();

  // CPU 人数変更時：存在しないCPUが順番に残らないよう再構築
  countGroup.addEventListener('change', () => { rebuildSpec(); });
  orderGroup.addEventListener('change', () => { updateSpecVisibility(); });

  // 交易と蛮族「Catan for Two（2人用）」は実プレイヤー2人専用 → CPU数を1に固定し他を無効化。
  // 他のシナリオに戻したら解除する。
  const applyScenarioPlayerLimit = (id: ScenarioId): void => {
    const twoOnly = getScenario(id).rules?.catanForTwo === true;
    const radios = Array.from(countGroup.querySelectorAll<HTMLInputElement>('input[name="cpuCount"]'));
    for (const r of radios) {
      r.disabled = twoOnly && r.value !== '1';
      if (twoOnly && r.value === '1') r.checked = true;
      r.closest('label')?.classList.toggle('radio-disabled', r.disabled);
    }
    if (twoOnly) rebuildSpec(); // 3〜4人の指定順が残らないよう作り直す
  };
  applyScenarioPlayerLimit(lastConfig?.scenario ?? 'classic');

  const startBtn = document.createElement('button');
  startBtn.className = 'home-start-btn';
  startBtn.textContent = 'ゲーム開始';
  cpuForm.appendChild(startBtn);

  // ---- LAN対戦フォーム（同一LAN内の複数端末で人間対戦）。既定タブなので表示。----
  const onlineForm = document.createElement('div');
  onlineForm.className = 'home-form';
  // ロビーUIは専用モジュールが描画する（CPU対戦フォームには非干渉）。
  // resume があれば自動で再接続を試みる（リロード/一時切断からの復帰）。
  renderLanLobby(onlineForm, { onGameStart: onLanStart }, resume);

  card.appendChild(cpuForm);
  card.appendChild(onlineForm);
  screen.appendChild(card);

  // ---- ルール説明（折りたたみ。開始ボタンの下に置き、邪魔しない） ----
  screen.appendChild(buildRulePanel());

  // ---- コマ・カード図鑑（騎士と商人の全画像を名前・説明つきで一覧） ----
  const galleryBtn = document.createElement('button');
  galleryBtn.className = 'gallery-open-btn';
  galleryBtn.textContent = '🖼 コマ・カード図鑑を見る';
  galleryBtn.addEventListener('click', () => showAssetGallery());
  screen.appendChild(galleryBtn);

  container.appendChild(screen);

  // ---- イベント ----

  tabCpu.addEventListener('click', () => {
    tabCpu.classList.add('active');
    tabOnline.classList.remove('active');
    cpuForm.style.display = '';
    onlineForm.style.display = 'none';
  });

  tabOnline.addEventListener('click', () => {
    tabOnline.classList.add('active');
    tabCpu.classList.remove('active');
    onlineForm.style.display = '';
    cpuForm.style.display = 'none';
  });

  startBtn.addEventListener('click', () => {
    // 未入力ならランダムなカタカナ名（機械的な「プレイヤー1」を避ける）。
    const name = nameInput.value.trim() || generateRandomPlayerName();
    savePlayerName(name);

    const countVal = (countGroup.querySelector('input[name="cpuCount"]:checked') as HTMLInputElement | null)?.value ?? '1';
    let cpuCount = (parseInt(countVal, 10) as 1 | 2 | 3) || 1;
    // 2人用カタンは実プレイヤー2人専用（UI で固定済みだが、開始時にも最終クランプ）。
    if (getScenario(getScenarioSelectValue(scenarioSelect)).rules?.catanForTwo) cpuCount = 1;

    const diffVal = (diffGroup.querySelector('input[name="cpuDiff"]:checked') as HTMLInputElement | null)?.value ?? '普通';
    const diffMap: Record<string, AiDifficulty> = { '弱': 'normal', '普通': 'strong', '強': 'elite' };
    const cpuDifficulty: AiDifficulty = diffMap[diffVal] ?? 'strong';

    const speedVal = (speedGroup.querySelector('input[name="cpuSpeed"]:checked') as HTMLInputElement | null)?.value ?? '普通';
    const speedMap: Record<string, CpuSpeed> = { 'ゆっくり': 'slow', '普通': 'normal', '速い': 'fast', '最速': 'instant' };
    const cpuSpeed: CpuSpeed = speedMap[speedVal] ?? 'normal';

    // 盤面シナリオを読み取る（ドロップダウンの値＝ScenarioId）。
    const scenario: ScenarioId = getScenarioSelectValue(scenarioSelect);

    // プレイヤー順設定を読み取る
    const orderMode = readOrderMode();
    const cfg: HomeConfig = { mode: 'cpu', playerName: name, cpuCount, cpuDifficulty, cpuSpeed, orderMode, scenario };
    // 指定順は現在の人数（cpuCount+1）に一致する specState のみ採用。
    // 食い違う場合は spec を渡さず initGameState 側で元順にフォールバック。
    if (orderMode === 'fixed' && specState.length === cpuCount + 1) {
      cfg.playerOrderSpec = [...specState];
    }

    onStart(cfg);
  });
}

// ルール説明の1セクション（見出し＋箇条書き）を生成
function ruleSection(heading: string, bullets: string[]): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'rule-section';
  const h = document.createElement('div');
  h.className = 'rule-heading';
  h.textContent = heading;
  sec.appendChild(h);
  const ul = document.createElement('ul');
  ul.className = 'rule-list';
  for (const b of bullets) {
    const li = document.createElement('li');
    li.textContent = b;
    ul.appendChild(li);
  }
  sec.appendChild(ul);
  return sec;
}

// タイルの色見本（小さな六角形）。盤面の色と一致させ、麦と金などを見分けやすくする。
function legendHex(type: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'legend-hex');
  const poly = document.createElementNS(NS, 'polygon');
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); pts.push(`${(20 + 18 * Math.cos(a)).toFixed(1)},${(20 + 18 * Math.sin(a)).toFixed(1)}`); }
  poly.setAttribute('points', pts.join(' '));
  poly.setAttribute('class', `hex-tile ${type}`);
  // 金は盤面のグラデーション(url)が凡例SVGでは解決しないので、近い光沢ゴールドの単色＋濃縁＋発光を直接指定。
  // 麦(黄土色 #c8a830)よりはっきり明るい黄金色にして見分けやすくする。絵文字は環境差で崩れるため入れない。
  if (type === 'gold') poly.setAttribute('style', 'fill:#ffcf1f;stroke:#7a5200;stroke-width:2.5;filter:drop-shadow(0 0 3px rgba(255,210,40,0.9))');
  svg.appendChild(poly);
  return svg;
}

// タイルの見分け方（色見本のグリッド）。ルール説明に入れて視覚的に分かりやすくする。
function buildTileLegend(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'rule-section';
  const h = document.createElement('div');
  h.className = 'rule-heading';
  h.textContent = '🗺 タイルの見分け方';
  sec.appendChild(h);
  const grid = document.createElement('div');
  grid.className = 'rule-legend';
  // 資源タイルは盤面と同じアイコン画像を表示。金/砂漠/海は資源ではないので画像も絵文字も付けない（六角の色見本で示す）。
  const entries: [string, ResourceType | null, string][] = [
    ['forest', 'wood', '木材'], ['hill', 'brick', 'レンガ'], ['pasture', 'wool', '羊毛'],
    ['field', 'grain', '麦'], ['mountain', 'ore', '鉱石'], ['desert', null, '砂漠（資源なし）'],
    ['gold', null, '金＝好きな資源'], ['sea', null, '海（航海者）'],
  ];
  for (const [type, res, label] of entries) {
    const cell = document.createElement('div');
    cell.className = 'rule-legend-cell';
    cell.appendChild(legendHex(type));
    if (res) {
      const img = document.createElement('img');
      img.className = 'legend-res-img';
      img.src = RES_FLY_IMG[res];
      img.alt = label;
      img.draggable = false;
      cell.appendChild(img);
    }
    const lbl = document.createElement('span');
    lbl.className = 'rule-legend-label';
    lbl.textContent = label;
    cell.appendChild(lbl);
    grid.appendChild(cell);
  }
  sec.appendChild(grid);
  return sec;
}

// TOPページのルール説明（折りたたみ式）
function buildRulePanel(): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'rule-panel';
  const summary = document.createElement('summary');
  summary.className = 'rule-summary';
  summary.textContent = '📖 はじめての人へ（ルール説明）';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'rule-body';
  body.appendChild(ruleSection('🎯 目的', [
    `先に ${VP_TABLE.target} 点（航海者の盤面は 13 点）を取ったプレイヤーが勝ち。`,
    '開拓地・都市・最長交易路・最大騎士力・勝利点カードで点を集める。',
  ]));
  body.appendChild(buildTileLegend());
  body.appendChild(ruleSection('🔁 ターンの流れ', [
    '① サイコロを振る',
    '② 出た数字のタイルから資源をもらう',
    '③ 交易・建設をする',
    '④ ターン終了',
  ]));
  body.appendChild(ruleSection('🌲 資源', [
    '木・レンガ・羊・麦・鉱石を集める。',
    'タイルの数字が出ると、隣に開拓地/都市を持つ人が資源を得る。',
    '開拓地は1個、都市は2個もらえる。',
  ]));
  body.appendChild(ruleSection('🏠 建設コスト', [
    '道：木＋レンガ',
    '開拓地：木＋レンガ＋羊＋麦',
    '都市：麦2＋鉱石3',
    '発展カード：羊＋麦＋鉱石',
  ]));
  body.appendChild(ruleSection('🦹 7と盗賊', [
    '7が出ると資源は出ない。',
    '手札8枚以上の人は半分捨てる。',
    '盗賊を動かして、隣接する相手から1枚奪える。',
    '盗賊がいるタイルからは資源が出ない。',
  ]));
  body.appendChild(ruleSection('🤝 交易', [
    '他プレイヤーと資源を交換できる。',
    '銀行（4:1）や港（3:1 / 2:1）とも交換できる。',
    '同じ資源同士の交換はできない。',
  ]));
  body.appendChild(ruleSection('🃏 発展カード', [
    '騎士・街道建設・年の豊穣（発見）・独占・勝利点カードがある。',
    'サイコロ前に使えるのは騎士だけ。他はサイコロ後に使う。',
    '勝利点カードは隠し点（自分だけ見える）。',
  ]));
  body.appendChild(ruleSection('🏆 点数', [
    '開拓地：1点 / 都市：2点',
    '最長交易路：2点（道5本以上で最長の人）',
    '最大騎士力：2点（騎士3回以上で最多の人）',
    '勝利点カード：1点',
  ]));
  body.appendChild(ruleSection('⛵ 航海者（航海者・群島の盤面）', [
    '盤面が海で島に分かれている。新しい島へは「船」で渡る。',
    '船：木＋羊。海に面した辺に置く。道と船は自分の建物でつながる。「⛵船を移動」で行き止まりの船を1ターン1回動かせる。',
    '金タイル：数字が出ると、木・レンガ・羊・麦・鉱石から好きな資源を選べる（開拓地1・都市2）。麦（黄土色）と違い、明るい金色が目印。',
    '新しい島に最初に開拓地を建てると +2点（島ボーナス）。',
    '7のとき、陸タイルをタップ＝盗賊、海タイルをタップ＝海賊（隣の船から1枚奪い、その海での船建設を封じる）。',
    '海岸の港（3:1 / 2:1）も使える。航海者の盤面は 13点で勝ち。',
  ]));
  body.appendChild(ruleSection('⚔ 都市と騎士（上級者向け・13点で勝ち）', [
    '基本ルールに「商品・都市の発展・騎士・蛮族の襲来」が加わる拡張。',
    '商品：都市が建つ地形のうち 森＝紙・牧草＝布・山＝金貨 を1個ずつ追加で産む（資源とは別の手札）。',
    '都市の発展（交易・政治・科学の3系統）：商品を払ってレベルアップ。Lv3で特典、Lv4で都市が「メトロポリス」になり +4点。',
    '騎士：兵士のコマ。建てて麦で起動し、移動・敵騎士の押し出し・強盗の追い払いに使える。',
    '蛮族の襲来：船のイベントで蛮族が近づき、満タンで攻めてくる。起動した騎士の合計が盤上の都市数以上なら防衛成功。足りないと都市が1つ開拓地に格下げ。',
    '進歩カード：交易・政治・科学のイベントで引く特殊カード（手札は最大4枚）。発展レベルが高い色ほど引きやすい。',
    'この盤面では盗賊は資源だけでなく商品も奪い、手札の上限判定（7の捨て札）も資源＋商品の合計で数える。',
  ]));
  body.appendChild(ruleSection('💡 操作のコツ', [
    '最初は資源が多く出そうな数字の近くに開拓地を置く。',
    '6・8は出やすい数字。',
    '港を使うと資源を交換しやすい。',
    '道を伸ばして開拓地を増やし、都市にすると資源が増える。',
  ]));

  details.appendChild(body);
  return details;
}

function createTab(label: string, active: boolean): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'home-tab' + (active ? ' active' : '');
  btn.textContent = label;
  return btn;
}

function createRadioGroup(name: string, options: string[], defaultVal: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  options.forEach(opt => {
    const wrapper = document.createElement('div');
    wrapper.className = 'home-radio-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = opt;
    input.id = `${name}_${opt}`;
    if (opt === defaultVal) input.checked = true;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = opt;
    wrapper.appendChild(input);
    wrapper.appendChild(label);
    frag.appendChild(wrapper);
  });
  return frag;
}

// ============================================================
// GameState 初期化
// ============================================================

function initGameState(cfg: HomeConfig): GameState {
  // 盤面シナリオ: cfg 優先。未指定なら URL の ?scenario=（開発/動作確認用フック）。
  const urlScenario0 = new URLSearchParams(window.location.search).get('scenario') as ScenarioId | null;
  const scenarioId = cfg.scenario ?? urlScenario0 ?? 'classic';
  // 2人用カタン（catanForTwo）は実プレイヤー2人専用。?scenario= 直指定などで人数が合わない
  // 場合もここで 2人（人間1+CPU1）に丸める（createInitialGameState は不一致を例外にする）。
  const totalPlayers = getScenario(scenarioId).rules?.catanForTwo ? 2 : cfg.cpuCount + 1;
  // CPU 名はランダムな3文字名を重複なく割り当て（人間名とも重複回避）。state に保存され
  // 以降は固定（render 毎の再抽選はしない）。表示名のみでCPUロジックには関与しない。
  const cpuNames = pickCpuNames(cfg.cpuCount, [cfg.playerName]);
  // プレイヤー実体（誰が人間/CPUか）は ID 固定で生成する。手番順とは独立。
  const specs: PlayerSpec[] = [];
  for (let i = 0; i < totalPlayers; i++) {
    const isHuman = i === 0;
    specs.push({
      id: PLAYER_IDS[i]!,
      color: PLAYER_COLORS[i]!,
      name: isHuman ? cfg.playerName : cpuNames[i - 1]!,
      type: isHuman ? 'human' : 'ai',
      ...(isHuman ? {} : { aiDifficulty: cfg.cpuDifficulty }),
    });
  }
  // 既定 'classic' は従来と同一。未知IDは createInitialGameState 側で classic にフォールバック。
  // 手番順: ランダム=毎回シャッフル / 指定=spec を検証して採用（不整合なら元順）。
  return createInitialGameState(specs, cfg.orderMode, cfg.playerOrderSpec, undefined, scenarioId);
}

// ============================================================
// 有効配置ハイライト計算
// ============================================================

function computeHighlights(state: GameState, mode: BuildMode): BoardRenderOptions {
  const pid = state.playerOrder[state.currentPlayerIndex]!;
  const opts: BoardRenderOptions = {};

  if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
    if (state.setupSubPhase === 'PLACE_SETTLEMENT') {
      const valid = new Set(
        Object.keys(state.vertices).filter(vid => canBuildSettlement(state, pid, vid)),
      );
      opts.validVertexIds = valid;
      // 初心者モード: 出やすさ＋資源の多様性で上位の地点に⭐を出す。
      if (beginnerMode) opts.recommendedVertexIds = recommendedSetupVertices(state, valid);
    } else if (state.setupSubPhase === 'PLACE_ROAD') {
      opts.validEdgeIds = new Set(
        Object.keys(state.edges).filter(eid => canBuildRoad(state, pid, eid)),
      );
      // 航海者: 海岸の開拓地は道の代わりに船も置ける → 海上候補も光らせて道/船を選ばせる。
      opts.validShipEdgeIds = new Set(
        Object.keys(state.edges).filter(eid => canBuildShip(state, pid, eid)),
      );
    }
    return opts;
  }

  if (state.phase === 'MAIN') {
    if (state.turnPhase === 'ROBBER') {
      // 盗賊(陸)＋海賊(海)の移動先。陸側の合法集合は getRobberMoveTargets に一元化
      // （現在地除外・S5 の数字ヘックス限定・T&B 親切な盗賊の2VP保護と砂漠フォールバック）。
      const landTargets = new Set(getRobberMoveTargets(state));
      // 航海者: 盗賊も海賊も動かせる時は、先に選んだ方(robberPiece)のタイルだけ光らせる。
      // 未選択(null)なら何も光らせず、picker で選ばせる。片方しか無い盤は従来どおり両方判定。
      const avail = robberPieceAvail(state);
      const both = avail.robber && avail.pirate;
      const showLand = both ? robberPiece === 'robber' : avail.robber;
      const showSea = both ? robberPiece === 'pirate' : avail.pirate;
      opts.validTileIds = new Set(
        Object.keys(state.tiles).filter(tid => {
          const t = state.tiles[tid]!;
          // 海タイルは海賊の移動先（現在地は除外）。
          if (t.type === 'sea') return showSea && tid !== state.piratePosition;
          return showLand && landTargets.has(tid);
        }),
      );
      return opts;
    }

    // 交易と蛮族「Catan for Two」: 中立コマの配置待ち。置く中立(色)が決まっている時だけ
    // その中立の合法位置を光らせる（両中立に置ける間はバーで選ぶまで光らせない）。
    if (state.turnPhase === 'TB_NEUTRAL') {
      const owner = tbNeutralActingOwner(state);
      if (owner) {
        if (state.tbNeutralPending === 'settlement') {
          opts.validVertexIds = new Set(tbNeutralSettlementTargets(state, owner));
        } else {
          opts.validEdgeIds = new Set(tbNeutralRoadTargets(state, owner));
        }
      }
      return opts;
    }

    // 騎士と商人: 都市格下げは、対象（LAN=viewer/ローカル=人間）の平の都市を赤く光らせて盤面でタップ選択。
    if (state.turnPhase === 'CITY_DOWNGRADE') {
      const pending = state.pendingCityDowngrade ?? [];
      const me = selfPlayerId();
      const acting = me && pending.includes(me) ? me : pending.find(p => state.players[p]?.type === 'human');
      if (acting) opts.downgradeVertexIds = new Set(plainCityVertexIds(state, acting));
      return opts;
    }

    // 交易と蛮族イベント「地震」: 対象（LAN=viewer/ローカル=人間）の未損傷の道を光らせて盤面でタップ選択。
    if (state.turnPhase === 'EVENT_DAMAGE') {
      const pending = state.tbPendingEventDamage ?? [];
      const me = selfPlayerId();
      const acting = me && pending.includes(me) ? me : pending.find(p => state.players[p]?.type === 'human');
      if (acting) {
        opts.validEdgeIds = new Set(Object.keys(state.edges).filter(eid => {
          const r = state.edges[eid]!.road;
          return r?.playerId === acting && !r.damaged;
        }));
      }
      return opts;
    }

    if (state.turnPhase === 'TRADE_BUILD') {
      if (mode === 'road') {
        opts.validEdgeIds = new Set(
          Object.keys(state.edges).filter(eid => canBuildRoad(state, pid, eid)),
        );
        // 航海者: 街道建設カード使用中は船も無料配置できる（道2/船2/道1+船1）→ 海上候補も光らせる。
        if (state.roadBuildingRoadsRemaining > 0) {
          opts.validShipEdgeIds = new Set(
            Object.keys(state.edges).filter(eid => canBuildShip(state, pid, eid)),
          );
        }
      } else if (mode === 'ship') {
        opts.validShipEdgeIds = new Set(
          Object.keys(state.edges).filter(eid => canBuildShip(state, pid, eid)),
        );
      } else if (mode === 'moveShip') {
        // 航海者・船移動: 未選択なら動かせる自分の船、選択済なら（空きの）移動先を光らせる。
        opts.validShipEdgeIds = moveShipFrom == null
          ? new Set(Object.keys(state.edges).filter(eid =>
              state.edges[eid]!.ship?.playerId === pid && isShipMovable(state, pid, eid)))
          : new Set(Object.keys(state.edges).filter(eid => canMoveShip(state, pid, moveShipFrom!, eid)));
      } else if (mode === 'settlement') {
        opts.validVertexIds = new Set(
          Object.keys(state.vertices).filter(vid => canBuildSettlement(state, pid, vid)),
        );
      } else if (mode === 'city') {
        opts.validVertexIds = new Set(
          Object.keys(state.vertices).filter(vid => canBuildCity(state, pid, vid)),
        );
      } else if (mode === 'moveKnight') {
        // 騎士と商人・騎士移動: 未選択なら動かせる自分の起動騎士、選択済なら移動先頂点を光らせる。
        opts.validVertexIds = moveKnightFrom == null
          ? new Set(Object.keys(state.vertices).filter(vid => isKnightMovable(state, pid, vid)))
          : new Set(Object.keys(state.vertices).filter(vid => canMoveKnight(state, pid, moveKnightFrom!, vid)));
      } else if (mode === 'chaseRobber') {
        // 騎士と商人・強盗追い払い: 強盗に隣接した自分のアクティブ騎士頂点を光らせる。
        opts.validVertexIds = new Set(robberAdjacentChasableVertexIds(state, pid));
      } else if (mode === 'buildKnight') {
        // 騎士と商人・騎士の手動配置: 建てられる合法頂点を光らせる。
        opts.validVertexIds = new Set(Object.keys(state.vertices).filter(vid => canBuildKnight(state, pid, vid)));
      } else if (mode === 'activateKnight') {
        // 騎士と商人・騎士の手動起動: 起動できる自分の騎士頂点を光らせる。
        opts.validVertexIds = new Set(Object.keys(state.vertices).filter(vid => canActivateKnight(state, pid, vid)));
      } else if (mode === 'upgradeKnight') {
        // 騎士と商人・騎士の手動昇格: 昇格できる自分の騎士頂点を光らせる。
        opts.validVertexIds = new Set(Object.keys(state.vertices).filter(vid => canUpgradeKnight(state, pid, vid)));
      } else if (mode === 'placeMerchant') {
        // 騎士と商人・商人カード: 自分の建物に隣接する資源タイルを光らせて盤面で選ばせる。
        opts.validTileIds = new Set(merchantTileIds(state, pid));
      } else if (mode === 'inventorSwap') {
        // 騎士と商人・発明家: 入替可能タイルを光らせる。1枚目選択後はそれ以外を入替先候補に。
        const all = inventorTiles(state);
        opts.validTileIds = new Set(inventorFirstTile == null ? all : all.filter(t => t !== inventorFirstTile));
        if (inventorFirstTile) opts.selectedTileId = inventorFirstTile; // 1枚目を青で確定強調
      } else if (mode === 'placeBishop') {
        // 騎士と商人・僧正: 盗賊を置ける陸タイルを光らせる。
        opts.validTileIds = new Set(bishopTileIds(state));
      } else if (mode === 'selectDiplomatRoad') {
        // 騎士と商人・外交官: 撤去できる相手の端の道を光らせる。
        opts.validEdgeIds = new Set(diplomatRemovableRoads(state, pid));
      } else if (mode === 'selectDeserterKnight') {
        // 騎士と商人・脱走兵: 1手目=消せる相手の騎士 / 2手目=獲得騎士の設置先を光らせる。
        opts.validVertexIds = new Set(
          deserterRemoveVid == null ? deserterTargets(state, pid) : deserterPlacementTargets(state, pid),
        );
        if (deserterRemoveVid) opts.selectedVertexId = deserterRemoveVid; // 消す騎士を確定強調
      } else if (mode === 'selectMedicineSettlement') {
        // 騎士と商人・医術: 都市化できる自分の開拓地を光らせる。
        opts.validVertexIds = new Set(medicineSettlements(state, pid));
      } else if (mode === 'selectMetropolis') {
        // 騎士と商人・メトロポリス: 化ける自分の都市を光らせて盤面で選ばせる。
        opts.validVertexIds = new Set(metropolisCityChoices(state, pid));
      } else if (mode === 'selectSmithKnight') {
        // 騎士と商人・鍛冶屋: 昇格できる自分の騎士を光らせる。1体目選択後はそれ以外を2体目候補に。
        const all = smithKnightTargets(state, pid);
        opts.validVertexIds = new Set(smithFirstKnight == null ? all : all.filter(v => v !== smithFirstKnight));
        if (smithFirstKnight) opts.selectedVertexId = smithFirstKnight; // 1体目を確定強調
      } else if (mode === 'selectEngineerCity') {
        // 騎士と商人・技師: 城壁を建てられる自分の都市を光らせる。
        opts.validVertexIds = new Set(engineerWallCities(state, pid));
      } else if (mode === 'selectWallCity') {
        // 騎士と商人・城壁建設: 城壁を建てられる自分の都市を光らせる（候補は技師と同じ）。
        opts.validVertexIds = new Set(engineerWallCities(state, pid));
      } else if (mode === 'selectIntrigueKnight') {
        // 騎士と商人・陰謀: 退去させられる敵騎士（自分の道/船に隣接）を光らせる。
        opts.validVertexIds = new Set(intrigueKnightTargets(state, pid));
      } else if (mode === 'idle' && state.tbEventCards && tbHasDamagedRoad(state, pid)) {
        // 交易と蛮族イベント「地震」: 自分の損傷した道を光らせる（タップで修理・レンガ1木1）。
        opts.validEdgeIds = new Set(tbDamagedRoadEdges(state, pid));
      }
    }
  }

  return opts;
}

// ============================================================
// DOM 取得（モジュール起動時に一度だけ）
// ============================================================

const homeDiv   = document.getElementById('home')       as HTMLDivElement;
const gameTitle = document.getElementById('game-title') as HTMLHeadingElement;
const appDiv    = document.getElementById('app')        as HTMLDivElement;
const gameNav   = document.getElementById('game-nav')   as HTMLDivElement;
const svgBoard  = document.getElementById('board')      as unknown as SVGSVGElement;
const uiDiv     = document.getElementById('ui')         as HTMLDivElement;

if (!homeDiv || !gameTitle || !appDiv || !gameNav || !svgBoard || !uiDiv) {
  throw new Error('DOM elements not found');
}

// ============================================================
// アプリ状態
// ============================================================

let state!: GameState;
let buildMode: BuildMode = 'idle';
// 航海者・船移動モードで選択中の移動元の辺ID（未選択は null）。
let moveShipFrom: string | null = null;
// 騎士と商人・騎士移動モードで選択中の移動元頂点ID（未選択は null）。
let moveKnightFrom: string | null = null;
function setMoveKnightFrom(vid: string | null): void { moveKnightFrom = vid; redraw(); }
// 騎士と商人・発明家(inventorSwap)で1枚目に選んだタイルID（未選択は null）。2枚目をタップで入替。
let inventorFirstTile: string | null = null;
function setInventorFirst(tid: string | null): void { inventorFirstTile = tid; redraw(); }
// 騎士と商人・鍛冶屋(selectSmithKnight)で1体目に選んだ騎士頂点ID（未選択は null）。2体目をタップで昇格。
let smithFirstKnight: string | null = null;
function setSmithFirst(vid: string | null): void { smithFirstKnight = vid; redraw(); }
// 脱走兵: 1手目に選んだ「消す相手の騎士」頂点（非null＝2手目＝獲得騎士の設置先選択中）。
let deserterRemoveVid: string | null = null;
function setDeserterRemove(vid: string | null): void { deserterRemoveVid = vid; redraw(); }
// メトロポリス手動選択中に「今+1する都市改善ツリー」と、その改善の発生源（改善ボタン or クレーンカード）を控える。
// 候補（自分の平の都市）が2つ以上ある時に盤面タップで化ける都市を選ばせる。
//   via==='improvement': 都市タップで BUILD_IMPROVEMENT を再送。
//   via==='crane':       都市タップで PLAY_PROGRESS(crane) を craneMetropolisVertexId 付きで再送。
let pendingMetropolis: { track: CkTrack; via: 'improvement' } | { track: CkTrack; via: 'crane'; cardId: string } | null = null;
let uiPhase: UIPhase = { type: 'idle' };
// 強盗/海賊を「先に移動」してから相手選択させる時、移動先をプレビュー描画したタイル。
// 相手確定(MOVE_ROBBER/MOVE_PIRATE)時の二重スライドを抑止するためにも使う。
let robberPreviewedTile: string | null = null;
// 航海者: 7/騎士でコマを動かす時、盗賊(陸)と海賊(海)のどちらを動かすか先に選ばせる。
// null=未選択（両方動かせる時は先に選ぶまで盤面は光らせない）。ROBBER フェーズ外では常に null に戻す。
let robberPiece: 'robber' | 'pirate' | null = null;
function setRobberPiece(p: 'robber' | 'pirate' | null): void { robberPiece = p; redraw(); }
// 盗賊(陸)・海賊(海)がそれぞれ「動かせる先があるか」。両方 true の時だけ先に選ばせる。
function robberPieceAvail(s: GameState): { robber: boolean; pirate: boolean } {
  const robber = getRobberMoveTargets(s).length > 0;
  const pirate = s.piratePosition != null
    && Object.values(s.tiles).some(t => t.type === 'sea' && t.id !== s.piratePosition);
  return { robber, pirate };
}

// 交易と蛮族「Catan for Two」: TB_NEUTRAL でどちらの中立に置くかの事前選択。
// null=未選択（両中立に置ける時は選ぶまで盤面を光らせない）。TB_NEUTRAL 外では常に null に戻す。
let tbNeutralChoice: PlayerId | null = null;
function setTbNeutralChoice(p: PlayerId | null): void { tbNeutralChoice = p; redraw(); }
// 配置できる中立の一覧（現在の pending 種別で合法位置を持つ中立のみ）。
function tbNeutralAvail(s: GameState): PlayerId[] {
  return (s.tbNeutralPlayerIds ?? []).filter(n => s.tbNeutralPending === 'settlement'
    ? tbNeutralSettlementTargets(s, n).length > 0
    : tbNeutralRoadTargets(s, n).length > 0);
}
// いま配置操作の対象になっている中立。片方しか置けなければ自動でその中立、両方なら選択済みのもの。
function tbNeutralActingOwner(s: GameState): PlayerId | null {
  if (s.turnPhase !== 'TB_NEUTRAL') return null;
  const avail = tbNeutralAvail(s);
  if (avail.length === 1) return avail[0]!;
  if (tbNeutralChoice && avail.includes(tbNeutralChoice)) return tbNeutralChoice;
  return null;
}
let lastConfig: HomeConfig | null = null;

// ---- LAN対戦（サーバ権威）----
// netMode 時は state はサーバ配信のマスク済み state。CPU スケジューリングや
// ローカル applyAction は一切行わず、操作UIも出さない（MVP1-2: 情報表示のみ）。
let netMode = false;
let viewerPlayerId: PlayerId | null = null;
let lanClient: LanClient | null = null;

// AI タイムアウト世代管理（世代が変わった setTimeout は無視）
let gameGeneration = 0;

// ゲーム画面がアクティブか。ホーム復帰後に resize/演出残骸経由で redraw→
// ウォッチドッグ/CPUループが再武装され、放棄したゲームが裏で進む「ゾンビ進行」を防ぐ。
let inGame = false;

// 演出速度の一元参照。lastConfig はCPU対戦専用の設定なので、LAN対戦では参照しない
// （前回CPU対戦の「最速」がLANに漏れて全演出が消える等の混線を防ぐ）。
function fxSpeed(): CpuSpeed {
  return netMode ? 'normal' : (lastConfig?.cpuSpeed ?? 'normal');
}

// 初心者モード（localStorage保存）: 局面ガイド（助言バナー）＋初期配置のおすすめ地点を表示。
const BEGINNER_KEY = 'catan_beginner';
let beginnerMode: boolean = (() => {
  try { return localStorage.getItem(BEGINNER_KEY) === '1'; } catch { return false; }
})();
function setBeginnerMode(v: boolean): void {
  beginnerMode = v;
  try { localStorage.setItem(BEGINNER_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// サイコロ演出の速さ設定（CPU速度とは独立・localStorage保存）。off=演出なしで即結果。
type DiceFxMode = 'off' | 'slow' | 'normal' | 'fast';
const DICE_FX_KEY = 'catan_dice_fx';
function diceFxMode(): DiceFxMode {
  try { const v = localStorage.getItem(DICE_FX_KEY); if (v === 'off' || v === 'slow' || v === 'normal' || v === 'fast') return v; } catch { /* ignore */ }
  return 'normal';
}
function setDiceFxMode(m: DiceFxMode): void {
  try { localStorage.setItem(DICE_FX_KEY, m); } catch { /* ignore */ }
}
const DICE_FX_LABELS: Record<DiceFxMode, string> = { off: 'OFF（即結果）', slow: 'ゆっくり', normal: '普通', fast: '速い' };

// アニメーション表示の設定（資源飛行・サイコロ回転・カード大表示・建設ポップ・紙吹雪等）。
// 既定ON＝端末のOS「動きを減らす(prefers-reduced-motion)」設定に関係なく常に演出を出す。
// オンライン対戦で各プレイヤーの端末のOS設定差により「出る端末/出ない端末」がバラつく
// （省電力モードやアクセシビリティで知らぬ間にOFFになっている）問題への対策。OFFで省略可。
type AnimFxMode = 'on' | 'off';
const ANIM_FX_KEY = 'catan_anim_fx';
function animFxMode(): AnimFxMode {
  try { const v = localStorage.getItem(ANIM_FX_KEY); if (v === 'on' || v === 'off') return v; } catch { /* ignore */ }
  return 'on'; // 既定ON: OSの reduced-motion を無視して演出を出す（全端末で箱出し表示）
}
function setAnimFxMode(m: AnimFxMode): void {
  try { localStorage.setItem(ANIM_FX_KEY, m); } catch { /* ignore */ }
  applyReduceMotionClass();
}
const ANIM_FX_LABELS: Record<AnimFxMode, string> = { on: 'ON', off: 'OFF' };
// CSS側の演出抑制（@media ではなく html.reduce-motion クラスで判定）を、アプリ内設定に同期する。
// 既定ON＝クラスなし＝OSの reduced-motion に関係なく全演出を出す。OFF時のみクラスを付けて抑制する。
// （CSSメディアクエリはOS設定を直読みするため、JSの上書きだけでは各端末の設定差を解消できない。）
function applyReduceMotionClass(): void {
  try { document.documentElement.classList.toggle('reduce-motion', animFxMode() === 'off'); } catch { /* ignore */ }
}
applyReduceMotionClass(); // 起動時に現在の設定を反映

// このターンにCPUがプレイヤー間交易を提案済みか（連続提案防止）
let cpuPlayerTradeOfferedThisTurn = false;

// ダイスのロール演出中フラグ。演出中は新たなアクションを無視（多重ロール等を防止）。
let diceAnimating = false;
// ダイス演出を開始した時刻(performance.now)。想定時間を大きく超えてもフラグが落ちない場合
// （WebGL例外等でフラグ固着）をウォッチドッグが検知して強制解除し、CPUの永久停止を防ぐ保険。
let _diceAnimStart = 0;
// 蛮族襲来の全画面演出が盤面を覆っている間は、資源/進歩カードの配布アニメを流さない
// （演出が消えて盤面が見えてから飛ばす＝被りを防ぐ）。clearAt は演出の終了予定時刻(performance.now基準)。
const BARB_OVERLAY_MS = 4200;
// 進歩カードを「使用した瞬間」に中央へ大きく見せる時間（ms）。CPUの次手はこの間ゲートして
// 「何のカードを使ったか」が見えてから次へ進ませる（演出スキップ防止）。out フェードは少し手前。
const PROGRESS_CARD_FX_MS = 1700;
let barbarianOverlayClearAt = 0;
function pendingOverlayDelay(): number {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  return Math.max(0, barbarianOverlayClearAt - now);
}
// 資源/商品の分配アニメ中フラグ。CPUの次手（特に次のダイス）を待たせ、サイコロと飛行アニメの被りを防ぐ。
let resourceAnimating = false;
let _resAnimTimer: number | null = null;
let _resAnimEndAt = 0;
// 資源/進歩カードの飛行が出ている間、CPUの次手を待たせる。複数の飛行（資源＋進歩カード）が
// 重なっても「最も遅く着地する」時刻までゲートを延長する（早い方の解除で先走らないように）。
function holdResourceAnimating(ms: number): void {
  resourceAnimating = true;
  const end = (typeof performance !== 'undefined' ? performance.now() : 0) + ms;
  if (end <= _resAnimEndAt) return; // 既により長く確保済み
  _resAnimEndAt = end;
  if (_resAnimTimer != null) clearTimeout(_resAnimTimer);
  _resAnimTimer = window.setTimeout(() => {
    resourceAnimating = false; _resAnimTimer = null; _resAnimEndAt = 0;
    scheduleAiTurn();
  }, ms);
}

// 画面右上メニュー（ホーム/BGM/SE/CPU速度）の開閉状態
let gameMenuOpen = false;

// 出目分布の集計（インデックス2〜12が出現回数。現在のゲーム中のみ蓄積）
let diceStats: number[] = new Array(13).fill(0);

// 人間向け: 他プレイヤーからの交易提案を自動拒否する設定（既定OFF）
let autoRejectTrades = false;
// 人間ターゲットの交易応答タイマー（自動拒否・20秒タイムアウト用）
let humanTradeTimer: ReturnType<typeof setTimeout> | null = null;

// 直近に実際に出た「CPU交易提案」のシグネチャ（1件だけ保持）。
// 完全一致する次のCPU提案だけを抑制する（ターンをまたいでも有効）。
// 人間→CPU提案・銀行交易には影響しない（CPU起案のみ記録）。
let lastCpuOfferSignature: string | null = null;

/**
 * CPU交易提案のシグネチャ（cpuPid + give内訳 + receive内訳）。
 * キー順に依存しないよう資源をソートして直列化する。
 */
function cpuOfferSignature(cpuPid: string, offer: TradeOffer): string {
  const ser = (h: Partial<ResourceHand>): string =>
    RESOURCE_TYPES.filter(r => (h[r] ?? 0) > 0)
      .map(r => `${r}:${h[r]}`)
      .join(',');
  return `${cpuPid}|give=${ser(offer.give)}|recv=${ser(offer.receive)}`;
}

// ============================================================
// 再描画
// ============================================================

/**
 * 再描画。skipBoard=true は「盤面SVGの入力（state / buildMode / placePreview）が不変」と
 * 呼び出し側が保証できる UI 限定更新（交易・捨て札モーダルの +/− 等）用で、盤面の全再構築と
 * ハイライト計算を省く（スマホでの連打タップ遅延・実行中CSSアニメの破棄を防ぐ）。
 */
function redraw(skipBoard = false): void {
  if (!state) return;

  // ゲーム進行中は three(WebGL ダイス) を裏で先読み（初回ロールまでに用意。多重ロードは内部ガード）。
  if (state.phase === 'MAIN') preloadDiceGL();

  // 航海者: 盗賊/海賊の事前選択は ROBBER フェーズ限定。フェーズを抜けたら選択をリセットする。
  if (!(state.phase === 'MAIN' && state.turnPhase === 'ROBBER') && robberPiece !== null) robberPiece = null;

  // 交易と蛮族「Catan for Two」: 中立(色)の事前選択は TB_NEUTRAL 限定。抜けたらリセット。
  if (!(state.phase === 'MAIN' && state.turnPhase === 'TB_NEUTRAL') && tbNeutralChoice !== null) tbNeutralChoice = null;

  // DISCARD フェーズの uiPhase 自動同期。
  // LAN ではマスク済み state のため discardPid は「自分（8枚以上の場合）」に
  // 自然解決し、捨て札UIが各端末で自分の分だけ出る。
  if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    const discardPid = findPendingDiscarder(state);
    if (discardPid && (uiPhase.type !== 'discard' || uiPhase.playerId !== discardPid)) {
      uiPhase = { type: 'discard', playerId: discardPid, selected: makeHand() };
    }
  } else if (uiPhase.type === 'discard') {
    uiPhase = { type: 'idle' };
  }

  // 航海者: 金タイル産出の選択待ち(GOLD)の uiPhase 自動同期（DISCARD と同様）。
  // owed なプレイヤーが切り替わったらスロットを引き直す。GOLD を抜けたら破棄。
  if (state.phase === 'MAIN' && state.turnPhase === 'GOLD') {
    const goldPid = state.playerOrder.find(p => ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
    if (goldPid && (uiPhase.type !== 'goldChoice' || uiPhase.playerId !== goldPid)) {
      const owed = (state.pendingGoldChoice ?? {})[goldPid] ?? 0;
      uiPhase = { type: 'goldChoice', playerId: goldPid, slots: Array.from({ length: owed }, () => null) };
    }
  } else if (uiPhase.type === 'goldChoice') {
    uiPhase = { type: 'idle' };
  }

  if (state.turnPhase !== 'ROBBER' && uiPhase.type === 'robberTarget') {
    uiPhase = { type: 'idle' };
    robberPreviewedTile = null;
  }

  // 仮置きプレビュー(placePreview)/道船選択(edgePieceChoice)は、配置できない局面/GAME_OVER では破棄する。
  if ((uiPhase.type === 'placePreview' || uiPhase.type === 'edgePieceChoice') && !isPlaceablePhase(state)) {
    uiPhase = { type: 'idle' };
  }

  // 仮置きプレビューのゴーストを board へ渡す（computeHighlights の結果へ付加）。
  const withPreview = (opts: BoardRenderOptions): BoardRenderOptions => {
    // 航海者: 道/船どちらを置くか選択中は、その辺に道と船の両方のゴーストを重ねて「ここに置く」と示す。
    if (uiPhase.type === 'edgePieceChoice') {
      opts.previewEdgeId = uiPhase.edgeId;
      opts.previewShipEdgeId = uiPhase.edgeId;
    }
    if (uiPhase.type === 'placePreview') {
      if (uiPhase.kind === 'road') opts.previewEdgeId = uiPhase.targetId;
      else if (uiPhase.kind === 'ship') opts.previewShipEdgeId = uiPhase.targetId;
      else if (uiPhase.kind === 'settlement' || uiPhase.kind === 'city') opts.previewVertexId = uiPhase.targetId;
      // 商人は選んだタイル、騎士の起動/昇格は選んだ騎士頂点を青で「これを確定」と明示。
      else if (uiPhase.kind === 'placeMerchant') opts.selectedTileId = uiPhase.targetId;
      else if (uiPhase.kind === 'activateKnight' || uiPhase.kind === 'upgradeKnight') opts.selectedVertexId = uiPhase.targetId;
    }
    // 強盗/海賊の相手選択中は、コマを移動先タイルに先行表示（駒移動→相手選択の順序）。
    if (uiPhase.type === 'robberTarget') {
      if (uiPhase.kind === 'pirate') opts.previewPirateTileId = uiPhase.tileId;
      else opts.previewRobberTileId = uiPhase.tileId;
    }
    return opts;
  };

  // LAN対戦: 操作UIは viewer の手番のみ有効化（lanMode）。建設ハイライトも
  // 自分の手番のときだけ出す。CPUスケジュール/ウォッチドッグは動かさない。
  if (netMode) {
    if (!skipBoard) {
      // 手番のハイライトに加え、多人数解決（都市格下げ等）で viewer が対象の時も出す（boardCanAct）。
      const myTurn = viewerPlayerId != null && viewerPlayerId === currentPid(state);
      const opts: BoardRenderOptions = (myTurn || boardCanAct()) ? withPreview(computeHighlights(state, buildMode)) : {};
      opts.viewport = boardViewport;
      if (state.piratePosition) opts.piratePosition = state.piratePosition;
      renderBoard(svgBoard, state, opts);
    }
    renderUI(
      uiDiv, state, buildMode, setBuildMode, uiPhase, setUIPhase, dispatch,
      viewerPlayerId ?? undefined, /* lanMode */ true,
    );
    updateGameNav();
    updatePlaceConfirmBar();
    updateZoomControls();
    updateLandscapeSheet();
    updateBeginnerHint();
    return;
  }

  if (!skipBoard) {
    // ローカル: 配置/盗賊ハイライトは人間の手番のみ（CPUの手番に緑ハイライトを出すと
    // 「人間が代わりに操作できる」ように見え、実際にクリックを誘発していた）。
    // 例外: 都市格下げ(CITY_DOWNGRADE)など多人数解決は手番に関係なく対象の人間が操作する。
    // この時もハイライト（赤い格下げ対象）を出さないと「光る都市が無く選べない」状態になる。
    // boardCanAct() が true を返すのは「今ローカル人間が操作してよい場面」なので、それで判定する。
    const humanTurn = state.players[currentPid(state)]?.type === 'human';
    const opts: BoardRenderOptions = (humanTurn || boardCanAct()) ? withPreview(computeHighlights(state, buildMode)) : {};
    opts.viewport = boardViewport;
    if (state.piratePosition) opts.piratePosition = state.piratePosition;
    renderBoard(svgBoard, state, opts);
  }
  renderUI(uiDiv, state, buildMode, setBuildMode, uiPhase, setUIPhase, dispatch);
  updateGameNav();
  updatePlaceConfirmBar();
  updateZoomControls();
  // CPUが責任を持つ場面ならフリーズ対策ウォッチドッグを再武装
  armCpuWatchdog();
  updateLandscapeSheet();
  updateBeginnerHint();
}

// ============================================================
// 横持ちスマホ: 操作パネルをボトムシート化（collapsed/expanded）
// ============================================================

// ユーザーが手動で開いた状態。交易依頼/捨て札中は強制で開く（mustAct）。
let landscapeSheetUserOpen = false;
let sheetHandleEl: HTMLButtonElement | null = null;

// 横持ちの操作対象プレイヤー（LAN=自分、ローカル=人間）。
function viewerForStatus(): PlayerId | null {
  if (netMode) return viewerPlayerId;
  return state.playerOrder.find(p => state.players[p]?.type === 'human') ?? null;
}

// ボトムシートのハンドルに出す短いステータス。alert=見逃すと困る（交易/捨て札）。
function computeSheetStatus(): { text: string; alert: boolean } {
  if (!state) return { text: '', alert: false };
  const viewer = viewerForStatus();
  const cur = state.playerOrder[state.currentPlayerIndex];
  const tr = state.pendingTrade;
  if (viewer && tr && tr.targetPlayerIds.includes(viewer) && !tr.responses[viewer]
      && (tr.state === 'TRADE_OFFER' || tr.state === 'TRADE_RESPONSE')) {
    return { text: '🤝 交易依頼！', alert: true };
  }
  if (viewer && state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    const h = state.players[viewer]?.hand;
    const total = h ? RESOURCE_TYPES.reduce((s, r) => s + h[r], 0) : 0;
    if (total >= 8 && !(state.discardedThisRound ?? []).includes(viewer)) {
      return { text: '🗑 捨て札！', alert: true };
    }
  }
  // 航海者: 自分が金タイル産出の選択待ちなら案内（手番でなくても出す）。
  if (viewer && state.phase === 'MAIN' && state.turnPhase === 'GOLD'
      && ((state.pendingGoldChoice ?? {})[viewer] ?? 0) > 0) {
    // T&B イベント（豊作の年など）でも GOLD を流用しているため文言を出し分ける。
    return { text: state.tbPendingEventNumber != null ? '✨ 資源を選択！' : '✨ 金を選択！', alert: true };
  }
  // 交易と蛮族イベント: 自分が選択待ちなら案内（手番でなくても出す）。
  if (viewer && state.phase === 'MAIN') {
    if (state.turnPhase === 'EVENT_GIVE' && (state.tbPendingEventGive ?? {})[viewer])
      return { text: '🎁 左隣へ渡す資源を選択！', alert: true };
    if (state.turnPhase === 'EVENT_HELPFUL' && (state.tbPendingEventHelpful ?? []).includes(viewer))
      return { text: '🎁 渡す相手と資源を選択！', alert: true };
    if (state.turnPhase === 'EVENT_STEAL' && state.tbPendingEventSteal?.playerId === viewer)
      return { text: '⚔ 奪う相手を選択！', alert: true };
    if (state.turnPhase === 'EVENT_DAMAGE' && (state.tbPendingEventDamage ?? []).includes(viewer))
      return { text: '🚧 損傷させる自分の道をタップ', alert: true };
  }
  if (viewer && cur === viewer) {
    if (state.phase === 'SETUP_FORWARD' || state.phase === 'SETUP_BACKWARD') {
      if (state.setupSubPhase === 'PLACE_ROAD') {
        // 航海者: 海岸の開拓地なら道の代わりに船を置ける → その場合は選択を促す。
        const canShip = Object.keys(state.edges).some(eid => canBuildShip(state, cur, eid));
        return { text: canShip ? '🛤 道 か ⛵ 船 を配置（海岸はどちらでもOK）' : '🛤 道を配置', alert: false };
      }
      return { text: '🏠 開拓地を配置', alert: false };
    }
    if (state.turnPhase === 'PRE_ROLL') return { text: state.tbEventCards ? '🃏 イベントカードをめくる' : '🎲 ダイス', alert: false };
    if (state.turnPhase === 'ROBBER')   return { text: '🦹 盗賊を移動するタイルをタップ', alert: true };
    if (state.turnPhase === 'CITY_DOWNGRADE') return { text: '⚔ 格下げする自分の都市をタップ', alert: true };
    if (state.turnPhase === 'PROGRESS_DISCARD') return { text: '📜 進歩カードが5枚 — 捨てる1枚を選択', alert: true };
    if (state.turnPhase === 'TRADE_BUILD') {
      if (buildMode === 'road')       return { text: '🛤 道を配置', alert: false };
      if (buildMode === 'ship')       return { text: '🚢 船を配置', alert: false };
      if (buildMode === 'moveShip')   return { text: moveShipFrom ? '⛵ 移動先をタップ' : '⛵ 動かす船を選択', alert: false };
      if (buildMode === 'moveKnight') return { text: moveKnightFrom ? '🛡 移動先をタップ' : '🛡 動かす騎士を選択', alert: false };
      if (buildMode === 'chaseRobber') return { text: '🦹 追い払う騎士を選択', alert: false };
      if (buildMode === 'buildKnight') return { text: '🛡 騎士を置く頂点をタップ', alert: false };
      if (buildMode === 'activateKnight') return { text: '⚡ 起動する騎士をタップ', alert: false };
      if (buildMode === 'upgradeKnight') return { text: '⬆ 昇格する騎士をタップ', alert: false };
      if (buildMode === 'placeMerchant') return { text: '🏪 商人を置く資源タイルをタップ', alert: true };
      if (buildMode === 'inventorSwap') return { text: inventorFirstTile ? '🔄 入れ替え先のタイルをタップ' : '🔄 入れ替える1つ目のタイルをタップ', alert: true };
      if (buildMode === 'placeBishop') return { text: '⛪ 盗賊を置くタイルをタップ', alert: true };
      if (buildMode === 'selectDiplomatRoad') return { text: '📜 撤去する道をタップ（自分の道は建て直し可）', alert: true };
      if (buildMode === 'selectDeserterKnight') return { text: deserterRemoveVid ? '🏃 得た騎士を置く頂点をタップ' : '🏃 消す相手の騎士をタップ', alert: true };
      if (buildMode === 'selectMedicineSettlement') return { text: '💊 都市にする開拓地をタップ', alert: true };
      if (buildMode === 'selectMetropolis') return { text: '🏛 メトロポリスにする都市をタップ', alert: true };
      if (buildMode === 'selectSmithKnight') return { text: smithFirstKnight ? '⚒ 昇格する2体目の騎士をタップ' : '⚒ 昇格する騎士をタップ（最大2体）', alert: true };
      if (buildMode === 'selectEngineerCity') return { text: '🧱 城壁を建てる都市をタップ', alert: true };
      if (buildMode === 'selectWallCity') return { text: '🧱 城壁を建てる都市をタップ', alert: true };
      if (buildMode === 'selectIntrigueKnight') return { text: '🗡 退去させる敵騎士をタップ', alert: true };
      if (buildMode === 'settlement') return { text: '🏠 開拓地を配置', alert: false };
      if (buildMode === 'city')       return { text: '🏙 都市を配置', alert: false };
      return { text: '🛠 建設・交易', alert: false };
    }
  }
  if (cur) {
    const p = state.players[cur];
    // CPU/人間を問わず控えめに「○○ の番」とだけ表示（CPUを強調しすぎない）。
    return { text: `⏳ ${p?.name ?? ''} の番`, alert: false };
  }
  return { text: '', alert: false };
}

// ハンドル更新＋開閉状態の反映（横持ち以外でも安全に呼べる：CSSが媒体で制御）。
function updateLandscapeSheet(): void {
  if (!sheetHandleEl) {
    sheetHandleEl = document.createElement('button');
    sheetHandleEl.id = 'ui-sheet-handle';
    sheetHandleEl.type = 'button';
    sheetHandleEl.addEventListener('click', () => {
      landscapeSheetUserOpen = !landscapeSheetUserOpen;
      updateLandscapeSheet();
    });
    appDiv.appendChild(sheetHandleEl);
  }
  if (!state) return;
  const st = computeSheetStatus();
  // 交易/捨て札は自動展開。建設モード中は盤面をタップさせたいので自動収納。
  const open = st.alert || (landscapeSheetUserOpen && buildMode === 'idle');
  document.body.classList.toggle('lsheet-open', open);
  sheetHandleEl.classList.toggle('alert', st.alert);
  const arrow = open ? '▼ 閉じる' : '▲ 操作';
  sheetHandleEl.textContent = `${st.text}　${arrow}`;
}

// ============================================================
// ゲームナビバー更新
// ============================================================

const CPU_SPEED_LABELS: Record<CpuSpeed, string> = {
  slow: 'ゆっくり', normal: '普通', fast: '速い', instant: '最速',
};

function updateGameNav(): void {
  gameNav.innerHTML = '';

  // ゲーム終了時のみ、主要アクション（再戦/ホーム）を見える位置に出す
  if (state.phase === 'GAME_OVER') {
    if (lastConfig) {
      const rematchBtn = document.createElement('button');
      rematchBtn.className = 'btn-nav btn-nav-primary';
      rematchBtn.textContent = 'もう一度プレイ';
      rematchBtn.addEventListener('click', () => { if (lastConfig) startGame(lastConfig); });
      gameNav.appendChild(rematchBtn);
    }
    const homeBtn = document.createElement('button');
    homeBtn.className = 'btn-nav';
    homeBtn.textContent = '設定を変えてホームへ';
    homeBtn.addEventListener('click', returnToHome);
    gameNav.appendChild(homeBtn);
  }

  // 右上の「☰ メニュー」（補助操作をまとめてメイン操作の邪魔をしない）
  const menuBtn = document.createElement('button');
  menuBtn.className = 'menu-toggle';
  menuBtn.textContent = '☰ メニュー';
  menuBtn.setAttribute('aria-label', 'メニュー');
  const dd = document.createElement('div');
  dd.className = 'game-menu';
  dd.style.display = gameMenuOpen ? 'flex' : 'none';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gameMenuOpen = !gameMenuOpen;
    dd.style.display = gameMenuOpen ? 'flex' : 'none';
  });
  dd.addEventListener('click', (e) => e.stopPropagation());

  // 初心者モード（ゲーム中でも切替可。ヒント/おすすめ⭐/遊び方ボタンを即反映）。
  {
    const begRow = document.createElement('div');
    begRow.className = 'game-menu-row';
    const lbl = document.createElement('span');
    lbl.className = 'game-menu-label';
    lbl.textContent = '🔰 初心者モード';
    const sel = document.createElement('select');
    sel.className = 'game-menu-select';
    ([['on', 'ON'], ['off', 'OFF']] as [string, string][]).forEach(([v, t]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = t;
      if ((beginnerMode ? 'on' : 'off') === v) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => { setBeginnerMode(sel.value === 'on'); redraw(); });
    begRow.append(lbl, sel);
    dd.appendChild(begRow);
  }

  // CPU 速度（ゲーム中に変更可能。次のCPU行動から反映）
  if (lastConfig) {
    const speedRow = document.createElement('div');
    speedRow.className = 'game-menu-row';
    const lbl = document.createElement('span');
    lbl.className = 'game-menu-label';
    lbl.textContent = 'CPU速度';
    const sel = document.createElement('select');
    sel.className = 'game-menu-select';
    // 速度は4段階（ゆっくり/普通/速い/最速）。ゲーム中でも変更でき、次のCPU行動から反映。
    const curSpeed: CpuSpeed = lastConfig!.cpuSpeed;
    (['slow', 'normal', 'fast', 'instant'] as CpuSpeed[]).forEach(sp => {
      const opt = document.createElement('option');
      opt.value = sp; opt.textContent = CPU_SPEED_LABELS[sp];
      if (curSpeed === sp) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      if (lastConfig) lastConfig = { ...lastConfig, cpuSpeed: sel.value as CpuSpeed };
    });
    speedRow.append(lbl, sel);
    dd.appendChild(speedRow);
  }

  // アニメーション表示（ON/OFF）。既定ON＝OSの「動きを減らす」に関係なく演出を出す。
  // OFFで資源飛行・サイコロ回転・カード大表示などを省略（reduced-motion 相当）。即反映。
  {
    const animRow = document.createElement('div');
    animRow.className = 'game-menu-row';
    const lbl = document.createElement('span');
    lbl.className = 'game-menu-label';
    lbl.textContent = 'アニメーション';
    const sel = document.createElement('select');
    sel.className = 'game-menu-select';
    const cur = animFxMode();
    (['on', 'off'] as AnimFxMode[]).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = ANIM_FX_LABELS[m];
      if (cur === m) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => setAnimFxMode(sel.value as AnimFxMode));
    animRow.append(lbl, sel);
    dd.appendChild(animRow);
  }

  // サイコロ演出の速さ（OFF/ゆっくり/普通/速い）。CPU速度とは独立・即反映。
  {
    const diceRow = document.createElement('div');
    diceRow.className = 'game-menu-row';
    const lbl = document.createElement('span');
    lbl.className = 'game-menu-label';
    lbl.textContent = 'サイコロ演出';
    const sel = document.createElement('select');
    sel.className = 'game-menu-select';
    const cur = diceFxMode();
    (['off', 'slow', 'normal', 'fast'] as DiceFxMode[]).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = DICE_FX_LABELS[m];
      if (cur === m) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => setDiceFxMode(sel.value as DiceFxMode));
    diceRow.append(lbl, sel);
    dd.appendChild(diceRow);
  }

  // BGM ON/OFF + 音量
  const bgmRow = document.createElement('div');
  bgmRow.className = 'game-menu-row';
  const bgmBtn = document.createElement('button');
  bgmBtn.className = 'game-menu-btn';
  bgmBtn.textContent = isBgmEnabled() ? '🔊 BGM ON' : '🔇 BGM OFF';
  bgmBtn.addEventListener('click', () => {
    setBgmEnabled(!isBgmEnabled());
    if (isBgmEnabled()) bgmStart(); else bgmStop();
    bgmBtn.textContent = isBgmEnabled() ? '🔊 BGM ON' : '🔇 BGM OFF';
  });
  const volSlider = document.createElement('input');
  volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '100';
  volSlider.value = String(Math.round(getBgmVolume() * 100));
  volSlider.className = 'bgm-volume';
  volSlider.title = 'BGM 音量';
  volSlider.setAttribute('aria-label', 'BGM 音量');
  volSlider.addEventListener('input', () => bgmSetVolume(parseInt(volSlider.value) / 100));
  bgmRow.append(bgmBtn, volSlider);
  dd.appendChild(bgmRow);

  // BGM 曲選択（3種）。選択は localStorage に保存され、次回も同じ曲。
  const trackRow = document.createElement('div');
  trackRow.className = 'game-menu-row';
  const trackLbl = document.createElement('span');
  trackLbl.className = 'game-menu-label';
  trackLbl.textContent = 'BGM 曲';
  const trackSel = document.createElement('select');
  trackSel.className = 'game-menu-select';
  BGM_TRACKS.forEach((tr, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = tr.name;
    if (i === getBgmTrack()) opt.selected = true;
    trackSel.appendChild(opt);
  });
  trackSel.addEventListener('change', () => setBgmTrack(parseInt(trackSel.value, 10)));
  trackRow.append(trackLbl, trackSel);
  dd.appendChild(trackRow);

  // SE ON/OFF + 音量（BGM と同じ並び。設定は localStorage に永続化）
  const seRow = document.createElement('div');
  seRow.className = 'game-menu-row';
  const seBtn = document.createElement('button');
  seBtn.className = 'game-menu-btn';
  seBtn.textContent = isSeEnabled() ? '🔔 効果音 ON' : '🔕 効果音 OFF';
  seBtn.addEventListener('click', () => {
    setSeEnabled(!isSeEnabled());
    seBtn.textContent = isSeEnabled() ? '🔔 効果音 ON' : '🔕 効果音 OFF';
  });
  const seVol = document.createElement('input');
  seVol.type = 'range'; seVol.min = '0'; seVol.max = '100';
  seVol.value = String(Math.round(getSeVolume() * 100));
  seVol.className = 'bgm-volume';
  seVol.title = '効果音 音量';
  seVol.setAttribute('aria-label', '効果音 音量');
  seVol.addEventListener('input', () => setSeVolume(parseInt(seVol.value, 10) / 100));
  // スライダーを離したときに現在音量で確認音を鳴らす（聞いて調整できる）。
  seVol.addEventListener('change', () => { if (isSeEnabled()) playSE('click'); });
  seRow.append(seBtn, seVol);
  dd.appendChild(seRow);

  // 触覚フィードバック（対応端末のみ表示。設定は localStorage に永続）。
  if (hapticsSupported()) {
    const hapBtn = document.createElement('button');
    hapBtn.className = 'game-menu-btn';
    hapBtn.textContent = isHapticsEnabled() ? '📳 振動 ON' : '📴 振動 OFF';
    hapBtn.addEventListener('click', () => {
      setHapticsEnabled(!isHapticsEnabled());
      hapBtn.textContent = isHapticsEnabled() ? '📳 振動 ON' : '📴 振動 OFF';
    });
    dd.appendChild(hapBtn);
  }

  // 出目分布グラフ
  const statsBtn = document.createElement('button');
  statsBtn.className = 'game-menu-btn';
  statsBtn.textContent = '🎲 出目分布';
  statsBtn.addEventListener('click', () => {
    gameMenuOpen = false;
    dd.style.display = 'none';
    showDiceStatsModal();
  });
  dd.appendChild(statsBtn);

  // 交易の自動拒否（人間向け。ONなら他プレイヤーからの提案を自動で拒否）
  const autoRejBtn = document.createElement('button');
  autoRejBtn.className = 'game-menu-btn';
  autoRejBtn.textContent = autoRejectTrades ? '🚫 交易を自動拒否 ON' : '🤝 交易を自動拒否 OFF';
  autoRejBtn.addEventListener('click', () => {
    autoRejectTrades = !autoRejectTrades;
    autoRejBtn.textContent = autoRejectTrades ? '🚫 交易を自動拒否 ON' : '🤝 交易を自動拒否 OFF';
    // ONにした瞬間、保留中の提案があれば適用する
    if (autoRejectTrades) scheduleHumanTradeAutoReject();
  });
  dd.appendChild(autoRejBtn);

  // ホームに戻る（誤クリック防止のため最下部・確認ダイアログ付き。ゲーム中のみ）
  if (state.phase !== 'GAME_OVER') {
    const homeBtn = document.createElement('button');
    homeBtn.className = 'game-menu-btn game-menu-danger';
    homeBtn.textContent = '🏠 ホームに戻る';
    homeBtn.addEventListener('click', () => {
      if (window.confirm('ホームに戻りますか？現在のゲームは終了します。')) returnToHome();
    });
    dd.appendChild(homeBtn);
  }

  // 「🔰 遊び方」ボタン（目的・手番の流れ・建設コスト＋このゲーム固有ルールの早見表）。
  // 初心者モードに限らず常時表示（シナリオ別の詳細ルールを誰でも確認できるように）。
  if (state.phase !== 'GAME_OVER') {
    const helpBtn = document.createElement('button');
    helpBtn.className = 'btn-nav beginner-help-nav-btn';
    helpBtn.textContent = '🔰 遊び方';
    helpBtn.addEventListener('click', () => openBeginnerHelp(state));
    gameNav.appendChild(helpBtn);
  }

  const wrap = document.createElement('div');
  wrap.className = 'game-menu-wrap';
  wrap.append(menuBtn, dd);
  gameNav.appendChild(wrap);
}


// ============================================================
// ディスパッチ
// ============================================================

const RESET_UIPHASE_ACTIONS = new Set([
  'DISCARD_RESOURCES', 'MOVE_ROBBER', 'BANK_TRADE',
  'PLAY_KNIGHT', 'PLAY_YEAR_OF_PLENTY', 'PLAY_MONOPOLY', 'PLAY_ROAD_BUILDING',
  'FINISH_ROAD_BUILDING', 'END_TURN', 'DECLARE_VICTORY',
  'OFFER_TRADE', 'CONFIRM_TRADE', 'CANCEL_TRADE',
  // 交易と蛮族「Catan for Two」: 強制交易の成立後は tbForcedTrade モーダルを閉じる
  // （閉じないと give 選択が残り、確定を再送してエンジンが 'already spent tokens' を投げる）。
  'TB_FORCED_TRADE',
]);

// CPU行動の待ち時間(ms)。初見でもCPUの動きを追える速度を基準に再調整。
//  ゆっくり: 現行ゆっくり(1200)よりさらに遅く（じっくり観戦向け）
//  普通(既定): 現行「ゆっくり」相当＝CPUの建設/交易/盗賊/捨て札を目で追える
//  速い: 現行「普通〜速い」相当でテンポ重視
//  最速: 動作確認用の最速
const CPU_SPEED_MS: Record<CpuSpeed, number> = { slow: 2200, normal: 1200, fast: 350, instant: 30 };
function aiDelayMs(): number {
  return CPU_SPEED_MS[lastConfig?.cpuSpeed ?? 'normal'];
}

/** 人間が交易提案した後、CPU ターゲットを自動応答させる */
function scheduleCpuTradeResponse(): void {
  if (!state) return;
  const trade = state.pendingTrade;
  if (!trade || trade.state !== 'TRADE_OFFER') return;

  const pending = trade.targetPlayerIds.find(t => !trade.responses[t]);
  if (!pending || state.players[pending]?.type !== 'ai') return;

  const gen = gameGeneration;
  setTimeout(() => {
    if (gen !== gameGeneration) return;
    const cur = state.pendingTrade;
    if (!cur || cur.state !== 'TRADE_OFFER') return;
    const stillPending = cur.targetPlayerIds.find(t => !cur.responses[t]);
    if (stillPending !== pending) return;

    // 受諾判断は AI の交易方策に委ねる（支払い可能・目標前進・必要資源温存・利敵回避）。
    const accepts = evaluateTradeOffer(state, pending as PlayerId, cur.offer, cur.initiatorId);
    dispatch({ type: 'RESPOND_TRADE', response: { playerId: pending as PlayerId, status: accepts ? 'ACCEPT' : 'REJECT' } });
  }, aiDelayMs());
}

/**
 * CPUが交易を起案した後、人間が応答したら CPU として自動的に確認/キャンセルする。
 * TRADE_RESPONSE 状態かつ initiator が AI の場合のみ動作する。
 */
function scheduleCpuInitiatorConfirm(): void {
  if (!state) return;
  const trade = state.pendingTrade;
  if (!trade || trade.state !== 'TRADE_RESPONSE') return;
  if (state.players[trade.initiatorId]?.type !== 'ai') return;

  const gen = gameGeneration;
  setTimeout(() => {
    if (gen !== gameGeneration) return;
    const cur = state.pendingTrade;
    if (!cur || cur.state !== 'TRADE_RESPONSE') return;
    if (state.players[cur.initiatorId]?.type !== 'ai') return;

    const acceptor = cur.targetPlayerIds.find(
      t => cur.responses[t]?.status === 'ACCEPT',
    ) as PlayerId | undefined;
    if (acceptor) {
      dispatch({ type: 'CONFIRM_TRADE', responderId: acceptor });
    } else {
      dispatch({ type: 'CANCEL_TRADE' });
    }
  }, aiDelayMs());
}

/**
 * 人間がターゲットの交易提案に対する自動拒否/タイムアウト拒否をスケジュールする。
 * - 自動拒否ON → すぐ拒否
 * - 提案された資源を持っていない → 約2秒で拒否
 * - 20秒無反応 → タイムアウト拒否
 * 人間が手動で応答すれば（responses に入る）発火しない。
 */
function scheduleHumanTradeAutoReject(): void {
  if (humanTradeTimer) { clearTimeout(humanTradeTimer); humanTradeTimer = null; }
  if (!state) return;
  const trade = state.pendingTrade;
  if (!trade || trade.state !== 'TRADE_OFFER') return;
  if (state.players[trade.initiatorId]?.type !== 'ai') return; // CPU起案のみ対象
  const humanTarget = trade.targetPlayerIds.find(
    t => !trade.responses[t] && state.players[t]?.type === 'human',
  );
  if (!humanTarget) return;

  const human = state.players[humanTarget]!;
  const canAfford = RESOURCE_TYPES.every(r => (human.hand[r] ?? 0) >= (trade.offer.receive[r] ?? 0));

  let delay: number; let timeout = false;
  if (autoRejectTrades) delay = 600;            // 自動拒否設定ON
  else if (!canAfford) delay = 2000;            // 渡せる資源がない → 短時間で拒否
  else { delay = 20000; timeout = true; }       // 20秒無反応で自動拒否

  const gen = gameGeneration;
  humanTradeTimer = setTimeout(() => {
    humanTradeTimer = null;
    if (gen !== gameGeneration) return;
    const cur = state.pendingTrade;
    if (!cur || cur.state !== 'TRADE_OFFER') return;
    if (cur.responses[humanTarget]) return;     // 既に人間が応答済み
    appendSystemLog(timeout ? '⏱ 20秒経過のため自動拒否' : `🤝 ${human.name} は交換を拒否`);
    dispatch({ type: 'RESPOND_TRADE', response: { playerId: humanTarget, status: 'REJECT' } });
  }, delay);
}

function scheduleAiTurn(): void {
  if (!state || state.phase === 'GAME_OVER') return;
  // 資源分配アニメ中はCPUの次手を待つ（クリア時に再呼び出しされる）。サイコロとの被り防止。
  if (resourceAnimating) return;

  const gen = gameGeneration;

  if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    // 捨て札済み(discardedThisRound)の AI は除外。判定は discardCount（騎士と商人は資源＋商品）で。
    // 16枚以上から半分捨てても8枚以上残るため、これが無いと同じ AI を再選択して違法な
    // 二重捨てを dispatch し、watchdog(8秒) まで進行が止まる。
    const discardPid = state.playerOrder.find(pid =>
      state.players[pid]?.type === 'ai'
      && !(state.discardedThisRound ?? []).includes(pid)
      && discardCount(state, pid) > 0);
    if (discardPid) {
      setTimeout(() => {
        if (gen !== gameGeneration) return;
        runCpuStep(discardPid, {});
      }, aiDelayMs());
    }
    return;
  }

  // 騎士と商人: 蛮族敗北での都市格下げ待ち。対象 CPU を1人ずつ自動解決（DISCARD と同様）。
  if (state.phase === 'MAIN' && state.turnPhase === 'CITY_DOWNGRADE') {
    const dpid = (state.pendingCityDowngrade ?? []).find(p => state.players[p]?.type === 'ai');
    if (dpid) {
      setTimeout(() => {
        if (gen !== gameGeneration) return;
        runCpuStep(dpid, {});
      }, aiDelayMs());
    }
    return;
  }

  // 騎士と商人: 進歩カード上限超過（5枚目）の捨て札待ち。対象 CPU を1人ずつ自動解決。
  if (state.phase === 'MAIN' && state.turnPhase === 'PROGRESS_DISCARD') {
    const dpid = (state.pendingProgressDiscard ?? []).find(p => state.players[p]?.type === 'ai');
    if (dpid) {
      setTimeout(() => {
        if (gen !== gameGeneration) return;
        runCpuStep(dpid, {});
      }, aiDelayMs());
    }
    return;
  }

  // 航海者: 金タイル産出の選択待ち。owed な CPU を1人ずつ自動解決する（DISCARD と同様）。
  if (state.phase === 'MAIN' && state.turnPhase === 'GOLD') {
    const goldPid = state.playerOrder.find(p =>
      state.players[p]?.type === 'ai' && ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
    if (goldPid) {
      setTimeout(() => {
        if (gen !== gameGeneration) return;
        runCpuStep(goldPid, {});
      }, aiDelayMs());
    }
    return;
  }

  // 交易と蛮族イベント: 選択待ち（良き隣人/親切な隣人/衝突・交易優位/地震）。対象 CPU を1人ずつ自動解決。
  if (state.phase === 'MAIN' && tbEventPendingIds(state).length > 0) {
    const epid = tbEventPendingIds(state).find(p => state.players[p]?.type === 'ai');
    if (epid) {
      setTimeout(() => {
        if (gen !== gameGeneration) return;
        runCpuStep(epid, {});
      }, aiDelayMs());
    }
    return;
  }

  const pid = state.playerOrder[state.currentPlayerIndex]!;
  if (state.players[pid]?.type === 'ai') {
    const aiOpts: AiOpts = { skipPlayerTrade: cpuPlayerTradeOfferedThisTurn };
    setTimeout(() => {
      if (gen !== gameGeneration) return;
      runCpuStep(pid, aiOpts);
    }, aiDelayMs());
  }
}

// CPUの1手を「例外やnullでも止まらない」ように実行する。
function runCpuStep(pid: PlayerId, aiOpts: AiOpts): void {
  try {
    let action = chooseAction(state, pid, aiOpts);
    // 直近と完全一致するCPU交易提案は抑制し、交易抜きで選び直す。
    if (action?.type === 'OFFER_TRADE'
        && cpuOfferSignature(pid, action.offer) === lastCpuOfferSignature) {
      action = chooseAction(state, pid, { ...aiOpts, skipPlayerTrade: true });
    }
    if (!action) action = safeFallbackAction();
    if (action) dispatch(action);
  } catch (err) {
    console.warn('CPU処理に失敗したためフォールバックします', err);
    const fb = safeFallbackAction();
    if (fb) { try { dispatch(fb); } catch (e) { console.warn('fallback failed', e); } }
  }
}

// ============================================================
// CPUフリーズ対策（ウォッチドッグ）: 一定時間 CPU が進めない場合に
// 合法な安全行動を自動実行して進行不能を防ぐ。ゲームロジックは変えない。
// ============================================================

let cpuWatchdog: ReturnType<typeof setTimeout> | null = null;
const WATCHDOG_MS = 8000;

/** 次に動く責任が CPU 側にあるか（人間の番なら待つので false） */
function cpuIsResponsible(): boolean {
  if (!state || state.phase === 'GAME_OVER') return false;
  const t = state.pendingTrade;
  if (t) {
    if (t.state === 'TRADE_OFFER') {
      const pending = t.targetPlayerIds.find(x => !t.responses[x]);
      return !!pending && state.players[pending]?.type === 'ai';
    }
    if (t.state === 'TRADE_RESPONSE') return state.players[t.initiatorId]?.type === 'ai';
    return false;
  }
  if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    return state.playerOrder.some(p => state.players[p]?.type === 'ai'
      && !(state.discardedThisRound ?? []).includes(p)
      && discardCount(state, p) > 0);
  }
  // 多人数解決フェーズは「手番」ではなく対象プレイヤーが解決する。対象に CPU がいる時だけ
  // CPU 責任（＝ウォッチドッグ対象）。人間が対象の時は false（人間の操作を待つ。誤って
  // safeFallbackAction が走らないように＝「前の人の処理が終わっていない」誤検知を防ぐ）。
  if (state.phase === 'MAIN' && state.turnPhase === 'GOLD') {
    return state.playerOrder.some(p => state.players[p]?.type === 'ai' && ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
  }
  if (state.phase === 'MAIN' && state.turnPhase === 'CITY_DOWNGRADE') {
    return (state.pendingCityDowngrade ?? []).some(p => state.players[p]?.type === 'ai');
  }
  if (state.phase === 'MAIN' && state.turnPhase === 'PROGRESS_DISCARD') {
    return (state.pendingProgressDiscard ?? []).some(p => state.players[p]?.type === 'ai');
  }
  // 交易と蛮族イベント: 選択待ちの対象に CPU がいる時だけ CPU 責任（GOLD 等と同方針）。
  if (state.phase === 'MAIN' && tbEventPendingIds(state).length > 0) {
    return tbEventPendingIds(state).some(p => state.players[p]?.type === 'ai');
  }
  const cur = state.playerOrder[state.currentPlayerIndex];
  return !!cur && state.players[cur]?.type === 'ai';
}

/** 進行が止まっていないか判定するためのトークン */
function progressToken(): string {
  if (!state) return '';
  const t = state.pendingTrade;
  return `${state.globalTurnNumber}|${state.currentPlayerIndex}|${state.turnPhase}|${state.phase}|${t ? t.state + ':' + Object.keys(t.responses).length : '-'}|${state.log.length}`;
}

/** ウォッチドッグを再武装（CPU責任時のみ）。redraw のたびに呼ぶ。 */
function armCpuWatchdog(): void {
  if (cpuWatchdog) { clearTimeout(cpuWatchdog); cpuWatchdog = null; }
  if (!inGame) return; // ホーム復帰後は武装しない（ゾンビ進行防止）
  if (!cpuIsResponsible()) return;
  const token = progressToken();
  const gen = gameGeneration;
  cpuWatchdog = setTimeout(() => {
    cpuWatchdog = null;
    if (gen !== gameGeneration) return;
    if (diceAnimating || resourceAnimating) {
      // 通常は演出/分配アニメ中は待つ。ただし「想定終了時刻を大きく超えても落ちないフラグ」は
      // 固着とみなし強制解除して進行を回復する（WebGL例外等でフラグが残り永久停止するのを防ぐ）。
      const nowFx = (typeof performance !== 'undefined' ? performance.now() : 0);
      const resStuck = resourceAnimating && _resAnimEndAt > 0 && nowFx > _resAnimEndAt + 2000;
      const diceStuck = diceAnimating && _diceAnimStart > 0 && nowFx - _diceAnimStart > 15000;
      if (!resStuck && !diceStuck) { armCpuWatchdog(); return; }
      console.warn('[fx] 演出フラグの固着を検知。強制解除してCPU進行を回復します', { resStuck, diceStuck });
      if (resStuck) { resourceAnimating = false; if (_resAnimTimer != null) { clearTimeout(_resAnimTimer); _resAnimTimer = null; } _resAnimEndAt = 0; }
      if (diceStuck) { diceAnimating = false; _diceAnimStart = 0; }
      // フォールスルー: 下の通常判定で、進んでいなければ安全行動で進める。
    }
    if (!cpuIsResponsible()) return;                      // 人間の番になっていれば何もしない
    if (progressToken() !== token) { armCpuWatchdog(); return; } // 進んでいれば再武装
    // 一定時間進まなかった → 合法な安全行動で進める
    const fb = safeFallbackAction();
    if (fb) {
      appendSystemLog('CPU処理をスキップしました');
      try { dispatch(fb); } catch (e) { console.warn('watchdog fallback failed', e); }
    }
  }, WATCHDOG_MS);
}

/** どのフェーズでも「合法で進行する」行動を1つ返す（最終手段）。 */
function safeFallbackAction(): Action | null {
  if (!state || state.phase === 'GAME_OVER') return null;
  const trade = state.pendingTrade;
  if (trade) {
    if (trade.state === 'TRADE_OFFER') {
      const pending = trade.targetPlayerIds.find(t => !trade.responses[t]);
      if (pending && state.players[pending]?.type === 'ai') {
        return { type: 'RESPOND_TRADE', response: { playerId: pending, status: 'REJECT' } };
      }
    } else if (trade.state === 'TRADE_RESPONSE' && state.players[trade.initiatorId]?.type === 'ai') {
      const acc = trade.targetPlayerIds.find(t => trade.responses[t]?.status === 'ACCEPT') as PlayerId | undefined;
      return acc ? { type: 'CONFIRM_TRADE', responderId: acc } : { type: 'CANCEL_TRADE' };
    }
    return null;
  }
  // 捨て札（CPUが対象のとき）。判定・生成は chooseAction(chooseDiscard) に集約。
  // 騎士と商人では資源＋商品で数える（資源のみだと商品込みのCPUが選ばれず捨て札が終わらない）。
  if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
    const dpid = state.playerOrder.find(p => state.players[p]?.type === 'ai'
      && !(state.discardedThisRound ?? []).includes(p)
      && discardCount(state, p) > 0);
    if (dpid) return chooseAction(state, dpid);
    return null;
  }
  // 航海者: 金タイル産出の選択待ち（owed な CPU の選択を chooseAction で生成）。
  if (state.phase === 'MAIN' && state.turnPhase === 'GOLD') {
    const gpid = state.playerOrder.find(p => state.players[p]?.type === 'ai'
      && ((state.pendingGoldChoice ?? {})[p] ?? 0) > 0);
    if (gpid) return chooseAction(state, gpid);
    return null;
  }
  // 騎士と商人: 蛮族敗北での都市格下げ待ち（対象 CPU の選択を chooseAction で生成）。
  if (state.phase === 'MAIN' && state.turnPhase === 'CITY_DOWNGRADE') {
    const cpid = (state.pendingCityDowngrade ?? []).find(p => state.players[p]?.type === 'ai');
    if (cpid) return chooseAction(state, cpid);
    return null;
  }
  // 騎士と商人: 進歩カード上限超過の捨て札待ち（対象 CPU の選択を chooseAction で生成）。
  if (state.phase === 'MAIN' && state.turnPhase === 'PROGRESS_DISCARD') {
    const cpid = (state.pendingProgressDiscard ?? []).find(p => state.players[p]?.type === 'ai');
    if (cpid) return chooseAction(state, cpid);
    return null;
  }
  // 交易と蛮族イベント: 選択待ち（対象 CPU の選択を chooseAction で生成）。
  if (state.phase === 'MAIN' && tbEventPendingIds(state).length > 0) {
    const epid = tbEventPendingIds(state).find(p => state.players[p]?.type === 'ai');
    if (epid) return chooseAction(state, epid);
    return null;
  }
  const cur = state.playerOrder[state.currentPlayerIndex];
  if (!cur || state.players[cur]?.type !== 'ai') return null; // 人間の番は強制しない
  // 交易と蛮族「Catan for Two」: 中立コマの配置待ち（chooseAction=chooseTbNeutral が第一候補。
  // 保険として最初の合法配置も直接探す。エンジンは合法手がある時だけこのフェーズに入る）。
  if (state.turnPhase === 'TB_NEUTRAL') {
    const a = chooseAction(state, cur);
    if (a) return a;
    for (const n of state.tbNeutralPlayerIds ?? []) {
      if (state.tbNeutralPending === 'settlement') {
        const v = Object.keys(state.vertices).find(vid => canBuildSettlement(state, n, vid));
        if (v) return { type: 'TB_NEUTRAL_SETTLEMENT', owner: n, vertexId: v };
      } else {
        const eid = Object.keys(state.edges).find(x => canBuildRoad(state, n, x));
        if (eid) return { type: 'TB_NEUTRAL_ROAD', owner: n, edgeId: eid };
      }
    }
    return null;
  }
  if (state.turnPhase === 'ROBBER') {
    // 合法な移動先から選ぶ（海・数字限定・親切な盗賊の保護ヘックスを避けないと MOVE_ROBBER が弾かれ進行が止まりうる）。
    const tileId = getRobberMoveTargets(state)[0];
    // 強奪は必須: 手札持ちの相手がいれば選ぶ（chooseStealTarget が 0枚・保護対象を除外・不在なら null）。
    if (tileId) return { type: 'MOVE_ROBBER', tileId, stealFromPlayerId: chooseStealTarget(state, tileId, cur) };
    return null;
  }
  if (state.turnPhase === 'PRE_ROLL') return { type: 'ROLL_DICE' };
  if (state.turnPhase === 'TRADE_BUILD') return { type: 'END_TURN' };
  return null;
}

/** システムログを1件追記（公開情報のみ・CPU内部は出さない）。 */
function appendSystemLog(message: string): void {
  if (!state) return;
  const entry = { turn: state.globalTurnNumber, playerId: (state.playerOrder[state.currentPlayerIndex] ?? 'player1') as PlayerId, type: 'SYSTEM' as const, message };
  state = { ...state, log: [...state.log, entry].slice(-MAX_LOG_ENTRIES) };
}

/**
 * 資源獲得アニメーション
 * origin: 画面座標（起点タイル中心など）。省略時はボードの中央。
 */
// 1個のアイコンを起点→対象パネルへ飛ばす。
const RES_FLY_MS = 1300;       // 飛行時間（ゆっくり）
const RES_FLY_STAGGER = 300;   // アイコン1個ずつの間隔（0.3秒）
// 資源が大量に出た時、stagger の累積でゲート(CPU待ち)が10秒超に膨らむのを防ぐ上限。
// この時間を超える分はアイコンを詰めて飛ばし、CPU進行が長時間止まらないようにする。
const MAX_STAGGER_TOTAL = 2400; // stagger 累積の上限（ms）
function spawnResFlyer(
  imgSrc: string,                     // 飛ばすアイコン画像（資源 or 商品）
  target: { x: number; y: number },   // 着地先（ビューポート座標。.res-fly は position:fixed）
  origin: { x: number; y: number },
  delay: number,
  landEl?: HTMLElement | null,        // 着地時にポップさせるパネル（C-2）
  imgClass = 'res-fly-img',           // 飛ばす画像のクラス（進歩カードは札形の 'pc-fly-img'）
  hidden = false,                     // 種類を伏せて飛ばす（LANの他プレイヤーの非ダイス獲得・公開枚数のみ）
): void {
  // 遅延スポーンは世代ガード必須: delay は最大数秒あり、ホーム復帰/新ゲーム開始後に
  // 旧ゲームのアイコンが画面上を飛び続けるのを防ぐ（clearTransientFx は未発火タイマーを消せない）。
  const gen = gameGeneration;
  setTimeout(() => {
    if (gen !== gameGeneration) return;
    const span = document.createElement('span');
    span.className = 'res-fly';
    if (hidden) {
      // 種類非公開: 札裏のトークンを飛ばす（誰が何枚得たかだけ伝え、種類は秘匿）。
      const back = document.createElement('div');
      back.className = 'res-fly-hidden';
      span.appendChild(back);
    } else {
      // 手札カードと同じ画像で飛ばす（資源・商品とも。絵文字→画像で見た目を統一）。
      const img = document.createElement('img');
      img.className = imgClass;
      img.src = imgSrc;
      img.alt = '';
      img.draggable = false;
      span.appendChild(img);
    }
    // 起点位置をセット
    span.style.left = `${origin.x}px`;
    span.style.top  = `${origin.y}px`;
    // 終点位置（着地先中央）への移動量をCSS変数でセット
    span.style.setProperty('--tx', `${target.x - origin.x}px`);
    span.style.setProperty('--ty', `${target.y - origin.y}px`);
    document.body.appendChild(span);
    requestAnimationFrame(() => requestAnimationFrame(() => { span.classList.add('fly-in'); }));
    setTimeout(() => {
      span.remove();
      if (gen !== gameGeneration) return; // 着地SE/ポップも旧ゲーム分は抑止
      playSE('resource');
      // 着地ポップ: パネルを一瞬だけ弾ませる（reduced-motion時はCSS側でアニメ無効）。
      if (landEl) {
        landEl.classList.remove('res-landed');
        void landEl.offsetWidth; // リフローで連続着地でも再生されるよう再起動
        landEl.classList.add('res-landed');
        setTimeout(() => landEl.classList.remove('res-landed'), 260);
      }
    }, RES_FLY_MS);
  }, delay);
}

// 資源アニメの着地先。パネルが盤面下に回り込むレイアウト(mini-mode)では盤面四隅の
// ミニパネル（表示中のもの）へ、四隅レイアウト(PC広画面/横持ち)では通常のプレイヤーパネルへ。
function flyTargetFor(pid: string): HTMLElement | null {
  const mini = document.querySelector(`.mini-panel[data-pid="${pid}"]`) as HTMLElement | null;
  if (mini && mini.getBoundingClientRect().width > 0) return mini; // 表示中なら優先
  return document.querySelector(`.player-panel[data-pid="${pid}"]`) as HTMLElement | null;
}

/** タイルの画面中心座標を返す */
function tileScreenCenter(tileId: string): { x: number; y: number } | null {
  const boardEl = document.getElementById('board');
  const g = boardEl?.querySelector(`[data-tile-id="${tileId}"]`) as SVGGElement | null;
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 盤上の現行盗賊コマ(SVG)を複製し、盤面と同じ表示スケールで fly に載せる。
// 盗賊のデザインは board.ts の単一実装のみ。ここは複製するだけで描画パスは持たない
// （旧表現＝🦹絵文字は複製失敗時のフォールバックとしてのみ残す）。
function appendRobberFlyVisual(fly: HTMLElement): void {
  const boardEl = document.getElementById('board') as SVGSVGElement | null;
  const liveRobber = boardEl?.querySelector('.robber') as SVGGElement | null;
  if (!boardEl || !liveRobber) { fly.textContent = '🦹'; return; }
  try {
    const bb = liveRobber.getBBox();
    const vbW = boardEl.viewBox.baseVal.width || 752;
    const scale = boardEl.getBoundingClientRect().width / vbW; // 盤面の表示倍率に合わせる
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `${bb.x} ${bb.y} ${bb.width} ${bb.height}`);
    svg.setAttribute('width', `${bb.width * scale}`);
    svg.setAttribute('height', `${bb.height * scale}`);
    svg.style.overflow = 'visible';
    svg.appendChild(liveRobber.cloneNode(true));
    fly.appendChild(svg);
  } catch { fly.textContent = '🦹'; }
}

// プレイヤーの手札総数（公開情報ベース。他者はマスクで handCount、自分は実手札）。
// 騎士と商人では商品も奪取され得るので合算する（強奪アニメ判定用）。
function totalCardsOf(s: GameState, pid: string): number {
  const p = s.players[pid];
  if (!p) return 0;
  const res = p.handCount ?? RESOURCE_TYPES.reduce((a, r) => a + p.hand[r], 0);
  if (s.expansion !== 'cities_knights') return res;
  const com = p.commodityCount ?? (p.commodities ? COMMODITY_TYPES.reduce((a, c) => a + p.commodities![c], 0) : 0);
  return res + com;
}
// 公開情報の資源/商品の合計枚数（他者はマスクで handCount/commodityCount、自分は実手札）。
function resCountOf(s: GameState, pid: string): number {
  const p = s.players[pid]; if (!p) return 0;
  return p.handCount ?? RESOURCE_TYPES.reduce((a, r) => a + p.hand[r], 0);
}
function comCountOf(s: GameState, pid: string): number {
  const p = s.players[pid]; if (!p) return 0;
  return p.commodityCount ?? (p.commodities ? COMMODITY_TYPES.reduce((a, c) => a + p.commodities![c], 0) : 0);
}

// 略奪演出: 伏せカード(種類非公開)が被害者パネル→略奪者パネルへ1枚飛ぶ。
function animateStealCard(fromPid: string, toPid: string): void {
  if (fxSpeed() === 'instant' || prefersReducedMotion()) return;
  const fromEl = flyTargetFor(fromPid);
  const toEl = flyTargetFor(toPid);
  if (!fromEl || !toEl) return;
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  if ((fr.width === 0 && fr.height === 0) || (tr.width === 0 && tr.height === 0)) return;
  const from = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
  const to = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
  const card = document.createElement('div');
  card.className = 'steal-card';
  card.style.left = `${from.x}px`;
  card.style.top = `${from.y}px`;
  card.style.setProperty('--tx', `${to.x - from.x}px`);
  card.style.setProperty('--ty', `${to.y - from.y}px`);
  document.body.appendChild(card);
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('go')));
  setTimeout(() => card.remove(), 720);
}

/** 盗賊が移動元→移動先へスライドする演出。移動先で着地ハイライト。 */
function animateRobberMove(fromTileId: string, toTileId: string): void {
  if (fxSpeed() === 'instant' || prefersReducedMotion() || fromTileId === toTileId) return;
  const from = tileScreenCenter(fromTileId);
  const to = tileScreenCenter(toTileId);
  if (!from || !to) return;
  const boardArea = document.getElementById('board-area');
  boardArea?.classList.add('robber-sliding'); // スライド中は静的コマを隠す（二重表示防止）

  const fly = document.createElement('div');
  fly.className = 'robber-fly';
  fly.style.left = `${from.x}px`;
  fly.style.top  = `${from.y}px`;
  fly.style.setProperty('--tx', `${to.x - from.x}px`);
  fly.style.setProperty('--ty', `${to.y - from.y}px`);
  // 飛ぶコマは盤上と同じ現行SVGデザインを複製して載せる（旧🦹絵文字は使わない＝
  // 移動中に別キャラが動いて見える二重表現を解消）。複製不可なら絵文字でフォールバック。
  appendRobberFlyVisual(fly);
  document.body.appendChild(fly);
  requestAnimationFrame(() => requestAnimationFrame(() => fly.classList.add('go')));

  setTimeout(() => {
    fly.remove();
    boardArea?.classList.remove('robber-sliding');
    const robber = document.querySelector('#board .robber') as SVGGElement | null;
    if (robber) {
      robber.classList.add('robber-landed');
      setTimeout(() => robber.classList.remove('robber-landed'), 650);
    }
  }, 560);
}

// ============================================================
// 勝利演出（派手な勝利モーダル＋紙吹雪）
// ============================================================

const PLAYER_HEX: Record<string, string> = {
  player1: '#e03030', player2: '#3060e0', player3: '#a855f7', player4: '#f0a020',
};
const CONFETTI_COLORS = ['#ffd700', '#ff5b5b', '#5ba8f5', '#a855f7', '#f0a020', '#7aee40', '#ffffff'];
// 勝利を確定させたアクションから勝因を推定（不明なら「10点到達」）
const VICTORY_REASON: Record<string, string> = {
  BUILD_CITY:       '都市建設で勝利！',
  BUILD_SETTLEMENT: '開拓地建設で勝利！',
  PLAY_KNIGHT:      '最大騎士力で勝利！',
  BUILD_ROAD:       '最長交易路で勝利！',
  BUY_DEV_CARD:     '勝利点カードで勝利！',
};

// 終了画面の順位ラベル。
const RANK_LABEL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '4位' };

function scoreChip(text: string, bonus = false): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `score-chip${bonus ? ' bonus' : ''}`;
  s.textContent = text;
  return s;
}
// 内訳チップ（先頭に素材アイコン＋テキスト）。絵文字をやめ画像で統一。icon=null はテキストのみ。
function scoreChipIcon(icon: string | null | undefined, text: string, bonus = false, title?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `score-chip${bonus ? ' bonus' : ''}`;
  if (title) s.title = title;
  if (icon) { const img = document.createElement('img'); img.className = 'score-chip-ic'; img.src = icon; img.alt = ''; img.draggable = false; s.appendChild(img); }
  s.appendChild(document.createTextNode(text));
  return s;
}

// 終了後スコアボード: 全員の順位・名前・最終VP・内訳・プレイ講評を表示する。
// ゲーム終了後は秘匿を続ける意味が無いため、全員のVPカード込み内部VPを開示する。
function buildVictoryScoreboard(): HTMLDivElement {
  const me = selfPlayerId();
  const rows = state.playerOrder.map(pid => {
    const vp = calcVP(state, pid);
    return { pid, vp, recap: buildPlayerRecap(state, pid) };
  });
  // 表示VPの降順。同点はゲーム手番順で安定させる。
  rows.sort((a, b) => b.vp - a.vp || state.playerOrder.indexOf(a.pid) - state.playerOrder.indexOf(b.pid));

  const wrap = document.createElement('div');
  wrap.className = 'score-board';
  const title = document.createElement('div');
  title.className = 'score-board-title';
  title.textContent = '最終結果';
  wrap.appendChild(title);

  rows.forEach((row, i) => {
    const p = state.players[row.pid];
    if (!p) return;
    const color = PLAYER_HEX[row.pid] ?? '#aaa';
    const rank = i + 1;
    const rowEl = document.createElement('div');
    rowEl.className = `score-row${row.pid === state.winner ? ' winner' : ''}${row.pid === me ? ' self' : ''}`;
    rowEl.style.setProperty('--row-color', color);

    const head = document.createElement('div');
    head.className = 'score-head';
    const rankEl = document.createElement('span');
    rankEl.className = `score-rank rank-${rank}`;
    rankEl.textContent = RANK_LABEL[rank] ?? `${rank}位`;
    const dot = document.createElement('span'); dot.className = 'score-dot'; dot.style.background = color;
    const name = document.createElement('span'); name.className = 'score-name';
    name.textContent = `${p.name}${p.type === 'ai' ? '（CPU）' : ''}${row.pid === me ? '〔あなた〕' : ''}`;
    const vpEl = document.createElement('span'); vpEl.className = 'score-vp'; vpEl.textContent = `★${row.vp}`;
    head.append(rankEl, dot, name, vpEl);
    rowEl.appendChild(head);

    const r = row.recap;
    const bd = document.createElement('div');
    bd.className = 'score-bd';
    const plainCities = Math.max(0, r.cities - r.metropolises); // メトロポリスは別チップで出すので二重計上しない
    if (r.settlements > 0) bd.appendChild(scoreChipIcon(ASSETS.piece.settlement, `×${r.settlements}`, false, '開拓地（各1点）'));
    if (plainCities > 0)   bd.appendChild(scoreChipIcon(ASSETS.piece.city, `×${plainCities}`, false, '都市（各2点）'));
    // 騎士と商人: メトロポリス（各4点：都市の基本2点＋発展ボーナス2点）。基本ゲームには存在しない。
    // 都市チップから除外している（plainCities）ため、ここで都市基本2点も含めた合計4点を表示し、★VPと内訳を一致させる。
    if (r.metropolises > 0) bd.appendChild(scoreChipIcon(metropolisImg(p.color), `×${r.metropolises}（+${r.metropolises * 4}）`, true, 'メトロポリス（各4点）'));
    if (r.hasLongestRoad)  bd.appendChild(scoreChipIcon(ASSETS.action.road, '最長+2', true, '最長交易路'));
    // 最大騎士力は基本ゲームのみ（騎士と商人は騎士コマ制のため非表示）。
    if (!r.isCk && r.hasLargestArmy) bd.appendChild(scoreChipIcon(ASSETS.knight.basic, '最大+2', true, '最大騎士力'));
    // 騎士と商人: 蛮族撃退の守護者VP。
    if (r.isCk && r.defenderVP > 0) bd.appendChild(scoreChipIcon(ASSETS.piece.defenderBadge, `守護+${r.defenderVP}`, true, '蛮族を退けた守護者（各+1点）'));
    // 騎士と商人: 商人コマ保持（+1点・公開）。
    if (r.isCk && r.hasMerchant) bd.appendChild(scoreChipIcon(ASSETS.piece.merchant, '商人+1', true, '商人コマ保持中（+1点）'));
    // 騎士と商人: 進歩カードの永久勝利点（印刷/立憲、各+1点・公開）。
    if (r.isCk && r.progressVP > 0) bd.appendChild(scoreChipIcon(null, `★永久+${r.progressVP}`, true, '進歩カードの永久勝利点（印刷/立憲など・各+1点）'));
    // 航海者: 新しい島への入植（各+2点）。専用素材が無いため記号で表示。
    if (r.islandBonus > 0) bd.appendChild(scoreChipIcon(null, `🏝+${r.islandBonus * 2}`, true, '新しい島への入植（各+2点）'));
    // VPカード枚数はゲーム終了後なので全員開示する。
    const vpCards = p.devCards.filter(c => c.type === 'victory_point').length;
    if (vpCards > 0) bd.appendChild(scoreChipIcon(null, `★カード×${vpCards}`, false, '勝利点カード（各1点）'));
    if (bd.childElementCount > 0) rowEl.appendChild(bd);

    const cm = document.createElement('div');
    cm.className = 'score-comment';
    cm.textContent = r.comment;
    rowEl.appendChild(cm);

    wrap.appendChild(rowEl);
  });
  return wrap;
}

function showVictoryOverlay(winnerId: PlayerId, causeAction: string): void {
  document.querySelector('.victory-overlay')?.remove(); document.getElementById('victory-reopen-btn')?.remove(); document.querySelector('.dicestats-overlay')?.remove(); document.getElementById('cpu-status')?.remove();
  vibrate([20, 40, 20, 40, 50]); // 勝利の触覚（多くは建設経由で勝つため DECLARE_VICTORY 以外でも鳴らす）
  if (!state) return;
  const winner = state.players[winnerId];
  if (!winner) return;
  const color = PLAYER_HEX[winnerId] ?? '#ffd700';
  const vp = calcVP(state, winnerId);
  const isHuman = winner.type === 'human';
  const reason = VICTORY_REASON[causeAction] ?? `${victoryTarget(state)}点到達で勝利！`;

  const overlay = document.createElement('div');
  overlay.className = 'victory-overlay';
  overlay.style.setProperty('--win-color', color);
  // 勝利全面背景（祝祭の島）＋可読性スクリム。スクリムを画像の上に重ねてモーダル文字を読みやすく。
  if (ASSETS.bg.victory) {
    overlay.style.background =
      `radial-gradient(120% 100% at 50% 0%, rgba(8,28,32,0.5), rgba(2,8,10,0.82)), url("${ASSETS.bg.victory}") center/cover no-repeat`;
  }

  // 紙吹雪（アニメ抑制時は省略。勝者発表モーダルは静的に表示する）。
  if (!prefersReducedMotion()) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    for (let i = 0; i < 80; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!;
      piece.style.animationDelay = `${Math.random() * 0.9}s`;
      piece.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      confetti.appendChild(piece);
    }
    overlay.appendChild(confetti);
  }

  // モーダル
  const modal = document.createElement('div');
  modal.className = 'victory-modal';
  modal.style.borderColor = color;

  const trophy = document.createElement('div');
  trophy.className = 'victory-trophy';
  trophy.textContent = isHuman ? '🎉🏆🎉' : '🏆';
  modal.appendChild(trophy);

  const dot = document.createElement('span'); dot.className = 'victory-dot'; dot.style.background = color;
  const nameEl = document.createElement('div');
  nameEl.className = 'victory-name';
  nameEl.style.color = color;
  nameEl.append(dot, document.createTextNode(`${winner.name} 勝利！`));
  modal.appendChild(nameEl);

  const vpEl = document.createElement('div');
  vpEl.className = 'victory-vp';
  vpEl.textContent = `★${vp} 到達`;
  modal.appendChild(vpEl);

  const reasonEl = document.createElement('div');
  reasonEl.className = 'victory-reason';
  reasonEl.textContent = reason;
  modal.appendChild(reasonEl);

  // 全員の順位・最終VP・内訳・プレイ講評（スマホ縦でも読めるよう縦並び＋スクロール）。
  modal.appendChild(buildVictoryScoreboard());

  const btnRow = document.createElement('div');
  btnRow.className = 'victory-btns';
  if (lastConfig) {
    const again = document.createElement('button');
    again.className = 'btn-nav btn-nav-primary';
    again.textContent = '🔄 もう一度遊ぶ';
    again.addEventListener('click', () => { overlay.remove(); if (lastConfig) startGame(lastConfig); });
    btnRow.appendChild(again);
  }
  const home = document.createElement('button');
  home.className = 'btn-nav';
  home.textContent = '🏠 ホームに戻る';
  home.addEventListener('click', () => { overlay.remove(); returnToHome(); });
  btnRow.appendChild(home);
  // 勝利後でもこのゲームの出目分布を見られるように
  const statsBtn = document.createElement('button');
  statsBtn.className = 'btn-nav';
  statsBtn.textContent = '🎲 出目分布';
  statsBtn.addEventListener('click', () => showDiceStatsModal());
  btnRow.appendChild(statsBtn);
  // 結果モーダルを一時的に隠して最終盤面をゆっくり見る（感想戦用）。フローティングボタンで結果に戻せる。
  const viewBoardBtn = document.createElement('button');
  viewBoardBtn.className = 'btn-nav';
  viewBoardBtn.textContent = '🗺 最終盤面を見る';
  viewBoardBtn.addEventListener('click', () => hideVictoryOverlayForBoardView(overlay));
  btnRow.appendChild(viewBoardBtn);
  modal.appendChild(btnRow);
  overlay.appendChild(modal);

  // 優勝スプラッシュ: 蛮族襲来のように全画面の祝祭画像（島の花火）を数秒だけ見せてから
  // 結果モーダルを出す。アニメ抑制時／画像が無い時はスプラッシュを省略してすぐ結果へ。
  const splashMs = (prefersReducedMotion() || !ASSETS.bg.victory) ? 0 : 2600;
  let splash: HTMLDivElement | null = null;
  if (splashMs > 0) {
    modal.classList.add('victory-pending');
    splash = document.createElement('div');
    splash.className = 'victory-splash';
    const big = document.createElement('div');
    big.className = 'victory-splash-title';
    big.style.color = color;
    const t = document.createElement('div'); t.className = 'victory-splash-trophy'; t.textContent = isHuman ? '🎉🏆🎉' : '🏆';
    const n = document.createElement('div'); n.textContent = `${winner.name} 勝利！`;
    big.append(t, n);
    splash.appendChild(big);
    overlay.appendChild(splash);
  }

  document.body.appendChild(overlay);

  const reveal = () => {
    if (splash) {
      const s = splash;
      s.classList.add('fade-out');
      window.setTimeout(() => s.remove(), 360);
    }
    modal.classList.remove('victory-pending');
    modal.classList.add('victory-reveal');
  };
  if (splashMs > 0) window.setTimeout(reveal, splashMs);
  // 勝者パネルの発光は buildPlayerPanel 側で付与（再描画後も維持される）
}

// 勝利モーダルを一時的に隠し、最終盤面をゆっくり見られるようにする（感想戦用）。
// フローティングの再表示ボタンを残し、いつでも結果画面へ戻れる。
function hideVictoryOverlayForBoardView(overlay: HTMLDivElement): void {
  overlay.classList.add('victory-hidden');
  document.getElementById('victory-reopen-btn')?.remove();
  const reopen = document.createElement('button');
  reopen.id = 'victory-reopen-btn';
  reopen.textContent = '🏆 結果を見る';
  reopen.addEventListener('click', () => {
    overlay.classList.remove('victory-hidden');
    reopen.remove();
  });
  document.body.appendChild(reopen);
}

// ============================================================
// 出目分布グラフ（現在ゲームのダイス集計を簡易棒グラフで表示）
// ============================================================

function showDiceStatsModal(): void {
  document.querySelector('.dicestats-overlay')?.remove();

  const total = diceStats.reduce((s, n) => s + n, 0);
  const maxCount = Math.max(1, ...diceStats.slice(2, 13));
  let mostFreq = 0, mostFreqCount = -1;
  for (let n = 2; n <= 12; n++) {
    if ((diceStats[n] ?? 0) > mostFreqCount) { mostFreqCount = diceStats[n] ?? 0; mostFreq = n; }
  }

  const overlay = document.createElement('div');
  overlay.className = 'dicestats-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement('div');
  modal.className = 'dicestats-modal';

  const header = document.createElement('div');
  header.className = 'dicestats-header';
  header.textContent = '🎲 出目分布（このゲーム）';
  modal.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'dicestats-summary';
  summary.textContent = total === 0
    ? 'まだダイスを振っていません'
    : `合計 ${total} 回 ・ 最多 ${mostFreq}（${mostFreqCount}回） ・ 7は ${diceStats[7] ?? 0}回`;
  modal.appendChild(summary);

  const chart = document.createElement('div');
  chart.className = 'dicestats-chart';
  for (let n = 2; n <= 12; n++) {
    const count = diceStats[n] ?? 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = `dicestats-row${n === 7 ? ' seven' : ''}${n === mostFreq && count > 0 ? ' most' : ''}`;
    const label = document.createElement('span'); label.className = 'dicestats-num'; label.textContent = String(n);
    const track = document.createElement('div'); track.className = 'dicestats-track';
    const bar = document.createElement('div'); bar.className = 'dicestats-bar';
    // 0回は空、1回以上は見やすい最小幅を確保
    bar.style.width = count > 0 ? `${Math.max(5, Math.round((count / maxCount) * 100))}%` : '0';
    track.appendChild(bar);
    const val = document.createElement('span'); val.className = 'dicestats-val';
    val.textContent = total > 0 ? `${count}回 (${pct}%)` : `${count}回`;
    row.append(label, track, val);
    chart.appendChild(row);
  }
  modal.appendChild(chart);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-nav';
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', () => overlay.remove());
  const btnRow = document.createElement('div');
  btnRow.className = 'dicestats-btns';
  btnRow.appendChild(closeBtn);
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}


/** サイコロ産出タイルの画面座標を取得する */
function getProducingTileOrigin(diceTotal: number): { x: number; y: number } | null {
  const boardEl = document.getElementById('board') as SVGSVGElement | null;
  if (!boardEl) return null;
  // state から diceTotal に対応するタイルを探す
  const producingTiles = Object.values(state.tiles).filter(
    t => t.number === diceTotal && !t.hasRobber,
  );
  if (producingTiles.length === 0) return null;
  // 最初のタイルの axial 座標からピクセル中心を求める
  const tile = producingTiles[0]!;
  // SVG内座標: axialToPixel を使えないが、data-tile-id から g 要素の位置が取れる
  const tileG = boardEl.querySelector(`[data-tile-id="${tile.id}"]`) as SVGGElement | null;
  if (!tileG) return null;
  const tileRect = tileG.getBoundingClientRect();
  return {
    x: tileRect.left + tileRect.width / 2,
    y: tileRect.top  + tileRect.height / 2,
  };
}

/** ボード中心の画面座標 */
function getBoardCenter(): { x: number; y: number } {
  const boardEl = document.getElementById('board');
  if (!boardEl) return { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  const r = boardEl.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** ダイス目に対応する産出タイルを一時的に強調表示（どのタイルから資源が出たか分かりやすく） */
function highlightProducingTiles(diceTotal: number): void {
  if (fxSpeed() === 'instant') return;
  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  for (const tile of Object.values(state.tiles)) {
    if (tile.number !== diceTotal || tile.hasRobber) continue;
    const poly = boardEl.querySelector(`[data-tile-id="${tile.id}"] .hex-tile`) as SVGElement | null;
    if (!poly) continue;
    poly.classList.add('producing');
    setTimeout(() => poly.classList.remove('producing'), 1600);
  }
}

// ダイス以外（年の豊穣等）での手札増加。LANでは自分のみ非0（相手はマスクで0）。
function handDiffGains(oldState: GameState, newState: GameState, pid: string): Array<{ r: ResourceType; n: number }> {
  const oldH = oldState.players[pid]?.hand;
  const newH = newState.players[pid]?.hand;
  if (!oldH || !newH) return [];
  const gains: Array<{ r: ResourceType; n: number }> = [];
  for (const r of RESOURCE_TYPES) {
    const diff = newH[r] - oldH[r];
    if (diff > 0) gains.push({ r, n: diff });
  }
  return gains;
}

// 商品(紙/布/金貨)の手札差分（増分のみ）。非ダイスの取得（交易等）で自分の増分を飛ばす用。
function commodityDiffGains(oldState: GameState, newState: GameState, pid: string): Array<{ c: CommodityType; n: number }> {
  const oldC = oldState.players[pid]?.commodities;
  const newC = newState.players[pid]?.commodities;
  if (!oldC || !newC) return [];
  const gains: Array<{ c: CommodityType; n: number }> = [];
  for (const c of COMMODITY_TYPES) {
    const diff = (newC[c] ?? 0) - (oldC[c] ?? 0);
    if (diff > 0) gains.push({ c, n: diff });
  }
  return gains;
}

// 資源 r を「このダイス目で産出し、かつ pid の建物に隣接する」タイルの画面中心を返す。
// 見つからなければ その資源の産出タイル先頭 → 産出タイル → 盤面中央 へフォールバック。
// 参照は公開情報（タイル/数字/強盗/盤面の建物）のみ。
function originForGain(diceTotal: number, pid: string, r: ResourceType): { x: number; y: number } {
  const boardEl = document.getElementById('board');
  const screenOf = (tileId: string): { x: number; y: number } | null => {
    const g = boardEl?.querySelector(`[data-tile-id="${tileId}"]`) as SVGGElement | null;
    if (!g) return null;
    const rect = g.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  let firstOfRes: string | null = null;
  for (const tile of Object.values(state.tiles)) {
    if (tile.number !== diceTotal || tile.hasRobber) continue;
    if (TILE_RESOURCE_MAP[tile.type] !== r) continue;
    if (firstOfRes == null) firstOfRes = tile.id;
    const vids = state.tileToVertices[tile.id] ?? [];
    if (vids.some(v => state.vertices[v]?.building?.playerId === pid)) {
      const pos = screenOf(tile.id);
      if (pos) return pos;
    }
  }
  if (firstOfRes) { const pos = screenOf(firstOfRes); if (pos) return pos; }
  return getProducingTileOrigin(diceTotal) ?? getBoardCenter();
}

// 商品 c を「このダイス目で産出し、かつ pid の都市に隣接する」タイルの画面中心を返す。
// 商品は都市からのみ産出（森=紙/牧草=布/山=金貨）。見つからなければ該当地形タイル→盤面中央へ。
function originForCommodity(diceTotal: number, pid: string, c: CommodityType): { x: number; y: number } {
  const boardEl = document.getElementById('board');
  const screenOf = (tileId: string): { x: number; y: number } | null => {
    const g = boardEl?.querySelector(`[data-tile-id="${tileId}"]`) as SVGGElement | null;
    if (!g) return null;
    const rect = g.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  let firstOfCom: string | null = null;
  for (const tile of Object.values(state.tiles)) {
    if (tile.number !== diceTotal || tile.hasRobber) continue;
    if (TILE_COMMODITY_MAP[tile.type] !== c) continue;
    if (firstOfCom == null) firstOfCom = tile.id;
    const vids = state.tileToVertices[tile.id] ?? [];
    if (vids.some(v => state.vertices[v]?.building?.type === 'city' && state.vertices[v]?.building?.playerId === pid)) {
      const pos = screenOf(tile.id);
      if (pos) return pos;
    }
  }
  if (firstOfCom) { const pos = screenOf(firstOfCom); if (pos) return pos; }
  return getBoardCenter();
}

// 演出を省略すべきか。trueなら派手な動きは省略し即時化する（資源飛行・サイコロ回転・
// カード大表示・建設ポップ・紙吹雪など全演出の共通ゲート）。
// 判定はアプリ内設定（animFxMode）を最優先する。既定はON＝OSの reduced-motion を無視して
// 必ず演出を出す（オンライン対戦で各端末のOS設定差により演出がバラつくのを防ぐ）。
// ユーザーが設定メニューで明示OFFにしたときだけ省略する。
function prefersReducedMotion(): boolean {
  return animFxMode() === 'off';
}

// 初期配置2軒目（SETUP_BACKWARD）で配る初期資源を公開情報から導出して飛ばす。
// 「どの資源を配るか」は付与(game.ts)と同じ setupGainFor に一本化（ロジックのドリフト防止）。
// 配置頂点の隣接タイル＋バンク残はいずれも公開情報なので、LANで相手の手札が
// マスクされていても全員分のアニメを出せる（手札差分だと相手は0で出なかった）。
function animateSetupGain(oldState: GameState, vertexId: string): void {
  const pid = oldState.playerOrder[oldState.currentPlayerIndex];
  if (!pid) return;
  const targetEl = flyTargetFor(pid);
  if (!targetEl) return;
  const tr = targetEl.getBoundingClientRect();
  if (tr.width === 0 && tr.height === 0) return;
  const target = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };

  // 獲得資源は付与と同じ純粋関数で導出。初期配置はバンク枯渇しないため現在の bank で可。
  const gains = setupGainFor(oldState, vertexId, oldState.bank);
  if (gains.length === 0) return;

  // 飛び元（表示用）: 配置頂点に隣接する「その資源を産むタイル」を順に割り当てる。
  const tilesByRes = new Map<ResourceType, string[]>();
  for (const [tid, vids] of Object.entries(oldState.tileToVertices)) {
    if (!vids.includes(vertexId)) continue;
    const r = TILE_RESOURCE_MAP[oldState.tiles[tid]?.type ?? 'desert'];
    if (!r) continue;
    const list = tilesByRes.get(r) ?? [];
    list.push(tid);
    tilesByRes.set(r, list);
  }

  let delay = 0;
  for (const r of gains) {
    const tid = tilesByRes.get(r)?.shift();
    const origin = (tid ? tileScreenCenter(tid) : null) ?? getBoardCenter();
    const jitter = { x: origin.x + (Math.random() - 0.5) * 30, y: origin.y + (Math.random() - 0.5) * 20 };
    spawnResFlyer(RES_FLY_IMG[r], target, jitter, delay, targetEl);
    delay += RES_FLY_STAGGER;
  }
}

function triggerResourceAnimation(
  oldState: GameState,
  newState: GameState,
  action?: Action,
  diceTotal?: number,
): void {
  if (fxSpeed() === 'instant' || prefersReducedMotion()) return;
  // 盗み取り(MOVE_ROBBER)は飛ばさない（奪った資源の種類を秘匿するため）。
  if (action?.type === 'MOVE_ROBBER') return;

  // 初期配置の「最後の軒」で配る初期資源を公開情報から導出する（LANでも相手分のアニメを出すため）。
  // 標準/航海者は2軒目、S6 織物は3軒目。それ以前の軒は資源なしなので飛ばさない。
  if (action?.type === 'BUILD_SETTLEMENT'
      && (oldState.phase === 'SETUP_FORWARD' || oldState.phase === 'SETUP_BACKWARD')
      && oldState.setupSubPhase === 'PLACE_SETTLEMENT') {
    const setupTarget = oldState.startingSettlements ?? 2;
    const spid = oldState.playerOrder[oldState.currentPlayerIndex];
    const placedBefore = spid
      ? Object.values(oldState.vertices).filter(v => v.building?.playerId === spid).length
      : 0;
    if (placedBefore + 1 >= setupTarget) animateSetupGain(oldState, action.vertexId);
    return;
  }

  // ダイス産出は公開情報。盤面（タイル/数字/強盗/建物）とバンクから各プレイヤーの
  // 実獲得を導出し、全員分のアイコンを該当ヘックスからパネルへ飛ばす。
  // 騎士と商人では「資源＋商品(紙/布/金貨)」を都市産出に合わせて飛ばす（資源と同じ演出）。
  // LANでは相手の手札がマスクされ手札差分が0になるため、この公開導出が必須。
  // ダイス以外（交易・年の豊穣等）は手札差分（自分のみ公開）で資源・商品とも飛ばす。
  const isDice = action?.type === 'ROLL_DICE' && diceTotal !== undefined;
  const ck = isCk(newState);
  // 騎士と商人: 蛮族敗北(CITY_DOWNGRADE)・進歩カード上限(PROGRESS_DISCARD)では生産が「保留」される。
  // ロールでこれらの保留フェーズに入った時はまだ資源が配られていないので生産アニメを出さない
  // （出すと「幻の資源」が飛び、さらに分配アニメ用ゲートで進行が約2秒固まる＝手前の処理が
  //   終わっていないように見える原因になっていた）。生産は保留が解けた時に出す。
  // T&B イベントカード: イベント効果の選択待ち（EVENT_* / イベント由来のGOLD）中も生産は「保留」。
  const rollDeferred = action?.type === 'ROLL_DICE'
    && (newState.turnPhase === 'CITY_DOWNGRADE' || newState.turnPhase === 'PROGRESS_DISCARD'
      || newState.tbPendingEventNumber != null);
  // 保留が全て解決して生産が確定した瞬間（DOWNGRADE_CITY / DISCARD_PROGRESS でフェーズが抜けた）。
  const ckDeferredResolved = ck
    && (action?.type === 'DOWNGRADE_CITY' || action?.type === 'DISCARD_PROGRESS')
    && (oldState.turnPhase === 'CITY_DOWNGRADE' || oldState.turnPhase === 'PROGRESS_DISCARD')
    && newState.turnPhase !== 'CITY_DOWNGRADE' && newState.turnPhase !== 'PROGRESS_DISCARD';
  // T&B: イベント選択の最後の1手（CHOOSE_EVENT_* / CHOOSE_GOLD）で保留数字が消えた＝生産が走った瞬間。
  const tbDeferredResolved = (action?.type === 'CHOOSE_EVENT_GIVE' || action?.type === 'CHOOSE_EVENT_HELPFUL'
      || action?.type === 'CHOOSE_EVENT_STEAL' || action?.type === 'CHOOSE_EVENT_DAMAGE' || action?.type === 'CHOOSE_GOLD')
    && oldState.tbPendingEventNumber != null && newState.tbPendingEventNumber == null;
  const deferredResolved = ckDeferredResolved || tbDeferredResolved;
  // ダイス生産アニメを出す総数。通常ロール（保留なし）か、保留解決時。盤面は確定後の newState 基準
  //（保留中に格下げされた都市を反映＝実際に配られた量と一致）。
  const prodTotal = isDice ? diceTotal
    : deferredResolved ? ((newState.lastDiceRoll?.[0] ?? 0) + (newState.lastDiceRoll?.[1] ?? 0))
    : undefined;
  const animateDiceProd = ((isDice && !rollDeferred) || deferredResolved) && prodTotal !== undefined && prodTotal !== 7;
  const ckProd = (animateDiceProd && ck) ? computeCkProduction(newState, prodTotal!) : null;
  const baseProd = (animateDiceProd && !ck) ? computeDiceProduction(newState, prodTotal!) : null;

  const MAX_PER_PLAYER = 8; // スマホで重くならないよう1人あたりの上限（商品分を見込み少し増やす）
  // 蛮族襲来の全画面演出が出ている間は、それが消えて盤面が見えてから飛ばす（被り防止）。
  // delay は演出の残り時間から始めるため「飛ばしたか」は spawned で別に判定する。
  let delay = pendingOverlayDelay();
  // stagger 累積の上限（大量産出でもCPUを長時間ブロックしないよう頭打ちにする）。
  const staggerCeil = delay + MAX_STAGGER_TOTAL;
  let spawned = false;
  for (const pid of newState.playerOrder) {
    // 飛ばすアイコン群（資源・商品を統一して扱う）。hidden=種類非公開（札裏トークン）。
    const flyables: Array<{ img: string; origin: { x: number; y: number }; n: number; hidden?: boolean }> = [];
    if (ckProd) {
      for (const r of RESOURCE_TYPES) { const n = ckProd.resources[pid]?.[r] ?? 0; if (n > 0) flyables.push({ img: RES_FLY_IMG[r], origin: originForGain(prodTotal!, pid, r), n }); }
      for (const c of COMMODITY_TYPES) { const n = ckProd.commodities[pid]?.[c] ?? 0; if (n > 0) flyables.push({ img: COM_FLY_IMG[c], origin: originForCommodity(prodTotal!, pid, c), n }); }
    } else if (baseProd) {
      for (const r of RESOURCE_TYPES) { const n = baseProd[pid]?.[r] ?? 0; if (n > 0) flyables.push({ img: RES_FLY_IMG[r], origin: originForGain(prodTotal!, pid, r), n }); }
    } else if (!rollDeferred) {
      // 非ダイス獲得（交易・年の豊穣・進歩カード効果など）。自分や同一端末の相手は手札差分で
      // 種類まで出せる。LANの他プレイヤーは手札がマスクされ差分0になるため、公開の合計枚数の
      // 増分だけ札裏トークンで飛ばす（種類は秘匿のまま「何枚得たか」を全員に見せる）。
      const c0 = getBoardCenter();
      const exact: Array<{ img: string; n: number }> = [];
      for (const { r, n } of handDiffGains(oldState, newState, pid)) exact.push({ img: RES_FLY_IMG[r], n });
      for (const { c, n } of commodityDiffGains(oldState, newState, pid)) exact.push({ img: COM_FLY_IMG[c], n });
      if (exact.length > 0) {
        for (const e of exact) flyables.push({ img: e.img, origin: c0, n: e.n });
      } else {
        // 資源・商品それぞれの増分を別々に見る。片方が減りもう片方が増える札
        // （例: 商業港=資源を渡し商品を得る）でも、増えた側を伏せ札で見せる。
        const gain = Math.max(0, resCountOf(newState, pid) - resCountOf(oldState, pid))
                   + Math.max(0, comCountOf(newState, pid) - comCountOf(oldState, pid));
        if (gain > 0) flyables.push({ img: '', origin: c0, n: gain, hidden: true });
      }
    }
    if (flyables.length === 0) continue;
    const targetEl = flyTargetFor(pid);
    if (!targetEl) continue;
    // 着地先の中央座標を“今”確定させる（再描画でミニパネルが作り直されても飛行は崩れない）。
    const tr = targetEl.getBoundingClientRect();
    if (tr.width === 0 && tr.height === 0) continue;
    const target = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };

    let count = 0;
    for (const { img, origin, n, hidden } of flyables) {
      for (let i = 0; i < n && count < MAX_PER_PLAYER; i++) {
        const jitter = { x: origin.x + (Math.random() - 0.5) * 30, y: origin.y + (Math.random() - 0.5) * 20 };
        spawnResFlyer(img, target, jitter, delay, targetEl, 'res-fly-img', !!hidden);
        delay = Math.min(delay + RES_FLY_STAGGER, staggerCeil); // 1個ずつ間隔を空ける（上限 staggerCeil で頭打ち＝大量時もCPUを長く止めない）
        count++; spawned = true;
      }
    }
  }
  // 飛行が出た場合は完了までCPUの次手（特に次のダイス）を待たせ、サイコロと飛行の被りを防ぐ。
  if (spawned) holdResourceAnimating(delay + RES_FLY_MS + 120);
}

// 騎士と商人: 進歩カードを得たプレイヤーへ、デッキ色の札がパネルへ飛ぶ演出（資源と同じ仕組み）。
// 公開情報の progressCardCount 差分で全員分（自分・相手）を出す。種類は秘匿なので札裏で飛ばす。
function triggerProgressCardAnimation(oldState: GameState, newState: GameState): void {
  if (fxSpeed() === 'instant' || prefersReducedMotion()) return;
  if (!isCk(newState)) return;
  const ev = newState.lastEventDie;
  const eventDeck = (ev === 'trade' || ev === 'politics' || ev === 'science') ? ev : null;
  const me = selfPlayerId();
  const origin = getBoardCenter();
  // 蛮族襲来の全画面演出が出ている間（撃退同点でカードが出る等）は、消えてから飛ばす。
  let delay = pendingOverlayDelay();
  let any = false;
  for (const pid of newState.playerOrder) {
    const before = oldState.players[pid]?.progressCardCount ?? oldState.players[pid]?.progressCards?.length ?? 0;
    const after = newState.players[pid]?.progressCardCount ?? newState.players[pid]?.progressCards?.length ?? 0;
    const gained = after - before;
    if (gained <= 0) continue;
    const targetEl = flyTargetFor(pid);
    if (!targetEl) continue;
    const tr = targetEl.getBoundingClientRect();
    if (tr.width === 0 && tr.height === 0) continue;
    const target = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
    // デッキ色: 色イベントはその色、それ以外は自分は実カードのデッキ、相手は中立(政治)。
    const selfNewDecks = pid === me ? (newState.players[pid]?.progressCards ?? []).slice(-gained).map(c => c.deck) : null;
    for (let i = 0; i < gained && i < 4; i++) {
      const deck = eventDeck ?? selfNewDecks?.[i] ?? 'politics';
      spawnResFlyer(ASSETS.cardBack[deck], target, origin, delay, targetEl, 'pc-fly-img');
      delay += RES_FLY_STAGGER;
      any = true;
    }
  }
  // 保留フェーズ（都市格下げ/進歩カード捨て）へ入る時はゲートしない。次は「ロール」ではなく
  // 「解決操作」なので待たせる必要がなく、待たせると解決が固まって見える原因になる。
  const pendingPhase = newState.turnPhase === 'CITY_DOWNGRADE' || newState.turnPhase === 'PROGRESS_DISCARD';
  if (any && !pendingPhase) holdResourceAnimating(delay + RES_FLY_MS + 120);
}

// 騎士と商人: 誰かが進歩カードを手に入れたら「○○がカードを手に入れた」と盤面へ全体通知する。
// カードの種類は伏せる（公開情報の枚数差分だけを使う）。色イベント抽選・撃退同点・スパイ強奪など
// カードが増える全経路をカバーする。飛行アニメ（triggerProgressCardAnimation）は reduced-motion で
// 出ないため、情報としての告知はこちらで別に出す（reduced-motion でも表示）。蛮族襲来の全画面演出が
// 出ている間は、それが消えてから告知する（被り防止）。
function maybeNoticeProgressCardGain(prevState: GameState, newState: GameState): void {
  if (!isCk(newState)) return;
  const gainers: string[] = [];
  for (const pid of newState.playerOrder) {
    const before = prevState.players[pid]?.progressCardCount ?? prevState.players[pid]?.progressCards?.length ?? 0;
    const after = newState.players[pid]?.progressCardCount ?? newState.players[pid]?.progressCards?.length ?? 0;
    if (after > before) gainers.push(newState.players[pid]?.name ?? pid);
  }
  if (gainers.length === 0) return;
  const msg = `🎴 ${gainers.join('・')} がカードを手に入れた`;
  const delay = pendingOverlayDelay();
  if (delay > 0) window.setTimeout(() => showBoardNotice(msg, '#c9a227'), delay + 120);
  else showBoardNotice(msg, '#c9a227');
}

// 進歩カードを使用した瞬間、盤面中央へそのカードを大きく短時間表示する（何を使ったか分かりやすく）。
// 札種は公開情報 newState.lastProgressPlay から特定する（使うと全員に種類が分かる）。LAN では
// 使用者の手札が秘匿され prevState から札種を引けないため、この公開フィールドが他プレイヤー表示に必須。
function showPlayedProgressCard(prevState: GameState, newState: GameState, action: Action | undefined): void {
  if (!action || action.type !== 'PLAY_PROGRESS') return;
  if (fxSpeed() === 'instant' || prefersReducedMotion()) return;
  const actor = prevState.playerOrder[prevState.currentPlayerIndex];
  if (!actor) return;
  // 札種の特定（優先順）:
  //  1. action.cardType … 送信側が載せた公開情報（LANで他プレイヤーでも常に分かる・サーバ更新不要）
  //  2. newState.lastProgressPlay … サーバが刻む公開フィールド（サーバ更新時のフォールバック）
  //  3. prevState の使用者手札 … 単一端末/自分の手番（自分の札は公開）のフォールバック
  const cardType = action.cardType
    ?? (newState.lastProgressPlay?.playerId === actor ? newState.lastProgressPlay.cardType : undefined)
    ?? prevState.players[actor]?.progressCards?.find(c => c.id === action.cardId)?.type;
  if (!cardType) return;
  const host = document.getElementById('board-area');
  if (!host) return;
  document.getElementById('played-progress')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'played-progress';
  const img = document.createElement('img');
  img.className = 'played-progress-img';
  img.src = ASSETS.progressCard[cardType] ?? ASSETS.cardBack.politics;
  img.alt = PROGRESS_CARD_NAME[cardType];
  img.draggable = false;
  const cap = document.createElement('div');
  cap.className = 'played-progress-cap';
  cap.textContent = `📜 ${PROGRESS_CARD_NAME[cardType]}`;
  wrap.append(img, cap);
  host.appendChild(wrap);
  setTimeout(() => { wrap.classList.add('out'); }, PROGRESS_CARD_FX_MS - 450);
  setTimeout(() => wrap.remove(), PROGRESS_CARD_FX_MS);
  // CPUが進歩カードを使った時は、このカード表示が見えてから次手へ進ませる（演出スキップ防止）。
  // PLAY_PROGRESS はダイス演出を挟まないため、ゲートしないと aiDelayMs(最速30ms)で即次手に進む。
  holdResourceAnimating(PROGRESS_CARD_FX_MS);
}

// 自分のプレイヤーID（LAN=viewer、単一端末=human）。手番強調・得点演出の基準。
function selfPlayerId(): PlayerId | undefined {
  if (netMode) return viewerPlayerId ?? undefined;
  return state?.playerOrder.find(p => state.players[p]?.type === 'human');
}

// 得点(VP)が増えたプレイヤーのパネルを光らせ「+N VP」をポップ表示する。
// 自分は VPカード込み、相手は公開VPのみで判定する（相手の非公開VPカードは演出しない＝秘匿維持）。
function triggerVpGainEffects(prevState: GameState, newState: GameState): void {
  if (fxSpeed() === 'instant') return;
  const me = selfPlayerId();
  for (const pid of newState.playerOrder) {
    const before = pid === me ? calcVP(prevState, pid) : calcPublicVP(prevState, pid);
    const after  = pid === me ? calcVP(newState,  pid) : calcPublicVP(newState,  pid);
    const delta = after - before;
    if (delta > 0) popVpGain(pid, delta);
  }
  // 称号の移動（公開情報）は専用の少し派手な演出＋ファンファーレSE。
  // 旧保持者がいた場合は、バッジが旧→新保持者へ飛ぶ（C-7・移動の見落とし防止）。
  if (prevState.longestRoadHolder !== newState.longestRoadHolder && newState.longestRoadHolder) {
    if (prevState.longestRoadHolder) flyBadge(prevState.longestRoadHolder, newState.longestRoadHolder, '🛤');
    flashBonus(newState.longestRoadHolder, '🛤 最長交易路！');
  }
  if (prevState.largestArmyHolder !== newState.largestArmyHolder && newState.largestArmyHolder) {
    if (prevState.largestArmyHolder) flyBadge(prevState.largestArmyHolder, newState.largestArmyHolder, '⚔');
    flashBonus(newState.largestArmyHolder, '⚔ 最大騎士力！');
  }
}

// 称号バッジが旧保持者→新保持者のパネルへ飛ぶ演出（C-7）。reduced-motion/instantは省略。
function flyBadge(fromPid: string, toPid: string, glyph: string): void {
  if (fxSpeed() === 'instant' || prefersReducedMotion()) return;
  const fromEl = flyTargetFor(fromPid);
  const toEl = flyTargetFor(toPid);
  if (!fromEl || !toEl) return;
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  if ((fr.width === 0 && fr.height === 0) || (tr.width === 0 && tr.height === 0)) return;
  const from = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
  const to = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
  const b = document.createElement('div');
  b.className = 'badge-fly';
  b.textContent = glyph;
  b.style.left = `${from.x}px`;
  b.style.top = `${from.y}px`;
  b.style.setProperty('--tx', `${to.x - from.x}px`);
  b.style.setProperty('--ty', `${to.y - from.y}px`);
  document.body.appendChild(b);
  requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('go')));
  setTimeout(() => b.remove(), 900);
}

// プレイヤーパネル上に「+N VP」を浮かせ、パネルを短時間発光させる。
function popVpGain(pid: PlayerId, delta: number): void {
  // 資源フライと同じ flyTargetFor を使う: スマホ縦持ち(mini-mode)では実パネルが盤面下・
  // 横持ちのシート収納時は #ui ごと不可視のため、表示中のミニパネルを優先しないと
  // ポップが画面外/原点付近に出て見えない。非表示なら DOM ポップは省略（SEは鳴らす）。
  const panelEl = flyTargetFor(pid);
  const rect = panelEl?.getBoundingClientRect();
  if (!panelEl || !rect || (rect.width === 0 && rect.height === 0)) {
    setTimeout(() => playSE('vpGain'), 220);
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'vp-pop';
  pop.textContent = `+${delta}★`;
  pop.style.left = `${rect.left + rect.width / 2}px`;
  pop.style.top = `${rect.top + 8}px`;
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 1300);
  panelEl.classList.add('vp-gain-flash');
  setTimeout(() => panelEl.classList.remove('vp-gain-flash'), 900);
  // 建設SEと重ならないよう少し遅らせて「+点」を知らせる。
  setTimeout(() => playSE('vpGain'), 220);
}

// 称号獲得の演出（パネル発光＋ラベルポップ＋ファンファーレSE）。
function flashBonus(pid: PlayerId, label: string): void {
  // popVpGain と同様、表示中のミニパネル優先（モバイルで称号ポップが画面外に出るのを防ぐ）。
  const panelEl = flyTargetFor(pid);
  const rect = panelEl?.getBoundingClientRect();
  if (panelEl && rect && (rect.width > 0 || rect.height > 0)) {
    panelEl.classList.add('bonus-flash');
    setTimeout(() => panelEl.classList.remove('bonus-flash'), 1500);
    const pop = document.createElement('div');
    pop.className = 'bonus-pop';
    pop.textContent = label;
    pop.style.left = `${rect.left + rect.width / 2}px`;
    pop.style.top = `${rect.top - 2}px`;
    document.body.appendChild(pop);
    setTimeout(() => pop.remove(), 1900);
  }
  setTimeout(() => playSE('bonusGain'), 260);
}

// 自分の手番が始まった瞬間に、やわらかいチャイムで知らせる（他人の手番開始と区別）。
// 自分宛てのプレイヤー間交易提案が新たに来たら、操作パネル（提案UI）へゆっくりスクロールして気づかせる。
function maybeScrollToTradeOffer(prevState: GameState, newState: GameState): void {
  const me = selfPlayerId();
  if (!me) return;
  const offerForMe = (s: GameState): boolean => {
    const t = s.pendingTrade;
    // 申し込みが来て自分が未応答の対象である間（TRADE_OFFER/RESPONSE 両方）。
    // 以前は TRADE_RESPONSE のみ見ており、最初の TRADE_OFFER で盤面通知が出なかった。
    return !!(t && (t.state === 'TRADE_OFFER' || t.state === 'TRADE_RESPONSE') && t.targetPlayerIds.includes(me) && !t.responses[me]);
  };
  if (offerForMe(newState) && !offerForMe(prevState)) {
    // まず盤面に「交易の申し込み」メッセージを出して気づかせ、その後ゆっくり提案UIへスクロールする。
    const t = newState.pendingTrade;
    const proposer = t ? newState.players[t.initiatorId]?.name : null;
    showBoardNotice(`🤝 ${proposer ?? '相手'}から交易の申し込み`);
    setTimeout(() => {
      // 800ms の間に交易が解決/取消された場合はスクロールしない（古いスクロール抑止）。
      if (state && !offerForMe(state)) return;
      const target = (document.querySelector('.turn-panel .modal-panel')
        ?? document.querySelector('.turn-panel')) as HTMLElement | null;
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 800);
  }
}

// 盤面メッセージ（中央上に短く出す汎用トースト。交易申し込みなどの通知に使う）。
// レイアウトは崩さない absolute 配置。約2.2秒で自動消滅。
// 初心者モードの局面ガイド（助言バナー）を盤面下部に表示・更新する。
// renderUI に消されないよう #board-area 直下に別管理で持つ。OFF/該当なしでは除去。
function updateBeginnerHint(): void {
  const host = document.getElementById('board-area');
  if (!host) return;
  const existing = document.getElementById('beginner-hint');
  const hint = beginnerMode && state ? beginnerHint(state, selfPlayerId() ?? null) : null;
  if (!hint) { existing?.remove(); return; }

  const el = existing ?? document.createElement('div');
  if (!existing) { el.id = 'beginner-hint'; host.appendChild(el); }
  el.innerHTML = '';
  const icon = document.createElement('span');
  icon.className = 'bh-icon';
  icon.textContent = hint.icon;
  const txt = document.createElement('div');
  txt.className = 'bh-text';
  const t = document.createElement('div');
  t.className = 'bh-title';
  t.textContent = hint.title;
  const b = document.createElement('div');
  b.className = 'bh-body';
  b.textContent = hint.body;
  txt.appendChild(t);
  txt.appendChild(b);
  el.appendChild(icon);
  el.appendChild(txt);
}

function showBoardNotice(text: string, color = '#e0a948'): void {
  const host = document.getElementById('board-area');
  if (!host) return;
  document.getElementById('board-notice')?.remove();
  const n = document.createElement('div');
  n.id = 'board-notice';
  n.style.setProperty('--turn-color', color);
  n.textContent = text;
  host.appendChild(n);
  setTimeout(() => n.remove(), 2200);
}

function maybeYourTurnCue(prevState: GameState, newState: GameState): void {
  if (newState.phase === 'GAME_OVER') return;
  const me = selfPlayerId();
  const prevCur = prevState.playerOrder[prevState.currentPlayerIndex];
  const newCur = newState.playerOrder[newState.currentPlayerIndex];
  if (newCur === me && prevCur !== me) {
    setTimeout(() => playSE('yourTurn'), 140);
  }
  // 手番開始の明示（MAINのみ。手番は公開情報なのでLAN全クライアントで一致）。
  if (newState.phase === 'MAIN' && newCur && newCur !== prevCur) {
    showTurnToast(newCur, newCur === me);
  }
  // 初期配置（SETUP）: 自分の番で開拓地/道を盤面に置く必要があるので盤面へ自動スクロール。
  // 手番開始（開拓地）と開拓地→道のサブフェーズ移行の両方で発火させる。CPU/相手の番では動かさない。
  const isSetup = newState.phase === 'SETUP_FORWARD' || newState.phase === 'SETUP_BACKWARD';
  if (isSetup && newState.setupSubPhase != null && newCur === me && currentPid(newState) === me
      && (prevCur !== newCur || prevState.setupSubPhase !== newState.setupSubPhase)) {
    scrollToBoard();
  }
}

// 手番開始トースト（盤面上に短く「○○の番」。レイアウトは崩さない absolute 配置）。
function showTurnToast(pid: string, isMe: boolean): void {
  const host = document.getElementById('board-area');
  if (!host || !state) return;
  document.getElementById('turn-toast')?.remove();
  const p = state.players[pid];
  if (!p) return;
  const color = PLAYER_HEX[pid] ?? '#aaa';
  const toast = document.createElement('div');
  toast.id = 'turn-toast';
  if (isMe) toast.classList.add('mine');
  toast.style.setProperty('--turn-color', color);
  const dot = document.createElement('span');
  dot.className = 'turn-toast-dot';
  dot.style.background = color;
  const txt = document.createElement('span');
  txt.textContent = isMe ? 'あなたの番！' : `${p.name} の番`;
  toast.append(dot, txt);
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 1700);
}

// 騎士と商人: ロール時に見せるイベントダイス情報（生産2ダイス＝赤+黄／イベントダイス／抽選・蛮族）。
interface DiceEventInfo {
  eventDie: 'ship' | CkTrack;
  redDie: number;       // 赤ダイス(=生産d1) は抽選のしきい値にも使う
  barbPos: number;
  attacked: boolean;    // この前進で襲来したか
  advanced: boolean;    // 蛮族船が前進したか
  // 襲来したときの防衛結果（撃退単独勝利/同点/敗北＝格下げ）。attacked=false のときは null。
  attackResult: { kind: 'win' | 'tie' | 'defeat'; names: string[] } | null;
  // 色ゲートのとき、現手番から時計回り順の各プレイヤーの抽選照合。船のときは null。
  draws: Array<{ name: string; level: number; threshold: number; eligible: boolean; drew: boolean }> | null;
}


/** ロール前後のstateからイベントダイスの可視化情報を導出。非CK or 情報なしは null。 */
function buildDiceEventInfo(prev: GameState, next: GameState): DiceEventInfo | null {
  if (!isCk(next) || !next.lastEventDie || !next.lastDiceRoll) return null;
  const ev = next.lastEventDie;
  const red = next.lastDiceRoll[0];
  const info: DiceEventInfo = {
    eventDie: ev, redDie: red,
    barbPos: next.barbarianPosition ?? 0,
    attacked: (next.barbarianAttacks ?? 0) > (prev.barbarianAttacks ?? 0),
    advanced: (next.barbarianPosition ?? 0) > (prev.barbarianPosition ?? 0),
    attackResult: null,
    draws: null,
  };
  // 襲来した場合の防衛結果を導出（撃退で守護VP獲得 / 同点 / 敗北＝都市格下げ予定）。
  if (info.attacked) {
    const defenders = next.playerOrder
      .filter(p => (next.players[p]?.defenderVP ?? 0) > (prev.players[p]?.defenderVP ?? 0))
      .map(p => next.players[p]?.name ?? p);
    const downgraders = (next.pendingCityDowngrade ?? []).map(p => next.players[p]?.name ?? p);
    info.attackResult = downgraders.length > 0 ? { kind: 'defeat', names: downgraders }
      : defenders.length > 0 ? { kind: 'win', names: defenders }
      : { kind: 'tie', names: [] };
  }
  if (ev !== 'ship') {
    const n = next.playerOrder.length;
    const start = next.currentPlayerIndex ?? 0;
    const rows: NonNullable<DiceEventInfo['draws']> = [];
    for (let i = 0; i < n; i++) {
      const pid = next.playerOrder[(start + i) % n]!;
      const level = next.players[pid]?.improvements?.[ev] ?? 0;
      const threshold = level + 1;
      const eligible = level >= 1 && red <= threshold; // Lv0は不可・赤≤Lv+1
      const before = (prev.players[pid]?.progressCards ?? []).length;
      const after = (next.players[pid]?.progressCards ?? []).length;
      rows.push({ name: next.players[pid]?.name ?? pid, level, threshold, eligible, drew: after > before });
    }
    info.draws = rows;
  }
  return info;
}

/** イベント結果パネル（船＝蛮族トラック前進 / 色ゲート＝赤としきい値の照合・抽選）。 */
function buildEventResolutionPanel(info: DiceEventInfo): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'dice-event-panel';
  if (info.eventDie === 'ship') {
    if (info.attacked) {
      // 襲来: 画像は出さず見出しだけ（全画面演出と重複するため絵は不要）。
      const bt = document.createElement('div');
      bt.className = 'dep-attack-title';
      bt.textContent = '⚔ 蛮族 襲来！';
      panel.appendChild(bt);
    } else {
      // 前進: 蛮族船コマの画像と見出しを「横並び」にする（縦に積むと画面が見切れるため）。
      // 見出しの船絵文字(🛶)はアイコンと重複するので外す。
      const head = document.createElement('div');
      head.className = 'dep-advance-head';
      if (ASSETS.piece.barbarianShip) {
        const ship = document.createElement('img');
        ship.className = 'dep-ship'; ship.src = ASSETS.piece.barbarianShip; ship.alt = '蛮族船'; ship.draggable = false;
        head.appendChild(ship);
      }
      const title = document.createElement('div');
      title.className = 'dep-title';
      title.textContent = '蛮族船が前進';
      head.appendChild(title);
      panel.appendChild(head);
    }
    const danger = info.barbPos >= CK_BARBARIAN_MAX - 2;
    const track = document.createElement('div');
    track.className = `dep-track${danger ? ' danger' : ''}`;
    for (let i = 1; i <= CK_BARBARIAN_MAX; i++) {
      const pip = document.createElement('span');
      pip.className = `dep-pip${i <= info.barbPos ? ' on' : ''}${i === info.barbPos && info.advanced ? ' just' : ''}`;
      track.appendChild(pip);
    }
    panel.appendChild(track);
    const sub = document.createElement('div');
    if (info.attacked && info.attackResult) {
      // 襲来時は防衛の結果（撃退/同点/敗北＝誰が格下げ・誰がVP）を明示する。
      const r = info.attackResult;
      sub.className = `dep-sub dep-result ${r.kind}`;
      sub.textContent =
        r.kind === 'win'    ? `🛡 撃退成功！ ${r.names.join('・')} が +1 勝利点（カタンの守護者）` :
        r.kind === 'tie'    ? '🛡 撃退成功！（最大貢献が同点 — 各自が進歩カードを獲得）' :
                              `⚔ 防衛失敗！ ${r.names.join('・')} が都市を1つ開拓地に格下げ`;
    } else {
      sub.className = 'dep-sub';
      sub.textContent = `蛮族 ${info.barbPos} / ${CK_BARBARIAN_MAX}${danger ? '（まもなく襲来）' : ''}`;
    }
    panel.appendChild(sub);
  } else {
    // 色ゲート（交易/政治/科学）の進歩カード抽選。スマホで見切れないよう、全員の
    // しきい値詳細は出さず「誰が貰えたか」だけを簡潔に出す（誰も貰えなければ1行）。
    const color = info.eventDie; // この分岐では 'ship' ではなく CkTrack（交易/政治/科学）
    const title = document.createElement('div');
    title.className = `dep-title ev-${color}`;
    // 先頭の「科」等の漢字ラベルはカッコ悪いので、そのトラックのアイコン画像にする。
    const icon = document.createElement('img');
    icon.className = 'dep-ev-icon'; icon.src = ASSETS.trackIcon[color]; icon.alt = ''; icon.draggable = false;
    title.append(icon, document.createTextNode(` ${CK_TRACK_NAME[color]}の進歩カード`));
    panel.appendChild(title);
    const winners = (info.draws ?? []).filter(r => r.drew);
    if (winners.length === 0) {
      const sub = document.createElement('div');
      sub.className = 'dep-sub';
      sub.textContent = '誰ももらえませんでした';
      panel.appendChild(sub);
    } else {
      const list = document.createElement('div');
      list.className = 'dep-draws';
      for (const r of winners) {
        const rowEl = document.createElement('div');
        rowEl.className = 'dep-draw-row ok';
        rowEl.textContent = `🎴 ${r.name} が獲得`;
        list.appendChild(rowEl);
      }
      panel.appendChild(list);
    }
  }
  return panel;
}

/** 生産合計（赤+黄）のポップ表示。赤は抽選しきい値にも使うことが伝わる表記。 */
function showDiceSum(sum: HTMLElement, d1: number, d2: number): void {
  sum.innerHTML = '';
  // 赤・黄の値を色付きバッジで、合計を強調。チープな素テキストを避ける。
  const mk = (cls: string, txt: string): HTMLElement => { const s = document.createElement('span'); s.className = cls; s.textContent = txt; return s; };
  sum.append(
    mk('dice-sum-die red', String(d1)),
    mk('dice-sum-plus', '＋'),
    mk('dice-sum-die yellow', String(d2)),
    mk('dice-sum-eq', '＝'),
    mk('dice-sum-total', String(d1 + d2)),
  );
  sum.classList.add('show');
}

// 蛮族襲来: 画面全体を覆う襲来演出＋SE（重要イベントなので reduced-motion でも出す）。
function showBarbarianAttackOverlay(result?: DiceEventInfo['attackResult']): void {
  playSE('barbarianAttack');
  document.getElementById('barbarian-attack')?.remove();
  const ov = document.createElement('div');
  ov.id = 'barbarian-attack';
  if (ASSETS.bg.barbarian) ov.style.backgroundImage = `url("${ASSETS.bg.barbarian}")`;
  if (prefersReducedMotion()) ov.classList.add('reduced');
  const title = document.createElement('div');
  title.className = 'barbarian-attack-title';
  title.textContent = '⚔ 蛮族 襲来！';
  ov.appendChild(title);
  // 防衛の結果（撃退/同点/敗北）を襲来見出しの下に大きく表示する。
  if (result) {
    const res = document.createElement('div');
    res.className = `barbarian-attack-result ${result.kind}`;
    res.textContent =
      result.kind === 'win'    ? `🛡 撃退成功！ ${result.names.join('・')} が +1勝利点` :
      result.kind === 'tie'    ? '🛡 撃退成功！（同点 — 各自が進歩カード）' :
                                 `防衛失敗… ${result.names.join('・')} が都市を格下げ`;
    ov.appendChild(res);
  }
  document.body.appendChild(ov);
  // 結果（撃退/敗北・誰が格下げ）を読めるよう長めに表示（タップは透過するので操作は妨げない）。
  // この演出が消えるまで資源/進歩カードの配布アニメは待たせる（pendingOverlayDelay）。
  // 最速(instant)では襲来演出も短くしてテンポ優先（出すが長くは止めない）。普通/速いは従来どおり。
  const overlayMs = fxSpeed() === 'instant' ? 1500 : BARB_OVERLAY_MS;
  barbarianOverlayClearAt = (typeof performance !== 'undefined' ? performance.now() : 0) + overlayMs;
  setTimeout(() => { ov.remove(); barbarianOverlayClearAt = 0; }, overlayMs);
  // CPUの次手も、この全画面演出が消えるまで待たせる（演出スキップ防止）。ダイスの finishAll は
  // 演出より早く来る(約4.6s)ため、ここでゲートしないとCPUが襲来挿絵の途中で次へ進んでしまう。
  holdResourceAnimating(overlayMs);
}

/** イベント結果を演出へ接続: 船=蛮族前進（残り少は警告フラッシュ）/ 色ゲート=その色が画面に広がる。
 * 盤面(#board-area)を transform で動かすと結果表示時にガタつくため、盤は動かさず
 * オーバーレイのフラッシュ（非レイアウト・GPU合成のみ）で表現する。 */
function applyEventFlourish(info: DiceEventInfo): void {
  // 蛮族襲来は重要イベントなので、演出OFF/reduced-motion でも全画面演出＋SEを出す。
  if (info.eventDie === 'ship' && info.attacked) showBarbarianAttackOverlay(info.attackResult);
  if (prefersReducedMotion() || fxSpeed() === 'instant') return;
  const board = document.getElementById('board-area') ?? document.body;
  if (info.eventDie === 'ship') {
    // 残り1〜2マス or 襲来のみ、赤い警告フラッシュ（盤は揺らさない）。
    if (info.advanced && (info.barbPos >= CK_BARBARIAN_MAX - 2 || info.attacked)) {
      const flash = document.createElement('div');
      flash.className = 'dice-color-wash ev-danger';
      board.appendChild(flash);
      setTimeout(() => flash.remove(), 900);
    }
  } else {
    const wash = document.createElement('div');
    wash.className = `dice-color-wash ev-${info.eventDie}`;
    board.appendChild(wash);
    setTimeout(() => wash.remove(), 950);
  }
}

// three(WebGL) は重いので動的 import で遅延ロード（初期バンドルを軽く保つ＝レンダーオンデマンドの精神）。
// ゲーム開始時(preloadDiceGL)に裏で読み込み、初回ロールまでに用意できる。未ロード/非対応時は null。
let _diceGLMod: typeof import('./renderer/diceGL') | null = null;
let _diceGLLoading = false;
function preloadDiceGL(): void {
  if (_diceGLMod || _diceGLLoading) return;
  _diceGLLoading = true;
  import('./renderer/diceGL').then(m => { _diceGLMod = m; }).catch(e => { _diceGLLoading = false; console.warn('DiceGL load failed', e); });
}
function getDiceGL(): DiceGLController | null {
  if (!_diceGLMod) { preloadDiceGL(); return null; } // 未ロードなら今ロード開始し、今回はフォールバック表示
  return _diceGLMod.ensureDiceGL();
}

/** ロール中だけ盤面を沈めるオーバーレイ（背後の盤を blur+減彩+減光、ダイスへスポット）。z50のダイスは前面のまま。 */
function showBoardDim(reduced: boolean): HTMLElement {
  const host = document.getElementById('board-area') ?? document.body;
  host.querySelectorAll('.dice-board-dim').forEach(n => n.remove()); // 残留掃除（連続ロール）
  const dim = document.createElement('div');
  dim.className = `dice-board-dim${reduced ? ' reduced' : ''}`;
  host.appendChild(dim);
  void dim.offsetWidth;     // reflow を挟んでフェードイン
  dim.classList.add('on');
  return dim;
}
function hideBoardDim(dim: HTMLElement | null): void {
  if (!dim) return;
  dim.classList.remove('on');
  setTimeout(() => dim.remove(), 360);
}

// 3Dダイス演出（Three.js/WebGL）: 赤=生産d1／黄=生産d2／イベント(CK)を実写級の立方体として
// 転がし、diceGLMapping の目標姿勢へ着地させる（出目は外部値・物理で決めない）。着地は時間差
// （赤→黄→イベント）。既存の演出（盤dim・生産合計ポップ・抽選照合・蛮族前進/wash・board hit）へ繋ぐ。
function playDiceRoll(d1: number, d2: number, eventInfo: DiceEventInfo | null, onDone: () => void): void {
  if (d1 < 1 || d2 < 1) { onDone(); return; }
  const reduced = prefersReducedMotion();
  const mode = diceFxMode();                          // サイコロ演出の速さ（off=演出なしで即結果）
  const instant = reduced || mode === 'off';

  const host = document.getElementById('board-area') ?? document.body;
  const dim = showBoardDim(instant);                 // ① ロール中だけ盤を沈める（off/抑制は軽い減光）
  const overlay = document.createElement('div');
  overlay.className = 'dice-roll-overlay';
  // イベント結果パネルをサイコロの「下」に出す回（CK）は、ダイス＋パネルを中央寄せにして
  // パネル出現時にダイスが大きく跳ね上がって見えるのを防ぐ（通常ロールは従来どおり下寄せ）。
  if (eventInfo) overlay.classList.add('has-event');
  // ダイスと合計を1枚の「結果カード」にまとめ、ダイスが面に乗っているように見せる（浮き防止）。
  const card = document.createElement('div'); card.className = 'dice-result-card';
  const glWrap = document.createElement('div'); glWrap.className = 'dice-gl-wrap';
  const sum = document.createElement('div'); sum.className = 'dice-sum';
  card.append(glWrap, sum);
  overlay.append(card);
  host.appendChild(overlay);

  const spec: RollSpec = {
    red: { value: d1 }, yellow: { value: d2 },
    event: eventInfo ? { result: eventInfo.eventDie } : null,
  };
  const gl = getDiceGL();

  let done = false;
  const finishAll = (): void => {
    if (done) return; done = true;
    overlay.remove(); hideBoardDim(dim); gl?.reset(); onDone();
  };
  // 結果パネル＋（船=警告フラッシュ / 色=wash＋抽選照合）。
  // パネルはサイコロ枠の「下」に出す（上に出すと画面上端で見切れていたため）。
  const showPanelAndFlourish = (): void => {
    if (!eventInfo) return;
    overlay.appendChild(buildEventResolutionPanel(eventInfo));
    applyEventFlourish(eventInfo);
  };

  // ⑧ WebGL非対応/失敗 → 最小限の結果表示（出目と船/色ゲートは sum＋パネルで判別可能）。
  if (!gl) {
    glWrap.remove();
    showDiceSum(sum, d1, d2);
    if (eventInfo) showPanelAndFlourish();
    setTimeout(finishAll, eventInfo ? 1700 : 900);
    return;
  }

  gl.mountTo(glWrap);

  // 演出OFF / reduced-motion: タンブルを省き即着地（出目の正しさは維持）。
  if (instant) {
    gl.showStatic(spec);
    showDiceSum(sum, d1, d2);
    showPanelAndFlourish();
    setTimeout(finishAll, eventInfo ? 1500 : 900);
    return;
  }

  // 着地時刻（サイコロ演出の速さ設定で伸縮）。赤→黄(+約300ms)→イベント(さらに遅れ＝見せ場)。
  const k = mode === 'fast' ? 0.6 : mode === 'slow' ? 1.5 : 1;
  const tRed = Math.round(1550 * k);
  const tYellow = Math.round(1850 * k);
  const tEvent = Math.round(2350 * k);

  gl.roll(spec, { redMs: tRed, yellowMs: tYellow, eventMs: tEvent }, {
    onRedLand: () => playSE('dice'),
    onYellowLand: () => { playSE('dice'); showDiceSum(sum, d1, d2); }, // 赤＋黄が揃って合計ポップ
    onEventLand: () => {
      playSE('diceLandHeavy');                        // クライマックスの発光は GL 側（盤は動かさない＝ガタつき防止）
      showPanelAndFlourish();
    },
  });

  // 結果照合を見せる持続は従来どおり（イベント着地後に十分見せてから片付け）。
  if (eventInfo) setTimeout(finishAll, tEvent + Math.round(2300 * k));
  else setTimeout(finishAll, tYellow + Math.round(1000 * k));
}

// ============================================================
// dispatch / applyNetState 共通: 状態遷移後の演出
// ============================================================

// 状態更新後の「見せる」処理本体（CPU/交易のスケジューリングは含まない）。
// redraw → 盗賊スライド → 7のSE → 産出ハイライト → 資源/VP/手番演出、を再現する。
// dispatch（ローカル）と applyNetState（LAN）の両方から呼び、演出のドリフトを防ぐ。
// ROLL_DICE ではこの関数自体が runWithDiceAnim 経由でダイス停止後に呼ばれる。つまり
// 手札カウントの再描画(redraw)と資源アニメは「出目が止まってから」まとめて起こる
// （ローカル/LAN とも同経路）。演出中の早出しを防ぐため、他経路の redraw も
// diceAnimating 中はスキップする（onViewportChange 参照）。
function runTransitionFx(
  prevState: GameState,
  action: Action | undefined,
  diceTotal: number | undefined,
  robberFromTile: string | undefined,
): void {
  diceAnimating = false;
  // 相手選択の前にプレビューで既にコマを移動先へ動かしている場合、確定時の再スライドは抑止する。
  const previewedMove = robberPreviewedTile != null && (action?.type === 'MOVE_ROBBER' || action?.type === 'MOVE_PIRATE') && robberPreviewedTile === action.tileId;
  robberPreviewedTile = null;
  redraw();
  if (action?.type === 'MOVE_ROBBER' && robberFromTile) {
    if (!previewedMove) animateRobberMove(robberFromTile, action.tileId);
    // 略奪が成立（被害者の手札が1枚減った）なら、伏せカードが被害者→略奪者へ飛ぶ。
    // 資源の種類は出さない（秘匿）。盗賊の着地後に少し遅らせて見せる。
    const victim = action.stealFromPlayerId;
    const actor = prevState.playerOrder[prevState.currentPlayerIndex];
    if (victim && actor && totalCardsOf(prevState, victim) > totalCardsOf(state, victim)) {
      setTimeout(() => animateStealCard(victim, actor), 580);
    }
  }
  // 7（盗賊）が出た瞬間: 専用の不穏SE。捨て札フェーズなら警告SEも（少し遅らせて重複回避）。
  if (action?.type === 'ROLL_DICE' && diceTotal === 7) {
    playSE('sevenRoll');
    if (state.phase === 'MAIN' && state.turnPhase === 'DISCARD') {
      setTimeout(() => playSE('discardWarn'), 360);
    }
  }
  // 7以外: 産出タイルを強調して「どのタイルから資源が出たか」を分かりやすく
  if (action?.type === 'ROLL_DICE' && diceTotal !== undefined && diceTotal !== 7) {
    highlightProducingTiles(diceTotal);
  }
  triggerResourceAnimation(prevState, state, action, diceTotal);
  triggerProgressCardAnimation(prevState, state);
  maybeNoticeProgressCardGain(prevState, state);
  showPlayedProgressCard(prevState, state, action);
  animateBuildPlacement(action);
  triggerVpGainEffects(prevState, state);
  maybeYourTurnCue(prevState, state);
  maybeScrollToTradeOffer(prevState, state);
  maybeNoticeCityDowngrade(prevState, state);
  maybeNoticeRobberMove(prevState, state);
  // 発明家: 数字入替が成立したら「効いた」ことを明示（数字トークンが入れ替わるだけで気づきにくいため）。
  if (action?.type === 'PLAY_PROGRESS' && action.choice?.inventorTiles) {
    showBoardNotice('🔄 タイルの数字を入れ替えました', '#7fb0ff');
  }
}

// 騎士と商人: 蛮族敗北で自分（LAN=viewer/ローカル=人間）が都市格下げ対象になったら、
// 全画面の襲来演出が消えた頃に盤面へスクロール＋通知して「都市をタップ」と気づかせる。
function maybeNoticeCityDowngrade(prevState: GameState, newState: GameState): void {
  const me = selfPlayerId();
  if (!me) return;
  const amPending = (s: GameState): boolean =>
    s.turnPhase === 'CITY_DOWNGRADE' && (s.pendingCityDowngrade ?? []).includes(me);
  if (!amPending(newState) || amPending(prevState)) return;
  const gen = gameGeneration;
  // 襲来オーバーレイ(約2.6s)が消えてから案内（重ならないように）。
  setTimeout(() => {
    if (gen !== gameGeneration || !state || !amPending(state)) return;
    showBoardNotice('⚔ 盤面で光っている自分の都市をタップして格下げ', '#ff8a5a');
    scrollToBoard();
  }, 2700);
}

// 7のロール／騎士カード／強盗追い払いの後、ROBBER フェーズに入ったら、移動するのが自分（LAN=viewer/
// ローカル=人間）のときに盤面へ自動スクロールして「盗賊の移動を行ってください」と案内する。
// 盗賊を動かすのは常に手番プレイヤーなので currentPid===自分 で判定。phase の立ち上がり（prev≠ROBBER）
// のみで発火させ、既に ROBBER 中の再描画では鳴らさない。CPU/相手の7では発火しない。
function maybeNoticeRobberMove(prevState: GameState, newState: GameState): void {
  const me = selfPlayerId();
  if (!me) return;
  if (!(newState.turnPhase === 'ROBBER' && prevState.turnPhase !== 'ROBBER' && currentPid(newState) === me)) return;
  showBoardNotice('🦹 盤面のタイルをタップして盗賊の移動を行ってください', '#ff8a5a');
  scrollToBoard();
}

// 建設フィードバック(C-4): 開拓地/都市はスケールインのポップ、道は辺をなぞる描画。
// redraw 後に該当要素へ一時クラスを付けて CSS アニメで見せる（reduced-motion/instantは省略）。
function animateBuildPlacement(action: Action | undefined): void {
  if (!action || fxSpeed() === 'instant' || prefersReducedMotion()) return;
  if (action.type === 'BUILD_SETTLEMENT' || action.type === 'BUILD_CITY') {
    const g = document.querySelector(`#board [data-vertex-id="${action.vertexId}"]`) as SVGGElement | null;
    if (!g) return;
    g.classList.add('just-built');
    setTimeout(() => g.classList.remove('just-built'), 650);
  } else if (action.type === 'BUILD_ROAD') {
    const line = document.querySelector(`#board [data-road-edge-id="${action.edgeId}"]`) as SVGLineElement | null;
    if (!line) return;
    line.classList.add('road-draw');
    setTimeout(() => line.classList.remove('road-draw'), 600);
  }
}

// ROLL_DICE ならダイス演出（赤・黄・イベントの3個＋CKの抽選/蛮族パネル）を見せてから finish。
// 交易と蛮族「イベントカード」ではダイスは箱に戻っている＝カードめくり演出に差し替える。
function runWithDiceAnim(action: Action | undefined, prevState: GameState, finish: () => void): void {
  if (action?.type === 'ROLL_DICE' && state.tbEventCards && state.tbLastEventCard) {
    diceAnimating = true;
    _diceAnimStart = (typeof performance !== 'undefined' ? performance.now() : 0);
    playTbEventCardReveal(state.tbLastEventCard, state.tbNewYearRebuilt === true, finish);
  } else if (action?.type === 'ROLL_DICE' && state.lastDiceRoll) {
    diceAnimating = true;
    _diceAnimStart = (typeof performance !== 'undefined' ? performance.now() : 0);
    const [d1, d2] = state.lastDiceRoll;
    playDiceRoll(d1, d2, buildDiceEventInfo(prevState, state), finish);
  } else {
    finish();
  }
}

// 交易と蛮族「イベントカード」: カードの1行説明（めくり演出用のUI文言）。
const TB_EVENT_SUMMARY: Record<TbEventCard['event'], string> = {
  beautiful_day:    '事件なし。数字のヘックスが通常どおり生産',
  calm_seas:        '港に建物が最も多い人が、好きな資源1枚を獲得',
  conflict:         '最大騎士力（無ければ騎士カード最多の1人）が誰かから1枚奪う',
  earthquake:       '全員が自分の道1本を損傷。修理するまで道を建てられない',
  epidemic:         'この生産では都市も資源1枚だけ',
  good_neighbors:   '全員が左隣へ好きな資源1枚を渡す',
  helpful_neighbor: '点数トップが、点数の低い人へ資源1枚を渡す',
  new_year:         'イベントデッキを作り直す',
  plentiful_year:   '全員が好きな資源1枚を獲得',
  robber_attacks:   '「7」として解決！ 8枚以上は捨て札→盗賊が動く',
  robber_flees:     '盗賊が砂漠へ帰る（誰からも奪わない）',
  tournament:       '表向きの騎士カード最多の人が、好きな資源1枚を獲得',
  trade_advantage:  '最長交易路の人が誰かから1枚奪う',
};

// カードめくり演出: ダイスの代わりに、めくったイベントカード（名前・数字・効果）を短時間見せる。
function playTbEventCardReveal(card: TbEventCard, rebuilt: boolean, onDone: () => void): void {
  const reduced = prefersReducedMotion();
  const mode = diceFxMode();
  const instant = reduced || mode === 'off';

  const host = document.getElementById('board-area') ?? document.body;
  const dim = showBoardDim(instant);
  const overlay = document.createElement('div');
  overlay.className = 'dice-roll-overlay';
  const panel = document.createElement('div');
  panel.className = 'dice-result-card tb-event-reveal';

  if (rebuilt) {
    const ny = document.createElement('div');
    ny.textContent = '🔄 新年！ イベントデッキを作り直しました';
    ny.style.cssText = 'font-size:14px;opacity:.9;margin-bottom:6px;';
    panel.appendChild(ny);
  }
  const title = document.createElement('div');
  title.textContent = `🃏 ${TB_EVENT_NAME[card.event]}`;
  title.style.cssText = 'font-size:22px;font-weight:700;';
  panel.appendChild(title);
  if (card.number != null) {
    // ダイス合計と同じ見た目の数字強調を流用（.dice-sum-total の黄色い大数字）。
    const sum = document.createElement('div');
    sum.className = 'dice-sum show';
    const label = document.createElement('span');
    label.className = 'dice-sum-label';
    label.textContent = '生産数字';
    const total = document.createElement('span');
    total.className = 'dice-sum-total';
    total.textContent = String(card.number);
    sum.append(label, total);
    panel.appendChild(sum);
  }
  const desc = document.createElement('div');
  desc.textContent = TB_EVENT_SUMMARY[card.event];
  desc.style.cssText = 'font-size:13px;opacity:.92;margin-top:6px;max-width:280px;';
  panel.appendChild(desc);

  overlay.appendChild(panel);
  host.appendChild(overlay);
  // 7(盗賊の襲撃)の不穏SEは演出後の runTransitionFx が鳴らす（ここで鳴らすと二重になる）。

  const k = mode === 'fast' ? 0.6 : mode === 'slow' ? 1.5 : 1;
  const hold = instant ? 900 : Math.round(2100 * k);
  setTimeout(() => { overlay.remove(); hideBoardDim(dim); onDone(); }, hold);
}

// ターン終了時など、盤面を画面内に出す（スマホで操作パネルまでスクロールしている状態から戻す）。
// ゲーム生成/再同期の直後（runTransitionFx を経由しない経路）で、今が自分（ローカル人間/LAN=viewer）の
// 初期配置（SETUP）番なら盤面へスクロールする直接チェック。maybeYourTurnCue は手番遷移時のみ働くため、
// 「最初から自分が手番」「自分のSETUP中に再接続」のケースを取りこぼすのを補う。
function maybeScrollForMySetup(s: GameState | null): void {
  if (!s) return;
  const isSetup = s.phase === 'SETUP_FORWARD' || s.phase === 'SETUP_BACKWARD';
  if (isSetup && s.setupSubPhase != null && currentPid(s) === selfPlayerId()) scrollToBoard();
}

function scrollToBoard(): void {
  const board = document.getElementById('board-area') ?? document.getElementById('board');
  try {
    if (board && typeof board.scrollIntoView === 'function') board.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch { window.scrollTo(0, 0); }
}

function dispatch(action: Action): void {
  // 騎士と商人: 人間が「商人/発明家」を使う時は自動でなく盤面でタイルを選ばせる。
  if (action.type === 'PLAY_PROGRESS' && !diceAnimating) {
    const ppid = currentPid(state);
    const pcard = state.players[ppid]?.progressCards?.find(c => c.id === action.cardId);
    const pHuman = state.players[ppid]?.type === 'human' || ppid === selfPlayerId();
    // 商人: 候補が2つ以上ある時のみ盤面選択（0/1個なら従来どおりエンジンが自動配置）。
    if (pcard?.type === 'merchant' && pHuman && !action.choice?.merchantTileId
        && state.turnPhase === 'TRADE_BUILD' && merchantTileIds(state, ppid).length > 1) {
      document.querySelector('.help-overlay')?.remove(); // カード詳細モーダルを閉じる
      setBuildMode('placeMerchant'); // setBuildMode が盤面へ自動スクロールする
      showBoardNotice('🏪 商人を置く資源タイルをタップしてください');
      return;
    }
    // 発明家: 入替候補が2つ以上ある時、盤面で2タイルを順にタップして数字を入れ替える。
    if (pcard?.type === 'inventor' && pHuman && !action.choice?.inventorTiles
        && state.turnPhase === 'TRADE_BUILD' && inventorTiles(state).length >= 2) {
      document.querySelector('.help-overlay')?.remove();
      inventorFirstTile = null;
      setBuildMode('inventorSwap');
      showBoardNotice('🔄 数字を入れ替える1つ目のタイルをタップ');
      return;
    }
    // 僧正: 盗賊を置くタイルを盤面で選ぶ（隣接する全相手から1枚ずつ奪う）。
    if (pcard?.type === 'bishop' && pHuman && !action.choice?.bishopTileId
        && state.turnPhase === 'TRADE_BUILD' && bishopTileIds(state).length > 0) {
      document.querySelector('.help-overlay')?.remove();
      setBuildMode('placeBishop');
      showBoardNotice('⛪ 盗賊を置くタイルをタップ（隣接の全相手から1枚ずつ奪う）');
      return;
    }
    // 外交官: 撤去する相手の端の道を盤面で選ぶ。
    if (pcard?.type === 'diplomat' && pHuman && !action.choice?.diplomatEdgeId
        && state.turnPhase === 'TRADE_BUILD' && diplomatRemovableRoads(state, ppid).length > 0) {
      document.querySelector('.help-overlay')?.remove();
      setBuildMode('selectDiplomatRoad');
      showBoardNotice('📜 撤去する端の道をタップ（自分の道なら別の場所に建て直せる）');
      return;
    }
    // 脱走兵: 消す相手の騎士を盤面で選ぶ（同強度の騎士を自分が得る）。
    if (pcard?.type === 'deserter' && pHuman && !action.choice?.deserterVertexId
        && state.turnPhase === 'TRADE_BUILD' && deserterTargets(state, ppid).length > 0) {
      document.querySelector('.help-overlay')?.remove();
      deserterRemoveVid = null; // 1手目（消す騎士の選択）から開始
      setBuildMode('selectDeserterKnight');
      showBoardNotice('🏃 消す相手の騎士をタップ（同じ強さの騎士を得て設置先も選べる）');
      return;
    }
    // 医術: 都市化する自分の開拓地を盤面で選ぶ（麦1＋鉱石2を払える＆開拓地があるとき）。
    if (pcard?.type === 'medicine' && pHuman && !action.choice?.medicineVertexId
        && state.turnPhase === 'TRADE_BUILD' && medicineSettlements(state, ppid).length > 0) {
      const me = state.players[ppid];
      const affordable = !!me && me.hand.grain >= 1 && me.hand.ore >= 2 && me.remainingCities > 0;
      if (affordable) {
        document.querySelector('.help-overlay')?.remove();
        setBuildMode('selectMedicineSettlement');
        showBoardNotice('💊 都市にする自分の開拓地をタップ（麦1＋鉱石2）');
        return;
      }
    }
    // 鍛冶屋: 昇格する自分の騎士を盤面で選ぶ（最大2体）。候補2体以上の時のみ手動（0/1体は自動）。
    if (pcard?.type === 'smith' && pHuman && !action.choice?.smithVertexIds
        && state.turnPhase === 'TRADE_BUILD' && smithKnightTargets(state, ppid).length > 1) {
      document.querySelector('.help-overlay')?.remove();
      smithFirstKnight = null;
      setBuildMode('selectSmithKnight');
      showBoardNotice('⚒ 昇格する1体目の騎士をタップ（最大2体）');
      return;
    }
    // 技師: 城壁を建てる自分の都市を盤面で選ぶ（候補2つ以上の時のみ手動）。
    if (pcard?.type === 'engineer' && pHuman && !action.choice?.engineerVertexId
        && state.turnPhase === 'TRADE_BUILD' && engineerWallCities(state, ppid).length > 1) {
      document.querySelector('.help-overlay')?.remove();
      setBuildMode('selectEngineerCity');
      showBoardNotice('🧱 城壁を建てる自分の都市をタップ');
      return;
    }
    // 陰謀: 退去させる敵騎士を盤面で選ぶ（候補2つ以上の時のみ手動）。
    if (pcard?.type === 'intrigue' && pHuman && !action.choice?.intrigueVertexId
        && state.turnPhase === 'TRADE_BUILD' && intrigueKnightTargets(state, ppid).length > 1) {
      document.querySelector('.help-overlay')?.remove();
      setBuildMode('selectIntrigueKnight');
      showBoardNotice('🗡 退去させる敵騎士をタップ（自分の道に隣接）');
      return;
    }
    // クレーン: 割引改善が Lv4到達（=メトロポリス化）で、化ける都市の候補が2つ以上ある時は
    //   改善ボタンと同じく盤面で都市を選ばせる（従来は先頭都市へ自動配置され選べなかった回帰の修正）。
    if (pcard?.type === 'crane' && pHuman && action.choice?.craneMetropolisVertexId == null
        && state.turnPhase === 'TRADE_BUILD') {
      const chosen = action.choice?.craneTrack;
      const track = (chosen && craneEligibleTracks(state, ppid).includes(chosen)) ? chosen : craneTrack(state, ppid);
      if (track && improvementTakesMetropolis(state, ppid, track) && metropolisCityChoices(state, ppid).length > 1) {
        pendingMetropolis = { track, via: 'crane', cardId: action.cardId };
        document.querySelector('.help-overlay')?.remove();
        setBuildMode('selectMetropolis');
        showBoardNotice('🏛 メトロポリスにする自分の都市をタップ（+2点）');
        return;
      }
    }
  }
  // 騎士と商人: 都市改善でメトロポリスを新規獲得し、化ける都市の候補が2つ以上ある時は
  // 自動でなく盤面で都市を選ばせる（候補1つ以下ならエンジンが自動配置）。
  if (action.type === 'BUILD_IMPROVEMENT' && !diceAnimating && action.metropolisVertexId == null) {
    const ipid = currentPid(state);
    const iHuman = state.players[ipid]?.type === 'human' || ipid === selfPlayerId();
    if (iHuman && state.turnPhase === 'TRADE_BUILD'
        && improvementTakesMetropolis(state, ipid, action.track)
        && metropolisCityChoices(state, ipid).length > 1) {
      pendingMetropolis = { track: action.track, via: 'improvement' };
      document.querySelector('.help-overlay')?.remove();
      setBuildMode('selectMetropolis');
      showBoardNotice('🏛 メトロポリスにする自分の都市をタップ（+2点）');
      return;
    }
  }
  // 自分がターンを終了したら盤面へスクロールして次の状況を見せる（スマホ）。
  if (action.type === 'END_TURN') scrollToBoard();
  // LAN対戦: ローカル applyAction は禁止（正本はサーバ）。Action はサーバへ送る。
  if (netMode) { netDispatch(action); return; }
  // ダイス演出中は操作を受け付けない（多重ロール・先走り操作を防止）
  if (diceAnimating) return;
  try {
    const prevState = state;
    state = applyAction(state, action);

    // SE（applyNetState と共通の対応表を再利用）
    playActionSE(action);
    // 触覚は自分の操作のみ（CPUの連続操作で鳴り続けないようにアクターを判定）。
    {
      const actorPid = action.type === 'DISCARD_RESOURCES' ? action.playerId
        : action.type === 'CHOOSE_GOLD' ? action.playerId
        : action.type === 'DOWNGRADE_CITY' ? action.playerId
        : action.type === 'DISCARD_PROGRESS' ? action.playerId
        : action.type === 'CHOOSE_EVENT_GIVE' ? action.playerId
        : action.type === 'CHOOSE_EVENT_HELPFUL' ? action.playerId
        : action.type === 'CHOOSE_EVENT_DAMAGE' ? action.playerId
        : action.type === 'CHOOSE_EVENT_STEAL' ? prevState.tbPendingEventSteal?.playerId
        : action.type === 'RESPOND_TRADE' ? action.response.playerId
        : prevState.playerOrder[prevState.currentPlayerIndex];
      if (actorPid === selfPlayerId()) vibrateForAction(action);
    }
    // 勝利確定: 派手な勝利演出（モーダル＋紙吹雪）＋勝利SE。CPUの後続処理は止める。
    if (state.phase === 'GAME_OVER' && prevState.phase !== 'GAME_OVER') {
      if (cpuWatchdog) { clearTimeout(cpuWatchdog); cpuWatchdog = null; }
      if (humanTradeTimer) { clearTimeout(humanTradeTimer); humanTradeTimer = null; }
      playSE('victory');
      if (state.winner) showVictoryOverlay(state.winner, action.type);
    }

    // リソース獲得アニメーション用のダイス目（ROLL_DICE のみ）
    const diceTotal = action.type === 'ROLL_DICE' && state.lastDiceRoll
      ? state.lastDiceRoll[0] + state.lastDiceRoll[1]
      : undefined;

    // 出目分布の集計（確定した出目のみ。演出中の仮表示はカウントしない）。
    // 人間/CPU 問わず1ロール1回。ロジックには影響しない。
    if (action.type === 'ROLL_DICE' && diceTotal !== undefined && diceTotal >= 2 && diceTotal <= 12) {
      diceStats[diceTotal] = (diceStats[diceTotal] ?? 0) + 1;
    }

    // 盗賊スライド演出用に、移動前の盗賊タイルを控える
    const robberFromTile = action.type === 'MOVE_ROBBER'
      ? Object.values(prevState.tiles).find(t => t.hasRobber)?.id
      : undefined;

    if (
      action.type === 'BUILD_ROAD' ||
      action.type === 'BUILD_SETTLEMENT' ||
      action.type === 'BUILD_CITY' ||
      // 騎士と商人: 配置/起動/昇格/城壁の後もモードが残り「ボタンが光りっぱなし」になる不具合の修正。
      action.type === 'BUILD_KNIGHT' ||
      action.type === 'ACTIVATE_KNIGHT' ||
      action.type === 'UPGRADE_KNIGHT' ||
      action.type === 'BUILD_CITY_WALL' ||
      // 商人カードのタイル配置（placeMerchant）完了後もモードを残さない。
      action.type === 'PLAY_PROGRESS' ||
      // メトロポリス手動選択（selectMetropolis）完了後もモードを残さない。
      action.type === 'BUILD_IMPROVEMENT'
    ) {
      buildMode = 'idle';
      pendingMetropolis = null;
    }

    if (action.type === 'PLAY_ROAD_BUILDING') {
      buildMode = 'road';
      // 道を置くのは盤面なので自動スクロール（自分の手番のときだけ。CPUは自動配置）。
      if (currentPid(state) === selfPlayerId()) scrollToBoard();
    }

    // 街道建設カード使用中は引き続き建設モードを維持（2本目以降は同じ盤面なので再スクロールしない）。
    // 航海者: プレイヤーが「船を置く」を選んでいれば船モードを保持し、それ以外は道モードへ。
    if (state.roadBuildingRoadsRemaining > 0 && buildMode !== 'ship') {
      buildMode = 'road';
    }

    // CPUがプレイヤー間交易を提案した場合：連続提案フラグ＋シグネチャを記録
    if (action.type === 'OFFER_TRADE') {
      const initPid = prevState.playerOrder[prevState.currentPlayerIndex]!;
      if (prevState.players[initPid]?.type === 'ai') {
        cpuPlayerTradeOfferedThisTurn = true;
        lastCpuOfferSignature = cpuOfferSignature(initPid, action.offer);
      }
    }
    // ターン終了時：連続提案フラグをリセット
    if (action.type === 'END_TURN') {
      cpuPlayerTradeOfferedThisTurn = false;
    }
    // ターン終了で建設モードを必ず解除。次ターンに『都市』等のモードが残って盤面に誤った
    // 配置ハイライトが出る／誤タップを誘発するのを防ぐ。船移動後も移動モードを抜ける。
    if (action.type === 'END_TURN') {
      buildMode = 'idle';
      moveShipFrom = null;
      moveKnightFrom = null;
    } else if (action.type === 'MOVE_SHIP') {
      if (buildMode === 'moveShip') buildMode = 'idle';
      moveShipFrom = null;
    } else if (action.type === 'MOVE_KNIGHT') {
      if (buildMode === 'moveKnight') buildMode = 'idle';
      moveKnightFrom = null;
    } else if (action.type === 'CHASE_ROBBER') {
      // 追い払い後は ROBBER フェーズになる。モードを解除して既存のタイルクリックで移動先を選ばせる。
      buildMode = 'idle';
    }

    // ログ追記（公開情報のみ）。直近 MAX_LOG_ENTRIES 件に制限。
    const newLogs = buildActionLog(prevState, action, state);
    if (newLogs.length > 0) {
      state = { ...state, log: [...state.log, ...newLogs].slice(-MAX_LOG_ENTRIES) };
    }

    if (RESET_UIPHASE_ACTIONS.has(action.type)) {
      // CPUプレイヤーが捨て札した場合は人間の選択状態を保持する
      const isCpuDiscard =
        action.type === 'DISCARD_RESOURCES' &&
        state.players[action.playerId]?.type === 'ai';
      if (!isCpuDiscard) {
        uiPhase = { type: 'idle' };
      }
    }

    // 再描画＋演出（applyNetState と共通本体）。その後にローカル専用の進行（CPU/交易）を続ける。
    // 世代ガード: ダイス演出（最大2秒超）中にホーム復帰/新ゲーム開始されると、この finish が
    // 新世代の scheduleAiTurn を呼び、放棄した旧ゲームが裏で進行し続ける（ゾンビ進行）。
    const gen = gameGeneration;
    const finish = (): void => {
      if (gen !== gameGeneration) return;
      runTransitionFx(prevState, action, diceTotal, robberFromTile);
      // 交易提案後は CPU ターゲットが自動応答 / CPU起案時は人間の応答を待つ
      if (action.type === 'OFFER_TRADE' || action.type === 'RESPOND_TRADE') {
        scheduleCpuTradeResponse();
        scheduleCpuInitiatorConfirm();
        scheduleHumanTradeAutoReject(); // 人間ターゲットの自動拒否/タイムアウト
      } else {
        scheduleAiTurn();
      }
    };
    runWithDiceAnim(action, prevState, finish);
  } catch (err) {
    // 例外が出ても全体は止めない。ウォッチドッグが安全行動で進行を回復する。
    console.warn('applyAction error (recoverable):', err);
  }
}

function setBuildMode(mode: BuildMode): void {
  buildMode = mode;
  // 建設モードに入ったら横持ちシートは畳み、盤面へ自動スクロール（操作対象を必ず見せる）。
  // 解除('idle')やトグルOFFでは動かさない。setBuildMode の呼び出し元は人間のUIボタンと
  // dispatch の進歩カード/メトロポリス割込みのみ（CPUは通らない）なので人間操作時だけ働く。
  if (mode !== 'idle') { landscapeSheetUserOpen = false; scrollToBoard(); }
  // モード変更で仮置きプレビューは破棄（別の建設物を選び直したとみなす）。
  if (uiPhase.type === 'placePreview') uiPhase = { type: 'idle' };
  // 船移動モード以外へ移ったら選択中の移動元を解除。
  if (mode !== 'moveShip') moveShipFrom = null;
  if (mode !== 'moveKnight') moveKnightFrom = null;
  if (mode !== 'inventorSwap') inventorFirstTile = null;
  if (mode !== 'selectSmithKnight') smithFirstKnight = null;
  if (mode !== 'selectDeserterKnight') deserterRemoveVid = null;
  redraw();
}

// 航海者: 船移動モードで選択中の移動元を更新して再描画する（events.ts から呼ばれる）。
function setMoveShipFrom(eid: string | null): void {
  moveShipFrom = eid;
  redraw();
}

// 配置（建設）が可能な局面か。仮置きプレビューの有効/破棄判定に使う。
function isPlaceablePhase(s: GameState): boolean {
  if (s.phase === 'SETUP_FORWARD' || s.phase === 'SETUP_BACKWARD') return s.setupSubPhase != null;
  return s.phase === 'MAIN' && s.turnPhase === 'TRADE_BUILD';
}

// バーを辺の画面位置（無ければ盤面下端中央）に合わせて配置する。
function positionBarAtBoard(bar: HTMLElement, edgeId?: string): void {
  const margin = 8;
  const maxTop = window.innerHeight - bar.offsetHeight - margin;
  // 辺が指定されていれば、その辺の実DOM位置の少し下に出す（「その場に」選ばせる）。
  if (edgeId) {
    const line = document.querySelector(`#board [data-edge-id="${edgeId}"]`) as SVGGraphicsElement | null;
    if (line) {
      const r = line.getBoundingClientRect();
      bar.style.top = `${Math.round(Math.min(r.bottom + margin, Math.max(margin, maxTop)))}px`;
      bar.style.left = `${Math.round(r.left + r.width / 2)}px`;
      return;
    }
  }
  const boardEl = document.getElementById('board');
  if (boardEl) {
    const r = boardEl.getBoundingClientRect();
    bar.style.top = `${Math.round(Math.min(r.bottom + margin, Math.max(margin, maxTop)))}px`;
    bar.style.left = `${Math.round(r.left + r.width / 2)}px`;
  }
}

// 航海者: 海岸の辺で「道/船どちらを置くか」をその場に選ばせるバー。
function updateEdgePieceChoiceBar(): void {
  document.getElementById('edge-piece-choice')?.remove();
  if (!state || uiPhase.type !== 'edgePieceChoice') return;
  const edgeId = uiPhase.edgeId;

  const bar = document.createElement('div');
  bar.id = 'edge-piece-choice';
  const text = document.createElement('span');
  text.className = 'place-confirm-text';
  text.textContent = 'ここに置くのは？';

  const mkBtn = (label: string, kind: 'road' | 'ship'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `place-confirm-ok epc-${kind}`;
    b.textContent = label;
    b.addEventListener('click', () => {
      if (uiPhase.type !== 'edgePieceChoice') return;
      const act = resolvePlacePreviewAction(state, currentPid(state), kind, edgeId);
      uiPhase = { type: 'idle' };
      if (act) dispatch(act);
      redraw();
    });
    return b;
  };
  const cancel = document.createElement('button');
  cancel.className = 'place-confirm-cancel';
  cancel.textContent = '✕';
  cancel.addEventListener('click', () => { uiPhase = { type: 'idle' }; redraw(); });

  const actions = document.createElement('div');
  actions.className = 'place-confirm-actions';
  actions.append(mkBtn('🛤 道', 'road'), mkBtn('🚢 船', 'ship'), cancel);
  bar.append(text, actions);
  document.body.appendChild(bar);
  positionBarAtBoard(bar, edgeId);
}

// 航海者: 盗賊(陸)と海賊(海)のどちらを動かすか、先に選ばせるバー。両方動かせる時だけ出す。
function updateRobberPieceBar(): void {
  document.getElementById('robber-piece-choice')?.remove();
  if (!state || state.phase !== 'MAIN' || state.turnPhase !== 'ROBBER') return;
  if (!boardCanAct()) return;                       // 自分が動かす場面のみ
  if (uiPhase.type === 'robberTarget') return;      // 既にコマを置いて略奪相手を選ぶ最中は出さない
  const avail = robberPieceAvail(state);
  if (!(avail.robber && avail.pirate)) return;      // 片方だけなら選ぶ必要なし（従来どおり）

  const bar = document.createElement('div');
  bar.id = 'robber-piece-choice';
  const text = document.createElement('span');
  text.className = 'place-confirm-text';
  text.textContent = robberPiece === null ? '⚔ どちらを動かす？' : '動かすコマ（切替できます）';

  const mk = (label: string, piece: 'robber' | 'pirate'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'place-confirm-ok' + (robberPiece === piece ? ' rpc-active' : '');
    b.textContent = label;
    b.addEventListener('click', () => setRobberPiece(piece));
    return b;
  };
  const actions = document.createElement('div');
  actions.className = 'place-confirm-actions';
  actions.append(mk('🦹 盗賊', 'robber'), mk('🏴‍☠️ 海賊', 'pirate'));
  bar.append(text, actions);
  document.body.appendChild(bar);
  positionBarAtBoard(bar);
}

// 交易と蛮族「Catan for Two」: どちらの中立に置くか先に選ばせるバー。両中立に置ける時だけ出す。
function updateTbNeutralBar(): void {
  document.getElementById('tb-neutral-choice')?.remove();
  if (!state || state.phase !== 'MAIN' || state.turnPhase !== 'TB_NEUTRAL') return;
  if (!boardCanAct()) return; // 自分が置く場面のみ
  const avail = tbNeutralAvail(state);
  if (avail.length < 2) return; // 片方しか置けなければ選ぶ必要なし（自動でその中立）

  const bar = document.createElement('div');
  bar.id = 'tb-neutral-choice';
  const text = document.createElement('span');
  text.className = 'place-confirm-text';
  const pieceName = state.tbNeutralPending === 'settlement' ? '開拓地' : '道';
  text.textContent = tbNeutralChoice === null
    ? `🏳 どちらの中立に${pieceName}を置く？`
    : '置く中立（切替できます）';

  const mk = (nid: PlayerId): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'place-confirm-ok' + (tbNeutralChoice === nid ? ' rpc-active' : '');
    b.textContent = state!.players[nid]?.name ?? nid;
    b.addEventListener('click', () => setTbNeutralChoice(nid));
    return b;
  };
  const actions = document.createElement('div');
  actions.className = 'place-confirm-actions';
  actions.append(...avail.map(mk));
  bar.append(text, actions);
  document.body.appendChild(bar);
  positionBarAtBoard(bar);
}

// 仮置きプレビュー中の確認バー（盤面に被らない固定位置）。確定で建設、やめるで取消。
function updatePlaceConfirmBar(): void {
  updateEdgePieceChoiceBar();
  updateRobberPieceBar();
  updateTbNeutralBar();
  document.getElementById('place-confirm')?.remove();
  if (!state || uiPhase.type !== 'placePreview') return;
  // 騎士と商人の即時系（起動/昇格/商人）は「建てる？」でなく動作に合わせた文言にする。
  const actionKind = uiPhase.kind === 'activateKnight' || uiPhase.kind === 'upgradeKnight' || uiPhase.kind === 'placeMerchant';
  const label = uiPhase.kind === 'road' ? '道' : uiPhase.kind === 'ship' ? '船' : uiPhase.kind === 'city' ? '都市'
    : uiPhase.kind === 'activateKnight' ? '騎士を起動' : uiPhase.kind === 'upgradeKnight' ? '騎士を昇格'
    : uiPhase.kind === 'placeMerchant' ? 'ここに商人を配置' : '開拓地';

  const bar = document.createElement('div');
  bar.id = 'place-confirm';
  const text = document.createElement('span');
  text.className = 'place-confirm-text';
  text.textContent = actionKind ? `${label}する？` : `${label}をここに建てる？`;

  const ok = document.createElement('button');
  ok.className = 'place-confirm-ok';
  ok.textContent = '✓ 確定';
  ok.addEventListener('click', () => {
    if (uiPhase.type !== 'placePreview') return;
    const act = resolvePlacePreviewAction(state, currentPid(state), uiPhase.kind, uiPhase.targetId);
    uiPhase = { type: 'idle' };
    if (act) dispatch(act);
    redraw();
  });

  const cancel = document.createElement('button');
  cancel.className = 'place-confirm-cancel';
  cancel.textContent = '✕ やめる';
  cancel.addEventListener('click', () => { uiPhase = { type: 'idle' }; redraw(); });

  // [確定][やめる] は専用の横並びコンテナに入れ、幅が狭くても縦積み/折返ししない。
  const actions = document.createElement('div');
  actions.className = 'place-confirm-actions';
  actions.append(ok, cancel);
  bar.append(text, actions);
  document.body.appendChild(bar);

  // 盤面の直下（中央）に出して、選択した道/頂点の近くで確認できるようにする。
  // 画面下に固定すると、スマホ縦持ちでは盤面から遠く離れて見にくいため。
  // 盤面を実測し、はみ出す場合（横持ちで盤面が画面いっぱい等）は画面下端へクランプ。
  const boardEl = document.getElementById('board');
  if (boardEl) {
    const r = boardEl.getBoundingClientRect();
    const margin = 8;
    const maxTop = window.innerHeight - bar.offsetHeight - margin;
    const top = Math.min(r.bottom + margin, Math.max(margin, maxTop));
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(r.left + r.width / 2)}px`;
  }
}

function setUIPhase(phase: UIPhase): void {
  // 盤面SVGの入力は state / buildMode / placePreview のみ（computeHighlights は uiPhase 非参照）。
  // 仮置きプレビューの出し入れ以外の uiPhase 変更（モーダルの +/− 等）では盤面再構築を省く。
  // 例外: robberTarget は盗賊/海賊コマを移動先へプレビュー描画するため盤面を再構築する。
  const robberPhaseChange = phase.type === 'robberTarget' || uiPhase.type === 'robberTarget';
  // placePreview と edgePieceChoice はゴースト/選択の出し入れで盤面SVGを作り直す必要がある。
  const boardPreviewChange = uiPhase.type === 'placePreview' || phase.type === 'placePreview'
    || uiPhase.type === 'edgePieceChoice' || phase.type === 'edgePieceChoice';
  const skipBoard = !robberPhaseChange && !boardPreviewChange;
  // 複数相手の選択に入る瞬間（または開いたまま別タイルへ選び直した時）、まずコマを移動先タイルへ
  // 動かす（「駒移動→相手選択」の順序）。海賊はスライド演出が無いのでプレビュー描画でジャンプ。
  if (phase.type === 'robberTarget' && state
      && (uiPhase.type !== 'robberTarget' || uiPhase.tileId !== phase.tileId)) {
    if (phase.kind !== 'pirate') {
      const fromTile = uiPhase.type === 'robberTarget' ? uiPhase.tileId
        : Object.values(state.tiles).find(t => t.hasRobber)?.id;
      if (fromTile) animateRobberMove(fromTile, phase.tileId);
    }
    robberPreviewedTile = phase.tileId;
    // コマが移動先へスライドした後、略奪相手を選ぶパネル（盤面下の #ui）へ自動スクロール。
    // スライド(約560ms)の完了後に出すため遅延。海賊はスライドが無いので短め。途中で選び終えたら中止。
    const gen = gameGeneration;
    const targetTile = phase.tileId;
    setTimeout(() => {
      if (gen !== gameGeneration || uiPhase.type !== 'robberTarget' || uiPhase.tileId !== targetTile) return;
      // robberTarget 中の .action-buttons は略奪相手ピッカー（modal-panel）のみを含む。
      const el = (document.querySelector('#ui .action-buttons .modal-panel')
        ?? document.querySelector('#ui .action-buttons')
        ?? document.querySelector('#ui .turn-panel')
        ?? document.getElementById('ui')) as HTMLElement | null;
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, phase.kind === 'pirate' ? 160 : 620);
  } else if (phase.type !== 'robberTarget') {
    robberPreviewedTile = null;
  }
  uiPhase = phase;
  redraw(skipBoard);
}

// ============================================================
// ゲーム開始（idempotent: 複数回呼んでも安全）
// ============================================================

// SVG ボードイベントは一度だけ登録
let boardEventsAttached = false;
// 盤面クリック/ジェスチャの登録は一度だけ（ローカル/LAN 共通の単一経路）。
// ※ startGame と startLanGame で別々に attachBoardEvents を呼ぶと引数の渡し忘れ（発明家の
//   getter/setter 欠落で inventorSwap が無反応になった回帰）が起きるため、必ずこの関数に集約する。
// メトロポリス手動選択で都市をタップした時に投げるアクション（改善ボタン or クレーンカード経由）。
// 候補外の頂点は events.ts 側で弾かれるため、ここでは pendingMetropolis の発生源だけで分岐する。
function metropolisPickAction(vid: string): Action | null {
  if (!pendingMetropolis) return null;
  if (pendingMetropolis.via === 'crane') {
    return { type: 'PLAY_PROGRESS', cardId: pendingMetropolis.cardId,
      choice: { craneTrack: pendingMetropolis.track, craneMetropolisVertexId: vid } };
  }
  return { type: 'BUILD_IMPROVEMENT', track: pendingMetropolis.track, metropolisVertexId: vid };
}

function attachBoardEventsOnce(): void {
  if (boardEventsAttached) return;
  attachBoardEvents(
    svgBoard, () => state, () => buildMode, setUIPhase, dispatch, boardCanAct,
    () => moveShipFrom, setMoveShipFrom,
    () => moveKnightFrom, setMoveKnightFrom,
    () => inventorFirstTile, setInventorFirst,
    metropolisPickAction,
    () => smithFirstKnight, setSmithFirst,
    () => deserterRemoveVid, setDeserterRemove,
    () => robberPiece,
    () => (state ? tbNeutralActingOwner(state) : null),
  );
  attachBoardGestures(svgBoard, () => boardViewport, setBoardViewport);
  installHexTooltip(svgBoard, () => state);
  boardEventsAttached = true;
}

// 盤面のピンチズーム/パンの永続ビューポート（viewBox座標系）。
let boardViewport: BoardViewport = { scale: 1, tx: 0, ty: 0 };
function setBoardViewport(vp: BoardViewport): void {
  boardViewport = vp;
  updateZoomControls();
}

// 盤面の中心(viewBox中心)を返す。
function boardCenter(): { cx: number; cy: number } {
  const b = svgBoard.viewBox?.baseVal;
  const w = b?.width || 800, h = b?.height || 700;
  return { cx: (b?.x || 0) + w / 2, cy: (b?.y || 0) + h / 2 };
}

// 盤面を中心固定で拡大/縮小（factor>1=拡大, <1=縮小）。
function zoomBoardBy(factor: number): void {
  const { cx, cy } = boardCenter();
  boardViewport = centeredZoom(boardViewport.scale * factor, cx, cy);
  updateZoomControls();
  redraw();
}

// 盤面ズームを等倍（全体表示）に戻す。
function resetBoardZoom(): void {
  const { cx, cy } = boardCenter();
  boardViewport = centeredZoom(1, cx, cy);
  updateZoomControls();
  redraw();
}

// ズーム操作クラスタの表示位置（board-area に対する割合）・折りたたみ状態を記憶する。
const ZOOM_POS_KEY = 'catan.zoomCtrlPos';
const ZOOM_COLLAPSED_KEY = 'catan.zoomCtrlCollapsed';
function loadZoomPos(): { fx: number; fy: number } | null {
  try { const s = localStorage.getItem(ZOOM_POS_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveZoomPos(fx: number, fy: number): void {
  try { localStorage.setItem(ZOOM_POS_KEY, JSON.stringify({ fx, fy })); } catch { /* ignore */ }
}
// 記憶した割合位置を現在の board-area サイズに合わせて反映（はみ出さないようクランプ）。
function applyZoomPos(box: HTMLElement, host: HTMLElement): void {
  const pos = loadZoomPos();
  if (!pos) return;
  const bw = box.offsetWidth || 110, bh = box.offsetHeight || 36;
  const maxX = Math.max(0, host.clientWidth - bw), maxY = Math.max(0, host.clientHeight - bh);
  const nx = Math.min(maxX, Math.max(0, pos.fx * host.clientWidth));
  const ny = Math.min(maxY, Math.max(0, pos.fy * host.clientHeight));
  box.style.left = `${nx}px`; box.style.top = `${ny}px`;
  box.style.right = 'auto'; box.style.bottom = 'auto';
}
// グリップ(⠿)を掴んでクラスタを自由に移動できるようにする。位置は割合で記憶。
function makeZoomDraggable(box: HTMLElement, handle: HTMLElement): void {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    const host = document.getElementById('board-area');
    if (!host) return;
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = box.getBoundingClientRect(), hr = host.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left - hr.left; oy = r.top - hr.top;
    box.classList.add('dragging');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const host = document.getElementById('board-area');
    if (!host) return;
    const maxX = Math.max(0, host.clientWidth - box.offsetWidth);
    const maxY = Math.max(0, host.clientHeight - box.offsetHeight);
    const nx = Math.min(maxX, Math.max(0, ox + (e.clientX - sx)));
    const ny = Math.min(maxY, Math.max(0, oy + (e.clientY - sy)));
    box.style.left = `${nx}px`; box.style.top = `${ny}px`;
    box.style.right = 'auto'; box.style.bottom = 'auto';
    saveZoomPos(host.clientWidth ? nx / host.clientWidth : 0, host.clientHeight ? ny / host.clientHeight : 0);
    e.preventDefault();
  });
  const end = (e: PointerEvent): void => {
    dragging = false; box.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// box を現在サイズで画面内へ再クランプして保存（展開で幅が変わった時用）。
function reclampZoomPos(box: HTMLElement, host: HTMLElement): void {
  const maxX = Math.max(0, host.clientWidth - box.offsetWidth);
  const maxY = Math.max(0, host.clientHeight - box.offsetHeight);
  const nx = Math.min(maxX, Math.max(0, box.offsetLeft));
  const ny = Math.min(maxY, Math.max(0, box.offsetTop));
  box.style.left = `${nx}px`; box.style.top = `${ny}px`;
  box.style.right = 'auto'; box.style.bottom = 'auto';
  saveZoomPos(host.clientWidth ? nx / host.clientWidth : 0, host.clientHeight ? ny / host.clientHeight : 0);
}
// 折りたたみ切替（折りたたみ時は −/⤢/＋ を隠して最小化）。状態を記憶。
function setZoomCollapsed(box: HTMLElement, host: HTMLElement, collapsed: boolean): void {
  box.classList.toggle('collapsed', collapsed);
  const tg = box.querySelector('.z-toggle') as HTMLButtonElement | null;
  if (tg) {
    tg.textContent = collapsed ? '⊕' : '‹';
    const t = collapsed ? 'ズーム操作を開く' : '折りたたむ';
    tg.title = t; tg.setAttribute('aria-label', t);
  }
  try { localStorage.setItem(ZOOM_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  requestAnimationFrame(() => reclampZoomPos(box, host)); // 幅変化に追従して画面内へ
}

// 盤面のズーム操作クラスタ。既定は盤面左上・折りたたみ（小さい）。グリップ(⠿)でドラッグ移動でき、
// ⊕ で −/⤢/＋ を展開。位置・開閉状態は記憶される。
function updateZoomControls(): void {
  const host = document.getElementById('board-area');
  if (!host || !inGame) { document.getElementById('board-zoom')?.remove(); return; }
  let box = document.getElementById('board-zoom');
  if (!box) {
    box = document.createElement('div');
    box.id = 'board-zoom';
    const boxRef = box;
    const handle = document.createElement('div');
    handle.className = 'zoom-drag';
    handle.textContent = '⠿';
    handle.title = 'ドラッグで移動';
    handle.setAttribute('aria-label', 'ズーム操作の位置を移動');
    box.appendChild(handle);
    const mk = (txt: string, cls: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = `zoom-btn ${cls}`;
      b.textContent = txt;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      return b;
    };
    box.appendChild(mk('⊕', 'z-toggle', 'ズーム操作を開く',
      () => setZoomCollapsed(boxRef, host, !boxRef.classList.contains('collapsed'))));
    box.appendChild(mk('−', 'z-out', '縮小（全体を表示）', () => zoomBoardBy(1 / 1.25)));
    box.appendChild(mk('⤢', 'z-reset', '全体表示に戻す', () => resetBoardZoom()));
    box.appendChild(mk('＋', 'z-in', '拡大（島を大きく表示）', () => zoomBoardBy(1.25)));
    host.appendChild(box);
    applyZoomPos(box, host);
    makeZoomDraggable(box, handle);
    let collapsed = true;
    try { collapsed = (localStorage.getItem(ZOOM_COLLAPSED_KEY) ?? '1') === '1'; } catch { /* ignore */ }
    setZoomCollapsed(box, host, collapsed);
  }
  const s = boardViewport.scale;
  (box.querySelector('.z-out') as HTMLButtonElement | null)?.toggleAttribute('disabled', s <= ZOOM_LIMITS.min + 0.001);
  (box.querySelector('.z-in') as HTMLButtonElement | null)?.toggleAttribute('disabled', s >= ZOOM_LIMITS.max - 0.001);
  (box.querySelector('.z-reset') as HTMLButtonElement | null)?.classList.toggle('active', Math.abs(s - 1) > 0.01);
}

// 飛行中の一時演出ノード（ダイス/資源/盗賊/略奪/得点ポップ/手番トースト）を掃除する。
// ゲーム開始・ホーム復帰時に呼び、前ゲームの残骸が次画面に残らないようにする。
function clearTransientFx(): void {
  document
    .querySelectorAll('.dice-roll-overlay, .dice-board-dim, .dice-color-wash, .res-fly, .robber-fly, .steal-card, .badge-fly, .vp-pop, .bonus-pop, #turn-toast, #board-notice, #played-progress, #barbarian-attack')
    .forEach(n => n.remove());
}

// ============================================================
// LAN対戦: ゲーム開始 / サーバメッセージ処理 / Action送信
// ============================================================

// 現在の手番プレイヤーID。
function currentPid(s: GameState): PlayerId {
  return s.playerOrder[s.currentPlayerIndex]!;
}

// 盤面クリック（配置・盗賊）を受け付けてよいか。LAN=自分の手番のみ、ローカル=人間の手番のみ。
// startGame / startLanGame のどちらで登録されても同一の述語で両モードを判定する。
function boardCanAct(): boolean {
  if (!state) return false;
  // 騎士と商人: 都市格下げは多人数解決。対象（LAN=viewer/ローカル=人間）は手番外でも盤面操作可。
  if (state.turnPhase === 'CITY_DOWNGRADE') {
    const pending = state.pendingCityDowngrade ?? [];
    if (netMode) return viewerPlayerId != null && pending.includes(viewerPlayerId);
    return pending.some(p => state.players[p]?.type === 'human');
  }
  // 交易と蛮族イベント「地震」: 対象は手番外でも盤面（自分の道）をタップして解決する。
  if (state.turnPhase === 'EVENT_DAMAGE') {
    const pending = state.tbPendingEventDamage ?? [];
    if (netMode) return viewerPlayerId != null && pending.includes(viewerPlayerId);
    return pending.some(p => state.players[p]?.type === 'human');
  }
  if (netMode) return viewerPlayerId != null && viewerPlayerId === currentPid(state);
  return state.players[currentPid(state)]?.type === 'human';
}

// LAN で送信を許可する Action（クライアント側ガード。サーバでも二重に検証）。
// クライアント送信フィルタ。サーバ受理リストと同一の単一の真実(LAN_SYNCED_ACTIONS)から生成する
// （二重管理のズレで騎士と商人の操作が送られず「ボタン無反応」になっていた回帰の根治）。
const LAN_CLIENT_ALLOWED = new Set<Action['type']>(LAN_SYNCED_ACTIONS);

// ロビーから started を受け取った時に呼ばれる。以降のメッセージは main が受ける。
function startLanGame(initial: GameState, viewerId: PlayerId, client: LanClient): void {
  // CPU 系タイマーを無効化（LANはCPU不使用）
  gameGeneration++;
  document.querySelector('.victory-overlay')?.remove(); document.getElementById('victory-reopen-btn')?.remove(); document.querySelector('.dicestats-overlay')?.remove(); document.getElementById('cpu-status')?.remove();

  netMode = true;
  inGame = true;
  reconnectTries = 0;
  reconnecting = false;
  reconnectSince = 0;
  viewerPlayerId = viewerId;
  lanClient = client;
  state = initial;
  buildMode = 'idle';
  uiPhase = { type: 'idle' };
  landscapeSheetUserOpen = false;
  diceAnimating = false;
  clearTransientFx();
  pendingNetStates = [];
  diceStats = new Array(13).fill(0);

  // 以降のサーバメッセージ（状態更新・切断等）は main 側で処理する。
  client.setHandler(handleNetMessage);
  // 予期しない切断時は再接続を試みる（致命扱いにしない）。
  client.setOnClose(attemptReconnect);

  // ボードクリック（配置・盗賊）を有効化。dispatch は netMode で送信に分岐する。
  attachBoardEventsOnce();

  boardViewport = { scale: 1, tx: 0, ty: 0 }; // 新規対戦はズームをリセット

  // 画面をゲーム本体へ切替
  homeDiv.style.display = 'none';
  gameTitle.style.display = 'none';
  appDiv.style.display = '';

  hideReconnecting();
  redraw();
  maybeScrollForMySetup(state); // LAN開始直後が自分のSETUP配置番なら盤面へスクロール
}

// ============================================================
// LAN 再接続（一時切断・リロード復帰・サーバ再起動からの復元）
// ============================================================
//
// 方針: 対局中に接続が切れても「こちらからは絶対に諦めない」。
//   - 回数上限を設けず、間隔だけ広げて延々と再接続を試す（トンネル・機内モード・
//     ホテルWi-Fi・端末スリープなど、数分後に戻ってくるケースを取りこぼさない）。
//   - 画面復帰/オンライン復帰イベントで即座に試行する（バックグラウンドではタイマーが
//     絞られるため、時間任せだと「戻ってきた瞬間」に間に合わない）。
//   - サーバ側にルームが無くなっていたら、預かった封印スナップショットで復元を試みる。
//   - 諦めるのはユーザーが「やめる」を押したときと、サーバが明確に拒否したときだけ。

let reconnectTries = 0;
// バックオフ（ms）。最後の値以降はその値で打ち止め＝無期限に試し続ける。
const RECONNECT_DELAYS = [400, 800, 1500, 3000, 5000, 8000, 12000, 15000];
let reconnecting = false;         // 再接続の試行が進行中（多重起動の抑止）
let reconnectSince = 0;           // 切断が始まった時刻（バナー表示用）

// 再接続のスケジュールを一本化する。WebSocket の接続失敗は error と close の両方が
// 発火するため、素朴に両方から setTimeout すると試行が指数的に分岐し、複数ソケットが
// 並行接続 → 孤児クライアントがブロードキャストを二重処理（SE二重・演出二重）し得る。
let reconnectTimer: number | null = null;
function scheduleReconnect(): void {
  if (!netMode) return;
  if (reconnectTimer != null) return; // 既にスケジュール済みなら重複させない
  const delay = RECONNECT_DELAYS[Math.min(reconnectTries, RECONNECT_DELAYS.length - 1)]!;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    attemptReconnect();
  }, delay);
}

// 「今すぐ試す」系のトリガ（画面復帰・オンライン復帰・手動ボタン）。
// バックオフをリセットして即時に1回試す。
function kickReconnect(): void {
  if (!netMode) return;
  if (lanClient?.isOpen()) { lanClient.checkAlive(); return; } // 生きていれば生存確認だけ
  reconnectTries = 0;
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  attemptReconnect();
}

// 端末の状態変化に反応して即座に張り直す。
// スマホはバックグラウンドで setTimeout が大きく間引かれるため、
// 「復帰した瞬間のイベント」を拾えるかどうかが体感の分かれ目になる。
window.addEventListener('online', kickReconnect);
window.addEventListener('focus', kickReconnect);
window.addEventListener('pageshow', kickReconnect); // bfcache からの復帰
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') kickReconnect();
});

function showReconnecting(message?: string): void {
  let el = document.getElementById('reconnect-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reconnect-banner';
    const txt = document.createElement('span');
    txt.id = 'reconnect-text';
    const retry = document.createElement('button');
    retry.id = 'reconnect-retry';
    retry.type = 'button';
    retry.textContent = '今すぐ再試行';
    retry.addEventListener('click', kickReconnect);
    const quit = document.createElement('button');
    quit.id = 'reconnect-quit';
    quit.type = 'button';
    quit.textContent = 'やめる';
    quit.addEventListener('click', () => {
      if (!window.confirm('対戦から抜けてホームに戻りますか？（この対局には戻れなくなります）')) return;
      abandonNetGame();
    });
    el.append(txt, retry, quit);
    document.body.appendChild(el);
  }
  const txt = el.querySelector('#reconnect-text');
  if (txt) {
    const secs = reconnectSince ? Math.floor((Date.now() - reconnectSince) / 1000) : 0;
    txt.textContent = message ?? (secs >= 5 ? `🔄 再接続中…（${secs}秒）` : '🔄 再接続中…');
  }
  el.style.display = '';
}
function hideReconnecting(): void {
  const el = document.getElementById('reconnect-banner');
  if (el) el.style.display = 'none';
}

// ゲーム中に WebSocket が切れたとき、保存した resume 情報で同一プレイヤー復帰を試みる。
// 失敗しても諦めず、バックオフしながら試し続ける（打ち切りはユーザー操作のみ）。
function attemptReconnect(): void {
  if (!netMode) return;
  const info = loadResume();
  // resume 情報が無いと同一プレイヤーとして戻れない（＝この対局は続行不能）。
  if (!info) { reconnectFailed('この対局に戻るための情報が失われました。'); return; }
  if (reconnecting) return;         // 進行中の試行があるなら任せる
  if (lanClient?.isOpen()) return;  // 既に繋がっている
  reconnecting = true;
  reconnectTries++;
  if (!reconnectSince) reconnectSince = Date.now();
  showReconnecting();
  const client = new LanClient(handleNetMessage);
  client.setOnClose(() => {
    // 再接続中にまた切れたらバックオフして再試行（error/close の二重発火は scheduleReconnect が吸収）。
    reconnecting = false;
    scheduleReconnect();
  });
  client.connect().then(() => {
    reconnecting = false;
    // ハンドシェイク中にホーム復帰やローカル新ゲーム開始（netMode=false）が起きた場合、
    // この接続は誰からも参照されておらず returnToHome/startGame の後始末では閉じられない。
    // ここで resume を送ると放棄した LAN ゲームが 'started' で復活し、進行中のローカル
    // ゲームやホーム画面を乗っ取るため、破棄して終了する。
    if (!netMode) { client.close(); return; }
    // 旧クライアントが残っていれば閉じる（孤児接続の二重メッセージ処理を防ぐ。
    // close() は closedByUs を立てるため旧側の onClose → 再接続ループは発火しない）。
    if (lanClient && lanClient !== client) lanClient.close();
    lanClient = client;
    client.send({ t: 'resume', code: info.code, you: info.you, token: info.token });
  }).catch(() => {
    reconnecting = false;
    scheduleReconnect();
  });
}

// 復帰不能と判明したときだけ呼ぶ（サーバが拒否した／復元データが無い）。
function reconnectFailed(reason = '接続が切れました。ルームに入り直してください。'): void {
  if (!netMode) return;
  netMode = false;
  reconnectTries = 0;
  reconnecting = false;
  reconnectSince = 0;
  clearResume();
  hideReconnecting();
  window.alert(reason);
  returnToHome();
}

// ユーザーが自分の意思で対戦を降りる（再接続バナーの「やめる」）。
function abandonNetGame(): void {
  netMode = false;
  reconnecting = false;
  reconnectTries = 0;
  reconnectSince = 0;
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  clearResume();
  hideReconnecting();
  returnToHome();
}

function handleNetMessage(msg: import('./net/protocol').ServerMessage): void {
  switch (msg.t) {
    case 'joined':
      // 再接続成功（resume/restore）でも届く。トークンを保存し、再接続UIを閉じる。
      viewerPlayerId = msg.you;
      saveResume({ code: msg.code, you: msg.you, token: msg.token });
      reconnectTries = 0;
      reconnectSince = 0;
      hideReconnecting();
      break;
    case 'started':
      // 開始 or 再接続復帰: viewer と state を更新（再接続時はゲーム画面へ復帰）。
      reconnectTries = 0;
      reconnectSince = 0;
      hideReconnecting();
      if (!netMode) { startLanGame(msg.state, msg.you, lanClient!); break; }
      viewerPlayerId = msg.you;
      state = msg.state;
      pendingNetStates = []; // 正本を受け直したので保留中の旧配信は破棄
      redraw();
      maybeScrollForMySetup(state); // 復帰時に自分のSETUP配置番なら盤面へスクロール
      break;
    case 'state':
      // サーバが適用済みの正本（マスク済み）。演出はアクション種別で再現する。
      hideReconnecting();
      applyNetState(msg.action, msg.state);
      break;
    case 'snapshot':
      // サーバ再起動に備えた封印スナップショット（中身は読めない）。次の復元まで預かる。
      saveSnapshot(msg.code, msg.sealed, msg.turn);
      break;
    case 'restorable': {
      // サーバにルームが無い（再起動・スリープ明け）。預かったスナップショットで復元を試みる。
      const info = loadResume();
      const sealed = loadSnapshot(msg.code);
      if (info && sealed && lanClient) {
        showReconnecting('♻️ 対局を復元しています…');
        lanClient.send({ t: 'restore', code: msg.code, you: info.you, token: info.token, sealed });
      } else {
        reconnectFailed('サーバが再起動したため、この対局は終了しました。ルームを作り直してください。');
      }
      break;
    }
    case 'bye':
      // サーバの計画停止（デプロイ等）。すぐ戻ってくるので、案内だけ出して再接続に任せる。
      if (netMode) {
        reconnectSince = reconnectSince || Date.now();
        showReconnecting(`🔄 ${msg.reason}。自動で復帰します…`);
        reconnectTries = 0;
      }
      break;
    case 'error':
      if (msg.fatal) {
        // サーバが resume/restore を明確に拒否した（接続は開いている）。再接続せずホームへ。
        if (netMode) reconnectFailed(`LAN対戦: ${msg.message}`);
      } else {
        // 操作拒否など非致命: 進行は継続（次の state 配信で UI は整合する）。
        console.warn('LAN操作エラー:', msg.message);
      }
      break;
    // 'lobby'（開始後の参加者増減ブロードキャスト等）は無視
  }
}

// アクション種別に応じた効果音。ローカル dispatch / LAN 受信の双方で使う。
// ---- ハプティクス（触覚フィードバック・B-5）。対応端末のみ動作、設定で無効化可。 ----
const HAPTICS_KEY = 'catan_haptics';
let hapticsEnabled = (() => { try { const v = localStorage.getItem(HAPTICS_KEY); return v == null ? true : v === '1'; } catch { return true; } })();
function isHapticsEnabled(): boolean { return hapticsEnabled; }
function setHapticsEnabled(v: boolean): void {
  hapticsEnabled = v;
  try { localStorage.setItem(HAPTICS_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  if (v) vibrate(15); // ON にした瞬間に確認の軽い振動
}
function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}
function vibrate(pattern: number | number[]): void {
  if (!hapticsEnabled || !hapticsSupported()) return;
  try { navigator.vibrate(pattern); } catch { /* ignore */ }
}
// アクション種別に応じた軽い触覚（音と同経路で local/LAN 双方から呼ばれる）。
function vibrateForAction(action: Action): void {
  switch (action.type) {
    case 'BUILD_ROAD': case 'BUILD_SETTLEMENT': case 'BUILD_CITY': vibrate(18); break;
    case 'ROLL_DICE':         vibrate([12, 45, 12]); break;
    case 'CONFIRM_TRADE':     vibrate([10, 30, 10]); break;
    case 'MOVE_ROBBER':       vibrate(28); break;
    case 'DECLARE_VICTORY':   vibrate([20, 40, 20, 40, 50]); break;
  }
}

function playActionSE(action: Action): void {
  switch (action.type) {
    case 'ROLL_DICE':         playSE('dice'); break;
    case 'BUILD_ROAD':
    case 'BUILD_SETTLEMENT':
    case 'BUILD_CITY':        playSE('build'); break;
    case 'BUY_DEV_CARD':      playSE('devCard'); break;
    case 'PLAY_KNIGHT':
    case 'PLAY_ROAD_BUILDING':
    case 'PLAY_YEAR_OF_PLENTY':
    case 'PLAY_MONOPOLY':     playSE('devCard'); break;
    case 'MOVE_ROBBER':
    case 'MOVE_PIRATE':       playSE('robber'); break;
    case 'CONFIRM_TRADE':     playSE('tradeOk'); break;
    case 'RESPOND_TRADE':
      if ((action as { response: { status: string } }).response.status === 'REJECT') playSE('tradeNg');
      break;
    case 'END_TURN':          playSE('turnStart'); break;
    case 'DECLARE_VICTORY':   playSE('victory'); break;
    case 'DISCARD_RESOURCES': playSE('discardLose'); break;
    case 'CHOOSE_GOLD':       playSE('build'); break;
    // 交易と蛮族「イベントカード」: 選択解決のSE（既存音の流用）。
    case 'CHOOSE_EVENT_GIVE':
    case 'CHOOSE_EVENT_HELPFUL': playSE('tradeOk'); break;
    case 'CHOOSE_EVENT_STEAL':   if (action.targetPlayerId != null) playSE('robber'); break;
    case 'CHOOSE_EVENT_DAMAGE':  playSE('discardLose'); break;
    case 'REPAIR_ROAD':          playSE('build'); break;
  }
}

// LAN: ダイス演出中に届いた後続のサーバ配信を一時保留するキュー。
// 即時適用すると (1) 演出が打ち切られ手札が先に増えて見える、(2) 残った settle タイマーが
// 古い prevState と最新 state を比較して VP ポップ等を二重再生する、ため演出終了後に順次適用する。
let pendingNetStates: Array<{ action: Action | undefined; state: GameState }> = [];

// LAN: サーバ配信の新 state を反映し、アクション種別に応じた演出を再現する。
// ローカル applyAction は行わない（正本はサーバ）。CPU/ログ処理も走らせない。
function applyNetState(action: Action | undefined, newState: GameState): void {
  if (diceAnimating) {
    pendingNetStates.push({ action, state: newState });
    return;
  }
  const gen = gameGeneration;
  const prevState = state;
  state = newState;

  // SE（dispatch と同じ対応）
  if (action) playActionSE(action);

  // 勝利演出（GAME_OVER 遷移時）
  if (state.phase === 'GAME_OVER' && prevState.phase !== 'GAME_OVER') {
    playSE('victory');
    if (state.winner && action) showVictoryOverlay(state.winner, action.type);
  }

  const diceTotal = action?.type === 'ROLL_DICE' && state.lastDiceRoll
    ? state.lastDiceRoll[0] + state.lastDiceRoll[1]
    : undefined;
  if (action?.type === 'ROLL_DICE' && diceTotal !== undefined && diceTotal >= 2 && diceTotal <= 12) {
    diceStats[diceTotal] = (diceStats[diceTotal] ?? 0) + 1;
  }

  const robberFromTile = action?.type === 'MOVE_ROBBER'
    ? Object.values(prevState.tiles).find(t => t.hasRobber)?.id
    : undefined;

  if (action && (action.type === 'BUILD_ROAD' || action.type === 'BUILD_SETTLEMENT' || action.type === 'BUILD_CITY'
      || action.type === 'PLAY_PROGRESS' || action.type === 'BUILD_IMPROVEMENT')) {
    buildMode = 'idle';
    pendingMetropolis = null;
    inventorFirstTile = null;
    smithFirstKnight = null;
    deserterRemoveVid = null;
  }
  // ターン終了で建設モード/船移動選択を解除（次ターンにモードが残るのを防ぐ・LAN）。
  if (action?.type === 'END_TURN' || action?.type === 'MOVE_SHIP') {
    buildMode = 'idle';
    moveShipFrom = null;
    moveKnightFrom = null;
  }
  if (action?.type === 'PLAY_ROAD_BUILDING') {
    buildMode = 'road';
    if (currentPid(state) === selfPlayerId()) scrollToBoard(); // viewer の手番のみ盤面へ
  }
  if (state.roadBuildingRoadsRemaining > 0) buildMode = 'road';

  // 交易/発展カード/盗賊/ターン終了などの後はモーダルUIを閉じる（CPU path と同様）。
  // ただし DISCARD_RESOURCES は除外（複数人捨て札で他人の捨て札時に自分の選択中UIを
  // 消さないため）。捨て札・盗賊ターゲットは直後の redraw 自動同期が再導出する。
  if (action && action.type !== 'DISCARD_RESOURCES' && RESET_UIPHASE_ACTIONS.has(action.type)) {
    uiPhase = { type: 'idle' };
  }

  // 再描画＋演出（dispatch と共通本体）。LAN では後続スケジューリングはしない（サーバが駆動）。
  // 世代ガード: ダイス演出中のホーム復帰後に旧ゲームの演出を走らせない。
  runWithDiceAnim(action, prevState, () => {
    if (gen !== gameGeneration) return;
    runTransitionFx(prevState, action, diceTotal, robberFromTile);
    // 演出中に溜まった配信を順次適用（後続が ROLL_DICE なら再び演出に入りキューが続く）。
    while (pendingNetStates.length > 0 && !diceAnimating) {
      const next = pendingNetStates.shift()!;
      applyNetState(next.action, next.state);
    }
  });
}

// LAN: クライアント操作をサーバへ送る（ローカル state は変更しない）。
function netDispatch(action: Action): void {
  if (diceAnimating) return;
  if (!lanClient || !viewerPlayerId) return;
  // 切断中に押された操作は握りつぶさず、再接続を促す（「押しても無反応」を作らない）。
  // 復帰後はサーバの正本 state が配信されるので、ここで送らなくても盤面はズレない。
  if (!lanClient.isOpen()) {
    showReconnecting();
    kickReconnect();
    return;
  }
  if (!LAN_CLIENT_ALLOWED.has(action.type)) return; // 未対応操作は送らない
  // actor（操作者）が自分か。多人数解決（捨て札/金/都市格下げ/進歩カード捨て）は手番に関係なく
  // action.playerId が操作者。交易応答は応答者。それ以外は手番プレイヤー。
  // ※ DOWNGRADE_CITY/DISCARD_PROGRESS を入れ忘れると、蛮族襲来が他人の手番で起きた時に viewer の
  //   格下げ操作が currentPid 判定で弾かれ「オンラインだと格下げできない」原因になる（サーバの
  //   requiredActor と一致させる）。
  const actor =
    action.type === 'DISCARD_RESOURCES' ? action.playerId :
    action.type === 'CHOOSE_GOLD'       ? action.playerId :
    action.type === 'DOWNGRADE_CITY'    ? action.playerId :
    action.type === 'DISCARD_PROGRESS'  ? action.playerId :
    action.type === 'CHOOSE_EVENT_GIVE'    ? action.playerId :
    action.type === 'CHOOSE_EVENT_HELPFUL' ? action.playerId :
    action.type === 'CHOOSE_EVENT_DAMAGE'  ? action.playerId :
    action.type === 'CHOOSE_EVENT_STEAL'   ? (state.tbPendingEventSteal?.playerId ?? currentPid(state)) :
    action.type === 'RESPOND_TRADE'     ? action.response.playerId :
    currentPid(state);
  if (actor !== viewerPlayerId) return; // 自分の操作できる場面のみ送信
  vibrateForAction(action); // 自分の操作の触覚は送信時に即返す（LANの往復待ちを避ける）
  // 進歩カード使用は「何を使ったか」が公開情報。送信側が札種を載せておくと、相手クライアントは
  // サーバの lastProgressPlay（サーバ更新依存）に頼らず盤面表示できる（サーバが旧版でも転送される）。
  let out = action;
  if (action.type === 'PLAY_PROGRESS' && !action.cardType) {
    const ct = state.players[actor]?.progressCards?.find(c => c.id === action.cardId)?.type;
    if (ct) out = { ...action, cardType: ct };
  }
  lanClient.send({ t: 'action', action: out });
}

function startGame(cfg: HomeConfig): void {
  // 新しいゲーム世代 → 前の AI setTimeout を無効化
  gameGeneration++;
  document.querySelector('.victory-overlay')?.remove(); document.getElementById('victory-reopen-btn')?.remove(); document.querySelector('.dicestats-overlay')?.remove(); document.getElementById('cpu-status')?.remove();

  // CPU対戦はローカル完結。LAN終了画面からの「もう一度プレイ」等で LAN セッションが残って
  // いると、古いハンドラに後続の 'state' 配信が届いてローカルゲームを上書きするため確実に破棄する。
  if (netMode || lanClient) {
    lanClient?.close();
    lanClient = null;
    viewerPlayerId = null;
  }
  netMode = false;
  reconnectTries = 0;
  reconnecting = false;
  reconnectSince = 0;
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  hideReconnecting();
  clearResume();
  pendingNetStates = [];
  inGame = true;
  lastConfig = cfg;
  state = initGameState(cfg);
  buildMode = 'idle';
  uiPhase = { type: 'idle' };
  landscapeSheetUserOpen = false;
  diceAnimating = false;
  clearTransientFx();
  cpuPlayerTradeOfferedThisTurn = false;
  lastCpuOfferSignature = null;
  diceStats = new Array(13).fill(0); // 新規ゲームで出目分布をリセット

  // 画面切り替え（ゲーム中は大きなタイトルは出さず、盤面/操作の領域を広げる）
  homeDiv.style.display = 'none';
  gameTitle.style.display = 'none';
  appDiv.style.display = '';

  // ボードイベントは初回のみ登録（二重登録防止）
  if (!boardEventsAttached) {
    attachBoardEventsOnce();
  }

  boardViewport = { scale: 1, tx: 0, ty: 0 }; // 新規ゲームはズームをリセット
  redraw();
  maybeScrollForMySetup(state); // 開始直後が自分のSETUP配置番なら盤面へスクロール
  scheduleAiTurn();
}

// ============================================================
// ホームに戻る
// ============================================================

function returnToHome(): void {
  // AI タイムアウトを無効化
  gameGeneration++;
  inGame = false;
  pendingNetStates = [];
  document.querySelector('.victory-overlay')?.remove(); document.getElementById('victory-reopen-btn')?.remove(); document.querySelector('.dicestats-overlay')?.remove(); document.getElementById('cpu-status')?.remove();
  document.getElementById('zoom-reset')?.remove(); document.getElementById('board-zoom')?.remove(); document.getElementById('place-confirm')?.remove(); document.getElementById('ship-help')?.remove();
  boardViewport = { scale: 1, tx: 0, ty: 0 };
  diceAnimating = false;
  clearTransientFx();
  // 横持ちボトムシートの状態をリセット
  landscapeSheetUserOpen = false;
  document.body.classList.remove('lsheet-open');

  // LAN対戦の後片付け（接続を閉じてローカルモードへ戻す）
  if (netMode || lanClient) {
    lanClient?.close();
    lanClient = null;
    netMode = false;
    viewerPlayerId = null;
  }
  // 明示的にホームへ戻ったので再接続情報は破棄（自動復帰しない）。
  reconnectTries = 0;
  reconnecting = false;
  reconnectSince = 0;
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  hideReconnecting();
  clearResume();

  appDiv.style.display = 'none';
  gameTitle.style.display = 'none';
  homeDiv.style.display = '';

  // ホーム画面を再レンダリング（前回の設定を引き継ぐ。resume は渡さない）。
  renderHome(homeDiv, startGame, startLanGame);
}

// ============================================================
// 起動
// ============================================================

// 画面サイズ/向きの変化に追従（四隅⇄ミニパネルの切替も含めリロード不要）。
// ミニパネルの幅(--board-draw-width)はドラッグ中もズレないよう即時に同期し、
// 重い再描画（レイアウト判定込み）は ~100ms デバウンスして連打を抑える。
let viewportChangeTimer: ReturnType<typeof setTimeout> | null = null;
function onViewportChange(): void {
  // ホーム画面では何もしない（redraw→armCpuWatchdog 経由で放棄したゲームが再起動するのを防ぐ）。
  if (!inGame || !state) return;
  syncBoardDrawWidth();
  if (viewportChangeTimer) clearTimeout(viewportChangeTimer);
  viewportChangeTimer = setTimeout(() => {
    viewportChangeTimer = null;
    // ダイス演出中の再描画は避ける。出目が止まる前に手札カウントが更新され「資源が
    // 先に増えて見える」ため。演出完了時に runTransitionFx が必ず再描画するので取り残されない。
    if (inGame && state && !diceAnimating) redraw();
  }, 100);
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);

// メニュー外クリックで閉じる
document.addEventListener('click', (e) => {
  if (!gameMenuOpen) return;
  const target = e.target as Node;
  if (!gameNav.contains(target)) {
    gameMenuOpen = false;
    const dd = gameNav.querySelector('.game-menu') as HTMLElement | null;
    if (dd) dd.style.display = 'none';
  }
});

// 起動時: 保存された resume 情報があれば自動で再接続を試みる（リロード復帰）。
renderHome(homeDiv, startGame, startLanGame, loadResume() ?? undefined);

