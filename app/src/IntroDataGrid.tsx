// First-visit cinematic: a 14×9 "MIT shape-shifting table" grid of
// pins that animates through three scenes to communicate, in this
// order:
//   1. "shows you layers of *data*"  -- a stadium wave sweeps the
//       grid, lifting pins and tinting them orange as it passes.
//   2. "lets you express your *preferences*" -- a circular mask
//       narrows in from the outside; pins outside the (shrinking)
//       central hole rise and turn orange. End state: nearly-full
//       orange-lifted grid with a small central purple hole.
//   3. "and *combine* layers" -- two stencils slide apart and then
//       back together. Orange stencil = the Scene 2 end shape
//       (full sheet with a circular hole). Blue stencil = a
//       diagonal alpha ramp (opaque at bottom-right, transparent
//       at upper-left). Where both cover a cell, the pin shows a
//       new "mix" colour (the warm magenta we already use as the
//       curve editor midpoint).
//
// Implementation notes:
//   - The pin geometry is real CSS 3D: each pin is a preserve-3d
//     box with a top face (translateZ = --lift) and two side walls
//     (height = --lift) rotated 90° to stand vertically. The walls
//     use a multiply-blended dark gradient over the top face's hue
//     so they auto-shade for any colour we set. The right wall is
//     dimmed an extra ~18% (filter: brightness) because it faces
//     away from the implied light source. Adjacent occlusion is
//     free: the grid wrapper has transform-style: preserve-3d, so
//     a tall pin in front correctly covers a shorter pin behind it
//     in the rendered frame.
//   - Animation is driven imperatively via RAF for performance:
//     pins render exactly once via React; on each frame we update
//     their --lift and --hue custom properties through refs. With
//     14×9 = 126 pins, going through React on every frame would
//     spend a chunk of each frame in reconciliation; direct DOM
//     style writes keep the scene fluid even on lower-end devices.
//   - The caption uses React state since it only changes ~3 times
//     across the whole sequence (once per scene).

import { useEffect, useMemo, useRef, useState } from 'react';

const COLS = 14;
const ROWS = 9;
const CELL = 36;
const GAP = 4;
const MAX_LIFT = 24; // px peak pin height

// Palette intentionally reuses the curve editor's hand-picked stops
// so the abstract grid visually rhymes with the live UI the user
// drops into after the intro finishes.
const COLOR_FLAT = '#5a3a56';     // resting plum
const COLOR_ORANGE = '#c69c42';   // "preference satisfied" warm
const COLOR_BLUE = '#4a6fb8';     // royal blue, second preference
const COLOR_MIX = '#a75b4d';      // both preferences agree

type SceneId = 'data' | 'preferences' | 'combine';

interface SceneSpec {
  id: SceneId;
  before: string;
  highlight: string;
  after: string;
  highlightColor: string;
  // Optional second colour: when set, the highlighted word renders
  // with a horizontal gradient between the two colours -- used on
  // "combine" to fade orange → blue across the word.
  highlightColor2?: string;
  durationMs: number;
}

const SCENES: SceneSpec[] = [
  {
    id: 'data',
    before: 'shows you layers of ',
    highlight: 'data',
    after: '',
    highlightColor: COLOR_ORANGE,
    durationMs: 4800,
  },
  {
    id: 'preferences',
    before: 'lets you express your ',
    highlight: 'preferences',
    after: '',
    highlightColor: COLOR_ORANGE,
    durationMs: 4200,
  },
  {
    id: 'combine',
    before: 'and ',
    highlight: 'combine',
    after: ' layers',
    highlightColor: COLOR_ORANGE,
    highlightColor2: COLOR_BLUE,
    durationMs: 5800,
  },
];

// ─── pure math helpers ─────────────────────────────────────────────

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
function easeInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 2 * c * c : -1 + (4 - 2 * c) * c;
}
function easeOut(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) * (1 - c);
}
function lerpColor(a: string, b: string, t: number): string {
  const tt = clamp01(t);
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  return `rgb(${Math.round(lerp(ar, br, tt))},${Math.round(lerp(ag, bg, tt))},${Math.round(lerp(ab, bb, tt))})`;
}

// ─── per-scene cell-state functions ────────────────────────────────

interface PinState { lift: number; color: string }

// Scene 1: a single travelling Gaussian wavefront with a softer
// trailing pulse, then settle back to flat. Two waves so the
// "stadium wave" reading lands without the user feeling the scene
// is over after one pass.
function dataState(t: number, col: number, row: number): PinState {
  const wavePositions: number[] = [];
  // First wave: 0 → 0.45 traverses left to right.
  if (t < 0.45) wavePositions.push(lerp(-2.5, COLS + 1.5, t / 0.45));
  // Second wave: 0.50 → 0.88, slightly behind so they don't merge.
  if (t > 0.50 && t < 0.88) wavePositions.push(lerp(-2.5, COLS + 1.5, (t - 0.50) / 0.38));
  const sigma = 1.7;
  let intensity = 0;
  for (const wp of wavePositions) {
    const d = col - wp;
    intensity = Math.max(intensity, Math.exp(-(d * d) / (2 * sigma * sigma)));
  }
  // Edges of the grid (top/bottom rows) lift a hair less, so the
  // wave reads as a 3D crest rather than a perfect column rise.
  const rowFalloff = 1 - Math.abs(row - (ROWS - 1) / 2) * 0.04;
  intensity *= rowFalloff;
  return {
    lift: intensity * MAX_LIFT,
    color: lerpColor(COLOR_FLAT, COLOR_ORANGE, intensity),
  };
}

// Scene 2: circular "hole" mask narrows from outside the grid down
// to a tiny central radius. Cells outside the hole are lifted and
// orange; cells inside (the hole itself) remain flat purple. The
// feathered band makes the moving boundary read as a soft frontier
// rather than a hard cut.
function preferencesState(t: number, col: number, row: number): PinState {
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;
  const dx = col - cx;
  const dy = row - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxR = Math.sqrt(cx * cx + cy * cy) + 1.0;
  const minR = 1.1;
  // 0 → 0.78 shrinks the hole; 0.78 → 1.0 holds at the small radius
  // so the user has time to read the final shape before scene 3
  // transitions in.
  const phase = t < 0.78 ? easeOut(t / 0.78) : 1;
  const holeR = lerp(maxR, minR, phase);
  // Feather across ~0.8 cells around the boundary -- enough to make
  // the edge soft without losing the "this is a defined shape" read.
  const feather = 0.8;
  const intensity = clamp01((dist - holeR) / feather + 0.5);
  return {
    lift: intensity * MAX_LIFT,
    color: lerpColor(COLOR_FLAT, COLOR_ORANGE, intensity),
  };
}

// Scene 3: two stencils animate horizontal offsets in cell-units.
// orangeOffset > 0 shifts the orange sheet right (revealing the
// left edge as un-covered). blueOffset starts off-screen-left so
// blue enters from the left edge of the grid as orange retreats.
function scene3Offsets(t: number): { oX: number; bX: number } {
  // Phase A (0   - 0.22): split  -- orange slides right; blue slides
  //                                 in from left, matching motion.
  // Phase B (0.22- 0.42): hold split
  // Phase C (0.42- 0.66): both slide toward centre, overlapping
  // Phase D (0.66- 1.00): hold combined state
  const orangeSplit = 4;
  const blueOffscreen = -(COLS + 2);
  const blueSplit = -4;
  if (t < 0.22) {
    const p = easeInOut(t / 0.22);
    return { oX: lerp(0, orangeSplit, p), bX: lerp(blueOffscreen, blueSplit, p) };
  }
  if (t < 0.42) return { oX: orangeSplit, bX: blueSplit };
  if (t < 0.66) {
    const p = easeInOut((t - 0.42) / 0.24);
    return { oX: lerp(orangeSplit, 0, p), bX: lerp(blueSplit, 0, p) };
  }
  return { oX: 0, bX: 0 };
}

// Orange stencil: a sheet spanning the whole grid extent in the
// stencil's local frame, opaque everywhere except a small circular
// hole at the centre.
function inOrangeShape(localCol: number, localRow: number): boolean {
  if (localCol < -0.5 || localCol > COLS - 0.5) return false;
  if (localRow < -0.5 || localRow > ROWS - 0.5) return false;
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;
  const dx = localCol - cx;
  const dy = localRow - cy;
  return Math.sqrt(dx * dx + dy * dy) > 1.3;
}

// Blue stencil: same extent, opaque diagonally from the bottom-right
// corner inward. Threshold at 0.5 gives a clean half-grid coverage.
function inBlueShape(localCol: number, localRow: number): boolean {
  if (localCol < -0.5 || localCol > COLS - 0.5) return false;
  if (localRow < -0.5 || localRow > ROWS - 0.5) return false;
  const alpha = (localCol + localRow) / (COLS + ROWS - 2);
  return alpha > 0.48;
}

function combineState(t: number, col: number, row: number): PinState {
  const { oX, bX } = scene3Offsets(t);
  const inO = inOrangeShape(col - oX, row);
  const inB = inBlueShape(col - bX, row);
  if (inO && inB) return { lift: MAX_LIFT, color: COLOR_MIX };
  if (inO) return { lift: MAX_LIFT, color: COLOR_ORANGE };
  if (inB) return { lift: MAX_LIFT, color: COLOR_BLUE };
  return { lift: 0, color: COLOR_FLAT };
}

function pinStateAt(sceneId: SceneId, t: number, col: number, row: number): PinState {
  if (sceneId === 'data') return dataState(t, col, row);
  if (sceneId === 'preferences') return preferencesState(t, col, row);
  return combineState(t, col, row);
}

// ─── component ─────────────────────────────────────────────────────

interface IntroDataGridProps {
  onComplete: () => void;
}

export function IntroDataGrid({ onComplete }: IntroDataGridProps) {
  const [sceneIdx, setSceneIdx] = useState(0);
  const pinRefs = useRef<(HTMLDivElement | null)[]>([]);
  const completedRef = useRef(false);

  // Static cell positions (in unrotated grid space).
  const cells = useMemo(() => {
    const out: { col: number; row: number; x: number; y: number }[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        out.push({ col, row, x: col * (CELL + GAP), y: row * (CELL + GAP) });
      }
    }
    return out;
  }, []);

  // Stable ref so the RAF closure always sees the latest callback
  // even if the parent re-renders mid-sequence with a new function.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const startTime = performance.now();
    const durations = SCENES.map((s) => s.durationMs);
    const total = durations.reduce((a, b) => a + b, 0);
    let lastSceneIdx = -1;

    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - startTime;
      if (elapsed >= total) {
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleteRef.current();
        }
        return;
      }

      let accum = 0;
      let idx = 0;
      let t = 0;
      for (let i = 0; i < SCENES.length; i++) {
        if (elapsed < accum + durations[i]) {
          idx = i;
          t = (elapsed - accum) / durations[i];
          break;
        }
        accum += durations[i];
      }
      if (idx !== lastSceneIdx) {
        lastSceneIdx = idx;
        setSceneIdx(idx);
      }

      const sceneId = SCENES[idx].id;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const s = pinStateAt(sceneId, t, c.col, c.row);
        const el = pinRefs.current[i];
        if (el) {
          // Unitless on purpose: CSS uses calc(var(--lift) * 1px)
          // where it needs a length and a plain calc(var(--lift) / N)
          // where it needs a number (opacity). A px-valued custom
          // property would make the opacity calc return a length and
          // get treated as invalid, so the shadow stayed permanently
          // visible -- which read on screen as a "weird circle"
          // under every pin even when fully down.
          el.style.setProperty('--lift', s.lift.toFixed(2));
          el.style.setProperty('--hue', s.color);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [cells]);

  const gridW = COLS * (CELL + GAP) - GAP;
  const gridH = ROWS * (CELL + GAP) - GAP;
  const spec = SCENES[sceneIdx];

  return (
    <div className="intro-grid-stage">
      <div
        className="intro-grid-tilt"
        style={{ width: gridW, height: gridH }}
      >
        {cells.map((c, i) => (
          <div
            key={i}
            ref={(el) => { pinRefs.current[i] = el; }}
            className="intro-pin"
            style={{
              transform: `translate3d(${c.x}px, ${c.y}px, 0)`,
              ['--lift' as never]: '0',
              ['--hue' as never]: COLOR_FLAT,
            }}
          >
            <div className="intro-pin-shadow" />
            <div className="intro-pin-side intro-pin-side-front" />
            <div className="intro-pin-side intro-pin-side-right" />
            <div className="intro-pin-top" />
          </div>
        ))}
      </div>

      <div className="intro-grid-caption">
        <p key={sceneIdx} className="intro-grid-caption-line">
          <span>{spec.before}</span>
          {spec.highlightColor2 ? (
            <strong
              className="intro-grid-caption-hl intro-grid-caption-hl-gradient"
              style={{
                backgroundImage: `linear-gradient(90deg, ${spec.highlightColor}, ${spec.highlightColor2})`,
              }}
            >
              {spec.highlight}
            </strong>
          ) : (
            <strong
              className="intro-grid-caption-hl"
              style={{ color: spec.highlightColor }}
            >
              {spec.highlight}
            </strong>
          )}
          <span>{spec.after}</span>
        </p>
      </div>
    </div>
  );
}
