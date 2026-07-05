// ============================================================
// src/net/protocol.ts — LAN対戦 WebSocket メッセージ型（クライアント/サーバ共有）
// ============================================================
//
// サーバ権威モデル:
//   - 正本 state はサーバが保持し、純粋エンジン applyAction で更新する。
//   - クライアントは操作 Action を送るだけ（MVP3 以降）。
//   - サーバは送信者が正しい actor か検証し、適用後、各クライアントへ
//     視点別マスク済み state を配信する。
//
// MVP 1-2 で実際に使うのは create/join/start（C→S）と
// joined/lobby/started/error（S→C）。action / state は MVP3 以降で使う。

import type { GameState, PlayerId, PlayerColor, Action, AiDifficulty } from '../types';
import type { ScenarioId } from '../engine/scenarios';

// WebSocket のパス（Vite dev サーバと同一オリジン上に同居）
export const LAN_WS_PATH = '/lan';

// LAN対戦で同期する Action 種別の「単一の真実」。
// クライアントの送信フィルタ(LAN_CLIENT_ALLOWED)とサーバの受理ホワイトリスト(LAN_ALLOWED_ACTIONS)は
// 必ずこの配列から生成する。二重管理でズレると「ボタンを押しても無反応」になるため一元化する。
// 新しい操作（拡張含む）は必ずここへ追加すること。
export const LAN_SYNCED_ACTIONS: ReadonlyArray<Action['type']> = [
  // 基本＋航海者
  'ROLL_DICE', 'BUILD_ROAD', 'BUILD_SHIP', 'MOVE_SHIP', 'BUILD_SETTLEMENT', 'BUILD_CITY',
  'BUY_DEV_CARD', 'END_TURN', 'DECLARE_VICTORY',
  'MOVE_ROBBER', 'MOVE_PIRATE', 'DISCARD_RESOURCES', 'CHOOSE_GOLD', 'DOWNGRADE_CITY', 'DISCARD_PROGRESS',
  'OFFER_TRADE', 'RESPOND_TRADE', 'CONFIRM_TRADE', 'CANCEL_TRADE', 'BANK_TRADE',
  'PLAY_KNIGHT', 'PLAY_ROAD_BUILDING', 'PLAY_YEAR_OF_PLENTY', 'PLAY_MONOPOLY', 'FINISH_ROAD_BUILDING',
  // 騎士と商人
  'BUILD_IMPROVEMENT', 'BUILD_KNIGHT', 'ACTIVATE_KNIGHT', 'UPGRADE_KNIGHT',
  'BUILD_CITY_WALL', 'MOVE_KNIGHT', 'CHASE_ROBBER', 'PLAY_PROGRESS',
  // 交易と蛮族「イベントカード」
  'CHOOSE_EVENT_GIVE', 'CHOOSE_EVENT_HELPFUL', 'CHOOSE_EVENT_STEAL', 'CHOOSE_EVENT_DAMAGE', 'REPAIR_ROAD',
];

// LAN の手番順モード（ホストが設定）。random=毎回シャッフル / joined=入室順。
export type LanOrderMode = 'random' | 'joined';

// ロビーに表示する参加者1人分の公開情報
export interface LobbyPlayer {
  readonly id: PlayerId;          // 割り当てられたスロット（player1..4）
  readonly name: string;
  readonly color: PlayerColor;
  readonly isHost: boolean;
  readonly connected: boolean;
  readonly isCpu: boolean;        // CPU プレイヤーか（混合対戦用）
}

// ---- クライアント → サーバ ----
export type ClientMessage =
  | { t: 'create'; name: string }                       // ルーム作成（作成者がホスト）
  | { t: 'join';   code: string; name: string }         // ルーム参加
  | { t: 'rename'; name: string }                       // 名前変更（ロビー中）
  | { t: 'setCpu'; count: number }                       // CPU 人数設定（ホストのみ）
  | { t: 'setConfig'; cpuDifficulty?: AiDifficulty; orderMode?: LanOrderMode; scenario?: ScenarioId } // CPU強さ/手番順/盤面（ホストのみ）
  | { t: 'start' }                                       // ホストがゲーム開始
  | { t: 'resume'; code: string; you: PlayerId; token: string } // 再接続（同一プレイヤーとして復帰）
  | { t: 'action'; action: Action };                     // 操作（MVP3 以降）

// ---- サーバ → クライアント ----
export type ServerMessage =
  // token = 再接続用の秘密トークン（localStorage に保存して resume 時に提示）
  | { t: 'joined'; code: string; you: PlayerId; isHost: boolean; token: string; started: boolean }
  | { t: 'lobby';  code: string; hostUrls: string[]; players: LobbyPlayer[];
      canStart: boolean; cpuCount: number; maxCpu: number;          // maxCpu=今追加できるCPU上限
      cpuDifficulty: AiDifficulty; orderMode: LanOrderMode; scenario: ScenarioId } // ホスト設定（参加者は表示のみ）
  | { t: 'started'; you: PlayerId; state: GameState }               // 開始（state はマスク済み）
  | { t: 'state';   state: GameState; action?: Action; by?: PlayerId } // 状態更新（MVP3 以降）
  | { t: 'error';   message: string; fatal?: boolean };               // fatal=true で接続断などの致命的エラー
