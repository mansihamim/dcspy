'use strict';

/**
 * Tes modul tunnel (src/tunnel.js) — tanpa jaringan & tanpa menjalankan cloudflared.
 * Yang diuji: pengurai URL, keadaan awal, dan integrasi ke /api/status.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Tunnel, urlDari } = require('../src/tunnel');
const { createDashboard } = require('../src/dashboard');
const { Ps5Presence } = require('../src/ps5');

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ✔ ' + name); }
  catch (err) { console.log('  ✖ ' + name + '\n    ' + err.message); process.exitCode = 1; }
}

(async () => {
  console.log('== Tes Tunnel ==');

  await test('urlDari(): mengambil URL trycloudflare dari keluaran cloudflared', () => {
    assert.strictEqual(urlDari('INF +https://dua-tiga-empat.trycloudflare.com'), 'https://dua-tiga-empat.trycloudflare.com');
    assert.strictEqual(urlDari('2026-10-01 INF |  https://abc-def.trycloudflare.com  |'), 'https://abc-def.trycloudflare.com');
  });

  await test('urlDari(): aman kalau belum ada URL', () => {
    assert.strictEqual(urlDari(''), '');
    assert.strictEqual(urlDari('menghubungkan...'), '');
    assert.strictEqual(urlDari('https://contoh.com/bukan-tunnel'), '');
  });

  await test('Tunnel: mati -> tidak melakukan apa-apa', async () => {
    const t = new Tunnel({ logger: log, port: 23304, aktif: false });
    await t.start();
    assert.strictEqual(t.info.jalan, false);
    assert.strictEqual(t.info.url, '');
    assert.strictEqual(t.info.aktif, false);
    t.stop();
  });

  await test('Tunnel: laporan URL dilewati kalau alamat pelapor kosong (tanpa jaringan)', async () => {
    const t = new Tunnel({ logger: log, port: 23304, laporUrl: '', laporSecret: 'x' });
    t.url = 'https://contoh-tunnel.trycloudflare.com';
    await t._lapor(); // tidak boleh melempar error walau tanpa jaringan
    assert.ok(true);
  });

  await test('/api/status memuat info tunnel', async () => {
    const ps5 = new Ps5Presence({ logger: log, cfg: { enabled: false, game: 'Fortnite', appId: '', details: '', platform: 'ps5', timer: true, officialName: true } });
    const tiruan = { info: { aktif: true, jalan: true, url: 'https://aaa-bbb.trycloudflare.com', log: [] } };
    const envFile = path.join(os.tmpdir(), 'tunnel-test-' + process.pid + '.env');
    fs.writeFileSync(envFile, 'STATUS=idle\n');
    const d = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: 'k' }, log, ps5,
      roblox: {}, gateway: { requestPresencePush() {} }, quest: null, tunnel: tiruan, envFile,
    });
    const srv = d.start();
    await new Promise((r) => setTimeout(r, 250));
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/status`, { headers: { 'x-dash-key': 'k' } })).json();
    assert.strictEqual(st.tunnel.url, 'https://aaa-bbb.trycloudflare.com');
    assert.strictEqual(st.tunnel.jalan, true);
    d.stop();
    fs.unlinkSync(envFile);
  });

  await test('tanpa tunnel: /api/status tetap jalan (tunnel = null)', async () => {
    const ps5 = new Ps5Presence({ logger: log, cfg: { enabled: false, game: 'Fortnite', appId: '', details: '', platform: 'ps5', timer: true, officialName: true } });
    const envFile = path.join(os.tmpdir(), 'tunnel-test2-' + process.pid + '.env');
    fs.writeFileSync(envFile, 'STATUS=idle\n');
    const d = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: 'k' }, log, ps5,
      roblox: {}, gateway: { requestPresencePush() {} }, quest: null, envFile,
    });
    const srv = d.start();
    await new Promise((r) => setTimeout(r, 250));
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/status`, { headers: { 'x-dash-key': 'k' } })).json();
    assert.strictEqual(st.tunnel, null);
    d.stop();
    fs.unlinkSync(envFile);
  });

  console.log(`\n${passed} test lulus.`);
})();
