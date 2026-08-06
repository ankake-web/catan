// ============================================================
// src/net/lanClient.ts — LAN対戦 WebSocket クライアント（ブラウザ）
// ============================================================
//
// dev サーバと同一オリジンの /lan へ接続する薄いラッパー。
// 受信メッセージはハンドラへそのまま渡し、UI 側（lanLobby / main）が解釈する。
//
// オンライン対戦で「落ちない」ための仕掛けをここに集約する:
//   - アプリ層ハートビート（ping/pong）: 無通信での中間経路によるアイドル切断を防ぎ、
//     同時に「TCP は生きているのに応答が返らない」半死接続を自力で検知して張り直す。
//   - 接続タイムアウト: 無料枠サーバの起動待ちで永遠にスピナーが回る状態を作らない。
//   - isOpen()/checkAlive(): 画面復帰時に接続の生死を能動的に確かめる。

import { LAN_WS_PATH, PING_INTERVAL_MS, PONG_TIMEOUT_MS } from './protocol';
import type { ClientMessage, ServerMessage } from './protocol';

export type LanHandler = (msg: ServerMessage) => void;

// 接続先 WebSocket URL を解決する。
// VITE_LAN_SERVER_URL が設定されていればそのホスト（別オリジンの本番サーバ）へ、
// 未設定なら現在ページと同一オリジンの /lan へ接続する（ローカル dev / LAN 対戦）。
function lanServerUrl(): string {
  const base = import.meta.env.VITE_LAN_SERVER_URL?.trim();
  if (base) {
    // 末尾スラッシュを除いて /lan を付与（wss://host や wss://host/ の両方を許容）。
    return `${base.replace(/\/$/, '')}${LAN_WS_PATH}`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${LAN_WS_PATH}`;
}

/**
 * 対戦サーバの HTTP ヘルスチェック URL（同一オリジン運用なら null）。
 * 無料枠のスリープからの復帰は WebSocket より HTTP の方が確実に起こせるため、
 * 接続前のウォームアップに使う。
 */
export function lanHealthUrl(): string | null {
  const base = import.meta.env.VITE_LAN_SERVER_URL?.trim();
  if (!base) return null;
  // wss:// → https:// / ws:// → http:// に読み替える。
  const http = base.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/$/, '');
  return `${http}/health`;
}

/**
 * サーバを起こす（スリープ中の無料枠インスタンス対策）。
 * 成否は問わない（失敗しても続けて WebSocket 接続を試す）。戻り値は「起きた手応え」。
 */
export async function warmUpLanServer(timeoutMs = 60_000): Promise<boolean> {
  const url = lanHealthUrl();
  if (!url) return true; // 同一オリジン（dev/LAN）はウォームアップ不要
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export class LanClient {
  private ws: WebSocket | null = null;
  private handler: LanHandler;
  private onClose: (() => void) | null = null;
  private closedByUs = false;
  // ハートビート: 一定間隔で ping を送り、一定時間応答が無ければ切れたとみなす。
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private lastAliveAt = 0;

  constructor(handler: LanHandler) {
    this.handler = handler;
  }

  /** 受信ハンドラを差し替える（ロビー → ゲーム本体へ受け渡す際に使用）。 */
  setHandler(handler: LanHandler): void {
    this.handler = handler;
  }

  /** 予期しない切断時のコールバックを設定（設定時は fatal エラーを投げず再接続に委ねる）。 */
  setOnClose(cb: () => void): void {
    this.onClose = cb;
  }

  /** 送信可能な状態か（切断中に操作を投げて無反応になるのを UI 側で防ぐため）。 */
  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 接続の生死を能動的に確認する（画面復帰・オンライン復帰時に呼ぶ）。
   * スマホではバックグラウンド中に接続が切れても close イベントが遅れて届くことがあり、
   * 「繋がっているつもりで無反応」になりやすい。ここで即座に判定して再接続へ倒す。
   */
  checkAlive(): void {
    if (this.closedByUs) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.fireClose();
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) return; // CONNECTING は待つ
    if (this.lastAliveAt && Date.now() - this.lastAliveAt > PONG_TIMEOUT_MS) {
      this.dropAsDead();
      return;
    }
    this.send({ t: 'ping' }); // 応答が無ければ次のハートビートで落ちる
  }

  /**
   * 対戦サーバの /lan へ接続。open で resolve、失敗・タイムアウトで reject。
   * 接続先はビルド時環境変数 VITE_LAN_SERVER_URL で切り替える:
   *   - 設定あり（例 wss://catan-xxxx.onrender.com）… その別ホストへ接続。
   *     GitHub Pages など、サーバが別オリジンに居る本番構成で使う。
   *   - 未設定 … 従来どおり同一オリジンの /lan へ接続（ローカル dev / LAN 対戦）。
   */
  connect(timeoutMs = 20_000): Promise<void> {
    const url = lanServerUrl();
    this.ws = new WebSocket(url);
    this.lastAliveAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      let settled = false;
      // 応答が無いまま握手が終わらないケース（スリープ中サーバ・不安定回線）を打ち切る。
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closedByUs = true; // このソケットは捨てる（onClose の再接続ループを回さない）
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('サーバへの接続がタイムアウトしました'));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lastAliveAt = Date.now();
        this.startHeartbeat();
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('サーバに接続できませんでした'));
      };
      ws.onmessage = (ev: MessageEvent) => {
        this.lastAliveAt = Date.now(); // 何か届いた＝生きている
        let msg: ServerMessage;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.t === 'pong') return; // ハートビートの応答はここで消費する
        this.handler(msg);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        this.stopHeartbeat();
        if (this.closedByUs) return;
        this.fireClose();
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closedByUs = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  // ---- 内部 ----

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.beatTimer = setInterval(() => {
      if (this.closedByUs) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.fireClose(); return; }
      if (Date.now() - this.lastAliveAt > PONG_TIMEOUT_MS) { this.dropAsDead(); return; }
      this.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.beatTimer != null) { clearInterval(this.beatTimer); this.beatTimer = null; }
  }

  // 応答が絶えた接続を切る。close イベントの到着を待たず、その場で再接続へ倒す。
  private dropAsDead(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* noop */ }
    this.fireClose();
  }

  // 切断通知は1接続につき1回だけ上げる（再接続ループの多重起動を防ぐ）。
  private closeFired = false;
  private fireClose(): void {
    if (this.closeFired || this.closedByUs) return;
    this.closeFired = true;
    this.stopHeartbeat();
    if (this.onClose) this.onClose();
    else this.handler({ t: 'error', message: 'サーバとの接続が切れました', fatal: true });
  }
}
