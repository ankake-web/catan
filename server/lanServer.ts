// ============================================================
// server/lanServer.ts — LAN対戦 WebSocket サーバ（サーバ権威）
// ============================================================
//
// Vite dev サーバの HTTP サーバに相乗りし、パス /lan の WebSocket だけを処理する
// （Vite 自身の HMR WebSocket と衝突しないよう noServer + パス判定）。
//
// 役割:
//   - ルーム作成 / 参加 / 参加者一覧の同期（ロビー）
//   - ホストのゲーム開始 → 純粋エンジンで初期 state を生成
//   - 各クライアントへ「視点別マスク済み」state を配信
//
// MVP 1-2 範囲: ロビー＋開始＋同一盤面＋playerId 割当＋秘匿マスク。
// 操作 Action の同期（applyAction 適用・配信）は MVP3 以降で本ファイルに追加する。
//
// 注意: このファイルは src 外なので tsc の型チェックゲート対象外。
//        dev 起動時のみ Vite プラグインから動的 import される。

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Server } from 'node:http';
import os from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { createInitialGameState } from '../src/engine/createState';
import { maskStateFor } from '../src/engine/mask';
import { applyAction } from '../src/engine/game';
import { discardCount } from '../src/engine/robber';
import { buildActionLog, MAX_LOG_ENTRIES } from '../src/engine/log';
import { nextCpuAction, cpuFallbackAction } from '../src/engine/lanCpu';
import { generateRandomPlayerName, resolveUniqueName, pickCpuName } from '../src/net/names';
import { RESOURCE_TYPES, COMMODITY_TYPES } from '../src/constants';
import { LAN_WS_PATH, LAN_SYNCED_ACTIONS } from '../src/net/protocol';
import type { ClientMessage, ServerMessage, LobbyPlayer, LanOrderMode } from '../src/net/protocol';
import type { PlayerId, PlayerColor, PlayerType, GameState, Action, LogEntry, AiDifficulty } from '../src/types';
import type { PlayerSpec } from '../src/engine/createState';
import type { ScenarioId } from '../src/engine/scenarios';
import { listScenarios } from '../src/engine/scenarios';

// 受理する盤面シナリオID（レジストリ由来＝追加シナリオも自動で許可）。
const KNOWN_SCENARIO_IDS = new Set<ScenarioId>(listScenarios().map(s => s.id));
import type { PlayerOrderMode } from '../src/engine/setup';

// LAN 同期する Action（サーバ側ホワイトリスト）。
// MVP4 で交易・捨て札・盗賊・発展カード使用・勝利まで全主要操作を許可する。
// サーバ受理ホワイトリスト。クライアント送信フィルタと同じ単一の真実(LAN_SYNCED_ACTIONS)から生成。
export const LAN_ALLOWED_ACTIONS = new Set<Action['type']>(LAN_SYNCED_ACTIONS);

// 捨て札 Action の正当性検証（サーバ正本でのみ判定。資源＋商品＝騎士と商人）。
// 「ちょうど required 枚」「各資源/商品が所持範囲内」を満たすときのみ true。
export function isValidDiscard(state: GameState, action: Extract<Action, { type: 'DISCARD_RESOURCES' }>): boolean {
  const p = state.players[action.playerId];
  if (!p) return false;
  const required = discardCount(state, action.playerId);
  const res = (action.resources ?? {}) as Partial<Record<typeof RESOURCE_TYPES[number], number>>;
  const com = (action.commodities ?? {}) as Partial<Record<typeof COMMODITY_TYPES[number], number>>;
  const discardSum =
    RESOURCE_TYPES.reduce((s, r) => s + (res[r] ?? 0), 0) +
    COMMODITY_TYPES.reduce((s, c) => s + (com[c] ?? 0), 0);
  const resWithin = RESOURCE_TYPES.every(r => (res[r] ?? 0) >= 0 && (res[r] ?? 0) <= p.hand[r]);
  const comWithin = COMMODITY_TYPES.every(c => (com[c] ?? 0) >= 0 && (com[c] ?? 0) <= (p.commodities?.[c] ?? 0));
  return required !== 0 && discardSum === required && resWithin && comWithin;
}

// その Action を実行してよいプレイヤー（actor）。送信者の id と一致せねば拒否。
export function requiredActor(state: GameState, action: Action): PlayerId | null {
  switch (action.type) {
    case 'DISCARD_RESOURCES': return action.playerId;
    case 'CHOOSE_GOLD':       return action.playerId;
    case 'DOWNGRADE_CITY':    return action.playerId;
    case 'DISCARD_PROGRESS':  return action.playerId;
    case 'RESPOND_TRADE':     return action.response.playerId;
    // 交易と蛮族「イベントカード」: 多人数解決は action.playerId、強奪は保留中の奪う側本人のみ。
    case 'CHOOSE_EVENT_GIVE':    return action.playerId;
    case 'CHOOSE_EVENT_HELPFUL': return action.playerId;
    case 'CHOOSE_EVENT_DAMAGE':  return action.playerId;
    case 'CHOOSE_EVENT_STEAL':   return state.tbPendingEventSteal?.playerId ?? null;
    default:                  return state.playerOrder[state.currentPlayerIndex] ?? null;
  }
}

const PLAYER_IDS: PlayerId[] = ['player1', 'player2', 'player3', 'player4'];
const PLAYER_COLORS: PlayerColor[] = ['red', 'blue', 'purple', 'orange'];
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;

// CPU の一手ごとのディレイ(ms)。人間が何が起きたか追えるよう待つ。
// ダイス後は出目演出が見えるよう長めにする。
const CPU_STEP_MS = 850;
const CPU_AFTER_ROLL_MS = 1700;

// 切断したメンバーを保持して再接続を待つ猶予(ms)。これを過ぎたら解放する。
const DISCONNECT_GRACE_MS = 90_000;

// タイミング設定（テストで短縮値を注入できるようにする。未指定なら上記の本番既定値）。
export interface LanServerOptions {
  graceMs?: number;
  cpuStepMs?: number;
  cpuAfterRollMs?: number;
  // 接続を受理する Origin の許可リスト（本番=スタンドアロン起動で指定）。
  // 未指定なら Origin 検証を行わない（dev で Vite に相乗りする場合の従来挙動）。
  allowedOrigins?: string[];
}

// 接続元 Origin が許可リストに含まれるか判定する（WebSocket upgrade 前の門番）。
// Origin ヘッダが無い接続（非ブラウザ＝テスト/CLI。ws ライブラリの既定）は素通しする。
// 許可リストに '*' を含めれば全オリジンを許可する。
export function isOriginAllowed(origin: string | undefined, allowlist: string[]): boolean {
  if (!origin) return true;
  if (allowlist.includes('*')) return true;
  return allowlist.includes(origin);
}

interface Member {
  ws: WebSocket | null;       // 切断中は null
  id: PlayerId;
  name: string;
  isHost: boolean;
  connected: boolean;
  token: string;              // 再接続用の秘密トークン
  graceTimer: ReturnType<typeof setTimeout> | null; // 切断後の解放タイマー
}

interface Room {
  code: string;
  members: Member[];          // 人間プレイヤー（socketを持つ）。CPUは含まない。
  started: boolean;
  state: GameState | null;
  cpuCount: number;           // CPU 人数（0..3、ホストが設定）
  cpuTimer: ReturnType<typeof setTimeout> | null; // サーバ側CPU駆動タイマー
  // CPU のランダム3文字名。ルームで一度決めたら固定（再接続・人数変更でも維持）。
  cpuNames: string[];
  cpuDifficulty: AiDifficulty;  // ホスト設定のCPU強さ（弱い/普通/強い）
  orderMode: LanOrderMode;      // ホスト設定の手番順（ランダム/入室順）
  scenario: ScenarioId;         // ホスト設定の盤面（基本/航海者/群島）
  // 視点別ログ（playerId → ログ配列）。各端末に「自分視点」のログを配信するため。
  memberLogs: Record<string, LogEntry[]>;
  // タイミング（attachLanServer のオプションから設定。テストでは短縮値を注入）。
  graceMs: number;
  cpuStepMs: number;
  cpuAfterRollMs: number;
}

const rooms = new Map<string, Room>();

// テスト専用: 全ルームの保留タイマー(CPU駆動・切断猶予)を止めて Map を空にする。
// 統合テスト間でタイマーやルームが残留しないようにするための後始末フック。
export function __resetRoomsForTest(): void {
  for (const room of rooms.values()) {
    if (room.cpuTimer) { clearTimeout(room.cpuTimer); room.cpuTimer = null; }
    for (const m of room.members) {
      if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; }
    }
  }
  rooms.clear();
}

function send(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// 再接続トークンは「同一プレイヤーとして復帰＝相手の手札も見える」認証情報なので、
// 推測可能だとセッション乗っ取り（秘匿漏洩）につながる。CSPRNG で生成する。
function genToken(): string {
  return randomBytes(32).toString('base64url');
}

// ルームコード: スマホのテンキーで入力しやすい数字4桁。
// - 終始“文字列”として扱い（Number()/parseInt を挟まない）先頭ゼロを保持する。
// - 各桁は CSPRNG(randomInt) で引く（Math.random は予測可能なため使わない）。
// - 既存アクティブルームと衝突したら引き直す。上限到達でエラー（無限ループ/枯渇防止）。
// 注: 4桁=1万通りと鍵空間は狭い。総当たり参加は接続単位の試行制限（下記）と
//     ルームが一時的・即時破棄される性質で緩和する設計。
const CODE_DIGITS = '0123456789';
const CODE_LEN = 4;
const CODE_MAX_ATTEMPTS = 200;
export function genCode(isTaken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_DIGITS[randomInt(CODE_DIGITS.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error('ルームコードの生成に失敗しました（空きコード枯渇）');
}

// 空いている最小スロット（player1..4）を返す。満員なら null。
function nextSlot(room: Room): PlayerId | null {
  const used = new Set(room.members.map(m => m.id));
  for (const id of PLAYER_IDS) {
    if (!used.has(id)) return id;
  }
  return null;
}

function colorFor(id: PlayerId): PlayerColor {
  return PLAYER_COLORS[PLAYER_IDS.indexOf(id)] ?? 'red';
}

const connectedHumans = (room: Room): number => room.members.filter(m => m.connected).length;

// ゲーム中に Player.type を切り替える（切断→AI が代行 / 再接続→人間へ復帰）。
// room.state を不変更新する。AI 化時の難易度はルームの CPU 設定に合わせる。
function convertPlayerType(room: Room, pid: PlayerId, type: PlayerType): void {
  if (!room.state) return;
  const p = room.state.players[pid];
  if (!p || p.type === type) return;
  const updated = type === 'ai' ? { ...p, type, aiDifficulty: room.cpuDifficulty } : { ...p, type };
  room.state = { ...room.state, players: { ...room.state.players, [pid]: updated } };
}

// CPU に割り当てる空きスロット（人間が使っていない player1..4 の先頭から cpuCount 個）。
function cpuSlots(room: Room): PlayerId[] {
  const used = new Set(room.members.map(m => m.id));
  return PLAYER_IDS.filter(id => !used.has(id)).slice(0, room.cpuCount);
}

// 人間＋CPU が 4 を超えないよう CPU 人数をクランプする。
function clampCpu(room: Room): void {
  const maxCpu = Math.max(0, MAX_PLAYERS - room.members.length);
  room.cpuCount = Math.min(Math.max(0, room.cpuCount), maxCpu);
}

// CPU 名をルーム単位で固定割り当て（不足分のみ追加。人間名・既存CPU名と重複回避）。
// 一度決めた名前は room.cpuNames に残るので、人数変更・再接続後も同じ名前を維持する。
function cpuNamesFor(room: Room, count: number): string[] {
  const humanNames = room.members.map(m => m.name);
  while (room.cpuNames.length < count) {
    room.cpuNames.push(pickCpuName([...humanNames, ...room.cpuNames]));
  }
  return room.cpuNames.slice(0, count);
}

function lobbyPlayers(room: Room): LobbyPlayer[] {
  const humans: LobbyPlayer[] = [...room.members]
    .sort((a, b) => PLAYER_IDS.indexOf(a.id) - PLAYER_IDS.indexOf(b.id))
    .map(m => ({ id: m.id, name: m.name, color: colorFor(m.id), isHost: m.isHost, connected: m.connected, isCpu: false }));
  const cpuNames = cpuNamesFor(room, cpuSlots(room).length);
  const cpus: LobbyPlayer[] = cpuSlots(room).map((id, i) => ({
    id, name: cpuNames[i] ?? `CPU${i + 1}`, color: colorFor(id), isHost: false, connected: true, isCpu: true,
  }));
  return [...humans, ...cpus];
}

function lanHostUrls(port: number): string[] {
  const urls: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}/`);
      }
    }
  }
  return urls;
}

function broadcastLobby(room: Room, urls: string[]): void {
  clampCpu(room);
  const humans = connectedHumans(room);
  const total = humans + room.cpuCount;
  const msg: ServerMessage = {
    t: 'lobby',
    code: room.code,
    hostUrls: urls,
    players: lobbyPlayers(room),
    // 人間が1人以上、合計2〜4人なら開始可（CPUだけの対戦は不可）
    canStart: humans >= 1 && total >= MIN_PLAYERS && total <= MAX_PLAYERS,
    cpuCount: room.cpuCount,
    maxCpu: Math.max(0, MAX_PLAYERS - humans),
    cpuDifficulty: room.cpuDifficulty,
    orderMode: room.orderMode,
    scenario: room.scenario,
  };
  for (const m of room.members) send(m.ws, msg);
}

// 更新後の正本 state を、各メンバーへ視点別マスク＋視点別ログで配信する。
// ログは buildActionLog を「その視点(m.id)」で生成するため、自分の獲得内訳や
// 「あなた」表記が各端末で正しくなり、他人の資源獲得内訳も漏れない。
// 配信するアクションを視点別に秘匿する。捨て札・金タイル選択の「資源の種類」は本人以外には
// 秘匿（枚数のみログで公開）。生 action をそのまま配ると DevTools で相手の捨て/金の内訳が漏れる。
// 盗み/獲得アニメは各端末でマスク済み state の差分から導出するため、resources を消しても支障なし。
export function redactActionFor(action: Action, viewerId: PlayerId, byPid: PlayerId): Action {
  if (viewerId === byPid) return action; // 本人は自分の内訳を見てよい
  if (action.type === 'DISCARD_RESOURCES') {
    // 種類を秘匿（枚数は視点別ログが count で持つ）。騎士と商人の商品内訳も隠す。
    return { ...action, resources: {}, commodities: {} };
  }
  if (action.type === 'CHOOSE_GOLD') {
    return { ...action, resources: {} };
  }
  // 錬金術師: 指定した次のダイス目は秘匿情報（相手に先読みさせない）。choice.dice を隠す。
  if (action.type === 'PLAY_PROGRESS' && action.choice?.dice) {
    const { dice: _dice, ...restChoice } = action.choice;
    return { ...action, choice: restChoice };
  }
  return action;
}

function broadcastState(room: Room, prev: GameState, action: Action, byPid: PlayerId): void {
  if (!room.state) return;
  for (const m of room.members) {
    // ログは切断中でも蓄積する（送信だけスキップ）。これで再接続時に
    // 切断中のCPU代行手番もログに反映され、盤面と齟齬しない。
    // ※ ログは正本 action（resources 込み）から生成するが、log.ts が種類を出さないので安全。
    const entries = buildActionLog(prev, action, room.state, m.id);
    const log = [...(room.memberLogs[m.id] ?? []), ...entries].slice(-MAX_LOG_ENTRIES);
    room.memberLogs[m.id] = log;
    if (!m.connected) continue;
    send(m.ws, { t: 'state', state: { ...maskStateFor(room.state, m.id), log }, action: redactActionFor(action, m.id, byPid), by: byPid });
  }
}

function startGame(room: Room): void {
  clampCpu(room);
  const ordered = [...room.members].sort((a, b) => PLAYER_IDS.indexOf(a.id) - PLAYER_IDS.indexOf(b.id));
  const humanSpecs: PlayerSpec[] = ordered.map(m => ({
    id: m.id,
    name: m.name,
    color: colorFor(m.id),
    type: 'human' as const,
  }));
  // CPU は空きスロットへ割り当て（type:'ai'）。難易度はホスト設定、名前はルーム固定のランダム3文字名。
  const cpuNames = cpuNamesFor(room, cpuSlots(room).length);
  const cpuSpecs: PlayerSpec[] = cpuSlots(room).map((id, i) => ({
    id,
    name: cpuNames[i] ?? `CPU${i + 1}`,
    color: colorFor(id),
    type: 'ai' as const,
    aiDifficulty: room.cpuDifficulty,
  }));
  // 手番順はホスト設定。joined=入室順(spec順をそのまま固定) / random=シャッフル。
  // 乱数（ダイス/山札/盤面/CPU判断）はすべてサーバ側。
  const allSpecs = [...humanSpecs, ...cpuSpecs];
  const orderMode: PlayerOrderMode = room.orderMode === 'joined' ? 'fixed' : 'random';
  const orderSpec = room.orderMode === 'joined' ? allSpecs.map(s => s.id) : undefined;
  const state = createInitialGameState(allSpecs, orderMode, orderSpec, undefined, room.scenario);
  room.started = true;
  room.state = state;
  room.memberLogs = {};
  for (const m of room.members) {
    room.memberLogs[m.id] = [];
    send(m.ws, { t: 'started', you: m.id, state: maskStateFor(state, m.id) });
  }
  // 開始直後の手番が CPU の場合に備えて CPU 駆動を起動。
  scheduleCpuTick(room, room.cpuStepMs);
}

// ============================================================
// サーバ側 CPU 駆動（混合対戦）
// ============================================================

// CPU 駆動の観測用カウンタ（テスト/手順での追跡用。秘匿情報は含めない）。
export const cpuDriveStats = { steps: 0, fallbacks: 0 };

// CPU が動く必要があれば、delay 後に一手だけ適用して配信し、再スケジュールする。
// 人間の手番・人間の入力待ち・GAME_OVER になれば停止する。
function scheduleCpuTick(room: Room, delay: number): void {
  if (room.cpuTimer) { clearTimeout(room.cpuTimer); room.cpuTimer = null; }
  if (!room.started || !room.state || room.state.phase === 'GAME_OVER') return;
  if (!nextCpuAction(room.state)) return; // 今は CPU が動く場面ではない
  room.cpuTimer = setTimeout(() => {
    room.cpuTimer = null;
    if (!room.started || !room.state || room.state.phase === 'GAME_OVER') return;
    const step = nextCpuAction(room.state, Math.random);
    if (!step) return; // 人間の番になった等
    const applied = applyCpuStep(room, step.pid, step.action);
    if (!applied) return; // 適用できず（極めて稀）。人間操作/再接続を待つ。
    // 次の CPU 手番へ。ダイス後は演出ぶん長めに待つ。
    const nextDelay = applied === 'ROLL_DICE' ? room.cpuAfterRollMs : room.cpuStepMs;
    scheduleCpuTick(room, nextDelay);
  }, delay);
}

// CPU の一手を適用して配信する。失敗時はフェーズ別の安全行動でフォールバックし、
// それでも失敗したら（極めて稀）進行を止めずに停止する。
// 返り値: 適用できた Action の type（再スケジュール判定用）/ 失敗なら null。
function applyCpuStep(room: Room, pid: PlayerId, action: Action): Action['type'] | null {
  if (!room.state) return null;
  try {
    const prev = room.state;
    const next = applyAction(prev, action, Math.random);
    room.state = next;
    cpuDriveStats.steps++;
    broadcastState(room, prev, action, pid);
    return action.type;
  } catch (err) {
    // 本来成功すべき CPU Action が失敗した。秘匿情報は出さず type と理由のみ記録する。
    cpuDriveStats.fallbacks++;
    console.warn(`[LAN-CPU] action ${action.type} by ${pid} failed; falling back. reason: ${(err as Error)?.message ?? 'unknown'}`);
    try {
      const prev = room.state;
      const cur = prev.playerOrder[prev.currentPlayerIndex];
      // フォールバックの actor: 捨て札/金選択/交易応答/T&Bイベント選択は対象本人、それ以外は手番者。
      const fbActor = (action.type === 'DISCARD_RESOURCES' || action.type === 'CHOOSE_GOLD' || action.type === 'RESPOND_TRADE'
        || action.type === 'CHOOSE_EVENT_GIVE' || action.type === 'CHOOSE_EVENT_HELPFUL'
        || action.type === 'CHOOSE_EVENT_STEAL' || action.type === 'CHOOSE_EVENT_DAMAGE') ? pid : (cur ?? pid);
      const fb = cpuFallbackAction(prev, fbActor as PlayerId);
      const next = applyAction(prev, fb, Math.random);
      room.state = next;
      broadcastState(room, prev, fb, fbActor as PlayerId);
      return fb.type;
    } catch (err2) {
      console.warn(`[LAN-CPU] fallback also failed: ${(err2 as Error)?.message ?? 'unknown'}`);
      return null;
    }
  }
}

/**
 * Vite dev サーバの HTTP サーバへ LAN WebSocket を相乗りさせる。
 * @param httpServer    Vite の Node HTTP サーバ
 * @param fallbackPort  address() が取れない場合のポート（既定 5173）
 */
export function attachLanServer(httpServer: Server, fallbackPort = 5173, opts: LanServerOptions = {}): void {
  // perMessageDeflate: state ブロードキャストの73%は開始後不変の盤面ジオメトリ（約26KB/通）で、
  // 反復的な JSON は deflate で概ね 1/5〜1/10 に縮む。モバイル回線でのオンライン対戦の帯域と
  // 受信遅延を大きく削減する（プロトコル・クライアント変更は不要）。
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  // タイミング設定（テストでは短縮値を注入。未指定なら本番既定値）。
  const graceMs = opts.graceMs ?? DISCONNECT_GRACE_MS;
  const cpuStepMs = opts.cpuStepMs ?? CPU_STEP_MS;
  const cpuAfterRollMs = opts.cpuAfterRollMs ?? CPU_AFTER_ROLL_MS;
  const allowedOrigins = opts.allowedOrigins; // 未指定なら Origin 検証なし（dev 相乗り）。

  // ホスト URL 表示用に、実際に listen しているポートを動的取得する。
  const currentUrls = (): string[] => {
    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' && addr.port ? addr.port : fallbackPort;
    return lanHostUrls(port);
  };

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* noop */ }
    // /lan 以外（Vite HMR 等）は触らない＝他のリスナに委ねる
    if (pathname !== LAN_WS_PATH) return;
    // Origin 検証（許可リスト指定時のみ）。許可外は 403 でソケットを閉じる。
    if (allowedOrigins && !isOriginAllowed(req.headers.origin, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let me: Member | null = null;
    // ルームコード総当たり対策: この接続で「存在しないコードへの join」が
    // 続いたら接続を切る。1接続あたりの試行を絞り、4桁(1万通り)の全探索を非現実的にする。
    // 正本(connected room)に入れば 0 に戻す。誤入力数回では切らない緩めの上限。
    let badJoinAttempts = 0;
    const MAX_BAD_JOINS = 12;

    ws.on('message', (data: unknown) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(data)); } catch { return; }

      switch (msg.t) {
        case 'create': {
          if (room) return;
          let code: string;
          try { code = genCode(c => rooms.has(c)); }
          catch { send(ws, { t: 'error', message: 'ルームを作成できませんでした。時間をおいて再度お試しください' }); return; }
          room = { code, members: [], started: false, state: null, cpuCount: 0, cpuTimer: null, cpuNames: [], cpuDifficulty: 'strong', orderMode: 'random', scenario: 'classic', memberLogs: {}, graceMs, cpuStepMs, cpuAfterRollMs };
          rooms.set(code, room);
          me = { ws, id: 'player1', name: assignName(msg.name, room), isHost: true, connected: true, token: genToken(), graceTimer: null };
          room.members.push(me);
          send(ws, { t: 'joined', code, you: me.id, isHost: true, token: me.token, started: false });
          broadcastLobby(room, currentUrls());
          break;
        }
        case 'join': {
          if (room) return;
          const target = rooms.get((msg.code || '').toUpperCase());
          if (!target) {
            if (++badJoinAttempts >= MAX_BAD_JOINS) {
              send(ws, { t: 'error', message: '試行回数が多すぎます。しばらくしてから入り直してください', fatal: true });
              try { ws.close(); } catch { /* noop */ }
              return;
            }
            send(ws, { t: 'error', message: 'ルームが見つかりません' });
            return;
          }
          badJoinAttempts = 0;
          if (target.started) { send(ws, { t: 'error', message: 'このルームは既に開始済みです' }); return; }
          const slot = nextSlot(target);
          if (!slot) { send(ws, { t: 'error', message: 'ルームが満員です（最大4人）' }); return; }
          room = target;
          me = { ws, id: slot, name: assignName(msg.name, target), isHost: false, connected: true, token: genToken(), graceTimer: null };
          room.members.push(me);
          send(ws, { t: 'joined', code: room.code, you: me.id, isHost: false, token: me.token, started: false });
          broadcastLobby(room, currentUrls());
          break;
        }
        case 'resume': {
          // 再接続: 同一プレイヤー(token一致)として復帰する。新規プレイヤーは増やさない。
          if (room) return;
          const target = rooms.get((msg.code || '').toUpperCase());
          if (!target) { send(ws, { t: 'error', message: '接続が切れました。ルームに入り直してください', fatal: true }); return; }
          const member = target.members.find(m => m.id === msg.you && m.token === msg.token);
          if (!member) { send(ws, { t: 'error', message: '接続が切れました。ルームに入り直してください', fatal: true }); return; }
          // 二重接続: 古い接続があれば無効化（新しい接続を正とする）。
          if (member.ws && member.ws !== ws) { try { member.ws.close(); } catch { /* noop */ } }
          if (member.graceTimer) { clearTimeout(member.graceTimer); member.graceTimer = null; }
          member.ws = ws;
          member.connected = true;
          room = target;
          me = member;
          send(ws, { t: 'joined', code: target.code, you: member.id, isHost: member.isHost, token: member.token, started: target.started });
          if (target.started && target.state) {
            // 切断中は AI が代行していた Player を、本人復帰につき人間へ戻す。
            convertPlayerType(target, member.id, 'human');
            // ゲーム中: 現在の視点別マスク state ＋ 自分視点ログで再同期。
            send(ws, { t: 'started', you: member.id, state: { ...maskStateFor(target.state, member.id), log: target.memberLogs[member.id] ?? [] } });
            // 復帰を他プレイヤーへ通知＋CPU駆動を再評価（手番待ち解消の場合に備える）。
            notifyReconnect(target, member.name);
            scheduleCpuTick(target, target.cpuStepMs);
          } else {
            broadcastLobby(target, currentUrls());
          }
          break;
        }
        case 'rename': {
          if (!room || !me || room.started) return;
          me.name = assignName(msg.name, room, me);
          broadcastLobby(room, currentUrls());
          break;
        }
        case 'setCpu': {
          // CPU 人数の設定はホストのみ・ロビー中のみ。
          if (!room || !me || !me.isHost || room.started) return;
          const n = Number.isFinite(msg.count) ? Math.floor(msg.count) : 0;
          room.cpuCount = n; // clampCpu は broadcastLobby 内で適用
          broadcastLobby(room, currentUrls());
          break;
        }
        case 'setConfig': {
          // CPU強さ・手番順の設定はホストのみ・ロビー中のみ。参加者からは変更不可。
          if (!room || !me || !me.isHost || room.started) return;
          if (msg.cpuDifficulty === 'weak' || msg.cpuDifficulty === 'normal' || msg.cpuDifficulty === 'strong' || msg.cpuDifficulty === 'elite') {
            room.cpuDifficulty = msg.cpuDifficulty;
          }
          if (msg.orderMode === 'random' || msg.orderMode === 'joined') {
            room.orderMode = msg.orderMode;
          }
          if (msg.scenario && KNOWN_SCENARIO_IDS.has(msg.scenario)) {
            room.scenario = msg.scenario;
          }
          broadcastLobby(room, currentUrls());
          break;
        }
        case 'start': {
          if (!room || !me || !me.isHost || room.started) return;
          clampCpu(room);
          const humans = connectedHumans(room);
          const total = humans + room.cpuCount;
          if (humans < 1 || total < MIN_PLAYERS || total > MAX_PLAYERS) {
            send(ws, { t: 'error', message: '人間1人以上・合計2〜4人で開始できます' });
            return;
          }
          startGame(room);
          break;
        }
        case 'action': {
          // ルーム所属・開始済み・正本stateの存在を確認
          if (!room || !me || !room.started || !room.state) return;
          const action = msg.action;
          if (!action || !LAN_ALLOWED_ACTIONS.has(action.type)) {
            send(ws, { t: 'error', message: 'この操作はまだLAN対戦に対応していません' });
            return;
          }
          // 不正クライアント対策: 権限判定・検証・適用をすべて try で包む。
          // 必須フィールド欠落（例 RESPOND_TRADE に response が無い／DISCARD に resources が無い）の
          // JSON は requiredActor や検証で TypeError を投げうるが、これがリスナー外へ漏れると
          // Node プロセス全体が落ち全ルームが巻き込まれる（リモートDoS）。catch で送信者にのみ通知する。
          try {
            // 操作権限: actor が送信者本人か（非手番/別IDは拒否）
            const actor = requiredActor(room.state, action);
            if (actor !== me.id) {
              send(ws, { t: 'error', message: 'あなたの操作できる場面ではありません' });
              return;
            }
            // 交易応答は「交易対象に含まれるプレイヤー」のみ許可（対象外を拒否）
            if (action.type === 'RESPOND_TRADE') {
              const pt = room.state.pendingTrade;
              if (!pt || !pt.targetPlayerIds.includes(action.response.playerId)) {
                send(ws, { t: 'error', message: '交易の対象ではありません' });
                return;
              }
            }
            // 交易確定は「交易対象かつ ACCEPT した相手」に対してのみ許可する
            // （拒否者・対象外への一方的な成立強制を防ぐ。エンジン側 confirmTrade と二重防御）。
            if (action.type === 'CONFIRM_TRADE') {
              const pt = room.state.pendingTrade;
              if (!pt || !pt.targetPlayerIds.includes(action.responderId) || pt.responses[action.responderId]?.status !== 'ACCEPT') {
                send(ws, { t: 'error', message: '承諾した相手とのみ交易を成立できます' });
                return;
              }
            }
            // 捨て札は「手札の半分(切り捨て)を、所持範囲内で」のみ許可（不足/過剰を拒否）。
            // 騎士と商人では商品も手札枚数に含まれる（資源だけ数えると商品込みの捨て札が常に
            // 拒否され、オンラインで捨てられなくなる）。判定は isValidDiscard に集約。
            if (action.type === 'DISCARD_RESOURCES' && !isValidDiscard(room.state, action)) {
              send(ws, { t: 'error', message: '捨て札の枚数が正しくありません' });
              return;
            }
            // 金タイル選択は「ちょうど owed 枚・各資源はバンク在庫の範囲内」のみ許可。
            if (action.type === 'CHOOSE_GOLD') {
              const owed = (room.state.pendingGoldChoice ?? {})[action.playerId] ?? 0;
              const res = action.resources as Partial<Record<typeof RESOURCE_TYPES[number], number>>;
              const sum = RESOURCE_TYPES.reduce((s, r) => s + (res[r] ?? 0), 0);
              const withinBank = RESOURCE_TYPES.every(r => (res[r] ?? 0) >= 0 && (res[r] ?? 0) <= room.state.bank[r]);
              if (owed === 0 || sum !== owed || !withinBank) {
                send(ws, { t: 'error', message: '金タイルの選択枚数が正しくありません' });
                return;
              }
            }
            const prev = room.state;
            // 乱数（ダイス/山札/盗賊奪取）はすべてサーバ側で確定する
            const next = applyAction(prev, action, Math.random);
            room.state = next;
            // 視点別ログは broadcastState 内で各メンバー視点に生成する
            broadcastState(room, prev, action, me.id);
            // 人間の操作後に CPU の手番/応答が来る場合は CPU 駆動を起動。
            scheduleCpuTick(room, action.type === 'ROLL_DICE' ? room.cpuAfterRollMs : room.cpuStepMs);
          } catch {
            // applyAction が弾いた無効操作 or 不正な形のメッセージ（送信者にのみ通知し、プロセスは継続）
            send(ws, { t: 'error', message: '無効な操作です' });
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (!room || !me) return;
      // この ws が現在のメンバーの ws でない（既に別接続に置き換わった）なら無視。
      if (me.ws !== ws) return;
      me.connected = false;
      me.ws = null;
      if (!room.started) {
        // 開始前: 即削除せず猶予を持たせ、同一端末の再接続(resume)で復帰できるようにする。
        broadcastLobby(room, currentUrls());
        scheduleMemberRelease(room, me);
      } else {
        // 開始後: 切断者の手番でゲームが停止しないよう、その Player を一時的に AI 化して
        // サーバ側 CPU 駆動に代行させる（再接続で人間へ戻す）。スロット自体は解放しない。
        convertPlayerType(room, me.id, 'ai');
        if (connectedHumans(room) === 0) {
          // 観戦者ゼロなら CPU 駆動を一時停止（再接続で再開）。ルームは猶予中は保持。
          if (room.cpuTimer) { clearTimeout(room.cpuTimer); room.cpuTimer = null; }
        } else {
          notifyDisconnect(room, me.name);
          // 切断者の手番なら即 CPU が代行できるよう駆動を起動する。
          scheduleCpuTick(room, room.cpuStepMs);
        }
        scheduleMemberRelease(room, me);
      }
    });
  });
}

// 切断メンバーを猶予後に解放する（再接続が来なければ枠を空ける）。
function scheduleMemberRelease(room: Room, member: Member): void {
  if (member.graceTimer) clearTimeout(member.graceTimer);
  member.graceTimer = setTimeout(() => {
    member.graceTimer = null;
    if (member.connected) return; // 既に再接続済み

    if (room.started) {
      // 開始後はスロットを解放しない。resume（id+token 一致）で同一プレイヤーとして
      // 復帰できるよう Member を残す（その間 Player は AI が代行し続ける）。
      // 全員が戻らないまま猶予を過ぎた場合のみルームを破棄する。
      if (connectedHumans(room) === 0) {
        if (room.cpuTimer) { clearTimeout(room.cpuTimer); room.cpuTimer = null; }
        for (const m of room.members) { if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; } }
        rooms.delete(room.code);
      }
      return;
    }

    // 開始前（ロビー）: スロットを解放する（従来どおり）。
    room.members = room.members.filter(m => m !== member);
    // ホストが抜けたままなら残りの先頭をホストに昇格
    if (member.isHost && room.members.length > 0 && !room.members.some(m => m.isHost)) {
      room.members[0]!.isHost = true;
    }
    // 誰もいなくなったら CPU を止めてルーム破棄
    if (room.members.length === 0) {
      if (room.cpuTimer) { clearTimeout(room.cpuTimer); room.cpuTimer = null; }
      rooms.delete(room.code);
      return;
    }
    broadcastLobby(room, lanHostUrls(5173));
  }, room.graceMs);
}

function sanitizeName(raw: string): string {
  // 空でもここでは補完しない（空判定を assignName に委ねる）。
  return (raw ?? '').toString().trim().slice(0, 20);
}

// ルーム内の他メンバー名と重複しない名前を割り当てる。
// 空入力ならランダムなカタカナ名を生成。明示入力は尊重しつつ重複だけ回避する。
function assignName(raw: string, room: Room, exclude?: Member): string {
  const existing = room.members.filter(m => m !== exclude).map(m => m.name);
  const requested = sanitizeName(raw) || generateRandomPlayerName(existing);
  return resolveUniqueName(requested, existing);
}

// ゲーム中の切断/再接続を、接続中の人間へシステムログ＋現在stateで知らせる。
function notifySystem(room: Room, message: string): void {
  if (!room.state) return;
  const entry: LogEntry = {
    turn: room.state.globalTurnNumber,
    playerId: room.state.playerOrder[room.state.currentPlayerIndex] ?? 'player1',
    type: 'SYSTEM',
    message,
  };
  for (const m of room.members) {
    if (!m.connected || !m.ws) continue;
    const log = [...(room.memberLogs[m.id] ?? []), entry].slice(-MAX_LOG_ENTRIES);
    room.memberLogs[m.id] = log;
    send(m.ws, { t: 'state', state: { ...maskStateFor(room.state, m.id), log } });
  }
}
function notifyDisconnect(room: Room, name: string): void { notifySystem(room, `🔌 ${name} が切断しました`); }
function notifyReconnect(room: Room, name: string): void { notifySystem(room, `🔄 ${name} が再接続しました`); }
