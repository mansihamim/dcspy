'use strict';

/**
 * Small shared helpers for interpreting Discord quest progress.
 * Keep the server's value as the source of truth: a requested timestamp or a
 * cached value must never be substituted for a missing/zero server value.
 */
const DEFAULT_TARGETS = Object.freeze({
  PLAY_ON_DESKTOP: 900,
  WATCH_VIDEO: 60,
  WATCH_VIDEO_ON_MOBILE: 60,
});

function targetFor(task, type) {
  const raw = task && task.target;
  if (raw !== undefined && raw !== null && raw !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_TARGETS[type] || 0;
}

/**
 * Read an explicitly supplied task value. `known:false` is distinct from 0:
 * zero is real progress and must not fall back to a stale/local estimate.
 */
function readTaskProgress(source, type) {
  const root = source && source.progress && typeof source.progress === 'object'
    ? source.progress
    : source;
  const entry = root && type ? root[type] : undefined;
  if (entry === undefined || entry === null) return { known: false, value: 0 };
  const raw = typeof entry === 'object' ? entry.value : entry;
  if (raw === undefined || raw === null || raw === '') return { known: false, value: 0 };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { known: false, value: 0 };
  return { known: true, value };
}

/**
 * `completed_at` is authoritative unless the same payload explicitly reports
 * that the selected task is still below its target. In that contradictory
 * case keep it eligible and reconcile with later server progress instead of
 * showing a false green "done" state.
 */
function completionState(userStatus, type, target) {
  const completedAt = Boolean(userStatus && userStatus.completed_at);
  const progress = type ? readTaskProgress(userStatus, type) : { known: false, value: 0 };
  const goal = Number(target);
  const hasGoal = Number.isFinite(goal) && goal > 0;
  const mismatch = completedAt && progress.known && hasGoal && progress.value < goal;
  return {
    completed: completedAt && !mismatch,
    completedAt,
    mismatch,
    progress,
  };
}

module.exports = { DEFAULT_TARGETS, targetFor, readTaskProgress, completionState };
