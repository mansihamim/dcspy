'use strict';

/**
 * Logger sederhana dengan timestamp + level.
 * Level: debug < info < warn < error
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(levelName = 'info') {
  const min = LEVELS[String(levelName).toLowerCase()] ?? LEVELS.info;

  const write = (level, args) => {
    if (LEVELS[level] < min) return;
    const ts = new Date().toTimeString().slice(0, 8);
    const tag = level === 'info' ? '' : `[${level.toUpperCase()}] `;
    // eslint-disable-next-line no-console
    console.log(`[${ts}] ${tag}${args.join(' ')}`);
  };

  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

/** Format angka jadi "1:23" (menit:detik). */
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { createLogger, fmtDuration };
