const DEFAULT_UNDO_HISTORY = 10;

let undoHistoryLimit = DEFAULT_UNDO_HISTORY;

export function normalizeUndoHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_UNDO_HISTORY;
  return Math.max(1, Math.min(100, Math.round(parsed)));
}

export function setUndoHistoryLimit(value: unknown): void {
  undoHistoryLimit = normalizeUndoHistoryLimit(value);
}

export function getUndoHistoryLimit(): number {
  return undoHistoryLimit;
}
