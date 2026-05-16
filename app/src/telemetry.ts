// Tiny instrumentation singleton for the collab debug panel.
//
// Counts every billable interaction with the relay so we can hold the
// live numbers up against `docs/collab-budget.md` and find leaks.
//
// Two independent stores:
//   - counts: a per-category running tally. Used to answer "how many
//             messages did the formula bar send this session?"
//   - log:    a bounded ring buffer of recent events with timestamps.
//             Used in the debug panel as a scrolling activity feed
//             ("0.4s ago: outbound axis-presence, 1 msg").
//
// Safe to call from anywhere; no React. The DebugPanel subscribes via
// onChange() and re-renders on its own debounced cadence. When the
// panel is hidden (the common case in production) the cost is one
// integer increment per call -- effectively free.

export type Direction = 'out' | 'in' | 'event';

export interface TelemetryEvent {
  ts: number;            // performance.now() ms since page load
  direction: Direction;  // out: client->relay, in: relay->client, event: UI
  category: string;      // free-form, see docs/collab-budget.md
  detail?: string;       // optional one-line context ("axis=temp")
  size?: number;         // bytes (when applicable)
}

export interface TelemetrySnapshot {
  countsOut: Record<string, number>;
  countsIn: Record<string, number>;
  countsEvent: Record<string, number>;
  totalOut: number;
  totalIn: number;
  totalEvent: number;
  bytesOut: number;
  bytesIn: number;
  startedAt: number;     // performance.now() at session start (or last reset)
  log: TelemetryEvent[]; // most recent first, capped at LOG_MAX
}

const LOG_MAX = 100;
const NOTIFY_DEBOUNCE_MS = 100;

class Telemetry {
  private countsOut: Record<string, number> = {};
  private countsIn: Record<string, number> = {};
  private countsEvent: Record<string, number> = {};
  private totalOut = 0;
  private totalIn = 0;
  private totalEvent = 0;
  private bytesOut = 0;
  private bytesIn = 0;
  private log: TelemetryEvent[] = [];
  private startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

  private listeners = new Set<(s: TelemetrySnapshot) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  recordOut(category: string, detail?: string, size?: number) {
    this.countsOut[category] = (this.countsOut[category] ?? 0) + 1;
    this.totalOut += 1;
    if (size !== undefined) this.bytesOut += size;
    this.push({ ts: this.now(), direction: 'out', category, detail, size });
  }

  recordIn(category: string, detail?: string, size?: number) {
    this.countsIn[category] = (this.countsIn[category] ?? 0) + 1;
    this.totalIn += 1;
    if (size !== undefined) this.bytesIn += size;
    this.push({ ts: this.now(), direction: 'in', category, detail, size });
  }

  recordEvent(category: string, detail?: string) {
    this.countsEvent[category] = (this.countsEvent[category] ?? 0) + 1;
    this.totalEvent += 1;
    this.push({ ts: this.now(), direction: 'event', category, detail });
  }

  reset() {
    this.countsOut = {};
    this.countsIn = {};
    this.countsEvent = {};
    this.totalOut = 0;
    this.totalIn = 0;
    this.totalEvent = 0;
    this.bytesOut = 0;
    this.bytesIn = 0;
    this.log = [];
    this.startedAt = this.now();
    this.scheduleNotify();
  }

  snapshot(): TelemetrySnapshot {
    return {
      countsOut: { ...this.countsOut },
      countsIn: { ...this.countsIn },
      countsEvent: { ...this.countsEvent },
      totalOut: this.totalOut,
      totalIn: this.totalIn,
      totalEvent: this.totalEvent,
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
      startedAt: this.startedAt,
      log: this.log.slice(),
    };
  }

  onChange(cb: (s: TelemetrySnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => { this.listeners.delete(cb); };
  }

  private push(ev: TelemetryEvent) {
    this.log.unshift(ev);
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
    this.scheduleNotify();
  }

  private scheduleNotify() {
    if (this.notifyTimer != null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const snap = this.snapshot();
      for (const cb of this.listeners) cb(snap);
    }, NOTIFY_DEBOUNCE_MS);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}

export const telemetry = new Telemetry();

// ── Debug-mode activation ──────────────────────────────────────────────
//
// Two ways to turn it on:
//   1. URL: `?debug=1` or `#debug=1` (anywhere in the query or fragment).
//   2. localStorage: `localStorage.setItem('utopiamap.debug', '1')`.
//
// Both are sticky for the rest of the page; the localStorage flag
// also persists across reloads. We deliberately don't make this a
// runtime toggle from the UI — debug mode is for developers.

const DEBUG_LS_KEY = 'utopiamap.debug';

export function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const search = new URLSearchParams(window.location.search);
    if (search.get('debug') === '1') return true;
    const hash = (window.location.hash || '').replace(/^#/, '');
    const hashParams = new URLSearchParams(hash);
    if (hashParams.get('debug') === '1') return true;
    if (localStorage.getItem(DEBUG_LS_KEY) === '1') return true;
  } catch {
    // localStorage may throw in private mode; URL parsing is safe.
  }
  return false;
}

// Convenience: call from devtools to toggle without messing with the URL.
if (typeof window !== 'undefined') {
  (window as unknown as { utopiaDebug?: { on: () => void; off: () => void; reset: () => void } }).utopiaDebug = {
    on: () => { try { localStorage.setItem(DEBUG_LS_KEY, '1'); } catch {} location.reload(); },
    off: () => { try { localStorage.removeItem(DEBUG_LS_KEY); } catch {} location.reload(); },
    reset: () => telemetry.reset(),
  };
}
