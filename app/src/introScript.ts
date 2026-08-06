// Intro choreography data.
//
// The intro is split in two acts:
//   1. Cinematic: a 45s autoplay sequence that puppets the real app
//      (temp + people axes, the actual heatmap shader, the actual
//      formula bar) to demonstrate the data → preference → combine
//      mental model without ever using a word like "function" or
//      "curve". Skippable from t=3s onward.
//   2. Interactive: pick 2-of-6 axes that matter to you, then one
//      preset per chosen axis. No sliders, no math -- each preset
//      maps to a pre-built curve under the hood so the user
//      personalises their first map in ≤4 clicks total.
//
// On reveal we set the formula to `<axisA> * <axisB>` and install the
// preset curves, then fade out and pulse the formula bar so the user
// sees they just composed a real formula.

import type { CurvePoint } from './CurveEditor';

// ── Cinematic ──────────────────────────────────────────────────────

// One slice of the autoplay timeline. The runner steps through the
// list, applying `apply()` at start, showing `caption`, and waiting
// `holdMs` before advancing. `apply` receives an IntroAPI handle so
// each scene can mutate axis / formula / curve / camera using the
// real underlying state -- no duplicate rendering pipeline, the demo
// IS the product.
export interface CinematicScene {
  caption: string;
  holdMs: number;
  apply?: (api: CinematicAPI) => void | Promise<void>;
}

// Imperative handle the cinematic uses to drive the actual app
// (defined here so introScript stays UI-framework-agnostic; App.tsx
// supplies a concrete implementation backed by setHeatmapActiveAxis /
// updateLookupTexture / etc).
export interface CinematicAPI {
  setAxis(axisId: string): void;
  setCurve(axisId: string, points: CurvePoint[]): void;
  setFormula(text: string): void;
  typeFormula(text: string, charDelayMs: number): Promise<void>;
  flyTo(center: [number, number], zoom: number, durationMs: number): void;
}

const DEFAULT_TEMP_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const HEAT_HATER_CURVE: CurvePoint[] = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
const MILD_TENT_CURVE: CurvePoint[] = [
  { x: 0.0, y: 0.0 },
  { x: 0.45, y: 1.0 },
  { x: 0.55, y: 1.0 },
  { x: 1.0, y: 0.0 },
];
const DEFAULT_POP_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const QUIET_POP_CURVE: CurvePoint[] = [{ x: 0, y: 1 }, { x: 1, y: 0 }];

export const CINEMATIC: CinematicScene[] = [
  {
    caption: "This is where it's hot.",
    holdMs: 4500,
    apply: (api) => {
      api.setAxis('temp');
      api.setCurve('temp', DEFAULT_TEMP_CURVE);
      api.setFormula('');
      api.flyTo([20, 15], 1.5, 1800);
    },
  },
  {
    caption: 'But maybe you hate heat.',
    holdMs: 4500,
    apply: (api) => {
      api.setCurve('temp', HEAT_HATER_CURVE);
    },
  },
  {
    caption: 'Or freezing.',
    holdMs: 4500,
    apply: (api) => {
      api.setCurve('temp', MILD_TENT_CURVE);
    },
  },
  {
    caption: 'Now: where are the people?',
    holdMs: 4500,
    apply: (api) => {
      api.setAxis('pop');
      api.setCurve('pop', DEFAULT_POP_CURVE);
    },
  },
  {
    caption: 'Some want crowds. Some want quiet.',
    holdMs: 4500,
    apply: (api) => {
      api.setCurve('pop', QUIET_POP_CURVE);
    },
  },
  {
    caption: 'Combine them.',
    holdMs: 6000,
    apply: async (api) => {
      // Keep the tent on temp + inverse on pop, then assemble the
      // formula visibly. Typing matches the user's later "checkbox"
      // intuition for stacking features.
      api.setCurve('temp', MILD_TENT_CURVE);
      api.setCurve('pop', QUIET_POP_CURVE);
      await api.typeFormula('t * p', 200);
    },
  },
  {
    caption: 'Your turn.',
    holdMs: 1500,
  },
];

// Estimated total runtime, used by the UI to show a progress bar.
export const CINEMATIC_TOTAL_MS = CINEMATIC.reduce((sum, s) => sum + s.holdMs, 0);

// ── Interactive: 6 axis chips ──────────────────────────────────────

// Each chip wraps one underlying axis with a friendlier name + presets.
// The `presets` array is ordered for the chip layout; `compose()`
// picks the chosen preset's curve when the user finalises.
export interface AxisPreset {
  id: string;             // stable preset id (used in localStorage / collab if we add it later)
  label: string;          // displayed on the chip ("Tropical", "Big city", ...)
  hint?: string;          // tiny secondary line under the label ("~30°C+", "Tokyo, Lagos")
  curve: CurvePoint[];    // applied to the underlying axis on commit
}

export interface AxisChip {
  id: string;              // stable id ("climate", "people", ...)
  axisId: string;          // underlying app axis ("temp", "pop", ...)
  label: string;           // chip title shown in step 1
  blurb: string;           // one-liner shown on the chip
  presets: AxisPreset[];   // sub-question chips for step 2
  // Optional copy specific to this axis used on the reveal screen.
  // The reveal sentence is templated: <axisAReveal> × <axisBReveal>.
  revealNoun: string;      // "Climate", "People", "Cost of living", ...
}

// Tent curve helper: peak at `center`, falling to zero `halfWidth`
// away on either side. Clamped to [0, 1] so the LUT stays in range.
function tent(center: number, halfWidth: number): CurvePoint[] {
  const left = Math.max(0, center - halfWidth);
  const right = Math.min(1, center + halfWidth);
  const pts: CurvePoint[] = [];
  if (left > 0) pts.push({ x: 0, y: 0 });
  pts.push({ x: left, y: 0 });
  pts.push({ x: center, y: 1 });
  pts.push({ x: right, y: 0 });
  if (right < 1) pts.push({ x: 1, y: 0 });
  return pts;
}

// Monotonic up / down ramps -- the user wanting "as much of X as
// possible" gets a linear up-ramp; wanting "as little as possible"
// gets the inverse.
const RAMP_UP: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const RAMP_DOWN: CurvePoint[] = [{ x: 0, y: 1 }, { x: 1, y: 0 }];

export const AXIS_CHIPS: AxisChip[] = [
  {
    id: 'climate',
    axisId: 'temp',
    label: 'Climate',
    blurb: 'How hot or cold do you like it?',
    revealNoun: 'Climate',
    presets: [
      { id: 'tropical', label: 'Tropical', hint: '~30°C / 86°F', curve: tent(0.88, 0.10) },
      { id: 'warm',     label: 'Warm',     hint: '~24°C / 75°F', curve: tent(0.72, 0.10) },
      { id: 'mild',     label: 'Mild',     hint: '~18°C / 65°F', curve: tent(0.58, 0.10) },
      { id: 'cool',     label: 'Cool',     hint: '~12°C / 54°F', curve: tent(0.42, 0.10) },
      { id: 'cold',     label: 'Cold',     hint: '~0°C / 32°F',  curve: tent(0.20, 0.12) },
    ],
  },
  {
    id: 'people',
    axisId: 'pop',
    label: 'People',
    blurb: 'How crowded should it feel?',
    revealNoun: 'People',
    presets: [
      { id: 'bigcity',    label: 'Big city',   hint: 'Tokyo, Lagos',           curve: RAMP_UP },
      { id: 'suburbs',    label: 'Suburbs',    hint: 'Midsize town vibe',      curve: tent(0.5, 0.20) },
      { id: 'rural',      label: 'Rural',      hint: 'Small towns, farms',     curve: tent(0.25, 0.20) },
      { id: 'wilderness', label: 'Wilderness', hint: 'Off the beaten path',    curve: RAMP_DOWN },
    ],
  },
  {
    id: 'money',
    axisId: 'gdp',
    label: 'Money',
    blurb: 'What kind of economy do you want?',
    revealNoun: 'Cost of living',
    presets: [
      { id: 'affordable', label: 'Affordable', hint: 'Lower cost of living', curve: RAMP_DOWN },
      { id: 'midrange',   label: 'Mid-range',  hint: 'Comfortable middle',   curve: tent(0.55, 0.20) },
      { id: 'thriving',   label: 'Thriving',   hint: 'High-income regions',  curve: RAMP_UP },
    ],
  },
  {
    id: 'nature',
    axisId: 'vista',
    label: 'Nature',
    blurb: 'How much do views and scenery matter?',
    revealNoun: 'Scenery',
    presets: [
      { id: 'stunning', label: 'Stunning views', hint: 'Mountains, coastlines', curve: RAMP_UP },
      { id: 'some',     label: 'Some greenery',  hint: 'A few open vistas',     curve: tent(0.55, 0.20) },
      { id: 'whatever', label: "Doesn't matter", hint: 'Pick on other factors', curve: tent(0.5, 0.5) },
    ],
  },
  {
    id: 'health',
    axisId: 'hcare',
    label: 'Healthcare',
    blurb: 'How critical is good healthcare nearby?',
    revealNoun: 'Healthcare',
    presets: [
      { id: 'critical', label: 'Critical for me', hint: 'Top-tier hospitals',     curve: RAMP_UP },
      { id: 'nice',     label: 'Nice to have',    hint: 'Reasonable access',      curve: tent(0.6, 0.25) },
    ],
  },
  {
    id: 'internet',
    axisId: 'inet',
    label: 'Internet',
    blurb: 'How important is fast internet?',
    revealNoun: 'Internet speed',
    presets: [
      { id: 'fiber',     label: 'Need fiber',    hint: 'Remote work, streaming', curve: RAMP_UP },
      { id: 'signal',    label: 'Just a signal', hint: 'Email + maps is enough', curve: tent(0.55, 0.30) },
      { id: 'offgrid',   label: 'Off-grid OK',   hint: 'I want to disconnect',   curve: RAMP_DOWN },
    ],
  },
];

// ── Reveal composer ────────────────────────────────────────────────

// Build the formula text the user will see in the formula bar after
// committing. We use single-letter hotkeys (HOTKEYS in App.tsx) when
// the underlying axis has one so the formula bar reads "t * p"
// (matching the cinematic), otherwise the canonical axis id.
const HOTKEY_FOR_AXIS: Record<string, string> = {
  temp: 't', pop: 'p', gdp: 'g', vista: 'o', hcare: 'h', inet: 'i',
};

export function composeFormula(chosenAxisIds: string[]): string {
  return chosenAxisIds
    .map((id) => HOTKEY_FOR_AXIS[id] ?? id)
    .join(' * ');
}

// Reveal sentence templated from chosen reveal nouns.
//
// Example for [climate, people] → "Climate × People — a map of where
// the temperature you love meets the density you want."
export function composeRevealSentence(chips: AxisChip[]): string {
  if (chips.length === 0) return 'Your map is ready.';
  if (chips.length === 1) return `${chips[0].revealNoun} — your map of ${chips[0].revealNoun.toLowerCase()}.`;
  return `${chips[0].revealNoun} × ${chips[1].revealNoun} — your map of where these meet.`;
}

// ── LocalStorage flag ──────────────────────────────────────────────

export const INTRO_SEEN_KEY = 'utopiamap.intro.seen.v1';

export function hasSeenIntro(): boolean {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; }
  catch { return false; }
}

export function markIntroSeen(): void {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); }
  catch { /* private window etc -- intro will re-show, that's fine */ }
}

export function resetIntroSeen(): void {
  try { localStorage.removeItem(INTRO_SEEN_KEY); }
  catch { /* ignore */ }
}
