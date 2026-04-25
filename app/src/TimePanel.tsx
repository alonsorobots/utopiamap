import { useState, useRef, useEffect, useCallback, useImperativeHandle, useMemo, forwardRef } from 'react';

const DEFAULT_MIN_YEAR = 1980;
const DEFAULT_MAX_YEAR = 2050;
const DEFAULT_YEAR = new Date().getFullYear();
const PLAY_INTERVAL_MS = 250;

// Years > this cutoff are served from the projection scenario (we ship only
// SSP5-8.5 right now -- see pipeline/build_tiles.py ZABEL_PERIODS).
const PROJECTION_SCENARIO = 'ssp585';

interface TimePanelProps {
  onTimeChange?: (year: number, scenario: string) => void;
  disabled?: boolean;
  initialYear?: number;
  overrideYear?: number;
  temporalRange?: { first: number; last: number } | null;
  projections?: Record<string, number[]> | null;
  /** Sorted list of every year that actually has data (for tick marks). */
  dataYears?: number[];
}

export interface TimePanelHandle {
  togglePlay: () => void;
  jumpToYear: (y: number) => void;
  /** Move one tick forward (+1) or backward (-1) through the data years. */
  stepYear: (dir: 1 | -1) => void;
}

export const TimePanel = forwardRef<TimePanelHandle, TimePanelProps>(
  function TimePanel({
    onTimeChange,
    disabled = false,
    initialYear,
    overrideYear,
    temporalRange,
    projections,
    dataYears,
  }, ref) {
  const projYears = useMemo(() => {
    const arr = projections?.[PROJECTION_SCENARIO] ?? [];
    return [...arr].sort((a, b) => a - b);
  }, [projections]);
  const hasProjections = projYears.length > 0;

  // Visual cutoff between "current data" and "projected data".  We anchor to
  // today's calendar year so the teal projection range only kicks in when the
  // user scrubs into the future, but we never put the cutoff *before* the last
  // historical year either (that would paint actually-historical years teal).
  // The data-fetch logic in tileDataLoader independently snaps to the nearest
  // available historical or projection year.
  const projCutoff = useMemo(() => {
    const histLast = temporalRange?.last ?? 0;
    return Math.max(histLast, DEFAULT_YEAR);
  }, [temporalRange]);

  // Slider track extent: covers historical + projection range so a single
  // scrub takes the user past today into the future seamlessly.
  const trackRange = useMemo(() => {
    let lo = DEFAULT_MIN_YEAR;
    let hi = DEFAULT_MAX_YEAR;
    if (temporalRange) {
      lo = Math.min(lo, temporalRange.first);
      hi = Math.max(hi, temporalRange.last);
    }
    if (projections) {
      for (const ys of Object.values(projections)) {
        for (const y of ys) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
    }
    return { first: lo, last: hi };
  }, [temporalRange, projections]);

  const [year, setYear] = useState(initialYear ?? DEFAULT_YEAR);
  const [playing, setPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const yearRef = useRef(year);
  yearRef.current = year;

  // Pick scenario automatically based on year vs the projection cutoff.
  const scenarioForYear = useCallback((y: number): string => {
    if (hasProjections && y > projCutoff) return PROJECTION_SCENARIO;
    return 'historical';
  }, [hasProjections, projCutoff]);

  const notify = useCallback((y: number) => {
    onTimeChange?.(y, scenarioForYear(y));
  }, [onTimeChange, scenarioForYear]);

  const setYearAndNotify = useCallback((y: number) => {
    const min = trackRange.first;
    const max = trackRange.last;
    const clamped = Math.max(min, Math.min(max, y));
    setYear(clamped);
    notify(clamped);
  }, [notify, trackRange]);

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setYear(prev => {
          // For axes with sparse data (e.g. agrip = 4 samples) walk from one
          // data year to the next instead of stepping +1y at a time, otherwise
          // play would crawl through ~30 years of identical map output.
          let next: number;
          if (dataYears && dataYears.length > 0) {
            const nxt = dataYears.find(y => y > prev);
            next = nxt ?? trackRange.last + 1;
          } else {
            next = prev + 1;
          }
          if (next > trackRange.last) {
            setPlaying(false);
            return trackRange.last;
          }
          return next;
        });
      }, PLAY_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, trackRange, dataYears]);

  useEffect(() => {
    notify(year);
  }, [year, notify]);

  const togglePlay = useCallback(() => {
    if (disabled) return;
    if (!playing && year >= trackRange.last) {
      setYear(trackRange.first);
    }
    setPlaying(p => !p);
  }, [playing, year, disabled, trackRange]);

  const jumpToYear = useCallback((y: number) => {
    if (disabled) return;
    setPlaying(false);
    setYearAndNotify(y);
  }, [disabled, setYearAndNotify]);

  // Step to the next/previous data year. Falls back to +/-1y when there's
  // no explicit dataYears list. Pauses playback first so the manual step
  // is the next thing that lands.
  const stepYear = useCallback((dir: 1 | -1) => {
    if (disabled) return;
    setPlaying(false);
    const cur = yearRef.current;
    let next: number;
    if (dataYears && dataYears.length > 0) {
      if (dir > 0) {
        const found = dataYears.find(y => y > cur);
        next = found ?? cur;
      } else {
        let found = cur;
        for (const y of dataYears) {
          if (y < cur) found = y;
          else break;
        }
        next = found;
      }
    } else {
      next = cur + dir;
    }
    setYearAndNotify(next);
  }, [disabled, dataYears, setYearAndNotify]);

  useImperativeHandle(ref, () => ({ togglePlay, jumpToYear, stepYear }), [togglePlay, jumpToYear, stepYear]);

  const yearFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return year;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = trackRange.first + frac * (trackRange.last - trackRange.first);
    // Snap the thumb to the nearest year that actually has data.  This makes
    // the displayed year always match a real tile, and -- crucially -- the
    // moment the map updates is exactly the moment the thumb crosses a tick.
    // For dense annual data (temp, prec, ...) every integer is a data year so
    // the snap is a no-op; for sparse axes (agrip = 4 samples) it matters.
    if (dataYears && dataYears.length > 0) {
      let best = dataYears[0];
      let bestDist = Math.abs(raw - best);
      for (const y of dataYears) {
        const d = Math.abs(raw - y);
        if (d < bestDist) { best = y; bestDist = d; }
      }
      return best;
    }
    return Math.round(raw);
  }, [year, trackRange, dataYears]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = true;
    setPlaying(false);
    setYearAndNotify(yearFromClientX(e.clientX));
  }, [yearFromClientX, setYearAndNotify, disabled]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setYearAndNotify(yearFromClientX(e.clientX));
  }, [yearFromClientX, setYearAndNotify]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const displayYear = (disabled && overrideYear) ? overrideYear : year;
  const span = trackRange.last - trackRange.first;
  const frac = span > 0 ? (displayYear - trackRange.first) / span : 0;
  const nowFrac = span > 0 ? (DEFAULT_YEAR - trackRange.first) / span : 0;
  const projFrac = span > 0 ? Math.max(0, Math.min(1, (projCutoff - trackRange.first) / span)) : 1;

  // Bound the past/projection wash to the actual data range so empty regions
  // of the track read as "no data here" instead of inviting the user to
  // scrub into them.  E.g. `free` has data starting in 2000; without this,
  // the historical wash would extend back to 1980 and falsely suggest data.
  const dataFirstFrac = useMemo(() => {
    if (!dataYears || dataYears.length === 0 || span <= 0) return 0;
    return Math.max(0, Math.min(1, (dataYears[0] - trackRange.first) / span));
  }, [dataYears, trackRange, span]);
  const dataLastFrac = useMemo(() => {
    if (!dataYears || dataYears.length === 0 || span <= 0) return 1;
    return Math.max(0, Math.min(1, (dataYears[dataYears.length - 1] - trackRange.first) / span));
  }, [dataYears, trackRange, span]);
  const pastLeftFrac = dataFirstFrac;
  const pastRightFrac = Math.max(pastLeftFrac, Math.min(projFrac, dataLastFrac));
  const projRightFrac = hasProjections ? Math.max(projFrac, dataLastFrac) : projFrac;

  const inProjection = hasProjections && displayYear > projCutoff;

  return (
    <div className={`time-panel${disabled ? ' time-panel-disabled' : ''}`}>
      <div className="time-panel-top">
        <button
          className="time-play-btn"
          onClick={togglePlay}
          disabled={disabled}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor" />
              <rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <polygon points="3,1 13,7 3,13" fill="currentColor" />
            </svg>
          )}
        </button>

        <span className="time-year-display">{displayYear}</span>

        {inProjection && (
          <span className="time-projection-badge" aria-label="Climate projection">
            PROJECTIONS
          </span>
        )}
      </div>

      <div
        className="time-slider-area"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div ref={trackRef} className="time-slider-track">
          {/* Base "history" wash up to the projection cutoff, "projection"
              wash beyond it.  These are intentionally subtle -- the zebra
              segments below provide the year-by-year delineation. */}
          <div
            className="time-slider-past"
            style={{
              left: `${pastLeftFrac * 100}%`,
              width: `${Math.max(0, pastRightFrac - pastLeftFrac) * 100}%`,
            }}
          />
          {hasProjections && projRightFrac > projFrac && (
            <div
              className="time-slider-projection-fill"
              style={{
                left: `${projFrac * 100}%`,
                width: `${(projRightFrac - projFrac) * 100}%`,
              }}
            />
          )}

          {/* Zebra-stripe the gaps *between* consecutive data years.  Each
              stripe spans [Y_i, Y_{i+1}], so a data year sits exactly on the
              border between two stripes -- the playhead (which snaps to data
              years) therefore lands on stripe boundaries, not centres.  Tone
              alternates per stripe; projection-side stripes pick up the teal
              accent so the past/future split also reads as a colour shift. */}
          {dataYears && dataYears.length > 1 && span > 0 && dataYears.slice(0, -1).map((y, i) => {
            const next = dataYears[i + 1];
            const left = (y - trackRange.first) / span;
            const right = (next - trackRange.first) / span;
            if (right < 0 || left > 1) return null;
            const l = Math.max(0, left);
            const r = Math.min(1, right);
            const inProj = hasProjections && next > projCutoff;
            const tone = i % 2;
            return (
              <div
                key={`seg-${y}-${next}`}
                className={`time-slider-segment time-slider-segment-${tone}${inProj ? ' time-slider-segment-proj' : ''}`}
                style={{ left: `${l * 100}%`, width: `${(r - l) * 100}%` }}
                title={`${y}-${next}`}
              />
            );
          })}

          <div className="time-slider-now" style={{ left: `${nowFrac * 100}%` }} />
        </div>
        <div
          className={`time-slider-thumb${inProjection ? ' time-slider-thumb-proj' : ''}`}
          style={{ left: `${frac * 100}%` }}
        />
      </div>

      <div className="time-slider-labels">
        <span>{trackRange.first}</span>
        <span className="time-label-now" style={{ left: `${nowFrac * 100}%` }}>{DEFAULT_YEAR}</span>
        <span>{trackRange.last}</span>
      </div>
    </div>
  );
});
