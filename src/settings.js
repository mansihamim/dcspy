'use strict';

/**
 * ============================================================================
 *  StatusKeeper — status permanen yang bisa dihapus kalau kamu mau
 * ============================================================================
 *  Cara kerja (mode `keep`, default):
 *   1. Status kamu disimpan PERMANEN di server Discord dengan expiry = 0
 *      ("Don't clear") → tidak akan hilang sendiri walau aplikasi ditutup,
 *      HP restart, atau logout-login.
 *   2. Kalau kamu mengubah status di aplikasi → status baru itu otomatis
 *      dikunci & dijadikan permanen.
 *   3. Kalau kamu MENGHAPUS status di aplikasi → dianggap sengaja:
 *      script melepas kunci dan TIDAK memasangnya kembali.
 *      (Terlihat real-time dari event USER_SETTINGS_PROTO_UPDATE, bukan
 *      hanya saat pengecekan berkala.)
 *
 *  Mode lain:
 *   - `enforce` : status dipaksa selalu ada; dihapus → dipasang ulang.
 *   - `off`     : script tidak menyentuh custom status sama sekali.
 *   - `CUSTOM_STATUS_TEXT` diisi → teks itu dianggap wajib ada (dipasang ulang).
 *
 *  Catatan penting: script tidak pernah mengirim custom status lewat presence
 *  kalau statusnya sudah tidak ada / sudah dilepas, jadi status tidak
 *  "bangkit sendiri" setelah kamu hapus.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const proto = require('./proto');
const { request, patchJson } = require('./http');

const EMPTY_TARGET = { text: '', emojiName: '', emojiId: '' };

class StatusKeeper {
  /**
   * @param {{token:string, logger:any, apiVersion:number, dataDir:string, cfg:any, status:string, onChange?:Function}} opts
   */
  constructor({ token, logger, apiVersion, dataDir, cfg, status, onChange = null }) {
    this.token = token;
    this.log = logger;
    this.apiBase = `https://discord.com/api/v${apiVersion}`;
    this.cfg = cfg;                     // config.customStatus
    this.presenceStatus = status;       // online | idle | dnd | invisible
    this.settingsPresenceStatus = '';   // nilai awal dari settings proto (kalau ada)
    this.onChange = onChange;           // dipanggil saat aktivitas presence berubah

    this.lockFile = path.join(dataDir, 'status-lock.json');
    this.target = { ...EMPTY_TARGET };
    this.lockApplied = false;           // true = status ini pernah sukses terpasang di akun
    this.suppressUntil = 0;             // abaikan event sesaat setelah kita PATCH
    this.applying = false;
    this.pendingTimer = null;
    this.pendingReason = '';
    this.timer = null;
    this.lastApplyAt = 0;
    this.releasedAt = 0;
  }

  get enabled() {
    return Boolean(this.cfg.enabled) && this.cfg.mode !== 'off';
  }

  /**
   * true = status wajib ada (dipasang ulang kalau hilang):
   *   - mode `enforce`, atau
   *   - CUSTOM_STATUS_TEXT / emoji di config diisi (patok)
   */
  get enforcing() {
    return this.cfg.mode === 'enforce' || this.cfg.pinned;
  }

  get hasTarget() {
    return Boolean(this.target.text || this.target.emojiName || this.target.emojiId);
  }

  get headers() {
    return {
      Authorization: this.token,
      'User-Agent': 'Mozilla/5.0 (compatible; discord-keep-online/2.1)',
    };
  }

  /* ------------------------------- LOCK FILE ------------------------------ */

  /** Muat status terkunci dari disk. @returns {{found:boolean, applied:boolean}} */
  loadLock() {
    try {
      if (!fs.existsSync(this.lockFile)) return { found: false, applied: false };
      const data = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (!data || typeof data !== 'object') return { found: false, applied: false };
      this.target = {
        text: String(data.text || ''),
        emojiName: String(data.emojiName || ''),
        emojiId: String(data.emojiId || ''),
      };
      this.lockApplied = data.applied === true;
      return { found: this.hasTarget, applied: this.lockApplied };
    } catch (err) {
      this.log.warn('Gagal baca file kunci status:', err.message);
      return { found: false, applied: false };
    }
  }

  saveLock(applied = this.lockApplied) {
    this.lockApplied = Boolean(applied);
    if (!this.hasTarget) return;
    try {
      fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
      fs.writeFileSync(
        this.lockFile,
        JSON.stringify({ ...this.target, applied: this.lockApplied, lockedAt: new Date().toISOString() }, null, 2),
      );
    } catch (err) {
      this.log.warn('Gagal simpan file kunci status:', err.message);
    }
  }

  /**
   * Lepas kunci: status dihapus oleh user -> jangan dipasang ulang,
   * dan hapus file kunci supaya tidak "bangkit" saat script restart.
   */
  releaseLock(reason) {
    const hadTarget = this.hasTarget || this.lockApplied;
    this.target = { ...EMPTY_TARGET };
    this.lockApplied = false;
    this.releasedAt = Date.now();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    try { fs.rmSync(this.lockFile, { force: true }); } catch { /* ignore */ }
    if (hadTarget) {
      this.log.info(
        `Status dihapus (${reason}) → penjaga status berhenti, TIDAK dipasang ulang. ` +
          'Kalau mau ada status lagi, cukup set di aplikasi Discord.',
      );
      this.onChange?.();
    } else {
      this.log.debug(`Status kosong (${reason}) — tidak ada yang perlu dikunci.`);
    }
  }

  /* --------------------------------- REST -------------------------------- */

  async fetchSettings() {
    const res = await request('GET', `${this.apiBase}/users/@me/settings-proto/1`, { headers: this.headers });
    if (res.status !== 200) return { ok: false, status: res.status, error: res.error };
    const b64 = res.json && typeof res.json.settings === 'string' ? res.json.settings : '';
    return { ok: true, base64: b64, buffer: proto.fromBase64(b64), empty: !b64 };
  }

  async patchSettings(buffer, reason) {
    const res = await patchJson(
      `${this.apiBase}/users/@me/settings-proto/1`,
      { settings: proto.toBase64(buffer) },
      this.headers,
    );

    if (res.status === 200) {
      this.suppressUntil = Date.now() + 5000;
      this.lastApplyAt = Date.now();
      return { ok: true };
    }

    if (res.status === 429) {
      const waitMs = Math.ceil(((res.json && res.json.retry_after) || 5) * 1000) + 750;
      this.log.warn(`Status: kena rate-limit, coba lagi dalam ${(waitMs / 1000).toFixed(1)}s`);
      this.scheduleApply(reason, waitMs);
      return { ok: false, rateLimited: true };
    }

    this.log.warn(`Status: gagal simpan settings (HTTP ${res.status}) ${res.body ? res.body.slice(0, 180) : res.error || ''}`);
    return { ok: false };
  }

  /* ------------------------------- APPLY --------------------------------- */

  /** Pasang custom status permanen + simpan pilihan online/idle/dnd. */
  async apply(reason = 'manual') {
    if (!this.enabled) return;
    if (!this.hasTarget) return; // sudah dilepas -> jangan pasang apa pun

    if (this.applying) {
      this.scheduleApply(reason, 2000);
      return;
    }
    this.applying = true;
    const targetSnapshot = { ...this.target };

    try {
      const cur = await this.fetchSettings();
      if (!cur.ok) {
        this.log.warn(`Status: tidak bisa baca settings (HTTP ${cur.status}${cur.error ? ` ${cur.error}` : ''}) — coba lagi nanti`);
        this.scheduleApply(reason, 30000);
        return;
      }

      // Kalau statusnya sudah dilepas saat kita menunggu, batal.
      if (!this.hasTarget || this.target.text !== targetSnapshot.text) return;

      const previous = proto.readCustomStatus(cur.buffer);
      let buffer = proto.upsertCustomStatus(cur.buffer, {
        text: targetSnapshot.text,
        emojiName: targetSnapshot.emojiName,
        emojiId: targetSnapshot.emojiId,
        createdAtMs: this.cfg.neverExpire ? Date.now() : previous.createdAtMs || Date.now(),
        // neverExpire = true -> expiry dihapus (0) supaya status tidak pernah kedaluwarsa
        expiresAtMs: this.cfg.neverExpire ? 0 : previous.expiresAtMs || 0,
      });

      if (this.cfg.persistStatus && this.presenceStatus) {
        buffer = proto.setPresenceStatusSetting(buffer, this.presenceStatus, { createdAtMs: Date.now() });
      }

      const res = await this.patchSettings(buffer, reason);
      if (res.ok) {
        this.saveLock(true); // tandai: sudah terpasang di akun
        const emoji = targetSnapshot.emojiName || (targetSnapshot.emojiId ? `:${targetSnapshot.emojiId}` : '');
        const label = targetSnapshot.text || '(emoji saja)';
        this.log.info(
          `Status ${JSON.stringify(label)}${emoji ? ' ' + emoji : ''} tersimpan permanen (${reason}). ` +
            'Tidak akan hilang sendiri walau aplikasi Discord ditutup.',
        );
      } else if (!res.rateLimited) {
        this.scheduleApply(reason, 30000);
      }
    } catch (err) {
      this.log.warn('Status: error saat apply —', err.message);
    } finally {
      this.applying = false;
    }
  }

  scheduleApply(reason = 'enforce', delayMs = 2500) {
    if (!this.hasTarget) return;
    this.pendingReason = reason;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.apply(this.pendingReason).catch((e) => this.log.warn('Status:', e.message));
    }, delayMs);
  }

  /* ------------------------- REKONSILIASI / ENFORCE ----------------------- */

  /**
   * Bandingkan status yang ada di akun dengan target kita.
   * @param {{found:boolean,text:string,emojiName:string,emojiId:string,expiresAtMs:number}} current
   * @param {string} source
   */
  async reconcile(current, source) {
    if (!this.enabled) return;

    const isEmpty = !current.text && !current.emojiName && !current.emojiId;
    const same =
      current.text === this.target.text &&
      (current.emojiName || '') === (this.target.emojiName || '') &&
      String(current.emojiId || '') === String(this.target.emojiId || '');

    /* ---- status kosong / dihapus ---- */
    if (isEmpty) {
      if (!this.hasTarget) return; // sudah tidak ada target, semuanya beres
      if (this.enforcing) {
        this.log.info(`Status hilang (terdeteksi: ${source}) → dipasang ulang (mode paksa).`);
        this.scheduleApply('dipasang ulang');
        this.onChange?.();
      } else {
        this.releaseLock(source === 'event gateway' ? 'kamu hapus di aplikasi' : `terdeteksi ${source}`);
      }
      return;
    }

    /* ---- status sama dengan target ---- */
    if (same) {
      if (this.cfg.neverExpire && current.expiresAtMs !== 0) {
        this.log.info('Status punya waktu kedaluwarsa (mis. "Clear after") → diubah jadi permanen...');
        this.scheduleApply('jadikan permanen');
        return;
      }
      if (!this.lockApplied) this.saveLock(true); // status sudah ada di akun
      return;
    }

    /* ---- status berbeda dengan target ---- */
    if (this.enforcing) {
      this.log.info(`Status diubah di luar script → dikembalikan ke ${JSON.stringify(this.target.text || '(emoji)')}...`);
      this.scheduleApply('kembalikan status');
      this.onChange?.();
      return;
    }

    // mode `keep`: hormati perubahan yang kamu lakukan di aplikasi
    this.target = { text: current.text, emojiName: current.emojiName, emojiId: current.emojiId };
    this.lockApplied = false;
    this.saveLock(false);
    this.log.info(`Status baru terdeteksi (${source}): ${JSON.stringify(this.target.text || '(emoji)')} → dikunci & dijadikan permanen.`);
    this.onChange?.();
    this.scheduleApply('kunci status baru');
  }

  /**
   * Dipanggil dari event gateway USER_SETTINGS_PROTO_UPDATE (real-time).
   * @param {string} base64 settings proto
   * @param {boolean} [partial]
   */
  handleSettingsEvent(base64, partial = false) {
    if (!this.enabled) return;
    let current;
    try {
      current = proto.readCustomStatus(proto.fromBase64(base64));
    } catch (err) {
      this.log.debug('Status: gagal decode event settings —', err.message);
      return;
    }
    const isEmpty = !current.text && !current.emojiName && !current.emojiId;

    // Perubahan dari kita sendiri boleh diabaikan... KECUALI kalau statusnya jadi
    // kosong: patch kita tidak pernah mengosongkan status, jadi itu pasti ulah user.
    const ownChange = Date.now() < this.suppressUntil && !(isEmpty && this.hasTarget);
    if (ownChange) return;

    this.reconcile(current, partial ? 'event gateway (parsial)' : 'event gateway')
      .catch((e) => this.log.warn('Status:', e.message));
  }

  /** Pengecekan berkala (jaring pengaman kalau event gateway terlewat). */
  async tick() {
    if (!this.enabled) return;
    const cur = await this.fetchSettings();
    if (!cur.ok) return;
    const current = proto.readCustomStatus(cur.buffer);
    await this.reconcile(current, 'pengecekan berkala');
  }

  /* -------------------------------- MULAI -------------------------------- */

  async init() {
    if (!this.cfg.enabled) {
      this.log.info('Penjaga status: nonaktif (CUSTOM_STATUS_ENABLED=false).');
      return;
    }
    if (this.cfg.mode === 'off') {
      this.log.info('Penjaga status: mode OFF — script tidak menyentuh custom status.');
      return;
    }

    // 1. Ambil settings saat ini
    const cur = await this.fetchSettings();
    if (cur.ok) {
      const storedStatus = proto.readPresenceStatus(cur.buffer);
      if (['online', 'idle', 'dnd', 'invisible'].includes(storedStatus)) {
        this.settingsPresenceStatus = storedStatus;
        this.presenceStatus = storedStatus;
      }
    }
    const current = cur.ok
      ? proto.readCustomStatus(cur.buffer)
      : { found: false, text: '', emojiName: '', emojiId: '', expiresAtMs: 0 };
    if (!cur.ok) {
      this.log.warn(`Penjaga status: gagal baca settings (HTTP ${cur.status}) — akan dicoba lagi nanti.`);
    }
    const serverEmpty = !current.text && !current.emojiName && !current.emojiId;

    // 2. Tentukan target status
    if (this.cfg.pinned) {
      this.target = { text: this.cfg.text, emojiName: this.cfg.emojiName, emojiId: this.cfg.emojiId };
      this.lockApplied = false;
      this.log.info(`Status dipatok dari config: ${JSON.stringify(this.target.text || '(emoji)')}`);
    } else {
      const lock = this.loadLock();
      if (lock.found && lock.applied && serverEmpty && cur.ok) {
        // Pernah terpasang, sekarang hilang -> user menghapusnya saat script mati.
        this.releaseLock('status sudah tidak ada di akun');
      } else if (lock.found && !serverEmpty && lock.applied) {
        const berbeda = current.text !== this.target.text || (current.emojiName || '') !== (this.target.emojiName || '');
        if (berbeda) {
          this.target = { text: current.text, emojiName: current.emojiName, emojiId: current.emojiId };
          this.saveLock(false);
          this.log.info(`Status di akun berbeda dari kunci lama → mengikuti status terbaru: ${JSON.stringify(this.target.text || '(emoji)')}`);
        } else {
          this.log.info(`Status terkunci dari file: ${JSON.stringify(this.target.text || '(emoji)')}`);
        }
      } else if (lock.found && !lock.applied) {
        // File kunci ada tapi belum pernah sukses terpasang -> jangan dianggap dihapus
        this.log.info(`Melanjutkan status yang belum sempat terpasang: ${JSON.stringify(this.target.text || '(emoji)')}`);
      } else if (!lock.found) {
        if (!serverEmpty) {
          this.target = { text: current.text, emojiName: current.emojiName, emojiId: current.emojiId };
          this.saveLock(false);
          this.log.info(`Custom status yang sedang kamu pakai dikunci: ${JSON.stringify(this.target.text || '(emoji)')}`);
        } else {
          this.log.info(
            'Belum ada custom status. Set di aplikasi Discord kapan saja — ' +
              'script akan otomatis menguncinya & membuatnya permanen.',
          );
        }
      }
    }

    // 3. Jadikan permanen (expiry = "Don't clear")
    if (this.hasTarget) {
      if (cur.ok) {
        const perlu = this.cfg.pinned ? true : !this.lockApplied || current.expiresAtMs !== 0;
        if (perlu) await this.apply('saat start');
      }
    }

    // 4. Pengecekan berkala (hanya jaring pengaman; event gateway yang utama)
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn('Status:', e.message));
    }, this.cfg.refreshMin * 60 * 1000);
    if (this.timer.unref) this.timer.unref();

    if (this.hasTarget) {
      this.log.info(
        `Penjaga status aktif (mode ${this.enforcing ? 'paksa' : 'keep'}) — cek ulang tiap ${this.cfg.refreshMin} menit. ` +
          (this.enforcing ? 'Status akan dipasang ulang kalau hilang.' : 'Status tidak dipasang ulang kalau kamu hapus.'),
      );
    } else {
      this.log.info('Penjaga status: menunggu kamu membuat custom status di aplikasi.');
    }
  }

  /* ------------------------------- PRESENCE ------------------------------ */

  /** Activity tipe 4 (custom status) untuk dikirim ke gateway. Null bila tidak ada. */
  currentActivity() {
    if (!this.enabled || !this.cfg.presence || !this.hasTarget) return null;
    const act = {
      id: 'custom',
      name: 'Custom Status',
      type: 4,
      created_at: Date.now(),
    };
    if (this.target.text) act.state = this.target.text;
    if (this.target.emojiName || this.target.emojiId) {
      act.emoji = {};
      if (this.target.emojiName) act.emoji.name = this.target.emojiName;
      if (this.target.emojiId) act.emoji.id = String(this.target.emojiId);
    }
    return act;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
  }
}

module.exports = { StatusKeeper };
