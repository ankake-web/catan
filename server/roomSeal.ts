// ============================================================
// server/roomSeal.ts — ルーム状態の「封印スナップショット」
// ============================================================
//
// 目的: サーバが再起動・スリープ復帰・デプロイでメモリを失っても、対局を続けられるようにする。
//
// 仕組み:
//   サーバは正本 state（マスク前＝全員の手札を含む）を圧縮＋暗号化した1本の文字列にして
//   各クライアントへ配る。クライアントはそれを localStorage に預かるだけで、中身は読めない。
//   ルームが消えた後にクライアントが差し戻す（restore）と、サーバは復号・改竄検証してから
//   ルームを再構築する。つまり「保存領域はクライアント、権威はサーバ」のまま復元できる。
//
// なぜ暗号化するか:
//   スナップショットには全員の手札・発展カードという秘匿情報が入る。素の JSON で配ると
//   DevTools で相手の手札が丸見えになる。また署名が無いと盤面を書き換えて差し戻せてしまう。
//   AES-256-GCM は暗号化と改竄検知（認証タグ）を同時に満たすのでこれを使う。
//
// 鍵:
//   環境変数 ROOM_SECRET から導出する。**再起動をまたいで復元したいなら必ず設定する**
//   （未設定だと起動ごとにランダム鍵になり、再起動後の復元だけが効かなくなる。
//     同一プロセス内の復元／改竄検知は未設定でも機能する）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const VERSION = 'v1';
const IV_LEN = 12;   // GCM 推奨の 96bit
const TAG_LEN = 16;

// 封印文字列の受理上限。復号前に長さで弾き、巨大データによるメモリ/CPU 消費を防ぐ。
// 実測は 4人・終盤で 10KB 前後（gzip 後）なので 1MB あれば充分に余裕がある。
export const MAX_SEALED_LEN = 1_000_000;

// 復元を受け付ける有効期限。古すぎるスナップショットでの巻き戻しを防ぐ。
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000; // 6時間

// 鍵は ROOM_SECRET から SHA-256 で 32byte 導出。未設定時はプロセス固有のランダム鍵。
let cachedKey: Buffer | null = null;
let cachedFromEnv = false;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.ROOM_SECRET?.trim();
  if (secret) {
    cachedKey = createHash('sha256').update(secret, 'utf8').digest();
    cachedFromEnv = true;
  } else {
    cachedKey = randomBytes(32);
    cachedFromEnv = false;
  }
  return cachedKey;
}

/** ROOM_SECRET 由来の永続鍵か（false = 再起動で復元できない一時鍵）。起動ログの警告に使う。 */
export function hasPersistentKey(): boolean {
  key();
  return cachedFromEnv;
}

/** テスト専用: 導出済み鍵を捨てて再導出させる（環境変数を差し替えた後に呼ぶ）。 */
export function __resetSealKeyForTest(): void {
  cachedKey = null;
  cachedFromEnv = false;
}

/** 任意のオブジェクトを封印する（JSON → gzip → AES-256-GCM → base64url）。 */
export function seal(payload: unknown): string {
  const plain = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, enc]).toString('base64url')}`;
}

/**
 * 封印を解く。改竄・鍵違い・形式違い・巨大入力はすべて null を返す（例外は投げない）。
 * 戻り値の中身は呼び出し側で検証すること（ここでは「壊れていない」ことだけを保証する）。
 */
export function unseal(sealed: string): unknown | null {
  if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > MAX_SEALED_LEN) return null;
  const dot = sealed.indexOf('.');
  if (dot < 0 || sealed.slice(0, dot) !== VERSION) return null;
  try {
    const raw = Buffer.from(sealed.slice(dot + 1), 'base64url');
    if (raw.length <= IV_LEN + TAG_LEN) return null;
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(gunzipSync(plain).toString('utf8'));
  } catch {
    return null; // 鍵違い/改竄/破損
  }
}

/** 再接続トークンの保存形式。サーバは平文を持たず、この SHA-256 だけを保持・照合する。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}
