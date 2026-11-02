'use strict';

/** Regression tests for Spotify polling reliability and health diagnostics. */
const assert = require('assert');
const http = require('../src/http');
const originalRequest = http.request;
const log = { info() {}, warn() {}, error() {}, debug() {} };
let respond = async () => ({ status: 204, ok: true, json: null, body: '', headers: {} });
http.request = (...args) => respond(...args);
delete require.cache[require.resolve('../src/spotify')];
const { SpotifyPresence } = require('../src/spotify');

const cfg = {
  enabled: true,
  accessToken: 'test-spotify-token',
  pollSec: 5,
  dealerPingSec: 15,
  dealerIdleTimeoutSec: 45,
  stopGraceSec: 3,
  resolveRetrySec: 5,
  debugDealer: false,
};
const makeSpotify = () => new SpotifyPresence({
  discordToken: 'test-discord-token', logger: log, cfg: { ...cfg }, userAgent: 'test-agent',
});
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('spotify.test.js — polling & diagnostics\n');

  await test('polling serializes slow calls and backs off on HTTP 429', async () => {
    let calls = 0;
    let finish;
    respond = async () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    };
    const sp = makeSpotify();
    const first = sp.poll();
    await Promise.resolve();
    await Promise.resolve();
    const concurrent = await sp.poll();
    assert.strictEqual(concurrent, undefined);
    assert.strictEqual(calls, 1, 'hanya satu /me/player request boleh berjalan');

    finish({ status: 429, ok: false, json: {}, body: '', headers: { 'retry-after': '2' } });
    await first;
    assert.strictEqual(sp.status().polling.lastStatus, 429);
    assert.strictEqual(sp.status().polling.failures, 1);
    assert.ok(sp.status().polling.backoffSec >= 1, 'jeda Retry-After tercatat');

    await sp.poll();
    assert.strictEqual(calls, 1, 'tidak mengulang request selama rate-limit cooldown');

    sp.pollBackoffUntil = 0;
    respond = async () => ({
      status: 200, ok: true, body: '', headers: {},
      json: {
        currently_playing_type: 'track', is_playing: true, progress_ms: 1200,
        item: {
          uri: 'spotify:track:track-1', name: 'Lagu Tes', duration_ms: 180000,
          artists: [{ name: 'Artis Tes' }], album: { name: 'Album Tes', images: [] },
        },
      },
    });
    await sp.poll();
    assert.strictEqual(sp.track.title, 'Lagu Tes');
    assert.strictEqual(sp.status().track.artist, 'Artis Tes');
    assert.strictEqual(sp.status().polling.lastStatus, 200);
    assert.ok(sp.status().polling.lastSuccessAt > 0);
    assert.strictEqual(sp.status().tokenAvailable, true);
    assert.strictEqual(JSON.stringify(sp.status()).includes('test-spotify-token'), false, 'health tidak pernah membocorkan token');
    sp.stop();
  });

  await test('polling fallback berhenti menembak API ketika Dealer real-time sehat', async () => {
    let calls = 0;
    respond = async () => { calls += 1; return { status: 204, ok: true, json: null, headers: {} }; };
    const sp = makeSpotify();
    sp.dealerReady = true;
    sp.dealerConnected = true;
    sp.ws = { readyState: 1 };
    sp.lastDealerMsg = Date.now();
    sp.lastDealerEventAt = Date.now();
    await sp.poll();
    assert.strictEqual(calls, 0);
    assert.strictEqual(sp.status().dealer.ready, true);
    assert.strictEqual(sp.status().source, 'dealer');
    sp.stop();
  });

  await test('poll fallback saat ping Dealer hidup tetapi connect-state sudah stale', async () => {
    let calls = 0;
    respond = async () => { calls += 1; return { status: 204, ok: true, json: null, headers: {} }; };
    const sp = makeSpotify();
    sp.dealerReady = true;
    sp.dealerConnected = true;
    sp.ws = { readyState: 1 };
    sp.lastDealerMsg = Date.now(); // pong masih datang
    sp.lastDealerEventAt = Date.now() - 60000; // tetapi update lagu sudah lama
    await sp.poll();
    assert.strictEqual(calls, 1, 'polling harus memulihkan data meskipun ping/pong masih aktif');
    assert.strictEqual(sp.status().dealer.fresh, false);
    assert.strictEqual(sp.status().source, 'polling');
    sp.stop();
  });

  await test('track baru dari polling mengganti sync_id dan mengirim change', async () => {
    const oldId = 'AAAAAAAAAAAAAAAAAAAAAA';
    const newId = 'BBBBBBBBBBBBBBBBBBBBBB';
    const sp = makeSpotify();
    sp.track = {
      uri: `spotify:track:${oldId}`, title: 'Lagu Lama', artist: 'Artis Lama', album: '',
      startMs: Date.now() - 1000, endMs: Date.now() + 100000, isPlaying: true,
    };
    sp.lastPlaybackUpdateAt = Date.now();
    let changes = 0;
    sp.on('change', () => { changes += 1; });
    respond = async () => ({
      status: 200, ok: true, body: '', headers: {},
      json: {
        currently_playing_type: 'track', is_playing: true, progress_ms: 500,
        item: {
          uri: `spotify:track:${newId}`, name: 'Lagu Baru', duration_ms: 200000,
          artists: [{ name: 'Artis Baru' }], album: { name: 'Album Baru', images: [] },
        },
      },
    });
    await sp.poll();
    assert.strictEqual(sp.track.title, 'Lagu Baru');
    assert.strictEqual(sp.currentActivity().sync_id, newId);
    assert.strictEqual(changes, 1, 'pergantian lagu memicu push presence');
    sp.stop();
  });

  await test('Discord auth 401 membersihkan track lama yang tidak bisa diverifikasi', async () => {
    const sp = makeSpotify();
    sp.cfg.accessToken = '';
    sp.track = {
      uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', title: 'Lagu Lama', artist: 'Artis Lama',
      startMs: Date.now() - 1000, endMs: Date.now() + 100000, isPlaying: true,
    };
    sp.lastPlaybackUpdateAt = Date.now();
    let changes = 0;
    sp.on('change', () => { changes += 1; });
    respond = async () => ({ status: 401, ok: false, json: { message: 'Unauthorized' }, body: '', headers: {} });
    await sp.poll();
    assert.strictEqual(sp.track, null);
    assert.strictEqual(sp.currentActivity(), null);
    assert.strictEqual(sp.status().polling.lastStatus, 401);
    assert.strictEqual(sp.status().track, null);
    assert.strictEqual(changes, 1);
    sp.stop();
  });

  await test('Spotify API 401 membersihkan status lagu cached', async () => {
    const sp = makeSpotify();
    sp.track = {
      uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', title: 'Lagu Cached', artist: 'Artis',
      startMs: Date.now() - 1000, endMs: Date.now() + 100000, isPlaying: true,
    };
    sp.lastPlaybackUpdateAt = Date.now();
    let changes = 0;
    sp.on('change', () => { changes += 1; });
    respond = async () => ({ status: 401, ok: false, json: { message: 'Unauthorized' }, body: '', headers: {} });
    await sp.poll();
    assert.strictEqual(sp.track, null);
    assert.strictEqual(sp.status().polling.lastStatus, 401);
    assert.strictEqual(changes, 1);
    sp.stop();
  });

  await test('episode dan data pemutaran stale tidak meninggalkan lagu sebelumnya', async () => {
    const sp = makeSpotify();
    sp.track = {
      uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', title: 'Track Lama', artist: 'Artis',
      startMs: Date.now() - 1000, endMs: Date.now() + 100000, isPlaying: true,
    };
    sp.lastPlaybackUpdateAt = Date.now();
    respond = async () => ({
      status: 200, ok: true, body: '', headers: {},
      json: {
        currently_playing_type: 'episode', is_playing: true, progress_ms: 1200,
        item: { uri: 'spotify:episode:episode-1', name: 'Podcast' },
      },
    });
    await sp.poll();
    assert.strictEqual(sp.track.isPlaying, false);
    sp.stoppedSince = Date.now() - 4000;
    assert.strictEqual(sp.maintainPlayback(), true);
    assert.strictEqual(sp.track, null);

    sp.track = {
      uri: 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB', title: 'Track Stale', artist: 'Artis',
      startMs: Date.now() - 1000, endMs: Date.now() + 100000, isPlaying: true,
    };
    sp.lastPlaybackUpdateAt = Date.now() - 120000;
    assert.strictEqual(sp.maintainPlayback(), true);
    assert.strictEqual(sp.track, null);
    sp.stop();
  });

  await test('tautan Spotify memakai track ID mentah dan party ID Discord', async () => {
    const sp = makeSpotify();
    sp.track = {
      uri: 'spotify:track:0123456789ABCDEFGHIJKL',
      title: 'Lagu Tes', artist: 'Artis Tes', album: 'Album Tes', imageId: 'cover-id',
      startMs: 1000, endMs: 181000, isPlaying: true,
    };
    const activity = sp.currentActivity({ discordUserId: '1120443084858204290' });
    assert.strictEqual(activity.sync_id, '0123456789ABCDEFGHIJKL');
    assert.strictEqual(activity.party.id, 'spotify:1120443084858204290');
    assert.strictEqual(activity.session_id, undefined, 'session_id tidak boleh diisi dengan Spotify ID');

    const withoutDiscordId = sp.currentActivity();
    assert.strictEqual(withoutDiscordId.party, undefined, 'tanpa Discord ID jangan pakai ID Spotify sebagai party');
    sp.track.uri = 'spotify:album:0123456789ABCDEFGHIJKL';
    assert.strictEqual(sp.currentActivity({ discordUserId: '1120443084858204290' }).sync_id, undefined);
    sp.stop();
  });

  http.request = originalRequest;
  console.log(`\n${passed} test lulus${process.exitCode ? ' (ada yang gagal!)' : '.'}`);
  process.exit(process.exitCode || 0);
})();
