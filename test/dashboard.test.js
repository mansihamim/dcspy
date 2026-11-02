'use strict';

/**
 * Tes dashboard PS5 (src/dashboard.js).
 * Fokus: aturan "wajib pilih game dulu sebelum ON", on/off tanpa restart,
 * ganti game langsung berlaku, kunci dashboard, dan penyimpanan ke .env.
 *
 * CATATAN: tes ini memakai .env TIRUAN (file sementara) — .env asli tidak disentuh.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard, saveEnv } = require('../src/dashboard');
const { Ps5Presence } = require('../src/ps5');

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const KEY = 'kunci-tes-123';
let PORT = 0; // diisi dari port bebas yang dipilih OS
let base = ''; // diisi setelah server jalan

const tmpEnv = path.join(os.tmpdir(), 'dash-test-' + process.pid + '.env');
fs.writeFileSync(tmpEnv, ['STATUS=dnd', 'PS5_ENABLED=true', 'PS5_GAME=Fortnite', 'DEVICE=macos', ''].join('\n'));

const ps5 = new Ps5Presence({
  logger: log,
  cfg: { enabled: false, game: 'Fortnite', appId: '', details: '', platform: 'ps5', timer: true, officialName: true },
});

const roblox = {
  enabled: true,
  visible: true,
  name: 'ROBLOX',
  game: 'Steal An Egg',
  stopped: true,
  pushes: 0,
  status() { return { active: this.visible, lastError: '', lastPollStatus: 200 }; },
  stop() { this.stopped = true; },
  resume() { this.stopped = false; return Promise.resolve(); },
};

const spotify = {
  status() {
    return {
      enabled: true, source: 'polling', playing: false, track: null,
      dealer: { connected: false, ready: false },
      polling: { enabled: true, intervalSec: 5, lastStatus: 200, lastError: '' },
    };
  },
};

const gateway = {
  pushes: 0,
  presenceStatus: 'dnd',
  presenceStatusSource: 'config',
  lastStatusSyncAt: 0,
  lastPresenceSentAt: 123,
  lastPresenceSentSummary: [{ name: 'Spotify', type: 2, syncIdPresent: true, partyIdPresent: true, sessionIdPresent: false }],
  lastOwnSessionPresence: { at: 120, status: 'dnd', activityNames: ['Spotify'], spotifyPresent: true, spotifySyncIdPresent: true, spotifyPartyIdPresent: true },
  lastAggregatePresence: null,
  requestPresencePush() { this.pushes += 1; },
  selfUser: { username: 'floohere.', id: '1120443084858204290' },
};

const dash = createDashboard({
  cfg: { enabled: true, port: PORT, host: '127.0.0.1', key: KEY },
  log, ps5, roblox, spotify, gateway, version: '2.1.0', envFile: tmpEnv,
  onUser: () => ({ tag: 'floohere.', id: '1120443084858204290' }),
});

const H = { 'x-dash-key': KEY, 'Content-Type': 'application/json' };
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
const post = (p, body, headers) =>
  fetch(base + p, { method: 'POST', headers: headers || H, body: JSON.stringify(body || {}) });

const envNow = () => fs.readFileSync(tmpEnv, 'utf8');

let qStub = null;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✔ ' + name);
  } catch (err) {
    console.log('  ✖ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('== Tes Dashboard PS5 ==');
  const server = dash.start();
  await new Promise((r) => setTimeout(r, 250));
  PORT = server.address().port; // port bebas dari OS -> tes tidak bentrok proses lain
  base = `http://127.0.0.1:${PORT}`;

  await test('tanpa kunci -> 401 (dashboard terkunci)', async () => {
    const r = await get('/api/status');
    assert.strictEqual(r.status, 401);
  });

  await test('kunci salah -> 401', async () => {
    const r = await get('/api/status', { 'x-dash-key': 'salah' });
    assert.strictEqual(r.status, 401);
  });

  await test('buka /?k=KUNCI -> dapat cookie + pindah ke /', async () => {
    const r = await fetch(`${base}/?k=${KEY}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get('set-cookie') || '', /ps5dash=/);
  });

  await test('cookie hasil login bisa dipakai (tanpa header)', async () => {
    const r = await fetch(base + '/api/status', { headers: { cookie: `ps5dash=${KEY}` } });
    assert.strictEqual(r.status, 200);
  });

  await test('kunci benar -> status lengkap & bisa dibaca', async () => {
    const r = await get('/api/status', H);
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.on, false, 'awalnya OFF');
    assert.strictEqual(typeof j.uptime, 'number');
    assert.strictEqual(j.user.tag, 'floohere.');
    assert.ok(j.game, 'ada info game');
    assert.strictEqual(j.presenceStatus, 'dnd', 'status gateway terlihat untuk diagnosa sinkronisasi');
    assert.strictEqual(j.presenceDiagnostics.sentActivities[0].name, 'Spotify');
    assert.strictEqual(j.presenceDiagnostics.sentActivities[0].syncIdPresent, true);
    assert.strictEqual(j.presenceDiagnostics.selfSession.spotifyPresent, true);
    assert.strictEqual(j.roblox.active, true, 'aktif dibaca dari visible Roblox yang sebenarnya');
    assert.strictEqual(j.roblox.health.lastPollStatus, 200, 'health poll Roblox tersedia');
    assert.strictEqual(j.spotify.source, 'polling', 'diagnostik Spotify tersedia di status API');
    assert.strictEqual(j.spotify.polling.lastStatus, 200);
  });

  await test('ON tanpa pilih game -> DITOLAK 400 (wajib pilih game dulu)', async () => {
    const r = await post('/api/on', {});
    const j = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(j.error, /pilih game/i);
    assert.strictEqual(ps5.cfg.enabled, false, 'mode PS5 tetap OFF');
    assert.strictEqual(envNow().includes('PS5_ENABLED=true'), true, '.env tidak diubah jadi ON');
  });

  await test('ON dengan game -> nyala + nama/ikon resmi + Roblox dijeda', async () => {
    const r = await post('/api/on', { game: 'spider-man' });
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.on, true);
    assert.strictEqual(j.game.name, 'Marvel’s Spider-Man Remastered', 'nama resmi Discord');
    assert.strictEqual(j.game.id, '1124351769175150702', 'ikon resmi (id aplikasi)');
    assert.strictEqual(j.roblox.paused, true, 'polling Roblox berhenti (hemat)');
    assert.ok(j.game.icon.startsWith('https://cdn.discordapp.com/app-icons/'), 'ikon resmi Discord');
  });

  await test('ON mengirim presence ke Discord & menyimpan ke .env', async () => {
    assert.ok(gateway.pushes > 0, 'presence diminta ulang');
    const env = envNow();
    assert.match(env, /^PS5_ENABLED=true$/m);
    assert.match(env, /^PS5_GAME=Marvel’s Spider-Man Remastered$/m);
    assert.match(env, /^STATUS=dnd$/m, 'baris .env lain tidak disentuh');
    assert.match(env, /^DEVICE=macos$/m);
  });

  await test('ON lagi dengan game lain -> game berganti otomatis (tanpa restart)', async () => {
    const r = await post('/api/game', { game: 'gta 5' });
    const j = await r.json();
    assert.strictEqual(j.game.name, 'Grand Theft Auto V Legacy');
    assert.strictEqual(j.game.id, '1402418714716143646');
    assert.match(envNow(), /^PS5_GAME=Grand Theft Auto V Legacy$/m);
  });

  await test('game di luar daftar -> tetap boleh ON, tanpa ikon', async () => {
    const r = await post('/api/game', { game: 'Game Karangan' });
    const j = await r.json();
    assert.strictEqual(j.game.name, 'Game Karangan');
    assert.strictEqual(j.game.id, null);
    assert.strictEqual(j.game.icon, '');
  });

  await test('OFF -> mode PS5 mati, Roblox lanjut dipantau', async () => {
    const r = await post('/api/off', {});
    const j = await r.json();
    assert.strictEqual(j.on, false);
    assert.strictEqual(j.roblox.paused, false, 'Roblox jalan lagi');
    assert.match(envNow(), /^PS5_ENABLED=false$/m);
    assert.match(envNow(), /^PS5_GAME=/m, 'game terakhir tetap disimpan');
    assert.strictEqual(ps5.activity(), null, 'tidak ada aktivitas PS5 dikirim');
  });

  await test('daftar game: semua entri punya ikon resmi & id tidak ganda', async () => {
    const j = await (await get('/api/games?semua=1', H)).json();
    const { GAMES } = require('../src/ps5');
    assert.strictEqual(j.total, GAMES.length, 'jumlah total = jumlah di tabel game');
    assert.ok(j.total >= 1000, 'minimal 1000 game, sekarang ' + j.total);
    const noIcon = j.games.filter((g) => !/cdn\.discordapp\.com\/app-icons\/\d+\/.+\.png/.test(g.u));
    assert.strictEqual(noIcon.length, 0, 'ikon resmi lengkap: ' + noIcon.map((g) => g.n).join(', '));
    const ids = new Set(j.games.map((g) => g.i));
    assert.strictEqual(ids.size, j.total, 'tidak ada id ganda');
  });

  await test('daftar dibatasi (hemat kuota HP) & urut yang rilis dulu', async () => {
    const j = await (await get('/api/games', H)).json();
    assert.strictEqual(j.count, 60, 'default kirim 60 game saja');
    assert.strictEqual(j.games[0].r, 1, 'yang sudah rilis di atas');
    const adaMati = j.games.some((g, i) => g.r === 0 && j.games.slice(0, i).some((x) => x.r === 1));
    assert.strictEqual(adaMati, false, 'yang belum rilis taruh di bawah');
  });

  await test('filter tahun dari server (2026) + hitungan belum rilis', async () => {
    const j = await (await get('/api/games?tahun=2026&limit=200', H)).json();
    assert.ok(j.cocok >= 100, 'game 2026: ' + j.cocok);
    assert.ok(j.games.every((g) => g.y === 2026), 'semua hasil bertahun 2026');
    assert.ok(j.belumRilis >= 10, 'ada game belum rilis: ' + j.belumRilis);
  });

  await test('pencarian dari server (alias juga): "gta 6", "nba", "forza"', async () => {
    const g1 = await (await get('/api/games?q=gta%206', H)).json();
    assert.ok(g1.games.some((g) => g.n === 'Grand Theft Auto VI'), 'gta 6 ketemu');
    const g2 = await (await get('/api/games?q=nba%202k26', H)).json();
    assert.strictEqual(g2.games[0].n, 'NBA 2K26');
    const g3 = await (await get('/api/games?q=forza&limit=50', H)).json();
    assert.ok(g3.games.some((g) => g.n === 'Forza Horizon 6'), 'forza horizon 6 ketemu');
  });

  await test('ON dengan game belum rilis -> DITOLAK (dimatikan/redup)', async () => {
    const r = await post('/api/on', { game: 'Forza Horizon 6' });
    const j = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(j.error, /belum rilis/i);
    assert.strictEqual(ps5.cfg.enabled, false, 'mode PS5 tetap OFF');
  });

  await test('ON ditolak TIDAK merusak state (bug yang diaudit & diperbaiki)', async () => {
    await post('/api/on', { game: 'NBA 2K26' });
    const sebelum = { nama: ps5.name, id: ps5.appId };
    const r = await post('/api/game', { game: 'Grand Theft Auto VI' });
    assert.strictEqual(r.status, 400, 'GTA VI belum rilis -> ditolak');
    assert.strictEqual(ps5.name, sebelum.nama, 'game aktif tidak berubah setelah ditolak');
    assert.strictEqual(ps5.appId, sebelum.id, 'id aplikasi tidak berubah setelah ditolak');
    await post('/api/off', {});
  });

  await test('ON dengan game yang sudah rilis -> lanjut normal', async () => {
    const r = await post('/api/on', { game: 'NBA 2K26' });
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.on, true);
    assert.strictEqual(j.game.name, 'NBA 2K26');
    assert.strictEqual(j.game.released, 1);
    await post('/api/off', {});
  });

  await test('Forza Horizon 6 ada di filter 2026 (permintaan terakhir)', async () => {
    const j = await (await get('/api/games?tahun=2026&limit=200', H)).json();
    const fh6 = j.games.find((g) => g.n === 'Forza Horizon 6');
    assert.ok(fh6, 'Forza Horizon 6 harus ada');
    assert.strictEqual(fh6.y, 2026);
    assert.strictEqual(fh6.r, 0, 'Forza Horizon 6 ditandai belum rilis di PS5');
    assert.ok(fh6.u.startsWith('https://cdn.discordapp.com/app-icons/'), 'ikon resmi ada');
    const daftar2026 = j.games.filter((g) => g.y === 2026).map((g) => g.n);
    assert.ok(daftar2026.includes('Forza Horizon 6'));
    assert.ok(daftar2026.includes('Grand Theft Auto VI'), 'GTA VI (2026) ada');
    assert.ok(daftar2026.length >= 100, 'daftar 2026: ' + daftar2026.length + ' game');
  });

  await test('penjalan quest: daftar, mulai, stop (quest tiruan)', async () => {
    const q = {
      aktif: false, mode: null, sedang: null, antrian: [], selesai: [], gagal: [], mulaiJam: null,
      daftar: async () => ({ ok: true, quests: [
        { id: '111', nama: 'Quest Uji A', appId: '363445589247131668', target: 900, progress: 300, selesai: false, diklaim: false, kedaluwarsa: false, berakhir: '2026-12-31T00:00:00Z', hadiah: '700 Orbs' },
        { id: '222', nama: 'Quest Uji B', appId: '1402418703554842694', target: 900, progress: 900, selesai: true, diklaim: false, kedaluwarsa: false, berakhir: '2026-12-31T00:00:00Z', hadiah: 'Blurple 8-Bit Wings' },
        { id: '333', nama: 'Quest Lewat', appId: '1402418703554842694', target: 900, progress: 0, selesai: false, diklaim: false, kedaluwarsa: true, berakhir: '2026-01-01T00:00:00Z', hadiah: '700 Orbs' },
      ],
      konsol: {
        playstation: { total: 20, lewatDesktop: 20, tanpaDesktop: 0, layak: 0, nama: [] },
        xbox: { total: 13, lewatDesktop: 13, tanpaDesktop: 0, layak: 0, nama: [] },
        lain: { total: 0, lewatDesktop: 0, tanpaDesktop: 0, layak: 0, nama: [] },
      } }),
      mulai: async (qid) => {
        q.aktif = true; q.mode = 'satu';
        q.sedang = { nama: 'Quest Uji A', qid, value: 300, target: 900, hadiah: '700 Orbs' };
        return { ok: true, quest: q.sedang };
      },
      autoMulai: async () => {
        q.aktif = true; q.mode = 'auto'; q.antrian = ['Quest Uji A'];
        q.sedang = { nama: 'Quest Uji A', qid: '111', value: 0, target: 900, hadiah: '700 Orbs' };
        return { ok: true, jumlah: 1, quests: [{ nama: 'Quest Uji A', hadiah: '700 Orbs' }] };
      },
      batal: () => { q.aktif = false; q.mode = null; q.sedang = null; return { ok: true, info: 'dihentikan' }; },
      stop() {},
    };
    qStub = q;
    const d2 = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: KEY },
      log, ps5, roblox, gateway: { requestPresencePush() {} }, quest: q, envFile: tmpEnv,
      onUser: () => ({ tag: 'floohere.' }),
    });
    const srv = d2.start();
    await new Promise((r) => setTimeout(r, 250));
    const base2 = `http://127.0.0.1:${srv.address().port}`;
    const j = await (await fetch(base2 + '/api/quests', { headers: H })).json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.quests.length, 3, 'semua quest desktop dikirim (termasuk yang lewat)');
    assert.ok(j.quests.some((x) => x.selesai), 'ada yang sudah selesai');
    assert.strictEqual(j.quests.filter((x) => x.kedaluwarsa).length, 1, 'yang lewat ditandai kedaluwarsa');
    assert.strictEqual(
      j.quests.filter((x) => !x.selesai && !x.kedaluwarsa).length, 1, 'tinggal 1 yang layak dikerjakan');
    assert.strictEqual(j.konsol.playstation.total, 20, 'quest berjalur PSN dilaporkan terpisah');
    assert.strictEqual(j.konsol.playstation.lewatDesktop, 20, 'semuanya bisa lewat jalur desktop');
    assert.strictEqual(j.konsol.playstation.layak, 0, 'tidak ada quest PSN yang benar-benar mentok');

    const mulai = await (await fetch(base2 + '/api/quest/start', { method: 'POST', headers: H, body: JSON.stringify({ qid: '111' }) })).json();
    assert.strictEqual(mulai.ok, true);
    assert.ok(mulai.quest.nama, 'ada info quest yang jalan');

    const st = await (await fetch(base2 + '/api/status', { headers: H })).json();
    assert.strictEqual(st.quest.qid, '111', 'status menampilkan quest yang sedang jalan');
    assert.strictEqual(st.quest.target, 900);

    const stop = await (await fetch(base2 + '/api/quest/stop', { method: 'POST', headers: H, body: '{}' })).json();
    assert.strictEqual(stop.ok, true);
    srv.close();
  });

  await test('mode otomatis: /api/quest/auto menyalakan & menghentikan', async () => {
    const d3 = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: KEY },
      log, ps5, roblox, gateway: { requestPresencePush() {} }, quest: qStub, envFile: tmpEnv,
      onUser: () => ({ tag: 'floohere.' }),
    });
    const srv = d3.start();
    await new Promise((r) => setTimeout(r, 250));
    const base3 = `http://127.0.0.1:${srv.address().port}`;
    const on = await (await fetch(base3 + '/api/quest/auto', { method: 'POST', headers: H, body: JSON.stringify({ on: true }) })).json();
    assert.strictEqual(on.ok, true, 'otomatis dinyalakan');
    assert.strictEqual(on.jumlah, 1);
    const st = await (await fetch(base3 + '/api/status', { headers: H })).json();
    assert.strictEqual(st.quest.mode, 'auto', 'status menandai mode otomatis');
    assert.ok(Array.isArray(st.quest.antrian), 'ada info antrian');
    const off = await (await fetch(base3 + '/api/quest/auto', { method: 'POST', headers: H, body: JSON.stringify({ on: false }) })).json();
    assert.strictEqual(off.ok, true, 'otomatis dihentikan');
    srv.close();
  });

  await test('port tambahan (DASH_PORT_EXTRA) juga melayani dashboard', async () => {
    const d4 = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: KEY, portExtra: [0] },
      log, ps5, roblox, gateway: { requestPresencePush() {} }, quest: qStub, envFile: tmpEnv,
      onUser: () => ({ tag: 'floohere.' }),
    });
    const srv4 = d4.start();
    await new Promise((r) => setTimeout(r, 300));
    const utama = srv4.address().port;
    const st = await (await fetch(`http://127.0.0.1:${utama}/api/status`, { headers: H })).json();
    assert.ok(Array.isArray(st.dash.ports), 'status melaporkan port yang didengar');
    assert.strictEqual(st.dash.ports.length, 2, 'port utama + 1 port tambahan terikat');
    const lain = st.dash.ports.find((x) => x !== utama);
    assert.ok(lain, 'port tambahan dapat nomornya');
    const hz = await fetch(`http://127.0.0.1:${lain}/healthz`);
    assert.strictEqual(hz.status, 200, 'port tambahan melayani juga');
    d4.stop();
  });

  await test('panel menjelaskan quest jalur konsol yang dilewati (PSN/Xbox)', async () => {
    const html = await (await get('/', H)).text();
    assert.ok(html.includes('jalur konsol'), 'ada penjelasan soal quest jalur konsol');
    assert.ok(html.includes('dikerjakan lewat jalur desktop'), 'dijelaskan bahwa jalur desktop diterima Discord');
    assert.ok(html.includes('PlayStation 4'), 'label platform PS4 benar (bukan disamakan dengan PC)');
    assert.ok(html.includes('HP Android'), 'label platform HP benar');
  });

  await test('halaman menampilkan panel quest', async () => {
    const html = await (await get('/', H)).text();
    assert.ok(html.includes('Quest Discord'), 'panel quest ada');
    assert.ok(html.includes('muatQuest'), 'skrip quest ada');
  });

  await test('pencarian lewat alias (mis. "fifa", "wedge") ketemu', async () => {
    const j = await (await get('/api/games?semua=1', H)).json();
    const cari = (q) => j.games.filter((g) => (g.n + ' ' + g.a).toLowerCase().includes(q)).map((g) => g.n);
    assert.ok(cari('gta 6').length > 0, 'alias gta 6 ada');
    assert.ok(cari('fifa').length > 0, 'alias fifa ada');
    assert.ok(cari('spider').some((n) => /Spider-Man/.test(n)), 'alias spider ketemu Spider-Man');
  });

  await test('nama resmi sesuai (PUBG, Control, RE2, Trackmania, dll)', async () => {
    const harus = {
      pubg: "PLAYERUNKNOWN'S BATTLEGROUNDS",
      control: 'Control',
      'resident evil 2': 'Resident Evil 2',
      trackmania: 'Trackmania',
      'black desert': 'Black Desert Online',
      'little nightmares 2': 'Little Nightmares II',
      'ea sports wrc': 'WRC',
      'divinity 2': 'Divinity Original Sin 2',
      'ghost of yotei': 'Ghost of Yōtei',
      'clair obscur': 'Clair Obscur: Expedition 33',
      forza: 'Forza Horizon 5',
      'god of war ragnarok': 'God of War Ragnarök',
      'the last of us 2': 'The Last of Us™ Part II Remastered',
    };
    for (const [ketik, harusNama] of Object.entries(harus)) {
      const j = await (await get('/api/resolve?game=' + encodeURIComponent(ketik), H)).json();
      assert.ok(j.found, `"${ketik}" harus ketemu`);
      assert.strictEqual(j.name, harusNama, `"${ketik}" harus tampil sebagai "${harusNama}"`);
      assert.ok(j.icon.startsWith('https://cdn.discordapp.com/app-icons/'), `ikon resmi untuk ${ketik}`);
    }
  });

  await test('/api/resolve memakai nama resmi sebelum ON', async () => {
    const j = await (await get('/api/resolve?game=returnal', H)).json();
    assert.strictEqual(j.found, true);
    assert.strictEqual(j.name, 'Returnal™');
    assert.ok(j.icon.includes('1382615456007061514') === false); // dijaga: ini id Stellar Blade, bukan Returnal
    assert.ok(j.icon.startsWith('https://cdn.discordapp.com/app-icons/'));
  });

  await test('halaman utama ada isinya & tanpa resource luar (hemat)', async () => {
    const r = await get('/', H);
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(html.includes('PS5 Mode'));
    assert.ok(!/<script[^>]+src=/.test(html), 'tidak ada <script src> (nol CDN)');
    assert.ok(!/<link[^>]+stylesheet/.test(html), 'tidak ada CSS luar');
    assert.ok(html.length < 40000, 'halaman tetap kecil: ' + html.length + ' B');
  });

  await test('healthz untuk cek cepat dari luar', async () => {
    const j = await (await get('/healthz')).json();
    assert.strictEqual(j.ok, true);
  });

  await test('saveEnv: baris lain aman + tambah baris baru kalau belum ada', async () => {
    const f = path.join(os.tmpdir(), 'dash-save-' + process.pid + '.env');
    fs.writeFileSync(f, 'A=1\nB=2\n');
    saveEnv({ B: '9', C: '3' }, f);
    const out = fs.readFileSync(f, 'utf8');
    assert.match(out, /^A=1$/m);
    assert.match(out, /^B=9$/m);
    assert.match(out, /^C=3$/m);
    fs.unlinkSync(f);
  });

  await test('token quest: disinkronkan ke Quest/Scout, tidak masuk status lain atau terbaca di respons', async () => {
    const mainToken = 'M'.repeat(24) + '.mainpart.' + 'S'.repeat(30);
    const questToken = 'Q'.repeat(24) + '.questpart.' + 'T'.repeat(30);
    const questEnvOriginal = process.env.QUEST_TOKEN;
    const discordEnvOriginal = process.env.DISCORD_TOKEN;
    const tokenEnv = path.join(os.tmpdir(), 'dash-quest-token-' + process.pid + '.env');
    fs.writeFileSync(tokenEnv, 'KEEP_ME=1\n');

    const cfgPath = require.resolve('../src/config');
    const configCache = require.cache[cfgPath];
    const Module = require('module');
    const fakeConfig = new Module(cfgPath, module);
    fakeConfig.filename = cfgPath;
    fakeConfig.loaded = true;
    fakeConfig.exports = { config: { discordToken: mainToken, apiVersion: 'v9', userAgent: 'test' } };

    const httpClient = require('../src/http');
    const requestOriginal = httpClient.request;
    const requestEvents = [];
    const events = [];
    const gatewayProbe = { pushes: 0, requestPresencePush() { this.pushes += 1; } };
    const ps5Probe = {
      cfg: { enabled: false, game: 'Fortnite' }, platform: 'ps5', timer: false,
      startedAt: Date.now(), name: 'Fortnite', appId: '', calls: [],
    };
    const questProbe = {
      token: mainToken,
      setToken(token) { this.token = token; events.push(['quest-token', token]); return { ok: true }; },
    };
    const scoutProbe = {
      setAktif(on) { events.push(['scout-active', on]); return { enabled: Boolean(on) }; },
      setToken(token, opts) { events.push(['scout-token', token, opts]); return true; },
    };
    const tokenDash = createDashboard({
      cfg: { enabled: true, port: 0, host: '127.0.0.1', key: KEY },
      log, ps5: ps5Probe, roblox: null, gateway: gatewayProbe,
      quest: questProbe, scout: scoutProbe, envFile: tokenEnv,
    });
    let tokenServer;
    try {
      process.env.DISCORD_TOKEN = mainToken;
      require.cache[cfgPath] = fakeConfig;
      httpClient.request = async (method, url, options) => {
        requestEvents.push({ method, url, auth: options.headers.Authorization });
        return { ok: true, status: 200, json: { username: 'quest-audit-user' } };
      };
      tokenServer = tokenDash.start();
      await new Promise((resolve) => tokenServer.once('listening', resolve));
      const tokenBase = `http://127.0.0.1:${tokenServer.address().port}`;

      const savedResponse = await fetch(tokenBase + '/api/quest/token', {
        method: 'POST', headers: H, body: JSON.stringify({ token: questToken }),
      });
      const saved = await savedResponse.json();
      assert.strictEqual(savedResponse.status, 200);
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(requestEvents.length, 1, 'custom token is validated with one /users/@me request');
      assert.strictEqual(requestEvents[0].auth, questToken);
      assert.strictEqual(questProbe.token, questToken);
      assert.deepStrictEqual(events[0], ['quest-token', questToken]);
      assert.deepStrictEqual(events[1], ['scout-token', questToken, { tokenKhusus: true }]);
      assert.match(fs.readFileSync(tokenEnv, 'utf8'), /^KEEP_ME=1$/m);
      assert.match(fs.readFileSync(tokenEnv, 'utf8'), /^QUEST_TOKEN=/m);

      const currentResponse = await fetch(tokenBase + '/api/quest/token', { headers: H });
      const current = await currentResponse.json();
      assert.strictEqual(current.sumber, 'sendiri');
      assert.strictEqual(current.kunci, 'tersimpan (dirahasiakan)');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(current, 'panjang'), false);

      const deletedResponse = await fetch(tokenBase + '/api/quest/token', { method: 'DELETE', headers: H });
      const deleted = await deletedResponse.json();
      assert.strictEqual(deleted.ok, true);
      assert.strictEqual(deleted.kunci, 'tersimpan (dirahasiakan)');
      assert.strictEqual(questProbe.token, mainToken);
      assert.deepStrictEqual(events.slice(2), [
        ['scout-active', false],
        ['quest-token', mainToken],
        ['scout-token', mainToken, { tokenKhusus: false }],
      ]);
      assert.match(fs.readFileSync(tokenEnv, 'utf8'), /^KEEP_ME=1$/m);
      assert.doesNotMatch(fs.readFileSync(tokenEnv, 'utf8'), /^QUEST_TOKEN=/m);
      const returned = JSON.stringify([saved, current, deleted]);
      for (const token of [questToken, mainToken]) {
        assert.strictEqual(returned.includes(token), false, 'API response must not echo the full token');
        assert.strictEqual(returned.includes(token.slice(0, 10)), false, 'API response must not expose a token prefix');
        assert.strictEqual(returned.includes(token.slice(-4)), false, 'API response must not expose a token suffix');
      }
      assert.strictEqual(gatewayProbe.pushes, 0, 'quest token does not cause a presence push');
      assert.deepStrictEqual(ps5Probe.calls, [], 'quest token does not touch PS5 state');
    } finally {
      httpClient.request = requestOriginal;
      if (configCache) require.cache[cfgPath] = configCache;
      else delete require.cache[cfgPath];
      if (questEnvOriginal === undefined) delete process.env.QUEST_TOKEN;
      else process.env.QUEST_TOKEN = questEnvOriginal;
      if (discordEnvOriginal === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = discordEnvOriginal;
      if (tokenServer && tokenServer.listening) {
        await new Promise((resolve) => tokenServer.close(resolve));
      } else {
        tokenDash.stop();
      }
      fs.rmSync(tokenEnv, { force: true });
    }
  });

  server.close();
  fs.unlinkSync(tmpEnv);
  console.log(`\n${passed} test lulus.`);
})();
