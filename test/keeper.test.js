'use strict';

/**
 * Test StatusKeeper (penjaga status) dengan Discord API tiruan.
 * Jalankan: npm test
 *
 * Yang diuji:
 *  1. Status yang dipakai sekarang otomatis dikunci + dijadikan permanen
 *  2. Mode keep : status DIHAPUS -> tetap terhapus (tidak dipasang ulang)
 *  3. Mode keep : setelah dihapus, status baru dari aplikasi dikunci lagi
 *  4. Mode enforce : status yang dihapus dipasang ulang
 *  5. Mode patok (CUSTOM_STATUS_TEXT) : selalu dikembalikan ke teks itu
 *  6. Restart setelah dihapus tidak membangkitkan status lama
 */

const assert = require('assert');

/* --- Pasang Discord API tiruan SEBELUM settings.js dimuat ---------------- */

const http = require('../src/http');
const proto = require('../src/proto');

const server = {
  settings: proto.encodeFields([
    proto.bytesField(2, Buffer.from('setting lain milik user', 'utf8')),
    proto.bytesField(23, Buffer.from([0x0a, 0x01, 0x07])),
  ]),
  patchCount: 0,
  calls: [],
};

http.request = async (method, url, opts = {}) => {
  server.calls.push(`${method} ${url}`);
  if (url.includes('/users/@me/settings-proto/1')) {
    if (method === 'GET') {
      return { status: 200, ok: true, json: { settings: server.settings.toString('base64') }, body: '', headers: {} };
    }
    const body = JSON.parse(opts.body);
    server.settings = Buffer.from(body.settings, 'base64');
    server.patchCount += 1;
    return { status: 200, ok: true, json: { settings: body.settings }, body: '', headers: {} };
  }
  return { status: 404, ok: false, json: null, body: '', headers: {} };
};
http.patchJson = async (url, payload, headers) =>
  http.request('PATCH', url, { headers, body: JSON.stringify(payload) });
http.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { StatusKeeper } = require('../src/settings');

/* ------------------------------- Utilitas -------------------------------- */

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiap keeper pakai folder data sendiri supaya test tidak saling bau file kunci.
let dataCounter = 0;
const os = require('os');
const fsp = require('fs');
const path = require('path');
const freshDataDir = () => {
  const dir = path.join(os.tmpdir(), `dc-keep-test-${process.pid}-${++dataCounter}`);
  fsp.rmSync(dir, { recursive: true, force: true });
  return dir;
};

function makeCfg(overrides = {}) {
  return {
    enabled: true,
    mode: 'keep',
    text: '',
    emojiName: '',
    emojiId: '',
    enforce: false,
    neverExpire: true,
    refreshMin: 60,
    presence: true,
    persistStatus: true,
    pinned: false,
    ...overrides,
  };
}

function makeKeeper(cfg) {
  return new StatusKeeper({
    token: 'token-palsu',
    logger: log,
    apiVersion: 9,
    dataDir: freshDataDir(),
    cfg,
    status: 'dnd',
  });
}

const onServer = () => proto.readCustomStatus(server.settings);
const patchCount = () => server.patchCount;

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

/* --------------------------------- Test ---------------------------------- */

(async () => {
  console.log('keeper.test.js — status permanen & bisa dihapus\n');

  await test('status yang dipakai sekarang dikunci + dibuat permanen', async () => {
    server.settings = proto.upsertCustomStatus(server.settings, {
      text: 'sibuk, balas lambat',
      emojiName: '📵',
      expiresAtMs: Date.now() + 3_600_000, // dari app: "Clear after 1 hour"
    });

    const keeper = makeKeeper(makeCfg());
    await keeper.init();

    const read = onServer();
    assert.strictEqual(read.text, 'sibuk, balas lambat');
    assert.strictEqual(read.emojiName, '📵');
    assert.strictEqual(read.expiresAtMs, 0, 'harus jadi permanen (Don\'t clear)');
    assert.strictEqual(proto.readPresenceStatus(server.settings), 'dnd', 'pilihan status dnd ikut tersimpan');
    keeper.stop();
  });

  await test('status awal dibaca dari settings proto agar VPS mulai sesuai pilihan di app', async () => {
    server.settings = proto.setPresenceStatusSetting(server.settings, 'idle');
    server.settings = proto.upsertCustomStatus(server.settings, {
      text: 'status ada', emojiName: '', emojiId: '', expiresAtMs: 0,
    });
    const keeper = makeKeeper(makeCfg());
    await keeper.init();
    assert.strictEqual(keeper.settingsPresenceStatus, 'idle');
    assert.strictEqual(keeper.presenceStatus, 'idle');
    server.settings = proto.setPresenceStatusSetting(server.settings, 'dnd');
    keeper.stop();
  });

  await test('mode keep: status DIHAPUS kamu -> tidak dipasang ulang', async () => {
    const keeper = makeKeeper(makeCfg());
    keeper.target = { text: 'sibuk, balas lambat', emojiName: '', emojiId: '' };
    keeper.saveLock(true); // seolah-olah sudah terpasang sebelumnya
    keeper.suppressUntil = 0;

    server.settings = proto.clearCustomStatus(server.settings); // kamu hapus di aplikasi
    const before = patchCount();
    keeper.handleSettingsEvent(server.settings.toString('base64'));

    await wait(3500); // tunggu kalau-kalau ada apply yang nyangkut

    assert.strictEqual(patchCount(), before, 'tidak boleh ada PATCH (status tidak dipasang ulang)');
    assert.strictEqual(onServer().found, false, 'status harus tetap terhapus');
    assert.strictEqual(keeper.hasTarget, false, 'kunci status harus dilepas');
    assert.strictEqual(keeper.currentActivity(), null, 'presence tidak boleh lagi memuat custom status');
    assert.ok(!fsp.existsSync(keeper.lockFile), 'file kunci harus dihapus supaya tidak bangkit saat restart');

    // pengecekan berkala juga tidak boleh membangkitkannya
    await keeper.tick();
    await wait(3200);
    assert.strictEqual(onServer().found, false, 'tick tidak boleh memasang ulang status');
    keeper.stop();
  });

  await test('mode keep: setelah dihapus, status baru di aplikasi dikunci lagi', async () => {
    const keeper = makeKeeper(makeCfg());
    keeper.target = { text: '', emojiName: '', emojiId: '' };
    keeper.suppressUntil = 0;

    server.settings = proto.upsertCustomStatus(server.settings, {
      text: 'lagi di luar kota',
      expiresAtMs: Date.now() + 86_400_000,
    });
    keeper.handleSettingsEvent(server.settings.toString('base64'));
    await wait(3200);

    assert.strictEqual(keeper.target.text, 'lagi di luar kota', 'status baru harus dikunci');
    assert.strictEqual(onServer().text, 'lagi di luar kota');
    assert.strictEqual(onServer().expiresAtMs, 0, 'expiry dinormalkan jadi permanen');
    keeper.stop();
  });

  await test('mode enforce: status yang dihapus dipasang ulang', async () => {
    const keeper = makeKeeper(makeCfg({ mode: 'enforce', enforce: true }));
    keeper.target = { text: 'selalu ada', emojiName: '', emojiId: '' };
    keeper.saveLock(true);
    keeper.suppressUntil = 0;

    server.settings = proto.clearCustomStatus(server.settings);
    keeper.handleSettingsEvent(server.settings.toString('base64'));
    await wait(3200);

    assert.strictEqual(onServer().found, true, 'status harus muncul lagi');
    assert.strictEqual(onServer().text, 'selalu ada');
    assert.strictEqual(onServer().expiresAtMs, 0);
    keeper.stop();
  });

  await test('mode patok (CUSTOM_STATUS_TEXT): selalu dikembalikan', async () => {
    const keeper = makeKeeper(makeCfg({ text: 'fokus kerja', pinned: true, mode: 'keep' }));
    await keeper.init();
    assert.strictEqual(onServer().text, 'fokus kerja');

    keeper.suppressUntil = 0;
    server.settings = proto.upsertCustomStatus(server.settings, { text: 'diganti orang lain' });
    keeper.handleSettingsEvent(server.settings.toString('base64'));
    await wait(3200);
    assert.strictEqual(onServer().text, 'fokus kerja', 'harus kembali ke status config');
    keeper.stop();
  });

  await test('restart setelah dihapus: status lama tidak dibangkitkan', async () => {
    // Kondisi: file kunci masih ada (mis. script mati mendadak) tapi status di akun sudah kosong
    server.settings = proto.clearCustomStatus(server.settings);
    const dir = freshDataDir();
    const keeperA = new StatusKeeper({
      token: 'token-palsu', logger: log, apiVersion: 9, dataDir: dir, cfg: makeCfg(), status: 'dnd',
    });
    keeperA.target = { text: 'status lama', emojiName: '', emojiId: '' };
    keeperA.saveLock(true); // pernah terpasang
    keeperA.stop();

    const before = patchCount();
    const keeperB = new StatusKeeper({
      token: 'token-palsu', logger: log, apiVersion: 9, dataDir: dir, cfg: makeCfg(), status: 'dnd',
    });
    await keeperB.init();
    await wait(500);

    assert.strictEqual(onServer().found, false, 'status lama tidak boleh muncul lagi');
    assert.strictEqual(patchCount(), before, 'tidak ada penulisan ulang status');
    assert.strictEqual(keeperB.hasTarget, false, 'kunci dilepas saat start');
    keeperB.stop();
  });

  await test('presence aktivitas (tipe 4) berisi teks status', async () => {
    const keeper = makeKeeper(makeCfg({ text: 'fokus kerja', pinned: true }));
    await keeper.init();
    const act = keeper.currentActivity();
    assert.strictEqual(act.type, 4);
    assert.strictEqual(act.state, 'fokus kerja');
    keeper.stop();
  });

  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
})();
