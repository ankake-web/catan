// ============================================================
// src/net/lanLobby.ts — LAN対戦ロビーUI（TOPの「オンライン対戦」タブ）
// ============================================================
//
// ルーム作成/参加 → 参加者一覧の同期 → ホストの開始、までを担当する。
// ゲーム開始（started 受信）で onGameStart を呼び、以降は main 側が描画する。
// 既存の CPU 対戦フォームには一切触れない（このモジュールは LAN 専用）。

import { LanClient, warmUpLanServer, lanHealthUrl } from './lanClient';
import type { ServerMessage, LobbyPlayer, LanOrderMode } from './protocol';
import type { ScenarioId } from '../engine/scenarios';
import { buildScenarioSelect } from '../renderer/scenarioSelect';
import type { GameState, PlayerId, PlayerColor, AiDifficulty } from '../types';
import { attachNameField, savePlayerName } from './nameField';
import { saveResume, clearResume, loadResume, saveSnapshot, loadSnapshot, decodeResumeCode } from './resume';
import type { ResumeInfo } from './resume';

// 盤面/パネル/スコアボードと同じ正準パレットに合わせる（ロビーのドット色を統一）。
const COLOR_HEX: Record<PlayerColor, string> = {
  red: '#e03030', blue: '#3060e0', purple: '#a855f7', orange: '#f0a020',
};

export interface LanLobbyCallbacks {
  // started 受信時: マスク済み state・自分のID・接続中クライアントを引き渡す
  onGameStart: (state: GameState, viewerId: PlayerId, client: LanClient) => void;
}

interface LobbyView {
  code: string;
  you: PlayerId | null;
  isHost: boolean;
  players: LobbyPlayer[];
  hostUrls: string[];
  canStart: boolean;
  cpuCount: number;
  maxCpu: number;
  cpuDifficulty: AiDifficulty;
  orderMode: LanOrderMode;
  scenario: ScenarioId;
  error: string;
}

export function renderLanLobby(container: HTMLElement, cb: LanLobbyCallbacks, resume?: ResumeInfo): void {
  container.innerHTML = '';

  let client: LanClient | null = null;
  const view: LobbyView = {
    code: '', you: null, isHost: false, players: [], hostUrls: [], canStart: false,
    cpuCount: 0, maxCpu: 3, cpuDifficulty: 'strong', orderMode: 'random', scenario: 'classic', error: '',
  };
  let stage: 'idle' | 'connecting' | 'lobby' | 'resuming' = 'idle';
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectMsg = '';
  // 復帰対象（リロード/切断からの resume）。restorable 応答で復元を送るために保持する。
  let pendingResume: ResumeInfo | null = null;

  const root = document.createElement('div');
  root.className = 'lan-lobby';
  container.appendChild(root);

  // ---- サーバメッセージ処理 ----
  const handle = (msg: ServerMessage): void => {
    clearConnectTimer(); // サーバ応答が来た＝接続/作成/参加の待機は終了
    switch (msg.t) {
      case 'joined':
        view.you = msg.you; view.isHost = msg.isHost; view.code = msg.code; view.error = '';
        // 再接続情報を保存（リロード/一時切断で同一プレイヤー復帰）。
        saveResume({ code: msg.code, you: msg.you, token: msg.token });
        // started=true なら 'started' 受信でゲームへ遷移するのでロビーは描かない。
        if (!msg.started) { stage = 'lobby'; render(); }
        break;
      case 'lobby':
        view.code = msg.code; view.players = msg.players;
        view.hostUrls = msg.hostUrls; view.canStart = msg.canStart;
        view.cpuCount = msg.cpuCount; view.maxCpu = msg.maxCpu;
        view.cpuDifficulty = msg.cpuDifficulty; view.orderMode = msg.orderMode;
        view.scenario = msg.scenario;
        if (stage === 'lobby' || stage === 'resuming') { stage = 'lobby'; render(); }
        break;
      case 'started':
        if (client) cb.onGameStart(msg.state, msg.you, client);
        break;
      case 'snapshot':
        // 復元用の封印スナップショット（中身は読めない）。次に落ちたときのために預かる。
        saveSnapshot(msg.code, msg.sealed, msg.turn);
        break;
      case 'restorable': {
        // サーバ側にルームが無い（再起動・スリープ明け）。預かったスナップショットがあれば
        // 差し戻して対局を復元する。無ければ素直に入り直してもらう。
        const info = pendingResume;
        const sealed = loadSnapshot(msg.code);
        if (info && sealed && client) {
          stage = 'resuming'; connectMsg = '♻️ 対局を復元中…'; render();
          client.send({ t: 'restore', code: msg.code, you: info.you, token: info.token, sealed });
        } else {
          clearResume();
          client?.close(); client = null;
          stage = 'idle';
          view.error = '前回の対局は終了しました（サーバが再起動したか、時間が経ちすぎています）。';
          render();
        }
        break;
      }
      case 'bye':
        // サーバの計画停止。ロビー段階では復帰先が無いので案内だけ出す。
        view.error = `${msg.reason}。少し待ってからもう一度お試しください。`;
        render();
        break;
      case 'error':
        if (msg.fatal) {
          // 再接続失敗など: 保存情報を破棄して入室前(idle)へ戻す。
          clearResume();
          client?.close(); client = null;
          stage = 'idle';
        }
        view.error = msg.message; render();
        break;
    }
  };

  const ensureClient = async (): Promise<boolean> => {
    if (client) return true;
    client = new LanClient(handle);
    try {
      await client.connect();
      return true;
    } catch {
      client = null;
      view.error = 'サーバに接続できませんでした（ホストが dev サーバを起動しているか確認してください）';
      render();
      return false;
    }
  };

  function clearConnectTimer(): void {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }
  // 別オリジンの対戦サーバ（無料枠）はアクセスが無いとスリープする。復帰に数十秒かかる間に
  // WebSocket を張ろうとしても失敗し「サーバに繋がらない」と誤解されるため、先に HTTP で起こす。
  async function wakeServer(): Promise<void> {
    if (!lanHealthUrl()) return; // 同一オリジン（dev / LAN 内対戦）は不要
    const prev = connectMsg;
    connectMsg = '🔌 対戦サーバを起動中…（初回は1分ほどかかることがあります）'; render();
    await warmUpLanServer();
    connectMsg = prev; render();
  }

  // 接続〜サーバ応答までローディング表示。応答が来ない場合は一定時間でタイムアウト。
  async function beginConnect(label: string, send: () => void): Promise<void> {
    stage = 'connecting'; connectMsg = label; view.error = ''; render();
    clearConnectTimer();
    await wakeServer();
    if (stage !== 'connecting') return; // 待っている間に画面が変わった
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (stage !== 'connecting') return;
      client?.close(); client = null;
      view.error = 'サーバが応答しません。少し待ってから再試行してください。';
      stage = 'idle'; render();
    }, 25_000);
    if (await ensureClient()) {
      send();
    } else {
      clearConnectTimer();
      stage = 'idle'; render(); // ensureClient が接続失敗時の error を設定済み
    }
  }

  // ---- レンダリング ----
  function render(): void {
    root.innerHTML = '';
    if (stage === 'idle') renderIdle();
    else if (stage === 'connecting' || stage === 'resuming') {
      const wrap = document.createElement('div');
      wrap.className = 'lan-wait';
      const sp = document.createElement('span');
      sp.className = 'lan-spinner';
      wrap.appendChild(sp);
      const tx = document.createElement('span');
      tx.textContent = stage === 'resuming' ? '再接続中…' : (connectMsg || '接続中…');
      wrap.appendChild(tx);
      root.appendChild(wrap);
    } else renderLobby();
    if (view.error) {
      const err = document.createElement('div');
      err.className = 'lan-error';
      err.textContent = `⚠ ${view.error}`;
      root.appendChild(err);
    }
  }

  // 再接続（resume 情報があれば、同一プレイヤーとして復帰を試みる）。
  // サーバが寝ている可能性があるので先に起こす。失敗しても保存情報は消さず、
  // 手動で「対局に戻る」を押して再試行できるようにする。
  async function startResume(info: ResumeInfo): Promise<void> {
    pendingResume = info;
    stage = 'resuming'; view.error = ''; render();
    await wakeServer();
    if (stage !== 'resuming') return;
    if (await ensureClient()) {
      client!.send({ t: 'resume', code: info.code, you: info.you, token: info.token });
    } else {
      stage = 'idle';
      view.error = 'サーバに接続できませんでした。「前回の対局に戻る」でもう一度お試しください。';
      render();
    }
  }

  function renderIdle(): void {
    // 進行中だった対局の情報が残っていれば、まず「戻る」導線を出す。
    // 自動復帰に失敗した後でも、ここから何度でもやり直せる（＝閉じ込められない）。
    const saved = loadResume();
    if (saved) {
      const back = document.createElement('button');
      back.className = 'home-start-btn lan-resume-btn';
      back.textContent = `▶ 前回の対局に戻る（ルーム ${saved.code}）`;
      back.addEventListener('click', () => { void startResume(saved); });
      root.appendChild(back);
      const drop = document.createElement('button');
      drop.className = 'lan-resume-drop';
      drop.type = 'button';
      drop.textContent = '戻らない（この対局を破棄）';
      drop.addEventListener('click', () => { clearResume(); render(); });
      root.appendChild(drop);
      const div = document.createElement('div');
      div.className = 'lan-divider';
      div.textContent = 'または';
      root.appendChild(div);
    }

    const nameField = field('プレイヤー名');
    const nameRow = document.createElement('div');
    nameRow.className = 'name-input-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'home-input';
    const dice = attachNameField(nameInput);  // 初期値=保存名 or ランダム、🎲ボタン
    nameRow.appendChild(nameInput);
    nameRow.appendChild(dice);
    nameField.appendChild(nameRow);
    root.appendChild(nameField);

    // 未入力なら空のまま送る（サーバがランダム名を補完＋重複回避する）。
    const getName = (): string => {
      const n = nameInput.value.trim();
      savePlayerName(n);
      return n;
    };

    // ルーム作成
    const createBtn = document.createElement('button');
    createBtn.className = 'home-start-btn';
    createBtn.textContent = 'ルームを作成';
    createBtn.addEventListener('click', () => {
      void beginConnect('🔄 ルームを作成中…', () => client!.send({ t: 'create', name: getName() }));
    });
    root.appendChild(createBtn);

    const divider = document.createElement('div');
    divider.className = 'lan-divider';
    divider.textContent = 'または';
    root.appendChild(divider);

    // ルーム参加
    const joinRow = document.createElement('div');
    joinRow.className = 'lan-join-row';
    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.className = 'home-input lan-code-input';
    // 長さ制限は sanitize 側の slice(0,4) で行う。native maxLength を併用すると
    // 記号入りのペースト（例 "ab-12"）が先頭4文字で切られてから整形され、
    // 有効文字が削れてしまうため、ここでは付けない。
    codeInput.placeholder = 'ルームコード（数字4桁）';
    codeInput.setAttribute('aria-label', 'ルームコード（数字4桁）'); // placeholder だけに頼らない読み上げ名
    // 数字のみ。スマホではテンキーを出す。自動補正/予測変換による二重入力を防ぐ。
    codeInput.setAttribute('autocomplete', 'off');
    codeInput.setAttribute('autocorrect', 'off');
    codeInput.spellcheck = false;
    codeInput.inputMode = 'numeric';
    codeInput.pattern = '[0-9]*';
    // value 全体を数字のみへ正規化する（手書きで old+typedChar を継ぎ足さない）。
    // IME変換中（isComposing）は書き換えず、確定後にのみ整えることで二重化を防ぐ。
    // 値が変わらないなら代入もしない（カーソル飛び・再入力ループを防ぐ）。
    const sanitizeCode = (): void => {
      const cleaned = codeInput.value.replace(/\D/g, '').slice(0, 4);
      if (cleaned !== codeInput.value) codeInput.value = cleaned;
    };
    codeInput.addEventListener('input', (e) => {
      if ((e as InputEvent).isComposing) return; // 変換中は確定を待つ
      sanitizeCode();
    });
    codeInput.addEventListener('compositionend', sanitizeCode);
    const joinBtn = document.createElement('button');
    joinBtn.className = 'home-online-btn';
    joinBtn.textContent = '参加';
    const submitJoin = async (): Promise<void> => {
      sanitizeCode();
      const code = codeInput.value.trim();
      if (code.length < 4) { view.error = 'ルームコードを入力してください'; render(); return; }
      await beginConnect('🔄 ルームに参加中…', () => client!.send({ t: 'join', code, name: getName() }));
    };
    joinBtn.addEventListener('click', () => { void submitJoin(); });
    // 送信だけは keydown で扱う（Enter キーで参加）。
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void submitJoin(); }
    });
    joinRow.appendChild(codeInput);
    joinRow.appendChild(joinBtn);
    root.appendChild(joinRow);

    // 別の端末・履歴を消した端末から進行中の対局へ戻るための復帰コード入力（普段は畳んでおく）。
    // 同じ端末なら保存情報で自動復帰するため、ここは「引っ越し用の非常口」。
    const recover = document.createElement('details');
    recover.className = 'lan-recover';
    const summary = document.createElement('summary');
    summary.textContent = '別の端末から対局に戻る（復帰コード）';
    recover.appendChild(summary);
    const rHint = document.createElement('p');
    rHint.className = 'lan-hint';
    rHint.textContent = '対局中の端末の ☰メニュー →「🔑 復帰コードをコピー」で出る文字列を貼り付けてください。ルームNo だけでは戻れません（席の持ち主だけが戻れるようにするため）。';
    recover.appendChild(rHint);
    const rRow = document.createElement('div');
    rRow.className = 'lan-join-row';
    const rInput = document.createElement('input');
    rInput.type = 'text';
    rInput.className = 'home-input';
    rInput.placeholder = 'CATAN1-…';
    rInput.setAttribute('autocomplete', 'off');
    rInput.setAttribute('aria-label', '復帰コード');
    const rBtn = document.createElement('button');
    rBtn.className = 'home-online-btn';
    rBtn.textContent = '戻る';
    const submitRecover = (): void => {
      const info = decodeResumeCode(rInput.value);
      if (!info) { view.error = '復帰コードが正しくありません（CATAN1- で始まる文字列を貼り付けてください）'; render(); return; }
      saveResume(info);        // 以後はこの端末でも自動復帰できるようにする
      void startResume(info);
    };
    rBtn.addEventListener('click', submitRecover);
    rInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitRecover(); } });
    rRow.append(rInput, rBtn);
    recover.appendChild(rRow);
    root.appendChild(recover);

    const hint = document.createElement('p');
    hint.className = 'lan-hint';
    hint.textContent = '同じ Wi-Fi / LAN 内の端末同士で対戦できます。ホストが表示する URL に他の端末からアクセスしてください。';
    root.appendChild(hint);
  }

  function renderLobby(): void {
    // ルームコード
    const codeBox = document.createElement('div');
    codeBox.className = 'lan-code-box';
    codeBox.append('ルームコード ');
    const codeStrong = document.createElement('b');
    codeStrong.className = 'lan-code';
    codeStrong.textContent = view.code;
    codeBox.appendChild(codeStrong);
    root.appendChild(codeBox);

    // 参加用 URL（他端末で開く）
    if (view.hostUrls.length > 0) {
      const urlBox = document.createElement('div');
      urlBox.className = 'lan-url-box';
      const lbl = document.createElement('div');
      lbl.className = 'lan-url-label';
      lbl.textContent = '他の端末でこの URL を開く:';
      urlBox.appendChild(lbl);
      for (const u of view.hostUrls) {
        const a = document.createElement('a');
        a.className = 'lan-url';
        a.href = u; a.textContent = u; a.target = '_blank'; a.rel = 'noopener';
        urlBox.appendChild(a);
      }
      root.appendChild(urlBox);
    }

    // 参加者一覧
    const listBox = document.createElement('div');
    listBox.className = 'lan-players';
    const listTitle = document.createElement('div');
    listTitle.className = 'lan-players-title';
    listTitle.textContent = `参加者 (${view.players.filter(p => p.connected).length})`;
    listBox.appendChild(listTitle);
    const humanCount = view.players.filter(p => !p.isCpu && p.connected).length;
    for (const p of view.players) {
      const row = document.createElement('div');
      row.className = `lan-player-row${p.connected ? '' : ' disconnected'}${p.isCpu ? ' cpu' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'lan-player-dot';
      dot.style.background = COLOR_HEX[p.color];
      row.appendChild(dot);
      const nm = document.createElement('span');
      nm.className = 'lan-player-name';
      nm.textContent = p.isCpu ? `🤖 ${p.name}` : p.name;
      row.appendChild(nm);
      const tags = document.createElement('span');
      tags.className = 'lan-player-tags';
      if (p.isCpu) tags.textContent += ' CPU';
      if (p.isHost) tags.textContent += ' 👑ホスト';
      if (p.id === view.you) tags.textContent += ' (あなた)';
      if (!p.connected && !p.isCpu) tags.textContent += ' …切断';
      row.appendChild(tags);
      listBox.appendChild(row);
    }
    root.appendChild(listBox);

    // CPU 人数設定（ホストのみ）。人間＋CPUが2〜4人になるよう調整する。
    if (view.isHost) {
      const cpuBox = document.createElement('div');
      cpuBox.className = 'lan-cpu-ctrl';
      const lbl = document.createElement('span');
      lbl.className = 'lan-cpu-label';
      lbl.textContent = 'CPU 人数';
      cpuBox.appendChild(lbl);
      const minus = document.createElement('button');
      minus.className = 'lan-cpu-btn'; minus.textContent = '−';
      minus.disabled = view.cpuCount <= 0;
      minus.addEventListener('click', () => client?.send({ t: 'setCpu', count: view.cpuCount - 1 }));
      const val = document.createElement('span');
      val.className = 'lan-cpu-val'; val.textContent = String(view.cpuCount);
      const plus = document.createElement('button');
      plus.className = 'lan-cpu-btn'; plus.textContent = '＋';
      plus.disabled = view.cpuCount >= view.maxCpu;
      plus.addEventListener('click', () => client?.send({ t: 'setCpu', count: view.cpuCount + 1 }));
      cpuBox.append(minus, val, plus);
      const hint = document.createElement('span');
      hint.className = 'lan-cpu-hint';
      hint.textContent = `（人間 ${humanCount} ＋ CPU ${view.cpuCount} ＝ ${humanCount + view.cpuCount}人）`;
      cpuBox.appendChild(hint);
      root.appendChild(cpuBox);
    }

    // CPU強さ・手番順（ホストが設定。参加者はハイライト表示のみ＝変更不可）。
    // 強さを1段引き上げ: 弱い=旧普通(normal) / 普通=旧強い(strong) / 強い=新最上位(elite)。
    const DIFF_OPTS: { value: AiDifficulty; text: string }[] = [
      { value: 'normal', text: '弱い' }, { value: 'strong', text: '普通' }, { value: 'elite', text: '強い' },
    ];
    const ORDER_OPTS: { value: LanOrderMode; text: string }[] = [
      { value: 'random', text: 'ランダム' }, { value: 'joined', text: '入室順' },
    ];
    const segRow = <T extends string>(
      labelText: string, opts: { value: T; text: string }[], cur: T, onPick: (v: T) => void,
    ): HTMLDivElement => {
      const box = document.createElement('div');
      box.className = 'lan-cfg-ctrl';
      const lbl = document.createElement('span');
      lbl.className = 'lan-cfg-label';
      lbl.textContent = labelText;
      box.appendChild(lbl);
      const grp = document.createElement('div');
      grp.className = 'lan-cfg-seg';
      for (const o of opts) {
        const b = document.createElement('button');
        b.className = `lan-cfg-opt${o.value === cur ? ' active' : ''}`;
        b.textContent = o.text;
        if (view.isHost) b.addEventListener('click', () => onPick(o.value));
        else b.disabled = true;   // 参加者は表示のみ
        grp.appendChild(b);
      }
      box.appendChild(grp);
      return box;
    };
    // 盤面シナリオはドロップダウン＋説明（シナリオが多いので segment ではなく select）。
    const scenRow = document.createElement('div');
    scenRow.className = 'lan-cfg-ctrl lan-cfg-scenario';
    const scenLbl = document.createElement('span');
    scenLbl.className = 'lan-cfg-label';
    scenLbl.textContent = '盤面（ルール）';
    scenRow.appendChild(scenLbl);
    scenRow.appendChild(buildScenarioSelect({
      current: view.scenario,
      disabled: !view.isHost,                       // 参加者は表示のみ
      onChange: v => client?.send({ t: 'setConfig', scenario: v }),
    }));
    root.appendChild(scenRow);
    root.appendChild(segRow('CPU 強さ', DIFF_OPTS, view.cpuDifficulty, v => client?.send({ t: 'setConfig', cpuDifficulty: v })));
    root.appendChild(segRow('手番順', ORDER_OPTS, view.orderMode, v => client?.send({ t: 'setConfig', orderMode: v })));

    // 開始 / 待機
    if (view.isHost) {
      const startBtn = document.createElement('button');
      startBtn.className = 'home-start-btn';
      // 開始条件未達は内部条件を見せず、シンプルに「待機中」。
      startBtn.textContent = view.canStart ? 'ゲーム開始' : '⏳ 待機中…';
      startBtn.disabled = !view.canStart;
      startBtn.addEventListener('click', () => client?.send({ t: 'start' }));
      root.appendChild(startBtn);
      if (!view.canStart) {
        const note = document.createElement('div');
        note.className = 'lan-wait-note';
        note.textContent = '参加者を待っています';
        root.appendChild(note);
      }
    } else {
      const wait = document.createElement('div');
      wait.className = 'lan-wait';
      wait.textContent = '⏳ ホストの開始を待っています';
      root.appendChild(wait);
    }

    // 退出
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'home-online-btn lan-leave';
    leaveBtn.textContent = '退出';
    leaveBtn.addEventListener('click', () => {
      client?.close(); client = null;
      stage = 'idle';
      Object.assign(view, { code: '', you: null, isHost: false, players: [], hostUrls: [], canStart: false, error: '' });
      render();
    });
    root.appendChild(leaveBtn);
  }

  function field(labelText: string): HTMLDivElement {
    const f = document.createElement('div');
    f.className = 'home-field';
    const l = document.createElement('label');
    l.className = 'home-label';
    l.textContent = labelText;
    f.appendChild(l);
    return f;
  }

  render();
  // 再接続情報があれば自動で復帰を試みる（リロード/一時切断からの復帰）。
  if (resume) void startResume(resume);
}
