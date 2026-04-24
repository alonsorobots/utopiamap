import { useRef, useEffect, useState, useCallback } from 'react';
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
import { isAxisTemporal, getTemporalRange, getProjections, getAllAxisYears, loadCatalog, getTilesBase } from './tileDataLoader';
import type { FormulaError, PaintedMask } from './heatmapLayer';
import { CurveEditor } from './CurveEditor';
import type { AxisConfig, CurvePoint } from './CurveEditor';
import { DraggablePanel } from './DraggablePanel';
import { DrawMode } from './DrawMode';
import { TimePanel } from './TimePanel';
import type { TimePanelHandle } from './TimePanel';
import { TopBar } from './TopBar';
import type { AxisOption } from './TopBar';
import { decodeStateFromHash, encodeStateToHash, isShareHash } from './shareLink';
import type { ShareableState } from './shareLink';
import './App.css';

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

const LINEAR_UP: CurvePoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
];

const COUNTRY_AXES = new Set(['gdp', 'risk', 'free', 'inet', 'energy', 'depv', 'e_consume']);

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
    unit: 'C',
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
    unit: 'C',
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
    defaultCurve: [
      { x: 0,                y: 0 },
      { x: 550 / 3000,       y: 1 },
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
      { x: 5.5 / 20,  y: 1 },
      { x: 11.5 / 20, y: 0 },
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
    dataMax: 100,
    unit: '',
    formatValue: (norm) => `${Math.round(norm * 100)}/100`,
    formatHover: (norm) => {
      const safety = Math.round(norm * 100);
      let band: string;
      if (safety > 80) band = 'Very safe';
      else if (safety > 60) band = 'Safe';
      else if (safety > 40) band = 'Moderate';
      else if (safety > 20) band = 'Risky';
      else band = 'High risk';
      return `${safety}/100 (${band})`;
    },
    description: 'How safe a place is from natural disasters -- earthquakes, floods, landslides, and sea-level rise.\nBright = safe. Dark = high risk.',
    whoIsThisFor: 'Homebuyers, families, or preppers wanting to avoid flood zones, earthquake belts, and landslide-prone slopes.',
    unitDescription: 'Safety score from 0-100 combining earthquake shaking, river flood risk, coastal sea-level exposure, and landslide danger. Vermont ~90, coastal Bangladesh ~15, San Andreas Fault ~30.',
    source: 'GEM Seismic v2023.1 + JRC Flood + ETOPO 2022',
    sourceUrl: 'https://www.globalquakemodel.org/product/global-seismic-hazard-map/',
    hoverLabel: 'Safety',
    defaultCurve: LINEAR_UP,
    staticYear: 2023,
    infoWidth: 310,
    infoHeight: 218
  },
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
    formatHover: (norm) => {
      const v = Math.round(norm * 100);
      let band: string;
      if (v < 40) band = 'Severe deprivation';
      else if (v < 55) band = 'Low development';
      else if (v < 70) band = 'Medium development';
      else if (v < 85) band = 'High development';
      else band = 'Very high development';
      return `${v}/100 (${band})`;
    },
    description: 'Overall quality of life combining health, education, and income.\nBright = highly developed. Dark = severe deprivation.',
    whoIsThisFor: 'People seeking well-functioning societies with good schools, hospitals, and economic opportunity.',
    unitDescription: 'Human Development Index from 0-100. Combines life expectancy, years of schooling, and income. Norway ~95, Brazil ~75, Chad ~40.',
    source: 'Global Data Lab (Subnational HDI)',
    sourceUrl: 'https://globaldatalab.org/shdi/',
    hoverLabel: 'Development',
    defaultCurve: LINEAR_UP,
    staticYear: 2021,
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
    description: 'How much of the surrounding landscape is visible from each spot. A "total viewshed" sums every line of sight reaching outward across rugged terrain, plains, and coasts.\nBright = sweeping panoramas. Dark = boxed in or no view at all (oceans).',
    whoIsThisFor: 'House hunters who want a view, photographers chasing horizons, and anyone who values being able to see far.',
    unitDescription: 'Score 0-100. Mountain ridgelines, sea cliffs, and high plateaus rank highest. Valley floors and dense forest interiors rank lowest. Computed from a global viewshed analysis at 100m resolution by alltheviews.world.',
    source: 'alltheviews.world (Tom Buckley-Houston, Ryan Berger, Jaco Dart)',
    sourceUrl: 'https://map.alltheviews.world/',
    hoverLabel: 'Vista',
    defaultCurve: LINEAR_UP,
    staticYear: 2025,
    infoWidth: 320,
    infoHeight: 232
  },
  travel: {
    label: 'Travel to City',
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
    label: 'Draw',
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

const AXIS_IDS = Object.keys(AXES);
const ENERGY_SUB_IDS = ['e_consume', 'e_oil', 'e_coal', 'e_gas', 'e_nuke', 'e_hydro', 'e_wind', 'e_solar', 'e_geo'];
const MAIN_AXIS_IDS = AXIS_IDS.filter((id) => !ENERGY_SUB_IDS.includes(id));

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
  depv: 'x',
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
};

const AXIS_OPTIONS: AxisOption[] = Object.entries(AXES)
  .filter(([id]) => !ENERGY_SUB_IDS.includes(id))
  .map(([id, a]) => ({
    id,
    label: a.label,
    hotkey: HOTKEYS[id] ?? id[0],
    description: a.description,
    unitDescription: a.unitDescription,
    source: a.source,
    sourceUrl: a.sourceUrl,
  }));

const ENERGY_SUB_OPTIONS: AxisOption[] = ENERGY_SUB_IDS.map((id) => {
  const a = AXES[id];
  return {
    id,
    label: a.label,
    hotkey: HOTKEYS[id] ?? id[0],
    description: a.description,
    unitDescription: a.unitDescription,
    source: a.source,
    sourceUrl: a.sourceUrl,
  };
});

type FreeScores = Record<string, Record<string, { composite: number; fiw?: number; cpi?: number }>>;

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
  const [, setCatalogReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCatalog().then(() => { if (alive) setCatalogReady(true); });
    return () => { alive = false; };
  }, []);
  // When the page is loaded with a #view= permalink we ignore localStorage
  // entirely so the share-link viewer sees exactly the sender's setup, and
  // we also skip writing back to localStorage (see `triggerSave` below).
  const [isShareView, setIsShareView] = useState(HAS_SHARE_HASH);
  const [shareHydrated, setShareHydrated] = useState(false);
  const [hydrationKey, setHydrationKey] = useState(0); // bumped to remount CurveEditor after share-state load
  const [saved] = useState(() => (HAS_SHARE_HASH ? null : loadSavedState()));
  const [activeAxis, setActiveAxis] = useState(saved?.activeAxis ?? 'temp');
  const [showInfoPanel, setShowInfoPanel] = useState(true);
  const [formula, setFormula] = useState(saved?.formula ?? '');
  const [formulaError, setFormulaError] = useState<string | null>(null);
  const curveStatesRef = useRef<Record<string, CurvePoint[]>>(saved?.curves ?? {});
  const unitStatesRef = useRef<Record<string, string>>(saved?.units ?? {});
  const [isTouch] = useState(() =>
    typeof window !== 'undefined' &&
    navigator.maxTouchPoints > 0 &&
    window.matchMedia('(pointer: coarse)').matches,
  );

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

  const handleAxisChange = useCallback((axisId: string) => {
    setActiveAxis(axisId);
    setHeatmapActiveAxis(axisId);
    snapYearToAxis(axisId);
    mapRef.current?.triggerRepaint();
  }, [snapYearToAxis]);

  const stepAxis = useCallback((dir: 1 | -1) => {
    setActiveAxis((prev) => {
      const idx = MAIN_AXIS_IDS.indexOf(prev);
      if (idx < 0) return prev;
      const next = MAIN_AXIS_IDS[(idx + dir + MAIN_AXIS_IDS.length) % MAIN_AXIS_IDS.length];
      setHeatmapActiveAxis(next);
      snapYearToAxis(next);
      mapRef.current?.triggerRepaint();
      return next;
    });
  }, [snapYearToAxis]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === 'ArrowLeft') { e.stopPropagation(); e.preventDefault(); stepAxis(-1); return; }
      if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); stepAxis(1); return; }
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
      if (typeof shared.activeAxis === 'string') {
        setActiveAxis(shared.activeAxis);
        setHeatmapActiveAxis(shared.activeAxis);
      }
      if (typeof shared.formula === 'string') {
        setFormula(shared.formula);
        const err = setHeatmapFormula(shared.formula);
        setFormulaError(err ? err.message : null);
      }
      if (typeof shared.year === 'number' && Number.isFinite(shared.year)) {
        setTimeYear(shared.year, 'historical');
      }
      if (map && Array.isArray(shared.mapCenter) && shared.mapCenter.length === 2 && typeof shared.mapZoom === 'number') {
        map.jumpTo({ center: shared.mapCenter, zoom: shared.mapZoom });
      }
      if (shared.mask) {
        importPaintedMask(shared.mask);
      }
      setHydrationKey(k => k + 1);
      setShareHydrated(true);
      mapRef.current?.triggerRepaint();
    });
    return () => { cancelled = true; };
  }, [isShareView, mapLoaded]);

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

  const buildReadonlyShareLink = useCallback(async (): Promise<string> => {
    const map = mapRef.current;
    const center = map?.getCenter();
    const mask: PaintedMask | null = exportPaintedMask();
    const state: ShareableState = {
      curves: curveStatesRef.current,
      units: unitStatesRef.current,
      formula,
      activeAxis: activeAxisRef.current,
      mapCenter: center ? [center.lng, center.lat] : [0, 20],
      mapZoom: map?.getZoom() ?? 2,
      year: getTimeYear(),
      ...(mask ? { mask } : {}),
    };
    const hash = await encodeStateToHash(state);
    const base = window.location.origin + window.location.pathname;
    return `${base}#${hash}`;
  }, [formula]);

  const handlePointsChange = useCallback((axisId: string, points: CurvePoint[]) => {
    curveStatesRef.current[axisId] = points;
    triggerSave();
  }, [triggerSave]);

  const handleUnitChange = useCallback((axisId: string, unit: string) => {
    unitStatesRef.current[axisId] = unit;
    triggerSave();
  }, [triggerSave]);

  useEffect(() => { triggerSave(); }, [activeAxis, formula, triggerSave]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMapChange = () => triggerSave();
    map.on('moveend', onMapChange);
    map.on('zoomend', onMapChange);
    return () => {
      map.off('moveend', onMapChange);
      map.off('zoomend', onMapChange);
    };
  }, [mapLoaded, triggerSave]);

  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string; color?: string } | null>(null);

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
          text = `${label}: ${fmt(hv.rawNorm, ax.unit)}`;
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
  }, [mapLoaded, computeHoverText]);

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
        activeAxisId={activeAxis}
        onAxisChange={handleAxisChange}
        formula={formula}
        onFormulaChange={handleFormulaChange}
        onFormulaSelectionChange={handleFormulaSelectionChange}
        formulaError={formulaError}
        repoUrl={REPO_URL}
        onSaveFile={handleSaveFile}
        onLoadFile={handleLoadFile}
        onBuildReadonlyLink={buildReadonlyShareLink}
      />

      {isShareView && (
        <div className="shared-session-pill" title="You are viewing a snapshot from a shared link. Your own session is untouched.">
          <span className="shared-session-dot" />
          {shareHydrated ? 'viewing shared session' : 'loading shared session...'}
          <button
            className="shared-session-exit"
            onClick={() => {
              if (typeof window !== 'undefined') {
                history.replaceState(null, '', window.location.pathname + window.location.search);
                window.location.reload();
              }
            }}
            title="Exit shared session and return to your own"
          >
            exit
          </button>
        </div>
      )}

      {mapLoaded && activeAxis === 'draw' && mapRef.current && (
        <DrawMode map={mapRef.current} isTouch={isTouch} />
      )}

      {mapLoaded && activeAxis !== 'draw' && (
        <TimePanel
          ref={timePanelRef}
          onTimeChange={(y, s) => { setTimeYear(y, s); triggerSave(); }}
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
          className="map-hover-tooltip"
          style={{ left: hoverInfo.x, top: hoverInfo.y, color: hoverInfo.color }}
        >
          {hoverInfo.text}
        </div>
      )}

      {mapLoaded && activeAxis !== 'draw' && (
        <DraggablePanel
          initialX={24}
          initialBottomOffset={44}
          initialWidth={210}
          initialHeight={225}
          title={`${axis.label} prefs`}
          onPrev={() => stepAxis(-1)}
          onNext={() => stepAxis(1)}
        >
          {(w, h) => (
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
          )}
        </DraggablePanel>
      )}

      {showInfoPanel && activeAxis !== 'draw' && (
        <DraggablePanel
          key={`info-${activeAxis}`}
          initialRight={24}
          initialBottomOffset={44}
          initialWidth={infoW}
          initialHeight={infoH}
          title={`${axis.label} info`}
          onSizeChange={(w, h) => {
            infoSizesRef.current[activeAxis] = { w, h };
            try {
              localStorage.setItem('infoPanelSizes', JSON.stringify(infoSizesRef.current));
            } catch {}
            console.log(`[Art Direction] To save these as defaults, paste this into the AI chat:\n${JSON.stringify(infoSizesRef.current)}`);
          }}
        >
          {(w, h) => (
            <div className="axis-detail-content" style={{ width: w, height: h, overflowY: 'auto', paddingRight: '4px' }}>
              <button className="axis-detail-close" onClick={() => setShowInfoPanel(false)}>x</button>
              <p style={{ whiteSpace: 'pre-line' }}>{axis.description}</p>
              {axis.whoIsThisFor && <p className="axis-detail-who" style={{ marginTop: '8px' }}><strong>Who is this for:</strong> {axis.whoIsThisFor}</p>}
              {axis.unitDescription && <p className="axis-detail-units" style={{ marginTop: '8px' }}>{axis.unitDescription}</p>}
              <p className="axis-detail-source">
                Source: {axis.sourceUrl
                  ? <a href={axis.sourceUrl} target="_blank" rel="noopener noreferrer">{axis.source}</a>
                  : axis.source}
              </p>
              <div className="axis-detail-hint">[i] to toggle</div>
            </div>
          )}
        </DraggablePanel>
      )}

      {!showInfoPanel && activeAxis !== 'draw' && (
        <button
          className="axis-detail-toggle"
          onClick={() => setShowInfoPanel(true)}
          title="Show data info (i)"
        >i</button>
      )}
    </div>
  );
}
