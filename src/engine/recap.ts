// ============================================================
// src/engine/recap.ts — 終了後のプレイスタイル講評（公開情報のみ）
// ============================================================
//
// ゲーム終了後、各プレイヤーへ「どんなプレイだったか」の短いコメントを付ける。
// 使う統計は最終 GameState から導出できる公開情報のみ：
//   - 開拓地数 / 都市数 / 盤面上の道の本数 / 最長道路長
//   - 最長交易路・最大騎士力の保持 / 騎士使用回数 / 公開VP
// 手札の内訳・VPカードの中身などの秘匿情報は一切参照しない。
// よって LAN のマスク済み state でも（自分・勝者以外でも）同じ結果になり、
// 秘匿を保ったまま全員へ表示できる。
//
// コメントは定型文ベース。判断材料が乏しいときは無難な「バランス型」に寄せ、
// 事実（公開統計）に基づく表現だけを使う（怪しい断定はしない）。

import type { GameState, PlayerId } from '../types';
import { calcLongestRoad, calcPublicVP } from './scoring';

export interface PlayerRecap {
  settlements: number;
  cities: number;        // 都市の総数（メトロポリス含む）
  metropolises: number;  // 騎士と商人: メトロポリス数（各+2点）
  defenderVP: number;    // 騎士と商人: 蛮族撃退の守護者VP
  hasMerchant: boolean;  // 騎士と商人: 商人コマを保持中か（+1点・公開）
  progressVP: number;    // 騎士と商人: 進歩カードの永久勝利点（印刷/立憲、各+1点・公開）
  islandBonus: number;   // 航海者: 新しい島への入植件数（各+2点）
  isCk: boolean;         // 騎士と商人モードか（講評・内訳の出し分け用）
  roads: number;
  longestRoad: number;
  hasLongestRoad: boolean;
  knights: number;
  hasLargestArmy: boolean;
  publicVP: number;
  isWinner: boolean;
  comment: string;
}

type RecapStats = Omit<PlayerRecap, 'comment'>;

/** 最終 state（公開情報）から1プレイヤーの統計＋講評コメントを作る。 */
export function buildPlayerRecap(state: GameState, pid: PlayerId): PlayerRecap {
  let settlements = 0, cities = 0, metropolises = 0;
  for (const v of Object.values(state.vertices)) {
    if (v.building?.playerId !== pid) continue;
    if (v.building.type === 'city') { cities++; if (v.building.metropolis) metropolises++; } else settlements++;
  }
  let roads = 0;
  for (const e of Object.values(state.edges)) {
    if (e.road?.playerId === pid) roads++;
  }
  const islandBonus = Object.values(state.islandBonus ?? {}).flat().filter(owner => owner === pid).length;
  const p = state.players[pid];
  const stats: RecapStats = {
    settlements,
    cities,
    metropolises,
    defenderVP: p?.defenderVP ?? 0,
    hasMerchant: state.merchant?.playerId === pid,
    progressVP: p?.progressVP ?? 0,
    islandBonus,
    isCk: state.expansion === 'cities_knights',
    roads,
    longestRoad: calcLongestRoad(state, pid),
    hasLongestRoad: p?.hasLongestRoad ?? false,
    knights: p?.knightsPlayed ?? 0,
    hasLargestArmy: p?.hasLargestArmy ?? false,
    publicVP: calcPublicVP(state, pid),
    isWinner: state.winner === pid,
  };
  return { ...stats, comment: styleComment(stats) };
}

/**
 * 公開統計から短い講評を選ぶ（定型文）。特徴の強い順に評価し、
 * 該当が無ければ無難な「バランス型」に寄せる。すべて公開情報に基づく。
 */
function styleComment(r: RecapStats): string {
  const win = r.isWinner;
  // 騎士と商人は「メトロポリス/守護(蛮族防衛)/都市発展」軸で講評する（最大騎士力は無いため使わない）。
  if (r.isCk) {
    if (r.metropolises >= 2) return win ? 'メトロポリスを複数築いた発展型の勝利' : 'メトロポリスを狙った発展型';
    if (r.metropolises >= 1) return win ? '都市を発展させメトロポリスで競り勝った発展型の勝利' : 'メトロポリスを築いた発展型';
    if (r.defenderVP >= 2) return win ? '蛮族を退け続けた守護型の勝利' : '騎士で防衛を支えた守護型';
    if (r.cities >= 3) return win ? '都市化を進め生産で押し切った開発型の勝利' : '都市化を急いだ生産重視型';
    if (r.hasLongestRoad || r.roads >= 9) return win ? '道を伸ばし切った開拓者の勝利' : '道を広く伸ばした開拓者型';
    if (r.settlements >= 4) return win ? '街を広げて押し切った拡張型の勝利' : '開拓地を広げた拡張型';
    if (!win && r.publicVP <= 5) return '蛮族と発展に苦しんだが粘り強く対応';
    return win ? 'バランスよくまとめた発展型の勝利' : 'バランス型のプレイ';
  }
  // 称号は強い特徴なので最優先。
  if (r.hasLongestRoad && r.hasLargestArmy) {
    return win ? '道も騎士も制した万能型の勝利' : '道と騎士の両面で攻めた万能型';
  }
  if (r.hasLargestArmy || r.knights >= 3) {
    return win ? '騎士を率いて盤面を動かした軍事型の勝利' : '騎士を多用した軍事・妨害型';
  }
  if (r.hasLongestRoad || r.roads >= 9) {
    return win ? '道を伸ばし切った開拓者の勝利' : '道を広く伸ばした開拓者タイプ';
  }
  if (r.cities >= 3) {
    return win ? '都市化を進め生産力で押し切った開発型' : '都市化を急いだ生産重視タイプ';
  }
  if (r.cities >= 1 && r.settlements >= 3) {
    return win ? 'バランスよく街を広げて競り勝った安定型' : 'バランスよく街を広げた安定型';
  }
  if (r.settlements >= 4) {
    return win ? '開拓地を広げて押し切った拡張型' : '開拓地を多く広げた拡張型';
  }
  if (!win && r.publicVP <= 4) {
    return '序盤の展開に苦しんだが粘り強く対応';
  }
  return win ? '効率よくまとめた堅実な勝利' : 'バランス型のプレイ';
}
