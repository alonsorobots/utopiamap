import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';

const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

import {
  createHeatmapLayer,
  updateLookupTexture,
  setActiveAxis as setHeatmapActiveAxis,
  setFormula as setHeatmapFormula,
  setTimeYear,
  getTimeYear,
  readValueAtLngLat,
  exportPaintedMask,
  importPaintedMask,
} from './heatmapLayer';
import { isAxisTemporal, getTemporalRange, getProjections, getAllAxisYears, loadCatalog, getCatalog, getTilesBase } from './tileDataLoader';
import { tokenize as tokenizeFormula, resolveAxisAlias } from './formulaParser';
import type { FormulaError, PaintedMask } from './heatmapLayer';
import { CurveEditor, evaluateCurvePoints } from './CurveEditor';
import type { AxisConfig, CurvePoint } from './CurveEditor';
import { DraggablePanel } from './DraggablePanel';
import { DrawMode } from './DrawMode';
import { TimePanel } from './TimePanel';
import type { TimePanelHandle } from './TimePanel';
import { TopBar } from './TopBar';
import type { AxisOption } from './TopBar';
import { decodeStateFromHash, encodeStateToBase64, encodeStateToHash, isShareHash } from './shareLink';
import type { ShareableState } from './shareLink';
import { useCollab } from './useCollab';
import { CollabBar } from './CollabUI';
import { DebugPanel } from './DebugPanel';
import { Intro } from './Intro';
import type { CinematicAPI } from './introScript';
import { hasSeenIntro, markIntroSeen, resetIntroSeen } from './introScript';
import { isDebugEnabled } from './telemetry';
import './App.css';

// Captured at module load so a single render decides whether the
// panel ever mounts -- toggling debug mode requires a reload, which
// keeps the production hot path free of any debug-related branches
// that aren't constant-folded out by the bundler.
const DEBUG_MODE = isDebugEnabled();

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const REPO_URL = 'https://github.com/alonsorobots/utopiamap';
const SAVE_KEY = 'utopia-prefs-v1';

interface SavedState {
  curves: Record<string, CurvePoint[]>;
  units: Record<string, string>;
  formula: string;
  activeAxis: string;
  mapCenter: [number, number];
  mapZoom: number;
  year: number;
}

function loadSavedState(): Partial<SavedState> | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<SavedState>;
  } catch {
    return null;
  }
}

function writeSave(state: SavedState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {}
}

// Kicked off at module load time so the gzip+base64 decode runs in parallel
// with React's first render. Resolves to null when there is no #view= hash
// or when decoding fails for any reason.
const HASH_HYDRATION: Promise<ShareableState | null> = (() => {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const h = window.location.hash || '';
  if (!isShareHash(h)) return Promise.resolve(null);
  return decodeStateFromHash(h).catch(() => null);
})();
const HAS_SHARE_HASH = typeof window !== 'undefined' && isShareHash(window.location.hash || '');

// Master switch for the first-visit intro / tutorial. Disabled while
// we iterate on the rest of the app locally so it never auto-launches
// and the replay pill stays hidden. Flip back to `true` to restore the
// full intro experience (all the code below stays intact).
const INTRO_ENABLED = false;

const LINEAR_UP: CurvePoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
];

const COUNTRY_AXES = new Set(['gdp', 'free', 'inet', 'energy', 'depv', 'e_consume']);

// Disaster mortality lookup (deaths per million per year, per hazard, on a
// 0.5° grid). Loaded once for hover breakdown on `risk` and the 8 individual
// hazard axes (eq, flood, cyclone, tsunami, volcano, drought, wildfire,
// landslide).
type RiskLookup = {
  v?: number;
  res: number;          // degrees per cell
  w: number;            // grid width
  h: number;            // grid height
  hazards: { id: string; values: number[]; intensity?: number[] }[];
  // values    = mortality × 10 (deaths/M/yr × 10)
  // intensity = native physical units (PGA in g, depth in m, wind m/s, ...)
  composite: number[];  // composite, deaths/M/yr × 10
};
let riskLookupCache: RiskLookup | null = null;
let riskLookupLoading = false;
function loadRiskLookup(): RiskLookup | null {
  if (riskLookupCache) return riskLookupCache;
  if (riskLookupLoading) return null;
  riskLookupLoading = true;
  fetch('/risk_lookup.json')
    .then(r => r.ok ? r.json() : null)
    .then((data: RiskLookup | null) => { if (data) riskLookupCache = data; })
    .catch(() => {})
    .finally(() => { riskLookupLoading = false; });
  return null;
}
const HAZARD_LABELS: Record<string, string> = {
  earthquake: 'Earthquake',
  flood:      'Flood',
  cyclone:    'Cyclone',
  tsunami:    'Tsunami',
  volcano:    'Volcano',
  drought:    'Drought',
  wildfire:   'Wildfire',
  landslide:  'Landslide',
};

// SHDI subnational HDI lookup -- per-region Health / Education / Income
// breakdowns for the Deprivation hover. The grid array stores a small int
// id per cell (0 = ocean / no data); the regions table maps id -> indicators
// for that admin region (latest year, typically 2022).
type DepvRegion = {
  country: string;
  region: string;
  year: number;
  shdi: number;
  health: number | null;
  education: number | null;
  income: number | null;
  lifexp: number | null;
  esch_yrs: number | null;
  gnic: number | null;
};
type DepvLookup = {
  v?: number;
  regions: Record<string, DepvRegion>;
  grid: { res: number; w: number; h: number; ids: number[] };
};
let depvLookupCache: DepvLookup | null = null;
let depvLookupLoading = false;
function loadDepvLookup(): DepvLookup | null {
  if (depvLookupCache) return depvLookupCache;
  if (depvLookupLoading) return null;
  depvLookupLoading = true;
  fetch('/depv_lookup.json')
    .then(r => r.ok ? r.json() : null)
    .then((data: DepvLookup | null) => { if (data) depvLookupCache = data; })
    .catch(() => {})
    .finally(() => { depvLookupLoading = false; });
  return null;
}
function depvRegionAt(lat: number, lng: number): DepvRegion | null {
  const lk = depvLookupCache;
  if (!lk) return null;
  let lon = lng;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const g = lk.grid;
  const ix = Math.max(0, Math.min(g.w - 1, Math.floor((lon + 180) / g.res)));
  const iy = Math.max(0, Math.min(g.h - 1, Math.floor((90 - lat) / g.res)));
  const id = g.ids[iy * g.w + ix];
  if (!id) return null;
  return lk.regions[String(id)] ?? null;
}
function fmtOddsPerYear(v: number): string {
  if (v <= 0) return '~0';
  const oneIn = Math.round(1e6 / v);
  if (oneIn >= 1_000_000) return `1 in ${(oneIn / 1_000_000).toFixed(1)} million per year`;
  if (oneIn >= 1000) return `1 in ${Math.round(oneIn / 1000)} thousand per year`;
  return `1 in ${oneIn.toLocaleString()} per year`;
}
function riskCellAt(lat: number, lng: number): {
  composite: number;                    // deaths/M/yr at this cell (composite)
  hazards: { id: string; rate: number; intensity?: number }[];
} | null {
  const lk = riskLookupCache;
  if (!lk) return null;
  let lon = lng;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const ix = Math.max(0, Math.min(lk.w - 1, Math.floor((lon + 180) / lk.res)));
  const iy = Math.max(0, Math.min(lk.h - 1, Math.floor((90 - lat) / lk.res)));
  const idx = iy * lk.w + ix;
  const composite = (lk.composite[idx] || 0) / 10;
  const hazards = lk.hazards.map(h => ({
    id: h.id,
    rate: (h.values[idx] || 0) / 10,
    intensity: h.intensity ? h.intensity[idx] : undefined,
  }));
  return { composite, hazards };
}
function intensityAt(hazardKey: string, lat: number, lng: number): number | null {
  const cell = riskCellAt(lat, lng);
  if (!cell) return null;
  const found = cell.hazards.find(h => h.id === hazardKey);
  return found && typeof found.intensity === 'number' ? found.intensity : null;
}
function mortalityAt(hazardKey: string, lat: number, lng: number): number | null {
  const cell = riskCellAt(lat, lng);
  if (!cell) return null;
  const found = cell.hazards.find(h => h.id === hazardKey);
  return found ? found.rate : null;
}
function fmtMortality(v: number): string {
  if (v <= 0) return '<0.05';
  if (v < 0.1) return '<0.1';
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toString();
}

type EnergyData = { score: number, fuels?: Record<string, number> };
let energyScores: Record<string, EnergyData> | null = null;
let energyScoresLoading = false;
function loadEnergyScores(): Record<string, EnergyData> | null {
  if (energyScores) return energyScores;
  if (energyScoresLoading) return null;
  energyScoresLoading = true;
  fetch(`${getTilesBase()}/energy/energy_scores.json`)
    .then(r => r.json())
    .then(data => { energyScores = data; })
    .catch(() => { energyScoresLoading = false; });
  return null;
}

// Per-cell crop lookup for Agriculture hover.
// `agri`  uses MapSPAM 2020 harvested-area; values = hectares (rounded int).
// `agrip` uses Zabel suitability;            values = suitability index 0-100.
type CropsLookup = {
  resolution_deg: number;
  origin: { lat: number; lng: number };
  ny: number;
  nx: number;
  top_n: number;
  units?: string;
  crops: string[];
  cells: Record<string, [number, number][]>; // "iy_ix" -> [[crop_index, value], ...]
};
const CROPS_LOOKUP_URLS: Record<string, string> = {
  agri:  '/crops_lookup.json',
  agrip: '/crops_lookup_agrip.json',
};
const cropsLookupCache: Record<string, CropsLookup | null> = {};
const cropsLookupLoading: Record<string, boolean> = {};
function loadCropsLookup(axis: string): CropsLookup | null {
  const url = CROPS_LOOKUP_URLS[axis];
  if (!url) return null;
  if (cropsLookupCache[axis]) return cropsLookupCache[axis];
  if (cropsLookupLoading[axis]) return null;
  cropsLookupLoading[axis] = true;
  fetch(url)
    .then(r => r.ok ? r.json() : null)
    .then((data: CropsLookup | null) => { if (data) cropsLookupCache[axis] = data; })
    .catch(() => {})
    .finally(() => { cropsLookupLoading[axis] = false; });
  return null;
}
export function topCropsAt(axis: string, lat: number, lng: number): { name: string; value: number }[] | null {
  const lk = cropsLookupCache[axis];
  if (!lk) return null;
  const iy = Math.floor((lk.origin.lat - lat) / lk.resolution_deg);
  const ix = Math.floor((lng - lk.origin.lng) / lk.resolution_deg);
  if (iy < 0 || iy >= lk.ny || ix < 0 || ix >= lk.nx) return null;
  const entry = lk.cells[`${iy}_${ix}`];
  if (!entry) return null;
  return entry.map(([idx, value]) => ({ name: lk.crops[idx], value }));
}

// Shared formatter for power-plant capacity layers (e_oil, e_coal, ...).
// Decodes the log-scaled normalized value back to MW.
function plantCapacityValue(norm: number, dataMax: number): number {
  const maxLog = Math.log1p(dataMax);
  return Math.expm1(norm * maxLog);
}
function plantCapacityShort(norm: number, dataMax: number): string {
  return `${Math.round(plantCapacityValue(norm, dataMax)).toLocaleString()} MW`;
}
function plantCapacityHover(norm: number, dataMax: number): string {
  const mw = plantCapacityValue(norm, dataMax);
  let band: string;
  if (mw < 1) band = 'None';
  else if (mw < 50) band = 'Minor';
  else if (mw < 500) band = 'Moderate';
  else if (mw < 2000) band = 'Major';
  else band = 'Heavy';
  return `${Math.round(mw).toLocaleString()} MW (${band})`;
}

const AXES: Record<string, AxisConfig> = {
  temp: {
    label: 'Temperature',
    dataMin: -30,
    dataMax: 45,
    unit: 'F',
    formatValue: (norm, unit) => {
      const c = -30 + norm * 75;
      if (unit === 'F') return `${Math.round(c * 9 / 5 + 32)}F`;
      return `${Math.round(c)}C`;
    },
    formatHover: (norm, unit) => {
      const c = -30 + norm * 75;
      const v = unit === 'F' ? `${Math.round(c * 9 / 5 + 32)}F` : `${Math.round(c)}C`;
      let band: string;
      if (c < -5) band = 'Frigid';
      else if (c < 5) band = 'Cold';
      else if (c < 15) band = 'Cool';
      else if (c < 22) band = 'Mild';
      else if (c < 28) band = 'Warm';
      else band = 'Hot';
      return `${v} (${band})`;
    },
    unitOptions: ['C', 'F'],
    description: 'How warm or cold a place typically feels across the year.\nBright = warm. Dark = cold.',
    whoIsThisFor: 'Anyone choosing a climate -- escaping harsh winters, avoiding extreme heat, or finding year-round comfort.',
    unitDescription: 'Degrees = how hot or cold the air feels on a typical day. San Francisco ~14C, Bangkok ~28C, Moscow ~6C.',
    source: 'TerraClimate (University of Idaho)',
    sourceUrl: 'https://www.climatologylab.org/terraclimate.html',
    hoverLabel: 'Avg temp',
    defaultCurve: [
      { x: 0.467, y: 1 },
      { x: 0.6,   y: 0 },
      { x: 0.733, y: 0 },
      { x: 0.867, y: 1 },
    ],
    infoWidth: 304,
    infoHeight: 167
  },
  tvar: {
    label: 'Temp Volatility',
    dataMin: 0,
    dataMax: 15,
    unit: 'F',
    formatValue: (norm, unit) => {
      const c = norm * 15;
      if (unit === 'F') return `${(c * 9 / 5).toFixed(1)}F std`;
      return `${c.toFixed(1)}C std`;
    },
    formatHover: (norm, unit) => {
      const c = norm * 15;
      const v = unit === 'F' ? `${(c * 9 / 5).toFixed(1)}F std` : `${c.toFixed(1)}C std`;
      let band: string;
      if (c < 3) band = 'Steady';
      else if (c < 6) band = 'Mild seasons';
      else if (c < 10) band = 'Distinct seasons';
      else band = 'Extreme swings';
      return `${v} (${band})`;
    },
    unitOptions: ['C', 'F'],
    description: 'How much the temperature swings between seasons.\nBright = steady year-round. Dark = big swings between summer and winter.',
    whoIsThisFor: 'People who want consistent weather (low swing) or who love distinct four seasons (high swing).',
    unitDescription: 'Standard deviation = how far the monthly average wanders from the yearly average. Hawaii ~2C (barely changes), Chicago ~12C (brutal winters, hot summers).',
    source: 'TerraClimate (University of Idaho)',
    sourceUrl: 'https://www.climatologylab.org/terraclimate.html',
    hoverLabel: 'Temp std dev',
    defaultCurve: [
      { x: 0.4, y: 0 },
      { x: 0.8, y: 1 },
    ],
    infoWidth: 304,
    infoHeight: 199
  },
  water: {
    label: 'Water',
    dataMin: 0,
    dataMax: 3000,
    unit: 'mm',
    formatValue: (norm) => `${Math.round(norm * 3000)} mm/yr`,
    formatHover: (norm) => {
      const mm = Math.round(norm * 3000);
      let band: string;
      if (mm < 250) band = 'Arid';
      else if (mm < 600) band = 'Semi-arid';
      else if (mm < 1200) band = 'Temperate';
      else if (mm < 2000) band = 'Wet';
      else band = 'Tropical';
      return `${mm} mm/yr (${band})`;
    },
    description: 'How much rain falls in a year.\nBright = wet and green. Dark = dry and arid.',
    whoIsThisFor: 'Farmers, homesteaders, or anyone who cares about water security and lush green surroundings vs dry desert.',
    unitDescription: 'Millimeters of rain per year = if you collected all the rain in a bucket, how deep it would be. Sahara ~25 mm, London ~600 mm, Amazon ~2500 mm.',
    source: 'TerraClimate precipitation data',
    sourceUrl: 'https://www.climatologylab.org/terraclimate.html',
    hoverLabel: 'Precip.',
    // Inverted-U / plateau rather than a plain ramp: deserts score
    // low, the temperate-to-green band (~900-1400 mm) is the peak,
    // and extreme tropical monsoon (2000+ mm) tapers back down --
    // because past a point more rain means humidity, mold, and
    // flooding, not "better". A plain ramp wrongly rated Seattle,
    // the Amazon, and the Mumbai monsoon as equally ideal.
    //
    // NOTE on polarity: the curve LUT stores (1 - y), and the shader
    // uses it directly as brightness/alpha, so y=0 is the TOP of the
    // graph = preferred/bright and y=1 is the bottom = hidden. Hence
    // the sweet spot is y:0 and the disliked extremes are y near 1.
    defaultCurve: [
      { x: 0,           y: 0.95 }, // true desert -- hidden
      { x: 300 / 3000,  y: 0.65 }, // arid edge
      { x: 600 / 3000,  y: 0.1  }, // semi-arid / Mediterranean -- already great
      { x: 900 / 3000,  y: 0.0  }, // temperate sweet spot -- most preferred
      { x: 1400 / 3000, y: 0.0  }, // still ideal, green
      { x: 2200 / 3000, y: 0.45 }, // wet, getting soggy
      { x: 1,           y: 0.65 }, // tropical monsoon -- less preferred
    ],
    infoWidth: 304,
    infoHeight: 185
  },
  solar: {
    label: 'Solar',
    dataMin: 0,
    dataMax: 2555,
    unit: 'kWh/m2',
    formatValue: (norm) => `${Math.round(norm * 2555)} kWh`,
    formatHover: (norm) => {
      const k = Math.round(norm * 2555);
      let band: string;
      if (k < 1000) band = 'Cloudy';
      else if (k < 1500) band = 'Mixed';
      else if (k < 2000) band = 'Sunny';
      else band = 'Brilliant';
      return `${k} kWh/m2/yr (${band})`;
    },
    description: 'How much sunlight hits the ground in a year.\nBright = sunny. Dark = cloudy.',
    whoIsThisFor: 'People wanting solar panels, sunny weather, or to avoid seasonal depression from dark winters.',
    unitDescription: 'kWh/m2/yr = the energy a 1-meter-square solar panel could capture in a year. UK ~900, Spain ~1800, Sahara ~2400.',
    source: 'Global Solar Atlas (World Bank / Solargis)',
    sourceUrl: 'https://globalsolaratlas.info/',
    hoverLabel: 'Solar irrad.',
    defaultCurve: LINEAR_UP,
    staticYear: 2020,
    infoWidth: 306,
    infoHeight: 185
  },
  wind: {
    label: 'Wind',
    dataMin: 0,
    dataMax: 20,
    unit: 'm/s',
    formatValue: (norm) => `${(norm * 20).toFixed(1)} m/s`,
    formatHover: (norm) => {
      const v = norm * 20;
      let band: string;
      if (v < 2) band = 'Calm';
      else if (v < 5) band = 'Light breeze';
      else if (v < 8) band = 'Breezy';
      else if (v < 12) band = 'Windy';
      else band = 'Gale-prone';
      return `${v.toFixed(1)} m/s (${band})`;
    },
    description: 'How windy a place is on average.\nBright = windy. Dark = calm.',
    whoIsThisFor: 'Wind energy prospectors, people wanting to avoid constantly blustery areas, or kite surfers.',
    unitDescription: 'Meters per second = how fast the air moves. Walking pace ~1.5, gentle breeze ~5, strong wind ~10, dangerous gale ~20+.',
    source: 'Global Wind Atlas / ERA5',
    sourceUrl: 'https://globalwindatlas.info/',
    hoverLabel: 'Wind speed',
    defaultCurve: [
      { x: 5.5 / 20, y: 1 },
      { x: 10  / 20, y: 0 },
    ],
    staticYear: 2020,
    infoWidth: 305,
    infoHeight: 166
  },
  energy: {
    label: 'Energy Balance',
    dataMin: 0,
    dataMax: 100,
    unit: 'score',
    formatValue: (norm) => {
      const net = Math.round(norm * 100) - 50;
      if (net > 0) return `+${net}`;
      return `${net}`;
    },
    formatHover: (norm) => {
      const net = Math.round(norm * 100) - 50;
      if (net > 20) return `+${net} (Major exporter)`;
      if (net > 5) return `+${net} (Net exporter)`;
      if (net < -20) return `${net} (Major importer)`;
      if (net < -5) return `${net} (Net importer)`;
      return `${net >= 0 ? '+' : ''}${net} (Balanced)`;
    },
    description: 'Does a country produce more energy than it uses, or less?\nBright = net exporter. Dark = net importer.',
    whoIsThisFor: 'People concerned about grid reliability, energy independence, or living in a self-sufficient country.',
    unitDescription: 'Score out of 100. 50 = balanced. Above 50 = the country exports surplus energy. Below 50 = it depends on imports. Norway ~85 (oil exporter), Japan ~25 (heavy importer).',
    source: 'WRI Global Power Plant Database / World Bank',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Energy bal.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
    infoWidth: 308,
    infoHeight: 220
  },
  e_consume: {
    label: 'Energy Consumption',
    dataMin: 0,
    dataMax: 15000,
    unit: 'kWh',
    formatValue: (norm) => `${Math.round(norm * 15000).toLocaleString()} kWh/cap`,
    formatHover: (norm) => {
      const k = Math.round(norm * 15000);
      let band: string;
      if (k < 500) band = 'Off-grid level';
      else if (k < 2000) band = 'Low use';
      else if (k < 6000) band = 'Modern';
      else if (k < 10000) band = 'Industrialized';
      else band = 'Energy-intensive';
      return `${k.toLocaleString()} kWh/cap (${band})`;
    },
    description: 'How much electricity the average person uses per year.\nBright = high consumption (industrialized). Dark = low.',
    whoIsThisFor: 'Anyone gauging how modernized or energy-intensive daily life is in a given country.',
    unitDescription: 'kWh per person per year = roughly how many hours you could run a space heater. USA ~12,000, UK ~5,000, Nigeria ~150.',
    source: 'World Bank',
    sourceUrl: 'https://data.worldbank.org/indicator/EG.USE.ELEC.KH.PC',
    hoverLabel: 'Consumption',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_oil: {
    label: 'Oil',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where oil-burning power plants are located.\nBright = concentrated oil generation. Dark = none.',
    whoIsThisFor: 'People tracking fossil fuel dependence or avoiding areas reliant on oil for electricity.',
    unitDescription: 'Megawatts = how much power a plant can produce. 1 MW powers roughly 750 homes. A large oil plant is 500-2000 MW.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Oil cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_coal: {
    label: 'Coal',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where coal power plants are located.\nBright = heavy coal dependence. Dark = none.',
    whoIsThisFor: 'People concerned about the dirtiest fossil fuel and its impact on local air quality and climate.',
    unitDescription: 'Megawatts = how much power a plant can produce. 1 MW powers roughly 750 homes. China and India dominate global coal capacity.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Coal cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_gas: {
    label: 'Natural Gas',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where natural gas power plants are located.\nBright = gas-heavy grid. Dark = none.',
    whoIsThisFor: 'People tracking the transition from coal to gas, or concerned about methane emissions.',
    unitDescription: 'Megawatts = how much power a plant can produce. 1 MW powers roughly 750 homes. Gas is often called a "bridge fuel" between coal and renewables.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Gas cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_nuke: {
    label: 'Nuclear',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where nuclear reactors are located.\nBright = nearby nuclear plants. Dark = none.',
    whoIsThisFor: 'People wanting zero-carbon baseload energy nearby, or those wanting to keep distance from reactors.',
    unitDescription: 'Megawatts = how much power a plant can produce. A single reactor is typically 500-1400 MW. France gets ~70% of its electricity from nuclear.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Nuclear cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_hydro: {
    label: 'Hydro',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where hydroelectric dams and river plants are located.\nBright = hydro-rich. Dark = none.',
    whoIsThisFor: 'People seeking regions powered by clean, renewable water energy or interested in dam infrastructure.',
    unitDescription: 'Megawatts = how much power a plant can produce. Three Gorges Dam (China) is the world\'s largest at 22,500 MW. Norway gets 90%+ from hydro.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Hydro cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_wind: {
    label: 'Wind Energy',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where wind farms are deployed for electricity.\nBright = lots of turbines. Dark = none.',
    whoIsThisFor: 'People wanting to live near clean energy infrastructure or tracking wind energy expansion.',
    unitDescription: 'Megawatts = how much power a farm can produce. A single modern turbine is 2-5 MW. Texas and the North Sea are global leaders.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Wind cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_solar: {
    label: 'Solar Energy',
    dataMin: 0,
    dataMax: 10000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 10000),
    formatHover: (norm) => plantCapacityHover(norm, 10000),
    description: 'Where large solar farms are installed.\nBright = major solar capacity. Dark = none.',
    whoIsThisFor: 'People tracking grid-scale solar adoption or wanting to live in solar-powered regions.',
    unitDescription: 'Megawatts = how much power a farm can produce. A rooftop is ~5-10 kW; a utility farm can be 500+ MW. China and USA lead globally.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Solar cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  e_geo: {
    label: 'Geothermal',
    dataMin: 0,
    dataMax: 5000,
    unit: 'MW',
    formatValue: (norm) => plantCapacityShort(norm, 5000),
    formatHover: (norm) => plantCapacityHover(norm, 5000),
    description: 'Where geothermal plants tap underground heat for electricity.\nBright = geothermal capacity. Dark = none.',
    whoIsThisFor: 'People interested in volcanic-region energy or seeking places with uniquely stable, 24/7 renewable power.',
    unitDescription: 'Megawatts = how much power a plant can produce. Found near tectonic boundaries -- Iceland, Philippines, Kenya, and New Zealand lead.',
    source: 'WRI Global Power Plant Database',
    sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    hoverLabel: 'Geo. cap.',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
  },
  agri: {
    label: 'Agriculture',
    dataMin: 0,
    dataMax: 100,
    unit: 'AI',
    formatValue: (norm) => `${Math.round(norm * 100)} AI`,
    formatHover: (norm) => {
      const ai = Math.round(norm * 100);
      let band: string;
      if (ai < 5) band = 'Barren';
      else if (ai < 25) band = 'Sparse';
      else if (ai < 60) band = 'Mixed use';
      else if (ai < 85) band = 'Active farmland';
      else band = 'Breadbasket';
      return `${ai} Activity Index (${band})`;
    },
    description: 'Where crops are actually grown today, blending climate, soil, terrain, and human factors.\nBright = active farmland. Dark = little or no crop production.',
    whoIsThisFor: 'Homesteaders, farmers, or anyone who values local food security and access to fresh produce.',
    unitDescription: 'Activity index from 0-100, log-scaled from harvested-area density (hectares per ~9 km cell). Iowa corn belt ~95, Swiss Alps ~10, Sahara 0. Hover to see the top crops grown locally.',
    source: 'IFPRI MapSPAM 2020 v2 (46 crops, harvested area)',
    sourceUrl: 'https://doi.org/10.7910/DVN/SWPENT',
    hoverLabel: 'Cropland',
    staticYear: 2020,
    defaultCurve: LINEAR_UP,
    infoWidth: 322,
    infoHeight: 200
  },
  agrip: {
    label: 'Agriculture Potential',
    dataMin: 0,
    dataMax: 100,
    unit: 'SI',
    formatValue: (norm) => `${Math.round(norm * 100)} SI`,
    formatHover: (norm) => {
      const si = Math.round(norm * 100);
      let band: string;
      if (si < 10) band = 'Unsuitable';
      else if (si < 35) band = 'Marginal';
      else if (si < 60) band = 'Moderate';
      else if (si < 80) band = 'Highly suitable';
      else band = 'Prime';
      return `${si} SI (${band})`;
    },
    description: 'Where crops could grow based on climate, soil, and terrain -- today and projected to 2100.\nBright = high biophysical potential. Dark = unsuitable for farming.',
    whoIsThisFor: 'Long-term planners, climate-aware homesteaders, and anyone curious how warming will reshape the world\'s breadbaskets.',
    unitDescription: 'Suitability index from 0-100 across 23 major crops, picking the best fit per place. US Midwest ~85, Sahel ~20, polar deserts 0. Scrub past today to see high-emissions (SSP5-8.5) climate projections; hover to see the top crops.',
    source: 'Zabel et al. 2014 -- Global Agricultural Suitability v3 (LMU Munich)',
    sourceUrl: 'https://doi.org/10.5281/zenodo.5982577',
    hoverLabel: 'Crop suitability',
    defaultCurve: LINEAR_UP,
    infoWidth: 332,
    infoHeight: 215
  },
  pop: {
    label: 'Population',
    dataMin: 0,
    dataMax: 10000,
    unit: '/km2',
    formatValue: (norm) => {
      const maxLog = Math.log1p(10000);
      const val = Math.expm1(norm * maxLog);
      return `${Math.round(val).toLocaleString()}/km2`;
    },
    formatHover: (norm) => {
      const maxLog = Math.log1p(10000);
      const val = Math.expm1(norm * maxLog);
      let band: string;
      if (val < 5) band = 'Wilderness';
      else if (val < 100) band = 'Rural';
      else if (val < 1500) band = 'Suburban';
      else if (val < 5000) band = 'Urban';
      else band = 'Dense city';
      return `${Math.round(val).toLocaleString()}/km2 (${band})`;
    },
    description: 'How many people live in each square kilometer.\nBright = dense cities. Dark = empty wilderness.',
    whoIsThisFor: 'People who feel safest surrounded by millions, and people who feel safest surrounded by no one.',
    unitDescription: 'People per km2 = imagine a square 1 km on each side. Rural farmland ~10, typical suburb ~1,000, Manhattan ~28,000.',
    source: 'SEDAC GPWv4 (NASA / Columbia University)',
    sourceUrl: 'https://sedac.ciesin.columbia.edu/data/collection/gpw-v4',
    hoverLabel: 'Pop. density',
    defaultCurve: LINEAR_UP,
    infoWidth: 305,
    infoHeight: 168
  },
  gdp: {
    label: 'GDP per capita',
    dataMin: 0,
    dataMax: 80000,
    unit: 'PPP$',
    formatValue: (norm) => {
      const maxLog = Math.log1p(80000);
      const val = Math.expm1(norm * maxLog);
      return `$${Math.round(val).toLocaleString()}`;
    },
    formatHover: (norm) => {
      const maxLog = Math.log1p(80000);
      const val = Math.expm1(norm * maxLog);
      let band: string;
      if (val < 1500) band = 'Low income';
      else if (val < 5000) band = 'Lower middle';
      else if (val < 15000) band = 'Upper middle';
      else if (val < 40000) band = 'High income';
      else band = 'Wealthy';
      return `$${Math.round(val).toLocaleString()} (${band})`;
    },
    description: 'How much economic output each person produces locally. Hover changes with zoom: country (World Bank), state/province (pop-weighted), or district (Kummu admin-2).\nBright = wealthy area. Dark = poor area.',
    whoIsThisFor: 'Anyone wanting to understand the true local economy -- not just the country average, but your actual region or neighborhood.',
    unitDescription: 'PPP dollars = what a dollar actually buys locally (adjusted for prices). Country tier: WB constant 2021 intl $; State and District tiers: Kummu et al. admin-2 (calibrated to WB country totals).',
    source: 'Kummu et al. gridded GDP (admin-2, 1990-2024) + World Bank NY.GDP.PCAP.PP.KD',
    sourceUrl: 'https://zenodo.org/records/10976733',
    hoverLabel: 'GDP/capita',
    defaultCurve: LINEAR_UP,
    infoWidth: 306,
    infoHeight: 200
  },
  air: {
    label: 'Air Quality',
    dataMin: 0,
    dataMax: 70,
    unit: 'AQI',
    formatValue: (norm) => `${Math.round((1 - norm) * 70)} ug/m3`,
    formatHover: (norm) => {
      const pm25 = Math.round((1 - norm) * 70);
      let band: string;
      if (pm25 < 5) band = 'Excellent';
      else if (pm25 < 15) band = 'Good';
      else if (pm25 < 35) band = 'Fair';
      else band = 'Poor';
      return `${pm25} ug/m3 (${band})`;
    },
    description: 'How clean the air is where you live.\nBright = clean air. Dark = heavy smog.',
    whoIsThisFor: 'Parents, asthmatics, or anyone wanting to avoid long-term health damage from breathing polluted air.',
    unitDescription: 'PM2.5 = tiny particles at least 30x smaller than a human hair that lodge deep in your lungs. WHO safe limit is 5. Most of Europe ~10, Delhi can hit 200+.',
    source: 'WashU Atmospheric Composition Group (V6)',
    sourceUrl: 'https://sites.wustl.edu/acag/datasets/surface-pm2-5/',
    hoverLabel: 'Air cleanliness',
    defaultCurve: [
      { x: 0.5,   y: 1 },
      { x: 0.714, y: 0 },
    ],
    infoWidth: 300,
    infoHeight: 183
  },
  elev: {
    label: 'Elevation',
    dataMin: 0,
    dataMax: 6000,
    unit: 'm',
    formatValue: (norm) => `${Math.round(norm * 6000)} m`,
    formatHover: (norm) => {
      const m = Math.round(norm * 6000);
      let band: string;
      if (m < 50) band = 'Coastal';
      else if (m < 500) band = 'Lowlands';
      else if (m < 1500) band = 'Hills';
      else if (m < 2500) band = 'Highlands';
      else if (m < 4000) band = 'Mountains';
      else band = 'Thin air';
      return `${m} m (${band})`;
    },
    description: 'Height above sea level.\nBright = high mountains. Dark = lowlands and coast.',
    whoIsThisFor: 'Mountaineers, altitude trainers, or people wanting to avoid altitude sickness and thin air.',
    unitDescription: 'Meters above sea level. Sea level = 0, Denver = 1,600, Mexico City = 2,200, Everest base camp = 5,400.',
    source: 'ETOPO 2022 (NOAA)',
    sourceUrl: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model',
    hoverLabel: 'Elevation',
    defaultCurve: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0 },
      { x: 0.5,  y: 1 },
    ],
    staticYear: 2022,
    infoWidth: 311,
    infoHeight: 150
  },
  risk: {
    label: 'Disasters',
    dataMin: 0,
    dataMax: 200,                    // deaths per million per year, capped for color
    unit: '/M/yr',
    formatValue: (norm) => `${fmtOddsPerYear(norm * 200)}`,
    formatHover: (norm, _u, lat, lng) => {
      void loadRiskLookup();
      const cell = (lat !== undefined && lng !== undefined) ? riskCellAt(lat, lng) : null;
      const total = cell ? cell.composite : norm * 200;
      const headline = total > 0
        ? `${fmtOddsPerYear(total)}  (${fmtMortality(total)} deaths per million per year)`
        : '~0 chance per year';
      if (!cell) return headline;
      const lines = cell.hazards
        .filter(h => h.rate >= 0.05)
        .sort((a, b) => b.rate - a.rate)
        .map(h => `  ${(HAZARD_LABELS[h.id] || h.id).padEnd(11)} ${fmtOddsPerYear(h.rate)}`);
      if (!lines.length) return headline;
      return [headline, ...lines].join('\n');
    },
    description: 'Chance of dying from a natural disaster here.\nBright = safe. Dark = dangerous. Hover for the per-hazard breakdown.',
    whoIsThisFor: 'Homebuyers and anyone weighing earthquake, flood, cyclone, tsunami, volcanic, drought, wildfire, and landslide exposure.',
    unitDescription: 'Annual probability of death, expressed as "1 in N per year". Also shown in deaths per million people per year for comparison. Reference: car crashes ~120, heart disease ~2,000, all causes ~8,000 deaths per million per year.',
    source: 'See sources panel',
    sources: [
      { name: 'EM-DAT (mortality, 1980-2020)', url: 'https://public.emdat.be/' },
      { name: 'Our World in Data (decadal disaster deaths + population)', url: 'https://ourworldindata.org/natural-disasters' },
      { name: 'GEM Global Seismic Hazard Map v2023.1 (PGA)', url: 'https://maps.openquake.org/map/global-seismic-hazard-map/' },
      { name: 'JRC GloFAS Global River Flood Hazard (RP100)', url: 'https://data.jrc.ec.europa.eu/dataset/jrc-floods-floodmapgl_rp50y-tif' },
      { name: 'Bloemendaal STORM tropical cyclone wind (RP100)', url: 'https://data.4tu.nl/articles/dataset/STORM_climate_change_synthetic_tropical_cyclone_tracks/12706085' },
      { name: 'Davies et al. 2017 Global PTHA (tsunami)', url: 'https://nhess.copernicus.org/articles/18/3105/2018/' },
      { name: 'Smithsonian Global Volcanism Program', url: 'https://volcano.si.edu/list_volcano_holocene.cfm' },
      { name: 'SPEI-12 global drought index', url: 'https://spei.csic.es/database.html' },
      { name: 'ETOPO 2022 Global Relief (slope, landslide proxy)', url: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model' },
    ],
    hoverLabel: 'Disaster',
    // Disasters is the one axis whose raw value is NOT inverted: high
    // value = more deaths = more dangerous (formatValue is norm*200
    // deaths, with no 1-norm flip). So unlike the "more is better"
    // axes it must use a DESCENDING curve -- safe places (low value)
    // are preferred/bright, deadly places (high value) are hidden.
    // The previous LINEAR_UP did the opposite, lighting up the most
    // dangerous regions, which contradicted the "Bright = safe"
    // description.
    defaultCurve: [
      { x: 0, y: 0 }, // ~0 deaths -- safe -- preferred/bright
      { x: 1, y: 1 }, // 200 deaths/M/yr -- dangerous -- hidden
    ],
    staticYear: 2023,
    infoWidth: 311,
    infoHeight: 184
  },
  ...((): Record<string, AxisConfig> => {
    // Each hazard renders the raw physical intensity from
    // _out/{hazard}_intensity.tif into pmtiles, with display cap = dataMax
    // and a known transform (must mirror build_tiles.py). The display value
    // is recovered by inverting the transform; for hover, when the lookup
    // is loaded, we use the exact stored intensity instead.
    type HazSpec = {
      id: string; hazardKey: string; label: string; hoverLabel: string;
      who: string; desc: string;
      sources: { name: string; url?: string }[];
      // pmtiles encoding (mirror build_tiles.py)
      dataMax: number;
      transform: 'linear' | 'sqrt' | 'gamma';
      gamma?: number;
      // native unit
      unit: string;
      unitOptions?: string[];
      formatNative: (intensity: number, unit: string) => string;
      band: (intensity: number) => string;
      unitDescription: string;
    };
    const invertTransform = (norm: number, max: number, t: 'linear'|'sqrt'|'gamma', gamma = 1) => {
      const n = Math.max(0, Math.min(1, norm));
      if (t === 'linear') return n * max;
      if (t === 'sqrt')   return n * n * max;
      return Math.pow(n, 1 / gamma) * max;
    };
    const HAZ_DEF: HazSpec[] = [
      {
        id: 'eq', hazardKey: 'earthquake', label: 'Earthquakes', hoverLabel: 'PGA',
        who: 'Anyone weighing seismic exposure (Pacific Rim, Himalaya, Andes, East African Rift).',
        desc: 'Peak Ground Acceleration with a 1-in-475-year return period.\nBright = stable. Dark = severe shaking.',
        sources: [
          { name: 'GEM Global Seismic Hazard Map v2023.1 (PGA, 475-yr)', url: 'https://maps.openquake.org/map/global-seismic-hazard-map/' },
        ],
        dataMax: 1.5, transform: 'gamma', gamma: 0.55,
        unit: 'g',
        formatNative: (g) => `${g.toFixed(2)}g`,
        band: (g) => g < 0.04 ? 'Negligible'
                   : g < 0.10 ? 'Minor'
                   : g < 0.20 ? 'Moderate'
                   : g < 0.40 ? 'Strong'
                   : g < 0.80 ? 'Severe'
                              : 'Extreme',
        unitDescription: '"g" = peak ground acceleration as a fraction of gravity at the 1-in-475-year level. 0.1g = light shaking, 0.4g = strong, 1g = ground briefly moves as fast as falling.'
      },
      {
        id: 'flood', hazardKey: 'flood', label: 'River Floods', hoverLabel: 'Depth',
        who: 'Anyone near rivers, deltas, or low-elevation watersheds.',
        desc: 'Maximum river-flood depth at a 1-in-100-year event.\nBright = dry. Dark = deep flooding.',
        sources: [
          { name: 'JRC Global River Flood Hazard, RP100 (m)', url: 'https://data.jrc.ec.europa.eu/dataset/jrc-floods-floodmapgl_rp50y-tif' },
        ],
        dataMax: 10.0, transform: 'sqrt',
        unit: 'm',
        formatNative: (m) => `${m.toFixed(1)} m`,
        band: (m) => m < 0.1 ? 'Dry'
                   : m < 0.5 ? 'Shallow'
                   : m < 1.5 ? 'Knee-to-waist'
                   : m < 3.0 ? 'Submerging'
                              : 'Catastrophic',
        unitDescription: 'Meters of water at a 1-in-100-year river flood. 0.5 m = ankle-deep, 1.5 m = waist, 3 m = first-floor submerged.'
      },
      {
        id: 'cyclone', hazardKey: 'cyclone', label: 'Cyclones', hoverLabel: 'Wind',
        who: 'Anyone in tropical or subtropical coastal zones (hurricane, typhoon, cyclone).',
        desc: 'Peak wind speed at a 1-in-100-year tropical cyclone.\nBright = calm. Dark = catastrophic winds.',
        sources: [
          { name: 'Bloemendaal STORM 100-yr max wind (present climate, m/s)', url: 'https://data.4tu.nl/articles/dataset/STORM_climate_change_synthetic_tropical_cyclone_tracks/12706085' },
        ],
        dataMax: 90.0, transform: 'gamma', gamma: 0.7,
        unit: 'mph',
        unitOptions: ['mph', 'm/s', 'km/h'],
        formatNative: (ms, unit) => {
          if (unit === 'm/s') return `${Math.round(ms)} m/s`;
          if (unit === 'km/h') return `${Math.round(ms * 3.6)} km/h`;
          return `${Math.round(ms * 2.23694)} mph`;
        },
        band: (ms) => {
          const mph = ms * 2.23694;
          if (mph < 39)  return 'No cyclone';
          if (mph < 74)  return 'Tropical storm';
          if (mph < 96)  return 'Cat 1';
          if (mph < 111) return 'Cat 2';
          if (mph < 130) return 'Cat 3';
          if (mph < 157) return 'Cat 4';
          return 'Cat 5';
        },
        unitDescription: 'Peak sustained 10-minute wind at a 1-in-100-year cyclone. 74 mph = hurricane threshold; 157 mph = Cat 5.'
      },
      {
        id: 'tsunami', hazardKey: 'tsunami', label: 'Tsunami', hoverLabel: 'Runup',
        who: 'Anyone within ~30 km of a coastline near a subduction zone.',
        desc: 'Coastal wave runup at a 1-in-500-year tsunami.\nBright = safe. Dark = inundating waves.',
        sources: [
          { name: 'Davies et al. 2017 Global PTHA (1/500-yr coastal runup, m)', url: 'https://nhess.copernicus.org/articles/18/3105/2018/' },
        ],
        dataMax: 10.0, transform: 'sqrt',
        unit: 'm',
        formatNative: (m) => `${m.toFixed(1)} m`,
        band: (m) => m < 0.1 ? 'Negligible'
                   : m < 0.5 ? 'Minor'
                   : m < 2.0 ? 'Inundating'
                   : m < 5.0 ? 'Severe'
                              : 'Catastrophic',
        unitDescription: 'Maximum wave runup at a 1-in-500-year tsunami. 2 m floods low-lying coasts; 5 m destroys most coastal structures.'
      },
      {
        id: 'volcano', hazardKey: 'volcano', label: 'Volcanoes', hoverLabel: 'Exposure',
        who: 'Anyone within ~30 km of a Holocene volcano with recent activity.',
        desc: 'Proximity to active Holocene volcanoes, weighted by recent eruptions.\nBright = far from any. Dark = dense volcanic clusters.',
        sources: [
          { name: 'Smithsonian Global Volcanism Program (Holocene volcanoes)', url: 'https://volcano.si.edu/list_volcano_holocene.cfm' },
        ],
        dataMax: 8.0, transform: 'gamma', gamma: 0.4,
        unit: 'score',
        formatNative: (s) => `${s.toFixed(1)} score`,
        band: (s) => s < 0.05 ? 'None'
                   : s < 0.3  ? 'Distant'
                   : s < 1.0  ? 'Nearby'
                   : s < 3.0  ? 'Active zone'
                              : 'Volcanic cluster',
        unitDescription: 'Gaussian-smoothed exposure score (sigma ~25 km), with recent eruptions weighted 3x. Higher = more (and more recently active) volcanoes within ~50 km.'
      },
      {
        id: 'drought', hazardKey: 'drought', label: 'Droughts', hoverLabel: 'Drought',
        who: 'Anyone in arid or semi-arid agricultural regions where prolonged dry spells cause famine.',
        desc: 'Fraction of months in severe drought (SPEI-12 < -1.5).\nBright = wet. Dark = chronically dry.',
        sources: [
          { name: 'SPEI-12 severe-drought frequency (1980-2006)', url: 'https://spei.csic.es/database.html' },
        ],
        dataMax: 0.5, transform: 'linear',
        unit: '% months',
        formatNative: (f) => `${(f * 100).toFixed(1)}% months`,
        band: (f) => f < 0.02 ? 'Wet'
                   : f < 0.05 ? 'Mild'
                   : f < 0.10 ? 'Common'
                   : f < 0.20 ? 'Persistent'
                              : 'Chronic',
        unitDescription: 'Share of months between 1980-2006 in severe drought (SPEI-12 below -1.5). 5% = 1 in 20 months; 20% = 1 in 5.'
      },
      {
        id: 'wildfire', hazardKey: 'wildfire', label: 'Wildfires', hoverLabel: 'Fire risk',
        who: 'Anyone in fire-prone climates (Mediterranean, western US, southern Australia).',
        desc: 'Fire-conducive months (drought + fuel proxy).\nBright = low fire risk. Dark = chronic fire weather.',
        sources: [
          { name: 'SPEI-12 drought-frequency proxy (vegetation-capped)', url: 'https://spei.csic.es/database.html' },
        ],
        dataMax: 0.4, transform: 'linear',
        unit: '% months',
        formatNative: (f) => `${(f * 100).toFixed(1)}% months`,
        band: (f) => f < 0.02 ? 'Negligible'
                   : f < 0.05 ? 'Low'
                   : f < 0.10 ? 'Moderate'
                   : f < 0.20 ? 'High'
                              : 'Extreme',
        unitDescription: 'Share of months with drought-driven fire-prone weather, capped where there is no fuel (deserts).'
      },
      {
        id: 'landslide', hazardKey: 'landslide', label: 'Landslides', hoverLabel: 'Slope',
        who: 'Anyone living below steep slopes in heavy-rain regions.',
        desc: 'Terrain slope from ETOPO global relief.\nBright = flat. Dark = steep.',
        sources: [
          { name: 'ETOPO 2022 Global Relief (5 km slope)', url: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model' },
        ],
        dataMax: 45.0, transform: 'linear',
        unit: '°',
        formatNative: (deg) => `${deg.toFixed(1)}°`,
        band: (deg) => deg < 1   ? 'Flat'
                     : deg < 5   ? 'Gentle'
                     : deg < 15  ? 'Hilly'
                     : deg < 30  ? 'Steep'
                                  : 'Cliff-like',
        unitDescription: 'Average slope at the 5 km cell. 5° = gentle hill, 15° = ski-slope blue, 30° = ski-slope black diamond.'
      },
    ];
    const out: Record<string, AxisConfig> = {};
    for (const h of HAZ_DEF) {
      out[h.id] = {
        label: h.label,
        dataMin: 0,
        dataMax: h.dataMax,
        unit: h.unit,
        unitOptions: h.unitOptions,
        formatValue: (norm, unit) => {
          const v = invertTransform(norm, h.dataMax, h.transform, h.gamma);
          return h.formatNative(v, unit);
        },
        formatHover: (norm, unit, lat, lng) => {
          void loadRiskLookup();
          let intensity: number | null = null;
          let mortality: number | null = null;
          if (lat !== undefined && lng !== undefined) {
            intensity = intensityAt(h.hazardKey, lat, lng);
            mortality = mortalityAt(h.hazardKey, lat, lng);
          }
          if (intensity == null) {
            intensity = invertTransform(norm, h.dataMax, h.transform, h.gamma);
          }
          const native = h.formatNative(intensity, unit);
          const band = h.band(intensity);
          const head = `${native} (${band})`;
          if (mortality != null && mortality >= 0.05) {
            return `${head}\n  ${fmtOddsPerYear(mortality)}  (${fmtMortality(mortality)} deaths per million per year)`;
          }
          return head;
        },
        description: h.desc,
        whoIsThisFor: h.who,
        unitDescription: h.unitDescription,
        source: 'See sources panel',
        sources: h.sources,
        hoverLabel: h.hoverLabel,
        defaultCurve: LINEAR_UP,
        staticYear: 2023,
        infoWidth: 311,
        infoHeight: 184,
      };
    }
    return out;
  })(),
  inet: {
    label: 'Connectivity',
    dataMin: 0,
    dataMax: 1000,
    unit: 'Mbps',
    formatValue: (norm) => {
      const maxLog = Math.log1p(1000000);
      const val = Math.expm1(norm * maxLog) / 1000;
      return `${Math.round(val)} Mbps`;
    },
    formatHover: (norm) => {
      const maxLog = Math.log1p(1000000);
      const val = Math.expm1(norm * maxLog) / 1000;
      let band: string;
      if (val < 5) band = 'Dial-up tier';
      else if (val < 25) band = 'Basic';
      else if (val < 100) band = 'Solid';
      else if (val < 300) band = 'Fast';
      else band = 'Blazing';
      return `${Math.round(val)} Mbps (${band})`;
    },
    description: 'How fast the internet is.\nBright = blazing fast. Dark = slow or nonexistent.',
    whoIsThisFor: 'Digital nomads, remote workers, and anyone who needs reliable internet for work, streaming, or gaming.',
    unitDescription: 'Megabits per second = how quickly data flows. 10 Mbps = basic browsing, 25 = video calls, 100+ = fast downloads. South Korea ~200, rural Africa ~2.',
    source: 'Ookla Speedtest Intelligence (Q4 2024)',
    sourceUrl: 'https://www.speedtest.net/insights/blog/best-internet-countries/',
    hoverLabel: 'Internet speed',
    defaultCurve: LINEAR_UP,
    staticYear: 2024,
    infoWidth: 308,
    infoHeight: 184
  },
  depv: {
    label: 'Deprivation',
    dataMin: 0,
    dataMax: 100,
    unit: 'idx',
    formatValue: (norm) => `${Math.round(norm * 100)}/100`,
    formatHover: (norm, _u, lat, lng) => {
      void loadDepvLookup();
      const v = Math.round(norm * 100);
      let band: string;
      if (v < 40) band = 'Severe deprivation';
      else if (v < 55) band = 'Low development';
      else if (v < 70) band = 'Medium development';
      else if (v < 85) band = 'High development';
      else band = 'Very high development';
      const headline = `${v}/100 (${band})`;

      const reg = (lat !== undefined && lng !== undefined) ? depvRegionAt(lat, lng) : null;
      if (!reg) return headline;
      const fmt = (x: number | null, digits = 2) =>
        x === null || !Number.isFinite(x) ? '?' : x.toFixed(digits);
      const lines = [
        `  Health     ${fmt(reg.health)}` + (reg.lifexp != null ? `  (life exp ${reg.lifexp.toFixed(0)} yr)` : ''),
        `  Education  ${fmt(reg.education)}` + (reg.esch_yrs != null ? `  (${reg.esch_yrs.toFixed(1)} yr expected)` : ''),
        `  Income     ${fmt(reg.income)}` + (reg.gnic != null ? `  ($${Math.round(reg.gnic).toLocaleString()} GNI/cap)` : ''),
      ];
      const where = reg.region ? `${reg.region}, ${reg.country}` : reg.country;
      return [`${headline}  -- ${where}`, ...lines].join('\n');
    },
    description: 'Overall quality of life combining health, education, and income.\nBright = highly developed. Dark = severe deprivation. Hover for the per-region breakdown.',
    whoIsThisFor: 'People seeking well-functioning societies with good schools, hospitals, and economic opportunity.',
    unitDescription: 'Human Development Index from 0-100. Combines life expectancy, years of schooling, and income. Norway ~95, Brazil ~75, Chad ~40. Hover shows the three sub-indices plus raw life expectancy, expected schooling years, and GNI per capita for the subnational region.',
    source: 'Global Data Lab (Subnational HDI)',
    sourceUrl: 'https://globaldatalab.org/shdi/',
    hoverLabel: 'Development',
    defaultCurve: LINEAR_UP,
    staticYear: 2022,
    infoWidth: 307,
    infoHeight: 201
  },
  hcare: {
    label: 'Healthcare',
    dataMin: 0,
    dataMax: 180,
    unit: 'min',
    formatValue: (norm) => `${Math.round((1 - norm) * 180)} min`,
    formatHover: (norm) => {
      const mins = Math.round((1 - norm) * 180);
      let band: string;
      if (mins < 15) band = 'Excellent access';
      else if (mins < 30) band = 'Good access';
      else if (mins < 60) band = 'Fair';
      else if (mins < 120) band = 'Remote';
      else band = 'Very remote';
      return `${mins} min (${band})`;
    },
    description: 'How close you are to a hospital or clinic.\nBright = nearby healthcare. Dark = hours away from medical help.',
    whoIsThisFor: 'Retirees, parents, or people with medical conditions who need quick access to emergency care.',
    unitDescription: 'Travel time to the nearest hospital. Under 15 min = excellent access (most cities). 60+ min = remote. Parts of rural Africa or Amazon can exceed 3 hours.',
    source: 'Malaria Atlas Project (Oxford / MAP)',
    sourceUrl: 'https://malariaatlas.org/research-project/accessibility-to-healthcare/',
    hoverLabel: 'Healthcare access',
    defaultCurve: LINEAR_UP,
    staticYear: 2019,
    infoWidth: 323,
    infoHeight: 183
  },
  vista: {
    label: 'Vista',
    dataMin: 0,
    dataMax: 1,
    unit: 'view',
    formatValue: (norm) => {
      const score = Math.round(norm * 100);
      return `${score}/100`;
    },
    formatHover: (norm) => {
      const score = Math.round(norm * 100);
      let band: string;
      if (score < 5) band = 'Boxed in';
      else if (score < 25) band = 'Limited view';
      else if (score < 50) band = 'Open horizon';
      else if (score < 75) band = 'Sweeping vista';
      else band = 'Panoramic';
      return `${score}/100 (${band})`;
    },
    description: 'How much of the surrounding landscape is visible from each spot.\nBright = sweeping panoramas. Dark = boxed in or no view at all.',
    whoIsThisFor: 'House hunters chasing a view, photographers, and anyone who values being able to see far.',
    unitDescription: 'Score 0-100 from a global viewshed analysis. Mountain ridgelines, sea cliffs, and high plateaus rank highest. Valley floors and dense forest interiors rank lowest.',
    source: 'alltheviews.world (Buckley-Houston, Berger, Dart)',
    sourceUrl: 'https://map.alltheviews.world/',
    hoverLabel: 'Vista',
    defaultCurve: LINEAR_UP,
    staticYear: 2025,
    infoWidth: 320,
    infoHeight: 195
  },
  travel: {
    label: 'City',
    dataMin: 0,
    dataMax: 720,
    unit: 'min',
    formatValue: (norm) => {
      const mins = Math.round((1 - norm) * 720);
      if (mins < 60) return `${mins} min`;
      const hrs = Math.round(mins / 60);
      return `${hrs} hr${hrs > 1 ? 's' : ''}`;
    },
    formatHover: (norm) => {
      const mins = Math.round((1 - norm) * 720);
      const v = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} hr${Math.round(mins / 60) > 1 ? 's' : ''}`;
      let band: string;
      if (mins < 15) band = 'Urban';
      else if (mins < 45) band = 'Suburban';
      else if (mins < 120) band = 'Rural';
      else if (mins < 360) band = 'Remote';
      else band = 'Wilderness';
      return `${v} (${band})`;
    },
    description: 'How long it takes to reach the nearest city.\nBright = close to urban life. Dark = deep wilderness.',
    whoIsThisFor: 'People who want access to shops, airports, and culture vs those seeking true off-grid remoteness.',
    unitDescription: 'Travel time in minutes. Most suburbs < 30 min. Rural towns ~1-2 hrs. Remote Amazon or Siberia can exceed 12 hrs.',
    source: 'Weiss et al. 2018 (Nature)',
    sourceUrl: 'https://figshare.com/articles/dataset/Travel_time_to_cities_and_ports_in_the_year_2015/7638134',
    hoverLabel: 'Travel to city',
    defaultCurve: LINEAR_UP,
    staticYear: 2015,
    infoWidth: 310,
    infoHeight: 183
  },
  free: {
    label: 'Freedom',
    dataMin: 0,
    dataMax: 100,
    unit: 'score',
    formatValue: (norm) => `${Math.round(norm * 100)}/100`,
    formatHover: (norm) => {
      const v = Math.round(norm * 100);
      let band: string;
      if (v < 25) band = 'Authoritarian';
      else if (v < 50) band = 'Not free';
      else if (v < 70) band = 'Partly free';
      else if (v < 90) band = 'Mostly free';
      else band = 'Fully free';
      return `${v}/100 (${band})`;
    },
    description: 'Scoring based on seven topics:\n• Electoral Process\n• Political Pluralism & Participation\n• Functioning of Government\n• Freedom of Expression & Belief\n• Associational & Organizational Rights\n• Rule of Law\n• Personal Autonomy\n\nBright = free and transparent. Dark = authoritarian and corrupt.',
    whoIsThisFor: 'Combines Freedom House (political rights) and Transparency International (corruption perception).',
    unitDescription: 'Finland ~95, USA ~75, Russia ~20. Hover for exact sub-scores.',
    source: 'Freedom House FIW + Transparency International CPI',
    sourceUrl: 'https://freedomhouse.org/report/freedom-world',
    hoverLabel: 'Freedom',
    defaultCurve: LINEAR_UP,
    infoWidth: 320,
    infoHeight: 285
  },
  draw: {
    label: 'DRAW',
    dataMin: 0,
    dataMax: 1,
    unit: '',
    formatValue: (norm) => (norm >= 0.5 ? 'on' : 'off'),
    formatHover: (norm) => (norm >= 0.5 ? 'on (Selected)' : 'off (Excluded)'),
    description: 'Paint your own regions on the map to include or exclude areas that matter to you.\nBright = selected. Dark = excluded.',
    whoIsThisFor: 'You! Manually highlight or block out regions for your personal formula.',
    unitDescription: 'On or off. Painted areas score full marks in formulas. Use with other layers: "draw * temp" shows temperature only in your painted region.',
    source: 'You! (hand-drawn)',
  },
};

const ENERGY_SUB_IDS = ['e_consume', 'e_oil', 'e_coal', 'e_gas', 'e_nuke', 'e_hydro', 'e_wind', 'e_solar', 'e_geo'];
const HAZARD_SUB_IDS = ['eq', 'flood', 'cyclone', 'tsunami', 'volcano', 'drought', 'wildfire', 'landslide'];

// Explicit menu / cycle order, ranked by how likely a typical user is to
// reach for an axis when deciding where to live: practical things first
// (climate, air, healthcare, hazards), squishier / more subjective ones
// last (freedom, agriculture, draw-your-own). Keep this list as the
// single source of truth -- AXIS_OPTIONS, the arrow-key cycle and the
// formula-bar autocomplete priority all derive from it.
const MAIN_AXIS_IDS = [
  'temp', 'tvar', 'water', 'pop', 'hcare',
  'gdp', 'agri', 'agrip', 'solar', 'risk',
  'inet', 'free', 'depv', 'air', 'travel',
  'elev', 'vista', 'wind', 'energy', 'draw',
].filter((id) => id in AXES);

// Arrow keys should cycle through every axis the user can possibly
// tune, including the energy + hazard sub-axes. Match the visual menu
// order: all main axes first (so arrow keys feel like reading the
// hamburger top-to-bottom), then the Energy and Natural Hazards
// sub-axes, with `draw` always last to mirror DraggablePanel's reading
// order (...wind, energy, Energy..., Natural Hazards..., DRAW).
const CYCLE_AXIS_IDS: string[] = (() => {
  const mainNoDraw = MAIN_AXIS_IDS.filter((id) => id !== 'draw');
  const subs = [
    ...ENERGY_SUB_IDS.filter((s) => s in AXES),
    ...HAZARD_SUB_IDS.filter((s) => s in AXES),
  ];
  const tail = MAIN_AXIS_IDS.includes('draw') ? ['draw'] : [];
  return [...mainNoDraw, ...subs, ...tail];
})();

// Short identifier shown next to each axis in the hamburger menu and used
// as the friendly typed-name in the formula bar. Defaults to the internal
// id; override here when we want a snappier abbreviation. The internal id
// is intentionally left alone (it keys tile URLs, R2 paths, the curve
// catalog and saved hashes).
const DISPLAY_IDS: Record<string, string> = {
  risk: 'dis',
  inet: 'conn',
  travel: 'city',
};

const HOTKEYS: Record<string, string> = {
  temp: 't',
  tvar: 'v',
  water: 'w',
  solar: 's',
  wind: 'n',
  energy: 'e',
  agri: 'a',
  agrip: 'z',
  pop: 'p',
  gdp: 'g',
  air: 'q',
  elev: 'l',
  risk: 'k',
  inet: 'i',
  depv: 'r',
  hcare: 'h',
  travel: 'm',
  vista: 'o',
  free: 'f',
  draw: 'd',
  e_consume: '1',
  e_oil: '2',
  e_coal: '3',
  e_gas: '4',
  e_nuke: '5',
  e_hydro: '6',
  e_wind: '7',
  e_solar: '8',
  e_geo: '9',
  eq: '0',
};

const AXIS_OPTIONS: AxisOption[] = MAIN_AXIS_IDS.map((id) => {
  const a = AXES[id];
  return {
    id,
    label: a.label,
    hotkey: HOTKEYS[id] ?? id[0],
    displayId: DISPLAY_IDS[id],
    description: a.description,
    unitDescription: a.unitDescription,
    source: a.source,
    sourceUrl: a.sourceUrl,
  };
});

function _toAxisOption(id: string): AxisOption {
  const a = AXES[id];
  return {
    id,
    label: a.label,
    hotkey: HOTKEYS[id] ?? id[0],
    displayId: DISPLAY_IDS[id],
    description: a.description,
    unitDescription: a.unitDescription,
    source: a.source,
    sourceUrl: a.sourceUrl,
  };
}
const ENERGY_SUB_OPTIONS: AxisOption[] = ENERGY_SUB_IDS.map(_toAxisOption);
const HAZARD_SUB_OPTIONS: AxisOption[] = HAZARD_SUB_IDS.map(_toAxisOption);

type FreeScores = Record<string, Record<string, {
  composite: number;
  fiw?: number;
  cpi?: number;
  cats?: Partial<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', number>>;
}>>;
const FREE_CAT_LABELS: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', string> = {
  A: 'Electoral process',
  B: 'Political pluralism',
  C: 'Functioning government',
  D: 'Expression & belief',
  E: 'Associational rights',
  F: 'Rule of law',
  G: 'Personal autonomy',
};

let freeScoresCache: FreeScores | null = null;
let freeScoresLoading = false;

function loadFreeScores(): FreeScores | null {
  if (freeScoresCache) return freeScoresCache;
  if (freeScoresLoading) return null;
  freeScoresLoading = true;
  fetch(`${getTilesBase()}/free/free_scores.json`)
    .then(r => r.ok ? r.json() as Promise<FreeScores> : null)
    .then(d => { freeScoresCache = d; })
    .catch(() => {})
    .finally(() => { freeScoresLoading = false; });
  return null;
}

// GDP per capita country-tier values (World Bank PPP, constant 2021 intl $).
// Shape: { "2024": { "United States of America": 75489, ... }, ... }
type GdpCountryScores = Record<string, Record<string, number>>;
const GDP_AVAILABLE_YEARS = [2000, 2005, 2010, 2015, 2020, 2024];

let gdpCountryCache: GdpCountryScores | null = null;
let gdpCountryLoading = false;
function loadGdpCountryScores(): GdpCountryScores | null {
  if (gdpCountryCache) return gdpCountryCache;
  if (gdpCountryLoading) return null;
  gdpCountryLoading = true;
  fetch('/gdp_country_scores.json')
    .then(r => r.ok ? r.json() as Promise<GdpCountryScores> : null)
    .then(d => { gdpCountryCache = d; })
    .catch(() => {})
    .finally(() => { gdpCountryLoading = false; });
  return null;
}

// Per-state GDP per capita lookup, keyed by ISO-3166-2 code (e.g. "AR-E").
// Split out of gdp_state_fills.geojson to keep the eager-loaded vector file
// small; fetched lazily only on the first GDP-axis hover.
type GdpStateScores = Record<string, Record<string, number>>;
let gdpStateCache: GdpStateScores | null = null;
let gdpStateLoading = false;
function loadGdpStateScores(): GdpStateScores | null {
  if (gdpStateCache) return gdpStateCache;
  if (gdpStateLoading) return null;
  gdpStateLoading = true;
  fetch('/gdp_state_scores.json')
    .then(r => r.ok ? r.json() as Promise<GdpStateScores> : null)
    .then(d => { gdpStateCache = d; })
    .catch(() => {})
    .finally(() => { gdpStateLoading = false; });
  return null;
}

function nearestGdpYear(target: number): number {
  let best = GDP_AVAILABLE_YEARS[0];
  let bestDist = Math.abs(best - target);
  for (const y of GDP_AVAILABLE_YEARS) {
    const d = Math.abs(y - target);
    if (d < bestDist) { best = y; bestDist = d; }
  }
  return best;
}

function formatGdpDollars(val: number): string {
  if (!Number.isFinite(val)) return '$?';
  return `$${Math.round(val).toLocaleString()}`;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const timePanelRef = useRef<TimePanelHandle>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Forces a re-render after the tile catalog has resolved so helpers like
  // getAllAxisYears() (which read from a module-level cache) actually return
  // data the first time TimePanel renders.  Without this the data-year ticks
  // would only appear after some other state change happened to re-render App.
  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCatalog().then(() => { if (alive) setCatalogReady(true); });
    return () => { alive = false; };
  }, []);
  // When the page is loaded with a #view= permalink we ignore localStorage
  // entirely so the share-link viewer sees exactly the sender's setup, and
  // we also skip writing back to localStorage (see `triggerSave` below).
  const [isShareView, setIsShareView] = useState(HAS_SHARE_HASH);
  const [hydrationKey, setHydrationKey] = useState(0); // bumped to remount CurveEditor after share-state load
  const [saved] = useState(() => (HAS_SHARE_HASH ? null : loadSavedState()));
  const [activeAxis, setActiveAxis] = useState(saved?.activeAxis ?? 'temp');
  const [isTouch] = useState(() =>
    typeof window !== 'undefined' &&
    navigator.maxTouchPoints > 0 &&
    window.matchMedia('(pointer: coarse)').matches,
  );
  // Phone users land on just the graph editor (centered) -- the info
  // panel takes over the same panel only when they tap the round "i".
  // Desktop keeps both panels open by default, side by side.
  const [showInfoPanel, setShowInfoPanel] = useState(!isTouch);
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);
  const [formula, setFormula] = useState(saved?.formula ?? '');
  const [formulaError, setFormulaError] = useState<string | null>(null);
  const curveStatesRef = useRef<Record<string, CurvePoint[]>>(saved?.curves ?? {});
  const unitStatesRef = useRef<Record<string, string>>(saved?.units ?? {});

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: saved?.mapCenter ?? [0, 20],
      zoom: saved?.mapZoom ?? 2,
      minZoom: 1,
      maxZoom: 10,
      maxPitch: 0,
      attributionControl: false,
      // @ts-ignore
      antialias: true,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      const style = map.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          const id = layer.id;

          if (id.includes('water') || id.includes('ocean')) {
            try { map.setPaintProperty(id, 'fill-color', '#12100e'); } catch {}
          }

          if (id.includes('background') || id === 'land') {
            try { map.setPaintProperty(id, 'background-color', '#393734'); } catch {}
            try { map.setPaintProperty(id, 'fill-color', '#393734'); } catch {}
          }

          if (id.includes('landuse') || id.includes('landcover') || id.includes('park') || id.includes('building') || id.includes('aeroway')) {
            try { map.setPaintProperty(id, 'fill-color', '#363432'); } catch {}
          }

          if (id.includes('label') || id.includes('place') || id.includes('poi')) {
            try { map.setPaintProperty(id, 'text-color', 'rgba(192, 168, 120, 0.55)'); } catch {}
            try { map.setPaintProperty(id, 'text-halo-color', 'rgba(14, 13, 11, 0.8)'); } catch {}
          }

          if (id.includes('boundary') || id.includes('border')) {
            try { map.setPaintProperty(id, 'line-color', 'rgba(80, 65, 45, 0.3)'); } catch {}
          }
          if (id.includes('road') || id.includes('highway') || id.includes('street')) {
            try { map.setPaintProperty(id, 'line-color', 'rgba(50, 42, 30, 0.4)'); } catch {}
          }
        }
      }

      const heatmap = createHeatmapLayer();
      map.addLayer(heatmap);

      map.addSource('countries', {
        type: 'geojson',
        data: `${window.location.origin}/countries.geojson`,
      });
      map.addLayer({
        id: 'country-fills',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-opacity': 0 },
      });
      map.addLayer({
        id: 'country-borders',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': 'rgba(0, 0, 0, 0.5)',
          'line-width': 1.0,
        },
        layout: { visibility: 'none' },
      });

      map.addSource('states', {
        type: 'geojson',
        data: `${window.location.origin}/states.geojson?v=3`,
      });
      map.addLayer({
        id: 'state-borders',
        type: 'line',
        source: 'states',
        minzoom: 1,
        paint: {
          'line-color': 'rgba(0, 0, 0, 0.3)',
          'line-width': .7,
        },
        layout: { visibility: 'none' },
      });

      // adm2_boundaries.pmtiles is 150MB; keep it on the same R2 host as the
      // raster tiles in production via VITE_TILES_BASE, fall back to the local
      // dev server (app/public/) otherwise.
      const tilesBase = (import.meta.env.VITE_TILES_BASE as string | undefined)
        || window.location.origin;
      map.addSource('adm2-boundaries', {
        type: 'vector',
        url: `pmtiles://${tilesBase}/adm2_boundaries.pmtiles`,
      });
      map.addLayer({
        id: 'adm2-borders-layer',
        type: 'line',
        source: 'adm2-boundaries',
        'source-layer': 'geoBoundariesCGAZ_ADM2',
        minzoom: 2.5,
        paint: {
          'line-color': 'rgba(0, 0, 0, 0.1)',
          'line-width': 0.5,
        },
        layout: { visibility: 'none' },
      });
      // Invisible ADM2 fills purely for district-tier hit-testing (GDP hover).
      map.addLayer({
        id: 'adm2-fills-layer',
        type: 'fill',
        source: 'adm2-boundaries',
        'source-layer': 'geoBoundariesCGAZ_ADM2',
        minzoom: 6,
        paint: { 'fill-opacity': 0 },
        layout: { visibility: 'none' },
      });

      // GDP per capita state tier (Natural Earth ADM1 polygons with WB-anchored,
      // population-weighted Kummu values for each available year).
      // minzoom=3.5: only takes over the hover when the user is actually zoomed
      // to a single-country view, so wide-zoom hovers fall through to the
      // country (World Bank) tier.
      map.addSource('gdp-state-fills', {
        type: 'geojson',
        data: `${window.location.origin}/gdp_state_fills.geojson?v=1`,
      });
      map.addLayer({
        id: 'gdp-state-fills-layer',
        type: 'fill',
        source: 'gdp-state-fills',
        minzoom: 3.5,
        paint: { 'fill-opacity': 0 },
        layout: { visibility: 'none' },
      });

      setMapLoaded(true);
    });

    mapRef.current = map;
    return () => map.remove();
  }, []);

  const activeAxisRef = useRef(activeAxis);
  activeAxisRef.current = activeAxis;
  const formulaRef = useRef(formula);
  formulaRef.current = formula;
  const lastMapPointRef = useRef<{ lng: number; lat: number; px: number; py: number } | null>(null);

  // When switching axes, the previously selected year may not exist for the
  // new axis (e.g. switching from `pop` (2000-2015) to `gdp` (2000, 2005, ...,
  // 2024) at year 2017). Snap to the nearest available year so the heatmap and
  // the tooltip never end up showing "no data".
  const snapYearToAxis = useCallback((axisId: string) => {
    const years = getAllAxisYears(axisId);
    if (years.length === 0) return; // static axis -- nothing to do
    const cur = getTimeYear();
    if (years.includes(cur)) return;
    let best = years[0];
    let bestDist = Math.abs(best - cur);
    for (const y of years) {
      const d = Math.abs(y - cur);
      if (d < bestDist) { best = y; bestDist = d; }
    }
    setTimeYear(best, 'historical');
    timePanelRef.current?.jumpToYear(best);
  }, []);

  // True when the formula bar holds exactly one axis identifier and
  // nothing else. In that case picking a new axis (menu, hotkey, arrow
  // keys) should also rewrite the formula -- otherwise the lone axis
  // in the formula keeps overriding the user's selection. Anything more
  // complex (operators, numbers, parens, multiple idents) is treated as
  // an authored formula and left untouched.
  const isSingleAxisFormula = useCallback((f: string): boolean => {
    const toks = tokenizeFormula(f).filter(t => t.type !== 'space');
    return toks.length === 1 && toks[0].type === 'ident';
  }, []);

  const handleAxisChange = useCallback((axisId: string) => {
    setActiveAxis(axisId);
    setHeatmapActiveAxis(axisId);
    if (isSingleAxisFormula(formulaRef.current)) {
      // Show the friendly short hint (e.g. "dis", "conn") in the formula
      // bar when one is defined, so the formula matches what the menu
      // displays. The alias resolves back to the canonical id at parse time.
      const formulaText = DISPLAY_IDS[axisId] ?? axisId;
      setFormula(formulaText);
      const err = setHeatmapFormula(formulaText);
      setFormulaError(err ? err.message : null);
    }
    snapYearToAxis(axisId);
    mapRef.current?.triggerRepaint();
  }, [snapYearToAxis, isSingleAxisFormula]);

  // Real-time collaboration. Keeps activeAxis / formula / year in lock-step
  // with everyone else in the same #room=<id>. Cursor positions are pushed
  // separately via Y.Awareness so they don't bloat the persistent doc.
  const collab = useCollab({
    onAxis: (axis) => {
      setActiveAxis(axis);
      setHeatmapActiveAxis(axis);
      if (isSingleAxisFormula(formulaRef.current)) {
        setFormula(axis);
        const err = setHeatmapFormula(axis);
        setFormulaError(err ? err.message : null);
      }
      snapYearToAxis(axis);
      mapRef.current?.triggerRepaint();
    },
    onFormula: (f) => {
      // A peer publishing a fresh empty value (which can happen during
      // a join race or if someone clears their bar) shouldn't flash
      // the local user's formula bar red. Treat empty/whitespace as
      // "no formula" -- which setHeatmapFormula already accepts as a
      // no-op single-axis fallback.
      const trimmed = f.trim();
      setFormula(trimmed);
      const err = setHeatmapFormula(trimmed);
      setFormulaError(err ? err.message : null);
      mapRef.current?.triggerRepaint();
    },
    onYear: (y, s) => {
      // Clamp incoming year to one that has data for *our* current
      // axis. The peer's local snap fired against their own axis, but
      // race conditions (peer scrubs year before their onAxis arrives
      // here, or we and the peer momentarily disagree on which axis
      // is active) can land us on year=2024 while we're on `pop`
      // (data only up to 2015). snapYearToAxis below would catch
      // that but only on the next axis change -- snap now so the
      // tile fetch in the next frame already has the right year.
      const years = getAllAxisYears(activeAxisRef.current);
      let snapped = y;
      if (years.length > 0 && !years.includes(y)) {
        snapped = years[0];
        let bestDist = Math.abs(snapped - y);
        for (const candidate of years) {
          const d = Math.abs(candidate - y);
          if (d < bestDist) { snapped = candidate; bestDist = d; }
        }
      }
      setTimeYear(snapped, s);
      timePanelRef.current?.jumpToYear(snapped);
    },
    onCurves: (curves) => {
      // A peer tuned one or more curves. Adopt the new control points
      // for every changed axis and re-rasterize the LUT so the GPU
      // picks up the change immediately, even for axes that don't have
      // a CurveEditor mounted right now (e.g. inside a multi-axis
      // formula). Bumping hydrationKey forces the visible CurveEditor
      // to remount with the peer's points instead of the local ones.
      let touched = false;
      for (const [axisId, points] of Object.entries(curves)) {
        if (!Array.isArray(points)) continue;
        curveStatesRef.current[axisId] = points as CurvePoint[];
        try { updateLookupTexture(axisId, evaluateCurvePoints(points as CurvePoint[])); } catch {}
        touched = true;
      }
      if (touched) {
        setHydrationKey((k) => k + 1);
        mapRef.current?.triggerRepaint();
      }
    },
    onUnits: (units) => {
      let touched = false;
      for (const [axisId, unit] of Object.entries(units)) {
        if (typeof unit !== 'string') continue;
        unitStatesRef.current[axisId] = unit;
        touched = true;
      }
      if (touched) setHydrationKey((k) => k + 1);
    },
    onMask: (mask) => {
      // A peer painted (or cleared) the draw mask. Pull the new mask
      // into our local PaintedMask store; importPaintedMask already
      // triggers a map repaint. We don't want to fire our own publish
      // in response, so just guard against null/undefined and trust
      // the type at runtime -- it was JSON-roundtripped via Yjs.
      try {
        importPaintedMask((mask as PaintedMask) ?? null);
      } catch {
        // Ignore malformed payloads from older clients.
      }
    },
  });

  const stepAxis = useCallback((dir: 1 | -1) => {
    setActiveAxis((prev) => {
      // Cycle through the full axis set (incl. energy + hazard sub-axes)
      // so arrow keys can reach every map, not just the menu's top level.
      // Falls back to the main list if `prev` is somehow off-cycle.
      const list = CYCLE_AXIS_IDS.includes(prev) ? CYCLE_AXIS_IDS : MAIN_AXIS_IDS;
      const idx = list.indexOf(prev);
      if (idx < 0) return prev;
      const next = list[(idx + dir + list.length) % list.length];
      setHeatmapActiveAxis(next);
      if (isSingleAxisFormula(formulaRef.current)) {
        setFormula(next);
        const err = setHeatmapFormula(next);
        setFormulaError(err ? err.message : null);
      }
      snapYearToAxis(next);
      mapRef.current?.triggerRepaint();
      return next;
    });
  }, [snapYearToAxis, isSingleAxisFormula]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const showGdpFills = activeAxis === 'gdp';
    try {
      map.setLayoutProperty('country-borders', 'visibility', 'visible');
      map.setLayoutProperty('state-borders', 'visibility', 'visible');
      map.setLayoutProperty('gdp-state-fills-layer', 'visibility', showGdpFills ? 'visible' : 'none');
      map.setLayoutProperty('adm2-fills-layer', 'visibility', showGdpFills ? 'visible' : 'none');
      map.setLayoutProperty('adm2-borders-layer', 'visibility', 'visible');
    } catch {}
  }, [activeAxis, mapLoaded]);

  // Push local axis into the shared collab doc whenever it changes.
  // Y.Map.set is a no-op when the value already matches, so this also
  // harmlessly re-fires after a remote update without bouncing back.
  // When collab.roomId flips (new session) we also seed the room with
  // our current curves/units so a freshly-shared link shows the
  // creator's tunings rather than a blank slate. We also mirror the
  // axis into our awareness state so peers see "Bob -- elev" on their
  // presence chip.
  //
  // Note: formula is published only on COMMIT (Enter / blur via the
  // FormulaBar.onFormulaCommit callback), not on every keystroke --
  // typing "tem" would otherwise leak three intermediate broadcasts
  // and burn through the Workers free-plan budget.
  useEffect(() => {
    collab.publishView({ axis: activeAxis });
    collab.publishAxis(activeAxis);
  }, [activeAxis, collab]);

  const handleFormulaCommit = useCallback((f: string) => {
    collab.publishView({ formula: f });
  }, [collab]);
  useEffect(() => {
    if (!collab.roomId) return;
    // One-shot seed when a session starts. Subsequent edits flow
    // through handlePointsChange / handleUnitChange / handleStrokeEnd.
    // Include the current painted mask so a creator who already drew
    // before sharing immediately propagates their drawing to joiners.
    const mask = exportPaintedMask();
    collab.publishView({
      curves: { ...curveStatesRef.current },
      units: { ...unitStatesRef.current },
      ...(mask ? { mask } : {}),
    });
  }, [collab.roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === 'ArrowLeft') { e.stopPropagation(); e.preventDefault(); stepAxis(-1); return; }
      if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); stepAxis(1); return; }
      // Up/Down are reserved for the timeline. We always preventDefault so
      // MapLibre never falls back to its own pan-up/pan-down behavior, even
      // for axes that aren't temporal -- in that case it just becomes a
      // no-op rather than panning the map. Up = forward in time, Down = back.
      if (e.key === 'ArrowUp') {
        e.stopPropagation();
        e.preventDefault();
        if (isAxisTemporal(activeAxisRef.current)) timePanelRef.current?.stepYear(1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.stopPropagation();
        e.preventDefault();
        if (isAxisTemporal(activeAxisRef.current)) timePanelRef.current?.stepYear(-1);
        return;
      }
      if (e.key === ' ') { e.preventDefault(); if (isAxisTemporal(activeAxisRef.current)) timePanelRef.current?.togglePlay(); return; }
      if (e.key === 'Home') {
        e.preventDefault();
        const range = getTemporalRange(activeAxisRef.current);
        if (range) {
          const cur = getTimeYear();
          timePanelRef.current?.jumpToYear(cur <= range.first ? range.last : range.first);
        }
        return;
      }
      if (e.key === 'i') { setShowInfoPanel(p => !p); return; }

      const pressed = e.key.toLowerCase();
      for (const [id, hk] of Object.entries(HOTKEYS)) {
        if (pressed === hk) { e.preventDefault(); handleAxisChange(id); return; }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stepAxis, handleAxisChange]);

  const handleCurveChange = useCallback((axisId: string, values: Float32Array) => {
    updateLookupTexture(axisId, values);
    mapRef.current?.triggerRepaint();
  }, []);

  const handleFormulaChange = useCallback((f: string) => {
    setFormula(f);
    const err: FormulaError | null = setHeatmapFormula(f);
    setFormulaError(err ? err.message : null);
    mapRef.current?.triggerRepaint();
  }, []);

  // Double-click an axis identifier in the formula bar -> switch the
  // active axis so the curve editor lets the user tune that axis. The
  // formula itself is left alone (handleAxisChange already only
  // rewrites it for single-ident formulas), so e.g. double-clicking
  // "water" in "temp + water" just swaps the graph panel to water
  // while the map keeps showing the full formula.
  const handleFormulaIdentDoubleClick = useCallback((text: string) => {
    const axisId = resolveAxisAlias(text);
    if (!AXES[axisId]) return;
    handleAxisChange(axisId);
  }, [handleAxisChange]);

  const handleFormulaSelectionChange = useCallback((sel: string | null) => {
    if (sel && sel.trim().length > 0) {
      setHeatmapFormula(sel);
      mapRef.current?.triggerRepaint();
    } else {
      const err = setHeatmapFormula(formula);
      setFormulaError(err ? err.message : null);
      mapRef.current?.triggerRepaint();
    }
  }, [formula]);

  useEffect(() => {
    if (saved?.activeAxis) setHeatmapActiveAxis(saved.activeAxis);
    if (saved?.formula) {
      const err = setHeatmapFormula(saved.formula);
      setFormulaError(err ? err.message : null);
    }
    if (saved?.year) setTimeYear(saved.year, 'historical');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snap the initial timeline year to one the active axis actually has data
  // for. Two ways this matters on first paint:
  //   1. Fresh sessions: TimePanel's default is `new Date().getFullYear()`,
  //      but several axes (temp/water/tvar/gdp/...) end at 2024 with no
  //      projections. resolveArchiveUrl returns '' for years past the last
  //      archive, fetchTileData caches a blank tile, and the heatmap
  //      uploads the blank as if it were real -- map looks blank.
  //   2. Returning sessions whose saved.year is past the active axis's last
  //      year (e.g. localStorage from a session that hit bug #1 before the
  //      fix existed). Same blank-tile failure mode.
  // snapYearToAxis is a no-op when the current year is already valid for
  // the axis, so it's safe to run unconditionally -- including for
  // share-link sessions whose catalog landed *after* the share-load
  // effect had a chance to apply (axis, year) from the URL.
  useEffect(() => {
    if (!mapLoaded || !catalogReady) return;
    if (!getCatalog()) return;
    snapYearToAxis(activeAxis);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, catalogReady, activeAxis]);

  // Apply state decoded from a #view= permalink once both the gzip decode
  // and the map have finished initialising. We do this imperatively rather
  // than at React init time because CompressionStream is async; the brief
  // "loading shared session" pill covers the gap.
  useEffect(() => {
    if (!isShareView || !mapLoaded) return;
    let cancelled = false;
    HASH_HYDRATION.then((shared) => {
      if (cancelled || !shared) {
        if (!shared) setIsShareView(false);
        return;
      }
      const map = mapRef.current;
      if (shared.curves && typeof shared.curves === 'object') {
        curveStatesRef.current = { ...curveStatesRef.current, ...shared.curves };
      }
      if (shared.units && typeof shared.units === 'object') {
        unitStatesRef.current = { ...unitStatesRef.current, ...shared.units };
      }
      const sharedAxis = typeof shared.activeAxis === 'string' ? shared.activeAxis : null;
      if (sharedAxis) {
        setActiveAxis(sharedAxis);
        setHeatmapActiveAxis(sharedAxis);
      }
      if (typeof shared.formula === 'string') {
        setFormula(shared.formula);
        const err = setHeatmapFormula(shared.formula);
        setFormulaError(err ? err.message : null);
      }
      if (typeof shared.year === 'number' && Number.isFinite(shared.year)) {
        setTimeYear(shared.year, 'historical');
        timePanelRef.current?.jumpToYear(shared.year);
      }
      // After we've applied both axis and year, force them back into a
      // consistent state. The sender may have shared year=2024 on `pop`
      // (whose catalog stops at 2015) -- snap to the nearest data year
      // so the recipient never opens to a blank "no data" map. Guarded
      // by catalogReady so getAllAxisYears actually returns the year
      // list; if the catalog hasn't loaded yet the snap useEffect
      // below will pick it up once it does.
      if (sharedAxis && catalogReady) {
        snapYearToAxis(sharedAxis);
      }
      if (map && Array.isArray(shared.mapCenter) && shared.mapCenter.length === 2 && typeof shared.mapZoom === 'number') {
        map.jumpTo({ center: shared.mapCenter, zoom: shared.mapZoom });
      }
      if (shared.mask) {
        importPaintedMask(shared.mask);
      }
      setHydrationKey(k => k + 1);
      mapRef.current?.triggerRepaint();
    });
    return () => { cancelled = true; };
  }, [isShareView, mapLoaded, catalogReady, snapYearToAxis]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerSave = useCallback(() => {
    // While viewing a shared link, never overwrite the recipient's own
    // localStorage save -- their existing session must survive untouched.
    if (isShareView) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const map = mapRef.current;
      const center = map?.getCenter();
      writeSave({
        curves: curveStatesRef.current,
        units: unitStatesRef.current,
        formula,
        activeAxis: activeAxisRef.current,
        mapCenter: center ? [center.lng, center.lat] : [0, 20],
        mapZoom: map?.getZoom() ?? 2,
        year: getTimeYear(),
      });
    }, 500);
  }, [formula, isShareView]);

  const snapshotState = useCallback((): ShareableState => {
    const map = mapRef.current;
    const center = map?.getCenter();
    const mask: PaintedMask | null = exportPaintedMask();
    return {
      curves: curveStatesRef.current,
      units: unitStatesRef.current,
      formula,
      activeAxis: activeAxisRef.current,
      mapCenter: center ? [center.lng, center.lat] : [0, 20],
      mapZoom: map?.getZoom() ?? 2,
      year: getTimeYear(),
      ...(mask ? { mask } : {}),
    };
  }, [formula]);

  const buildReadonlyShareLink = useCallback(async (): Promise<string> => {
    const hash = await encodeStateToHash(snapshotState());
    const base = window.location.origin + window.location.pathname;
    return `${base}#${hash}`;
  }, [snapshotState]);

  // Hybrid link = static snapshot + live room id, so recipients still
  // see the current view even if the worker is down or full. The
  // collab session is started here if it isn't already so the room id
  // exists in time to splice into the URL. Falls back to a pure
  // read-only link if collab isn't configured for this build.
  const buildCollabShareLink = useCallback(async (): Promise<string> => {
    const blob = await encodeStateToBase64(snapshotState());
    const base = window.location.origin + window.location.pathname;
    let roomId = collab.roomId;
    if (!roomId && collab.enabled) roomId = collab.startSession();
    if (!roomId) return `${base}#view=${blob}`;
    return `${base}#view=${blob}&room=${roomId}`;
  }, [snapshotState, collab]);

  // Debounce curve + year publishes: dragging a curve point or
  // scrubbing the timeline fires the change handler on every pointer
  // pixel (60fps), and each call to collab.publishView is a billable
  // Workers request on the free plan. 300ms idle = "user finished
  // dragging" in practice; the local heatmap still updates live, only
  // the peer broadcast is delayed.
  const collabCurvePushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePointsChange = useCallback((axisId: string, points: CurvePoint[]) => {
    curveStatesRef.current[axisId] = points;
    triggerSave();
    if (collabCurvePushTimer.current != null) clearTimeout(collabCurvePushTimer.current);
    collabCurvePushTimer.current = setTimeout(() => {
      collabCurvePushTimer.current = null;
      // We send the WHOLE curves map (not just the changed axis)
      // because Y.Map.set replaces the value -- partial patches would
      // clobber other peers' edits to other axes.
      collab.publishView({ curves: { ...curveStatesRef.current } });
    }, 300);
  }, [triggerSave, collab]);

  // ── First-visit intro ────────────────────────────────────────────
  //
  // The intro overlay (`Intro.tsx`) renders a 45s cinematic that
  // puppets the real heatmap + formula bar + curve LUTs to teach the
  // data → preference → combine model, then asks the user to pick 2
  // of 6 axes and a preset per axis so they land on a personalised
  // formula instead of the default `temp`. Shown on first visit only
  // (localStorage flag) and never to users arriving via a #view=
  // share link (they came for someone else's map). A "Replay intro"
  // pill in the corner of the info panel can re-trigger it later.
  const [introOpen, setIntroOpen] = useState(() => INTRO_ENABLED && !HAS_SHARE_HASH && !hasSeenIntro());
  const finishIntro = useCallback(() => {
    markIntroSeen();
    setIntroOpen(false);
  }, []);
  const replayIntro = useCallback(() => {
    resetIntroSeen();
    setIntroOpen(true);
  }, []);

  // Imperative API the intro uses to drive the real app state. Each
  // method funnels through the same setters the rest of the UI uses
  // (so the cinematic IS the product, not a parallel reimplementation).
  const introApi: CinematicAPI = useMemo(() => ({
    setAxis: (axisId: string) => {
      setActiveAxis(axisId);
      setHeatmapActiveAxis(axisId);
      // Force the heatmap to render the raw axis (clear any formula
      // left over from a previous scene) so the user sees just that
      // axis's data when the caption introduces it.
      setHeatmapFormula('');
      mapRef.current?.triggerRepaint();
    },
    setCurve: (axisId: string, points: CurvePoint[]) => {
      curveStatesRef.current[axisId] = points;
      try { updateLookupTexture(axisId, evaluateCurvePoints(points)); } catch {}
      setHydrationKey((k) => k + 1);
      mapRef.current?.triggerRepaint();
    },
    setFormula: (text: string) => {
      setFormula(text);
      const err = setHeatmapFormula(text);
      setFormulaError(err ? err.message : null);
      mapRef.current?.triggerRepaint();
    },
    typeFormula: async (text: string, charDelayMs: number) => {
      for (let i = 1; i <= text.length; i++) {
        const partial = text.slice(0, i);
        setFormula(partial);
        const err = setHeatmapFormula(partial);
        setFormulaError(err ? err.message : null);
        mapRef.current?.triggerRepaint();
        await new Promise<void>((r) => window.setTimeout(r, charDelayMs));
      }
    },
    flyTo: (center: [number, number], zoom: number, durationMs: number) => {
      try { mapRef.current?.flyTo({ center, zoom, duration: durationMs, essential: true }); } catch {}
    },
  // setHeatmapActiveAxis / setHeatmapFormula / updateLookupTexture /
  // evaluateCurvePoints are module-level imports; including them in
  // deps would only churn the memo since they're stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // When the intro commits the user's personalised state, fold it
  // into the same place a normal session would land (curveStatesRef
  // + formula state + active axis + triggerSave so it persists for
  // next time -- a returning user shouldn't lose what they just
  // chose). We also push to collab if a room is already active,
  // even though that's vanishingly rare (you'd have to deep-link
  // into a room without ever having visited utopiamap before).
  const onIntroCommit = useCallback((commit: {
    formula: string;
    activeAxis: string;
    curves: Record<string, CurvePoint[]>;
  }) => {
    for (const [axisId, points] of Object.entries(commit.curves)) {
      curveStatesRef.current[axisId] = points;
    }
    setFormula(commit.formula);
    setActiveAxis(commit.activeAxis);
    triggerSave();
    if (collab.roomId) {
      collab.publishView({
        formula: commit.formula,
        axis: commit.activeAxis,
        curves: { ...curveStatesRef.current },
      });
    }
  }, [triggerSave, collab]);

  const collabYearPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishYearDebounced = useCallback((year: number, scenario: string) => {
    if (collabYearPushTimer.current != null) clearTimeout(collabYearPushTimer.current);
    collabYearPushTimer.current = setTimeout(() => {
      collabYearPushTimer.current = null;
      collab.publishView({ year, scenario });
    }, 300);
  }, [collab]);

  const handleUnitChange = useCallback((axisId: string, unit: string) => {
    unitStatesRef.current[axisId] = unit;
    triggerSave();
    collab.publishView({ units: { ...unitStatesRef.current } });
  }, [triggerSave, collab]);

  // Smoothly fly to wherever a peer is currently looking. The
  // `lastPublishedCameraRef` update suppresses our own re-publish of
  // the same view we just adopted -- otherwise three peers clicking
  // each other in quick succession would each generate a fresh
  // moveend and burn DO requests echoing the same coordinates.
  const handleJumpToPeer = useCallback((peer: { view?: { lng: number; lat: number; zoom: number } }) => {
    const v = peer.view;
    const map = mapRef.current;
    if (!v || !map) return;
    lastPublishedCameraRef.current = v;
    try {
      map.flyTo({ center: [v.lng, v.lat], zoom: v.zoom, duration: 800, essential: true });
    } catch {}
  }, []);

  // Fires after each completed paint or erase stroke. One DO request
  // per stroke -- not per painted cell -- so a long sweeping brush
  // stroke costs the same as a single dab.
  const handleStrokeEnd = useCallback(() => {
    triggerSave();
    if (!collab.roomId) return;
    const mask = exportPaintedMask();
    // Yjs treats `undefined` as "delete" and `null` as a real value;
    // we want the latter so a peer fully erasing their canvas actually
    // propagates "no paint" to everyone else.
    collab.publishView({ mask: mask ?? null });
  }, [collab, triggerSave]);

  useEffect(() => { triggerSave(); }, [activeAxis, formula, triggerSave]);

  // Debounce camera awareness publishes the same way we debounce
  // curves / year: a single trackpad fling fires `moveend` constantly,
  // and each call is a billable Workers request. 2s idle matches
  // "user stopped moving the map". Plus a skip-tiny-change filter so
  // a sub-pixel jitter doesn't burn a message.
  const collabCameraPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPublishedCameraRef = useRef<{ lng: number; lat: number; zoom: number } | null>(null);
  const cameraChangedEnough = useCallback((next: { lng: number; lat: number; zoom: number }) => {
    const prev = lastPublishedCameraRef.current;
    if (!prev) return true;
    if (Math.abs(prev.zoom - next.zoom) >= 0.1) return true;
    // Center delta as a fraction of the current viewport extent
    // (rough -- proper great-circle math isn't worth it at this fidelity).
    const dLng = Math.abs(prev.lng - next.lng);
    const dLat = Math.abs(prev.lat - next.lat);
    const scale = 360 / Math.pow(2, next.zoom);
    return (dLng + dLat) / scale > 0.05;
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMapChange = () => {
      triggerSave();
      if (!collab.roomId) return;
      if (collabCameraPushTimer.current != null) clearTimeout(collabCameraPushTimer.current);
      collabCameraPushTimer.current = setTimeout(() => {
        collabCameraPushTimer.current = null;
        const m = mapRef.current;
        if (!m) return;
        const c = m.getCenter();
        const view = { lng: c.lng, lat: c.lat, zoom: m.getZoom() };
        if (!cameraChangedEnough(view)) return;
        lastPublishedCameraRef.current = view;
        collab.publishCamera(view);
      }, 2000);
    };
    map.on('moveend', onMapChange);
    map.on('zoomend', onMapChange);
    return () => {
      map.off('moveend', onMapChange);
      map.off('zoomend', onMapChange);
    };
  }, [mapLoaded, triggerSave, collab, cameraChangedEnough]);

  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string; color?: string } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp the hover tooltip inside the map container so it never spills
  // off the top/right of small viewports (common on phones when the
  // tap point is near the screen edges). Default placement is above-right
  // of the cursor; flip horizontally / vertically when that would
  // overflow, then hard-clamp as a last resort.
  useLayoutEffect(() => {
    if (!hoverInfo || !tooltipRef.current || !containerRef.current) {
      setTooltipPos(null);
      return;
    }
    const tip = tooltipRef.current.getBoundingClientRect();
    const cont = containerRef.current.getBoundingClientRect();
    const PAD = 6;
    const OFFSET = 12;
    let left = hoverInfo.x + OFFSET;
    let top = hoverInfo.y - tip.height - 8;
    if (left + tip.width > cont.width - PAD) left = hoverInfo.x - tip.width - OFFSET;
    if (left < PAD) left = PAD;
    if (top < PAD) top = hoverInfo.y + 16;
    if (top + tip.height > cont.height - PAD) top = cont.height - tip.height - PAD;
    if (top < PAD) top = PAD;
    setTooltipPos({ left, top });
  }, [hoverInfo]);

  const computeHoverText = useCallback((lng: number, lat: number, px: number, py: number) => {
    const map = mapRef.current;
    const axId = activeAxisRef.current;
    const hv = readValueAtLngLat(lng, lat);
    if (!hv) {
      setHoverInfo(null);
      return;
    }

    let text: string;
    if (hv.isFormula) {
      text = `${Math.round(hv.curveValue * 100)}% match`;
    } else {
      const ax = AXES[axId];
      if (ax) {
        const label = ax.hoverLabel ?? ax.label;
        if (axId === 'energy') {
          text = `${label}: (Country Avg)`; // Overwritten by country polygon hit-test
        } else {
          const fmt = ax.formatHover ?? ax.formatValue;
          // Use the user-selected unit (e.g. C/F toggle on temp), falling
          // back to the axis default. Without this lookup the hover label
          // always rendered in the axis's static default unit.
          const userUnit = unitStatesRef.current[axId] ?? ax.unit;
          text = `${label}: ${fmt(hv.rawNorm, userUnit, lat, lng)}`;
        }
      } else {
        text = `${Math.round(hv.rawNorm * 100)}%`;
      }
    }

    if (map && COUNTRY_AXES.has(axId)) {
      try {
        const features = map.queryRenderedFeatures([px, py], { layers: ['country-fills'] });
        if (features.length > 0) {
          const name = features[0].properties?.NAME;
          if (name) {
            if (axId === 'gdp') {
              // Tiered GDP per capita hover: District (Kummu pixel) > State
              // (WB-anchored pop-weighted Kummu) > Country (World Bank PPP).
              const targetYear = getTimeYear();
              const yrKey = String(nearestGdpYear(targetYear));
              let handled = false;

              // 1. District (ADM2) -- only above the layer's minzoom
              const adm2Features = map.queryRenderedFeatures([px, py], { layers: ['adm2-fills-layer'] });
              if (adm2Features.length > 0) {
                const props = adm2Features[0].properties;
                const districtName = props?.shapeName;
                if (districtName) {
                  // Kummu is constant within an ADM2 polygon, so the local
                  // raster pixel value IS the canonical Kummu value here.
                  text = `${districtName}, ${name} (District) -- GDP/capita: ${(AXES.gdp.formatHover ?? AXES.gdp.formatValue)(hv.rawNorm, '')}`;
                  handled = true;
                }
              }

              // 2. State (ADM1) -- value lives in lazy-loaded gdp_state_scores.json,
              //    keyed by ISO-3166-2 (e.g. "US-CA") which the polygon carries.
              if (!handled) {
                const stateFeatures = map.queryRenderedFeatures([px, py], { layers: ['gdp-state-fills-layer'] });
                if (stateFeatures.length > 0) {
                  const props = stateFeatures[0].properties;
                  const stateName = props?.name;
                  const isoKey = props?.iso_3166_2;
                  if (stateName && isoKey) {
                    const scoresByState = loadGdpStateScores();
                    const stateVal = scoresByState?.[isoKey]?.[yrKey];
                    if (typeof stateVal === 'number' && Number.isFinite(stateVal)) {
                      text = `${stateName}, ${name} (State, ${yrKey}) -- GDP/capita: ${formatGdpDollars(stateVal)}`;
                      handled = true;
                    }
                  }
                }
              }

              // 3. Country (ADM0) -- World Bank PPP, constant 2021 intl $
              if (!handled) {
                const scores = loadGdpCountryScores();
                const wbVal = scores?.[yrKey]?.[name];
                if (typeof wbVal === 'number' && Number.isFinite(wbVal)) {
                  text = `${name} (Country, ${yrKey}) -- GDP/capita: ${formatGdpDollars(wbVal)}`;
                } else {
                  text = `${name} -- ${text}`;
                }
              }
            } else if (axId === 'energy') {
              const scores = loadEnergyScores();
              if (scores && scores[name] !== undefined) {
                const norm = scores[name].score / 100;
                text = `${name} -- ${(AXES.energy.formatHover ?? AXES.energy.formatValue)(norm, '')}`;
                const fuels = scores[name].fuels;
                if (fuels) {
                  const total = Object.values(fuels).reduce((acc, v) => acc + v, 0);
                  if (total > 0) {
                    const allFuels = Object.entries(fuels)
                      .sort((a, b) => b[1] - a[1])
                      .map(([f, cap]) => {
                        const pct = Math.round((cap / total) * 100);
                        return pct > 0 ? `\n${f} ${pct}%` : '';
                      })
                      .join('');
                    if (allFuels) text += `${allFuels}`;
                  }
                }
              } else {
                text = `${name} -- No data`;
              }
            } else {
              text = `${name} -- ${text}`;
            }

            if (axId === 'free') {
              const scores = loadFreeScores();
              if (scores) {
                const yr = String(getTimeYear());
                const entry = scores[yr]?.[name];
                if (entry) {
                  const parts: string[] = [];
                  if (entry.fiw != null) parts.push(`FIW ${Math.round(entry.fiw)}`);
                  if (entry.cpi != null) parts.push(`CPI ${Math.round(entry.cpi)}`);
                  if (parts.length > 0) text += ` (${parts.join(', ')})`;
                  if (entry.cats) {
                    const order: (keyof typeof FREE_CAT_LABELS)[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
                    const lines = order
                      .map(k => {
                        const v = entry.cats?.[k];
                        return v != null ? `\n${FREE_CAT_LABELS[k]} ${Math.round(v)}%` : '';
                      })
                      .filter(Boolean)
                      .join('');
                    if (lines) text += lines;
                  }
                }
              }
            }
          }
        }
      } catch {}
    }

    if (axId === 'agri' || axId === 'agrip') {
      loadCropsLookup(axId); // trigger lazy fetch on first hover
      const top = topCropsAt(axId, lat, lng);
      if (top && top.length) {
        if (axId === 'agri') {
          // values = hectares -> show as % share of harvested area
          const total = top.reduce((acc, c) => acc + c.value, 0);
          if (total > 0) {
            const lines = top
              .map(c => {
                const pct = Math.round((c.value / total) * 100);
                return pct > 0 ? `\n${c.name} ${pct}%` : '';
              })
              .filter(Boolean)
              .join('');
            if (lines) text += lines;
          }
        } else {
          // agrip -- values = suitability index 0-100
          const lines = top
            .map(c => c.value > 0 ? `\n${c.name} ${Math.round(c.value)} SI` : '')
            .filter(Boolean)
            .join('');
          if (lines) text += lines;
        }
      }
    }

    setHoverInfo({ x: px, y: py, text });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    function onMove(e: maplibregl.MapMouseEvent) {
      const { lng, lat } = e.lngLat;
      lastMapPointRef.current = { lng, lat, px: e.point.x, py: e.point.y };
      computeHoverText(lng, lat, e.point.x, e.point.y);
    }

    function onLeave() {
      lastMapPointRef.current = null;
      setHoverInfo(null);
    }

    map.on('mousemove', onMove);
    map.getCanvas().addEventListener('mouseleave', onLeave);
    return () => {
      map.off('mousemove', onMove);
      map.getCanvas().removeEventListener('mouseleave', onLeave);
    };
  }, [mapLoaded, computeHoverText, collab]);

  useEffect(() => {
    const pos = lastMapPointRef.current;
    if (pos) computeHoverText(pos.lng, pos.lat, pos.px, pos.py);
  }, [activeAxis, computeHoverText]);

  const buildSaveState = useCallback((): SavedState => {
    const map = mapRef.current;
    const center = map?.getCenter();
    return {
      curves: curveStatesRef.current,
      units: unitStatesRef.current,
      formula,
      activeAxis: activeAxisRef.current,
      mapCenter: center ? [center.lng, center.lat] : [0, 20],
      mapZoom: map?.getZoom() ?? 2,
      year: getTimeYear(),
    };
  }, [formula]);

  const handleSaveFile = useCallback(() => {
    const state = buildSaveState();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'utopia-prefs.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [buildSaveState]);

  const handleLoadFile = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const state = JSON.parse(reader.result as string) as Partial<SavedState>;
          if (state.curves) curveStatesRef.current = state.curves;
          if (state.units) unitStatesRef.current = state.units;
          if (state.formula !== undefined) {
            setFormula(state.formula);
            const err = setHeatmapFormula(state.formula);
            setFormulaError(err ? err.message : null);
          }
          if (state.activeAxis) {
            setActiveAxis(state.activeAxis);
            setHeatmapActiveAxis(state.activeAxis);
          }
          if (state.year) {
            setTimeYear(state.year, 'historical');
            timePanelRef.current?.jumpToYear(state.year);
          }
          const map = mapRef.current;
          if (map) {
            if (state.mapCenter) map.setCenter(state.mapCenter);
            if (state.mapZoom !== undefined) map.setZoom(state.mapZoom);
          }
          writeSave(state as SavedState);
          mapRef.current?.triggerRepaint();
        } catch {}
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const axis = AXES[activeAxis];

  const [initialSizes] = useState(() => {
    try {
      const saved = localStorage.getItem('infoPanelSizes');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const infoSizesRef = useRef<Record<string, { w: number; h: number }>>(initialSizes);
  const savedInfoSize = infoSizesRef.current[activeAxis];
  const infoW = savedInfoSize?.w ?? (axis.infoWidth ?? 306);
  const infoH = savedInfoSize?.h ?? (axis.infoHeight ?? 240);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      <TopBar
        axes={AXIS_OPTIONS}
        energySubAxes={ENERGY_SUB_OPTIONS}
        hazardSubAxes={HAZARD_SUB_OPTIONS}
        activeAxisId={activeAxis}
        onAxisChange={handleAxisChange}
        formula={formula}
        onFormulaChange={handleFormulaChange}
        onFormulaCommit={handleFormulaCommit}
        onFormulaSelectionChange={handleFormulaSelectionChange}
        onFormulaIdentDoubleClick={handleFormulaIdentDoubleClick}
        formulaError={formulaError}
        formulaAxisOrder={CYCLE_AXIS_IDS}
        repoUrl={REPO_URL}
        onSaveFile={handleSaveFile}
        onLoadFile={handleLoadFile}
        onBuildReadonlyLink={buildReadonlyShareLink}
        onBuildCollabLink={buildCollabShareLink}
        collabEnabled={collab.enabled}
        collabShareUrl={collab.shareUrl}
        collabError={collab.status.error ?? null}
        onStartCollab={collab.startSession}
      />

      <CollabBar
        enabled={collab.enabled}
        status={collab.status}
        peers={collab.peers}
        roomId={collab.roomId}
        onEnd={collab.endSession}
        onJumpToPeer={handleJumpToPeer}
      />

      {DEBUG_MODE && <DebugPanel />}

      {mapLoaded && activeAxis === 'draw' && mapRef.current && (
        <DrawMode
          map={mapRef.current}
          isTouch={isTouch}
          onStrokeEnd={handleStrokeEnd}
        />
      )}

      {mapLoaded && activeAxis !== 'draw' && (
        <TimePanel
          ref={timePanelRef}
          onTimeChange={(y, s) => { setTimeYear(y, s); triggerSave(); publishYearDebounced(y, s); }}
          disabled={!isAxisTemporal(activeAxis)}
          initialYear={saved?.year}
          overrideYear={AXES[activeAxis]?.staticYear}
          temporalRange={getTemporalRange(activeAxis)}
          projections={getProjections(activeAxis)}
          dataYears={getAllAxisYears(activeAxis)}
        />
      )}

      {hoverInfo && (
        <div
          ref={tooltipRef}
          className="map-hover-tooltip"
          style={{
            left: tooltipPos ? tooltipPos.left : hoverInfo.x + 12,
            top: tooltipPos ? tooltipPos.top : hoverInfo.y,
            color: hoverInfo.color,
            visibility: tooltipPos ? 'visible' : 'hidden',
          }}
        >
          {hoverInfo.text}
        </div>
      )}

      {mapLoaded && activeAxis !== 'draw' && (() => {
        // Reusable bits so the phone (single-panel swap) and desktop
        // (two-panel side-by-side) layouts stay in lockstep.
        const renderCurve = (w: number, h: number) => (
          <CurveEditor
            key={`${activeAxis}:${hydrationKey}`}
            width={w}
            height={h}
            axis={axis}
            axisId={activeAxis}
            onCurveChange={handleCurveChange}
            savedPoints={curveStatesRef.current[activeAxis]}
            onPointsChange={handlePointsChange}
            savedUnit={unitStatesRef.current[activeAxis]}
            onUnitChange={handleUnitChange}
            subtitle={`${activeAxis} [${HOTKEYS[activeAxis]?.toUpperCase() ?? ''}]`}
          />
        );

        const renderInfo = (w: number, h: number) => (
          <div className="axis-detail-content" style={{ width: w, height: h, overflowY: 'auto', paddingRight: '4px' }}>
            <p style={{ whiteSpace: 'pre-line' }}>{axis.description}</p>
            {axis.whoIsThisFor && <p className="axis-detail-who" style={{ marginTop: '8px' }}><strong>Who is this for:</strong> {axis.whoIsThisFor}</p>}
            {axis.unitDescription && <p className="axis-detail-units" style={{ marginTop: '8px' }}>{axis.unitDescription}</p>}
            {axis.sources && axis.sources.length > 0 ? (
              <p className="axis-detail-source">
                Sources:{' '}
                <button
                  className="axis-detail-sources-toggle"
                  onClick={() => setShowSourcesPanel((v) => !v)}
                >{axis.sources.length} datasets {showSourcesPanel ? '▾' : '▸'}</button>
              </p>
            ) : (
              <p className="axis-detail-source">
                Source: {axis.sourceUrl
                  ? <a href={axis.sourceUrl} target="_blank" rel="noopener noreferrer">{axis.source}</a>
                  : axis.source}
              </p>
            )}
            <div className="axis-detail-hint">[i] to toggle</div>
          </div>
        );

        const infoCornerBtn = (
          <button
            className={`curve-info-corner-btn${showInfoPanel ? ' active' : ''}`}
            onClick={() => setShowInfoPanel((p) => !p)}
            title={showInfoPanel ? 'Hide info' : 'Show info'}
            aria-label={showInfoPanel ? 'Hide info' : 'Show info'}
          >i</button>
        );

        if (isTouch) {
          // Phone: a single panel that swaps between curve editor and
          // info content, preserving the user's chosen position/size.
          // The same DraggablePanel instance is rendered in either
          // case (no key change) so React keeps its internal state.
          const inInfo = showInfoPanel;
          return (
            <DraggablePanel
              initialCenter
              initialBottomOffset={44}
              initialWidth={260}
              initialHeight={inInfo ? 240 : 225}
              title={`${axis.label} ${inInfo ? 'info' : 'prefs'}`}
              onPrev={() => stepAxis(-1)}
              onNext={() => stepAxis(1)}
              onClose={inInfo ? () => setShowInfoPanel(false) : undefined}
              cornerButton={inInfo ? undefined : infoCornerBtn}
            >
              {(w, h) => inInfo ? renderInfo(w, h) : renderCurve(w, h)}
            </DraggablePanel>
          );
        }

        // Desktop: two panels side by side. The curve panel keeps its
        // round info corner button so info is always one tap away even
        // when the info panel is closed.
        return (
          <>
            <DraggablePanel
              initialX={24}
              initialBottomOffset={44}
              initialWidth={240}
              initialHeight={257}
              title={`${axis.label} prefs`}
              onPrev={() => stepAxis(-1)}
              onNext={() => stepAxis(1)}
              cornerButton={infoCornerBtn}
            >
              {(w, h) => renderCurve(w, h)}
            </DraggablePanel>
            {showInfoPanel && (
              <DraggablePanel
                key={`info-${activeAxis}`}
                initialRight={24}
                initialBottomOffset={44}
                initialWidth={infoW}
                initialHeight={infoH}
                title={`${axis.label} info`}
                onClose={() => setShowInfoPanel(false)}
                onSizeChange={(w, h) => {
                  infoSizesRef.current[activeAxis] = { w, h };
                  try {
                    localStorage.setItem('infoPanelSizes', JSON.stringify(infoSizesRef.current));
                  } catch {}
                  console.log(`[Art Direction] To save these as defaults, paste this into the AI chat:\n${JSON.stringify(infoSizesRef.current)}`);
                }}
              >
                {(w, h) => renderInfo(w, h)}
              </DraggablePanel>
            )}
          </>
        );
      })()}

      {!isTouch && showInfoPanel && showSourcesPanel && axis.sources && axis.sources.length > 0 && (
        <DraggablePanel
          key={`sources-${activeAxis}`}
          initialRight={24 + infoW + 12}
          initialBottomOffset={44}
          initialWidth={320}
          initialHeight={Math.min(360, 60 + axis.sources.length * 22)}
          title={`${axis.label} sources`}
          onClose={() => setShowSourcesPanel(false)}
        >
          {(w, h) => (
            <div className="axis-detail-content" style={{ width: w, height: h, overflowY: 'auto', paddingRight: '4px' }}>
              <ul className="axis-sources-list">
                {axis.sources!.map((s, i) => (
                  <li key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a>
                    ) : (
                      <span>{s.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DraggablePanel>
      )}

      {/* First-visit intro overlay. Mounts only when the localStorage
           flag is unset and we're not viewing a share link. Calls
           finishIntro() on both natural completion and user-skip. */}
      {introOpen && (
        <Intro
          api={introApi}
          onFinish={finishIntro}
          onCommit={onIntroCommit}
        />
      )}

      {/* Returning users + share-link visitors get a small persistent
           pill in the bottom-left that re-runs the intro on demand --
           the only discovery surface for the cinematic after first
           visit, so make sure it's visible but unobtrusive. */}
      {INTRO_ENABLED && !introOpen && (
        <button
          className="intro-replay-pill"
          onClick={replayIntro}
          title="Replay the 45-second intro"
        >
          {HAS_SHARE_HASH ? 'New here? See the 45s intro →' : '▶ Replay intro'}
        </button>
      )}
    </div>
  );
}
