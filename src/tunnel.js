'use strict';

/**
 * ============================================================================
 *  Tunnel — supaya dashboard bisa dibuka dari internet TANPA port publik.
 * ============================================================================
 *
 *  Masalah: server (panel/hosting) kadang tidak punya alamat/port publik,
 *  jadi dashboard yang nempel di proses bot tidak bisa dibuka dari HP.
 *
 *  Solusi: bot membuka **tunnel keluar** (Cloudflare Quick Tunnel) ke
 *  dashboard-nya sendiri. Hasilnya satu URL HTTPS publik seperti
 *  `https://xxxx-yyyy.trycloudflare.com` yang bisa dibuka dari mana saja.
 *
 *  URL-nya berubah setiap kali bot restart, jadi URL itu **dilaporkan** ke
 *  satu halaman tetap (mis. `flodismy-dash.vercel.app`) supaya kamu cukup
 *  bookmark satu alamat.
 *
 *  Catatan jujur:
 *   - Ini terowongan keluar (outbound), jadi tidak butuh port/alamat dari
 *     hosting dan tidak membuka port baru di server (aman dari sisi firewall).
 *   - Quick Tunnel gratis dari Cloudflare: tidak ada jaminan SLA, dan URL
 *     berubah kalau di-restart (halaman tetap di Vercel menanganinya).
 *   - cloudflared diunduh sekali ke ./bin (bukan dependency npm).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const URL_UNDUH =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

/**
 * Cari URL tunnel dari keluaran cloudflared.
 * Dipisah jadi fungsi murni supaya bisa diuji tanpa menjalankan proses.
 * @param {string} teks
 * @returns {string} '' kalau belum ada
 */
function urlDari(teks) {
  const m = String(teks || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : '';
}

class Tunnel extends EventEmitter {
  /**
   * @param {{logger:any, port:number, dir?:string, aktip?:boolean,
   *          laporUrl?:string, laporSecret?:string}} opts
   */
  constructor({ logger, port, dir, aktif = true, laporUrl = '', laporSecret = '' }) {
    super();
    this.log = logger;
    this.port = Number(port) || 23304;
    this.dir = dir || path.join(__dirname, '..', 'bin');
    this.bin = path.join(this.dir, 'cloudflared');
    this.aktif = Boolean(aktif);
    this.laporUrl = String(laporUrl || '').trim();
    this.laporSecret = String(laporSecret || '').trim();

    this.url = '';
    this.proc = null;
    this.stopped = false;
    this.gagalBerturut = 0;
    this.timer = null;
    this.terakhirLapor = 0;
    this.logCf = [];
    this.gagalUnduh = 0;
    this.pecah = false; // true = tunnel menyerah (bot dibiarkan hidup tanpa tunnel)
    this.mulaiJam = 0;
    this.berkasJejak = path.join(__dirname, '..', 'data', 'tunnel-jejak.json');
    this.maksPercobaan = Number(process.env.TUNNEL_MAKS_COBA || 5);
  }

  /* --------------------------- jejak percobaan ---------------------------- */

  _bacaJejak() {
    try {
      return JSON.parse(fs.readFileSync(this.berkasJejak, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  _tulisJejak(isi) {
    try {
      fs.mkdirSync(path.dirname(this.berkasJejak), { recursive: true });
      fs.writeFileSync(this.berkasJejak, JSON.stringify(isi, null, 1));
    } catch {
      /* kalau tidak bisa menulis, abaikan */
    }
  }

  /* --------------------------------- unduh -------------------------------- */

  async _pastikanBin() {
    try {
      const st = fs.statSync(this.bin);
      if (st.size > 5 * 1024 * 1024) return true; // sudah ada & ukurannya wajar
    } catch {
      /* belum ada */
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.log.info('Tunnel: mengunduh cloudflared (sekali saja, ±40 MB) — pakai streaming.');
    const res = await fetch(URL_UNDUH, { redirect: 'follow' });
    if (!res.ok) throw new Error(`unduh gagal (HTTP ${res.status})`);
    if (!res.body) throw new Error('unduhan tidak mengalir');
    const sementara = this.bin + '.part';
    // streaming -> memori tetap kecil (jangan buffer 40 MB di RAM)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(sementara, { mode: 0o755 }));
    const ukuran = fs.statSync(sementara).size;
    if (ukuran < 5 * 1024 * 1024) {
      fs.unlinkSync(sementara);
      throw new Error(`berkas tidak wajar (${ukuran} byte)`);
    }
    fs.renameSync(sementara, this.bin);
    this.log.info(`Tunnel: cloudflared siap (${Math.round(ukuran / 1048576)} MB).`);
    return true;
  }

  /* ------------------------------- jalankan ------------------------------- */

  async start() {
    if (!this.aktif || this.stopped || this.pecah) return;

    // Jejak tersimpan: kalau percobaan sebelumnya membuat container mati
    // (proses hilang sebelum sempat menulis apa-apa), jangan ulangi terus.
    const jejak = this._bacaJejak();
    if (jejak.mati) {
      this.pecah = true;
      this.log.warn('Tunnel: pernah gagal (jejak di data/tunnel-jejak.json) — tunnel dilewati.');
      this.log.warn('Tunnel: bot jalan normal tanpa tunnel. Hapus berkas itu kalau mau coba lagi.');
      return;
    }
    if ((jejak.coba || 0) >= this.maksPercobaan) {
      this.pecah = true;
      this.log.warn(`Tunnel: sudah ${jejak.coba}× dicoba & gagal — tunnel dilewati (bot tetap hidup).`);
      this.log.warn('Tunnel: hapus data/tunnel-jejak.json kalau mau mencoba lagi.');
      return;
    }
    this._tulisJejak({ coba: (jejak.coba || 0) + 1, terakhir: Date.now() });
    // Tunda dulu: keep-online & dashboard dipastikan hidup lebih dulu. Kalau
    // tunnel bermasalah (mis. hosting membunuh prosesnya), bot tetap aman.
    const jeda = Number(process.env.TUNNEL_MULAI_DETIK || 15) * 1000;
    this.log.info(`Tunnel: akan dicoba ${Math.round(jeda / 1000)} detik lagi (biar bot stabil dulu).`);
    await new Promise((r) => setTimeout(r, jeda));
    if (this.stopped || this.pecah) return;
    try {
      await this._pastikanBin();
    } catch (e) {
      this.gagalUnduh += 1;
      this.log.warn('Tunnel: gagal menyiapkan cloudflared — ' + e.message);
      if (this.gagalUnduh >= 2) {
        this.pecah = true;
        this.log.warn('Tunnel: menyerah setelah 2× gagal unduh. Bot dibiarkan jalan tanpa tunnel.');
        this.log.warn('Tunnel: minta alamat/port publik ke hosting sebagai gantinya.');
      } else {
        setTimeout(() => this.start(), 20000);
      }
      return;
    }
    this._spawn();
  }

  _spawn() {
    if (this.stopped) return;
    const args = ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate'];
    this.mulaiJam = Date.now();
    this.proc = spawn(this.bin, args, { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] });

    const tangkap = (chunk) => {
      const teks = String(chunk);
      for (const baris of teks.split(/\r?\n/)) {
        const t = baris.trim();
        if (!t) continue;
        this.logCf.push(t);
        if (this.logCf.length > 40) this.logCf.shift();
        const ketemu = urlDari(t);
        if (ketemu && ketemu !== this.url) {
          this.url = ketemu;
          this._tulisJejak({ coba: 0, sukses: Date.now() });
          this.gagalBerturut = 0;
          this.log.info(`Tunnel: dashboard bisa dibuka di ${this.url}`);
          this.emit('url', this.url);
          this._lapor();
        }
      }
    };
    this.proc.stdout.on('data', tangkap);
    this.proc.stderr.on('data', tangkap);

    this.proc.on('error', (e) => {
      this.log.warn('Tunnel: gagal menjalankan cloudflared — ' + e.message);
      this._cobaLagi();
    });
    this.proc.on('exit', (code) => {
      const hidupMs = Date.now() - this.mulaiJam;
      this.proc = null;
      if (this.stopped) return;
      this.log.warn(`Tunnel: cloudflared berhenti (kode ${code}) setelah ${Math.round(hidupMs / 1000)} detik.`);
      if (hidupMs < 15000) {
        // mati terlalu cepat -> jangan biarkan bot ikut dibunuh hosting
        this.gagalBerturut += 1;
        if (this.gagalBerturut >= 3) {
          this.pecah = true;
          this._tulisJejak({ coba: 99, mati: true, terakhir: Date.now() });
          this.log.warn('Tunnel: 3× mati cepat — tunnel DIMATIKAN supaya bot tetap hidup.');
          this.log.warn('Tunnel: dashboard tetap jalan di server; minta alamat/port publik ke hosting.');
          return;
        }
      } else {
        this.gagalBerturut = 0;
      }
      this._cobaLagi();
    });
  }

  _cobaLagi() {
    if (this.stopped) return;
    this.gagalBerturut += 1;
    const jeda = Math.min(60, 5 * this.gagalBerturut);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._spawn(), jeda * 1000);
    if (this.gagalBerturut === 3) {
      this.log.warn('Tunnel: sudah 3× gagal. Kalau hosting memblokir, minta alamat/port ke hosting saja.');
    }
  }

  /* ----------------------- laporkan URL ke halaman tetap ------------------- */

  async _lapor() {
    if (!this.laporUrl || !this.url) return;
    if (Date.now() - this.terakhirLapor < 5000) return;
    this.terakhirLapor = Date.now();
    try {
      const r = await fetch(this.laporUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-secret': this.laporSecret },
        body: JSON.stringify({ url: this.url, at: Date.now() }),
      });
      if (r.ok) this.log.info('Tunnel: alamat tetap (Vercel) sudah diperbarui.');
      else this.log.warn(`Tunnel: gagal melaporkan alamat (HTTP ${r.status}).`);
    } catch (e) {
      this.log.warn('Tunnel: gagal melaporkan alamat — ' + e.message);
    }
  }

  /** Ringkasan untuk /api/status. */
  get info() {
    return {
      aktif: this.aktif && !this.pecah, jalan: Boolean(this.proc), url: this.url,
      pecah: this.pecah, log: this.logCf.slice(-3),
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      if (this.proc) this.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Tunnel, urlDari };
