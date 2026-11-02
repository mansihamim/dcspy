'use strict';

/**
 * Pembungkus HTTP pakai fetch bawaan Node (18+).
 * Semua request di project ini lewat sini, biar rapi & ada timeout.
 */

/**
 * @param {string} method
 * @param {string} url
 * @param {{headers?: Record<string,string>, body?: string, timeoutMs?: number}} opts
 * @returns {Promise<{status:number, ok:boolean, body:string, json:any, headers:Record<string,string>}>}
 */
async function request(method, url, opts = {}) {
  const { headers = {}, body, timeoutMs = 25000 } = opts; // 25s: VPS kadang lambat
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { /* bukan JSON, biarkan null */ }
    }
    return {
      status: res.status,
      ok: res.ok,
      body: text,
      json,
      headers: Object.fromEntries(res.headers.entries()),
    };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(err && err.message ? err.message : err);
    return { status: 0, ok: false, body: '', json: null, headers: {}, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** GET yang mengembalikan JSON (atau null). */
async function getJson(url, headers = {}, timeoutMs = 25000) {
  const res = await request('GET', url, { headers, timeoutMs });
  if (res.status !== 200) return { status: res.status, json: null, body: res.body };
  return { status: res.status, json: res.json, body: res.body };
}

/** PATCH dengan body JSON. */
async function patchJson(url, payload, headers = {}, timeoutMs = 25000) {
  return request('PATCH', url, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { request, getJson, patchJson, sleep };
