'use strict';

/**
 * Tes penjalan quest (src/quest.js) — tanpa menyentuh jaringan Discord.
 * Semua balasan Discord ditiru lewat `runner.api` yang diganti.
 */

const assert = require('assert');
// uji tidak perlu menunggu jeda sopan 1,2 dtk — isi logika yang diuji, bukan jedanya
process.env.QUEST_JEDA_KERJA_MS = '0';
const { QuestRunner } = require('../src/quest');

// tanggal DINAMIS: fixture dulu memakai tanggal mati ('2026-10-02') yang
// akhirnya lewat sehingga uji ikut gagal padahal kode benar
const DEPAN = new Date(Date.now() + 60 * 86400000).toISOString();      // masih 60 hari lagi
const SEGERA = new Date(Date.now() + 3 * 86400000).toISOString();      // 3 hari lagi (masih depan)

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** ps5 tiruan: mencatat semua perubahan supaya bisa diperiksa. */
function ps5Tiruan() {
  return {
    cfg: { enabled: true, game: 'NBA 2K26' },
    platform: 'ps5',
    game: 'NBA 2K26',
    riwayat: [],
    applyGame(g) { this.game = g; this.cfg.game = g; this.riwayat.push('game:' + g); return { name: g, id: '1', matched: true }; },
    setPlatform(p) { this.platform = p; this.riwayat.push('platform:' + p); return p; },
    setEnabled(on) { this.cfg.enabled = on; this.riwayat.push('on:' + on); return on; },
  };
}

const q = (id, nama, opts = {}) => ({
  id,
  config: {
    messages: { quest_name: nama },
    expires_at: opts.expires || DEPAN,
    task_config_v2: { tasks: opts.jalur
      ? { [opts.jalur]: { type: opts.jalur, target: opts.target || 900, applications: [{ id: opts.app || '542075586886107149' }] } }
      : { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: opts.target || 900, applications: [{ id: opts.app || '363445589247131668' }] } } },
    rewards_config: { rewards: [{ orb_quantity: 700, messages: { name: '700 Orbs' } }] },
  },
  user_status: { progress: opts.progress ? { PLAY_ON_DESKTOP: { value: opts.progress } } : {}, completed_at: opts.selesai ? '2026-01-01T00:00:00Z' : null },
});

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
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== Tes Penjalan Quest ==');

  await test('daftar(): hanya jalur desktop, kedaluwarsa dideteksi', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    r.api = async () => ({ status: 200, json: { quests: [
      q('1', 'Quest Baru', { expires: DEPAN }),
      q('2', 'Quest Lewat', { expires: '2026-01-01T00:00:00+00:00' }),
      q('3', 'Quest Selesai', { selesai: true }),
      q('psn', 'Quest PSN Saja', { jalur: 'PLAY_ON_PLAYSTATION' }),
      q('xb', 'Quest Xbox Saja', { jalur: 'PLAY_ON_XBOX' }),
      { id: '4', config: { messages: { quest_name: 'Hanya Xbox' }, task_config_v2: { tasks: { PLAY_ON_XBOX: { target: 900, applications: [{ id: '1' }] } } } }, user_status: {} },
    ] } });
    const d = await r.daftar();
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.quests.length, 3, 'yang tidak punya jalur desktop dibuang');
    const lewat = d.quests.find((x) => x.nama === 'Quest Lewat');
    assert.strictEqual(lewat.kedaluwarsa, true, 'diketahui kedaluwarsa');
    assert.strictEqual(d.quests.find((x) => x.nama === 'Quest Baru').kedaluwarsa, false);
    assert.strictEqual(lewat.hadiah, '700 Orbs');
  });

  await test('completed_at tidak menutupi kekurangan 1 menit pada progres server', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    const kurangSemenit = r._petakan([q('gap', 'Kurang semenit', { target: 900, progress: 840, selesai: true })]).out[0];
    assert.equal(kurangSemenit.selesai, false, 'progress 840/900 tetap belum selesai');
    assert.equal(kurangSemenit.selesaiTidakSinkron, true, 'kontradiksi ditandai untuk UI');
    assert.equal(kurangSemenit.progress, 840);
    assert.equal(QuestRunner.pilihLayak([kurangSemenit]).length, 1, 'masih bisa dilanjutkan');
    const tanpaNilaiProgress = r._petakan([q('done', 'Selesai', { selesai: true })]).out[0];
    assert.equal(tanpaNilaiProgress.selesai, true, 'completed_at tetap dipercaya bila API tidak memberi nilai progres yang bertentangan');
  });

  await test('claimed_at selalu mencegah quest dikirim ulang ke worker', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    const sudahDiklaim = q('claimed', 'Sudah diklaim');
    sudahDiklaim.user_status.claimed_at = '2026-10-01T00:00:00Z';
    const hasil = r._petakan([sudahDiklaim]).out[0];
    assert.equal(hasil.diklaim, true);
    assert.equal(QuestRunner.pilihLayak([hasil]).length, 0);
    r.api = async () => ({ status: 200, json: { quests: [sudahDiklaim] } });
    assert.equal((await r.mulai('claimed')).ok, false, 'tombol mulai juga menolak quest yang sudah diklaim');
  });

  await test('daftar(): quest jalur konsol (PSN/Xbox) dihitung, bukan dikerjakan', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    r.api = async () => ({ status: 200, json: { quests: [
      q('d1', 'Quest Desktop'),
      q('p1', 'Quest PSN', { jalur: 'PLAY_ON_PLAYSTATION' }),
      q('p2', 'Quest PSN Lalu', { jalur: 'PLAY_ON_PLAYSTATION', expires: '2026-01-01T00:00:00+00:00' }),
      q('x1', 'Quest Xbox', { jalur: 'PLAY_ON_XBOX' }),
    ] } });
    const d = await r.daftar();
    assert.strictEqual(d.quests.length, 1, 'yang bisa dikerjakan cuma jalur desktop');
    assert.strictEqual(d.quests[0].nama, 'Quest Desktop');
    assert.strictEqual(d.konsol.playstation.total, 2, 'dua quest berjalur PSN dicatat');
    assert.strictEqual(d.konsol.playstation.tanpaDesktop, 2, 'dua-duanya jalur PSN saja');
    assert.strictEqual(d.konsol.playstation.layak, 1, 'yang masih berlaku dihitung (tidak bisa dikerjakan)');
    assert.deepStrictEqual(d.konsol.playstation.nama, ['Quest PSN']);
    assert.strictEqual(d.konsol.xbox.total, 1, 'quest Xbox dicatat');

    // quest dua jalur: dihitung lewatDesktop, bukan sebagai "dilewati"
    const r2 = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    r2.api = async () => ({ status: 200, json: { quests: [
      { id: 'dua', config: { messages: { quest_name: 'Dua Jalur' }, expires_at: DEPAN,
        task_config_v2: { tasks: {
          PLAY_ON_DESKTOP: { target: 900, applications: [{ id: '1' }] },
          PLAY_ON_PLAYSTATION: { target: 900, applications: [{ id: '2' }] } } } }, user_status: {} },
    ] } });
    const d2 = await r2.daftar();
    assert.strictEqual(d2.quests.length, 1, 'tetap masuk daftar kerja (jalur desktop)');
    assert.strictEqual(d2.konsol.playstation.total, 1);
    assert.strictEqual(d2.konsol.playstation.lewatDesktop, 1, 'ditandai bisa lewat desktop');
    assert.strictEqual(d2.konsol.playstation.tanpaDesktop, 0);
    assert.strictEqual(d2.konsol.playstation.layak, 0, 'tidak dihitung sebagai quest yang dilewati');

    // satu quest dengan PSN DAN Xbox: dihitung di kedua jalur
    const r3 = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    r3.api = async () => ({ status: 200, json: { quests: [
      { id: 'tiga', config: { messages: { quest_name: 'PSN + Xbox' }, expires_at: DEPAN,
        task_config_v2: { tasks: {
          PLAY_ON_DESKTOP: { target: 900, applications: [{ id: '1' }] },
          PLAY_ON_PLAYSTATION: { target: 900, applications: [{ id: '2' }] },
          PLAY_ON_XBOX: { target: 900, applications: [{ id: '3' }] } } } }, user_status: {} },
    ] } });
    const d3 = await r3.daftar();
    assert.strictEqual(d3.konsol.playstation.lewatDesktop, 1, 'terhitung di jalur PSN');
    assert.strictEqual(d3.konsol.xbox.lewatDesktop, 1, 'terhitung juga di jalur Xbox');
    // heartbeat PSN tidak pernah dicoba walau auto
    let beat = 0;
    r.api = async (jalur) => {
      if (jalur.includes('heartbeat')) beat += 1;
      return { status: 200, json: { quests: [q('p1', 'Quest PSN', { jalur: 'PLAY_ON_PLAYSTATION' })] } };
    };
    await r.autoMulai();
    await tunggu(200);
    assert.strictEqual(beat, 0, 'auto tidak menyentuh quest jalur konsol');
  });

  await test('mulai(): quest kedaluwarsa / sudah selesai DITOLAK', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    r.api = async () => ({ status: 200, json: { quests: [q('2', 'Quest Lewat', { expires: '2026-01-01T00:00:00+00:00' }), q('3', 'Quest Selesai', { selesai: true })] } });
    const a = await r.mulai('2');
    assert.strictEqual(a.ok, false);
    assert.match(a.error, /kedaluwarsa/i);
    const b = await r.mulai('3');
    assert.strictEqual(b.ok, false);
    assert.match(b.error, /sudah selesai/i);
    assert.strictEqual(ps5.platform, 'ps5', 'presence tidak diutak-atik saat ditolak');
  });

  await test('autoMulai(): ambil semua yang layak, lewati yang kedaluwarsa', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    let beats = 0;
    r.api = async (path) => {
      if (path.includes('/heartbeat')) {
        beats += 1;
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: '2026-09-30T00:00:00Z' } };
      }
      return { status: 200, json: { quests: [
        q('1', 'Aktif A', { expires: DEPAN, app: '363445589247131668' }),
        q('2', 'Lewat B', { expires: '2026-01-01T00:00:00+00:00' }),
        q('3', 'Aktif C', { expires: DEPAN, app: '1402418703554842694' }),
      ] } };
    };
    const mulai = await r.autoMulai();
    assert.strictEqual(mulai.ok, true);
    assert.strictEqual(mulai.jumlah, 2, 'hanya 2 quest layak');
    assert.deepStrictEqual(mulai.quests.map((x) => x.nama), ['Aktif A', 'Aktif C']);
    await tunggu(120); // biarkan loop jalan (beatSec 0 -> cepat)
    assert.deepStrictEqual(r.selesai, ['Aktif A', 'Aktif C'], 'keduanya selesai');
    assert.strictEqual(r.aktif, false, 'berhenti sendiri setelah semua selesai');
    assert.ok(beats >= 2, 'heartbeat dipanggil');
    // presence dipulihkan
    assert.strictEqual(ps5.platform, 'ps5');
    assert.strictEqual(ps5.cfg.game, 'NBA 2K26');
  });

  await test('desktop: status selesai dengan 840/900 tetap menunggu sampai target dan terminal dikonfirmasi', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    const panggilan = [];
    let heartbeat = 0;
    r._postKerja = async (_path, body) => {
      panggilan.push({ ...body });
      if (body.terminal) {
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'confirmed' } };
      }
      heartbeat += 1;
      if (heartbeat === 1) {
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 840 } }, completed_at: 'stale-flag' } };
      }
      return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: null } };
    };
    const result = await r._kerjaDesktop(
      { id: 'gap', nama: 'Kurang semenit', appId: 'app', target: 900, progress: 840 },
      { value: 840 },
    );
    assert.equal(result, 'selesai');
    assert.equal(heartbeat, 2, 'satu menit kurang tidak dihentikan terlalu cepat');
    assert.deepEqual(panggilan.map((x) => Boolean(x.terminal)), [false, false, true], 'terminal hanya dikirim setelah progres 900/900');
  });

  await test('desktop: heartbeat terminal gagal tidak dicatat selesai', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    r._postKerja = async (_path, body) => body.terminal
      ? { status: 401, json: { message: 'unauthorized' } }
      : { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } } } };
    const result = await r._kerjaDesktop(
      { id: 'terminal-401', nama: 'Terminal ditolak', appId: 'app', target: 900, progress: 0 },
      { value: 0 },
    );
    assert.equal(result, 'heartbeat terminal ditolak (HTTP 401)');
    assert.notEqual(result, 'selesai');
  });

  await test('quest kedaluwarsa saat dikerjakan -> dilewati, lanjut ke berikutnya', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    let ke = 0;
    r.api = async (path, body) => {
      if (path.includes('/heartbeat')) {
        ke += 1;
        // quest pertama (app 111...) ditolak kedaluwarsa, quest kedua selesai
        if (String(body.application_id) === '111111111111111111') {
          return { status: 404, json: { message: 'Quest has expired', code: 260017 } };
        }
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      }
      return { status: 200, json: { quests: [
        q('1', 'Sudah Lewat', { expires: DEPAN, app: '111111111111111111' }),
        q('2', 'Masih Bisa', { expires: DEPAN, app: '222222222222222222' }),
      ] } };
    };
    await r.autoMulai();
    await tunggu(200);
    assert.deepStrictEqual(r.selesai, ['Masih Bisa'], 'yang gagal tidak masuk daftar selesai');
    assert.strictEqual(r.gagal.length, 1);
    assert.strictEqual(r.gagal[0].sebab, 'kedaluwarsa');
    assert.strictEqual(r.aktif, false);
  });

  await test('batal(): berhenti CEPAT walau heartbeat panjang (bug: nunggu 95 detik)', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 95 }); // heartbeat panjang
    r.api = async (jalur) => (jalur.includes('heartbeat')
      ? { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 10 } } } }
      : { status: 200, json: { quests: [q('9', 'Quest Lambat')] } });
    await r.mulai('9');
    await tunggu(300);
    assert.strictEqual(r.aktif, true, 'jalan dulu');
    const t0 = Date.now();
    r.batal();
    for (let i = 0; i < 60 && r.aktif; i += 1) await tunggu(50); // maks 3 detik
    const lama = Date.now() - t0;
    assert.strictEqual(r.aktif, false, 'langsung berhenti (tidak menunggu 95 detik)');
    assert.ok(lama < 2000, `berhenti dalam ${lama} ms (harus < 2000 ms)`);
    assert.strictEqual(ps5.cfg.game, 'NBA 2K26', 'presence dikembalikan ke game semula');
    assert.strictEqual(ps5.platform, 'ps5', 'platform dipulihkan');
    assert.strictEqual(ps5.cfg.enabled, true, 'status ON/OFF dipulihkan');
  });

  await test('batal(): berhenti & presence tetap dipulihkan', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 1 }); // 1 detik antar beat
    r.api = async (path) => {
      if (path.includes('/heartbeat')) return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 30 } } } };
      return { status: 200, json: { quests: [q('1', 'Quest Panjang', { expires: DEPAN })] } };
    };
    await r.autoMulai();
    await tunggu(80);
    assert.strictEqual(r.aktif, true, 'sedang jalan');
    const b = await r.batal();
    assert.strictEqual(b.ok, true);
    await tunggu(1300);
    assert.strictEqual(r.aktif, false, 'berhenti setelah dibatalkan');
    assert.strictEqual(ps5.platform, 'ps5', 'platform dipulihkan');
    assert.strictEqual(ps5.cfg.game, 'NBA 2K26', 'game dipulihkan');
  });

  await test('presence TIDAK disentuh sama sekali saat quest dikerjakan (jalur terpisah)', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    let saatHeartbeat = null;
    r.api = async (path) => {
      if (path.includes('/heartbeat')) {
        saatHeartbeat = { game: ps5.game, platform: ps5.platform, enabled: ps5.cfg.enabled };
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      }
      return { status: 200, json: { quests: [q('1', 'Quest Roblox', { expires: DEPAN, app: '363445589247131668' })] } };
    };
    await r.autoMulai();
    for (let i = 0; i < 200 && r.aktif; i += 1) await tunggu(20);
    assert.ok(saatHeartbeat, 'heartbeat dipanggil');
    assert.strictEqual(saatHeartbeat.platform, 'ps5', 'platform tetap ps5 (bukan dipaksa desktop)');
    assert.strictEqual(saatHeartbeat.game, 'NBA 2K26', 'game tidak diganti ke game quest');
    assert.strictEqual(saatHeartbeat.enabled, true, 'status ON/OFF tidak diubah');
    assert.deepStrictEqual(ps5.riwayat, [], 'tidak ada satu pun perubahan presence: ' + JSON.stringify(ps5.riwayat));
    assert.deepStrictEqual(r.selesai, ['Quest Roblox'], 'quest tetap selesai tanpa mengubah presence');
  });

  await test('QUEST_UBAH_PRESENCE=true: presence barulah diganti (opsional, lama)', async () => {
    process.env.QUEST_UBAH_PRESENCE = 'true';
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    r.api = async (path) => (path.includes('/heartbeat')
      ? { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } }
      : { status: 200, json: { quests: [q('1', 'Quest Roblox', { expires: DEPAN, app: '363445589247131668' })] } });
    await r.autoMulai();
    for (let i = 0; i < 200 && r.aktif; i += 1) await tunggu(20);
    assert.ok(ps5.riwayat.some((x) => x.startsWith('platform:desktop')), 'platform diganti ke desktop');
    assert.strictEqual(ps5.platform, 'ps5', 'setelah selesai dikembalikan');
    assert.strictEqual(ps5.cfg.game, 'NBA 2K26', 'game dikembalikan');
    delete process.env.QUEST_UBAH_PRESENCE;
  });

  /* ---------------- perbaikan 1 Okt: POST, enroll, video ---------------- */

  await test('heartbeat & video-progress dikirim dengan POST (bug lama: GET -> HTTP 405)', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const panggilan = [];
    r.api = async (path, body, method) => {
      panggilan.push({ path, body, method });
      if (path.includes('/heartbeat')) {
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      }
      return { status: 200, json: { quests: [q('1', 'Quest Desktop', { expires: DEPAN })] } };
    };
    await r.autoMulai();
    await tunggu(150);
    const hb = panggilan.filter((x) => x.path.includes('/heartbeat'));
    assert.ok(hb.length >= 1, 'heartbeat dikirim');
    for (const h of hb) assert.strictEqual(h.method, 'POST', 'heartbeat harus POST, bukan ' + h.method);
    assert.ok(hb.some((h) => h.body && h.body.terminal === true), 'ada heartbeat penutup terminal:true');
  });

  await test('quest belum diterima -> diterima otomatis (enroll) sebelum dikerjakan', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const panggilan = [];
    r.api = async (path, body, method) => {
      panggilan.push({ path, body, method });
      if (path.includes('/enroll')) {
        return { status: 200, json: { enrolled_at: '2026-10-01T00:00:00Z' } };
      }
      if (path.includes('/heartbeat')) {
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      }
      return { status: 200, json: { quests: [q('1', 'Belum Diterima', { expires: DEPAN })] } };
    };
    await r.autoMulai();
    await tunggu(150);
    const en = panggilan.find((x) => x.path.includes('/enroll'));
    assert.ok(en, 'enroll dipanggil');
    assert.strictEqual(en.method, 'POST');
    assert.strictEqual(en.body.location, 11, 'body enroll memakai location:11 (dari klien resmi)');
    assert.strictEqual(en.body.is_targeted, false);
    const urut = panggilan.map((x) => x.path.includes('/enroll') ? 'enroll' : x.path.includes('/heartbeat') ? 'beat' : 'lain');
    assert.ok(urut.indexOf('enroll') < urut.indexOf('beat'), 'enroll dulu, baru heartbeat');
    assert.deepStrictEqual(r.selesai, ['Belum Diterima']);
  });

  await test('enroll gagal -> quest dilewati (tanpa heartbeat), alasannya dicatat', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    let beat = 0;
    r.api = async (path) => {
      if (path.includes('/enroll')) return { status: 403, json: { message: 'User is not enrolled', code: 260000 } };
      if (path.includes('/heartbeat')) { beat += 1; return { status: 200, json: {} }; }
      return { status: 200, json: { quests: [q('1', 'Tidak Bisa Diikuti', { expires: DEPAN })] } };
    };
    await r.autoMulai();
    await tunggu(150);
    assert.strictEqual(beat, 0, 'tidak ada heartbeat untuk quest yang gagal diterima');
    assert.strictEqual(r.dilewati.length, 1);
    assert.match(r.dilewati[0].sebab, /diterima/i);
    assert.strictEqual(r.aktif, false, 'berhenti sendiri, tidak menggantung');
  });

  await test('quest WATCH_VIDEO: video-progress dikirim naik & selesai (tanpa presence)', async () => {
    process.env.QUEST_VIDEO_TICK_MS = '4';
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const panggilan = [];
    const vq = {
      id: 'v1',
      config: {
        messages: { quest_name: 'Nonton Video' },
        expires_at: DEPAN,
        task_config_v2: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 40 } } },
        rewards_config: { rewards: [{ orb_quantity: 300, messages: { name: '300 Orbs' } }] },
      },
      // sudah diterima 1 jam lalu -> server mengizinkan timestamp maju cepat
      user_status: { enrolled_at: new Date(Date.now() - 3600000).toISOString(), progress: { WATCH_VIDEO: { value: 0 } } },
    };
    r.api = async (path, body, method) => {
      panggilan.push({ path, body, method });
      if (path.includes('/video-progress')) {
        const ts = body.timestamp;
        return { status: 200, json: { progress: { WATCH_VIDEO: { value: ts } }, completed_at: ts >= 40 ? 'x' : null } };
      }
      return { status: 200, json: { quests: [vq] } };
    };
    const mulai = await r.autoMulai();
    assert.strictEqual(mulai.ok, true);
    assert.strictEqual(mulai.quests[0].jenis, 'WATCH_VIDEO');
    for (let i = 0; i < 200 && r.aktif; i += 1) await tunggu(20);
    const vp = panggilan.filter((x) => x.path.includes('/video-progress'));
    assert.ok(vp.length >= 2, 'video-progress dikirim beberapa kali');
    for (const v of vp) assert.strictEqual(v.method, 'POST', 'video-progress harus POST');
    const ts = vp.map((x) => x.body.timestamp);
    assert.ok(ts[ts.length - 1] >= 40, 'timestamp terakhir mencapai target (' + ts[ts.length - 1] + ')');
    assert.ok(ts.every((x, i) => i === 0 || x >= ts[i - 1]), 'timestamp tidak pernah mundur');
    assert.deepStrictEqual(r.selesai, ['Nonton Video']);
    assert.strictEqual(ps5.platform, 'ps5', 'presence tidak diutak-atik untuk quest video');
    assert.deepStrictEqual(ps5.riwayat, [], 'tidak ada perubahan presence untuk quest video');
    delete process.env.QUEST_VIDEO_TICK_MS;
  });

  await test('video: HTTP 202 dijeda dan timestamp yang diminta tidak dianggap progres', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    r.videoTickMs = 6000; // batas mandek kecil untuk fixture; tidur diganti agar tes tak menunggu
    const jeda = [];
    const kiriman = [];
    r._tunggu = async (ms) => { jeda.push(ms); };
    r._postKerja = async (_path, body) => {
      kiriman.push(body.timestamp);
      if (kiriman.length === 1) return { status: 202, json: null };
      return { status: 200, json: { progress: { WATCH_VIDEO: { value: 0 } }, completed_at: null } };
    };
    const result = await r._kerjaVideo(
      { id: 'video-gap', nama: 'Video belum progres', jenis: 'WATCH_VIDEO', target: 40, progress: 0, diterima: Date.now() - 3600000 },
      { value: 0 },
    );
    assert.match(result, /progres video berhenti|belum terkonfirmasi/);
    assert.equal(kiriman.length, 5, 'berhenti setelah progres server tidak bergerak');
    assert.ok(jeda.length >= 4 && jeda[0] === 6000, '202 mendapat jeda, bukan loop cepat');
    assert.ok(kiriman.every((x) => x < 40), 'timestamp target yang diminta tidak dihitung sebagai progres server');
  });

  await test('quest yang belum dimulai (starts_at depan) tidak dikerjakan', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const besok = new Date(Date.now() + 86400000).toISOString();
    r.api = async () => ({ status: 200, json: { quests: [
      { id: 'n1', config: { messages: { quest_name: 'Besok Baru Buka' }, starts_at: besok, expires_at: DEPAN,
        task_config_v2: { tasks: { PLAY_ON_DESKTOP: { target: 900, applications: [{ id: '1' }] } } } }, user_status: {} },
    ] } });
    const d = await r.daftar();
    assert.strictEqual(d.quests[0].belumMulai, true);
    const a = await r.autoMulai();
    assert.strictEqual(a.ok, false, 'tidak ada yang layak');
    assert.match(a.error, /belum dimulai|tidak ada/i);
  });

  await test('headers(): X-Super-Properties terkirim (tanpa ini Discord tak menyajikan quest video)', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    const h = r.headers();
    assert.ok(h['X-Super-Properties'], 'header ada');
    const isi = JSON.parse(Buffer.from(h['X-Super-Properties'], 'base64').toString('utf8'));
    assert.strictEqual(isi.os, 'Windows');
    assert.strictEqual(isi.browser, 'Discord Client');
    assert.ok(isi.client_build_number, 'ada client_build_number');
    assert.strictEqual(isi.has_client_mods, false);
    assert.ok(h.Origin === 'https://discord.com');
  });

  await test('antrianLayak(): quest video dikerjakan LEBIH DULU daripada main game', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const video = {
      id: 'v', config: { messages: { quest_name: 'Nonton Video' }, expires_at: DEPAN,
        task_config_v2: { tasks: { WATCH_VIDEO: { target: 30 } } } }, user_status: {},
    };
    const desktop = q('d', 'Main Game', { expires: SEGERA }); // berakhir lebih dekat (tapi belum lewat)
    r.api = async () => ({ status: 200, json: { quests: [desktop, video] } });
    const a = await r.antrianLayak();
    assert.strictEqual(a.length, 2);
    assert.strictEqual(a[0].nama, 'Nonton Video', 'video dulu walau tanggal berakhirnya lebih jauh');
    assert.strictEqual(a[1].nama, 'Main Game');
  });

  await test('PARALEL: dua quest desktop + satu video dikerjakan BERSAMAAN', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    const urut = [];
    let progA = 0;
    const quest = (id, nama, app, target) => ({
      id,
      config: { messages: { quest_name: nama }, expires_at: DEPAN,
        task_config_v2: { tasks: { PLAY_ON_DESKTOP: { target, applications: [{ id: app }] } } } },
      user_status: { enrolled_at: '2026-01-01T00:00:00Z', progress: {} },
    });
    const video = {
      id: 'v', config: { messages: { quest_name: 'Video V' }, expires_at: DEPAN,
        task_config_v2: { tasks: { WATCH_VIDEO: { target: 20 } } } },
      user_status: { enrolled_at: new Date(Date.now() - 3600000).toISOString(), progress: { WATCH_VIDEO: { value: 0 } } },
    };
    r.api = async (path, body) => {
      if (path.includes('/heartbeat')) {
        const app = String(body.application_id);
        urut.push(app);
        if (app === '111111111111111111') {
          progA += 300;
          return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: progA } }, completed_at: progA >= 900 ? 'x' : null } };
        }
        return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      }
      if (path.includes('/video-progress')) {
        return { status: 200, json: { progress: { WATCH_VIDEO: { value: body.timestamp } }, completed_at: body.timestamp >= 20 ? 'x' : null } };
      }
      return { status: 200, json: { quests: [quest('a', 'Desktop A', '111111111111111111', 900), quest('b', 'Desktop B', '222222222222222222', 900), video] } };
    };
    const mulai = await r.autoMulai();
    assert.strictEqual(mulai.jumlah, 3);
    assert.strictEqual(r.antrian.length, 0, 'tidak ada antre — semua jalan sekaligus');
    for (let i = 0; i < 400 && r.aktif; i += 1) await tunggu(20);
    // urutan mengikuti prioritas (video dulu), jadi bandingkan sebagai himpunan
    assert.deepStrictEqual(
      r.selesai.slice().sort(),
      ['Desktop A', 'Desktop B', 'Video V'].sort(),
      'ketiganya selesai: ' + JSON.stringify(r.selesai),
    );
    const idxB = urut.indexOf('222222222222222222');
    const idxA3 = urut.lastIndexOf('111111111111111111');
    assert.ok(idxB >= 0 && idxA3 >= 0, 'kedua quest desktop mengirim heartbeat');
    assert.ok(idxB < idxA3, `B jalan sebelum A selesai (paralel); urutan=${urut.map((x) => x.slice(0, 3)).join(',')}`);
  });

  await test('quest yang SUDAH diterima tidak di-enroll ulang (regresi salah ketik dikuti)', async () => {
    const ps5 = ps5Tiruan();
    const r = new QuestRunner({ token: 'x', log, ps5, beatSec: 0 });
    let enroll = 0;
    r.api = async (path) => {
      if (path.includes('/enroll')) { enroll += 1; return { status: 200, json: {} }; }
      if (path.includes('/heartbeat')) return { status: 200, json: { progress: { PLAY_ON_DESKTOP: { value: 900 } }, completed_at: 'x' } };
      return { status: 200, json: { quests: [{
        id: '1', config: { messages: { quest_name: 'Sudah Diterima' }, expires_at: DEPAN,
          task_config_v2: { tasks: { PLAY_ON_DESKTOP: { target: 900, applications: [{ id: '111111111111111111' }] } } } },
        user_status: { enrolled_at: '2026-09-01T00:00:00Z', progress: {} },
      }] } };
    };
    await r.autoMulai();
    for (let i = 0; i < 100 && r.aktif; i += 1) await tunggu(20);
    assert.strictEqual(enroll, 0, 'tidak ada enroll ulang untuk quest yang sudah diterima');
    assert.deepStrictEqual(r.selesai, ['Sudah Diterima']);
  });

  await test('cobaKlaim: Discord minta captcha -> dicatat, tidak melempar, tidak diulang', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    let claim = 0;
    r.api = async (path) => {
      if (path.includes('/claim-reward')) {
        claim += 1;
        return { status: 400, json: { captcha_key: ['captcha-required'], captcha_sitekey: 'abc', captcha_service: 'hcaptcha' } };
      }
      return { status: 200, json: { quests: [
        q('9', 'Siap Diklaim', { selesai: true }),
        q('8', 'Belum Selesai'),
      ] } };
    };
    const h = await r.cobaKlaim();
    assert.strictEqual(h.dicoba, 1, 'hanya quest selesai-yang belum diklaim yang dicoba');
    assert.strictEqual(h.perluCaptcha.length, 1);
    assert.strictEqual(h.terklaim.length, 0);
    assert.strictEqual(claim, 1);
    // percobaan kedua (tanpa paksa) TIDAK mengirim lagi — biar tidak spam Discord
    const h2 = await r.cobaKlaim();
    assert.strictEqual(h2.dicoba, 0, 'tidak mencoba ulang quest yang sama');
    assert.strictEqual(claim, 1);
    // dengan paksa -> boleh coba lagi
    const h3 = await r.cobaKlaim({ paksa: true });
    assert.strictEqual(h3.dicoba, 1);
    assert.strictEqual(claim, 2);
  });

  await test('cobaKlaim: kalau Discord mengizinkan (200) -> tercatat terklaim', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), beatSec: 0 });
    r.api = async (path, body, method) => {
      if (path.includes('/claim-reward')) return { status: 200, json: { entitlements: [{ sku_id: '1' }] } };
      return { status: 200, json: { quests: [q('7', 'Quest Orb', { selesai: true })] } };
    };
    const h = await r.cobaKlaim();
    assert.strictEqual(h.terklaim.length, 1, 'harus tercatat terklaim');
    assert.strictEqual(h.perluCaptcha.length, 0);
    assert.strictEqual(r._klaimDicoba.size, 1);
  });

  await test('cekSekarang: pemeriksaan otomatis yang overlap tidak menumpuk permintaan', async () => {
    const r = new QuestRunner({ token: 'x', log, ps5: ps5Tiruan(), otomatis: true });
    let jumlahPanggilan = 0;
    let lepaskan;
    const gate = new Promise((resolve) => { lepaskan = resolve; });
    r.antrianLayak = async () => {
      jumlahPanggilan += 1;
      if (jumlahPanggilan === 1) await gate;
      return [];
    };

    const pertama = r.cekSekarang('jadwal');
    await Promise.resolve();
    const kedua = await r.cekSekarang('jadwal');
    assert.deepStrictEqual(kedua, { ok: false, error: 'pemeriksaan quest sebelumnya masih berjalan' });
    assert.strictEqual(jumlahPanggilan, 1, 'hanya ada satu GET daftar quest saat request lambat');

    lepaskan();
    assert.strictEqual((await pertama).jumlah, 0);
    assert.strictEqual(r._cekSedang, false, 'kunci dibuka kembali setelah request selesai');
    assert.strictEqual((await r.cekSekarang('jadwal')).jumlah, 0, 'pemeriksaan berikutnya tetap bisa jalan');
    assert.strictEqual(jumlahPanggilan, 2);
    r.stop();
  });

  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
  // penjalan quest meninggalkan timer (beat/putar) yang membuat proses
  // menggantung — keluar dengan tenang seperti uji lain
  process.exit(process.exitCode || 0);
})();
