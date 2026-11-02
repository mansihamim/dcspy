'use strict';

/**
 * ============================================================================
 *  SpotifyPresence — "Listening to Spotify" real-time di profil Discord
 * ============================================================================
 *  Alur (sama seperti versi PHP, tapi versi Node.js):
 *   1. Ambil access token Spotify otomatis lewat Discord API
 *      (akun Discord kamu sudah di-link ke Spotify).
 *   2. Sambung ke dealer.spotify.com (real-time, tanpa polling).
 *   3. Daftarkan "device" palsu + subscribe connect-state -> dapat
 *      notifikasi lagu yang sedang diputar.
 *   4. Resolve metadata (judul/artis/album/cover) lewat Web API.
 *   5. Emit event 'change' -> index.js meminta gateway mengirim presence.
 *   6. Fallback polling /v1/me/player tiap SPOTIFY_POLL_SEC detik.
 * ============================================================================
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocketClient = require('./wsclient');
const { request } = require('./http');

const DEALER_URL = 'wss://dealer.spotify.com/';

function retryAfterMs(res) {
  const headers = res && res.headers ? res.headers : {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const raw = res && res.json && res.json.retry_after != null
    ? res.json.retry_after
    : (key ? headers[key] : null);
  const seconds = raw == null || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60_000, Math.max(5000, seconds * 1000 + 1000));
  const at = Date.parse(String(raw || ''));
  if (Number.isFinite(at)) return Math.min(15 * 60_000, Math.max(5000, at - Date.now() + 1000));
  return 30_000;
}

class SpotifyPresence extends EventEmitter {
  constructor({ discordToken, logger, cfg, apiVersion = 9, userAgent }) {
    super();
    this.discordToken = discordToken;
    this.log = logger;
    this.cfg = cfg;
    this.apiVersion = apiVersion;
    this.userAgent = userAgent;

    this.ws = null;
    this.connectionId = null;
    this.deviceId = null;
    this.token = null;
    this.tokenExp = 0;
    this.track = null;               // lagu yang sedang diputar (ternormalisasi)
    this.resolved = new Map();       // cache metadata: trackId -> info
    this.resolveRetryAt = 0;
    this.stoppedSince = null;        // timestamp saat "berhenti" terdeteksi (grace)
    this.pollDisabled = false;
    this.dealerUnsupported = false; // true = token tidak boleh daftar device (real-time mati, polling jalan)
    this.dealerConnected = false;
    this.dealerReady = false;
    this.lastDealerMsg = 0;
    this.lastDealerEventAt = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    this.timers = [];

    // Diagnostik + kendali polling supaya request lambat/429 tidak menumpuk.
    this.pollInFlight = false;
    this.pollBackoffUntil = 0;
    this.pollFailures = 0;
    this.lastPollAt = 0;
    this.lastPollOk = 0;
    this.lastPollStatus = null;
    this.lastPollError = '';
    this.lastTokenError = '';
    this.lastPlaybackUpdateAt = 0;
    this.lastClearReason = '';
    this.started = false;
  }

  /* ----------------------------- TOKEN SPOTIFY ---------------------------- */

  get headers() {
    return {
      Authorization: this.discordToken,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
    };
  }

  invalidateToken() {
    if (this.cfg.accessToken) return; // token manual tidak di-refresh
    this.token = null;
    this.tokenExp = 0;
  }

  /** Dealer hanya dianggap sehat bila state playback baru saja benar-benar diterima. */
  isDealerStateFresh(now = Date.now()) {
    const timeoutMs = Math.max(1, Number(this.cfg.dealerIdleTimeoutSec) || 45) * 1000;
    return Boolean(
      this.dealerReady && this.dealerConnected && this.ws &&
      this.ws.readyState === WebSocketClient.OPEN && this.lastDealerEventAt > 0 &&
      now - this.lastDealerEventAt < timeoutMs,
    );
  }

  /** Hapus activity yang sudah tidak bisa diverifikasi agar judul lama tidak menggantung. */
  clearTrack(reason = 'playback tidak tersedia') {
    const hadTrack = Boolean(this.track);
    this.track = null;
    this.stoppedSince = null;
    this.lastClearReason = String(reason || '').slice(0, 120);
    if (!hadTrack) return false;
    this.log.info('Spotify: presence lama dihapus (' + this.lastClearReason + ').');
    this.emit('change');
    return true;
  }

  markPlaybackStopped() {
    const now = Date.now();
    if (this.stoppedSince === null) this.stoppedSince = now;
    if (this.track && this.track.isPlaying !== false) {
      this.track.isPlaying = false;
      this.emit('change');
    }
  }

  /** Dipanggil oleh timer maupun saat polling gagal; fail closed pada data usang. */
  maintainPlayback(now = Date.now()) {
    if (!this.track) return false;
    const graceMs = Math.max(0, Number(this.cfg.stopGraceSec) || 0) * 1000;
    if (this.stoppedSince !== null && now - this.stoppedSince >= graceMs) {
      return this.clearTrack('playback berhenti');
    }
    const staleSec = Math.max(15, Number(this.cfg.staleAfterSec) || Math.max(60, (Number(this.cfg.pollSec) || 5) * 6));
    if (
      this.lastPlaybackUpdateAt > 0 && now - this.lastPlaybackUpdateAt >= staleSec * 1000 &&
      !this.isDealerStateFresh(now)
    ) {
      return this.clearTrack('data pemutaran kedaluwarsa');
    }
    return false;
  }

  logThrottled(message) {
    const now = Date.now();
    if (this._lastErrLog && now - this._lastErrLog < 60000) return;
    this._lastErrLog = now;
    this.log.warn(message);
  }

  /** Ambil token Spotify: manual (config) -> otomatis lewat Discord API. */
  async getToken() {
    if (this.cfg.accessToken) {
      this.lastTokenError = '';
      return this.cfg.accessToken;
    }
    if (this.token && this.tokenExp > Date.now() + 60000) {
      this.lastTokenError = '';
      return this.token;
    }

    const conns = await request('GET', `https://discord.com/api/v${this.apiVersion}/users/@me/connections`, {
      headers: this.headers,
    });
    if (conns.status !== 200) {
      this.lastTokenError = `Discord connections HTTP ${conns.status || 0}`;
      this.logThrottled(`Spotify token: gagal ambil koneksi Discord (HTTP ${conns.status}${conns.error ? ' ' + conns.error : ''})`);
      return null;
    }

    const list = Array.isArray(conns.json) ? conns.json : [];
    const spotifyConn = list.find((c) => c && c.type === 'spotify');
    if (!spotifyConn) {
      this.lastTokenError = 'Koneksi Spotify tidak tertaut di Discord';
      this.logThrottled(
        'Tidak ada koneksi Spotify di akun Discord ini. Link dulu: Discord → User Settings → Connections → Spotify.',
      );
      return null;
    }

    const res = await request(
      'GET',
      `https://discord.com/api/v${this.apiVersion}/users/@me/connections/spotify/${spotifyConn.id}/access-token`,
      { headers: this.headers },
    );
    if (res.status !== 200) {
      this.lastTokenError = `Discord access-token HTTP ${res.status || 0}`;
      this.logThrottled(`Spotify token: gagal ambil access-token (HTTP ${res.status})`);
      return null;
    }
    const token = res.json && res.json.access_token;
    if (!token) {
      this.lastTokenError = 'access_token Spotify kosong dari Discord';
      this.logThrottled('Spotify token: access_token kosong dari Discord.');
      return null;
    }

    this.token = token;
    this.tokenExp = Date.now() + 50 * 60 * 1000; // token Spotify ~1 jam, cache 50 menit
    this.lastTokenError = '';
    this.log.info(`Spotify token didapat (akun: ${spotifyConn.name || '?'})`);
    return token;
  }

  /* ------------------------------ METADATA ------------------------------- */

  /** Ambil judul/artis/album/cover/durasi sebuah track (dicache). */
  async resolveTrack(trackId) {
    if (this.resolved.has(trackId)) return this.resolved.get(trackId);

    let token = await this.getToken();
    if (!token) return null;

    const url = `https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(trackId)}&market=from_token`;
    let res = await request('GET', url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 401) {
      this.invalidateToken();
      token = await this.getToken();
      if (token) res = await request('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (res.status !== 200) return null;

    const t = res.json && Array.isArray(res.json.tracks) ? res.json.tracks[0] : null;
    if (!t) return null;

    const imgUrl = t.album?.images?.[0]?.url || '';
    const info = {
      title: t.name || 'Unknown',
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name || '',
      imageId: imgUrl ? imgUrl.slice(imgUrl.lastIndexOf('/') + 1) : '',
      durationMs: Number(t.duration_ms || 0),
    };

    if (this.resolved.size > 50) this.resolved.delete(this.resolved.keys().next().value);
    this.resolved.set(trackId, info);
    return info;
  }

  /** Resolve track yang sedang diputar (dengan backoff, tidak pernah pakai judul lama). */
  async tryResolveCurrentTrack() {
    const track = this.track;
    if (!track || !track.needsResolve) return;
    if (Date.now() < this.resolveRetryAt) return;
    this.resolveRetryAt = Date.now() + this.cfg.resolveRetrySec * 1000;

    const info = await this.resolveTrack(track.uri.slice('spotify:track:'.length));
    if (!info) return; // gagal -> coba lagi nanti

    const t = this.track;
    if (!t || t.uri !== track.uri) return; // lagu sudah berganti saat resolve

    t.title = info.title;
    t.artist = info.artist;
    t.album = info.album;
    if (info.imageId) t.imageId = info.imageId;
    if (info.durationMs) {
      t.durationMs = info.durationMs;
      t.endMs = t.startMs + info.durationMs;
    }
    t.needsResolve = false;
    this.log.info(`Spotify: ${info.title} — ${info.artist} (${info.album})`);
    this.emit('change');
  }

  /* ------------------------------- DEALER -------------------------------- */

  async connectDealer() {
    if (this.stopped) return;
    const token = await this.getToken();
    if (!token) {
      this.scheduleDealerReconnect(20000);
      return;
    }

    let ws;
    try {
      ws = new WebSocketClient(`${DEALER_URL}?access_token=${encodeURIComponent(token)}`, {
        headers: {
          'User-Agent': this.userAgent,
          Origin: 'https://open.spotify.com',
        },
        handshakeTimeout: 20000,
      });
    } catch (err) {
      this.log.warn('Spotify dealer: gagal membuat koneksi —', err.message);
      this.scheduleDealerReconnect(15000);
      return;
    }

    this.ws = ws;
    this.connectionId = null;
    this.deviceId = null;
    this.dealerConnected = false;
    this.dealerReady = false;

    ws.on('open', () => {
      this.lastDealerMsg = Date.now();
      this.dealerConnected = true;
      this.dealerReady = false;
      this.log.info('Spotify dealer: terhubung');
    });

    ws.on('message', (data) => {
      this.lastDealerMsg = Date.now();
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      this.handleDealerMessage(msg).catch((err) => this.log.warn('Spotify dealer:', err.message));
    });

    ws.on('error', (err) => {
      this.log.warn('Spotify dealer: error —', err.message);
    });

    ws.on('close', (code) => {
      this.log.info(`Spotify dealer: koneksi tertutup (code ${code})`);
      if (this.ws === ws) {
        this.ws = null;
        this.dealerConnected = false;
        this.dealerReady = false;
      }
      this.invalidateToken();
      this.scheduleDealerReconnect(5000);
    });
  }

  scheduleDealerReconnect(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const attempt = this.reconnectAttempts++;
    const backoff = Math.min(60000, Math.max(5000, Number(delayMs) || 5000) * (2 ** Math.min(attempt, 4)));
    const delay = backoff + Math.floor(Math.random() * 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectDealer().catch((err) => {
        this.log.warn('Spotify dealer: error saat reconnect —', err.message);
        this.scheduleDealerReconnect(15000);
      });
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  dealerSend(obj) {
    if (!this.ws || this.ws.readyState !== WebSocketClient.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  async handleDealerMessage(msg) {
    if (msg.type === 'pong') return;

    if (this.cfg.debugDealer) {
      this.log.debug('[dealer] ' + JSON.stringify(msg).slice(0, 400));
    }

    if (msg.type !== 'message') return;

    const uri = msg.uri || '';
    const headers = msg.headers || {};

    // 1. connection id
    if (uri.includes('pusher/v1/connections') || headers['Spotify-Connection-Id']) {
      const cid = headers['Spotify-Connection-Id'];
      if (cid && cid !== this.connectionId) {
        this.log.info(`Spotify connection id: ${cid}`);
        await this.setupDealer(cid);
      }
    }

    // 2. update connect-state
    if (uri.includes('connect-state')) {
      this.lastDealerEventAt = Date.now();
      for (const cluster of extractClusters(msg)) {
        this.parseCluster(cluster);
      }
    }
  }

  /** Daftarkan device palsu + subscribe connect-state, lalu parse cluster awal. */
  async setupDealer(cid) {
    this.connectionId = cid;

    const token = await this.getToken();
    if (!token) return;

    const deviceId = crypto.randomBytes(20).toString('hex');
    this.deviceId = deviceId;

    const authJson = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://open.spotify.com',
      Referer: 'https://open.spotify.com/',
    };

    // (opsional) subscribe notifikasi user — kalau gagal, tidak fatal
    await request(
      'PUT',
      `https://api.spotify.com/v1/me/notifications/user?connection_id=${encodeURIComponent(cid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // 1) daftarkan fake device
    const device = {
      brand: 'spotify',
      capabilities: {
        audio_podcasts: true,
        change_volume: true,
        disable_connect: false,
        enable_play_token: true,
        manifest_formats: ['file_urls_mp3', 'manifest_ids_video', 'file_urls_external', 'file_ids_mp4', 'file_ids_mp4_dual'],
        play_token_lost_behavior: 'pause',
        supports_file_media_type: true,
        video_playback: true,
      },
      device_id: deviceId,
      device_type: 'computer',
      metadata: {},
      model: 'web_player',
      name: 'Discord',
      platform_identifier: 'web_player',
    };

    const regBody = JSON.stringify({
      client_version: 'harmony:4.21.0-a4bc573',
      connection_id: cid,
      device,
      outro_endcontent_snooping: false,
      volume: 65535,
    });

    // Spotify beberapa kali memindahkan/membatasi endpoint ini, jadi kita coba
    // beberapa host sebelum menyerah ke mode polling.
    const REG_HOSTS = [
      'https://guc-spclient.spotify.com',
      'https://api.spotify.com/v1',
    ];
    let regHost = null;
    let lastStatus = 0;
    for (const host of REG_HOSTS) {
      const reg = await request('POST', `${host}/track-playback/v1/devices`, { headers: authJson, body: regBody });
      lastStatus = reg.status;
      if (reg.status === 200) { regHost = host; break; }
    }

    if (!regHost) {
      // Token hasil Discord tidak diizinkan mendaftarkan device (biasanya 403).
      // Bukan masalah: presence tetap jalan lewat polling /me/player.
      this.dealerUnsupported = true;
      this.dealerReady = false;
      this.log.info(
        `Spotify: mode real-time (dealer) tidak didukung token ini (HTTP ${lastStatus}) — ` +
          `pakai mode polling ${this.cfg.pollSec}s, lagu tetap tampil di profil.`,
      );
      return;
    }

    // 2) subscribe connect-state (dapat cluster awal)
    this.log.info(`Spotify: device terdaftar via ${regHost.replace('https://', '')}`);

    // 2) subscribe connect-state (dapat cluster awal + update real-time).
    //    Host-nya mengikuti region dealer (mis. "ip.gue1.spotify.net" -> gue1).
    const region = regionFromConnectionId(cid);
    const csHosts = [...new Set([
      region ? `https://${region}-spclient.spotify.com` : null,
      'https://guc3-spclient.spotify.com',
      'https://gew1-spclient.spotify.com',
      regHost,
    ].filter(Boolean))];

    let cluster = null;
    for (const host of csHosts) {
      const sub = await request('PUT', `${host}/connect-state/v1/devices/hobs_${deviceId}`, {
        headers: { ...authJson, 'x-spotify-connection-id': cid },
        body: JSON.stringify({
          device: {
            device_info: { capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true } },
          },
          member_type: 'CONNECT_STATE',
        }),
      });
      if (sub.status === 200) {
        cluster = sub.json;
        this.log.info(`Spotify: mode real-time AKTIF (connect-state via ${host.replace('https://', '')})`);
        break;
      }
      this.log.debug(`Spotify: connect-state ${host.replace('https://', '')} -> HTTP ${sub.status}`);
    }

    if (!cluster) {
      this.dealerUnsupported = true;
      this.dealerReady = false;
      this.log.info(
        `Spotify: update real-time tidak tersedia untuk token ini — pakai polling ${this.cfg.pollSec}s ` +
          '(lagu & progress tetap akurat).',
      );
      return;
    }

    this.dealerUnsupported = false;
    this.dealerReady = true;
    this.lastDealerEventAt = Date.now();
    this.reconnectAttempts = 0;
    if (cluster.player_state) this.parseCluster(cluster);
  }

  /* --------------------------- PARSING CLUSTER ---------------------------- */

  parseCluster(cluster) {
    const ps = cluster.player_state || null;
    const track = ps && ps.track ? ps.track : null;

    // Sinyal OTORITATIF "berhenti": cek paling awal, karena player_state
    // sering masih menyimpan lagu terakhir saat playback dihentikan.
    if (cluster.not_playing_since_timestamp) {
      this.lastPlaybackUpdateAt = Date.now();
      this.markPlaybackStopped();
      return;
    }

    if (!track || !track.uri) return; // state parsial -> biarkan apa adanya

    this.lastPlaybackUpdateAt = Date.now();
    const uri = track.uri;
    if (!uri.startsWith('spotify:track:')) {
      // Podcast/episode/ad bukan lagu; jangan biarkan track lama tertahan.
      this.markPlaybackStopped();
      return;
    }

    this.stoppedSince = null;

    const metadata = track.metadata || {};
    const imgUrl = metadata.image_xlarge_url || metadata.image_url || '';
    const imageId = imgUrl ? imgUrl.slice(imgUrl.lastIndexOf('/') + 1) : '';

    const duration = Number(ps.duration || 0);
    const posAsOf = Number(ps.position_as_of_timestamp || 0);
    const ts = Number(ps.timestamp || 0);
    const paused = Boolean(ps.is_paused);

    let position = paused ? posAsOf : ts > 0 ? posAsOf + (Date.now() - ts) : posAsOf;
    if (position < 0) position = 0;
    if (duration > 0 && position > duration) position = duration;

    const prev = this.track;
    const isNew = !prev || prev.uri !== uri;

    if (isNew) {
      const startMs = Date.now() - position;
      this.track = {
        uri,
        title: '',
        artist: '',
        album: '',
        imageId,
        durationMs: duration,
        positionMs: position,
        startMs,
        endMs: duration > 0 ? startMs + duration : 0,
        isPlaying: !paused,
        needsResolve: true,
      };
      this.stoppedSince = paused ? Date.now() : null;
      this.lastClearReason = '';
      this.log.debug(`Spotify: track baru ${uri}`);
      this.resolveRetryAt = 0;
      this.tryResolveCurrentTrack().catch(() => {});
      this.emit('change');
      return;
    }

    // lagu yang sama -> update posisi & status saja
    const t = this.track;
    const wasPlaying = Boolean(t.isPlaying);
    if (imageId) t.imageId = imageId;
    if (duration > 0) t.durationMs = duration;
    t.isPlaying = !paused;
    if (!paused) {
      t.positionMs = position;
      t.startMs = Date.now() - position;
      if (duration > 0) t.endMs = t.startMs + duration;
      this.stoppedSince = null;
    } else if (this.stoppedSince === null) {
      this.stoppedSince = Date.now();
    }
    if (wasPlaying !== t.isPlaying) this.emit('change');
    if (t.needsResolve) this.tryResolveCurrentTrack().catch(() => {});
  }

  /* ------------------------------- POLLING -------------------------------- */

  /**
   * Jaring pengaman kalau update dealer terlewat. Pakai /me/player supaya bisa
   * membedakan: 204 = benar-benar berhenti, "ad" = iklan, 200+item = ada lagu.
   */
  async poll() {
    if (this.stopped || this.pollDisabled || this.pollInFlight) return;
    const now = Date.now();
    if (now < this.pollBackoffUntil) return;

    // Ping/pong hanya membuktikan socket hidup, bukan state lagu masih mengalir.
    // Poll lagi bila update connect-state sudah stale, meskipun Dealer masih menjawab ping.
    if (this.isDealerStateFresh(now)) return;

    this.pollInFlight = true;
    this.lastPollAt = now;
    this.lastPollError = '';
    const failWithBackoff = (status, message, minimumMs = 0) => {
      this.pollFailures += 1;
      this.lastPollStatus = Number(status) || 0;
      this.lastPollError = message;
      const exponential = Math.min(60000, 5000 * (2 ** Math.min(this.pollFailures - 1, 4)));
      this.pollBackoffUntil = Math.max(this.pollBackoffUntil, Date.now() + Math.max(minimumMs, exponential));
    };

    try {
      const token = await this.getToken();
      if (this.stopped) return;
      if (!token) {
        const tokenError = this.lastTokenError || 'token Spotify tidak tersedia';
        if (/HTTP 401\b/.test(tokenError)) this.clearTrack('autentikasi Discord ditolak');
        else this.maintainPlayback(Date.now());
        failWithBackoff(/HTTP 401\b/.test(tokenError) ? 401 : 0, tokenError);
        return;
      }

      const res = await request('GET', 'https://api.spotify.com/v1/me/player', {
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 15000,
      });
      if (this.stopped) return;
      this.lastPollStatus = Number(res && res.status) || 0;

      if (res.status === 401) {
        this.invalidateToken();
        this.clearTrack('token Spotify ditolak; lagu lama tidak dapat diverifikasi');
        failWithBackoff(401, 'HTTP 401 — token perlu diperbarui', 5000);
        return;
      }
      if (res.status === 403) {
        this.pollDisabled = true;
        this.pollFailures += 1;
        this.lastPollError = 'HTTP 403 — /me/player tidak diizinkan untuk token ini';
        this.clearTrack('akses pemutaran tidak diizinkan');
        this.log.info('Spotify: /me/player tidak didukung token ini (polling dimatikan).');
        return;
      }
      if (res.status === 429) {
        const retryMs = retryAfterMs(res);
        failWithBackoff(429, `HTTP 429 — tunggu ${Math.ceil(retryMs / 1000)}s`, retryMs);
        this.logThrottled(`Spotify polling kena rate limit; jeda ${Math.ceil(retryMs / 1000)} detik sebelum mencoba lagi.`);
        return;
      }
      if (res.status === 204) {
        this.pollFailures = 0;
        this.lastPollError = '';
        this.lastPollOk = Date.now();
        this.lastPlaybackUpdateAt = Date.now();
        this.pollBackoffUntil = 0;
        this.markPlaybackStopped();
        return;
      }
      if (res.status !== 200 || !res.json) {
        const error = `HTTP ${res.status || 0}${res.error ? ` — ${res.error}` : ''}`;
        this.maintainPlayback(Date.now());
        failWithBackoff(res.status, error);
        this.logThrottled(`Spotify polling gagal (${error}); akan mencoba lagi otomatis.`);
        return;
      }

      this.pollFailures = 0;
      this.lastPollError = '';
      this.lastPollOk = Date.now();
      this.pollBackoffUntil = 0;
      const j = res.json;
      const type = j.currently_playing_type || 'track';

      if (type === 'ad') {
        this.lastPlaybackUpdateAt = Date.now();
        this.stoppedSince = null; // iklan bukan "berhenti"
        return;
      }

      const item = j.item;
      if (!item) {
        this.lastPlaybackUpdateAt = Date.now();
        this.markPlaybackStopped();
        return;
      }

      const uri = item.uri || '';
      if (!uri.startsWith('spotify:track:')) {
        // Jangan terus menampilkan lagu lama saat pengguna pindah ke podcast/episode.
        this.lastPlaybackUpdateAt = Date.now();
        this.markPlaybackStopped();
        return;
      }

      const imgUrl = item.album?.images?.[0]?.url || '';
      const imageId = imgUrl ? imgUrl.slice(imgUrl.lastIndexOf('/') + 1) : '';
      const duration = Number(item.duration_ms || 0);
      const progress = Number(j.progress_ms || 0);
      const playing = Boolean(j.is_playing);

      const prev = this.track;
      if (!prev || prev.uri !== uri) {
        const startMs = Date.now() - progress;
        this.track = {
          uri,
          title: item.name || '',
          artist: (item.artists || []).map((a) => a.name).join(', '),
          album: item.album?.name || '',
          imageId,
          durationMs: duration,
          positionMs: progress,
          startMs,
          endMs: duration > 0 ? startMs + duration : 0,
          isPlaying: playing,
          needsResolve: false,
        };
        this.lastPlaybackUpdateAt = Date.now();
        this.stoppedSince = playing ? null : Date.now();
        this.lastClearReason = '';
        this.log.info(`Spotify: ${this.track.title} — ${this.track.artist}`);
        this.emit('change');
        return;
      }

      const t = this.track;
      const wasPlaying = Boolean(t.isPlaying);
      if (playing) {
        t.positionMs = progress;
        t.startMs = Date.now() - progress;
        if (duration > 0) t.endMs = t.startMs + duration;
      }
      t.isPlaying = playing;
      this.lastPlaybackUpdateAt = Date.now();
      if (playing) this.stoppedSince = null;
      else if (this.stoppedSince === null) this.stoppedSince = Date.now();
      if (wasPlaying !== playing) this.emit('change');
      if (t.needsResolve) this.tryResolveCurrentTrack().catch(() => {});
    } catch (err) {
      if (this.stopped) return;
      const message = String(err && err.message ? err.message : err).slice(0, 180);
      this.maintainPlayback(Date.now());
      failWithBackoff(0, message);
      this.logThrottled(`Spotify polling error (${message}); akan mencoba lagi otomatis.`);
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Status aman untuk dashboard; tidak pernah mengembalikan access token. */
  status() {
    const now = Date.now();
    const track = this.track
      ? {
          title: this.track.title || '',
          artist: this.track.artist || '',
          album: this.track.album || '',
          isPlaying: Boolean(this.track.isPlaying),
        }
      : null;
    const dealerHealthy = Boolean(
      this.dealerReady && this.dealerConnected && this.ws && this.ws.readyState === WebSocketClient.OPEN,
    );
    const dealerFresh = this.isDealerStateFresh(now);
    const pollingEnabled = Boolean(this.cfg.enabled && !this.pollDisabled);
    return {
      enabled: Boolean(this.cfg.enabled),
      source: dealerFresh ? 'dealer' : (pollingEnabled ? 'polling' : (this.cfg.enabled ? 'unavailable' : 'off')),
      tokenAvailable: Boolean(this.cfg.accessToken || (this.token && this.tokenExp > now)),
      tokenError: this.lastTokenError,
      dealer: {
        connected: Boolean(this.dealerConnected && this.ws && this.ws.readyState === WebSocketClient.OPEN),
        ready: dealerHealthy,
        fresh: dealerFresh,
        unsupported: Boolean(this.dealerUnsupported),
        reconnectPending: Boolean(this.reconnectTimer),
        lastMessageAt: this.lastDealerMsg,
        lastEventAt: this.lastDealerEventAt,
      },
      polling: {
        enabled: pollingEnabled,
        intervalSec: Number(this.cfg.pollSec || 0),
        inFlight: this.pollInFlight,
        lastAttemptAt: this.lastPollAt,
        lastSuccessAt: this.lastPollOk,
        lastStatus: this.lastPollStatus,
        failures: this.pollFailures,
        backoffUntil: this.pollBackoffUntil,
        backoffSec: Math.max(0, Math.ceil((this.pollBackoffUntil - now) / 1000)),
        lastError: this.lastPollError,
      },
      playing: Boolean(track && track.isPlaying),
      track,
      playbackDataAgeSec: this.lastPlaybackUpdateAt
        ? Math.max(0, Math.floor((now - this.lastPlaybackUpdateAt) / 1000))
        : null,
      lastClearReason: this.lastClearReason,
    };
  }

  /* ------------------------------- PRESENCE ------------------------------- */

  /**
   * Spotify activity yang dapat dibuka dari profil Discord.
   * sync_id harus berupa Spotify track ID mentah, bukan URI; party memakai
   * Discord user ID. session_id tidak dikirim karena Discord mengelolanya.
   */
  currentActivity({ discordUserId } = {}) {
    const t = this.track;
    if (!t) return null;
    if (!t.isPlaying) {
      const graceMs = Math.max(0, Number(this.cfg.stopGraceSec) || 0) * 1000;
      if (this.stoppedSince === null || Date.now() - this.stoppedSince >= graceMs) return null;
    }

    const act = { name: 'Spotify', type: 2, flags: 48 }; // SYNC | PLAY
    if (t.title) act.details = t.title;
    if (t.artist) act.state = t.artist;

    const assets = {};
    if (t.imageId) assets.large_image = `spotify:${t.imageId}`;
    if (t.album) assets.large_text = t.album;
    if (Object.keys(assets).length) act.assets = assets;

    const accountId = String(discordUserId || '').trim();
    if (/^\d{16,22}$/.test(accountId)) act.party = { id: `spotify:${accountId}` };

    const ts = {};
    if (t.startMs) ts.start = Math.floor(t.startMs);
    if (t.endMs && t.endMs > t.startMs) ts.end = Math.floor(t.endMs);
    if (Object.keys(ts).length) act.timestamps = ts;

    const syncId = /^spotify:track:([A-Za-z0-9]{22})$/.exec(String(t.uri || '').trim())?.[1];
    if (syncId) act.sync_id = syncId;
    return act;
  }

  /* --------------------------------- MULAI -------------------------------- */

  async start() {
    if (this.started || !this.cfg.enabled) {
      if (!this.cfg.enabled) this.log.info('Spotify: nonaktif (ENABLE_SPOTIFY=false).');
      return;
    }
    this.started = true;
    this.stopped = false;
    this.pollDisabled = false;
    this.pollBackoffUntil = 0;
    this.pollFailures = 0;
    this.lastPollError = '';
    if (this.cfg.accessToken) {
      this.log.info('Spotify: memakai SPOTIFY_ACCESS_TOKEN manual.');
    }

    await this.connectDealer().catch((err) => {
      this.log.warn('Spotify dealer: gagal memulai koneksi —', err.message);
      this.scheduleDealerReconnect(15000);
    });

    // ping dealer tiap 15s + deteksi dealer mati (tidak ada pesan > 45s)
    this.timers.push(
      setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocketClient.OPEN) return;
        this.dealerSend({ type: 'ping' });
        if (this.lastDealerMsg && Date.now() - this.lastDealerMsg > this.cfg.dealerIdleTimeoutSec * 1000) {
          this.log.warn('Spotify dealer: tidak ada pesan — reconnect.');
          try { this.ws.terminate(); } catch { /* ignore */ }
        }
      }, this.cfg.dealerPingSec * 1000),
    );

    // Hapus presence saat playback berhenti atau data terlalu lama tidak bisa diverifikasi.
    this.timers.push(setInterval(() => this.maintainPlayback(), 1000));

    // fallback polling
    this.timers.push(
      setInterval(() => {
        this.poll().catch(() => {});
      }, this.cfg.pollSec * 1000),
    );
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.clearTrack('pemantauan dijeda');
    this.dealerConnected = false;
    this.dealerReady = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

/* ------------------------------ UTIL DEALER ------------------------------ */

/**
 * Connection id dari dealer berbentuk base64 yang isinya antara lain
 * "...+dealer+tcp://0ab140fa.ip.gue1.spotify.net:5700+...".
 * Region (gue1/gew1/...) dipakai untuk memilih host connect-state yang benar.
 */
function regionFromConnectionId(cid) {
  try {
    const decoded = Buffer.from(String(cid), 'base64').toString('utf8');
    const m = /ip\.([a-z]{3}\d)\.spotify\.net/i.exec(decoded) || /([a-z]{3}\d)-spclient/i.exec(decoded);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Normalisasi satu item payload dealer (bisa string JSON / base64 / object). */
function normalizePayloadItem(item) {
  if (item && typeof item === 'object') {
    if (Object.prototype.hasOwnProperty.call(item, 'body')) {
      const body = item.body;
      if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { /* lanjut ke base64 */ }
        try { return JSON.parse(Buffer.from(body, 'base64').toString('utf8')); } catch { return null; }
      }
      return body && typeof body === 'object' ? body : null;
    }
    return item;
  }
  if (typeof item === 'string') {
    try { return JSON.parse(item); } catch { /* lanjut */ }
    try { return JSON.parse(Buffer.from(item, 'base64').toString('utf8')); } catch { return null; }
  }
  return null;
}

/** Ambil semua cluster connect-state dari satu pesan dealer. */
function extractClusters(msg) {
  const out = [];
  const payload = msg.payloads || msg.payload || null;
  if (!payload || typeof payload !== 'object') return out;

  // kadang payload-nya sudah berupa objek cluster
  if (payload.player_state || payload.devices || payload.not_playing_since_timestamp) {
    out.push(payload);
    return out;
  }

  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const obj = normalizePayloadItem(item);
    if (!obj) continue;
    if (obj.cluster && typeof obj.cluster === 'object') out.push(obj.cluster);
    else if (obj.player_state || obj.devices || obj.not_playing_since_timestamp) out.push(obj);
  }
  return out;
}

module.exports = { SpotifyPresence, extractClusters, normalizePayloadItem, regionFromConnectionId };
