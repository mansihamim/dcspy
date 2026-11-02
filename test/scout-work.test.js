'use strict';

const assert = require('node:assert/strict');
const { Scout } = require('../src/scout');

async function main() {
  const logLines = [];
  const log = {
    info: (...args) => logLines.push(args.join(' ')),
    warn: (...args) => logLines.push(args.join(' ')),
    error: (...args) => logLines.push(args.join(' ')),
  };
  let called = 0;
  const quest = {
    aktif: false,
    kena401: false,
    kerjakanLuar: async (arr, trans, asal) => {
      called += 1;
      assert.equal(arr.length, 1);
      assert.equal(typeof trans, 'function');
      assert.equal(asal, 'scout:be');
      return {
        ok: true,
        jumlah: 1,
        selesai: [{ id: 'clean-crew', nama: 'Clean Crew' }],
        gagal: [],
        dilewati: [],
      };
    },
  };
  const scout = new Scout({ token: 'fake', log, quest, enabled: true });
  scout.kontrol = { close() {} };
  scout.portSocks = 9190;
  scout._identSaatIni = 'be-test';
  scout._alert = () => {};
  scout._segarkanIdSet = async () => {};

  const cleanCrew = {
    id: 'clean-crew',
    config: {
      messages: { quest_name: 'Clean Crew' },
      task_config_v2: { tasks: { PLAY_ON_DESKTOP: { target: 900 } } },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    user_status: {},
  };
  const hasil = await scout._kerjakan([cleanCrew], 'be');
  assert.equal(hasil, 'kerja');
  assert.equal(called, 1);
  assert.equal(scout.stat.dikerjakanTotal, 1);
  assert.equal(scout.stat.kerjaTotal, 1);
  assert.ok(logLines.some((line) => line.includes('mengerjakan 1 quest')));

  quest.aktif = true;
  assert.equal(await scout._kerjakan([cleanCrew], 'us'), 'kerja', 'runner sibuk menghentikan rotasi negara');
  assert.equal(scout.antriKerja.length, 1, 'temuan masuk antrean sampai batch aktif selesai');
  quest.aktif = false;

  const psnOnly = {
    id: 'psn-only',
    config: {
      messages: { quest_name: 'Konsol saja' },
      task_config_v2: { tasks: { PLAY_ON_PLAYSTATION: { target: 900 } } },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    user_status: {},
  };
  assert.equal(scout._ringkasSatu(psnOnly).supported, false, 'quest console-only bukan pekerjaan yang bisa diselesaikan oleh runner desktop/video');
  assert.equal(await scout._kerjakan([psnOnly], 'jp'), 'kosong', 'hasil 0 untuk negara ini boleh langsung lanjut');
  assert.equal(called, 1, 'quest console-only tidak dikirim ke runner');

  const noExpiry = {
    id: 'no-expiry',
    config: { messages: { quest_name: 'Tanpa tanggal akhir' }, task_config_v2: { tasks: { PLAY_ON_DESKTOP: { target: 900 } } } },
    user_status: {},
  };
  const noExpirySummary = scout._ringkasSatu(noExpiry);
  assert.equal(noExpirySummary.exp, Number.MAX_SAFE_INTEGER, 'tanggal akhir yang hilang tidak mengubah quest aktif menjadi kedaluwarsa');

  const staleDone = {
    ...cleanCrew,
    user_status: { completed_at: 'stale', progress: { PLAY_ON_DESKTOP: { value: 840 } } },
  };
  const mismatch = scout._ringkasSatu(staleDone);
  assert.equal(mismatch.selesai, false, 'Scout tidak menyisihkan quest yang progress-nya kurang satu menit');
  assert.equal(mismatch.selesaiTidakSinkron, true);

  const rotate = new Scout({ token: 'fake', log, enabled: true, tokenKhusus: true });
  rotate.negara = [{ cc: 'aa', fps: ['A'] }, { cc: 'bb', fps: ['B'] }];
  rotate.burstMaks = 2;
  rotate.jedaAntar = 0;
  rotate._tulisJson = () => {};
  rotate._susunUrutan = () => {};
  rotate._cekDariId = async () => ({ ok: true, layak: 0 });
  const scanned = [];
  rotate._pindaiNegara = async (country) => { scanned.push(country.cc); return 'kosong'; };
  const rotated = await rotate._tick();
  assert.equal(rotated, 'kosong');
  assert.deepEqual(scanned, ['aa', 'bb'], 'negara kosong dilewati tanpa menunggu putaran berikutnya');
  rotate.stop();

  let pemindaianSaatSibuk = 0;
  const busy = new Scout({
    token: 'fake', log, enabled: true, tokenKhusus: true,
    quest: { aktif: true, sisaJeda: () => 0 },
  });
  busy.negara = [{ cc: 'aa', fps: ['A'] }];
  busy._kerjakanAntrean = async () => '';
  busy._pindaiNegara = async () => { pemindaianSaatSibuk += 1; return 'kosong'; };
  assert.equal(await busy._tick(), 'id', 'Scout menunggu batch aktif selesai');
  assert.equal(pemindaianSaatSibuk, 0, 'Scout tidak memindai negara lain saat quest masih dikerjakan');
  busy.stop();

  const waitForWork = new Scout({ token: 'fake', log, enabled: true, tokenKhusus: true });
  waitForWork.negara = [{ cc: 'aa', fps: ['A'] }, { cc: 'bb', fps: ['B'] }];
  waitForWork.burstMaks = 2;
  waitForWork.jedaAntar = 0;
  waitForWork._tulisJson = () => {};
  waitForWork._susunUrutan = () => {};
  waitForWork._cekDariId = async () => ({ ok: true, layak: 0 });
  let lepasKerja;
  const selesaiKerja = new Promise((resolve) => { lepasKerja = resolve; });
  const urutan = [];
  waitForWork._pindaiNegara = async (country) => {
    urutan.push(country.cc);
    if (country.cc === 'aa') return selesaiKerja;
    return 'kosong';
  };
  const putaran = waitForWork._tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urutan, ['aa'], 'tidak pindah negara saat quest negara pertama masih dikerjakan');
  lepasKerja('kerja');
  assert.equal(await putaran, 'kerja');
  assert.deepEqual(urutan, ['aa']);
  waitForWork.stop();

  console.log('scout-work.test.js — passed (auto-work handoff; unsupported console paths; accurate completion; rotate empty countries; wait for work).');
}

main().catch((err) => {
  console.error('scout-work.test.js — FAIL', err.stack || err.message);
  process.exitCode = 1;
});
