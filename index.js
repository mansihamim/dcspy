#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  discord-keep-online (Node.js)
 *  Keep-online + status DND + custom status PERMANEN + Spotify "Listening"
 * ============================================================================
 *  Versi Node.js dari dc3.php. Yang dilakukan:
 *    1. Connect ke gateway Discord  -> akun ONLINE (status: online/idle/dnd)
 *    2. Custom status kamu disimpan PERMANEN di server Discord
 *       (expires = "Don't clear"), lalu dijaga supaya tidak hilang
 *       walau aplikasi Discord ditutup / HP restart / logout-login.
 *    3. Ambil token Spotify otomatis lewat Discord API
 *    4. Connect ke dealer.spotify.com -> notifikasi lagu real-time
 *    5. Tampilkan "Listening to Spotify" (judul, artis, album, cover, progress)
 *    6. Heartbeat + auto-reconnect untuk kedua koneksi
 *
 *  CARA PAKAI:
 *     npm install
 *     cp .env.example .env    # isi DISCORD_TOKEN
 *     npm start
 *
 *  ⚠ Self-bot MELANGGAR ToS Discord -> risiko banned/disabled.
 *    Pakai dengan risiko sendiri, JANGAN pakai akun utama.
 * ============================================================================
 */

const { config, validateConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { DiscordGateway } = require('./src/discord');
const { SpotifyPresence } = require('./src/spotify');
const { StatusKeeper } = require('./src/settings');
const { RobloxPresence } = require('./src/roblox');
const { Ps5Presence, platformLabel } = require('./src/ps5');
const { createDashboard, saveEnv } = require('./src/dashboard');
const { QuestRunner } = require('./src/quest');
const { Tunnel } = require('./src/tunnel');
const { Scout } = require('./src/scout');
const { request } = require('./src/http');

async function main() {
  const log = createLogger(config.logLevel);

  log.info('==============================================');
  log.info(' discord-keep-online (Node.js) v2.1.0');
  log.info(` status: ${config.status.toUpperCase()}  |  spotify: ${config.spotify.enabled ? 'ON' : 'OFF'}`);
  log.info(` penjaga status: ${config.customStatus.enabled && config.customStatus.mode !== 'off' ? `ON (mode ${config.customStatus.mode})` : 'OFF'}`);  log.info(` roblox: ${config.ps5.enabled ? 'OFF (digantikan mode PS5)' : config.roblox.enabled ? `ON (mode ${config.roblox.mode})` : 'OFF'}`);
  if (config.ps5.enabled) log.info(` ps5: ON — pura-pura main "${config.ps5.game}" di ${platformLabel(config.ps5.platform)}`);
  log.info(` terlihat sebagai: ${config.platform.label}`);
  log.info('==============================================');

  const problems = validateConfig(log);
  if (problems.length) {
    for (const p of problems) log.error('✖ ' + p);
    process.exit(1);
  }

  /* -------------------------- komponen utama -------------------------- */

  const spotify = new SpotifyPresence({
    discordToken: config.discordToken,
    logger: log,
    cfg: config.spotify,
    apiVersion: config.apiVersion,
    userAgent: config.userAgent,
  });

  const roblox = new RobloxPresence({
    logger: log,
    cfg: config.roblox,
  });

  const ps5 = new Ps5Presence({
    logger: log,
    cfg: config.ps5,
  });

  const keeper = new StatusKeeper({
    token: config.discordToken,
    logger: log,
    apiVersion: config.apiVersion,
    dataDir: config.dataDir,
    cfg: config.customStatus,
    status: config.status,
  });

  const gateway = new DiscordGateway({
    token: config.discordToken,
    logger: log,
    userAgent: config.userAgent,
    properties: config.platform.properties, // <- PC/laptop Apple, bukan Android
    apiVersion: config.apiVersion,
    presenceRefreshSec: config.presenceRefreshSec,
    presenceStatus: config.status,
  });

  /** Activities yang dikirim ke gateway: [custom status?, PS5/Roblox?, Spotify?] */
  const buildActivities = () => {
    const list = [];
    const custom = keeper.currentActivity();
    if (custom) list.push(custom);
    // Mode PS5 (kalau ON) menggantikan aktivitas Roblox — kamu tidak mungkin
    // main Roblox dan PS5 bersamaan.
    const game = ps5.activity() || roblox.activity();
    if (game) list.push(game);
    const music = spotify.currentActivity({ discordUserId: gateway.selfUser?.id });
    if (music) list.push(music);
    return list;
  };

  gateway.setPresenceProvider(buildActivities, config.status);
  keeper.onChange = () => gateway.requestPresencePush();
  spotify.on('change', () => gateway.requestPresencePush());
  roblox.on('change', () => gateway.requestPresencePush());
  ps5.on('change', () => gateway.requestPresencePush());

  /* ------------------------- dashboard PS5 (opsional) ------------------ */
  // Nempel di proses ini juga -> tanpa proses/port/RAM tambahan.
  const quest = new QuestRunner({
    token: config.discordToken, log, ps5,
    apiVersion: config.apiVersion, beatSec: config.quest.beatSec,
    otomatis: config.quest.otomatis, otomatisMenit: config.quest.otomatisMenit,
  });
  quest.on('change', () => gateway.requestPresencePush());
  // token quest khusus (kalau diisi di dashboard) — hanya untuk quest,
  // tidak menyentuh presence/PS5/Roblox/Spotify.
  if (config.quest.token) {
    quest.setToken(config.quest.token);
    log.info('Quest: memakai token khusus dari QUEST_TOKEN (hanya untuk quest).');
  }

  /* ---------------------------------------------------------------------
   * Scout Orb — keliling negara lewat Tor untuk memantau quest baru.
   * Proses tor dijalankan sendiri (mode klien, RAM dibatasi) dan TIDAK
   * menyentuh koneksi presence/status bot.
   * ------------------------------------------------------------------- */
  const scout = new Scout({
    token: config.quest.token || config.discordToken,
    // true = token khusus quest ada → sweep boleh ngebut.
    // false = sweep memakai token UTAMA (akun bot) → mode hati-hati, karena
    //         sweep lintas negara berulang kali terbukti diikuti token ditolak
    //         Discord (REST 401) — lihat LAPORAN-SCOUT §15.
    tokenKhusus: Boolean(config.quest.token),
    log,
    quest,
    enabled: config.scout.enabled,
    intervalMin: config.scout.intervalMin,
    jedaPutaran: config.scout.jedaPutaranDetik,
    jedaSaatId: config.scout.jedaSaatIdDetik,
    mulaiDetik: config.scout.mulaiDetik,
  });

  /* tunnel keluar: bikin dashboard bisa dibuka dari internet tanpa port publik */
  const tunnel = new Tunnel({
    logger: log,
    port: config.dash.port,
    dir: config.tunnel.dir || undefined,
    aktif: config.tunnel.enabled && config.dash.enabled,
    laporUrl: config.tunnel.laporUrl,
    laporSecret: config.tunnel.laporSecret,
  });
  tunnel.on('url', () => gateway.requestPresencePush && gateway.requestPresencePush());

  const dashboard = createDashboard({
    cfg: config.dash,
    log,
    ps5,
    roblox,
    spotify,
    quest,
    scout,
    tunnel,
    gateway,
    version: '2.1.0',
    bot: {
      hidup: () => !botTokenMati,
      tokenBaru: (tk) => terapkanTokenBaru(tk),
    },
    onUser: () => ({ tag: (gateway.selfUser && gateway.selfUser.username) || '', id: (gateway.selfUser && gateway.selfUser.id) || '' }),
  });

  gateway.on('ready', () => {
    log.info(buildActivities().length ? 'Presence dikirim (status + aktivitas).' : 'Presence dikirim (status saja).');
    // Pastikan status di server masih sesuai (mis. habis diubah dari app)
    keeper.tick().catch(() => {});
  });

  gateway.on('settingsUpdate', ({ base64, partial }) => keeper.handleSettingsEvent(base64, partial));
  gateway.on('statusChange', ({ status, previous, source }) => {
    config.status = status;
    keeper.presenceStatus = status;
    process.env.STATUS = status;
    try {
      saveEnv({ STATUS: status });
      log.info(`Status Discord disinkronkan dari ${source || 'Discord app'} (${previous} → ${status}) dan disimpan ke .env.`);
    } catch (err) {
      log.warn(`Status Discord sudah disinkronkan ke VPS, tetapi gagal disimpan ke .env: ${err.message}`);
    }
  });

  /*
   * Token bot DITOLAK Discord (mis. 4004 Authentication failed).
   * Dulu bot langsung keluar -> server crash-loop dan dashboard ikut mati,
   * sehingga token baru tidak bisa ditempel dari mana pun.
   * Sekarang: mode darurat — quest, scout, dan dashboard TETAP jalan, dan bot
   * menyambung ulang sendiri begitu token baru ditempel (dashboard/panel).
   */
  let botTokenMati = false;
  let cekTokenTimer = null;

  function mulaiCekToken() {
    if (cekTokenTimer) return;
    cekTokenTimer = setInterval(async () => {
      if (!botTokenMati || shuttingDown) return;
      const tk = String(process.env.DISCORD_TOKEN || '').trim();
      if (!tk) return;
      try {
        const r = await request('GET', `https://discord.com/api/${config.apiVersion}/users/@me`, {
          headers: { Authorization: tk, 'User-Agent': config.userAgent },
          timeoutMs: 15000,
        });
        if (r.ok && r.json && r.json.id) {
          clearInterval(cekTokenTimer);
          cekTokenTimer = null;
          log.info(`Token bot baru diterima (akun ${r.json.username}) — menyambung ulang…`);
          terapkanTokenBaru(tk);
        }
      } catch {
        /* diamkan — coba lagi nanti */
      }
    }, 45000);
  }

  /** Pakai token bot baru: presence langsung nyambung, sisanya ikut saat mulai ulang. */
  function terapkanTokenBaru(tk) {
    botTokenMati = false;
    config.discordToken = tk;
    process.env.DISCORD_TOKEN = tk;
    try {
      gateway.setToken(tk);
    } catch (e) {
      log.warn('Discord: gagal menyambung ulang — ' + e.message);
    }
    // komponen lain (Spotify, penjaga status) baru ikut setelah mulai ulang;
    // tunggu quest yang sedang jalan selesai dulu supaya tidak terputus.
    const tunggu = setInterval(() => {
      if (shuttingDown || quest.aktif) return;
      clearInterval(tunggu);
      log.info('Mulai ulang bot sekarang agar semua komponen memakai token baru…');
      process.exit(1); // panel otomatis menjalankan ulang
    }, 5000);
    setTimeout(() => clearInterval(tunggu), 15 * 60000); // jangan menggantung selamanya
  }

  gateway.on('fatal', ({ code } = {}) => {
    if (botTokenMati) return;
    botTokenMati = true;
    log.error(`Discord: token bot DITOLAK (code ${code || '?'}) — token bot mati.`);
    log.error('MODE DARURAT: quest, scout, dan dashboard TETAP JALAN (presence/status/Spotify off).');
    log.error('Tempel token bot baru di dashboard -> kartu "Token bot" (atau lewat panel). Bot menyambung ulang sendiri.');
    // hemat & rapi: presence/status/Spotify dijeda sampai token baru dipasang
    // (dulu mereka menembak API tiap 30-60 dtk dan spam log 401 tanpa hasil)
    try { spotify.stop(); } catch { /* ignore */ }
    try { keeper.stop(); } catch { /* ignore */ }
    try { roblox.stop(); } catch { /* ignore */ }
    log.info('Presence/status/Spotify + Roblox dijeda dulu (butuh token bot) — hidup lagi setelah token baru dipasang.');
    mulaiCekToken();
  });

  /* ------------------------------ jalankan ---------------------------- */

  await keeper.init().catch((err) => log.warn('Penjaga status:', err.message));
  if (keeper.settingsPresenceStatus) {
    gateway.adoptPresenceStatus(keeper.settingsPresenceStatus, 'settings proto saat start', false);
  }
  if (config.ps5.enabled) {
    await ps5.start().catch((err) => log.warn('PS5:', err.message));
  } else {
    await roblox.start().catch((err) => log.warn('Roblox:', err.message));
  }
  await spotify.start().catch((err) => log.warn('Spotify:', err.message));
  quest.startOtomatis(); // otomatis tanpa tombol: cek & kerjakan sendiri
  gateway.start();
  dashboard.start();
  tunnel.start().catch((err) => log.warn('Tunnel:', err.message));
  scout.start().catch((err) => log.warn('Scout:', err.message));

  /* quest: kalau diminta, langsung kerjakan semua yang bisa dikerjakan */
  if (config.quest.autoStart) {
    setTimeout(() => {
      quest.autoMulai()
        .then((r) => {
          if (r.ok) log.info(`Quest OTOMATIS dinyalakan sendiri: ${r.jumlah} quest menunggu.`);
          else log.info('Quest otomatis: ' + r.error);
        })
        .catch((e) => log.warn('Quest otomatis: ' + e.message));
    }, 20000);
  }

  log.info('Berjalan... tekan Ctrl+C untuk berhenti (custom status tetap tersimpan).');

  /* ------------------------------ shutdown ---------------------------- */

  let shuttingDown = false;
  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Menghentikan...');
    log.info('Catatan: custom status TIDAK dihapus — tetap tersimpan di akun Discord.');
    if (cekTokenTimer) clearInterval(cekTokenTimer);
    try { gateway.stop(); } catch { /* ignore */ }
    try { spotify.stop(); } catch { /* ignore */ }
    try { roblox.stop(); } catch { /* ignore */ }
    try { keeper.stop(); } catch { /* ignore */ }
    try { quest.stop(); } catch { /* ignore */ }
    try { scout.stop(); } catch { /* ignore */ }
    try { dashboard.stop(); } catch { /* ignore */ }
    try { tunnel.stop(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 300);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Jangan biarkan error tak terduga mematikan keep-online
  process.on('unhandledRejection', (err) => log.warn('Unhandled rejection:', err && err.message ? err.message : err));
  process.on('uncaughtException', (err) => log.error('Uncaught exception:', err && err.stack ? err.stack : err));
}

main().catch((err) => {
  console.error('Gagal start:', err);
  process.exit(1);
});
