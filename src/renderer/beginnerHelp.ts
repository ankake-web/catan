// ============================================================
// src/renderer/beginnerHelp.ts — 初心者向け「はじめての遊び方」オーバーレイ
// ============================================================
//
// ゲーム中に「🔰 遊び方」から開く、目的・手番の流れ・建設コスト・コツの早見表。
// 図鑑(showAssetGallery)と同じ overlay/modal CSS を流用する。

import type { GameState } from '../types';
import { getScenario, getScenarioRules } from '../engine/scenarios';

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

  // このゲーム（いま遊んでいるシナリオ）固有のルールを先頭に出す。
  if (state.scenarioId) {
    const scen = getScenario(state.scenarioId as Parameters<typeof getScenario>[0]);
    section(`📜 このゲーム「${scen.name}」のルール`, getScenarioRules(state.scenarioId));
  }

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

  // 航海者（海のある盤）共通ルール。シナリオ固有の上に、海まわりの共通操作をまとめて出す。
  if (sea) {
    section('⛵ 海と船（航海者の共通ルール）', [
      '船は「自分の船」か「自分の建物」からしか伸ばせない。陸の道と海の船は、開拓地・都市の上でだけ切り替わる。',
      '行き止まりの船は「⛵船を移動」で1ターンに1隻だけ別の海辺へ動かせる。',
      '7が出たら「盗賊（陸タイルをタップ）」か「海賊（海タイルをタップ）」を選べる。海賊は隣の船の持ち主から1枚奪い、その海での船建設を封じる。',
      '砂漠の無い盤では、盗賊は最初は盤の外。最初に7が出て盗賊を選ぶと、そこで初めて盤に登場する（海賊は最初から盤の隅の海に居る）。',
      '初期配置の2個目のコマは、海岸の開拓地なら「道」でも「船」でも置ける（光った辺をタップ）。',
      '金タイル：数字が出ると、木・レンガ・羊・麦・鉱石から好きな資源を選んでもらえる（開拓地1・都市2）。',
    ]);
  }

  section('💡 勝つコツ', [
    '数字6・8（●が多い）に接する角は資源が出やすい。最初の開拓地はここを狙う。',
    'ちがう資源が3種そろう場所だと、いろいろ建てやすい。',
    '手札は7枚以下に保つと、7が出ても捨てずに済む。',
    'ヘックスにマウスを乗せる（スマホは長押し）と「取れる資源・出やすさ」が見られる。',
  ]);

  const terms = [
    `勝利点(VP)：ゲームの点数。先に${goal}点で勝ち。`,
    '開拓地：角に建てる家。1点・出た数字で資源1個。',
    '都市：開拓地の昇格。2点・資源2個（鉱石3＋麦2）。',
    '道：辺に置き、つなげて開拓地を広げる。',
    '港：海岸の交易所。3:1、特定資源なら2:1で交換できる。',
    '最長交易路：道（船）が5本以上つながって最長の人に+2点。',
    '最大騎士力：騎士カードを3枚以上・いちばん多く使った人に+2点。',
    '発展カード：騎士／勝利点／進歩（街道建設・独占・豊穣）。',
    '盗賊：7か騎士で動かす。止めたマスは資源が出ず、隣の人から1枚奪える。',
    '銀行交易(4:1)：同じ資源4枚を、好きな資源1枚と交換。',
  ];
  if (sea) {
    terms.push('船：海に置く「道」。新しい島へ渡る（木1＋羊1）。');
    terms.push('金タイル：数字が出ると、好きな資源を選んでもらえる。');
  }
  section('📖 よく出る用語', terms);

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
