// ============================================================
// tests/lan-resilience.test.ts — オンライン対戦の「落ちない/戻れる」検証
// ============================================================
//
// 対象:
//   1. 封印スナップショット(roomSeal): 往復・改竄検知・鍵違い・期限・本人確認
//   2. サーバがルームの記憶を失っても、端末が預かるスナップショットで対局を復元できる
//      （= 本番でサーバが再起動/スリープしても対戦へ戻れる、の回帰テスト）
//   3. アプリ層ハートビート(ping/pong)が応答すること
//   4. 対局中は切断猶予を過ぎてもスロットが維持され、再接続できること

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachLanServer, __resetRoomsForTest, verifySnapshot } from '../server/lanServer';
import type { LanServerOptions } from '../server/lanServer';
import { seal, unseal, hashToken, __resetSealKeyForTest, SNAPSHOT_TTL_MS } from '../server/roomSeal';
import { LAN_WS_PATH } from '../src/net/protocol';
import type { ClientMessage, ServerMessage } from '../src/net/protocol';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let server: Server | null = null;
let port = 0;
const clients: TestClient[] = [];

interface TestClient {
  ws: WebSocket;
  send: (m: ClientMessage) => void;
  next: (pred: (m: ServerMessage) => boolean, ms?: number) => Promise<ServerMessage>;
}

beforeAll(() => {
  // 鍵を固定して決定的にする（本番も ROOM_SECRET を設定した運用が前提）。
  process.env.ROOM_SECRET = 'test-secret-for-room-seal';
  __resetSealKeyForTest();
});

async function startServer(opts: LanServerOptions = { graceMs: 200, gameKeepMs: 10_000, cpuStepMs: 20, cpuAfterRollMs: 20, snapshotMinIntervalMs: 0 }): Promise<void> {
  server = createServer();
  attachLanServer(server, 0, opts);
  await new Promise<void>(res => server!.listen(0, '127.0.0.1', () => res()));
  port = (server!.address() as AddressInfo).port;
}

function connect(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${LAN_WS_PATH}`);
  const waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void; t: ReturnType<typeof setTimeout> }[] = [];
  const seen: ServerMessage[] = [];
  ws.on('message', (data: Buffer) => {
    let m: ServerMessage;
    try { m = JSON.parse(String(data)) as ServerMessage; } catch { return; }
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) { clearTimeout(waiters[i]!.t); waiters[i]!.res(m); waiters.splice(i, 1); }
    }
  });
  // 既に届いているメッセージも拾えるようにする（snapshot のように到着順が前後するもの向け）。
  const next = (pred: (m: ServerMessage) => boolean, ms = 2000): Promise<ServerMessage> => {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        const idx = waiters.findIndex(w => w.t === t);
        if (idx >= 0) waiters.splice(idx, 1);
        rej(new Error('lan-resilience test: next() timed out'));
      }, ms);
      waiters.push({ pred, res, t });
    });
  };
  const client: TestClient = { ws, send: (m) => ws.send(JSON.stringify(m)), next };
  clients.push(client);
  return new Promise((res, rej) => {
    ws.on('open', () => res(client));
    ws.on('error', rej);
  });
}

const isType = <T extends ServerMessage['t']>(t: T) => (m: ServerMessage): boolean => m.t === t;

// 封印文字列の中身を1文字だけ書き換える（末尾はパディングの都合で無変化になり得るので中央を叩く）。
function tamper(sealed: string): string {
  const body = sealed.slice(3);
  const mid = Math.floor(body.length / 2);
  const ch = body[mid] === 'A' ? 'B' : 'A';
  return `v1.${body.slice(0, mid)}${ch}${body.slice(mid + 1)}`;
}

async function setupStartedGame() {
  const host = await connect();
  const hjP = host.next(isType('joined'));
  host.send({ t: 'create', name: 'Alice' });
  const hj = await hjP as Extract<ServerMessage, { t: 'joined' }>;

  const guest = await connect();
  const gjP = guest.next(isType('joined'));
  guest.send({ t: 'join', code: hj.code, name: 'Bob' });
  const gj = await gjP as Extract<ServerMessage, { t: 'joined' }>;

  const hsP = host.next(isType('started'));
  const gsP = guest.next(isType('started'));
  host.send({ t: 'start' });
  const hStarted = await hsP as Extract<ServerMessage, { t: 'started' }>;
  await gsP;

  return { host, guest, code: hj.code, hostToken: hj.token, guestToken: gj.token, hStarted };
}

afterEach(async () => {
  for (const c of clients) { try { c.ws.terminate(); } catch { /* noop */ } }
  clients.length = 0;
  await delay(50);
  __resetRoomsForTest();
  if (server) { await new Promise<void>(res => server!.close(() => res())); server = null; }
});

describe('roomSeal（復元スナップショットの封印）', () => {
  it('封印 → 解封で元のオブジェクトに戻る', () => {
    const payload = { v: 1, code: '0421', nested: { hand: { brick: 3 } }, arr: [1, 2, 3] };
    const sealed = seal(payload);
    expect(typeof sealed).toBe('string');
    expect(sealed.startsWith('v1.')).toBe(true);
    // 中身が平文で覗けないこと（手札がそのまま見えたら秘匿の意味がない）
    expect(sealed).not.toContain('brick');
    expect(unseal(sealed)).toEqual(payload);
  });

  it('1文字でも書き換えたら解封できない（改竄検知）', () => {
    const sealed = seal({ hello: 'world', hand: [1, 2, 3, 4, 5] });
    expect(unseal(tamper(sealed))).toBeNull();
  });

  it('壊れた入力・巨大入力・版違いは例外を投げずに null', () => {
    expect(unseal('')).toBeNull();
    expect(unseal('not-sealed')).toBeNull();
    expect(unseal('v2.aaaa')).toBeNull();
    expect(unseal(`v1.${'a'.repeat(2_000_000)}`)).toBeNull();
  });

  it('鍵が変わると解封できない（他サーバの封印を持ち込めない）', () => {
    const sealed = seal({ secret: 1 });
    process.env.ROOM_SECRET = 'another-secret';
    __resetSealKeyForTest();
    expect(unseal(sealed)).toBeNull();
    // 後続テストのため鍵を戻す
    process.env.ROOM_SECRET = 'test-secret-for-room-seal';
    __resetSealKeyForTest();
    expect(unseal(sealed)).toEqual({ secret: 1 });
  });
});

describe('verifySnapshot（差し戻されたスナップショットの検証）', () => {
  const base = (over: Record<string, unknown> = {}) => seal({
    v: 1,
    code: '1234',
    savedAt: Date.now(),
    turn: 5,
    cpuCount: 0,
    cpuNames: [],
    cpuDifficulty: 'strong',
    orderMode: 'random',
    scenario: 'classic',
    members: [{ id: 'player1', name: 'A', isHost: true, tokenHash: hashToken('tok-1') }],
    memberLogs: {},
    state: { playerOrder: ['player1'], players: { player1: {} } },
    ...over,
  });

  it('正しいコード＋本人のトークンなら通る', () => {
    expect(verifySnapshot(base(), '1234', 'player1', 'tok-1')).not.toBeNull();
  });

  it('別ルームのコードでは通らない', () => {
    expect(verifySnapshot(base(), '9999', 'player1', 'tok-1')).toBeNull();
  });

  it('トークンが違えば通らない（他人の対局を復元できない）', () => {
    expect(verifySnapshot(base(), '1234', 'player1', 'wrong')).toBeNull();
  });

  it('メンバーに居ないプレイヤーIDでは通らない', () => {
    expect(verifySnapshot(base(), '1234', 'player3', 'tok-1')).toBeNull();
  });

  it('期限切れ（TTL 超過）は通らない', () => {
    const old = base({ savedAt: Date.now() - SNAPSHOT_TTL_MS - 1000 });
    expect(verifySnapshot(old, '1234', 'player1', 'tok-1')).toBeNull();
  });
});

describe('lanServer: 落ちない/戻れる', () => {
  it('ping に pong を返す（アプリ層ハートビート）', async () => {
    await startServer();
    const c = await connect();
    const p = c.next(isType('pong'));
    c.send({ t: 'ping' });
    expect((await p).t).toBe('pong');
  });

  it('対局開始時に復元スナップショットが配られる', async () => {
    await startServer();
    const { host } = await setupStartedGame();
    const snap = await host.next(isType('snapshot')) as Extract<ServerMessage, { t: 'snapshot' }>;
    expect(typeof snap.sealed).toBe('string');
    expect(snap.sealed.length).toBeGreaterThan(50);
  });

  it('サーバがルームを失っても、端末のスナップショットで対局を復元できる', async () => {
    await startServer();
    const g = await setupStartedGame();
    const snap = await g.host.next(isType('snapshot')) as Extract<ServerMessage, { t: 'snapshot' }>;

    // --- サーバ再起動の模擬: ルームの記憶をすべて失う ---
    __resetRoomsForTest();

    // 再接続 → ルームが無いので「復元できるかも」と返ってくる
    const back = await connect();
    const restorableP = back.next(isType('restorable'));
    back.send({ t: 'resume', code: g.code, you: 'player1', token: g.hostToken });
    const restorable = await restorableP as Extract<ServerMessage, { t: 'restorable' }>;
    expect(restorable.code).toBe(g.code);

    // 預かっていた封印を差し戻す → 対局が復元される
    const joinedP = back.next(isType('joined'));
    const startedP = back.next(isType('started'));
    back.send({ t: 'restore', code: g.code, you: 'player1', token: g.hostToken, sealed: snap.sealed });
    const joined = await joinedP as Extract<ServerMessage, { t: 'joined' }>;
    const started = await startedP as Extract<ServerMessage, { t: 'started' }>;
    expect(joined.you).toBe('player1');
    expect(started.state.playerOrder).toEqual(g.hStarted.state.playerOrder);
    // 自分の手札は素、相手は伏せ札（復元後もマスクが効いている）
    expect(started.state.players.player1!.handCount).toBeUndefined();
    expect(started.state.players.player2!.handCount).not.toBeUndefined();

    // 相手も同じルームへ普通に再接続できる（復元は1人が代表して行えばよい）
    const back2 = await connect();
    const j2P = back2.next(isType('joined'));
    const s2P = back2.next(isType('started'));
    back2.send({ t: 'resume', code: g.code, you: 'player2', token: g.guestToken });
    expect((await j2P as Extract<ServerMessage, { t: 'joined' }>).you).toBe('player2');
    expect((await s2P as Extract<ServerMessage, { t: 'started' }>).state.players.player2!.handCount).toBeUndefined();
  });

  it('改竄したスナップショットでは復元できない', async () => {
    await startServer();
    const g = await setupStartedGame();
    const snap = await g.host.next(isType('snapshot')) as Extract<ServerMessage, { t: 'snapshot' }>;
    __resetRoomsForTest();

    const back = await connect();
    const errP = back.next(isType('error'));
    back.send({ t: 'restore', code: g.code, you: 'player1', token: g.hostToken, sealed: tamper(snap.sealed) });
    const err = await errP as Extract<ServerMessage, { t: 'error' }>;
    expect(err.fatal).toBe(true);
  });

  it('他人のトークンでは復元できない（対局の乗っ取り防止）', async () => {
    await startServer();
    const g = await setupStartedGame();
    const snap = await g.host.next(isType('snapshot')) as Extract<ServerMessage, { t: 'snapshot' }>;
    __resetRoomsForTest();

    const back = await connect();
    const errP = back.next(isType('error'));
    back.send({ t: 'restore', code: g.code, you: 'player1', token: 'bogus-token', sealed: snap.sealed });
    expect((await errP as Extract<ServerMessage, { t: 'error' }>).fatal).toBe(true);
  });

  it('復元済みルームがあるときの restore は通常の再接続として扱われる', async () => {
    await startServer();
    const g = await setupStartedGame();
    const snap = await g.host.next(isType('snapshot')) as Extract<ServerMessage, { t: 'snapshot' }>;
    // ルームは生きているまま restore が来たケース（先に別端末が復元した後の合流）
    const back = await connect();
    const startedP = back.next(isType('started'));
    back.send({ t: 'restore', code: g.code, you: 'player2', token: g.guestToken, sealed: snap.sealed });
    const started = await startedP as Extract<ServerMessage, { t: 'started' }>;
    expect(started.you).toBe('player2');
  });

  it('対局中は切断猶予(ロビー用)を過ぎてもスロットが残り、再接続できる', async () => {
    // graceMs は短く、gameKeepMs は長く。対局中はロビー猶予に引きずられないこと。
    await startServer({ graceMs: 50, gameKeepMs: 10_000, cpuStepMs: 20, cpuAfterRollMs: 20, snapshotMinIntervalMs: 0 });
    const g = await setupStartedGame();
    g.guest.ws.close();
    await delay(300); // ロビー猶予(50ms)を大きく超えて待つ

    const back = await connect();
    const startedP = back.next(isType('started'));
    back.send({ t: 'resume', code: g.code, you: 'player2', token: g.guestToken });
    const started = await startedP as Extract<ServerMessage, { t: 'started' }>;
    expect(started.you).toBe('player2');
    expect(started.state.players.player2!.type).toBe('human'); // AI 代行から本人へ復帰
  });
});
