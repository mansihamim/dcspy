'use strict';

/**
 * ============================================================================
 *  WebSocketClient — implementasi WebSocket (RFC 6455) tanpa dependency
 * ============================================================================
 *  Dipakai supaya script bisa jalan cuma dengan `node index.js`
 *  (tidak perlu npm install / tidak perlu folder node_modules).
 *
 *  Fitur yang didukung (seperlunya untuk Discord & Spotify):
 *   - ws:// dan wss:// (TLS)
 *   - handshake HTTP/1.1 + verifikasi Sec-WebSocket-Accept
 *   - frame text/binary, masking, payload 7/16/64-bit
 *   - fragmentasi (continuation frames) + ping/pong/close
 *   - auto-pong saat menerima ping
 *   - event: open, message, ping, pong, close, error
 *   - method: send(), ping(), close(), terminate()
 * ============================================================================
 */

const { EventEmitter } = require('events');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 32 * 1024 * 1024; // pengaman (32 MB cukup untuk kedua layanan)

const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketClient extends EventEmitter {
  /**
   * @param {string} url  ws:// atau wss://
   * @param {{headers?:Record<string,string>, handshakeTimeout?:number, maxPayload?:number, rejectUnauthorized?:boolean}} opts
   */
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.headers = opts.headers || {};
    this.handshakeTimeout = opts.handshakeTimeout || 20000;
    this.maxPayload = opts.maxPayload || MAX_PAYLOAD;
    this.rejectUnauthorized = opts.rejectUnauthorized !== false;

    this.readyState = WebSocketClient.CONNECTING; // 0
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshakeData = '';
    this._fragOpcode = null;
    this._fragChunks = [];
    this._fragLength = 0;

    const u = new URL(url);
    this.secure = u.protocol === 'wss:';
    this.host = u.hostname;
    this.port = Number(u.port || (this.secure ? 443 : 80));
    this.path = (u.pathname || '/') + (u.search || '');

    this._connect();
  }

  /* ------------------------------- KONEKSI ------------------------------- */

  _connect() {
    const onConnect = () => {
      this._sendHandshake();
    };

    const onData = (chunk) => {
      if (!this.handshakeDone) return this._consumeHandshake(chunk);
      this._consumeFrames(chunk);
    };

    const onError = (err) => {
      if (this.readyState === WebSocketClient.CLOSED) return;
      this.emit('error', err);
      this._finalize(1006, Buffer.from(String(err && err.message ? err.message : err)));
    };

    const onClose = () => {
      if (this.readyState === WebSocketClient.CLOSED) return;
      // socket tertutup tanpa close frame
      this._finalize(1006, Buffer.alloc(0));
    };

    const options = { host: this.host, port: this.port };
    if (this.secure) {
      this.socket = tls.connect({ ...options, servername: this.host, rejectUnauthorized: this.rejectUnauthorized });
      this.socket.once('secureConnect', onConnect);
    } else {
      this.socket = net.connect(options, onConnect);
    }

    this.socket.on('data', onData);
    this.socket.on('error', onError);
    this.socket.on('close', onClose);
    this.socket.setNoDelay(true);
    if (typeof this.socket.setTimeout === 'function') {
      this.socket.setTimeout(0); // tidak pakai timeout socket; heartbeat diurus pemanggil
    }

    this._handshakeTimer = setTimeout(() => {
      if (!this.handshakeDone) {
        const err = new Error('timeout handshake WebSocket');
        this.emit('error', err);
        this.terminate();
      }
    }, this.handshakeTimeout);
    if (this._handshakeTimer.unref) this._handshakeTimer.unref();
  }

  _sendHandshake() {
    this.key = crypto.randomBytes(16).toString('base64');
    const lines = [
      `GET ${this.path} HTTP/1.1`,
      `Host: ${this.host}${this.port === (this.secure ? 443 : 80) ? '' : `:${this.port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
    ];
    for (const [k, v] of Object.entries(this.headers)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k}: ${v}`);
    }
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
  }

  _consumeHandshake(chunk) {
    this.handshakeData += chunk.toString('latin1');
    const end = this.handshakeData.indexOf('\r\n\r\n');
    if (end === -1) {
      if (this.handshakeData.length > 65536) {
        this.emit('error', new Error('respons handshake terlalu besar'));
        this.terminate();
      }
      return;
    }

    const rawHead = this.handshakeData.slice(0, end);
    const rest = Buffer.from(this.handshakeData.slice(end + 4), 'latin1');
    this.handshakeData = '';

    const [statusLine, ...headerLines] = rawHead.split('\r\n');
    const status = Number((/^HTTP\/1\.\d\s+(\d{3})/.exec(statusLine) || [])[1] || 0);
    const headers = {};
    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    if (status !== 101) {
      const err = new Error(`handshake gagal (HTTP ${status})`);
      err.status = status;
      err.body = rawHead.slice(0, 400);
      this.emit('error', err);
      this.terminate();
      return;
    }

    const expected = crypto.createHash('sha1').update(this.key + GUID).digest('base64');
    if ((headers['sec-websocket-accept'] || '') !== expected) {
      this.emit('error', new Error('Sec-WebSocket-Accept tidak cocok'));
      this.terminate();
      return;
    }

    clearTimeout(this._handshakeTimer);
    this.handshakeDone = true;
    this.readyState = WebSocketClient.OPEN;
    this.emit('open');

    if (rest.length) this._consumeFrames(rest);
  }

  /* -------------------------------- FRAME -------------------------------- */

  _consumeFrames(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.readyState === WebSocketClient.CLOSED) return;
    }
  }

  /** Baca satu frame dari buffer. @returns {{fin:boolean,opcode:number,payload:Buffer}|null} */
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('payload terlalu besar');
      length = Number(big);
      offset += 8;
    }

    if (length > this.maxPayload) {
      this.emit('error', new Error(`payload ${length} byte melebihi batas`));
      this.terminate();
      return null;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + length) return null;

    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) copy[i] = payload[i] ^ maskKey[i % 4];
      payload = copy;
    } else {
      payload = Buffer.from(payload); // lepas dari buffer besar
    }

    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this._sendFrame(payload, OPCODE.PONG);
        this.emit('ping', payload);
        return;

      case OPCODE.PONG:
        this.emit('pong', payload);
        return;

      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2) : Buffer.alloc(0);
        if (this.readyState === WebSocketClient.OPEN) {
          // balas close lalu tutup
          this._sendFrame(payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0), OPCODE.CLOSE);
          this.readyState = WebSocketClient.CLOSING;
        }
        this._finalize(code, reason);
        return;
      }

      case OPCODE.CONT: {
        if (this._fragOpcode === null) return; // continuation tanpa awal -> abaikan
        this._fragChunks.push(payload);
        this._fragLength += payload.length;
        if (fin) this._deliverMessage(this._fragOpcode, Buffer.concat(this._fragChunks, this._fragLength), true);
        return;
      }

      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (fin) {
          this._deliverMessage(opcode, payload, false);
        } else {
          this._fragOpcode = opcode;
          this._fragChunks = [payload];
          this._fragLength = payload.length;
        }
        return;
      }

      default:
        // opcode tidak dikenal -> abaikan
        return;
    }
  }

  _deliverMessage(opcode, payload, wasFragmented) {
    if (wasFragmented) {
      this._fragOpcode = null;
      this._fragChunks = [];
      this._fragLength = 0;
    }
    if (opcode === OPCODE.TEXT) {
      this.emit('message', payload, false);
    } else {
      this.emit('message', payload, true);
    }
  }

  /* -------------------------------- KIRIM -------------------------------- */

  _sendFrame(payload, opcode = OPCODE.TEXT, onComplete = null) {
    if (!this.socket || this.socket.destroyed) {
      if (typeof onComplete === 'function') onComplete(new Error('WebSocket socket is not writable'));
      return false;
    }

    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header;

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len <= 0xffff) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }

    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];

    try {
      const frame = Buffer.concat([header, body]);
      if (typeof onComplete === 'function') {
        return this.socket.write(frame, (err) => onComplete(err || null));
      }
      return this.socket.write(frame);
    } catch (err) {
      this.emit('error', err);
      if (typeof onComplete === 'function') onComplete(err);
      return false;
    }
  }

  /** Kirim teks/buffer; callback (opsional) berjalan setelah socket menulis frame. */
  send(data, onComplete = null) {
    if (this.readyState !== WebSocketClient.OPEN) {
      if (typeof onComplete === 'function') onComplete(new Error('WebSocket is not open'));
      return false;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this._sendFrame(payload, OPCODE.TEXT, onComplete);
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== WebSocketClient.OPEN) return false;
    return this._sendFrame(Buffer.isBuffer(data) ? data : Buffer.from(String(data)), OPCODE.PING);
  }

  /** Tutup dengan sopan (mengirim close frame). */
  close(code = 1000, reason = '') {
    if (this.readyState === WebSocketClient.CLOSED || this.readyState === WebSocketClient.CLOSING) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(payload, OPCODE.CLOSE);
    this.readyState = WebSocketClient.CLOSING;
    this._finalize(code, reasonBuf);
  }

  /** Tutup paksa (tanpa close frame). */
  terminate() {
    this._finalize(1006, Buffer.alloc(0));
  }

  _finalize(code, reasonBuf) {
    if (this.readyState === WebSocketClient.CLOSED) return;
    this.readyState = WebSocketClient.CLOSED;
    clearTimeout(this._handshakeTimer);
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.emit('close', code, Buffer.isBuffer(reasonBuf) ? reasonBuf : Buffer.from(String(reasonBuf || '')));
  }
}

WebSocketClient.CONNECTING = 0;
WebSocketClient.OPEN = 1;
WebSocketClient.CLOSING = 2;
WebSocketClient.CLOSED = 3;

module.exports = WebSocketClient;
module.exports.OPEN = WebSocketClient.OPEN;
module.exports.CLOSED = WebSocketClient.CLOSED;
