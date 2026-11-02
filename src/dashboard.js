'use strict';

/**
 * ============================================================================
 *  Dashboard PS5 — panel kecil buat on/off mode "pura-pura main PS5"
 * ============================================================================
 *  Kenapa hemat:
 *    - Nempel di proses yang SUDAH jalan (index.js). Tidak ada proses baru,
 *      tidak ada port baru, tidak ada dependency baru -> nol RAM tambahan.
 *    - Halaman HTML-nya dikirim sekali lalu di-cache browser; sesudah itu
 *      yang lewat cuma JSON kecil (~1 KB) tiap 5 detik saat tab dibuka.
 *    - Tidak ada framework, tidak ada CDN, tidak ada database.
 *
 *  Alamat: http://<host-panel>:<DASH_PORT>/?k=<DASH_KEY>
 *  (kunci disimpan sebagai cookie, jadi buka sekali saja lalu bookmark "/").
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

/** Hash ikon resmi tiap game (diambil dari API Discord, disimpan lokal). */
const ICONS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'icons.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const iconUrl = (id, size = 64) =>
  id && ICONS[id] ? `https://cdn.discordapp.com/app-icons/${id}/${ICONS[id]}.png?size=${size}` : '';

/** Tahun rilis tiap game (untuk filter tahun di dashboard). */
const YEARS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'years.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const gameYearOf = (id) => (id && YEARS[id]) || 0;

/** 0 = belum rilis di PS5 (ditampilkan redup di dashboard). */
const RELEASED = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'released.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const releasedOf = (id) => (id && RELEASED[id] === 0 ? 0 : 1);

/* ------------------------------- .env ---------------------------------- */

/** Simpan beberapa baris ke .env (baris lain tidak disentuh). */
function saveEnv(pairs, file = ENV_FILE) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(file, out.endsWith('\n') ? out : out + '\n', 'utf8');
}

/** Buang satu baris KEY=... dari .env (dipakai tombol buang token quest). */
function hapusEnv(key, file = ENV_FILE) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return false;
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const sisa = lines.filter((l) => !re.test(l));
  if (sisa.length === lines.length) return false;
  fs.writeFileSync(file, sisa.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return true;
}

/** Tidak mengembalikan fragmen token: cukup tampilkan bahwa kredensial tersimpan. */
function topengToken(t) {
  return String(t || '').trim() ? 'tersimpan (dirahasiakan)' : '';
}

/* -------------------------------- util --------------------------------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        // boleh juga kirim sebagai form-urlencoded sederhana
        const obj = {};
        for (const kv of raw.split('&')) {
          const [k, v] = kv.split('=');
          if (k) obj[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
        resolve(obj);
      }
    });
    req.on('error', reject);
  });
}

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

/* ================================ SERVER ================================ */

/**
 * @param {{cfg:any, log:any, ps5:any, roblox:any, spotify?:any, gateway:any, version?:string,
 *          onUser?:() => ({tag?:string, id?:string}), saveEnvFn?:Function}} opts
 */
function createDashboard({ cfg, log, ps5, roblox, spotify = null, gateway, quest = null, scout = null, tunnel = null, version = '2.1.0', onUser, bot = null, envFile = ENV_FILE }) {
  const state = { startedAt: Date.now(), lastAction: null, lastActionAt: null };
  const save = (pairs) => saveEnv(pairs, envFile);

  /* ------------------------------ aksi -------------------------------- */

  function push() {
    try {
      gateway.requestPresencePush();
    } catch {
      /* ignore */
    }
  }

  function status() {
    const game = {
      written: ps5.cfg.game || '',
      name: ps5.name,
      id: ps5.appId || null,
      year: gameYearOf(ps5.appId),
      released: releasedOf(ps5.appId),
      icon: iconUrl(ps5.appId, 128),
      official: Boolean(ps5.matchedGame),
      belumRilis: releasedOf(ps5.appId) === 0,
    };
    const user = onUser ? onUser() || {} : {};
    const robloxActive = roblox && typeof roblox.visible === 'boolean'
      ? roblox.visible
      : Boolean(roblox && roblox.active);
    const robloxHealth = roblox && typeof roblox.status === 'function' ? roblox.status() : null;
    const spotifyHealth = spotify && typeof spotify.status === 'function' ? spotify.status() : null;
    return {
      on: Boolean(ps5.cfg.enabled),
      game,
      platform: ps5.platform,
      timer: ps5.timer,
      startedAt: ps5.startedAt,
      playingFor: Math.max(0, Math.floor((Date.now() - ps5.startedAt) / 1000)),
      presenceStatus: gateway && gateway.presenceStatus ? gateway.presenceStatus : null,
      presenceStatusSource: gateway && gateway.presenceStatusSource ? gateway.presenceStatusSource : null,
      lastStatusSyncAt: gateway && gateway.lastStatusSyncAt ? gateway.lastStatusSyncAt : 0,
      presenceDiagnostics: gateway ? {
        sentAt: gateway.lastPresenceSentAt || 0,
        sentActivities: Array.isArray(gateway.lastPresenceSentSummary) ? gateway.lastPresenceSentSummary : [],
        selfSession: gateway.lastOwnSessionPresence || null,
        aggregateSession: gateway.lastAggregatePresence || null,
      } : null,
      roblox: {
        enabled: Boolean(roblox && roblox.enabled),
        active: Boolean(robloxActive),
        name: (roblox && roblox.name) || '',
        game: (roblox && roblox.game) || '',
        health: robloxHealth,
        // saat mode PS5 nyala, pemantauan Roblox memang dijeda (hemat kuota)
        paused: Boolean(roblox && (roblox.stopped || ps5.cfg.enabled)),
      },
      spotify: spotifyHealth,
      user,
      quest: quest
        ? {
        otomatis: quest.otomatis !== false,
        otomatisMenit: quest.otomatisMenit || 1,
        cekTerakhir: quest._cekTerakhir || null,
        jeda: typeof quest.sisaJeda === 'function' ? quest.sisaJeda() : 0,
        jedaSampai: quest.limitSampai || 0,
        kena401: Boolean(quest.kena401),
        jalan: Boolean(quest.aktif),
        paralel: true,
        rute: quest.asalNegara || null, // mis. "scout:jp" kalau dikerjakan lewat negara lain
        aktif: (quest.aktifList || []).map((x) => ({
          qid: x.qid, nama: x.nama, jenis: x.jenis, video: Boolean(x.video),
          value: x.value || 0, target: x.target || 900, hadiah: x.hadiah || '',
        })),
        nama: quest.sedang ? quest.sedang.nama : '',
        qid: quest.sedang ? quest.sedang.qid : '',
        jenis: quest.sedang ? quest.sedang.jenis : '',
        video: quest.sedang ? Boolean(quest.sedang.video) : false,
        value: quest.sedang ? quest.sedang.value : 0,
        target: quest.sedang ? quest.sedang.target : 900,
        hadiah: quest.sedang ? quest.sedang.hadiah : '',
        mode: quest.mode,
        antrian: quest.antrian,
        selesai: quest.selesai,
        dilewati: quest.dilewati,
        gagal: quest.gagal,
        ditunda: quest.ditunda || [],
        mulai: quest.mulaiJam,
      } : null,
      tokenBot: bot && typeof bot.hidup === 'function' ? { hidup: Boolean(bot.hidup()) } : null,
      version,
      dash: { port: cfg.port, ports: [...portTerikat] },
      tunnel: tunnel ? tunnel.info || null : null,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
    };
  }

  function turnOn(gameName) {
    const game = String(gameName || '').trim();
    if (!game) {
      const err = new Error('Pilih game dulu sebelum ON.');
      err.status = 400;
      throw err;
    }
    // Validasi DULU sebelum state diubah (biar tidak ada sisa game yang ditolak).
    const { findGameInfo } = require('./ps5');
    const cek = findGameInfo(game, ps5.cfg.appId);
    if (cek && cek.released === 0) {
      const err = new Error(`"${cek.name}" belum rilis di PS5 — pilih game lain dulu ya.`);
      err.status = 400;
      throw err;
    }
    const res = ps5.applyGame(game);
    ps5.setEnabled(true);
    if (roblox) roblox.stop(); // hemat: berhenti ngecek Roblox selama mode PS5 nyala
    save({ PS5_ENABLED: 'true', PS5_GAME: res.matched ? res.name : game });
    state.lastAction = `ON — ${res.name}`;
    state.lastActionAt = Date.now();
    log.info(`Dashboard: PS5 ON — "${res.name}"${res.matched ? ' (ikon resmi)' : ' (tanpa ikon)'}`);
    push();
    return res;
  }

  async function turnOff() {
    ps5.setEnabled(false);
    save({ PS5_ENABLED: 'false' });
    if (roblox) await roblox.resume().catch(() => {});
    state.lastAction = 'OFF — kembali memantau Roblox';
    state.lastActionAt = Date.now();
    log.info('Dashboard: PS5 OFF — kembali ke mode Roblox.');
    push();
  }

  function switchGame(gameName) {
    const game = String(gameName || '').trim();
    if (!game) {
      const err = new Error('Nama game kosong.');
      err.status = 400;
      throw err;
    }
    const { findGameInfo } = require('./ps5');
    const cek = findGameInfo(game, ps5.cfg.appId);
    if (cek && cek.released === 0) {
      const err = new Error(`"${cek.name}" belum rilis di PS5 — pilih game lain dulu ya.`);
      err.status = 400;
      throw err;
    }
    const res = ps5.applyGame(game);
    save({ PS5_GAME: res.matched ? res.name : game });
    state.lastAction = `ganti game — ${res.name}`;
    state.lastActionAt = Date.now();
    push();
    return res;
  }

  /* ------------------------------ routing ----------------------------- */

  function isAuthed(req, url) {
    if (!cfg.key) return true;
    const cookie = parseCookies(req.headers.cookie);
    const given = cookie.ps5dash || req.headers['x-dash-key'] || url.searchParams.get('k') || '';
    return given === cfg.key;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // kunci benar lewat ?k=... -> simpan cookie lalu pindah ke "/"
    if ((p === '/' || p === '/index.html') && cfg.key && url.searchParams.get('k') === cfg.key) {
      res.writeHead(302, {
        'Set-Cookie': `ps5dash=${cfg.key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
        Location: '/',
      });
      return res.end();
    }

    if (p === '/healthz') return json(res, 200, { ok: true, on: Boolean(ps5.cfg.enabled) });

    if (!isAuthed(req, url)) {
      if (p === '/') {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage());
      }
      return json(res, 401, { ok: false, error: 'Kunci dashboard salah. Buka /?k=KUNCI' });
    }

    if (p === '/' || p === '/index.html') {
      const body = pageHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }

    if (p === '/api/status' && req.method === 'GET') return json(res, 200, status());

    // Baca-saja: keadaan profil Discord (untuk memastikan Nitro & hiasan kembali setelah pulih).
    // Hanya memakai GET /users/@me — panggilan yang sama yang bot lakukan saat start (aman).
    if (p === '/api/profil' && req.method === 'GET') {
      const { request } = require('./http');
      const HARAP = {
        avatar_animasi: true,
        banner: '6f154561a8d2c2f6e1acd53a6f7c3713',
        font: 3,
        efek: 8,
        dekorasi: '1458472704222171347',
        nameplate: '1409898407945834558',
      };
      const r = await request('GET', 'https://discord.com/api/v9/users/@me', {
        headers: { Authorization: require('./config').config.discordToken, 'User-Agent': 'Mozilla/5.0' },
      });
      if (!r.ok || !r.json) {
        return json(res, 200, { ok: false, http: r.status, error: r.error || (r.json && r.json.message) || 'gagal baca' });
      }
      const d = r.json;
      const av = String(d.avatar || '');
      const sk = d.display_name_styles || {};
      const deko = (d.avatar_decoration_data || {}).sku_id || null;
      const nameplate = ((d.collectibles || {}).nameplate || {}).sku_id || null;
      const cek = {
        avatar_animasi: av.startsWith('a_') === HARAP.avatar_animasi,
        banner: d.banner === HARAP.banner,
        gaya_nama: sk.font_id === HARAP.font && sk.effect_id === HARAP.efek,
        dekorasi: deko === HARAP.dekorasi,
        nameplate: nameplate === HARAP.nameplate,
      };
      return json(res, 200, {
        ok: true,
        diambil: new Date().toISOString(),
        nitro: d.premium_type != null ? d.premium_type : null,
        premium_type: d.premium_type || 0,
        tag: `${d.username}${d.discriminator && d.discriminator !== '0' ? '#' + d.discriminator : ''}`,
        nama: d.global_name || null,
        avatar: av || null,
        avatar_animasi: av.startsWith('a_'),
        banner: d.banner || null,
        tema: null, // tema warna hanya ada di /profile, sengaja tidak dipanggil di sini
        display_name_styles: sk && Object.keys(sk).length ? sk : null,
        dekorasi: deko,
        nameplate,
        badge_flags: d.public_flags || 0,
        cocok: cek,
        semua_cocok: Object.values(cek).every(Boolean),
      });
    }

    if (p === '/api/games' && req.method === 'GET') {
      const { GAMES } = require('./ps5');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const tahun = Number(url.searchParams.get('tahun') || 0);
      const semua = url.searchParams.get('semua') === '1';
      const batas = Math.min(600, Math.max(1, Number(url.searchParams.get('limit') || 60)));

      // ringkasan per tahun (tombol filter)
      const perTahun = {};
      for (const g of GAMES) if (g.year) perTahun[g.year] = (perTahun[g.year] || 0) + 1;

      let daftar = GAMES;
      if (tahun) daftar = daftar.filter((g) => g.year === tahun);
      if (q) daftar = daftar.filter((g) => (g.name + ' ' + (g.alias || []).join(' ')).toLowerCase().includes(q));
      const total = daftar.length;
      if (!semua) daftar = daftar.slice(0, batas);

      const games = daftar.map((g) => ({
        n: g.name,                       // nama resmi
        i: g.id,                         // id aplikasi (ikon)
        u: iconUrl(g.id, 64),
        y: g.year || 0,                  // tahun rilis
        r: g.released === 0 ? 0 : 1,     // 0 = belum rilis di PS5 (redup)
        a: (g.alias || []).join(' '),    // alias, buat pencarian di sisi klien juga
      }));
      const belum = games.filter((g) => !g.r).length;
      return json(res, 200, {
        count: games.length,
        total: GAMES.length,
        cocok: total,
        belumRilis: GAMES.filter((g) => g.released === 0).length,
        tahunIniBelum: belum,
        years: perTahun,
        games,
      });
    }

    if (p === '/api/resolve' && req.method === 'GET') {
      const q = url.searchParams.get('game') || '';
      const { findGameInfo } = require('./ps5');
      const info = findGameInfo(q, ps5.cfg.appId);
      if (!info) return json(res, 200, { found: false, name: q.trim(), icon: '' });
      return json(res, 200, { found: true, name: info.name, id: info.id, year: info.year || 0, icon: iconUrl(info.id, 128) });
    }

    if (p === '/api/on' && req.method === 'POST') {
      const body = await readBody(req);
      const res2 = turnOn(body.game);
      return json(res, 200, { ok: true, ...status(), applied: res2 });
    }

    if (p === '/api/off' && req.method === 'POST') {
      await readBody(req).catch(() => {});
      await turnOff();
      return json(res, 200, { ok: true, ...status() });
    }

    // ------- Token khusus quest (hanya untuk quest; PS5/dll tidak tersentuh) -------
    if (p === '/api/quest/token' && req.method === 'GET') {
      const envToken = String(process.env.QUEST_TOKEN || '').trim();
      const dipakai = quest ? quest.token : envToken;
      const tokenBotSaatIni = String(process.env.DISCORD_TOKEN || require('./config').config.discordToken || '').trim();
      const samaDenganBot = Boolean(dipakai) && dipakai === tokenBotSaatIni;
      return json(res, 200, {
        ok: true,
        punya: Boolean(envToken),
        sumber: envToken ? 'sendiri' : 'bot',
        samaDenganBot,
        kunci: topengToken(dipakai),
      });
    }

    if (p === '/api/quest/token' && req.method === 'POST') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      const b = await readBody(req).catch(() => ({}));
      const tk = String((b && b.token) || '').trim();
      if (!tk) return json(res, 400, { ok: false, error: 'Token kosong.' });
      if (!/^[\w-]{15,40}\.[\w-]{3,15}\.[\w-]{15,120}$/.test(tk)) {
        return json(res, 400, { ok: false, error: 'Bentuk token tidak seperti token Discord.' });
      }
      // uji token dulu ke Discord (GET /users/@me) — kalau 401, jangan disimpan
      const { request } = require('./http');
      const uji = await request('GET', 'https://discord.com/api/v9/users/@me', {
        headers: { Authorization: tk, 'User-Agent': 'Mozilla/5.0' },
        timeoutMs: 20000,
      });
      if (!uji.ok || !uji.json) {
        return json(res, 400, {
          ok: false,
          error: `Token ditolak Discord (HTTP ${uji.status || 0}). Pastikan menyalin token yang benar.`,
        });
      }
      save({ QUEST_TOKEN: tk });
      process.env.QUEST_TOKEN = tk; // supaya kartu langsung menampilkan yang benar
      quest.setToken(tk);
      // Scout memiliki header sendiri; selalu selaraskan agar QUEST_TOKEN yang
      // baru ditempel tidak membuat Scout tetap memakai token utama lewat Tor.
      if (scout && typeof scout.setToken === 'function') scout.setToken(tk, { tokenKhusus: true });
      const who = uji.json.username || '';
      log.info(`Token quest diganti dari dashboard -> akun ${who} (hanya untuk quest).`);
      return json(res, 200, { ok: true, akun: who, kunci: topengToken(tk), sumber: 'sendiri' });
    }

    if (p === '/api/quest/token' && req.method === 'DELETE') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      const sisa = hapusEnv('QUEST_TOKEN', envFile);
      delete process.env.QUEST_TOKEN;
      const tokenUtama = String(process.env.DISCORD_TOKEN || require('./config').config.discordToken || '').trim();
      // Kembali ke token utama bukan opt-in Scout: hentikan Scout sampai pemilik
      // menyalakannya kembali secara sadar (dan mendapat izin yang diperlukan).
      if (scout && typeof scout.setAktif === 'function') scout.setAktif(false);
      quest.setToken(tokenUtama);
      if (scout && typeof scout.setToken === 'function') scout.setToken(tokenUtama, { tokenKhusus: false });
      log.info('Token quest dikembalikan ke token bot (.env) — Scout tetap OFF.');
      return json(res, 200, { ok: true, sumber: 'bot', dibuang: Boolean(sisa), kunci: topengToken(quest.token) });
    }

    // Scout Orb: keadaan rotasi negara (baca-saja).
    if (p === '/api/scout' && req.method === 'GET') {
      if (!scout) return json(res, 200, { ok: false, error: 'Scout tidak aktif di proses ini.' });
      return json(res, 200, { ok: true, ...scout.status() });
    }

    // Token BOT (DISCORD_TOKEN) — dipakai presence/status/Spotify.
    // Kalau token bot ditolak Discord, bot jalan dalam mode darurat (quest tetap
    // jalan) dan token baru bisa ditempel di sini tanpa perlu buka panel.
    if (p === '/api/bot/token' && req.method === 'GET') {
      const dipakai = String(process.env.DISCORD_TOKEN || '').trim();
      return json(res, 200, {
        ok: true,
        hidup: bot && typeof bot.hidup === 'function' ? Boolean(bot.hidup()) : true,
        kunci: topengToken(dipakai),
      });
    }

    if (p === '/api/bot/token' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const tk = String((b && b.token) || '').trim();
      if (!tk) return json(res, 400, { ok: false, error: 'Token kosong.' });
      if (!/^[\w-]{15,40}\.[\w-]{3,15}\.[\w-]{15,120}$/.test(tk)) {
        return json(res, 400, { ok: false, error: 'Bentuk token tidak seperti token Discord.' });
      }
      const { request } = require('./http');
      const uji = await request('GET', `https://discord.com/api/${cfg.apiVersion || 'v9'}/users/@me`, {
        headers: { Authorization: tk, 'User-Agent': cfg.userAgent || 'Mozilla/5.0' },
        timeoutMs: 20000,
      });
      if (!uji.ok || !uji.json) {
        return json(res, 400, {
          ok: false,
          error: `Token ditolak Discord (HTTP ${uji.status || 0}). Salin ulang token bot yang benar.`,
        });
      }
      save({ DISCORD_TOKEN: tk });
      process.env.DISCORD_TOKEN = tk;
      try {
        if (bot && typeof bot.tokenBaru === 'function') bot.tokenBaru(tk);
      } catch (e) {
        log.warn('Token bot: gagal menerapkan token baru — ' + e.message);
      }
      const who = uji.json.username || '';
      log.info(`Token BOT diganti dari dashboard -> akun ${who}. Bot menyambung ulang.`);
      return json(res, 200, { ok: true, akun: who, kunci: topengToken(tk) });
    }

    // Periksa & kerjakan sekarang (opsional — normalnya otomatis sendiri).
    if (p === '/api/quest/cek-sekarang' && req.method === 'POST') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      if (typeof quest.cekSekarang !== 'function') return json(res, 400, { ok: false, error: 'Versi bot ini belum punya fitur otomatis.' });
      const r = await quest.cekSekarang('manual');
      return json(res, 200, { ok: r.ok !== false, ...r });
    }

    // Nyalakan / matikan Scout Orb.
    if (p === '/api/scout/toggle' && req.method === 'POST') {
      if (!scout) return json(res, 200, { ok: false, error: 'Scout tidak aktif di proses ini.' });
      const b = await readBody(req).catch(() => ({}));
      const r = scout.setAktif(b && b.on);
      log.info('Scout: diubah dari dashboard -> ' + (r.aktif ? 'ON' : 'OFF'));
      return json(res, 200, { ok: true, ...r });
    }

    if (p === '/api/quests' && req.method === 'GET') {
      if (!quest) return json(res, 200, { ok: false, error: 'Penjalan quest tidak aktif.', quests: [] });
      const d = await quest.daftar();
      return json(res, d.ok ? 200 : 502, d);
    }

    // Diagnostik region: dari negara mana server ini mengakses Discord + (opsi ?quest=1) quest yang TERLIHAT dari server.
    // Dipakai untuk menguji apakah daftar quest berbeda per negara IP. Baca-saja, tidak mengubah apa pun.
    if (p === '/api/geo' && req.method === 'GET') {
      const { request } = require('./http');
      const g = await request('GET', 'http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeoutMs: 15000,
      });
      const out = {
        ok: true,
        waktu: new Date().toISOString(),
        keluar: g.json && g.json.country ? g.json : { error: g.error || `HTTP ${g.status}` },
      };
      if (url.searchParams.get('quest') === '1' && quest && typeof quest.daftar === 'function') {
        const d = await quest.daftar();
        out.quest = d.ok
          ? {
              total: d.quests.length,
              layak: d.quests.filter((x) => !x.selesai && !x.kedaluwarsa && !x.belumMulai).length,
              diikutiBelumSelesai: d.quests.filter((x) => x.diikuti && !x.selesai).length,
              selesai: d.quests.filter((x) => x.selesai).length,
              diklaim: d.quests.filter((x) => x.diklaim).length,
              daftar: d.quests.map((x) => ({
                id: x.id, nama: x.nama, jenis: x.jenis, video: x.video,
                selesai: x.selesai, diklaim: x.diklaim, diikuti: x.diikuti,
                kedaluwarsa: x.kedaluwarsa, belumMulai: x.belumMulai, hadiah: x.hadiah,
              })),
            }
          : { error: d.error || 'gagal ambil quest' };
      }
      return json(res, 200, out);
    }

    if (p === '/api/quest/start' && req.method === 'POST') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      const body = await readBody(req);
      const hasil = await quest.mulai(body.qid);
      return json(res, hasil.ok ? 200 : 400, { ...hasil, ...status() });
    }

    if (p === '/api/quest/auto' && req.method === 'POST') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      const body = await readBody(req);
      if (body.on === false) {
        const hasil = quest.batal();
        return json(res, hasil.ok ? 200 : 400, { ...hasil, ...status() });
      }
      const hasil = await quest.autoMulai();
      return json(res, hasil.ok ? 200 : 400, { ...hasil, ...status() });
    }

    // Uji celah: coba KLAIM quest langsung dari API (tanpa browser). Tanpa captcha solver.
    if (p === '/api/quest/claim-coba' && req.method === 'POST') {
      if (!quest || typeof quest.cobaKlaim !== 'function') return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      const body = await readBody(req).catch(() => ({}));
      const paksa = Boolean(body && body.paksa);
      const hasil = await quest.cobaKlaim({ paksa });
      const ringkas = {
        dicoba: hasil.dicoba,
        terklaim: hasil.terklaim.map((x) => x.nama),
        perluCaptcha: hasil.perluCaptcha.map((x) => x.nama),
        gagal: hasil.gagal.map((x) => `${x.nama || '-'} (HTTP ${x.http || '?'} ${x.pesan || ''})`),
      };
      const info = hasil.dicoba === 0
        ? 'Tidak ada quest selesai yang belum diklaim.'
        : `${hasil.dicoba} dicoba · ${hasil.terklaim.length} terklaim · ${hasil.perluCaptcha.length} wajib captcha (klaim manual di app)`;
      return json(res, 200, { ok: true, info, ...ringkas, ...status() });
    }

    if (p === '/api/quest/stop' && req.method === 'POST') {
      if (!quest) return json(res, 400, { ok: false, error: 'Penjalan quest tidak aktif.' });
      await readBody(req).catch(() => {});
      const hasil = await quest.batal();
      return json(res, hasil.ok ? 200 : 400, { ...hasil, ...status() });
    }

    if (p === '/api/platform' && req.method === 'POST') {
      const body = await readBody(req);
      const { PLATFORMS } = require('./ps5');
      const minta = String(body.platform || '').trim().toLowerCase();
      if (!PLATFORMS.includes(minta)) {
        const err = new Error('Platform tidak dikenal. Pilihan: ' + PLATFORMS.join(', '));
        err.status = 400;
        throw err;
      }
      ps5.setPlatform(minta);
      save({ PS5_PLATFORM: minta });
      state.lastAction = `platform -> ${minta}`;
      state.lastActionAt = Date.now();
      push();
      return json(res, 200, { ok: true, ...status() });
    }

    if (p === '/api/game' && req.method === 'POST') {
      const body = await readBody(req);
      const res2 = switchGame(body.game);
      return json(res, 200, { ok: true, ...status(), applied: res2 });
    }

    return json(res, 404, { ok: false, error: 'Tidak ada.' });
  }

  /** Satu handler, bisa dipasang di beberapa listener (port utama + tambahan). */
  const buatServer = () => {
    const s = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        const code = err.status || 500;
        if (code >= 500) log.warn('Dashboard:', err.message);
        json(res, code, { ok: false, error: err.message });
      });
    });
    s.on('clientError', (err, socket) => socket.destroy());
    s.keepAliveTimeout = 5000;
    return s;
  };

  const server = buatServer();
  const serverTambahan = [];
  /* port yang benar-benar terikat (dipakai /api/status + tes) */
  const portTerikat = new Set();

  return {
    start() {
      if (!cfg.enabled) {
        log.info('Dashboard: OFF (DASH_ENABLED=false).');
        return;
      }
      const hostTampil = cfg.host === '0.0.0.0' ? 'alamat-panel-kamu' : cfg.host;
      const hint = cfg.key ? `/?k=${cfg.key}` : '/';
      const pasang = (srv, port, utama) => {
        srv.on('error', (err) => {
          const sebab = err.code === 'EACCES' ? 'tidak punya izin (port < 1024 butuh root)' : err.code || err.message;
          log.warn(`Dashboard: port ${port} gagal (${sebab}).` + (utama ? ' Mode PS5 tetap jalan.' : ''));
        });
        srv.listen(port, cfg.host, () => {
          const p = srv.address().port;
          portTerikat.add(p);
          if (utama) log.info(`Dashboard PS5: http://${hostTampil}:${p}${hint}`);
          else log.info(`Dashboard PS5: juga mendengarkan port ${p} (port tambahan).`);
        });
      };
      pasang(server, cfg.port, true);
      for (const p of cfg.portExtra || []) {
        const extra = buatServer();
        serverTambahan.push(extra);
        pasang(extra, p, false);
      }
      return server;
    },
    stop() {
      for (const s of [server, ...serverTambahan]) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    },
    status,
    turnOn,
    turnOff,
    switchGame,
    iconUrl,
  };
}

/* ================================ TAMPILAN =============================== */

function loginPage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PS5 Mode</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8eeff;
font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
.b{background:#141b33;padding:28px 24px;border-radius:18px;text-align:center;max-width:320px}
h1{font-size:19px;margin:0 0 8px}p{color:#93a3c7;font-size:13px;margin:0 0 16px}
input{width:100%;padding:12px;border-radius:12px;border:1px solid #2b3557;background:#0e1428;color:#e8eeff;font-size:15px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;background:#2f6bff;color:#fff;font-size:15px;font-weight:600}
</style></head><body><div class="b"><h1>🔒 Dashboard PS5</h1>
<p>Butuh kunci dari <code>.env</code> (DASH_KEY).<br>Buka <code>/?k=KUNCI</code> sekali saja.</p>
<form onsubmit="location.href='/?k='+encodeURIComponent(document.querySelector('input').value);return false">
<input placeholder="tempel kunci di sini" autofocus><button>Buka</button></form></div></body></html>`;
}

function pageHtml() {
  return `<!doctype html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1020">
<title>PS5 Mode</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:14px 14px calc(22px + env(safe-area-inset-bottom));background:#0b1020;color:#e8eeff;
  font:15px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;max-width:640px;margin-inline:auto}
h1{font-size:17px;margin:6px 0 2px;display:flex;align-items:center;gap:8px}
.sub{color:#8a9ac0;font-size:12px;margin-bottom:14px}
.card{background:#141b33;border:1px solid #212b47;border-radius:18px;padding:16px;margin-bottom:12px}
.row{display:flex;align-items:center;gap:14px}
.ico{width:64px;height:64px;border-radius:14px;background:#0e1428;flex:0 0 64px;object-fit:cover}
.nm{font-size:17px;font-weight:650;line-height:1.25;word-break:break-word}
.meta{color:#8a9ac0;font-size:12.5px;margin-top:3px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.3px}
.on{background:#10331f;color:#38d97a;border:1px solid #1d5c38}
.off{background:#331017;color:#ff6b81;border:1px solid #5c1d29}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}
button.big{width:100%;padding:17px;border:0;border-radius:16px;font-size:16.5px;font-weight:700;color:#fff;
  background:linear-gradient(180deg,#2f6bff,#1f4fd0);cursor:pointer;transition:.15s}
button.big.off{background:linear-gradient(180deg,#e0405c,#b32a43)}
button.big:disabled{opacity:.42;cursor:not-allowed;filter:grayscale(.35)}
button.big:active:not(:disabled){transform:scale(.985)}
.hint{color:#8a9ac0;font-size:12.5px;text-align:center;margin-top:9px;min-height:17px}
input.search{width:100%;padding:12px 14px;border-radius:13px;border:1px solid #2b3557;background:#0e1428;
  color:#e8eeff;font-size:15px;margin-bottom:10px}
.ylab{color:#8a9ac0;font-size:12px;margin:0 0 7px}
.years{display:flex;gap:7px;overflow-x:auto;padding:0 0 9px;margin:0 -2px;scrollbar-width:none}
.years::-webkit-scrollbar{display:none}
.yc{flex:0 0 auto;padding:6px 12px;border-radius:999px;border:1px solid #2b3557;background:#0e1428;color:#c3cfe8;
  font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
.yc:hover{border-color:#3d4a75}
.yc.on{background:#2f6bff;border-color:#2f6bff;color:#fff}
.yc small{opacity:.75;font-weight:600}
.questbox{max-height:38vh;overflow:auto;margin:0 -4px;padding:0 4px}
.q{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:12px;border:1px solid #212b47;margin-bottom:7px}
.q.done{opacity:.5}
.q .qn{flex:1;min-width:0}
.q .qt{font-size:13.5px;font-weight:600;line-height:1.25}
.q .qsub{font-size:11.5px;color:#8a9ac0;margin-top:2px}
.q button{padding:8px 12px;border:0;border-radius:10px;background:#2f6bff;color:#fff;font-size:12.5px;
  font-weight:700;cursor:pointer;white-space:nowrap}
.q button.stop{background:#e0405c}
.q button:disabled{opacity:.5;cursor:default}
.bar{height:6px;border-radius:99px;background:#0e1428;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#2f6bff,#38d97a);width:0}
button.qauto{width:100%;padding:13px;border:0;border-radius:13px;font-size:14.5px;font-weight:700;color:#fff;
  background:linear-gradient(180deg,#2f6bff,#1f4fd0);cursor:pointer}
button.qauto.stop{background:linear-gradient(180deg,#e0405c,#b32a43)}
button.qauto:disabled{opacity:.5;cursor:default}
.games{max-height:46vh;overflow:auto;border-radius:13px;margin:0 -4px;padding:0 4px}
.g{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:12px;cursor:pointer;border:1px solid transparent}
.g:hover{background:#182142}
.g.mati{opacity:.42;filter:grayscale(.75);cursor:not-allowed}
.g.mati:hover{background:transparent}
.g .tag{font-size:10.5px;font-weight:700;color:#ff8fa3;background:#3a1220;border:1px solid #5c1d2c;
  padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:1px}
.g.sel{background:#16224a;border-color:#2f6bff}
.g img{width:34px;height:34px;border-radius:9px;background:#0e1428;flex:0 0 34px}
.g span{font-size:14.5px;line-height:1.25}
.t{font-variant-numeric:tabular-nums;font-weight:650}
.foot{color:#66739a;font-size:11.5px;text-align:center;margin-top:14px;line-height:1.6}
.toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,26px);background:#1b2645;border:1px solid #2f6bff;
  color:#e8eeff;padding:11px 16px;border-radius:13px;font-size:13.5px;opacity:0;transition:.22s;pointer-events:none;z-index:9;max-width:88vw;text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}
.tabs{display:flex;gap:8px;margin:0 0 12px}
.tab{flex:1;padding:13px 10px;border-radius:14px;border:1px solid #2b3557;background:#0e1428;color:#c3cfe8;
  font-size:14px;font-weight:700;cursor:pointer;transition:.15s}
.tab:hover{border-color:#3d4a75}
.tab.on{background:linear-gradient(180deg,#2f6bff,#1f4fd0);border-color:#2f6bff;color:#fff}
.tab small{display:block;font-size:10.5px;font-weight:600;opacity:.75;margin-top:2px}
.kunci{width:100%;padding:11px 13px;border-radius:12px;border:1px solid #2b3557;background:#0e1428;
  color:#e8eeff;font-size:13.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
.tk{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tk button{padding:9px 13px;border:0;border-radius:11px;background:#2f6bff;color:#fff;font-size:12.5px;font-weight:700;cursor:pointer}
.tk button.buang{background:#e0405c}
.tk button:disabled{opacity:.5;cursor:default}
details summary{cursor:pointer;color:#8a9ac0;font-size:12.5px;list-style:none}
details summary::-webkit-details-marker{display:none}
</style></head><body>

<h1>🎮 PS5 Mode <span id="pill" class="pill off"><span class="dot"></span>MEMUAT</span></h1>
<div class="sub">Panel ini jalan di VPS yang sama dengan bot — hemat, tanpa proses tambahan.</div>

<div class="tabs">
  <button id="tabPS5" class="tab on" type="button">🎮 PS5 MODE<small>status & pilihan game</small></button>
  <button id="tabQuest" class="tab" type="button">🎯 QUEST AUTO<small>quest · scout · token</small></button>
</div>

<div id="bannerBot" style="display:none;margin:0 0 12px;padding:12px 14px;border-radius:14px;background:#3a1420;border:1px solid #7b2740;color:#ffd9e2;font-size:13.5px;line-height:1.55">
  <b>⚠️ Token bot ditolak Discord</b> — presence/status/Spotify sedang mati, tapi <b>quest &amp; scout tetap jalan</b>.<br>
  Tempel token bot baru di kartu <b>🤖 Token bot</b> (di halaman ini) — bot menyambung ulang sendiri, tidak perlu restart.
</div>

<div id="pagePS5">

<div class="card">
  <div class="row">
    <img id="ico" class="ico" alt="" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>">
    <div style="min-width:0">
      <div id="nm" class="nm">—</div>
      <div class="meta"><span id="plat">PS5</span> <span id="thn"></span>· <span id="tmr" class="t">0:00</span></div>
      <div id="offi" class="meta"></div>
    </div>
  </div>
</div>

<button id="btn" class="big">Memuat…</button>
<div id="hint" class="hint"></div>

<div class="card">
  <div class="meta" style="margin:0 0 8px">Platform yang ditampilkan</div>
  <div id="plats" class="years"></div>
</div>

<div class="card" style="margin-top:12px">
  <div class="meta" style="margin:0 0 9px">Pilih game — ketik untuk cari (<span id="jml">…</span> game, semuanya berikon resmi) ·
    <span style="color:#8a9ac0">yang <b style="color:#ff8fa3">redup</b> = belum rilis di PS5</span></div>
  <div class="ylab">Tahun rilis</div>
  <div id="years" class="years"></div>
  <input id="q" class="search" placeholder="🔍 cari game… (mis. gta, forza, fifa)">
  <div id="list" class="games"></div>
  <div id="ket" class="meta" style="margin-top:8px"></div>
</div>

<div class="card" id="botCard">
  <div class="meta" style="margin:0 0 9px;display:flex;justify-content:space-between;align-items:center">
    <span>🤖 Token bot (DISCORD_TOKEN)</span>
    <span id="botrefresh" style="cursor:pointer;color:#5b8cff">muat ulang</span>
  </div>
  <div id="botbox" class="meta">memuat…</div>
</div>

</div><!-- /pagePS5 -->

<div id="pageQuest" style="display:none">

<div class="card" id="questCard">
  <div class="meta" style="margin:0 0 9px;display:flex;justify-content:space-between;align-items:center">
    <span>🎯 Quest Discord (Orbs)</span>
    <span id="qrefresh" style="cursor:pointer;color:#5b8cff">muat ulang</span>
  </div>
  <div id="qbox" class="questbox"><div class="meta">memuat…</div></div>
  <div id="qauto" style="margin-top:9px"></div>
</div>

<div class="card" id="scoutCard">
  <div class="meta" style="margin:0 0 9px;display:flex;justify-content:space-between;align-items:center">
    <span>🌍 Scout Orb — keliling negara lewat Tor</span>
    <span id="srefresh" style="cursor:pointer;color:#5b8cff">muat ulang</span>
  </div>
  <div id="sbox" class="questbox"><div class="meta">memuat…</div></div>
  <div id="sbtn" style="margin-top:9px"></div>
</div>

<div class="card" id="tokenCard">
  <div class="meta" style="margin:0 0 9px;display:flex;justify-content:space-between;align-items:center">
    <span>🔑 Token quest</span>
    <span id="tkrefresh" style="cursor:pointer;color:#5b8cff">muat ulang</span>
  </div>
  <div id="tkbox" class="meta">memuat…</div>
</div>

</div><!-- /pageQuest -->

<details class="card">
  <summary>ℹ️ Info & catatan</summary>
  <div class="meta" style="margin-top:9px" id="info"></div>
</details>

<div class="foot">
  Roblox tetap dipantau otomatis saat PS5 OFF · timer jalan terus ·<br>
  pilihan tersimpan di <code>.env</code>, tetap kepakai walau server restart.
</div>

<div id="toast" class="toast"></div>

<script>
var S = { games: [], years: {}, sel: null, st: null, busy: false, tahun: 0, questList: null, key: localStorage.getItem('ps5k') || '' };
var $ = function (id) { return document.getElementById(id); };

function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function api(p, opt) {
  opt = opt || {};
  if (S.key) opt.headers = Object.assign({ 'x-dash-key': S.key }, opt.headers || {});
  return fetch(p, opt).then(function (r) { return r.json(); });
}
function post(p, body) {
  return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

function render() {
  var st = S.st || {}; var on = !!st.on; var g = st.game || {};
  $('pill').className = 'pill ' + (on ? 'on' : 'off');
  $('pill').innerHTML = '<span class="dot"></span>' + (on ? 'PS5 ON' : 'PS5 OFF');
  $('nm').textContent = g.name || '—';
  var LABEL_PLAT = { ps5: 'PlayStation 5', ps4: 'PlayStation 4', xbox: 'Xbox', desktop: 'PC',
    android: 'HP Android', ios: 'iPhone/iPad', meta_quest: 'Meta Quest', samsung: 'Samsung' };
  $('plat').textContent = LABEL_PLAT[st.platform] || st.platform;
  $('tmr').textContent = on ? fmt(st.playingFor) : 'timer mati';
  $('thn').textContent = g.year ? g.year + ' · ' : '';
  if (g.icon) { $('ico').src = g.icon; $('ico').style.visibility = 'visible'; } else { $('ico').style.visibility = 'hidden'; }
  $('offi').textContent = !g.released ? '🚫 game ini belum rilis di PS5' :
    (g.id ? (g.official ? '✓ ikon & nama resmi Discord' : '⚠ game ini belum terdaftar — tampil tanpa ikon') : '');

  var btn = $('btn');
  if (S.busy) { btn.disabled = true; btn.textContent = '⏳ memproses…'; btn.className = 'big'; }
  else if (on) { btn.disabled = false; btn.className = 'big off'; btn.textContent = '⏹  MATIKAN (off)'; }
  else {
    var can = !!S.sel;
    btn.disabled = !can; btn.className = 'big';
    btn.textContent = can ? '▶  NYALAKAN — ' + (S.sel.n || S.sel) : '▶  NYALAKAN (pilih game dulu)';
  }
  $('hint').textContent = on
    ? 'Sedang tampil main ' + (g.name || '') + ' · Roblox dijeda otomatis · ganti game di bawah langsung berlaku'
    : (S.sel ? 'Game terpilih: ' + (S.sel.n || S.sel) : 'Wajib pilih game dulu sebelum bisa ON.');

  renderPlat();
  if (S.questList) renderQuestBox(S.questList);   // biar progres bar-nya ikut jalan
  var rb = st.roblox || {};
  $('info').innerHTML =
    'Dipakai game: <b>' + esc(g.written || '-') + '</b><br>' +
    'Nama tampil di Discord: <b>' + esc(g.name || '-') + '</b><br>' +
    'ID aplikasi: <code>' + esc(g.id || 'tidak ada') + '</code><br>' +
    'Roblox: ' + (rb.paused ? 'dijeda (PS5 ON)' : rb.active ? 'aktif — ' + esc(rb.game || rb.name) : 'standby') + '<br>' +
    'Aksi terakhir: ' + esc(st.lastAction || '-') + '<br>' +
    'Dashboard hidup: ' + fmt(st.uptime) + ' · versi ' + esc(st.version || '');
}

function renderList() {
  var out = [];
  for (var i = 0; i < S.games.length; i++) {
    var g = S.games[i];
    var mati = !g.r;
    out.push('<div class="g' + (S.sel && S.sel.n === g.n ? ' sel' : '') + (mati ? ' mati' : '') +
      '" data-n="' + esc(g.n) + '" data-r="' + (g.r ? 1 : 0) + '" title="' +
      (mati ? 'Belum rilis di PS5' : esc(g.n)) + '">' +
      (g.u ? '<img loading="lazy" src="' + esc(g.u) + '" alt="">' : '') +
      '<span>' + esc(g.n) + (g.y ? ' <small style="color:#8a9ac0">· ' + g.y + '</small>' : '') +
      (mati ? '<span class="tag">belum rilis</span>' : '') + '</span></div>');
  }
  if (!out.length) out.push('<div class="meta" style="padding:10px">Tidak ada yang cocok. Game di luar daftar tetap bisa ON, tapi tampil tanpa ikon.</div>');
  $('list').innerHTML = out.join('');
}

/** Ambil daftar dari server (filter tahun + pencarian) — hemat data di HP. */
function muatDaftar() {
  var q = $('q').value.trim();
  var url = '/api/games?limit=60&tahun=' + S.tahun + (q ? '&q=' + encodeURIComponent(q) : '');
  api(url).then(function (d) {
    S.games = d.games || [];
    S.years = d.years || S.years;
    S.total = d.total || S.total;
    renderYears(); renderList();
    $('jml').textContent = (d.count || 0) + ' dari ' + (d.total || 0) + ' ';
    $('ket').textContent = (d.cocok > d.count) ? ('menampilkan ' + d.count + ' pertama — ketik di kotak cari untuk mempersempit') : '';
  });
}

/** Tombol pilih tahun (2026 dulu, lalu mundur). */
function renderYears() {
  var keys = Object.keys(S.years).map(Number).filter(Boolean).sort(function (a, b) { return b - a; });
  var html = '<button class="yc' + (S.tahun === 0 ? ' on' : '') + '" data-y="0">Semua <small>(' + (S.total || '') + ')</small></button>';
  for (var i = 0; i < keys.length; i++) {
    var y = keys[i];
    html += '<button class="yc' + (S.tahun === y ? ' on' : '') + '" data-y="' + y + '">' + y +
      ' <small>(' + S.years[y] + ')</small></button>';
  }
  $('years').innerHTML = html;
}

function load() {
  api('/api/status').then(function (st) {
    S.st = st;
    if (!S.sel && st.game && st.game.name) S.sel = { n: st.game.name, u: st.game.icon, r: st.game.released, auto: true };
    render();
  }).catch(function () { toast('Gagal ambil status.'); });
}

$('list').addEventListener('click', function (e) {
  var el = e.target.closest('.g'); if (!el) return;
  if (el.getAttribute('data-r') === '0') { toast('Game ini belum rilis di PS5.'); return; }
  var name = el.getAttribute('data-n');
  S.sel = null;
  for (var i = 0; i < S.games.length; i++) if (S.games[i].n === name) S.sel = S.games[i];
  renderList(); render();
  var on = S.st && S.st.on;
  if (on && S.sel && S.st.game && S.st.game.name !== S.sel.n) {
    S.busy = true; render();
    post('/api/game', { game: S.sel.n }).then(function (r) {
      S.busy = false; if (r.ok) { S.st = r; toast('Game diganti → ' + (r.game.name || '')); } else toast(r.error || 'Gagal');
      render();
    });
  }
});

$('btn').addEventListener('click', function () {
  var on = S.st && S.st.on;
  if (!on && S.sel && S.sel.r === 0) { toast('Game ini belum rilis di PS5 — pilih yang lain.'); return; }
  S.busy = true; render();
  var req = on ? post('/api/off') : post('/api/on', { game: S.sel ? (S.sel.n || S.sel) : ($('q').value.trim()) });
  req.then(function (r) {
    S.busy = false;
    if (r.ok) { S.st = r; toast(on ? 'PS5 OFF — balik pantau Roblox' : 'PS5 ON — ' + (r.game.name || '')); }
    else toast(r.error || 'Gagal');
    render();
  }).catch(function () { S.busy = false; toast('Koneksi gagal.'); render(); });
});

/* ---------------- quest ---------------- */
function fmtProgress(v, t) { return Math.floor(v / 60) + 'm ' + (v % 60) + 's / ' + Math.floor(t / 60) + 'm'; }

function renderQuestBox(j) {
  if (j && j.quests) S.questList = j;
  var st = (S.st && S.st.quest) || null;
  var layak = ((j && j.quests) || []).filter(function (q) { return !q.selesai && !q.kedaluwarsa && !q.belumMulai; });
  var jalan = !!(st && (st.jalan || st.nama));
  var menit = layak.reduce(function (t, q) {
    return t + (q.jenis && q.jenis.indexOf('WATCH_VIDEO') === 0 ? 3 : 15);
  }, 0);
  var otoOn = (st && st.otomatis) || (j && j.otomatis);
  var jeda = (st && st.jeda) || 0;
  var jamJeda = (st && st.jedaSampai)
    ? new Date(st.jedaSampai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : '';
  if (jalan) {
    var jumlahJalan = (st.aktif && st.aktif.length) ? st.aktif.length : 1;
    $('qauto').innerHTML = '<button class="qauto stop" data-qauto="0">⏹ hentikan — ' +
      (jumlahJalan > 1 ? jumlahJalan + ' quest jalan bersamaan' : esc(st.nama)) + '</button>';
  } else if (layak.length) {
    $('qauto').innerHTML = '<div class="meta" style="text-align:center">' +
      (otoOn ? '⚡ ' + layak.length + ' quest langsung dikerjakan sendiri (tanpa klik apa pun)' :
               '⚠️ otomatis dimatikan (QUEST_OTOMATIS=false)') + '</div>';
  } else {
    var jamCek = (st && st.cekTerakhir) ? new Date(st.cekTerakhir).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
    if (jeda > 0) {
      $('qauto').innerHTML = '<div class="meta" style="text-align:center">' +
        '⏳ dijeda batas laju Discord — lanjut otomatis' +
        (jamJeda ? ' sekitar pukul <b>' + jamJeda + '</b>' : '') +
        '<br><span style="opacity:.7">sisa ±' + Math.ceil(jeda / 60) + ' menit (bot melanjutkan sendiri, tidak perlu diapa-apakan)</span></div>';
    } else {
    $('qauto').innerHTML = '<div class="meta" style="text-align:center">' +
      (otoOn ? '⚡ otomatis ON — quest baru langsung diterima & dikerjakan sendiri (tanpa tombol)' +
               '<br><span style="opacity:.7">diperiksa tiap ' + ((st && st.otomatisMenit) || 1) + ' menit · terakhir ' + jamCek + '</span>' :
               'otomatis dimatikan (QUEST_OTOMATIS=false)') + '</div>';
    }
  }

  var html = '';
  var list = (j && j.quests) || [];
  var aktives = (st && st.aktif && st.aktif.length) ? st.aktif : (st && st.nama ? [st] : []);
  if (st && st.rute) {
    html += '<div class="meta" style="margin-bottom:7px">🌍 dikerjakan lewat rute <b>' + esc(st.rute) +
      '</b> (scout — status profilmu tetap tidak diubah)</div>';
  }
  if (aktives.length) {
    if (aktives.length > 1) {
      html += '<div class="meta" style="margin-bottom:7px">⚡ OTOMATIS — <b>' + aktives.length +
        ' quest dikerjakan BERSAMAAN</b> (sekaligus, tidak antre) · status profilmu tidak diubah</div>';
    }
    aktives.forEach(function (a) {
      var persen2 = Math.min(100, Math.round(((a.value || 0) / (a.target || 900)) * 100));
      var jenis = (a.jenis === 'WATCH_VIDEO' || a.jenis === 'WATCH_VIDEO_ON_MOBILE') ? '🎬 nonton video' : '🎮 main di PC';
      html += '<div class="q" style="border-color:#2f6bff;margin-bottom:9px"><div class="qn">' +
        '<div class="qt">⏳ ' + (st.mode === 'auto' ? 'OTOMATIS' : 'dikerjakan') + ': ' + esc(a.nama) + '</div>' +
        '<div class="qsub">' + jenis + ' · ' + fmtProgress(a.value || 0, a.target || 900) + ' · ' + persen2 + '% · ' +
        esc(a.hadiah || '') + '</div>' +
        '<div class="bar"><i style="width:' + persen2 + '%"></i></div></div>' +
        (aktives.length === 1 ? '<button class="stop" data-stop="1">stop</button>' : '') + '</div>';
    });
    if (aktives.length > 1) {
      html += '<div style="text-align:right;margin:-4px 0 9px"><button class="stop" data-stop="1">⏹ stop semua</button></div>';
    }
  }
  if (st && !st.nama && ((st.selesai && st.selesai.length) || (st.dilewati && st.dilewati.length) ||
      (st.gagal && st.gagal.length) || (st.ditunda && st.ditunda.length))) {
    if (st.selesai && st.selesai.length) {
      html += '<div class="q"><div class="qn"><div class="qt">✅ selesai: ' + esc(st.selesai.join(', ')) + '</div>' +
        '<div class="qsub">tinggal klaim di aplikasi Discord (perlu captcha) · atau coba dari API dulu</div></div>' +
        '<button class="stop" data-claim="1" style="background:#1f6f43">🔓 coba klaim</button></div>';
    }
    (st.ditunda || []).forEach(function (x) {
      html += '<div class="q done"><div class="qn"><div class="qt">⏳ ditunda: ' + esc(x.nama) + '</div>' +
        '<div class="qsub">' + esc(x.sebab || 'batas laju Discord') + ' — dicoba lagi otomatis setelah jeda Discord selesai</div></div></div>';
    });
    (st.dilewati || []).forEach(function (x) {
      html += '<div class="q done"><div class="qn"><div class="qt">⚠️ dilewati: ' + esc(x.nama) + '</div>' +
        '<div class="qsub">' + esc(x.sebab) + ' — akan dicoba lagi otomatis pada pemeriksaan berikutnya</div></div></div>';
    });
    (st.gagal || []).forEach(function (x) {
      html += '<div class="q done"><div class="qn"><div class="qt">❌ gagal: ' + esc(x.nama) + '</div>' +
        '<div class="qsub">' + esc(x.sebab) + '</div></div></div>';
    });
  }
  var belum = list.filter(function (q) { return !q.selesai && !q.diklaim && !q.kedaluwarsa; });
  var sudah = list.filter(function (q) { return q.selesai || q.diklaim; });
  if (!list.length) html += '<div class="meta">Tidak ada quest yang bisa dikerjakan sekarang.</div>';
  function labelJenis(q) {
    if (q.jenis === 'WATCH_VIDEO') return '🎬 nonton video';
    if (q.jenis === 'WATCH_VIDEO_ON_MOBILE') return '🎬 nonton video (HP)';
    if (q.jenis === 'PLAY_ON_DESKTOP') return '🎮 main di PC (tanpa ganti status)';
    return esc(q.jenis || '');
  }
  belum.forEach(function (q) {
    var persen = Math.min(100, Math.round((q.progress / q.target) * 100));
    var satuan = (q.jenis && q.jenis.indexOf('WATCH_VIDEO') === 0) ? ' dari video' : ' detik';
    var tanda = q.dikuti ? '' : ' <small style="color:#ffcc66">(diterima otomatis saat dikerjakan)</small>';
    html += '<div class="q"><div class="qn"><div class="qt">' + esc(q.nama) + '</div>' +
      '<div class="qsub">' + labelJenis(q) + ' · ' + esc(q.hadiah || '') + ' · ' + q.progress + '/' + q.target + satuan +
      ' · berakhir ' + esc(String(q.berakhir || '-').slice(0, 10)) + tanda +
      (q.selesaiTidakSinkron ? ' · ⚠️ status Discord dan progres belum cocok; belum dihitung selesai' : '') + '</div>' +
      (persen ? '<div class="bar"><i style="width:' + persen + '%"></i></div>' : '') +
      '</div><button data-quest="' + esc(q.id) + '"' + (st ? ' disabled' : '') + '>kerjakan</button></div>';
  });
  var BATAS = 8; // daftar panjang (mis. 97 quest) dipangkas biar halaman tetap enak dibaca
  function sisa(n) {
    return n > 0 ? '<div class="meta">…dan ' + n + ' lainnya</div>' : '';
  }
  var kadaluarsaList = list.filter(function (q) { return !q.selesai && q.kedaluwarsa; });
  kadaluarsaList.slice(0, BATAS).forEach(function (q) {
    html += '<div class="q done"><div class="qn"><div class="qt">🚫 ' + esc(q.nama) + ' <small>(kedaluwarsa)</small></div>' +
      '<div class="qsub">tidak bisa dikerjakan lagi — Discord sudah menutup quest ini</div></div></div>';
  });
  html += sisa(kadaluarsaList.length - BATAS);
  sudah.slice(0, BATAS).forEach(function (q) {
    html += '<div class="q done"><div class="qn"><div class="qt">✅ ' + esc(q.nama) + '</div>' +
      '<div class="qsub">' + esc(q.hadiah || '') + ' — ' + (q.diklaim ? 'sudah diklaim' : 'tinggal klaim di app Discord') + '</div></div></div>';
  });
  html += sisa(sudah.length - BATAS);
  var kk = (j && j.konsol) || null;
  if (kk) {
    var psn = kk.playstation || {}, xb = kk.xbox || {}, lain = kk.lain || {};
    // (a) yang benar-benar tidak bisa dikerjakan: quest konsol SAJA
    var dilewati = [];
    if (psn.layak) dilewati.push('PlayStation ' + psn.layak);
    if (xb.layak) dilewati.push('Xbox ' + xb.layak);
    if (lain.layak) dilewati.push('lainnya ' + lain.layak);
    if (dilewati.length) {
      html += '<div class="meta" style="margin-top:9px">🚫 dilewati: ' + dilewati.join(' · ') +
        ' quest hanya bisa lewat konsol (main di PS/Xbox asli) — Discord mengeceknya dari akun PSN/Xbox yang ' +
        'benar-benar terhubung, jadi tidak bisa dikerjakan skrip.</div>';
    }
    // (b) yang punya dua jalur: tetap selesai lewat jalur desktop
    var lewat = [];
    if (psn.lewatDesktop) lewat.push('PlayStation ' + psn.lewatDesktop + '/' + psn.total);
    if (xb.lewatDesktop) lewat.push('Xbox ' + xb.lewatDesktop + '/' + xb.total);
    if (lewat.length) {
      html += '<div class="meta" style="margin-top:9px">🛈 quest yang juga punya jalur konsol (' + lewat.join(' · ') +
        ') dikerjakan lewat jalur desktop-nya — Discord menerima jalur desktop, jadi questnya tetap selesai.</div>';
    }
  }
  $('qbox').innerHTML = html;
}

function renderScout(j) {
  if (!j || !j.ok) { $('sbox').innerHTML = '<div class="meta">' + esc((j && j.error) || 'Scout tidak aktif.') + '</div>'; $('sbtn').innerHTML = ''; return; }
  var t = j.terakhir || null;
  var menit = Math.round(((Date.now() - (j.mulaiJam || Date.now())) / 60000));
  var baris = [];
  if (j.antri) {
    baris.push('<div class="meta">📥 <b>' + j.antri + '</b> negara menunggu dikerjakan: ' +
      (j.antriList || []).map(function (x) { return '<b>' + esc(String(x.cc).toUpperCase()) + '</b> (' + x.jumlah + ')'; }).join(' · ') + '</div>');
  }
  if (j.panas && j.panas.length) {
    baris.push('<div class="meta">🔥 negara produktif (dipindai lebih dulu): ' +
      j.panas.map(function (x) { return '<b>' + esc(String(x.cc).toUpperCase()) + '</b>'; }).join(' · ') + '</div>');
  }
  baris.push('<div class="meta">negara terdaftar: <b>' + (j.negara || 0) + '</b> · ' +
    (j.intervalMin > 0 ? 'rotasi tiap <b>' + j.intervalMin + ' menit</b>' : '<b>tanpa jeda</b> (negara kosong langsung lanjut)') +
    ' · antar negara <b>' + (j.jedaAntar || 2) + ' dtk</b> · ' +
    (j.burstMaks || 10) + ' negara per putaran · ' +
    (j.autoKerja ? '<b style="color:#7ee3a0">kerja otomatis ON</b>' : 'kerja otomatis OFF') + '</div>');
  if (j.rataDetikNegara) {
    var perMenit = Math.max(1, Math.round(60 / j.rataDetikNegara));
    var neg50 = j.rataDetikNegara * (j.negara || 51);
    baris.push('<div class="meta">⚡ kecepatan: <b>' + j.rataDetikNegara + ' dtk/negara</b> (~' + perMenit +
      ' negara/menit · ' + (j.negara || 51) + ' negara ≈ ' + (neg50 > 120 ? Math.round(neg50 / 60) + ' menit' : Math.round(neg50) + ' dtk') +
      ') — dulu ±19-20 dtk/negara</div>');
  }
  if (t) {
    baris.push('<div class="meta">terakhir: <b>' + esc(String(t.cc || '').toUpperCase()) + '</b> (' + esc(t.ip || '?') + ') — ' +
      (t.total || 0) + ' quest terlihat · ' + (t.layak || 0) + ' masih bisa · ' + (t.temuan || 0) + ' temuan</div>');
  } else {
    baris.push('<div class="meta">belum ada putaran selesai — tor sedang disiapkan/dipanaskan.</div>');
  }
  var status = j.aktif ? '<span style="color:#7fe0a0">AKTIF</span>' : '<span style="color:#ff8fa3">DIJEDA</span>';
  if (!j.aktif && j.sebab) status += ' <span class="meta">(' + esc(j.sebab) + ')</span>';
  baris.push('<div class="meta">keadaan: ' + status + ' · tor: ' + (j.torSiap ? 'siap' : 'menyiapkan') + ' · jalan ' + menit + ' menit</div>');
  baris.push('<div class="meta">kerja otomatis: ' + (j.autoKerja ? '<b style="color:#7fe0a0">ON</b> — quest yang ketemu langsung dikerjakan (klaim tetap manual di app)' : '<b style="color:#ff8fa3">OFF</b>') +
    ' · sampai <b>' + (j.burstMaks || 10) + '</b> negara per putaran kalau kosong · jeda antar negara ' + (j.jedaAntar || 2) + ' dtk</div>');
  if (j.dikerjakanTotal) baris.push('<div class="meta">total quest selesai lewat scout: <b>' + j.dikerjakanTotal + '</b> (dari ' + (j.kerjaTotal || 0) + ' kali kerja)</div>');
  var al = j.alert || [];
  if (al.length) {
    baris.push('<div class="meta" style="margin-top:7px;color:#ffd479"><b>🔔 peristiwa terakhir</b></div>');
    for (var k = 0; k < Math.min(al.length, 5); k++) {
      var a = al[k];
      var jam = new Date(a.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      baris.push('<div class="meta">• ' + esc(jam) + ' — ' + esc(a.teks) + '</div>');
    }
  }
  var tmn = j.temuan || [];
  if (tmn.length) {
    baris.push('<div class="meta" style="margin-top:7px;color:#ffd479"><b>🎯 ' + (j.temuanTotal || tmn.length) + ' temuan</b></div>');
    for (var i = 0; i < Math.min(tmn.length, 12); i++) {
      var x = tmn[i];
      var kapan = x.exp ? new Date(x.exp).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
      baris.push('<div class="meta">• <b>' + esc(x.nama || x.id) + '</b> — ' + esc((x.cc || '').toUpperCase()) + ' · ' +
        (x.orbs || '?') + ' Orbs · ' + esc(x.jenis || '') + ' · kategori <b>' + esc(x.kategori || '') + '</b> · sebelum ' + kapan + '</div>');
    }
  } else {
    baris.push('<div class="meta" style="margin-top:7px">belum ada temuan — semua quest yang terlihat sudah dikenal atau sudah diklaim.</div>');
  }
  $('sbox').innerHTML = baris.join('');
  $('sbtn').innerHTML = '<button class="qauto' + (j.aktif ? ' stop' : '') + '" data-scout="' + (j.aktif ? '0' : '1') + '">' +
    (j.aktif ? '⏹ matikan scout' : '▶ nyalakan scout') + '</button>';
}

function muatScout() {
  api('/api/scout').then(function (j) { renderScout(j); }).catch(function () {
    $('sbox').innerHTML = '<div class="meta">Gagal memuat scout.</div>';
  });
}

function muatQuest() {
  api('/api/quests').then(function (j) { renderQuestBox(j); })
    .catch(function () { $('qbox').innerHTML = '<div class="meta">Gagal memuat quest.</div>'; });
}

/* ------------------------- tab: PS5 MODE / QUEST AUTO ------------------------- */
function pindahTab(nama) {
  var q = nama === 'quest';
  $('pagePS5').style.display = q ? 'none' : 'block';
  $('pageQuest').style.display = q ? 'block' : 'none';
  $('tabPS5').className = 'tab' + (q ? '' : ' on');
  $('tabQuest').className = 'tab' + (q ? ' on' : '');
  try { localStorage.setItem('tab', q ? 'quest' : 'ps5'); } catch (e) {}
  if (q) { muatQuest(); muatScout(); muatToken(); }
}
$('tabPS5').addEventListener('click', function () { pindahTab('ps5'); });
$('tabQuest').addEventListener('click', function () { pindahTab('quest'); });
(function () {
  var t = 'ps5';
  try { t = localStorage.getItem('tab') || (location.hash === '#quest' ? 'quest' : 'ps5'); } catch (e) {}
  pindahTab(t);
})();

/* ------------------------------ token quest ---------------------------------- */
function renderToken(j) {
  if (!j || !j.ok) { $('tkbox').innerHTML = esc((j && j.error) || 'tidak tersedia'); return; }
  var baris = [];
  baris.push('<div class="tk"><span class="kunci">' + esc(j.kunci || '(kosong)') + '</span>' +
    '<span style="color:' + (j.sumber === 'sendiri' ? '#7fe0a0' : '#8a9ac0') + '">' +
    (j.sumber === 'sendiri' ? 'token sendiri' : 'token bot (.env)') + '</span></div>');
  baris.push('<input id="tkin" class="kunci" style="margin-top:9px" placeholder="tempel token Discord baru di sini…" autocomplete="off">');
  baris.push('<div class="tk" style="margin-top:9px">' +
    '<button id="tksimpan" type="button">ganti token</button>' +
    (j.sumber === 'sendiri' ? '<button id="tkbuang" class="buang" type="button">🗑 hapus token (pakai token bot)</button>' : '') +
    '</div>');
  baris.push('<div class="meta" style="margin-top:8px">Token ini <b>hanya dipakai untuk quest</b> — ' +
    'PS5, status/online, Roblox, dan Spotify tetap memakai token bot di .env. ' +
    'Tombol hapus mengembalikan semuanya ke token bot.</div>');
  $('tkbox').innerHTML = baris.join('');
  var b = $('tksimpan');
  if (b) b.addEventListener('click', function () {
    var t = ($('tkin').value || '').trim();
    if (!t) { toast('tempel dulu tokennya'); return; }
    b.disabled = true; b.textContent = 'memeriksa…';
    api('/api/quest/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) })
      .then(function (r) {
        if (r.ok) { toast('Token quest tersimpan — akun ' + (r.akun || '?')); muatToken(); }
        else { toast(r.error || 'gagal menyimpan'); b.disabled = false; b.textContent = 'ganti token'; }
      })
      .catch(function () { toast('gagal menghubungi panel'); b.disabled = false; b.textContent = 'ganti token'; });
  });
  var h = $('tkbuang');
  if (h) h.addEventListener('click', function () {
    if (!confirm('Hapus token quest dan kembali memakai token bot (.env)?')) return;
    h.disabled = true;
    api('/api/quest/token', { method: 'DELETE' })
      .then(function (r) { toast(r.ok ? 'kembali memakai token bot' : (r.error || 'gagal')); muatToken(); })
      .catch(function () { toast('gagal menghubungi panel'); h.disabled = false; });
  });
}

function renderBotToken(j) {
  var b = [];
  if (j.hidup) {
    b.push('<div class="meta">✅ token bot sehat — bot online.</div>');
  } else {
    b.push('<div class="meta" style="color:#ffb3c6">⚠️ token bot DITOLAK Discord (bot sedang mode darurat: quest tetap jalan).</div>');
  }
  b.push('<div style="margin:6px 0"><span class="kunci">' + esc(j.kunci || '(kosong)') + '</span></div>');
  if (!j.hidup) {
    b.push('<input id="botin" class="kunci" style="margin-top:9px" placeholder="tempel token bot baru (Developer Portal → Bot → Reset Token)…" autocomplete="off">');
    b.push('<button class="qauto" id="botsave" style="margin-top:9px">simpan & sambung ulang</button>');
  }
  $('botbox').innerHTML = b.join('');
  $('bannerBot').style.display = j.hidup ? 'none' : 'block';
  var sv = $('botsave');
  if (sv) sv.addEventListener('click', function () {
    var v = ($('botin').value || '').trim();
    if (!v) return toast('token masih kosong');
    sv.disabled = true; sv.textContent = 'memeriksa…';
    post('/api/bot/token', { token: v }).then(function (r) {
      toast('token bot tersimpan — akun ' + (r.akun || '?') + ' · menyambung ulang');
      setTimeout(muatBotToken, 1200);
    }).catch(function (e) {
      sv.disabled = false; sv.textContent = 'simpan & sambung ulang';
      toast((e && e.message) || 'token ditolak Discord');
    });
  });
}
function muatBotToken() {
  api('/api/bot/token').then(renderBotToken).catch(function () {
    $('botbox').innerHTML = '<div class="meta">Gagal memuat status token bot.</div>';
  });
}
$('botrefresh').addEventListener('click', muatBotToken);
muatBotToken();
setInterval(muatBotToken, 30000);

function muatToken() {
  api('/api/quest/token').then(renderToken).catch(function () {
    $('tkbox').innerHTML = '<div class="meta">Gagal memuat token.</div>';
  });
}
$('tkrefresh').addEventListener('click', muatToken);

$('srefresh').addEventListener('click', muatScout);

$('sbtn').addEventListener('click', function (e) {
  var b = e.target.closest('[data-scout]');
  if (!b) return;
  b.disabled = true;
  post('/api/scout/toggle', { on: b.getAttribute('data-scout') === '1' }).then(function (r) {
    toast(r.sebab && !r.aktif ? 'Scout belum dinyalakan: ' + r.sebab : 'Scout: ' + (r.aktif ? 'dinyalakan' : 'dimatikan'));
    setTimeout(muatScout, 600);
  }).catch(function () { b.disabled = false; toast('gagal ubah scout'); });
});

$('qbox').addEventListener('click', function (e) {
  var klaim = e.target.closest('[data-claim]');
  if (klaim) {
    klaim.disabled = true; klaim.textContent = 'mencoba…';
    post('/api/quest/claim-coba', {}).then(function (r) {
      toast(r.info || r.error || 'selesai');
      if (r.perluCaptcha && r.perluCaptcha.length) {
        toast('Discord wajibkan captcha — klaim manual di app: ' + r.perluCaptcha.join(', '));
      }
      if (r.terklaim && r.terklaim.length) toast('Terklaim: ' + r.terklaim.join(', '));
      setTimeout(muatQuest, 1500);
    }).catch(function () { klaim.disabled = false; klaim.textContent = '🔓 coba klaim'; });
    return;
  }
  var stop = e.target.closest('[data-stop]');
  if (stop) {
    stop.disabled = true;
    post('/api/quest/stop', {}).then(function (r) { toast(r.info || r.error || 'stop'); setTimeout(muatQuest, 1200); });
    return;
  }
  var b = e.target.closest('[data-quest]');
  if (!b) return;
  b.disabled = true; b.textContent = 'mulai…';
  post('/api/quest/start', { qid: b.getAttribute('data-quest') }).then(function (r) {
    if (r.ok) { toast('Quest mulai dikerjakan (15 menit)'); }
    else { toast(r.error || 'Gagal'); b.disabled = false; b.textContent = 'kerjakan'; }
    setTimeout(muatQuest, 900);
  });
});
$('qrefresh').addEventListener('click', function () { muatQuest(); });

$('qauto').addEventListener('click', function (e) {
  var b = e.target.closest('[data-qauto]'); if (!b) return;
  var on = b.getAttribute('data-qauto') === '1';
  b.disabled = true; b.textContent = on ? 'menyiapkan…' : 'menghentikan…';
  post('/api/quest/auto', { on: on }).then(function (r) {
    if (r.ok) toast(on ? 'Otomatis mulai: ' + (r.jumlah || '') + ' quest' : (r.info || 'dihentikan'));
    else toast(r.error || 'Gagal');
    setTimeout(muatQuest, 1200);
  });
});

var tCari = null;
$('q').addEventListener('input', function () {
  clearTimeout(tCari);
  tCari = setTimeout(muatDaftar, 220);
});

var PLAT = [['ps5', 'PS5'], ['ps4', 'PS4'], ['desktop', 'PC'], ['xbox', 'Xbox'], ['android', 'HP']];
function renderPlat() {
  var cur = (S.st && S.st.platform) || 'ps5';
  $('plats').innerHTML = PLAT.map(function (p) {
    return '<button class="yc' + (p[0] === cur ? ' on' : '') + '" data-p="' + p[0] + '">' + p[1] + '</button>';
  }).join('');
}

$('plats').addEventListener('click', function (e) {
  var b = e.target.closest('.yc'); if (!b) return;
  var val = b.getAttribute('data-p');
  S.busy = true; render();
  post('/api/platform', { platform: val }).then(function (r) {
    S.busy = false;
    if (r.ok) { S.st = r; toast('Platform: ' + val); } else toast(r.error || 'Gagal');
    renderPlat(); render();
  });
});

$('years').addEventListener('click', function (e) {
  var b = e.target.closest('.yc'); if (!b) return;
  S.tahun = Number(b.getAttribute('data-y')) || 0;
  renderYears(); muatDaftar();
});

// ambil kunci dari URL kalau ada, lalu simpan
if (location.search.indexOf('k=') > 0) {
  var k = new URLSearchParams(location.search).get('k');
  if (k) { localStorage.setItem('ps5k', k); S.key = k; }
  history.replaceState(null, '', '/');
}

api('/api/games?limit=60').then(function (d) {
  S.games = d.games || [];
  S.years = d.years || {};
  S.total = d.total || 0;
  $('jml').textContent = (d.count || 0) + ' dari ' + (S.total || 0) + ' ';
  renderYears();
  renderList();
  load();
}).catch(function () { load(); });

setInterval(function () { var on = S.st && S.st.on; if (!on) load(); }, 5000);
setInterval(muatQuest, 12000);
muatQuest();
setInterval(muatScout, 20000);
muatScout();
setInterval(function () {
  if (!S.st || !S.st.on) return;
  S.st.playingFor += 1; $('tmr').textContent = fmt(S.st.playingFor);
}, 1000);
</script></body></html>`;
}

module.exports = { createDashboard, saveEnv, iconUrl, ICONS, pageHtml, loginPage };
