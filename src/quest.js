'use strict';

/**
 * ============================================================================
 *  Penjalan Quest Discord — desktop + video, dengan auto-accept (enroll)
 * ============================================================================
 *
 *  Cara Discord menghitung quest (dari hasil pembongkaran klien & bot sejenis):
 *
 *   1. Quest harus DITERIMA dulu (accept) — kalau belum, setiap heartbeat
 *      ditolak: HTTP 403 { code: 260000, "User is not enrolled..." }.
 *      Terima quest  : POST /quests/{id}/enroll
 *                      body { location: 11, is_targeted: false, metadata_raw: null }
 *
 *   2. PLAY_ON_DESKTOP (main game X menit):
 *      POST /quests/{id}/heartbeat  body { application_id, terminal: false }
 *      dikirim berkala (klien resmi tiap ±20 detik) selama presence kita
 *      menampilkan aplikasi itu di platform desktop.
 *      Setelah target tercapai: heartbeat terakhir dengan terminal: true.
 *
 *   3. WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE (nonton video X detik):
 *      POST /quests/{id}/video-progress  body { timestamp: <detik> }
 *      timestamp naik terus (klien +7 detik per detik), TAPI server hanya
 *      menerima sampai (waktu sejak quest diterima + 10 detik) — jadi
 *      pacenya diatur di sini, bukan lompat langsung ke target.
 *
 *   4. Quest jalur konsol (PLAY_ON_PLAYSTATION / PLAY_ON_XBOX) tidak bisa
 *      dikerjakan dari skrip: Discord memverifikasi ke server Sony/Microsoft.
 *      Kalau quest juga punya jalur desktop, jalur desktopnya tetap dikerjakan.
 *
 *  Klaim hadiah TETAP manual (Discord meminta captcha / konfirmasi di aplikasi).
 * ============================================================================
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { targetFor, readTaskProgress, completionState } = require('./quest-progress');

const API = 'https://discord.com/api/v9';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';

/**
 * X-Super-Properties — WAJIB. Tanpa header ini Discord menganggap permintaan
 * datang dari klien tak dikenal dan TIDAK menyajikan quest bertarget
 * (termasuk semua quest "nonton video"): hasilnya 0 quest, padahal di aplikasi
 * ada puluhan. Diuji 1 Okt: tanpa header -> 0 quest, dengan header -> 97 quest
 * (30 main-game + 67 nonton video).
 */
const SUPER_PROPERTIES = Buffer.from(
  JSON.stringify({
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: '1.0.9215',
    os_version: '10.0.19045',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: 'en-US',
    has_client_mods: false,
    client_launch_id: randomUUID(),
    browser_user_agent: UA,
    browser_version: '37.6.0',
    os_sdk_version: '19045',
    client_build_number: 471091,
    native_build_number: 72186,
    client_event_source: null,
  }),
).toString('base64');

/** jenis tugas yang bisa dikerjakan skrip ini */
const BISA_DESKTOP = 'PLAY_ON_DESKTOP';
const JENIS_VIDEO = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];

/** pengaturan pace video (mengikuti klien resmi) */
const VIDEO_MAJU = 7; // detik yang dikirim per tick
const VIDEO_TICK_MS = 1000; // jeda antar tick (bisa diubah lewat QUEST_VIDEO_TICK_MS)
const VIDEO_MASADEPAN = 10; // server hanya menerima sampai (lama sejak diterima + 10 detik)

/** Ringkasan quest jalur konsol (tidak bisa dikerjakan dari skrip). */
function kosongKonsol() {
  const jenis = () => ({ total: 0, lewatDesktop: 0, tanpaDesktop: 0, layak: 0, nama: [] });
  return { playstation: jenis(), xbox: jenis(), lain: jenis() };
}

class QuestRunner extends EventEmitter {
  /**
   * @param {{token:string, log:any, ps5:any, apiVersion?:string, beatSec?:number}} opts
   */
  constructor({ token, log, ps5, apiVersion = 'v9', beatSec = 30, otomatis, otomatisMenit }) {
    super();
    this.token = token;
    /** rute khusus (dipakai Scout): fungsi transport SOCKS; null = fetch biasa */
    this.transport = null;
    /** pengait dari Scout: putar sirkuit Tor kalau rute gagal di level jaringan */
    this.rotasiRute = null;
    /** true = permintaan kerja dipindah ke rute luar negeri (dipilih otomatis) */
    this.pakaiRute = false;
    /**
     * Quest yang sudah SELESAI di sesi ini — tidak boleh didaftarkan/dikerjakan
     * lagi (dulu sempat diulang -> borong permintaan & kena batas laju 214 dtk).
     */
    this.pernahSelesai = new Set();
    /**
     * Batas laju PANJANG dari Discord (mis. retry_after 32 menit). Dulu bot
     * TIDUR di dalam permintaan selama itu tanpa log (kelihatan menggantung);
     * sekarang bot berhenti sopan lalu melanjutkan sendiri.
     */
    this.limitSampai = 0;
    this._lanjutTimer = null;
    /**
     * Tenggang tambahan SETELAH batas laju habis (detik). Discord menaikkan
     * retry_after kalau bucket-nya disentuh lagi sebelum benar-benar dingin
     * (malam ini 1934 dtk -> 3133 dtk). Setelah cooldown panjang, bot menunggu
     * lebih dulu sebelum mengetuk pintu lagi.
     */
    this.graceDetik = 0;
    /** berkas kecil supaya cooldown tetap dihormati walau bot mulai ulang */
    this.berkasJeda = require('path').join(__dirname, '..', '.scout', 'jeda.json');
    /** label asal kerja (mis. "scout:jp") — ditampilkan di dashboard */
    this.asalNegara = null;
    /** true kalau Discord pernah menjawab 401 (token mati) — scout auto-jeda */
    this.kena401 = false;
    /** kapan 401 terakhir + jeda uji ulang (token kadang hanya diblokir sementara) */
    this.kena401At = 0;
    this.uji401Ms = Math.max(60000, Number(process.env.QUEST_401_RETRY_MENIT || 10) * 60000);
    /** hitungan 429 (dipakai scout untuk melambat sendiri kalau kena batas) */
    this.stat429 = 0;
    /**
     * OTOMATIS (tanpa tombol): tiap QUEST_OTOMATIS_MENIT menit bot memeriksa
     * sendiri apakah ada quest yang bisa dikerjakan, lalu mengerjakannya —
     * tidak perlu menekan apa pun di dashboard.
     */
    this.otomatis = String(process.env.QUEST_OTOMATIS || 'true').toLowerCase() !== 'false';
    // 1 menit = terasa instan; masih bisa diubah lewat QUEST_OTOMATIS_MENIT
    this.otomatisMenit = Math.max(
      1,
      Number(otomatisMenit || process.env.QUEST_OTOMATIS_MENIT || 1) || 1,
    );
    if (otomatis !== undefined) this.otomatis = String(otomatis).toLowerCase() !== 'false';
    this._otomatisTimer = null;
    this._otomatisStartTimer = null;
    this._cekSelesaiTimer = null;
    this._cekTerakhir = 0;
    this._cekSedang = false;
    this._otomatisBerhenti = false;
    this.log = log;
    this.ps5 = ps5;
    this._muatJeda(); // hormati catatan batas laju dari sesi sebelumnya
    this.apiVersion = apiVersion;
    /** jeda heartbeat desktop — klien resmi memakai ±20 detik (0 diizinkan untuk tes) */
    const envBeat = process.env.QUEST_BEAT_SEC;
    this.beatSec = envBeat != null && envBeat !== '' ? Number(envBeat) : Number(beatSec);
    if (!Number.isFinite(this.beatSec)) this.beatSec = 30;
    /** ganti presence saat mengerjakan quest? default TIDAK (quest tetap selesai) */
    this.ubahPresence = String(process.env.QUEST_UBAH_PRESENCE || 'false').toLowerCase() === 'true';
    /** coba KLAIM dari API begitu quest selesai? default TIDAK (uji celah klaim tanpa browser) */
    this.claimCoba = String(process.env.QUEST_CLAIM_COBA || 'false').toLowerCase() === 'true';
    /** id quest yang sudah pernah dicoba klaim (biar tidak spam) */
    this._klaimDicoba = new Set();
    /** pace video */
    // jeda sopan antar permintaan ke Discord (token ini juga dipakai hal lain).
    // Bisa dikecilkan lewat env untuk uji; bawaan tetap 1,2 dtk.
    this.jedaKerja = Math.max(0, Number(process.env.QUEST_JEDA_KERJA_MS != null ? process.env.QUEST_JEDA_KERJA_MS : 1200) || 0);
    this.videoTickMs = Number(process.env.QUEST_VIDEO_TICK_MS || VIDEO_TICK_MS) || VIDEO_TICK_MS;
    this.videoMaju = Number(process.env.QUEST_VIDEO_MAJU || VIDEO_MAJU) || VIDEO_MAJU;
    this.videoMasaDepan = Number(process.env.QUEST_VIDEO_MASADEPAN || VIDEO_MASADEPAN) || VIDEO_MASADEPAN;

    this.timer = null;
    this.stopped = false;
    this.batalFlag = false;

    /** tidur yang bisa dibangunkan: BANYAK tidur sekaligus (mode paralel) */
    this._tidur = new Set();
    this._putarTimer = null;
    this._hasil = new Map();

    /** keadaan yang dipakai dashboard */
    this.aktif = false;
    this.mode = null; // 'satu' | 'auto'
    this.sedang = null; // quest utama (kompat dashboard lama)
    this.aktifList = []; // SEMUA quest yang sedang dikerjakan bersamaan
    this.antrian = []; // tidak dipakai lagi (semua jalan sekaligus)
    this.selesai = []; // nama yang berhasil
    this.gagal = []; // { nama, sebab }
    this.dilewati = []; // { nama, sebab } — mis. belum diterima / kedaluwarsa
    this.mulaiJam = null;
    this.pemulihan = null;
  }

  headers() {
    return {
      Authorization: this.token,
      'User-Agent': UA,
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
      'X-Discord-Locale': 'en-US',
      'X-Super-Properties': SUPER_PROPERTIES,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Ganti token HANYA untuk keperluan quest (kartu "Token quest" di dashboard).
   * Presence/status, PS5, Roblox, Spotify TIDAK memakai token ini.
   */
  setToken(tokenBaru) {
    const t = String(tokenBaru || '').trim();
    if (!t) return { ok: false, error: 'token kosong' };
    this.token = t;
    this.kena401 = false;
    this._otomatisBerhenti = false; // token baru = otomatis boleh jalan lagi
    this.log.info('Quest: token diperbarui; nilai token tidak dicatat.');
    this.emit('change');
    return { ok: true };
  }

  /**
   * GET/POST dengan retry untuk 429 (rate limit) & 5xx.
   * @param {string} path
   * @param {any} body
   * @param {string} method
   * @param {Function|null} trans rute khusus (Scout): transport SOCKS dari
   *   socks.js. null/kosong = fetch biasa (koneksi server sendiri).
   */
  async api(path, body, method = 'GET', trans = null) {
    let terakhir = null;
    for (let coba = 0; coba < 4; coba += 1) {
      let r;
      const fnTrans = trans || this.transport;
      if (fnTrans) {
        // lewat rute khusus (mis. Tor) — satu permintaan, hasil sudah JSON
        try {
          const h = await fnTrans(`${API}${path}`, {
            method,
            headers: this.headers(),
            body: method === 'GET' ? undefined : JSON.stringify(body || {}),
            timeoutMs: 60000,
          });
          r = {
            status: (h && h.status) || 0,
            // pesan galat asli ikut dibawa (dulu dibuang -> log cuma "HTTP 0")
            json: (h && h.json) || (h && h.error ? { message: h.error } : null),
          };
        } catch (e) {
          r = { status: 0, json: { message: e && e.message ? e.message : String(e) } };
        }
        if (!r.status) {
          terakhir = r;
          // gagal di level jaringan: putar sirkuit sekali (kalau ada pengait) baru ulangi
          if (coba === 0 && this.rotasiRute) {
            try {
              await this.rotasiRute();
            } catch {
              /* abaikan */
            }
          }
          await this._tunggu(1500 * (coba + 1));
          continue;
        }
      } else {
        let res;
        try {
          res = await fetch(`${API}${path}`, {
            method,
            headers: this.headers(),
            body: method === 'GET' ? undefined : JSON.stringify(body || {}),
          });
        } catch (e) {
          terakhir = { status: 0, json: { message: e.message } };
          await this._tunggu(1500 * (coba + 1));
          continue;
        }
        let jsonMentah = null;
        try {
          jsonMentah = await res.json();
        } catch {
          /* boleh kosong */
        }
        r = { status: res.status, json: jsonMentah };
      }
      if (r.status === 429) {
        const tunggu = Number((r.json || {}).retry_after) || 5;
        this.stat429 += 1;
        if (tunggu > 300) {
          // Batas laju panjang: jangan tidur selama itu di dalam permintaan.
          const sebelumnya = this.limitSampai;
          /*
           * Kalau cooldown sebelumnya BARU SAJA habis (<=2 menit) lalu kita sudah
           * kena batas laju panjang lagi, berarti bucket Discord belum dingin:
           * tambah tenggang 5 menit (maks 15) supaya makin sopan.
           */
          if (sebelumnya && Date.now() - sebelumnya < 120000) {
            this.graceDetik = Math.min(900, (this.graceDetik || 0) + 300);
          }
          this.limitSampai = Date.now() + Math.ceil(tunggu * 1000) + this.graceDetik * 1000;
          this._simpanJeda();
          const jam = new Date(this.limitSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          this.log.warn(
            `Quest: batas laju Discord ${Math.ceil(tunggu / 60)} menit — quest dijeda, lanjut otomatis sekitar pukul ${jam}` +
              (this.graceDetik ? ` (termasuk tenggang ${Math.round(this.graceDetik / 60)} menit)` : '') +
              '.',
          );
          this._jadwalkanLanjut();
          this.emit('change');
          return { status: 429, json: { ...(r.json || {}), limitPanjang: true } };
        }
        this.log.warn(`Quest: kena batas laju Discord — tunggu ${Math.ceil(tunggu)} detik.`);
        terakhir = r; // kalau semua percobaan habis, kembalikan 429 yang asli (dulu jadi status 0)
        await this._tunggu(Math.min(Math.ceil(tunggu * 1000) + 500, 60000));
        continue;
      }
      if (r.status >= 500) {
        terakhir = { status: r.status, json: r.json };
        await this._tunggu(1500 * (coba + 1));
        continue;
      }
      if (r.status === 401) {
        this.kena401 = true;
        this.kena401At = Date.now();
        this.emit('token401');
      }
      return { status: r.status, json: r.json };
    }
    return terakhir || { status: 0, json: null };
  }

  /** POST yang benar (dulu sempat salah jadi GET -> HTTP 405, progres mandek 0). */
  post(path, body, trans = null) {
    return this.api(path, body, 'POST', trans);
  }

  /**
   * Permintaan KERJA (progres/heartbeat). Cerdas memilih jalur:
   * LANGSUNG dulu (paling cepat & paling stabil), pindah ke rute luar negeri
   * hanya kalau Discord menolak/memutus jalur langsung. Yang benar-benar butuh
   * rute negara lain cuma PENDAFTARAN (enroll) quest yang terkunci wilayah.
   */
  async _postKerja(path, body, trans = null) {
    if (!trans || this.pakaiRute) return this.post(path, body, this.pakaiRute ? trans : null);
    const h = await this.post(path, body, null);
    if (h.status === 200) return h;
    const kode = h.json && h.json.code;
    const perluRute =
      h.status === 0 || h.status === 403 || h.status === 404 || kode === 260000 || kode === 260008;
    if (!perluRute) return h;
    if (!this._ruteDiumumkan) {
      this._ruteDiumumkan = true;
      this.log.info(
        `Quest: jalur langsung ditolak (HTTP ${h.status}) — dilanjutkan lewat rute ${this.asalNegara || 'luar negeri'}.`,
      );
    }
    this.pakaiRute = true;
    return this.post(path, body, trans);
  }

  /* =========================== daftar quest =========================== */

  /** Ambil jenis tugas & target/progres untuk tugas yang bisa dikerjakan. */
  static ringkasTugas(tasks, us) {
    const jenis = Object.keys(tasks || {});
    const pilih = [];
    const tambah = (type) => {
      const progress = readTaskProgress(us, type);
      pilih.push({
        jenis: type,
        target: targetFor(tasks[type], type),
        value: progress.value,
        valueKnown: progress.known,
      });
    };
    if (tasks[BISA_DESKTOP]) tambah(BISA_DESKTOP);
    for (const type of JENIS_VIDEO) if (tasks[type]) tambah(type);
    return { jenis, pilih };
  }

  /**
   * Semua quest + status, jenis tugas, dan alasannya kalau tidak bisa dikerjakan.
   */
  async daftar(trans = null) {
    const { status, json } = await this.api('/quests/@me', undefined, 'GET', trans);
    if (status !== 200 || !json) {
      return { ok: false, status, error: `HTTP ${status}`, quests: [], konsol: kosongKonsol() };
    }
    const semua = json.quests || json;
    const arr = Array.isArray(semua) ? semua : Object.values(semua);
    const { out, konsol } = this._petakan(arr);
    return { ok: true, quests: out, konsol };
  }

  /** Mapping daftar mentah Discord -> struktur internal (dipakai daftar() & Scout). */
  _petakan(arr) {
    const kini = Date.now();
    const out = [];
    const konsol = kosongKonsol();

    for (const q of arr) {
      const cfg = q.config || {};
      const us = q.user_status || {};
      const tasks = (cfg.task_config_v2 || cfg.task_config || {}).tasks || {};
      const mulai = cfg.starts_at ? Date.parse(cfg.starts_at) : null;
      const exp = cfg.expires_at ? Date.parse(cfg.expires_at) : null;
      const nama = (cfg.messages && cfg.messages.quest_name) || (cfg.application && cfg.application.name) || '?';
      const kedaluwarsa = Boolean(exp && exp < kini);
      const belumMulai = Boolean(mulai && mulai > kini);
      const selesaiServer = Boolean(us.completed_at);
      const diklaim = Boolean(us.claimed_at);
      const diikuti = Boolean(us.enrolled_at);

      const { jenis, pilih } = QuestRunner.ringkasTugas(tasks, us);

      // jalur konsol dihitung per platform (satu quest bisa punya PSN DAN Xbox)
      const jalur = [];
      if (tasks.PLAY_ON_PLAYSTATION) jalur.push('playstation');
      if (tasks.PLAY_ON_XBOX) jalur.push('xbox');
      if (!pilih.length) {
        const jenisKonsol = jalur.length ? jalur : Object.keys(tasks).length ? ['lain'] : [];
        for (const jn of jenisKonsol) {
          const k = konsol[jn];
          k.total += 1;
          k.tanpaDesktop += 1;
          if (!selesaiServer && !diklaim && !kedaluwarsa && !belumMulai) {
            k.layak += 1;
            if (k.nama.length < 5) k.nama.push(nama.trim());
          }
        }
        continue;
      }
      for (const jn of jalur) {
        konsol[jn].total += 1;
        konsol[jn].lewatDesktop += 1;
      }

      const app = (tasks[BISA_DESKTOP] && (tasks[BISA_DESKTOP].applications || [])[0]) ||
        cfg.application || {};
      const dipilih = pilih[0];
      const statusSelesai = completionState(us, dipilih.jenis, dipilih.target);
      const selesai = statusSelesai.completed;
      const selesaiTidakSinkron = statusSelesai.mismatch;

      let alasan = '';
      if (diklaim) alasan = 'sudah diklaim';
      else if (selesaiTidakSinkron) {
        alasan = `status selesai Discord bertentangan dengan progres ${dipilih.value}/${dipilih.target} detik — belum dianggap selesai`;
      } else if (selesai) alasan = 'sudah selesai — tinggal klaim di app Discord';
      else if (kedaluwarsa) alasan = 'kedaluwarsa';
      else if (belumMulai) alasan = 'belum dimulai (menunggu waktu Discord)';
      else if (!diikuti) alasan = 'belum diterima — akan diterima otomatis';

      out.push({
        id: q.id,
        nama,
        penerbit: (cfg.messages && cfg.messages.game_publisher) || '',
        appId: app.id || '',
        jenis: dipilih.jenis, // tugas yang akan dikerjakan
        jenisSemua: jenis, // semua jalur yang dipunyai quest
        video: JENIS_VIDEO.includes(dipilih.jenis),
        target: dipilih.target,
        progress: dipilih.value,
        progressDiketahui: dipilih.valueKnown,
        diikuti,
        diterima: us.enrolled_at ? Date.parse(us.enrolled_at) : null,
        selesai,
        selesaiTidakSinkron,
        diklaim,
        kedaluwarsa,
        belumMulai,
        berakhir: cfg.expires_at || null,
        hadiah: ((cfg.rewards_config && cfg.rewards_config.rewards) || [])
          .map((r) => (r.orb_quantity ? `${r.orb_quantity} Orbs` : (r.messages && r.messages.name) || 'hadiah'))
          .join(' + '),
        alasan,
      });
    }

    const bobot = (q) => (q.selesai ? 3 : q.kedaluwarsa || q.belumMulai ? 2 : q.diikuti ? 0 : 1);
    out.sort((a, b) => bobot(a) - bobot(b) || (a.berakhir || '9999').localeCompare(b.berakhir || '9999'));
    return { out, konsol };
  }

  /** Yang benar-benar bisa dikerjakan dari hasil _petakan() (desktop/video, aktif, belum selesai). */
  static pilihLayak(out) {
    return out
      .filter((q) => !q.selesai && !q.diklaim && !q.kedaluwarsa && !q.belumMulai)
      .sort(
        (a, b) =>
          (a.video ? 0 : 1) - (b.video ? 0 : 1) || // video dulu (cepat, hitungan detik)
          String(a.berakhir || '9999').localeCompare(String(b.berakhir || '9999')),
      );
  }

  /** Yang benar-benar bisa dikerjakan sekarang (desktop/video, aktif, belum selesai). */
  async antrianLayak(trans = null) {
    const { ok, quests } = await this.daftar(trans);
    if (!ok) return [];
    return QuestRunner.pilihLayak(quests);
  }

  /** Nama resmi dari tabel game kita (biar presence pakai nama & ikon resmi Discord). */
  namaResmi(appId, fallback) {
    try {
      const { GAMES } = require('./ps5');
      const g = GAMES.find((x) => x.id === String(appId));
      if (g) return g.name;
    } catch {
      /* abaikan */
    }
    return fallback || '';
  }

  /* ============================== mulai =============================== */

  /** Kerjakan satu quest (tidak menunggu selesai). */
  async mulai(qid) {
    if (this.aktif) return { ok: false, error: `Masih ada yang jalan: ${this.sedang ? this.sedang.nama : this.mode}` };
    const { ok, quests } = await this.daftar();
    if (!ok) return { ok: false, error: 'Tidak bisa mengambil daftar quest dari Discord.' };
    const q = quests.find((x) => String(x.id) === String(qid));
    if (!q) return { ok: false, error: 'Quest tidak ditemukan.' };
    if (q.diklaim) return { ok: false, error: 'Quest ini sudah diklaim.' };
    if (q.selesai) return { ok: false, error: 'Quest ini sudah selesai — tinggal klaim di aplikasi Discord.' };
    if (q.kedaluwarsa) return { ok: false, error: `Quest "${q.nama}" sudah kedaluwarsa — tidak bisa dikerjakan lagi.` };
    if (q.belumMulai) return { ok: false, error: `Quest "${q.nama}" belum dimulai menurut jadwal Discord.` };

    this._jalan([q], 'satu');
    return { ok: true, quest: q };
  }

  /** Kerjakan SEMUA quest yang bisa dikerjakan, satu per satu. */
  async autoMulai() {
    if (this.aktif) return { ok: false, error: 'Sudah ada yang jalan — hentikan dulu.' };
    const layak = await this.antrianLayak();
    if (!layak.length) return { ok: false, error: 'Tidak ada quest yang bisa dikerjakan (semua selesai / kedaluwarsa / belum dimulai).' };
    this._jalan(layak, 'auto');
    return { ok: true, jumlah: layak.length, quests: layak.map((q) => ({ nama: q.nama, jenis: q.jenis, hadiah: q.hadiah })) };
  }

  /**
   * Dipakai SCOUT: kerjakan daftar quest yang dibaca DARI NEGARA LAIN lewat
   * rute tor (trans), menunggu sampai semua selesai, lalu kembalikan hasilnya
   * supaya scout baru pindah negara. Presence tetap TIDAK disentuh
   * (QUEST_UBAH_PRESENCE=false), jadi PS5/Roblox kamu aman.
   * @param {Array} mentah daftar quest mentah dari Discord (negara itu)
   * @param {Function} trans transport SOCKS (socks.js: transporSocks)
   * @param {string} label keterangan asal, mis. "scout:jp"
   */
  async kerjakanLuar(mentah, trans, label) {
    if (this.aktif) return { ok: false, error: 'masih ada quest lain yang sedang dikerjakan' };
    const arr = Array.isArray(mentah) ? mentah : (mentah && mentah.quests) || [];
    const { out } = this._petakan(arr);
    // quest yang sudah selesai di sesi ini tidak pernah diulang
    const layak = QuestRunner.pilihLayak(out).filter((q) => !this.pernahSelesai.has(String(q.id)));
    if (!layak.length) return { ok: false, error: 'tidak ada quest yang bisa dikerjakan di negara itu' };
    this.kena401 = false;

    const semuaSelesai = [];
    const semuaGagal = [];
    const semuaDilewati = [];
    let ronde = layak;
    for (let putar = 0; putar < 3; putar += 1) {
      await this._jalan(ronde, 'auto', { trans, label });
      const r = this._catatHasil(ronde);
      semuaSelesai.push(...r.selesai);
      semuaGagal.push(...r.gagal);
      semuaDilewati.push(...r.dilewati);
      if (this.kena401) break;
      // ulangi HANYA yang gagal (bukan selesai / kedaluwarsa / belum bisa diterima)
      const gagalId = new Set(r.gagal.filter((x) => !/kedaluwarsa/i.test(x.sebab)).map((x) => String(x.id)));
      ronde = ronde.filter((q) => gagalId.has(String(q.id)));
      if (!ronde.length) break;
      if (this.rotasiRute) {
        try {
          await this.rotasiRute(); // sirkuit baru sebelum dicoba lagi
        } catch {
          /* abaikan */
        }
      }
      this.log.warn(
        `Quest: ${ronde.length} quest belum berhasil — dicoba lagi (${putar + 1}/2)` +
          (label ? ` lewat rute ${label}` : '') +
          '.',
      );
    }
    // buang catatan "gagal/pending" untuk quest yang akhirnya SELESAI di ronde berikutnya
    const selesaiId = new Set(layak.filter((q) => this.pernahSelesai.has(String(q.id))).map((q) => String(q.id)));
    const bersih = (arr) => arr.filter((x) => !selesaiId.has(String(x.id))).map(({ nama, sebab }) => ({ nama, sebab }));
    const gagalAkhir = bersih(semuaGagal);
    const dilewatiAkhir = bersih(semuaDilewati);
    // simpan seluruh hasil (lintas ronde) untuk dashboard
    this.selesai = semuaSelesai.slice();
    this.gagal = gagalAkhir.slice();
    this.dilewati = dilewatiAkhir.slice();
    this.emit('change');
    return {
      ok: true,
      jumlah: layak.length,
      selesai: semuaSelesai,
      gagal: gagalAkhir,
      dilewati: dilewatiAkhir,
      kena401: this.kena401,
      uji401Menit: Math.round(this.uji401Ms / 60000),
    };
  }

  /* ========================= otomatis tanpa tombol ======================= */

  /** Nyalakan pemantau otomatis: quest baru langsung dikerjakan sendiri. */
  startOtomatis() {
    if (!this.otomatis || this._otomatisTimer) return;
    this.log.info(
      `Quest OTOMATIS: aktif — tiap ${this.otomatisMenit} menit bot memeriksa & ` +
        'mengejakan sendiri quest yang bisa dikerjakan (tanpa tombol).',
    );
    // pertama: beri waktu bot stabil dulu; timer disimpan agar bisa dibatalkan.
    this._otomatisStartTimer = setTimeout(() => {
      this._otomatisStartTimer = null;
      this.cekSekarang('awal').catch((e) => this.log.warn('Quest OTOMATIS: cek awal gagal — ' + e.message));
    }, 25000);
    this._otomatisTimer = setInterval(() => {
      this.cekSekarang('jadwal').catch((e) => this.log.warn('Quest OTOMATIS: cek jadwal gagal — ' + e.message));
    }, this.otomatisMenit * 60000);
  }

  stopOtomatis() {
    if (this._otomatisTimer) clearInterval(this._otomatisTimer);
    this._otomatisTimer = null;
    if (this._otomatisStartTimer) clearTimeout(this._otomatisStartTimer);
    this._otomatisStartTimer = null;
    if (this._cekSelesaiTimer) clearTimeout(this._cekSelesaiTimer);
    this._cekSelesaiTimer = null;
    if (this._lanjutTimer) clearTimeout(this._lanjutTimer);
    this._lanjutTimer = null;
  }

  /**
   * Pasang cooldown batas laju DARI LUAR (dipakai SCOUT: pemindaian memakai
   * token yang sama, jadi kalau scout kena 429 panjang, penjalan quest harus
   * ikut menunggu — bukan scout tidur 30 menit sendirian sambil penjalan
   * tetap menembak API dan memperpanjang hukuman).
   */
  pasangJeda(detik, sebab = 'api') {
    const sampai = Date.now() + Math.max(0, Number(detik) || 0) * 1000;
    if (sampai <= this.limitSampai) return this.sisaJeda(); // jangan memendekkan yang sudah ada
    this.limitSampai = sampai;
    this._simpanJeda();
    this._jadwalkanLanjut();
    try {
      const jam = new Date(this.limitSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      this.log.warn(`Quest: batas laju dari ${sebab} — jeda sampai ±${jam} (dicatat, tahan mulai ulang).`);
    } catch {
      /* log belum siap */
    }
    this.emit('change');
    return this.sisaJeda();
  }

  /** Sisa waktu cooldown batas laju (detik; 0 = tidak sedang dijeda). */
  sisaJeda() {
    return Math.max(0, Math.ceil((this.limitSampai - Date.now()) / 1000));
  }

  /* ------------------ cooldown batas laju (tahan mulai ulang) ------------------ */

  _muatJeda() {
    try {
      const fs = require('fs');
      const j = JSON.parse(fs.readFileSync(this.berkasJeda, 'utf8'));
      if (!j || !(Number(j.sampai) > Date.now())) return;
      this.limitSampai = Number(j.sampai);
      this.graceDetik = Math.max(0, Number(j.grace) || 0);
      try {
        const jam = new Date(this.limitSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        this.log.info(`Quest: batas laju Discord masih berlaku sampai ±${jam} (catatan tersimpan) — menunggu, tidak menghajar API.`);
      } catch { /* log belum siap — abaikan */ }
      this._jadwalkanLanjut();
    } catch {
      /* belum ada catatan — normal */
    }
  }

  _simpanJeda() {
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(this.berkasJeda), { recursive: true });
      fs.writeFileSync(this.berkasJeda, JSON.stringify({
        sampai: this.limitSampai, grace: this.graceDetik, ts: Date.now(),
      }));
    } catch {
      /* gagal menyimpan bukan masalah besar */
    }
  }

  /** Pengingat supaya bot lanjut sendiri begitu cooldown habis. */
  _jadwalkanLanjut() {
    if (this._lanjutTimer) clearTimeout(this._lanjutTimer);
    const sisa = this.limitSampai - Date.now();
    if (sisa <= 0) return;
    this._lanjutTimer = setTimeout(() => {
      this._lanjutTimer = null;
      if (this.stopped) return;
      const jam = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      this.log.info(`Quest: cooldown batas laju selesai (${jam}) — memeriksa quest lagi.`);
      this.cekSekarang('lanjut').catch(() => {});
    }, sisa + 5000);
  }

  /**
   * Periksa sekali sekarang: kalau ada quest yang bisa dikerjakan (dan tidak ada
   * yang sedang dikerjakan), kerjakan semuanya otomatis.
   * @param {string} dari 'awal' | 'jadwal' | 'manual' | 'selesai'
   */
  async cekSekarang(dari = 'jadwal') {
    if (this.stopped) return { ok: false, error: 'penjalan quest sedang dihentikan' };
    if (!this.otomatis && dari !== 'manual') return { ok: false, error: 'otomatis dimatikan (QUEST_OTOMATIS=false)' };
    if (this._cekSedang) return { ok: false, error: 'pemeriksaan quest sebelumnya masih berjalan' };
    if (this.aktif) return { ok: false, error: 'sedang ada quest yang dikerjakan' };
    if (this.sisaJeda() > 0 && dari !== 'manual') {
      this._jadwalkanLanjut();
      const jam = new Date(this.limitSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      if (!this._limitDiumumkan) {
        this._limitDiumumkan = true;
        this.log.info(`Quest OTOMATIS: masih dijeda batas laju Discord — lanjut otomatis sekitar pukul ${jam}.`);
      }
      return { ok: false, error: `batas laju Discord (lanjut ${jam})`, sisa: this.sisaJeda() };
    }
    if (this.kena401 && dari !== 'manual') {
      // Token ditolak: jangan menghajar API; uji ulang maksimal sekali per cooldown.
      const sudah = Date.now() - (this.kena401At || 0);
      if (sudah < this.uji401Ms) {
        if (!this._otomatisBerhenti) {
          const menit = Math.ceil((this.uji401Ms - sudah) / 60000);
          this._otomatisBerhenti = true;
          this.log.error(
            `Quest OTOMATIS: token ditolak (401) — bot berhenti menembak API. Mencoba lagi sendiri dalam ±${menit} menit; ` +
              'tempel token baru di dashboard kalau memang sudah mati.',
          );
        }
        return { ok: false, error: 'token 401' };
      }
      this.log.info('Quest OTOMATIS: uji ulang berkala setelah 401 — mengetuk sekali saja.');
      this.kena401At = Date.now();
    }

    // Kunci sebelum await: interval 1 menit / cek Scout / cek setelah selesai
    // tidak boleh menumpuk GET /quests/@me saat jaringan Discord lambat.
    this._cekSedang = true;
    this._cekTerakhir = Date.now();
    try {
      const layak = (await this.antrianLayak()).filter((q) => !this.pernahSelesai.has(String(q.id)));
      if (this.stopped) return { ok: false, error: 'penjalan quest sedang dihentikan' };
      if (this.aktif) return { ok: false, error: 'quest lain mulai saat pemeriksaan berlangsung' };
      if (!layak.length) {
        if (dari === 'manual') this.log.info('Quest OTOMATIS: tidak ada quest yang bisa dikerjakan sekarang.');
        return { ok: true, jumlah: 0 };
      }
      this.log.info(`Quest OTOMATIS (${dari}): ${layak.length} quest bisa dikerjakan — langsung dikerjakan.`);
      this._jalan(layak, 'auto');
      return { ok: true, jumlah: layak.length, quests: layak.map((q) => q.nama) };
    } finally {
      this._cekSedang = false;
    }
  }

  /** Hentikan (presence tetap dipulihkan). */
  batal() {
    if (!this.aktif) return { ok: false, error: 'Tidak ada quest yang sedang jalan.' };
    const nama = this.sedang ? this.sedang.nama : '-';
    this.batalFlag = true;
    this._bangunkan();
    return { ok: true, info: `Dihentikan: ${nama}` };
  }

  /** Tidur yang bisa dipotong: satu timeout per quest, tanpa polling tiap 250 ms. */
  _tunggu(ms) {
    if (this.batalFlag || this.stopped) return Promise.resolve();
    const durasi = Math.max(0, Number(ms) || 0);
    if (durasi === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const rec = { selesai: false, timer: null };
      rec.beres = () => {
        if (rec.selesai) return;
        rec.selesai = true;
        if (rec.timer) clearTimeout(rec.timer);
        this._tidur.delete(rec);
        resolve();
      };
      rec.timer = setTimeout(rec.beres, durasi);
      this._tidur.add(rec);
    });
  }

  /** Bangunkan SEMUA tidur yang sedang jalan (dipakai batal()/stop()). */
  _bangunkan() {
    for (const rec of [...this._tidur]) rec.beres();
  }

  /* ============================ inti kerja ============================ */

  /** Terima quest (accept). Dipakai untuk quest yang belum diikuti. */
  async _terima(q, trans = null) {
    const jejak = [];
    const sekali = async (fnTrans) => {
      const hasil = await this.post(
        `/quests/${q.id}/enroll`,
        { location: 11, is_targeted: false, metadata_raw: null },
        fnTrans,
      );
      if (hasil.status === 200) {
        const at = hasil.json && hasil.json.enrolled_at ? Date.parse(hasil.json.enrolled_at) : Date.now();
        return { ok: true, enrolledAt: at };
      }
      const pesan = (hasil.json && hasil.json.message) || `HTTP ${hasil.status}`;
      if (/already/i.test(pesan)) return { ok: true, enrolledAt: Date.now() }; // sudah terdaftar
      return {
        ok: false,
        pesan,
        status: hasil.status,
        kode: hasil.json && hasil.json.code,
        ditunda: Boolean(hasil.json && hasil.json.limitPanjang),
      };
    };
    const ulangLayak = (h) => h.status === 429 || h.status === 0 || (h.status >= 500 && h.status < 600);

    // (1) jalur LANGSUNG — quest biasa selesai di sini
    for (let c = 0; c < 3; c += 1) {
      const h = await sekali(null);
      if (h.ok) return h;
      if (h.ditunda) return { ok: false, pesan: h.pesan, ditunda: true };
      jejak.push(`langsung: ${h.pesan}`);
      if (!ulangLayak(h)) break; // mis. 404 "Unknown quest" -> memang cuma ada di negara lain
      await this._tunggu(2500 * (c + 1));
    }
    // (2) rute luar negeri (kalau ada) — inilah yang membuka quest terkunci wilayah
    if (trans) {
      for (let c = 0; c < 3; c += 1) {
        const h = await sekali(trans);
        if (h.ok) return h;
        if (h.ditunda) return { ok: false, pesan: h.pesan, ditunda: true };
        jejak.push(`rute: ${h.pesan}`);
        if (!ulangLayak(h)) break;
        if (h.status === 0 && this.rotasiRute) {
          try {
            await this.rotasiRute();
          } catch {
            /* abaikan */
          }
        }
        await this._tunggu(2500 * (c + 1));
      }
    }
    // (3) verifikasi ulang: kadang balasannya gagal, padahal sudah terdaftar
    for (const t of [null, trans]) {
      if (t === undefined) continue;
      try {
        const d = await this.daftar(t);
        const qq = (d.quests || []).find((x) => String(x.id) === String(q.id));
        if (qq && qq.diikuti) return { ok: true, enrolledAt: qq.diterima || Date.now() };
      } catch {
        /* coba jalur berikutnya */
      }
    }
    return { ok: false, pesan: jejak.slice(0, 3).join(' · ') || 'tanpa keterangan' };
  }

  /**
   * Baca hasil satu putaran dari _hasil (Map id -> hasil) lalu catat yang selesai
   * supaya tidak pernah diulang. Mengembalikan ringkasan.
   */
  _catatHasil(daftar) {
    const selesai = [];
    const gagal = [];
    const dilewati = [];
    const ditunda = [];
    for (const q of daftar) {
      const h = this._hasil.get(q.id);
      if (h === 'selesai') {
        selesai.push(q.nama);
        this.pernahSelesai.add(String(q.id));
      } else if (h === 'kedaluwarsa') {
        gagal.push({ id: String(q.id), nama: q.nama, sebab: 'kedaluwarsa' });
      } else if (h === 'ditunda') {
        ditunda.push({ id: String(q.id), nama: q.nama, sebab: 'batas laju Discord' });
      } else if (h === 'belum-diterima') {
        dilewati.push({ id: String(q.id), nama: q.nama, sebab: 'belum bisa diterima otomatis' });
      } else if (h === 'belum-dimulai') {
        dilewati.push({ id: String(q.id), nama: q.nama, sebab: 'belum dimulai' });
      } else if (h && h !== 'dibatalkan') {
        gagal.push({ id: String(q.id), nama: q.nama, sebab: h });
      }
    }
    return { selesai, gagal, dilewati, ditunda };
  }

  /** @param {Array} daftar @param {'satu'|'auto'} mode @param {{trans?:Function,label?:string}} opts */
  _jalan(daftar, mode, opts = {}) {
    this.aktif = true;
    this.mode = mode;
    this.batalFlag = false;
    this.selesai = [];
    this.gagal = [];
    this.dilewati = [];
    this.ditunda = [];
    this._hasil = new Map();
    this.mulaiJam = Date.now();
    this.antrian = []; // tidak ada antre lagi: semua dikerjakan BERSAMAAN
    this.aktifList = daftar.map((q) => ({
      qid: q.id, nama: q.nama, appId: q.appId, jenis: q.jenis, video: Boolean(q.video),
      value: q.progress || 0, target: q.target, hadiah: q.hadiah,
    }));
    this.sedang = this.aktifList[0] || null;

    // hanya disimpan kalau nanti presence benar-benar diubah (QUEST_UBAH_PRESENCE=true)
    this.pemulihan = this.ubahPresence
      ? { game: this.ps5.cfg.game, platform: this.ps5.platform, enabled: this.ps5.cfg.enabled }
      : null;

    this.asalNegara = opts.label || null;
    this.pakaiRute = false; // dipilih otomatis oleh _postKerja
    this._ruteDiumumkan = false;
    this.log.info(
      mode === 'auto'
        ? `Quest OTOMATIS: ${daftar.length} quest dikerjakan BERSAMAAN (sekaligus, tanpa antre).` +
          (this.asalNegara ? ` Dikerjakan lewat rute ${this.asalNegara}.` : '')
        : `Quest: mulai "${daftar[0].nama}" (${daftar[0].jenis}).`,
    );
    this.emit('change');

    // dikembalikan supaya pemanggil (Scout) bisa MENUNGGU sampai semua selesai
    return this._loop(daftar, opts.trans || null).catch((e) => {
      this.log.warn('Quest: berhenti karena error — ' + e.message);
      this._selesaiSemua();
    });
  }

  async _loop(daftar, trans = null) {
    /* 1) terima quest satu per satu (berurutan, jeda kecil) — dulu borongan
       sekaligus dan itu memicu batas laju 429 besar-besaran. Mengerjakannya
       tetap BERSAMAAN di langkah berikutnya. */
    for (const q of daftar) {
      if (this.batalFlag || this.stopped) break;
      if (q.diikuti) continue;
      const en = await this._terima(q, trans);
      if (en.ok) {
        q.diikuti = true;
        if (en.enrolledAt) q.diterima = en.enrolledAt;
        this.log.info(`Quest "${q.nama}": diterima otomatis (enroll).`);
      } else if (en.ditunda) {
        q.ditunda = en.pesan; // batas laju panjang: bukan gagal, dicoba setelah cooldown
        break;
      } else {
        q.tolak = en.pesan;
        this.log.warn(`Quest "${q.nama}": tidak bisa diterima otomatis — ${en.pesan}`);
      }
      await this._tunggu(this.jedaKerja); // sopan ke API (token ini juga dipakai bot)
    }
    if (daftar.some((q) => q.tolak)) {
      this.log.warn('Quest: yang belum bisa diterima akan dicoba lagi otomatis nanti.');
    }

    const siap = daftar.filter((q) => q.diikuti);
    const desktop = siap.filter((q) => q.jenis === BISA_DESKTOP);

    /* 2) presence: TIDAK disentuh — quest selesai dari heartbeat saja.
       (presence = jalur terpisah: mode PS5 / Roblox milik pemilik) */
    if (desktop.length) {
      if (this.ubahPresence) {
        try {
          this.ps5.applyGame(this.namaResmi(desktop[0].appId, desktop[0].nama) || desktop[0].nama);
          this.ps5.setPlatform('desktop');
          this.ps5.setEnabled(true);
        } catch (e) {
          this.log.warn('Quest: presence — ' + e.message);
        }
        this._mulaiPutar(desktop);
      } else {
        this.log.info('Quest: presence TIDAK diubah — status PS5/Roblox kamu tetap seperti semula.');
      }
    }

    /* 3) kerjakan SEMUANYA sekaligus */
    await Promise.all(siap.map((q) => this._kerja(q, trans)));

    /* 4) rangkum hasil (urutan tetap sesuai daftar) */
    for (const q of daftar) {
      if (q.tolak) {
        this.dilewati.push({ nama: q.nama, sebab: `belum bisa diterima otomatis (${q.tolak})` });
        continue;
      }
      if (q.ditunda) {
        this.ditunda.push({ nama: q.nama, sebab: 'batas laju Discord' });
        continue;
      }
      const h = this._hasil.get(q.id);
      if (h === 'ditunda') {
        this.ditunda.push({ nama: q.nama, sebab: 'batas laju Discord' });
        continue;
      }
      if (h === 'selesai') {
        this.selesai.push(q.nama);
        this.log.info(`Quest "${q.nama}" SELESAI (${q.hadiah}) — klaim di app Discord.`);
        this.emit('selesai', { ...q });
      } else if (h === 'kedaluwarsa') {
        this.gagal.push({ nama: q.nama, sebab: 'kedaluwarsa' });
      } else if (h === 'belum-diterima' || h === 'belum-dimulai') {
        this.dilewati.push({ nama: q.nama, sebab: h === 'belum-diterima' ? 'belum bisa diterima otomatis' : 'belum dimulai' });
      } else if (h && h !== 'dibatalkan') {
        this.gagal.push({ nama: q.nama, sebab: h });
      }
    }
    this._selesaiSemua();

    /* 5) uji celah: coba klaim langsung dari API (kalau dinyalakan QUEST_CLAIM_COBA) */
    if (this.claimCoba && this.selesai.length) {
      try {
        const hk = await this.cobaKlaim({ trans });
        this.klaimTerakhir = hk;
      } catch (e) {
        this.log.warn('Quest: uji klaim API — ' + e.message);
      }
    }
  }

  /**
   * COBA KLAIM dari API — uji "tanpa browser".
   * Satu percobaan per quest (kecuali paksa), TIDAK memakai jasa captcha.
   * Kalau Discord minta captcha: dicatat & dilewati; klaim tetap manual di app.
   */
  async cobaKlaim({ paksa = false, trans = null } = {}) {
    const hasil = { dicoba: 0, terklaim: [], perluCaptcha: [], gagal: [] };
    const list = await this.api('/quests/@me', undefined, 'GET', trans);
    if (list.status !== 200 || !list.json) {
      hasil.gagal.push({ pesan: `daftar quest HTTP ${list.status}` });
      return hasil;
    }
    const daftar = Array.isArray(list.json.quests) ? list.json.quests : [];
    const siap = daftar.filter((qq) => {
      const us = qq.user_status || {};
      return us.completed_at && !us.claimed_at;
    });
    if (!siap.length) {
      this.log.info('Quest: klaim API — tidak ada quest selesai yang belum diklaim.');
      return hasil;
    }
    for (const qq of siap) {
      const nama = ((qq.config || {}).messages || {}).quest_name || qq.id;
      if (!paksa && this._klaimDicoba.has(qq.id)) continue; // sudah dicoba -> jangan spam Discord
      this._klaimDicoba.add(qq.id);
      hasil.dicoba += 1;
      const r = await this.post(`/quests/${qq.id}/claim-reward`, {
        platform: 0,
        location: 11,
        metadata_sealed: null,
        traffic_metadata_sealed: null,
      }, trans);
      const mintaCaptcha = r.status === 400 && r.json && (r.json.captcha_key || r.json.captcha_sitekey);
      if (r.status === 200 || r.status === 204) {
        hasil.terklaim.push({ id: qq.id, nama });
        this.log.info(`Quest: KLAIM API BERHASIL — "${nama}" (tanpa captcha!).`);
      } else if (mintaCaptcha) {
        hasil.perluCaptcha.push({ id: qq.id, nama });
        this.log.warn(`Quest: klaim API ditolak untuk "${nama}" — Discord wajibkan captcha. Klaim manual di app Discord.`);
      } else {
        const pesan = (r.json && (r.json.message || JSON.stringify(r.json).slice(0, 140))) || '';
        hasil.gagal.push({ id: qq.id, nama, http: r.status, pesan });
        this.log.warn(`Quest: klaim API gagal untuk "${nama}" (HTTP ${r.status}) ${pesan}`);
      }
      await this._tunggu(this.jedaKerja);
    }
    this.emit('change');
    return hasil;
  }

  /** Satu quest: pilih jalurnya, simpan hasilnya. */
  async _kerja(q, trans = null) {
    const entri = this.aktifList.find((x) => String(x.qid) === String(q.id)) || null;
    let h;
    if (this.batalFlag || this.stopped) h = 'dibatalkan';
    else if (q.jenis === BISA_DESKTOP) h = await this._kerjaDesktop(q, entri, trans);
    else if (JENIS_VIDEO.includes(q.jenis)) h = await this._kerjaVideo(q, entri, trans);
    else h = 'jenis tugas belum didukung: ' + q.jenis;
    this._hasil.set(q.id, h);
    this.emit('change');
    return h;
  }

  /** Putar presence antar game quest desktop tiap 60 detik. */
  _mulaiPutar(desktop) {
    if (desktop.length < 2) return;
    let i = 0;
    clearInterval(this._putarTimer);
    this._putarTimer = setInterval(() => {
      if (this.batalFlag || this.stopped || !this.aktif) return;
      i = (i + 1) % desktop.length;
      const q = desktop[i];
      try {
        this.ps5.applyGame(this.namaResmi(q.appId, q.nama) || q.nama);
        this.emit('change');
      } catch {
        /* abaikan */
      }
    }, 60000);
  }

  /** PLAY_ON_DESKTOP: heartbeat berkala sampai target, tanpa menebak progres lokal. */
  async _kerjaDesktop(q, entri, trans = null) {
    let gagalBerturut = 0;
    let mandekBeats = 0;
    let progresTerakhir = Number.isFinite(Number(q.progress)) ? Number(q.progress) : null;
    const maksGagal = 5;
    const target = targetFor({ target: q.target }, BISA_DESKTOP);
    const sisaAwal = Math.max(0, target - (progresTerakhir || 0));
    // Ada batas keras supaya API 200/202 tanpa progres tidak membuat worker hidup selamanya.
    const batasDurasiMs = Math.max(180000, Math.min(7200000, sisaAwal * 2000 + 120000));
    const batasMandek = Math.max(5, Math.ceil(240 / Math.max(1, Number(this.beatSec) || 1)));
    const sampai = Date.now() + batasDurasiMs;

    while (!this.batalFlag && !this.stopped && Date.now() < sampai) {
      const { status, json } = await this._postKerja(
        `/quests/${q.id}/heartbeat`,
        { application_id: q.appId, terminal: false },
        trans,
      );
      const kode = json && json.code;

      if (status === 202) {
        // 202 = diterima tanpa isi; bukan bukti progres ataupun selesai.
        gagalBerturut = 0;
        mandekBeats += 1;
        if (mandekBeats >= batasMandek) return `progres belum terkonfirmasi (${entri && entri.value || 0}/${target} detik)`;
        await this._tunggu(this.beatSec * 1000);
        continue;
      }
      if (status === 200) {
        gagalBerturut = 0;
        const progress = readTaskProgress(json, BISA_DESKTOP);
        if (progress.known) {
          if (entri) entri.value = progress.value;
          if (progresTerakhir === null || progress.value !== progresTerakhir) mandekBeats = 0;
          else if (progress.value < target) mandekBeats += 1;
          progresTerakhir = progress.value;
        } else {
          mandekBeats += 1;
        }
        const v = progress.known ? progress.value : (entri && Number(entri.value)) || 0;
        this.log.info(`Quest "${q.nama}": ${v}/${target} detik (${Math.min(100, Math.floor((v / target) * 100))}%)`);
        this.emit('change');

        const selesai = completionState(json, BISA_DESKTOP, target);
        if (selesai.mismatch) {
          this.log.warn(`Quest "${q.nama}": Discord menandai selesai tetapi progres masih ${progress.value}/${target} detik — belum dihitung selesai; lanjut verifikasi.`);
        } else if (selesai.completed && !progress.known) {
          return 'selesai';
        }

        // Hanya nilai progres eksplisit dari Discord yang boleh memicu terminal.
        if (progress.known && progress.value >= target) {
          const akhir = await this._postKerja(
            `/quests/${q.id}/heartbeat`,
            { application_id: q.appId, terminal: true },
            trans,
          );
          const kodeAkhir = akhir.json && akhir.json.code;
          if (akhir.status === 404 || kodeAkhir === 260017) return 'kedaluwarsa';
          if (akhir.status === 403 && kodeAkhir === 260000) return 'belum-diterima';
          if (akhir.status === 429 && akhir.json && akhir.json.limitPanjang) return 'ditunda';
          if (akhir.status === 401) return 'heartbeat terminal ditolak (HTTP 401)';
          if (akhir.status >= 200 && akhir.status < 300) {
            const progressAkhir = readTaskProgress(akhir.json, BISA_DESKTOP);
            if (progressAkhir.known && entri) entri.value = progressAkhir.value;
            const selesaiAkhir = completionState(akhir.json, BISA_DESKTOP, target);
            if (!progressAkhir.known || progressAkhir.value >= target) return 'selesai';
            if (selesaiAkhir.mismatch) {
              this.log.warn(`Quest "${q.nama}": balasan terminal masih menunjukkan ${progressAkhir.value}/${target} detik — belum dihitung selesai.`);
            }
          } else {
            gagalBerturut += 1;
            this.log.warn(`Quest "${q.nama}": heartbeat terminal gagal (HTTP ${akhir.status}) — percobaan ${gagalBerturut}/${maksGagal}`);
            if (gagalBerturut >= maksGagal) return `heartbeat terminal gagal terus (HTTP ${akhir.status})`;
          }
        }
        if (mandekBeats >= batasMandek) return `progres berhenti di ${v}/${target} detik`;
      } else if (status === 429 && json && json.limitPanjang) {
        return 'ditunda';
      } else if (status === 404 || kode === 260017) {
        this.log.warn(`Quest "${q.nama}": sudah kedaluwarsa di Discord — dilewati.`);
        return 'kedaluwarsa';
      } else if (status === 403 && kode === 260000) {
        this.log.warn(`Quest "${q.nama}": Discord bilang belum diterima — dilewati.`);
        return 'belum-diterima';
      } else {
        gagalBerturut += 1;
        this.log.warn(`Quest "${q.nama}": heartbeat gagal (HTTP ${status}) — percobaan ${gagalBerturut}/${maksGagal}`);
        if (gagalBerturut >= maksGagal) return `heartbeat gagal terus (HTTP ${status})`;
      }
      await this._tunggu(this.beatSec * 1000);
    }
    if (this.batalFlag || this.stopped) return 'dibatalkan';
    const terakhir = (entri && Number(entri.value)) || 0;
    return `waktu habis sebelum target (${terakhir}/${target} detik)`;
  }

  /** WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE: kirim timestamp bertahap, tunggu nilai yang dikonfirmasi server. */
  async _kerjaVideo(q, entri, trans = null) {
    const mulaiTerima = q.diterima || Date.now();
    const target = targetFor({ target: q.target }, q.jenis);
    let progres = Math.max(0, Number(q.progress) || 0);
    let gagalBerturut = 0;
    let mandekTicks = 0;
    const maksGagal = 5;
    const batasDetik = Math.max(120, target * 3); // pengaman supaya tidak menggantung
    const sampai = Date.now() + batasDetik * 1000;
    const batasMandek = Math.max(5, Math.ceil(30000 / Math.max(250, this.videoTickMs)));

    while (!this.batalFlag && !this.stopped && Date.now() < sampai) {
      const lewat = Math.floor((Date.now() - mulaiTerima) / 1000);
      const bolehSampai = lewat + this.videoMasaDepan;
      let kirim = null;
      if (bolehSampai - progres >= this.videoMaju) {
        kirim = Math.min(target, progres + this.videoMaju + Math.random());
      } else if (lewat + 2 >= target) {
        kirim = target; // server tetap menentukan progres yang benar-benar diterima
      }

      if (kirim !== null) {
        const { status, json } = await this._postKerja(`/quests/${q.id}/video-progress`, { timestamp: kirim }, trans);
        const kode = json && json.code;
        if (status === 202) {
          // Balasan tanpa body bukan progres; beri jarak sebelum mencoba lagi.
          gagalBerturut = 0;
          mandekTicks += 1;
          if (mandekTicks >= batasMandek) return `progres video belum terkonfirmasi (${progres}/${target} detik)`;
          await this._tunggu(this.videoTickMs);
          continue;
        }
        if (status === 200) {
          gagalBerturut = 0;
          const progress = readTaskProgress(json, q.jenis);
          if (progress.known) {
            const sebelumnya = progres;
            progres = progress.value; // pakai angka server apa adanya; tidak mengasumsikan timestamp terkirim = progres diterima
            if (entri) entri.value = progres;
            if (progres > sebelumnya) mandekTicks = 0;
            else if (progres < target) mandekTicks += 1;
          } else {
            mandekTicks += 1;
          }
          this.log.info(`Quest "${q.nama}" (video): ${progres}/${target} detik`);
          this.emit('change');

          const selesai = completionState(json, q.jenis, target);
          if (selesai.mismatch) {
            this.log.warn(`Quest "${q.nama}" (video): status selesai bertentangan dengan progres ${progress.value}/${target} detik — belum dihitung selesai.`);
          } else if (selesai.completed && !progress.known) {
            return 'selesai';
          }

          if (progress.known && progress.value >= target) {
            const akhir = await this._postKerja(`/quests/${q.id}/video-progress`, { timestamp: target }, trans);
            const kodeAkhir = akhir.json && akhir.json.code;
            if (akhir.status === 404 || kodeAkhir === 260017) return 'kedaluwarsa';
            if (akhir.status === 403 && kodeAkhir === 260000) return 'belum-diterima';
            if (akhir.status === 429 && akhir.json && akhir.json.limitPanjang) return 'ditunda';
            if (akhir.status === 401) return 'video-progress terminal ditolak (HTTP 401)';
            if (akhir.status >= 200 && akhir.status < 300) {
              const progressAkhir = readTaskProgress(akhir.json, q.jenis);
              if (progressAkhir.known) {
                progres = progressAkhir.value;
                if (entri) entri.value = progres;
              }
              const selesaiAkhir = completionState(akhir.json, q.jenis, target);
              if (!progressAkhir.known || progressAkhir.value >= target) return 'selesai';
              if (selesaiAkhir.mismatch) {
                this.log.warn(`Quest "${q.nama}" (video): balasan terminal masih ${progressAkhir.value}/${target} detik — belum dihitung selesai.`);
              }
            } else {
              gagalBerturut += 1;
              this.log.warn(`Quest "${q.nama}": video-progress terminal gagal (HTTP ${akhir.status}) — percobaan ${gagalBerturut}/${maksGagal}`);
              if (gagalBerturut >= maksGagal) return `video-progress terminal gagal terus (HTTP ${akhir.status})`;
            }
          }
          if (mandekTicks >= batasMandek) return `progres video berhenti di ${progres}/${target} detik`;
        } else if (status === 429 && json && json.limitPanjang) {
          return 'ditunda';
        } else if (status === 404 || kode === 260017) {
          return 'kedaluwarsa';
        } else if (status === 403 && kode === 260000) {
          return 'belum-diterima';
        } else {
          gagalBerturut += 1;
          this.log.warn(`Quest "${q.nama}": video-progress gagal (HTTP ${status}) — percobaan ${gagalBerturut}/${maksGagal}`);
          if (gagalBerturut >= maksGagal) return `video-progress gagal terus (HTTP ${status})`;
        }
      }
      await this._tunggu(this.videoTickMs);
    }
    if (this.batalFlag || this.stopped) return 'dibatalkan';
    return 'waktu habis sebelum video selesai';
  }

  /** Semua selesai/dihentikan: kembalikan presence seperti semula. */
  _selesaiSemua() {
    clearInterval(this._putarTimer);
    this._putarTimer = null;
    const p = this.pemulihan;
    if (!p) this.log.info('Quest: selesai — presence kamu tidak pernah diubah.');
    if (p) {
      try {
        this.ps5.setPlatform(p.platform);
        this.ps5.applyGame(p.game);
        this.ps5.setEnabled(p.enabled);
        this.log.info(`Quest: presence dikembalikan ke "${p.game}" di ${p.platform}.`);
      } catch (e) {
        this.log.warn('Quest: gagal memulihkan presence — ' + e.message);
      }
    }
    this.aktif = false;
    this.mode = null;
    this.sedang = null;
    this.aktifList = [];
    this.antrian = [];
    this.pemulihan = null;
    this.asalNegara = null;
    this.emit('change');
    // begitu semua selesai, periksa lagi sebentar lagi — kalau ada quest baru
    // yang muncul, langsung dikerjakan tanpa perlu menekan tombol.
    if (this.otomatis && !this.stopped) {
      if (this._cekSelesaiTimer) clearTimeout(this._cekSelesaiTimer);
      this._cekSelesaiTimer = setTimeout(() => {
        this._cekSelesaiTimer = null;
        this.cekSekarang('selesai').catch(() => {});
      }, 20000);
    }
  }

  stop() {
    this.stopped = true;
    this.batalFlag = true;
    this.stopOtomatis();
    this._bangunkan();
  }
}

module.exports = { QuestRunner };
