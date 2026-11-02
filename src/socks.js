'use strict';

/**
 * ============================================================================
 *  SOCKS5 + HTTPS — permintaan HTTP lewat proxy SOCKS (mis. Tor), tanpa
 *  dependency npm (cuma modul bawaan Node: net, tls, https).
 * ============================================================================
 *
 *  Kenapa dibuat sendiri? Proyek ini sengaja nol dependency. Node tidak punya
 *  opsi "fetch lewat SOCKS" bawaan, jadi kita: (1) sambung ke port SOCKS tor,
 *  (2) handshake SOCKS5 (no-auth) + CONNECT host:port, (3) bungkus soket itu
 *  jadi TLS, (4) pakai lewat https.Agent milik Node — otomatis urus HTTP,
 *  chunked encoding, dsb.
 *
 *  Dipakai oleh modul Scout (rotasi negara lewat Tor).
 */

const net = require('net');
const tls = require('tls');
const https = require('https');

/**
 * Sambung ke tujuan lewat SOCKS5. Menghasilkan soket mentah (belum TLS).
 *
 * `auth` = {user, pass} OPSIONAL — dan ini penting: Tor memakai user/pass SOCKS
 * sebagai kunci ISOLASI STREAM (IsolateSOCKSAuth, aktif secara bawaan). Artinya
 * satu username unik = satu SIRKUIT BARU, tanpa perlu sinyal NEWNYM yang
 * dibatasi 1× / 10 detik. Inilah yang membuat rotasi negara jadi cepat.
 */
function socksConnect(socksPort, tujuanHost, tujuanPort, timeoutMs = 20000, auth = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: socksPort });
    let buf = Buffer.alloc(0);
    let tahap = 0; // 0 = kirim salam, 0.5 = kirim user/pass, 1 = kirim CONNECT, 2 = selesai
    let beres = false;
    const selesai = (fn, arg) => {
      if (beres) return;
      beres = true;
      clearTimeout(timer);
      sock.removeAllListeners('data');
      fn(arg);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      selesai(reject, new Error(`SOCKS: timeout menyambung ke ${tujuanHost}:${tujuanPort}`));
    }, timeoutMs);
    const kirimConnect = () => {
      const h = Buffer.from(tujuanHost, 'utf8');
      if (h.length > 255) return selesai(reject, new Error('SOCKS: nama host terlalu panjang'));
      sock.write(
        Buffer.concat([
          Buffer.from([5, 1, 0, 3, h.length]),
          h,
          Buffer.from([(tujuanPort >> 8) & 255, tujuanPort & 255]),
        ]),
      );
    };
    sock.on('error', (e) => selesai(reject, e));
    sock.on('close', () => selesai(reject, new Error('SOCKS: soket tertutup sebelum siap')));
    // hanya tawarkan user/pass kalau diminta (itulah kunci isolasi sirkuit)
    sock.on('connect', () => sock.write(auth ? Buffer.from([5, 1, 2]) : Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (tahap === 0) {
        if (buf.length < 2) return;
        const metode = buf[1];
        if (metode === 255) return selesai(reject, new Error('SOCKS: server tidak menerima metode kita'));
        buf = buf.subarray(2);
        if (metode === 2) {
          if (!auth) return selesai(reject, new Error('SOCKS: server minta autentikasi'));
          const u = Buffer.from(String(auth.user || 'anon'), 'utf8');
          const pw = Buffer.from(String(auth.pass != null ? auth.pass : auth.user || 'anon'), 'utf8');
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
          tahap = 0.5;
          return;
        }
        if (metode !== 0) return selesai(reject, new Error('SOCKS: metode autentikasi ditolak server'));
        tahap = 1;
        kirimConnect();
        return;
      }
      if (tahap === 0.5) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return selesai(reject, new Error('SOCKS: user/pass ditolak'));
        buf = buf.subarray(2);
        tahap = 1;
        kirimConnect();
        return;
      }
      if (tahap === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return selesai(reject, new Error(`SOCKS: CONNECT ditolak (kode ${buf[1]})`));
        const atyp = buf[3];
        let panjang = 4;
        if (atyp === 1) panjang += 4 + 2;
        else if (atyp === 4) panjang += 16 + 2;
        else if (atyp === 3) panjang += 1 + buf[4] + 2;
        else return selesai(reject, new Error('SOCKS: alamat balasan tidak dikenal'));
        if (buf.length < panjang) return;
        tahap = 2;
        const sisa = buf.subarray(panjang); // jaga-jaga kalau ada byte lebih
        if (sisa.length) sock.unshift(sisa);
        selesai(resolve, sock);
      }
    });
  });
}

/**
 * Agent HTTPS yang seluruh koneksinya lewat SOCKS5.
 * Dipakai: https.request({ agent: new SocksAgent(port) })
 */
class SocksAgent extends https.Agent {
  constructor(socksPort, auth = null) {
    super({ keepAlive: false, maxSockets: 4 });
    this.socksPort = Number(socksPort);
    this.auth = auth || null;
  }

  createConnection(options, cb) {
    let sudah = false;
    const balas = (err, sock) => {
      if (sudah) return;
      sudah = true;
      cb(err, sock);
    };
    const host = options.hostname || options.host;
    const port = options.port || 443;
    socksConnect(this.socksPort, host, port, 20000, this.auth)
      .then((sock) => {
        const t = tls.connect({ socket: sock, servername: options.servername || host }, () => balas(null, t));
        t.on('error', (e) => balas(e));
      })
      .catch((e) => balas(e));
  }
}

/**
 * Permintaan HTTPS lewat SOCKS5. Mengembalikan { status, json, body, error }.
 * @param {number} socksPort
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string, timeoutMs?:number}} opsi
 */
function minta(socksPort, url, opsi = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 45000, user = null, pass = null } = opsi;
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: 0, json: null, body: '', error: 'URL tidak sah: ' + e.message });
    }
    // user/pass = kunci isolasi Tor (satu username = satu sirkuit)
    const agent = new SocksAgent(socksPort, user ? { user, pass: pass != null ? pass : user } : null);
    const req = https.request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const potongan = [];
        res.on('data', (c) => potongan.push(c));
        res.on('end', () => {
          const teks = Buffer.concat(potongan).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(teks);
          } catch {
            /* bukan JSON */
          }
          resolve({ status: res.statusCode || 0, json, body: teks });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', (e) => resolve({ status: 0, json: null, body: '', error: e.message }));
    if (body != null) req.write(body);
    req.end();
  });
}

/** GET JSON sederhana lewat SOCKS (HTTPS). */
async function getJsonSocks(socksPort, url, timeoutMs = 20000, opsi = {}) {
  const r = await minta(socksPort, url, { timeoutMs, ...opsi });
  if (r.status === 200 && r.json) return { ok: true, json: r.json };
  return { ok: false, status: r.status, error: r.error || r.body.slice(0, 120) };
}

/**
 * HTTP BIASA (tanpa TLS) lewat SOCKS5 — dipakai untuk ip-api.com yang gratis
 * hanya di http. (country.is versi terbaru kadang menjawab "T1" untuk exit
 * Tor, jadi ip-api yang lebih dulu dipakai.)
 */
function httpMinta(socksPort, url, timeoutMs = 15000, opsi = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: 0, json: null, body: '', error: e.message });
    }
    const auth = opsi && opsi.user ? { user: opsi.user, pass: opsi.pass != null ? opsi.pass : opsi.user } : null;
    socksConnect(socksPort, u.hostname, u.port || 80, timeoutMs, auth)
      .then((sock) => {
        let buf = '';
        const timer = setTimeout(() => {
          sock.destroy();
          resolve({ status: 0, json: null, body: buf, error: 'timeout' });
        }, timeoutMs);
        sock.on('data', (d) => {
          buf += d.toString('utf8');
        });
        sock.on('close', () => {
          clearTimeout(timer);
          const pisah = buf.indexOf('\r\n\r\n');
          if (pisah < 0) return resolve({ status: 0, json: null, body: buf, error: 'balasan tidak lengkap' });
          const kepala = buf.slice(0, pisah);
          const baris = kepala.split('\r\n');
          const status = Number((baris[0].match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || 0);
          let teks = buf.slice(pisah + 4);
          if (/transfer-encoding:\s*chunked/i.test(kepala)) teks = lepasChunked(teks);
          let json = null;
          try {
            json = JSON.parse(teks);
          } catch {
            /* bukan JSON */
          }
          resolve({ status, json, body: teks });
        });
        sock.on('error', (e) => {
          clearTimeout(timer);
          resolve({ status: 0, json: null, body: buf, error: e.message });
        });
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
            `User-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
        );
      })
      .catch((e) => resolve({ status: 0, json: null, body: '', error: e.message }));
  });
}

/** buang pembungkus chunked pada badan HTTP */
function lepasChunked(teks) {
  let hasil = '';
  let i = 0;
  while (i < teks.length) {
    const j = teks.indexOf('\r\n', i);
    if (j < 0) break;
    const n = parseInt(teks.slice(i, j), 16);
    if (!Number.isFinite(n) || n <= 0) break;
    hasil += teks.slice(j + 2, j + 2 + n);
    i = j + 2 + n + 2;
  }
  return hasil;
}

/**
 * Transport siap-pakai untuk QuestRunner (src/quest.js):
 *   quest.transport = transporSocks(port)
 * Semua permintaan quest lalu lewat SOCKS (mis. Tor) — dipakai Scout supaya
 * quest dari negara lain bisa LANGSUNG dikerjakan dari rute yang sama.
 * @param {number} socksPort
 * @param {number} timeoutDefault
 * @returns {(url:string, opsi?:object) => Promise<{status:number,json:any,body:string}>}
 */
function transporSocks(socksPort, timeoutDefault = 60000, bawaan = {}) {
  return (url, opsi = {}) =>
    minta(socksPort, url, { ...bawaan, ...opsi, timeoutMs: opsi.timeoutMs || timeoutDefault });
}

module.exports = { socksConnect, SocksAgent, minta, getJsonSocks, httpMinta, transporSocks };
