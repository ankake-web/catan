// ============================================================
// src/assets/manifest.ts — 画像素材の中央マニフェスト（単一の真実）
// ============================================================
//
// ゲーム要素 → 画像URL を一元定義する。アプリ内の画像参照は必ずこのマニフェスト経由にする。
// Vite が import を base 付きの実URLへ解決する。未作成の要素は null とし、呼び出し側は
// placeholder()／assetImg() で「壊れ画像・404・クラッシュ」を出さずに代替表示する。
//
// 命名規約（正規ファイル名）に合わせて src/assets/ 配下へ配置済み。

// ---- コマ・盤面（プレイヤー色つき） ----
import houseRed from './settlement-red.png';
import houseBlue from './settlement-blue.png';
import housePurple from './settlement-purple.png';
import houseOrange from './settlement-orange.png';
import cityRed from './city-red.png';
import cityBlue from './city-blue.png';
import cityPurple from './city-purple.png';
import cityOrange from './city-orange.png';
import metropolisRed from './metropolis-red.png';
import metropolisBlue from './metropolis-blue.png';
import metropolisPurple from './metropolis-purple.png';
import metropolisOrange from './metropolis-orange.png';
import shipRed from './ship-red.png';
import shipBlue from './ship-blue.png';
import shipPurple from './ship-purple.png';
import shipOrange from './ship-orange.png';
import settlementGeneric from './settlement.png';
import cityGeneric from './city.png';
import robber from './robber.png';
import pirate from './pirate.png';
import barbarianShip from './barbarian-ship.png';
// ---- アクション系アイコン（道建設・バンク交易・プレイヤー間交易） ----
import roadIcon from './road.png';
import bankTradeIcon from './bank-trade.png';
import playerTradeIcon from './player-trade.png';
import knightActivateIcon from './knight-activate.png';
import knightUpgradeIcon from './knight-upgrade.png';

// ---- 騎士（基本/強い/最強。盤面はプレイヤー色の土台ディスクで所有者を示す中立コマ） ----
import knightBasic from './knight-basic.png';
import knightStrong from './knight-strong.png';
import knightMighty from './knight-mighty.png';

// ---- 騎士と商人の追加コマ ----
import merchant from './merchant.png';
import metropolisGate from './metropolis-gate.png';
import defenderBadge from './defender-badge.png';
import cityWall from './city-wall.png';

// ---- 資源5 ----
import resLumber from './res-lumber.png';
import resBrick from './res-brick.png';
import resWool from './res-wool.png';
import resGrain from './res-grain.png';
import resOre from './res-ore.png';

// ---- 地形タイルのイラスト（ヘックスに敷く・俯瞰の手描き調） ----
import tileForest from './tile-forest.jpg';
import tileField from './tile-field.jpg';
import tilePasture from './tile-pasture.jpg';
import tileHill from './tile-hill.jpg';
import tileMountain from './tile-mountain.jpg';
import tileDesert from './tile-desert.jpg';
import tileGold from './tile-gold.jpg';
import tileSea from './tile-sea.jpg';

// ---- 商品3 ----
import comPaper from './com-paper.png';
import comCloth from './com-cloth.png';
import comCoin from './com-coin.png';

// ---- 改良建築6（トラック×レベル：Lv3/Lv4） ----
import bldTradingHouse from './bld-trading-house.png'; // 商業L3
import bldBank from './bld-bank.png';                  // 商業L4
import bldFortress from './bld-fortress.png';          // 政治L3
import bldCathedral from './bld-cathedral.png';        // 政治L4
import bldAqueduct from './bld-aqueduct.png';          // 科学L3
import bldTheater from './bld-theater.png';            // 科学L4

// ---- 改良トラックのアイコン（ボタン用、Lv1–2/5 など建築が無いレベルで使用） ----
import impTrade from './track-trade.png';
import impPolitics from './track-politics.png';
import impScience from './track-science.png';

// ---- 進歩カードの裏（トラック色） ----
import cardBackTrade from './card-back-trade.png';
import cardBackPolitics from './card-back-politics.png';
import cardBackScience from './card-back-science.png';

// ---- 政治カード9種 ----
import polBishop from './card-pol-bishop.png';
import polDiplomat from './card-pol-diplomat.png';
import polIntrigue from './card-pol-intrigue.png';
import polDeserter from './card-pol-deserter.png';
import polWarlord from './card-pol-warlord.png';
import polSpy from './card-pol-spy.png';
import polSaboteur from './card-pol-saboteur.png';
import polWedding from './card-pol-wedding.png';
import polConstitution from './card-pol-constitution.png';

// ---- 科学カード10種（緑） ----
import sciAlchemist from './card-sci-alchemist.png';
import sciCrane from './card-sci-crane.png';
import sciEngineer from './card-sci-engineer.png';
import sciInventor from './card-sci-inventor.png';
import sciIrrigation from './card-sci-irrigation.png';
import sciMedicine from './card-sci-medicine.png';
import sciMining from './card-sci-mining.png';
import sciRoadBuilding from './card-sci-road-building.png';
import sciSmith from './card-sci-smith.png';
import sciPrinter from './card-sci-printer.png';

// ---- 商業カード6種（黄） ----
import comMerchant from './card-com-merchant.png';
import comMerchantFleet from './card-com-merchant-fleet.png';
import comMasterMerchant from './card-com-master-merchant.png';
import comCommercialHarbor from './card-com-commercial-harbor.png';
import comResourceMonopoly from './card-com-resource-monopoly.png';
import comTradeMonopoly from './card-com-trade-monopoly.png';

// ---- 背景・装飾 ----
import bgTitle from './bg-title.jpg';
import bgVictory from './bg-victory.jpg';
import bgBarbarian from './bg-barbarian.jpg';
import frameDecorative from './frame-decorative.png';

export type ColorKey = 'red' | 'blue' | 'purple' | 'orange';

const HOUSE: Record<ColorKey, string> = { red: houseRed, blue: houseBlue, purple: housePurple, orange: houseOrange };
const CITY: Record<ColorKey, string> = { red: cityRed, blue: cityBlue, purple: cityPurple, orange: cityOrange };
const METROPOLIS: Record<ColorKey, string> = { red: metropolisRed, blue: metropolisBlue, purple: metropolisPurple, orange: metropolisOrange };
const SHIP: Record<ColorKey, string> = { red: shipRed, blue: shipBlue, purple: shipPurple, orange: shipOrange };

/**
 * 素材一覧。未作成は null（呼び出し側で placeholder にフォールバック）。
 * これがアプリ内の画像参照の唯一の出所。
 */
export const ASSETS = {
  piece: {
    settlement: settlementGeneric,
    city: cityGeneric,
    robber,
    pirate,
    merchant,
    metropolisGate,
    defenderBadge,
    cityWall,
    barbarianShip: barbarianShip as string | null, // 蛮族船コマ
  },
  knight: { basic: knightBasic, strong: knightStrong, mighty: knightMighty } as Record<'basic' | 'strong' | 'mighty', string>,
  resource: { lumber: resLumber, brick: resBrick, wool: resWool, grain: resGrain, ore: resOre } as Record<'lumber' | 'brick' | 'wool' | 'grain' | 'ore', string>,
  // 地形タイルのイラスト（ヘックスの塗りに使う・TileType に対応）
  tile: {
    forest: tileForest, field: tileField, pasture: tilePasture, hill: tileHill,
    mountain: tileMountain, desert: tileDesert, gold: tileGold, sea: tileSea,
  } as Record<'forest' | 'field' | 'pasture' | 'hill' | 'mountain' | 'desert' | 'gold' | 'sea', string>,
  commodity: { paper: comPaper, cloth: comCloth, coin: comCoin } as Record<'paper' | 'cloth' | 'coin', string>,
  // 改良建築: トラック → レベル(3/4) → 画像
  building: {
    trade: { 3: bldTradingHouse, 4: bldBank },
    politics: { 3: bldFortress, 4: bldCathedral },
    science: { 3: bldAqueduct, 4: bldTheater },
  } as Record<'trade' | 'politics' | 'science', Record<3 | 4, string>>,
  trackIcon: { trade: impTrade, politics: impPolitics, science: impScience } as Record<'trade' | 'politics' | 'science', string>,
  // アクション系アイコン（道/バンク交易/プレイヤー間交易）
  action: { road: roadIcon, bankTrade: bankTradeIcon, playerTrade: playerTradeIcon, knightActivate: knightActivateIcon, knightUpgrade: knightUpgradeIcon },
  cardBack: { trade: cardBackTrade, politics: cardBackPolitics, science: cardBackScience } as Record<'trade' | 'politics' | 'science', string>,
  politicsCard: {
    bishop: polBishop, diplomat: polDiplomat, intrigue: polIntrigue, deserter: polDeserter,
    warlord: polWarlord, spy: polSpy, saboteur: polSaboteur, wedding: polWedding, constitution: polConstitution,
  } as Record<string, string>,
  // 進歩カード25種の個別アート（エンジンの型スラッグ→画像）。政治9＋科学10＋商業6。
  // 表示側は ASSETS.progressCard[type] ?? ASSETS.cardBack[deck] で参照（未登録のみデッキ裏へ）。
  progressCard: {
    // 政治9
    bishop: polBishop, diplomat: polDiplomat, intrigue: polIntrigue, deserter: polDeserter,
    warlord: polWarlord, spy: polSpy, saboteur: polSaboteur, wedding: polWedding, constitution: polConstitution,
    // 科学10
    alchemist: sciAlchemist, crane: sciCrane, engineer: sciEngineer, inventor: sciInventor,
    irrigation: sciIrrigation, medicine: sciMedicine, mining: sciMining,
    road_building_progress: sciRoadBuilding, smith: sciSmith, printer: sciPrinter,
    // 商業6
    merchant: comMerchant, merchant_fleet: comMerchantFleet, master_merchant: comMasterMerchant,
    commercial_harbor: comCommercialHarbor, resource_monopoly: comResourceMonopoly, trade_monopoly: comTradeMonopoly,
  } as Record<string, string>,
  bg: { title: bgTitle, victory: bgVictory, barbarian: bgBarbarian },
  frame: frameDecorative,
} as const;

/** プレイヤー色の駒画像（盤面用）。色キーが不明なら赤にフォールバック。 */
export function houseImg(color: ColorKey): string { return HOUSE[color] ?? HOUSE.red; }
export function cityImg(color: ColorKey): string { return CITY[color] ?? CITY.red; }
export function metropolisImg(color: ColorKey): string { return METROPOLIS[color] ?? METROPOLIS.red; }
export function shipImg(color: ColorKey): string { return SHIP[color] ?? SHIP.red; }

/** トラック種別→トラック色（プレースホルダ/カード裏の色味）。 */
export const TRACK_COLOR: Record<'trade' | 'politics' | 'science', string> = {
  trade: '#d8a838', politics: '#3b6fd4', science: '#3f9e54',
};

/**
 * 欠損素材の代替: ラベル付きの色付きSVGを data-URI で返す。<img src> にそのまま使える。
 * 壊れ画像/404を絶対に出さないためのグレースフル・プレースホルダ。
 */
export function placeholder(label = '?', color = '#6b7280'): string {
  const safe = label.slice(0, 10).replace(/[<>&]/g, '');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'>` +
    `<rect width='128' height='128' rx='16' fill='${color}' opacity='0.85'/>` +
    `<rect x='4' y='4' width='120' height='120' rx='13' fill='none' stroke='rgba(255,255,255,0.5)' stroke-width='3'/>` +
    `<text x='64' y='70' font-size='20' font-family='sans-serif' font-weight='bold' fill='#fff' ` +
    `text-anchor='middle' dominant-baseline='middle'>${safe}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * <img> を生成。url が null/空ならプレースホルダ、読み込み失敗時(onerror)もプレースホルダへ。
 * これにより素材欠損でも UI が壊れない。
 */
export function assetImg(url: string | null | undefined, cls: string, alt = '', fallbackLabel = '?', color = '#6b7280'): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = alt;
  img.draggable = false;
  const ph = placeholder(fallbackLabel, color);
  img.src = url || ph;
  img.addEventListener('error', () => { if (img.src !== ph) img.src = ph; }, { once: true });
  return img;
}
