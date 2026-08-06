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
  // 交易と蛮族「Catan for Two（2人用）」
  'TB_NEUTRAL_ROAD', 'TB_NEUTRAL_SETTLEMENT', 'TB_FORCED_TRADE', 'TB_MOVE_ROBBER', 'TB_DISCARD_KNIGHT',
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

// ---- 接続の生存確認（keepalive）----
// ブラウザの WebSocket API は protocol レベルの ping を送れないため、アプリ層で往復させる。
// 目的は2つ:
//   1. 無通信のまま放置してモバイル回線/リバースプロキシにアイドル切断されるのを防ぐ。
//   2. 「TCPは生きているが実質死んでいる」半死接続をクライアント側が検知して自分から張り直す。
export const PING_INTERVAL_MS = 20_000;   // クライアントが ping を送る間隔
export const PONG_TIMEOUT_MS = 45_000;    // これだけサーバ無応答なら切断とみなす
export const SERVER_PING_INTERVAL_MS = 25_000; // サーバが protocol ping を打つ間隔

// ---- クライアント → サーバ ----
export type ClientMessage =
  | { t: 'create'; name: string }                       // ルーム作成（作成者がホスト）
  | { t: 'join';   code: string; name: string }         // ルーム参加
  | { t: 'rename'; name: string }                       // 名前変更（ロビー中）
  | { t: 'setCpu'; count: number }                       // CPU 人数設定（ホストのみ）
  | { t: 'setConfig'; cpuDifficulty?: AiDifficulty; orderMode?: LanOrderMode; scenario?: ScenarioId } // CPU強さ/手番順/盤面（ホストのみ）
  | { t: 'start' }                                       // ホストがゲーム開始
  | { t: 'resume'; code: string; you: PlayerId; token: string } // 再接続（同一プレイヤーとして復帰）
  | { t: 'restore'; code: string; you: PlayerId; token: string; sealed: string } // ルーム消失後の復元（封印スナップショット提示）
  | { t: 'ping' }                                        // 生存確認（サーバは pong を返す）
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
  // 復元用の封印スナップショット。サーバが暗号化した正本 state で、クライアントは中身を
  // 読めない（＝手札は漏れない・改竄できない）。各端末が localStorage に預かり、
  // サーバ再起動でルームが消えたときに restore で差し戻して対局を復元する。
  | { t: 'snapshot'; code: string; sealed: string; turn: number }
  // resume したがサーバにそのルームが無い（再起動・スリープ明け等）。
  // 端末が封印スナップショットを持っているなら restore を送ってほしい、という誘導。
  | { t: 'restorable'; code: string }
  // サーバが計画的に停止する（デプロイ等）。すぐ復帰するので再接続して、という予告。
  | { t: 'bye'; reason: string }
  | { t: 'pong' }                                                     // ping への応答
  | { t: 'error';   message: string; fatal?: boolean };               // fatal=true で接続断などの致命的エラー
