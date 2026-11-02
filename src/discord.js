'use strict';

/**
 * ============================================================================
 *  DiscordGateway — koneksi gateway Discord (v9) untuk user token
 * ============================================================================
 *  Fungsi:
 *   - IDENTIFY (op 2) -> akun ONLINE
 *   - HEARTBEAT (op 1) + watchdog ACK
 *   - PRESENCE UPDATE (op 3) -> status (online/idle/dnd) + activities
 *     (Spotify "Listening to ..." dan/atau Custom Status)
 *   - Auto reconnect + backoff, resume sederhana (identify ulang)
 *   - Event USER_SETTINGS_PROTO_UPDATE diteruskan ke StatusKeeper
 *
 *  ⚠ Self-bot melanggar ToS Discord. Pakai risiko sendiri, jangan akun utama.
 * ============================================================================
 */

const { EventEmitter } = require('events');
const WebSocketClient = require('./wsclient');
const proto = require('./proto');

const GATEWAY_URL = 'wss://gateway.discord.gg/';

/** Kode close yang tidak ada gunanya di-retry. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const CLOSE_REASONS = {
  4000: 'Unknown error',
  4001: 'Unknown opcode',
  4002: 'Decode error',
  4003: 'Not authenticated',
  4004: 'Authentication failed (token salah / invalid)',
  4005: 'Already authenticated',
  4007: 'Invalid seq',
  4008: 'Rate limited',
  4009: 'Session timed out',
  4010: 'Invalid shard',
  4011: 'Sharding required',
  4012: 'Invalid API version',
  4013: 'Invalid intent(s)',
  4014: 'Disallowed intent(s)',
};

const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);

function normalizePresenceStatus(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'offline') return 'invisible';
  return VALID_PRESENCE_STATUSES.has(status) ? status : null;
}

/** Keep activity diagnostics useful without storing track titles or identifiers. */
function summarizeActivities(activities) {
  return (Array.isArray(activities) ? activities : []).slice(0, 10).map((activity) => {
    const isSpotify = activity && activity.name === 'Spotify' && Number(activity.type) === 2;
    const summary = {
      name: String(activity && activity.name || '').slice(0, 40),
      type: Number.isFinite(Number(activity && activity.type)) ? Number(activity.type) : null,
    };
    if (isSpotify) {
      summary.syncIdPresent = Boolean(activity.sync_id);
      summary.partyIdPresent = Boolean(activity.party && activity.party.id);
      summary.sessionIdPresent = Boolean(activity.session_id);
    }
    return summary;
  });
}

function summarizeSessionPresence(session) {
  const activities = Array.isArray(session && session.activities) ? session.activities : [];
  const spotify = activities.find((activity) => activity && activity.name === 'Spotify' && Number(activity.type) === 2);
  return {
    at: Date.now(),
    status: normalizePresenceStatus(session && session.status),
    activityNames: summarizeActivities(activities).map((activity) => activity.name),
    spotifyPresent: Boolean(spotify),
    spotifySyncIdPresent: Boolean(spotify && spotify.sync_id),
    spotifyPartyIdPresent: Boolean(spotify && spotify.party && spotify.party.id),
  };
}

class DiscordGateway extends EventEmitter {
  constructor({ token, logger, userAgent, apiVersion = 9, presenceRefreshSec = 15, presenceStatus = 'dnd', properties = null }) {
    super();
    this.token = token;
    this.log = logger;
    this.userAgent = userAgent;
    /** properties IDENTIFY -> menentukan akun terlihat dari PC/HP di profil */
    this.properties = properties || { os: 'Mac OS X', browser: 'Discord Client', device: '' };
    this.apiVersion = apiVersion;
    this.presenceRefreshSec = presenceRefreshSec;
    this.presenceStatus = normalizePresenceStatus(presenceStatus) || 'dnd';
    this.presenceStatusSource = 'config';
    this.lastStatusSyncAt = 0;
    this.pendingSessionsReplace = null;
    this.lastPresenceSentAt = 0;
    this.lastPresenceSentSummary = [];
    this.lastOwnSessionPresence = null;
    this.lastAggregatePresence = null;

    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.identified = false;
    this.hbInterval = 41250;
    this.hbTimer = null;
    this.lastAck = 0;
    this.lastBeatSent = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.identifyRetryTimer = null;
    this.watchdogTimer = null;
    this.presenceTimer = null;
    this.stopped = false;

    /** Fungsi yang mengembalikan array activities saat presence dikirim. */
    this.presenceProvider = () => [];
    this.pushRequested = false;
  }

  /**
   * Ganti token saat bot sedang jalan (dipakai mode darurat kalau token lama
   * ditolak Discord). Menyambung ulang memakai token baru tanpa restart.
   */
  setToken(t) {
    if (!t) return false;
    this.token = t;
    this.stopped = false;
    this.reconnectAttempts = 0;
    try {
      if (this.ws) this.ws.close(1000, 'ganti-token');
    } catch {
      /* abaikan */
    }
    this.connect();
    return true;
  }

  setPresenceProvider(fn, status = this.presenceStatus) {
    this.presenceProvider = typeof fn === 'function' ? fn : () => [];
    this.presenceStatus = normalizePresenceStatus(status) || this.presenceStatus;
  }

  /** Terapkan status baru dan beritahu pemilik proses agar menyimpannya. */
  adoptPresenceStatus(value, source = 'Discord app', push = true) {
    const status = normalizePresenceStatus(value);
    if (!status) return false;
    if (status === this.presenceStatus) {
      this.presenceStatusSource = source;
      this.lastStatusSyncAt = Date.now();
      return false;
    }

    const previous = this.presenceStatus;
    this.presenceStatus = status;
    this.presenceStatusSource = source;
    this.lastStatusSyncAt = Date.now();
    this.log.info(`Status Discord mengikuti aplikasi: ${previous} → ${status}.`);
    if (push) this.sendPresence();
    this.emit('statusChange', { previous, status, source, at: this.lastStatusSyncAt });
    return true;
  }

  /**
   * SESSIONS_REPLACE memuat status per sesi akun. Ikuti sesi aplikasi lain,
   * bukan sesi VPS sendiri; statusnya lalu diterapkan hanya ke sesi VPS.
   */
  syncFromSessions(payload, push = true) {
    if (!this.sessionId) return false;
    const sessions = Array.isArray(payload)
      ? payload
      : (payload && Array.isArray(payload.sessions) ? payload.sessions : []);
    const sessionIdOf = (session) => String(session && (session.session_id || session.sessionId) || '');
    const ownSession = sessions.find((session) => sessionIdOf(session) === String(this.sessionId));
    const aggregateSession = sessions.find((session) => sessionIdOf(session).toLowerCase() === 'all');
    if (ownSession) this.lastOwnSessionPresence = summarizeSessionPresence(ownSession);
    if (aggregateSession) this.lastAggregatePresence = summarizeSessionPresence(aggregateSession);

    const candidates = sessions.filter((session) => {
      if (!session || typeof session !== 'object') return false;
      const id = String(session.session_id || session.sessionId || '');
      // The synthetic "all" session is an aggregate for every client, not an app session.
      if (!id || id.toLowerCase() === 'all' || id === String(this.sessionId)) return false;
      if (session.active === false) return false;
      return Boolean(normalizePresenceStatus(session.status));
    });
    if (!candidates.length) return false;

    const session = candidates.find((item) => item.active === true) || candidates[0];
    const clientInfo = session.client_info || session.clientInfo || {};
    const client = String(clientInfo.client || 'Discord app');
    const os = String(clientInfo.os || '');
    const source = `SESSIONS_REPLACE (${client}${os ? `/${os}` : ''})`;
    return this.adoptPresenceStatus(session.status, source, push);
  }

  /* --------------------------------- MULAI ------------------------------- */

  start() {
    this.stopped = false;
    this.connect();

    this.watchdogTimer = setInterval(() => this.watchdog(), 15000);
    this.presenceTimer = setInterval(() => {
      if (!this.identified) return;
      this.sendPresence();
    }, Math.max(5, this.presenceRefreshSec) * 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdogTimer);
    clearInterval(this.presenceTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.identifyRetryTimer);
    this.identifyRetryTimer = null;
    clearInterval(this.hbTimer);
    this.identified = false;
    if (this.ws) {
      try { this.ws.close(1000, 'shutdown'); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.identifyRetryTimer);
    this.identifyRetryTimer = null;

    const url = `${GATEWAY_URL}?v=${this.apiVersion}&encoding=json`;
    this.log.debug('Discord: menyambung ke gateway...');

    let ws;
    try {
      ws = new WebSocketClient(url, {
        headers: {
          'User-Agent': this.userAgent,
          Origin: 'https://discord.com',
        },
        handshakeTimeout: 20000,
      });
    } catch (err) {
      this.log.warn('Discord: gagal membuat koneksi —', err.message);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;
    this.identified = false;
    this.seq = null;
    this.sessionId = null;
    this.pendingSessionsReplace = null;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.log.debug('Discord: socket terbuka, menunggu HELLO...');
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      let payload;
      try {
        payload = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      try {
        this.handlePayload(payload);
      } catch (err) {
        this.log.warn('Discord: error memproses payload —', err.message);
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.log.warn('Discord: error koneksi —', err.message);
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
      const list = CLOSE_REASONS[code] ? ` (${CLOSE_REASONS[code]})` : '';
      this.log.warn(`Discord: koneksi tertutup — code ${code}${list}${reason ? ` : ${reason}` : ''}`);
      // A replaced socket may close after the new socket has already connected.
      // Its late close must not tear down or invalidate the current session.
      if (this.ws !== ws) {
        this.log.debug('Discord: mengabaikan close dari socket lama.');
        return;
      }
      this.cleanupSocket(ws);
      if (FATAL_CLOSE_CODES.has(code)) {
        this.log.error('Discord: token ditolak / tidak valid. Perbaiki DISCORD_TOKEN lalu jalankan ulang.');
        this.stopped = true;
        this.emit('fatal', { code, reason });
        return;
      }
      this.scheduleReconnect();
    });
  }

  cleanupSocket(expectedWs = this.ws) {
    if (expectedWs && this.ws !== expectedWs) return false;
    clearTimeout(this.identifyRetryTimer);
    this.identifyRetryTimer = null;
    clearInterval(this.hbTimer);
    this.hbTimer = null;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.identified = false;
    return true;
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(60000, 3000 * Math.pow(1.6, Math.min(this.reconnectAttempts, 6))) + Math.floor(Math.random() * 1500);
    this.log.info(`Discord: reconnect dalam ${(delay / 1000).toFixed(1)}s (percobaan ke-${this.reconnectAttempts})`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /* ------------------------------- KIRIM --------------------------------- */

  send(payload, onComplete = null) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocketClient.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload), (err) => {
        if (err) this.log.warn('Discord: gagal menulis frame —', err.message);
        if (typeof onComplete === 'function') onComplete(err || null, socket);
      });
      return true;
    } catch (err) {
      this.log.warn('Discord: gagal kirim —', err.message);
      if (typeof onComplete === 'function') onComplete(err, socket);
      return false;
    }
  }

  identify() {
    this.send({
      op: 2,
      d: {
        token: this.token,
        properties: this.properties,
        presence: {
          status: this.presenceStatus,
          since: null,
          activities: this.presenceProvider() || [],
          afk: false,
        },
      },
    });
  }

  heartbeat() {
    this.lastBeatSent = Date.now();
    this.send({ op: 1, d: this.seq });
  }

  sendPresence() {
    if (!this.identified) return false;
    const activities = this.presenceProvider() || [];
    const d = {
      since: this.presenceStatus === 'idle' ? Date.now() : null,
      activities,
      status: this.presenceStatus,
      afk: false,
    };
    const socket = this.ws;
    const sentAt = Date.now();
    const summary = summarizeActivities(activities);
    if (!this.send({ op: 3, d }, (err, writtenSocket) => {
      // The ws callback confirms the frame was written. Ignore late callbacks
      // from a socket that has already been replaced.
      if (err || writtenSocket !== socket || this.ws !== socket || !this.identified) return;
      this.lastPresenceSentAt = sentAt;
      this.lastPresenceSentSummary = summary;
    })) return false;
    return true;
  }

  /** Minta presence dikirim secepatnya (mis. lagu Spotify berubah). */
  requestPresencePush() {
    if (!this.identified) {
      this.pushRequested = true;
      return;
    }
    this.sendPresence();
  }

  /* ------------------------------ PENANGANAN ----------------------------- */

  handlePayload(payload) {
    const { op, d, t } = payload;

    switch (op) {
      case 10: { // HELLO
        this.hbInterval = d?.heartbeat_interval ?? 41250;
        this.lastAck = Date.now();
        this.log.debug(`Discord: HELLO — heartbeat ${this.hbInterval} ms`);
        clearInterval(this.hbTimer);
        // Kirim heartbeat pertama setelah jeda acak (aturan Discord)
        const first = setTimeout(() => {
          this.heartbeat();
          this.hbTimer = setInterval(() => this.heartbeat(), this.hbInterval);
        }, Math.floor(this.hbInterval * (0.4 + Math.random() * 0.4)));
        if (first.unref) first.unref();
        this.identify();
        break;
      }

      case 11: // HEARTBEAT ACK
        this.lastAck = Date.now();
        break;

      case 1: // server minta heartbeat
        this.heartbeat();
        break;

      case 7: // RECONNECT
        this.log.info('Discord: server minta reconnect');
        this.cleanupSocket();
        this.scheduleReconnect();
        break;

      case 9: { // INVALID SESSION
        this.log.info('Discord: session invalid — identify ulang');
        this.identified = false;
        this.sessionId = null;
        this.pendingSessionsReplace = null;
        clearTimeout(this.identifyRetryTimer);
        this.identifyRetryTimer = setTimeout(() => {
          this.identifyRetryTimer = null;
          if (!this.stopped && this.ws && this.ws.readyState === WebSocketClient.OPEN) this.identify();
        }, 2000 + Math.random() * 3000);
        if (this.identifyRetryTimer.unref) this.identifyRetryTimer.unref();
        break;
      }

      case 0: { // DISPATCH
        if (typeof d?.s === 'number') this.seq = d.s;

        if (t === 'READY') {
          clearTimeout(this.identifyRetryTimer);
          this.identifyRetryTimer = null;
          const user = d?.user || {};
          this.sessionId = d?.session_id || null;
          this.identified = true;
          this.reconnectAttempts = 0;
          this.selfUser = user; // dipakai dashboard (nama akun)
          this.log.info(`Discord: ONLINE sebagai ${user.username ?? '?'} (id ${user.id ?? '?'})`);
          if (this.pendingSessionsReplace) {
            const sessions = this.pendingSessionsReplace;
            this.pendingSessionsReplace = null;
            this.syncFromSessions(sessions, false);
          }
          if (this.pushRequested) this.pushRequested = false;
          this.sendPresence();
          this.emit('ready', user);
        } else if (t === 'RESUMED') {
          clearTimeout(this.identifyRetryTimer);
          this.identifyRetryTimer = null;
          this.log.info('Discord: session dilanjutkan (RESUMED)');
          this.identified = true;
          this.sendPresence();
          this.emit('ready');
        } else if (t === 'SESSIONS_REPLACE') {
          if (!this.sessionId) this.pendingSessionsReplace = d;
          else this.syncFromSessions(d);
        } else if (t === 'USER_SETTINGS_PROTO_UPDATE') {
          const type = d?.settings?.type;
          const b64 = d?.settings?.proto;
          if (b64 && (type === undefined || type === 1)) {
            this.emit('settingsUpdate', { base64: b64, partial: Boolean(d?.partial) });
            try {
              const storedStatus = proto.readPresenceStatus(proto.fromBase64(b64));
              if (storedStatus) this.adoptPresenceStatus(storedStatus, 'USER_SETTINGS_PROTO_UPDATE');
            } catch (err) {
              this.log.debug('Discord: status settings proto tidak terbaca —', err.message);
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  /** Watchdog: kalau ACK tidak datang, anggap koneksi zombie -> reconnect. */
  watchdog() {
    if (!this.ws || this.stopped) return;
    if (!this.identified) return;
    const limit = this.hbInterval * 2.5;
    if (this.lastAck && Date.now() - this.lastAck > limit) {
      this.log.warn('Discord: heartbeat tidak di-ACK — reconnect.');
      this.cleanupSocket();
      this.scheduleReconnect();
    }
  }
}

module.exports = { DiscordGateway };
