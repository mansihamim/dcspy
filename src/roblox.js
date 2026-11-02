'use strict';

/**
 * ============================================================================
 *  RobloxPresence — tampilkan "Playing Roblox" di Discord walau main di HP
 * ============================================================================
 *  Kenapa perlu ini?
 *   - Aplikasi Discord di HP TIDAK bisa mendeteksi game lain (batasan OS),
 *     jadi main Roblox di HP tidak pernah muncul sebagai aktivitas.
 *   - Supaya muncul, kita yang mengirim aktivitas "Playing Roblox" ke gateway
 *     Discord. Karena sesi script ini terdaftar sebagai desktop (Mac),
 *     di profil orang lain akan terlihat seperti main dari PC/laptop.
 *
 *  Dua mode:
 *   1. `manual` — aktivitas "Playing <ROBLOX_NAME>" selalu tampil
 *      (mis. "Playing Roblox"). Tidak butuh kredensial apa pun.
 *   2. `auto`   — script memantau presence Roblox kamu (butuh cookie
 *      .ROBLOSECURITY + user ID) lalu menampilkan nama game yang benar-benar
 *      sedang kamu mainkan, mis. "Playing Roblox · Blox Fruits".
 *      Kalau kamu tidak sedang main, aktivitasnya otomatis hilang.
 *
 *  ⚠ Cookie .ROBLOSECURITY = kunci login akun Roblox. Simpan hanya di .env,
 *     jangan pernah dibagikan. Script ini tidak pernah menampilkannya di log.
 * ============================================================================
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { request } = require('./http');

const PRESENCE_URL = 'https://presence.roblox.com/v1/presence/users';
const GAMES_URL = 'https://games.roblox.com/v1/games?universeIds=';
const PLACE_TO_UNIVERSE_URL = 'https://apis.roblox.com/universes/v1/places/';

/**
 * lastLocation yang BUKAN nama game (jadi jangan dipakai sebagai nama game).
 * Contoh: saat hanya membuka aplikasi/web Roblox.
 */
const NON_GAME_LOCATIONS = new Set([
  'website', 'offline', 'mobile', 'mobile app', 'app', 'home', 'roblox', 'roblox studio',
  'roblox.com', 'games', 'invisible', '', '-',
]);

function looksLikeGameName(location) {
  const value = String(location || '').trim();
  if (!value) return false;
  return !NON_GAME_LOCATIONS.has(value.toLowerCase());
}

/** Jenis presence Roblox. */
const PRESENCE_TYPE = {
  OFFLINE: 0,
  ONLINE: 1,
  IN_GAME: 2,
  IN_STUDIO: 3,
  INVISIBLE: 4,
};

/**
 * Ambil data presence milik satu user dari respons API (murni, mudah dites).
 * @param {any} json respons presence.roblox.com
 * @param {string|number} userId
 * @returns {{type:number|null, location:string, placeId:number|null, universeId:number|null, rootPlaceId:number|null, gameId:string|null}}
 */
function parsePresence(json, userId) {
  const empty = { type: null, location: '', placeId: null, universeId: null, rootPlaceId: null, gameId: null };
  const list = json && Array.isArray(json.userPresences) ? json.userPresences : null;
  if (!list) return empty;
  const id = String(userId);
  // Jangan pernah memakai list[0] sebagai fallback: bila Roblox tidak
  // mengembalikan target user, itu bisa menampilkan presence orang lain.
  const entry = list.find((p) => p && p.userId != null && String(p.userId) === id);
  if (!entry) return empty;
  return {
    type: typeof entry.userPresenceType === 'number' ? entry.userPresenceType : null,
    location: String(entry.lastLocation || ''),
    placeId: entry.placeId ?? null,
    universeId: entry.universeId ?? null,
    rootPlaceId: entry.rootPlaceId ?? null,
    gameId: entry.gameId || null,
  };
}

/**
 * Ubah presence Roblox jadi info aktivitas Discord.
 * @returns {{visible:boolean, game:string}}
 */
function describePresence(presence) {
  switch (presence.type) {
    case PRESENCE_TYPE.IN_GAME:
      return { visible: true, game: presence.location || '' };
    case PRESENCE_TYPE.IN_STUDIO:
      return { visible: true, game: 'Roblox Studio' };
    case PRESENCE_TYPE.ONLINE:
      return { visible: true, game: '' };
    default: // OFFLINE / INVISIBLE / tidak diketahui
      return { visible: false, game: '' };
  }
}

class RobloxPresence extends EventEmitter {
  /**
   * @param {{logger:any, cfg:any}} opts  cfg = config.roblox
   */
  constructor({ logger, cfg }) {
    super();
    this.log = logger;
    this.cfg = cfg;

    this.name = cfg.name || 'Roblox';
    this.appId = String(cfg.appId || '').trim(); // app Roblox di Discord -> logo asli
    // Aktivitas "native" Discord (orang main Roblox di PC) memakai dua ID:
    //   session_id = 32 hex, id = 16 hex. Kita tiru supaya tampilannya sama persis.
    this.sessionId = crypto.randomBytes(16).toString('hex');
    this.gameId = crypto.randomBytes(8).toString('hex');
    this.showGame = cfg.showGame !== false; // tampilkan nama game di baris kedua?
    this.game = cfg.mode === 'manual' ? cfg.game || '' : '';
    this.visible = cfg.mode === 'manual';
    this.startedAt = Date.now();
    // Jeda maksimal (ms) yang masih dianggap "sesi yang sama" -> timer tidak direset.
    this.graceMs = Math.max(0, Number(cfg.timerGraceMin ?? 10)) * 60000;

    this.stopped = false;
    this.timer = null;
    this.csrfToken = '';
    this.nameCache = new Map();     // universeId -> nama game
    this.universeCache = new Map(); // placeId -> universeId
    this.lastPollAt = 0;
    this.lastPollOk = 0;
    this.lastPollStatus = null;
    this.lastError = '';
    this.failCount = 0;
    this.pollInFlight = false;
    this.lastSeenAt = 0;            // terakhir kali terdeteksi sedang main
    this.lastSource = '';
  }

  get enabled() {
    return Boolean(this.cfg.enabled);
  }

  get available() {
    return this.enabled && this.visible && Boolean(this.name || this.game);
  }

  /** Aktivitas untuk gateway Discord (null = tidak ada aktivitas Roblox). */
  activity() {
    if (!this.available) return null;
    const act = {
      id: this.gameId,          // 16 hex, seperti aktivitas native
      session_id: this.sessionId, // 32 hex
      name: this.name || 'ROBLOX',
      type: 0, // Playing
      created_at: this.startedAt,
      timestamps: { start: this.startedAt },
      official_game_id: null,
    };
    // application_id = aplikasi "Roblox" resmi di Discord -> logo Roblox tampil
    // dengan benar (kalau tidak diisi, Discord suka menampilkan gambar rusak).
    if (this.appId) act.application_id = this.appId;
    if (this.game && this.showGame) act.details = this.game;
    return act;
  }

  /** Terapkan status terbaru; emit 'change' kalau ada yang berubah. */
  update(visible, game, source = '') {
    const now = Date.now();
    const gapMs = this.lastSeenAt ? now - this.lastSeenAt : Infinity;
    if (visible) {
      this.lastSeenAt = now;
      this.lastSource = source;
    }
    const changed = visible !== this.visible || game !== this.game;
    if (!changed) return;
    if (visible && !this.visible) {
      // Mulai main lagi. Timer HANYA direset kalau jedanya sudah lama
      // (lebih dari ROBLOX_TIMER_GRACE_MIN). Kalau presence cuma sempat
      // hilang sebentar / ganti game, timer tetap jalan — tidak balik ke 0.
      if (gapMs > this.graceMs) this.startedAt = now;
    }
    // Catatan: ganti nama game saat masih main TIDAK lagi me-reset timer.
    this.visible = visible;
    this.game = game;
    if (visible) {
      this.log.info(`Roblox: ${this.name}${game ? ' — ' + game : ''} (terdeteksi dari ${source})`);
    } else {
      this.log.info(`Roblox: tidak sedang main (${source}) — aktivitas dihapus.`);
    }
    this.emit('change');
  }

  /* --------------------------- API presence ----------------------------- */

  /** Nama game dari universeId (cache 1 jam), diambil dari API publik Roblox. */
  async resolveGameName(universeId) {
    if (!universeId) return '';
    const key = String(universeId);
    const cached = this.nameCache.get(key);
    if (cached && Date.now() - cached.at < 3600_000) return cached.name;
    const res = await request('GET', GAMES_URL + key, {
      headers: { Accept: 'application/json', 'User-Agent': this.cfg.userAgent },
    });
    const name = res.json && Array.isArray(res.json.data) && res.json.data[0] ? String(res.json.data[0].name || '') : '';
    if (name) this.nameCache.set(key, { name, at: Date.now() });
    return name;
  }

  /** placeId -> universeId (API publik Roblox), supaya nama game bisa akurat. */
  async resolveUniverseId(placeId) {
    if (!placeId) return 0;
    const key = String(placeId);
    if (this.universeCache.has(key)) return this.universeCache.get(key);
    const res = await request('GET', `${PLACE_TO_UNIVERSE_URL}${key}/universe`, {
      headers: { Accept: 'application/json', 'User-Agent': this.cfg.userAgent },
    });
    const universeId = res.status === 200 && res.json ? Number(res.json.universeId || 0) : 0;
    this.universeCache.set(key, universeId);
    return universeId;
  }

  /** Ambil presence milik user (cookie opsional; tanpa cookie tetap dapat tipe + lokasi). */
  async fetchPresence() {
    const body = JSON.stringify({ userIds: [Number(this.cfg.userId)] });
    const doRequest = (csrf) =>
      request('POST', PRESENCE_URL, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.cfg.cookie ? { Cookie: `.ROBLOSECURITY=${this.cfg.cookie}` } : {}),
          'User-Agent': this.cfg.userAgent,
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body,
        timeoutMs: Math.max(8000, Math.min(20000, Number(this.cfg.pollSec || 15) * 1000 - 1000)),
      });

    let res = await doRequest(this.csrfToken);

    // Roblox: 403 + header X-CSRF-TOKEN -> ulangi dengan token itu
    const newToken = res.headers && (res.headers['x-csrf-token'] || res.headers['X-CSRF-TOKEN']);
    if ((res.status === 403 || res.status === 401) && newToken && newToken !== this.csrfToken) {
      this.csrfToken = newToken;
      res = await doRequest(this.csrfToken);
    }
    return res;
  }

  async poll() {
    if (!this.enabled || this.cfg.mode !== 'auto' || this.stopped || this.pollInFlight) return;
    if (!this.cfg.userId) {
      this.lastError = 'ROBLOX_USER_ID belum diatur';
      return;
    }

    this.pollInFlight = true;
    this.lastPollAt = Date.now();
    try {
      const res = await this.fetchPresence();
      if (this.stopped) return;
      this.lastPollStatus = Number(res && res.status) || 0;

      if (res.status !== 200) {
        this.failCount += 1;
        this.lastError = `HTTP ${res.status}${res.error ? ` ${res.error}` : ''}`;
        // cukup laporkan sesekali supaya log tidak banjir
        if (this.failCount === 1 || this.failCount % 20 === 0) {
          this.log.warn(
            `Roblox: gagal cek presence (${this.lastError}) — cek ROBLOX_COOKIE / ROBLOX_USER_ID di .env.`,
          );
        }
        return;
      }

      const presence = parsePresence(res.json, this.cfg.userId);
      if (presence.type === null) {
        // HTTP 200 tanpa entri user yang diminta bukan bukti bahwa user offline.
        // Jangan hapus aktivitas yang valid karena respons parsial/malformed.
        this.failCount += 1;
        this.lastError = 'presence user tidak ada di respons Roblox';
        if (this.failCount === 1 || this.failCount % 20 === 0) {
          this.log.warn(`Roblox: ${this.lastError} (HTTP 200); aktivitas lama dipertahankan.`);
        }
        return;
      }

      this.failCount = 0;
      this.lastPollOk = Date.now();
      this.lastError = '';
      const described = describePresence(presence);

      // ---- sedang main: cari nama game yang PALING AKURAT ----
      if (described.visible) {
        let label = described.game;

        // 1) universeId langsung dari API presence
        let universeId = Number(presence.universeId || 0);
        // 2) kalau tidak ada, ubah placeId -> universeId (API publik)
        if (!universeId) universeId = await this.resolveUniverseId(presence.placeId || presence.rootPlaceId);
        if (this.stopped) return;
        // 3) nama RESMI dari Roblox (paling akurat, sama seperti di website)
        if (universeId) {
          const official = await this.resolveGameName(universeId);
          if (official) label = official;
        }
        if (this.stopped) return;
        // 4) fallback: lastLocation kalau memang berupa nama game
        if (!label && looksLikeGameName(presence.location)) label = presence.location;

        this.update(true, label, 'API Roblox');
        return;
      }

      // ---- tidak (terdeteksi) main: pakai jendela "anti-kedip" ----
      const stickyMs = Math.max(0, Number(this.cfg.stickyMin || 0)) * 60 * 1000;
      const withinSticky = stickyMs > 0 && this.game && this.lastSeenAt && Date.now() - this.lastSeenAt < stickyMs;
      if (withinSticky) {
        this.update(true, this.game, 'API Roblox (jendela anti-kedip)');
        return;
      }
      this.update(false, '', 'API Roblox');
    } catch (err) {
      if (this.stopped) return;
      this.lastPollStatus = 0;
      this.failCount += 1;
      this.lastError = String(err && err.message ? err.message : err).slice(0, 180);
      if (this.failCount === 1 || this.failCount % 20 === 0) {
        this.log.warn(`Roblox: error saat cek presence — ${this.lastError}`);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Ringkasan diagnostik yang aman ditampilkan di dashboard (tanpa cookie). */
  status() {
    return {
      enabled: this.enabled,
      mode: this.cfg.mode,
      active: Boolean(this.visible),
      game: this.game || '',
      monitoring: Boolean(this.enabled && this.cfg.mode === 'auto' && this.timer && !this.stopped),
      paused: Boolean(this.stopped),
      intervalSec: Number(this.cfg.pollSec || 0),
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      lastPollStatus: this.lastPollStatus,
      inFlight: this.pollInFlight,
      failures: this.failCount,
      lastError: this.lastError,
      lastSource: this.lastSource,
    };
  }

  /* -------------------------------- MULAI -------------------------------- */

  async start() {
    if (!this.enabled) {
      this.log.info('Roblox: nonaktif (ROBLOX_ENABLED=false).');
      return;
    }

    if (this.cfg.mode !== 'auto') {
      if (!this.name && !this.game) {
        this.log.warn('Roblox: ROBLOX_NAME/ROBLOX_GAME kosong — tidak ada yang ditampilkan.');
        return;
      }
      this.log.info(
        `Roblox: mode manual — aktivitas "Playing ${this.name}"${this.game ? ` (${this.game})` : ''} ` +
          'tampil terus selama script jalan.',
      );
      this.emit('change');
      return;
    }

    // mode auto: wajib ROBLOX_USER_ID; cookie opsional
    if (!this.cfg.userId) {
      this.log.warn(
        'Roblox: mode auto butuh ROBLOX_USER_ID di .env ' +
          '(angka dari URL profil: roblox.com/users/<angka>/profile).',
      );
      return;
    }

    this.log.info(
      `Roblox: mode auto — memantau presence tiap ${this.cfg.pollSec}s (user ${this.cfg.userId}` +
        `${this.cfg.cookie ? ', +cookie' : ', tanpa cookie'}).`,
    );
    await this.poll().catch((e) => this.log.warn('Roblox:', e.message));

    this.timer = setInterval(() => {
      this.poll().catch((e) => this.log.warn('Roblox:', e.message));
    }, this.cfg.pollSec * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Dipakai dashboard: lanjut memantau lagi setelah sempat di-stop
   * (mis. waktu mode PS5 dimatikan). Tidak mengubah config apa pun.
   */
  async resume() {
    if (!this.enabled || this.timer) return;
    this.stopped = false;
    if (this.cfg.mode !== 'auto') {
      this.emit('change');
      return;
    }
    this.log.info(`Roblox: lanjut memantau (tiap ${this.cfg.pollSec}s).`);
    await this.poll().catch((e) => this.log.warn('Roblox:', e.message));
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.log.warn('Roblox:', e.message));
    }, this.cfg.pollSec * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { RobloxPresence, parsePresence, describePresence, PRESENCE_TYPE };
