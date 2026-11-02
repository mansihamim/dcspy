'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Scout } = require('../src/scout');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = { info() {}, warn() {}, error() {} };

function makeScout(dir) {
  const scout = new Scout({ token: 'fake', log, enabled: true, mulaiDetik: 3600 });
  scout.dirData = dir;
  scout.berkasNegara = path.join(dir, 'negara.json');
  scout.berkasKnown = path.join(dir, 'known.json');
  scout.berkasTemuan = path.join(dir, 'temuan.json');
  scout.berkasState = path.join(dir, 'state.json');
  scout.berkasStat = path.join(dir, 'stat.json');
  scout.kontrol = { close() {} };
  scout._segarkanIdSet = async () => {};
  fs.mkdirSync(dir, { recursive: true });
  // Cache lama sengaja lebih dari TTL 24 jam; jangan digunakan.
  fs.writeFileSync(scout.berkasNegara, JSON.stringify({
    ts: Date.now() - 48 * 60 * 60 * 1000,
    negara: [{ cc: 'old', fps: ['STALE'] }],
  }));
  return scout;
}

async function main() {
  const fetchOriginal = global.fetch;
  const retryOriginal = process.env.SCOUT_ONIONOO_RETRY_DETIK;
  const mainTokenPolicyOriginal = process.env.SCOUT_TOKEN_UTAMA;
  const intervalCautiousOriginal = process.env.SCOUT_INTERVAL_HATI_HATI;
  const burstCautiousOriginal = process.env.SCOUT_BURST_HATI_HATI;
  const jedaCautiousOriginal = process.env.SCOUT_JEDA_HATI_HATI;
  const burstBaseOriginal = process.env.SCOUT_BURST_MAKS;
  const jedaBaseOriginal = process.env.SCOUT_JEDA_ANTAR_NEGARA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-retry-test-'));
  let scoutPulih;
  let scoutOff;
  let scoutDefault;
  let scoutMainDenied;
  let scoutCautious;
  try {
    // Safety default: no Tor/Discord scan unless the operator explicitly enables Scout.
    scoutDefault = new Scout({ token: 'fake', log });
    assert.equal(scoutDefault.status().enabled, false);
    assert.equal(scoutDefault.status().aktif, false);
    global.fetch = async () => { throw new Error('default-off Scout must not fetch'); };
    await scoutDefault.start();
    assert.equal(scoutDefault.status().enabled, false);
    scoutDefault.stop();
    scoutDefault = null;

    // A main-token guard must reject before Onionoo and before the baseline /quests/@me request.
    process.env.SCOUT_TOKEN_UTAMA = 'tolak';
    const policyLogs = [];
    const policyLog = {
      info: (m) => policyLogs.push(String(m)),
      warn: (m) => policyLogs.push(String(m)),
      error: (m) => policyLogs.push(String(m)),
      debug: (m) => policyLogs.push(String(m)),
    };
    let onionooCalls = 0;
    let baselineCalls = 0;
    scoutMainDenied = new Scout({
      token: 'main-token-sentinel', log: policyLog, enabled: true, tokenKhusus: false,
    });
    scoutMainDenied._muatNegara = async () => { onionooCalls += 1; };
    scoutMainDenied._segarkanIdSet = async () => { baselineCalls += 1; };
    await scoutMainDenied.start();
    assert.equal(onionooCalls, 0, 'main-token guard runs before Onionoo');
    assert.equal(baselineCalls, 0, 'main-token guard runs before /quests/@me baseline');
    assert.equal(scoutMainDenied.status().aktif, false);
    assert.equal(scoutMainDenied.status().enabled, false, 'blocked startup leaves Scout OFF');
    assert.equal(scoutMainDenied.status().tokenUtamaDitolak, true);
    scoutMainDenied.setAktif(true);
    assert.equal(scoutMainDenied.status().enabled, false, 'dashboard ON is rejected without explicit opt-in');
    assert.equal(policyLogs.join('\n').includes('main-token-sentinel'), false, 'token value is never logged');
    scoutMainDenied.stop();
    scoutMainDenied = null;

    // Explicit opt-in stays bounded: max 3 countries, at least 8s between them, 5m between rounds.
    process.env.SCOUT_TOKEN_UTAMA = 'izin';
    process.env.SCOUT_BURST_MAKS = '10';
    process.env.SCOUT_JEDA_ANTAR_NEGARA = '2';
    process.env.SCOUT_BURST_HATI_HATI = '3';
    process.env.SCOUT_JEDA_HATI_HATI = '8';
    process.env.SCOUT_INTERVAL_HATI_HATI = '5';
    scoutCautious = new Scout({
      token: 'main-token-sentinel', log: policyLog, enabled: false, intervalMin: 0, tokenKhusus: false,
    });
    assert.equal(scoutCautious.status().hatiHati, true);
    assert.equal(scoutCautious.status().tokenKhusus, false);
    assert.equal(scoutCautious.status().burstMaks, 3);
    assert.ok(scoutCautious.status().jedaAntar >= 8);
    assert.ok(scoutCautious.status().intervalMin >= 5);
    scoutCautious.setToken('quest-token-sentinel', { tokenKhusus: true });
    assert.equal(scoutCautious.status().hatiHati, false, 'dedicated quest token restores its own mode');
    assert.equal(scoutCautious.status().tokenKhusus, true);
    assert.equal(policyLogs.join('\n').includes('quest-token-sentinel'), false, 'token changes never log credentials');
    scoutCautious.stop();
    scoutCautious = null;

    process.env.SCOUT_ONIONOO_RETRY_DETIK = '1';
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulated DNS failure');
      return { ok: true, json: async () => ({ relays: [{ fingerprint: 'FRESH', country: 'us' }] }) };
    };

    scoutPulih = makeScout(path.join(tmp, 'retry'));
    await scoutPulih.start();
    assert.equal(calls, 1);
    assert.equal(scoutPulih.dimintaAktif, true, 'desired ON state must survive a fetch failure');
    assert.equal(scoutPulih.aktif, false, 'must wait until a fresh country list is loaded');
    assert.deepEqual(scoutPulih.negara, [], 'expired cache must not be used');
    assert.ok(scoutPulih._retryNegaraTimer, 'retry timer should be scheduled');

    await sleep(1250);
    assert.equal(calls, 2, 'fetch should retry automatically');
    assert.equal(scoutPulih.aktif, true, 'Scout should activate after the fresh list loads');
    assert.deepEqual(scoutPulih.negara, [{ cc: 'us', fps: ['FRESH'] }]);
    assert.equal(scoutPulih._retryNegaraTimer, null);
    scoutPulih.stop();
    scoutPulih = null;

    let callsAfterOff = 0;
    global.fetch = async () => {
      callsAfterOff += 1;
      throw new Error('simulated DNS failure');
    };
    scoutOff = makeScout(path.join(tmp, 'off'));
    await scoutOff.start();
    assert.equal(callsAfterOff, 1);
    scoutOff.setAktif(false);
    assert.equal(scoutOff._retryNegaraTimer, null, 'OFF must cancel the pending retry');
    await sleep(1150);
    assert.equal(callsAfterOff, 1, 'no retry may happen after the user turns Scout OFF');
    assert.equal(scoutOff.dimintaAktif, false);
    scoutOff.stop();
    scoutOff = null;

    console.log('scout-retry.test.js — passed (default OFF; main-token guard/cautious opt-in; fresh-list retry; OFF cancels retry).');
  } finally {
    if (scoutPulih) scoutPulih.stop();
    if (scoutOff) scoutOff.stop();
    if (scoutDefault) scoutDefault.stop();
    global.fetch = fetchOriginal;
    const restoreEnv = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restoreEnv('SCOUT_ONIONOO_RETRY_DETIK', retryOriginal);
    restoreEnv('SCOUT_TOKEN_UTAMA', mainTokenPolicyOriginal);
    restoreEnv('SCOUT_INTERVAL_HATI_HATI', intervalCautiousOriginal);
    restoreEnv('SCOUT_BURST_HATI_HATI', burstCautiousOriginal);
    restoreEnv('SCOUT_JEDA_HATI_HATI', jedaCautiousOriginal);
    restoreEnv('SCOUT_BURST_MAKS', burstBaseOriginal);
    restoreEnv('SCOUT_JEDA_ANTAR_NEGARA', jedaBaseOriginal);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('scout-retry.test.js — FAIL', err.stack || err.message);
  process.exitCode = 1;
});
