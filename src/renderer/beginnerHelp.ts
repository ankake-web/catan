// ============================================================
// src/renderer/beginnerHelp.ts — 初心者向け「はじめての遊び方」オーバーレイ
// ============================================================
//
// ゲーム中に「🔰 遊び方」から開く、目的・手番の流れ・建設コスト・コツの早見表。
// 図鑑(showAssetGallery)と同じ overlay/modal CSS を流用する。

import type { GameState } from '../types';

function hasSea(state: GameState): boolean {
  return Object.values(state.tiles).some(t => t.type === 'sea');
}

/** 「はじめての遊び方」オーバーレイを開く（多重表示は前のを消す）。 */
export function openBeginnerHelp(state: GameState): void {
  document.querySelector('.gallery-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'gallery-overlay beginner-help-overlay';
  const modal = document.createElement('div');
  modal.className = 'gallery-modal';

  const header = document.createElement('div');
  header.className = 'gallery-header';
  header.textContent = '🔰 はじめての遊び方';
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'gallery-body beginner-help-body';

  const sea = hasSea(state);
  const goal = state.victoryTarget ?? 10;

  const section = (title: string, lines: string[]): void => {
    const s = document.createElement('div');
    s.className = 'gallery-section-title';
    s.textContent = title;
    body.appendChild(s);
    const ul = document.createElement('ul');
    ul.className = 'beginner-help-list';
    for (const ln of lines) {
      const li = document.createElement('li');
      li.textContent = ln;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  };

  section('🎯 ゴール', [
    `だれより早く ${goal} 点（勝利点）を取れば勝ち。`,
    '開拓地=1点 / 都市=2点 / 最長交易路=2点 / 最大騎士力=2点 / 勝利点カード=1点。',
  ]);

  section('🔁 手番の流れ', [
    '① サイコロを振る → 出た数字に接する自分の建物が資源をもらう（都市は2倍）。',
    '　7が出たら、手札8枚以上の人は半分を捨てる＋盗賊を動かして1枚奪う。',
    '② 交易する → 銀行と4:1、港なら3:1や2:1、ほかのプレイヤーとも交換できる。',
    '③ 建てる → 道・開拓地・都市・発展カード（払えるだけ）。',
    '④「手番終了」で次の人へ。',
  ]);

  section('🧱 建設コスト', [
    '道：木1＋レンガ1',
    '開拓地：木1＋レンガ1＋羊1＋麦1（道につなげて・他の建物から2マス以上あける）',
    '都市：麦2＋鉱石3（自分の開拓地を昇格＝資源2倍に）',
    '発展カード：羊1＋麦1＋鉱石1（騎士・勝利点など）',
    ...(sea ? ['船：木1＋羊1（海ぞいに伸ばして新しい島へ）'] : []),
  ]);

  section('💡 勝つコツ', [
    '数字6・8（●が多い）に接する角は資源が出やすい。最初の開拓地はここを狙う。',
    'ちがう資源が3種そろう場所だと、いろいろ建てやすい。',
    '手札は7枚以下に保つと、7が出ても捨てずに済む。',
    '困ったらヘックスにマウスを乗せると「取れる資源・出やすさ」が見られる。',
  ]);

  modal.appendChild(body);

  const close = document.createElement('button');
  close.className = 'gallery-close';
  close.textContent = '閉じる';
  close.addEventListener('click', () => overlay.remove());
  modal.appendChild(close);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
