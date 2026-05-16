// Live cost-instrumentation overlay for the collab relay.
//
// Visible only when debug mode is on (`?debug=1` or `#debug=1` in the
// URL, or `localStorage.utopiamap.debug = '1'`). Renders a fixed
// bottom-left card with:
//   - per-category outbound message counts (the billable side)
//   - per-category inbound message counts (peer broadcasts)
//   - rolling activity log (most recent 20 events)
//   - bytes in/out
//   - projected monthly cost extrapolating current msg/min rate
//
// Compare the live numbers against `docs/collab-budget.md`; anything
// above spec is a leak. The panel itself talks to the `telemetry`
// singleton which is populated by `collab.ts` on every send/receive.

import { useEffect, useState } from 'react';
import { telemetry, type TelemetrySnapshot } from './telemetry';

const PANEL_LOG_LIMIT = 20;

// Workers Paid pricing (verified late 2025): $0.30 per million Workers
// requests, $0.20 per million DO requests beyond the included quota.
// Each outbound msg = 1 Workers request + 1 DO request, so combined
// marginal cost is $0.50 per million. Below the included quota the
// marginal cost is $0, but the projection is what *would* be charged
// at the user's current rate so we use the marginal price.
const COST_PER_MILLION_USD = 0.5;
const INCLUDED_MSGS_PER_MONTH = 10_000_000; // base Workers Paid quota

export function DebugPanel() {
  const [snap, setSnap] = useState<TelemetrySnapshot>(() => telemetry.snapshot());
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => telemetry.onChange(setSnap), []);

  // Tick once a second so the rate / projected numbers update even
  // when nothing is happening on the wire.
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.max(1, (now - snap.startedAt) / 1000);
  const msgsPerMin = (snap.totalOut / elapsedSec) * 60;
  const projectedMonthlyMsgs = msgsPerMin * 60 * 24 * 30;
  const projectedExtraMsgs = Math.max(0, projectedMonthlyMsgs - INCLUDED_MSGS_PER_MONTH);
  const projectedCostUsd = (projectedExtraMsgs / 1_000_000) * COST_PER_MILLION_USD;

  return (
    <div className={`debug-panel${collapsed ? ' debug-panel-collapsed' : ''}`}>
      <div className="debug-panel-header">
        <span className="debug-panel-title">collab telemetry</span>
        <div className="debug-panel-actions">
          <button onClick={() => telemetry.reset()} title="Reset all counters">reset</button>
          <button onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="debug-panel-body">
          <div className="debug-panel-summary">
            <div><span className="debug-panel-num">{snap.totalOut}</span> out</div>
            <div><span className="debug-panel-num">{snap.totalIn}</span> in</div>
            <div><span className="debug-panel-num">{fmtBytes(snap.bytesOut)}</span> ↑</div>
            <div><span className="debug-panel-num">{fmtBytes(snap.bytesIn)}</span> ↓</div>
            <div title="Outbound msgs/min, averaged over the session">
              <span className="debug-panel-num">{msgsPerMin.toFixed(1)}</span> msg/min
            </div>
            <div title="Projected monthly cost at current outbound rate (Workers Paid: $5 base + $0.50/M after 10M)">
              <span className="debug-panel-num">${projectedCostUsd.toFixed(2)}</span>/mo extra
            </div>
          </div>

          <Section title="outbound (billable)" counts={snap.countsOut} />
          <Section title="inbound (from peers)" counts={snap.countsIn} />

          <div className="debug-panel-section-title">recent events</div>
          <div className="debug-panel-log">
            {snap.log.slice(0, PANEL_LOG_LIMIT).map((ev, i) => (
              <div key={i} className={`debug-panel-log-row debug-panel-log-${ev.direction}`}>
                <span className="debug-panel-log-ts">{fmtAge(now - ev.ts)}</span>
                <span className="debug-panel-log-dir">{symbolFor(ev.direction)}</span>
                <span className="debug-panel-log-cat">{ev.category}</span>
                {ev.size !== undefined && (
                  <span className="debug-panel-log-size">{ev.size}b</span>
                )}
                {ev.detail && <span className="debug-panel-log-detail">{ev.detail}</span>}
              </div>
            ))}
            {snap.log.length === 0 && (
              <div className="debug-panel-log-empty">no traffic yet</div>
            )}
          </div>

          <div className="debug-panel-foot">
            spec: <code>docs/collab-budget.md</code>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <>
      <div className="debug-panel-section-title">{title}</div>
      <div className="debug-panel-table">
        {entries.map(([cat, n]) => (
          <div className="debug-panel-row" key={cat}>
            <span className="debug-panel-row-cat">{cat}</span>
            <span className="debug-panel-row-num">{n}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / 1024 / 1024).toFixed(2)}M`;
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

function symbolFor(d: 'out' | 'in' | 'event'): string {
  if (d === 'out') return '↑';
  if (d === 'in') return '↓';
  return '•';
}
