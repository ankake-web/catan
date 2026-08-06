// ============================================================
// src/net/resume.ts — LAN再接続情報の保存（localStorage）
// ============================================================
//
// リロード・一時切断後に「同じプレイヤー」として復帰するため、
// ルームコード・自分のID・再接続トークンを保存する。
// 秘匿情報（手札など）は保存しない。
//
// あわせて「封印スナップショット」も預かる。これはサーバが暗号化した対局の正本で、
// こちら側では中身を読めない（＝手札は漏れないし、書き換えても検証で弾かれる）。
// サーバが再起動してルームごと消えたとき、これを差し戻して対局を復元する。

import type { PlayerId } from '../types';

export interface ResumeInfo {
  code: string;
  you: PlayerId;
  token: string;
}

const KEY = 'catan_lan_resume';
const SNAP_KEY = 'catan_lan_snapshot';

// サーバ側 SNAPSHOT_TTL_MS と揃える（古すぎる復元は受理されないので保持もしない）。
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export function saveResume(info: ResumeInfo): void {
  try { localStorage.setItem(KEY, JSON.stringify(info)); } catch { /* 不可環境は無視 */ }
}

export function loadResume(): ResumeInfo | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<ResumeInfo>;
    if (o && typeof o.code === 'string' && typeof o.you === 'string' && typeof o.token === 'string') {
      return { code: o.code, you: o.you as PlayerId, token: o.token };
    }
  } catch { /* 壊れた値は無視 */ }
  return null;
}

export function clearResume(): void {
  try { localStorage.removeItem(KEY); } catch { /* 無視 */ }
  clearSnapshot();
}

// ---- 復帰コード（別端末・データ消失からの復帰用）----
//
// 自動復帰は localStorage の保存情報で行うため、普段は何も入力しなくてよい。
// ただし「別のスマホで続きをやりたい」「履歴を消してしまった」場合は保存情報が無く、
// ルームNo だけでは復帰できない（同一プレイヤーの証明＝トークンが必要なため）。
// そこで No＋自分のスロット＋トークンを1本の文字列にまとめ、貼り付けで復帰できるようにする。
//
// 注意: この文字列は「その席で対局に入れる鍵」そのもの。他人に渡すと成りすませる。

const CODE_PREFIX = 'CATAN1-';

/** ResumeInfo → 貼り付け用の1行文字列。 */
export function encodeResumeCode(info: ResumeInfo): string {
  const json = JSON.stringify([info.code, info.you, info.token]);
  // btoa は Latin-1 しか扱えないが、中身は ASCII（数字/player1-4/base64url トークン）なので安全。
  return CODE_PREFIX + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 貼り付けられた復帰コードを ResumeInfo に戻す。壊れていれば null。 */
export function decodeResumeCode(raw: string): ResumeInfo | null {
  try {
    const s = (raw ?? '').trim().replace(/\s+/g, '');
    if (!s.toUpperCase().startsWith(CODE_PREFIX)) return null;
    const b64 = s.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const [code, you, token] = arr;
    if (typeof code !== 'string' || typeof you !== 'string' || typeof token !== 'string') return null;
    if (!code || !token || !/^player[1-4]$/.test(you)) return null;
    return { code, you: you as PlayerId, token };
  } catch {
    return null;
  }
}

// ---- 封印スナップショット（サーバ再起動からの復元用）----

interface SnapshotStore {
  code: string;
  turn: number;
  sealed: string;
  savedAt: number;
}

/** サーバから届いた封印スナップショットを預かる（同じルームの新しいものだけ保持）。 */
export function saveSnapshot(code: string, sealed: string, turn: number): void {
  try {
    const prev = readSnapshot();
    // 同じルームで、より新しいターンのものだけ上書きする（古い局面での巻き戻しを防ぐ）。
    if (prev && prev.code === code && prev.turn > turn) return;
    const store: SnapshotStore = { code, turn, sealed, savedAt: Date.now() };
    localStorage.setItem(SNAP_KEY, JSON.stringify(store));
  } catch { /* 容量不足・不可環境は無視（復元できないだけで対戦は続く） */ }
}

/** 指定ルームの封印スナップショットを取り出す（別ルーム・期限切れは null）。 */
export function loadSnapshot(code: string): string | null {
  const s = readSnapshot();
  if (!s || s.code !== code) return null;
  if (Date.now() - s.savedAt > SNAPSHOT_TTL_MS) return null;
  return s.sealed;
}

export function clearSnapshot(): void {
  try { localStorage.removeItem(SNAP_KEY); } catch { /* 無視 */ }
}

function readSnapshot(): SnapshotStore | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<SnapshotStore>;
    if (o && typeof o.code === 'string' && typeof o.sealed === 'string'
      && typeof o.turn === 'number' && typeof o.savedAt === 'number') {
      return { code: o.code, sealed: o.sealed, turn: o.turn, savedAt: o.savedAt };
    }
  } catch { /* 壊れた値は無視 */ }
  return null;
}
