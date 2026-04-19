import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';

interface DraggablePanelProps {
  initialX?: number;
  initialRight?: number;
  initialBottomOffset: number;
  initialWidth: number;
  initialHeight: number;
  minWidth?: number;
  minHeight?: number;
  title: string;
  onPrev?: () => void;
  onNext?: () => void;
  onSizeChange?: (w: number, h: number) => void;
  children: ReactNode | ((width: number, height: number) => ReactNode);
}

type Interaction = 'move' | 'resize';

export function DraggablePanel({
  initialX, initialRight, initialBottomOffset, initialWidth, initialHeight,
  minWidth = 200, minHeight = 120, title, onPrev, onNext, onSizeChange, children,
}: DraggablePanelProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: initialWidth, h: initialHeight });
  const interactionRef = useRef<{ type: Interaction; ox: number; oy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const userDragged = useRef(false);

  // Component remounts via `key` prop when initial sizes need to reset,
  // so we don't need a useEffect to watch them.

  const computePos = useCallback(() => {
    if (!panelRef.current) return null;
    const parent = panelRef.current.parentElement!;
    const panelH = panelRef.current.getBoundingClientRect().height;
    const parentRect = parent.getBoundingClientRect();
    const y = parentRect.height - panelH - initialBottomOffset;

    if (initialRight !== undefined) {
      const panelW = panelRef.current.getBoundingClientRect().width;
      return { x: parentRect.width - panelW - initialRight, y };
    }
    return { x: initialX ?? 0, y };
  }, [initialX, initialRight, initialBottomOffset]);

  useEffect(() => {
    if (userDragged.current) return;
    const p = computePos();
    if (p) setPos(p);
  }, [computePos]);

  useEffect(() => {
    if (initialRight === undefined) return;
    const onResize = () => {
      if (userDragged.current) return;
      const p = computePos();
      if (p) setPos(p);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [initialRight, computePos]);

  const startMove = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const rect = panelRef.current!.getBoundingClientRect();
    interactionRef.current = { type: 'move', ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    userDragged.current = true;
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    interactionRef.current = { type: 'resize', ox: e.clientX, oy: e.clientY };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const interaction = interactionRef.current;
    if (!interaction || !panelRef.current) return;
    const parent = panelRef.current.parentElement!;
    const parentRect = parent.getBoundingClientRect();

    if (interaction.type === 'move') {
      const panelRect = panelRef.current.getBoundingClientRect();
      setPos({
        x: Math.max(0, Math.min(parentRect.width - panelRect.width, e.clientX - parentRect.left - interaction.ox)),
        y: Math.max(0, Math.min(parentRect.height - panelRect.height, e.clientY - parentRect.top - interaction.oy)),
      });
    } else {
      const dx = e.clientX - interaction.ox;
      const dy = e.clientY - interaction.oy;
      interaction.ox = e.clientX;
      interaction.oy = e.clientY;
      setSize((prev) => {
        const newSize = {
          w: Math.max(minWidth, prev.w + dx),
          h: Math.max(minHeight, prev.h + dy),
        };
        if (onSizeChange && (newSize.w !== prev.w || newSize.h !== prev.h)) {
          onSizeChange(newSize.w, newSize.h);
        }
        return newSize;
      });
    }
  }, [minWidth, minHeight, onSizeChange]);

  const onPointerUp = useCallback(() => { interactionRef.current = null; }, []);

  const contentW = size.w;
  const contentH = size.h;

  const style: React.CSSProperties = pos
    ? { position: 'absolute', left: pos.x, top: pos.y, width: size.w + 32 }
    : { position: 'absolute', left: initialX ?? 0, bottom: initialBottomOffset, width: size.w + 32, visibility: 'hidden' as const };

  return (
    <div
      ref={panelRef}
      className="curve-panel"
      style={style}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div
        className="curve-panel-title"
        style={{ cursor: 'grab', userSelect: 'none' }}
        onPointerDown={startMove}
      >
        <span>{title}</span>
        {(onPrev || onNext) && (
          <span className="panel-nav-arrows">
            <button
              className="panel-nav-btn"
              onClick={(e) => { e.stopPropagation(); onPrev?.(); }}
              aria-label="Previous axis"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button
              className="panel-nav-btn"
              onClick={(e) => { e.stopPropagation(); onNext?.(); }}
              aria-label="Next axis"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </span>
        )}
      </div>
      <div style={{ width: contentW, height: contentH, overflow: 'hidden' }}>
        {typeof children === 'function' ? children(contentW, contentH) : children}
      </div>
      <div
        className="resize-handle"
        onPointerDown={startResize}
      />
    </div>
  );
}
