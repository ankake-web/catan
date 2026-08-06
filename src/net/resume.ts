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
