// First-visit cinematic: a low-res world map made of "MIT inFORM"
// style pins that storytells utopiamap's core mechanic in three
// movements -- "data → preferences → combine" -- using temperature
// (cube colour) and elevation (cube height) as the two layers.
//
// Story spine: "find warm places to climb"
//   0. story        story setup ("warm places to climb")
//   1. temp         show layer 1: temperature gradient on the map
//   2. temp-pref    apply the "warm" preference: cool cells fade
//   3. elev         introduce layer 2: cubes rise to elevation
//                   (colours fade back to flat first so the elevation
//                   reads as a fresh layer, not a mod of the colours)
//   4. elev-pref    apply the "high" preference: low cubes drop
//   5. combine      AND the two filters: only warm + high survives
//                   (e.g. Andes, Ethiopian Highlands, Himalayas tail)
//
// Pacing principle (user explicitly requested): text comes in FIRST,
// then a beat to read, THEN animation. Never simultaneous. Every
// scene's animation start is offset by a readable amount so the eye
// always has one job at a time.
//
// Implementation notes:
//   - The world map is procedural: a handful of lat/lon bounding
//     regions with optional taper shaping (NA/SA/Africa/Eurasia all
//     taper from wide tops to narrower bottoms). At 44×16 resolution
//     this gives instantly recognisable continent silhouettes while
//     remaining trivial to tune via TypeScript edits rather than ASCII.
//   - Only LAND cells render -- the ocean cells aren't even in the
//     DOM. This is what sells "this is a map of the world" instead
//     of an abstract grid.
//   - Temperature is cosine of latitude with a tiny longitudinal
//     modulation; elevation is a sum of Gaussian bumps at known
//     mountain ranges. Both are tuned so the "warm AND high" filter
//     reveals a satisfying handful of geographically-meaningful
//     survivors at the end.
//   - Per-cell state is computed every RAF tick by pinStateAt(scene,
//     t, cellInfo); cellInfo is pre-computed once per cell. Pin DOM
//     is rendered exactly once via React; the RAF loop updates --lift
//     and --hue through refs to avoid reconciliation cost per frame.

import { useEffect, useMemo, useRef, useState } from 'react';

// ─── grid & palette ────────────────────────────────────────────────

const COLS = 44;
const ROWS = 16;
const CELL = 18;     // px per pin
const GAP = 2;
const MAX_LIFT = 14; // peak pin height (px); deliberately less than
                     // the previous 24 because cells are smaller now.

const COLOR_FLAT = '#3e2840';     // dim plum (the "no data" baseline)
const COLOR_WARM = '#c69c42';     // amber-gold for hot temperature & "warm AND high" survivors
const COLOR_PLUM = '#5a3a56';     // mid plum -- intermediate temperature stop
const COLOR_RUST = '#a75b4d';     // warm rust -- intermediate temperature stop (also matches curve editor mid)

// Latitude range we render. Cropping at ±75° kills the Antarctic
// blob (which adds nothing for our story) and keeps the visible
// world's aspect ratio close to 3:1.
const LAT_TOP = 75;
const LAT_BOT = -75;

const lonAtCol = (col: number) => -180 + (col / (COLS - 1)) * 360;
const latAtRow = (row: number) => LAT_TOP - (row / (ROWS - 1)) * (LAT_TOP - LAT_BOT);

// ─── world map silhouette ──────────────────────────────────────────

interface Region {
  name: string;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  // 'taper-down' = narrower at the bottom (NA, SA, Africa, etc.)
  // undefined = rectangular bounding-box
  shape?: 'taper-down';
  centerLon?: number;
}

const REGIONS: Region[] = [
  // North America: wide at the Canadian top, narrows through Mexico
  { name: 'na',         lonMin: -130, lonMax: -65,  latMin:  14, latMax: 73,  shape: 'taper-down', centerLon: -100 },
  { name: 'alaska',     lonMin: -170, lonMax: -130, latMin:  55, latMax: 72 },
  { name: 'cAmerica',   lonMin:  -95, lonMax: -78,  latMin:   7, latMax: 18 },
  { name: 'greenland',  lonMin:  -55, lonMax: -22,  latMin:  60, latMax: 76 },

  // South America: widest in the Amazon basin, tapers to Patagonia
  { name: 'sa',         lonMin:  -80, lonMax: -35,  latMin: -55, latMax: 12,  shape: 'taper-down', centerLon: -62 },

  // Europe + Scandinavia + Russia (a single chunky horizontal slab)
  { name: 'europe',     lonMin:  -10, lonMax:  35,  latMin:  36, latMax: 70 },
  { name: 'russia',     lonMin:   20, lonMax: 175,  latMin:  45, latMax: 73 },

  // Middle East joining Europe to Asia
  { name: 'middleEast', lonMin:   32, lonMax:  60,  latMin:  12, latMax: 42 },

  // Africa: widest in the Sahara band, tapers to the Cape
  { name: 'africa',     lonMin:  -18, lonMax:  50,  latMin: -35, latMax: 37,  shape: 'taper-down', centerLon: 17 },

  // India: distinctive tapered peninsula
  { name: 'india',      lonMin:   68, lonMax:  92,  latMin:   6, latMax: 35,  shape: 'taper-down', centerLon: 78 },

  // China / east-Asia mainland
  { name: 'china',      lonMin:   92, lonMax: 135,  latMin:  18, latMax: 53 },

  // SE Asia + Indonesia (merged at this resolution; good enough)
  { name: 'seAsia',     lonMin:   95, lonMax: 145,  latMin: -10, latMax: 22 },

  // Japan
  { name: 'japan',      lonMin:  130, lonMax: 146,  latMin:  30, latMax: 45 },

  // Australia
  { name: 'australia',  lonMin:  113, lonMax: 155,  latMin: -38, latMax: -12 },

  // Madagascar (separate isle so Africa's east coast doesn't read as merged)
  { name: 'madagascar', lonMin:   43, lonMax:  51,  latMin: -26, latMax: -12 },
];

function isLand(col: number, row: number): boolean {
  const lon = lonAtCol(col);
  const lat = latAtRow(row);
  for (const r of REGIONS) {
    if (lon < r.lonMin || lon > r.lonMax) continue;
    if (lat < r.latMin || lat > r.latMax) continue;
    if (r.shape === 'taper-down') {
      // yNorm goes 0 at top, 1 at bottom; factor squeezes the
      // horizontal extent toward 0 as we approach the bottom.
      const yNorm = (r.latMax - lat) / (r.latMax - r.latMin);
      const center = r.centerLon ?? (r.lonMin + r.lonMax) / 2;
      const halfWidth = (r.lonMax - r.lonMin) / 2;
      const factor = lerp(1.0, 0.22, yNorm * yNorm);
      if (Math.abs(lon - center) > halfWidth * factor) continue;
    }
    return true;
  }
  return false;
}

// ─── data layers: temperature + elevation ──────────────────────────

function temperatureAt(col: number, row: number): number {
  const lat = latAtRow(row);
  const lon = lonAtCol(col);
  // Cosine of latitude: 1.0 at equator, 0.0 at poles.
  let t = Math.cos((lat * Math.PI) / 180);
  // Continental-interior cooling bias breaks the perfect latitude
  // bands; just enough to add visual texture so the temp layer
  // doesn't look like a 1D gradient.
  const interiorBias = 0.06 * Math.cos(((lon + 90) * 2 * Math.PI) / 360);
  return Math.max(0, Math.min(1, t - interiorBias));
}

// Each mountain is an anisotropic Gaussian (different sigma per
// axis) so long ranges like the Andes can be tall and narrow without
// blooming sideways.
const MOUNTAINS = [
  { name: 'rockies',    lat:  42, lon: -112, sigmaLat:  7, sigmaLon:  8, height: 0.72 },
  { name: 'andes',      lat: -15, lon:  -70, sigmaLat: 18, sigmaLon:  4, height: 1.00 },
  { name: 'alps',       lat:  46, lon:    9, sigmaLat:  3, sigmaLon:  6, height: 0.55 },
  { name: 'himalayas',  lat:  30, lon:   85, sigmaLat:  6, sigmaLon: 14, height: 1.00 },
  { name: 'ethiopia',   lat:  10, lon:   38, sigmaLat:  6, sigmaLon:  5, height: 0.78 },
  { name: 'greenland',  lat:  70, lon:  -40, sigmaLat:  8, sigmaLon: 12, height: 0.50 },
  { name: 'outback',    lat: -25, lon:  135, sigmaLat:  6, sigmaLon: 10, height: 0.32 },
  { name: 'drakensbg',  lat: -30, lon:   28, sigmaLat:  4, sigmaLon:  6, height: 0.42 },
];

function elevationAt(col: number, row: number): number {
  const lat = latAtRow(row);
  const lon = lonAtCol(col);
  let h = 0;
  for (const m of MOUNTAINS) {
    const dLat = (lat - m.lat) / m.sigmaLat;
    const dLon = (lon - m.lon) / m.sigmaLon;
    h = Math.max(h, m.height * Math.exp(-(dLat * dLat + dLon * dLon) / 2));
  }
  return Math.min(1, h);
}

// Thresholds for the two preference filters. Tuned so the "warm
// AND high" intersection ends up being a satisfying handful of
// geographically-meaningful cells (Andes near equator, Ethiopian
// Highlands, the warm tail of the Himalayas, southern Rockies).
const WARM_THRESHOLD = 0.62;
const HIGH_THRESHOLD = 0.30;

// ─── colour helpers ────────────────────────────────────────────────

function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * clamp01(t); }
function easeOut(t: number): number { const c = clamp01(t); return 1 - (1 - c) * (1 - c); }
function easeInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 2 * c * c : -1 + (4 - 2 * c) * c;
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

// Temperature → colour: 4-stop ramp through the same palette family
// as the live curve editor, so the abstract intro reads in the same
// visual language as the real product.
function tempColor(temp: number): string {
  const t = clamp01(temp);
  if (t < 0.35) return lerpColor(COLOR_FLAT, COLOR_PLUM, t / 0.35);
  if (t < 0.65) return lerpColor(COLOR_PLUM, COLOR_RUST, (t - 0.35) / 0.30);
  return lerpColor(COLOR_RUST, COLOR_WARM, (t - 0.65) / 0.35);
}

// ─── per-scene cell-state functions ────────────────────────────────

interface CellInfo {
  col: number;
  row: number;
  tempColor: string;
  warm: boolean;
  elevation: number;
  high: boolean;
}

interface PinState { lift: number; color: string }

// Story scene: everything flat plum. The visual is the silhouette
// of the world; the text does all the storytelling.
function storyState(): PinState {
  return { lift: 0, color: COLOR_FLAT };
}

// Temperature scene: hold flat plum while the caption appears and
// the user reads it, then tween every cell from plum → its
// temperature colour over 1.5s. The hold-after gives the eye a
// chance to land on the equatorial band before scene 2 strips it
// down to just "warm".
function tempState(t: number, c: CellInfo): PinState {
  if (t < 1800) return { lift: 0, color: COLOR_FLAT };
  const progress = clamp01((t - 1800) / 1500);
  return { lift: 0, color: lerpColor(COLOR_FLAT, c.tempColor, progress) };
}

// Warm-preference scene: cool cells fade BACK to plum; warm cells
// stay coloured. The hold at the start gives the user time to read
// the caption before the visual changes.
function tempPrefState(t: number, c: CellInfo): PinState {
  if (c.warm) return { lift: 0, color: c.tempColor };
  if (t < 800) return { lift: 0, color: c.tempColor };
  const progress = clamp01((t - 800) / 1400);
  return { lift: 0, color: lerpColor(c.tempColor, COLOR_FLAT, progress) };
}

// Elevation scene: three phases in sequence so the user has time to
// see WHAT'S happening before WHY:
//   0    -> 1500ms: hold (read caption)
//   1500 -> 2300ms: all colours fade back to plum (warm cells lose
//                   their orange; cool cells already are plum so they
//                   don't move). This resets the colour channel so
//                   the elevation rise reads as "new layer, not a
//                   tweak of the old".
//   2300 -> 4000ms: cubes rise to their elevation heights (eased).
//   4000 -> end   : hold so user can read the mountain ridges.
function elevState(t: number, c: CellInfo): PinState {
  let color = c.warm ? c.tempColor : COLOR_FLAT;
  if (t >= 1500 && c.warm) {
    color = lerpColor(c.tempColor, COLOR_FLAT, clamp01((t - 1500) / 800));
  }
  if (t >= 2300) {
    color = COLOR_FLAT;
  }
  let lift = 0;
  if (t >= 2300) {
    lift = c.elevation * MAX_LIFT * easeOut(clamp01((t - 2300) / 1700));
  }
  return { lift, color };
}

// High-preference scene: low cubes drop back to flat; mountain
// cubes stay raised. Same pacing pattern as temp-pref: brief hold
// for the caption to land, then the animation.
function elevPrefState(t: number, c: CellInfo): PinState {
  const fullLift = c.elevation * MAX_LIFT;
  if (c.high) return { lift: fullLift, color: COLOR_FLAT };
  if (t < 800) return { lift: fullLift, color: COLOR_FLAT };
  const progress = clamp01((t - 800) / 1400);
  return { lift: fullLift * (1 - progress), color: COLOR_FLAT };
}

// Combine scene: this is the payoff. End state shows ONLY cells
// that pass BOTH filters (warm AND high), in full colour and full
// lift. Everything else collapses to flat plum.
//
// Animation:
//   0    -> 1500ms: hold from elev-pref end (high cells raised
//                   plum, low cells flat plum). Caption appears.
//   1500 -> 3500ms: simultaneous transitions --
//                     high+warm: colour plum → temp colour
//                     high+cool: lift → 0 (drops away)
//                     low      : already at rest
//   3500 -> 4500ms: hold the survivors in their final state.
//   4500 -> end   : subcaption appears ("Found.")
function combineState(t: number, c: CellInfo): PinState {
  const fullLift = c.elevation * MAX_LIFT;
  if (!c.high) return { lift: 0, color: COLOR_FLAT };
  // From here on, c.high is true.
  if (t < 1500) return { lift: fullLift, color: COLOR_FLAT };
  const progress = easeInOut(clamp01((t - 1500) / 2000));
  if (c.warm) {
    return {
      lift: fullLift,
      color: lerpColor(COLOR_FLAT, c.tempColor, progress),
    };
  }
  return {
    lift: fullLift * (1 - progress),
    color: COLOR_FLAT,
  };
}

function pinStateAt(sceneId: string, t: number, cell: CellInfo): PinState {
  switch (sceneId) {
    case 'story':     return storyState();
    case 'temp':      return tempState(t, cell);
    case 'temp-pref': return tempPrefState(t, cell);
    case 'elev':      return elevState(t, cell);
    case 'elev-pref': return elevPrefState(t, cell);
    case 'combine':   return combineState(t, cell);
    default:          return storyState();
  }
}

// ─── scene table ───────────────────────────────────────────────────

interface CaptionEvent { appearAtMs: number; text: string }

interface SceneSpec {
  id: string;
  durationMs: number;
  captions: CaptionEvent[];
}

// Caption text uses **highlight** for the orange-accented words.
// Pacing principle: every caption appears at least ~200ms after the
// scene begins (so the eye registers the transition); animations are
// scheduled later still so the user can read first, then watch.
const SCENES: SceneSpec[] = [
  {
    id: 'story',
    durationMs: 5200,
    captions: [
      { appearAtMs: 300,  text: 'Utopiamap helps you find places that match what matters to you.' },
      { appearAtMs: 2600, text: "Let's find **warm places to climb**." },
    ],
  },
  {
    id: 'temp',
    durationMs: 4800,
    captions: [
      { appearAtMs: 200, text: 'It shows you layers of **data** — like temperature.' },
    ],
  },
  {
    id: 'temp-pref',
    durationMs: 3400,
    captions: [
      { appearAtMs: 200, text: 'Your **preference** — warm.' },
    ],
  },
  {
    id: 'elev',
    durationMs: 5400,
    captions: [
      { appearAtMs: 200, text: 'Now another layer — **elevation**.' },
    ],
  },
  {
    id: 'elev-pref',
    durationMs: 3400,
    captions: [
      { appearAtMs: 200, text: 'Your **preference** — high.' },
    ],
  },
  {
    id: 'combine',
    durationMs: 6800,
    captions: [
      { appearAtMs: 200,  text: '**Combine** preferences.' },
      { appearAtMs: 4600, text: 'Warm. High. **Found.**' },
    ],
  },
];

// ─── component ─────────────────────────────────────────────────────

interface IntroDataGridProps {
  onComplete: () => void;
}

export function IntroDataGrid({ onComplete }: IntroDataGridProps) {
  const [sceneIdx, setSceneIdx] = useState(0);
  // sceneT is held in a ref to avoid forcing React re-renders every
  // frame (captions only need to know which ones to mount, not the
  // sub-millisecond progress within a scene).
  const sceneTRef = useRef(0);
  const [captionsVisible, setCaptionsVisible] = useState<number>(0);
  const pinRefs = useRef<(HTMLDivElement | null)[]>([]);
  const completedRef = useRef(false);

  // Pre-compute per-cell info ONCE: lat/lon-derived values that
  // never change across scenes. Only land cells are included; ocean
  // cells aren't rendered at all (which is what makes the silhouette
  // legible as a world map).
  const cells = useMemo<Array<CellInfo & { x: number; y: number }>>(() => {
    const out: Array<CellInfo & { x: number; y: number }> = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!isLand(col, row)) continue;
        const temp = temperatureAt(col, row);
        const elev = elevationAt(col, row);
        out.push({
          col, row,
          x: col * (CELL + GAP),
          y: row * (CELL + GAP),
          tempColor: tempColor(temp),
          warm: temp >= WARM_THRESHOLD,
          elevation: elev,
          high: elev >= HIGH_THRESHOLD,
        });
      }
    }
    return out;
  }, []);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const startTime = performance.now();
    const durations = SCENES.map((s) => s.durationMs);
    const total = durations.reduce((a, b) => a + b, 0);
    let lastSceneIdx = -1;
    let lastCaptionsCount = 0;

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
          t = elapsed - accum;
          break;
        }
        accum += durations[i];
      }
      sceneTRef.current = t;

      if (idx !== lastSceneIdx) {
        lastSceneIdx = idx;
        lastCaptionsCount = 0;
        setSceneIdx(idx);
        setCaptionsVisible(0);
      }

      // Count how many of the current scene's captions should be
      // visible by now (their appearAtMs ≤ scene-local t).
      const scene = SCENES[idx];
      let visible = 0;
      for (const c of scene.captions) {
        if (t >= c.appearAtMs) visible++;
        else break;
      }
      if (visible !== lastCaptionsCount) {
        lastCaptionsCount = visible;
        setCaptionsVisible(visible);
      }

      const sceneId = scene.id;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const s = pinStateAt(sceneId, t, c);
        const el = pinRefs.current[i];
        if (el) {
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
  const scene = SCENES[sceneIdx];
  const visibleCaptions = scene.captions.slice(0, captionsVisible);

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
        {visibleCaptions.map((c, i) => (
          <p
            key={`${sceneIdx}-${i}`}
            className={`intro-grid-caption-line intro-grid-caption-${i === 0 ? 'primary' : 'secondary'}`}
          >
            {renderCaption(c.text)}
          </p>
        ))}
      </div>
    </div>
  );
}

// ─── caption rendering ─────────────────────────────────────────────

// Lightweight markdown for captions: text wrapped in **double stars**
// renders as the orange-accent highlight. Everything else is plain
// text. Kept inline because we control all the source text and never
// need to handle untrusted input.
function renderCaption(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <strong key={i} className="intro-grid-caption-hl" style={{ color: COLOR_WARM }}>
          {p.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
