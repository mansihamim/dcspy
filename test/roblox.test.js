'use strict';

/**
 * Test RobloxPresence — memastikan aktivitas "Playing Roblox" benar.
 * Jalankan: npm run test:roblox
 */

const assert = require('assert');
const { RobloxPresence, parsePresence, describePresence, PRESENCE_TYPE } = require('../src/roblox');

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Modul roblox mengambil `request` dari http.js saat di-require.
 * Jadi setelah memasang mock, modulnya harus di-require ulang (cache dibuang).
 */
function freshRobloxModule() {
  delete require.cache[require.resolve('../src/roblox')];
  return require('../src/roblox');
}

const baseCfg = {
  enabled: true,
  mode: 'manual',
  name: 'Roblox',
  game: '',
  cookie: '',
  userId: '',
  pollSec: 30,
  userAgent: 'test-agent',
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('roblox.test.js — aktivitas "Playing Roblox"\n');

  /* ------------------------- parsing respons API ------------------------- */

  await test('parsePresence: main game (type 2) + nama game', () => {
    const json = {
      userPresences: [{
        userPresenceType: 2,
        lastLocation: '[Leaderboards!] The Rake REMASTERED',
        placeId: 2413927524,
        rootPlaceId: 2413927524,
        gameId: '436735c2-7010-4dd0-83a1-0e3af1510779',
        universeId: 847722000,
        userId: 1843923756,
      }],
    };
    const p = parsePresence(json, 1843923756);
    assert.strictEqual(p.type, 2);
    assert.strictEqual(p.location, '[Leaderboards!] The Rake REMASTERED');
    assert.strictEqual(p.universeId, 847722000);
    const d = describePresence(p);
    assert.strictEqual(d.visible, true);
    assert.strictEqual(d.game, '[Leaderboards!] The Rake REMASTERED');
  });

  await test('parsePresence: pilih user yang benar dari banyak entri', () => {
    const json = { userPresences: [
      { userPresenceType: 0, lastLocation: 'Website', userId: 111 },
      { userPresenceType: 2, lastLocation: 'Blox Fruits', universeId: 2753915549, userId: 222 },
    ] };
    const p = parsePresence(json, 222);
    assert.strictEqual(p.type, PRESENCE_TYPE.IN_GAME);
    assert.strictEqual(p.location, 'Blox Fruits');
    assert.strictEqual(parsePresence(json, 111).type, 0);
  });

  await test('parsePresence: tidak memakai presence user lain bila target tidak ada', () => {
    const json = { userPresences: [
      { userPresenceType: 2, lastLocation: 'Game milik orang lain', userId: 111 },
    ] };
    assert.strictEqual(parsePresence(json, 222).type, null);
    assert.strictEqual(parsePresence({ userPresences: [{ userPresenceType: 2, userId: null }] }, 222).type, null);
  });

  await test('describePresence: offline/invisible -> tidak tampil', () => {
    assert.deepStrictEqual(describePresence({ type: 0 }), { visible: false, game: '' });
    assert.deepStrictEqual(describePresence({ type: 4 }), { visible: false, game: '' });
    assert.deepStrictEqual(describePresence({ type: null }), { visible: false, game: '' });
  });

  await test('describePresence: online di website -> tampil tanpa nama game', () => {
    assert.deepStrictEqual(describePresence({ type: 1, location: 'Website' }), { visible: true, game: '' });
  });

  await test('describePresence: di Roblox Studio -> "Roblox Studio"', () => {
    assert.deepStrictEqual(describePresence({ type: 3 }), { visible: true, game: 'Roblox Studio' });
  });

  await test('parsePresence: respons kosong / error tidak bikin crash', () => {
    for (const bad of [null, {}, { userPresences: [] }, { error: 'Unauthorized' }]) {
      const p = parsePresence(bad, 123);
      assert.strictEqual(p.type, null);
    }
  });

  /* --------------------------- bentuk aktivitas -------------------------- */

  await test('mode manual: aktivitas "Playing Roblox" tanpa kredensial', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg } });
    await rb.start();
    const act = rb.activity();
    assert.strictEqual(act.name, 'Roblox');
    assert.strictEqual(act.type, 0, 'type 0 = Playing');
    assert.ok(act.timestamps.start > 0, 'ada timer berjalan');
    assert.strictEqual(act.details, undefined, 'tanpa nama game kalau tidak diisi');
    rb.stop();
  });

  await test('mode manual + ROBLOX_GAME: ada baris kedua', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, game: 'Blox Fruits' } });
    await rb.start();
    const act = rb.activity();
    assert.strictEqual(act.name, 'Roblox');
    assert.strictEqual(act.details, 'Blox Fruits');
    rb.stop();
  });

  await test('showGame=false -> hanya "Playing ROBLOX" (tanpa details, tanda Rich Presence hilang)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, showGame: false } });
    await rb.start();
    rb.update(true, 'The Hunt: Roblox 20', 'tes');
    const act = rb.activity();
    assert.strictEqual(act.name, 'Roblox');
    assert.strictEqual(act.details, undefined, 'tidak ada baris nama game');
    assert.ok(act.timestamps.start > 0, 'timer tetap jalan');
    rb.stop();
  });

  await test('timer TIDAK reset saat nama game berubah (masih main)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg } });
    await rb.start();
    rb.update(true, 'Blox Fruits', 'tes');
    const t1 = rb.activity().timestamps.start;
    await new Promise((r) => setTimeout(r, 30));
    rb.update(true, 'Grow a Garden', 'tes'); // ganti game
    const t2 = rb.activity().timestamps.start;
    assert.strictEqual(t2, t1, 'timer tetap berjalan walau game berganti');
    rb.stop();
  });

  await test('timer TIDAK balik ke 0 kalau presence sempat hilang sebentar (< grace)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, timerGraceMin: 10 } });
    await rb.start();
    rb.update(true, 'Blox Fruits', 'tes');
    const t1 = rb.activity().timestamps.start;
    rb.update(false, '', 'tes'); // keluar sebentar (mis. ganti server/loading)
    await new Promise((r) => setTimeout(r, 30));
    rb.update(true, 'Blox Fruits', 'tes'); // balik main
    const t2 = rb.activity().timestamps.start;
    assert.strictEqual(t2, t1, 'timer lanjut, tidak mulai dari 0');
    rb.stop();
  });

  await test('timer direset kalau jeda main sudah lama (> grace)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, timerGraceMin: 0 } });
    await rb.start();
    rb.update(true, 'Blox Fruits', 'tes');
    const t1 = rb.activity().timestamps.start;
    rb.update(false, '', 'tes');
    await new Promise((r) => setTimeout(r, 30));
    rb.update(true, 'Blox Fruits', 'tes');
    const t2 = rb.activity().timestamps.start;
    assert.ok(t2 > t1, 'jeda panjang -> timer baru');
    rb.stop();
  });

  await test('aktivitas meniru struktur native: id 16 hex, session_id 32 hex, official_game_id null', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, appId: '363445589247131668' } });
    await rb.start();
    const act = rb.activity();
    assert.match(act.id, /^[0-9a-f]{16}$/, 'id 16 hex seperti aktivitas Roblox native');
    assert.match(act.session_id, /^[0-9a-f]{32}$/, 'session_id 32 hex');
    assert.strictEqual(act.official_game_id, null);
    assert.strictEqual(act.application_id, '363445589247131668');
    rb.stop();
  });

  await test('application_id Roblox dipasang -> logo resmi (bukan gambar rusak)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, appId: '363445589247131668' } });
    await rb.start();
    const act = rb.activity();
    assert.strictEqual(act.application_id, '363445589247131668', 'app id Roblox resmi');
    assert.strictEqual(act.name, 'Roblox');
    assert.strictEqual(act.type, 0);
    rb.stop();
  });

  await test('appId kosong -> tidak ada application_id (blok itu dibuang)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, appId: '' } });
    await rb.start();
    const act = rb.activity();
    assert.strictEqual(act.application_id, undefined);
    rb.stop();
  });

  await test('nonaktif -> tidak ada aktivitas', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, enabled: false } });
    await rb.start();
    assert.strictEqual(rb.activity(), null);
    rb.stop();
  });

  await test('mode auto tanpa cookie/user id -> tidak ada aktivitas (dan tidak crash)', async () => {
    const rb = new RobloxPresence({ logger: log, cfg: { ...baseCfg, mode: 'auto' } });
    await rb.start();
    assert.strictEqual(rb.activity(), null);
    rb.stop();
  });

  /* --------------------------- mode auto (mock) -------------------------- */

  await test('mode auto: mengikuti game yang sedang dimainkan, lalu hilang saat berhenti', async () => {
    const http = require('../src/http');
    const original = http.request;
    let inGame = true;

    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        const presence = inGame
          ? { userPresenceType: 2, lastLocation: 'Grow a Garden', placeId: 1, rootPlaceId: 1, universeId: 3327674666, gameId: 'x', userId: 999 }
          : { userPresenceType: 0, lastLocation: 'Website', placeId: null, rootPlaceId: null, universeId: null, gameId: null, userId: 999 };
        return { status: 200, ok: true, json: { userPresences: [presence] }, body: '', headers: {} };
      }
      if (url.includes('games.roblox.com')) {
        return { status: 200, ok: true, json: { data: [{ name: 'Grow a Garden', id: 3327674666 }] }, body: '', headers: {} };
      }
      return original(method, url);
    };

    const { RobloxPresence: Fresh } = freshRobloxModule();
    const cfg = { ...baseCfg, mode: 'auto', cookie: '_|WARNING:-DO-NOT-SHARE-|abc', userId: '999', pollSec: 15 };
    const rb = new Fresh({ logger: log, cfg });
    const changes = [];
    rb.on('change', () => changes.push(rb.activity() ? rb.activity().details : null));

    await rb.start();
    const act = rb.activity();
    assert.ok(act, 'aktivitas harus ada saat in-game');
    assert.strictEqual(act.name, 'Roblox');
    assert.strictEqual(act.details, 'Grow a Garden', 'pakai nama resmi dari API games');
    assert.ok(act.timestamps.start > 0);

    // user berhenti main -> aktivitas harus hilang
    inGame = false;
    await rb.poll();
    assert.strictEqual(rb.activity(), null, 'aktivitas hilang saat berhenti main');
    assert.deepStrictEqual(changes, ['Grow a Garden', null]);
    rb.stop();
    http.request = original;
  });

  await test('mode auto: cookie salah (401) -> tidak crash, hanya peringatan', async () => {
    const http = require('../src/http');
    const original = http.request;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        return { status: 401, ok: false, json: null, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const cfg = { ...baseCfg, mode: 'auto', cookie: 'salah', userId: '999' };
    const rb = new Fresh({ logger: log, cfg });
    await rb.start();
    assert.strictEqual(rb.activity(), null);
    assert.ok(rb.failCount > 0, 'kegagalan dicatat');
    rb.stop();
    http.request = original;
  });

  await test('tanpa cookie pun tetap dapat tipe & nama game (fallback lastLocation)', async () => {
    const http = require('../src/http');
    const original = http.request;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        // Roblox bisa mengembalikan universeId null untuk request tanpa cookie,
        // tapi lastLocation tetap berisi nama game.
        return { status: 200, ok: true, json: { userPresences: [{
          userPresenceType: 2, lastLocation: 'Steal a Brainrot', placeId: null, rootPlaceId: null,
          gameId: null, universeId: null, userId: 999 }] }, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', cookie: '', userId: '999' } });
    await rb.start();
    assert.ok(rb.activity(), 'aktivitas harus tampil');
    assert.strictEqual(rb.activity().details, 'Steal a Brainrot');
    rb.stop();
    http.request = original;
  });

  await test('nama game diambil dari Roblox resmi via placeId -> universeId', async () => {
    const http = require('../src/http');
    const original = http.request;
    const calls = [];
    http.request = async (method, url) => {
      calls.push(url);
      if (url.includes('presence.roblox.com')) {
        return { status: 200, ok: true, json: { userPresences: [{
          userPresenceType: 2, lastLocation: 'nama dari server', placeId: 2413927524,
          rootPlaceId: 2413927524, gameId: 'g', universeId: null, userId: 999 }] }, body: '', headers: {} };
      }
      if (url.includes('apis.roblox.com/universes/v1/places/')) {
        return { status: 200, ok: true, json: { universeId: 847722000 }, body: '', headers: {} };
      }
      if (url.includes('games.roblox.com')) {
        return { status: 200, ok: true, json: { data: [{ name: 'The Rake REMASTERED' }] }, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', cookie: '', userId: '999' } });
    await rb.start();
    assert.strictEqual(rb.activity().details, 'The Rake REMASTERED', 'harus pakai nama RESMI Roblox');
    assert.ok(calls.some((u) => u.includes('apis.roblox.com/universes/v1/places/2413927524/universe')));
    assert.ok(calls.some((u) => u.includes('games.roblox.com/v1/games?universeIds=847722000')));
    rb.stop();
    http.request = original;
  });

  await test('"Website" (cuma buka Roblox) tidak dianggap nama game', async () => {
    const http = require('../src/http');
    const original = http.request;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        return { status: 200, ok: true, json: { userPresences: [{
          userPresenceType: 1, lastLocation: 'Website', placeId: null, rootPlaceId: null,
          gameId: null, universeId: null, userId: 999 }] }, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', cookie: '', userId: '999' } });
    await rb.start();
    const act = rb.activity();
    assert.ok(act, 'tetap "Playing Roblox" saat hanya membuka Roblox');
    assert.strictEqual(act.details, undefined, 'tidak boleh menampilkan kata "Website" sebagai game');
    rb.stop();
    http.request = original;
  });

  await test('jendela anti-kedip: aktivitas bertahan sebentar lalu hilang', async () => {
    const http = require('../src/http');
    const original = http.request;
    let inGame = true;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        return { status: 200, ok: true, json: { userPresences: [{
          userPresenceType: inGame ? 2 : 0, lastLocation: inGame ? 'Adopt Me!' : 'Website',
          placeId: null, rootPlaceId: null, gameId: null, universeId: null, userId: 999 }] }, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();

    // sticky 2 menit: setelah berhenti main, aktivitas masih tampil
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', cookie: '', userId: '999', stickyMin: 2 } });
    await rb.start();
    assert.strictEqual(rb.activity().details, 'Adopt Me!');
    inGame = false;
    await rb.poll();
    assert.strictEqual(rb.activity().details, 'Adopt Me!', 'masih tampil dalam jendela anti-kedip');
    rb.stop();

    // sticky dimatikan (0 menit): langsung hilang
    const rb2 = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', cookie: '', userId: '999', stickyMin: 0 } });
    await rb2.start();
    await rb2.poll();
    assert.strictEqual(rb2.activity(), null, 'sticky 0 = langsung hilang saat berhenti main');
    rb2.stop();
    http.request = original;
  });

  await test('poll Roblox tidak menumpuk saat API lambat dan diagnostik mencatat hasil', async () => {
    const http = require('../src/http');
    const original = http.request;
    let calls = 0;
    let selesai;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        calls += 1;
        return new Promise((resolve) => { selesai = resolve; });
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', userId: '999', pollSec: 15 } });
    const first = rb.poll();
    await Promise.resolve();
    await rb.poll();
    assert.strictEqual(calls, 1, 'request kedua dilewati selama poll pertama masih berjalan');
    selesai({
      status: 200, ok: true,
      json: { userPresences: [{ userId: 999, userPresenceType: 2, lastLocation: 'Fish It!' }] },
      body: '', headers: {},
    });
    await first;
    assert.strictEqual(rb.visible, true);
    assert.strictEqual(rb.lastPollStatus, 200);
    assert.ok(rb.lastPollOk > 0);
    assert.strictEqual(rb.status().inFlight, false);
    assert.strictEqual(rb.status().active, true);
    rb.stop();
    http.request = original;
  });

  await test('HTTP 200 tanpa user target tidak menghapus game Roblox yang terakhir valid', async () => {
    const http = require('../src/http');
    const original = http.request;
    http.request = async (method, url) => {
      if (url.includes('presence.roblox.com')) {
        return { status: 200, ok: true, json: { userPresences: [
          { userPresenceType: 2, lastLocation: 'presence orang lain', userId: 123 },
        ] }, body: '', headers: {} };
      }
      return original(method, url);
    };
    const { RobloxPresence: Fresh } = freshRobloxModule();
    const rb = new Fresh({ logger: log, cfg: { ...baseCfg, mode: 'auto', userId: '999' } });
    rb.update(true, 'Fish It!', 'test');
    await rb.poll();
    assert.strictEqual(rb.game, 'Fish It!');
    assert.strictEqual(rb.visible, true);
    assert.match(rb.status().lastError, /tidak ada/i);
    assert.strictEqual(rb.status().failures, 1);
    rb.stop();
    http.request = original;
  });

  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
  process.exit(process.exitCode || 0);
})();
