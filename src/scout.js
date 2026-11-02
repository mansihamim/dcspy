'use strict';

/**
 * ============================================================================
 *  Scout — "keliling dunia" lewat Tor untuk MEMANTAU quest Orb di semua negara.
 * ============================================================================
 *
 *  Cara kerja:
 *    0. Cek dulu dari ID. Kalau sudah ADA yang bisa dikerjakan, putaran negara
 *       dilewati (tidak perlu keliling) — biar hemat.
 *    1. Kalau tidak ada: pilih negara berikutnya (daftar dari onionoo: hanya
 *       negara yang punya exit Tor), pin exit-nya (SETCONF + NEWNYM), lalu
 *       VERIFIKASI negaranya sebelum dipakai.
 *    2. Baca daftar quest akun (GET /quests/@me) DARI negara itu.
 *    3. Kotak kosong = langsung pindah negara lagi (tanpa menunggu 5 menit),
 *       sampai SCOUT_BURST_MAKS negara per putaran (ada jeda kecil antar
 *       negara karena tor membatasi NEWNYM ±10 detik).
 *    4. Ketemu quest yang bisa dikerjakan = **langsung dikerjakan dari rute
 *       tor itu** (kerjakanLuar) dan DITUNGGU sampai semua selesai, baru
 *       lanjut negara lain. Presence tidak disentuh; klaim tetap manual.
 *    5. Temuan disimpan -> kartu "Scout Orb" di dashboard.
 *
 *  Prinsip aman:
 *    - tor jalan sebagai proses anak (seperti cloudflared), mode CLIENT-ONLY.
 *    - RAM dibatasi (--MaxMemInQueues), satu permintaan pada satu waktu.
 *    - Koneksi presence/status bot TIDAK lewat tor — hanya pembacaan quest.
 *    - Kalau token dijawab 401, scout PAUSE otomatis (tidak menghajar API).
 *    - Kalau tor gagal berkali-kali, scout mati sendiri; bot tetap hidup.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const net = require('net');
const { minta, getJsonSocks, httpMinta, transporSocks } = require('./socks');

const API = 'https://discord.com/api/v9';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';
const { randomUUID } = require('crypto');
const { targetFor, completionState } = require('./quest-progress');
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

const URL_TOR =
  process.env.SCOUT_TOR_URL ||
  'https://dist.torproject.org/torbrowser/15.0.24/tor-expert-bundle-linux-x86_64-15.0.24.tar.gz';

const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================== kontrol tor ============================== */

/** Klien control port tor (protokol teks). Dipakai untuk pin exit + NEWNYM. */
class TorKontrol {
  constructor(port, log) {
    this.port = port;
    this.log = log;
    this.sock = null;
    this.buf = '';
    this.tunggu = null;
    this.siapAuth = false;
  }

  /**
   * Balasan tor selesai kalau baris terakhir (berakhiran \n) berupa baris
   * "akhir": `250 OK`, `251 ...`, atau galat `4xx/5xx ...`. Baris lanjutan
   * memakai tanda hubung ("250-..."), data lanjutan memakai plus ("250+...").
   */
  _cekBalasan() {
    if (!this.tunggu) return;
    if (!/\r?\n$/.test(this.buf)) return;
    const baris = this.buf.replace(/\r?\n$/, '').split(/\r?\n/);
    const akhir = baris[baris.length - 1] || '';
    if (!/^(?:250|251|4\d\d|5\d\d) /.test(akhir)) return;
    const teks = this.buf;
    this.buf = '';
    const cb = this.tunggu;
    this.tunggu = null;
    cb(teks);
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.sock) return resolve();
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error('control port tor: timeout'));
      }, timeoutMs);
      s.on('connect', () => {
        clearTimeout(t);
        this.sock = s;
        this.siapAuth = false;
        s.on('data', (d) => {
          this.buf += d.toString('utf8');
          this._cekBalasan();
        });
        s.on('close', () => {
          this.sock = null;
          this.siapAuth = false;
        });
        s.on('error', () => {
          this.sock = null;
          this.siapAuth = false;
        });
        resolve();
      });
      s.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  cmd(baris, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('control port belum tersambung'));
      const t = setTimeout(() => {
        this.tunggu = null;
        reject(new Error('control port: timeout menunggu balasan'));
      }, timeoutMs);
      this.tunggu = (teks) => {
        clearTimeout(t);
        resolve(teks);
      };
      this.sock.write(baris + '\r\n');
    });
  }

  /**
   * Tor 0.4.9 dengan CookieAuthentication 0 memakai metode NULL: klien tetap
   * harus mengirim "AUTHENTICATE" (tanpa argumen) sebelum perintah lain,
   * kalau tidak semua perintah dijawab "514 Authentication required".
   */
  async authenticate() {
    if (this.siapAuth) return;
    const b = await this.cmd('AUTHENTICATE', 10000);
    if (!/^250/m.test(b)) throw new Error('control port: autentikasi ditolak — ' + b.trim().slice(0, 80));
    this.siapAuth = true;
  }

  close() {
    try {
      this.sock && this.sock.destroy();
    } catch {
      /* abaikan */
    }
    this.sock = null;
    this.siapAuth = false;
  }
}

/* ========================== ekstrak tar.gz (mini) ========================= */

/**
 * Ekstrak beberapa berkas dari .tar.gz TANPA dependency (tar format POSIX
 * sederhana: header 512 byte + isi). Hanya berkas biasa yang diambil.
 * @param {string} berkas path .tar.gz
 * @param {Map<string,string>} mau  nama di tar -> path tujuan
 */
function ekstrakTargz(berkas, mau) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const rs = fs.createReadStream(berkas);
    let buf = Buffer.alloc(0);
    let sisaIsi = 0; // byte isi berkas yang belum diproses
    let sisaPad = 0; // padding blok yang belum dilewati
    let tulis = null; // write stream berkas yang sedang diekstrak
    const diambil = [];

    const proses = () => {
      for (;;) {
        if (sisaIsi > 0) {
          const n = Math.min(sisaIsi, buf.length);
          if (n === 0) return;
          if (tulis) tulis.write(buf.subarray(0, n));
          buf = buf.subarray(n);
          sisaIsi -= n;
          if (sisaIsi === 0 && tulis) {
            tulis.end();
            tulis = null;
          }
          continue;
        }
        if (sisaPad > 0) {
          const n = Math.min(sisaPad, buf.length);
          if (n === 0) return;
          buf = buf.subarray(n);
          sisaPad -= n;
          continue;
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        let semuaNol = true;
        for (let i = 0; i < 512; i += 1)
          if (h[i] !== 0) {
            semuaNol = false;
            break;
          }
        if (semuaNol) continue; // blok akhir
        const nama = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const ukuranStr = h.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
        const ukuran = parseInt(ukuranStr, 8) || 0;
        const jenis = String.fromCharCode(h[156] || 48);
        sisaPad = (512 - (ukuran % 512)) % 512;
        const tujuan = mau.get(nama);
        if (jenis === '0' && tujuan) {
          fs.mkdirSync(path.dirname(tujuan), { recursive: true });
          tulis = fs.createWriteStream(tujuan, { mode: 0o755 });
          diambil.push(nama);
          sisaIsi = ukuran;
        } else if (jenis === '5') {
          if (tujuan) fs.mkdirSync(tujuan, { recursive: true });
        } else if (jenis === '0') {
          sisaIsi = ukuran; // lewati
        }
      }
    };

    rs.on('error', reject);
    gunzip.on('error', reject);
    gunzip.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      try {
        proses();
      } catch (e) {
        reject(e);
      }
    });
    gunzip.on('end', () => resolve(diambil));
    rs.pipe(gunzip);
  });
}

/* ================================= Scout ================================= */

class Scout extends EventEmitter {
  /**
   * @param {{token:string, log:any, enabled?:boolean, intervalMin?:number, mulaiDetik?:number}} opts
   */
  constructor({
    token, log, enabled = false, intervalMin = 0, mulaiDetik = 45, quest = null,
    jedaPutaran = 0, jedaSaatId = 30, tokenKhusus = true,
  }) {
    super();
    this.token = token;
    this.log = log;
    /** penjalan quest (dipakai untuk mengerjakan quest dari negara lain) */
    this.quest = quest;
    /** true = quest yang ketemu langsung dikerjakan (SCOUT_AUTO_KERJA) */
    this.autoKerja = String(process.env.SCOUT_AUTO_KERJA || 'true').toLowerCase() !== 'false';
    /** Simpan nilai dasar agar pergantian token tidak meninggalkan mode lama. */
    this.burstMaksDasar = Math.max(1, Number(process.env.SCOUT_BURST_MAKS || 10) || 10);
    this.jedaAntarDasar = Math.max(0, Number(process.env.SCOUT_JEDA_ANTAR_NEGARA ?? 2) || 2);
    this.tokenKhusus = Boolean(tokenKhusus);
    this.hatiHati = !this.tokenKhusus;
    /**
     * Mode token utama hanya boleh digunakan dengan opt-in eksplisit
     * SCOUT_TOKEN_UTAMA=izin. Nilai kosong dan "tolak" sama-sama menolak.
     */
    this.tolakTokenUtama = this.hatiHati && String(process.env.SCOUT_TOKEN_UTAMA || '').trim().toLowerCase() !== 'izin';
    this.burstMaks = this.burstMaksDasar;
    this.jedaAntar = this.jedaAntarDasar;
    /**
     * Jeda kecil antar negara tetap menjaga rotasi cepat di dalam satu putaran;
     * putaran main-token dibatasi terpisah lewat SCOUT_INTERVAL_HATI_HATI.
     */
    /** waktu NEWNYM terakhir (tor: paling cepat 1× / 10 dtk) */
    this._newnymAt = 0;
    /**
     * Identitas SOCKS (user/pass) = kunci ISOLASI sirkuit Tor.
     * Satu identitas unik = satu sirkuit baru TANPA NEWNYM (Newnym dibatasi
     * 1×/10 dtk, jadi jalur lama memakan ±19-20 dtk per negara; jalur ini
     * biasanya 3-5 dtk). Identitas ini juga dipakai quest runner lewat
     * this.trans supaya pendaftaran benar-benar keluar dari negara itu.
     */
    this._identKe = 0;
    this._identSaatIni = 'scout-awal';
    /** antrean negara yang quest-nya ketemu saat penjalan masih sibuk */
    this.antriKerja = [];
    /** rute SOCKS siap pakai untuk quest runner (portnya baru diketahui di bawah) */
    /** catatan peringatan terakhir untuk dashboard */
    this.alert = [];
    this.dimintaAktif = Boolean(enabled);
    this.aktif = Boolean(enabled);
    this.sebabJeda = '';
    // Quest-token boleh memakai interval yang dikonfigurasi; token utama diberi cooldown putaran.
    this.intervalMinDasar = Math.max(0, Number(intervalMin) || 0);
    this.intervalMin = this.intervalMinDasar;
    /** jeda kecil antar putaran kalau semuanya kosong (detik; 0 = langsung lanjut) */
    this.jedaPutaran = Math.max(0, Number(jedaPutaran) || 0);
    /** jeda saat quest dari ID sedang dikerjakan bot (jangan hajar API terus-menerus) */
    this.jedaSaatId = Math.max(5, Number(jedaSaatId) || 30);
    this.mulaiDetik = Math.max(5, Number(mulaiDetik) || 45);
    this._aturModeToken();

    // catatan: bootstrap update menghapus ./data tiap tarik versi baru,
    // jadi catatan scout disimpan di ./.scout supaya riwayat tidak hilang
    // (termasuk cache tor -> bootstrap berikutnya lebih cepat).
    const ROOT = path.join(__dirname, '..');
    this.dirBin = path.join(ROOT, 'bin', 'tor');
    this.dirData = path.join(ROOT, '.scout');
    this.dirTorData = path.join(this.dirData, 'tor');
    this.berkasNegara = path.join(this.dirData, 'negara.json');
    this.berkasKnown = path.join(this.dirData, 'known.json');
    this.berkasTemuan = path.join(this.dirData, 'temuan.json');
    this.berkasState = path.join(this.dirData, 'state.json');
    this.berkasStat = path.join(this.dirData, 'stat.json');

    this.portSocks = Number(process.env.SCOUT_SOCKS_PORT || 9190);
    this.portKontrol = Number(process.env.SCOUT_CTRL_PORT || 9191);
    /**
     * Rute SOCKS untuk quest runner. PENTING: jangan panggil transporSocks()
     * di atas — dulu portnya belum terisi (undefined -> NaN) sehingga SETIAP
     * permintaan quest lewat rute selalu gagal ("HTTP 0") tanpa jejak.
     * Dibuat lazy begini supaya portnya selalu dibaca saat dipakai.
     */

    /** pengait: quest runner minta sirkuit baru kalau rute gagal di level jaringan */
    if (this.quest) {
      this.quest.rotasiRute = async () => {
        try {
          await this.putarSirkuit();
        } catch {
          /* tor mungkin sedang mati — biarkan */
        }
      };
    }
    this.kontrol = new TorKontrol(this.portKontrol, log);
    this.torProc = null;
    this.torSiap = false;
    this.gagalTor = 0;
    this.torLog = [];

    this.negara = []; // [{cc, fps:[...]}]
    this.idx = 0;
    this.known = new Set();
    this.idSet = new Set(); // id quest yang TERLIHAT dari ID
    this.temuan = []; // temuan unik (terbaru di depan)
    this.stat = {
      putaran: 0, scan: 0, terakhir: null, temuanTotal: 0, mulaiJam: 0,
      dikerjakanTotal: 0, kerjaTotal: 0,
      /**
       * catatan negara "panas": pernah menghasilkan quest bisa dikerjakan.
       * Dipakai supaya negara produktif dipindai LEBIH DULU tiap putaran
       * (quest baru di sana ketemu lebih cepat). Format: { cc: {layak, at} }
       */
      panas: {},
      /** kecepatan rata-rata per negara (detik) — bukti & tampilan dashboard */
      detikNegara: 0,
      negaraDihitung: 0,
    };
    this.stopped = false;
    this._timer = null;
    this._retryNegaraTimer = null;
    this._startSedang = false;
  }

  /* ------------------------------ persiapan ------------------------------ */

  _aturModeToken() {
    this.hatiHati = !this.tokenKhusus;
    this.tolakTokenUtama = this.hatiHati && String(process.env.SCOUT_TOKEN_UTAMA || '').trim().toLowerCase() !== 'izin';
    const burstHatiHati = Math.max(1, Number(process.env.SCOUT_BURST_HATI_HATI ?? 3) || 3);
    const jedaHatiHati = Math.max(0, Number(process.env.SCOUT_JEDA_HATI_HATI ?? 8) || 8);
    this.burstMaks = this.hatiHati ? Math.min(this.burstMaksDasar, burstHatiHati) : this.burstMaksDasar;
    this.jedaAntar = this.hatiHati ? Math.max(this.jedaAntarDasar, jedaHatiHati) : this.jedaAntarDasar;
    // Main-token mode must rest between rounds; still rotates immediately within a round.
    const cooldownRounds = Math.max(5, Number(process.env.SCOUT_INTERVAL_HATI_HATI ?? 5) || 5);
    this.intervalMin = this.hatiHati ? Math.max(this.intervalMinDasar, cooldownRounds) : this.intervalMinDasar;
  }

  /** Ganti kredensial Scout bersama token quest, tanpa pernah mencetak token ke log. */
  setToken(token, { tokenKhusus = false } = {}) {
    const tk = String(token || '').trim();
    if (!tk) return false;
    this.token = tk;
    this.tokenKhusus = Boolean(tokenKhusus);
    this._aturModeToken();
    if (this.hatiHati && this.tolakTokenUtama) {
      this.dimintaAktif = false;
      this.aktif = false;
      this.sebabJeda = 'token utama dilindungi; Scout menunggu token quest atau izin eksplisit';
    } else {
      this.sebabJeda = '';
      if (this.dimintaAktif) {
        if (this.negara.length) this.aktif = true;
        else this.start().catch((e) => this.log.warn('Scout: gagal mulai setelah token diperbarui — ' + e.message));
      }
    }
    this.emit('change');
    return true;
  }

  _bacaJson(p, bawaan) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return bawaan;
    }
  }

  _tulisJson(p, isi) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(isi));
    } catch (e) {
      this.log.warn('Scout: gagal menulis ' + path.basename(p) + ' — ' + e.message);
    }
  }

  _jadwalkanRetryNegara() {
    const detik = Math.max(1, Number(process.env.SCOUT_ONIONOO_RETRY_DETIK || 300) || 300);
    if (this._retryNegaraTimer || this.stopped || !this.dimintaAktif) return detik;
    this._retryNegaraTimer = setTimeout(() => {
      this._retryNegaraTimer = null;
      if (this.stopped || !this.dimintaAktif) return;
      this.log.info('Scout: mencoba ulang memuat daftar negara dari Onionoo.');
      this.start().catch((e) => this.log.warn('Scout: retry daftar negara gagal — ' + e.message));
    }, detik * 1000);
    if (typeof this._retryNegaraTimer.unref === 'function') this._retryNegaraTimer.unref();
    return detik;
  }

  async start() {
    if (!this.dimintaAktif) {
      this.log.info('Scout: dimatikan lewat setelan (SCOUT_ENABLED=false).');
      return;
    }
    // Tolak token utama SEBELUM Onionoo, baseline /quests/@me, atau Tor disentuh.
    if (this.hatiHati && this.tolakTokenUtama) {
      this.dimintaAktif = false;
      this.aktif = false;
      this.sebabJeda = 'token utama dilindungi; pasang token quest atau set SCOUT_TOKEN_UTAMA=izin secara sadar';
      this.log.warn('Scout: tidak mengirim permintaan memakai token utama karena izin eksplisit belum ada.');
      this.emit('change');
      return;
    }
    if (this.stopped || this._startSedang) return;
    this._startSedang = true;
    try {
      // muat catatan lama (known = quest yang pernah terlihat scout ATAU dari ID)
      const kn = this._bacaJson(this.berkasKnown, { ids: [] });
      this.known = new Set(kn.ids || []);
      const tm = this._bacaJson(this.berkasTemuan, { temuan: [], idSet: [] });
      this.temuan = tm.temuan || [];
      this.idSet = new Set(tm.idSet || []);
      this.stat.temuanTotal = this.temuan.length;
      // lanjutkan dari negara terakhir (jangan mengulang dari awal tiap restart)
      const stx = this._bacaJson(this.berkasStat, {});
      this.stat.dikerjakanTotal = Number(stx.dikerjakanTotal) || 0;
      this.stat.kerjaTotal = Number(stx.kerjaTotal) || 0;
      this.stat.panas = (stx && stx.panas) || {};
      this.stat.detikNegara = Number(stx.detikNegara) || 0;
      this.stat.negaraDihitung = Number(stx.negaraDihitung) || 0;
      const st = this._bacaJson(this.berkasState, { idx: 0 });
      this.idx = Number(st.idx) || 0;
      if (this.idx) this.log.info(`Scout: melanjutkan rotasi dari urutan ke-${this.idx + 1} (catatan tersimpan).`);

      let gagalMuat = null;
      try {
        await this._muatNegara();
      } catch (e) {
        gagalMuat = e;
      }
      if (this.stopped || !this.dimintaAktif) return;
      if (gagalMuat || !this.negara.length) {
        // Jangan diam-diam memakai daftar cache yang sudah lewat TTL 24 jam.
        this.negara = [];
        this.aktif = false;
        const ulang = this._jadwalkanRetryNegara();
        this.sebabJeda = `daftar negara tidak tersedia (menunggu Onionoo; coba ulang ±${ulang} dtk)`;
        if (gagalMuat) {
          this.log.warn(
            `Scout: daftar negara gagal dimuat — ${gagalMuat.message}; coba ulang dalam ${ulang} dtk. Cache kedaluwarsa tidak dipakai.`,
          );
        } else {
          this.log.warn(`Scout: daftar negara kosong — coba ulang dalam ${ulang} dtk.`);
        }
        this.emit('change');
        return;
      }
      if (this._retryNegaraTimer) {
        clearTimeout(this._retryNegaraTimer);
        this._retryNegaraTimer = null;
      }
      // baseline: quest yang terlihat dari ID (langsung, tanpa tor).
      // Dipakai untuk deteksi EKSTRA + mengisi "known" sebelum putaran pertama
      // supaya quest yang sudah kelihatan dari ID tidak dilaporkan sebagai BARU.
      await this._segarkanIdSet().catch(() => {});
      if (this.stopped || !this.dimintaAktif) return;

      this.aktif = true;
      this.sebabJeda = '';
      this.stat.mulaiJam = Date.now();
      this.log.info(
        `Scout: siap — ${this.negara.length} negara · sampai ${this.burstMaks} negara per putaran ` +
          `(kosong = langsung pindah) · ` +
          (this.intervalMin > 0 ? `istirahat ${this.intervalMin} menit` : 'tanpa jeda antar putaran') +
          ` · kerja otomatis ` +
          `${this.autoKerja ? 'ON' : 'OFF'}. Mulai ${this.mulaiDetik} detik lagi.`,
      );
      if (this.autoKerja && !this.quest) this.log.warn('Scout: penjalan quest tidak ada — kerja otomatis dinonaktifkan.');
      this._timer = setTimeout(() => this._loop(), this.mulaiDetik * 1000);
      this.emit('change');
    } finally {
      this._startSedang = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._retryNegaraTimer) clearTimeout(this._retryNegaraTimer);
    this._retryNegaraTimer = null;
    this.kontrol.close();
    try {
      this.torProc && this.torProc.kill('SIGTERM');
    } catch {
      /* abaikan */
    }
  }

  /** daftar negara ber-exit dari onionoo (cache 24 jam) */
  async _muatNegara() {
    const cache = this._bacaJson(this.berkasNegara, null);
    if (cache && Array.isArray(cache.negara) && cache.negara.length && Date.now() - (cache.ts || 0) < 86400000) {
      this.negara = cache.negara;
      this.log.info(`Scout: daftar negara dari cache — ${this.negara.length} negara.`);
      return;
    }
    const r = await fetch(
      'https://onionoo.torproject.org/details?flag=Exit&running=true&fields=fingerprint,country',
      { headers: { 'User-Agent': 'discord-keep-online/scout' } },
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const peta = new Map();
    for (const rel of j.relays || []) {
      const cc = String(rel.country || '').toLowerCase();
      if (!/^[a-z]{2}$/.test(cc)) continue;
      if (!peta.has(cc)) peta.set(cc, []);
      const daftar = peta.get(cc);
      const maks = Number(process.env.SCOUT_FP_PER_NEGARA || 12) || 12;
      if (daftar.length < maks) daftar.push(rel.fingerprint);
    }
    this.negara = [...peta.entries()]
      .map(([cc, fps]) => ({ cc, fps }))
      .sort((a, b) => a.cc.localeCompare(b.cc));
    this._tulisJson(this.berkasNegara, { ts: Date.now(), negara: this.negara });
    this.log.info(`Scout: daftar negara diperbarui dari onionoo — ${this.negara.length} negara ber-exit Tor.`);
  }

  /** quest yang terlihat dari ID (koneksi langsung; bukan tor) */
  async _segarkanIdSet() {
    try {
      const r = await fetch(`${API}/quests/@me`, { headers: this._headers() });
      if (r.status !== 200) return;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : j.quests || [];
      if (!arr.length) return;
      this.idSet = new Set(arr.map((q) => q.id));
      // quest yang terlihat dari IP Indonesia = sudah "dikenal", jadi tidak
      // dilaporkan sebagai BARU ("baru" harus berarti benar-benar baru).
      for (const id of this.idSet) this.known.add(id);
      this._simpan();
      this.log.info(`Scout: baseline ID diperbarui — ${this.idSet.size} quest terlihat dari ID.`);
    } catch {
      /* diamkan */
    }
  }

  _simpan() {
    this._tulisJson(this.berkasKnown, { ids: [...this.known].slice(-4000) });
    this._tulisJson(this.berkasTemuan, { temuan: this.temuan.slice(0, 300), idSet: [...this.idSet] });
    this._tulisJson(this.berkasStat, {
      dikerjakanTotal: this.stat.dikerjakanTotal,
      kerjaTotal: this.stat.kerjaTotal,
      panas: this.stat.panas || {},
      detikNegara: this.stat.detikNegara,
      negaraDihitung: this.stat.negaraDihitung,
      alert: this.alert.slice(0, 20),
      ts: Date.now(),
    });
  }

  /** Catat peringatan; pemindaian bisa menggabungkan penyimpanan agar tidak menulis berkali-kali. */
  _alert(teks, { persist = true, notify = true } = {}) {
    this.log.info('🔔 ' + teks);
    this.alert.unshift({ at: Date.now(), teks });
    if (this.alert.length > 20) this.alert.pop();
    if (persist) this._simpan();
    if (notify) this.emit('change');
  }

  _headers() {
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

  /* --------------------------------- tor --------------------------------- */

  async _pastikanTor() {
    if (this.torSiap && this.torProc && this.torProc.exitCode === null) return true;

    // 1) Kalau sudah ada tor yang menjawab di port kontrol kita (mis. sisa
    //    proses sebelum bot restart), pakai itu — jangan spawn baru.
    if (await this._kontrolHidup()) {
      this.torSiap = true;
      this.gagalTor = 0;
      this.log.info('Scout: memakai tor yang sudah jalan (port kontrol menjawab).');
      return true;
    }

    await this._pastikanBin();
    this._spawnTor(true);

    // 2) Tunggu bootstrap sampai 100%. Kalau proses kita mati (mis. kunci data
    //    directory dipakai tor lain) dan port kontrol tetap tidak menjawab,
    //    jangan menggantung lama — berhenti cepat dengan pesan jelas.
    let matiBeruntun = 0;
    for (let i = 0; i < 60; i += 1) {
      await tidur(2000);
      if (this.stopped) return false;
      if (this.torProc && this.torProc.exitCode !== null) {
        matiBeruntun += 1;
        if (matiBeruntun === 1 && this._pakaiIsolasi) {
          // Cadangan aman: sebagian build/versi tor bisa menolak flag isolasi.
          // Tanpa flag, pemindaian tetap jalan (lebih lambat, pakai NEWNYM).
          const sebab = this.torLog.slice(-2).join(' | ');
          this.log.warn(`Scout: tor menolak opsi isolasi${sebab ? ' — ' + sebab : ''}; mencoba tanpa isolasi (lebih lambat).`);
          this.kontrol.close();
          this._spawnTor(false);
          matiBeruntun = 0;
        } else if (matiBeruntun >= 5) {
          throw new Error(`proses tor berhenti (kode ${this.torProc.exitCode}) dan port kontrol tidak menjawab`);
        }
      }
      try {
        if (!this.kontrol.sock) await this.kontrol.connect(4000);
        await this.kontrol.authenticate();
        const balas = await this.kontrol.cmd('GETINFO status/bootstrap-phase');
        const m = balas.match(/PROGRESS=(\d+)/);
        if (m && Number(m[1]) >= 100) {
          this.torSiap = true;
          this.gagalTor = 0;
          this.log.info('Scout: tor siap (bootstrap 100%).');
          return true;
        }
      } catch {
        /* coba lagi */
      }
    }
    throw new Error('tor tidak selesai bootstrap dalam 2 menit');
  }

  /** Ada tor hidup di port kontrol kita dan sudah bootstrap 100%? */
  async _kontrolHidup() {
    try {
      if (!this.kontrol.sock) await this.kontrol.connect(4000);
      await this.kontrol.authenticate();
      const balas = await this.kontrol.cmd('GETINFO status/bootstrap-phase', 8000);
      const m = balas.match(/PROGRESS=(\d+)/);
      return Boolean(m) && Number(m[1]) >= 100;
    } catch {
      return false;
    }
  }

  async _pastikanBin() {
    const binTor = path.join(this.dirBin, 'tor');
    try {
      const st = fs.statSync(binTor);
      if (st.size > 2 * 1024 * 1024) return;
    } catch {
      /* belum ada */
    }
    fs.mkdirSync(this.dirBin, { recursive: true });
    this.log.info('Scout: mengunduh tor (±31 MB, sekali saja)…');
    const res = await fetch(URL_TOR, { redirect: 'follow' });
    if (!res.ok) throw new Error(`unduh tor gagal (HTTP ${res.status})`);
    const sementara = path.join(this.dirBin, 'tor.tar.gz');
    const ws = fs.createWriteStream(sementara);
    await new Promise((resolve, reject) => {
      const { Readable } = require('stream');
      const { pipeline } = require('stream/promises');
      pipeline(Readable.fromWeb(res.body), ws).then(resolve).catch(reject);
    });
    const ukuran = fs.statSync(sementara).size;
    if (ukuran < 15 * 1024 * 1024) {
      fs.unlinkSync(sementara);
      throw new Error(`bundel tor tidak wajar (${ukuran} byte)`);
    }
    this.log.info('Scout: mengekstrak tor…');
    const mau = new Map([
      ['tor/tor', path.join(this.dirBin, 'tor')],
      ['tor/libcrypto.so.3', path.join(this.dirBin, 'libcrypto.so.3')],
      ['tor/libevent-2.1.so.7', path.join(this.dirBin, 'libevent-2.1.so.7')],
      ['tor/libssl.so.3', path.join(this.dirBin, 'libssl.so.3')],
      ['data/geoip', path.join(this.dirBin, 'geoip')],
    ]);
    const diambil = await ekstrakTargz(sementara, mau);
    fs.unlinkSync(sementara);
    try {
      fs.chmodSync(path.join(this.dirBin, 'tor'), 0o755);
    } catch {
      /* abaikan */
    }
    if (!diambil.includes('tor/tor')) throw new Error('biner tor tidak ada di dalam bundel');
    this.log.info(`Scout: tor siap dipakai (${diambil.length} berkas diekstrak).`);
  }

  _spawnTor(pakaiIsolasi = true) {
    this._pakaiIsolasi = pakaiIsolasi;
    const binTor = path.join(this.dirBin, 'tor');
    fs.mkdirSync(this.dirTorData, { recursive: true });
    const logTor = path.join(this.dirTorData, 'tor.log');
    const args = [
      // PENTING: IsolateSOCKSAuth HARUS jadi flag di baris SocksPort.
      // Kalau ditulis sebagai opsi sendiri, tor menolak:
      //   "Unknown option 'IsolateSOCKSAuth'. Failing." lalu keluar (kode 1)
      // — itu yang sempat membuat pemindaian mati beberapa menit.
      '--SocksPort', pakaiIsolasi ? `127.0.0.1:${this.portSocks} IsolateSOCKSAuth` : `127.0.0.1:${this.portSocks}`,
      '--ControlPort', `127.0.0.1:${this.portKontrol}`,
      '--CookieAuthentication', '0',
      '--DataDirectory', this.dirTorData,
      '--ClientOnly', '1',
      '--AvoidDiskWrites', '1',
      '--MaxMemInQueues', '48 MB',
      '--GeoIPFile', path.join(this.dirBin, 'geoip'),
      '--Log', `notice file ${logTor}`,
      '--Log', 'notice stderr', // pesan galat tor ikut tertangkap (dulu tersembunyi)
    ];
    this.torProc = spawn(binTor, args, {
      env: { ...process.env, LD_LIBRARY_PATH: this.dirBin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tangkap = (c) => {
      const t = String(c).trim();
      if (!t) return;
      this.torLog.push(t);
      if (this.torLog.length > 30) this.torLog.shift();
    };
    this.torProc.stdout.on('data', tangkap);
    this.torProc.stderr.on('data', tangkap);
    this.torProc.on('exit', (kode) => {
      this.torSiap = false;
      this.kontrol.close();
      if (!this.stopped) {
        const sebab = this.torLog.slice(-3).join(' | ');
        this.log.warn(`Scout: proses tor berhenti (kode ${kode})${sebab ? ' — ' + sebab : ''}.`);
      }
    });
    this.log.info('Scout: tor dijalankan (client-only, RAM dibatasi 48 MB).');
  }

  /* ------------------------------- putaran ------------------------------- */

  async _loop() {
    while (!this.stopped) {
      const mulai = Date.now();
      let kembali = 'kosong';
      if (this.aktif) {
        try {
          kembali = await this._tick();
        } catch (e) {
          this.log.warn('Scout: putaran gagal — ' + e.message);
        }
      }
      /*
       * TANPA jeda 5 menit. Negara yang tidak punya quest (0 yang bisa
       * dikerjakan) langsung dilewati dan putaran berikutnya jalan segera.
       * Lantai 3 detik cuma pengaman supaya tidak berputar panas kalau tor
       * atau daftar negara sedang bermasalah.
       */
      let jedaMs;
      if (kembali === 'jeda') {
        // cooldown batas laju Discord — periksa tiap 2 menit sampai lega
        jedaMs = 120000;
      } else if (kembali === 'id') {
        jedaMs = this.jedaSaatId * 1000; // bot sedang mengerjakan quest dari ID
      } else if (this.intervalMin > 0) {
        // kalau memang diminta ada jeda putaran (SCOUT_INTERVAL_MIN > 0)
        jedaMs = Math.max(3000, this.intervalMin * 60000 - (Date.now() - mulai));
      } else {
        jedaMs = this.jedaPutaran * 1000 + 3000;
      }
      if (jedaMs > 0) await tidur(jedaMs);
    }
  }

  /**
   * Satu putaran:
   *  - cek dulu dari ID (kalau ada yang bisa dikerjakan, tidak perlu keliling);
   *  - negara kosong = LANGSUNG pindah negara lain (sampai burstMaks);
   *  - ketemu quest bisa dikerjakan = kerjakan lewat rute tor itu & TUNGGU selesai.
   */
  async _tick() {
    if (!this.negara.length) return 'kosong';
    /*
     * Kalau penjalan quest sedang dijeda batas laju Discord (mis. retry 32
     * menit), pemindaian memakai token yang sama — jadi ikut berhenti sopan
     * supaya cooldown tidak diperpanjang.
     */
    if (this.hatiHati && this.tolakTokenUtama) {
      if (!this._tungguTokenDiumumkan) {
        this._tungguTokenDiumumkan = true;
        this.log.warn(
          'Scout: TIDAK ADA token quest terpisah dan izin sweep-token-utama belum diberikan ' +
            '(atur SCOUT_TOKEN_UTAMA=izin hanya jika memang menghendaki) — pemindaian menunggu.'
        );
      }
      this.sebabJeda = 'menunggu token quest terpisah (token utama dilindungi)';
      return 'jeda';
    }
    if (this.hatiHati && !this._hatiHatiDiumumkan) {
      this._hatiHatiDiumumkan = true;
      this.log.warn(
        `Scout: tidak ada token quest terpisah — sweep memakai token UTAMA dengan mode HATI-HATI ` +
          `(${this.jedaAntar} dtk antar negara, ${this.burstMaks} negara/putaran). Tempel token quest di halaman QUEST untuk kecepatan penuh.`,
      );
    }
    if (this.quest && typeof this.quest.sisaJeda === 'function' && this.quest.sisaJeda() > 0) {
      if (!this._jedaDiumumkan) {
        this._jedaDiumumkan = true;
        const jam = new Date(this.quest.limitSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        this.log.info(`Scout: batas laju Discord — pemindaian dijeda, lanjut otomatis sekitar pukul ${jam}.`);
      }
      this.sebabJeda = 'batas laju Discord (token)';
      return 'jeda';
    }
    this._jedaDiumumkan = false;
    this.sebabJeda = '';
    // 0) antrean dulu: quest dari negara lain yang tertunda dikerjakan lebih dulu
    const hAntre = await this._kerjakanAntrean();
    if (hAntre) return hAntre;
    // Jangan pindah negara saat ada batch quest yang masih berjalan. Tunggu
    // sebentar, lalu lanjutkan antrean/pemindaian setelah runner benar-benar idle.
    if (this.quest && this.quest.aktif) {
      this.sebabJeda = 'menunggu batch quest aktif selesai';
      return 'id';
    }

    // 1) cek dari ID — hanya "cukup" kalau penjalan BELUM mengerjakannya
    const dariId = await this._cekDariId();
    if (!this.aktif) return 'berhenti';
    if (dariId.ok && dariId.layak > 0 && !(this.quest && this.quest.aktif)) {
      this.log.info(
        `Scout: dari ID ada ${dariId.layak} quest yang bisa dikerjakan — putaran negara dilewati; ` +
          'bot mengerjakannya sendiri (tanpa klik apa pun).',
      );
      // pemicu instan: begitu terlihat, langsung dikerjakan (tidak menunggu jadwal berikutnya)
      if (this.autoKerja && this.quest && typeof this.quest.cekSekarang === 'function') {
        this.quest.cekSekarang('scout').catch(() => {});
      }
      return 'id';
    }

    let sudah = 0;
    while (!this.stopped && this.aktif && sudah < this.burstMaks) {
      // awal putaran: negara yang pernah menghasilkan quest didahulukan
      if (this.idx === 0) this._susunUrutan();
      const target = this.negara[this.idx % this.negara.length];
      this.idx = (this.idx + 1) % this.negara.length;
      this.stat.putaran += 1;
      this._tulisJson(this.berkasState, { idx: this.idx, terakhir: target.cc, at: Date.now() });

      const hasil = await this._pindaiNegara(target);
      sudah += 1;
      this.emit('change');
      if (hasil !== 'kosong') return hasil; // 'kerja' / 'berhenti' -> putaran selesai
      if (sudah < this.burstMaks) await tidur(this.jedaAntar * 1000);
    }
    if (!this.stopped && this.aktif) {
      this.log.info(`Scout: ${sudah} negara beruntun kosong — langsung lanjut (tanpa jeda).`);
    }
    return 'kosong';
  }

  /** Cek cepat dari ID: ada berapa quest yang bisa dikerjakan sekarang? */
  async _cekDariId() {
    if (!this.quest) return { ok: false, layak: 0 };
    const d = await this.quest.daftar();
    if (this.quest.kena401) {
      this.aktif = false;
      this.sebabJeda = 'token dijawab 401 — scout dijeda otomatis';
      this.log.error('Scout: token dijawab 401 saat cek dari ID — scout dijeda otomatis.');
      return { ok: false, layak: 0 };
    }
    if (!d.ok) return { ok: false, layak: 0 };
    // quest yang terlihat dari ID = sudah "dikenal" (bukan barang baru)
    for (const q of d.quests) {
      this.idSet.add(q.id);
      this.known.add(q.id);
    }
    const layak = d.quests.filter((q) => !q.selesai && !q.kedaluwarsa && !q.belumMulai).length;
    this._simpan();
    return { ok: true, layak };
  }

  /**
   * Pindai satu negara. Kembalian:
   *   'kosong'  = tidak ada quest bisa dikerjakan -> pindah negara lagi
   *   'kerja'   = ada & sudah dikerjakan sampai selesai (atau kerja otomatis mati)
   *   'berhenti'= token mati / tor gagal 3x -> scout dijeda
   */
  /** Penjalan quest sedang bekerja? Kalau ya: jangan ganggu sirkuitnya. */
  _runnerSibuk() {
    return !!(this.quest && this.quest.aktif);
  }

  /**
   * Buang SEMUA sirkuit yang sudah ada — tanpa NEWNYM.
   *
   * Kenapa perlu: SETCONF ExitNodes hanya berlaku untuk sirkuit yang BARU
   * dibangun. Tor kadang masih menyerahkan sirkuit lama ("basi") ke stream
   * baru, sehingga hasilnya keluar dari negara yang salah (uji nyata:
   * pin DE dibalas exit JP). CLOSECIRCUIT membuat sirkuit baru wajib
   * mengikuti exit yang barusan di-pin, dan tidak dibatasi 10 detik
   * seperti NEWNYM.
   */
  async _flushSirkuit() {
    try {
      const teks = await this.kontrol.cmd('GETINFO circuit-status', 8000);
      const ids = String(teks)
        .split(/\r?\n/)
        .filter((b) => /^\d+ (BUILT|EXTENDED|LAUNCHED|GUARD_WAIT|COMPUTING|NEW|FIRST_HOP_READY)/.test(b))
        .map((b) => b.split(' ')[0]);
      for (const id of ids) {
        try {
          await this.kontrol.cmd(`CLOSECIRCUIT ${id}`, 6000);
        } catch {
          /* sirkuit mungkin sudah tertutup sendiri */
        }
      }
      return ids.length;
    } catch {
      return 0;
    }
  }

  /**
   * Pastikan sirkuit saat ini benar-benar keluar dari negara `cc`.
   * Cara: identitas SOCKS baru (= sirkuit baru) → cek; salah → identitas baru
   * lagi (maks 3x). NEWNYM hanya dipakai sebagai cadangan terakhir, dan
   * TIDAK PERNAH saat penjalan quest sedang bekerja (bisa memindahkan rute
   * yang sedang ia pakai).
   */
  async _pastiNegara(cc, maksPercobaan = 3) {
    const bolehGanggu = !this._runnerSibuk();
    for (let p = 1; p <= maksPercobaan; p++) {
      const ip = await this._cekNegara(cc, this._identBaru(cc));
      if (ip) return ip;
      if (p === 2 && bolehGanggu) await this._flushSirkuit();
      await tidur(250);
    }
    if (bolehGanggu) {
      await this._newnym().catch(() => {});
      await this._flushSirkuit();
      const ip = await this._cekNegara(cc, this._identBaru(cc));
      if (ip) return ip;
    }
    return '';
  }

  /**
   * Baca /quests/@me lewat sirkuit yang sudah terverifikasi.
   *
   * BUG LAMA yang diperbaiki di sini: penanganan 429 memeriksa `r.retry_after`
   * padahal lamanya tunggu ada di `r.json.retry_after` (socks.js tidak pernah
   * mengangkatnya ke luar) — jadi cabang 429 TIDAK PERNAH jalan dan pemindai
   * terus menembak Discord saat sedang dihukum, yang justru memperpanjang
   * hukuman (retry_after 32 menit -> 52 menit).
   */
  async _bacaQuest(cc, opsi = {}) {
    const diblokir = () => this.stopped || !this.aktif || (this.hatiHati && this.tolakTokenUtama);
    if (diblokir()) return { berhenti: true, r: null };
    const paket = { ...opsi, headers: this._headers() };
    let r = await minta(this.portSocks, `${API}/quests/@me`, paket);
    const rl = Number((r.json && r.json.retry_after) || r.retry_after || 0);
    if (r.status === 429 && rl > 0) {
      const tungguMs = Math.ceil(rl * 1000);
      // 429 PANJANG: jangan tidur diam-diam di dalam putaran — serahkan
      // cooldown ke penjalan quest supaya keduanya berhenti bersamaan,
      // dan catatannya tahan mulai ulang.
      if (tungguMs > 120000 && this.quest && typeof this.quest.pasangJeda === 'function') {
        this.quest.pasangJeda(Math.ceil(tungguMs / 1000), `scout:${cc}`);
        this.sebabJeda = 'batas laju Discord (token)';
        this.emit('change');
        return { jeda: true, r };
      }
      this.log.warn(`Scout: [${String(cc).toUpperCase()}] kena batas laju — tunggu ${Math.ceil(rl)} dtk lalu coba lagi.`);
      await tidur(tungguMs + 1500);
      if (diblokir()) return { berhenti: true, r: null };
      r = await minta(this.portSocks, `${API}/quests/@me`, paket);
    }
    return { jeda: false, r };
  }

  async _pindaiNegara(target) {
    const cc = target.cc;
    const mulaiNegara = Date.now(); // untuk statistik kecepatan (detik/negara)
    // tor siap?
    try {
      if (!(await this._pastikanTor())) return 'berhenti';
    } catch (e) {
      this.gagalTor += 1;
      this.log.warn(`Scout: tor gagal (${this.gagalTor}×) — ${e.message}`);
      this.sebabJeda = 'tor bermasalah (dicoba lagi nanti)';
      if (this.gagalTor >= 5) {
        this.aktif = false;
        this.sebabJeda = 'tor gagal 5× — scout dijeda otomatis';
        this.log.warn('Scout: 5× gagal menyiapkan tor — scout dijeda. Bot tetap jalan.');
      }
      this.emit('change');
      return this.aktif ? 'kosong' : 'berhenti';
    }

    /*
     * Pin exit negara target, lalu minta SIRKUIT BARU lewat identitas SOCKS
     * (tanpa NEWNYM = tanpa menunggu 10 detik). Kalau jalur cepat gagal,
     * baru pakai NEWNYM sebagai cadangan.
     */
    let ip = '';
    for (const fp of this._pilihFp(target)) {
      try {
        await this.kontrol.cmd(`SETCONF ExitNodes=$${fp} StrictNodes=1`);
      } catch (e) {
        this.log.warn('Scout: kontrol tor gagal — ' + e.message);
        this.kontrol.close();
        continue;
      }
      if (!this._runnerSibuk()) await this._flushSirkuit(); // buang sirkuit basi
      ip = await this._pastiNegara(cc);
      if (ip) break;
    }
    if (!ip) {
      this.log.warn(`Scout: [${cc}] tidak dapat exit yang cocok — langsung negara berikutnya.`);
      return 'kosong';
    }

    // OFF / token utama ditolak dapat diputuskan ketika Tor masih menyiapkan sirkuit;
    // jangan mulai request Discord setelah keputusan tersebut.
    if (this.stopped || !this.aktif || (this.hatiHati && this.tolakTokenUtama)) return 'berhenti';
    // baca daftar quest DARI negara itu (identitas yang sama = sirkuit yang sudah terverifikasi)
    const opsiId = { headers: this._headers(), timeoutMs: 60000, user: this._identSaatIni, pass: this._identSaatIni };
    const baca = await this._bacaQuest(cc, opsiId);
    if (baca.berhenti || this.stopped || !this.aktif) return 'berhenti';
    if (baca.jeda) return 'jeda';
    let r = baca.r;
    if (r.status === 401) {
      this.aktif = false;
      this.sebabJeda = 'token dijawab 401 — scout dijeda otomatis';
      this.log.error('Scout: token dijawab 401 — scout dijeda otomatis. Perbaiki token lalu nyalakan lagi.');
      this.emit('change');
      return 'berhenti';
    }
    if (r.status !== 200 || !r.json) {
      this.log.warn(`Scout: [${cc}] gagal baca quest (HTTP ${r.status}${r.error ? ' ' + r.error : ''}) — negara berikutnya.`);
      if (!r.status) {
        this.torSiap = false;
        this.kontrol.close();
      }
      return 'kosong';
    }

    const arr = Array.isArray(r.json) ? r.json : r.json.quests || [];
    const sekarang = Date.now();
    let layak = 0;
    const baru = [];
    for (const q of arr) {
      const ring = this._ringkasSatu(q);
      const semuaIdBaru = !this.known.has(ring.id);
      this.known.add(ring.id);
      // "bisa dikerjakan" = masih berlaku, belum selesai/diklaim, DAN sudah mulai.
      // (quest yang belum dimulai tidak bisa diterima Discord -> jangan dihitung,
      //  itu dulu bikin scout mencoba menerima quest yang belum dibuka)
      const hidup = ring.supported && ring.exp > sekarang && !ring.selesai && !ring.claimed && (!ring.mulai || ring.mulai <= sekarang);
      if (!hidup) continue;
      layak += 1;
      const ekstra = !this.idSet.has(ring.id);
      if (semuaIdBaru || ekstra) {
        baru.push({ ...ring, cc, kategori: semuaIdBaru ? 'BARU' : 'EKSTRA' });
      }
    }
    this.stat.scan += 1;
    this.stat.terakhir = { cc, ip, at: Date.now(), total: arr.length, layak, temuan: baru.length };
    // statistik kecepatan (detik/negara)
    const detik = (Date.now() - mulaiNegara) / 1000;
    this.stat.detikNegara = (this.stat.detikNegara || 0) + detik;
    this.stat.negaraDihitung = (this.stat.negaraDihitung || 0) + 1;
    // negara yang menghasilkan quest dicatat "panas" (dipindai lebih dulu lain kali)
    if (layak > 0) this.stat.panas[cc] = { layak, at: Date.now() };
    // Dedupe dalam O(n) dan kumpulkan alert secara lokal. Menulis tiga file JSON
    // sinkron untuk setiap temuan memperlambat pemindaian negara yang ramai.
    const temuanIds = new Set(this.temuan.map((x) => String(x.id)));
    for (const t of baru) {
      const id = String(t.id);
      if (temuanIds.has(id)) continue;
      temuanIds.add(id);
      this.temuan.unshift(t);
      this.stat.temuanTotal += 1;
      this._alert(`[${t.cc.toUpperCase()}] ${t.kategori}: ${t.nama} (${t.orbs || '?'} Orbs, ${t.jenis})`, { persist: false, notify: false });
    }
    if (this.temuan.length > 300) this.temuan.length = 300;

    if (!layak) {
      this._simpan();
      this.emit('change');
      this.log.info(`Scout: [${cc.toUpperCase()}] ${arr.length} quest · tidak ada yang bisa dikerjakan → langsung negara berikutnya.`);
      return 'kosong';
    }

    // ADA! Lapor dulu, baru kerjakan (alert ini menyimpan sekaligus temuan di atas)
    this._alert(`[${cc.toUpperCase()}] 🎯 ${layak} quest bisa dikerjakan dari negara itu.`);
    if (!this.autoKerja || !this.quest) {
      this.log.info(`Scout: [${cc.toUpperCase()}] kerja otomatis mati — temuan dicatat saja.`);
      return 'kerja';
    }
    return this._kerjakan(arr, cc);
  }

  /**
   * Kerjakan quest yang ketemu di satu negara. Kalau penjalan sedang sibuk,
   * simpan negara ini ke antrean dan HENTIKAN rotasi sampai batch aktif selesai.
   */
  async _kerjakan(arr, cc) {
    const sekarang = Date.now();
    const layakArr = arr.filter((q) => {
      const r = this._ringkasSatu(q);
      return r.supported && r.exp > sekarang && !r.selesai && !r.claimed && (!r.mulai || r.mulai <= sekarang);
    });
    if (!layakArr.length) return 'kosong';
    if (this.quest.aktif) {
      if (!this.antriKerja.some((x) => x.cc === cc) && this.antriKerja.length < 8) {
        this.antriKerja.push({ cc, fps: (this.negara.find((n) => n.cc === cc) || {}).fps || [], jumlah: layakArr.length, at: Date.now() });
        this._alert(`[${cc.toUpperCase()}] 📥 ${layakArr.length} quest masuk antrean — dikerjakan begitu yang sekarang selesai.`);
      } else if (this.antriKerja.length >= 8) {
        this.log.warn(`Scout: antrean quest penuh — [${cc.toUpperCase()}] disimpan untuk dipindai lagi setelah batch aktif selesai.`);
      }
      return 'kerja'; // hentikan rotasi negara sampai batch yang aktif selesai
    }
    this.log.info(
      `Scout: [${cc.toUpperCase()}] mengerjakan ${layakArr.length} quest — pendaftaran lewat rute ${cc.toUpperCase()}, ` +
        'progres lewat koneksi biasa — menunggu sampai semua selesai…',
    );
    // coba-ulang sekarang ditangani penjalan quest (hanya yang gagal, sirkuit
    // diputar otomatis) — di sini cukup laporkan hasilnya apa adanya.
    // Identitas DIBEKUKAN: kalau pemindai memutar identitas lagi sementara
    // quest sedang dikerjakan, pendaftaran bisa keluar dari negara lain
    // (Discord menolak 403 "region"). Jadi rute penjalan dikunci di sini.
    const identKerja = this._identSaatIni;
    const transKerja = (url, opsi = {}) =>
      minta(this.portSocks, url, { ...opsi, user: identKerja, pass: identKerja });
    const hasil = await this.quest.kerjakanLuar(arr, transKerja, `scout:${cc}`);
    if (hasil.ok) {
      const selesai = (hasil.selesai || []).length;
      this.stat.dikerjakanTotal += selesai;
      this.stat.kerjaTotal += 1;
      const gagal = (hasil.gagal || []).length;
      const dilewati = (hasil.dilewati || []).length;
      this.log.info(
        `Scout: [${cc.toUpperCase()}] selesai ${selesai}/${hasil.jumlah} quest` +
          (gagal ? ` · gagal ${gagal}` : '') +
          (dilewati ? ` · dilewati ${dilewati}` : ''),
      );
      if (selesai) {
        this._alert(`[${cc.toUpperCase()}] ✅ quest selesai ${selesai}/${hasil.jumlah} — klaim di app Discord.`);
      } else {
        const sebab = [...(hasil.gagal || []), ...(hasil.dilewati || [])]
          .map((x) => x.sebab || 'gagal')
          .slice(0, 2)
          .join(' · ');
        this._alert(
          `[${cc.toUpperCase()}] ⚠️ 0/${hasil.jumlah} quest selesai — ${sebab || 'belum berhasil'} (dicoba lagi nanti).`,
        );
      }
      await this._segarkanIdSet().catch(() => {});
    } else {
      this.log.warn(`Scout: [${cc.toUpperCase()}] tidak bisa mengerjakan — ${hasil.error}`);
    }
    if (this.quest.kena401) {
      this.aktif = false;
      this.sebabJeda = 'token dijawab 401 — scout dijeda otomatis';
      this.emit('change');
      return 'berhenti';
    }
    return 'kerja';
  }

  /**
   * Kerjakan isi antrean (dipanggil saat penjalan sudah bebas).
   * Pin exit negara itu lagi → baca daftar segar → kerjakan.
   */
  async _kerjakanAntrean() {
    if (!this.quest || this.quest.aktif || !this.antriKerja.length) return '';
    const item = this.antriKerja.shift();
    if (!item) return '';
    if (Date.now() - item.at > 30 * 60000) return ''; // basi > 30 menit
    const cc = item.cc;
    try {
      if (!(await this._pastikanTor())) return '';
      let ip = '';
      for (const fp of this._pilihFp({ cc, fps: item.fps })) {
        try {
          await this.kontrol.cmd(`SETCONF ExitNodes=$${fp} StrictNodes=1`);
        } catch (e) {
          this.log.warn('Scout: kontrol tor gagal (antrean) — ' + e.message);
          this.kontrol.close();
          continue;
        }
        await this._flushSirkuit(); // penjalan sedang bebas di sini — aman
        ip = await this._pastiNegara(cc);
        if (ip) break;
      }
      if (!ip) {
        this.log.warn(`Scout: [${cc.toUpperCase()}] antrean — exit tidak cocok, dilewati (akan dipindai lagi).`);
        return '';
      }
      const baca = await this._bacaQuest(cc, {
        timeoutMs: 60000, user: this._identSaatIni, pass: this._identSaatIni,
      });
      if (baca.jeda) return 'jeda';
      const r = baca.r;
      if (r.status === 401) {
        this.aktif = false;
        this.sebabJeda = 'token dijawab 401 — scout dijeda otomatis';
        this.log.error('Scout: token dijawab 401 (antrean) — scout dijeda otomatis.');
        this.emit('change');
        return 'berhenti';
      }
      if (r.status !== 200 || !r.json) return '';
      const arr = Array.isArray(r.json) ? r.json : r.json.quests || [];
      this.log.info(`Scout: [${cc.toUpperCase()}] dari ANTREAN — mengerjakan ${item.jumlah} quest yang tadi tertunda…`);
      return await this._kerjakan(arr, cc);
    } catch (e) {
      this.log.warn('Scout: antrean gagal — ' + e.message);
      return '';
    }
  }

  /** Ringkasan satu quest dari data mentah Discord (dipakai Scout saja). */
  _ringkasSatu(q) {
    const cfg = q.config || {};
    const us = q.user_status || {};
    const tugas = (cfg.task_config_v2 && cfg.task_config_v2.tasks) || (cfg.task_config && cfg.task_config.tasks) || {};
    const taskType = tugas.PLAY_ON_DESKTOP
      ? 'PLAY_ON_DESKTOP'
      : tugas.WATCH_VIDEO
        ? 'WATCH_VIDEO'
        : tugas.WATCH_VIDEO_ON_MOBILE
          ? 'WATCH_VIDEO_ON_MOBILE'
          : '';
    const task = taskType ? tugas[taskType] : null;
    const jenis = taskType === 'PLAY_ON_DESKTOP' ? 'main' : taskType ? 'nonton' : '?';
    const target = taskType ? targetFor(task, taskType) : 0;
    const selesaiState = completionState(us, taskType, target);
    const expRaw = cfg.expires_at ? Date.parse(cfg.expires_at) : Number.MAX_SAFE_INTEGER;
    const mulaiRaw = cfg.starts_at ? Date.parse(cfg.starts_at) : 0;
    let orbs = null;
    try {
      const rw = (cfg.rewards_config && cfg.rewards_config.rewards) || [];
      orbs = rw.length ? rw[0].orb_quantity : null;
    } catch {
      /* biarkan null */
    }
    return {
      id: q.id,
      nama: (cfg.messages && cfg.messages.quest_name) || (cfg.application && cfg.application.name) || '?',
      jenis,
      supported: Boolean(taskType),
      target,
      progress: selesaiState.progress.value,
      selesaiTidakSinkron: selesaiState.mismatch,
      orbs,
      exp: Number.isFinite(expRaw) ? expRaw : Number.MAX_SAFE_INTEGER,
      mulai: Number.isFinite(mulaiRaw) ? mulaiRaw : 0,
      selesai: taskType ? selesaiState.completed : Boolean(us.completed_at),
      claimed: Boolean(us.claimed_at),
    };
  }

  /**
   * Cek negara IP keluar sekarang. ip-api (http) dulu; country.is cadangan.
   * Catatan: country.is versi baru menjawab "T1" untuk banyak exit Tor —
   * karena itu ip-api yang dipakai lebih dulu.
   * @returns {Promise<string>} alamat IP kalau cocok, '' kalau tidak
   */
  /**
   * Sinyal sirkuit baru — TAPI hormati batas Tor (NEWNYM maks 1× / 10 detik).
   * Kalau dipanggil terlalu cepat, Tor mengabaikannya (sirkuit tidak berganti),
   * jadi dulu kita menunggu 6 dtk + 11 dtk antar negara = ±19 dtk per negara.
   * Sekarang spasi dijaga di sini saja, dan sisanya tidak perlu menunggu.
   */
  async _newnym() {
    const sejak = Date.now() - (this._newnymAt || 0);
    const sisa = 10500 - sejak;
    if (sisa > 0) await tidur(sisa);
    await this.kontrol.cmd('SIGNAL NEWNYM');
    this._newnymAt = Date.now();
  }

  /** Identitas SOCKS baru untuk satu negara = sirkuit Tor baru (tanpa NEWNYM). */
  _identBaru(cc) {
    this._identKe = (this._identKe || 0) + 1;
    this._identSaatIni = `sc-${cc}-${this._identKe}`;
    return this._identSaatIni;
  }

  /** Sirkuit Tor baru untuk exit yang sama (dipakai saat kerja gagal). */
  async putarSirkuit() {
    this._identSaatIni = `rot-${Date.now().toString(36)}`; // sirkuit baru lewat isolasi
    try {
      await this.kontrol.cmd('SIGNAL NEWNYM');
      this._newnymAt = Date.now();
    } catch {
      /* tor mungkin sedang mati — biarkan */
    }
    await tidur(1500);
  }

  /**
   * Tunggu sampai sirkuit BENAR-BENAR keluar dari negara tujuan.
   * Dulu: tidur 6 dtk dulu, baru cek (3×). Sekarang: cek sejak 0,3 dtk dan
   * ulangi tiap 1,5 dtk — biasanya cocok dalam 1-4 dtk (hemat ~4-5 dtk/negara).
   */

  /**
   * Urutkan daftar negara: yang pernah menghasilkan quest (panas) didahulukan,
   * sisanya tetap ikut terpindai (urutan rotasi). Dipanggil di awal putaran.
   */
  _susunUrutan() {
    const panas = this.stat.panas || {};
    const nilai = (cc) => {
      const p = panas[cc];
      if (!p) return 0;
      if (Date.now() - (p.at || 0) > 7 * 24 * 3600 * 1000) return 0; // basi > 7 hari
      return (Number(p.layak) || 1) * 1e13 + (p.at || 0);
    };
    this.negara = [...this.negara].sort((a, b) => nilai(b.cc) - nilai(a.cc));
  }

  async _cekNegara(cc, ident = null) {
    // identitas diteruskan supaya pengecekan negara memakai SIRKUIT yang sama
    // dengan yang akan dipakai membaca quest (kalau tidak, hasilnya bisa beda)
    const opsiId = ident ? { user: ident, pass: ident } : {};
    const cek1 = await httpMinta(this.portSocks, 'http://ip-api.com/json/?fields=countryCode,query', 15000, opsiId);
    if (cek1.json && cek1.json.countryCode) {
      if (String(cek1.json.countryCode).toLowerCase() === cc) return cek1.json.query || '(ip-api)';
      // jawaban pasti dari ip-api: keluar dari negara LAIN → tak perlu cek kedua
      // (menghemat ±1,5 dtk per percobaan; sirkuit yang sama pasti sama jawabannya)
      return '';
    }
    const cek2 = await getJsonSocks(this.portSocks, 'https://api.country.is/', 15000, opsiId);
    if (cek2.ok && String(cek2.json.country || '').toLowerCase() === cc) return cek2.json.ip || '(country.is)';
    return '';
  }

  _pilihFp(target) {
    const daftar = [...(target.fps || [])];
    const pilih = [];
    while (daftar.length && pilih.length < 3) {
      pilih.push(daftar.splice(Math.floor(Math.random() * daftar.length), 1)[0]);
    }
    return pilih;
  }

  /* ------------------------------- kontrol ------------------------------- */

  setAktif(on) {
    this.dimintaAktif = Boolean(on);
    if (this.dimintaAktif && this.hatiHati && this.tolakTokenUtama) {
      this.dimintaAktif = false;
      this.aktif = false;
      this.sebabJeda = 'token utama dilindungi; pasang token quest atau opt-in eksplisit terlebih dahulu';
      this.log.warn('Scout: ON ditolak — token utama tidak diizinkan untuk sweep.');
    } else if (!this.dimintaAktif) {
      this.aktif = false;
      this.sebabJeda = '';
      if (this._retryNegaraTimer) clearTimeout(this._retryNegaraTimer);
      this._retryNegaraTimer = null;
      this.log.info('Scout: dimatikan lewat dashboard.');
    } else if (!this.negara.length) {
      this.aktif = false;
      const ulang = this._jadwalkanRetryNegara();
      this.sebabJeda = `daftar negara tidak tersedia (menunggu Onionoo; coba ulang ±${ulang} dtk)`;
      this.gagalTor = 0;
      this.log.info(`Scout: ON diminta dari dashboard; daftar negara belum ada, coba ulang dalam ${ulang} dtk.`);
    } else {
      this.aktif = true;
      this.sebabJeda = '';
      this.gagalTor = 0;
      this.log.info('Scout: dinyalakan lewat dashboard.');
    }
    this.emit('change');
    return this.status();
  }

  status() {
    return {
      enabled: this.dimintaAktif,
      aktif: this.aktif,
      sebab: this.sebabJeda,
      intervalMin: this.intervalMin,
      jedaPutaran: this.jedaPutaran,
      jedaSaatId: this.jedaSaatId,
      burstMaks: this.burstMaks,
      jedaAntar: this.jedaAntar,
      autoKerja: this.autoKerja && Boolean(this.quest),
      negara: this.negara.length,
      putaran: this.stat.putaran,
      scan: this.stat.scan,
      torSiap: this.torSiap,
      terakhir: this.stat.terakhir,
      temuanTotal: this.stat.temuanTotal,
      temuan: this.temuan.slice(0, 40),
      dikerjakanTotal: this.stat.dikerjakanTotal,
      kerjaTotal: this.stat.kerjaTotal,
      antri: this.antriKerja.length,
      hatiHati: this.hatiHati,
      tokenKhusus: this.tokenKhusus,
      tokenUtamaDitolak: this.tolakTokenUtama,
      rataDetikNegara: this.stat.negaraDihitung
        ? Math.round((this.stat.detikNegara / this.stat.negaraDihitung) * 10) / 10
        : null,
      antriList: this.antriKerja.slice(0, 6).map((x) => ({ cc: x.cc, jumlah: x.jumlah })),
      panas: Object.entries(this.stat.panas || {})
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, 6)
        .map(([cc, v]) => ({ cc, layak: v.layak, at: v.at })),
      alert: this.alert.slice(0, 10),
      mulaiJam: this.stat.mulaiJam,
      logTor: this.torLog.slice(-6),
    };
  }
}

module.exports = { Scout, ekstrakTargz };
