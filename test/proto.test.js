'use strict';

/**
 * Test tanpa dependency (jalankan: npm test).
 * Memastikan encoder/decoder protobuf untuk custom status benar:
 *  - status dibaca & ditulis dengan tepat
 *  - field lain di settings TIDAK ikut rusak/hilang
 *  - expires_at_ms = 0 (Don't clear) => permanen
 */

const assert = require('assert');
const proto = require('../src/proto');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Settings palsu "milik user": berisi beberapa field lain (2 = inbox,
 * 13 = appearance, 23 = applications) supaya kita bisa memastikan
 * field-field itu tetap utuh setelah kita menulis custom status.
 */
function fakeSettings() {
  const parts = [
    proto.bytesField(2, Buffer.from('4a 01 02', 'utf8')),          // field lain (isi bebas)
    proto.bytesField(13, Buffer.from([0x08, 0x02])),               // field lain
    proto.bytesField(23, Buffer.from([0x0a, 0x03, 0x01, 0x02, 0x03])), // field lain
  ];
  return proto.encodeFields(parts);
}

const rawOf = (buf, field) => {
  const f = proto.findField(proto.decode(buf), field);
  return f ? f.raw.toString('hex') : null;
};

console.log('proto.test.js — pengujian custom status permanen\n');

/* ------------------------------------------------------------------ */

test('varint & fixed64 bolak-balik dengan benar', () => {
  const fields = proto.encodeFields([proto.varintField(7, 123456), proto.fixed64Field(3, 123456789012345n)]);
  const decoded = proto.decode(fields);
  assert.strictEqual(decoded.length, 2);
  assert.strictEqual(Number(decoded[0].value), 123456);
  assert.strictEqual(decoded[1].value.readBigUInt64LE(0), 123456789012345n);
});

test('settings tanpa custom status -> terbaca sebagai kosong', () => {
  const read = proto.readCustomStatus(fakeSettings());
  assert.strictEqual(read.found, false);
  assert.strictEqual(read.text, '');
});

test('tulis custom status: teks + emoji unicode', () => {
  const updated = proto.upsertCustomStatus(fakeSettings(), {
    text: 'sibuk, balas lambat',
    emojiName: '🔥',
  });
  const read = proto.readCustomStatus(updated);
  assert.strictEqual(read.found, true);
  assert.strictEqual(read.text, 'sibuk, balas lambat');
  assert.strictEqual(read.emojiName, '🔥');
  assert.strictEqual(read.expiresAtMs, 0, 'expires harus 0 = tidak pernah kedaluwarsa');
});

test('field settings lain tidak hilang/berubah', () => {
  const before = fakeSettings();
  const after = proto.upsertCustomStatus(before, { text: 'hai' });
  for (const field of [2, 13, 23]) {
    assert.strictEqual(rawOf(after, field), rawOf(before, field), `field ${field} berubah!`);
  }
  assert.strictEqual(proto.decode(after).length, proto.decode(before).length + 1);
});

test('status yang tadinya kedaluwarsa -> dinormalkan jadi permanen', () => {
  const expiring = proto.upsertCustomStatus(fakeSettings(), {
    text: 'afk',
    expiresAtMs: Date.now() + 3600_000,
  });
  assert.notStrictEqual(proto.readCustomStatus(expiring).expiresAtMs, 0);

  const permanent = proto.upsertCustomStatus(expiring, { text: 'afk', expiresAtMs: 0 });
  assert.strictEqual(proto.readCustomStatus(permanent).expiresAtMs, 0);
});

test('emoji custom (nama + id snowflake) tersimpan benar', () => {
  const updated = proto.upsertCustomStatus(fakeSettings(), {
    text: 'ngoding',
    emojiName: 'pepe',
    emojiId: '123456789012345678',
  });
  const read = proto.readCustomStatus(updated);
  assert.strictEqual(read.emojiName, 'pepe');
  assert.strictEqual(read.emojiId, '123456789012345678');
});

test('perbarui status yang sama tidak menumpuk duplikat', () => {
  const first = proto.upsertCustomStatus(fakeSettings(), { text: 'a' });
  const second = proto.upsertCustomStatus(first, { text: 'b' });
  const customEntries = proto.decode(second).filter((f) => f.field === 11);
  assert.strictEqual(customEntries.length, 1);
  assert.strictEqual(proto.readCustomStatus(second).text, 'b');
});

test('simpan pilihan status (dnd) ke settings', () => {
  const updated = proto.setPresenceStatusSetting(fakeSettings(), 'dnd');
  assert.strictEqual(proto.readPresenceStatus(updated), 'dnd');
  // custom status tetap utuh
  const withStatus = proto.upsertCustomStatus(fakeSettings(), { text: 'halo' });
  const both = proto.setPresenceStatusSetting(withStatus, 'idle');
  assert.strictEqual(proto.readPresenceStatus(both), 'idle');
  assert.strictEqual(proto.readCustomStatus(both).text, 'halo');
});

test('hapus custom status tidak menghapus pilihan status', () => {
  const withBoth = proto.setPresenceStatusSetting(
    proto.upsertCustomStatus(fakeSettings(), { text: 'hi' }),
    'dnd',
  );
  const cleared = proto.clearCustomStatus(withBoth);
  assert.strictEqual(proto.readCustomStatus(cleared).found, false);
  assert.strictEqual(proto.readPresenceStatus(cleared), 'dnd');
  assert.strictEqual(rawOf(cleared, 2), rawOf(withBoth, 2));
});

test('base64 (format yang dipakai Discord API) bolak-balik aman', () => {
  const updated = proto.upsertCustomStatus(fakeSettings(), { text: 'tes base64', emojiName: '✨' });
  const b64 = proto.toBase64(updated);
  const read = proto.readCustomStatus(proto.fromBase64(b64));
  assert.strictEqual(read.text, 'tes base64');
  assert.strictEqual(read.emojiName, '✨');
});

test('settings kosong tetap bisa ditulis (tanpa mengganggu field lain)', () => {
  const updated = proto.upsertCustomStatus(Buffer.alloc(0), { text: 'mulai dari nol' });
  const read = proto.readCustomStatus(updated);
  assert.strictEqual(read.text, 'mulai dari nol');
  assert.strictEqual(read.expiresAtMs, 0);
});

console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
