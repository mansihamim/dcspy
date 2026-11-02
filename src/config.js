'use strict';

/**
 * Konfigurasi terpusat.
 * Prioritas: environment variable > file .env > default di bawah.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

/** Parser .env super ringan (tanpa dependency). */
function loadDotEnv(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv();

const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase());
};
const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const str = (v, def = '') => (v === undefined || v === null ? def : String(v));

/**
 * Preset platform: menentukan akun kamu terlihat sedang online dari apa.
 * Ini yang bikin indikator di profil muncul sebagai komputer (PC/laptop)
 * atau HP. Harus konsisten antara User-Agent & properties IDENTIFY.
 */
const PLATFORMS = {
  android: {
    label: 'Android (HP)',
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; CPH2579 Build/AP3A.240617.008) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.199 Mobile Safari/537.36',
    properties: { os: 'Android', browser: 'Discord Android', device: 'Discord Android' },
  },
  ios: {
    label: 'iPhone / iPad (HP)',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    properties: { os: 'iOS', browser: 'Discord iOS', device: 'iPhone' },
  },
  macos: {
    label: 'MacBook / macOS (desktop Apple)',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.310 Chrome/130.0.6723.191 Electron/33.2.1 Safari/537.36',
    properties: { os: 'Mac OS X', browser: 'Discord Client', device: '' },
  },
  windows: {
    label: 'Windows (PC/laptop)',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.310 Chrome/130.0.6723.191 Electron/33.2.1 Safari/537.36',
    properties: { os: 'Windows', browser: 'Discord Client', device: '' },
  },
  linux: {
    label: 'Linux (PC/laptop)',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.310 Chrome/130.0.6723.191 Electron/33.2.1 Safari/537.36',
    properties: { os: 'Linux', browser: 'Discord Client', device: '' },
  },
  web: {
    label: 'Browser Chrome di macOS (web)',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36',
    properties: { os: 'Mac OS X', browser: 'Chrome', device: '' },
  },
};

/** Alias biar gampang: PC / mac / apple / laptop / hp / browser. */
const PLATFORM_ALIAS = {
  hp: 'android',
  phone: 'android',
  mobile: 'android',
  iphone: 'ios',
  android: 'android',
  ios: 'ios',
  mac: 'macos',
  macbook: 'macos',
  apple: 'macos',
  macos: 'macos',
  osx: 'macos',
  pc: 'windows',
  windows: 'windows',
  win: 'windows',
  laptop: 'windows',
  linux: 'linux',
  ubuntu: 'linux',
  web: 'web',
  browser: 'web',
  chrome: 'web',
};

/** Emoji custom status bisa berupa: "🔥" (unicode) atau "nama:123456789" (emoji custom). */
function parseEmoji(input) {
  const raw = String(input || '').trim();
  if (!raw) return { emojiName: '', emojiId: '' };
  if (/^\d{5,}$/.test(raw)) return { emojiName: '', emojiId: raw };
  const m = /^(.+?):(\d{5,})$/.exec(raw);
  if (m) return { emojiName: m[1], emojiId: m[2] };
  return { emojiName: raw, emojiId: '' };
}

const emojiCfg = parseEmoji(str(process.env.CUSTOM_STATUS_EMOJI));

/**
 * Mode penjaga status:
 *   keep    (default) = permanen, tapi kalau KAMU hapus -> tidak dipasang ulang
 *   enforce            = dipaksa selalu ada, dihapus -> dipasang ulang
 *   off                = script tidak menyentuh custom status
 * ENFORCE lama (CUSTOM_STATUS_ENFORCE) hanya dipakai kalau bernilai false -> off.
 */
const csModeRaw = str(process.env.CUSTOM_STATUS_MODE, '').trim().toLowerCase();
const legacyEnforce = process.env.CUSTOM_STATUS_ENFORCE === undefined
  ? null
  : bool(process.env.CUSTOM_STATUS_ENFORCE, true);
const csMode = ['keep', 'enforce', 'off'].includes(csModeRaw)
  ? csModeRaw
  : legacyEnforce === false ? 'off' : 'keep';

// DEVICE / PLATFORM: android | ios | macos | windows | linux | web (default: android)
const deviceRaw = str(process.env.DEVICE || process.env.PLATFORM, 'macos').trim().toLowerCase();
const platformKey = PLATFORM_ALIAS[deviceRaw] || 'macos';
const platform = PLATFORMS[platformKey];

const config = {
  rootDir: ROOT_DIR,
  dataDir: path.join(ROOT_DIR, 'data'),

  discordToken: str(process.env.DISCORD_TOKEN).trim(),
  apiVersion: num(process.env.API_VERSION, 9),
  status: str(process.env.STATUS, 'dnd').toLowerCase().trim() || 'dnd',

  // Platform yang "dipakai" akun (indikator PC/laptop vs HP di profil)
  platformKey,
  platform,
  deviceRequested: deviceRaw,

  userAgent: str(process.env.USER_AGENT, platform.userAgent),

  presenceRefreshSec: Math.max(5, num(process.env.PRESENCE_REFRESH_SEC, 15)),
  logLevel: str(process.env.LOG_LEVEL, 'info').toLowerCase(),
  debugDealer: bool(process.env.DEBUG_DEALER, false),

  spotify: {
    enabled: bool(process.env.ENABLE_SPOTIFY, true),
    accessToken: str(process.env.SPOTIFY_ACCESS_TOKEN).trim(),
    pollSec: Math.max(5, num(process.env.SPOTIFY_POLL_SEC, 5)),
    dealerPingSec: 15,
    dealerIdleTimeoutSec: 45,
    stopGraceSec: 3,
    staleAfterSec: Math.max(30, num(process.env.SPOTIFY_STALE_SEC, 90)),
    resolveRetrySec: 5,
  },

  /**
   * Roblox "Playing" presence.
   *  manual = aktivitas selalu tampil (tanpa kredensial)
   *  auto   = mengikuti game yang benar-benar dimainkan (butuh cookie + user id)
   */
  roblox: {
    enabled: bool(process.env.ROBLOX_ENABLED, false),
    mode: ['manual', 'auto'].includes(str(process.env.ROBLOX_MODE, 'manual').toLowerCase().trim())
      ? str(process.env.ROBLOX_MODE, 'manual').toLowerCase().trim()
      : 'manual',
    name: str(process.env.ROBLOX_NAME, 'ROBLOX').trim() || 'ROBLOX',
    game: str(process.env.ROBLOX_GAME).trim(),
    cookie: str(process.env.ROBLOX_COOKIE).trim(),
    userId: str(process.env.ROBLOX_USER_ID).trim(),
    pollSec: Math.max(15, num(process.env.ROBLOX_POLL_SEC, 30)),
    // Jendela "anti-kedip": aktivitas tetap tampil sekian menit setelah
    // terakhir terlihat main (0 = langsung hilang begitu keluar Roblox).
    stickyMin: Math.max(0, num(process.env.ROBLOX_STICKY_MIN, 0)),
    // ID aplikasi Roblox di Discord -> bikin logo Roblox yang asli muncul
    // (tanpa ini Discord menampilkan gambar rusak/kosong). Kosongkan untuk mematikan.
    appId: str(process.env.ROBLOX_APP_ID, '363445589247131668').trim(),
    // Timer "Playing for ..." tidak direset kalau jeda main masih di bawah ini
    // (menit). 0 = reset tiap berhenti sejenak.
    timerGraceMin: Math.max(0, num(process.env.ROBLOX_TIMER_GRACE_MIN, 10)),
    // true  = nama game tampil di baris kedua ("details") -> muncul tanda Rich Presence kecil
    // false = hanya "Playing ROBLOX" + timer -> tampilannya persis seperti deteksi Roblox asli
    showGame: bool(process.env.ROBLOX_SHOW_GAME, true),
    userAgent: str(process.env.ROBLOX_UA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
  },

  /**
   * "Pura-pura main PS5" (atau konsol lain).
   * Aktivitas yang dikirim punya field `platform` (ps5/ps4/xbox/...), jadi
   * profil Discord menampilkannya seperti orang yang main di konsol.
   */
  dash: {
    // Dashboard PS5 (nempel di proses ini — tanpa proses tambahan).
    enabled: bool(process.env.DASH_ENABLED, true),
    port: num(process.env.DASH_PORT, 23304),
    // Port tambahan (opsional), dipisah koma. Berguna kalau hosting/proxy
    // meneruskan subdomain ke port tertentu (mis. 80, 3000, 8080).
    // Contoh: DASH_PORT_EXTRA=80,3000,8080
    portExtra: str(process.env.DASH_PORT_EXTRA, '')
      .split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0 && x < 65536 && x !== num(process.env.DASH_PORT, 23304)),
    host: str(process.env.DASH_HOST, '0.0.0.0'),
    key: str(process.env.DASH_KEY).trim(), // kosong = tanpa kunci (tidak disarankan)
  },

  /**
   * Scout Orb — rotasi negara lewat Tor untuk memantau quest baru.
   * Tor diunduh sekali ke ./bin/tor (seperti cloudflared), jalan sebagai
   * proses anak mode klien. DIMA matikan: SCOUT_ENABLED=false.
   */
  scout: {
    // Disabled by default after the account-token/logout audit; enable only deliberately.
    enabled: bool(process.env.SCOUT_ENABLED, false),
    /** Jeda dasar (menit); mode token utama menambahkan cooldown minimum 5 menit di Scout. */
    intervalMin: Math.max(0, num(process.env.SCOUT_INTERVAL_MIN, 0)),
    /** jeda kecil antar putaran kalau semuanya kosong (detik; 0 = langsung) */
    jedaPutaranDetik: Math.max(0, num(process.env.SCOUT_JEDA_PUTARAN, 0)),
    /** jeda saat quest dari ID sedang dikerjakan bot (detik) */
    jedaSaatIdDetik: Math.max(5, num(process.env.SCOUT_JEDA_SAAT_ID, 30)),
    mulaiDetik: Math.max(5, num(process.env.SCOUT_MULAI_DETIK, 35)),
    /** kerja otomatis: quest dari negara lain langsung dikerjakan (default ON) */
    autoKerja: String(process.env.SCOUT_AUTO_KERJA || 'true').toLowerCase() !== 'false',
    /** maksimal negara per putaran kalau semuanya kosong (kosong = langsung pindah) */
    burstMaks: Math.max(1, num(process.env.SCOUT_BURST_MAKS, 10)),
  },

  /** Penjalan quest: boleh jalan sendiri begitu bot menyala? */
  quest: {
    autoStart: bool(process.env.QUEST_AUTO_START, false),
    // 30 dtk (dulu 20) — cukup sering untuk progres, tapi jauh lebih hemat kuota API
    beatSec: Number(process.env.QUEST_BEAT_SEC || 30) || 30,
    /** otomatis tanpa tombol: cek & kerjakan sendiri tiap X menit (default ON) */
    otomatis: bool(process.env.QUEST_OTOMATIS, true),
    /** tiap berapa menit diperiksa sendiri (1 menit = terasa instan, tetap sopan ke API) */
    otomatisMenit: Math.max(1, num(process.env.QUEST_OTOMATIS_MENIT, 1)),
    /**
     * Token Discord KHUSUS quest (opsional, diatur dari dashboard).
     * Kosong = pakai DISCORD_TOKEN yang sama seperti bot (default).
     * Token ini TIDAK dipakai untuk presence/status, PS5, Roblox, atau Spotify.
     */
    token: str(process.env.QUEST_TOKEN, '').trim(),
  },

  /**
   * Tunnel keluar (Cloudflare Quick Tunnel) supaya dashboard bisa dibuka dari
   * internet walau server tidak punya alamat/port publik.
   * URL-nya dilaporkan ke satu halaman tetap (mis. di Vercel) -> cukup
   * bookmark satu alamat.
   */
  tunnel: {
    enabled: bool(process.env.TUNNEL_ENABLED, true),
    dir: str(process.env.TUNNEL_DIR, '').trim(), // kosong = ./bin
    laporUrl: str(process.env.TUNNEL_LAPOR_URL, '').trim(),
    laporSecret: str(process.env.TUNNEL_LAPOR_SECRET, '').trim(),
  },

  ps5: {
    enabled: bool(process.env.PS5_ENABLED, false),
    game: str(process.env.PS5_GAME, 'Fortnite').trim() || 'Fortnite',
    appId: str(process.env.PS5_APP_ID).trim(), // kosong = cari otomatis dari daftar game
    details: str(process.env.PS5_DETAILS).trim(), // baris kedua (opsional)
    platform: str(process.env.PS5_PLATFORM, 'ps5').trim() || 'ps5',
    timer: bool(process.env.PS5_TIMER, true), // tampilkan timer "Playing for ..."
    // true = pakai nama resmi versi Discord (mis. "Marvel's Spider-Man Remastered")
    officialName: bool(process.env.PS5_OFFICIAL_NAME, true),
  },

  customStatus: {
    enabled: bool(process.env.CUSTOM_STATUS_ENABLED, true),
    mode: csMode,
    text: str(process.env.CUSTOM_STATUS_TEXT).trim(),
    emojiName: emojiCfg.emojiName,
    emojiId: emojiCfg.emojiId,
    enforce: csMode === 'enforce',
    neverExpire: bool(process.env.CUSTOM_STATUS_NEVER_EXPIRE, true),
    refreshMin: Math.max(1, num(process.env.CUSTOM_STATUS_REFRESH_MIN, 10)),
    presence: bool(process.env.PRESENCE_CUSTOM_STATUS, true),
    persistStatus: bool(process.env.PERSIST_STATUS, true),
  },
};

/** true bila user memasang status "dipatok" lewat config (bukan mode kunci otomatis). */
config.customStatus.pinned = Boolean(config.customStatus.text || config.customStatus.emojiName || config.customStatus.emojiId);

const VALID_STATUS = ['online', 'idle', 'dnd', 'invisible'];
function validateConfig(logger) {
  const problems = [];
  if (!config.discordToken || /TARUH_TOKEN|TOKEN_KAMU/i.test(config.discordToken)) {
    problems.push('DISCORD_TOKEN belum diisi (isi di file .env atau environment variable).');
  }
  if (!PLATFORM_ALIAS[config.deviceRequested]) {
    logger?.warn(
      `DEVICE="${config.deviceRequested}" tidak dikenal → memakai "${config.platformKey}". ` +
        `Pilihan: ${Object.keys(PLATFORM_ALIAS).join(', ')}.`,
    );
  }
  if (legacyEnforce === true && !['keep', 'enforce', 'off'].includes(csModeRaw)) {
    logger?.warn(
      'CUSTOM_STATUS_ENFORCE=true sudah tidak dipakai lagi — statusmu sekarang TIDAK akan ' +
        'dipasang ulang kalau kamu hapus (mode keep). Mau dipaksa selalu ada? Set CUSTOM_STATUS_MODE=enforce.',
    );
  }
  if (!VALID_STATUS.includes(config.status)) {
    problems.push(`STATUS "${config.status}" tidak dikenal. Pakai salah satu: ${VALID_STATUS.join(', ')}.`);
  }
  if (config.roblox.enabled && config.roblox.mode === 'auto') {
    if (!config.roblox.userId) {
      logger?.warn('ROBLOX_MODE=auto butuh ROBLOX_USER_ID. Sementara aktivitas Roblox dilewati.');
    }
    if (!config.roblox.cookie) {
      logger?.debug('ROBLOX_MODE=auto tanpa cookie — presence & nama game tetap dibaca dari API publik.');
    }
    if (config.roblox.userId && !/^[0-9]+$/.test(config.roblox.userId)) {
      problems.push('ROBLOX_USER_ID harus angka (lihat di URL profil Roblox: roblox.com/users/<angka>/profile).');
    }
  }
  if (config.status === 'invisible') {
    logger?.warn('STATUS=invisible → walau script jalan, akun akan tampil offline (status tetap tersimpan permanen).');
  }
  return problems;
}

module.exports = { config, loadDotEnv, parseEmoji, validateConfig, PLATFORMS };
