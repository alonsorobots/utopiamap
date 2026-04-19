import { useEffect, useRef, useState, useCallback } from 'react';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import { drawPaintCircle, drawEraseCircle } from './heatmapLayer';

const LEVEL_OFFSET = 8;
const MAX_LEVEL = 16;
const DEFAULT_BRUSH_PX = 36;
const MIN_BRUSH_PX = 6;
const MAX_BRUSH_PX = 120;

interface DrawModeProps {
  map: MaplibreMap;
  isTouch: boolean;
}

function lngLatToCell(lng: number, lat: number, level: number) {
  const gs = 1 << level;
  const mercX = (lng + 180) / 360;
  const latRad = (lat * Math.PI) / 180;
  const mercY =
    0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
  return {
    cx: Math.max(0, Math.min(gs - 1, Math.floor(mercX * gs))),
    cy: Math.max(0, Math.min(gs - 1, Math.floor(mercY * gs))),
  };
}

function screenPxToCellRadius(
  map: MaplibreMap,
  lngLat: { lng: number; lat: number },
  brushPx: number,
): number {
  const center = map.project([lngLat.lng, lngLat.lat]);
  const edge = map.unproject([center.x + brushPx / 2, center.y]);
  const level = Math.min(MAX_LEVEL, Math.floor(map.getZoom()) + LEVEL_OFFSET);
  const gs = 1 << level;
  const mercCenter = (lngLat.lng + 180) / 360;
  const mercEdge = (edge.lng + 180) / 360;
  return Math.max(0, Math.round(Math.abs(mercEdge - mercCenter) * gs));
}

function fractionToValue(frac: number): number {
  return Math.round(MIN_BRUSH_PX + frac * (MAX_BRUSH_PX - MIN_BRUSH_PX));
}

function valueToFraction(val: number): number {
  return (val - MIN_BRUSH_PX) / (MAX_BRUSH_PX - MIN_BRUSH_PX);
}

function BrushSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const applyFromX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChange(fractionToValue(frac));
    },
    [onChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      dragging.current = true;
      applyFromX(e.clientX);
    },
    [applyFromX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      applyFromX(e.clientX);
    },
    [applyFromX],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const frac = valueToFraction(value);
  const thumbDiameter = Math.max(8, value * 0.5);
  const maxThumbR = MAX_BRUSH_PX * 0.5 / 2;
  const trackUsable = 220 - 2 * maxThumbR;
  const thumbPx = maxThumbR + frac * trackUsable;

  return (
    <div
      className="brush-hslider-area"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div ref={trackRef} className="brush-hslider-track" />
      <div
        className="brush-hslider-thumb"
        style={{
          left: thumbPx,
          width: thumbDiameter,
          height: thumbDiameter,
        }}
      />
    </div>
  );
}

export function DrawMode({ map, isTouch }: DrawModeProps) {
  const [brushPx, setBrushPx] = useState(DEFAULT_BRUSH_PX);
  const [tooltipVisible, setTooltipVisible] = useState(true);
  const [touchMode, setTouchMode] = useState<'add' | 'erase'>('add');
  const painting = useRef(false);
  const erasing = useRef(false);
  const lastCellKey = useRef('');
  const cursorRef = useRef<HTMLDivElement>(null);
  const brushPxRef = useRef(brushPx);
  const touchModeRef = useRef(touchMode);
  brushPxRef.current = brushPx;
  touchModeRef.current = touchMode;

  useEffect(() => {
    if (cursorRef.current) {
      cursorRef.current.style.width = `${brushPx}px`;
      cursorRef.current.style.height = `${brushPx}px`;
    }
  }, [brushPx]);

  useEffect(() => {
    setTooltipVisible(true);
    const timer = setTimeout(() => setTooltipVisible(false), 4000);
    return () => clearTimeout(timer);
  }, []);

  // Shift + scroll wheel changes brush size
  useEffect(() => {
    const canvas = map.getCanvas();
    function onWheel(e: WheelEvent) {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const step = Math.max(2, Math.min(12, Math.abs(raw) / 10));
      const delta = raw > 0 ? -step : step;
      setBrushPx(prev => Math.max(MIN_BRUSH_PX, Math.min(MAX_BRUSH_PX, Math.round(prev + delta))));
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [map]);

  useEffect(() => {
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    map.boxZoom.disable();

    function apply(lngLat: { lng: number; lat: number }, erase: boolean) {
      const level = Math.min(
        MAX_LEVEL,
        Math.floor(map.getZoom()) + LEVEL_OFFSET,
      );
      const { cx, cy } = lngLatToCell(lngLat.lng, lngLat.lat, level);
      const cellR = screenPxToCellRadius(map, lngLat, brushPxRef.current);
      const key = `${level}/${cx}/${cy}`;
      if (key === lastCellKey.current) return;
      lastCellKey.current = key;
      if (erase) drawEraseCircle(level, cx, cy, cellR);
      else drawPaintCircle(level, cx, cy, cellR);
    }

    // ── Desktop (mouse) handlers ──
    function onDown(e: MapMouseEvent) {
      if (isTouch) return;
      const orig = e.originalEvent;
      if (!orig.shiftKey && !orig.ctrlKey && !orig.metaKey) return;
      e.preventDefault();
      map.dragPan.disable();
      const erase = orig.ctrlKey || orig.metaKey;
      if (erase) erasing.current = true;
      else painting.current = true;
      lastCellKey.current = '';
      apply(e.lngLat, erase);
    }

    function onMove(e: MapMouseEvent) {
      if (isTouch) return;
      if (cursorRef.current) {
        const orig = e.originalEvent;
        const showBrush = orig.shiftKey || orig.ctrlKey || orig.metaKey || painting.current || erasing.current;
        cursorRef.current.style.display = showBrush ? '' : 'none';
        cursorRef.current.style.left = `${e.point.x}px`;
        cursorRef.current.style.top = `${e.point.y}px`;
        canvas.style.cursor = showBrush ? 'none' : '';
      }
      if (painting.current || erasing.current) {
        apply(e.lngLat, erasing.current);
      }
    }

    function onUp() {
      if (painting.current || erasing.current) {
        if (!isTouch) map.dragPan.enable();
      }
      painting.current = false;
      erasing.current = false;
      lastCellKey.current = '';
    }

    function onContext(e: MapMouseEvent) {
      e.preventDefault();
    }

    function onLeave() {
      if (cursorRef.current) cursorRef.current.style.display = 'none';
      canvas.style.cursor = '';
    }

    // ── Touch handlers ──
    // On touch: single finger paints, two fingers pan/zoom.
    // dragPan stays ENABLED so two-finger swipe pans normally.
    // We intercept single-touch on the canvas before MapLibre can start a drag.
    let touchActive = false;

    function onTouchStart(e: TouchEvent) {
      if (!isTouch) return;
      if (e.touches.length !== 1) {
        if (touchActive) {
          touchActive = false;
          painting.current = false;
          erasing.current = false;
        }
        return;
      }
      // Single finger: paint/erase and block MapLibre from panning
      touchActive = true;
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([touch.clientX - rect.left, touch.clientY - rect.top]);
      const erase = touchModeRef.current === 'erase';
      if (erase) erasing.current = true;
      else painting.current = true;
      lastCellKey.current = '';
      apply(lngLat, erase);
      e.stopImmediatePropagation();
    }

    function onTouchMove(e: TouchEvent) {
      if (!isTouch) return;
      if (e.touches.length !== 1 || !touchActive) {
        if (touchActive) {
          touchActive = false;
          painting.current = false;
          erasing.current = false;
        }
        return;
      }
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([touch.clientX - rect.left, touch.clientY - rect.top]);
      apply(lngLat, erasing.current);
      e.preventDefault();
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length === 0) {
        touchActive = false;
        painting.current = false;
        erasing.current = false;
        lastCellKey.current = '';
      }
    }

    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    map.on('contextmenu', onContext);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('mouseup', onUp);

    if (isTouch) {
      // Use capture phase so we intercept BEFORE MapLibre's handlers
      canvas.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd);
    }

    return () => {
      canvas.style.cursor = prevCursor;
      map.off('mousedown', onDown);
      map.off('mousemove', onMove);
      map.off('mouseup', onUp);
      map.off('contextmenu', onContext);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('mouseup', onUp);

      if (isTouch) {
        canvas.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('touchend', onTouchEnd);
      }

      painting.current = false;
      erasing.current = false;
      map.boxZoom.enable();
    };
  }, [map, isTouch]);

  return (
    <>
      {/* Desktop brush cursor */}
      {!isTouch && (
        <div
          ref={cursorRef}
          className="draw-cursor"
          style={{ width: brushPx, height: brushPx, display: 'none' }}
        />
      )}

      {/* Desktop tooltip */}
      {!isTouch && (
        <div className={`draw-tooltip ${tooltipVisible ? 'draw-tooltip-visible' : ''}`}>
          <span className="draw-tooltip-key">Shift + click drag</span> to paint
          <span className="draw-tooltip-sep" />
          <span className="draw-tooltip-key">Ctrl + click drag</span> to erase
        </div>
      )}

      {/* Touch tooltip */}
      {isTouch && (
        <div className={`draw-tooltip ${tooltipVisible ? 'draw-tooltip-visible' : ''}`}>
          Drag to {touchMode === 'add' ? 'paint' : 'erase'} &middot; Pinch to pan/zoom
        </div>
      )}

      <div className="brush-panel">
        <div className="brush-panel-title">Brush size</div>
        <BrushSlider value={brushPx} onChange={setBrushPx} />

        {isTouch ? (
          <div className="brush-mode-toggle">
            <button
              className={`brush-mode-btn ${touchMode === 'add' ? 'brush-mode-active' : ''}`}
              onClick={() => setTouchMode('add')}
              aria-label="Paint mode"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className={`brush-mode-btn ${touchMode === 'erase' ? 'brush-mode-active brush-mode-erase' : ''}`}
              onClick={() => setTouchMode('erase')}
              aria-label="Erase mode"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="brush-panel-shortcuts">
            <div className="brush-shortcut-row">
              <kbd className="brush-action-label">Add</kbd>
              <span>Shift + click drag</span>
            </div>
            <div className="brush-shortcut-row">
              <kbd className="brush-action-label brush-action-erase">Erase</kbd>
              <span>Ctrl + click drag</span>
            </div>
            <div className="brush-shortcut-row">
              <kbd className="brush-action-label brush-action-size">Size</kbd>
              <span>Shift + scroll wheel</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
