'use strict';

/**
 * Test WebSocketClient (implementasi sendiri, tanpa dependency).
 * Server tiruan minimal ikut ditulis di file ini (RFC 6455 sisi server).
 * Jalankan: npm run test:ws
 */

const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const WebSocketClient = require('../src/wsclient');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ===================== Server WebSocket tiruan (test) ===================== */

function parseFrames(buf) {
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) break; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    let payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    buf = buf.subarray(off + len);
  }
  return { frames, rest: buf };
}

function serverFrame(payload, opcode = 0x1, fin = true) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Server uji: onOpen(sock, send, close) */
function startServer(onOpen) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let ready = false;
      const send = (payload, opcode = 0x1, fin = true) =>
        sock.write(serverFrame(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), opcode, fin));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!ready) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = buf.subarray(0, idx).toString('latin1');
          buf = buf.subarray(idx + 4);
          const key = (/sec-websocket-key:\s*(.+)/i.exec(head) || [])[1];
          const accept = crypto.createHash('sha1').update(key.trim() + GUID).digest('base64');
          sock.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          ready = true;
          if (onOpen) onOpen(sock, send, head);
          return;
        }
        const { frames, rest } = parseFrames(buf);
        buf = rest;
        for (const f of frames) (sock._frames = sock._frames || []).push(f);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await wait(30);
  }
  throw new Error('timeout menunggu kondisi');
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

/* ================================= TEST ================================== */

(async () => {
  console.log('wsclient.test.js — WebSocket tanpa dependency\n');

  await test('handshake + kirim/terima pesan teks', async () => {
    const { server, port } = await startServer((sock) => {
      // balas setiap pesan yang masuk
      sock.on('data', () => {
        const f = (sock._frames || []).pop();
        if (f && f.opcode === 0x1) sock.write(serverFrame(Buffer.from('echo:' + f.payload.toString())));
      });
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    const messages = [];
    ws.on('message', (m) => messages.push(m.toString()));
    await waitFor(() => ws.readyState === WebSocketClient.OPEN);
    ws.send('halo dunia');
    await waitFor(() => messages.length === 1);
    assert.strictEqual(messages[0], 'echo:halo dunia');
    ws.close();
    server.close();
  });

  await test('callback send berjalan setelah frame ditulis ke socket', async () => {
    const { server, port } = await startServer();
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    await waitFor(() => ws.readyState === WebSocketClient.OPEN);
    let completed = false;
    let writeError = null;
    ws.send('callback-check', (err) => { writeError = err || null; completed = true; });
    await waitFor(() => completed);
    assert.ifError(writeError);
    ws.close();
    server.close();
  });

  await test('payload besar (>64 KB) utuh', async () => {
    const big = 'x'.repeat(200000);
    const { server, port } = await startServer((sock) => {
      sock.on('data', () => {
        const f = (sock._frames || []).pop();
        if (f && f.opcode === 0x1) sock.write(serverFrame(Buffer.from(String(f.payload.length))));
      });
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    const messages = [];
    ws.on('message', (m) => messages.push(m.toString()));
    await waitFor(() => ws.readyState === WebSocketClient.OPEN);
    ws.send(big);
    await waitFor(() => messages.length === 1);
    assert.strictEqual(messages[0], String(big.length), 'panjang payload harus sesuai');
    ws.close();
    server.close();
  });

  await test('pesan terfragmentasi disatukan', async () => {
    const { server, port } = await startServer((sock) => {
      const a = Buffer.from('bagian-1 ');
      const b = Buffer.from('bagian-2');
      sock.write(serverFrame(a, 0x1, false)); // TEXT tanpa FIN
      setTimeout(() => sock.write(serverFrame(b, 0x0, true)), 50); // CONT + FIN
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    const messages = [];
    ws.on('message', (m) => messages.push(m.toString()));
    await waitFor(() => messages.length === 1);
    assert.strictEqual(messages[0], 'bagian-1 bagian-2');
    ws.close();
    server.close();
  });

  await test('ping dari server dijawab pong otomatis', async () => {
    // Server mengirim PING; client harus membalas PONG dengan payload sama.
    const received = [];
    const { server, port } = await startServer((sock) => {
      sock.on('data', () => {
        for (const f of sock._frames || []) {
          if (f.opcode === 0xa) received.push(f.payload.toString());
        }
      });
      setTimeout(() => sock.write(serverFrame(Buffer.from('pingtest'), 0x9)), 50);
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    const pingEvents = [];
    ws.on('ping', (p) => pingEvents.push(p.toString()));
    await waitFor(() => received.length === 1);
    assert.strictEqual(received[0], 'pingtest', 'pong harus membawa payload sama');
    assert.deepStrictEqual(pingEvents, ['pingtest'], 'event ping harus dipancarkan');
    ws.close();
    server.close();
  });

  await test('close frame dari server -> event close dengan kode', async () => {
    const { server, port } = await startServer((sock) => {
      setTimeout(() => {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(4004, 0);
        sock.write(serverFrame(payload, 0x8));
      }, 50);
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    let closeCode = null;
    ws.on('close', (code) => { closeCode = code; });
    await waitFor(() => closeCode !== null);
    assert.strictEqual(closeCode, 4004);
    assert.strictEqual(ws.readyState, WebSocketClient.CLOSED);
    server.close();
  });

  await test('handshake gagal (bukan 101) -> event error', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', () => sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ws = new WebSocketClient(`ws://127.0.0.1:${server.address().port}/`);
    let caught = null;
    ws.on('error', (e) => { caught = e; });     // dipasang langsung, sebelum event async apa pun
    await waitFor(() => caught);
    assert.match(caught.message, /403/, 'pesan error harus menyebut HTTP 403');
    await waitFor(() => ws.readyState === WebSocketClient.CLOSED);
    server.close();
  });

  await test('Sec-WebSocket-Accept salah -> ditolak', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: salah\r\n\r\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ws = new WebSocketClient(`ws://127.0.0.1:${server.address().port}/`);
    let caught = null;
    ws.on('error', (e) => { caught = e; });
    await waitFor(() => caught);
    assert.match(caught.message, /Accept/i);
    await waitFor(() => ws.readyState === WebSocketClient.CLOSED);
    server.close();
  });

  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
  process.exit(process.exitCode || 0);
})();
