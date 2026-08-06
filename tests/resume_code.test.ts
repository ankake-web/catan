// @vitest-environment jsdom
// ============================================================
// tests/resume_code.test.ts — 復帰コード（別端末から対局へ戻る合言葉）
// ============================================================
//
// 同じ端末なら localStorage で自動復帰するが、別端末・履歴削除からの復帰には
// 「ルームNo＋自分のスロット＋トークン」が要る。その1行文字列の往復を固定する。

import { describe, it, expect } from 'vitest';
import { encodeResumeCode, decodeResumeCode } from '../src/net/resume';
import type { ResumeInfo } from '../src/net/resume';

const INFO: ResumeInfo = {
  code: '0421',
  you: 'player2',
  token: 'Ab9_-xyzTOKEN0123456789abcdefghijklmnopq',
};

describe('復帰コード', () => {
  it('encode → decode で元に戻る', () => {
    const code = encodeResumeCode(INFO);
    expect(code.startsWith('CATAN1-')).toBe(true);
    expect(decodeResumeCode(code)).toEqual(INFO);
  });

  it('先頭ゼロのルームNoが保たれる（数値化されない）', () => {
    const info: ResumeInfo = { ...INFO, code: '0007' };
    expect(decodeResumeCode(encodeResumeCode(info))?.code).toBe('0007');
  });

  it('前後の空白・改行が混じっても読める（コピペ耐性）', () => {
    const code = encodeResumeCode(INFO);
    expect(decodeResumeCode(`  ${code}\n`)).toEqual(INFO);
  });

  it('トークンがそのまま平文で出ていない（肩越しに読まれにくい）', () => {
    expect(encodeResumeCode(INFO)).not.toContain(INFO.token);
  });

  it('壊れた文字列・別形式・空は null', () => {
    expect(decodeResumeCode('')).toBeNull();
    expect(decodeResumeCode('0421')).toBeNull();               // ルームNo だけでは戻れない
    expect(decodeResumeCode('CATAN1-!!!!')).toBeNull();
    expect(decodeResumeCode('CATAN9-abcd')).toBeNull();        // 版違い
    expect(decodeResumeCode(btoa('["0421","player2"]'))).toBeNull(); // 接頭辞なし
  });

  it('スロット名が player1..4 以外なら受け付けない', () => {
    const bad = 'CATAN1-' + btoa(JSON.stringify(['0421', 'player9', 'tok']))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeResumeCode(bad)).toBeNull();
  });
});
