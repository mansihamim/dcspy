'use strict';

/**
 * Tes modul "pura-pura main PS5" (src/ps5.js).
 * Fokus: field `platform` yang bikin Discord menampilkan sebagai konsol.
 */

const assert = require('assert');
const { Ps5Presence, findAppId, findGameInfo, officialName, normalizePlatform, platformLabel, GAMES } = require('../src/ps5');

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const baseCfg = {
  enabled: true,
  game: 'Fortnite',
  appId: '',
  details: '',
  platform: 'ps5',
  timer: true,
  officialName: true,
};

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
  console.log('ps5.test.js — "pura-pura main PS5"\n');

  await test('aktivitas memakai platform ps5 (kunci tampilan konsol)', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg } });
    await p.start();
    const act = p.activity();
    assert.strictEqual(act.platform, 'ps5', 'field platform = ps5');
    assert.strictEqual(act.name, 'Fortnite');
    assert.strictEqual(act.type, 0, 'type 0 = Playing');
    p.stop();
  });

  await test('ikon game muncul: application_id dari daftar game populer', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg } });
    await p.start();
    assert.strictEqual(p.activity().application_id, '1402418703554842694', 'app id Fortnite');
    p.stop();
  });

  await test('nama game tidak peka huruf besar/kecil + spasi', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, game: '  gta v ' } });
    await p.start();
    assert.strictEqual(p.activity().application_id, '1402418714716143646');
    assert.strictEqual(p.activity().name, 'Grand Theft Auto V Legacy', 'nama resmi juga walau ditulis "gta v"');
    p.stop();
  });

  await test('PS5_APP_ID manual menang atas daftar otomatis', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, game: 'Fortnite', appId: '123456789012345678' } });
    await p.start();
    assert.strictEqual(p.activity().application_id, '123456789012345678');
    p.stop();
  });

  await test('game tak dikenal -> tetap tampil, hanya tanpa ikon', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, game: 'Game Buatan Sendiri' } });
    await p.start();
    const act = p.activity();
    assert.strictEqual(act.name, 'Game Buatan Sendiri');
    assert.strictEqual(act.application_id, undefined);
    assert.strictEqual(act.platform, 'ps5', 'platform tetap ps5');
    p.stop();
  });

  await test('platform bisa diganti: ps4 / xbox / desktop', async () => {
    for (const [input, expect] of [['ps4', 'ps4'], ['xbox', 'xbox'], ['pc', 'desktop'], ['playstation', 'ps5'], ['hp', 'android']]) {
      const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, platform: input } });
      await p.start();
      assert.strictEqual(p.activity().platform, expect, `${input} -> ${expect}`);
      p.stop();
    }
  });

  await test('timer bisa dimatikan (PS5_TIMER=false)', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, timer: false } });
    await p.start();
    assert.strictEqual(p.activity().timestamps, undefined);
    p.stop();
  });

  await test('id & session_id berformat sama seperti aktivitas asli Discord', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg } });
    await p.start();
    const act = p.activity();
    assert.match(act.id, /^[0-9a-f]{16}$/);
    assert.match(act.session_id, /^[0-9a-f]{32}$/);
    p.stop();
  });

  await test('nonaktif -> tidak ada aktivitas sama sekali', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, enabled: false } });
    await p.start();
    assert.strictEqual(p.activity(), null);
    p.stop();
  });

  await test('PS5_DETAILS mengisi baris kedua', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, details: 'Trophy hunting' } });
    await p.start();
    assert.strictEqual(p.activity().details, 'Trophy hunting');
    p.stop();
  });

  await test('nama resmi Discord dipakai (PS5_OFFICIAL_NAME=true default)', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, game: 'Spider-Man' } });
    await p.start();
    const act = p.activity();
    assert.strictEqual(act.name, "Marvel’s Spider-Man Remastered", 'pakai nama resmi versi Discord');
    assert.strictEqual(act.application_id, '1124351769175150702');
    p.stop();
  });

  await test("Spider-Man TIDAK lagi salah ke game 'Spider-Man 3' (bug lama)", async () => {
    assert.notStrictEqual(findAppId('Spider-Man'), '504047615139119143');
    assert.strictEqual(findAppId('spiderman'), '1124351769175150702');
    assert.strictEqual(findAppId('spider man'), '1124351769175150702');
  });

  await test('PS5_OFFICIAL_NAME=false -> pakai nama yang kamu tulis sendiri', async () => {
    const p = new Ps5Presence({ logger: log, cfg: { ...baseCfg, game: 'spider-man', officialName: false } });
    await p.start();
    assert.strictEqual(p.activity().name, 'spider-man', 'nama apa adanya');
    assert.strictEqual(p.activity().application_id, '1124351769175150702', 'ikon tetap benar');
    p.stop();
  });

  await test('daftar game lengkap & setiap entri punya id + nama + alias', async () => {
    assert.ok(GAMES.length >= 1000, `jumlah game ${GAMES.length} (harus >= 1000)`);
    for (const g of GAMES) {
      assert.match(g.id, /^\d{5,25}$/, `id tidak valid: ${g.name}`);
      assert.ok(g.name && g.name.length > 1, 'nama kosong');
      assert.ok(Array.isArray(g.alias) && g.alias.length >= 1, `alias kosong: ${g.name}`);
    }
  });

  await test('pencocokan game populer (alias & sebagian nama)', async () => {
    assert.strictEqual(findAppId('GTA V'), '1402418714716143646');
    assert.strictEqual(findAppId('gta 5'), '1402418714716143646');
    assert.strictEqual(findAppId('Genshin'), '762434991303950386');
    assert.strictEqual(findAppId('elden ring'), '1402418436809953330');
    assert.strictEqual(findAppId('god of war ragnarok'), '1286371274003841115');
    assert.strictEqual(findAppId('the last of us part 2'), '1445149467216052364');
    assert.strictEqual(officialName('gta v'), 'Grand Theft Auto V Legacy');
    assert.strictEqual(findGameInfo('Game Buatan Sendiri'), null);
  });

  await test('tahun rilis masuk akal (sebagian kecil belum diketahui = 0)', async () => {
    const aneh = GAMES.filter((g) => g.year && (g.year < 1980 || g.year > 2027));
    assert.strictEqual(aneh.length, 0, 'tahun aneh: ' + aneh.map((g) => g.name + '=' + g.year).join(', '));
    const ada = GAMES.filter((g) => g.year).length;
    assert.ok(ada / GAMES.length > 0.85, 'yang punya tahun harus > 85%, sekarang ' + Math.round((ada / GAMES.length) * 100) + '%');
    for (const nama of ['WWE 2K26', 'NBA 2K26', 'EA SPORTS FC 26', 'Forza Horizon 6']) {
      const g = GAMES.find((x) => x.name === nama);
      assert.ok(g && g.year >= 2025, nama + ' harus punya tahun >= 2025');
    }
  });

  await test('game terbaru 2025-2026 ada (Forza Horizon 6, GTA VI, dll)', async () => {
    const harus = {
      'forza horizon 6': ['Forza Horizon 6', 2026],
      'gta 6': ['Grand Theft Auto VI', 2026],
      wolverine: ["Marvel's Wolverine", 2026],
      'resident evil requiem': ['Resident Evil Requiem', 2026],
      'nba 2k26': ['NBA 2K26', 2025],
      'wwe 2k26': ['WWE 2K26', 2026],
      'mlb the show 26': ['MLB The Show 26', 2026],
      'nioh 3': ['Nioh 3', 2026],
      saros: ['Saros', 2026],
      'ninja gaiden 4': ['Ninja Gaiden 4', 2025],
      'ghost of yotei': ['Ghost of Yōtei', 2025],
      'sonic racing': ['Sonic Racing: CrossWorlds', 2025],
      'ufc 6': ['EA Sports UFC 6', 2026],
    };
    for (const [ketik, [nama, tahun]] of Object.entries(harus)) {
      const g = findGameInfo(ketik);
      assert.ok(g, `"${ketik}" harus ketemu`);
      assert.strictEqual(g.name, nama, `"${ketik}" harus tampil sebagai "${nama}"`);
      assert.strictEqual(g.year, tahun, `tahun ${nama}`);
    }
    const tahun2026 = GAMES.filter((g) => g.year === 2026);
    assert.ok(tahun2026.length >= 40, 'game 2026 minimal 40, sekarang ' + tahun2026.length);
  });

  await test('tiap game punya penanda rilis; yang tahunnya >= 2027 ditandai belum rilis', async () => {
    const tanpa = GAMES.filter((g) => g.released !== 0 && g.released !== 1);
    assert.strictEqual(tanpa.length, 0, 'penanda rilis aneh: ' + tanpa.map((g) => g.name).join(', '));
    const salah = GAMES.filter((g) => g.year >= 2027 && g.released !== 0);
    assert.strictEqual(salah.length, 0, 'tahun >= 2027 harus belum rilis: ' + salah.map((g) => g.name).join(', '));
    const belum = GAMES.filter((g) => g.released === 0);
    assert.ok(belum.length >= 10, 'harus ada game belum rilis, sekarang ' + belum.length);
    for (const nama of ['Forza Horizon 6', 'Grand Theft Auto VI', 'Call of Duty®: Modern Warfare® 4']) {
      const g = GAMES.find((x) => x.name === nama);
      assert.ok(g, nama + ' harus ada di daftar');
      assert.strictEqual(g.released, 0, nama + ' belum rilis di PS5');
    }
    for (const nama of ['NBA 2K26', 'WWE 2K26', 'MLB The Show 26', 'EA SPORTS FC 26', 'Battlefield 6']) {
      const g = GAMES.find((x) => x.name === nama);
      assert.ok(g, nama + ' harus ada');
      assert.strictEqual(g.released, 1, nama + ' sudah rilis');
    }
  });

  await test('helper: findAppId / normalizePlatform / platformLabel', async () => {
    assert.strictEqual(findAppId('Fortnite'), '1402418703554842694');
    assert.strictEqual(findAppId('genshin impact'), '762434991303950386');
    assert.strictEqual(findAppId('apa saja', '999999999999999999'), '999999999999999999');
    assert.strictEqual(findAppId('game asing'), '');
    assert.strictEqual(normalizePlatform('PS5'), 'ps5');
    assert.strictEqual(normalizePlatform('aneh'), 'ps5');
    assert.strictEqual(platformLabel('ps5'), 'PS5');
    assert.strictEqual(platformLabel('xbox'), 'Xbox');
  });

  console.log(`\n${passed} test lulus.`);
})();
