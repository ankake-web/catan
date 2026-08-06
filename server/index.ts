// ============================================================
// server/index.ts — オンライン対戦サーバ スタンドアロン起動エントリ
// ============================================================
//
// Render などの Node ホスティングで WebSocket 対戦サーバを単体起動する。
// dev では Vite の HTTP サーバに相乗りするが（vite.config.ts の lan-ws プラグイン）、
// 本番はこのファイルを
//   npm start            (= tsx server/index.ts)
// で直接起動する。クライアント（GitHub Pages 等の別オリジン）からは
// ビルド時環境変数 VITE_LAN_SERVER_URL を介して wss:// でこのサーバへ接続される。
//
// 環境変数:
//   PORT            … listen ポート。ホスティングが注入する。未設定ならローカル用 8787。
//   ALLOWED_ORIGINS … 接続を受理する Origin の許可リスト（カンマ区切り）。
//                     本番は GitHub Pages のオリジンを必ず設定する。未設定なら
//                     開発用にローカル Vite オリジンのみ許可（ゆるめの既定）。

import http from 'node:http';
import { attachLanServer, shutdownLanServer } from './lanServer';
import { hasPersistentKey } from './roomSeal';

// listen ポート: ホスティングが注入する PORT を優先。ローカル単体起動用に既定 8787。
const PORT = Number(process.env.PORT) || 8787;

// 接続元 Origin の許可リスト。本番は ALLOWED_ORIGINS（カンマ区切り）で
// GitHub Pages のオリジン等を渡す。未設定時は開発用にローカル Vite オリジンを許可。
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_DEV_ORIGINS;

// 死活監視（Render のヘルスチェック）と、無料枠スリープからの手動復帰アクセス用。
// WebSocket アップグレード（/lan）以外の通常 HTTP はここで応答する。
// クライアントは WebSocket を張る前にここを叩いてサーバを起こす（ウォームアップ）。
// 無料枠はスリープからの復帰に数十秒かかることがあり、いきなり WebSocket を張ると
// 「つながらない」と誤解される。CORS を開けておき、ブラウザ側で完了を待てるようにする。
const httpServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    res.end();
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// WebSocket 対戦サーバ（/lan）を相乗りさせる。本番は Origin 許可リストで門番する。
attachLanServer(httpServer, PORT, { allowedOrigins });

httpServer.listen(PORT, () => {
  console.log(`[lan] WebSocket server listening on :${PORT} (path /lan)`);
  console.log(`[lan] allowed origins: ${allowedOrigins.join(', ')}`);
  if (!hasPersistentKey()) {
    // ROOM_SECRET が無いと再起動ごとに鍵が変わり、再起動をまたぐ対局復元だけができない。
    console.warn('[lan] ROOM_SECRET 未設定: 再起動をまたぐ対局復元は無効です（環境変数に長いランダム文字列を設定してください）');
  }
});

// ---- 耐障害: 想定外の例外でプロセスごと落ちない ----
// 1件のバグや壊れたメッセージで全ルームの対局が消えるのが最悪の体験なので、
// 例外はログに残して稼働を続ける（該当の操作だけが失敗する形に留める）。
process.on('uncaughtException', err => {
  console.error('[lan] uncaughtException（継続します）:', err);
});
process.on('unhandledRejection', reason => {
  console.error('[lan] unhandledRejection（継続します）:', reason);
});

// ---- 計画停止（デプロイ・再起動）----
// Render はデプロイ時に SIGTERM を送る。落ちる前に各端末へ最新の復元スナップショットと
// 「すぐ戻る」通知を届けてから閉じる。クライアントは自動で再接続→復元する。
let shuttingDown = false;
function gracefulExit(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lan] ${signal} 受信。対局スナップショットを配布して停止します`);
  try { shutdownLanServer(); } catch (e) { console.error('[lan] shutdown 中の例外:', e); }
  // スナップショットの送信がフラッシュされるだけの猶予を置いてから閉じる。
  setTimeout(() => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }, 500).unref();
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));
