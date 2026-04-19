import { useRef, useState, useCallback, useEffect, useMemo } from 'react';

export interface CurvePoint {
  x: number;
  y: number;
}

export interface AxisConfig {
  label: string;
  dataMin: number;
  dataMax: number;
  unit: string;
  formatValue: (normX: number, unit: string) => string;
  formatHover?: (normX: number, unit: string) => string;
  unitOptions?: string[];
  description?: string;
  whoIsThisFor?: string;
  unitDescription?: string;
  source?: string;
  sourceUrl?: string;
  hoverLabel?: string;
  defaultCurve?: CurvePoint[];
  staticYear?: number;
  infoWidth?: number;
  infoHeight?: number;
}

interface CurveEditorProps {
  width: number;
  height: number;
  axis?: AxisConfig;
  axisId?: string;
  onCurveChange: (axisId: string, values: Float32Array) => void;
  savedPoints?: CurvePoint[];
  onPointsChange?: (axisId: string, points: CurvePoint[]) => void;
  savedUnit?: string;
  onUnitChange?: (axisId: string, unit: string) => void;
  subtitle?: string;
}

const PAD = 12;
const PAD_L = 34;
const HANDLE_HIT_R = 22;
const HANDLE_HIT_R_MIN = 7;
const AXIS_LABEL_H = 30;
const MIN_GAP = 0.02;
const MAX_POINTS = 8;
const MIN_POINTS = 2;
const NEAR_CURVE_PX = 18;

const CURVE_COLOR = '#fb923c';
const HANDLE_COLOR = '#fb923c';
const TAIL_COLOR = 'rgba(251, 146, 60, 0.5)';

const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
];

function evaluateAtX(points: CurvePoint[], x: number): number {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return 0.5;
  if (x <= sorted[0].x) return sorted[0].y;
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  for (let j = 0; j < sorted.length - 1; j++) {
    if (x >= sorted[j].x && x <= sorted[j + 1].x) {
      const left = sorted[j];
      const right = sorted[j + 1];
      const dx = right.x - left.x;
      const t = dx > 0 ? (x - left.x) / dx : 0;
      return left.y + t * (right.y - left.y);
    }
  }
  return sorted[sorted.length - 1].y;
}

function evaluateCurve(points: CurvePoint[]): Float32Array {
  const out = new Float32Array(256);
  const sorted = [...points].sort((a, b) => a.x - b.x);

  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y: number;

    if (sorted.length === 0) {
      y = 0.5;
    } else if (x <= sorted[0].x) {
      y = sorted[0].y;
    } else if (x >= sorted[sorted.length - 1].x) {
      y = sorted[sorted.length - 1].y;
    } else {
      let segIdx = 0;
      for (let j = 0; j < sorted.length - 1; j++) {
        if (x >= sorted[j].x && x <= sorted[j + 1].x) {
          segIdx = j;
          break;
        }
      }
      const left = sorted[segIdx];
      const right = sorted[segIdx + 1];
      const dx = right.x - left.x;
      const t = dx > 0 ? (x - left.x) / dx : 0;
      y = left.y + t * (right.y - left.y);
    }

    out[i] = Math.max(0, Math.min(1, 1.0 - y));
  }
  return out;
}

const INSET = 8;

function toSvg(px: number, py: number, w: number, h: number): { cx: number; cy: number } {
  return { cx: PAD_L + INSET + px * (w - INSET * 2), cy: PAD + INSET + py * (h - INSET * 2) };
}

function fromSvg(sx: number, sy: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, (sx - PAD_L - INSET) / (w - INSET * 2))),
    y: Math.max(0, Math.min(1, (sy - PAD - INSET) / (h - INSET * 2))),
  };
}

function buildPath(points: CurvePoint[], svgW: number, svgH: number): string {
  if (points.length < 2) return '';
  const sorted = [...points].sort((a, b) => a.x - b.x);

  const first = toSvg(sorted[0].x, sorted[0].y, svgW, svgH);
  let d = `M ${first.cx} ${first.cy}`;

  for (let i = 0; i < sorted.length - 1; i++) {
    const right = sorted[i + 1];
    const end = toSvg(right.x, right.y, svgW, svgH);
    d += ` L ${end.cx} ${end.cy}`;
  }

  return d;
}

const BOTTOM_ROW_H = 20;
const SUBTITLE_H = 14;

export function CurveEditor({
  width, height, axis, axisId = '', onCurveChange, savedPoints, onPointsChange,
  savedUnit, onUnitChange, subtitle,
}: CurveEditorProps) {
  const hasUnitToggle = !!(axis?.unitOptions && axis.unitOptions.length > 1);
  const belowSvgH = BOTTOM_ROW_H + (hasUnitToggle ? 20 : 0);
  const aboveSvgH = subtitle ? SUBTITLE_H : 0;
  const svgTotalH = height - aboveSvgH - belowSvgH;
  const svgW = width - PAD_L - PAD;
  const svgH = svgTotalH - PAD * 2 - AXIS_LABEL_H;
  const svgRef = useRef<SVGSVGElement>(null);

  const [points, setPoints] = useState<CurvePoint[]>(() => {
    const init = savedPoints ?? axis?.defaultCurve ?? DEFAULT_CURVE;
    return [...init].sort((a, b) => a.x - b.x);
  });
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [unit, setUnitRaw] = useState(savedUnit ?? axis?.unit ?? '');
  const setUnit = useCallback((u: string) => {
    setUnitRaw(u);
    onUnitChange?.(axisId, u);
  }, [axisId, onUnitChange]);
  const draggingRef = useRef<number | null>(null);
  const draggingEdgeRef = useRef<{ idx: number; startX: number; leftStartX: number; rightStartX: number } | null>(null);

  const [previewRaw, setPreviewRaw] = useState(false);

  const sortedPoints = useMemo(() => [...points].sort((a, b) => a.x - b.x), [points]);
  
  const displayPoints = useMemo(() => {
    if (previewRaw) return [{ x: 0, y: 1 }, { x: 1, y: 0 }];
    return sortedPoints;
  }, [sortedPoints, previewRaw]);

  // Per-vertex hit radius. Lenient (HANDLE_HIT_R) when neighbors are far
  // away, but capped at half the screen-space distance to the nearest other
  // vertex so overlapping hit zones don't make tightly-packed handles
  // unselectable.
  const hitRadii = useMemo(() => {
    if (displayPoints.length <= 1) return [HANDLE_HIT_R];
    const screen = displayPoints.map((p) => toSvg(p.x, p.y, svgW, svgH));
    return screen.map((here, i) => {
      let minDist = Infinity;
      for (let j = 0; j < screen.length; j++) {
        if (j === i) continue;
        const dx = screen[j].cx - here.cx;
        const dy = screen[j].cy - here.cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minDist) minDist = d;
      }
      return Math.max(HANDLE_HIT_R_MIN, Math.min(HANDLE_HIT_R, minDist / 2));
    });
  }, [displayPoints, svgW, svgH]);

  useEffect(() => {
    onCurveChange(axisId, evaluateCurve(displayPoints));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onCurveChange(axisId, evaluateCurve(displayPoints));
  }, [displayPoints, axisId, onCurveChange]);

  useEffect(() => {
    onPointsChange?.(axisId, sortedPoints);
  }, [sortedPoints, axisId, onPointsChange]);

  const getPos = useCallback(
    (e: React.PointerEvent) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return fromSvg(e.clientX - rect.left, e.clientY - rect.top, svgW, svgH);
    },
    [svgW, svgH],
  );

  const onDown = useCallback(
    (idx: number) => (e: React.PointerEvent) => {
      if (previewRaw) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      draggingRef.current = idx;
      setDragIdx(idx);
    },
    [previewRaw],
  );

  const onEdgeDown = useCallback(
    (idx: number) => (e: React.PointerEvent) => {
      if (previewRaw) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      const pos = getPos(e);
      draggingEdgeRef.current = {
        idx,
        startX: pos.x,
        leftStartX: sortedPoints[idx].x,
        rightStartX: sortedPoints[idx + 1].x,
      };
    },
    [getPos, sortedPoints, previewRaw],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const pos = getPos(e);

      const edge = draggingEdgeRef.current;
      if (edge !== null) {
        const dx = pos.x - edge.startX;
        setPoints((prev) => {
          const sorted = [...prev].sort((a, b) => a.x - b.x);
          const minX = edge.idx === 0 ? 0 : sorted[edge.idx - 1].x + MIN_GAP;
          const maxX = edge.idx + 1 === sorted.length - 1 ? 1 : sorted[edge.idx + 2].x - MIN_GAP;
          
          let newLeftX = edge.leftStartX + dx;
          let newRightX = edge.rightStartX + dx;
          
          if (newLeftX < minX) {
            const diff = minX - newLeftX;
            newLeftX += diff;
            newRightX += diff;
          }
          if (newRightX > maxX) {
            const diff = newRightX - maxX;
            newLeftX -= diff;
            newRightX -= diff;
          }
          
          return sorted.map((p, i) => {
            if (i === edge.idx) return { ...p, x: Math.max(0, Math.min(1, newLeftX)) };
            if (i === edge.idx + 1) return { ...p, x: Math.max(0, Math.min(1, newRightX)) };
            return p;
          });
        });
        return;
      }

      const idx = draggingRef.current;
      if (idx === null) return;

      setPoints((prev) => {
        const sorted = [...prev].sort((a, b) => a.x - b.x);
        return sorted.map((p, i) => {
          if (i !== idx) return p;
          const minX = i === 0 ? 0 : sorted[i - 1].x + MIN_GAP;
          const maxX = i === sorted.length - 1 ? 1 : sorted[i + 1].x - MIN_GAP;
          return {
            x: Math.max(minX, Math.min(maxX, pos.x)),
            y: Math.max(0, Math.min(1, pos.y)),
          };
        });
      });
    },
    [getPos],
  );

  const onUp = useCallback(() => {
    draggingRef.current = null;
    draggingEdgeRef.current = null;
    setDragIdx(null);
  }, []);

  const onSvgDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = svgRef.current!.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const pos = fromSvg(localX, localY, svgW, svgH);

      const hitIdx = sortedPoints.findIndex((p, i) => {
        const sp = toSvg(p.x, p.y, svgW, svgH);
        const dx = localX - sp.cx;
        const dy = localY - sp.cy;
        const r = hitRadii[i] ?? HANDLE_HIT_R;
        return dx * dx + dy * dy <= r * r;
      });

      if (hitIdx >= 0) {
        if (sortedPoints.length > MIN_POINTS) {
          setPoints((prev) => {
            const sorted = [...prev].sort((a, b) => a.x - b.x);
            return sorted.filter((_, i) => i !== hitIdx);
          });
        }
      } else if (sortedPoints.length < MAX_POINTS) {
        const curveY = evaluateAtX(sortedPoints, pos.x);
        const curveSvgPt = toSvg(pos.x, curveY, svgW, svgH);
        const dist = Math.abs(localY - curveSvgPt.cy);

        if (dist < NEAR_CURVE_PX) {
          setPoints((prev) => {
            const next = [...prev, { x: pos.x, y: curveY }];
            return next.sort((a, b) => a.x - b.x);
          });
        }
      }
    },
    [svgW, svgH, sortedPoints, hitRadii],
  );

  const tooltipInfo = dragIdx !== null && sortedPoints[dragIdx]
    ? { svgPt: toSvg(sortedPoints[dragIdx].x, sortedPoints[dragIdx].y, svgW, svgH), normX: sortedPoints[dragIdx].x }
    : null;

  const tooltipText = tooltipInfo && axis
    ? axis.formatValue(tooltipInfo.normX, unit)
    : tooltipInfo
      ? `${Math.round(tooltipInfo.normX * 100)}%`
      : null;

  const curvePath = useMemo(() => buildPath(displayPoints, svgW, svgH), [displayPoints, svgW, svgH]);

  const firstPt = displayPoints[0];
  const lastPt = displayPoints[displayPoints.length - 1];
  const firstSvg = firstPt ? toSvg(firstPt.x, firstPt.y, svgW, svgH) : null;
  const lastSvg = lastPt ? toSvg(lastPt.x, lastPt.y, svgW, svgH) : null;

  const HANDLE_R = 5;

  const handleReset = useCallback(() => {
    const def = axis?.defaultCurve ?? DEFAULT_CURVE;
    setPoints([...def].sort((a, b) => a.x - b.x));
  }, [axis]);

  return (
    <div style={{ position: 'relative' }}>
      {subtitle && (
        <div className="curve-subtitle">{subtitle}</div>
      )}
      <svg
        ref={svgRef}
        width={width}
        height={svgTotalH}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onDoubleClick={onSvgDoubleClick}
        style={{ touchAction: 'none', display: 'block' }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={`h${f}`} x1={PAD_L} y1={PAD + f * svgH} x2={PAD_L + svgW} y2={PAD + f * svgH} stroke="#ffffff10" strokeWidth={1} />
        ))}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={`v${f}`} x1={PAD_L + f * svgW} y1={PAD} x2={PAD_L + f * svgW} y2={PAD + svgH} stroke="#ffffff10" strokeWidth={1} />
        ))}
        <rect x={PAD_L} y={PAD} width={svgW} height={svgH} fill="none" stroke="#ffffff20" strokeWidth={1} rx={4} />

        {firstSvg && firstPt.x > 0.005 && (
          <line x1={PAD_L} y1={firstSvg.cy} x2={firstSvg.cx} y2={firstSvg.cy} stroke={TAIL_COLOR} strokeWidth={2} strokeDasharray="4 3" />
        )}
        {lastSvg && lastPt.x < 0.995 && (
          <line x1={lastSvg.cx} y1={lastSvg.cy} x2={PAD_L + svgW} y2={lastSvg.cy} stroke={TAIL_COLOR} strokeWidth={2} strokeDasharray="4 3" />
        )}

        {curvePath && (
          <path d={curvePath} fill="none" stroke={CURVE_COLOR} strokeWidth={2.5} pointerEvents="none" />
        )}

        {/* Edge hit areas */}
        {displayPoints.map((pt, i) => {
          if (i === displayPoints.length - 1) return null;
          const next = displayPoints[i + 1];
          const sp1 = toSvg(pt.x, pt.y, svgW, svgH);
          const sp2 = toSvg(next.x, next.y, svgW, svgH);
          return (
            <line
              key={`edge-${i}`}
              x1={sp1.cx} y1={sp1.cy} x2={sp2.cx} y2={sp2.cy}
              stroke="rgba(0,0,0,0)" strokeWidth={24}
              pointerEvents="stroke"
              style={{ cursor: 'ew-resize' }}
              onPointerDown={onEdgeDown(i)}
            />
          );
        })}

        {tooltipInfo && tooltipText && (() => {
          const tx = tooltipInfo.svgPt.cx;
          const cy = tooltipInfo.svgPt.cy;
          const aboveY = cy - 34;
          const showBelow = aboveY < 8;

          if (showBelow) {
            const tipY = cy + 12;
            return (
              <g>
                <polygon
                  points={`${tx - 4},${tipY} ${tx + 4},${tipY} ${tx},${tipY - 6}`}
                  fill="rgba(0,0,0,0.88)"
                />
                <rect
                  x={tx - 30}
                  y={tipY}
                  width={60}
                  height={22}
                  rx={5}
                  fill="rgba(0,0,0,0.88)"
                  stroke="#ffffff30"
                  strokeWidth={0.5}
                />
                <text
                  x={tx}
                  y={tipY + 15}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={12}
                  fontFamily="monospace"
                  fontWeight={600}
                >
                  {tooltipText}
                </text>
              </g>
            );
          }

          return (
            <g>
              <rect
                x={tx - 30}
                y={aboveY}
                width={60}
                height={22}
                rx={5}
                fill="rgba(0,0,0,0.88)"
                stroke="#ffffff30"
                strokeWidth={0.5}
              />
              <text
                x={tx}
                y={aboveY + 15}
                textAnchor="middle"
                fill="#fff"
                fontSize={12}
                fontFamily="monospace"
                fontWeight={600}
              >
                {tooltipText}
              </text>
              <polygon
                points={`${tx - 4},${aboveY + 22} ${tx + 4},${aboveY + 22} ${tx},${aboveY + 28}`}
                fill="rgba(0,0,0,0.88)"
              />
            </g>
          );
        })()}

        {displayPoints.map((pt, i) => {
          const sp = toSvg(pt.x, pt.y, svgW, svgH);
          return (
            <g key={i}>
              <circle cx={sp.cx} cy={sp.cy} r={hitRadii[i] ?? HANDLE_HIT_R} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={onDown(i)} />
              <circle
                cx={sp.cx}
                cy={sp.cy}
                r={HANDLE_R}
                fill={HANDLE_COLOR}
                stroke="#fff"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            </g>
          );
        })}

        {/* Y-axis labels */}
        <text
          x={PAD_L - 4}
          y={PAD + 5}
          fill="rgba(255,255,255,0.3)"
          fontSize={7}
          fontFamily="'SF Mono', 'Fira Code', monospace"
          textAnchor="end"
        >high</text>
        <text
          x={PAD_L - 4}
          y={PAD + svgH}
          fill="rgba(255,255,255,0.3)"
          fontSize={7}
          fontFamily="'SF Mono', 'Fira Code', monospace"
          textAnchor="end"
        >low</text>
        <text
          x={10}
          y={PAD + svgH / 2}
          fill="rgba(255,255,255,0.22)"
          fontSize={9}
          fontFamily="'SF Mono', 'Fira Code', monospace"
          textAnchor="middle"
          transform={`rotate(-90, 10, ${PAD + svgH / 2})`}
        >Preference</text>

        {axis && (
          <>
            <text
              x={PAD_L}
              y={PAD + svgH + 14}
              fill="rgba(255,255,255,0.35)"
              fontSize={10}
              fontFamily="'SF Mono', 'Fira Code', monospace"
              textAnchor="start"
            >
              {axis.formatValue(0, unit)}
            </text>
            <text
              x={PAD_L + svgW}
              y={PAD + svgH + 14}
              fill="rgba(255,255,255,0.35)"
              fontSize={10}
              fontFamily="'SF Mono', 'Fira Code', monospace"
              textAnchor="end"
            >
              {axis.formatValue(1, unit)}
            </text>
            <text
              x={PAD_L + svgW / 2}
              y={PAD + svgH + 27}
              fill="rgba(255,255,255,0.3)"
              fontSize={9}
              fontFamily="'SF Mono', 'Fira Code', monospace"
              textAnchor="middle"
            >
              {axis.label}
            </text>
          </>
        )}
      </svg>
      <div className="curve-bottom-row">
        {axis?.unitOptions && axis.unitOptions.length > 1 && (
          <div className="unit-toggle-bottom">
            {axis.unitOptions.map((u) => (
              <button
                key={u}
                className={u === unit ? 'unit-btn active' : 'unit-btn'}
                onClick={() => setUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button 
            className="curve-reset-btn" 
            onPointerEnter={() => setPreviewRaw(true)}
            onPointerLeave={() => setPreviewRaw(false)}
            onPointerDown={() => setPreviewRaw(true)}
            onPointerUp={() => setPreviewRaw(false)}
            title="Hold to see raw data mapping"
          >
            raw
          </button>
          <button className="curve-reset-btn" onClick={handleReset}>reset</button>
        </div>
      </div>
    </div>
  );
}
