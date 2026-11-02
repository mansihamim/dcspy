'use strict';

/**
 * ============================================================================
 *  Protobuf mini decoder/encoder (tanpa dependency, tanpa protoc)
 * ============================================================================
 *  Dipakai untuk membaca & menulis "PreloadedUserSettings" milik Discord:
 *
 *    GET   /api/v9/users/@me/settings-proto/1   -> { settings: "<base64>" }
 *    PATCH /api/v9/users/@me/settings-proto/1   { settings: "<base64>" }
 *
 *  Struktur yang kita urus (sesuai discord_users/v1/PreloadedUserSettings.proto):
 *
 *    PreloadedUserSettings
 *      └─ field 11 : StatusSettings
 *           ├─ field 1 : status            (google.protobuf.StringValue  -> "online"|"idle"|"dnd"|"invisible")
 *           ├─ field 2 : custom_status     (CustomStatus)
 *           │     ├─ 1 : text              (string)
 *           │     ├─ 2 : emoji_id          (fixed64)
 *           │     ├─ 3 : emoji_name        (string)
 *           │     ├─ 4 : expires_at_ms     (fixed64, 0 / tidak ada = TIDAK PERNAH kedaluwarsa)
 *           │     ├─ 5 : created_at_ms     (fixed64)
 *           │     └─ 6 : label             (StringValue)
 *           ├─ field 3 : show_current_game (BoolValue)
 *           ├─ field 4 : status_expires_at_ms (fixed64)
 *           └─ field 5 : status_created_at_ms (UInt64Value)
 *
 *  Karena custom status ini disimpan di SETTINGS AKUN (server-side, bukan di
 *  sesi/app), statusnya tetap ada walau aplikasi Discord ditutup, HP restart,
 *  bahkan setelah logout-login lagi.
 *
 *  Decoder di bawah juga mempertahankan field lain yang tidak kita kenal
 *  (raw bytes), supaya setting lain milik user tidak hilang saat kita PATCH.
 * ============================================================================
 */

const WIRE = { VARINT: 0, FIXED64: 1, BYTES: 2, FIXED32: 5 };

// Nomor field di PreloadedUserSettings
const F_SETTINGS_STATUS = 11;

// Nomor field di StatusSettings
const F_STATUS_VALUE = 1;
const F_STATUS_CUSTOM = 2;
const F_STATUS_EXPIRES_AT_MS = 4;
const F_STATUS_CREATED_AT_MS = 5;

// Nomor field di CustomStatus
const F_CS_TEXT = 1;
const F_CS_EMOJI_ID = 2;
const F_CS_EMOJI_NAME = 3;
const F_CS_EXPIRES_AT_MS = 4;
const F_CS_CREATED_AT_MS = 5;

/* ------------------------------- VARINT ---------------------------------- */

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: i };
    shift += 7n;
    if (shift > 70n) throw new Error('varint terlalu panjang');
  }
  return null; // data belum lengkap
}

function writeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('varint negatif tidak didukung');
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

/* ------------------------------- DECODE ---------------------------------- */

/**
 * Decode buffer protobuf jadi daftar field.
 * Tiap field menyimpan `raw` (bytes lengkap termasuk tag) supaya bisa
 * di-encode ulang dengan aman.
 */
function decode(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const tag = readVarint(buf, i);
    if (!tag) break;
    i = tag.offset;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 0x7n);
    let value;

    if (wire === WIRE.VARINT) {
      const r = readVarint(buf, i);
      if (!r) break;
      i = r.offset;
      value = r.value;
    } else if (wire === WIRE.FIXED64) {
      if (i + 8 > buf.length) break;
      value = buf.subarray(i, i + 8);
      i += 8;
    } else if (wire === WIRE.BYTES) {
      const r = readVarint(buf, i);
      if (!r) break;
      i = r.offset;
      const len = Number(r.value);
      if (i + len > buf.length) break;
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wire === WIRE.FIXED32) {
      if (i + 4 > buf.length) break;
      value = buf.subarray(i, i + 4);
      i += 4;
    } else {
      break; // group / wire tidak dikenal -> berhenti (sisanya dibiarkan)
    }

    fields.push({ field, wire, value, raw: buf.subarray(start, i) });
  }
  return fields;
}

function encodeFields(fields) {
  return Buffer.concat(fields.map((f) => f.raw));
}

/* --------------------------- STRUKTUR FIELD ------------------------------ */

function buildRaw(field, wire, value) {
  const tag = writeVarint((BigInt(field) << 3n) | BigInt(wire));
  switch (wire) {
    case WIRE.VARINT:
      return Buffer.concat([tag, writeVarint(value)]);
    case WIRE.FIXED64:
    case WIRE.FIXED32:
      return Buffer.concat([tag, value]);
    case WIRE.BYTES:
      return Buffer.concat([tag, writeVarint(BigInt(value.length)), value]);
    default:
      throw new Error(`wire type ${wire} tidak didukung`);
  }
}

/** Buat field length-delimited (message/string/bytes). */
function bytesField(field, value) {
  if (!Buffer.isBuffer(value)) value = Buffer.from(String(value), 'utf8');
  return { field, wire: WIRE.BYTES, value, raw: buildRaw(field, WIRE.BYTES, value) };
}

function stringField(field, text) {
  return bytesField(field, Buffer.from(String(text), 'utf8'));
}

function varintField(field, value) {
  const v = BigInt(value);
  return { field, wire: WIRE.VARINT, value: v, raw: buildRaw(field, WIRE.VARINT, v) };
}

/** fixed64 selalu 8 byte little-endian. */
function fixed64Field(field, value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return { field, wire: WIRE.FIXED64, value: buf, raw: buildRaw(field, WIRE.FIXED64, buf) };
}

/** google.protobuf.StringValue  = message { string value = 1; } */
function stringValueWrapper(text) {
  return stringField(1, text);
}

/** google.protobuf.UInt64Value  = message { uint64 value = 1; } */
function uint64ValueWrapper(value) {
  return varintField(1, value);
}

/* --------------------------- OPERASI LIST FIELD -------------------------- */

const findField = (fields, field) => fields.find((f) => f.field === field) || null;
const hasField = (fields, field) => fields.some((f) => f.field === field);

/** Ganti field (atau tambahkan) tanpa merusak field lain. */
function setField(fields, field, entry) {
  const out = [];
  let done = false;
  for (const f of fields) {
    if (f.field === field) {
      if (!done) { out.push(entry); done = true; }
      continue; // buang duplikat
    }
    out.push(f);
  }
  if (!done) out.push(entry);
  return out;
}

function removeField(fields, field) {
  return fields.filter((f) => f.field !== field);
}

/* ------------------------------ PEMBACA ---------------------------------- */

function readString(fields, field) {
  const f = findField(fields, field);
  return f && f.wire === WIRE.BYTES ? f.value.toString('utf8') : null;
}

function readFixed64(fields, field) {
  const f = findField(fields, field);
  return f && f.wire === WIRE.FIXED64 && f.value.length === 8 ? f.value.readBigUInt64LE(0) : 0n;
}

function readWrapperString(fields, field) {
  const f = findField(fields, field);
  if (!f || f.wire !== WIRE.BYTES) return null;
  return readString(decode(f.value), 1);
}

/* --------------------------- API LEVEL TINGGI ---------------------------- */

/** Ambil bagian StatusSettings (field 11) dari settings proto. */
function getStatusFields(settingsBuf) {
  const root = decode(settingsBuf);
  const statusEntry = findField(root, F_SETTINGS_STATUS);
  return {
    root,
    statusFields: statusEntry && statusEntry.wire === WIRE.BYTES ? decode(statusEntry.value) : [],
  };
}

function putStatusFields(root, statusFields) {
  return encodeFields(setField(root, F_SETTINGS_STATUS, bytesField(F_SETTINGS_STATUS, encodeFields(statusFields))));
}

/** Baca custom status dari settings proto (dipakai untuk mode "kunci status"). */
function readCustomStatus(settingsBuf) {
  const empty = { found: false, text: '', emojiName: '', emojiId: '', expiresAtMs: 0, createdAtMs: 0 };
  if (!settingsBuf || settingsBuf.length === 0) return empty;

  let statusFields;
  try {
    ({ statusFields } = getStatusFields(settingsBuf));
  } catch {
    return empty;
  }

  const csEntry = findField(statusFields, F_STATUS_CUSTOM);
  if (!csEntry || csEntry.wire !== WIRE.BYTES) return empty;

  let cs;
  try {
    cs = decode(csEntry.value);
  } catch {
    return empty;
  }

  const emojiId = readFixed64(cs, F_CS_EMOJI_ID);
  return {
    found: true,
    text: readString(cs, F_CS_TEXT) || '',
    emojiName: readString(cs, F_CS_EMOJI_NAME) || '',
    emojiId: emojiId > 0n ? emojiId.toString() : '',
    expiresAtMs: Number(readFixed64(cs, F_CS_EXPIRES_AT_MS)),
    createdAtMs: Number(readFixed64(cs, F_CS_CREATED_AT_MS)),
  };
}

/** Baca pilihan status (online/idle/dnd/invisible) yang tersimpan di settings. */
function readPresenceStatus(settingsBuf) {
  if (!settingsBuf || settingsBuf.length === 0) return '';
  try {
    const { statusFields } = getStatusFields(settingsBuf);
    return readWrapperString(statusFields, F_STATUS_VALUE) || '';
  } catch {
    return '';
  }
}

/**
 * Pasang / perbarui custom status.
 * expiresAtMs = 0 (default) -> field expires TIDAK ditulis sama sekali
 * = "Don't clear" (tidak pernah kedaluwarsa).
 */
function upsertCustomStatus(settingsBuf, { text = '', emojiName = '', emojiId = '', createdAtMs = Date.now(), expiresAtMs = 0 } = {}) {
  const { root, statusFields: current } = getStatusFields(settingsBuf || Buffer.alloc(0));
  let statusFields = current;

  const customFields = [];
  if (text) customFields.push(stringField(F_CS_TEXT, text));
  if (emojiId) customFields.push(fixed64Field(F_CS_EMOJI_ID, emojiId));
  if (emojiName) customFields.push(stringField(F_CS_EMOJI_NAME, emojiName));
  if (expiresAtMs) customFields.push(fixed64Field(F_CS_EXPIRES_AT_MS, expiresAtMs));
  customFields.push(fixed64Field(F_CS_CREATED_AT_MS, createdAtMs));

  if (!text && !emojiName && !emojiId) {
    statusFields = removeField(statusFields, F_STATUS_CUSTOM); // hapus status
  } else {
    statusFields = setField(statusFields, F_STATUS_CUSTOM, bytesField(F_STATUS_CUSTOM, encodeFields(customFields)));
  }

  // status_expires_at_ms (field 4) dibersihkan: kita pakai 0 = permanen
  if (expiresAtMs === 0) statusFields = removeField(statusFields, F_STATUS_EXPIRES_AT_MS);

  return putStatusFields(root, statusFields);
}

/** Hapus custom status dari settings. */
function clearCustomStatus(settingsBuf) {
  const { root, statusFields } = getStatusFields(settingsBuf || Buffer.alloc(0));
  return putStatusFields(root, removeField(statusFields, F_STATUS_CUSTOM));
}

/** Simpan pilihan status (online/idle/dnd/invisible) supaya permanen. */
function setPresenceStatusSetting(settingsBuf, status, { createdAtMs = Date.now() } = {}) {
  const { root, statusFields: current } = getStatusFields(settingsBuf || Buffer.alloc(0));
  let statusFields = current;
  statusFields = setField(statusFields, F_STATUS_VALUE, bytesField(F_STATUS_VALUE, encodeFields([stringValueWrapper(status)])));
  statusFields = setField(
    statusFields,
    F_STATUS_CREATED_AT_MS,
    bytesField(F_STATUS_CREATED_AT_MS, encodeFields([uint64ValueWrapper(createdAtMs)])),
  );
  statusFields = removeField(statusFields, F_STATUS_EXPIRES_AT_MS); // 0 = tidak pernah kedaluwarsa
  return putStatusFields(root, statusFields);
}

/* ---- Helper agar mudah dites / dipakai modul lain (mis. event gateway) ---- */

/** Decode base64 settings proto dari event USER_SETTINGS_PROTO_UPDATE. */
function fromBase64(b64) {
  if (!b64) return Buffer.alloc(0);
  return Buffer.from(b64, 'base64');
}

function toBase64(buf) {
  return (buf || Buffer.alloc(0)).toString('base64');
}

module.exports = {
  WIRE,
  decode,
  encodeFields,
  bytesField,
  stringField,
  varintField,
  fixed64Field,
  findField,
  hasField,
  setField,
  removeField,
  getStatusFields,
  putStatusFields,
  readCustomStatus,
  readPresenceStatus,
  upsertCustomStatus,
  clearCustomStatus,
  setPresenceStatusSetting,
  fromBase64,
  toBase64,
};
