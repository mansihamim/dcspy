'use strict';

/** Regression tests for mirroring Discord app status to the VPS gateway. */
const assert = require('assert');
const proto = require('../src/proto');
const { DiscordGateway } = require('../src/discord');

const log = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
function makeGateway(status = 'online') {
  return new DiscordGateway({
    token: 'test-token', logger: log, userAgent: 'test-agent', presenceStatus: status,
  });
}

(async () => {
  console.log('discord-status.test.js — status app → VPS\n');

  await test('mengikuti DND dari sesi app lain dan mengirim ulang presence VPS', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    const sent = [];
    g.sendPresence = () => sent.push(g.presenceStatus);
    let change;
    g.on('statusChange', (event) => { change = event; });

    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 4,
      d: [
        { session_id: 'vps-session', status: 'online', active: true },
        { session_id: 'phone-session', status: 'dnd', active: true, client_info: { client: 'mobile', os: 'android' } },
      ],
    });

    assert.strictEqual(g.presenceStatus, 'dnd');
    assert.deepStrictEqual(sent, ['dnd']);
    assert.strictEqual(change.previous, 'online');
    assert.strictEqual(change.status, 'dnd');
    assert.match(change.source, /mobile\/android/);
    assert.ok(g.lastStatusSyncAt > 0);
  });

  await test('mengabaikan sesi agregat all dan memilih sesi app yang sebenarnya', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    g.sendPresence = () => {};
    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 11,
      d: [
        { session_id: 'all', status: 'online', active: true, client_info: { client: 'unknown', os: 'unknown' } },
        { session_id: 'app-session', status: 'dnd', active: true, client_info: { client: 'desktop', os: 'osx' } },
        { session_id: 'vps-session', status: 'online', active: true },
      ],
    });
    assert.strictEqual(g.presenceStatus, 'dnd');
    assert.match(g.presenceStatusSource, /desktop\/osx/);
  });

  await test('mencatat status app yang teramati meski nilainya sama dengan VPS', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    let sent = 0;
    g.sendPresence = () => { sent += 1; };
    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 9,
      d: [
        { session_id: 'app-session', status: 'online', active: true, client_info: { client: 'desktop', os: 'windows' } },
        { session_id: 'vps-session', status: 'online', active: true },
      ],
    });
    assert.strictEqual(g.presenceStatus, 'online');
    assert.match(g.presenceStatusSource, /desktop\/windows/);
    assert.ok(g.lastStatusSyncAt > 0);
    assert.strictEqual(sent, 0, 'status yang sama tidak perlu dikirim ulang');
  });

  await test('mengabaikan status sesi VPS sendiri dan sesi app yang tidak aktif', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    let sent = 0;
    g.sendPresence = () => { sent += 1; };

    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 5,
      d: [
        { session_id: 'vps-session', status: 'dnd', active: true },
        { session_id: 'old-app-session', status: 'idle', active: false },
      ],
    });

    assert.strictEqual(g.presenceStatus, 'online');
    assert.strictEqual(sent, 0);
  });

  await test('status invisible/offline dari sesi app dipetakan menjadi offline di VPS', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    g.sendPresence = () => {};

    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 6,
      d: [
        { session_id: 'app-session', status: 'invisible', active: true },
        { session_id: 'vps-session', status: 'online', active: true },
      ],
    });
    assert.strictEqual(g.presenceStatus, 'invisible');

    g.presenceStatus = 'online';
    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 7,
      d: [
        { session_id: 'app-session', status: 'offline', active: true },
        { session_id: 'vps-session', status: 'online', active: true },
      ],
    });
    assert.strictEqual(g.presenceStatus, 'invisible');
  });

  await test('mengikuti status dari event settings proto sebagai jalur sinkronisasi tambahan', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    let sent = 0;
    g.sendPresence = () => { sent += 1; };
    const encoded = proto.toBase64(proto.setPresenceStatusSetting(Buffer.alloc(0), 'idle'));
    g.handlePayload({
      op: 0, t: 'USER_SETTINGS_PROTO_UPDATE', s: 10,
      d: { settings: { type: 1, proto: encoded }, partial: false },
    });
    assert.strictEqual(g.presenceStatus, 'idle');
    assert.strictEqual(g.presenceStatusSource, 'USER_SETTINGS_PROTO_UPDATE');
    assert.strictEqual(sent, 1);
  });

  await test('buffer status awal sampai READY agar sesi VPS bisa dikecualikan', () => {
    const g = makeGateway('online');
    let sent = 0;
    g.sendPresence = () => { sent += 1; };
    let changes = 0;
    g.on('statusChange', () => { changes += 1; });

    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 1,
      d: [
        { session_id: 'app-session', status: 'idle', active: true },
        { session_id: 'vps-session', status: 'online', active: true },
      ],
    });
    assert.strictEqual(g.presenceStatus, 'online', 'belum memilih sesi sebelum READY');

    g.handlePayload({
      op: 0, t: 'READY', s: 2,
      d: { session_id: 'vps-session', user: { id: 'user-id', username: 'test' } },
    });
    assert.strictEqual(g.presenceStatus, 'idle');
    assert.strictEqual(sent, 1, 'kirim satu presence dengan status app terbaru');
    assert.strictEqual(changes, 1);
  });

  await test('mencatat aktivitas Spotify yang dikirim dan echo sesi tanpa menyimpan judul/ID track', () => {
    const g = makeGateway('idle');
    g.sessionId = 'vps-session';
    g.identified = true;
    const activity = {
      name: 'Spotify', type: 2, details: 'judul privat', sync_id: 'raw-track-id',
      party: { id: 'spotify:discord-user-id' },
    };
    g.presenceProvider = () => [activity];
    let sentPayload;
    g.send = (payload, done) => { sentPayload = payload; done(null, g.ws); return true; };
    g.sendPresence();

    assert.strictEqual(sentPayload.d.activities[0], activity, 'payload presence tidak diubah');
    assert.deepStrictEqual(g.lastPresenceSentSummary, [{
      name: 'Spotify', type: 2, syncIdPresent: true, partyIdPresent: true, sessionIdPresent: false,
    }]);
    assert.ok(g.lastPresenceSentAt > 0);

    g.syncFromSessions([
      { session_id: 'vps-session', status: 'idle', activities: [activity] },
      { session_id: 'all', status: 'idle', activities: [activity] },
    ], false);
    assert.strictEqual(g.lastOwnSessionPresence.spotifyPresent, true);
    assert.strictEqual(g.lastOwnSessionPresence.spotifySyncIdPresent, true);
    assert.strictEqual(g.lastOwnSessionPresence.spotifyPartyIdPresent, true);
    assert.strictEqual(g.lastAggregatePresence.spotifyPresent, true);
    assert.ok(!JSON.stringify(g.lastOwnSessionPresence).includes('raw-track-id'));
    assert.ok(!JSON.stringify(g.lastOwnSessionPresence).includes('judul privat'));
  });

  await test('gagal/telatnya penulisan socket tidak tercatat sebagai presence terkirim', () => {
    const g = makeGateway('online');
    g.identified = true;
    g.presenceProvider = () => [{ name: 'Spotify', type: 2, sync_id: 'private-track-id' }];
    g.send = (_payload, done) => { done(new Error('write failed'), g.ws); return true; };
    assert.strictEqual(g.sendPresence(), true, 'frame diterima untuk dikirim, tetapi callback melaporkan kegagalan');
    assert.strictEqual(g.lastPresenceSentAt, 0);
    assert.deepStrictEqual(g.lastPresenceSentSummary, []);

    const oldSocket = {};
    const newSocket = {};
    let finishWrite;
    g.ws = oldSocket;
    g.send = (_payload, done) => { finishWrite = done; return true; };
    g.sendPresence();
    g.ws = newSocket;
    finishWrite(null, oldSocket);
    assert.strictEqual(g.lastPresenceSentAt, 0, 'callback dari socket lama tidak memperbarui diagnostik');
    assert.deepStrictEqual(g.lastPresenceSentSummary, []);

    g.send = () => false;
    assert.strictEqual(g.sendPresence(), false, 'socket tertutup ditolak sebelum antrean');
    assert.strictEqual(g.lastPresenceSentAt, 0);
    assert.deepStrictEqual(g.lastPresenceSentSummary, []);
  });

  await test('close dari socket lama tidak membersihkan socket terbaru', () => {
    const g = makeGateway();
    const current = { removeAllListeners() { throw new Error('current socket must remain'); }, terminate() { throw new Error('current socket must remain'); } };
    const stale = {};
    g.ws = current;
    g.identified = true;
    assert.strictEqual(g.cleanupSocket(stale), false);
    assert.strictEqual(g.ws, current);
    assert.strictEqual(g.identified, true);
  });

  await test('mengabaikan status yang tidak dikenal tanpa merusak status sekarang', () => {
    const g = makeGateway('online');
    g.sessionId = 'vps-session';
    g.identified = true;
    g.sendPresence = () => {};
    g.handlePayload({
      op: 0, t: 'SESSIONS_REPLACE', s: 8,
      d: [{ session_id: 'app-session', status: 'busy', active: true }],
    });
    assert.strictEqual(g.presenceStatus, 'online');
  });

  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
  process.exit(process.exitCode || 0);
})();
