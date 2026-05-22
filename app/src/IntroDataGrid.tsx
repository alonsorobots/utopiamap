// First-visit cinematic: a low-res world map made of "MIT inFORM"
// style pins that storytells utopiamap's core mechanic in three
// movements -- "data → preferences → combine" -- using temperature
// (cube colour) and elevation (cube height) as the two layers.
//
// Story spine: "find warm places with mountains to hike"
//   0. story        big-picture intro: "find places that match what
//                   matters to you"
//   1. goal         the concrete example we'll work through ("warm
//                   mountains to hike") -- separate card so the user
//                   isn't asked to read two ideas in one beat
//   2. temp         layer 1 = temperature, sweep-in via ripples from
//                   the equator (so the appearance of the gradient
//                   reads as a process, not a snap)
//   3. temp-pref    preference 1 = warm: cool cells fade back to plum
//   4. elev         layer 2 = elevation: colours fade back to plum
//                   first (so elevation reads as a fresh layer, not a
//                   tweak of the colours) then cubes rise
//   5. elev-pref    preference 2 = high: low cubes drop
//   6. combine      AND the two filters: only warm + high survives
//                   (Andes, Ethiopian Highlands, Himalayan foothills)
//
// Pacing principle (user explicitly requested): text comes in FIRST,
// then a beat to read, THEN animation. Never simultaneous. Every
// scene's animation start is offset by a readable amount so the eye
// always has one job at a time.
//
// Self-paced navigation: ‹ / › buttons (and ArrowLeft/ArrowRight)
// jump between scene boundaries. Auto-advance still runs in the
// background, so a passive viewer sees the whole show without
// touching anything, but anyone who wants to slow down or rewind
// can. We shift startTimeRef rather than pausing RAF so the
// per-frame state pipeline stays uniform across modes.
//
// Implementation notes:
//   - The world map is procedural: a handful of lat/lon bounding
//     regions with optional taper shaping (NA/SA/Africa/Eurasia all
//     taper from wide tops to narrower bottoms). At 44×18 resolution
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ─── grid & palette ────────────────────────────────────────────────

const COLS = 44;
const ROWS = 18;     // bumped from 16 so northern continents (Russia,
                     // Greenland, Alaska) get enough vertical
                     // resolution to read as distinct landmasses.
const CELL = 18;     // px per pin
const GAP = 2;
const MAX_LIFT = 75; // peak pin height (px). Bumped again from 42 --
                     // user feedback: "height of the altitude is
                     // still not high enough". At 75px on 18px cells
                     // the tallest peaks tower over 4× their base
                     // width, so mountains read unmistakably.

// Palette. COLOR_FLAT is the baseline for "no data" cells -- it's
// intentionally DARKER and MORE MUTED than the previous #3e2840
// (which read as overly saturated plum and made the world look
// "cheaper than the rest of the app", per user feedback). COLOR_COLD
// is brand-new: it's the brightest cool stop the temperature ramp
// settles to in polar regions, so that AFTER the temperature layer
// is applied, even cold cells are visibly coloured (not blending
// into the flat baseline) -- this fixes the "VERY dark squares ...
// pretty much not visible" bug in the temperature scene.
const COLOR_FLAT = '#2c2630';     // darker, more muted "no data" baseline
const COLOR_COLD = '#4a4458';     // cool blue-grey: brightest "cold-data" stop
const COLOR_PLUM = '#5a3a56';     // mid plum -- intermediate temperature stop
const COLOR_RUST = '#a75b4d';     // warm rust -- intermediate temperature stop (matches curve editor)
const COLOR_WARM = '#c69c42';     // amber-gold for hot temperature & "warm AND high" survivors

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

// Northern landmasses (Alaska, NA, Greenland, Russia) are explicitly
// pushed up to latMax 75-80 so they show up in row 0 -- the user
// reported these "seemed to be missing" because the previous extents
// (latMax 72-76) made them only appear once or twice in the foreshortened
// back rows.
const REGIONS: Region[] = [
  // North America: wide at the Canadian top, narrows through Mexico
  { name: 'na',         lonMin: -130, lonMax: -55,  latMin:  14, latMax: 76,  shape: 'taper-down', centerLon: -100 },
  { name: 'alaska',     lonMin: -170, lonMax: -130, latMin:  55, latMax: 75 },
  { name: 'cAmerica',   lonMin:  -95, lonMax: -78,  latMin:   7, latMax: 18 },
  { name: 'greenland',  lonMin:  -55, lonMax: -22,  latMin:  60, latMax: 80 },

  // South America: widest in the Amazon basin, tapers to Patagonia
  { name: 'sa',         lonMin:  -80, lonMax: -35,  latMin: -55, latMax: 12,  shape: 'taper-down', centerLon: -62 },

  // Europe + Scandinavia + Russia (a single chunky horizontal slab)
  { name: 'europe',     lonMin:  -10, lonMax:  35,  latMin:  36, latMax: 72 },
  { name: 'russia',     lonMin:   20, lonMax: 178,  latMin:  45, latMax: 76 },

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
  const t = Math.cos((lat * Math.PI) / 180);
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

// Thresholds for the two preference filters. WARM_THRESHOLD raised
// from 0.62 → 0.80 so the "warm" filter actually filters out most
// of the temperate world (the user's complaint was that the
// previous threshold only chopped off the top row); now warm =
// roughly tropics + low subtropics (lat -35..+35). HIGH_THRESHOLD
// raised so the elevation filter eliminates the broad low ranges
// (Outback, Drakensberg shoulders) and keeps only the real peaks.
const WARM_THRESHOLD = 0.80;
const HIGH_THRESHOLD = 0.42;

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
// visual language as the real product. The cold end now goes to
// COLOR_COLD (not COLOR_FLAT), so polar cells are visibly coloured
// once the temperature layer is applied, not indistinguishable
// from the "no data" baseline.
function tempColor(temp: number): string {
  const t = clamp01(temp);
  if (t < 0.35) return lerpColor(COLOR_COLD, COLOR_PLUM, t / 0.35);
  if (t < 0.65) return lerpColor(COLOR_PLUM, COLOR_RUST, (t - 0.35) / 0.30);
  return lerpColor(COLOR_RUST, COLOR_WARM, (t - 0.65) / 0.35);
}

// easeOutBack: standard cubic easing with a slight overshoot at the
// end (peak emerges, briefly overshoots, then settles). Used for the
// elevation rise so mountains "pop" rather than glide -- the user
// wanted a more dramatic, mountain-emerging-from-the-ground feel.
function easeOutBack(t: number): number {
  const c = clamp01(t);
  const k1 = 1.18;
  const k3 = k1 + 1;
  return 1 + k3 * Math.pow(c - 1, 3) + k1 * Math.pow(c - 1, 2);
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

// Story / goal scenes: everything flat plum. The visual is the
// silhouette of the world; the text does all the storytelling. Both
// the "find places that match what matters to you" and the "let's
// find warm mountains" beats use the same state so the world holds
// still while the user reads.
function storyState(): PinState {
  return { lift: 0, color: COLOR_FLAT };
}

// Temperature scene: hold flat plum while the caption reads, then
// "heat ripple" stabilises into the temperature gradient. The
// ripple is a sequence of expanding wavefronts from the equator --
// each wave briefly brightens cells toward warm gold and gives
// them a small lift, while the underlying colour tweens from plum
// to its final temperature. After ~2.5s the ripples have dissipated
// and every cell sits at its true tempColor. This addresses the
// user's "it just goes black" feedback -- now the transition is a
// process the eye can watch rather than a silent crossfade.
function tempState(t: number, c: CellInfo): PinState {
  if (t < 1500) return { lift: 0, color: COLOR_FLAT };

  const sinceStart = t - 1500;

  // Final colour the cell settles into.
  const settle = easeOut(clamp01(sinceStart / 2200));
  const settledColor = lerpColor(COLOR_FLAT, c.tempColor, settle);

  // Three expanding wavefronts from the equator, each spawned 380ms
  // apart and dampening as it propagates. We take the MAX intensity
  // across waves so a cell flashes once per wave that passes over it.
  const equatorRow = (ROWS - 1) / 2;
  const distFromEquator = Math.abs(c.row - equatorRow);
  const RIPPLE_SPEED = 0.0090; // rows / ms
  const SIGMA = 1.3;

  let intensity = 0;
  for (let i = 0; i < 3; i++) {
    const offset = sinceStart - i * 380;
    if (offset < 0) break;
    const wavePos = offset * RIPPLE_SPEED;
    const d = distFromEquator - wavePos;
    const radial = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
    // Wave amplitude decays with distance + falls off entirely once
    // the wavefront has reached past the poles.
    const damp = Math.max(0, 1 - wavePos / (ROWS * 0.7)) * Math.max(0, 1 - i * 0.32);
    intensity = Math.max(intensity, radial * damp);
  }

  // Brightness pulse + small lift at the wavefront, on top of the
  // settled colour.
  const finalColor = lerpColor(settledColor, COLOR_WARM, intensity * 0.55);
  const lift = intensity * 5; // small (max ~5px) -- the wave is a
                              //   ripple, not an elevation event.

  return { lift, color: finalColor };
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
//   2300+         : peaks-first staggered rise with overshoot.
//                   Tallest cells (Andes, Himalayas) rise FIRST with
//                   no delay; lower foothills rise progressively
//                   later. Each cell uses easeOutBack so it briefly
//                   overshoots its target, giving a "peaks erupting"
//                   feel rather than a smooth glide. The user
//                   feedback was that the lift was unclear -- this
//                   makes the rise unmistakable and dramatic.
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
    // Peaks first, foothills later: high elevation → 0 delay,
    // low elevation → up to 900ms delay.
    const stagger = (1 - c.elevation) * 900;
    const riseLocal = t - 2300 - stagger;
    if (riseLocal > 0) {
      lift = c.elevation * MAX_LIFT * easeOutBack(riseLocal / 1400);
    }
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
    case 'goal':      return storyState();
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
// scheduled later still so the user can read first, then watch. All
// caption lines are full sentences -- the previous "Your preference
// — warm." style read as fragments, per user feedback.
const SCENES: SceneSpec[] = [
  // Big-picture intro. Just the world silhouette, no animation.
  {
    id: 'story',
    durationMs: 4200,
    captions: [
      { appearAtMs: 200, text: 'Utopiamap helps you find places that match what matters to you.' },
    ],
  },
  // Concrete example we'll work through. Its own card so the user
  // isn't asked to absorb two ideas in a single beat.
  {
    id: 'goal',
    durationMs: 3400,
    captions: [
      { appearAtMs: 200, text: "Let's find **warm places with mountains** to hike." },
    ],
  },
  {
    id: 'temp',
    durationMs: 5400,
    captions: [
      // Reworded: the previous "...colours the world — here,
      // temperature" tripped on the "here, temperature" fragment.
      // This reads as a single, natural sentence.
      { appearAtMs: 200, text: 'It shows you data — like **temperature**.' },
    ],
  },
  {
    id: 'temp-pref',
    durationMs: 3800,
    captions: [
      { appearAtMs: 200, text: 'Tell it your **preference**, and it keeps the warm places.' },
    ],
  },
  {
    id: 'elev',
    // 6800ms gives the peaks-first staggered rise (up to ~4400ms
    // from start of rise window at t=2300) a ~600ms hold tail
    // before the next scene takes over.
    durationMs: 6800,
    captions: [
      { appearAtMs: 200, text: 'Add another layer — **elevation** lifts the mountains.' },
    ],
  },
  {
    id: 'elev-pref',
    durationMs: 3800,
    captions: [
      { appearAtMs: 200, text: 'Tell it your **preference**, and it keeps the high places.' },
    ],
  },
  {
    id: 'combine',
    durationMs: 6800,
    captions: [
      { appearAtMs: 200,  text: '**Combine** preferences, and only the places that match both remain.' },
      { appearAtMs: 4500, text: 'Warm mountains, **found**.' },
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
  const tiltRef = useRef<HTMLDivElement | null>(null);
  const completedRef = useRef(false);

  // startTimeRef is a ref (not a const captured in useEffect) so
  // the manual ‹/› buttons can rewind/advance the clock by writing
  // a new origin -- the RAF loop reads the current value every
  // tick and re-derives scene + scene-local-t from it.
  const startTimeRef = useRef<number>(performance.now());

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

  // Manual navigation: jump the clock to the start of a scene. We
  // shift startTimeRef rather than tracking scene-local time
  // separately, so the RAF pipeline stays uniform whether playback
  // is auto-advancing or user-driven.
  const goToScene = useCallback((newIdx: number) => {
    if (newIdx < 0) return;
    if (newIdx >= SCENES.length) {
      // "Next" on the last scene = finish the cinematic and let
      // the parent advance to pick-axes.
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current();
      }
      return;
    }
    let accum = 0;
    for (let i = 0; i < newIdx; i++) accum += SCENES[i].durationMs;
    startTimeRef.current = performance.now() - accum;
    setSceneIdx(newIdx);
    setCaptionsVisible(0);
  }, []);

  // Keyboard nav. Use capture so we beat the app's own arrow-key
  // handlers (axis cycling) while the intro is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        goToScene(sceneIdx - 1);
      } else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        goToScene(sceneIdx + 1);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [sceneIdx, goToScene]);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const durations = SCENES.map((s) => s.durationMs);
    const total = durations.reduce((a, b) => a + b, 0);
    let lastSceneIdx = -1;
    let lastCaptionsCount = 0;

    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - startTimeRef.current;
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

      // World-fade-in: per user feedback "text needs to start the
      // show". On the opening story scene the world map cubes hold
      // at opacity 0 until ~1.3s in (caption is already on screen
      // and has been read), then fade up over ~900ms. All other
      // scenes keep the world fully visible. Re-running this every
      // visit to scene 0 (e.g. user pressed ‹ back to start) is
      // intentional -- the fade is a brief and consistent cue.
      if (tiltRef.current) {
        const worldOpacity = sceneId === 'story'
          ? clamp01((t - 1300) / 900)
          : 1;
        tiltRef.current.style.opacity = worldOpacity.toFixed(3);
      }

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
      <div className="intro-grid-caption">
        {visibleCaptions.map((c, i) => (
          <p
            key={`${sceneIdx}-${i}`}
            className="intro-grid-caption-line"
          >
            {renderCaption(c.text)}
          </p>
        ))}
      </div>

      <div
        ref={tiltRef}
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

      {/* Self-paced navigation. Always rendered (so the user can
          rewind at any point) but prev is disabled on scene 0. */}
      <button
        className="intro-grid-nav intro-grid-nav-prev"
        onClick={() => goToScene(sceneIdx - 1)}
        disabled={sceneIdx === 0}
        aria-label="Previous (←)"
        title="Previous (←)"
      >
        ‹
      </button>
      <button
        className="intro-grid-nav intro-grid-nav-next"
        onClick={() => goToScene(sceneIdx + 1)}
        aria-label="Next (→)"
        title="Next (→)"
      >
        ›
      </button>

      <div className="intro-grid-progress">
        {SCENES.map((_, i) => (
          <span
            key={i}
            className={`intro-grid-progress-dot${i === sceneIdx ? ' active' : ''}${i < sceneIdx ? ' past' : ''}`}
          />
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
